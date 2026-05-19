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

const { Attr, Constants, Permission, Privilege,
  RedisStore, Cache, toArray, sysEnv, Script
} = require("@drumee/server-essentials")
const {
  BOUND,
  CAPTION,
  CIRCULAR_REF,
  COMMENT,
  DESTINATION_IS_NOT_DIRECTORY,
  FILENAME,
  FILETYPE,
  FOLDER,
  HUB,
  INBOUND,
  INVALID_DATA,
  LOCKED,
  NOBOUND,
  NODE_ID,
  PID,
  RATING,
  RECIPIENT_ID,
  ROOT,
  STATUS,
  UNABLE_TO_MOVE_SAHREBOX,
  UNABLE_TO_RENAME_INBOUND,
  UNABLE_TO_TRANS_INBOUND,
} = Constants;

const { MfsTools, Generator, Document } = require("@drumee/server-core");
const { check_base, remove_node, move_node, copy_node, mkdir, rmdir, cleanSeen } = MfsTools;
const Media = require("../media");
const { writeAudit } = require("./_audit");
const { stringify } = JSON;
const { isEmpty, isString, values } = require("lodash");
const { join, resolve, basename, extname } = require("path");
const { existsSync, readFileSync, writeFileSync, readdirSync, statSync, copyFileSync, mkdirSync } = require("fs");
const { writeFileSync: writeJson } = require("jsonfile");
const SPAWN_OPT = { detached: true, stdio: ["ignore", "ignore", "ignore"] };
const Spawn = require("child_process").spawn;
const { tmp_dir, quota, server_location } = sysEnv();
const JSON_OPT = { spaces: 2, EOL: "\r\n" };
const { emptyTrash } = require('../../offline/queues/trashQueue');
const indexQueue = require('../../offline/queues/indexQueue');

//########################################
class __private_media extends Media {
  constructor(...args) {
    super(...args);
    this.transact = this.transact.bind(this);
    this.chk_pre_transact = this.chk_pre_transact.bind(this);
    this.pre_transact = this.pre_transact.bind(this);
    this.copy_all = this.copy_all.bind(this);
    this.move_all = this.move_all.bind(this);
    this.pre_restore_into = this.pre_restore_into.bind(this);
    this.restore_into = this.restore_into.bind(this);
    this.restore = this.restore.bind(this);
    this.pre_move = this.pre_move.bind(this);
    this._ready_for_move = this._ready_for_move.bind(this);
    this.update_caption = this.update_caption.bind(this);
    this.update_status = this.update_status.bind(this);
    this.purge = this.purge.bind(this);
    this.empty_bin = this.empty_bin.bind(this);
    this.trash = this.trash.bind(this);
    this.show_bin = this.show_bin.bind(this);
    this.home = this.home.bind(this);
    this.show_folders = this.show_folders.bind(this);
    this.reorder = this.reorder.bind(this);
    this.get_node_stat = this.get_node_stat.bind(this);
    this.comment = this.comment.bind(this);
    this.rename = this.rename.bind(this);
    this.share_media = this.share_media.bind(this);
    this.rotate = this.rotate.bind(this);
    this.replace = this.replace.bind(this);
    this.dmz_copy = this.dmz_copy.bind(this);
    this.dmz_detail = this.dmz_detail.bind(this);
    this.list_server_files = this.list_server_files.bind(this);
    this.server_export = this.server_export.bind(this);
    this.server_import = this.server_import.bind(this);
  }

  /**
   *
   */
  async server_import() {
    let socket_id = this.input.need(Attr.socket_id);
    let source_list = this.input.get("source_list") || ["/data/sample-1/"];
    let pid = this.input.use(PID);
    if (pid == null) {
      pid = "0";
    }
    let recipient_id = this.input.use(RECIPIENT_ID) || this.hub.get(Attr.id);
    let args = {
      pid,
      recipient_id,
      source_list,
      uid: this.uid,
      socket_id,
    };
    let cmd = resolve(
      server_location,
      "offline",
      "media",
      "serverimport.js"
    );
    let child = Spawn(cmd, [JSON.stringify(args)], SPAWN_OPT);
    child.unref();
    this.output.data(args);
  }

  /**
   *
   */
  async server_export() {
    let socket_id = this.input.need(Attr.socket_id);
    let dest_path = this.input.need("destination");
    this.heap.nodes = this.heap.nodes || this.source_nodes(); //JSON.parse(this.src.args);
    this.heap.srcgrantlst = [];
    let granted = [];
    let node;
    for (var hub of this.heap.nodes) {
      if (isString(hub.nid)) {
        node = { nid: hub.nid, hub_id: hub.hub_id };
        granted.push(node);
      } else {
        for (let id of hub.nid) {
          node = { nid: id, hub_id: hub.hub_id };
          granted.push(node);
        }
      }
    }

    let args = {
      granted,
      dest_path,
      uid: this.uid,
      socket_id,
    };
    let cmd = resolve(
      server_location,
      "offline",
      "media",
      "serverexport.js"
    );
    let child = Spawn(cmd, [JSON.stringify(args)], SPAWN_OPT);
    child.unref();
    this.output.data(args);
  }

  /**
   * 
   * @param {*} proc 
   * @returns 
   */
  async transact(proc) {
    const src = this.heap.srcgrantlst;
    const uid = this.user.uid();
    const { hub_id, id } = this.dest_granted();
    let data = await this.db.await_proc(proc, src, uid, id, hub_id);
    const deniedlst = this.heap.srcdeniedlst || [];
    if (isEmpty(data)) {
      if (deniedlst.length > 0) {
        this.output.data({ denied_lst: deniedlst });
      } else {
        this.output.data({});
      }
      return;
    }
    let items = [];
    data = toArray(data);
    for (let item of data) {
      if (!item.failed) {
        items.push(item);
      } else {
        this.warn("Failed transaction", item);
      }
    }
    let res = await this.after_transact(items);
    this.output.data(res);
  }

  /**
   *
   * @param {*} data
   */
  async move_node(data) { }

  /**
   *
   */
  async transact_show(node) {
    const { des_db, nid } = node;
    //const exclude = [this.input.get(Attr.socket_id)];
    let oldItems = {};
    let recipients = await this.yp.await_proc("entity_sockets", {
      db_name: des_db,
      //exclude,
    });
    const proc = `${des_db}.mfs_access_node`;
    for (let r of toArray(recipients)) {
      if (!oldItems[r.uid]) {
        oldItems[r.uid] = await this.db.await_proc(proc, r.uid, nid);
      }
    }
    let nodes = {};
    let counts = {};
    for (let s of toArray(sockets)) {
      if (!s || !s.uid) continue;
      let r = null;
      if (nodes[s.uid]) {
        r = nodes[s.uid];
      } else {
        r = await this.yp.await_proc(access, s.uid, nid);
      }
      if (!r || !r.actual_db) continue;
      if (r.filetype == Attr.hub && r.actual_hub_id) {
        r.hub_id = r.actual_hub_id;
        nid = r.actual_home_id;
      }
      const dest = { ...r };
      const src = { ...this.granted_node() }
      r.args = { tag, src, dest, changelog: this.__changelog }
      let c = null;
      if (counts[s.uid]) {
        c = counts[s.uid];
      } else {
        let proc = `${r.actual_db}.mfs_count_new`;
        c = await this.yp.await_proc(proc, nid, s.uid);
        counts[s.uid] = c;
      }

      r.new_chat = c.new_chat;
      r.new_file = c.new_file;
      r.hubs = c.hubs;
      nodes[s.uid] = r;
      await RedisStore.sendData(this.payload(r), s);
    }
    let res = values(nodes)[0];
    if (res && res.hub_id) {
      recipients.push(res.hub_id);
      result.push(res);
    }
  }

