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


class privateChat extends Entity {

  constructor(...args) {
    super(...args);
    this.post = this.post.bind(this);
    this.acknowledge = this.acknowledge.bind(this);
    this.forward = this.forward.bind(this);
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
    this.output.data({ peer_id });
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
   *
   */
  async _distributeMessage(input, message, thread_id, entities) {
    let temp_result = [];
    let mydata = {};
    let hisdata = {};
    let myinput = { ...input };
    let hisinput = { ...input };
    let acknowledge = {};
    let socket_id = this.input.get(Attr.socket_id);
    for (let entity_id of entities) {
      let drumate = await this.yp.await_proc("drumate_exists", entity_id);
      //if(!message_id) message_id = await this.db.await_proc('message_id');
      let message_id = await this.yp.await_func("uniqueId");
      if (!isEmpty(drumate)) {
        // Single write: message stored in sender's DB only.
        // p2p_post_message SP handles cross-DB p2p_time update for receiver.
        myinput.peer_id = entity_id;
        mydata = await this.yp.await_proc(
          "forward_proc",
          this.uid,
          "p2p_post_message",
          `'${stringify(myinput)}','${message}'`
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
            `'${message_id}','${this.uid}','${stringify(input.attachment)}'`
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
          `'${stringify(input)}','${msg.message}'`
        );
        await this.yp.await_proc(
          "forward_proc",
          entity_id,
          "channel_post_attachment",
          `'${message_id}','${entity_id}','${stringify(input.attachment)}'`
        );
        data.is_attachment = 0;
        if (!isEmpty(input.attachment)) {
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
  }

  /**
   *
   */
  async forward() {
    let entities = this.input.need(Attr.entities) || [];
    let nodes = this.input.need(Attr.nodes) || {};
    let peer_id = this.input.use(Attr.peer_id);
    let forwards = [];
    let temp_result = [];

    // P2P context: nodes.hub_id is the caller's own user ID (drumate entity),
    // not a hub entity. forward_message_get only knows hub channel, so we
    // look up each message via p2p_get_message with a cross-DB fallback.
    const isP2P = nodes.hub_id === this.uid;

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
    for (let msg of forwards) {
      let input = {
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

      let r = await this._distributeMessage(input, msg.message, null, entities);
      temp_result = temp_result.concat(r);
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
