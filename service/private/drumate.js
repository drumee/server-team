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

const { existsSync } = require('fs');
const { resolve } = require('path');
const { isEmpty, isArray } = require('lodash');
const {
  Attr, toArray, Remit, Constants, sendSms,
  Messenger, DrumeeCache, RedisStore, Cache
} = require("@drumee/server-essentials")

const {
  INVALID_EMAIL_FORMAT,
  EMAIL_ALREADY_EXIST,
  WRONG_PASSWORD
} = Constants;

const { Entity, Generator, MfsTools } = require("@drumee/server-core");
const { get_node_content } = MfsTools;
const { purge_account } = require("../lib/account-purge");

// Contextual tutorial tour ids. See tutorial_seen() below for why this list is
// duplicated in acl/drumate.json and in ui-team's tours.js, and what a
// mismatch costs.
const __TUTORIAL_TOURS = ['workspace', 'folder_task', 'share', 'migrate'];

//########################################
class __private_drumate extends Entity {


  /**
   * 
   * @returns 
   */
  async hub_to_pro() {
    const self = this;
    let ident = this.input.need(Attr.ident);
    ident = ident.toLowerCase();
    let name = this.input.need(Attr.name)
    let metadata = {}
    let res = {};
    let chk;
    if (this.user.domain_id() > 1) {
      return this.output.data({ status: 'PRO_USER' });
    }

    let org = await this.yp.await_proc('organisation_get', name);
    if (!isEmpty(org)) {
      return this.output.data({ status: 'NAME_NOT_AVAILABLE' });
    }
    let domain = `${ident}.${process.env.domain_name}`;
    chk = await this.yp.await_proc('vhost_exists', domain);
    let dom = await this.yp.await_proc('domain_exists', domain);
    if (!isEmpty(chk) || !isEmpty(dom)) {
      return this.output.data({ status: 'URL_NOT_AVAILABLE' });
    }

    domain = await this.yp.await_proc('domain_create', ident);

    metadata.step = 'hub_to_pro'
    metadata.org_name = name
    metadata.org_ident = ident
    metadata.domain_id = domain.id;
    metadata.domain_name = domain.name;
    metadata.link = domain.name
    metadata.mode = 'hub_to_pro'

    await this.yp.await_proc('domain_grant', metadata.domain_id, Remit.dom_owner, this.uid, 1);
    await this.yp.await_proc('organisation_add', this.uid, metadata.org_name, metadata.link, metadata.org_ident, metadata.domain_id, metadata);
    await this.yp.await_proc('drumate_hub_to_pro', this.uid, domain.id, Remit.dom_owner);
    await this.yp.await_proc('ticket_grant_permission', this.uid);


    let profile = {}
    profile.email_verified = 'yes';
    profile.connected = '1';
    profile.profile_type = 'pro',
      profile.quota = DrumeeCache.getSysConf('quota')
    await this.yp.await_proc('drumate_update_profile', this.uid, JSON.stringify(profile));
    let sockets = await this.yp.await_proc('user_sockets', this.uid);
    await RedisStore.sendData(this.payload(domain), sockets);

    this.output.data(domain);
  }

  /**
   * 
   * @returns 
   */
  async challenge_pw() {
    const password = this.input.use(Attr.password) || this.input.use(Attr.old_password);
    let data = await this.yp.await_proc('check_password_next', this.uid, password);
    if (isEmpty(data)) {
      this.trigger(_e.denied);
      return
    }
  }

  /**
   * Change the user's email.
   *
   * Verifier branches on profile.password_set:
   *   - password_set=1 → require current password (server-side verification,
   *     not just the UI pre-check) so an attacker on the session can't
   *     change the email out from under the user.
   *   - password_set=0 → require email-OTP secret+code, the same flow we
   *     use for delete_account on OAuth-only users.
   *
   * Falls back to password verification when the flag is missing for
   * backward compatibility with legacy users.
   */
  async change_email() {
    const email = this.input.need(Attr.email);
    if (!email.isEmail()) {
      this.exception.user(INVALID_EMAIL_FORMAT);
      return;
    }

    const profile = this.parseJSON(this.user.get(Attr.profile)) || {};
    const usePassword = await this._resolveUsePassword(profile);

    if (usePassword) {
      const password = this.input.need(Attr.password);
      const ok = await this.yp.await_proc('check_password_next', this.uid, password);
      if (isEmpty(ok)) {
        this.exception.user(WRONG_PASSWORD);
        return;
      }
    } else {
      const secret = this.input.need(Attr.secret);
      const code = this.input.need(Attr.code);
      const otp = await this.yp.await_proc('secret_check', this.uid, secret, code);
      if (!otp || otp.code != code) {
        this.output.data({ error: 'INVALID_CODE' });
        return;
      }
      await this.yp.await_proc('secret_clear', this.uid, 'all');
    }

    let row = await this.yp.await_proc('email_exists', email);
    if (!isEmpty(row) && row.email) {
      this.exception.user(EMAIL_ALREADY_EXIST);
      return;
    }
    let data = await this.yp.await_proc('drumate_change_email', this.uid, email);
    this.output.data(data);
  }

