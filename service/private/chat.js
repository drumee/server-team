/**
 * @license
 * Copyright 2024 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.gnu.org/licenses/agpl-3.0.html
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const { Attr, RedisStore, toArray } = require("@drumee/server-essentials");
const { Entity, MfsTools } = require("@drumee/server-core");
const { remove_node, move_node, copy_node } = MfsTools;

const { stringify } = JSON;
const { mkdirSync } = require("fs");
const { isEmpty, isArray, map, includes } = require("lodash");
const { CAN_CHAT, privilegeAllows } = require("../lib/member-capability");
const { markFeatureUsage } = require("../lib/feature-usage");

const ENTITY_ID_RE = /^[0-9a-zA-Z_-]{1,32}$/;
const DB_NAME_RE = /^[A-Za-z0-9_]+$/;
const MAX_ELIGIBILITY_HUBS = 50;


class privateChat extends Entity {

  constructor(...args) {
    super(...args);
    this.post = this.post.bind(this);
    this.acknowledge = this.acknowledge.bind(this);
    this.forward = this.forward.bind(this);
    this.forward_eligibility = this.forward_eligibility.bind(this);
    this.contact_rooms = this.contact_rooms.bind(this);
    this.chat_rooms = this.chat_rooms.bind(this);
    this.chat_room_info = this.chat_room_info.bind(this);
    this.share_rooms = this.share_rooms.bind(this);
    this.pages_to_read = this.pages_to_read.bind(this);
    this.pages_to_read = this.pages_to_read.bind(this);
    this.delete = this.delete.bind(this);
    this.messages = this.messages.bind(this);
    this.remove_attachment = this.remove_attachment.bind(this);
    this.count_all = this.count_all.bind(this);
    this.attachment = this.attachment.bind(this);
    this.change_status = this.change_status.bind(this);
    this.typing = this.typing.bind(this);
    this.react = this.react.bind(this);
  }

  /**
   * 
   */
  async attachment() {
    let message_id = this.input.use(Attr.message_id);
    let peer_id = this.input.use(Attr.peer_id);
    let page = this.input.use(Attr.page) || 1;
    let attach = {};
    let data = await this.db.await_proc("channel_get", message_id);

    if (isEmpty(data)) {
      // Fallback: P2P message stored in sender's p2p_channel
      data = await this.db.await_proc("p2p_get_message", message_id);
    }

    // Cross-DB fallback for receiver: message is in the sender's (peer's) DB
    if (isEmpty(data) && peer_id) {
      data = await this.yp.await_proc("forward_proc", peer_id, "p2p_get_message", `'${message_id}'`);
    }

    if (!isEmpty(data) && !isEmpty(data.attachment)) {
      data.attachment = this.parseJSON(data.attachment);
      attach = data.attachment.slice((page - 1) * 5, page * 5);
      if (!isEmpty(attach)) {
        attach = await this._getAttachmentsInfo(attach, this.uid, page);
      }
    }
    this.output.data(attach);
  }

  /**
   *
   */
  async acknowledge() {
    const peer_id = this.input.get(Attr.peer_id) || this.input.need(Attr.entity_id);
    const ref_ctime = this.input.use("ref_ctime");
    await this.db.await_proc("p2p_acknowledge", { peer_id, ref_ctime });
    // Dismiss any P2P mention notifications from this peer
    try {
      await this.yp.await_query(
        "UPDATE yp.contact_activity SET dismissed_at = UNIX_TIMESTAMP() WHERE event = 'p2p_mention' AND target_uid = ? AND uid = ? AND dismissed_at IS NULL",
        this.uid,
        peer_id
      );
    } catch (e) {
      this.warn("[chat.acknowledge] p2p_mention dismiss failed:", e && e.message);
    }
    // Notify the sender (peer_id) that I've read up to ref_ctime, so their chat
    // widget can place my "seen" avatar live (Messenger-style). This covers the
    // case where I read a freshly-received message while the chat is already
    // open — the on-load read-receipt push lives in messages(). peer_id in the
    // payload is MY uid so the recipient matches it against their own peerId (I
    // am their peer); ctime carries the read cursor for applyReadReceipt().
    try {
      const cursor = ref_ctime || Math.floor(Date.now() / 1000);
      const recipients = await this.yp.await_proc("user_sockets", peer_id);
      await RedisStore.sendData(
        this.payload([{ peer_id: this.uid, ctime: cursor }], { service: "chat.acknowledge" }),
        recipients
      );
    } catch (e) {
      this.warn("[chat.acknowledge] read-receipt push failed:", e && e.message);
    }
    this.output.data({ peer_id });
  }

  /**
   * Ephemeral typing indicator for P2P chat. Broadcasts the caller's typing
   * state over WebSocket to the peer's active sessions only. Nothing persisted.
   * peer_id in the payload is the sender's uid so the recipient's chat widget
   * matches it against their own peerId (the peer is the sender from their
   * perspective) — same convention used by chat.post.
   */
  async typing() {
    const entity_id = this.input.need(Attr.entity_id);
    const profile = this.user.get("profile") || {};
    const data = {
      author_id: this.uid,
      uid: this.uid,
      firstname: this.user.get(Attr.firstname),
      lastname: profile.lastname,
      peer_id: this.uid,
      state: this.input.use("state", 1),
    };
    const recipients = await this.yp.await_proc("user_sockets", entity_id);
    await RedisStore.sendData(
      this.payload(data, { service: "chat.typing" }),
      recipients,
    );
    this.output.data({ ok: 1 });
  }

  /**
   *
   */
  contact_rooms() {
    const tag_id = this.input.use(Attr.tag_id, "");
    const page = this.input.use(Attr.page) || 1;
    const key = this.input.use(Attr.key) || "";
    this.db.call_proc(
      "contact_chat_rooms",
      key,
      tag_id,
      page,
      this.output.list
    );
  }

  /**
   *
   */
  chat_rooms() {
    const tag_id = this.input.use(Attr.tag_id, "");
    const page = this.input.use(Attr.page) || 1;
    const key = this.input.use(Attr.key) || "";
    const flag = this.input.use(Attr.flag) || "";
    const option = this.input.use(Attr.option) || "active";
    this.db.call_proc(
      "chat_rooms",
      key,
      tag_id,
      flag,
      option,
      page,
      this.output.list
    );
  }

  /**
   *
   */
  async chat_room_info() {
    const key = this.input.need(Attr.key);
    this.db.call_proc("chat_room_info", key, this.output.data);
  }

  /**
   *
   */
  tag_chat_count() {
    const tag_id = this.input.need(Attr.tag_id, "");
    this.db.call_proc("tag_chat_count", tag_id, this.output.list);
  }

  /**
   *
   */
  share_rooms() {
    const page = this.input.use(Attr.page) || 1;
    const key = this.input.use(Attr.key) || "";
    this.db.call_proc("group_chat_rooms", key, page, this.output.list);
  }

  /**
   * 
   */
  async move_attachemnt(sbox, desdir, attachment, message_id) {
    let src = [];

    message_id = [message_id];
    for (let media of attachment) {
      src.push({ nid: media, hub_id: this.uid });
    }

    let data = await this.db.await_proc(
      "mfs_move_all",
      src,
      this.uid,
      desdir.id,
      sbox.hub_id
    );

    this.debug("chat.move_attachemnt mfs_move_all result", data);
    if (!data) return [];
    // mfs_move_all returns multi-result: [statusRow, [opRows...]] — flatten to op rows only
    let rows = [];
    if (Array.isArray(data)) {
      for (const item of data) {
        if (Array.isArray(item)) rows.push(...item);
        else if (item && item.action) rows.push(item);
      }
    } else if (data && data.action) {
      rows = [data];
    }
    data = rows;

    attachment = [];
    for (let node of data) {
      let dest = {};
      switch (node.action) {
        case "move":
          src = { nid: node.nid, mfs_root: node.src_mfs_root };
          dest = {
            nid: node.des_id,
            hub_id: sbox.hub_id,
            mfs_root: node.des_mfs_root,
          };
          attachment.push({ hub_id: sbox.hub_id, nid: node.des_id });
          if (node.des_mfs_root) {
            try { mkdirSync(node.des_mfs_root, { recursive: true }); } catch (_) {}
          }
          await move_node(src, dest);
          break;
        case "copy":
          src = { nid: node.nid, mfs_root: node.src_mfs_root };
          dest = {
            nid: node.des_id,
            hub_id: sbox.hub_id,
            mfs_root: node.des_mfs_root,
          };
          attachment.push({ hub_id: sbox.hub_id, nid: node.des_id });
          await copy_node(src, dest);
      }
    }

    for (let node of data) {
      switch (node.action) {
        case "delete":
          src = {
            nid: node.nid,
            hub_id: sbox.hub_id,
            mfs_root: node.src_mfs_root,
          };
          await remove_node(src);
      }
    }

    return attachment;
  }

  /**
   *
   */
  async threadInfo(thread_id, uid, peer_id) {
    let thread = {};
    let data = await this.yp.await_proc(
      "forward_proc",
      uid,
      "channel_get",
      `'${thread_id}'`
    );

    if (isEmpty(data)) {
      // Fallback: may be a P2P message I sent (in my drumate DB)
      data = await this.yp.await_proc(
        "forward_proc",
        uid,
        "p2p_get_message",
        `'${thread_id}'`
      );
    }

    if (isEmpty(data) && !isEmpty(peer_id)) {
      // Fallback: may be a P2P message the peer sent (in peer's drumate DB)
      data = await this.yp.await_proc(
        "forward_proc",
        peer_id,
        "p2p_get_message",
        `'${thread_id}'`
      );
    }

    if (isEmpty(data)) {
      thread.message = "DELETED";
      thread.message_id = thread_id;
      return thread;
    }

    thread.message = data.message;
    thread.message_id = data.message_id;
    thread.is_attachment = 0;
    if (!isEmpty(data.attachment)) {
      thread.is_attachment = 1;
      //thread.attachment = await this._getAttachmentsInfo(data.attachment, uid);
    }
    thread.author_id = data.author_id;
    thread.entity = await this.yp.await_proc(
      "forward_proc",
      uid,
      "shareroom_contact_get",
      `'${data.author_id}'`
    );
    return thread;
  }

  /**
   *
   * @param {*} uid
   * @param {*} entity_id
   * @returns
   */
  async entityInfo(uid, entity_id) {
    let entity = {};
    entity = await this.yp.await_proc(
      "forward_proc",
      uid,
      "shareroom_contact_get",
      `'${entity_id}'`
    );
    if (!isEmpty(entity.contact_id)) {
      let tag = await this.yp.await_proc(
        "forward_proc",
        uid,
        "my_tag_get",
        `'${entity.contact_id}'`
      );
      if (!isArray(tag)) {
        tag = [tag];
      }
      entity.tag = map(tag, "tag_id");
    }
    return entity;
  }

  /**
   *
   */
  async _checkPostSanity(entity_id, thread_id, attachment) {
    let res = {};
    let contact = await this.db.await_proc(
      "my_contact_exists",
      "entity",
      entity_id,
      null,
      null
    );
    if (isEmpty(contact) || contact.uid != entity_id) {
      // Not a formal contact — allow if entity_id is a registered drumate (colleague)
      let drumate = await this.yp.await_proc("drumate_exists", entity_id);
      if (isEmpty(drumate)) {
        res.status = "INVALID_CONTACT";
        return res;
      }
    }

    let invalid_attachment = 0;
    if (!isEmpty(attachment)) {
      for (let _file of attachment) {
        let file = await this.db.await_proc("mfs_access_node", this.uid, _file);
        if (isEmpty(file)) {
          invalid_attachment = invalid_attachment + 1;
        }
      }
    }
    if (invalid_attachment > 0) {
      res.status = "INVALID_ATTACHMENT";
      return res;
    }

    if (!isEmpty(thread_id)) {
      let data_thread = await this.db.await_proc("channel_get", thread_id);
      if (isEmpty(data_thread)) {
        // Fallback: may be a P2P message I sent (in my drumate DB)
        data_thread = await this.db.await_proc("p2p_get_message", thread_id);
      }
      if (isEmpty(data_thread)) {
        // Fallback: may be a P2P message the peer sent (in peer's drumate DB)
        data_thread = await this.yp.await_proc(
          "forward_proc",
          entity_id,
          "p2p_get_message",
          `'${thread_id}'`
        );
      }
      if (isEmpty(data_thread)) {
        res.status = "INVALID_THREAD";
        return res;
      }
    }
    return { ok: true };
  }

  /**
   * Resolve a recipient's drumate row once for the current request.
   */
  async _drumateFor(entity_id, drumateCache) {
    if (drumateCache.has(entity_id)) return drumateCache.get(entity_id);
    const drumate = await this.yp.await_proc("drumate_exists", entity_id);
    drumateCache.set(entity_id, drumate);
    return drumate;
  }

  /**
   * Keep forward's P2P policy aligned with chat.post: a formal contact or any
   * registered drumate (colleague) remains a valid recipient.
   */
  async _p2pAllowed(entity_id, drumate) {
    if (!isEmpty(drumate)) return true;
    try {
      const contact = await this.db.await_proc(
        "my_contact_exists",
        "entity",
        entity_id,
        null,
        null
      );
      return !isEmpty(contact) && contact.uid == entity_id;
    } catch (e) {
      this.warn("[chat.forward] contact lookup failed", entity_id, e && e.message);
      return false;
    }
  }

  /**
   * Check one entity's wildcard membership row in a hub. Defaults to the
   * caller, but takes an explicit entity so the same read answers both
   * questions forward needs: "may I post into this hub" and "is this recipient
   * a chat member of the hub the message came from". Missing, expired and
   * failed lookups all deliberately collapse to false.
   */
  async _hubChatAllowed(hub_id, entity_id = this.uid, bit = CAN_CHAT) {
    try {
      if (!ENTITY_ID_RE.test(String(hub_id || ""))) return false;
      if (!ENTITY_ID_RE.test(String(entity_id || ""))) return false;
      const dbName = await this.yp.await_func("get_db_name", hub_id);
      if (!DB_NAME_RE.test(String(dbName || ""))) return false;
      const result = await this.yp.await_query(
        `SELECT permission AS privilege FROM \`${dbName}\`.permission
          WHERE resource_id='*' AND entity_id=?
          AND (expiry_time=0 OR expiry_time>UNIX_TIMESTAMP()) LIMIT 1`,
        entity_id
      );
      const member = toArray(result)[0];
      if (!member || member.privilege == null) return false;
      return privilegeAllows(member.privilege, bit);
    } catch (e) {
      this.warn("[chat.forward] hub eligibility lookup failed", hub_id, e && e.message);
      return false;
    }
  }

  /**
   * Confinement rule for a message read out of a workspace conversation: it may
   * only reach that workspace's own chat members.
   *
   * A recipient id is either a person (contact row) or a hub (share-room row),
   * and both are checked against the SOURCE workspace:
   *   - the source workspace itself  -> allowed when the caller may chat there
   *     (forwarding back into the room the message came from)
   *   - a person                     -> allowed when they hold the CHAT right
   *     in the source workspace. Membership alone is not enough: a view-only
   *     member cannot read that workspace's conversation, so forwarding one to
   *     them would hand them content the workspace never granted them
   *     (QA decision 2026-08-15, superseding the membership-only rule).
   *   - any other hub                -> refused, even one the caller may chat
   *     in, because that would move the message out of its workspace
   *
   * Deliberately NOT the same rule as chat.post: post starts from the author's
   * own words, forward relays someone else's out of the room they wrote them in.
   */
  async _sourceMemberAllowed(entity_id, source_hub_id, eligCache, drumateCache) {
    const key = `${source_hub_id}:${entity_id}`;
    if (eligCache.has(key)) return eligCache.get(key);
    let allowed;
    if (entity_id === source_hub_id) {
      // Back into the room it came from: only the caller's own right matters.
      allowed = await this._hubChatAllowed(source_hub_id);
    } else {
      // A recipient is a person or a hub, and only a person can be a member of
      // the source workspace. The distinction has to be made explicitly:
      // `permission` is a COMMON table, so a hub DB has a `resource_id='*'` row
      // granting its own owner privilege 63 — reading the source hub's table
      // for another HUB id would otherwise sometimes match and let the message
      // leave its workspace.
      let drumate;
      try {
        drumate = await this._drumateFor(entity_id, drumateCache);
      } catch (e) {
        this.warn("[chat.forward] drumate lookup failed", entity_id, e && e.message);
        drumate = null;
      }
      allowed = isEmpty(drumate)
        ? false
        : await this._hubChatAllowed(source_hub_id, entity_id);
    }
    eligCache.set(key, allowed);
    return allowed;
  }

  /**
   * Resolve one forward recipient with request-local caches only.
   *
   * `source_hub_id` is the workspace the forwarded message was read from, or
   * null for a P2P conversation (which belongs to no workspace). It selects the
   * rule, and the drumate lookup still runs either way because
   * `_distributeMessage` needs that classification to pick its write path.
   */
  async _canChatWith(entity_id, eligCache, drumateCache, source_hub_id = null) {
    // Out of a workspace conversation: confined to that workspace's chat
    // members. Nothing else qualifies a recipient here — not being a contact,
    // not being a member of some other workspace the caller belongs to.
    // It resolves the drumate row itself, and caches it for _distributeMessage.
    if (source_hub_id) {
      return this._sourceMemberAllowed(
        entity_id,
        source_hub_id,
        eligCache,
        drumateCache,
      );
    }

    let drumate;
    try {
      drumate = await this._drumateFor(entity_id, drumateCache);
    } catch (e) {
      this.warn("[chat.forward] drumate lookup failed", entity_id, e && e.message);
      return false;
    }

    // P2P source: unchanged contact-or-registered-drumate policy, plus any hub
    // the caller may chat in.
    if (eligCache.has(entity_id)) return eligCache.get(entity_id);
    let allowed = await this._p2pAllowed(entity_id, drumate);
    if (allowed && isEmpty(drumate)) {
      // A formal-contact match is still a P2P recipient even if the yellow-page
      // lookup is temporarily empty. Preserve that classification downstream.
      drumate = { id: entity_id, contact: 1 };
      drumateCache.set(entity_id, drumate);
    }
    if (!allowed) allowed = await this._hubChatAllowed(entity_id);
    eligCache.set(entity_id, allowed);
    return allowed;
  }

  /**
   * Batch eligibility for the forward picker, mirroring the guard in forward().
   *
   * With `source_hub_id` (a workspace conversation) each requested id is scored
   * as a recipient of THAT workspace: its own id when the caller may chat there,
   * a person when they are a chat member of it, and 0 for every other hub.
   * Without it (P2P) the question is only whether the caller may chat in each
   * requested hub — contact rows need no request in that case.
   *
   * The response never distinguishes a missing hub, a non-member, an expired
   * member or a failed lookup.
   */
  async forward_eligibility() {
    const requested = this.input.use("hub_ids");
    const sourceHubId = this.input.use("source_hub_id");
    if (!isArray(requested) || requested.length > MAX_ELIGIBILITY_HUBS ||
      requested.some((hub_id) => typeof hub_id !== "string")) {
      return this.output.data({ status: "INVALID_HUB_IDS" });
    }
    if (sourceHubId != null &&
      (typeof sourceHubId !== "string" || !ENTITY_ID_RE.test(sourceHubId))) {
      return this.output.data({ status: "INVALID_HUB_IDS" });
    }

    const hubIds = [...new Set(requested)];
    const eligibility = Object.create(null);
    for (const hub_id of hubIds) eligibility[hub_id] = 0;

    // Secure-share sessions are creator-bound; never expose the creator's hub
    // memberships through this read endpoint.
    if (this.input.get("token")) return this.output.data(eligibility);

    // Same precondition as forward(): no relaying out of a workspace the caller
    // may not chat in, so every row reads 0 rather than leaking its membership.
    if (sourceHubId && !(await this._hubChatAllowed(sourceHubId))) {
      return this.output.data(eligibility);
    }

    const eligCache = new Map();
    const drumateCache = new Map();
    for (const hub_id of hubIds) {
      if (!ENTITY_ID_RE.test(hub_id)) continue;
      const ok = sourceHubId
        ? await this._sourceMemberAllowed(
          hub_id,
          sourceHubId,
          eligCache,
          drumateCache,
        )
        : await this._hubChatAllowed(hub_id);
      eligibility[hub_id] = ok ? 1 : 0;
    }
    this.output.data(eligibility);
  }

  /**
   *
   */
  async _distributeMessage(input, message, thread_id, entities, drumateCache = new Map()) {
    let temp_result = [];
    let mydata = {};
    let socket_id = this.input.get(Attr.socket_id);
    for (let entity_id of entities) {
      const drumate = await this._drumateFor(entity_id, drumateCache);
      const entityInput = { ...input, entity_id };
      const message_id = entityInput.message_id || await this.yp.await_func("uniqueId");
      entityInput.message_id = message_id;
      if (!isEmpty(drumate)) {
        // Single write: message stored in sender's DB only.
        // p2p_post_message SP handles cross-DB p2p_time update for receiver.
        entityInput.peer_id = entity_id;
        mydata = await this.yp.await_proc(
          "forward_proc",
          this.uid,
          "p2p_post_message",
          `'${stringify(entityInput)}','${message}'`
        );
        // mention_ids is returned as a JSON string from the DB; normalise to array
        if (mydata && mydata.mention_ids && !isArray(mydata.mention_ids)) {
          mydata.mention_ids = this.parseJSON(mydata.mention_ids) || [];
        }
        mydata.is_attachment = 0;
        if (!isEmpty(input.attachment)) {
          await this.yp.await_proc(
            "forward_proc",
            this.uid,
            "channel_post_attachment",
            `'${message_id}','${entity_id}','${stringify(input.attachment)}'`
          );
          mydata.is_attachment = 1;
        }

        mydata.entity = await this.entityInfo(this.uid, entity_id);
        if (!isEmpty(thread_id)) {
          mydata.thread = await this.threadInfo(thread_id, this.uid, entity_id);
        }
        let mycount = await this.yp.await_proc(
          "forward_proc",
          this.uid,
          "count_yet_read_next",
          `'${this.uid}','${entity_id}'`
        );
        mydata.room = mycount.room;
        mydata.total = mycount.total;
        mydata.to_id = this.uid;
        mydata.echoId = this.input.get("echoId");
        let profile = this.user.get("profile") || {};
        mydata.firstname = this.user.get(Attr.firstname);
        mydata.lastname = profile.lastname;

        /** Update sibling sessions */
        let myDest = await this.yp.await_proc("user_sockets", this.uid);
        myDest = toArray(myDest).filter(e => {
          return (e && socket_id && e.socket_id != socket_id)
        });
        if (!isEmpty(myDest)) {
          await RedisStore.sendData(this.payload(mydata), myDest);
        }
        temp_result.push(mydata);

        // Notify peer: WS push so they reload via p2p_list_messages (cross-DB fetch)
        let hisdata = { ...mydata };
        hisdata.to_id = entity_id;
        let hiscount = await this.yp.await_proc(
          "forward_proc",
          entity_id,
          "count_yet_read_next",
          `'${entity_id}','${this.uid}'`
        );
        hisdata.room = hiscount.room;
        hisdata.total = hiscount.total;

        let hisDest = await this.yp.await_proc("user_sockets", entity_id);
        // peer_id in the WS push must be the sender's ID so the recipient's
        // chat widget matches it against their peerId (from their perspective,
        // the peer is the sender, not themselves)
        await RedisStore.sendData(this.payload({ ...hisdata, peer_id: this.uid }), hisDest);
        temp_result.push(hisdata);

        // Log P2P mention to YP so the Mentions tab can surface it
        if (!isEmpty(input.mention_ids)) {
          const mentionedIds = isArray(input.mention_ids) ? input.mention_ids : this.parseJSON(input.mention_ids) || [];
          const msgPreview = typeof message === 'string' ? message.substring(0, 200) : '';
          for (const mentioned_uid of mentionedIds) {
            if (mentioned_uid === this.uid) continue;
            try {
              await this.yp.await_proc(
                "contact_log_activity",
                this.uid,
                mentioned_uid,
                "p2p_mention",
                { message_id: mydata.message_id, peer_id: this.uid, message: msgPreview }
              );
            } catch (e) {
              this.warn("[chat._distributeMessage] p2p_mention log failed:", e && e.message);
            }
          }
        }
      } else {
        let data = await this.yp.await_proc(
          "forward_proc",
          entity_id,
          "channel_post_message",
          `'${stringify(entityInput)}','${message}'`
        );
        data.is_attachment = 0;
        if (!isEmpty(input.attachment)) {
          await this.yp.await_proc(
            "forward_proc",
            entity_id,
            "channel_post_attachment",
            `'${message_id}','${entity_id}','${stringify(input.attachment)}'`
          );
          data.is_attachment = 1;
        }
        let profile = this.user.get("profile") || {};
        data.firstname = this.user.get(Attr.firstname);
        data.lastname = profile.lastname;
        data.hub_id = entity_id;
        let recipients = await this.yp.await_proc("entity_sockets", entity_id);
        await RedisStore.sendData(this.payload(data), recipients);
        temp_result.push(data);
      }
    }

    return temp_result;
  }

  /**
   *
   */
  async post() {
    let entity_id = this.input.need(Attr.entity_id);
    let message = this.input.use(Attr.message) || "";
    let thread_id = this.input.use(Attr.thread_id);
    let attachment = this.input.use(Attr.attachment) || [];
    let mention_ids = this.input.use('mention_ids');
    let sanity = await this._checkPostSanity(entity_id, thread_id, attachment);
    if (!sanity.ok) {
      this.output.data(sanity);
      return;
    }
    let input = {};
    let message_id = await this.yp.await_func("uniqueId");
    let sbox = await this.db.call_proc("mfs_wicket_home", this.uid);
    if (sbox && sbox[5]) { /** Created by desk_create_hub */
      sbox = { ...sbox[5] }
    }

    if (!isEmpty(attachment)) {
      if (!sbox || !sbox.hub_id || !sbox.chat_id) {
        this.error("chat.post: mfs_wicket_home returned invalid sbox", sbox);
        return this.output.data({ status: "SBOX_ERROR", sbox: stringify(sbox) });
      }
      let desdir;
      try {
        desdir = await this.yp.await_proc(
          "forward_proc",
          sbox.hub_id,
          "mfs_make_dir",
          `'${sbox.chat_id}','${stringify([message_id])}',1`
        );
        this.debug("chat.post desdir", desdir, "sbox", sbox);
        if (!desdir || desdir.failed || !desdir.id) {
          this.error("chat.post: mfs_make_dir failed", desdir);
          return this.output.data({ status: "MKDIR_ERROR", desdir: stringify(desdir) });
        }
        attachment = await this.move_attachemnt(
          sbox,
          desdir,
          attachment,
          message_id
        );
        this.debug("chat.post attachment after move", attachment);
        // Grant the P2P peer read access to the sender's sbox so that
        // media.info / media.mark_as_seen pass for the recipient's hub context.
        if (!isEmpty(attachment) && sbox.hub_id) {
          try {
            await this.yp.await_proc(
              "forward_proc",
              sbox.hub_id,
              "add_member",
              `'${entity_id}', 3, 0`
            );
            // Allow anonymous (src:anonymous) media endpoints to serve sbox files.
            // Files are protected by unguessable UUID nids — same security model as
            // all chat attachment links. This updates existing sboxes on first use.
            await this.yp.await_proc(
              "forward_proc",
              sbox.hub_id,
              "permission_grant",
              `'*', '*', 0, 1, 'system', ''`
            );
          } catch (e) {
            this.warn("chat.post: failed to grant recipient sbox access:", e && e.message);
          }
        }
      } catch (e) {
        this.error("chat.post attachment error", e);
        return this.output.data({
          status: "ATTACHMENT_ERROR",
          message: e && e.message ? e.message : String(e),
          desdir: stringify(desdir),
          sbox_hub_id: sbox && sbox.hub_id,
          sbox_chat_id: sbox && sbox.chat_id,
        });
      }
    }
    input.author_id = this.uid;
    input.uid = this.uid;
    if (!isEmpty(attachment)) {
      input.attachment = attachment;
    }
    if (!isEmpty(message)) {
      message = message.replace(/'/gi, "''");
    }
    if (!isEmpty(thread_id)) {
      input.thread_id = thread_id;
    }
    if (!isEmpty(message_id)) {
      input.message_id = message_id;
    }
    if (!isEmpty(mention_ids)) {
      input.mention_ids = mention_ids;
    }
    let res = await this._distributeMessage(input, message, thread_id, [
      entity_id,
    ]);
    this.output.data(res);
    // Core function -> the Chat bar and Avg messages/user. All three message
    // paths mark 'chat' (p2p here, workspace and file threads in channel.js):
    // "used chat" means sent a message, and splitting it three ways would put
    // a user who only ever posts in their workspace outside chat adoption.
    markFeatureUsage(this, "chat");
  }

  /**
   * Toggle the caller's emoji reaction on a P2P message. The message is
   * single-write in its author's DB: react locally when the caller authored it,
   * otherwise toggle cross-DB in the peer's DB (mirrors the get/delete paths).
   * Notifies the peer and the caller's other sessions via WebSocket.
   */
  async react() {
    const message_id = this.input.need(Attr.message_id);
    const emoji = this.input.need("emoji");
    const peer_id = this.input.get(Attr.peer_id) || this.input.need(Attr.entity_id);
    const socket_id = this.input.get(Attr.socket_id);
    const glyphs = Array.from(emoji || "");
    if (!glyphs.length || glyphs.length > 8 || /['"\\\s]/.test(emoji)) {
      return this.output.data({ status: "INVALID_EMOJI" });
    }
    // Message row lives in its author's DB. Try mine; if absent, it is the
    // peer's message -> toggle cross-DB in the peer's DB.
    let res = await this.db.await_proc(
      "p2p_message_reaction_toggle",
      message_id,
      this.uid,
      emoji
    );
    let row = Array.isArray(res) ? res[0] : res;
    if (isEmpty(row) || !row.found) {
      res = await this.yp.await_proc(
        "forward_proc",
        peer_id,
        "p2p_message_reaction_toggle",
        `'${message_id}','${this.uid}','${emoji}'`
      );
      row = Array.isArray(res) ? res[0] : res;
    }
    const reactions = row && row.reactions ? this.parseJSON(row.reactions) : {};
    // Notify the peer (peer_id in the payload is the caller's uid, mirroring
    // chat.acknowledge/chat.typing so the peer widget patches the right row).
    const hisDest = await this.yp.await_proc("user_sockets", peer_id);
    if (!isEmpty(hisDest)) {
      await RedisStore.sendData(
        this.payload({ message_id, peer_id: this.uid, reactions }, { service: "chat.react" }),
        hisDest
      );
    }
    // Update the caller's sibling sessions (exclude the originating socket).
    let myDest = await this.yp.await_proc("user_sockets", this.uid);
    myDest = toArray(myDest).filter((e) => e && (!socket_id || e.socket_id != socket_id));
    if (!isEmpty(myDest)) {
      await RedisStore.sendData(
        this.payload({ message_id, peer_id, reactions }, { service: "chat.react" }),
        myDest
      );
    }
    this.output.data({ message_id, reactions, capped: row && row.capped ? 1 : 0 });
  }

  /**
   *
   */
  async forward() {
    const requestedEntities = this.input.need(Attr.entities);
    const nodes = this.input.need(Attr.nodes) || {};
    const peer_id = this.input.use(Attr.peer_id);
    const forwards = [];
    let temp_result = [];
    const entities = [];
    const rejected = [];
    const seen = new Set();

    if (!isArray(requestedEntities)) {
      return this.output.data({ status: "INVALID_RECIPIENT", rejected });
    }
    for (const entity_id of requestedEntities) {
      if (typeof entity_id !== "string" || !ENTITY_ID_RE.test(entity_id)) {
        rejected.push(entity_id);
        continue;
      }
      if (seen.has(entity_id)) continue;
      seen.add(entity_id);
      entities.push(entity_id);
    }

    // P2P context: nodes.hub_id is the caller's own user ID (drumate entity),
    // not a hub entity. forward_message_get only knows hub channel, so we
    // look up each message via p2p_get_message with a cross-DB fallback.
    //
    // Claiming P2P for a workspace message gains nothing: the P2P path reads
    // `p2p_channel` in a drumate DB, where a workspace `channel` row does not
    // exist, so the lookup finds nothing and the request ends in
    // INVALID_MESSAGES.
    const isP2P = nodes.hub_id === this.uid;
    const sourceHubId = isP2P ? null : nodes.hub_id;

    const eligCache = new Map();
    const drumateCache = new Map();

    // A workspace message may only be relayed by someone who may chat in that
    // workspace. forward_message_get resolves the hub DB from the client's own
    // hub_id without checking the reader, so without this the caller's own
    // access to the source room was never established.
    if (sourceHubId) {
      if (typeof sourceHubId !== "string" ||
        !(await this._hubChatAllowed(sourceHubId))) {
        return this.output.data({ status: "INVALID_SOURCE", rejected });
      }
    }

    const allowed = [];
    for (const entity_id of entities) {
      if (await this._canChatWith(entity_id, eligCache, drumateCache, sourceHubId)) {
        allowed.push(entity_id);
      } else {
        rejected.push(entity_id);
      }
    }
    if (isEmpty(allowed)) {
      return this.output.data({ status: "INVALID_RECIPIENT", rejected });
    }

    if (isP2P) {
      const messageIds = isArray(nodes.messages)
        ? nodes.messages
        : (this.parseJSON(nodes.messages) || []);
      for (const message_id of messageIds) {
        // Try in my DB (messages I sent)
        let data = await this.db.await_proc("p2p_get_message", message_id);
        // Cross-DB fallback: message sent by peer (lives in peer's DB)
        if (isEmpty(data) && peer_id) {
          data = await this.yp.await_proc(
            "forward_proc",
            peer_id,
            "p2p_get_message",
            `'${message_id}'`
          );
        }
        if (isEmpty(data)) continue;
        if (!isEmpty(data.attachment)) {
          data.attachment = this.parseJSON(data.attachment);
        }
        if (!data.message) data.message = "";
        data.forward_message_id = message_id;
        forwards.push(data);
      }
    } else {
      // Hub channel forward (existing path)
      let forward_data = await this.db.await_proc("forward_message_get", nodes);
      forward_data = this.parseJSON(forward_data.result);
      for (let node of forward_data) {
        node = this.parseJSON(node);
        if (!isEmpty(node.attachment)) {
          node.attachment = this.parseJSON(node.attachment);
        }
        forwards.push(node);
      }
    }
    if (isEmpty(forwards)) {
      return this.output.data({ status: "INVALID_MESSAGES", rejected });
    }
    for (let msg of forwards) {
      const input = {
        author_id: this.uid,
        uid: this.uid,
        message: "",
      };
      if (!isEmpty(msg.attachment)) {
        input.attachment = msg.attachment;
      }
      if (isEmpty(msg.message)) {
        msg.message = "";
      }
      if (!isEmpty(msg.forward_message_id)) {
        input.forward_message_id = msg.forward_message_id;
      }
      if (!isEmpty(msg.message)) {
        msg.message = msg.message.replace(/'/gi, "''");
      }

      const r = await this._distributeMessage(
        input,
        msg.message,
        null,
        allowed,
        drumateCache
      );
      temp_result = temp_result.concat(r);
    }
    if (!isEmpty(rejected) && !isEmpty(temp_result)) {
      temp_result[0] = { ...temp_result[0], rejected };
    }
    this.output.data(temp_result);
  }

  /**
   *
   */
  async pages_to_read() {
    let entity_id = this.input.need(Attr.entity_id);
    let res = {};

    data = await this.db.await_proc(
      "my_contact_exists",
      "entity",
      entity_id,
      null,
      null
    );
    if (isEmpty(data)) {
      res.status = "INVALID_CONTACT";
      return this.output.data(res);
    }

    if (data.uid != entity_id) {
      res.status = "INVALID_CONTACT";
      return this.output.data(res);
    }

    res = await this.db.await_proc("pages_to_read", entity_id, this.uid);
    this.output.data(res);
  }

  /**
   *
   */
  async change_status() {
    let entity_id = this.input.need(Attr.entity_id);
    let status = this.input.need(Attr.status);
    let res = {};

    if (!["archived", "active"].includes(status)) {
      res.status = "INVALID_STATUS0";
      return this.output.data(res);
    }

    if (status == "archived") {
      res = await this.db.await_proc("archive_entity", entity_id);
    } else {
      res = await this.db.await_proc("unarchive_entity", entity_id);
    }
    //await this.notify_user(this.uid, res);
    let dest = await this.yp.await_proc("user_sockets", this.uid);
    await RedisStore.sendData(
      this.payload(res, { keys: { entity_id: Attr.hub_id } }),
      dest
    );
    // this.pushLiveUpdate({
    //   service: this.input.get(Attr.service),
    //   dest: {
    //     area: Attr.personal,
    //     type: Attr.drumate,
    //     hub_id: this.uid
    //   },
    //   model: res,
    //   keys: { entity_id: Attr.hub_id }

    //});

    this.output.data(res);
  }

  /**
   *
   */
  async messages() {
    let peer_id = this.input.get(Attr.peer_id) || this.input.need(Attr.entity_id);
    let page = this.input.use(Attr.page) || 1;
    let nodes = {};
    let db_name = this.user.get(Attr.db_name);
    let entity = await this.yp.await_proc(
      `${db_name}.shareroom_contact_get`,
      peer_id
    );
    nodes = {
      page: page,
      peer_id: peer_id,
    };

    let data = await this.db.await_proc("p2p_list_messages", nodes);

    if (!isArray(data)) {
      data = [data];
    }
    let messages = [];
    let recipients = [];
    for (let message of data) {
      message.entity = { id: this.uid };
      if (message.author_id != this.uid) {
        message.entity = entity;
      }

      if (message.is_notify == 1) {
        recipients.push(message.author_id);
      }
      if (!isEmpty(message.thread_id)) {
        message.thread = await this.threadInfo(message.thread_id, this.uid, peer_id);
      }
      messages.push(message);
    }
    let dest = await this.yp.await_proc("user_sockets", recipients);
    await RedisStore.sendData(
      this.payload(messages, { service: "chat.acknowledge" }),
      dest
    );

    // Why do we need to inform the reader ?
    // dest = await this.yp.await_proc("user_sockets", this.uid);
    // let model = await this.db.await_proc("notification_center_next");
    // await RedisStore.sendData(
    //   this.payload(model, { service: "messages.read" }),
    //   dest
    // );

    this.output.list(messages);
  }

  /**
   * 
   * @param {*} attachments 
   * @param {*} uid 
   * @param {*} page 
   * @returns 
   */
  async _getAttachmentsInfo(attachments, uid, page) {
    let files = [];

    for (let media of attachments) {
      let file = await this._getAttachmentInfo(uid, media);
      if (isEmpty(file)) continue;
      file.page = page;
      files.push(file);
    }
    return files;
  }

  /**
   * To get the  Attachment or media details for a  ids
   * @params {string} uid - hubid of the media
   * @params {string} mediaId - id of a media (nid)
   * @todo Need to add to globle function
   */
  async _getAttachmentInfo(uid, media) {
    let attr;
    if (typeof media.hub_id !== "undefined") {
      attr = await this.yp.await_proc(
        "forward_proc",
        media.hub_id,
        "mfs_access_node",
        `'${uid}', '${media.nid}'`
      );
    } else {
      attr = await this.yp.await_proc(
        "forward_proc",
        uid,
        "mfs_access_node",
        `'${uid}', '${media}'`
      );
    }
    if (!attr || isEmpty(attr)) return {};
    attr.privilege = attr.permission;
    delete attr["permission"];
    // Carry the folder file nid (set by channel.post for folder-promoted uploads):
    // the message attachment is a per-message sbox copy (its own nid), but its
    // chat thread is keyed by the FOLDER file. Exposing folder_nid lets the UI
    // point reply-in-thread at the same thread as the folder's "View Chat Threads".
    if (media && typeof media === "object" && media.folder_nid) {
      attr.folder_nid = `${media.folder_nid}`;
    }
    return this.output.sanitize(attr);
  }

  /**
   *
   */
  async delete() {
    let option = this.input.need(Attr.option);
    let messages = this.input.need(Attr.messages);
    let res = {};
    let data = {};
    let temp_result = [];
    this.info("chat.delete called", { option, messages, peer_id: this.input.use(Attr.peer_id) });
    if (option != "me" && option != "all") {
      res.status = "INVALID_OPTION";
      return this.output.data(res);
    }
    // P2P delete path: caller passes peer_id to signal P2P context
    let peer_id = this.input.use(Attr.peer_id);
    if (peer_id) {
      let temp_result = [];
      for (let message_id of messages) {
        let result;
        if (option === "all") {
          result = await this.db.await_proc("p2p_delete_all", { message_id, peer_id });
        } else {
          // Pass peer_id so the SP can handle the recipient (non-author) case
          result = await this.db.await_proc("p2p_delete_me", { message_id, peer_id });
        }
        // p2p_delete_* procs return { result: JSON_string } — unwrap it
        const parsed = result && typeof result.result === "string"
          ? this.parseJSON(result.result)
          : (result || {});
        this.info("chat.delete p2p result", { option, message_id, peer_id, success: parsed && parsed.SUCCESS });
        if (!parsed.SUCCESS) continue;
        temp_result.push({ message_id });
        // For "delete for all": notify peer so their UI removes the message.
        // For "delete for me": only the caller's view is updated — no peer notification.
        if (option === "all") {
          const hisDest = await this.yp.await_proc("user_sockets", peer_id);
          if (!isEmpty(hisDest)) {
            await RedisStore.sendData(
              this.payload({ message_id }, { service: "chat.delete" }),
              hisDest
            );
          }
        }
      }
      return this.output.list(temp_result);
    }

    let invalid_messageid = 0;
    let invalid_option = 0;
    for (let message_id of messages) {
      data = await this.db.await_proc("channel_get", message_id);
      if (isEmpty(data)) {
        invalid_messageid = invalid_messageid + 1;
      }
      if (!isEmpty(data)) {
        if (option == "all" && data.author_id != this.uid) {
          invalid_option = invalid_option + 1;
        }
      }
    }

    if (invalid_messageid > 0) {
      res.status = "INVALID_MESSAGES";
      return this.output.data(res);
    }

    if (invalid_option > 0) {
      res.status = "INVALID_OPTION";
      return this.output.data(res);
    }
    let result;
    if (option == "all") {
      result = await this.db.await_proc(
        "channel_delete_drumate_all",
        this.uid,
        option,
        stringify(messages)
      );
    } else {
      result = await this.db.await_proc(
        "channel_delete_drumate_me",
        this.uid,
        option,
        stringify(messages)
      );
    }
    data = result.shift() || [];
    if (!isArray(data)) {
      data = [data];
    }
    for (let message of data) {
      if (!isEmpty(message.delete_attachment)) {
        message.delete_attachment = this.parseJSON(message.delete_attachment);

        for (let tempattach of message.delete_attachment) {
          tempattach = this.parseJSON(tempattach);
          let sbox = await this.yp.await_proc(
            "forward_proc",
            tempattach.hub_id,
            "mfs_home",
            ``
          );
          let src = {
            nid: tempattach.nid,
            hub_id: tempattach.hub_id,
            mfs_root: sbox.home_dir + "/__storage__/",
          };
          await remove_node(src);
        }
      }

      temp_result.push(message);
      if (option == "all") {
        let dest = await this.yp.await_proc("user_sockets", message.entity_id);
        await RedisStore.sendData(
          this.payload(message, { keys: ["message_id"] }),
          dest
        );
      }
    }
    data = result.shift();
    if (!isArray(data)) {
      data = [data];
    }
    for (let msg of data) {
      let dest = await this.yp.await_proc("user_sockets", msg.uid);
      await RedisStore.sendData(
        this.payload(msg, { service: "chat.roominfo" }),
        dest
      );
    }
    this.output.list(temp_result);
  }

  /**
   *
   */
  async remove_attachment() {
    let nid = this.input.need(Attr.nid);
    let res = {};
    let file = await this.db.await_proc("mfs_access_node", this.uid, nid);
    if (isEmpty(file)) {
      res.status = "INVALID_ATTACHMENT";
      return this.output.data(res);
    }
    if (!includes(file.file_path, "/__chat__/__upload__/")) {
      res.status = "INVALID_ATTACHMENT";
      return this.output.data(res);
    }
    if (file.ftype == "folder" || file.ftype == "hub") {
      res.status = "INVALID_ATTACHMENT";
      return this.output.data(res);
    }
    // The chat staging folder is writable by every hub member; the ACL doc
    // promises owner-only removal — enforce it so one member cannot delete
    // another member's pending attachment.
    let owners = await this.db.await_query(
      "SELECT owner_id, origin_id FROM media WHERE id=?",
      `${nid}`
    );
    let owner = toArray(owners)[0] || {};
    if (
      `${owner.owner_id}` !== `${this.uid}` &&
      `${owner.origin_id}` !== `${this.uid}`
    ) {
      res.status = "INVALID_ATTACHMENT";
      return this.output.data(res);
    }

    await this.db.await_proc("mfs_attachment_remove", nid);
    let mfs_home = await this.db.await_proc("mfs_home");
    let src = {
      nid: nid,
      hub_id: this.hub.get(Attr.id),
      mfs_root: mfs_home.home_dir + "/__storage__/",
    };
    await remove_node(src);
    this.output.data(file)
  }

  /**
   *
   */
  count_all() {
    this.db.call_proc("all_read_count", this.output.data);
  }
}

module.exports = privateChat;