  /**
   *
   * @param {*} data
   * @returns
   */
  async after_transact(data) {
    let tag = this.randomString();
    let node;
    const rid = this.heap.recipient_id;
    const socket_id = this.input.get(Attr.socket_id);
    data = toArray(data);
    let result = [];
    // let copied = [];
    let dest, src;
    // let notify = {};
    let nodes = {};
    for (node of data) {
      switch (node.action) {
        case "move":
          src = { nid: node.nid, mfs_root: node.src_mfs_root };
          dest = { nid: node.des_id, hub_id: rid, mfs_root: node.des_mfs_root };
          move_node(src, dest, 1);
          break;
        case "copy":
          src = { nid: node.nid, mfs_root: node.src_mfs_root };
          dest = { nid: node.des_id, hub_id: rid, mfs_root: node.des_mfs_root };
          // let m = await this.yp.await_proc(
          //   "forward_proc",
          //   dest.hub_id,
          //   "mfs_access_node",
          //   `"${this.uid}", "${dest.nid}"`
          // );
          try {
            if (node.type == "same") {
              move_node(src, dest, 1);
            } else {
              copy_node(src, dest, 1);
              // m.position = this.input.get(Attr.position) || 0;
            }
            dest.parent_id = node.des_id;
            // notify[rid] = this.input.get(Attr.pid);
            // copied.push(dest);
          } catch (e) {
            this.warn("COPY FAILED ", e);
          }
          break;
        case "show":
          let nid = node.nid;
          let access = `${node.des_db}.mfs_access_node`;
          let sockets = await this.yp.await_proc("entity_sockets", {
            db_name: node.des_db,
          });
          nodes = {};
          let counts = {};
          for (let s of toArray(sockets)) {
            if (!s || !s.uid) continue;
            let r = null;
            if (nodes[s.uid]) {
              r = nodes[s.uid];
            } else {
              r = await this.yp.await_proc(access, s.uid, nid);
              result.push(r);
            }
            if (!r || !r.actual_db) continue;
            if (r.filetype == Attr.hub && r.actual_hub_id) {
              r.hub_id = r.actual_hub_id;
              nid = r.actual_home_id;
            }
            delete r.args;
            const dest = { ...r };
            const src = { ...this.heap.oldItems[s.uid] }
            r.args = { tag, src, dest, changelog: this.__changelog };
            let c = null;
            if (counts[s.uid]) {
              c = counts[s.uid];
            } else {
              let proc = `${r.actual_db}.mfs_count_new`;
              c = await this.yp.await_proc(proc, nid, s.uid);
              counts[s.uid] = c;
            }
            nodes[s.uid] = r;
            await RedisStore.sendData(this.payload(r), s);
          }
          break;

        case "delete":
          let target = {
            nid: node.nid,
            hub_id: rid,
            mfs_root: node.src_mfs_root,
          };
          remove_node(target, 1);
          // copied = dest;
          break;
      }
    }
    for (let r of result) {
      const dest = { ...r };
      delete dest.args;
      const src = { ...this.heap.oldItems[this.uid] }
      delete src.args;
      r.args = { tag, src, dest, changelog: this.__changelog }
      await this.changelog_write({ src, dest });
    }
    return result;
  }

  /**
   *
   */
  async link() {
    const nid = this.source_granted().id;
    const uid = this.user.uid();
    const pid = this.dest_granted().id;
    const rid = this.dest_granted().hub_id;
    let data = await this.db.await_proc("mfs_create_link", nid, uid, pid, rid);

    let m = await this.yp.await_proc(
      "forward_proc",
      rid,
      "mfs_access_node",
      `"${uid}", "${data.id}"`
    );
    m.position = this.input.get(Attr.position) || 0;
    let recipients = await this.yp.await_proc("entity_sockets", m.hub_id);
    await this.sendNodeAttributes({
      nid: m.nid,
      recipients,
      service: "media.new",
    });
    this.output.data(m);
  }

  /**
   *
   * @returns
   */
  slurp() {
    const download = require("download-file");
    const source = this.input.need(Attr.location);
    const url = new URL(source);
    if (!url.hostname || !url.pathname) {
      this.exception.user("MAL_FORMED_URL");
      return;
    }
    const dir = basename(tmp_dir, this.randomString());

    let filename = basename(url.pathname);
    const options = {
      directory: dir,
      filename,
    };

    let location = resolve(dir, filename);

    download(source, options, async (err) => {
      if (err) {
        this.exception.server(err);
        return;
      }
      let node = this.source_granted();
      await this.store(node.id, location, filename);
    });
  }

  /**
   * Check sanity before transaction
   * @param {*} src 
   * @param {*} dest 
   * @returns 
   */
  async chk_pre_transact(src, dest) {
    if (isEmpty(src) || isEmpty(dest)) {
      this.exception.user(INVALID_DATA);
      return;
    }

    if (dest[BOUND] === INBOUND) {
      this.exception.user(UNABLE_TO_TRANS_INBOUND);
      return;
    }

    if (!(dest[FILETYPE] == FOLDER || dest[FILETYPE] == ROOT)) {
      this.exception.user(DESTINATION_IS_NOT_DIRECTORY);
      return;
    }
    let wicket = await this.db.call_proc("mfs_wicket_home", this.uid);
    if (wicket[5]) { /** Created by desk_create_hub */
      wicket = { ...wicket[5] }
    }
    if (wicket.hub_id == this.dest_granted().hub_id) {
      this.exception.user("WICKET_HUB");
      return;
    }

    src = this.heap.srcgrantlst;
    const uid = this.user.uid();
    const { id, hub_id } = this.dest_granted();

    if (this.heap.action == "move") {
      let data = await this.db.await_proc(
        "mfs_chk_circular_ref",
        src,
        uid,
        id,
        hub_id
      );
      if (!isEmpty(data)) {
        this.exception.user(CIRCULAR_REF);
        return;
      }
    }
    if (this.heap.action == "copy") {
      let disk_limit = await this.yp.await_proc("disk_limit", hub_id) || {};
      let { watermark, owner_id, available_disk } = disk_limit;
      let { watermark: sys_watermark } = quota;
      if (watermark == Infinity || sys_watermark == Infinity) {
        this._done();
        return;
      };
      let { size } = await this.yp.await_proc(
        "get_transation_size",
        src,
        hub_id,
        this.heap.action
      );
      if (available_disk < size) {
        let error = Cache.message("your_limit_exceeded");
        if (this.uid != owner_id) {
          error = Cache.message("limit_exceeded");
        }
        return this.exception.user(error);
      }
    }

    this._done();
  }

