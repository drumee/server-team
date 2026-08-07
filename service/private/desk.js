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

const { isArray, after, union, filter, isEmpty } = require('lodash');
const Media = require('../media');
const { writeAudit } = require('./_audit');
const { pushReferralLive } = require('./_referral_live');

const {
  Attr, Privilege, toArray,
  RedisStore, uniqueId, sysEnv
} = require("@drumee/server-essentials");

// Desk search only looks at chat messages once the query is at least this long.
// A single letter matches almost every message, which buries the file/folder
// hits under hundreds of chat rows. Same threshold as channel.search().
const MIN_MESSAGE_SEARCH_LENGTH = 2;

// System events are stored in the channel as an `[[EVENT:payload]]` envelope
// (e.g. `[[MEETING:start:{...}]]`) and rendered as activity rows, never typed
// by a user. They must not surface as search hits: a query matching their
// markup or embedded ids (`MEETING`, hub ids, ...) is a false positive.
const SYSTEM_EVENT_MESSAGE = /^\s*\[\[[A-Z_]+:/;

class __private_desk extends Media {

  /**
   * 
   * @param  {...any} args 
   */
  constructor(...args) {
    super(...args);
    this.check_quota = this.check_quota.bind(this);
    this.pre_copy = this.pre_copy.bind(this);
    this.get_env = this.get_env.bind(this);
    this.home = this.home.bind(this);
    this.create_hub = this.create_hub.bind(this);
    // this.create_website = this.create_website.bind(this);
    this.leave_hub = this.leave_hub.bind(this);
    this.create_account = this.create_account.bind(this);
    this.get_workers = this.get_workers.bind(this);
    this.get_alternate_account = this.get_alternate_account.bind(this);
    this.reorder = this.reorder.bind(this);
    this.recent_files = this.recent_files.bind(this);
  }

  /**
   * 
   * @param {*} opt 
   */
  initialize(opt) {
    const self = this;
    opt.session.hub = opt.session.user;
    super.initialize(opt);
  }


  /**
   * 
   */
  async limit() {
    let { quota, mfs_dir } = sysEnv();
    let { watermark, sys_watermark } = quota;
    let limit = {}
    if (watermark == Infinity || sys_watermark == Infinity) {
      const diskSpace = require('check-disk-space').default;
      let df = await diskSpace(mfs_dir);
      limit.real = df.free;
      limit.storage = df.free;
    } else {
      limit = await this.yp.await_proc("get_quota", this.uid) || { storage: 0, real: 0 };
    }
    this.output.data(limit)
  }

  /**
   * 
   * @param {*} args 
   * @param {*} opt 
   */
  async _createHub(args, opt = {}) {
    const domain = this.user.get(Attr.domain);
    const owner_id = this.uid;
    let { area, filename, hostname, pid } = args;
    if (!domain || !area) {
      this.warn("MAL_FORMED_DATA", { args }, { domain, area });
      return this.exception.user("MAL_FORMED_DATA");
    }

    if (opt.is_wicket) {
      hostname = uniqueId()
      filename = hostname;
    } else {
      hostname = filename;
      hostname = hostname.replace(/[ \.,;:!&~#'|@*\$><\?\(\)\[\]\{\}\"\/]/g, '');
      hostname = await this.yp.await_func("strip_accents", hostname);
      hostname = hostname.replace(/\-$/, '');
      hostname = hostname.trim().toLowerCase();
      hostname = new URL(`http://${hostname}`).hostname;
    }

    opt.lang = this.input.ua_language();
    filename = await this.db.await_func("unique_filename", pid, filename, "");
    args = { hostname, area, filename, owner_id, domain };
    const rows = await this.db.await_proc(`desk_create_hub`, args, opt);
    let hub_id, hub_db, home_id;
    for (let r of rows) {
      if (r && r.failed) {
        this.debug("Rows returned", rows)
        this.warn("Failed to create hub", { args, opt, rows });
        return {};
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

    /** place the folder at the end on the user desk */
    let { count } = await this.db.await_query("SELECT count(*) count FROM media");
    await this.db.await_query("UPDATE media media SET rank=? WHERE id=?", count, hub_id);
    return { filename, hostname, hub_id, hub_db, home_id }

  }

  /**
   * 
   * @returns 
   */
  async check_quota() {
    const area = this.input.need(Attr.area, Attr.private);
    const folders = [];
    if (isArray(this.input.use('folders'))) {
      for (let path of this.input.use('folders')) {
        folders.push({ path });
      }
    }

    // get_quota is a SQL FUNCTION returning JSON, and the driver hands that
    // back as a string, not an object — destructuring it directly yielded
    // undefined for every key, which is the other half of why this guard never
    // fired. Parse when needed; tolerate a driver that already decoded it.
    let q = await this.yp.await_func("get_quota", this.uid);
    if (typeof q === 'string') {
      try { q = JSON.parse(q); } catch (e) { q = null; }
    }
    let { private_hub, share_hub, public_hub } = q || {};
    let used = ~~(await this.yp.await_func("hub_usage", this.uid, area)) || 0;
    let cap = null;
    let message = '_private_hub_limit_reached'
    switch (area) {
      case Attr.private:
        cap = private_hub;
        message = '_private_hub_limit_reached'
        break;
      case Attr.share:
        cap = share_hub;
        message = '_share_hub_limit_reached'
        break;
      case Attr.public:
        cap = public_hub;
        message = '_public_hub_limit_reached'
        break;
    }
    // A plan that does not state a cap for this area is unlimited there.
    //
    // This used to read `remain = cap - used` and refuse on `remain <= 0`,
    // which inverted the intent whenever the cap was absent: the 2026-07 plan
    // quotas carry no $.private_hub / $.share_hub, so `cap` was undefined,
    // `remain` was NaN, and `NaN <= 0` is FALSE — the guard passed every time
    // and the limit was never enforced for anyone. Decide on the cap itself,
    // so a missing one is explicitly unlimited and a real one is compared as a
    // number.
    cap = Number(cap);
    if (Number.isFinite(cap) && cap > 0 && used >= cap) {
      this.output.data({
        error: "QUOTA_EXCEEDED",
        reason: message,
        cap,
        used,
      })
      return;
    }
    this._done();
  }

  /**
   * 
   */
  pre_copy() {
    const id = this.input.need(Attr.nid);
    const count = after(2, this._done);

    this.yp.call_proc('get_hub_owner', id, function (data) {
      if ((data == null) || (data.owner_id !== this.uid)) {
        this.exception.forbiden('Must be owner to make a copy');
        return;
      }
      if ([Attr.private, Attr.public].includes(data.area)) {
        this.heap.area = data.area;
        this.heap.hubname = this.input.use(Attr.hubname) || uniqueId();
        count();
      } else {
        this.exception.user(`Copying area ${data.area} is not allowed`);
        return;
      }

      this.yp.call_proc('get_hub', data.id, function (row) {
        this.heap.profile = row.profile;
        this.heap.profile.name = this.heap.profile.name + '-copy';
        return count();
      }.bind(this));
    }.bind(this));
  }


  /**
   * 
   */
  async get_env() {
    let data = await this.db.await_proc("desk_env");
    data.filenames = await this.db.await_proc('mfs_get_filenames', this.home_id);
    data.privilege = Privilege.OWNER;
    data.quota = await this.yp.await_func("get_quota", this.uid) || { storage: 0, real: 0 };
    this.output.data(data);
  }

  /**
   * 
   */
  async home() {
    const page = this.input.use(Attr.page, 1);
    const VALID_TYPES = ['all', 'node', 'file', 'hub', 'docs', 'pdf', 'image', 'other'];
    let type = this.input.use(Attr.type, 'all');
    if (!VALID_TYPES.includes(type)) {
      type = 'all';
    }
    let res = await this.db.await_proc(
      "mfs_show_node_by",
      this.home_id,
      this.uid,
      { sort_by: 'rank', order: 'asc', page, type }
    );
    this.output.list(res);
  }

  /**
   * 
   */
  async export_vcf() {
    const self = this;
    function xlate(s, phones, addresses) {
      let lines = [
        `BEGIN:VCARD\n`,
        `VERSION:4.0\n`,
        `N:${s.firstname};${s.lastname};${s.surname};.;\n`,
        `FN:${s.fullname}\n`,
        `ORG:${s.organization}\n`,
        `TITLE:${s.title}\n`,
        `PHOTO;MEDIATYPE=image/gif:${s.avatar}\n`,
        `TEL;`,
        `ADR;`,
        `EMAIL:${s.email}\n`,
        `END:VCARD\n`,
      ];
      let r = [];
      let number, type, addr;
      for (let line of lines) {
        if (/^TEL/.test(line)) {
          for (let p of phones) {
            [number, type] = p.split('---');
            r.push(`TEL;TYPE=${type},voice;VALUE=uri:tel:${number}\n`);
          }
        } else if (/^ADR/.test(line)) {
          for (let a of addresses) {
            [addr, type] = a.split('---');
            try {
              let l = self.parseJSON(addr)
              r.push(`ADR;TYPE=${type};LABEL="${l.street}\n${l.city}\n${l.country}";;${l.street};${l.city};${l.country}\n`)
            } catch (e) {
              r.push(`ADR;TYPE=${type};LABEL=${addr}\n`)
            }
          }
        } else {
          r.push(line);
        }
      }
      r = union(r);
      return (filter(r, function (e) { return (!/undefined|null/.test(e)) }));
    }
    let rows = await this.db.await_proc('contact_export');
    rows = toArray(rows);
    let data = [];
    for (let row of rows) {
      let phones = [];
      if (row.phone) {
        phones = row.phone.split(/(:::)/);
      }
      let addresses = [];
      if (row.address) {
        addresses = row.address.split(/(:::)/);
      }
      data.push(xlate(row, phones, addresses));
    }
    return data;
  }

  /**
   * 
   */
  async backup() {
    this.export_vcf().then((vcf) => {
      this.download(this.home_id, vcf);
    })
  }

  /**
   * Search files/folders (via desk_search SP + media_index)
   * AND messages (via channel_search SP, cross-hub).
   */
  async search() {
    const string = this.input.safe_string(Attr.string);
    const page   = this.input.use(Attr.page, 1);
 
    if (isEmpty(string)) {
      const data = await this.db.await_proc(
        "mfs_show_node_by",
        this.home_id,
        this.uid,
        { sort_by: 'rank', order: 'asc', page, type: 'hub' }
      );
      this.output.list(data);
      return;
    }

    const pattern = string.trim();
 
    // File / folder search (existing behaviour, cross-hub via media_index)
    let fileResults = await this.db.await_proc('desk_search', { pattern, page });
    fileResults = toArray(fileResults).map(r => ({ ...r, result_type: 'file' }));
 
    // Message search across all active hubs owned by the current user
    let messageResults = [];
    try {
      // A too-short query skips the chat stage entirely (no hub lookup, no
      // channel_search) so file/folder hits are not buried — see
      // MIN_MESSAGE_SEARCH_LENGTH. File search still runs for any length.
      const hubs = pattern.length < MIN_MESSAGE_SEARCH_LENGTH ? [] : toArray(
        await this.yp.await_query(
          `SELECT e.id, e.db_name FROM entity e JOIN hub h ON h.id = e.id
           WHERE h.owner_id = ? AND e.type = 'hub' AND e.status = 'active'`,
          this.uid
        )
      );
 
      for (const hub of hubs) {
        if (!hub.db_name) continue;
        try {
          const rows = toArray(
            await this.yp.await_proc(`${hub.db_name}.channel_search`, pattern)
          );
          for (const row of rows) {
            // System event envelopes are activity rows, not user text
            if (SYSTEM_EVENT_MESSAGE.test(row.preview || '')) continue;
            row.hub_id      = hub.id;
            row.result_type = 'message';
            messageResults.push(row);
          }
        } catch (e) {
          // One hub failing must not abort the entire search
          this.warn(
            `[desk.search] channel_search failed for hub ${hub.id}:`,
            e && e.message
          );
        }
      }
 
      // Sort merged message results newest-first
      messageResults.sort((a, b) => b.ctime - a.ctime);
 
    } catch (e) {
      this.warn('[desk.search] message search stage failed:', e && e.message);
    }
 
    this.output.list([...fileResults, ...messageResults]);
  }

  /**
   * Get combined list of user + system wallpapers
   * 
   * Returns paginated array of wallpaper objects:
   * - User wallpapers first (from folders tagged with folder_type='wallpapers')
   * - System wallpapers second (from System hub Wallpapers folder)
   * 
   */
  async my_wallpapers() {
    const page = this.input.use(Attr.page, 1);
    const data = await this.db.await_proc('desk_my_wallpapers', this.uid, page);
    this.output.list(data);
  }


  /**
   * 
   */
  async disk_usage() {
    const page = this.input.use(Attr.page, 1);
    const category = this.input.use(Attr.category) || '*';
    const list = this.input.use(Attr.list);
    const data = await this.db.await_proc('desk_disk_usage', this.uid, category, page) || [];
    if (list) {
      return this.output.list(data[2]);
    }
    this.output.list(data);
  }

  /**
   * 
   * Wicket is used to handle external meeting
   * It must be unique per drumate
   * @returns 
   */
  async create_wicket() {
    let media;
    let data = await this.db.await_proc("desk_env");
    if (data.wicket_id) {
      let hub = await this.yp.await_proc('get_entity', data.wicket_id);
      media = await this.db.await_proc(`${hub.db_name}.mfs_access_node`, this.uid, hub.home_id);
      this.output.data({ ...media, wicket_id: data.wicket_id });
      return;
    }
    const args = { area: 'dmz', filename: "wicket" };
    const options = { is_wicket: 1 };

    let { home_id, hub_id, hub_db } = await this._createHub(args, options);
    if (!hub_db) {
      return this.output.data({ status: 'CREATION_FAILED' })
    }
    media = await this.db.await_proc(`${hub_db}.mfs_access_node`, this.uid, home_id);
    this.output.data({ ...media, wicket_id: hub_id });
  }



  /**
   * 
   * @returns 
   */
  async create_hub() {
    const pid = this.input.use(Attr.pid) || this.home_id;
    const filename = this.input.need(Attr.filename);
    const area = this.input.need(Attr.area, Attr.private);

    let { filename: actual_filename, hub_id } = await this._createHub({ area, filename, pid });
    if (!hub_id) {
      return this.output.data({ status: 'CREATION_FAILED' })
    }
    const hub = await this.yp.await_proc("get_hub", hub_id);
    if (isEmpty(hub)) {
      this.exception.server("Corrupted hub");
      return;
    }
    if (pid && pid != this.get(Attr.home_id)) {
      await this.db.await_proc("mfs_move", hub.id, pid)
    }
    let media = await this.db.await_proc("mfs_access_node", this.uid, hub_id);
    media.hub_id = hub_id;
    media.area = area;
    media.filename = actual_filename;
    media.privilege = media.permission;
    media.home_id = media.actual_home_id;
    media.isalink = 1;
    media.ownpath = '/';
    let sockets = await this.yp.await_proc('entity_sockets', media.hub_id);
    await RedisStore.sendData(this.payload(media), sockets);
    await this.changelog_write({ src: media, event: "media.new" });

    // Mirror to creator's drumate so the trail survives a later delete.
    const hub_db = await this.yp.await_func('get_db_name', hub_id);
    if (hub_db) {
      await writeAudit(this, {
        db: hub_db,
        uid: this.uid,
        action: 'create_workspace',
        category: 'admin',
        notify_to: 'admin',
        entity_id: hub_id,
        log: `Workspace '${actual_filename}' created (area=${area})`,
      });
    }
    await writeAudit(this, {
      db: this.user.get(Attr.db_name),
      uid: this.uid,
      action: 'create_workspace',
      category: 'admin',
      notify_to: 'admin',
      entity_id: hub_id,
      log: `Workspace '${actual_filename}' created (area=${area})`,
    });

    this.output.data(media);
  }

  /**
   * Record that the caller created a workspace from the workspace form
   * (ui-team builtins/media/form).
   *
   * The body is deliberately empty of work: the row this service exists to
   * write has already been written by the time we run. `"log": true` in
   * acl/desk.json makes router/rest/index.js call session.log_service(),
   * which posts yp.analytics_log -> INSERT INTO yp.services_log with the
   * caller's uid, the posted args and a timestamp. Same mechanism that logs
   * desk.create_hub, same table the analytics Referral users table already
   * reads for its Shares column.
   *
   * Why a separate service rather than counting desk.create_hub rows: the
   * form's THIRD workspace type, `personal`, is not a hub at all — it is a
   * home-root folder created through media.make_dir (see the comment in
   * media/form/index.js) — so it never touches desk.create_hub or yp.hub.
   * The form is the only place that knows which of the three types the user
   * asked for, so the form reports it and this records what it reported.
   */
  async track_workspace() {
    // The services_log row is already written by the router's `log` flag (see
    // above), so by the time we run, referral_members can already see this
    // workspace and will report the row's new status. Publishing before that
    // would push the status the user just left.
    // Coalesced and sent by service/private/_referral_live.js, which the
    // upload path uses too — see there for why the row is read back from
    // referral_members rather than assembled here.
    pushReferralLive(this, this.uid);
    this.output.data({ ok: 1 });
  }

  /**
   *
   * @param {*} s
   * @param {*} status
   * @returns
   */
  async set_online_status() {
    let r = await this.pushUserOnlineStatus();
    let status = 0;
    if (r && r[0]) status = r[0].my_state;
    this.output.data({ hub_id: this.uid, user_id: this.uid, status });

  }


  /**
   * 
   */
  async leave_hub() {
    const hub_id = this.input.use(Attr.nid);
    let sockets = await this.yp.await_proc('user_sockets', this.uid);
    let payload = { ...this.granted_node(), reason: 'leave', uid: this.uid };
    await this.changelog_write({ src: payload, event: "media.remove" });
    payload = this.payload(payload, { loopback: 1 });
    await RedisStore.sendData(payload, sockets);
    if (hub_id == this.uid) {
      this.exception.server("HUB_ID_NOT ALLOWED");
      return
    }
    await this.db.await_proc('leave_hub', hub_id);

    // Mirror to leaver's drumate in case they later lose hub visibility.
    const hub_db = await this.yp.await_func('get_db_name', hub_id);
    if (hub_db) {
      await writeAudit(this, {
        db: hub_db,
        uid: this.uid,
        action: 'left',
        category: 'member',
        notify_to: 'admin',
        entity_id: this.uid,
        log: `Member left workspace`,
      });
    }
    await writeAudit(this, {
      db: this.user.get(Attr.db_name),
      uid: this.uid,
      action: 'left',
      category: 'member',
      notify_to: 'admin',
      entity_id: hub_id,
      log: `Left workspace`,
    });

    this.output.data({ uid: this.uid, hub_id });
  }


  /**
   * The account schema is picked from the pool of hubs that are already created by offline process 
   */
  create_account() {
    const h = this.heap;
    const pw = this.input.need(Attr.password);

    this.yp.call_proc("drumate_create", pw, h.profile, (e, d, f) => {
      let error = 0;
      for (let r of d) {
        if (r[0] != null ? r[0].failed : undefined) {
          error = ~~(r[0] != null ? r[0].failed : undefined);
        }
      }
      if (error) {
        this.exception.user("Failed to create account", "desk_create_drumate failed");
      } else {
        this.yp.call_proc("get_visitor", h.ident, this.output.data);
      }
    });
  }

  /**
   * 
   */
  get_workers() {
    this.yp.call_proc("get_workers", this.uid, this.output.data);
  }


  /**
 *
 * @returns
 */
  async set_mfa() {
    const secret = this.input.need(Attr.secret);
    const code = this.input.need(Attr.code);
    const mfa = this.input.get("mfa");
    const otp = await this.yp.await_proc("secret_check", this.uid, secret, code);
    if (!otp || otp.code != code) {
      return this.output.data({ error: "INVALID_CODE" });
    }

    // profile.otp is the OTP delivery method consumed by
    // session.selectOtpMethod (server-core), which expects a name
    // ("email"/"sms"/"passkey"), not the on/off bit. Storing the bit
    // here triggers INVALID_OTP_METHOD on next sign-in. Email is the
    // only fully-wired method today, so default to that when MFA is on.
    const profile = {
      mfa,
      otp: parseInt(mfa) ? Attr.email : 0,
    };
    // SP drumate_update_profile expects a JSON STRING (it parses with
    // JSON_VALUE inside). Other callers in drumate.js stringify; passing
    // a raw object here let the driver coerce to "[object Object]" so the
    // whitelist walk silently skipped every field — mfa was never saved.
    await this.yp.call_proc("drumate_update_profile", this.uid, JSON.stringify(profile));
    await this.yp.await_proc("secret_clear", this.uid, "all");

    const user = await this.yp.await_proc("get_user", this.uid);
    this.output.data(user);
  }


  /**
   * 
   */
  get_alternate_account() {
    this.yp.call_proc("get_alternate_account", this.uid, this.output.data);
  }

  /**
   * 
   * @returns 
   */
  reorder() {
    const list = this.input.use(Attr.list);
    const cb = () => {
      this.output.data(list);
    };

    const count = after(list.length, cb);

    return (() => {
      const result = [];
      for (let item of list) {
        this.db.call_proc('mfs_update_rank', item.nid, item.index);
        result.push(count());
      }
      return result;
    })();
  }

  /**
   * Return recently modified files across all user hubs,
   * sorted by mtime DESC. Uses media_index (cross-hub, built by desk_search).
   * Hub nodes (workspaces) are excluded — shown separately by desk.home().
   */
  async recent_files() {
    const page = this.input.use(Attr.page, 1);
    const res = await this.db.await_proc('desk_recent_files', { page });
    this.output.list(res);
  }
}

module.exports = __private_desk;