  /**
   * 
   */
  check_password() {
    const password = this.input.get(Attr.password);
    this.debug("AAA:130", password)
    this.yp.call_proc('check_password_next', this.uid, password, this.output.data);
  }

  /**
   * 
   */
  change_mobile() {
    const user_id = this.user_id();
    const mobile = this.input.need(Attr.mobile);
    this.yp.call_proc('drumate_change_mobile', user_id, mobile, this.output.data);
  }


  /**
   * 
   * @returns 
   */
  async change_password() {
    const new_password = this.input.need(Attr.new_password);
    // Accept EITHER credential, strictly verifying whichever was sent —
    // same contract as unlink_oauth. The FE picks by the ACCOUNT's state:
    // password-backed accounts send old_password, accounts that never set
    // a password (OAuth signups) send an email OTP (secret + code). An
    // email OTP is equivalent proof to the forgot-password flow, so it is
    // also a valid way to (re)set the password of such an account.
    let r;
    const old_password = this.input.use(Attr.old_password);
    if (!isEmpty(old_password)) {
      r = await this.yp.await_proc('check_password_next', this.uid, old_password);
      if (isEmpty(r)) {
        this.output.data({ error: 'wrong_password' });
        return
      }
    } else {
      const secret = this.input.need(Attr.secret);
      const code = this.input.need(Attr.code);
      const otp = await this.yp.await_proc('secret_check', this.uid, secret, code);
      if (!otp || otp.code != code) {
        this.output.data({ error: 'INVALID_CODE' });
        return
      }
      await this.yp.await_proc('secret_clear', this.uid, 'all');
    }
    if (!new_password.match(/(.+){8,}/)) { //(/(.+){2,} +(.+){4,}/)
      this.output.data({ error: 'uncompliant_password' });
    } else {
      r = await this.yp.await_proc('set_password', this.uid, new_password);
      // Flag the account as password-backed so step-up flows
      // (delete_account, change_email) gate on password rather than OTP.
      await this.yp.call_proc('drumate_update_profile', this.uid, { password_set: 1 });
      // "Log out of other devices": drop every other session's cookie and
      // socket; the calling session (input.sid) survives. Best-effort — a
      // cleanup failure must not report the password change as failed.
      if (parseInt(this.input.use('logout_others', 0))) {
        try {
          await this.yp.await_proc('session_logout_others', this.uid, this.input.sid());
        } catch (e) {
          this.warn('change_password: session_logout_others failed:', e && e.message);
        }
      }
      this.output.data(r)
    }
  }

  /**
   * 
   */
  get_profile() {
    this.yp.call_proc('get_user', this.user.get(Attr.id), this.output.data);
  }
  /** 
   * 
  */
  async show_login_log() {
    const uaParser = require('ua-parser-js');
    let page = this.input.use(Attr.page, 1);
    let data = await this.yp.await_proc('show_login_log', this.uid, page);
    let res = [];
    let device = {};
    let md;
    data = toArray(data) || [];
    for (let row of data) {
      try {
        let d = uaParser(row.ua);
        if (d.type) {
          device.family = `${d.device.vendor}/${d.device.model}/${d.device.type}`;
        } else {
          device.family = `${d.os.name}/${d.browser.name}/${d.browser.version}`;
        }
        //this.debug("AAAA:148", device);
      } catch (e) {
        this.warn("GOT ERROR", row.metadata, e);
      }
      res.push({
        city: row.city,
        ip: row.ip,
        intime: row.intime,
        outtime: row.outtime,
        status: row.status,
        device,
      });
    }
    this.output.list(res);
  }

  /** Get One Time Password
   * If no phone, send by email
   *  @params {object} cur_profile -- as extracted from yp
   *  @params {object} args -- extra data to be sent back to frontend
   */
  async get_otp() {
    let { useSms } = global.myDrumee || {};
    if (!useSms) {
      this.exception.server("OTP_NOT_AVAILABLE");
      return
    }
    let profile = this.user.get(Attr.profile);
    if (isEmpty(profile)) {
      let user = await this.yp.await_proc('get_visitor', this.uid);
      profile = this.parseJSON(user.profile);
    }
    const token = this.randomString();
    const lang = this.client_language();
    let otp = await this.yp.await_proc('otp_create', this.uid, token);
    let message = DrumeeCache.message('_otp_code', lang);
    const Moment = require('moment');
    Moment.locale(lang);
    const expiry = Moment(otp.expiry, 'X').format("hh:mm");
    let phone = null;
    let email = null;
    let tips = null;
    try {
      phone = profile.mobile.phoneNumber()
    } catch {
      email = profile.email;
    }
    message = `${message.format(otp.code, expiry)}`;

    email = profile.email;
    if (phone) {
      let opt = {
        message,
        receivers: [phone]
      }
      sendSms(opt).send().then((result) => {
        if (!isEmpty(result.invalidReceivers)) {
          let msg = `${DrumeeCache.message('_invalid_recipient', lang)}`
          this.output.data({ error: `${msg} : ${result.invalidReceivers[0]}` });
          return;
        }
      })
      tips = phone.match(/(^.+)([0-9]{4,4})$/)[3];
      tips = tips;
    } else if (email) {
      const lang = this.client_language();
      const subject = DrumeeCache.message("_your_otp", lang);
      const fullname = this.user.get(Attr.fullname);
      const msg = new Messenger({
        template: "butler/otp",
        subject,
        recipient: email,
        lex: DrumeeCache.lex(lang),
        data: {
          subject,
          message,
          code: otp.code,
          firstname: this.user.get(Attr.firstname),
          fullname: fullname,
          recipient: fullname,
        },
        handler: this.exception.email
      });
      tips = email.match(/(^.+)(@)(.+)$/)
      tips = tips[3];
      await msg.send();
    } else {
      this.exception.user("Invalid profile");
      return;
    }
    otp.code = null;
    otp.tips = tips;
    this.output.data(otp);
  }