  /**
   * Prepare for transaction
   * @param {*} check 
   * @returns 
   */
  async pre_transact(check = 1) {
    this.heap.srcoutboundlst = [];
    this.heap.fileexists = [];
    this.heap.invalidemails = [];
    this.heap.nodes = this.source_nodes();
    let granted = [];
    let denied = [];
    this.heap.srcgranted = [];
    this.heap.oldItems = {};
    for (let n of this.source_granted(Attr.all)) {
      let { node } = n;
      if (!node || !node.permission) {
        denied.push(node);
        continue;
      }
      granted.push(node);
      let recipients = await this.yp.await_proc("entity_sockets", {
        hub_id: n.hub_id
      });
      let proc = `${n.db_name}.mfs_access_node`;
      for (let r of toArray(recipients)) {
        if (this.heap.oldItems[r.uid]) continue;
        node = await this.db.await_proc(proc, r.uid, n.id);
        if (node && node.privilege) {
          this.heap.oldItems[r.uid] = node;
        }
      }
    }
    this.heap.srcdeniedlst = denied;
    this.heap.srcgrantlst = granted;
    this.heap.sb = await this.yp.await_proc("drumate_get_share_box", this.uid);
    const rid = this.heap.recipient_id || this.input.get(RECIPIENT_ID);
    const pid = this.heap.pid || this.input.get(Attr.pid);
    const hub_id = this.input.get(Attr.hub_id);

    let dest;
    if (rid && hub_id != rid) {
      dest = await this.yp.await_proc(
        "forward_proc",
        rid,
        "mfs_access_node",
        `'${this.uid}', '${pid}'`
      );
    } else {
      dest = await this.db.await_proc("mfs_access_node", this.uid, pid);
    }
    this.heap.dest = dest;
    if (check) {
      await this.chk_pre_transact(granted, dest);
    }
    return 1;
  }


  /**
   * 
   */
  async set_homepage() {
    let node = this.granted_node();
    await this.yp.await_proc('set_homepage', node.actual_hub_id, node.ownpath);
    this.output.data(node);
  }

  /**
   * 
   */
  async copy_all() {
    await this.transact("mfs_copy_all");
  }

  /**
   * 
   */
  async move_all() {
    await this.transact("mfs_move_all");
  }

  /** Allow move with low privilege, but restricted to type=hub
   * 
   */
  async relocate() {
    if (/(media\.relocate)/.test(this.input.get(Attr.service))) {
      await this.transact("mfs_move_all");
    } else {
      this.exception.user(UNABLE_TO_MOVE_SAHREBOX);
    }
  }

  /**
   * 
   */
  async dmz_detail() {
    let res = {};
    let dmz_id = this.user.get("dmz_hub_id");
    let dmz_token = this.user.get("dmz_token");
    if (dmz_id) {
      res = await this.yp.await_proc("dmz_info_next", dmz_token);
    } else {
      res.status = "NO_DMZ ";
    }
    this.output.data(res);
  }

  /**
   *
   * @returns
   */
  async dmz_copy() {
    let flag = this.input.need(Attr.flag) || "no";
    let res = {};
    let guest;
    let dmz_id = this.user.get("dmz_hub_id");
    let dmz_token = this.user.get("dmz_token");
    let data;
    let node;
    let media;
    if (!dmz_id) {
      res.status = "NO_DMZ ";
      return this.output.data(res);
    }
    await this.yp.await_proc("dmz_update_sync", dmz_token, 0);

    let dmz = await this.yp.await_proc("dmz_info_next", dmz_token);

    if (!dmz) {
      res.status = "NO_DMZ ";
      return this.output.data(res);
    }
    if (dmz.privilege < 3) {
      res.status = "NO_COPY_PERMISSION";
      return this.output.data(res);
    }

    if (flag == "yes") {
      let src = await this.yp.await_proc(
        "forward_proc",
        dmz_id,
        "mfs_access_node",
        `'${dmz.uid}', '${dmz.nid}'`
      );

      let tempnode = {
        nid: src.nid,
        hub_id: src.hub_id,
      };
      src = tempnode;
      const uid = this.user.uid();
      const pid = this.home_id;
      const rid = this.uid;

      data = await this.db.await_proc(
        "mfs_copy_all", src, uid, pid, rid
      );

      data = toArray(data);
      for (node of data) {
        if (node.action == "showone") {
          await this.db.await_proc("mfs_rename", node.nid, dmz.name);
          media = await this.db.await_proc(
            "mfs_access_node",
            this.uid,
            node.nid
          );
        }
      }

      this.heap.recipient_id = this.uid;
      await this.after_transact(data);
    }

    if (media) {
      media.hub_id = this.uid;
      media.privilege = media.permission;
      media.actual_home_id = this.home_id;
      media.service = "desk.create_hub";
      await this.notify_user(this.uid, media);
    }

    this.output.data(dmz);
  }

  /**
   * 
   */
  async make_dir_special() {
    let res = [];
    let users = this.input.need(Attr.users);
    let node;
    for (let uid of users) {
      let user = await this.yp.await_proc("get_visitor", uid);
      let privilege = await this.db.await_func(`user_permission`, uid, "*");
      user.privilege = privilege;
      if (!(privilege & Permission.OWNER) && privilege & Permission.READ) {
        let profile = JSON.parse(user.profile);
        let fn = profile.firstname || "";
        let ln = profile.lastname || "";
        fn = fn.trim();
        ln = ln.trim();
        if (isEmpty(fn + ln)) {
          fn = profile.email;
        }
        let md = {
          uid: user.id,
          privilege: privilege,
          fullname: `${fn} ${ln}`.trim(),
          node_type: "p2p",
        };
        node = await this.db.await_proc(
          "mfs_make_dir",
          "0",
          stringify(md.fullname),
          1
        );
        await this.db.await_proc(
          "mfs_set_attr",
          node.id,
          "metadata",
          md
        );
        for (let id of users) {
          if (id == user.id) {
            await this.db.await_proc(
              "permission_grant",
              node.id,
              user.id,
              0,
              Privilege.WRITE,
              "system",
              `Writable by ${profile.email}`
            );
          } else {
            await this.db.await_proc(
              "permission_grant",
              node.id,
              user.id,
              0,
              Privilege.GUEST,
              "system",
              `Unreadable by ${profile.email}`
            );
          }
        }
      }
      res.push(user);
    }
    this.output.data(res);
  }

  /**
   * 
   */
  broadcast() {
    const message = this.input.use(Attr.message);
    this.notify_hub(this.hub.get(Attr.id), message);
    this.output.data(message);
  }

  /**
   * 
   */
  count_new() {
    const nid = this.input.use(Attr.nid) || this.home_id;
    this.db.call_proc("mfs_count_new", nid, this.uid, this.output.data);
  }

  /**
   * 
   */
  show_new() {
    const nid = this.input.use(Attr.nid, this.home_id);
    const page = this.input.use(Attr.page, 1);
    this.db.call_proc("mfs_show_new", nid, this.uid, page, this.output.list);
  }

  /**
   *
   */
  async set_lock() {
    let node = this.granted_node();
    let lock = {
      uid: this.uid,
      date: new Date().getTime(),
    };
    await this.db.await_proc("mfs_set_metadata", node.id, { lock }, 0);
  }

