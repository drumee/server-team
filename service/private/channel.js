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

const {
  Attr, RedisStore, toArray, Constants, sysEnv, Script
} = require("@drumee/server-essentials");
const { Entity, MfsTools } = require("@drumee/server-core");
const { remove_node, move_node, copy_node } = MfsTools;
const { stampAuthorIdentity } = require("../lib/message-author");

const { stringify, parse: jsonParse } = JSON;
const { isEmpty } = require("lodash");
const Crypto = require("crypto");
const { resolve: pathResolve, join: pathJoin } = require("path");
const {
  mkdirSync, writeFileSync, existsSync, symlinkSync, rmSync
} = require("fs");
const Spawn = require("child_process").spawn;

const { DOWNLOAD_FOLDER } = Constants;
const { FileIo } = require("@drumee/server-core");
const { tmp_dir, mfs_dir } = sysEnv();
const SPAWN_OPT = { detached: true, stdio: ["ignore", "ignore", "ignore"] };
const OFFLINE_DIR = pathResolve(__dirname, "..", "..", "offline", "media");
const EXPORT_CAP = 10000;
const EXPORT_MIME = { json: "application/json", pdf: "application/pdf" };

// Meeting system messages are stored as a body sentinel `[[MEETING:start|end:
// {json}]]` (no message_type) — the live chat renders them as "X started/ended
// a meeting" (see ui chat-item template/meeting-event.js). The export mirrors
// that instead of dumping the raw markup. Kept in sync with the same helper in
// offline/media/chat-export.js.
const MEETING_SENTINEL = /^\[\[MEETING:(start|end):(.+)\]\]$/;
function meetingEventText(message, fallbackName) {
  if (typeof message !== "string") return null;
  const m = message.match(MEETING_SENTINEL);
  if (!m) return null;
  let md = {};
  try { md = JSON.parse(m[2]) || {}; } catch (_) {}
  const by = md.by || fallbackName || "Someone";
  const verb = m[1] === "start" ? "started a meeting" : "ended the meeting";
  return `${by} ${verb}`;
}

/** ========================================== */
class __private_channel extends Entity {
  constructor(...args) {
    super(...args);
    this.messages = this.messages.bind(this);
    this.post = this.post.bind(this);
    this.write = this.write.bind(this);
    this.list_notifications = this.list_notifications.bind(this);
    this.read = this.read.bind(this);
    this.notify_chat = this.notify_chat.bind(this);
    this.acknowledge = this.acknowledge.bind(this);
    this.react = this.react.bind(this);
    this.typing = this.typing.bind(this);
    this.bookmark_add = this.bookmark_add.bind(this);
    this.bookmark_remove = this.bookmark_remove.bind(this);
    this.bookmark_list = this.bookmark_list.bind(this);
    this.send_ticket = this.send_ticket.bind(this);
    this.post_ticket = this.post_ticket.bind(this);
    this.show_ticket = this.show_ticket.bind(this);
    this.list_tickets = this.list_tickets.bind(this);
    this.update_ticket = this.update_ticket.bind(this);
    this.dm_init = this.dm_init.bind(this);
    this.list_conversations = this.list_conversations.bind(this);
    this.file_thread_info = this.file_thread_info.bind(this);
    this.file_thread_messages = this.file_thread_messages.bind(this);
    this.file_thread_post = this.file_thread_post.bind(this);
    this.file_thread_list_by_folder = this.file_thread_list_by_folder.bind(this);
    this.file_thread_acknowledge = this.file_thread_acknowledge.bind(this);
    this.export_scope = this.export_scope.bind(this);
    this.export = this.export.bind(this);
    this.export_fetch = this.export_fetch.bind(this);
  }

  /**
   *
   */
  notify_chat() {
    this.db.call_proc("channel_notify_messages", this.uid, this.output.data);
  }

  /**
   *
   * @returns
   */
  async _get_wicket(uid) {
    let sbox = await this.db.call_proc("mfs_wicket_home", uid);
    if (sbox && sbox[5]) {
      /** Created by desk_create_hub */
      return sbox[5];
    }
    return sbox;
  }
  /**
   *
   */
  async messages() {
    const order = this.input.use(Attr.order, "asc");
    const page = this.input.use(Attr.page) || 1;
    const nid = this.input.use(Attr.nid);
    let data = await this.db.await_proc(
      "channel_list_messages",
      this.uid,
      "date",
      order,
      page,
    );
    data = toArray(data);
    if (!isEmpty(nid)) {
      // Legacy messages (no _scope_nid) appear in every folder context for
      // backward compatibility. New messages scoped via _scope_nid stay isolated.
      data = data.filter((msg) => {
        try {
          const meta =
            typeof msg.metadata === "string"
              ? JSON.parse(msg.metadata)
              : msg.metadata || {};
          return !meta._scope_nid || meta._scope_nid === `${nid}`;
        } catch (e) {
          return true;
        }
      });
    }
    let messages = [];

    let cache = {};
    let hub_id = this.hub.get(Attr.id);
    for (let message of data) {
      // Own-authored rows keep the viewer as the entity id, but also carry the
      // SP-resolved display fields (incl. email) so a viewer who renders this
      // author as NOT "me" on their side — e.g. a creator-bound secure-share
      // recipient whose session uid equals the message author — still resolves a
      // name/email instead of falling back to the raw author id. The
      // `author_id != this.uid` branch below overwrites entity via
      // shareroom_contact_get, so this only affects self-authored rows.
      message.entity = {
        id: this.uid,
        firstname: message.firstname,
        lastname: message.lastname,
        fullname: message.fullname,
        email: message.email,
      };
      if (message.author_id != this.uid) {
        let key = message.author_id;

        if (cache[key]) {
          message.entity = cache[key];
        } else {
          message.entity = await this.yp.await_proc(
            "forward_proc",
            this.uid,
            "shareroom_contact_get",
            `'${message.author_id}'`,
          );
          cache[key] = message.entity;
        }
      }
      if (!isEmpty(message.thread_id)) {
        message.thread = await this.threadInfo(message.thread_id, hub_id);
      }
      messages.push(message);
    }

    let newest = null;
    for (const m of messages) {
      if (!newest || (m.ctime || 0) > (newest.ctime || 0)) newest = m;
    }
    if (newest && newest.message_id) {
      await this.db.await_proc(
        "channel_read_messages",
        newest.message_id,
        this.uid,
      );
    }
    let dest = await this.yp.await_proc("entity_sockets", hub_id);
    dest = toArray(dest).filter((e) => {
      return e.uid != this.uid;
    });
    await RedisStore.sendData(
      this.payload(messages, { service: "channel.acknowledge" }),
      dest,
    );

    // Why do we need to inform the reader ?
    // dest = await this.yp.await_proc('user_sockets', this.uid);
    // let db_name = this.user.get(Attr.db_name);
    // let model = await this.yp.await_proc(`${db_name}.notification_center_next`);
    // await RedisStore.sendData(this.payload(model, { service: "messages.read" }), dest);

    this.output.list(messages);
  }