  /** Send One Time Password -- SMS
   *  @params {object} cur_profile -- as extracted from yp
   *  @params {object} args -- extra data to be sent back to frontend
   */
  async send_otp(cur_profile, args) {
    const token = this.randomString();
    const lang = this.client_language();
    let otp = await this.yp.await_proc('otp_create', this.uid, token);
    const message = DrumeeCache.message('_otp_code', lang);
    const Moment = require('moment');
    Moment.locale(lang);
    const expiry = Moment(otp.expiry, 'X').format("hh:mm");
    const mobile = `${cur_profile.areacode}${cur_profile.mobile}`
    let opt = {
      message: `${message.format(otp.code, expiry)}`,
      receivers: [mobile]
    }
    sendSms(opt).then((result) => {
      if (!isEmpty(result.invalidReceivers)) {
        let msg = `${DrumeeCache.message('_invalid_recipient', lang)}`
        this.output.data({ error: `${msg} : ${result.invalidReceivers[0]}` });
        return;
      }
      otp.code = '******';
      this.output.data({ ...otp, ...args });
    })
  }

  /** check_otp_and_change
   *  Check if there pending OTP
   */
  async check_otp_and_change() {
    let secret = this.input.use(Attr.secret);
    let code = this.input.use(Attr.code);
    if (secret && code) {
      let otp = await this.yp.await_proc('otp_check', this.uid, secret, code);
      if (isEmpty(otp)) {
        this.exception.user(WRONG_PASSWORD);
      } else {
        await this.yp.await_proc('otp_delete', this.uid, secret, code);
        await this.do_update_profile();
      }
      return true;
    }
    return false;
  }

  /** do_update_profile
   * 
   */
  async do_update_profile() {
    let profile = this.input.need(Attr.profile);
    const profile_str = JSON.stringify(profile);
    let data = await this.yp.await_proc(
      'drumate_update_profile',
      this.uid,
      profile_str
    );
    try {
      profile = this.parseJSON(data.profile);
      if (!isEmpty(profile.address)) {
        profile.address = this.parseJSON(profile.address);
      }

    } catch (e) {
      this.warn("GOT ERROR", e);
    }
    await this.yp.call_proc('contact_sync_update', this.uid);
    this.output.data(profile);
  }


  /**
   * 
   */
  async intro_acknowledged() {
    let profile = '{"intro":"no"}';
    let data = await this.yp.await_proc('drumate_update_profile', this.uid, profile);
    this.output.data(data);
  }

  /**
  * Mark onboarding as complete for current user
  */
  async mark_onboarding_complete() {
    let data = await this.yp.await_proc(
      'drumate_update_profile',
      this.uid,
      JSON.stringify({ onboarded: true })
    );
    this.output.data(data);
  }


  /**
   * 
   * @returns 
   */
  async update_profile() {
    let profile = this.input.need(Attr.profile);
    let cur_profile = {};
    try {
      cur_profile = this.user.get(Attr.profile);
    } catch {
      cur_profile = {};
    }
    if (await this.check_otp_and_change()) return;
    for (let key in profile) {
      if (['otp'].includes(key)) {
        if (cur_profile.otp != null) {
          await this.send_otp(cur_profile, { profile });
          return;
        }
      }
    }
    await this.do_update_profile();
  }

  /**
   * Get or create the signed-in user's referral code + link.
   * Reads the live reward DB from reward_hub_conf, calls the reward-hub
   * proc (idempotent get-or-create), and builds a per-tenant referral link.
   */
  async get_referral_code() {
    let rewardDb = null;
    try {
      rewardDb = JSON.parse(Cache.getSysConf('reward_hub_conf') || '{}').db_name;
    } catch (e) {
      rewardDb = null;
    }
    if (!rewardDb) {
      return this.output.data({ error: 'reward_not_configured' });
    }
    let code = null;
    try {
      const rows = toArray(await this.yp.await_proc(`${rewardDb}.reward_get_referral_code`, this.uid));
      code = (rows[0] || {}).referral_code || null;
    } catch (e) {
      this.warn('[drumate.get_referral_code] proc failed', e && e.message);
      return this.output.data({ error: 'referral_unavailable' });
    }
    if (!code) {
      return this.output.data({ error: 'referral_unavailable' });
    }
    const referral_url = `${this.input.homepath()}#/welcome/signup?ref=${encodeURIComponent(code)}`;
    this.output.data({ referral_code: code, referral_url });
  }