  /**
   * Mutex. Get lock before writing into the file.
   */
  async get_lock() {
    let node = this.granted_node();
    let md = JSON.parse(node.metadata) || {};
    // let md5_hash = this.input.need('md5_hash');
    let user = this.user.toJSON();
    let writable = 0;
    let user_online = 0;
    let now = new Date().getTime();
    let lock = {
      uid: this.uid,
      date: now,
      // md5_hash
    };
    if (!md.lock) {
      writable = 1;
      await this.db.await_proc("mfs_set_metadata", node.id, { lock }, 0);
    } else {
      lock = JSON.parse(md.lock) || {};
      if (lock.uid == null || lock.uid == this.uid) {
        writable = 1;
        await this.set_lock();
      } else {
        user_online = await this.yp.await_func("is_user_online", lock.uid);
        if (user_online == 0) {
          writable = 1;
          user = this.user.toJSON();
        } else {
          if (now - lock.date > 60000) {
            writable = 1;
            user = this.user.toJSON();
          } else {
            writable = 0;
            user = await this.yp.await_proc("get_user", lock.uid);
          }
        }
      }
    }
    let locked = {
      ...lock,
      ctime: node.ctime,
      mtime: node.mtime,
      firstname: user.firstname,
      lastname: user.lastname,
    };
    node.locked = locked;
    node.filepath = node.file_path;
    node.writable = writable;
    this.output.data(node);
  }

  /**
   * 
   * @returns 
   */
  async pre_restore_into() {
    const uid = this.uid;
    //this.check_sanity(1);

    const src = this.source_granted(Attr.all);
    const dest = this.dest_granted();
    this.heap.srcgrantlst = [];
    let source_node;
    let denied = [];
    for (let node of src) {
      var proc = `${node.db_name}.mfs_access_node`;
      source_node = await this.yp.await_proc(proc, uid, node.id);
      if (source_node.permission & node.privilege) {
        this.heap.srcgrantlst.push({
          nid: source_node.nid,
          hub_id: source_node.hub_id,
          recipient_id: dest.hub_id,
          pid: dest.id,
          rank: 1,
        });
      } else {
        denied.push(source_node);
      }
    }
    if (!isEmpty(denied)) {
      this.warn("Got denied nodes", denied)
      this._done();
      return this.output.add_data({ denied });
    }
    this._done();
  }

  /**
   * 
   */
  async restore_into() {
    const src = this.heap.srcgrantlst;
    const uid = this.uid;
    let data = await this.db.await_proc(
      "mfs_restore_into_next",
      src,
      uid
    );
    await this._dispatch_restore(data);
  }

  /**
  * Restore a trashed file/folder to its original location.
  * If the original parent no longer exists, returns parent_missing=1
  * so the FE can show a location picker and call restore_into instead.
  * No physical file move is needed — files remain in mfs_root/{id}/.
  */
  async restore() {
    const nid = this.input.need(Attr.nid);
    let data = await this.db.await_proc('mfs_restore', nid);
    data = toArray(data)[0] || {};

    if (data.failed) {
      return this.exception.user(data.message || 'RESTORE_FAILED');
    }

    if (data.parent_missing) {
      return this.output.data({
        parent_missing: 1,
        nid,
        original_parent_id: data.original_parent_id,
      });
    }

    // Fetch full node attributes for WS notification
    const restored = await this.db.await_proc('mfs_access_node', this.uid, nid);
    if (!restored || !restored.hub_id) {
      return this.output.data(data);
    }

    let changelog = await this.changelog_write({ src: restored, event: 'media.new' });
    let sockets = await this.yp.await_proc('entity_sockets', restored.hub_id);
    await RedisStore.sendData(
      this.payload({ ...restored, args: { changelog } }, { service: 'media.restore' }),
      sockets
    );
    await RedisStore.sendData(
      this.payload({ rebuild: 1 }, { service: 'notification.resync' }),
      sockets
    );

    const hub_db = await this.yp.await_func('get_db_name', restored.hub_id);
    if (hub_db) {
      const ftype = restored.filetype || restored.category;
      const fname = restored.filename || restored.user_filename || nid;
      await writeAudit(this, {
        db: hub_db,
        uid: this.uid,
        action: 'added',
        category: 'media',
        entity_id: nid,
        log: `${ftype === 'folder' ? 'Folder' : 'File'} '${fname}' restored from trash`,
      });
    }

    this.output.data({ ...restored, args: { changelog } });
  }

  /**
   * 
   * @param {*} data 
   */
  async _dispatch_restore(data) {
    let src;
    let dest;
    let proc;
    data = toArray(data);
    var r;
    let show_node = [];
    for (var row of data) {
      switch (row.action) {
        case "copy":
          src = {
            nid: row.nid,
            mfs_root: row.src_mfs_root,
          };
          dest = {
            nid: row.des_id,
            mfs_root: row.des_mfs_root,
          };
          proc = `${row.dest_db_name}.mfs_access_node`;
          r = await this.yp.await_proc(proc, this.uid, dest.nid);
          r.privilege = r.permission;
          show_node.push(r);
          copy_node(src, dest, 1);
          break;
        case "show":
        case "showone":
          if (!row.dest_db_name) {
            let entity = await this.yp.await_proc('get_entity', this.input.get('recipient_id'))
            proc = `${entity.db_name}.mfs_access_node`;
            r = await this.db.await_proc(proc, this.uid, row.nid);
            r.privilege = r.permission;
            if (r.filetype == Attr.hub) {
              r.hub_id = row.nid; // hub_id is inconsistent after trash
            }
            show_node.push(r);
            continue;
          }
          proc = `${row.dest_db_name}.mfs_access_node`;
          r = await this.yp.await_proc(proc, this.uid, row.nid);
          r.privilege = r.permission;

          if (r.filetype == Attr.hub) {
            r.hub_id = row.nid; // hub_id is inconsistent after trash
          }
          show_node.push(r);
          break;
        case "delete":
          remove_node({ nid: row.nid, mfs_root: row.src_mfs_root }, 1);
          break;
        case "move":
          src = { nid: row.nid, mfs_root: row.src_mfs_root };
          dest = {
            nid: row.des_id,
            hub_id: row.dest_hub_id,
            mfs_root: row.des_mfs_root,
          };
          move_node(src, dest, 1);
          break;
        case "outbound":
          proc = `${row.dest_db_name}.mfs_get_related_sb`;
          let results = await this.yp.await_proc(proc, row.nid);
          var p;
          for (var sb_media of results) {
            p = `${row.dest_db_name}.sbx_restore`;
            await this.yp.await_proc(p, this.uid, row.nid, sb_media.uid);
            show_node.push(p);
          }
          break;
      }
    }
    let sockets = [];

    for (var m of show_node) {
      let changelog = await this.changelog_write({ src: m, event: "media.new" });
      let dest = await this.yp.await_proc("entity_sockets", m.hub_id);
      sockets = sockets.concat(dest);
      m.args = { ...m.args, changelog };
      await RedisStore.sendData(
        this.payload(m, { service: "media.restore_into" }),
        dest
      );
    }
    await RedisStore.sendData(
      this.payload({ rebuild: 1 }, { service: "notification.resync" }),
      sockets
    );

    this.output.list(show_node);
  }

