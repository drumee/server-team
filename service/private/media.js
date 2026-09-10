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
  FILESIZE,
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
const { check_base, check_safety, remove_node, move_node, copy_node, mkdir, rmdir, cleanSeen } = MfsTools;
const Media = require("../media");
const { writeAudit } = require("./_audit");
const { movePlanRows } = require("./_move-plan");
const { createHub } = require("../lib/env");
const { ARCHIVE_EXTENSIONS, inspect } = require("../lib/archive");
/** filecap.category for every archive extension — what media.filetype carries. */
const ARCHIVE_CATEGORY = "zip";
const { stringify } = JSON;
const { isEmpty, isString, values } = require("lodash");
const { join, resolve, basename, extname, dirname } = require("path");
const { existsSync, readFileSync, writeFileSync, readdirSync, statSync, copyFileSync, mkdirSync, renameSync, cpSync, rmSync } = require("fs");
const { writeFileSync: writeJson } = require("jsonfile");
const SPAWN_OPT = { detached: true, stdio: ["ignore", "ignore", "ignore"] };
const Spawn = require("child_process").spawn;
const { tmp_dir, quota, server_location } = sysEnv();
const JSON_OPT = { spaces: 2, EOL: "\r\n" };
const { emptyTrash } = require('../../offline/queues/trashQueue');
const indexQueue = require('../../offline/queues/indexQueue');

function firstRow(data) {
  return toArray(data)[0] || null;
}

// Areas a workspace-level operation may touch. Everything else is not a
// workspace a user picks from the workspace menu: 'personal' is a desk, 'dmz'
// hubs sit behind meetings and share links, 'public' hubs are system sites, and
// 'pool' entities are unbuilt shells waiting for the factory.
const WORKSPACE_AREAS = new Set(["private", "share"]);

//########################################
class __private_media extends Media {
  constructor(...args) {
    super(...args);
    this.transact = this.transact.bind(this);
    this.chk_pre_transact = this.chk_pre_transact.bind(this);
    this.pre_transact = this.pre_transact.bind(this);
    this.copy_all = this.copy_all.bind(this);
    this.move_all = this.move_all.bind(this);
    this.workspace_move = this.workspace_move.bind(this);
    this.merge_workspace = this.merge_workspace.bind(this);
    this.copy_workspace = this.copy_workspace.bind(this);
    this.move_cross_hub = this.move_cross_hub.bind(this);
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
    let data = movePlanRows(await this.db.await_proc(proc, src, uid, id, hub_id), this);
    // after_transact consumes the plan and returns only the rows it rendered
    // for the destination, which drops the nid -> des_id pairing that the
    // 'move' rows carry. Cross-workspace file threads need exactly that
    // pairing: the file arrives under a new node id, and the thread left
    // behind has to be told which one.
    this.heap.movePlan = data;
    const deniedlst = this.heap.srcdeniedlst || [];
    if (isEmpty(data)) {
      if (deniedlst.length > 0) {
        this.output.data({ denied_lst: deniedlst });
      } else {
        this.output.data({});
      }
      return null;
    }
    let items = [];
    for (let item of data) {
      if (!item.failed) {
        items.push(item);
      } else {
        this.warn("Failed transaction", item);
      }
    }
    let res = await this.after_transact(items);
    this.output.data(res);
    return res;
  }

  /**
   *
   * @param {*} data
   */
  async move_node(data) { }

  /**
   * Move a node's files to the storage directory it will live under after a
   * cross-workspace move.
   *
   * MfsTools.move_node cannot do this. It validates the destination with
   * check_base, which requires the directory to already exist — but the
   * destination here is a node that was created seconds ago and has no
   * directory yet. check_base returns null, move_node returns without moving
   * anything, and says nothing. The result is a database row pointing at a node
   * id with no files behind it: the record says the file moved, every preview
   * and download 404s.
   *
   * That is why a workspace ends up with more storage directories than files —
   * one abandoned directory per move, each holding the only copy of its file.
   *
   * A plain rename is enough: both storage roots live on the same filesystem,
   * so this is one atomic operation with no copy. The EXDEV fallback covers a
   * future split across devices.
   *
   * Only check_base is bypassed. The safety lock still applies: move_node
   * refuses to touch a directory another process has claimed, and skipping
   * check_base is no reason to move a locked one.
   *
   * Failure is logged, never thrown: the database move has already committed by
   * the time this runs, and the files are still readable at the old path.
   */
  _relocateNodeStorage(src, dest) {
    if (!src || !dest || !src.nid || !dest.nid) return false;
    if (!src.mfs_root || !dest.mfs_root) return false;
    const from = resolve(src.mfs_root, `${src.nid}`);
    const to = resolve(dest.mfs_root, `${dest.nid}`);
    if (from === to) return true;
    try {
      if (!existsSync(from)) {
        this.warn("Node storage missing at source, nothing to relocate", {
          from, to,
        });
        return false;
      }
      check_safety(from);
      if (existsSync(to)) {
        this.warn("Node storage already present at destination", { to });
        return true;
      }
      mkdirSync(dirname(to), { recursive: true });
      try {
        renameSync(from, to);
      } catch (error) {
        if (error && error.code === "EXDEV") {
          cpSync(from, to, { recursive: true });
          rmSync(from, { recursive: true, force: true });
        } else {
          throw error;
        }
      }
      return true;
    } catch (error) {
      this.warn("Failed to relocate node storage", {
        from, to, error: error && error.message,
      });
      return false;
    }
  }