  /**
   *
   */
  async get_settings() {
    const user_id = this.input.need(Attr.user_id);
    let data = await this.yp.await_proc('get_entity_settings', user_id);
    let settings;
    if (isEmpty(data) || isEmpty(data.settings)) {
      settings = {};
    } else {
      settings = this.parseJSON(data.settings);
    }
    this.output.data(settings);
  }

  /**
   * 
   */
  async update_settings() {
    const settings = this.input.need(Attr.settings);
    let old_settings = this.user.get(Attr.settings) || {};
    const settings_str = JSON.stringify({ ...old_settings, ...settings });
    this.debug(`:::::${settings_str}:::::::: update_settings`);
    let res = await this.yp.await_proc('entity_update_settings', this.uid, settings_str);
    this.output.data(res);
  }

  /**
   * Record that one contextual tutorial tour has been shown to this user.
   *
   * Deliberately NOT routed through update_settings above: that one merges
   * only at the top level, and it merges from `this.user` — the session
   * snapshot taken when the request started, not a fresh read. Two sessions
   * recording two different tours would lose one of them, and a nested
   * `tutorials_seen` map posted through it would be replaced wholesale rather
   * than merged. drumate_tutorial_seen does the merge in one atomic UPDATE
   * against the current column value instead.
   *
   * ALLOW-LIST: these ids are a wire contract shared with two other files and
   * there is no mechanism in this stack for sharing a constant across them —
   * getServices() ships service NAMES to the client, not params. Adding a tour
   * means editing all three:
   *   - acl/drumate.json                             (the tour_id doc string)
   *   - ui-team src/drumee/modules/desk/tutorial/tours.js   (the TOURS keys)
   *   - here
   * A mismatch fails as a silently rejected write with no client-side symptom,
   * so the id is validated rather than passed through.
   */
  async tutorial_seen() {
    const reset = ~~this.input.use('reset');
    if (reset) {
      // QA reset. Dev-gated server-side rather than trusting the client flag,
      // so a normal account cannot clear its own seen-map and replay the tours.
      const profile = this.parseJSON(this.user.get(Attr.profile)) || {};
      if (!profile.devel) {
        return this.exception.forbiden();
      }
      const res = await this.yp.await_proc('drumate_tutorial_seen', this.uid, null, 1);
      return this.output.data(this._tutorialsSeen(res));
    }

    const tour_id = this.input.use('tour_id');
    if (!__TUTORIAL_TOURS.includes(tour_id)) {
      return this.exception.bad_request('INVALID_TOUR_ID');
    }
    const res = await this.yp.await_proc('drumate_tutorial_seen', this.uid, tour_id, 0);
    this.output.data(this._tutorialsSeen(res));
  }

  /**
   * The proc returns `tutorials_seen` as a JSON string (entity.settings is
   * mediumtext, not a native JSON column, so JSON_EXTRACT hands back text).
   * Normalise it to an object for the client, which reads it as a map.
   */
  _tutorialsSeen(res) {
    const row = isArray(res) ? res[0] : res;
    const raw = row && row.tutorials_seen;
    const map = (typeof raw === 'string' ? this.parseJSON(raw) : raw) || {};
    return { tutorials_seen: map };
  }

  /**
   * 
   */
  async disk_space() {
    let data = await this.db.await_proc('mfs_manifest', { nid: this.home_id, uid: this.uid, show_nodes: 0 });
    this.output.list(data);
  }

  /**
   * 
   */
  my_hubs() {
    const page = this.input.use('page', 1);
    this.db.call_proc("my_hubs", page, this.output.list);
  }

  /**
   * 
   * @returns 
   */
  contacts() {
    const page = this.input.use('page', 1);
    const only_drumate = this.input.use('only_drumate', 0);
    const key = this.input.use('value', "");
    if (isEmpty(key)) {
      this.output.data([]);
      return;
    }
    if (only_drumate) {
      this.db.call_proc("my_contact", key, page, JSON.stringify([]), 'active', this.output.list);
    }
    else {
      this.db.call_proc("contact_search_next", key, page, this.output.list);
    }
  }

  /**
   * Gets list of hubs that an user own or belongs to.
   */
  hubs() {
    const page = this.input.use('page', 1);
    this.db.call_proc("drumate_hubs", page, this.output.data);
  }

  /**
   * 
   */
  async helpdesk() {
    let temp_result = [];
    const ulang = this.input.get('Xlang') || this.user.language();
    const page = this.input.use('page', 1);
    let data = await this.yp.await_proc('helpdesk', ulang, page);
    if (isArray(data)) {
      data = [data]
    }
    for (let message of data) {
      message.metadata = this.parseJSON(message.metadata)
      temp_result.push(message);
    }
    this.output.data(temp_result);
  }

  /**
   * Adds a font to drumate's font table.
   * Not used yet
   */
  font_add() {
    const fontname = this.input.need(Attr.fontname);
    this.db.call_proc("font_add", fontname, this.output.data);
  }