  /**
   * 
   */
  pre_move() {
    this.warn("pre_move is DEPRECATED")
  }

  /**
   * Ensure right conditions are met before moving
   * @returns 
   */
  _ready_for_move() {
    const { src } = this.heap;
    const { dest } = this.heap;
    this._failed = false;
    if (src == null || dest == null) {
      this.exception.user(INVALID_DATA);
      return;
    }

    if (["0", 0, "", null, undefined].includes(src.parent_id)) {
      this.exception.user(UNABLE_TO_DELETE_ROOT);
      return;
    }

    if (this.heap.circular_ref === "1") {
      this.exception.user(CIRCULAR_REF);
      return;
    }

    if (src[BOUND] !== NOBOUND && dest[BOUND] !== NOBOUND) {
      //throw {error: "500", message: UNABLE_TO_MOVE_SAHREBOX}

      return;
    }

    if (!(dest[FILETYPE] == FOLDER || dest[FILETYPE] == ROOT)) {
      this.exception.user(DESTINATION_IS_NOT_DIRECTORY);
      return;
    }

    if (src[FILETYPE] !== HUB && src[FILETYPE] !== FOLDER) {
      const src_path = check_base(src);
    }
    this._done();
  }

  /**
   * 
   */
  update_caption() {
    const nid = this.input.need(NODE_ID);
    const caption = this.input.need(CAPTION);
    this.update(CAPTION, caption, nid);
    this.output.data(this.get_file_stat(nid));
  }

  /**
   * 
   */
  async update_status() {
    const nid = this.input.need(NODE_ID);
    const status = this.input.need(STATUS);
    let data = await this.db.await_proc(
      "mfs_set_node_attr",
      nid,
      { status },
      1
    );
    this.output.data(data);
  }

  /**
   * To prevent node from being accidentally trashed
   */
  async lock() {
    let list = this.input.need(Attr.list);
    for (let nid of list) {
      await this.db.await_proc("mfs_set_attr", nid, "status", Attr.locked);
    }
    this.output.data(list);
  }

  /**
   * To actually purge nodes from trash bin
   * @params {array} ( list of nodes to be purged)
   */
  async _purge(data) {
    data = toArray(data) || [];
    let res = [];
    let entities = [];
    let db_name, files;
    for (var node of data) {
      db_name = node.db_name;
      if (!db_name || db_name == null) {
        files = await this.db.await_proc("mfs_purge", node.id);
        continue;
      }
      switch (node.category) {
        case Attr.folder:
          files = await this.yp.await_proc(db_name + ".mfs_purge", node.id);
          files = toArray(files);
          for (let f of files) {
            res.push(f);
            remove_node(f, 1);
          }
          break;
        case Attr.hub:
          throw "HUB_DELETION_FORBIDEN";
        default:
          await this.yp.await_proc(db_name + ".mfs_purge", node.id);
          res.push(node.id);
          if (node.bound !== Attr.inbound) {
            remove_node(node, 1);
          }
      }
    }
    for (var entity of entities) {
      await this.yp.await_proc("entity_delete", entity);
    }
    return data.concat(res);
  }

  /**
   * To actually purge entire trash bin
   * @params null
   */
  async empty_bin() {
    if (!this.user.get(Attr.settings).trash_expiry) {
      let list = await this.db.await_proc("mfs_empty_trash");
      await this._empty_bin(list)
      return this.output.data(list)
    }
    try {
      if (!this.uid) {
        throw new Error('User ID is required');
      }

      const hub_id = this.hub.get(Attr.id);
      if (!hub_id) {
        throw new Error('Hub ID is required');
      }

      const job = await emptyTrash(
        this.uid,
        hub_id,
        {
          socket_id: this.input.get(Attr.socket_id) || null,
          priority: 5
        }
      );

      this.output.data({
        status: 'queued',
        job_id: job.id,
        message: 'Trash cleanup has been queued'
      });

    } catch (error) {
      this.warn('[TRASH] Failed to queue empty_bin:', error.message);
      this.exception.server('FAILED_TO_QUEUE_TRASH_CLEANUP');
    }
  }

  /**
   *
   * @param {*} data
   */
  async _empty_bin(data) {
    let entities = toArray(data) || [];
    const { server_home } = sysEnv();
    let cmd = resolve(
      server_home,
      "offline",
      "media",
      "purge.js"
    );
    let args = {
      entities,
      uid: this.uid
    }
    let dir = resolve(tmp_dir, 'offline', 'queue');
    mkdir(dir);
    let file = resolve(dir, this.randomString() + '.json')
    writeJson(file, args, JSON_OPT);
    const child = Spawn(cmd, [file], SPAWN_OPT);
    child.unref();
  }

  /**
   *
   */
  async purge() {
    const list = this.input.use(Attr.list, []);
    let data = await this.db.await_proc("mfs_delete_trash", list);
    if (!isEmpty(data)) {
      await this._empty_bin(data);
    }
    this.output.list(data);
  }

  /**
   *
   * @returns
   */
  async pre_trash() {
    const src = this.source_granted(Attr.all);

    this.heap.nodes = this.heap.nodes || this.source_nodes(); //JSON.parse(this.src.args);
    this.heap.srcgrantlst = [];
    let granted = [];
    let tnode;
    for (var hub of this.heap.nodes) {
      if (isString(hub.nid)) {
        tnode = { nid: hub.nid, hub_id: hub.hub_id };
        granted.push(tnode);
      } else {
        for (let id of hub.nid) {
          tnode = { nid: id, hub_id: hub.hub_id };
          granted.push(tnode);
        }
      }
    }
    let data = await this.db.await_proc(
      "mfs_chk_pre_trash",
      stringify(granted),
      this.uid,
      Permission.MODIFY
    );
    if (!isEmpty(data)) {
      this.exception.user("_delete_hub");
      return;
    }

    let is_locked = 0;
    for (var node of src) {
      if (node.node.status == "locked") {
        is_locked = is_locked + 1;
        break;
      }
    }
    if (is_locked > 0) {
      this.exception.user(LOCKED);
      return;
    }
    this._done();
  }