  /**
   * To get the  Attachments or media details for a array of ids
   * @params {string[]} attachments - array of the media ids (nid)
   * @params {string} uid - hubid of the media
   * @todo Need to add to globle function
   */
  async _getAttachmentsInfo(attachments, uid) {
    let files = [];
    attachments = toArray(attachments);
    for (let media of attachments) {
      let file = await this._getAttachmentInfo(uid, media);
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
        `'${uid}', '${media.nid}'`,
      );
    } else {
      attr = await this.db.await_proc("mfs_access_node", uid, media);
    }
    return this.output.sanitize(attr);
  }

  async move_attachemnt(
    sbox,
    desdir,
    attachment,
    message_id,
    copy_only = false,
    folderNids = null,
  ) {
    let src = [];
    message_id = [message_id];
    // Sources promoted into the folder: tag their sbox copy with the folder file
    // nid so reply-in-thread and the folder's "View Chat Threads" resolve to ONE
    // thread (keyed by the folder file F, not the per-message sbox copy C).
    const folderSet = folderNids
      ? new Set(toArray(folderNids).map(String))
      : null;
    for (let media of attachment) {
      src.push({ nid: media, hub_id: this.hub.get(Attr.id) });
    }

    const proc = copy_only ? "mfs_copy_all" : "mfs_move_all";
    let data = await this.db.call_proc(
      proc,
      stringify(src),
      this.hub.get(Attr.id),
      desdir.id,
      sbox.hub_id,
    );
    data = toArray(data);

    let tempattachment = [];
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
          {
            const entry = { hub_id: sbox.hub_id, nid: node.des_id };
            if (folderSet && folderSet.has(`${node.nid}`)) {
              entry.folder_nid = `${node.nid}`;
            }
            tempattachment.push(entry);
          }
          if (copy_only) {
            await copy_node(src, dest, 1);
          } else {
            await move_node(src, dest);
          }
          break;
        case "copy":
          src = { nid: node.nid, mfs_root: node.src_mfs_root };
          dest = {
            nid: node.des_id,
            hub_id: sbox.hub_id,
            mfs_root: node.des_mfs_root,
          };
          {
            const entry = { hub_id: sbox.hub_id, nid: node.des_id };
            if (folderSet && folderSet.has(`${node.nid}`)) {
              entry.folder_nid = `${node.nid}`;
            }
            tempattachment.push(entry);
          }
          await copy_node(src, dest, 1);
      }
    }

    if (!copy_only) {
      for (let node of data) {
        switch (node.action) {
          case "delete":
            src = {
              nid: node.nid,
              hub_id: sbox.hub_id,
              mfs_root: node.src_mfs_root,
            };
            await remove_node(src, 1);
        }
      }
    }
    // In copy_only mode the originals still exist alongside the sbox copies;
    // pushing both here would render each attachment twice in the chat.
    if (!copy_only && this.hub.get(Attr.id) != this.uid) {
      for (let media of attachment) {
        tempattachment.push({ nid: media, hub_id: this.hub.get(Attr.id) });
      }
    }
    return tempattachment;
  }

  /**
   * Folder-scoped posts: split staged attachments (/__chat__/__upload__/)
   * into device uploads (client asked to promote them into the folder via
   * folder_attachment) and workspace copies (link-only, purged after send).
   * Staging is writable by every hub member, so each node must be anchored
   * to the hub's real chat_upload_id parent AND owned by the caller —
   * a client-supplied id alone authorizes nothing.
   */
  async _classify_staged_attachment(attachment, folder_attachment) {
    const res = { device: [], workspace: [] };
    let mfs_home = await this.db.call_proc("mfs_home");
    const staging_id = mfs_home && mfs_home.chat_upload_id;
    if (!staging_id) return res;
    const wanted = new Set(toArray(folder_attachment).map(String));
    for (let nid of toArray(attachment)) {
      let rows = await this.db.await_query(
        "SELECT id, parent_id, owner_id, origin_id, category FROM media WHERE id=?",
        `${nid}`,
      );
      let node = toArray(rows)[0];
      // Anchor on the actual staging parent — not a file_path substring,
      // which a user-created folder literally named __chat__ could spoof.
      if (!node || `${node.parent_id}` !== `${staging_id}`) continue;
      if (["folder", "hub"].includes(node.category)) continue;
      if (
        `${node.owner_id}` !== `${this.uid}` &&
        `${node.origin_id}` !== `${this.uid}`
      ) {
        this.warn("channel.post: staged attachment not owned by caller", nid);
        continue;
      }
      if (wanted.has(`${nid}`)) {
        res.device.push(`${nid}`);
      } else {
        res.workspace.push(`${nid}`);
      }
    }
    return res;
  }

  /**
   * Move staged device uploads into the scoped folder so the original lands
   * in the folder's Files tab, exactly like a direct upload would have.
   * Same-hub moves keep the node id (mfs_move_all only updates parent_id);
   * a cross-hub move re-creates the node, so remap old id -> des_id.
   */
  async _promote_staged_to_folder(deviceNids, folderNid) {
    const hub_id = this.hub.get(Attr.id);
    const src = deviceNids.map((nid) => ({ nid, hub_id }));
    let data = await this.db.call_proc(
      "mfs_move_all",
      stringify(src),
      this.uid,
      folderNid,
      hub_id,
    );
    data = toArray(data);
    const remap = {};
    for (let node of data) {
      if (node.action === "move" && node.des_id) {
        await move_node(
          { nid: node.nid, mfs_root: node.src_mfs_root },
          { nid: node.des_id, hub_id, mfs_root: node.des_mfs_root },
        );
        remap[`${node.nid}`] = `${node.des_id}`;
      }
      // 'show'/'same' rows = same-hub move: parent updated in place, no
      // physical relocation, id unchanged.
    }
    return remap;
  }

  /**
   * Promotion is confirmed by the node actually sitting under the folder —
   * not by the SP returning without error.
   */
  async _confirm_promoted(nids, folderNid) {
    const confirmed = [];
    for (let nid of toArray(nids)) {
      try {
        let rows = await this.db.await_query(
          "SELECT id FROM media WHERE id=? AND parent_id=?",
          `${nid}`,
          `${folderNid}`,
        );
        if (!isEmpty(toArray(rows))) confirmed.push(`${nid}`);
      } catch (e) {
        this.warn(
          "channel.post: promotion confirm failed",
          nid,
          e && e.message,
        );
      }
    }
    return confirmed;
  }

  /**
   * Staged workspace copies are duplicates (the original never left the
   * desk) — delete them only AFTER the message and its attachment records
   * are committed, so a failed post can still be retried from staging.
   */
  async _purge_staged_copies(nids) {
    if (isEmpty(nids)) return;
    let mfs_home = await this.db.call_proc("mfs_home");
    if (!mfs_home || !mfs_home.home_dir) return;
    for (let nid of nids) {
      try {
        await this.db.await_proc("mfs_attachment_remove", nid);
        await remove_node({
          nid,
          hub_id: this.hub.get(Attr.id),
          mfs_root: `${mfs_home.home_dir}/__storage__/`,
        });
      } catch (e) {
        this.warn(
          "channel.post: failed to purge staged copy",
          nid,
          e && e.message,
        );
      }
    }
  }

  /**
   * Folder windows live-append nodes from "media.new" payloads
   * (window/utils handleWsEvent) — the chat broadcast alone never reaches
   * the Files tab. Mirrors media.sendNodeAttributes.
   */
  async _notify_folder_new_nodes(nids, folderNid) {
    if (isEmpty(nids)) return;
    const hub_id = this.hub.get(Attr.id);
    let recipients = toArray(
      await this.yp.await_proc("entity_sockets", { hub_id }),
    );
    if (isEmpty(recipients)) return;
    for (let nid of nids) {
      const nodes = {};
      for (let r of recipients) {
        if (!r || !r.uid) continue;
        let attr =
          nodes[r.uid] ||
          (await this.db.await_proc("mfs_access_node", r.uid, nid));
        nodes[r.uid] = attr;
        if (isEmpty(attr) || !attr.nid) continue;
        try {
          await RedisStore.sendData(
            this.payload(attr, { service: "media.new" }),
            r,
          );
        } catch (e) {
          this.warn(
            "channel.post: media.new notify failed",
            nid,
            e && e.message,
          );
        }
      }
    }
  }

  /**
   *
   * @param {*} thread_id
   * @param {*} uid
   * @returns
   */
  async threadInfo(thread_id, uid) {
    let thread = {};
    let data = await this.yp.await_proc(
      "forward_proc",
      uid,
      "channel_get",
      `'${thread_id}'`,
    );

    if (isEmpty(data)) {
      thread.message = "DELETED";
      thread.message_id = data.message_id;
      return thread;
    }

    thread.message = data.message;
    thread.message_id = data.message_id;
    thread.is_attachment = 0;
    if (!isEmpty(data.attachment)) {
      thread.is_attachment = 1;
    }
    thread.author_id = data.author_id;
    thread.entity = await this.yp.await_proc(
      "forward_proc",
      this.uid,
      "shareroom_contact_get",
      `'${data.author_id}'`,
    );

    return thread;
  }

  /**
   *
   */
  async list_tickets() {
    let status = this.input.use(Attr.status) || ["new"];
    const page = this.input.use(Attr.page) || 1;
    const search_ticket_id = this.input.use(Attr.ticket_id);

    let filter = {};
    let tickets = [];
    filter.status = status;
    if (!isEmpty(search_ticket_id)) {
      filter.search_ticket_id = search_ticket_id;
    }

    let sbox = await this._get_wicket(this.uid);
    let data = await this.yp.await_proc(
      "forward_proc",
      sbox.hub_id,
      "ticket_list",
      `'${this.uid}','${stringify(filter)}','${page}'`,
    );

    data = toArray(data);

    for (let ticket of data) {
      ticket.metadata = this.parseJSON(ticket.metadata);
      tickets.push(ticket);
    }
    this.output.data(tickets);
  }

  /**
   *
   * @returns
   */
  async update_ticket() {
    const ticket_id = this.input.need(Attr.ticket_id);
    let status = this.input.use(Attr.status);
    let res = {};
    let metadata = {};
    let support_domain_id = Cache.getSysConf("support_domain");
    let my_org = await this.yp.await_proc("my_organisation", this.uid);

    if (my_org.domain_id != support_domain_id) {
      res.status = "INVALID_DOMAIN";
      return this.output.data(res);
    }

    if (!isEmpty(status)) {
      metadata.status = status;
    }
    let ticket = await this.yp.await_proc("ticket_detail", ticket_id);
    if (isEmpty(ticket)) {
      res.status = "INVALID_TICKET";
      return this.output.data(res);
    }
    ticket = await this.yp.call_proc(
      "ticket_update_metadata",
      ticket_id,
      metadata,
    );
    ticket.metadata = this.parseJSON(ticket.metadata);

    let recipients = await this.yp.await_proc("user_sockets", ticket.uid);
    await RedisStore.sendData(this.payload(ticket), recipients);

    let support = await this.yp.call_proc(
      "member_list_all",
      "all",
      Cache.getSysConf("support_domain"),
    );
    support = toArray(support);

    for (let member of support) {
      let recipients = await this.yp.await_proc(
        "user_sockets",
        member.drumate_id,
      );
      await RedisStore.sendData(this.payload(ticket), recipients);
    }
    this.output.data(ticket);
  }

  /**
   *
   */
  async show_ticket() {
    const page = this.input.use(Attr.page) || 1;
    const ticket_id = this.input.need(Attr.ticket_id);

    let ticket = await this.yp.await_proc("ticket_detail", ticket_id);
    let sbox = await this.yp.await_proc(
      "forward_proc",
      ticket.uid,
      "mfs_wicket_home",
      `'${ticket.uid}'`,
    );
    if (sbox[5]) {
      /** Created by desk_create_hub */
      sbox = { ...sbox[5] };
    }

    let data = await this.yp.await_proc(
      "forward_proc",
      sbox.hub_id,
      "ticket_show",
      `${ticket_id},'${this.uid}','${page}'`,
    );
    data = toArray(data);

    let messages = [];
    for (let message of data) {
      if (message.is_seen == 1 && message.is_notify == 1) {
        let support = await this.yp.call_proc(
          "member_list_all",
          this.uid,
          Cache.getSysConf("support_domain"),
        );
        support = toArray(support);
        for (let member of support) {
          message.service = "channel.acknowledge";
          let recipients = await this.yp.await_proc(
            "user_sockets",
            member.drumate_id,
          );
          await RedisStore.sendData(this.payload(message), recipients);
        }

        let recipients = await this.yp.await_proc("user_sockets", this.uid);
        await RedisStore.sendData(this.payload(message), recipients);
      }
      message.entity = { id: this.uid };
      if (message.author_id != this.uid) {
        message.entity = await this.yp.await_proc(
          "forward_proc",
          this.uid,
          "shareroom_contact_get",
          `'${message.author_id}'`,
        );
      }
      message.metadata = this.parseJSON(message.metadata);
      if (message.is_ticket == 1) {
        message.metadata.category_display = [];
        for (let category of message.metadata.category) {
          switch (category) {
            case "tech":
              message.metadata.category_display.push("Tech Bug");
              break;
            case "design":
              message.metadata.category_display.push("Design Bug");
              break;
            case "notunderstand":
              message.metadata.category_display.push("Could't Understand");
              break;
            case "enhancement":
              message.metadata.category_display.push("Enhancement");
              break;
          }
        }
        message.metadata.where_display = [];
        for (let where of message.metadata.where) {
          switch (where) {
            case "desktop":
              message.metadata.where_display.push("Desktop");
              break;
            case "chat":
              message.metadata.where_display.push("Chat");
              break;
            case "contactmanager":
              message.metadata.where_display.push("Contact Manager");
              break;
            case "teamroom":
              message.metadata.where_display.push("Team Room");
              break;
            case "sharebox":
              message.metadata.where_display.push("Share Box");
              break;
            case "profile":
              message.metadata.where_display.push("Profile");
              break;
            case "others":
              message.metadata.where_display.push("Others");
              break;
          }
        }
      }
      if (!isEmpty(message.thread_id)) {
        message.thread = await this.threadInfo(message.thread_id, sbox.hub_id);
      }
      messages.push(message);
    }
    this.output.list(messages);
  }

  /**
   *
   * @param {*} hub_id
   * @param {*} ticket_id
   * @returns
   */
  async autoreply(hub_id, ticket_id) {
    let reply = {};
    let input = {};
    let metadata = {};
    let message_id = await this.yp.await_func("uniqueId");
    await this.yp.await_proc(
      "forward_proc",
      hub_id,
      "map_ticket_add",
      `'${message_id}','${ticket_id}'`,
    );
    input.author_id = "autoreply";
    input.uid = "autoreply";
    input.message_id = message_id;
    input.metadata = metadata;
    input.metadata.message_type = "ticket_auto_reply";
    let message = Cache.message("_ticket_auto_reply", this.client_language());
    let data = await this.yp.await_proc(
      "forward_proc",
      hub_id,
      "channel_post_message",
      `'${stringify(input)}','${message}'`,
    );
    return this.output.sanitize(data);
  }

  /**
   *
   */
  async send_ticket() {
    let attachment = this.input.use(Attr.attachment, []);
    let message = this.input.need(Attr.message);
    let category = this.input.need(Attr.category, []);
    let alltime = this.input.use(Attr.alltime, 0);
    let where = this.input.use(Attr.where, []);
    const f = async () => {
      let metadata = {};
      let input = {};
      let message_id = await this.yp.await_func("uniqueId");
      let sbox = await this._get_wicket(this.uid);
      if (!isEmpty(attachment)) {
        let desdir = await this.yp.await_proc(
          "forward_proc",
          sbox.hub_id,
          "mfs_make_dir",
          `'${sbox.ticket_id}','${stringify([message_id])}',1`,
        );
        attachment = await this.move_attachemnt(
          sbox,
          desdir,
          attachment,
          message_id,
        );
      }
      metadata.status = "new";
      if (!isEmpty(attachment)) {
        metadata.attachment = attachment;
      }
      if (!isEmpty(category)) {
        metadata.category = category;
      }
      if (!isEmpty(category)) {
        metadata.alltime = alltime;
      }
      if (!isEmpty(where)) {
        metadata.where = where;
      }
      if (!isEmpty(message)) {
        message = message.replace(/'/gi, "''");
      }
      metadata.message = message;

      let ticket = await this.yp.await_proc(
        "ticket_add",
        message_id,
        this.uid,
        metadata,
      );
      metadata.ticket_id = ticket.ticket_id;

      await this.yp.await_proc(
        "forward_proc",
        sbox.hub_id,
        "map_ticket_add",
        `'${message_id}','${ticket.ticket_id}'`,
      );
      input.author_id = this.uid;
      input.uid = this.uid;
      input.message_id = message_id;
      input.metadata = metadata;
      input.metadata.message_type = "ticket";
      input.ticket_id = ticket.ticket_id;
      if (!isEmpty(attachment)) {
        input.attachment = attachment;
      }
      let data = await this.yp.await_proc(
        "forward_proc",
        sbox.hub_id,
        "channel_post_message",
        `'${stringify(input)}','${message}'`,
      );
      data.is_attachment = 0;
      if (!isEmpty(input.attachment)) {
        await this.yp.await_proc(
          "forward_proc",
          sbox.hub_id,
          "channel_post_attachment",
          `'${message_id}','${sbox.hub_id}','${stringify(input.attachment)}'`,
        );
        data.is_attachment = 1;
      }
      data.ticket_id = ticket.ticket_id;
      let profile = this.user.get("profile") || {};
      data.lastname = profile.lastname;
      data.firstname = profile.firstname;
      let my_org = await this.yp.await_proc("my_organisation", this.uid);
      data.org_name = my_org.name;
      data.metadata = metadata;

      let auto = await this.autoreply(sbox.hub_id, ticket.ticket_id);
      auto.service = "channel.post";

      auto.echoId = this.input.get("echoId");
      data.echoId = this.input.get("echoId");
      let keys = { entity_id: Attr.hub_id };
      let recipients = await this.yp.await_proc("user_sockets", ticket.uid);
      await RedisStore.sendData(this.payload(data, { keys }), recipients);
      await RedisStore.sendData(this.payload(auto, { keys }), recipients);
      let support = await this.yp.call_proc(
        "member_list_all",
        this.uid,
        Cache.getSysConf("support_domain"),
      );
      support = toArray(support);

      for (let member of support) {
        let recipients = await this.yp.await_proc(
          "user_sockets",
          member.drumate_id,
        );
        await RedisStore.sendData(this.payload(data, { keys }), recipients);
        await RedisStore.sendData(this.payload(auto, { keys }), recipients);
      }

      return data;
    };
    f()
      .then((data = {}) => {
        this.output.data(data);
      })
      .catch(this.fallback);
  }

  async post_ticket() {
    let message = this.input.use(Attr.message, "");
    const thread_id = this.input.use(Attr.thread_id);
    let attachment = this.input.use(Attr.attachment, []);
    const ticket_id = this.input.need(Attr.ticket_id);
    const f = async () => {
      let input = {};
      let res = {};
      let ticket = await this.yp.await_proc("ticket_detail", ticket_id);

      if (isEmpty(ticket)) {
        res.status = "INVALID_TICKET";
        return this.output.data(res);
      }
      let message_id = await this.yp.await_func("uniqueId");
      let sbox = await this._get_wicket(ticket.uid);

      if (!isEmpty(attachment)) {
        let desdir = await this.yp.await_proc(
          "forward_proc",
          sbox.hub_id,
          "mfs_make_dir",
          `'${sbox.ticket_id}','${stringify([message_id])}',1`,
        );
        attachment = await this.move_attachemnt(
          sbox,
          desdir,
          attachment,
          message_id,
        );
      }

      await this.yp.await_proc(
        "forward_proc",
        sbox.hub_id,
        "map_ticket_add",
        `'${message_id}','${ticket.ticket_id}'`,
      );
      input.author_id = this.uid;
      input.uid = this.uid;
      input.message_id = message_id;
      input.ticket_id = ticket.ticket_id;
      input.metadata = {};
      input.metadata.message_type = "ticket";
      if (!isEmpty(attachment)) {
        input.attachment = attachment;
      }
      if (!isEmpty(message)) {
        message = message.replace(/'/gi, "''");
      }
      if (!isEmpty(thread_id)) {
        input.thread_id = thread_id;
      }
      let data = await this.yp.await_proc(
        "forward_proc",
        sbox.hub_id,
        "channel_post_message",
        `'${stringify(input)}','${message}'`,
      );
      data.is_attachment = 0;
      if (!isEmpty(input.attachment)) {
        await this.yp.await_proc(
          "forward_proc",
          sbox.hub_id,
          "channel_post_attachment",
          `'${message_id}','${sbox.hub_id}','${stringify(input.attachment)}'`,
        );
        data.is_attachment = 1;
        // data.attachment = await this._getAttachmentsInfo(data.attachment, this.hub.get(Attr.id));
      }

      if (!isEmpty(thread_id)) {
        data.thread = await this.threadInfo(thread_id, sbox.hub_id);
      }

      data.ticket_id = ticket.ticket_id;
      data.echoId = this.input.get("echoId");
      //await this.notify_user(ticket.uid, data);
      let keys = { entity_id: Attr.hub_id };
      let recipients = await this.yp.await_proc("user_sockets", ticket.uid);
      await RedisStore.sendData(this.payload(data, { keys }), recipients);

      let support = await this.yp.call_proc(
        "member_list_all",
        "xxxxxxx",
        Cache.getSysConf("support_domain"),
      );
      support = toArray(support);

      for (let member of support) {
        let recipients = await this.yp.await_proc(
          "user_sockets",
          member.drumate_id,
        );
        await RedisStore.sendData(this.payload(data, { keys }), recipients);
      }

      return data;
    };
    f()
      .then((data = {}) => {
        this.output.data(data);
      })
      .catch(this.fallback);
  }

  /**
   *
   */
  async post() {
    let message = this.input.use(Attr.message, "");
    const thread_id = this.input.use(Attr.thread_id);
    let attachment = this.input.use(Attr.attachment, []);
    let folder_attachment = this.input.use("folder_attachment", []);
    const mention_ids = this.input.use("mention_ids", null);
    let exclude = this.input.need(Attr.socket_id);
    if (exclude) exclude = [exclude];
    let input = {};

    attachment = toArray(attachment).map(String);
    folder_attachment = toArray(folder_attachment).map(String);
    // Client-supplied ids flow into proc-call strings below — hard-reject
    // anything that is not a plain node id before any interpolation.
    const ID_RE = /^[0-9a-zA-Z_-]{1,32}$/;
    for (let id of [...attachment, ...folder_attachment]) {
      if (!ID_RE.test(id)) {
        this.warn("channel.post: malformed attachment id", id);
        return this.output.data({ status: "INVALID_ATTACHMENT" });
      }
    }

    let message_id = await this.db.await_proc("message_id");
    let sbox;
    message_id = message_id.id;

    if (this.hub.get(Attr.id) == this.uid) {
      sbox = await this._get_wicket(this.uid);
    } else {
      sbox = await this.db.call_proc("mfs_home");
    }
    const nid = this.input.use(Attr.nid);
    // Folder-scoped posts: device uploads sit in the hub's chat staging
    // until the message is sent. Promote them into the scoped folder first
    // (the original lands in the Files tab), then copy (not move) every
    // attachment into the sbox so the message keeps its own copy.
    const copy_only = !isEmpty(nid);
    let staged = { device: [], workspace: [] };
    let promoted = [];
    if (copy_only && !isEmpty(attachment)) {
      staged = await this._classify_staged_attachment(
        attachment,
        folder_attachment,
      );
      if (!isEmpty(staged.device)) {
        // Moving a file INTO the folder is a write — channel.post itself is
        // only read-gated, so check the destination node explicitly.
        // privilege check matches ui _K.permission.write: privilege&perm > 0
        const MFS_PERM_WRITE = 0b0001000;
        let folder = await this.db.await_proc("mfs_access_node", this.uid, nid);
        if (!isEmpty(folder) && Number(folder.privilege) & MFS_PERM_WRITE) {
          const remap = await this._promote_staged_to_folder(
            staged.device,
            nid,
          );
          attachment = attachment.map((n) => remap[n] || n);
          promoted = staged.device.map((n) => remap[n] || n);
          // A device nid the SP did not confirm stays in staging: its sbox
          // copy below is independent, so purge it like a workspace copy
          // rather than leaving a silent orphan.
          const confirmed = new Set(
            await this._confirm_promoted(promoted, nid),
          );
          const failed = [];
          promoted = promoted.filter((n) => {
            if (confirmed.has(`${n}`)) return true;
            failed.push(`${n}`);
            return false;
          });
          if (!isEmpty(failed)) {
            this.warn(
              "channel.post: promotion unconfirmed, purging from staging",
              failed,
            );
            staged.workspace.push(...failed);
          }
        } else {
          this.warn(
            "channel.post: caller lacks write on folder, staged uploads stay sbox-only",
            nid,
          );
          // Demote: keep them in the message (sbox copy) but never in the
          // folder; their staging copies get purged like workspace ones.
          staged.workspace.push(...staged.device);
          staged.device = [];
        }
      }
    }
    if (!isEmpty(attachment)) {
      let desdir = await this.yp.await_proc(
        "forward_proc",
        sbox.hub_id,
        "mfs_make_dir",
        `'${sbox.chat_id}','${stringify([message_id])}',1`,
      );
      attachment = await this.move_attachemnt(
        sbox,
        desdir,
        attachment,
        message_id,
        copy_only,
        promoted,
      );
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
    if (!isEmpty(nid)) {
      input.metadata = { _scope_nid: `${nid}` };
    }
    // Persist @-mentions so the message shows in the recipient's Mentions tab —
    // channel_list_notifications filters on mention_ids, and channel_post_message
    // reads `$.mention_ids` from the input JSON and stores it on the row. Without
    // this, an @-mention sent via channel.post is never recorded as a mention.
    if (!isEmpty(mention_ids)) {
      input.mention_ids = mention_ids;
    }
    input.message_id = message_id;
    let data = await this.yp.await_proc(
      "forward_proc",
      this.hub.get(Attr.id),
      "channel_post_message",
      `'${stringify(input)}','${message}'`,
    );
    data.is_attachment = 0;
    if (!isEmpty(input.attachment)) {
      await this.yp.await_proc(
        "forward_proc",
        this.hub.get(Attr.id),
        "channel_post_attachment",
        `'${message_id}','${this.hub.get(Attr.id)}','${stringify(input.attachment)}'`,
      );
      data.is_attachment = 1;
    }
    // Only after the message and its attachment records are committed:
    // remove the now-redundant staging copies and surface the promoted
    // files in everyone's open folder window.
    await this._purge_staged_copies(staged.workspace);
    await this._notify_folder_new_nodes(promoted, nid);

    if (!isEmpty(thread_id)) {
      data.thread = await this.threadInfo(thread_id, this.hub.get(Attr.id));
    }

    stampAuthorIdentity(this.user, data);
    data.hub_id = this.hub.get(Attr.id);
    if (nid) data.nid = nid;
    data.echoId = this.input.get("echoId");
    const meetingMatch = /^\[\[MEETING:\s*(start|end)\s*:/.exec(data.message);
    if (meetingMatch) data.message_type = `meeting.${meetingMatch[1]}`;
    let hub_id = this.hub.get(Attr.id);
    let recipients = await this.yp.await_proc("entity_sockets", {
      exclude,
      hub_id,
    });
    await RedisStore.sendData(this.payload(data), recipients);

    // Push a real-time mention notification to mentioned users who are not
    // already among the live hub recipients (mirrors channel.write). Without
    // this an @-mention in a hub/folder chat never reaches the mentioned user.
    if (!isEmpty(mention_ids)) {
      try {
        const hubRecipientUids = toArray(recipients).map((r) => r.uid);
        const extraMentionIds = mention_ids.filter(
          (id) => id !== this.uid && !hubRecipientUids.includes(id),
        );
        if (extraMentionIds.length) {
          const mentionRecipients = await this.yp.await_proc(
            "user_sockets",
            extraMentionIds,
          );
          if (!isEmpty(mentionRecipients)) {
            await RedisStore.sendData(this.payload(data), mentionRecipients);
          }
        }
      } catch (e) {
        this.warn(
          "[channel.post] mention notification failed:",
          e && e.message,
        );
      }
    }

    this.output.data(data);
  }

  /**
   * Lookup a file chat thread WITHOUT creating one. Returns current file
   * metadata plus the thread summary when a thread already exists. Opening a
   * file chat is side-effect free; the thread is created only by file_thread_post.
   */
  async file_thread_info() {
    const file_nid = this.input.use("file_nid");
    const file_thread_id = this.input.use("file_thread_id");
    if (isEmpty(file_nid) && isEmpty(file_thread_id)) {
      return this.output.data({ status: "INVALID_FILE" });
    }
    let info = toArray(
      await this.db.await_proc(
        "channel_file_thread_info",
        this.uid,
        `${file_nid || ""}`,
        `${file_thread_id || ""}`,
      ),
    )[0];
    if (isEmpty(info) || isEmpty(info.file_nid)) {
      return this.output.data({ exists_thread: 0, status: "NOT_FOUND" });
    }
    // Validate the caller can read the file itself (hydrates rename/delete state).
    const node = await this.db.await_proc(
      "mfs_access_node",
      this.uid,
      `${info.file_nid}`,
    );
    if (isEmpty(node)) {
      return this.output.data({ exists_thread: 0, status: "NO_PERMISSION" });
    }
    this.output.data(info);
  }

  /**
   * List child messages of one file thread, enriched to match channel.messages.
   * The procedure marks this thread seen (scoped) up to the page boundary.
   */
  async file_thread_messages() {
    const order = this.input.use(Attr.order, "asc");
    const page = this.input.use(Attr.page) || 1;
    let file_thread_id = this.input.use("file_thread_id");
    const file_nid = this.input.use("file_nid");
    const hub_id = this.hub.get(Attr.id);

    if (isEmpty(file_thread_id)) {
      if (isEmpty(file_nid)) return this.output.list([]);
      const byFile = toArray(
        await this.db.await_proc(
          "channel_file_thread_info",
          this.uid,
          `${file_nid}`,
          "",
        ),
      )[0];
      if (isEmpty(byFile) || !Number(byFile.exists_thread)) {
        return this.output.list([]);
      }
      file_thread_id = byFile.file_thread_id;
    }

    // Access check via the thread's file.
    const info = toArray(
      await this.db.await_proc(
        "channel_file_thread_info",
        this.uid,
        "",
        `${file_thread_id}`,
      ),
    )[0];
    // Fail closed: if the thread's file cannot be resolved or the caller
    // cannot read it, return no messages rather than leaking thread content.
    if (isEmpty(info) || isEmpty(info.file_nid)) {
      return this.output.list([]);
    }
    const node = await this.db.await_proc(
      "mfs_access_node",
      this.uid,
      `${info.file_nid}`,
    );
    if (isEmpty(node)) return this.output.list([]);

    let data = toArray(
      await this.db.await_proc(
        "channel_file_thread_list_messages",
        this.uid,
        `${file_thread_id}`,
        order,
        page,
      ),
    );
    const cache = {};
    for (let message of data) {
      message.entity = { id: this.uid };
      if (message.author_id != this.uid) {
        const key = message.author_id;
        if (cache[key]) {
          message.entity = cache[key];
        } else {
          message.entity = await this.yp.await_proc(
            "forward_proc",
            this.uid,
            "shareroom_contact_get",
            `'${message.author_id}'`,
          );
          cache[key] = message.entity;
        }
      }
      if (!isEmpty(message.thread_id)) {
        message.thread = await this.threadInfo(message.thread_id, hub_id);
      }
    }
    this.output.list(data);
  }

  /**
   * List existing file threads for files that are CURRENT direct children of a
   * folder (follows media.parent_id). Never creates threads.
   */
  async file_thread_list_by_folder() {
    const folder_nid = this.input.use("folder_nid");
    if (isEmpty(folder_nid)) return this.output.list([]);
    const folder = await this.db.await_proc(
      "mfs_access_node",
      this.uid,
      `${folder_nid}`,
    );
    if (isEmpty(folder)) return this.output.list([]);
    const order = this.input.use(Attr.order, "desc");
    const page = this.input.use(Attr.page) || 1;
    let data = await this.db.await_proc(
      "channel_file_thread_list_by_folder",
      this.uid,
      `${folder_nid}`,
      order,
      page,
    );
    this.output.list(toArray(data));
  }

  /**
   * Mark a single file thread seen up to message_id (scoped to that thread).
   * Broadcasts the acknowledgement to other participants.
   */
  async file_thread_acknowledge() {
    const file_thread_id = this.input.need("file_thread_id");
    const message_id = this.input.use(Attr.message_id);
    let exclude = this.input.need(Attr.socket_id);
    if (exclude) exclude = [exclude];
    let res = {};
    // Nothing to acknowledge without a message_id; skip the channel_get('')
    // lookup and the broadcast entirely.
    if (message_id) {
      res = await this.db.await_proc(
        "channel_file_thread_read_messages",
        `${message_id}`,
        this.uid,
        `${file_thread_id}`,
      );
      const message = await this.db.await_proc("channel_get", `${message_id}`);
      if (!isEmpty(message)) {
        message.key_id = this.hub.get(Attr.id);
        message.file_thread_id = file_thread_id;
        const recipients = await this.yp.await_proc("entity_sockets", {
          hub_id: message.key_id,
          exclude,
        });
        await RedisStore.sendData(
          this.payload(message, { service: "channel.file_thread_acknowledge" }),
          recipients,
        );
      }
    }
    this.output.data(res);
  }

  /**
   * Post a message into a file chat thread. Creates the thread + the
   * folder-visible "file.thread" root card atomically on the first message;
   * later sends reuse the same thread. Mirrors channel.post for attachments,
   * folder_attachment promotion, mentions, reply thread_id, and broadcast —
   * but the file's folder is derived from the file's current parent (never
   * trusted from the client) and the original file is never auto-attached.
   */
  async file_thread_post() {
    const file_nid = this.input.use("file_nid");
    if (isEmpty(file_nid)) {
      return this.output.data({ status: "INVALID_FILE" });
    }
    let message = this.input.use(Attr.message, "");
    const thread_id = this.input.use(Attr.thread_id);
    let attachment = this.input.use(Attr.attachment, []);
    let folder_attachment = this.input.use("folder_attachment", []);
    const mention_ids = this.input.use("mention_ids", null);
    let exclude = this.input.need(Attr.socket_id);
    if (exclude) exclude = [exclude];

    // Validate the target file: exists, is a file (not folder/hub), readable.
    const file_node = await this.db.await_proc(
      "mfs_access_node",
      this.uid,
      `${file_nid}`,
    );
    if (isEmpty(file_node)) {
      return this.output.data({ status: "NO_PERMISSION" });
    }
    // mfs_access_node returns the node's media category as `filetype` and
    // UNIONs trash_media. Reject containers (folder/hub/root) — a file chat
    // only attaches to a real file; active files carry specific categories
    // from yp.filecap (image/document/other/...), never the literal 'file'.
    const cat = `${file_node.filetype || ""}`;
    if (["folder", "hub", "root"].includes(cat)) {
      return this.output.data({ status: "INVALID_FILE" });
    }
    // Reject trashed/deleted nodes (trash_media rows surface as status
    // 'deleted'; 'orphaned' is a transient pre-purge state).
    if (["deleted", "orphaned"].includes(`${file_node.status || ""}`)) {
      return this.output.data({ status: "INVALID_FILE" });
    }
    const folder_nid = `${file_node.parent_id}`;
    if (isEmpty(folder_nid)) {
      return this.output.data({ status: "INVALID_FILE" });
    }

    attachment = toArray(attachment).map(String);
    folder_attachment = toArray(folder_attachment).map(String);
    // No-op on empty message with nothing to attach (same as sendMessage) — and
    // crucially BEFORE ensure_root, so merely opening/sending nothing creates no thread.
    if (
      isEmpty(message) &&
      isEmpty(attachment) &&
      isEmpty(folder_attachment)
    ) {
      return this.output.data({ status: "EMPTY" });
    }
    const ID_RE = /^[0-9a-zA-Z_-]{1,32}$/;
    for (let id of [...attachment, ...folder_attachment]) {
      if (!ID_RE.test(id)) {
        this.warn("channel.file_thread_post: malformed attachment id", id);
        return this.output.data({ status: "INVALID_ATTACHMENT" });
      }
    }

    const hub_id = this.hub.get(Attr.id);
    let sbox;
    if (hub_id == this.uid) {
      sbox = await this._get_wicket(this.uid);
    } else {
      sbox = await this.db.call_proc("mfs_home");
    }

    let message_id = await this.db.await_proc("message_id");
    message_id = message_id.id;
    let candidate_root = await this.db.await_proc("message_id");
    candidate_root = candidate_root.id;

    // Atomically reserve the thread + folder-visible root card (race-safe).
    let root = toArray(
      await this.db.await_proc(
        "channel_file_thread_ensure_root",
        `${file_nid}`,
        folder_nid,
        candidate_root,
        this.uid,
      ),
    )[0] || {};
    const file_thread_id = `${root.file_thread_id}`;
    const is_new = Number(root.is_new) === 1;
    if (isEmpty(file_thread_id)) {
      return this.output.data({ status: "POST_FAILED" });
    }

    // Attachments: copy into sbox + promote staged device uploads into the
    // file's parent folder when write is allowed (same as folder-scoped post).
    let input = {};
    let staged = { device: [], workspace: [] };
    let promoted = [];
    const copy_only = true;
    if (!isEmpty(attachment)) {
      staged = await this._classify_staged_attachment(
        attachment,
        folder_attachment,
      );
      if (!isEmpty(staged.device)) {
        const MFS_PERM_WRITE = 0b0001000;
        let folder = await this.db.await_proc(
          "mfs_access_node",
          this.uid,
          folder_nid,
        );
        if (!isEmpty(folder) && Number(folder.privilege) & MFS_PERM_WRITE) {
          const remap = await this._promote_staged_to_folder(
            staged.device,
            folder_nid,
          );
          attachment = attachment.map((n) => remap[n] || n);
          promoted = staged.device.map((n) => remap[n] || n);
          const confirmed = new Set(
            await this._confirm_promoted(promoted, folder_nid),
          );
          const failed = [];
          promoted = promoted.filter((n) => {
            if (confirmed.has(`${n}`)) return true;
            failed.push(`${n}`);
            return false;
          });
          if (!isEmpty(failed)) {
            this.warn(
              "channel.file_thread_post: promotion unconfirmed, purging",
              failed,
            );
            staged.workspace.push(...failed);
          }
        } else {
          this.warn(
            "channel.file_thread_post: caller lacks write on folder, staged uploads stay sbox-only",
            folder_nid,
          );
          staged.workspace.push(...staged.device);
          staged.device = [];
        }
      }
      let desdir = await this.yp.await_proc(
        "forward_proc",
        sbox.hub_id,
        "mfs_make_dir",
        `'${sbox.chat_id}','${stringify([message_id])}',1`,
      );
      attachment = await this.move_attachemnt(
        sbox,
        desdir,
        attachment,
        message_id,
        copy_only,
      );
    }

    input.author_id = this.uid;
    input.uid = this.uid;
    input.file_thread_id = file_thread_id;
    if (!isEmpty(attachment)) input.attachment = attachment;
    if (!isEmpty(message)) message = message.replace(/'/gi, "''");
    if (!isEmpty(thread_id)) input.thread_id = thread_id;
    if (!isEmpty(mention_ids)) input.mention_ids = mention_ids;
    input.metadata = {
      _scope_nid: folder_nid,
      _file_thread_id: file_thread_id,
      _file_nid: `${file_nid}`,
    };
    input.message_id = message_id;

    let data;
    try {
      data = await this.yp.await_proc(
        "forward_proc",
        hub_id,
        "channel_post_message",
        `'${stringify(input)}','${message}'`,
      );
    } catch (e) {
      // First-child rollback: drop the just-reserved thread + card before any
      // broadcast so a failed send leaves no orphan folder card.
      if (is_new) {
        try {
          await this.db.await_proc(
            "channel_file_thread_remove_root",
            file_thread_id,
            this.uid,
          );
        } catch (_) {}
      }
      this.warn(
        "[channel.file_thread_post] child post failed:",
        e && e.message,
      );
      return this.output.data({ status: "POST_FAILED" });
    }

    data.is_attachment = 0;
    if (!isEmpty(input.attachment)) {
      await this.yp.await_proc(
        "forward_proc",
        hub_id,
        "channel_post_attachment",
        `'${message_id}','${hub_id}','${stringify(input.attachment)}'`,
      );
      data.is_attachment = 1;
    }
    await this._purge_staged_copies(staged.workspace);
    await this._notify_folder_new_nodes(promoted, folder_nid);

    // Refresh thread summary + root card metadata (reply_count, last_message, mtime).
    await this.db.await_proc(
      "channel_file_thread_post_touch",
      file_thread_id,
      `${message_id}`,
      1,
    );

    if (!isEmpty(thread_id)) {
      data.thread = await this.threadInfo(thread_id, hub_id);
    }
    stampAuthorIdentity(this.user, data);
    data.hub_id = hub_id;
    data.echoId = this.input.get("echoId");
    data.file_thread_id = file_thread_id;
    data.file_thread = {
      file_thread_id,
      root_message_id: file_thread_id,
      file_nid: `${file_nid}`,
      folder_nid,
      is_new,
    };

    const recipients = await this.yp.await_proc("entity_sockets", {
      exclude,
      hub_id,
    });

    // On new thread, broadcast the folder-visible root card as a normal
    // channel.post so folder chat renders the "file thread started" card.
    if (is_new) {
      try {
        let card = toArray(
          await this.db.await_proc("channel_get", file_thread_id),
        )[0] || {};
        card.nid = folder_nid;
        card.hub_id = hub_id;
        card.message_type = "file.thread";
        card.file_thread_id = file_thread_id;
        card.file_nid = `${file_nid}`;
        await RedisStore.sendData(
          this.payload(card, { service: "channel.post" }),
          recipients,
        );
      } catch (e) {
        this.warn(
          "[channel.file_thread_post] root card broadcast failed:",
          e && e.message,
        );
      }
    }

    // Broadcast the child message to file-thread participants.
    await RedisStore.sendData(
      this.payload(data, { service: "channel.file_thread_post" }),
      recipients,
    );

    // Mention notification to mentioned users not among the live hub recipients.
    if (!isEmpty(mention_ids)) {
      try {
        const hubRecipientUids = toArray(recipients).map((r) => r.uid);
        const extraMentionIds = mention_ids.filter(
          (id) => id !== this.uid && !hubRecipientUids.includes(id),
        );
        if (extraMentionIds.length) {
          const mentionRecipients = await this.yp.await_proc(
            "user_sockets",
            extraMentionIds,
          );
          if (!isEmpty(mentionRecipients)) {
            await RedisStore.sendData(
              this.payload(data, { service: "channel.file_thread_post" }),
              mentionRecipients,
            );
          }
        }
      } catch (e) {
        this.warn(
          "[channel.file_thread_post] mention notification failed:",
          e && e.message,
        );
      }
    }

    this.output.data(data);
  }

  /**
   * Ephemeral typing indicator. Broadcasts the caller's typing state to all
   * other hub participants over WebSocket. Nothing is persisted.
   */
  async typing() {
    let exclude = this.input.need(Attr.socket_id);
    if (exclude) exclude = [exclude];
    let hub_id = this.hub.get(Attr.id);
    let profile = this.user.get("profile") || {};
    let data = {
      author_id: this.uid,
      uid: this.uid,
      firstname: this.user.attributes.firstname,
      lastname: profile.lastname,
      hub_id,
      state: this.input.use("state", 1),
    };
    let recipients = await this.yp.await_proc("entity_sockets", {
      exclude,
      hub_id,
    });
    await RedisStore.sendData(
      this.payload(data, { service: "channel.typing" }),
      recipients,
    );
    this.output.data({ ok: 1 });
  }

  /**
   * Post a message to a share hub channel.
   * Supports both authenticated (yp.drumate) and anonymous (yp.dmz_user) authors.
   * message_id is generated server-side via message_id SP.
   */
  async write() {
    let message = this.input.use(Attr.message, "");
    const thread_id = this.input.use(Attr.thread_id);
    let attachment = this.input.use(Attr.attachment, []);
    const is_forward = this.input.use(Attr.is_forward, 0);
    const mention_ids = this.input.use("mention_ids", null);
    let exclude = this.input.need(Attr.socket_id);
    if (exclude) exclude = [exclude];

    let message_id = await this.db.await_proc("message_id");
    message_id = message_id.id;

    let sbox = await this.db.call_proc("mfs_home");
    if (!isEmpty(attachment)) {
      let desdir = await this.yp.await_proc(
        "forward_proc",
        sbox.hub_id,
        "mfs_make_dir",
        `'${sbox.chat_id}','${stringify([message_id])}',1`,
      );
      attachment = await this.move_attachemnt(
        sbox,
        desdir,
        attachment,
        message_id,
      );
    }

    if (!isEmpty(message)) {
      message = message.replace(/'/gi, "''");
    }

    let data = await this.db.await_proc(
      "channel_write",
      this.uid,
      message_id,
      message,
      thread_id || null,
      !isEmpty(attachment) ? stringify(attachment) : null,
      is_forward,
      !isEmpty(mention_ids) ? stringify(mention_ids) : null,
    );

    data.is_attachment = !isEmpty(attachment) ? 1 : 0;

    if (!isEmpty(thread_id)) {
      data.thread = await this.threadInfo(thread_id, this.hub.get(Attr.id));
    }

    data.hub_id = this.hub.get(Attr.id);
    data.echoId = this.input.get("echoId");

    let hub_id = this.hub.get(Attr.id);
    let recipients = await this.yp.await_proc("entity_sockets", {
      exclude,
      hub_id,
    });
    await RedisStore.sendData(this.payload(data), recipients);

    if (!isEmpty(mention_ids)) {
      try {
        const hubRecipientUids = toArray(recipients).map((r) => r.uid);
        const extraMentionIds = mention_ids.filter(
          (id) => id !== this.uid && !hubRecipientUids.includes(id),
        );
        if (extraMentionIds.length) {
          const mentionRecipients = await this.yp.await_proc(
            "user_sockets",
            extraMentionIds,
          );
          if (!isEmpty(mentionRecipients)) {
            await RedisStore.sendData(this.payload(data), mentionRecipients);
          }
        }
      } catch (e) {
        this.warn(
          "[channel.write] mention notification failed:",
          e && e.message,
        );
      }
    }

    // Track chat_initiated
    try {
      const track = await this.db.await_proc(
        "share_track_add",
        "chat_initiated",
        this.uid,
        null,
      );
      const row = toArray(track)[0] || {};
      if (row.inserted) {
        const trackRecipients = await this.yp.await_proc("entity_sockets", {
          hub_id,
        });
        await RedisStore.sendData(
          this.payload(
            {
              event: "chat_initiated",
              actor_id: this.uid,
              firstname: row.firstname,
              lastname: row.lastname,
            },
            { service: "share.track_event" },
          ),
          trackRecipients,
        );
      }
    } catch (e) {
      this.warn(
        "[channel.write] chat_initiated tracking failed:",
        e && e.message,
      );
    }

    this.output.data(data);
  }

  /**
   * Retrieve paginated notifications for the current user across all hubs.
   * Supports type filter (all / mention / share) and unread-only toggle.
   */
  async list_notifications() {
    const VALID_TYPES = ["all", "mention", "share"];
    let type = this.input.use(Attr.type, "all");
    if (!VALID_TYPES.includes(type)) type = "all";
    const unread_only = this.input.use("unread_only", 0) ? 1 : 0;
    const page = this.input.use(Attr.page, 1);

    // Get all active hubs for the current user via their drumate media table.
    // yp.entity does not have an owner_id column; the user's drumate DB (this.db)
    // tracks all hubs they own/belong to via the media table (category='hub').
    let hubs = [];
    try {
      hubs = toArray(
        await this.db.await_query(
          `SELECT m.id AS id, e.db_name, IFNULL(h.name, m.user_filename) AS name
           FROM media m
           INNER JOIN yp.entity e ON e.id = m.id
           LEFT JOIN yp.hub h ON h.id = m.id
           WHERE m.category = 'hub' AND m.status = 'active'`,
        ),
      );
    } catch (e) {
      this.warn(
        "[channel.list_notifications] hub list query failed:",
        e && e.message,
      );
    }

    // Query channel_list_notifications per hub and aggregate results
    let all_notifications = [];
    for (const hub of hubs) {
      if (!hub.db_name) continue;
      try {
        const rows = toArray(
          await this.yp.await_proc(
            `${hub.db_name}.channel_list_notifications`,
            this.uid,
            type,
            unread_only,
            1,
          ),
        );
        // Tag each row with hub context for renderer
        for (const row of rows) {
          row.hub_id = hub.id;
          row.category = "teamchat";
          row.hub_name = hub.name || "";
          all_notifications.push(row);
        }
      } catch (e) {
        this.warn(
          `[channel.list_notifications] hub ${hub.id} query failed:`,
          e && e.message,
        );
      }
    }

    // Include P2P mentions from yp.contact_activity for mention/all tabs
    if (type === "mention" || type === "all") {
      try {
        const p2pMentions = toArray(
          await this.yp.await_query(
            `SELECT ca.id, ca.timestamp AS ctime, ca.uid AS author_id,
              JSON_UNQUOTE(JSON_EXTRACT(ca.data, '$.message_id')) AS message_id,
              JSON_UNQUOTE(JSON_EXTRACT(ca.data, '$.peer_id')) AS drumate_id,
              JSON_UNQUOTE(JSON_EXTRACT(ca.data, '$.message')) AS message,
              CONCAT('["', ca.target_uid, '"]') AS mention_ids,
              COALESCE(CONCAT(d.firstname, ' ', d.lastname), d.email, '') AS fullname,
              COALESCE(d.firstname, '') AS firstname,
              COALESCE(d.lastname, '') AS lastname,
              0 AS is_read
            FROM yp.contact_activity ca
            LEFT JOIN yp.drumate d ON d.id = ca.uid
            WHERE ca.target_uid = ? AND ca.event = 'p2p_mention' AND ca.dismissed_at IS NULL
            ORDER BY ca.timestamp DESC LIMIT 45`,
            this.uid,
          ),
        );
        for (const row of p2pMentions) {
          if (unread_only && row.is_read) continue;
          // Use contact_invite category so the UI dismisses via contact_activity_dismiss
          // (sets dismissed_at). The mention_ids field makes the skeleton render it as
          // a mention ("X mentioned you") despite the contact_invite category.
          row.category = "contact_invite";
          all_notifications.push(row);
        }
      } catch (e) {
        this.warn(
          "[channel.list_notifications] p2p mention query failed:",
          e && e.message,
        );
      }
    }

    // Include task @-mentions (logged by task._notifyMentions) for mention/all.
    // `name` carries the task title so the item renders "mentioned you in <task>".
    // NULLIF on the JSON reads: JSON_UNQUOTE(JSON_EXTRACT(...)) returns the 4-char
    // STRING 'null' for a JSON null, not SQL NULL. The client then navigated to
    // nid='null', which matches no node → "the file you requested does not exist".
    // Collapsing it back to a real NULL makes a nid-less row fall back to the
    // workspace root instead of erroring. `task_kind` distinguishes a reply
    // ('reply') from a true @-mention so the item can render the right sentence.
    if (type === "mention" || type === "all") {
      try {
        const taskMentions = toArray(
          await this.yp.await_query(
            `SELECT ca.id, ca.timestamp AS ctime, ca.uid AS author_id,
              JSON_UNQUOTE(JSON_EXTRACT(ca.data, '$.task_id')) AS task_id,
              JSON_UNQUOTE(JSON_EXTRACT(ca.data, '$.hub_id')) AS hub_id,
              NULLIF(JSON_UNQUOTE(JSON_EXTRACT(ca.data, '$.nid')), 'null') AS nid,
              NULLIF(JSON_UNQUOTE(JSON_EXTRACT(ca.data, '$.kind')), 'null') AS task_kind,
              JSON_UNQUOTE(JSON_EXTRACT(ca.data, '$.title')) AS name,
              CONCAT('["', ca.target_uid, '"]') AS mention_ids,
              COALESCE(CONCAT(d.firstname, ' ', d.lastname), d.email, '') AS fullname,
              COALESCE(d.firstname, '') AS firstname,
              COALESCE(d.lastname, '') AS lastname,
              0 AS is_read
            FROM yp.contact_activity ca
            LEFT JOIN yp.drumate d ON d.id = ca.uid
            WHERE ca.target_uid = ? AND ca.event = 'task_mention' AND ca.dismissed_at IS NULL
            ORDER BY ca.timestamp DESC LIMIT 45`,
            this.uid,
          ),
        );
        for (const row of taskMentions) {
          if (unread_only && row.is_read) continue;
          // contact_invite category → dismissed via contact_activity_dismiss;
          // mention_ids makes the skeleton render it as a mention.
          row.category = "contact_invite";
          row.event = "task_mention";
          all_notifications.push(row);
        }
      } catch (e) {
        this.warn(
          "[channel.list_notifications] task mention query failed:",
          e && e.message,
        );
      }
    }

    // Sort merged results by ctime DESC then apply pagination
    all_notifications.sort((a, b) => b.ctime - a.ctime);

    const PAGE_SIZE = 45;
    const offset = (page - 1) * PAGE_SIZE;
    const paged = all_notifications.slice(offset, offset + PAGE_SIZE);

    this.output.list(paged);
  }

  // ========================
  //
  // ========================
  read() {
    const id = this.input.use(Attr.id);
    this.db.call_proc("channel_read_messages", id, this.uid, this.output.data);
  }

  pages_to_read() {
    this.db.call_proc("pages_to_read", this.uid, this.output.data);
  }

  /**
   *
   */
  async acknowledge() {
    const message_id = this.input.use(Attr.message_id);
    // A personal/drumate entity resolved as the hub (e.g. a P2P conversation
    // whose hub_id is the peer's personal entity_id). Personal DBs carry the
    // single-JSON-arg acknowledge_message (not the 2-arg hub form), and P2P
    // read receipts are owned by chat.acknowledge (contact.js) against the
    // caller's own DB — so the hub path here both crashes
    // (ER_SP_WRONG_NO_OF_ARGS) and would target the wrong DB. Skip it cleanly.
    if (this.hub.get(Attr.area) === "personal") {
      this.warn(
        "[channel.acknowledge] skipped on personal entity; P2P ack belongs to chat.acknowledge",
        this.hub.get(Attr.id)
      );
      return this.output.data({});
    }
    let exclude = this.input.need(Attr.socket_id);
    if (exclude) exclude = [exclude];

    let res = {};
    res = await this.db.await_proc("acknowledge_message", message_id, this.uid);
    // Persist the reader into metadata._seen_ for every message up to message_id
    // (read receipts). acknowledge_message only advances the read_channel cursor,
    // so without this the reader never appears in _seen_ on a fresh load — they
    // would only flicker in via the live broadcast below.
    if (message_id) {
      await this.db.await_proc("channel_read_messages", message_id, this.uid);
    }
    let message = await this.db.await_proc("channel_get", message_id);
    message.key_id = this.hub.get(Attr.id);
    let recipients = await this.yp.await_proc("entity_sockets", {
      hub_id: message.key_id,
      exclude,
    });
    await RedisStore.sendData(this.payload(message), recipients);
    this.output.data(res);
  }

  /**
   * Toggle the caller's emoji reaction on a channel message (add if absent,
   * remove if present). Stored per-message in metadata._reactions_ alongside
   * read receipts (_seen_ untouched). Broadcasts the updated reactions map to
   * every other socket in the hub (caller's socket excluded).
   */
  async react() {
    const message_id = this.input.need(Attr.message_id);
    const emoji = this.input.need("emoji");
    let exclude = this.input.need(Attr.socket_id);
    if (exclude) exclude = [exclude];
    const glyphs = Array.from(emoji || "");
    if (!glyphs.length || glyphs.length > 8 || /['"\\\s]/.test(emoji)) {
      return this.output.data({ status: "INVALID_EMOJI" });
    }
    const res = await this.db.await_proc(
      "message_reaction_toggle",
      message_id,
      this.uid,
      emoji
    );
    const row = Array.isArray(res) ? res[0] : res;
    const reactions = row && row.reactions ? this.parseJSON(row.reactions) : {};
    const hub_id = this.hub.get(Attr.id);
    const data = { message_id, reactions, key_id: hub_id };
    const recipients = await this.yp.await_proc("entity_sockets", { hub_id, exclude });
    await RedisStore.sendData(
      this.payload(data, { service: "channel.react" }),
      recipients
    );
    this.output.data({ message_id, reactions, capped: row && row.capped ? 1 : 0 });
  }

  /**
   *
   */
  async acknowledge_ticket() {
    const message_id = this.input.use(Attr.message_id);
    const ticket_id = this.input.need(Attr.ticket_id);
    const f = async () => {
      let ticket = await this.yp.await_proc("ticket_detail", ticket_id);
      let sbox = await this.yp.await_proc(
        "forward_proc",
        ticket.uid,
        "mfs_wicket_home",
        `'${ticket.uid}'`,
      );

      let res = {};
      res = await this.yp.await_proc(
        "forward_proc",
        sbox.hub_id,
        "acknowledge_message",
        `'${message_id}','${this.uid}'`,
      );
      let message = await this.yp.await_proc(
        "forward_proc",
        sbox.hub_id,
        "channel_get",
        `'${message_id}'`,
      );

      let support = await this.yp.call_proc(
        "member_list_all",
        this.uid,
        Cache.getSysConf("support_domain"),
      );
      support = toArray(support);
      for (let member of support) {
        message.service = "channel.acknowledge";
        let service = message.service;
        let recipients = await this.yp.await_proc(
          "user_sockets",
          member.drumate_id,
        );
        await RedisStore.sendData(
          this.payload(message, { service }),
          recipients,
        );
      }

      let recipients = await this.yp.await_proc("user_sockets", this.uid);
      await RedisStore.sendData(this.payload(message), recipients);
      return this.output.data(res);
    };
    f()
      .then((r) => {
        this.output.data(r);
      })
      .catch(this.fallback);
  }

  // ========================
  //
  // ========================
  async clear_notifications() {
    //await this.notify_user(this.uid, {});
    let recipients = await this.yp.await_proc("user_sockets", this.uid);
    await RedisStore.sendData(this.payload({}), recipients);
    let data = await this.db.await_proc(
      "channel_clear_notifications",
      this.uid,
    );
    this.output.data(data);
  }

  /**
   * To create a RTC session Offer
   * see : https://webrtc.org/getting-started/firebase-rtc-codelab
   * @params {object} as specified by https://www.w3.org/TR/webrtc/#rtcpeerconnection-interface
   */
  async createRTCOffer() {
    const offer = this.input.need("offer");
    const data = {
      callerId: this.uid,
      roomId: Crypto.randomBytes(32).toString("base64"),
    };
    let recipients = await this.yp.await_proc("user_sockets", this.uid);
    await RedisStore.sendData(this.payload(data), recipients);
    this.output.data(data);
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

    if (option != "me" && option != "all") {
      res.status = "INVALID_OPTION";
      return this.output.data(res);
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
        "channel_delete_hub_all",
        this.uid,
        option,
        stringify(messages),
      );
    } else {
      result = await this.db.await_proc(
        "channel_delete_hub_me",
        this.uid,
        option,
        stringify(messages),
      );
    }
    data = result.shift() || [];
    data = toArray(data);
    for (let message of data) {
      if (!isEmpty(message.delete_attachment)) {
        message.delete_attachment = this.parseJSON(message.delete_attachment);
        for (let tempattach of message.delete_attachment) {
          let { nid, hub_id } = this.parseJSON(tempattach) || {};
          if (!nid || !hub_id) continue;
          let { home_dir } = await this.yp.await_proc(
            "forward_proc",
            hub_id,
            "mfs_home",
            ``,
          );
          let src = { nid, hub_id, home_dir };
          await remove_node(src);
        }
      }

      temp_result.push(message);

      if (option == "all") {
        let recipients = await this.yp.await_proc(
          "entity_sockets",
          this.hub.get(Attr.id),
        );
        await RedisStore.sendData(this.payload(message), recipients);
      }
    }
    data = result.shift();
    data = toArray(data);
    let service = "channel.roominfo";
    for (let msg of data) {
      let recipients = await this.yp.await_proc("user_sockets", msg.uid);
      await RedisStore.sendData(this.payload(msg, { service }), recipients);
    }
    this.output.list(temp_result);
  }

  /**
   * Pin (bookmark) a notification message for quick access.
   * Stores message_id + hub_id in notification_bookmark table (user drumate DB).
   */
  async bookmark_add() {
    const message_id = this.input.need("message_id");
    const hub_id = this.input.need("hub_id");

    const user_db = await this.yp.await_func("get_db_name", this.uid);
    if (!user_db) return this.exception.server("USER_DB_NOT_FOUND");

    const data = await this.yp.await_proc(
      `${user_db}.notification_bookmark_add`,
      message_id,
      hub_id,
    );
    this.output.data(data);
  }

  /**
   * Unpin (remove) a previously bookmarked notification.
   */
  async bookmark_remove() {
    const message_id = this.input.need("message_id");

    const user_db = await this.yp.await_func("get_db_name", this.uid);
    if (!user_db) return this.exception.server("USER_DB_NOT_FOUND");

    const data = await this.yp.await_proc(
      `${user_db}.notification_bookmark_remove`,
      message_id,
    );
    this.output.data(data);
  }

  /**
   * List all bookmarked notifications for the current user (paginated).
   */
  async bookmark_list() {
    const page = this.input.use(Attr.page, 1);

    const user_db = await this.yp.await_func("get_db_name", this.uid);
    if (!user_db) return this.exception.server("USER_DB_NOT_FOUND");

    const data = await this.yp.await_proc(
      `${user_db}.notification_bookmark_list`,
      page,
    );
    this.output.list(data);
  }

  /**
   * Get or create a 1-on-1 DM hub between the current user and a recipient.
   *
   * DM hubs use area='private' and a deterministic filename:
   *   _inbox_{lower_uid}_{higher_uid}
   * where UIDs are sorted lexicographically so the result is
   * identical regardless of who initiates the conversation.
   *
   * Returns: { hub_id, home_id, db_name, is_new }
   */
  async dm_init() {
    const recipient_id = this.input.need("recipient_id");
    if (!recipient_id || recipient_id === this.uid) {
      return this.exception.user("Invalid recipient_id.");
    }

    // Get user's drumate DB explicitly
    const user_db = await this.yp.await_func("get_db_name", this.uid);
    if (!user_db) return this.exception.server("USER_DB_NOT_FOUND");

    // Deterministic filename
    const [uid_a, uid_b] = [this.uid, recipient_id].sort();
    const dm_filename = `_inbox_${uid_a}_${uid_b}`;

    // 1. Check if DM hub already exists in user's drumate media table
    const existing = toArray(
      await this.yp.await_query(
        `SELECT m.id AS hub_id, e.db_name, e.home_id
         FROM ${user_db}.media m
         INNER JOIN yp.entity e ON e.id = m.id
         WHERE m.category = 'hub'
           AND m.user_filename = ?
           AND m.status = 'active'
         LIMIT 1`,
        dm_filename,
      ),
    )[0];

    if (existing && existing.hub_id) {
      existing.is_new = 0;
      return this.output.data(existing);
    }

    // 2. Create new DM hub — desk_create_hub runs in drumate DB context
    const domain = this.user.get(Attr.domain);
    const owner_id = this.uid;

    // Sanitise filename for hostname
    let hostname = dm_filename.replace(
      /[ \.,;:!&~#'|@*\$><\?\(\)\[\]\{\}\"\/]/g,
      "",
    );
    hostname = await this.yp.await_func("strip_accents", hostname);
    hostname = hostname.replace(/\-$/, "").trim().toLowerCase();
    hostname = new URL(`http://${hostname}`).hostname;

    const args = {
      hostname,
      area: "private",
      filename: dm_filename,
      owner_id,
      domain,
    };

    // Call desk_create_hub in user's drumate DB
    const rows = await this.yp.await_proc(
      `${user_db}.desk_create_hub`,
      args,
      {},
    );

    let hub_id, hub_db, home_id;
    for (const r of toArray(rows)) {
      if (r && r.failed) {
        this.warn("[dm_init] desk_create_hub failed", rows);
        return this.exception.server("DM_HUB_CREATION_FAILED");
      }
      if (r.db_name && r.filesize != null && r.actual_home_id) {
        hub_db = r.db_name;
        home_id = r.actual_home_id;
      }
      if (r.db_name && r.home_dir) {
        hub_id = r.id;
        hub_db = hub_db || r.db_name;
      }
    }

    if (!hub_id || !hub_db) {
      return this.exception.server("DM_HUB_CREATION_FAILED");
    }

    // 3. Add recipient as member with Edit+Chat privilege
    //    add_member(member_id, privilege, expiry_time) — expiry_time=0 = no expiry
    try {
      await this.yp.await_proc(`${hub_db}.add_member`, recipient_id, 7, 0);
    } catch (e) {
      // Non-fatal: hub created, recipient can be added later
      this.warn("[dm_init] add_member failed:", e && e.message);
    }

    // 4. Notify recipient via WebSocket
    try {
      const recipients = await this.yp.await_proc("user_sockets", recipient_id);
      await RedisStore.sendData(
        this.payload(
          { hub_id, home_id, db_name: hub_db, event: "dm.new" },
          { service: "channel.dm_init" },
        ),
        recipients,
      );
    } catch (e) {
      this.warn("[dm_init] notify failed:", e && e.message);
    }

    this.output.data({ hub_id, home_id, db_name: hub_db, is_new: 1 });
  }

  /**
   * List all DM conversations for the current user.
   *
   *
   * Returns: array of conversation objects sorted by last_message_time DESC.
   * Each item:
   *   hub_id, db_name, other_uid, last_message, last_message_time,
   *   unread_count, is_active_now (placeholder — presence via WebSocket)
   */
  async list_conversations() {
    const page = this.input.use(Attr.page, 1);
    const PAGE_SIZE = 20;
    const offset = (page - 1) * PAGE_SIZE;

    // 1. Find all DM hubs in current user's media table
    const hubs = toArray(
      await this.db.await_query(
        `SELECT m.id AS hub_id, e.db_name, m.user_filename AS filename
         FROM media m
         INNER JOIN yp.entity e ON e.id = m.id
         WHERE m.category = 'hub'
           AND m.user_filename LIKE '_inbox_%'
           AND m.status = 'active'
         ORDER BY m.upload_time DESC`,
      ),
    );

    if (!hubs.length) {
      return this.output.list([]);
    }

    // 2. For each DM hub: get last message + unread count
    const conversations = [];

    for (const hub of hubs) {
      if (!hub.db_name) continue;

      // Derive other_uid from filename: _inbox_{uid_a}_{uid_b}
      // Current user is one of them; the other is the recipient
      const parts = hub.filename.split("_").filter(Boolean);
      // parts: ['inbox', uid_a, uid_b]
      const other_uid =
        parts.find((p) => p !== "inbox" && p !== this.uid) || null;

      let last_message = null;
      let last_message_time = 0;
      let unread_count = 0;

      try {
        const db_name = hub.db_name;

        // Last message
        const lastMsgs = toArray(
          await this.yp.await_proc(
            `${db_name}.channel_list_messages`,
            this.uid,
            "date",
            "desc",
            1,
          ),
        );
        if (lastMsgs.length) {
          const lm = lastMsgs[0];
          last_message = lm.message
            ? String(lm.message).substring(0, 100)
            : null;
          last_message_time = lm.ctime || 0;
          if (!last_message && lm.is_attachment) last_message = "[File]";
        }

        // Unread count
        const unreadRow = toArray(
          await this.yp.await_query(
            `SELECT COUNT(*) AS cnt
             FROM ${db_name}.channel c
             WHERE c.status = 'active'
               AND c.author_id != ?
               AND NOT EXISTS (
                 SELECT 1 FROM ${db_name}.read_channel rc
                 WHERE rc.message_id = c.message_id AND rc.uid = ?
               )`,
            this.uid,
            this.uid,
          ),
        )[0];
        unread_count = unreadRow ? unreadRow.cnt || 0 : 0;
      } catch (e) {
        this.warn(
          `[list_conversations] hub ${hub.hub_id} query failed:`,
          e && e.message,
        );
      }

      // Get other user's profile
      let other_user = { id: other_uid };
      if (other_uid) {
        try {
          other_user = (await this.yp.await_proc("get_user", other_uid)) || {
            id: other_uid,
          };
        } catch (e) {
          this.warn("[list_conversations] get_user failed:", e && e.message);
        }
      }

      conversations.push({
        hub_id: hub.hub_id,
        db_name: hub.db_name,
        other_uid,
        other_user,
        last_message,
        last_message_time,
        unread_count,
      });
    }

    // 3. Sort by last_message_time DESC, apply pagination
    conversations.sort((a, b) => b.last_message_time - a.last_message_time);
    const paged = conversations.slice(offset, offset + PAGE_SIZE);

    this.output.list(paged);
  }

  /**
   * Get all channel messages in the current hub that have a specific file attached.
   * Powers the "See Chat Threads" feature from the file context menu
   * Params: file_nid (required) — media node ID of the file to search in attachment JSON arrays.
   */
  async list_by_file() {
    const file_nid = this.input.need("file_nid");
    const data = await this.db.await_proc("channel_list_by_file", file_nid);
    this.output.list(data);
  }

  /**
   * Get all channel messages in the current hub that either attach the file OR
   * mention it inline as `[@Filename](mention:hub_id:nid)` in the message body.
   * Powers the "See Chat Threads" feature with mention indexing.
   * Params: file_nid (required) — media node ID to find in attachment array OR mention pattern.
   */
  async list_thread_by_file() {
    const file_nid = this.input.need("file_nid");
    const hub_id = this.hub.get(Attr.id);
    const pattern = `mention:${hub_id}:${file_nid}`;

    const attachHits = await this.db.await_proc(
      "channel_list_by_file",
      file_nid,
    );
    let mentionHits = [];
    try {
      mentionHits = await this.db.await_proc("channel_search", pattern);
    } catch (e) {
      console.warn(
        "[list_thread_by_file] channel_search failed (continuing with attach-only):",
        e && e.message,
      );
    }

    const attachArr = toArray(attachHits);
    const mentionArr = toArray(mentionHits);

    // channel_search returns a minimal projection {result_type, id, author_id,
    // ctime, preview}. Fetch full rows for mention-only hits so chat-item can
    // render attachment, mention_ids, thread_id, status, metadata. Skip ids
    // already present in attachHits to avoid duplicate work.
    const attachIds = new Set(
      attachArr
        .map((r) => r && r.message_id)
        .filter(Boolean)
        .map(String),
    );
    const mentionOnlyIds = [];
    for (const r of mentionArr) {
      const mid = r && r.id != null ? String(r.id) : null;
      if (mid && !attachIds.has(mid)) mentionOnlyIds.push(mid);
    }

    let mentionRows = [];
    for (const mid of mentionOnlyIds) {
      try {
        const full = await this.db.await_proc("channel_get", mid);
        const row = Array.isArray(full) ? full[0] : full;
        if (row && row.message_id) {
          mentionRows.push(row);
          continue;
        }
        // Fallback: synthesize minimal shape from channel_search projection
        const src = mentionArr.find((r) => String(r.id) === mid) || {};
        mentionRows.push({
          sys_id: 0,
          author_id: src.author_id || "",
          message: src.preview || "",
          message_id: mid,
          thread_id: null,
          attachment: "[]",
          is_forward: 0,
          mention_ids: [],
          status: "active",
          ctime: src.ctime || 0,
          metadata: null,
        });
      } catch (e) {
        console.warn(
          "[list_thread_by_file] channel_get failed for",
          mid,
          e && e.message,
        );
      }
    }

    const byId = new Map();
    for (const row of [...attachArr, ...mentionRows]) {
      const key = row && row.message_id;
      if (key != null && !byId.has(String(key))) {
        byId.set(String(key), row);
      }
    }
    const merged = Array.from(byId.values()).sort(
      (a, b) => (b.ctime || 0) - (a.ctime || 0),
    );

    // Enrich each row to match channel.messages contract:
    // - message.entity = shareroom_contact_get(author_id) — kept as-is
    // - message.firstname/lastname/surname/fullname from drumate_get(author_id)
    //   because channel_get (unlike channel_list_messages) does NOT JOIN the
    //   user table, so chat-item's `m.firstname || ...` would otherwise miss.
    const contactCache = {};
    const profileCache = {};
    for (const message of merged) {
      message.entity = { id: this.uid };
      if (message.author_id && message.author_id !== this.uid) {
        const key = message.author_id;
        if (contactCache[key]) {
          message.entity = contactCache[key];
        } else {
          try {
            message.entity = await this.yp.await_proc(
              "forward_proc",
              this.uid,
              "shareroom_contact_get",
              `'${message.author_id}'`,
            );
            contactCache[key] = message.entity;
          } catch (e) {
            console.warn(
              "[list_thread_by_file] shareroom_contact_get failed for",
              message.author_id,
              e && e.message,
            );
          }
        }
      }
      // Hydrate firstname/lastname directly on the message row from drumate_get.
      if (message.author_id) {
        const key = message.author_id;
        let profile = profileCache[key];
        if (!profile) {
          try {
            const raw = await this.yp.await_proc(
              "drumate_get",
              message.author_id,
            );
            profile = Array.isArray(raw) ? raw[0] || {} : raw || {};
            profileCache[key] = profile;
          } catch (e) {
            console.warn(
              "[list_thread_by_file] drumate_get failed for",
              message.author_id,
              e && e.message,
            );
            profile = {};
            profileCache[key] = profile;
          }
        }
        if (!message.firstname && profile.firstname)
          message.firstname = profile.firstname;
        if (!message.lastname && profile.lastname)
          message.lastname = profile.lastname;
        if (!message.surname && profile.surname)
          message.surname = profile.surname;
        if (!message.fullname && profile.fullname)
          message.fullname = profile.fullname;
        if (!message.email && profile.email) message.email = profile.email;
      }

      if (!isEmpty(message.thread_id)) {
        try {
          message.thread = await this.threadInfo(message.thread_id, hub_id);
        } catch (e) {
          console.warn(
            "[list_thread_by_file] threadInfo failed for",
            message.thread_id,
            e && e.message,
          );
        }
      }
    }

    this.output.list(merged);
  }

  /**
   * Free-text (LIKE) search over the current hub's channel messages, scoped to
   * ONE conversation: the workspace/folder team chat when file_thread_id is
   * absent, or a specific file thread when present. Powers the chat-header
   * search field. Returns up to 45 matching previews newest-first via
   * channel_search_scoped; queries shorter than 2 chars return [] (avoids
   * scanning the whole channel on the first keystrokes).
   * Params: pattern (required, the query), file_thread_id (optional scope).
   */
  async search() {
    const pattern = `${this.input.use("pattern") || ""}`.trim();
    let file_thread_id = this.input.use("file_thread_id");
    const file_nid = this.input.use("file_nid");
    if (pattern.length < 2) {
      return this.output.list([]);
    }

    // Resolve the file thread from file_nid when the client knows only the file
    // (in-place file-thread scope before its thread id resolved client-side). A
    // file with no thread yet has no messages, so return [] rather than falling
    // back to the team chat (which would show the wrong conversation).
    if (isEmpty(file_thread_id) && !isEmpty(file_nid)) {
      const byFile = toArray(
        await this.db.await_proc(
          "channel_file_thread_info",
          this.uid,
          `${file_nid}`,
          "",
        ),
      )[0];
      if (isEmpty(byFile) || !Number(byFile.exists_thread)) {
        return this.output.list([]);
      }
      file_thread_id = byFile.file_thread_id;
    }

    const hub_id = this.hub.get(Attr.id);
    let rows = [];
    try {
      rows = await this.db.await_proc(
        "channel_search_scoped",
        this.uid,
        pattern,
        isEmpty(file_thread_id) ? null : `${file_thread_id}`,
      );
    } catch (e) {
      console.warn(
        "[channel.search] channel_search_scoped failed:",
        e && e.message,
      );
      return this.output.list([]);
    }
    // Tag hub_id so the client can build viewer/jump links (the proc runs in a
    // single hub DB context and does not return it — same convention as the
    // channel_search projection consumed by list_thread_by_file).
    const out = toArray(rows).map((r) => ({ ...r, hub_id }));
    this.output.list(out);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // EXPORT — Phase 1 (JSON) + Phase 2 (PDF)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Sanitize a string for use in a filename: keep alphanumeric, dash, dot.
   * @param {string} s
   * @returns {string}
   */
  _sanitizeName(s) {
    return String(s || "Drumee")
      .replace(/[^\w.-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "") || "Drumee";
  }

  /**
   * Build the canonical export filename (without extension).
   * e.g. "Drumee_Chat_My-Folder_2026-06-27"
   * @param {string} hubName
   * @returns {string}
   */
  _exportBasename(hubName) {
    const Moment = require("moment");
    const date = Moment(Moment.now() / 1000, "X").format("YYYY-MM-DD");
    const safeName = this._sanitizeName(hubName);
    return `Drumee_Chat_${safeName}_${date}`;
  }

  /**
   * Order the folder rows from channel_export_folder_tree depth-first so
   * export sections follow the on-screen tree (parent before children,
   * siblings by name). The proc returns depth ASC / name ASC, so each
   * parent's child list is already name-sorted.
   * @param {Array} folders  rows {id, parent_id, depth, name}
   * @returns {Array} same rows, DFS order, each with a `path` display string
   */
  _orderFolderTree(folders) {
    const byParent = new Map();
    for (const f of folders) {
      const key = `${f.parent_id}`;
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(f);
    }
    const root = folders.find((f) => Number(f.depth) === 0);
    const out = [];
    const walk = (node, trail) => {
      const path = trail ? `${trail} / ${node.name}` : `${node.name}`;
      out.push({ ...node, path });
      for (const child of byParent.get(`${node.id}`) || []) walk(child, path);
    };
    if (root) walk(root, "");
    return out;
  }

  /**
   * Gather all messages from the exported folder subtree, grouped into one
   * section per folder (tree order), each folder's file threads following
   * their folder section. Root-card system messages (message_type
   * 'file.thread') become `type:'event'` lines instead of empty messages.
   *
   * This SAME logic is duplicated in chat-export.js (PDF worker) — the job
   * is a standalone process and can't import this file. If gather logic
   * changes, update BOTH.
   *
   * @param {object} opts
   * @param {string|string[]} opts.folder_sel  which folders' general chat to
   *   include: 'all' (every folder in the subtree) | [folder_nids] | 'none'.
   * @param {string|string[]} opts.thread_sel  which file threads to include:
   *   'all' | [file_thread_ids] | 'none'.
   * @param {string|null}     opts.root_nid    folder the export is rooted at (null = hub root)
   * @param {number|null}     opts.date_start  epoch seconds or null
   * @param {number|null}     opts.date_end    epoch seconds or null
   * @param {Array}           opts.file_threads  subtree list from channel_export_file_thread_list
   * @param {Array}           opts.folder_tree   rows from channel_export_folder_tree
   * @returns {Promise<Array>} sections[]
   */
  async _gatherSections({ folder_sel, thread_sel, root_nid, date_start, date_end, file_threads, folder_tree }) {
    // Folder axis: 'all' → every folder; array → only those nids; 'none' → skip
    // all folder chat. folderSelSet is null when 'all' (no per-folder filter).
    const includeFolders = folder_sel === "all" ||
      (Array.isArray(folder_sel) && folder_sel.length > 0);
    const folderSelSet = Array.isArray(folder_sel)
      ? new Set(folder_sel.map(String)) : null;

    // Thread axis: 'all' → every thread; array → only those ids; 'none' → skip.
    let selectedFts = [];
    if (thread_sel === "all") {
      selectedFts = file_threads;
    } else if (Array.isArray(thread_sel)) {
      const sel = new Set(thread_sel.map(String));
      selectedFts = file_threads.filter((ft) => sel.has(String(ft.file_thread_id)));
    }
    // thread_sel === 'none' → selectedFts stays []

    const folders = this._orderFolderTree(toArray(folder_tree));
    const rootFolder = folders[0] || null;
    // filename lookup for root-card event lines
    const ftByFileNid = new Map(
      toArray(file_threads).map((ft) => [`${ft.file_nid}`, ft]),
    );

    // ── Gather general chat, grouped by folder (metadata._scope_nid) ───────
    const byFolder = new Map();
    if (includeFolders) {
      let page = 1;
      while (true) {
        const rows = toArray(
          await this.db.await_proc(
            "channel_export_messages",
            this.uid,
            root_nid || null,
            date_start || null,
            date_end || null,
            page,
          ),
        );
        if (!rows.length) break;
        for (const row of rows) {
          const msg = this._normalizeMessage(row);
          // Root cards are folder-visible "thread started" markers, not chat.
          if (row.message_type === "file.thread") {
            let meta = {};
            try {
              meta = typeof row.metadata === "string"
                ? jsonParse(row.metadata) : row.metadata || {};
            } catch (_) {}
            const ft = ftByFileNid.get(`${meta._file_nid}`);
            msg.type = "event";
            msg.text = `Chat thread started for "${(ft && ft.filename) || meta._file_nid || "a file"}"`;
          }
          // Legacy rows (no _scope_nid) surface in every folder in the live
          // UI — group them into the export root section.
          const key = row.scope_nid || (rootFolder ? `${rootFolder.id}` : "");
          if (!byFolder.has(key)) byFolder.set(key, []);
          byFolder.get(key).push(msg);
        }
        if (rows.length < 45) break;
        page++;
      }
    }

    // ── Emit sections in tree order; each folder's threads follow it ───────
    const sections = [];
    const pushThreadSection = async (ft, folder) => {
      const messages = [];
      let page = 1;
      while (true) {
        const rows = toArray(
          await this.db.await_proc(
            "channel_export_file_thread_messages",
            this.uid,
            `${ft.file_thread_id}`,
            date_start || null,
            date_end || null,
            page,
          ),
        );
        if (!rows.length) break;
        for (const row of rows) messages.push(this._normalizeMessage(row));
        if (rows.length < 45) break;
        page++;
      }
      sections.push({
        type: "file_thread",
        name: ft.filename || ft.file_thread_id,
        file_thread_id: ft.file_thread_id,
        file_nid: ft.file_nid,
        folder_nid: ft.folder_nid || (folder && folder.id) || null,
        folder_name: ft.folder_name || (folder && folder.name) || null,
        messages,
      });
    };

    // Pass 1 — folder/general chat sections first (tree order). When folder_sel
    // is an explicit list, only those folders are emitted.
    if (includeFolders) {
      for (const folder of folders) {
        if (folderSelSet && !folderSelSet.has(`${folder.id}`)) continue;
        const messages = byFolder.get(`${folder.id}`) || [];
        if (!messages.length) continue;
        sections.push({
          type: "folder_chat",
          name: folder.name,
          path: folder.path,
          nid: folder.id,
          messages,
        });
      }
    }

    // Pass 2 — file threads after all folder chat, ordered by their folder's
    // position in the tree (threads of a folder grouped together).
    const emittedThreads = new Set();
    for (const folder of folders) {
      for (const ft of selectedFts) {
        if (`${ft.folder_nid}` !== `${folder.id}`) continue;
        emittedThreads.add(`${ft.file_thread_id}`);
        await pushThreadSection(ft, folder);
      }
    }
    // Threads whose folder is missing from the tree (defensive) — append last.
    for (const ft of selectedFts) {
      if (emittedThreads.has(`${ft.file_thread_id}`)) continue;
      await pushThreadSection(ft, null);
    }

    return sections;
  }

  /**
   * Normalize a raw channel row into the canonical export message shape.
   * Author is already resolved in-proc (firstname/lastname/fullname columns).
   * Attachments are parsed from JSON into [{name, link}].
   * Reactions are kept raw from metadata (JSON output only; PDF builder strips them).
   * @param {object} row
   * @returns {object}
   */
  _normalizeMessage(row) {
    // Parse attachment JSON → [{name, link}]
    let attachments = [];
    if (row.attachment) {
      try {
        const raw = typeof row.attachment === "string"
          ? jsonParse(row.attachment)
          : row.attachment;
        for (const a of toArray(raw)) {
          // attachment entries are {nid, hub_id} or plain nid strings
          if (a && (a.nid || typeof a === "string")) {
            const nid = a.nid || a;
            const hub_id = a.hub_id || this.hub.get(Attr.id);
            attachments.push({
              name: a.filename || nid,
              // Build a service link the client (or PDF) can follow
              link: `/-/svc/media.orig?nid=${nid}&hub_id=${hub_id}`,
            });
          }
        }
      } catch (_) {
        // malformed attachment JSON — skip silently
      }
    }

    // Parse metadata for reactions (kept raw)
    let reactions = null;
    if (row.metadata) {
      try {
        const meta = typeof row.metadata === "string"
          ? jsonParse(row.metadata)
          : row.metadata;
        if (meta && meta._reactions_) reactions = meta._reactions_;
      } catch (_) {}
    }

    const authorName = row.fullname ||
      `${row.firstname || ""} ${row.lastname || ""}`.trim() || row.author_id;

    const out = {
      id: row.message_id,
      sys_id: row.sys_id,
      author: { id: row.author_id, name: authorName },
      time: row.ctime,
      text: row.message || "",
      attachments,
      reply_to: row.thread_id || null,
      reactions,
    };

    // Meeting start/end sentinel → friendly event line (mirrors live chat).
    const meeting = meetingEventText(row.message, authorName);
    if (meeting) {
      out.type = "event";
      out.text = meeting;
      out.attachments = [];
      out.reply_to = null;
    }
    return out;
  }

  /**
   * Resolve the workspace display name. The hub model's name/hubname often
   * holds the raw hub id (workspace-creation flow only sets yp.hub.name), so
   * an id-looking value falls through to the folder-tree root name, which
   * reads yp.hub.name with proper fallbacks.
   * @param {string} hub_id
   * @param {Array} folder_tree  rows from channel_export_folder_tree
   * @returns {string}
   */
  _exportHubName(hub_id, folder_tree) {
    const fromModel = this.hub.get(Attr.name) || this.hub.get("hubname") || "";
    if (fromModel && fromModel !== hub_id) return fromModel;
    const root = toArray(folder_tree).find((f) => Number(f.depth) === 0);
    return (root && root.name) || fromModel || hub_id;
  }

  /**
   * GET channel.export_scope {hub_id, nid?}
   * nid = folder the export modal was opened in; export covers its subtree.
   * Returns: { hub:{name, message_count, mtime},
   *            file_threads:[{file_thread_id, file_nid, filename, folder_nid, folder_name, reply_count}] }
   */
  async export_scope() {
    const hub_id = this.hub.get(Attr.id);
    const root_nid = this.input.use(Attr.nid) || null;
    const hub_mtime = this.hub.get("mtime") || this.hub.get(Attr.ctime) || 0;

    // Count subtree team-chat messages (date-unfiltered)
    const countRow = toArray(
      await this.db.await_proc("channel_export_count", this.uid, root_nid, null, null),
    )[0];
    const message_count = countRow ? Number(countRow.message_count) : 0;

    // List active file threads inside the subtree
    const file_threads = toArray(
      await this.db.await_proc("channel_export_file_thread_list", this.uid, root_nid),
    );

    const folder_tree = toArray(
      await this.db.await_proc("channel_export_folder_tree", hub_id, root_nid),
    );
    const hub_name = this._exportHubName(hub_id, folder_tree);

    // Ordered folder list (tree order, with display path) so the export modal
    // can offer a per-folder scope pick. Reuses the same DFS ordering the
    // gather step uses so nids/paths line up with the emitted sections.
    const folders = this._orderFolderTree(folder_tree).map((f) => ({
      nid: f.id,
      name: f.name,
      path: f.path,
    }));

    this.output.data({
      hub: { name: hub_name, message_count, mtime: hub_mtime },
      folders,
      file_threads,
    });
  }

  /**
   * Parse the two scope axes from the request, with a fallback from the legacy
   * scope_sel/include_folders contract so older clients keep working.
   *
   * New params (preferred):
   *   folder_sel : 'all' | JSON array of folder nids | 'none'
   *   thread_sel : 'all' | JSON array of file_thread_ids | 'none'
   *
   * Legacy mapping (when folder_sel/thread_sel absent):
   *   scope_sel 'all'            → folder 'all',  thread 'all'
   *   scope_sel 'hub_chat_only'  → folder 'all',  thread 'none'
   *   scope_sel [ids] + include_folders truthy → folder 'all',  thread [ids]
   *   scope_sel [ids] + include_folders falsy  → folder 'none', thread [ids]
   *
   * @returns {{folder_sel:(string|string[]), thread_sel:(string|string[])}}
   */
  _resolveScope() {
    const parseSel = (raw) => {
      if (raw === "all" || raw === "none") return raw;
      if (Array.isArray(raw)) return raw;
      if (typeof raw === "string") {
        try {
          const v = jsonParse(raw);
          return Array.isArray(v) ? v : "all";
        } catch (_) { return "all"; }
      }
      return null; // absent
    };

    const folderRaw = this.input.use("folder_sel");
    const threadRaw = this.input.use("thread_sel");
    let folder_sel = parseSel(folderRaw);
    let thread_sel = parseSel(threadRaw);
    if (folder_sel !== null && thread_sel !== null) {
      return { folder_sel, thread_sel };
    }

    // ── Legacy fallback ──────────────────────────────────────────────────────
    const scopeRaw = this.input.use("scope_sel") || "all";
    let scope_sel;
    if (scopeRaw === "all" || scopeRaw === "hub_chat_only") {
      scope_sel = scopeRaw;
    } else {
      try {
        scope_sel = Array.isArray(scopeRaw) ? scopeRaw : jsonParse(scopeRaw);
        if (!Array.isArray(scope_sel)) scope_sel = "all";
      } catch (_) { scope_sel = "all"; }
    }
    const incRaw = this.input.use("include_folders");
    const include_folders =
      incRaw === undefined || incRaw === null
        ? true
        : incRaw === true || incRaw === 1 || incRaw === "1" || incRaw === "true";

    if (scope_sel === "all") return { folder_sel: "all", thread_sel: "all" };
    if (scope_sel === "hub_chat_only") return { folder_sel: "all", thread_sel: "none" };
    // array of thread ids
    return {
      folder_sel: include_folders ? "all" : "none",
      thread_sel: scope_sel,
    };
  }

  /**
   * POST channel.export {hub_id, format, folder_sel, thread_sel, start_date, end_date, socket_id}
   * Returns: { wait:0|1, zipid, zipname, format }
   */
  async export() {
    const format = this.input.use("format") || "json";
    if (!["json", "pdf"].includes(format)) {
      return this.output.data({ status: "INVALID_FORMAT" });
    }

    // Two independent scope axes: folder_sel picks which folders' general chat
    // to include, thread_sel picks which file threads. Each is 'all' | array |
    // 'none'. When absent, fall back from the legacy scope_sel/include_folders
    // contract so older clients keep working (see _legacyScope).
    const { folder_sel, thread_sel } = this._resolveScope();

    const date_start = this.input.use("start_date") || null;
    const date_end = this.input.use("end_date") || null;
    // Folder subtree root — export covers this folder and everything below it.
    const root_nid = this.input.use(Attr.nid) || null;
    // PDF progress requires socket_id; reject early so the client spinner
    // is not left hanging with no progress events.
    const socket_id = this.input.use(Attr.socket_id) || null;
    if (format === "pdf" && !socket_id) {
      return this.output.data({ status: "MISSING_SOCKET_ID" });
    }

    // Resolve the subtree's active file threads once (needed for scope + count)
    const file_threads = toArray(
      await this.db.await_proc("channel_export_file_thread_list", this.uid, root_nid),
    );

    // ── 10k guard ────────────────────────────────────────────────────────────
    // Folder chat: counted via channel_export_count (date-aware, whole subtree).
    // NOTE the count is subtree-wide even when only some folders are selected —
    // an over-count that keeps the guard conservative (no schema change).
    // File threads: when no date filter is active, reply_count is an exact
    // total and avoids N extra DB calls. When a date filter is active,
    // reply_count is an overcount (messages outside the window still increment
    // it), so we do an exact date-filtered count per selected thread via
    // channel_export_file_thread_count — this keeps the guard honest and
    // consistent with the "narrow date range" hint shown on rejection.
    const hasDateFilter = date_start !== null || date_end !== null;

    let totalCount = 0;
    // Any folder selection (all or a non-empty list) means folder chat is counted.
    const includeHub = folder_sel === "all" ||
      (Array.isArray(folder_sel) && folder_sel.length > 0);

    if (includeHub) {
      const cr = toArray(
        await this.db.await_proc("channel_export_count", this.uid, root_nid, date_start, date_end),
      )[0];
      totalCount += cr ? Number(cr.message_count) : 0;
    }

    let selectedFts = [];
    if (thread_sel === "all") {
      selectedFts = file_threads;
    } else if (Array.isArray(thread_sel)) {
      const sel = new Set(thread_sel.map(String));
      selectedFts = file_threads.filter((ft) => sel.has(String(ft.file_thread_id)));
    }

    if (hasDateFilter) {
      // Exact date-filtered count per selected thread (N proc calls, but N is
      // bounded by the number of file threads the user selected — typically small).
      for (const ft of selectedFts) {
        const cr = toArray(
          await this.db.await_proc(
            "channel_export_file_thread_count",
            this.uid,
            `${ft.file_thread_id}`,
            date_start,
            date_end,
          ),
        )[0];
        totalCount += cr ? Number(cr.message_count) : 0;
      }
    } else {
      // No date filter: reply_count is the exact total (no rows excluded),
      // so use it directly — avoids N extra COUNT queries.
      for (const ft of selectedFts) {
        totalCount += Number(ft.reply_count) || 0;
      }
    }

    if (totalCount > EXPORT_CAP) {
      return this.output.data({
        status: "EXPORT_TOO_LARGE",
        message_count: totalCount,
        hint: "Narrow the date range to reduce the export size.",
      });
    }

    // ── Prepare staging ───────────────────────────────────────────────────────
    const zipid = this.randomString();
    const folder_tree = toArray(
      await this.db.await_proc("channel_export_folder_tree", this.hub.get(Attr.id), root_nid),
    );
    const hub_name = this._exportHubName(this.hub.get(Attr.id), folder_tree);
    // Name the file after the exported folder (subtree root), not the hub,
    // so an export taken inside a subfolder is recognizable.
    const rootFolder = folder_tree.find((f) => Number(f.depth) === 0);
    const basename = this._exportBasename((rootFolder && rootFolder.name) || hub_name);
    const zipname = `${basename}.${format}`;
    const stageDir = pathResolve(tmp_dir, DOWNLOAD_FOLDER, this.uid, zipid);
    mkdirSync(stageDir, { recursive: true });

    // ── JSON (synchronous) ────────────────────────────────────────────────────
    if (format === "json") {
      const sections = await this._gatherSections({
        folder_sel,
        thread_sel,
        root_nid,
        date_start,
        date_end,
        file_threads,
        folder_tree,
      });

      const Moment = require("moment");
      const exportedAt = Moment(Moment.now() / 1000, "X").format("YYYY-MM-DD HH:mm");
      const payload = {
        meta: {
          schema_version: 2,
          hub_id: this.hub.get(Attr.id),
          hub_name,
          root_nid: root_nid || null,
          root_name: (rootFolder && rootFolder.name) || hub_name,
          exported_by: this.uid,
          exported_at: exportedAt,
          date_start: date_start || null,
          date_end: date_end || null,
          format: "json",
        },
        sections,
      };

      const filePath = pathJoin(stageDir, zipname);
      writeFileSync(filePath, stringify(payload, null, 2), "utf8");

      return this.output.data({ wait: 0, zipid, zipname, format });
    }

    // ── PDF (async offline job) ────────────────────────────────────────────────
    const lang = this.client_language ? this.client_language() : "en";
    const args = {
      uid: this.uid,
      hub_id: this.hub.get(Attr.id),
      hub_name,
      root_nid,
      root_name: (rootFolder && rootFolder.name) || hub_name,
      folder_sel,
      thread_sel,
      start_date: date_start,
      end_date: date_end,
      format: "pdf",
      zipid,
      zipname,
      socket_id,
      lang,
    };

    const cmd = pathResolve(OFFLINE_DIR, "chat-export.js");
    const child = Spawn(cmd, [stringify(args)], SPAWN_OPT);
    // An un-handled spawn 'error' (e.g. EACCES when the worker file lost its
    // execute bit) surfaces as an uncaughtException that crashes the whole
    // REST service. Keep a worker launch failure contained to this export.
    child.on("error", (e) => {
      this.warn(`chat-export spawn failed: ${e && e.message}`);
    });
    child.unref();

    return this.output.data({ wait: 1, zipid, zipname, format });
  }

  /**
   * GET channel.export_fetch {zipid, zipname}
   * Serves a previously staged export file (JSON or PDF) via X-Accel-Redirect.
   * Creates a symlink under mfs_dir so nginx can serve the file.
   */
  async export_fetch() {
    const zipid = this.input.need("zipid");
    const zipname = this.input.need("zipname") || "export";

    const src = pathJoin(tmp_dir, DOWNLOAD_FOLDER, this.uid, zipid, zipname);
    const fileio = new FileIo(this);
    if (!existsSync(src)) {
      return fileio.not_found();
    }

    // Stable, space-free symlink under mfs_dir; FileIo.static() builds the
    // correct X-Accel-Redirect path (mirrors media.zip() — manual header
    // stripping produced an nginx path that 404'd: "File wasn't available").
    const ext = zipname.split(".").pop().toLowerCase();
    const mimetype = EXPORT_MIME[ext] || "application/octet-stream";
    const target = pathJoin(mfs_dir, DOWNLOAD_FOLDER, this.uid, zipid);
    mkdirSync(target, { recursive: true });
    const file = pathJoin(target, `${zipid}.${ext}`);
    if (existsSync(file)) rmSync(file);
    symlinkSync(src, file);

    fileio.static({ path: file, name: zipname, mimetype, code: 200 });
  }
}

module.exports = __private_channel;