  /**
   * 
   */
  font_last() {
    this.db.call_proc("font_last", this.output.data);
  }

  /**
   * Adds a color to drumate's color table.
   */
  color_add() {
    const rgba = this.input.need(Attr.rgba);
    const hexacode = this.input.need(Attr.hexacode);
    this.db.call_proc("color_add", rgba, hexacode, this.output.data);
  }

  /**
   * Gets last used colors.
   */
  color_last() {
    this.db.call_proc("color_last", this.output.data);
  }

  /**
   * 
   */
  async data_usage() {
    let quota = await this.yp.await_func("get_quota", this.uid) || {};
    let { usage } = await this.yp.await_proc("disk_usage", this.uid) || {};
    this.output.data({
      usage,
      quota
    });
  }

  /**
   * 
   */
  async show_backup_log() {
    const page = this.input.use(Attr.page, 1);
    var r = await this.db.await_proc("log_show_backup", page);
    this.output.list(r);
  }

  /**
   * Queue a full user-data export (personal files, hub files, P2P chat, activity logs).
   * Flags: personal | hubs | chat | logs
   * Runs as offline background process — sends download link via email on completion.
   */
  /**
   * Byte sizes for each backup category, so the export dialog can show what
   * the user is actually about to download.
   *
   * The dialog used to print fixed placeholder figures ("240 MB", "12 MB",
   * "88 MB", "2 MB") that were identical for every account and matched
   * nothing: the archive measured here came to 1.8 GB of source data against
   * a 342 MB total on screen.
   *
   * Files and workspace are counted from the same mfs_manifest rows and split
   * on the same `area == personal` test that offline/drumate/backup.js uses,
   * so the numbers describe the archive that command would actually build.
   * Chat and activity are CSV exports — their cost is the text itself, so the
   * message/row bytes are summed rather than guessed.
   */
  async backup_size() {
    const out = { files: 0, chat: 0, workspace: 0, activity: 0 };

    try {
      const hub = await this.yp.await_proc('get_hub', this.hub.get(Attr.id));
      if (hub?.db_name && hub?.home_id) {
        const result = await this.yp.await_proc(
          `${hub.db_name}.mfs_manifest`,
          { nid: hub.home_id, uid: this.uid, show_nodes: 1 }
        );
        for (const row of toArray(result?.[0])) {
          // The column is `filesize`; `size` doesn't exist on these rows and
          // silently read as undefined -> 0, which is how the dialog first
          // reported 0 B for an account holding 1.58 GB.
          const size = Number(row.filesize) || 0;
          if (row.area == Attr.personal) {
            // backup.js skips hub rows in the personal branch; mirror that or
            // the figure would count containers that never get archived.
            if (row.filetype !== Attr.hub) out.files += size;
          } else {
            out.workspace += size;
          }
        }
      }
    } catch (e) {
      this.warn('backup_size: manifest failed', e?.message);
    }

    try {
      const { db_name } = this.user.toJSON();
      const hubs = toArray(await this.yp.await_proc(`${db_name}.show_hubs`));
      for (const hub of hubs) {
        if (!hub.db_name) continue;
        const rows = toArray(await this.yp.await_query(
          `SELECT SUM(CHAR_LENGTH(IFNULL(message, ''))) AS bytes
             FROM \`${hub.db_name}\`.channel WHERE status != 'trashed'`
        ));
        out.chat += Number(rows?.[0]?.bytes) || 0;
      }
    } catch (e) {
      this.warn('backup_size: chat failed', e?.message);
    }

    try {
      const rows = toArray(await this.yp.await_query(
        `SELECT SUM(CHAR_LENGTH(IFNULL(args, ''))) + COUNT(*) * 64 AS bytes
           FROM yp.services_log WHERE uid = ?`, this.uid
      ));
      out.activity = Number(rows?.[0]?.bytes) || 0;
    } catch (e) {
      this.warn('backup_size: activity failed', e?.message);
    }

    this.output.data(out);
  }

  async backup() {
    const { spawn } = require('child_process');
    const SPAWN_OPT = { detached: true, stdio: ['ignore', 'ignore', 'ignore'] };

    const flags = this.input.need('flags');
    const socket_id = this.input.need(Attr.socket_id);
    const zipid = this.randomString();
    const email = this.user.get(Attr.email);
    const lang = this.user.language() || 'en';
    const { db_name, profile } = this.user.toJSON();
    const data = {
      uid: this.uid,
      hub_id: this.hub.get(Attr.id),
      zipid,
      socket_id,
      flags: Array.isArray(flags) ? flags : [flags],
      lang,
      email: profile.email,
      db_name
    };

    const cmd = resolve(__dirname, '../../offline/drumate', 'backup.js');
    const child = spawn(cmd, [JSON.stringify(data)], SPAWN_OPT);
    child.unref();

    this.output.json({ zipid, status: 'queued' });
  }