  /**
   *
   * @returns
   */
  async trash() {
    this.heap.nodes = this.heap.nodes || this.source_nodes(); //JSON.parse(this.src.args);
    this.heap.srcgrantlst = [];
    let granted = [];
    let node;
    for (var hub of this.heap.nodes) {
      if (isString(hub.nid)) {
        node = { nid: hub.nid, hub_id: hub.hub_id };
        granted.push(node);
      } else {
        for (let id of hub.nid) {
          node = { nid: id, hub_id: hub.hub_id };
          granted.push(node);
        }
      }
    }
    // Snapshot filename/filetype before mfs_pre_trash_next moves rows
    // to trash_media — needed for human-readable audit log lines.
    const auditTargets = [];
    for (const g of granted) {
      try {
        const hub_db = await this.yp.await_func('get_db_name', g.hub_id);
        if (!hub_db) continue;
        const attr = await this.yp.await_proc(`${hub_db}.mfs_node_attr`, g.nid);
        if (!attr) continue;
        auditTargets.push({
          hub_db,
          nid: g.nid,
          filename: attr.user_filename || attr.filename || g.nid,
          filetype: attr.category || attr.filetype,
        });
      } catch (e) { /* best-effort */ }
    }
    let data = await this.db.await_proc(
      "mfs_pre_trash_next",
      granted,
      this.uid,
      Permission.MODIFY
    );
    let keys = [Attr.nid, Attr.hub_id];
    let service = "media.remove";
    let recipients;
    let changelog = await this.changelog_write({ src: data, event: service });
    if (isEmpty(data)) {
      for (let h of granted) {
        recipients = await this.yp.await_proc("entity_sockets", h.hub_id);
        await RedisStore.sendData(
          this.payload({ ...h, changelog }, { keys, service }),
          recipients
        );
        await RedisStore.sendData(
          this.payload({}, { service: "notification.resync" }),
          recipients
        );
        await this.yp.await_proc("reminder_remove", { ...h, uid: this.uid });
      }
      this.output.data({ args: { changelog } });
      return;
    }
    recipients = await this.yp.await_proc("entity_sockets", this.hub.get(Attr.id));
    await RedisStore.sendData(
      this.payload(data, { changelog, keys: "*", service }),
      recipients
    );
    await RedisStore.sendData(
      this.payload({}, { service: "notification.resync" }),
      recipients
    );
    this.output.add_data({ changelog });

    for (const t of auditTargets) {
      await writeAudit(this, {
        db: t.hub_db,
        uid: this.uid,
        action: 'deleted',
        category: 'media',
        entity_id: t.nid,
        log: `${t.filetype === 'hub' ? 'Workspace' : t.filetype === 'folder' ? 'Folder' : 'File'} '${t.filename}' moved to trash`,
      });
    }

    this.output.list(data);
  }

  /**
   * Show trsh content
   */
  show_bin() {
    const page = this.input.get(Attr.page);
    if (page == null || page == undefined || page == 0) page = 1;
    this.db.call_proc("mfs_show_bin", page, this.output.list);
  }

  /**
   * 
   */
  async home() {
    const data = await this.db.await_proc("mfs_home");
    let db_name = this.user.get(Attr.db_name);
    let media = await this.yp.await_proc(`${db_name}.mfs_node_attr`, data.hub_id);
    if (media.file_path) {
      data.filename = basename(media.file_path)
    } else {
      data.filename = data.name;
    }
    this.output.data(data);
  }

  /**
   * 
   */
  sharebox_home() {
    this.exception.user("DECPRECATED");
  }

  /**
   * 
   */
  show_folders() {
    const nid = this.input.use(NODE_ID, this.home_id);
    const name = this.input.use(Attr.name, Attr.name);
    const order = this.input.use(Attr.order, "asc");
    const page = this.input.use(Attr.page, 1);
    this.db.call_proc(
      "mfs_show_folders",
      nid,
      this.uid,
      name,
      order,
      page,
      this.output.data
    );
  }

  /**
   * 
   */
  reorder() {
    const list = this.input.use(Attr.content);
    this.db.call_proc("mfs_reorder", stringify(list), this.output.list);
  }

  /**
   * 
   */
  async get_node_stat() {
    let node = this.granted_node();
    let desk_node = {};
    if (node.area != Attr.personal) {
      let db_name = this.user.get(Attr.db_name);
      desk_node = await this.yp.await_proc(
        `${db_name}.mfs_access_node`,
        this.uid,
        node.hub_id
      );
    }
    if (desk_node.file_path) {
      let re = new RegExp(`\.${desk_node.id}$`);
      desk_node.file_path = desk_node.file_path.replace(re, "");
      node.file_path = basename(desk_node.file_path, node.file_path);
      node.parent_path = desk_node.file_path;
    }
    this.output.data(node);
  }

  /**
   * 
   */
  comment() {
    const nid = this.input.need(NODE_ID);
    const content = this.input.need(COMMENT);
    const rating = this.input.use(RATING, 0);
    let data = {
      ref_id: nid,
      author_id: this.uid,
      content,
      rating,
      status: "draft",
    };
    data = this.insert_comment_association(data);
    this.db.call_proc("get_media_comment", `${data.id}`, this.output.data);
  }

  /**
   * Renames a file.
   * @returns
   */
  async rename() {
    let tag = this.randomString();
    let { node } = this.source_granted();
    let { nid, hub_id } = node;
    let filename = decodeURI(this.input.need(FILENAME));
    if (/^(.|.+\/.+| )$/.test(filename)) {
      this.exception.user("INVALID_FILENAME");
      return;
    }

    if (node[BOUND] === INBOUND) {
      this.exception.user(UNABLE_TO_RENAME_INBOUND, "", node.filename);
      return;
    }
    let res;
    let oldItems = {};
    let newItems = {};
    let recipients;

    /**  Renaming hubname must not change other's name*/
    if (node[FILETYPE] == Attr.hub) {
      recipients = await this.yp.await_proc(
        "entity_sockets",
        this.uid
      );
    } else {
      recipients = await this.yp.await_proc(
        "entity_sockets",
        this.hub.get(Attr.id)
      );
    }
    switch (node[FILETYPE]) {
      case Attr.schedule:
        try {
          let { metadata } = JSON.parse(this.granted_node());
          metadata = cleanSeen(metadata);
          metadata.title = filename;
          res = await this.db.await_proc(
            "mfs_set_metadata",
            nid,
            { content: metadata },
            1
          );
        } catch (e) { }
      default:
        for (let r of toArray(recipients)) {
          if (!oldItems[r.uid]) {
            oldItems[r.uid] = await this.db.await_proc(
              "mfs_access_node",
              r.uid,
              nid
            );
          }
        }
        res = await this.db.await_proc("mfs_rename", nid, filename);
        let attr;
        if (newItems[this.uid] && newItems[this.uid].filename) {
          attr = newItems[this.uid]
        } else {
          attr = await this.db.await_proc("mfs_access_node", this.uid, nid);
          newItems[this.uid] = attr;
        }
        attr.hub_id = attr.actual_hub_id;
        attr.privilege = attr.permission;
        attr.home_id = attr.actual_home_id;
        newItems[this.uid] = attr;
        let old = oldItems[this.uid];
        if (old) {
          await this.changelog_write({ src: old, dest: attr });
        }
    }
    for (let r of toArray(recipients)) {
      let dest;
      if (newItems[r.uid] && newItems[r.uid].filename) {
        dest = newItems[r.uid]
      } else {
        dest = await this.db.await_proc("mfs_access_node", r.uid, nid);
        newItems[r.uid] = dest;
      }
      let model = {
        ...oldItems[r.uid],
        args: {
          dest,
          src: oldItems[r.uid],
          tag,
          changelog: this.__changelog
        }
      };
      await RedisStore.sendData(this.payload(model), r);
    }
    let model;
    if (newItems[this.uid]) {
      model = { ...newItems[this.uid] }
    } else {
      model = { ...node, filename };
    }
    model.args = {
      dest: newItems[this.uid],
      src: oldItems[this.uid],
      changelog: this.__changelog
    }

    const old_name = (oldItems[this.uid] && oldItems[this.uid].filename) || node.filename || nid;
    await writeAudit(this, {
      db: this.hub.get(Attr.db_name),
      uid: this.uid,
      action: 'changed',
      category: 'title',
      entity_id: nid,
      log: `${node[FILETYPE] === Attr.hub ? 'Workspace' : 'Item'} renamed from '${old_name}' to '${filename}'`,
    });

    this.output.data(model);
  }

