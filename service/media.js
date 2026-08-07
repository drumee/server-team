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
  Attr, Events, Script, toArray, nullValue,
  RedisStore, Cache, sleep, Constants, sysEnv, getFileinfo
} = require("@drumee/server-essentials");
const indexQueue = require("../offline/queues/indexQueue");
const { writeAudit } = require("./private/_audit");
const { secureShareWriteVerdict, secureShareCapVerdict, secureShareCapPrivilege } = require("./lib/secure-share-write-guard");
const { DENIED } = Events;
const {
  BATCH_FILE,
  CARD,
  ID_NOBODY,
  DIRNAME,
  DOWNLOAD_FOLDER,
  FAILED_CREATE_FILE,
  FILESIZE,
  FOLDER,
  IMAGE,
  NODE_ID,
  ORIGINAL,
  PREVIEW,
  SLIDE,
  STREAM,
  STYLESHEET,
  THUMBNAIL,
  VIDEO,
  VIGNETTE,
  WEBP,
} = Constants;

const {
  Generator,
  Document,
  FileIo,
  Mfs,
  MfsTools,
} = require("@drumee/server-core");
const { remove_dir, mv } = MfsTools;
const { get_node_content } = require("@drumee/server-core/lib/utils/mfs");

const {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} = require("fs");

const {
  mkdir: mkdirAsync,
  rename: renameAsync,
  copyFile: copyFileAsync,
  unlink: unlinkAsync,
} = require("fs/promises");

/**
 * Non-blocking file move. The uploaded file lands in tmp_dir (root fs) while
 * the MFS storage tree lives on a separate data volume, so a plain rename
 * throws EXDEV and the shared MfsTools.mv() falls back to the SYNCHRONOUS
 * cpSync — which blocks the single-process Node event loop for the whole copy
 * of every uploaded file, freezing all other requests during a bulk upload.
 * Here rename is tried first (O(1) when same-device); the cross-device copy
 * runs on the libuv threadpool (copyFile), keeping the event loop responsive.
 */
async function moveFileAsync(src, dest) {
  try {
    await renameAsync(src, dest);
  } catch (e) {
    if (e && e.code === "EXDEV") {
      await copyFileAsync(src, dest);
      await unlinkAsync(src);
    } else {
      return false;
    }
  }
  return true;
}

const {
  isString,
  isObject,
  map,
  keys,
  isEmpty,
  isArray,
  isFunction,
} = require("lodash");

const {
  data_dir, tmp_dir, server_home, mfs_dir, quota
} = sysEnv();
const { stringify } = JSON;
const { join, resolve, dirname, basename } = require("path");
const Spawn = require("child_process").spawn;
const DATA_ROOT = new RegExp(`^${data_dir}`);
const SPAWN_OPT = { detached: true, stdio: ["ignore", "ignore", "ignore"] };
const OFFLINE_DIR = resolve(__dirname, "..", "offline", "media");