  /**
   * Confirm account deletion
   * @param {string} token - secret string required to validate account deletion
   */
  async unused_confirm_delete_account() {
    let secret = this.input.need(Attr.secret);
    const data = await this.yp.await_proc('token_get', secret);
    if (isEmpty(data)) {
      this.output.data({
        rejected: 1,
        reason: '_invalid_secret'
      });
      return;
    }
    let hubs = await this.db.await_proc('show_hubs');
    hubs = toArray(hubs) || [];
    for (let hub of hubs) {
      if (hub.owner_id == this.uid) {
        await this.notify_hub(hub.id, { service: "desk.leave_hub", id: hub.id });
        await this.yp.await_proc(`${hub.db_name}.remove_all_members`, 0);
      } else {
        await this.db.await_proc('leave_hub', hub.id);
      }
    }
    await this.yp.await_proc(`drumate_freeze`, this.uid);
    await this.yp.await_proc("token_delete", secret);
    secret = this.randomString();
    const fullname = this.user.get(Attr.fullname);
    let recipient = this.user.get(Attr.profile).email;
    await this.yp.await_proc('token_generate',
      recipient, fullname, secret, 'delete_account', this.uid);
    const lang = this.client_language();
    const subject = DrumeeCache.message("_account_reactivation_link", lang);
    const message = DrumeeCache.message("_account_deletion_email", lang);
    const link = `${this.input.homepath()}#/welcome/back=${secret}`;
    const Moment = require('moment');
    let date = Moment(this.input.timestamp / 1000 + 30 * 60 * 60 * 24, 'X')
      .format('dddd Do MMMM YYYY à hh:mm');
    const msg = new Messenger({
      template: "butler/deletion-revert-link",
      subject,
      recipient,
      lex: DrumeeCache.lex(lang),
      data: {
        subject,
        message,
        link,
        date,
        secret,
        firstname: this.user.get(Attr.firstname),
        fullname: fullname,
        recipient: fullname,
      },
      handler: this.exception.email
    });
    await msg.send();
    this.session.logout({ redirect: "#/welcome/checkout" });
  }

  /**
   * Prepare account deletion.
   *
   * Verifier branches on profile.password_set:
   *   - password_set=1 → password (current behaviour)
   *   - password_set=0 → email-OTP (secret + code via secret_check) so
   *     OAuth-only users (random UUID password) can delete their account.
   *
   * Falls back to password verification when the flag is missing for
   * backward compatibility with legacy users.
   */
  async delete_account() {
    const profile = this.parseJSON(this.user.get(Attr.profile)) || {};
    const usePassword = await this._resolveUsePassword(profile);

    if (usePassword) {
      const password = this.input.use(Attr.password);
      const data = await this.yp.await_proc('check_password_next', this.uid, password);
      if (isEmpty(data)) {
        this.output.data({ error: "WRONG_CREDENTIALS" });
        return;
      }
    } else {
      const secret = this.input.need(Attr.secret);
      const code = this.input.need(Attr.code);
      const otp = await this.yp.await_proc("secret_check", this.uid, secret, code);
      if (!otp || otp.code != code) {
        this.output.data({ error: "INVALID_CODE" });
        return;
      }
      await this.yp.await_proc("secret_clear", this.uid, "all");
    }

    // Deletion is immediate and permanent. drumate_freeze only parked the
    // account -- it held the address hostage behind a mangled 'uid/address'
    // value and, because it left the oauth_accounts / cookie rows in place,
    // every later sign-in re-bound the browser to the dead account and 403'd
    // the whole site instead of offering a fresh signup. Workspaces the account
    // owns are handed to a remaining member before it goes; see purge_account.
    await purge_account(this, this.uid);
    this.session.logout({ redirect: "#/welcome" });
  }

  /**
   * Return the OAuth providers linked to this user.
   * Used by the "Linked accounts" settings card to render the list.
   *
   * Returns: [{ provider, email, mtime }, ...]
   */
  async list_oauth_links() {
    const rows = await this.yp.await_query(
      'SELECT provider, email, ctime, mtime FROM oauth_accounts WHERE user_id = ? ORDER BY ctime ASC',
      this.uid
    );
    this.output.data(toArray(rows));
  }

  /**
   * Disconnect an OAuth provider from this account.
   *
   * Refuses if it would leave the account with NO way to authenticate:
   *   - password_set=0 AND removing the user's last oauth row → reject.
   * Otherwise deletes the oauth_accounts row.
   *
   * Sensitive — gated by the same password-or-OTP fork as delete_account.
   */
  /**
   * Mirror of settings_main._reconcilePasswordSet on the FE.
   * For legacy accounts where profile.password_set is unset, fall back
   * to "has at least one oauth row" → password_set=0 (OTP path).
   * Otherwise the FE picks OTP but the server demands a password.
   */
  async _resolveUsePassword(profile) {
    let passwordSet = profile && profile.password_set;
    if (passwordSet === undefined || passwordSet === null) {
      const row = await this.yp.await_query(
        'SELECT COUNT(*) AS n FROM oauth_accounts WHERE user_id = ?',
        this.uid
      );
      const hasOauth = ((row && row.n) || 0) > 0;
      passwordSet = hasOauth ? 0 : 1;
    }
    return parseInt(passwordSet) === 1;
  }