  /**
   * Not used
   */
  share_media() {
    const destination = this.input.need(Attr.destination);
    const nid = this.input.need(Attr.nodeId);
  }


  /**
   * 
   */
  async rotate() {
    let node = this.granted_node();
    if (node.filetype != Attr.image) {
      return this.exception.user('WRONG_FILETYPE');
    }
    const angle = this.input.get("angle") || 90;
    let md5Hash = await Generator.rotate_image(node, angle);
    if (md5Hash) {
      let { metadata } = node;
      metadata = cleanSeen(metadata);
      metadata.md5Hash = md5Hash;
      let { mtime } = await this.db.await_proc("mfs_set_metadata", node.id, metadata, 1);
      node.mtime = mtime;
      node.metadata = metadata;
    }
    let changelog = await this.changelog_write({ src: node, event: "media.replace" });
    let sockets = await this.yp.await_proc("entity_sockets", node.hub_id);
    await RedisStore.sendData(this.payload(node), sockets);
    this.output.add_data({
      args: {
        changelog
      }
    })
    this.output.data(node);
  }

  /**
   * @param {any}
   * @param {any}
   * Save content into FMS node
   */
  /**
   * Snapshot the current on-disk content of `node` into file_version
   * before it gets overwritten by save/replace. Copies orig.{ext} to
   * mfs_root/{nid}/versions/{insert_id}.{ext}, inserts the row, and
   * accounts the snapshot bytes against hub disk_usage.
   *
   * Returns the file_version row id, or null if nothing was snapshotted
   * (no source blob, no md5 change, or the call failed). Failures are
   * logged but never thrown — versioning must never block a save.
   */
  async _snapshot_version(node, opts = {}) {
    try {
      if (!node || !node.id || !node.extension) return null;
      const ext = node.extension;
      const src = resolve(node.mfs_root, node.id, `orig.${ext}`);
      if (!existsSync(src)) return null;

      // Skip if the new content hashes to the same bytes as what's
      // already on disk. Caller passes the new md5 when available.
      if (opts.newMd5 && node.md5Hash && opts.newMd5 === node.md5Hash) {
        return null;
      }

      const filename = node.user_filename || node.filename || "";
      const filesize = parseInt(node.filesize, 10) || 0;

      // Reserve a row first; we backfill file_path once we know the id.
      const reserved = await this.db.await_proc(
        "file_version_create",
        node.id,
        filename,
        filesize,
        "",
        this.uid
      );
      const row = Array.isArray(reserved) ? reserved[0] : reserved;
      if (!row || !row.id) return null;
      const versionId = row.id;

      const versionsDir = resolve(node.mfs_root, node.id, "versions");
      if (!existsSync(versionsDir)) mkdirSync(versionsDir, { recursive: true });
      const dest = resolve(versionsDir, `${versionId}.${ext}`);
      copyFileSync(src, dest);

      await this.db.await_run(
        `UPDATE file_version SET file_path = ? WHERE id = ?`,
        [dest, versionId]
      );

      // Charge the snapshot bytes against the hub's disk_usage so
      // quota math stays honest. disk_usage trigger will sync quota.
      const hub_id = node.hub_id || (this.hub && this.hub.get(Attr.id));
      if (filesize > 0 && hub_id) {
        try {
          await this.yp.await_run(
            `UPDATE yp.disk_usage
                SET size = GREATEST(0, IFNULL(size, 0) + ?)
              WHERE hub_id = ?`,
            [filesize, hub_id]
          );
        } catch (e) {
          this.warn && this.warn("[VERSION] disk_usage update failed:", e.message);
        }
      }

      return versionId;
    } catch (e) {
      this.warn && this.warn("[VERSION] snapshot failed:", e && e.message);
      return null;
    }
  }

  /**
   * Shared helper: store or update an on-disk file into MFS.
   * Creates a new node when nid is absent/unknown; replaces the existing
   * node otherwise. Handles snapshot, filesize sync, and SEO reindex.
   */
  async _persist_file(filepath, user_filename, pid, nid, metadata = {}) {
    const { createHash } = require("crypto");

    if (nid) {
      let attr = await this.db.await_proc("mfs_access_node", this.uid, nid);

      if (isEmpty(attr)) {
        await this.store(pid, filepath, user_filename);
        return;
      }

      const hash = createHash("md5").update(readFileSync(filepath)).digest("hex");
      const merged = cleanSeen({ ...metadata, md5Hash: hash });

      const old_filesize = attr.filesize || 0;
      const old_category = attr.category || attr.filetype;
      const hub_id = attr.hub_id;

      await this._snapshot_version(attr, { newMd5: hash });
      await this.db.await_proc("mfs_set_metadata", nid, merged, 0);
      await this.replace_content(attr, filepath, user_filename, hash);

      try {
        const mfs_path = resolve(attr.mfs_root, attr.id, `orig.${attr.extension}`);
        if (!existsSync(mfs_path)) throw new Error(`File not found after replace: ${mfs_path}`);
        const new_filesize = statSync(mfs_path).size;
        if (old_filesize !== new_filesize) {
          const delta = Number(new_filesize) - Number(old_filesize);
          await this.db.await_proc("mfs_set_attr", nid, "filesize", new_filesize);
          await this.yp.await_run(
            `UPDATE yp.disk_usage SET size = GREATEST(0, IFNULL(size, 0) + ?) WHERE hub_id = ?`,
            [delta, hub_id]
          );
          this.debug(`[SAVE] Updated filesize: ${old_filesize} → ${new_filesize} (${delta > 0 ? '+' : ''}${delta})`);
        }
      } catch (error) {
        this.warn('[SAVE] Failed to update filesize:', error.message);
      }

      if ([Attr.document].includes(old_category)) {
        try {
          await this.db.await_proc('seo_delete_index', hub_id, nid);
          this.debug(`[SEO] Deleted old index for: ${attr.filename}`);
          await new Promise(r => setTimeout(r, 100));
          const updated_node = await this.db.await_proc("mfs_access_node", this.uid, nid);
          if (!isEmpty(updated_node)) {
            await indexQueue.addFile(updated_node, {
              uid: this.uid,
              socket_id: this.input.get(Attr.socket_id),
              hub_id,
              priority: 8
            });
            this.debug(`[SEO] Queued for reindexing: ${attr.filename}`);
          }
        } catch (error) {
          this.warn(`[SEO] Failed to reindex after save: ${error.message}`);
        }
      }
    } else {
      await this.store(pid, filepath, user_filename);
    }
  }