class __media extends Mfs {
  /**
   *
   */
  async sendNodeAttributes(args) {
    const { nid, recipients, service, extraData, myData } = args;
    let nodes = {};
    let payload;
    let echoId = this.input.get('echoId');
    for (let r of toArray(recipients)) {
      if (myData && r.uid == this.uid) {
        payload = this.payload({ ...myData, ...extraData }, { echoId, service });
      } else {
        let attr =
          nodes[r.uid] ||
          (await this.db.await_proc("mfs_access_node", r.uid, nid));
        nodes[r.uid] = attr;
        payload = this.payload({ ...attr, ...extraData }, { echoId, service });
      }
      if (payload.model && (/^\/__chat__\//.test(payload.model.ownpath))) continue;
      await RedisStore.sendData(payload, r);
    }
  }

  /**
 * Return manifest of the node
 */
  manifest() {
    let { id } = this.granted_node();
    this.db.call_proc("mfs_manifest", { nid: id, uid: this.uid, show_nodes: 1 }, this.output.list);
  }

  /**
   * Server-side enforcement of a secure-share recipient's WRITE capability.
   *
   * A DMZ secure-share guest session is cookie-bound to the share CREATOR (so
   * hub endpoints resolve), which means this.uid carries the creator's FULL
   * privilege and the normal write ACL always passes — even for a view-only
   * recipient. This re-derives the RECIPIENT's effective write capability from
   * the share token (base caps UNION approved access grants, mirroring
   * dmz.js::_loginSecureShare) and denies when can_edit is absent.
   *
   * Non-secure-share writes are never affected: with no token, or a legacy DMZ
   * token, the verdict is null and the caller proceeds with the normal ACL.
   *
   * Side-effect free — the caller rejects with the primitive appropriate to its
   * phase (pre_upload is an ACL checker → trigger(DENIED); make_dir is a service
   * method → exception.forbiden()).
   *
   * @returns {Promise<boolean>} true → may proceed; false → caller must reject
   */
  async _secureShareCapAllowed(requiredCaps) {
    const token = this.input.get(Attr.token);
    if (!token) return true;

    // Resolve the recipient email exactly as _loginSecureShare does: an
    // AUTHENTICATED viewer is keyed to their OWN account email (never a
    // client-supplied value); an ANONYMOUS viewer to the grant_email the UI
    // replays. The account email always wins so a signed-in session can't claim
    // another requester's approved grant.
    let email = "";
    try {
      const cookie = this.input.get(Attr.cookie) || {};
      const regsid = cookie.regsid;
      if (regsid) {
        const guest_id = Cache.getSysConf("guest_id");
        const u = await this.yp.await_proc("cookie_retrieve_user", regsid);
        if (u && u.id && ![ID_NOBODY, guest_id].includes(u.id) && u.profile) {
          const p = typeof u.profile === "string" ? JSON.parse(u.profile) : u.profile;
          email = ((p && p.email) || "").toLowerCase().trim();
        }
      }
    } catch (e) {
      // fall through to the anonymous path
    }
    if (!email) {
      email = (this.input.get("grant_email") || "").toLowerCase().trim();
    }

    const verdict = await secureShareCapVerdict(this.yp, token, email, requiredCaps);
    if (verdict === false) {
      this.warn(`[secure-share] denied: recipient lacks ${[].concat(requiredCaps).join(" / ")}`);
      return false;
    }
    return true;
  }

  /**
   * Write (upload / mkdir) requires can_edit. Backward-compatible wrapper kept so
   * the existing pre_upload / make_dir callers stay byte-identical.
   *
   * FILE shares are additionally denied here: a single-file share exposes only the
   * shared file, so the recipient may EDIT that file (media.save / the euroffice
   * editor — separate paths, NOT gated by this method), but must never create a new
   * node (make_dir) or upload into the file's PARENT folder. The DMZ view lists that
   * parent (see _secureShareListTarget), so make_dir/upload target it; a recipient
   * with any standing on the workspace (a prior folder/root-share grant, a member, or
   * the creator) would otherwise write straight into the creator's folder even though
   * only a file was shared (Lexis file-share report). Folder shares are unaffected
   * (file_nid is null → allowed, no regression), and token-less / legacy / non-secure
   * writes are unaffected (_secureShareListTarget returns null → allowed).
   */
  async _secureShareWriteAllowed() {
    if (!(await this._secureShareCapAllowed(["can_edit"]))) return false;
    const listTarget = await this._secureShareListTarget();
    if (listTarget && listTarget.file_nid) return false;
    return true;
  }

  /**
   * For a folder LISTING served while still creator-bound (an anonymous secure-share
   * viewer), resolve the privilege bitmask the per-node `privilege` must be clamped
   * to, so nested folders display at the share's level instead of the creator's full
   * privilege. Returns null when NOT a secure-share request (no token / legacy) → the
   * caller must leave the listing untouched. Logged-in recipients are rebound to their
   * own capped uid, so their listing privilege is already capped → this is a no-op for
   * them. DISPLAY cap only. Recipient email resolved exactly as the write guard does.
   */
  async _secureShareCapPrivilege() {
    const token = this.input.get(Attr.token);
    if (!token) return null;
    let email = "";
    try {
      const cookie = this.input.get(Attr.cookie) || {};
      const regsid = cookie.regsid;
      if (regsid) {
        const guest_id = Cache.getSysConf("guest_id");
        const u = await this.yp.await_proc("cookie_retrieve_user", regsid);
        if (u && u.id && ![ID_NOBODY, guest_id].includes(u.id) && u.profile) {
          const p = typeof u.profile === "string" ? JSON.parse(u.profile) : u.profile;
          email = ((p && p.email) || "").toLowerCase().trim();
        }
      }
    } catch (e) {
      // fall through to the anonymous path
    }
    if (!email) {
      email = (this.input.get("grant_email") || "").toLowerCase().trim();
    }
    return secureShareCapPrivilege(this.yp, token, email);
  }

  /**
   * Resolve the token-authorized LISTING target for a secure-share DMZ request.
   * A logged-in recipient is node-granted only on the SHARED node; for a FILE share
   * that grant does NOT confer access to the file's PARENT — which is the folder
   * media.show_node_by lists. This returns, derived from the TOKEN (authoritative,
   * never client-supplied):
   *   { nid: <folder to list>, file_nid: <shared file to hard-filter to | null> }
   * so the listing can (a) target the shared file's parent even when the caller's own
   * source resolution missed it, and (b) hard-filter to the shared file so NO sibling
   * is ever returned. Returns null when NOT a valid secure-share request (no token /
   * legacy / invalid / revoked / expired) → the caller leaves the listing untouched
   * (byte-identical for every normal, token-less listing).
   */
  async _secureShareListTarget() {
    const token = this.input.get(Attr.token);
    if (!token) return null;
    let info;
    try {
      info = toArray(await this.yp.await_proc('secure_share_info', token))[0];
    } catch (e) {
      return null; // cannot classify → leave listing untouched
    }
    if (!info || info.failed || !info.creator_id) return null;
    if (info.validity && info.validity !== 'TICKET_OK') return null;
    let listNid = info.node_id;
    let file_nid = null;
    try {
      const attr = toArray(
        await this.yp.await_proc('forward_proc', info.hub_id, 'mfs_node_attr', `'${info.node_id}'`)
      )[0] || {};
      // A real FILE (not folder / hub / workspace-root) → list its PARENT, hard-filtered
      // to the file itself. Mirrors the node-type remap in dmz.js::_loginSecureShare.
      if (attr.filetype && attr.filetype !== 'folder' && attr.filetype !== 'hub' && attr.filetype !== 'root' && attr.pid) {
        file_nid = info.node_id;
        listNid = attr.pid;
      }
    } catch (e) {
      // Node-type probe failed → treat as a container (list node_id, no file filter).
    }
    return { nid: listNid, file_nid };
  }

  /**
   *
   * @returns
   */
  async make_dir() {
    if (!(await this._secureShareWriteAllowed())) return this.exception.forbiden();
    const parent = this.source_granted();
    const pid = parent.id || this.home_id;
    let ownpath = decodeURI(this.input.get(Attr.ownpath));
    const metadata = this.input.get(Attr.metadata);
    let node;
    //let exclude = this.input.need(Attr.socket_id);
    //if (exclude) exclude = [exclude];
    let uid = this.uid;
    if (nullValue(ownpath)) {
      let filename = this.input.need(DIRNAME);
      filename = filename.replace(/\//g, "-");
      filename = decodeURI(filename);
      let args = {
        owner_id: uid,
        filename,
        pid,
        category: Attr.folder,
        ext: "",
        mimetype: Attr.folder,
        filesize: 0,
        showResults: 1
      };
      node = await this.ensureCreateNode(args, {});
    } else {
      let path = ownpath.split(/\/+/).filter(function (e) {
        return e.length
      });
      let dir = await this.ensureMakeDir(this.home_id, path, 1);
      if (isEmpty(dir) || !dir.nid) {
        this.exception.user("FAILED_CREATE_FOLDER");
        return;
      }
      node = await this.db.await_proc("mfs_access_node", uid, dir.id);
    }

    // Update metadata if provided
    if (metadata && node && node.nid) {
      await this.db.await_proc("mfs_update_metadata", node.nid, JSON.stringify(metadata));
      // Refresh node data after metadata update
      node = await this.db.await_proc("mfs_access_node", uid, node.nid);
    }
    await this.changelog_write({ src: node, event: "media.new" });

    if (/^(.|.+\/.+| )$/.test(dirname)) {
      this.exception.user("INVALID_FILENAME");
      return;
    }
    let recipients = await this.yp.await_proc("entity_sockets", {
      hub_id: parent.hub_id,
      //exclude,
    });
    recipients = toArray(recipients);
    await this.sendNodeAttributes({
      nid: node.nid,
      recipients,
      service: "media.new",
      myData: node,
      //exclude
    });
    this.output.add_data({
      args: {
        changelog: this.__changelog
      }
    })

    if (uid && parent.hub_id && node && node.nid) {
      const hub_db = await this.yp.await_func('get_db_name', parent.hub_id);
      if (hub_db) {
        const fname = (node.filename || node.user_filename || node.nid);
        await writeAudit(this, {
          db: hub_db,
          uid,
          action: 'added',
          category: 'media',
          entity_id: node.nid,
          log: `Folder '${fname}' created`,
        });
      }
    }

    this.output.data(node);
  }


  /**
   * ownpath refers to the absolute path within the hub, nid must be set to hone_id
   * @returns
   */
  async _ensureParentExists() {
    let node = this.granted_node();
    // let replace =
    //   this.input.get(Attr.replace) || this.input.get(Attr.createOrReplace);
    /** Standard upload, using nid as destination */
    let ownpath = this.input.get(Attr.ownpath);
    this.heap.upload = node;

    if (nullValue(ownpath)) {
      if (this.isBranche(node)) {
        this.input.set({ replace: 0 })
        // this._mustReplace = false;
      }
      // else {
      //   if (replace) {
      //     this._mustReplace = true;
      //   } else {
      //     this._mustReplace = false;
      //   }
      // }
      this._done();
      return;
    }
    ownpath = decodeURI(ownpath);
    let { actual_home_id, id } = node;
    if (actual_home_id != this.home_id) {
      this.warn(`Using ownpath implies having same home_id: `,
        `Expected home_id=${this.home_id}, got ${actual_home_id}`,
        "Will bypass"
      )
      return this.exception.server("OWNPATH_INCONSISTENT");
    }

    let filename = basename(ownpath);

    /** Check existing item or its parent */
    id = await this.db.await_func("node_id_from_path", ownpath);
    if (id) {
      let item = await this.db.await_proc('mfs_access_node', this.uid, id);
      if (item && item.nid) {
        if (this.isBranche(item)) {
          if (this.shouldReplace()) {
            return this.exception.server("CANNOT_REPLACE_FOLDER");
          } else {
            this.heap.upload = item;
            this.granted_node(item);
          }
        } else {
          if (this.shouldReplace()) {
            this.heap.upload = item;
            this.granted_node(item);
          } else {
            /** Ensure permission leak ? */
            let parent = await this.db.await_proc('mfs_access_node', this.uid, item.parent_id);
            this.heap.upload = parent;
            this.granted_node(parent);
          }
        }
        return this._done();
      }
    }

    /** No parent found. Create one with recursivity */
    let dest_dir = dirname(ownpath);
    /** The item doesn't exist, force replace to 0 */
    this.input.set({ replace: 0, createOrReplace: 0 })

    let dir = dest_dir.split(/\/+/).filter(function (e) {
      return e.length
    });

    if (!dir.length) {
      this._done();
      return;
    }

    let parent = await this.ensureMakeDir(actual_home_id, dir, 1);
    if (!parent || !parent.nid) {
      return this.exception.server("FAILED_CREATE_FOLDER");
    }
    parent.filepath = join(parent.file_path, filename);
    parent.file_path = parent.filepath;
    this.heap.upload = parent;
    this.granted_node(parent);
    this._done();
  }

  /**
   *
   */
  shouldReplace() {

    let replace = this.input.use(Attr.replace) || this.input.use(Attr.createOrReplace);
    if (replace != null) {
      if (replace == 0) return 0
      return 1
    }
    return 0
  }

  /**
   *
   * @returns
   */
  async pre_upload() {
    let json_str;

    if (!(await this._secureShareWriteAllowed())) {
      this.warn("Secure-share upload denied: recipient lacks can_edit");
      this.trigger(DENIED);
      return;
    }
    if (this.session.isAnonymous()) {
      const token = this.input.use(Attr.token);
      if (isEmpty(token) && isEmpty(this.input.sid())) {
        this.warn("Trying to upload in without token");
        this.trigger(DENIED);
        return;
      }
    }
    let nid = this.input.use(Attr.nid);
    switch (nid) {
      case "-1":
      case "-2":
      case "-3":
      case -1:
      case -2:
      case -3:
        this._done();
        break;

      case -100:
      case "-100":
        const p = this.input.use(Attr.path);
        this.heap.tmp = p;
        json_str = stringify(
          map(p, function (e) {
            return decodeURI(e);
          })
        );
        let d = await this.ensureMakeDir(this.home_id, json_str, 1);
        this.output.data(d);
        break;

      default:
        await this._ensureParentExists();
    }
  }

  /** configure_icon
   * @param {any} nid
   * @param {any} incoming_file - the actual file prepared by core/io
   * @param {string} filename - the actual file prepared by core/io
   */
  async configure_icon(nid, incoming_file, filename) {
    const c = await getFileinfo(incoming_file, filename);
    const ext = c.extension;

    const filepath = join(this.user.get(Attr.home_dir), "__config__", "icons");
    mkdirSync(filepath, { recursive: true });
    if (!existsSync(filepath)) {
      this.warn(`ERROR : ${filepath} not found`);
      this.exception.user(FAILED_CREATE_FILE);
    }

    const orig = `${filepath}/tmp.${ext}`;
    mv(incoming_file, orig)
    Generator.create_avatar(nid, ext, this.user.get(Attr.home_dir), orig);
    this.yp.call_proc("entity_touch", this.user.get(Attr.id), this.output.data);
  }

  /**
   * @param {any} nid - special operation when < 0
   * @param {any}
   * Uploaded files are received by core/io
   * which store the content into io.input->file_path
   */
  async upload() {
    let nid = this.input.use(Attr.nid);
    const incoming_file = this.input.need(Attr.uploaded_file); // internally set by io
    let filename = decodeURI(this.input.need(Attr.filename));
    switch (nid) {
      case -1:
      case -2:
      case -3:
      case "-1":
      case "-2":
      case "-3":
        await this.configure_icon(nid, incoming_file, filename);
        break;

      default:
        let node = this.granted_node();
        if (this.shouldReplace() && isFunction(this.replace)) {
          this.replace(node.id, incoming_file, filename);
        } else {
          if (nid == "0") {
            nid = this.home_id;
          }
          if (this.heap.upload.nid) {
            // set by pre_upload
            nid = this.heap.upload.nid;
          }
          await this.store(nid, incoming_file, filename);
        }
    }
  }

  /**
   * @param {any} nid - node id when reaching MFS area, special operation when < 0
   * @param {any}
   * Uploaded files are received by core/io
   * which store the content into io.input->file_path
   */
  async upload_base64() {
    const image = this.input
      .need(Attr.image)
      .replace(/^data:image\/\w+;base64,/, "");
    const parent = this.source_granted();
    const filename = this.randomString() + "-" + this.input.need(Attr.filename);
    let filepath = resolve(tmp_dir, `${filename}`);
    writeFileSync(filepath, image, { encoding: "base64" });
    await this.store(parent.id, filepath, this.input.need(Attr.filename));
  }

  /**
   *
   */
  async chekcDiskLimit() {
    let { watermark, sys_watermark } = quota;
    if (watermark == Infinity || sys_watermark == Infinity) {
      return true;
    }

    // Get quota info
    let quotaResult = await this.yp.await_proc("get_quota", this.uid);

    // Handle different result formats from driver
    let quotaInfo = quotaResult;
    if (quotaResult && quotaResult.length > 0) {
      quotaInfo = quotaResult[0];
    }

    // Parse if string
    if (typeof quotaInfo === 'string') {
      try {
        quotaInfo = JSON.parse(quotaInfo);
      } catch (e) {
        this.warn('[QUOTA] Failed to parse quota JSON:', e.message);
        return true; // Fail open - don't block upload on parse error
      }
    }

    let { storage, domain_id, unlimited } = quotaInfo || {};

    // UNLIMITED ENTITLEMENT — the claim-reward prize (5 years, source='reward'
    // in yp.quota). $.unlimited is the explicit signal, surfaced by the
    // get_quota PROCEDURE as this column.
    //
    // Checked BEFORE `storage`, and not left to the sentinel test below, which
    // is a strict STRING compare: the driver hands numeric columns back as
    // Numbers on some paths, and `9223372036854775807 === '9223372036854775807'`
    // is false. A rewarded user would then be measured against a limit of
    // 9.2 EB, which happens to pass — until anything downstream does arithmetic
    // on it. Reading the flag says what we mean.
    if (unlimited === true || unlimited === 1 || unlimited === '1') {
      this.debug('[QUOTA] unlimited entitlement — upload allowed');
      return true;
    }

    // No storage limit or infinite. The sentinel stays as a floor: a reward row
    // always carries $.disk at BIGINT max too, so a half-deployed rollout (SQL
    // patched, this file not yet) still enforces "unlimited" correctly.
    if (!storage || storage == Infinity || storage === '9223372036854775807') {
      return true;
    }

    let curr_filesize = this.input.use(FILESIZE, 0);
    let disk_used = 0;

    // Different logic for free vs paid plans
    if (!domain_id || domain_id === 1) {
      // FREE PLAN: Individual user quota
      // Each free user has separate quota
      // Will not sum all free users - they all share domain_id=1
      let usageResult = await this.yp.await_proc("disk_usage", this.uid) || {};

      // Handle different result formats
      if (usageResult.usage) {
        // Format 1: { usage: { total: 123 } }
        let usage = usageResult.usage;
        if (typeof usage === 'string') {
          usage = JSON.parse(usage);
        }
        disk_used = parseInt(usage.total || 0);
      } else if (usageResult[0] && usageResult[0].usage) {
        // Format 2: [{ usage: "JSON" }]
        let usage = usageResult[0].usage;
        if (typeof usage === 'string') {
          usage = JSON.parse(usage);
        }
        disk_used = parseInt(usage.total || 0);
      } else {
        disk_used = 0;
      }

      this.debug(`[QUOTA] Free plan check: user=${this.uid}, used=${disk_used}/${storage}`);

    } else {
      // PAID PLAN: Domain shared quota
      // All users in organization share quota
      // Cache is auto-synced by database trigger
      let usageResult = await this.yp.await_proc("get_domain_usage", domain_id) || {};

      // Handle different result formats
      if (usageResult.usage) {
        let usage = usageResult.usage;
        if (typeof usage === 'string') {
          usage = JSON.parse(usage);
        }

        // Check for error (shouldn't happen for domain_id > 1)
        if (usage.error) {
          this.warn('[QUOTA] Domain usage error:', usage.error);
          // Fallback to individual check
          let fallback = await this.yp.await_proc("disk_usage", this.uid) || {};
          if (fallback.usage) {
            let fb = typeof fallback.usage === 'string' ? JSON.parse(fallback.usage) : fallback.usage;
            disk_used = parseInt(fb.total || 0);
          }
        } else {
          disk_used = parseInt(usage.total || 0);
        }
      } else if (usageResult[0] && usageResult[0].usage) {
        let usage = usageResult[0].usage;
        if (typeof usage === 'string') {
          usage = JSON.parse(usage);
        }
        disk_used = parseInt(usage.total || 0);
      } else {
        disk_used = 0;
      }

      this.debug(`[QUOTA] Paid plan check: domain=${domain_id}, used=${disk_used}/${storage}`);
    }

    // Check if upload would exceed limit
    if (disk_used + curr_filesize > storage) {
      this.warn(`[QUOTA] Limit exceeded: used=${disk_used}, new=${curr_filesize}, limit=${storage}`);

      let error;
      if (!domain_id || domain_id === 1) {
        // Free plan: your personal limit
        error = Cache.message("your_limit_exceeded");
      } else {
        // Paid plan: organization limit
        error = Cache.message("limit_exceeded");
      }

      this.exception.user(error);
      return false;
    }

    this.debug(`[QUOTA] Check passed: used=${disk_used}, new=${curr_filesize}, remaining=${storage - disk_used - curr_filesize}`);
    return true;
  }

  /**
   * Preapre data for storage
   * @param {*} incoming_file 
   * @param {*} filename 
   * @param {*} parent 
   * @returns 
   */
  async before_store(incoming_file, filename, parent) {
    if (!existsSync(incoming_file)) {
      this.exception.user(FAILED_CREATE_FILE);
      return;
    }

    if (!(await this.chekcDiskLimit())) return;

    const c = await getFileinfo(incoming_file, filename);
    let { ext } = Cache.getFilecap(c.ext)
    if (!ext) {
      /** Update filecap table to ensure proper execution */
      await this.yp.await_proc('add_filecap', c);
    }
    const data = {};
    data.filename = c.filename;
    data.parent_id = parent.nid;
    data.category = c.category;
    data.extension = c.extension;
    data.mimetype = c.mimetype;
    data.geometry = "0x0";
    data.filesize = this.input.use(FILESIZE, 0);

    const filetype = this.input.get(Attr.filetype);
    if (filetype) data.category = filetype;
    if (/^json$/i.test(c.extension)) {
      try {
        const { readFileSync } = require("jsonfile");
        let json = readFileSync(incoming_file) || {};
        if (/GraphLinksModel/i.test(json.class)) {
          data.metadata = {
            dataType: "diagram.state",
          };
        }
      } catch (e) {
        this.warn("ERR:397", e);
      }
    }
    return data;
  }

  /**
   * 
   */
  async notifyNewNode(node) {
    const { nid, hub_id } = node;
    let exclude = [this.input.get(Attr.socket_id)];
    let recipients = await this.yp.await_proc("entity_sockets", {
      hub_id,
      exclude,
    });
    await this.sendNodeAttributes({
      nid,
      recipients,
      service: "media.new",
      myData: node
    });
  };



  /**
   * In case of massive write, DB dead lock may appear
   * Retry until dead lock left or too much rety 
   * 
   * @param {string} id - Hub/node ID
   * @param {Array<string>} path - Path segments
   * @param {boolean} showResult - Whether to return result
   * @returns {Object} Node object
   * @throws {Error} If operation fails after retries
   */
  async ensureMakeDir(id, path, showResult) {
    // Configuration constants
    const MAX_RETRIES = 5;
    const MAX_DURATION_MS = 5000;
    const MIN_BACKOFF_MS = 100;
    const MAX_BACKOFF_MS = 2000;

    const START_TIME = Date.now();

    let ownpath = join('/', ...path);
    let exists = await this.db.await_func("node_id_from_path", ownpath);
    let node = await this.db.await_proc("mfs_make_dir", id, path, showResult);

    let i = 0;
    let failed = null;
    let error = null;
    const Moment = require("moment");

    while (node[1] && i < MAX_RETRIES) {
      // Timeout protection
      const elapsed = Date.now() - START_TIME;
      if (elapsed > MAX_DURATION_MS) {
        this.error('ensureMakeDir: Operation timeout exceeded', {
          elapsed_ms: elapsed,
          max_duration_ms: MAX_DURATION_MS,
          retries: i,
          path: ownpath,
          sqlstate: node[1]?.sqlstate
        });

        throw this.exception.server({
          message: 'MKDIR_OPERATION_TIMEOUT',
          elapsed_ms: elapsed,
          retries: i,
          path: ownpath,
          sqlstate: node[1]?.sqlstate
        });
      }

      // Save error info
      error = node[1];
      failed = null;

      // Handle specific SQL errors
      switch (node[1].sqlstate) {
        case '40001':  // DEADLOCK
          {
            failed = 'DEADLOCK_DETECTED';

            // Exponential backoff: 100ms, 200ms, 400ms, 800ms, 1600ms
            const backoffDelay = Math.min(
              MIN_BACKOFF_MS * Math.pow(2, i),
              MAX_BACKOFF_MS
            );

            this.debug(`ensureMakeDir: Deadlock detected, retrying`, {
              attempt: i + 1,
              max_retries: MAX_RETRIES,
              delay_ms: backoffDelay,
              path: ownpath,
              elapsed_ms: Date.now() - START_TIME
            });

            await sleep(backoffDelay);
            node = await this.db.await_proc("mfs_make_dir", id, path, showResult);
          }
          break;

        case '23000':  // DUPLICATE_ENTRY
          {
            failed = 'DUPLICATE_ENTRY';

            this.debug(`ensureMakeDir: Duplicate entry, retrying with timestamp`, {
              attempt: i + 1,
              max_retries: MAX_RETRIES,
              path: ownpath
            });

            await sleep(1000);

            // Create timestamped path
            let t = Moment(Date.now() / 1000, "X").format("YYYY-MM-DD@HH-mm-ss");
            let timestampedPath = [...path];

            if (timestampedPath.length > 0) {
              let lastSegment = timestampedPath[timestampedPath.length - 1];
              timestampedPath[timestampedPath.length - 1] = `${lastSegment}-${t}`;
            }

            node = await this.db.await_proc("mfs_make_dir", id, timestampedPath, showResult);
          }
          break;

        default:  // UNKNOWN ERROR
          {
            failed = `UNEXPECTED_SQL_ERROR_${node[1].sqlstate}`;

            this.error(`ensureMakeDir: Unexpected SQL error`, {
              sqlstate: node[1].sqlstate,
              errno: node[1].errno,
              sqlMessage: node[1].sqlMessage,
              path: ownpath,
              attempt: i + 1
            });

            // Break immediately
            break;
          }
      }

      i++;

      // Break out early for unknown errors
      if (failed && failed.startsWith('UNEXPECTED_SQL_ERROR')) {
        break;
      }
    }

    // Check if operation ultimately failed
    if (node[1] || failed) {
      const elapsed = Date.now() - START_TIME;

      this.error(`ensureMakeDir: Operation failed after retries`, {
        failed_reason: failed,
        retries: i,
        elapsed_ms: elapsed,
        path: ownpath,
        sqlstate: error?.sqlstate,
        errno: error?.errno,
        sqlMessage: error?.sqlMessage
      });

      // Throw error to propagate failure to caller
      throw this.exception.server({
        message: failed || 'MKDIR_FAILED',
        retries: i,
        elapsed_ms: elapsed,
        path: ownpath,
        sqlstate: error?.sqlstate,
        errno: error?.errno,
        originalError: error
      });
    }

    // Success case
    this.debug(`ensureMakeDir: Success`, {
      path: ownpath,
      nid: node.nid,
      existed: !!exists,
      retries: i,
      elapsed_ms: Date.now() - START_TIME
    });

    // Notify if new node was created
    if (!exists && node.nid) {
      await this.notifyNewNode(node);
    }

    return node;
  }

  /**
   * In case of massive write, DB dead lock may appear
   * Retry until dead lock left or too much rety 
   */
  async ensureCreateNode(args, metadata, results = { isOutput: 1 }) {
    let node = await this.db.await_proc("mfs_create_node", args, metadata, results);
    let i = 0;
    let failed;
    let error;
    const Moment = require("moment");
    while (node[1] && i < 30) {
      failed = '';
      error = node[1]
      switch (node[1].sqlstate) {
        case '40001':
          failed = 'DEAD_LOCK_WAIT_TOOL_LONG';
          await sleep(500);
          node = await this.db.await_proc("mfs_create_node", args, metadata, results);
          break;
        case '23000':
          failed = 'DUPLICATE_ENTRY';
          if (node[0].ownpath)
            await sleep(1000);
          let t = Moment(Moment.now() / 1000, "X").format("YYYY-MM-DD@hh:mm:ss");
          args.filename = `${args.filename}-${t}`
          node = await this.db.await_proc("mfs_create_node", args, metadata, results);
          break;
        default:
          failed = `UNEXPECTED_ERROR ${node[1].sqlstate}`;
      }
      i++;
    }
    if (failed) {
      this.warn(`${failed}: mfs_create_node waited ${i} times`, error)
    }
    return node;
  }

  /**
   *
   * @param {*} pid
   * @param {*} incoming_file
   * @param {*} filename
   * @param {*} callback
   * @returns
   */
  async store(pid, incoming_file, filename, callback) {
    let error;
    if (!pid) {
      error = `REQUIRE_PARENT_ID`;
      this.exception.server(error);
      return { error };
    }
    let uid = this.uid;
    let folder = this.granted_node();
    if (isEmpty(folder) || !folder.id) {
      error = `PERMISSION_DENIED`;
      this.exception.server(error);
      return { error };
    }

    let parent_of = await this.db.await_func("is_parent_of", folder.nid, pid);
    if (!parent_of && folder.nid != pid) {
      error = `WRONG_FILEPATH`;
      this.exception.server(error);
      return { error };
    }
    const data = await this.before_store(incoming_file, filename, folder);
    if (!data) {
      return { error: "failed_to_store" };
    }
    filename = data.filename || this.randomString();
    if (filename.length > 126) {
      filename = filename.slice(0, 126);
    }

    let args = {
      owner_id: uid,
      filename,
      pid,
      category: data.category,
      ext: data.extension,
      mimetype: data.mimetype,
      filesize: data.filesize,
      showResults: 1
    }
    let md = this.input.get(Attr.metadata);
    let metadata = {};
    if (md) {
      if (isString(md)) {
        metadata = JSON.parse(md);
      } else if (isObject(md)) {
        metadata = md;
      }
    }
    let md5Hash = this.input.get("md5Hash");
    metadata.md5Hash = md5Hash;
    let node = this.ensureCreateNode(args, metadata);
    node = await this.normalizeNode(node);

    if (!node || !node.id) {
      this.exception.server(`Failed to save file ${filename}`);
      return { error: "failed_to_store" };
    }
    let res = await this.after_store(pid, incoming_file, node);
    if (res.error || res.done) {
      return res;
    }

    let service = "";
    if (this.shouldReplace()) {
      service = "media.replace";
    } else {
      service = "media.new";
    }

    await this.changelog_write({ src: res, event: service })

    // The Uploads column on the analytics Referral users board counts exactly
    // the media.new rows written above, and an upload can also complete the
    // Onboarding -> Activated bar. Reported AFTER the changelog write so the
    // dashboard re-reads a count that already includes this file. Coalesced
    // per user inside the helper — store() runs once per FILE, so a bundle
    // would otherwise announce itself a hundred times. Never awaited: an
    // analytics message must not sit in the upload's critical path.
    // media.replace is not an upload the board counts, so it is not reported.
    if (service === "media.new") {
      require('./private/_referral_live').pushReferralLive(this, this.uid);
    }

    let hub_id = this.hub.get(Attr.id);
    let recipients = await this.yp.await_proc("entity_sockets", {
      hub_id,
    });

    await this.sendNodeAttributes({
      nid: res.nid,
      recipients,
      service,
      myData: res
    });

    /** SEO Indexing via Bull Queue */
    // if ([Attr.document, Attr.image].includes(data[CATEGORY])) {
    if ([Attr.document].includes(data.category)) {
      try {
        // Add to indexing queue
        res.actual_db = this.db._dbname;/** Require by the indexer. Do not use db_name, due to filter */
        res.hub_db = this.db._dbname;
        res.xdb = this.db._dbname;
        indexQueue.addFile(res, {
          uid: this.uid,
          socket_id: this.input.get(Attr.socket_id),
          hub_id: this.hub.get(Attr.id)
        });

        this.debug(`[MEDIA] Queued for indexing: ${res.filename}`);
      } catch (error) {
        // Don't fail upload if indexing queue fails
        this.warn(`[MEDIA] Failed to queue for indexing: ${error.message}`);
      }
    }

    if (isFunction(callback)) {
      return callback(node);
    }
    this.output.add_data({
      args: {
        changelog: this.__changelog
      }
    })
    this.output.data(node);
  }

  /**
   *
   */
  async handleForm(incoming_file, data) {
    let error;
    if (this.shouldReplace()) {
      error = "UNSUPPORTED_REPLACE";
      this.exception.user(error);
      return { error };
    }
    let form = readFileSync(incoming_file) || {};
    let definition = form.schema;
    let keys = form.keys;
    if (form.type != Attr.form || !definition) return;
    let name = `form_${data.id}`;
    let k, def, key;
    let sql = `CREATE TABLE IF NOT EXISTS ${name} (`;
    if (!keys) {
      definition.sys_id = "int(11) unsigned NOT NULL AUTO_INCREMENT";
      keys = {
        primary: "sys_id",
      };
    }

    if (!keys.primary) keys.primary = "sys_id";

    for (k in definition) {
      def = definition[k];
      sql = `${sql} ${k} ${def},`;
    }
    sql = `${sql} primary key (\`${keys.primary}\`),`;
    if (isArray(keys.unique)) {
      for (k in keys.unique) {
        let key = keys.unique[k];
        if (!definition[key]) continue;
        sql = `${sql} unique key (\`${key}\`),`;
      }
    }
    if (isArray(keys.index)) {
      for (k in keys.index) {
        let key = keys.index[k];
        if (!definition[key]) continue;
        sql = `${sql} unique key (\`${key}\`),`;
      }
    }
    sql = sql.replace(/,$/, ")");
    let r = await this.db.await_run(sql);
    if (r.errno) {
      this.exception.user(r.text);
      return { error: "FAILED_TO_CREATE_TABLE", message: r.text };
    }
    let writeHtml = require("@drumee/server-core/template");

    let html_file = writeHtml({ ...data, ...form });
    let filesize = 0;
    if (existsSync(master)) {
      filesize = statSync(html_file).size;
    }
    let filename = data.filename.replace(/\.form+$/, ".html");
    let args = {
      owner_id: this.uid,
      filename,
      pid,
      category: 'web',
      ext: 'html',
      mimetype: 'text/html',
      filesize,
      showResults: 1
    }
    let lines = readFileSync(html_file);
    let { createHash } = require("crypto");

    let md5Hash = createHash("md5");
    md5Hash.update(Buffer.from(lines));
    let metadata = { md5Hash };

    let node = this.ensureCreateNode(args, metadata);
    await this.sendNodeAttributes({
      nid: node.nid,
      recipients,
      service,
      myData: node
    });

    return { ...node, done: 1 };
  }

  /**
   *
   * @param {*} node
   */
  _convertToPdf(node) {
    let socket_id = this.input.get(Attr.socket_id);
    let args = {
      node,
      uid: this.uid,
      socket_id,
    };

    let cmd = resolve(OFFLINE_DIR, "to-pdf.js");
    let child = Spawn(cmd, [JSON.stringify(args)], SPAWN_OPT);
    child.unref();
  }

  /**
   *
   */
  toPdf() {
    this._convertToPdf(this.granted_node());
    this.output.data({ buildState: "wait" });
  }

  /**
   *
   * @param {*} data
   */
  async handlePdf(incoming_file, data) {
    const { writeFileSync } = require("jsonfile");
    //let exclude = [this.input.get(Attr.socket_id)];
    const raw_data = { ...data };
    data.replace = this.shouldReplace();

    const base = resolve(data.mfs_root, data.id);
    const ext = data.extension.toLowerCase();
    let orig = join(base, `orig.${ext}`);
    let info = join(base, "info.json");
    mkdirSync(base, { recursive: true });
    let docInfo = { buildState: Attr.working };
    if (!mv(incoming_file, orig)) {
      this.exception.server('FILE_ERROR');
      return
    }
    rmSync(info, { force: true });
    writeFileSync(info, docInfo);
    data.position = this.input.get(Attr.position) || 0;
    let recipients = await this.yp.await_proc(
      "entity_sockets",
      {
        hub_id: this.hub.get(Attr.id),
        //exclude,
      }
    );
    this._convertToPdf({ ...raw_data, ...data });
    if (!data.replace) {
      await this.sendNodeAttributes({
        nid: data.nid,
        recipients,
        service: "media.new",
        myData: data,
      });
    } else {
      await this.sendNodeAttributes({
        nid: data.nid,
        recipients,
        service: "media.replace",
        myData: data,
        extraData: { buildState: "wait" },
      });
    }
  }

  /**
   * 
   */
  async changelog_write(opt) {
    let { src, dest, event } = opt;
    let { metadata, md5Hash } = src;
    if (!md5Hash && metadata && metadata.md5Hash) {
      src.md5Hash = metadata.md5Hash;
    }
    delete src.metadata;

    if (dest) {
      let { metadata, md5Hash } = dest;
      if (!md5Hash && metadata && metadata.md5Hash) {
        dest.md5Hash = metadata.md5Hash;
      }
      delete dest.metadata;
    } else {
      dest = '{}';
    }
    if (!event) {
      event = this.input.get(Attr.service);
    }
    let changelog;
    try {
      if (/^\/__chat__\//.test(src.ownpth) || /^\/__chat__\//.test(dest.ownpth)) {
        this.__changelog = null;
        return this.__changelog;
      }
      changelog = await this.yp.await_proc(
        `changelog_write`, this.uid, this.hub.get(Attr.id), event, src, dest
      );
    } catch (e) {
      this.warn("changelog_write failed:", e)
    }
    this.__changelog = changelog
    return changelog;
  }

  /**
   * 
   * @param {*} incoming_file 
   * @param {*} data 
   * @returns 
   */
  async after_store(pid, incoming_file, data) {
    const base = resolve(data.mfs_root, data.id);
    await mkdirAsync(base, { recursive: true });
    const ext = data.extension.toLowerCase();
    let orig = `${base}/orig.${ext}`;
    this.granted_node(data);
    // Office documents (doc/docx/xls/.../odt) are NO LONGER auto-converted to a
    // user-facing PDF on upload. They are stored as-is (orig.<ext>) like any
    // other file; the SEO index queue (store() -> indexQueue, category=document)
    // renders a transient PDF only to produce thumb.png and then deletes it
    // (seo_lib.cleanup). The original is what the client serves/downloads.
    if (data.filetype == Attr.form) {
      let content = await this.handleForm(pid, incoming_file, data);
      return content;
    }

    if (!(await moveFileAsync(incoming_file, orig)) || !existsSync(orig)) {
      this.warn(`${__filename}:337 ${orig} not found`);
      this.exception.user(FAILED_CREATE_FILE);
      return { ...data, error: 1 };
    }

    // Force information generation
    if (data.filetype == Attr.document && data.extension == Attr.pdf) {
      Document.getInfo(data);
    }

    data.position = this.input.get(Attr.position) || 0;

    return data;
  }

  /**
   * 
   */
  async get_all() {
    const node_id = this.input.use(Attr.nid) || this.input.use(Attr.node_id, this.get_home_id());
    const page = this.input.use(Attr.page, 1);
    const VALID_TYPES = ['all', 'docs', 'pdf', 'image', 'other'];
    let type = this.input.use(Attr.type, 'all');
    if (!VALID_TYPES.includes(type)) {
      type = 'all';
    }
    let data = await this.db.await_proc(
      "mfs_show_node_by",
      node_id,
      this.uid,
      { sort_by: 'date', order: 'desc', page, type }
    );
    this.output.list(data);
  }

  /**
   * 
   */
  async show_node_by() {
    const granted = this.source_granted();
    let nid = (granted && granted.id) || "0";
    const VALID_TYPES = ['all', 'node', Attr.file, Attr.hub, 'docs', 'pdf', 'image', 'other'];
    let sort_by = this.input.use(Attr.sort, Attr.rank).toLowerCase();
    let order = this.input.use(Attr.order, "asc").toLowerCase();
    let type = this.input.use(Attr.type, 'all');
    // 'mtime' = modified-newest-first (the desk's default listing order);
    // 'name' was reachable in the proc but missing here (the list had
    // Attr.sort — the PARAM name — instead), so a name sort silently
    // degraded to rank.
    if (![Attr.rank, Attr.date, Attr.size, Attr.name, 'mtime'].includes(sort_by)) {
      sort_by = Attr.rank;
    }
    if (!["asc", "desc"].includes(order)) {
      order = "asc";
    }
    if (!VALID_TYPES.includes(type)) {
      type = 'all';
    }
    const page = this.input.use(Attr.page, 1);
    // Secure-share (DMZ) request: authorize the listing target from the TOKEN. A
    // logged-in recipient node-granted only on the shared FILE has no ACL on its
    // parent, so source resolution can miss it (nid === "0"); the token supplies the
    // parent to list. For a file share we ALSO hard-filter to the shared file below so
    // no sibling is ever exposed. null (no token / not a secure share) → unchanged.
    const ssTarget = await this._secureShareListTarget();
    if (ssTarget && ssTarget.nid && nid === "0") {
      nid = ssTarget.nid;
    }
    // When the result is pinned to a single FILE (secure-share file link or an
    // explicit file_nid), the post-filter below discards everything else — but
    // it only ever saw one 45-row page. With directories now ordered before
    // files, a busy parent's folders can consume the whole first page and the
    // shared file silently filters to an empty listing. Restrict the scan to
    // files so folders never spend the page budget the target needs.
    const file_nid = (ssTarget && ssTarget.file_nid) || this.input.get('file_nid');
    if (file_nid && (type === 'all' || type === 'node' || type === Attr.hub)) {
      type = Attr.file;
    }
    let data = await this.db.await_proc(
      "mfs_show_node_by",
      nid,
      this.uid,
      { sort_by, order, page, type }
    );
    // Token-authoritative file filter wins over the client value so a crafted request
    // (omitting file_nid) can never enumerate the shared file's siblings.
    if (file_nid) {
      data = toArray(data).filter(item => item && item.nid === file_nid);
    }
    // Secure-share listing: clamp each node's displayed privilege to the share's caps
    // so an anonymous (still creator-bound) recipient does not see the creator's full
    // privilege in nested folders. No token (normal desk listing) → capPriv null →
    // data untouched. Logged-in recipients are already capped via their own grant, so
    // the AND is a no-op for them. DISPLAY clamp only.
    const capPriv = await this._secureShareCapPrivilege();
    if (capPriv != null) {
      data = toArray(data).map((n) => {
        if (n && n.privilege != null) n.privilege = n.privilege & capPriv;
        return n;
      });
    }
    this.output.list(data);
  }

  /**
   *
   */
  async show_node_by_with_size() {
    const granted = this.source_granted();
    let nid = (granted && granted.id) || "0";
    const VALID_TYPES = ['all', 'node', 'file', 'hub', 'docs', 'pdf', 'image', 'other'];
    let sort_by = this.input.use(Attr.sort, Attr.rank).toLowerCase();
    let order = this.input.use(Attr.order, "asc").toLowerCase();
    let type = this.input.use(Attr.type, 'all');
    // 'mtime' = modified-newest-first (the desk's default listing order);
    // 'name' was reachable in the proc but missing here (the list had
    // Attr.sort — the PARAM name — instead), so a name sort silently
    // degraded to rank.
    if (![Attr.rank, Attr.date, Attr.size, Attr.name, 'mtime'].includes(sort_by)) {
      sort_by = Attr.rank;
    }
    if (!["asc", "desc"].includes(order)) {
      order = "asc";
    }
    if (!VALID_TYPES.includes(type)) {
      type = 'all';
    }
    const page = this.input.use(Attr.page, 1);
    // Secure-share (DMZ) token scoping — same as show_node_by (see there). null → unchanged.
    const ssTarget = await this._secureShareListTarget();
    if (ssTarget && ssTarget.nid && nid === "0") {
      nid = ssTarget.nid;
    }
    // Same pinned-file page-budget guard as show_node_by above.
    const ssFileNid = (ssTarget && ssTarget.file_nid) || this.input.get('file_nid');
    if (ssFileNid && (type === 'all' || type === 'node' || type === 'hub')) {
      type = 'file';
    }
    let branch = await this.db.await_proc(
      "mfs_show_node_by",
      nid,
      this.uid,
      { sort_by, order, page, type }
    );
    if (!isArray(branch)) {
      branch = [branch];
    }
    if (ssFileNid) {
      branch = toArray(branch).filter(item => item && item.nid === ssFileNid);
    }
    let tree = [];
    for (let file of branch) {
      if (file.ftype == "folder") {
        let nodes = await this.db.await_proc("mfs_manifest", { nid, uid: this.uid, show_nodes: 0 });
        file.filesize = nodes[0].total_size;
      }
      tree.push(file);
    }
    // Secure-share listing: clamp displayed per-node privilege to the share caps
    // (same as show_node_by). Gated on the token → normal listings untouched.
    const capPriv = await this._secureShareCapPrivilege();
    if (capPriv != null) {
      tree = tree.map((n) => {
        if (n && n.privilege != null) n.privilege = n.privilege & capPriv;
        return n;
      });
    }
    this.output.data(tree);
  }

  /**
   * 
   */
  reorder() {
    // Do not allow browsing
    this.output.data([]);
  }

  /**
   * 
   */
  async get_by_type() {
    const type = this.input.get(Attr.type) || IMAGE;
    const page = this.input.get(Attr.page) || 1;
    let opt = {
      type,
      page,
      order: this.input.get(Attr.order),
      sort: this.input.get(Attr.sort),
      pid: this.granted_node().id,
    };
    if (this.input.get("showAll")) {
      opt.pid = "*";
    }
    let files = await this.db.await_proc("mfs_list_by", opt);
    this.output.list(files);
  }

  /**
   * Gets list of all medias inside a node.
   */
  async get_path() {
    const { id } = this.source_granted();
    const data = await this.db.await_proc("mfs_get_path", id, this.uid);
    this.output.list(data);
  }

  /**
   * 
   */
  show_slides() {
    const nid = this.input.need(Attr.nid);
    const page = this.input.use(Attr.page, 1);
    let files = this.mfs_list_node_by(nid, IMAGE, page);
    this.output.data(files);
  }

  /**
   * 
   * @returns 
   */
  media_search() {
    return this.exception.user("DEPRECATED")
  }

  /**
  * Unified search: filenames + indexed content
  * Service: media.search_all
  * 
  * Searches both:
  * - Filenames
  * - File extensions
  * - Indexed content (words extracted from documents/images)
  * 
  * Returns results ranked by relevance:
  * - Exact filename match: highest priority
  * - Filename contains term: high priority  
  * - Extension match: medium priority
  * - Content match: lower priority
  */
  async search_all() {
    const query = this.input.safe_string(Attr.string) ||
      this.input.safe_string(Attr.query);

    const hub_id = this.hub.get(Attr.id);
    const page = this.input.use(Attr.page, 1);
    const limit = this.input.use(Attr.limit, 20);

    if (isEmpty(query)) {
      this.output.list([]);
      return;
    }

    const normalized_query = query.trim().replace(/ +/g, ' ');

    if (normalized_query.length < 2) {
      this.output.list([]);
      return;
    }

    try {
      this.debug(`[SEARCH] Query: "${normalized_query}" | Hub: ${hub_id} | Page: ${page}`);

      const results = await this.db.await_proc(
        'seo_search_unified',
        hub_id,
        this.uid,
        normalized_query,
        page,
        limit
      );

      if (!results) {
        this.output.list([]);
        return;
      }

      const result_array = isArray(results) ? results : [results];

      // Log search for analytics (don't fail if logging fails)
      try {
        await this.yp.await_proc(
          'log_search',
          this.uid,
          hub_id,
          normalized_query,
          result_array.length
        );
      } catch (e) {
        // Silently ignore logging errors
        this.debug('[SEARCH] Failed to log search:', e.message);
      }

      this.output.list(result_array);

    } catch (error) {
      this.warn('[SEARCH] Search failed:', error.message);

      // Return empty list on error instead of throwing exception
      this.output.list([]);
    }
  }

  /**
   * 
   */
  galery() { }

  /**
   * Thumb-class assets (vignette/thumb/card/preview/slide) are best-effort:
   * they are generated on demand from the original file, so when the source
   * is gone from disk (orphan DB row, lost content) there is nothing to
   * build. Reply 204 instead of 404 in that case — browsers log a console
   * error for every 404 fetch, so a desk full of orphan tiles used to flood
   * the console on every load; the UI falls back to the filetype icon on
   * both codes.
   */
  async _send_thumb(format) {
    // source_granted() returns the raw acl_check row (id/hub_id/db_name/
    // expiry/asked/privilege) with the REAL mfs node attached as .node —
    // unwrap it exactly like send_media does, or path resolution sees no
    // mfs_root/ext and healthy thumbs degrade to 204.
    const granted = this.source_granted();
    let node = granted && (granted.node || granted);
    // Last-resort: a grant shape that still lacks a resolvable root gets
    // the full row loaded the same way send_media's string-arg path does.
    if (node && !(node.target_mfs_root || node.mfs_root)) {
      const nid = node.id || node.nid;
      if (nid) {
        try {
          const full = await this.db.await_proc("mfs_node_attr", nid);
          if (full && (full.id || full.nid)) node = full;
        } catch (e) {
          this.debug(`mfs_node_attr failed for ${nid}:`, e.message);
        }
      }
    }
    if (node) {
      let orig = null;
      try {
        orig = get_node_content(node);
      } catch (e) {
        // Unresolvable shape — keep the legacy behavior untouched.
        await this.send_media(node, format);
        return;
      }
      if (orig && existsSync(orig)) {
        // Pre-run the (idempotent) generator: it swallows gm/convert
        // failures and returns nothing, after which FileIo would X-Accel
        // a nonexistent path and nginx would emit the 404. The thumb is
        // served ONLY when the output file actually exists after the
        // attempt — a corrupted/truncated source, a missing generator for
        // this filetype, or an unresolvable output path all degrade to 204.
        const output = get_node_content(node, format, "png");
        const g = Generator[`create_${node.filetype}_${format}`];
        if (isFunction(g) && output) {
          try {
            g(output, orig, node);
          } catch (e) {
            this.debug(`thumb generation failed nid=${node.id}:`, e.message);
          }
        }
        if (!output || !existsSync(output)) {
          this.output.head({ "Cache-Control": "no-store" }, 204);
          return;
        }
        await this.send_media(node, format);
        return;
      }
    }
    this.output.head({ "Cache-Control": "no-store" }, 204);
  }

  /**
   *
   */
  async vignette() {
    //const nid = this.input.need(Attr.nid);
    await this._send_thumb(VIGNETTE);
  }

  /**
   *
   */
  async thumb() {
    await this._send_thumb(THUMBNAIL);
  }

  /**
   *
   */
  async card() {
    await this._send_thumb(CARD);
  }

  /**
   * 
   */
  async mark_as_seen() {
    const nid = this.input.need(Attr.nid);
    let data = await this.db.await_proc(
      "mfs_mark_as_seen",
      nid,
      this.uid,
      1
    );
    let recipients = await this.yp.await_proc("user_sockets", this.uid);
    let keys = { entity_id: Attr.hub_id };
    await RedisStore.sendData(this.payload(data, { keys }), recipients);
    await RedisStore.sendData(
      this.payload({}, { service: "notification.resync" }),
      recipients
    );
    this.output.data(data);
  }

  /**
   * 
   */
  clear_notifications() {
    this.output.data({});
  }

  /**
   *
   */
  async slide() {
    await this._send_thumb(SLIDE);
  }

  /**
   *
   */
  async preview() {
    await this._send_thumb(PREVIEW);
  }

  /**
   *
   */
  async pdf() {
    //const nid = this.input.need(Attr.nid);
    let node = this.granted_node();
    if (node.filetype != Attr.document) {
      this.exception.user("WRONG_FORMAT");
      return;
    }
    // Office documents are downloaded as their ORIGINAL file (orig.<ext>), not
    // served as PDF, and must never be auto-converted on demand. Only a true
    // PDF (or an already-built transient preview) is served here.
    const docExt = (node.extension || node.ext || "").toString().toLowerCase();
    const isPdf = docExt === Attr.pdf;
    let info = Document.getInfo(node);
    const fileio = new FileIo(this);
    let path = info.pdf;
    if (path != null) {
      if (!existsSync(path)) {
        if (!isPdf) {
          // Never re-run LibreOffice for a non-pdf doc; the original is the file.
          fileio.not_found();
          return;
        }
        let s = Document.rebuildInfo(
          node,
          this.uid,
          this.input.get(Attr.socket_id)
        );
        if (s.path) {
          path = s.path;
        } else {
          this.output.data(s);
          return;
        }
      }
      const opt = {
        name: `${node.filename}.pdf`,
        path,
        accel: path.replace(DATA_ROOT, ""),
        mimetype: "application/pdf",
        code: 200,
      };
      fileio.static(opt);
    } else {
      fileio.not_found();
    }
  }

  /**
   * 
   */
  async webp() {
    await this.send_media(this.source_granted(), WEBP);
  }

  /**
   * 
   */
  async folder() {
    await this.send_media(this.source_granted(), FOLDER);
  }

  /**
   *
   */
  async page() {
    let filepath;
    let p = this.input.need("p");
    const e = this.input.use("e");
    if (!isEmpty(e)) {
      filepath = join(`${p}.${e}`);
    } else {
      filepath = join(p);
    }
    filepath = decodeURI(filepath);

    let data = await this.await_proc("mfs_get_by_path", filepath);

    if (!isEmpty(data) && data.id) {
      await this.send_media(data.id, ORIGINAL, null, "raw");
    } else {
      const fileio = new FileIo(this);
      return fileio.not_found(filepath);
    }
  }

  /**
   * 
   */
  async view() {
    const nid = this.input.need(Attr.nid);
    const page = this.input.use(Attr.page) || 0;
    await this.send_media(this.source_granted(), SLIDE, page);
  }

  /**
   *
   * @param {array} args list of node to be created as zip
   */
  zip_release() {
    const id = this.input.need(Attr.id);
    const src = join(tmp_dir, DOWNLOAD_FOLDER, this.uid, id);
    const link = join(
      mfs_dir,
      DOWNLOAD_FOLDER,
      this.uid,
      id
    );
    remove_dir(src, 1);
    remove_dir(link, 1);
    this.output.data({ id });
  }

  /**
   *
   * @param {array} args list of node to be created as zip
   * @param {array} cvf if present export cvf from user addresses book
   */
  create_large_zip(args, vcf) {
    //let dest_dir = this.home_dir;
    const zipid = this.randomString();

    const dest_dir = join(
      mfs_dir,
      DOWNLOAD_FOLDER,
      this.uid,
      zipid
    );
    mkdirSync(dest_dir, { recursive: true });
    const batch_file = join(dest_dir, BATCH_FILE);
    if (vcf) this.writeVcf(vcf, dest_dir);

    const { writeFileSync } = require("jsonfile");
    writeFileSync(batch_file, { nodes: args, uid: this.uid, zipid });
    return zipid;
  }

  /**
   *
   * @param {array} args list of node to be created as zip
   * @param {string} zipname name of zipped file
   */
  create_small_zip(args, zipname, vcf) {
    const zipid = this.randomString();

    const dest_dir = join(
      tmp_dir,
      DOWNLOAD_FOLDER,
      this.uid,
      zipid
    );
    //if (!this.sh_mkdir(dest_dir)) throw "Failed to create zip dir";
    mkdirSync(dest_dir, { recursive: true });
    let files = args;
    if (!isArray(files)) {
      files = [files];
    }
    let dump = this.makeArchiveList(files, dest_dir);
    for (let k of dump) {
      if ([Attr.hub, Attr.folder].includes(k.type)) continue;
      if (existsSync(k.src)) {
        // Clear any pre-existing entry at the destination before linking: two
        // branch nodes can map to the same archive path (duplicate filenames),
        // and a retried download can leave a stale symlink — either makes
        // symlinkSync throw EEXIST and fail the whole download
        // (SERVICE_FAILED:media.download). Mirror zip()'s rm-before-symlink.
        // force:true = no error when there is nothing to remove (the normal
        // case: dest_dir is freshly created per zipid), so behaviour is
        // unchanged except in the colliding/stale case.
        rmSync(k.dest, { force: true });
        symlinkSync(k.src, k.dest);
      }
    }
    if (vcf) this.writeVcf(vcf, dest_dir);

    // zipname is already sanitized (no spaces/quotes) by download(), so it is
    // safe to interpolate into the shell command. Archive under that name so
    // the file on disk matches what the client retrieves.
    const safe = String(zipname || "index").replace(/[^\w.-]+/g, "-") || "index";
    let cmd = `${Script.archive} ${dest_dir} ${safe}`;
    if (this.sh_exec(cmd)) {
      return zipid;
    }
  }

  /**
   *
   * @param {*} nid
   * @returns
   */
  async get_branch_nodes(nid) {
    let ids = this.input.use(Attr.nodes);
    let nodes = [];
    let r;
    let filename = this.input.use(Attr.filename) || "drumee-dl";
    let size = 0;
    if (isArray(ids)) {
      let res = [];
      for (let n of ids) {
        // Manifest EACH selected node on ITS OWN hub DB. The old code computed
        // db_name but discarded it, and called mfs_manifest with the OUTER `nid`
        // (source_granted's single node) on this.db every iteration — so a
        // multi-item selection (e.g. "download the whole workspace", which sends
        // every top-level item) manifested one node N times → after de-dup only
        // that one node's content landed in the zip. Mirror the offline worker
        // (offline/media/download.js get_branch_nodes): `${db_name}.mfs_manifest`
        // with n.nid. mfs_manifest returns each node's own absolute file_path, so
        // concatenating per-item manifests yields the full tree with no path
        // collisions.
        let db_name = await this.yp.await_func("get_db_name", n.hub_id);
        r = await this.yp.await_proc(`${db_name}.mfs_manifest`, { nid: n.nid, uid: this.uid, show_nodes: 1 });
        res = res.concat(r[0]);
        size = parseInt(size) + parseInt(r[1].total_size);
      }
      nodes = [res, { size, total_size: size }, { filename }];
    } else {
      r = await this.db.await_proc("mfs_manifest", { nid, uid: this.uid, show_nodes: 1 });
      filename = this.granted_node().filename || r[2].filename || "drumee";
      size = parseInt(r[1].total_size);
      nodes = [r[0], { size, total_size: size }, { filename }];
    }
    return nodes;
  }

  /**
   * 
   * @param {*} id 
   * @param {*} vcf 
   * @returns 
   */
  async download(id, vcf) {
    // Secure-share recipient: an explicit download (folder/file zip) requires
    // can_download (or can_edit). A view-only recipient is blocked here, while
    // inline PREVIEW/stream paths (thumb/preview/slide/video/orig-render/...) are
    // untouched so viewing still works. No token (normal/legacy request) → the
    // guard returns null → normal ACL applies, behaviour unchanged.
    if (!(await this._secureShareCapAllowed(["can_download", "can_edit"]))) {
      return this.exception.forbiden();
    }
    let node = this.source_granted();
    let nid = node.id;
    let socket_id = this.input.need(Attr.socket_id);
    if (id) {
      nid = id;
    }
    let nodes = await this.get_branch_nodes(nid);
    let size = nodes[1].total_size;
    let total_size = size;
    let zipid;
    let hub_id = this.hub.get(Attr.id);
    let filename = nodes[2].filename;
    const Moment = require("moment");
    // Name the archive after the folder/file + a filesystem/URL/shell-safe
    // timestamp (no spaces or colons), e.g. "operations-2026-05-31-0519".
    // The SAME name is archived on disk, returned to the client, and used for
    // retrieval — so the media.zip lookup matches (previously the response
    // returned "Drumee-<hh:mm>" while the archive was written under a different
    // name, causing a 404).
    const t = Moment(Moment.now() / 1000, "X").format("YYYY-MM-DD-HHmm");
    const base = String(filename || "Drumee")
      .replace(/[^\w.-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
    let zipname = `${base || "Drumee"}-${t}`;
    if (size <= 1024 * 1024 * 5) {
      zipid = this.create_small_zip(nodes[0], zipname, vcf);
      this.output.data({
        wait: 0,
        zipname,
        hub_id,
        size,
        nid,
        zipid,
      });
      return;
    }
    zipid = this.randomString();
    const lang = this.client_language();
    if (isArray(this.input.use(Attr.nodes))) {
      nodes = this.input.use(Attr.nodes);
    } else {
      nodes = [Document.cleanData(this.source_granted().node)];
    }
    let args = {
      nodes,
      lang,
      uid: this.uid,
      hub_id,
      zipid,
      socket_id,
      zipname,
    };
    let cmd = resolve(OFFLINE_DIR, "download.js");
    const str_args = JSON.stringify(args);
    let child = Spawn(cmd, [str_args], SPAWN_OPT);
    this.output.data({
      wait: 1,
      size,
      total_size,
      zipid,
      nid,
      hub_id,
      zipname,
    });
    child.unref();
  }

  /**
   *
   */
  writeVcf(vcf, dest_dir) {
    let filename = Cache.message("_addresses_book", this.client_language());
    let entries = [];
    for (let entry of vcf) {
      entries.push(entry.join(""));
    }
    writeFileSync(resolve(dest_dir, `${filename}.vcf`), entries, {
      encoding: "utf8",
    });
  }

  /**
   * get prepared zip file
   * @returns 
   */
  async zip() {
    // Defense-in-depth for the download guard: download() above stages the archive,
    // this serves its bytes. A view-only secure-share recipient must not retrieve a
    // previously-staged zip (no token → null → normal ACL, unchanged).
    if (!(await this._secureShareCapAllowed(["can_download", "can_edit"]))) {
      return this.exception.forbiden();
    }
    const id = this.input.need(Attr.id);
    const zipname = this.input.need("zipname") || `index`;
    // Use this.uid to match the path used by create_small_zip() and
    // create_large_zip(). Using hub_id caused path mismatch in workspaces
    // where hub_id ≠ uid, resulting in 404 on zip retrieval.
    const dir = join(tmp_dir, DOWNLOAD_FOLDER, this.uid, id);
    // The on-disk archive name does NOT match the friendly zipname the client
    // sends: create_small_zip() always writes "index.zip", and the large-zip
    // worker writes a sanitized name (spaces → "-"). Each id dir holds exactly
    // one archive, so resolve to the real file: try the requested name first,
    // then fall back to whatever single .zip is present. (Trusting the
    // friendly zipname for the path produced a dangling symlink → 404.)
    let src = join(dir, `${zipname}.zip`);
    if (!existsSync(src)) {
      const zips = existsSync(dir)
        ? readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".zip"))
        : [];
      if (zips.length) src = join(dir, zips[0]);
    }
    const target = join(
      mfs_dir,
      DOWNLOAD_FOLDER,
      this.uid,
      id
    );
    mkdirSync(target, { recursive: true });
    // Stable, space-free link name for the X-Accel-Redirect path; the friendly
    // download filename is set via the `name` option so the user still gets
    // "Drumee-….zip" even though the archive name carries spaces/colons.
    const file = join(target, `${id}.zip`);
    const fileio = new FileIo(this);

    // In case of download several time, remove existing symlink
    if (existsSync(file)) {
      rmSync(file);
    }

    if (existsSync(src)) {
      symlinkSync(src, file);
      const opt = {
        path: file,
        name: `${zipname}.zip`,
        mimetype: "application/zip",
        code: 200,
      };
      fileio.static(opt);
      return;
    }
    fileio.not_found();
  }

  /**
   *
   * @param {array} args list of node to be created as zip
   */
  zip_cancel() {
    const id = this.input.need(Attr.id);
    const cancelId = this.input.need("cancelId");
    const dirname = join(
      mfs_dir,
      DOWNLOAD_FOLDER,
      this.uid,
      id
    );
    const file = join(dirname, `index.zip`);
    if (existsSync(file) && cancelId) {
      // Provied process id is the parent of the actual zipper...
      process.kill(cancelId, 'SIGINT');
    }
    this.output.data({});
  }

  /**
   * 
   */
  async zip_size() {
    let nid = this.source_granted().id;
    // Check socket binding
    let dest = await this.yp.await_proc(
      "socket_get",
      this.input.need(Attr.socket_id)
    );

    let nodes = await this.get_branch_nodes(nid);
    let size = nodes[1].total_size;
    this.output.data({ size, socket_bound: isEmpty(dest) });
  }

  /**
   * 
   */
  async orig() {
    await this.send_media(this.source_granted(), ORIGINAL);
  }


  /**
   * cross log probe
   */
  xl() {
    let referer = this.input.get("referer");
    let probeid = this.input.get(Attr.nid);
    this.session.log_service({ referer, probeid });
    const fileio = new FileIo(this);
    fileio.icon();
  }

  /**
   * 
   */
  async stylesheet() {
    await this.send_media(this.source_granted(), STYLESHEET);
  }

  /**
   * 
   */
  async script() {
    await this.send_media(this.source_granted(), Attr.script);
  }
  /**
   * 
   */
  async audio() {
    await this.send_media(this.source_granted(), STREAM);
  }

  /**
   * 
   */
  async video() {
    await this.send_media(this.source_granted(), STREAM);
  }


  /**
   * 
   */
  async ogv() {
    await this.send_media(this.source_granted(), VIDEO);
  }

  /**
   * 
   * @returns 
   */
  async raw() {
    let filepath;
    let p = this.input.need("p");
    const e = this.input.use("e");
    if (/(\/+)$/.test(p)) {
      p = p.replace(/(\/+)$/, "");
      filepath = `/${p}`;
    } else if (!isEmpty(e)) {
      filepath = `/${p}.${e}`;
    } else {
      filepath = p;
    }
    filepath = `/${filepath}`;
    filepath = filepath.replace(/^(\/+)/, "/");
    filepath = decodeURI(filepath);
    let data = await this.db.await_proc("mfs_get_by_path", filepath);

    if (!isEmpty(data) && data.id) {
      try {
        let md = data.metadata;
        if (isString(md)) md = JSON.parse(md);

        if (md && md.loader) {
          let file = resolve(
            this.granted_node().home_dir,
            data.id,
            `orig.${data.extension}`
          );
          let loader = readFileSync(file);
          loader = String(loader).trim().toString();
          const Bootstrap = require("../client/bootstrap");
          let b = new Bootstrap(this);
          let c = await b.htmlContent(md.loader, md);
          this.output.html(c);
          b.stop();
          return;
        }
      } catch (e) {
        this.warn("FAILED TO GET HTML CONTENT", e);
      }
      await this.send_media(data.id, ORIGINAL, null, "raw");
      let xid = this.input.get("xid")
      if (xid) {
        this.session.log_service({ xid });
      }
      return;
    }
    const fileio = new FileIo(this);
    fileio.not_found(filepath);
  }

  /**
   * 
   * @param {*} id 
   * @param {*} name 
   * @param {*} value 
   * @param {*} cb 
   */
  _setAttr(id, name, value, cb) {
    switch (name) {
      case "mtime":
      case "ctime":
        name = "publish_time";
    }
    this.db.call_proc("mfs_set_attr", id, name, value, cb);
  }

  /**
   * 
   * @param {*} data 
   * @returns 
   */
  _clean_json(data) {
    //data._clean_ = 1;
    let str = stringify(data);
    str.replace(/\'/g, "&#9054;");
    return JSON.parse(str);
  }

  /**
   * 
   * @param {*} n 
   * @returns 
   */
  async info(n) {
    let node = n || this.granted_node();
    if (!node || !node.id) {
      this.exception.forbiden();
      return;
    }
    let info = { status: "na" };
    switch (node.filetype) {
      case Attr.document:
        info = Document.getInfo(node);
        if (info.error == "FILE_NOT_FOUND" || nullValue(info.pages) || !info.pdf || !existsSync(info.pdf)) {
          info = Document.rebuildInfo(
            node,
            this.uid,
            this.input.get(Attr.socket_id)
          );
        }
        break;
      case Attr.audio:
        try {
          info = await Generator.get_mm_info(node);
        } catch (e) {
          this.warn("Generator failed", e);
        }
        break;
      case Attr.video:
        info = Generator.get_video_info(node);
        break;
      case Attr.image:
        info = Generator.get_image_info(node);
        if (info.Image && /[0-9]+x[0-9]+/.test(info.Image.Geometry)) {
          await this.db.await_proc(
            "mfs_set_attr",
            node.id,
            "geometry",
            info.Image.Geometry
          );
        }
        break;

      case Attr.folder:
        info = await this.db.await_proc("mfs_manifest", { nid: node.id, uid: this.uid, show_nodes: 0 });
        break;
    }
    if (isEmpty(info)) {
      info = { error: "FILE_NOT_FOUND", reason: "NO_MORE_EXISTS" };
    }
    info.stats = this.sanitize(node);
    // if (!info.error) {
    //   await this.db.await_proc("readlog_mark", this.uid, node.hub_id, node.id);
    // }
    this.output.data(info);
  }

  /**
   * 
   */
  async get_node_attr() {
    let node = this.granted_node();
    let relpath = this.input.get('relpath');
    if (relpath) {
      let filepath = join(node.ownpath, relpath);
      let id = await this.db.await_func("node_id_from_path", filepath);
      if (id) {
        let item = await this.db.await_proc('mfs_access_node', this.uid, id);
        if (item && item.nid) {
          return this.output.data(item);
        }
      }
    }
    this.output.data(node);
  }

  /**
   * 
   */
  async is_expired() {
    const id = this.input.use(NODE_ID);
    let res = {};
    res.is_expired = 1;
    res.expiry = await this.db.await_func("user_expiry", this.uid, id);
    res.now = new Date().getTime(); //await this.db.await_func(" UNIX_TIMESTAMP");
    if (res.expiry > res.now) res.is_expired = 0;
    this.output.data(res);
  }
}

module.exports = __media;