  async unlink_oauth() {
    const provider = this.input.need('provider');

    // Accept EITHER credential — FE picks which to ask based on whether
    // 2FA is enabled and whether the user has a password. The server
    // doesn't trust profile.password_set (it can drift out of sync with
    // the actual fingerprint column) — it just verifies whichever
    // credential is sent.
    const password = this.input.use(Attr.password);
    const secret = this.input.use(Attr.secret);
    const code = this.input.use(Attr.code);

    let userHasPassword = false;

    if (password) {
      const ok = await this.yp.await_proc('check_password_next', this.uid, password);
      if (isEmpty(ok)) {
        this.output.data({ error: "WRONG_CREDENTIALS" });
        return;
      }
      userHasPassword = true;
      // Self-heal: successful password verification proves the user has
      // a password set, so reconcile the flag for future step-up flows.
      const profile = this.parseJSON(this.user.get(Attr.profile)) || {};
      if (parseInt(profile.password_set) !== 1) {
        try {
          await this.yp.call_proc('drumate_update_profile', this.uid, { password_set: 1 });
        } catch (e) {
          this.warn('unlink_oauth: failed to self-heal password_set', e);
        }
      }
    } else if (secret && code) {
      const otp = await this.yp.await_proc("secret_check", this.uid, secret, code);
      if (!otp || otp.code != code) {
        this.output.data({ error: "INVALID_CODE" });
        return;
      }
      await this.yp.await_proc("secret_clear", this.uid, "all");
      const profile = this.parseJSON(this.user.get(Attr.profile)) || {};
      userHasPassword = parseInt(profile.password_set) === 1;
    } else {
      this.output.data({ error: "VERIFICATION_REQUIRED" });
      return;
    }

    // Lockout guard: only block if the user genuinely has no other way
    // back in. With password set, removing all oauth is safe.
    if (!userHasPassword) {
      const remaining = await this.yp.await_query(
        'SELECT COUNT(*) AS n FROM oauth_accounts WHERE user_id = ? AND provider != ?',
        this.uid, provider
      );
      const left = (remaining && remaining.n) || 0;
      if (left === 0) {
        this.output.data({ error: "LAST_AUTH_METHOD" });
        return;
      }
    }

    await this.yp.await_query(
      'DELETE FROM oauth_accounts WHERE user_id = ? AND provider = ?',
      this.uid, provider
    );
    this.output.data({ status: "ok", provider });
  }

  /**
   * Allow OAuth-only users (password_set=0) to set a password for the
   * first time. Gated by an email-OTP step so an attacker on the
   * session can't add a password that locks the user out.
   *
   * Once set, password_set flips to 1 and the user can sign in either
   * way. Refuses if password_set=1 already (use change_password instead).
   */
  async set_initial_password() {
    const profile = this.parseJSON(this.user.get(Attr.profile)) || {};
    if (parseInt(profile.password_set) === 1) {
      this.output.data({ error: "ALREADY_HAS_PASSWORD" });
      return;
    }

    const password = this.input.need(Attr.password);
    if (!password.match(/(.+){8,}/)) {
      this.output.data({ error: "uncompliant_password" });
      return;
    }

    const secret = this.input.need(Attr.secret);
    const code = this.input.need(Attr.code);
    const otp = await this.yp.await_proc("secret_check", this.uid, secret, code);
    if (!otp || otp.code != code) {
      this.output.data({ error: "INVALID_CODE" });
      return;
    }
    await this.yp.await_proc("secret_clear", this.uid, "all");

    await this.yp.await_proc("set_password", this.uid, password);
    await this.yp.call_proc("drumate_update_profile", this.uid, { password_set: 1 });

    const user = await this.yp.await_proc("get_user", this.uid);
    this.output.data(user);
  }

  /**
   * Set user avatar using a media available in MFS
   * @param {string} reference - media id from MFS
   */
  async set_avatar() {
    const nid = this.input.use('reference');
    let node = await this.db.await_proc("mfs_node_attr", nid);
    if (isEmpty(node)) {
      this.exception.not_found("no_avatar");
      return;
    }
    const orig = get_node_content(node);
    if (!existsSync(orig)) {
      this.exception.not_found("no_avatar");
      return;
    }

    Generator.create_avatar(nid, node.ext, this.user.get(Attr.home_dir), orig);
    await this.yp.await_proc('entity_touch', this.uid);
    let data = await this.yp.await_proc('get_visitor', this.uid);
    this.output.data(data);
  }

  /**
   * 
   */
  async remove_avatar() {
    const root = this.user.get(Attr.home_dir)
    const { join } = require('path');
    const png = join(root, '__config__/icons/avatar*.png')
    const svg = join(root, '__config__/icons/avatar*.svg');
    const orig = join(root, '__config__/icons/tmp.*');
    const { rm } = require('shelljs');
    try {
      rm('-f', png);
    } catch (e) {
      this.debug("REMOVE AVATAR", e);
    };
    try {
      rm('-f', svg);
    } catch (e) {
      this.debug("REMOVE AVATAR", e);
    };

    try {
      rm('-f', orig);
    } catch (e) {
      this.debug("REMOVE AVATAR", e);
    };

    await this.yp.await_proc('entity_touch', this.uid);
    let data = await this.yp.await_proc('get_visitor', this.uid);
    this.output.data(data);
  }