  /**
   */
  async save() {
    const content = this.input.need(Attr.content);
    const convert_to = this.input.get('convert_to');
    const parent = this.source_granted();
    const user_filename = this.input.need(Attr.filename);
    const outdir = resolve(tmp_dir, this.randomString());
    mkdirSync(outdir, { recursive: true });
    const filepath = resolve(outdir, user_filename);
    const nid = this.input.get(Attr.id);
    const pid = this.input.get(Attr.pid) || parent.id;
    const metadata = this.input.get(Attr.metadata) || {};
    let filter = {
      docx: "docx:Office Open XML Text:EmbedImages",
      pdf: "pdf:writer_pdf_Export"
    }
    switch (convert_to) {
      case Attr.pdf:
      case 'docx':
        const outfile = resolve(outdir, user_filename);
        let re = new RegExp(`.(${convert_to})$`, 'i')
        const infile = outfile.replace(re, '.html')
        writeFileSync(infile, content, { encoding: "utf-8" });
        let cmd = `${Script.soffice} ${outdir} ${infile} '${filter[convert_to]}'`;
        if (this.sh_exec(cmd)) {
          await this._persist_file(outfile, user_filename, pid, nid, metadata);
        } else {
          rmdir(outdir)
          return this.exception.server('PDF_CONVERSION_FAILED');
        }
        break;
      default:
        writeFileSync(filepath, content, { encoding: "utf-8" });
        await this._persist_file(filepath, user_filename, pid, nid, metadata);
    }
    rmdir(outdir) // Cleanup temp files

  }


  /**
   * replace existing media by uploaded file
   * @param {*} nid 
   * @param {*} incoming_file 
   * @param {*} filename 
   * @returns 
   */
  async replace(nid, incoming_file, filename) {
    let node = this.granted_node();
    if (/^(folder|root)$/.test(node.filetype)) {
      this.warn("COULD NOT REPLACE FOLDER", this.input.use(Attr.filepath), node);
      this.exception.user("TARGET_IS_FOLDER_OR_ROOT");
      return;
    }
    let md5Hash = this.input.get("md5Hash");
    let { metadata } = node;
    metadata = cleanSeen(metadata);
    metadata.md5Hash = md5Hash;

    // Snapshot the pre-replace blob into file_version before the new
    // upload overwrites it. Skipped automatically when md5 matches.
    await this._snapshot_version(node, { newMd5: md5Hash });

    let privilege = node.permission;
    let home_dir = node.home_dir;
    let mfs_root = node.mfs_root;
    let data = await this.before_store(incoming_file, filename, {
      nid: node.parent_id,
    });
    data.rtime = Math.floor(new Date().getTime() / 1000);
    data.publish_time = data.rtime;
    if (data.filename) {
      data.user_filename = data.filename.replace(`.${data.extension}`, "");
    }

    await this.db.await_proc("mfs_set_node_attr", nid, data, 0);
    await this.db.await_proc("mfs_set_metadata", nid, metadata, 0);
    node.metadata = metadata;
    await this.after_store(
      node.pid,
      incoming_file,
      { ...node, privilege, home_dir, mfs_root, md5Hash },
    );
    node = await this.db.await_proc("mfs_access_node", this.uid, nid);
    if (node.filetype == Attr.document) {
      Document.rebuildInfo(
        node,
        this.uid,
        this.input.get(Attr.socket_id)
      )
    }
    this.output.data({
      ...node,
      replace: 1,
    });
  }

  /**
   * 
   * @param {*} node 
   * @param {*} incoming_file 
   * @param {*} filename 
   * @param {*} hash 
   * @returns 
   */
  async replace_content(node, incoming_file, filename, hash) {
    node.privilege = node.permission;
    let data = await this.before_store(incoming_file, filename, {
      nid: node.parent_id,
    });
    if (!data) {
      return;
    }
    if (/^(folder|root)$/.test(node.filetype)) {
      this.exception.user("TARGET_IS_FOLDER_OR_ROOT");
      return;
    }
    data.rtime = Math.floor(new Date().getTime() / 1000);
    data.publish_time = data.rtime;
    data.changed_time = data.rtime;
    if (data.filename) {
      data.user_filename = data.filename.replace(`.${data.extension}`, "");
    }
    node = await this.db.await_proc("mfs_set_node_attr", node.nid, data, 1);

    // Update disk_usage when filesize changes
    const old_filesize = node.filesize || 0;
    const new_filesize = data.filesize || 0;
    const delta = new_filesize - old_filesize;

    if (delta !== 0) {
      try {
        const hub_id = node.hub_id || this.hub.get(Attr.id);
        await this.yp.await_run(`
          UPDATE disk_usage 
          SET size = GREATEST(0, IFNULL(size, 0) + ${delta}) 
          WHERE hub_id = '${hub_id}'
        `);

        this.debug(`[QUOTA] Updated disk_usage on replace_content: delta=${delta} bytes`);
        // Trigger will auto-sync quota_usage

      } catch (e) {
        this.warn('[QUOTA] Failed to update disk_usage on replace_content:', e.message);
      }
    }

    node.extension = data.extension;
    this._mustReplace = 1;
    let attr = await this.after_store(
      data.parent_id,
      incoming_file,
      node
    );
    this.output.data({ ...node, ...attr, replace: 1 });
  }

  /**
   * 
   */
  get_filenames() {
    const nid = this.input.use(Attr.nid) || this.home_id;
    this.db.call_proc("mfs_get_filenames", nid, this.output.data);
  }

  /**
   * create_server_dir in the import and export folder
   * @todo Need to check the permisition
   */
  create_server_dir() {
    var path = this.input.need(Attr.path);
    var type = this.input.need(Attr.type);
    var name = this.input.need(Attr.name);
    var folderPath = "";
    let { import_dir, export_dir } = sysEnv();
    if (type == Attr.import) {
      folderPath = import_dir || global.myDrumee.exchangesArea.importFolders;
    }

    if (type == Attr.export) {
      folderPath = export_dir || global.myDrumee.exchangesArea.exportFolders;
    }

    if (!folderPath || !existsSync(folderPath)) {
      return this.output.data({ error: "exchangesArea is not configured " });
    }

    folderPath = resolve(folderPath, path, name);
    mkdir(folderPath);
    let fileObj = {
      file: name,
      ext: false,
      path: resolve(path, name),
    };

    this.output.data(fileObj);
  }

  /**
   * To list the server files
   *
   */

  list_server_files() {
    var path = this.input.need(Attr.path);
    var type = this.input.need(Attr.type);
    var fileList = [];
    var folderPath = "";
    let { import_dir, export_dir } = sysEnv();

    if (type == Attr.import) {
      folderPath = import_dir || global.myDrumee.exchangesArea.importFolders;
    }

    if (type == Attr.export) {
      folderPath = export_dir || global.myDrumee.exchangesArea.exportFolders;
    }

    if (!folderPath || !existsSync(folderPath)) {
      return this.output.data({ error: " exchangesArea is not configured " });
    }

    folderPath = basename(folderPath, path);

    readdirSync(folderPath).forEach((file) => {
      var ext = extname(file);
      let pathLocal = basename(path, file);

      fileList.push({
        file: file,
        ext: ext ? ext : false,
        // mime: mimeT,
        path: pathLocal,
      });
    });
    this.output.add_data({ info: { path: path } });
    this.output.data(fileList);
  }

  /**
   * 
   */
  async summary() {
    const nid = this.input.need(Attr.nid);
    let data = await this.db.await_proc("mfs_node_summary", nid);
    this.output.data(data);
  }
}

module.exports = __private_media;