  /**
   *
   */
  async transact_show(node) {
    // `nid` is reassigned to actual_home_id for a hub node below, so it cannot
    // be destructured as const — that threw on the first hub row it met.
    const { des_db } = node;
    let { nid } = node;
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
    const isWorkspaceMove = this.input.get(Attr.service) === 'media.workspace_move';
    const workspaceMoveSource = isWorkspaceMove
      ? { ...(this.heap.oldItems[this.uid] || toArray(this.heap.srcgrantlst)[0] || {}) }
      : null;
    data = toArray(data);
    let result = [];
    const workspaceMoveHubNames = new Map();
    // let copied = [];
    let dest, src;
    // let notify = {};
    let nodes = {};
    for (node of data) {
      switch (node.action) {
        case "move":
          src = { nid: node.nid, mfs_root: node.src_mfs_root };
          dest = { nid: node.des_id, hub_id: rid, mfs_root: node.des_mfs_root };
          this._relocateNodeStorage(src, dest);
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
    const writtenWorkspaceMoves = new Set();
    for (let r of result) {
      const dest = { ...r };
      delete dest.args;
      const src = isWorkspaceMove
        ? { ...workspaceMoveSource }
        : { ...this.heap.oldItems[this.uid] }
      delete src.args;
      if (isWorkspaceMove) {
        const destinationHubId = dest.actual_hub_id || dest.hub_id || rid;
        dest.hub_id = destinationHubId;
        if (!workspaceMoveHubNames.has(destinationHubId)) {
          try {
            const hub = toArray(await this.yp.await_proc('get_hub', destinationHubId))[0] || {};
            let profile = {};
            try {
              profile = isString(hub.profile) ? JSON.parse(hub.profile) : (hub.profile || {});
            } catch (_) { }
            workspaceMoveHubNames.set(
              destinationHubId,
              profile.name || hub.name || hub.hubname || hub.headline || ''
            );
          } catch (e) {
            this.warn('Unable to resolve workspace-move destination name', e);
            workspaceMoveHubNames.set(destinationHubId, '');
          }
        }
        dest.hub_name = workspaceMoveHubNames.get(destinationHubId);
      }
      r.args = { tag, src, dest, changelog: this.__changelog }
      if (isWorkspaceMove) {
        const changelogKey = [
          src.hub_id || this.hub.get(Attr.id),
          src.nid || src.id,
          dest.hub_id,
          dest.nid,
        ].join(':');
        if (writtenWorkspaceMoves.has(changelogKey)) continue;
        writtenWorkspaceMoves.add(changelogKey);
      }
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

  _fileMoveActor() {
    const firstname = this.user.get(Attr.firstname) || "";
    const lastname = this.user.get(Attr.lastname) || "";
    return {
      id: this.uid,
      firstname,
      lastname,
      fullname: `${firstname} ${lastname}`.trim() || this.uid,
    };
  }

  async _directFileThreadSnapshot(hubId, fileNid, dbName) {
    try {
      if (!dbName) {
        const storage = firstRow(await this.yp.await_proc("file_move_entity_storage", hubId));
        dbName = storage && storage.db_name;
      }
      if (!dbName) return null;
      const snapshot = firstRow(await this.yp.await_proc(
        `${dbName}.file_move_source_snapshot`, this.uid, fileNid
      ));
      if (!snapshot || !snapshot.file_thread_id
        || snapshot.category === FOLDER || snapshot.category === HUB) return null;
      return {
        hub_id: hubId,
        file_nid: fileNid,
        file_thread_id: snapshot.file_thread_id,
        filename: snapshot.user_filename || fileNid,
      };
    } catch (error) {
      this.warn("Direct file-thread snapshot failed", error);
      return null;
    }
  }

  async _reserveDirectFileThreadTrash(target) {
    if (!target) return { failed: 1, reserved: 0, status: "DIRECT_TARGET_REQUIRED" };
    target.transition_id = target.transition_id || this.randomString().slice(0, 16);
    target.lineage_id = target.lineage_id || this.randomString().slice(0, 16);
    try {
      const reservation = firstRow(await this.yp.await_proc(
        "file_thread_access_reserve_direct",
        target.transition_id,
        target.lineage_id,
        this.uid,
        target.hub_id,
        target.file_nid,
        target.file_thread_id
      ));
      if (reservation && reservation.lineage_id) {
        target.lineage_id = reservation.lineage_id;
      }
      return reservation || { failed: 1, reserved: 0, status: "DIRECT_RESERVATION_EMPTY" };
    } catch (error) {
      this.warn("Direct file-thread trash reservation failed", error);
      return { failed: 1, reserved: 0, status: "DIRECT_RESERVATION_FAILED" };
    }
  }

  async _releaseDirectFileThreadTrash(target) {
    if (!target || !target.transition_id) return null;
    try {
      return firstRow(await this.yp.await_proc(
        "file_thread_access_release_direct",
        target.transition_id,
        target.hub_id,
        target.file_nid,
        target.file_thread_id
      ));
    } catch (error) {
      this.warn("Direct file-thread trash reservation release failed", error);
      return null;
    }
  }

  async _releaseDirectFileThreadTrashBatch(targets) {
    for (const target of targets) {
      await this._releaseDirectFileThreadTrash(target);
    }
  }

  async _transitionDirectFileThreadAccess(target, targetState, reason, holder = null) {
    if (!target) return null;
    try {
      const transition = firstRow(await this.yp.await_proc(
        "file_thread_access_transition_direct",
        target.transition_id || this.randomString().slice(0, 16),
        target.lineage_id || this.randomString().slice(0, 16),
        this.uid,
        target.hub_id,
        target.file_nid,
        target.file_thread_id,
        targetState,
        reason,
        (holder && holder.hub_id) || null,
        (holder && holder.file_nid) || null,
        // Only meaningful on the way out, and only readable now: the media row
        // that carries the name is deleted by the move.
        (reason === "move_out" && target.filename) || null
      ));
      if (!transition || transition.failed || Number(transition.transitioned) !== 1) {
        return transition;
      }
      const recipients = await this.yp.await_proc("entity_sockets", target.hub_id);
      await RedisStore.sendData(this.payload({
        operation_id: transition.transition_id,
        lineage_id: transition.lineage_id,
        access_revision: transition.access_revision,
        actor: this._fileMoveActor(),
        reason,
        state: targetState === "active" ? "restored" : "revoked",
        hub_id: target.hub_id,
        // On move_back the thread rebinds to the node the file came back as,
        // so the client is told the new id alongside the one it still holds.
        // Everything else leaves the file where it was and sends one id.
        file_nid: target.file_nid,
        previous_file_nid: target.previous_file_nid || undefined,
        file_thread_id: target.file_thread_id,
        filename: target.filename,
        // Where the file went, so the source workspace can name it on the
        // thread's info card instead of just greying the thread out.
        holder_hub_id: (holder && holder.hub_id) || undefined,
        holder_hub_name: (holder && holder.hub_name) || undefined,
      }, { service: "channel.file_thread_access_changed" }), recipients);
      return transition;
    } catch (error) {
      this.warn("Direct file-thread access transition failed", error);
      return null;
    }
  }

  /**
   * Threads attached to the files about to move, captured while the media rows
   * still exist. After mfs_move_all they are gone from this workspace and
   * file_move_source_snapshot returns nothing.
   *
   * A moved folder is expanded here too, since a thread can hang off any file
   * inside it, at any depth.
   */
  async _snapshotFileThreadsBeforeMove(sourceNodes) {
    const snapshots = new Map();
    for (const node of toArray(sourceNodes)) {
      const nid = node && (node.nid || node.id);
      const hubId = node && (node.actual_hub_id || node.hub_id);
      if (!nid || !hubId) continue;
      const storage = firstRow(await this.yp.await_proc("file_move_entity_storage", hubId));
      const dbName = storage && storage.db_name;
      if (!dbName) continue;
      try {
        // Handles a file and a folder alike: given a file it returns at most
        // that file's own thread, given a folder it returns every thread
        // beneath it at any depth.
        const threads = toArray(await this.yp.await_proc(
          `${dbName}.channel_file_thread_list_in_subtree`, nid
        ));
        for (const row of threads) {
          if (!row || !row.file_nid || !row.file_thread_id) continue;
          const key = String(row.file_nid);
          if (snapshots.has(key)) continue;
          const target = {
            hub_id: hubId,
            file_nid: row.file_nid,
            file_thread_id: row.file_thread_id,
            filename: row.user_filename || row.file_nid,
          };
          // Reserve now, while the media row is still here. The reservation
          // parks the lineage in 'moving', which is also what stops a second
          // operation touching this thread mid-move. If it fails the thread is
          // simply left alone — the file still moves, and a thread left marked
          // active over a departed file is recoverable.
          const reservation = await this._reserveDirectFileThreadTrash(target);
          if (reservation && !reservation.failed
            && Number(reservation.reserved) === 1) {
            target.reserved = true;
          } else {
            this.warn("File thread move-out reservation failed", {
              hub_id: hubId,
              file_nid: row.file_nid,
              status: reservation && reservation.status,
            });
          }
          snapshots.set(key, target);
        }
      } catch (error) {
        this.warn("Unable to list file threads before move", { nid, error });
      }
    }
    return snapshots;
  }

  /**
   * Hands back reservations for threads whose files did not end up moving.
   * A reservation parks the lineage in 'moving', and only the operation that
   * took it can clear it, so anything left behind would block every later move
   * of that thread.
   */
  async _releaseFileThreadReservations(snapshots, movedFileNids) {
    if (!snapshots || !snapshots.size) return;
    for (const [key, target] of snapshots) {
      if (!target || !target.reserved) continue;
      if (movedFileNids && movedFileNids.has(key)) continue;
      await this._releaseDirectFileThreadTrash(target);
      target.reserved = false;
    }
  }

  /**
   * The nid -> des_id pairs for every real file in a completed move plan.
   * Folders and hub roots are skipped: only a file can carry a thread.
   */
  _movedFilePairs() {
    const plan = toArray(this.heap.movePlan);
    const pairs = [];
    for (const row of plan) {
      if (!row || row.action !== "move" || !row.nid || !row.des_id) continue;
      if (row.category === FOLDER || row.category === HUB) continue;
      pairs.push({ source_file_nid: row.nid, destination_file_nid: row.des_id });
    }
    return pairs;
  }

  /**
   * Display name of a workspace, matching how after_transact names a
   * workspace-move destination: the hub profile first, then the personal-space
   * owner for a drumate.
   */
  async _hubDisplayName(hubId) {
    if (!hubId) return "";
    try {
      const hub = firstRow(await this.yp.await_proc("get_hub", hubId)) || {};
      let profile = {};
      try {
        profile = isString(hub.profile) ? JSON.parse(hub.profile) : (hub.profile || {});
      } catch (_) { }
      return profile.name || hub.name || hub.hubname || hub.headline || "";
    } catch (error) {
      this.warn("Unable to resolve workspace name", { hub_id: hubId, error });
      return "";
    }
  }

  /**
   * A file leaving its workspace: the thread stays behind, readable but frozen,
   * and records where the file went.
   *
   * Ordering is not negotiable. mfs_move_all deletes the source media row, and
   * the transition refuses to mark a thread unavailable while that row is still
   * there — the same check that stops a thread being revoked over a file that
   * never actually left.
   *
   * A failure here never undoes the move. The file has already crossed; the
   * worst case is a thread still marked active whose file is gone, which the
   * UI renders as an unavailable card. That is a far better outcome than
   * unwinding a completed move.
   */
  async _markFileThreadMovedOut(target, destinationHubId, destinationFileNid) {
    if (!target || !destinationHubId || !destinationFileNid) return null;
    // The reservation was taken before the move, while the media row still
    // existed — reserve requires a live file, the transition requires a
    // departed one, so they sit on opposite sides of mfs_move_all.
    if (!target.reserved) {
      this.warn("File thread move-out skipped: no reservation", {
        hub_id: target.hub_id,
        file_nid: target.file_nid,
      });
      return null;
    }
    const holder = {
      hub_id: destinationHubId,
      file_nid: destinationFileNid,
      hub_name: await this._hubDisplayName(destinationHubId),
    };
    const transition = await this._transitionDirectFileThreadAccess(
      target, "unavailable", "move_out", holder
    );
    // Consumed either way: the transition clears current_operation_id on
    // success, and releases it on failure. Leaving the flag set would make the
    // final sweep hand back a reservation that no longer exists.
    target.reserved = false;
    if (!transition || transition.failed || Number(transition.transitioned) !== 1) {
      // Release it so the lineage does not sit in 'moving' forever, blocking
      // every later move of the same thread.
      await this._releaseDirectFileThreadTrash(target);
      this.warn("File thread move-out transition failed", {
        hub_id: target.hub_id,
        file_nid: target.file_nid,
        status: transition && transition.status,
      });
    }
    return transition;
  }

  /**
   * A file returning to the workspace its thread never left. The thread wakes
   * up and re-points at the node the file came back as.
   *
   * rebind runs first and is the strict half: it refuses on a thread-id
   * mismatch or a thread already present on the returning node, so a file that
   * merely looks like the original cannot capture someone else's conversation.
   */
  async _markFileThreadMovedBack(lineage, returnedFileNid, sourceDbName) {
    if (!lineage || !returnedFileNid) return null;
    const homeHubId = lineage.current_hub_id;
    const homeFileNid = lineage.current_file_nid;
    const threadId = lineage.current_thread_id;
    try {
      const storage = firstRow(await this.yp.await_proc(
        "file_move_entity_storage", homeHubId
      ));
      const homeDb = (storage && storage.db_name) || sourceDbName;
      if (!homeDb) {
        this.warn("File thread move-back: home storage unresolved", { hub_id: homeHubId });
        return null;
      }
      const rebound = firstRow(await this.yp.await_proc(
        `${homeDb}.channel_file_thread_rebind_returned_file`,
        homeFileNid, returnedFileNid, threadId
      ));
      if (!rebound || rebound.failed) {
        this.warn("File thread rebind on return failed", {
          hub_id: homeHubId,
          old_file_nid: homeFileNid,
          returned_file_nid: returnedFileNid,
          status: rebound && rebound.status,
        });
        return rebound;
      }
      const target = {
        // The transition is keyed on lineage_id and re-points current_file_nid
        // at the returning node, so it takes the new id here. The old one goes
        // along as previous_file_nid, which is what the client needs to swap
        // the thread onto the file it can now open.
        hub_id: homeHubId,
        file_nid: returnedFileNid,
        returned_file_nid: returnedFileNid,
        previous_file_nid: homeFileNid,
        file_thread_id: threadId,
        lineage_id: lineage.lineage_id,
        transition_id: this.randomString().slice(0, 16),
        filename: rebound.filename || "",
      };
      return await this._transitionDirectFileThreadAccess(
        target, "active", "move_back", null
      );
    } catch (error) {
      this.warn("File thread move-back failed", error);
      return null;
    }
  }

  /**
   * A file deleted for good while it was away. The thread is still in its home
   * workspace and still readable, but nothing will ever come back to it, so it
   * moves to a terminal state rather than waiting indefinitely.
   *
   * Trash does not come through here: a trashed file can be restored, and the
   * thread should keep waiting.
   */
  async _markFileThreadOrphaned(holderHubId, holderFileNid) {
    if (!holderHubId || !holderFileNid) return null;
    try {
      // One row per thread that was waiting: the file may have been discussed
      // in several workspaces, and deleting it ends the wait in all of them.
      const orphaned = toArray(await this.yp.await_proc(
        "file_thread_lineage_orphan_holder",
        this.randomString().slice(0, 16), holderHubId, holderFileNid
      )).filter((row) => row && row.lineage_id);
      for (const row of orphaned) {
        // Each event goes to the workspace that still holds that thread, never
        // to the one where the file was deleted.
        const recipients = await this.yp.await_proc("entity_sockets", row.current_hub_id);
        await RedisStore.sendData(this.payload({
          lineage_id: row.lineage_id,
          access_revision: row.access_revision,
          actor: this._fileMoveActor(),
          reason: "orphaned",
          state: "orphaned",
          hub_id: row.current_hub_id,
          file_nid: row.current_file_nid,
          file_thread_id: row.current_thread_id,
        }, { service: "channel.file_thread_access_changed" }), recipients);
      }
      return orphaned;
    } catch (error) {
      this.warn("File thread orphan marking failed", error);
      return null;
    }
  }

  /**
   * Applies the thread half of a completed cross-workspace move, one file at a
   * time so that a problem with one thread cannot strand the others.
   *
   * Each moved file falls into one of three cases, decided by whether a thread
   * elsewhere is already tracking it:
   *   - tracked, and this workspace is that thread's home  -> the file is
   *     coming home, wake the thread up
   *   - tracked, but home is somewhere else                -> the file is
   *     passing through, just follow it
   *   - not tracked                                        -> if it had a
   *     thread here, that thread stays behind
   */
  async _applyFileThreadMove(sourceHubId, sourceDbName, destinationHubId, snapshots) {
    if (!sourceHubId || !destinationHubId
      || String(sourceHubId) === String(destinationHubId)) return;
    const pairs = this._movedFilePairs();
    if (!pairs.length) return;

    for (const pair of pairs) {
      try {
        // Every thread anywhere that is waiting on this file. A file discussed
        // in more than one workspace has one sleeping thread per workspace, and
        // a single move can touch several of them at once.
        const waiting = toArray(await this.yp.await_proc(
          "file_thread_lineage_resolve_holder", sourceHubId, pair.source_file_nid
        )).filter((row) => row && row.lineage_id);

        for (const lineage of waiting) {
          if (String(lineage.current_hub_id) === String(destinationHubId)) {
            // This thread's own workspace is where the file is going: its wait
            // is over.
            await this._markFileThreadMovedBack(
              lineage, pair.destination_file_nid, sourceDbName
            );
          } else {
            // Still away from home. Follow the file so the thread's info card
            // keeps naming the workspace that actually holds it.
            const tracked = firstRow(await this.yp.await_proc(
              "file_thread_lineage_track_holder",
              lineage.lineage_id, destinationHubId, pair.destination_file_nid
            ));
            if (!tracked || tracked.failed || Number(tracked.tracked) !== 1) {
              this.warn("File thread holder tracking failed", {
                lineage_id: lineage.lineage_id,
                status: tracked && tracked.status,
              });
            }
          }
        }

        // Independent of the above: this workspace may ALSO have its own thread
        // on the file, written by the people here. That thread stays, and goes
        // to sleep now that the file is leaving.
        //
        // Both halves run for the same move. Sending a file back to A while B
        // has its own conversation about it wakes A's thread and puts B's to
        // sleep in one pass — handling only one of them is what left B's thread
        // pointing at a file that was no longer there.
        const target = snapshots && snapshots.get(String(pair.source_file_nid));
        if (!target) continue;
        await this._markFileThreadMovedOut(
          target, destinationHubId, pair.destination_file_nid
        );
      } catch (error) {
        this.warn("File thread move handling failed", {
          source_file_nid: pair.source_file_nid,
          error,
        });
      }
    }
  }

  /**
   * 
   */
  async move_all() {
    await this.transact("mfs_move_all");
  }

  /**
   * Compatibility shim for browsers still running the previous bundle.
   *
   * That bundle picks this endpoint whenever the file being moved has a chat
   * thread, and the saga behind it is gone: threads no longer travel between
   * databases. Removing the endpoint outright broke exactly the case it was
   * meant for — a cached client kept calling it and every move of a file with a
   * thread failed.
   *
   * The move itself is identical either way, so forward to workspace_move.
   * Delete once no client can still ask for this name.
   */
  async move_cross_hub() {
    const source = toArray(this.heap.srcgrantlst)[0] || {};
    const destination = this.dest_granted() || {};

    await this.workspace_move();

    // The old bundle refuses the move unless the reply says state
    // "committed" — it was written to poll a saga. workspace_move raises on
    // failure, so reaching this line means the files have moved, and this
    // vocabulary is the only success that client recognises.
    //
    // Overwrites the payload workspace_move already wrote (through transact).
    // The old bundle reads only `state` from this response, and the grid it
    // would otherwise repaint from is driven by the media.move / media.remove
    // events, not by this reply.
    this.output.data({
      operation_id: this.randomString().slice(0, 16),
      state: "committed",
      source_hub_id: source.actual_hub_id || source.hub_id || null,
      source_file_nid: source.nid || source.id || null,
      destination_hub_id: destination.actual_hub_id || destination.hub_id || null,
      access_revision: 0,
    });
  }

  /**
   * Move one or more items to another workspace as one server-side operation.
   *
   * The browser previously modeled this as copy then trash. Apart from leaving
   * a failure window between those requests, the trash operation had no trusted
   * destination context to record in the source workspace activity feed.
   * `mfs_move_all` already performs the cross-hub node migration; using it here
   * lets after_transact write a media.workspace_move changelog row with both the
   * source and destination node attributes.
   */
  async workspace_move() {
    const destination = this.dest_granted() || {};
    const destinationHubId = destination.actual_hub_id || destination.hub_id;
    const sourceNodes = toArray(this.heap.srcgrantlst);
    if (sourceNodes.some((node) => String(node.actual_hub_id || node.hub_id) === String(destinationHubId))) {
      this.exception.user(INVALID_DATA);
      return;
    }

    // Captured before the move: mfs_move_all deletes the source media rows, and
    // file_move_source_snapshot reads them.
    const threadSnapshots = await this._snapshotFileThreadsBeforeMove(sourceNodes);

    let result;
    try {
      result = await this.transact("mfs_move_all");
    } catch (error) {
      // The reservations were taken before the move; nothing moved, so release
      // them rather than leave every affected thread parked in 'moving' with
      // no operation left to clear it.
      await this._releaseFileThreadReservations(threadSnapshots);
      throw error;
    }
    if (isEmpty(result)) {
      await this._releaseFileThreadReservations(threadSnapshots);
      return;
    }

    const sourceUpdates = {};
    for (const node of sourceNodes) {
      const nid = node.nid || node.id;
      const hub_id = node.actual_hub_id || node.hub_id;
      if (!nid || !hub_id) continue;
      const snapshot = this.heap.oldItems[this.uid];
      const isMatchingSnapshot = snapshot
        && String(snapshot.nid || snapshot.id) === String(nid);
      sourceUpdates[`${hub_id}:${nid}`] = {
        ...node,
        ...(isMatchingSnapshot ? snapshot : {}),
        nid,
        hub_id,
      };
    }

    for (const source of values(sourceUpdates)) {
      const recipients = await this.yp.await_proc("entity_sockets", source.hub_id);
      await RedisStore.sendData(
        this.payload(source, { keys: [Attr.nid, Attr.hub_id], service: "media.remove" }),
        recipients
      );
      await RedisStore.sendData(
        this.payload({}, { service: "notification.resync" }),
        recipients
      );
    }

    // The thread half of the move. Threads are never carried across databases:
    // each one stays in the workspace where it was written, marked unavailable
    // while its file is away, and wakes up if that file comes back. Messages
    // therefore never leave the database that owns them, which is what makes
    // this safe where copying them was not.
    //
    // Deliberately last, and deliberately unable to fail the move: the files
    // have already crossed. A thread left marked active over a departed file
    // shows up as an unavailable card, which is recoverable; unwinding a
    // completed move is not.
    // One pass per distinct source workspace: a selection can span several,
    // and each has its own database to resolve threads against.
    const handledSourceHubs = new Set();
    for (const source of values(sourceUpdates)) {
      const sourceHubId = String(source.hub_id);
      if (handledSourceHubs.has(sourceHubId)) continue;
      handledSourceHubs.add(sourceHubId);
      const storage = firstRow(await this.yp.await_proc(
        "file_move_entity_storage", source.hub_id
      ));
      await this._applyFileThreadMove(
        source.hub_id,
        storage && storage.db_name,
        destinationHubId,
        threadSnapshots
      );
    }

    // A selection can be partly refused (permissions, circular reference), so a
    // reserved thread whose file never moved has to be handed back.
    const movedNids = new Set(
      this._movedFilePairs().map((pair) => String(pair.source_file_nid))
    );
    await this._releaseFileThreadReservations(threadSnapshots, movedNids);
  }

  /**
   * Merge one workspace into another: the contents of the source workspace
   * become a folder, named after it, inside the destination workspace.
   *
   * PHASE 1 - FILES ONLY, AND THE SOURCE SURVIVES, EMPTIED. Dropping it is a
   * separate step on purpose. Nothing should both relocate rows and drop a
   * database until the relocating half has been proven in production, so there
   * is no entity_delete on this path and nothing here drops anything.
   *
   * WHAT DOES NOT CROSS, and stays in the source workspace: chat threads (never
   * carried between databases - see workspace_move), tasks (task.nid addresses
   * media rows in the source database), meetings, share links, trash and
   * version history. Members do not cross either: the destination member list
   * is untouched, so whoever could reach these files only through the source
   * workspace loses them. That is exactly what moving one file across
   * workspaces already does, and it keeps granting access an explicit,
   * admin-gated act instead of a side effect of a move.
   *
   * ORDER MATTERS. Everything that can refuse - identity, area, an empty
   * source, storage - is settled BEFORE the destination folder is created, so a
   * refused merge never leaves an empty folder behind in somebody else's
   * workspace.
   *
   * Declared with no `preproc` on purpose: pre_transact builds its node list
   * from the ACL-granted source, which here is the source workspace's ROOT. The
   * nodes to move are that root's children, so the list is built below from
   * mfs_merge_source_nodes instead.
   */
  async merge_workspace() {
    const sourceHubId = this.hub.get(Attr.id);
    const sourceInfo = this.hub.toJSON() || {};
    const sourceDb = this.hub.get(Attr.db_name);

    const destination = this.dest_granted() || {};
    const recipientId = destination.actual_hub_id || destination.hub_id;
    const destPid = destination.id;
    const destDb = destination.db_name;

    if (!sourceHubId || !sourceDb || !recipientId || !destPid || !destDb) {
      this.warn("merge_workspace: source or destination unresolved", {
        sourceHubId, sourceDb, recipientId, destPid, destDb,
      });
      return this.exception.user(INVALID_DATA);
    }
    if (String(recipientId) === String(sourceHubId)) {
      this.warn("merge_workspace: source and destination are the same workspace", sourceHubId);
      return this.exception.user(INVALID_DATA);
    }

    // get_hub_owner resolves the id through vhost(), which reads yp.vhost by
    // entity id and therefore works on every domain. get_hub does NOT: it
    // rebuilds the fqdn as ident + '.drumee.com', which matches nothing
    // anywhere else and silently falls back to the 'home' entity - measured on
    // stage, where the real fqdn ends in .drumee.in. It must not be used to
    // identify a workspace here.
    const src = firstRow(await this.yp.await_proc("get_hub_owner", sourceHubId));
    const dst = firstRow(await this.yp.await_proc("get_hub_owner", recipientId));
    // The proc INNER JOINs yp.hub, so an empty row means "not a workspace".
    if (isEmpty(src) || isEmpty(dst)) {
      this.warn("merge_workspace: WRONG_ENTITY_TYPE", { sourceHubId, recipientId });
      return this.exception.user("WRONG_ENTITY_TYPE");
    }
    if (!WORKSPACE_AREAS.has(src.area) || !WORKSPACE_AREAS.has(dst.area)) {
      this.warn("merge_workspace: MERGE_AREA_NOT_ALLOWED", {
        source: src.area, destination: dst.area,
      });
      return this.exception.user("MERGE_AREA_NOT_ALLOWED");
    }

    // The workspace's display name lives in yp.hub.name, and mfs_node_attr is
    // how it is read from inside the workspace: for the ROOT node it answers
    // the hub name as `filename` (its CASE ... WHEN m.parent_id='0' branch).
    //
    // It is first in the chain because the obvious candidates are not there.
    // Measured against the running endpoint: this.hub.toJSON() carries neither
    // `name` nor `filename` for a workspace reached through scope:hub here, and
    // get_hub_owner's `ident` is NULL for anything desk_create_hub made. With
    // those two alone the folder was created named with the raw hub id.
    const rootAttr = firstRow(
      await this.db.await_proc("mfs_node_attr", this.home_id)
    ) || {};
    const sourceName = rootAttr.filename
      || sourceInfo.name || sourceInfo.filename || src.ident || sourceHubId;

    const nodes = toArray(await this.db.await_proc("mfs_merge_source_nodes"));
    if (isEmpty(nodes)) {
      // Said out loud rather than answered with an empty payload. On this
      // codebase's move paths a transaction that relocated nothing looked
      // exactly like one that succeeded, and that is what made the workspace
      // Move and Make-a-copy rows fail silently for months.
      this.output.data({
        status: "SOURCE_EMPTY",
        requested: 0,
        merged: 0,
        remaining: 0,
        folder: null,
        source_hub_id: sourceHubId,
        recipient_id: recipientId,
      });
      return;
    }

    const srcList = nodes.map((n) => ({ nid: n.nid, hub_id: sourceHubId }));

    // Storage. Inside one owner's allowance a merge is a net zero - the bytes
    // never leave it - so only a cross-owner merge can exceed anything. Mirrors
    // chk_pre_transact's copy branch, Infinity escape hatches included.
    if (String(src.owner_id || "") !== String(dst.owner_id || "")) {
      const limit = firstRow(await this.yp.await_proc("disk_limit", recipientId)) || {};
      const { watermark, owner_id, available_disk } = limit;
      const { watermark: sys_watermark } = quota;
      if (watermark != Infinity && sys_watermark != Infinity && !Number(limit.unlimited)) {
        const sized = firstRow(await this.yp.await_proc(
          "get_transation_size", srcList, recipientId, "move"
        )) || {};
        const size = Number(sized.size || 0);
        if (Number(available_disk) < size) {
          let error = Cache.message("your_limit_exceeded");
          if (this.uid != owner_id) {
            error = Cache.message("limit_exceeded");
          }
          this.warn("merge_workspace: destination has no room", {
            recipientId, available_disk, size,
          });
          return this.exception.user(error);
        }
      }
    }

    // First write of the whole handler. Every refusal above is behind us.
    const folderName = await this.yp.await_func(
      `${destDb}.unique_filename`, destPid, sourceName, ""
    );
    const created = firstRow(await this.yp.await_proc(
      `${destDb}.mfs_make_dir`, destPid, [folderName], 1
    )) || {};
    const folderId = created.id || created.nid;
    if (created.failed || !folderId) {
      this.warn("merge_workspace: destination folder could not be created", {
        recipientId, destPid, folderName, created,
      });
      return this.exception.server("SERVER_FAULT");
    }

    // after_transact reads both of these. oldItems supplies the `src` half of
    // every changelog row; one snapshot of the source root covers the whole
    // merge, where pre_transact's per-node-per-member walk would cost one proc
    // call for every node times every member online.
    this.heap.recipient_id = recipientId;
    this.heap.oldItems = {};
    const rootSnapshot = firstRow(
      await this.db.await_proc("mfs_access_node", this.uid, this.home_id)
    );
    if (rootSnapshot) this.heap.oldItems[this.uid] = rootSnapshot;

    const plan = movePlanRows(
      await this.db.await_proc(
        "mfs_move_all", srcList, this.user.uid(), folderId, recipientId
      ),
      this
    );

    const items = [];
    let refused = 0;
    for (const row of plan) {
      if (row && row.failed) {
        refused++;
        this.warn("merge_workspace: mfs_move_all refused a node", row);
      } else {
        items.push(row);
      }
    }

    const moved = await this.after_transact(items);

    // MEASURED, not inferred. mfs_move_all can decline a node without emitting
    // a `failed` row, so counting plan rows would report a clean merge over a
    // partial one. Asking the source what is still there cannot be fooled.
    const remaining = toArray(await this.db.await_proc("mfs_merge_source_nodes"));
    const stillHere = new Set(remaining.map((n) => String(n.nid)));
    const merged = nodes.length - remaining.length;
    if (remaining.length) {
      this.warn("merge_workspace: source workspace is not empty after the merge", {
        sourceHubId, requested: nodes.length, merged, remaining: remaining.length,
      });
    }

    // Tell the source workspace its content is gone. after_transact only
    // broadcasts to the DESTINATION - the same gap workspace_move fills right
    // here, and for the same reason: without this, anybody with the source
    // workspace open keeps seeing rows whose media records no longer exist,
    // until they reload. Driven off the MEASURED set, so a node that did not
    // actually move is not announced as removed.
    const departed = nodes.filter((n) => !stillHere.has(String(n.nid)));
    if (departed.length) {
      const recipients = await this.yp.await_proc("entity_sockets", sourceHubId);
      for (const node of departed) {
        await RedisStore.sendData(
          this.payload(
            { nid: node.nid, hub_id: sourceHubId },
            { keys: [Attr.nid, Attr.hub_id], service: "media.remove" }
          ),
          recipients
        );
      }
      await RedisStore.sendData(
        this.payload({}, { service: "notification.resync" }),
        recipients
      );
    }

    // Both sides get a row: one workspace lost its content, the other gained
    // it, and each audit log is read by a different set of admins. `removed`
    // and `added` are the two values action_log.action actually allows - it is
    // an ENUM, and a value outside it is written as an empty string while
    // writeAudit swallows the warning, which would leave no trace at all.
    await writeAudit(this, {
      db: sourceDb,
      uid: this.uid,
      action: 'removed',
      category: 'admin',
      notify_to: 'admin',
      entity_id: recipientId,
      log: `Workspace '${sourceName}' merged into another workspace as folder '${folderName}' - ${merged} item(s) moved out`,
    });
    await writeAudit(this, {
      db: destDb,
      uid: this.uid,
      action: 'added',
      category: 'admin',
      notify_to: 'admin',
      entity_id: sourceHubId,
      log: `Workspace '${sourceName}' merged in as folder '${folderName}' - ${merged} item(s) received`,
    });

    this.output.data({
      status: "MERGED",
      requested: nodes.length,
      merged,
      remaining: remaining.length,
      refused,
      folder: { nid: folderId, filename: folderName },
      source_hub_id: sourceHubId,
      recipient_id: recipientId,
      nodes: moved,
    });
  }

  /**
   * Duplicate a workspace: a NEW workspace named after the source, holding a
   * copy of its files and folders.
   *
   * THE SOURCE IS NEVER TOUCHED. That is what makes this operation a different
   * shape of risk from merge_workspace: nothing is relocated and nothing is
   * removed, so a failure at any point leaves at worst an extra workspace the
   * owner can delete - never damaged or half-moved data.
   *
   * FILES ONLY, and the caller is the new workspace's SOLE MEMBER. Chat, tasks,
   * meetings, share links, trash and version history are not copied; neither is
   * the member list. Copying members was considered and refused: it would let
   * somebody hand people access to a workspace without holding the admin right
   * every invite service asks for. Nothing identifying the source travels
   * either - no secure-share or DMZ token, no share box, no invite tracking, no
   * subscription rows, no services log, no notifications - and disk usage is
   * recomputed by the platform from what actually lands.
   *
   * ORDER IS THE SAFETY. Identity, area and storage are all settled BEFORE the
   * new workspace exists, so a refusal never leaves an empty workspace behind
   * on somebody's desk.
   *
   * The shell comes from the pre-built entity pool through the same createHub
   * the desk uses, so no database is ever created inside a request - which is
   * the whole reason that pool exists, DDL being unable to roll back.
   *
   * NOT hub_clone_content. That dormant procedure looks like it does this job
   * and cannot be used: it runs DELETE FROM media on the destination, it copies
   * media rows keeping the SOURCE's node ids, it leaves yp.entity.home_id
   * pointing at a root that no longer exists in the copy, and its closing
   * yp.hub_update_name writes the UNIQUE hubname and rebuilds the vhost fqdn
   * from a name containing spaces and brackets.
   */
  async copy_workspace() {
    const sourceHubId = this.hub.get(Attr.id);
    const sourceDb = this.hub.get(Attr.db_name);
    const userDb = this.user.get(Attr.db_name);
    const domain = this.user.get(Attr.domain);

    if (!sourceHubId || !sourceDb || !userDb || !domain) {
      this.warn("copy_workspace: incomplete context", {
        sourceHubId, sourceDb, userDb, domain,
      });
      return this.exception.user(INVALID_DATA);
    }

    // get_hub_owner, never get_hub - the latter rebuilds the fqdn as
    // ident + '.drumee.com' and silently answers the 'home' entity anywhere
    // else. An empty row means "not a workspace": the proc INNER JOINs yp.hub.
    const src = firstRow(await this.yp.await_proc("get_hub_owner", sourceHubId));
    if (isEmpty(src)) {
      this.warn("copy_workspace: WRONG_ENTITY_TYPE", { sourceHubId });
      return this.exception.user("WRONG_ENTITY_TYPE");
    }
    if (!WORKSPACE_AREAS.has(src.area)) {
      this.warn("copy_workspace: MERGE_AREA_NOT_ALLOWED", { area: src.area });
      return this.exception.user("MERGE_AREA_NOT_ALLOWED");
    }

    // mfs_node_attr answers the hub name as the ROOT node's `filename`; the
    // session object carries neither `name` nor `filename` for a workspace
    // reached through scope:hub here.
    const rootAttr = firstRow(
      await this.db.await_proc("mfs_node_attr", this.home_id)
    ) || {};
    const sourceName = rootAttr.filename || src.ident || sourceHubId;

    // The same list merge_workspace carries, and for the same reasons: the
    // __chat__ / __trash__ / __upload__ system folders are excluded because the
    // new workspace is given its own, hub cards because mfs_copy_all refuses
    // them anyway, and hidden or deleted rows because a duplicate should not
    // resurrect somebody's trash.
    const nodes = toArray(await this.db.await_proc("mfs_merge_source_nodes"));
    const srcList = nodes.map((n) => ({ nid: n.nid, hub_id: sourceHubId }));

    // Storage, BEFORE anything is created. Unlike a move, a copy always
    // consumes new bytes, so this applies within one owner too. Mirrors
    // chk_pre_transact's copy branch, Infinity escape hatches included.
    if (nodes.length) {
      const limit = firstRow(await this.yp.await_proc("disk_limit", sourceHubId)) || {};
      const { watermark, owner_id, available_disk } = limit;
      const { watermark: sys_watermark } = quota;
      if (watermark != Infinity && sys_watermark != Infinity && !Number(limit.unlimited)) {
        const sized = firstRow(await this.yp.await_proc(
          "get_transation_size", srcList, sourceHubId, "copy"
        )) || {};
        const size = Number(sized.size || 0);
        if (Number(available_disk) < size) {
          let error = Cache.message("your_limit_exceeded");
          if (this.uid != owner_id) {
            error = Cache.message("limit_exceeded");
          }
          this.warn("copy_workspace: not enough storage for the duplicate", {
            sourceHubId, available_disk, size,
          });
          return this.exception.user(error);
        }
      }
    }

    // First write of the handler. `-copy` follows the intent left behind in
    // desk.pre_copy, and createHub runs the name through unique_filename
    // against the caller's desk, so repeats become -copy(1) and so on. The
    // suffix also guarantees a non-empty hostname for a workspace whose name is
    // entirely punctuation, which would otherwise throw in createHub's URL().
    const home = firstRow(await this.yp.await_proc(`${userDb}.mfs_home`)) || {};
    const created = await createHub.call(this, {
      owner_id: this.uid,
      domain,
      area: src.area,
      filename: `${sourceName}-copy`,
      pid: home.home_id,
      user_db: userDb,
    }) || {};
    if (!created.hub_id || !created.hub_db) {
      this.warn("copy_workspace: the new workspace could not be created", {
        sourceHubId, created,
      });
      return this.exception.server("SERVER_FAULT");
    }

    // The destination root is resolved from the new database itself rather than
    // read out of desk_create_hub's answer. That answer is five result sets,
    // and which one carries the root depends on their order; asking the
    // database cannot be thrown off by that.
    const newHome = firstRow(
      await this.yp.await_proc(`${created.hub_db}.mfs_home`)
    ) || {};
    const destRoot = newHome.home_id;
    if (!destRoot) {
      this.warn("copy_workspace: the new workspace has no root node", {
        hub_id: created.hub_id, db: created.hub_db,
      });
      return this.exception.server("SERVER_FAULT");
    }

    let refused = 0;
    if (nodes.length) {
      // after_transact reads both of these; oldItems supplies the `src` half of
      // each changelog row, and one snapshot of the source root covers the lot.
      this.heap.recipient_id = created.hub_id;
      this.heap.oldItems = {};
      const rootSnapshot = firstRow(
        await this.db.await_proc("mfs_access_node", this.uid, this.home_id)
      );
      if (rootSnapshot) this.heap.oldItems[this.uid] = rootSnapshot;

      // mfs_copy_all is used UNMODIFIED. Its root insert filters
      // `category <> 'hub'`, which is exactly why media.copy on a workspace
      // created nothing - but the nodes handed to it here are the workspace's
      // CHILDREN, every one of them a file or a folder, so the filter has
      // nothing to reject. movePlanRows is not optional: the plan comes back
      // beside seo_update_hub's own result set, and a nested array matches no
      // case in after_transact's switch, so the bytes would never be copied.
      const plan = movePlanRows(
        await this.db.await_proc(
          "mfs_copy_all", srcList, this.user.uid(), destRoot, created.hub_id
        ),
        this
      );
      const items = [];
      for (const row of plan) {
        if (row && row.failed) {
          refused++;
          this.warn("copy_workspace: mfs_copy_all refused a node", row);
        } else {
          items.push(row);
        }
      }
      await this.after_transact(items);
    }

    // MEASURED in the new workspace, not inferred from the plan. mfs_copy_all
    // can decline a node without emitting a `failed` row, and a copy that
    // silently arrived empty is the exact failure this menu row had before.
    const landed = toArray(
      await this.yp.await_proc(`${created.hub_db}.mfs_merge_source_nodes`)
    );
    if (landed.length !== nodes.length) {
      this.warn("copy_workspace: the duplicate did not receive everything", {
        sourceHubId, hub_id: created.hub_id,
        requested: nodes.length, copied: landed.length, refused,
      });
    }

    // Written in the SOURCE, the only workspace that existed before this ran.
    // `changed` rather than `added`: action_log.action is an ENUM, and a value
    // outside it is stored as an empty string while writeAudit swallows the
    // warning, leaving no trace at all.
    await writeAudit(this, {
      db: sourceDb,
      uid: this.uid,
      action: 'changed',
      category: 'admin',
      notify_to: 'admin',
      entity_id: created.hub_id,
      log: `Workspace '${sourceName}' duplicated as '${created.filename}' - ${landed.length} item(s) copied`,
    });

    // `home_id` and `area` are here for the desk, not for decoration. The
    // workspace:refresh descriptor a listener REOPENS a workspace from carries
    // the ROOT node, never the hub id - libs/create-workspace says so in as
    // many words: "A hub's own nid is the hub/0 placeholder and would not open
    // anything." Without them the client cannot announce this workspace the
    // same way a create does, and it stays missing from the switcher until a
    // reload.
    this.output.data({
      status: "COPIED",
      hub_id: created.hub_id,
      home_id: destRoot,
      area: src.area,
      filename: created.filename,
      requested: nodes.length,
      copied: landed.length,
      refused,
      source_hub_id: sourceHubId,
    });
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

    const restoredThread = await this._directFileThreadSnapshot(restored.hub_id, nid);
    await this._transitionDirectFileThreadAccess(restoredThread, "active", "direct_restore");

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
      const restoredThread = await this._directFileThreadSnapshot(
        m.hub_id,
        m.nid || m.id,
        m.db_name || m.actual_db
      );
      await this._transitionDirectFileThreadAccess(restoredThread, "active", "direct_restore");
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
   * Tells any thread still waiting on a purged file that it will never come
   * back. Almost every purge matches nothing here, so a miss is the norm and
   * costs one indexed lookup.
   *
   * Only permanent deletion reaches this. Trash leaves the thread waiting,
   * because a trashed file can still be restored.
   *
   * mfs_delete_trash returns the node ids without a hub, so the workspace
   * comes from the request context — purge always runs against the caller's
   * current workspace.
   */
  async _orphanThreadsForPurged(purged) {
    const hubId = this.hub && this.hub.get(Attr.id);
    if (!hubId) return;
    for (const entry of toArray(purged)) {
      const nid = entry && (entry.id || entry.nid);
      if (!nid) continue;
      if (entry.category === FOLDER || entry.category === HUB) continue;
      try {
        await this._markFileThreadOrphaned(entry.hub_id || hubId, nid);
      } catch (error) {
        this.warn("Unable to orphan thread for purged file", { nid, error });
      }
    }
  }

  /**
   * To actually purge entire trash bin
   * @params null
   */
  // Downgrade over-limit: purge / empty_bin are the storage-RESOLVING
  // actions (trash still counts toward usage — only these decrement
  // yp.disk_usage), so each one re-measures the domain and clears/updates
  // the flags live. trash() calls it too: the numbers don't move there, but
  // the refreshed push keeps the owner's banner honest about that fact.
  // Best-effort — the operation itself is already committed.
  async _evaluateOverLimitAfterResolve() {
    try {
      const OverLimit = require('../lib/over-limit');
      if (!OverLimit.enabled()) return;
      const dom = ~~this.user.domain_id();
      if (dom <= 1) return;
      await OverLimit.evaluate(this.yp, dom, {
        notify: (state) => OverLimit.notifyDomain(this.yp, RedisStore, state),
      });
    } catch (e) {
      this.warn('[over-limit] post-resolve evaluation failed:', e.message);
    }
  }

  async empty_bin() {
    if (!this.user.get(Attr.settings).trash_expiry) {
      let list = await this.db.await_proc("mfs_empty_trash");
      await this._empty_bin(list)
      await this._evaluateOverLimitAfterResolve();
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
      await this._orphanThreadsForPurged(data);
    }
    await this._evaluateOverLimitAfterResolve();
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
    const directAccessTargets = [];
    const directAccessKeys = new Set();
    for (const g of granted) {
      try {
        const hub_db = await this.yp.await_func('get_db_name', g.hub_id);
        if (!hub_db) continue;
        const attr = await this.yp.await_proc(`${hub_db}.mfs_node_attr`, g.nid);
        if (!attr) continue;
        const directTarget = await this._directFileThreadSnapshot(g.hub_id, g.nid, hub_db);
        const directKey = directTarget && `${directTarget.hub_id}:${directTarget.file_nid}`;
        if (directTarget && !directAccessKeys.has(directKey)) {
          directAccessKeys.add(directKey);
          directAccessTargets.push(directTarget);
        }
        auditTargets.push({
          hub_db,
          nid: g.nid,
          filename: attr.user_filename || attr.filename || g.nid,
          filetype: attr.category || attr.filetype,
        });
      } catch (e) { /* best-effort */ }
    }
    const reservedTargets = [];
    for (const target of directAccessTargets) {
      const reservation = await this._reserveDirectFileThreadTrash(target);
      if (!reservation || reservation.failed || Number(reservation.reserved) !== 1) {
        await this._releaseDirectFileThreadTrashBatch(reservedTargets);
        this.exception.user((reservation && reservation.status) || "FILE_THREAD_TRASH_CONFLICT");
        return;
      }
      reservedTargets.push(target);
    }

    let data;
    try {
      data = await this.db.await_proc(
        "mfs_pre_trash_next",
        granted,
        this.uid,
        Permission.MODIFY
      );
    } catch (error) {
      await this._releaseDirectFileThreadTrashBatch(reservedTargets);
      throw error;
    }
    for (const target of directAccessTargets) {
      const transition = await this._transitionDirectFileThreadAccess(
        target, "unavailable", "direct_trash"
      );
      if (!transition || transition.failed || Number(transition.transitioned) !== 1) {
        await this._releaseDirectFileThreadTrash(target);
      }
    }
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

    await this._evaluateOverLimitAfterResolve();
    this.output.list(data);
  }

  /**
   * Show trsh content
   */
  show_bin() {
    // `let`, not `const`: the default below reassigns it. As a const this threw
    // "Assignment to constant variable" on every call that omitted `page` or
    // sent 0 — i.e. the default was unreachable, not merely unused.
    let page = this.input.get(Attr.page);
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

      // Announce the edit. Saving an editable file (note / markdown / text /
      // diagram — all of them post media.save) wrote NO changelog row at all, so
      // editing a shared document produced no notification for anyone (Duy
      // 2026-08-21, issue 1). It is the same fact as an upload-over-a-file, so it
      // reuses that event name: the client renders both as "<name> has been
      // updated".
      //
      // `notify: 0` keeps the in-app notification while leaving the activity
      // EMAIL alone: saves are frequent and nobody asked for mail here.
      //
      // The `/__chat__/` skip is done HERE rather than relying on
      // changelog_write's own guard, which tests `src.ownpth` — a field that
      // does not exist (mfs_access_node returns `ownpath`), so that guard has
      // never actually fired for any caller. Left alone on purpose: making it
      // work would change what every existing MFS event logs, which is a
      // behaviour change to a working path and not this fix's business. Reported
      // separately.
      //
      // Best-effort: a logging failure must never fail a save the user has
      // already been told succeeded.
      const chatScoped = /^\/__chat__\//.test(String(attr.ownpath || attr.file_path || ''));
      if (!chatScoped) {
        try {
          // Shallow copy: changelog_write deletes `metadata` off the object it
          // is handed, and `attr` is still read below.
          await this.changelog_write({ src: { ...attr }, event: 'media.replace', notify: 0 });
        } catch (e) {
          this.warn('[SAVE] changelog_write failed:', e && e.message);
        }
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

  /**
   * Extract an archive into the folder it sits in.
   *
   * Inspects here and extracts in offline/media/unzip.js. The split is not
   * incidental: reading an archive's table of contents is cheap and bounded
   * (it is the central directory, not the payload), so every refusal a user
   * could plausibly hit — wrong file type, password-protected, corrupt,
   * absurdly large, over quota — is decided inside the request, where it can
   * be answered with a reason. Only the expensive half runs detached.
   *
   * The ACL entry is `{src: read, dest: write}`: read on the archive, write on
   * the destination. That is also what puts unzip under the downgrade
   * over-limit clamp and the secure-share read-only ceiling, both of which key
   * off `dest > read` in router/rest — an unzip only ever ADDS bytes, so it
   * must be refused wherever an upload would be, and declaring `dest` is what
   * makes that automatic rather than something to remember here.
   */
  async unzip() {
    const socket_id = this.input.need(Attr.socket_id);
    const node = this.granted_node();
    if (isEmpty(node) || !node.id) {
      this.exception.forbiden();
      return;
    }

    // Two independent tests that have to agree. `category` is what the UI
    // gates its menu item on, and the extension list is what 7z was verified
    // to open on BOTH deployed versions. Between them they also keep Office
    // files out: docx/xlsx/odt are zip containers and 7z would happily explode
    // one into its parts, but they are `document` category, not `zip`.
    const ext = String(node.extension || "").toLowerCase();
    if (node.filetype !== ARCHIVE_CATEGORY || !ARCHIVE_EXTENSIONS.includes(ext)) {
      this.exception.user("NOT_AN_ARCHIVE");
      return;
    }

    const archivePath = join(node.home_dir, node.id, `orig.${ext}`);
    if (!existsSync(archivePath)) {
      this.exception.user("NODE_NOT_FOUND");
      return;
    }

    const info = await inspect(archivePath);
    if (!info.ok) {
      this.warn(`unzip refused ${node.id}: ${info.reason} ${info.detail || ""}`);
      this.exception.user(info.reason);
      return;
    }

    // Quota is measured against the UNCOMPRESSED total, which is the whole
    // point — a 40MB zip of a 6GB folder costs 6GB. chekcDiskLimit reads the
    // size off the input, the same field an upload sets, so free-vs-domain
    // plans and the unlimited entitlement are all handled in one place rather
    // than re-derived here. It raises its own user exception when it refuses.
    this.input.set(FILESIZE, info.totalBytes);
    if (!(await this.chekcDiskLimit())) return;

    // REQUIRED, never defaulted. The ACL's `dest: write` check runs against
    // acl._normalize_destination, which reads `heap.pid` — the raw request
    // field — and falls back to '0', the hub ROOT, when the client omits it.
    // Defaulting here to anything else (the archive's own parent, say) would
    // mean the folder we were authorised to write and the folder we actually
    // extract into are two different nodes, and per-folder privileges make
    // that a real gap rather than a theoretical one. Requiring it keeps the
    // node the ACL checked and the node we write to the same node.
    const pid = this.input.need(PID);
    const transactionid = this.randomString();
    const args = {
      nid: node.id,
      pid,
      recipient_id: this.heap.recipient_id || this.hub.get(Attr.id),
      uid: this.uid,
      socket_id,
      transactionid,
    };
    const cmd = resolve(server_location, "offline", "media", "unzip.js");
    const child = Spawn(cmd, [stringify(args)], SPAWN_OPT);
    child.unref();

    this.output.data({
      nid: node.id,
      transactionid,
      files: info.files,
      folders: info.folders,
      size: info.totalBytes,
    });
  }
}

module.exports = __private_media;