  /**
   * 
   */
  set_lang() {
    // supportedLanguage(falsy) returns the whole supported-language ARRAY —
    // storing that into profile.lang corrupts the value every page render
    // and every outgoing notification reads. Refuse a call without Xlang
    // instead of persisting garbage.
    const xlang = this.input.get('Xlang');
    if (!xlang) {
      return this.output.data({ status: 'LANG_REQUIRED' });
    }
    let lang = this.supportedLanguage(xlang);
    this.yp.call_proc('drumate_set_lang', this.user_id(), lang, this.output.data);
  }

  /**
   * 
   */
  privacy() {
    let lang = this.supportedLanguage(this.input.get('Xlang')); // Don't use Attr.lang, because it's superset by core/io
    this.yp.call_proc('drumate_set_privacy', this.user_id(), lang, this.output.data);
  }

  /**
   * 
   */
  async logout() {
    let data = {
      session_id: this.input.sid()
    }
    let device_id = this.input.get("device_id");
    if (device_id)
      await this.yp.await_proc('unregister_user_with_device',
        device_id
      );

    let sockets = await this.yp.await_proc('user_sockets', this.uid);
    sockets = toArray(sockets).filter((e) => { return e.cookie == data.session_id })

    await RedisStore.sendData(this.payload(data), sockets);

    this.session.logout();
  }


  /**
   * 
   */
  async notification_remove() {
    let r = { ok: 1 };
    const entity_id = this.input.use(Attr.entity_id) || '';
    let message;
    let tickets;
    let entity = 'hub';
    if (isEmpty(entity_id)) {
      entity = 'empty';
    } else {
      let drumate = await this.yp.await_proc('drumate_exists', entity_id);
      if (!isEmpty(drumate)) { entity = 'drumate' }
    }

    let data = await this.db.await_proc("notification_remove_next", entity_id);

    switch (entity) {
      case 'hub':
        message = await this.yp.await_proc('forward_proc', entity_id, 'channel_get_last', `'${this.uid}'`);
        break;
      case 'drumate':
        message = await this.db.await_proc("channel_get_last", entity_id);
        await this.db.await_proc('list_message', { page: 1, entity_id });
        this.debug("AAA:896", message);
        break;
    }

    let sockets = await this.yp.await_proc('user_sockets', this.uid);
    await RedisStore.sendData(this.payload({ ok: 1 }), sockets);

    let service = "chat.acknowledge";
    if (!isEmpty(message)) {
      switch (entity) {
        case 'drumate':
          sockets = await this.yp.await_proc('user_sockets', [message.author_id, this.uid]);
          break;
        case 'hub':
          message.hub_id = entity_id
          sockets = await this.yp.await_proc('user_sockets', this.uid);
      }
      await RedisStore.sendData(this.payload(message, { service }), sockets);
    }


    if (!isEmpty(tickets) && entity == 'Support Ticket') {
      for (let msg of toArray(tickets)) {
        msg.is_seen = 1
        sockets = await this.yp.await_proc('user_sockets', this.uid);
        await RedisStore.sendData(this.payload(msg, { service }), sockets);

        let support = await this.yp.call_proc('member_list_all', this.uid,
          DrumeeCache.getSysConf('support_domain')
        );
        let dest = [];
        for (let member of toArray(support)) {
          if (this.uid == member.drumate_id) continue;
          dest.push(member.drumate_id);
        }
        sockets = await this.yp.await_proc('user_sockets', dest);
        await RedisStore.sendData(this.payload(msg, { service }), sockets);
      }
    }

    this.output.data(r);
  }

  /**
   * 
   */
  async notification_center() {
    var r = await this.db.await_proc("notification_center_next");
    this.output.list(r);
  }

  /**
   * 
   */
  get_drumate_detail() {
    const id = this.input.need(Attr.id);
    this.yp.call_proc('drumate_exist', id, this.output.data);
  }

  /**
   * 
   * @returns 
   */
  async update_ident() {
    const ident = this.input.need(Attr.ident);
    const id = this.input.need(Attr.id);
    let chk;
    let my_org = await this.yp.await_proc('my_organisation', id)
    if (isEmpty(my_org)) {
      chk = await this.yp.await_proc('get_user_in_domain', ident, 1)
    }
    else {
      chk = await this.yp.await_proc('get_user_in_domain', ident, my_org.domain_id)
    }

    if (chk.exists == 1) {
      this.exception.user('_ident_already_exists');
      return
    }

    let profile = {};
    if (!isEmpty(ident)) {
      profile.ident = ident
      profile.username = ident
    }
    await this.yp.call_proc('drumate_update_profile', id, JSON.stringify(profile));
    await this.yp.await_proc('drumate_change_username', id, ident);
    let res = await this.yp.await_proc('get_visitor', id);
    this.output.data(res);
  }
}


module.exports = __private_drumate;
