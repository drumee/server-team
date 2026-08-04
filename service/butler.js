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
  Attr, Constants, sendSms, Messenger, Cache, sysEnv, uniqueId, RedisStore
} = require("@drumee/server-essentials");
const { platform } = require('./lib/env');
const { logConnection } = require('./lib/connection_log');
const { resolve } = require('path');
const { isEmpty, isString } = require("lodash");
const { notifyMemberJoined } = require("./lib/notify-member-joined");
const {
  PASS_CHECKER,
  ID_NOBODY,
  FORGOT_PASSWORD,
  INVALID_EMAIL_FORMAT,
} = Constants;
const { Mfs } = require("@drumee/server-core");

const { stringify } = JSON;

// Lifetime of a password-reset link, in seconds (1 hour). Enforced in both
// check_token (open/recheck) and set_password (actual set) — keep it single-
// sourced so the two checks can never drift out of sync.
const RESET_TOKEN_TTL = 3600;

class __butler extends Mfs {

  constructor(...args) {
    super(...args);
    this.platform = platform.bind(this);
  }

  /**
   * 
   */
  async join_contact(secret, user_id, inviter_id) {
    let { db_name } = await this.yp.await_proc('get_entity', user_id);
    let data = await this.yp.await_proc(
      `${db_name}.contact_join`, secret
    );
    if (!isEmpty(data)) {
      data = await this.yp.await_proc(
        `${db_name}.contact_notification_by_entity`,
        inviter_id
      );
      data.service = "contact.invite_accept";
      this.notify_user(inviter_id, data);
    }
  }

  /**
   * 
   */
  async send_otp(mobile, uid) {
    const token = this.randomString();
    const lang = this.user.language() || this.input.app_language();
    let otp = await this.yp.await_proc("otp_create", uid, token);
    const message = Cache.message("_otp_code", lang);
    const Moment = require("moment");
    Moment.locale(lang);
    const expiry = Moment(otp.expiry, "X").format("hh:mm");
    let opt = {
      message: `${message.format(otp.code, expiry)}`,
      receivers: [mobile],
    };
    try {
      let { invalidReceivers } = await sendSms(opt) || {};
      if (!isEmpty(invalidReceivers)) {
        return 0;
      }
      return otp;
    } catch (e) {
      return null;
    }
  }


  /**
   * 
   */
  async get_otp() {
    let r = await this.send_otp();
    if (r) {
      this.output.status(Attr.ok)
    } else {
      this.output.status(Attr.error)
    }
  }

  /**
   * Check tocken
   * @param {string} secret - token to be cheked
   */
  async check_token() {
    const secret = this.input.need(Attr.secret);
    let data = await this.yp.await_proc("token_get_next", secret);
    let a;
    if (data && isString(data.metadata)) {
      let md = {};
      try {
        md = this.parseJSON(data.metadata);
      } catch (e) { }
      if (md.mobile && data.method == "forgot_password") {
        let mobile = md.mobile;
        md.mobile = mobile.substr(mobile.length - 4);
      }
      data.metadata = md;
    }

    try {
      a = data.email.split("@");
    } catch (e) {
      this.output.data({ error: "INVALID_LINK" });
      // this.exception.user("invalid_token");
      return;
    }

    if (data.status != "active") {
      this.output.data({ error: 'LINK_EXPIRES' });
      // this.exception.user("invalid_token");
      return;
    }

    // Password-reset links expire RESET_TOKEN_TTL seconds after creation.
    if (
      data.method == "forgot_password" &&
      data.ctime &&
      Math.floor(Date.now() / 1000) - Number(data.ctime) > RESET_TOKEN_TTL
    ) {
      await this.yp.await_proc("token_delete", secret);
      this.output.data({ error: 'LINK_EXPIRES' });
      return;
    }

    // Check if email is already a registered Drumee user
    if (data.method === 'signup') {
      const existingUser = await this.yp.await_proc('drumate_exists', data.email);
      if (!isEmpty(existingUser) && existingUser.id) {
        data.user_exists = true;
        data.uid = existingUser.id;
      }
    }

    a = a[0].split(/[\.-_]/);
    const base = a[0] || "a";
    let i = await this.yp.await_proc("unique_ident", base);
    data.ident = i.ident;
    this.output.data(data);
  }

  /**
   * Generate a secret and send by email
   * @param {string} email - email required to send the secret token to
   */
  async get_reset_token() {
    const email = this.input.need(Attr.email).trim();
    if (!email.isEmail()) {
      this.output.data({
        rejected: INVALID_EMAIL_FORMAT,
      });
      return;
    }

    let user = await this.yp.await_proc("get_visitor", email);
    if (isEmpty(user) || user.id === ID_NOBODY) {
      this.output.data({});
      return null;
    }
    const token = this.randomString();
    await this.yp.await_proc(
      "token_generate_next",
      email,
      email,
      token,
      FORGOT_PASSWORD,
      user.id
    );

    if (token == null) {
      this.exception("Failed to create link");
      return;
    }
    const ulang = this.input.ua_language();
    const link = `${this.input.homepath()}#/welcome/reset/${user.id}/${token}`;
    const subject = Cache.message("_password_reset_link", ulang);
    const { main_domain } = sysEnv();
    const msg = new Messenger({
      template: "butler/password-forgot",
      subject,
      recipient: email,
      lex: Cache.lex(ulang),
      data: {
        icon: this.hub.get(Attr.icon),
        recipient: user.fullname,
        link,
        home: main_domain,
      },
      handler: this.exception.email,
    });
    await msg.send();
    this.output.data({ email });
  }

  /**
   *
   * @returns
   */
  async set_password() {
    const secret = this.input.need(Attr.secret);
    const pw = this.input.need(Attr.password);
    const id = this.input.need(Attr.id);
    let res = {};
    let metadata = {};
    let pass = {};
    let drumate;

    if (!PASS_CHECKER.test(pw)) {
      return this.output.data({ status: "BAD_PASSWORD" });
    }

    drumate = await this.yp.await_proc("drumate_exists", id);
    if (isEmpty(drumate)) {
      return this.output.data({ status: "DRUMATE_NOT_EXISTS" });
    }

    pass = await this.yp.await_proc("token_get_next", secret);

    if (isEmpty(pass)) {
      return this.output.data({ status: "INVALID_SECRET" });
    }
    if (pass.status != "active") {
      return this.output.data({ status: "INVALID_SECRET" });
    }
    if (pass.method != "forgot_password") {
      return this.output.data({ status: "INVALID_METHOD" });
    }
    // Reset links expire after RESET_TOKEN_TTL seconds — never set a password
    // from a stale link, even if the client somehow reached this point.
    if (pass.ctime && Math.floor(Date.now() / 1000) - Number(pass.ctime) > RESET_TOKEN_TTL) {
      await this.yp.await_proc("token_delete", secret);
      return this.output.data({ status: "INVALID_SECRET" });
    }

    metadata = this.parseJSON(pass.metadata);
    if (metadata.step != "password") {
      return this.output.data({ status: "INVALID_STEP" });
    }

    drumate = await this.yp.await_proc("drumate_exists", pass.email);
    if (isEmpty(drumate)) {
      return this.output.data({ status: "DRUMATE_NOT_EXISTS" });
    }
    drumate = await this.yp.await_proc("set_password", id, pw);
    // Forgot-password flow is a real password set — flag the account
    // as password-backed even if it was previously OAuth-only.
    await this.yp.call_proc("drumate_update_profile", id, { password_set: 1 });
    let connection = "offline";
    if ([1, "1", "sms"].includes(drumate.otp)) {
      metadata.step = "otpverify";
      metadata.uid = id;
      metadata.mobile = drumate.mobile;
      metadata.areacode = drumate.areacode;

      let data = await this.send_otp(
        `${metadata.areacode}${metadata.mobile}`,
        metadata.uid
      );
      delete metadata["otp_secret"];
      if (!isEmpty(data)) {
        metadata.otp_secret = data.secret;
      }
      await this.yp.await_proc("token_update", secret, metadata);
      res = await this.yp.await_proc("token_get_next", secret);
      connection = "otp";
    } else {
      let profile = {};
      profile.email_verified = "yes";
      profile.connected = "1";
      await this.yp.call_proc("drumate_update_profile", id, stringify(profile));
      //let domain = await this.yp.await_func("domain_name", sid);
      let opt = {
        uid: id,
        password: pw,
        sid: this.input.sid(),
        host: drumate.domain
      }
      let log = await this.yp.await_proc("session_signin", opt);
      metadata.step = "complete";
      await this.yp.await_proc("token_update", secret, metadata);
      res = await this.yp.await_proc("token_get_next", secret);
      await this.yp.await_proc("token_delete", secret);
      connection = "online";
    }
    if (!isEmpty(res)) {
      if (res.metadata != null) {
        res.metadata = {};
        res.metadata.step = metadata.step;
        if (!isEmpty(metadata.mobile)) {
          res.metadata.mobile = metadata.mobile.substr(
            metadata.mobile.length - 4
          );
        }
      }
    }
    let user = await this.yp.await_proc("get_user", drumate.id);
    this.output.data({ ...user, ...res, connection });
  }

  /**
   *
   */
  async password_otpresend() {
    const secret = this.input.need(Attr.secret);
    // let mobile = this.input.use(Attr.mobile)
    let res = {};
    let metadata = {};
    let pass = {};

    pass = await this.yp.await_proc("token_get_next", secret);
    if (isEmpty(pass)) {
      return this.output.data({ status: "INVALID_SECRET" });
    }
    if (pass.status != "active") {
      return this.output.data({ status: "INVALID_SECRET" });
    }

    if (pass.method != "forgot_password") {
      return this.output.data({ status: "INVALID_METHOD" });
    }

    metadata = this.parseJSON(pass.metadata);
    if (metadata.step != "otpresend" && metadata.step != "otpverify") {
      return this.output.data({ status: "INVALID_STEP" });
    }

    let data = await this.send_otp(
      `${metadata.areacode}${metadata.mobile}`,
      metadata.uid
    );

    delete metadata["otp_secret"];
    if (!isEmpty(data)) {
      metadata.otp_secret = data.secret;
    }
    metadata.step = "otpverify";
    await this.yp.await_proc("token_update", secret, metadata);
    res = await this.yp.await_proc("token_get_next", secret);
    if (!isEmpty(res)) {
      if (res.metadata != null) {
        res.metadata = {}; // this.parseJSON(res.metadata)
        res.metadata.step = metadata.step;
        if (!isEmpty(metadata.mobile)) {
          res.metadata.mobile = metadata.mobile.substr(
            metadata.mobile.length - 4
          );
        }
      }
    }
    this.output.data(res);
  }

  /**
   *
   * @returns
   */
  async password_otpverify() {
    let secret = this.input.use(Attr.secret);
    let code = this.input.use(Attr.code);
    let res = {};
    let profile = {};
    let metadata = {};
    let pass = {};

    pass = await this.yp.await_proc("token_get_next", secret);
    if (isEmpty(pass)) {
      return this.output.data({ status: "INVALID_SECRET" });
    }
    if (pass.status != "active") {
      return this.output.data({ status: "INVALID_SECRET" });
    }

    if (pass.method != "forgot_password") {
      return this.output.data({ status: "INVALID_METHOD" });
    }

    metadata = this.parseJSON(pass.metadata);
    if (metadata.step != "otpverify") {
      return this.output.data({ status: "INVALID_STEP" });
    }
    let otp = await this.yp.await_proc(
      "otp_check",
      metadata.uid,
      metadata.otp_secret,
      code
    );
    if (!isEmpty(otp)) {
      metadata.step = "complete";

      profile.email_verified = "yes";
      profile.mobile_verified = "yes";
      profile.connected = "1";
      await this.yp.call_proc(
        "drumate_update_profile",
        metadata.uid,
        stringify(profile)
      );

      await this.yp.await_proc("token_update", secret, metadata);
      res = await this.yp.await_proc("token_get_next", secret);
      await this.yp.await_proc(
        "session_login_otp",
        metadata.uid,
        code,
        metadata.otp_secret,
        this.input.sid()
      );
      // session_login_otp above OPENS A SESSION -- completing a forgot-password
      // reset signs the user straight in -- and it is a plain proc, so it writes
      // no services_log row. Without this the reset is a way into the product
      // that never registers as a login. (The call this replaces was commented
      // out and named a method that does not exist on this class.)
      await logConnection(this, metadata.uid);
      await this.yp.await_proc("token_delete", secret);
      await this.yp.await_proc(
        "otp_delete",
        metadata.uid,
        metadata.otp_secret,
        code
      );
    } else {
      metadata.step = "otpresend";
      await this.yp.await_proc("token_update", secret, metadata);
      res = await this.yp.await_proc("token_get_next", secret);
    }
    if (!isEmpty(res)) {
      if (res.metadata != null) {
        res.metadata = {}; // this.parseJSON(res.metadata)
        res.metadata.step = metadata.step;
        if (!isEmpty(metadata.mobile)) {
          res.metadata.mobile = metadata.mobile.substr(
            metadata.mobile.length - 4
          );
        }
      }
    }
    this.output.data(res);
  }


  /**
   *
   */
  async check_domain() {
    let url = this.input.get(Attr.domain) || this.input.host();
    const { main_domain } = sysEnv();
    let res = {};
    let domain = url;

    try {
      domain = new URL(url).hostname;
    } catch (err) { }
    res.isvalid = 0;
    domain = domain.replace(/^(.*\/\/)/, "").replace(/\/.*$/, "");
    let org = await this.yp.await_proc("organisation_get", domain);
    if (!org?.url) {
      res.url = domain;
      return this.output.data(res);
    }
    let hub = await this.yp.await_proc("get_hub", org.url);
    let user = await this.yp.await_proc("get_user", this.uid);
    if (!user?.id) {
      user = {
        uid: this.uid,
        id: this.uid,
        profile: {},
        ident: this.session.ident(),
        username: this.session.ident(),
        signed_in: 0,
        settings: {},
        organisation: org
      }
    }
    user.main_domain = main_domain;
    this.session.refreshAuthorization();
    let data = {
      organization: {
        url: org.link,
        name: org.name,
        domain_id: user.domain_id,
        username: user.username,
        uid: user.id,
        ...org,
      },
      hub,
      user,
      platform: this.platform(),
      isvalid: 1,
      main_domain,
    }
    this.output.data(data);
  }

  /**
   * Set new password through reset link
   * @param {string} secret - secret sent by email
   * @param {string} id - sdrumate id
   * @param {string} password - new password
   */
  async set_pass_phrase() {
    const secret = this.input.need(Attr.secret);
    const id = this.input.need(Attr.id);
    const pw = this.input.need(Attr.password);
    if (!PASS_CHECKER.test(pw)) {
      this.output.data({
        rejected: 1,
        reason: "bad_pass",
      });
      return;
    }
    let user = await this.yp.await_proc("drumate_get", id);
    if (isEmpty(user) || user.id === ID_NOBODY) {
      this.output.data({
        rejected: 1,
        reason: "not_found",
      });
      return;
    }
    let data = await this.yp.await_proc(
      "token_check",
      user.email,
      secret,
      FORGOT_PASSWORD
    );
    if (isEmpty(data)) {
      this.output.data({
        rejected: 1,
        reason: "not_found",
      });
      return;
    }
    if (data.age / 3600 > 12) {
      await this.yp.await_proc("token_delete", secret);
      this.output.data({
        rejected: 1,
        reason: "expired",
      });
      return;
    }

    await this.yp.await_proc("set_password", user.id, pw);
    // Token-based password set is a real password — flag the account
    // as password-backed for downstream step-up auth.
    await this.yp.call_proc("drumate_update_profile", user.id, { password_set: 1 });
    await this.yp.await_proc("token_delete", secret);
    this.output.data(user);
  }

  /**
   * The account schema is picked from the pool of hubs that are already created by offline process 
   */
  async _create_account(data) {
    const { main_domain: domain } = sysEnv();
    let {
      email,
      firstname = "",
      password,
    } = data;
    let username = firstname || email.split('@')[0];
    username = username.replace(/[^a-zA-Z0-9]/g, '');// Accept only ascci alphanum
    username = await this.yp.await_func("ensure_username", { username: username.toLowerCase(), domain });
    let a = firstname.split(/ +/)
    let lastname = "";
    if (a.length > 1) {
      firstname = a[0]
      a.shift()
      lastname = a.join(' ')
    }
    let profile = {
      username,
      sharebox: uniqueId(),
      otp: 0,
      category: "trial",
      profile_type: "trial",
      lang: this.user.language() || this.input.app_language(),
      firstname,
      lastname,
      email,
      // Local signup — real password supplied by user. Step-up flows
      // (delete_account, change_email) will gate on password instead of OTP.
      auth_method: "local",
      password_set: 1,
    }

    let user = await this.yp.await_proc("drumate_create", password, profile);
    if (!user || !user[0]) {
      return { ...profile, error: 1, status: "unknown_error" }
    }

    if (user[0].failed) {
      return { ...profile, error: 1, status: "db_error", ...user[0] }
    }
    let { permission, failed } = user[0];
    let { drumate } = user[2] || {};
    if (drumate && permission) {
      try {
        await this.session.login({ ident: email, password }, 0);
        return { error: 0, failed, status: "ok" }
      } catch (e) {
        this.warn("Auto login failed", e)
        return { error: 1, failed, status: "internal_error" }
      }
    }
    return { error: 1, failed, status: "unexpected_error" }
  }

  /**
   * 
   */
  async signup() {
    const socket_id = this.input.need(Attr.socket_id);
    const password = this.input.need(Attr.password).trim();
    const email = this.input.need(Attr.email).trim();
    const firstname = this.input.get(Attr.firstname);

    let bound = await this.yp.await_func("socket_check_binding", socket_id, this.input.sid());
    if (!bound) {
      return this.output.data({ status: "not_bound" });
    }

    let existingUser = await this.yp.await_proc("drumate_exists", email);
    if (existingUser && existingUser.email) {
      return this.output.data({ status: "user_exists", email });
    }

    let accountData = { socket_id, password, email, firstname };
    accountData = await this._create_account(accountData);  
    
    let tpl = resolve(__dirname, "./templates/welcome.html");
    switch (accountData.failed) {
      case 0: {
        /** Output done by session.login */
        const ulang = "en";
        let lex = Cache.lex(ulang);
        const { main_domain } = sysEnv();
        let mailData = {
          heading: lex._your_account_is_all_set,
          message: lex._mail_signup_drumee,
          workspace: lex._discover_drumee_desk,
          link: `https://${main_domain}/-/`,
          signature: lex._drumee_team,
          reminder: lex._copyright.format(`${new Date().getFullYear()}`),
          hello: lex._hello_x.format(firstname || ""),
        };
        const msg = new Messenger({
          subject: lex._welcome_on_drumee,
          recipient: email,
          handler: this.exception.email,
        });
        let html = msg.renderFrom(tpl, mailData);
        await msg.send({ html });

        // Resolve pending hub invitations registered before account existed
        try {
          await this._resolve_pending_invitation(email);
        } catch (err) {
          this.warn("[signup] Failed to resolve pending_invitation for", email, err && err.message);
        }

        return;
      }
      case 2:
        return this.output.data({ status: 'server_busy' });
      default: {
        this.warn("Failed to create drumate", accountData);
        if (accountData.error) {
          return this.output.data({ status: 'server_error' });
        }
      }
    }

    if (!accountData.error) {
      /** Output done by session.login */
      return;
    }

    return this.output.data(accountData);
  }

  /**
  * After a new user completes signup, resolve any pending hub invitations
  * that were registered via yp_add_pending_invitation before the account existed.
  *
  * @param {string} email - newly registered user's email
  */
  async _resolve_pending_invitation(email) {
    const { toArray } = require("@drumee/server-essentials").utils;
    const { isEmpty } = require("lodash");

    // 1. Get new user's ID
    const newUser = await this.yp.await_proc("drumate_exists", email);
    if (isEmpty(newUser) || !newUser.id) {
      this.warn("[_resolve_pending_invitation] Cannot find newly created user for", email);
      return;
    }

    // 2. Find all pending hub invitations for this email
    const pending = await this.yp.await_proc("pending_invitation_get_by_email", email);
    const rows = toArray(pending);
    if (isEmpty(rows)) return;

    for (const row of rows) {
      const { hub_id, permission, expiry_time } = row;
      try {
        // 3. Get hub db_name explicitly
        const db_name = await this.yp.await_func("get_db_name", hub_id);
        if (!db_name) {
          this.warn(`[_resolve_pending_invitation] Cannot find db_name for hub ${hub_id}`);
          continue;
        }

        // 4. Add as real member
        await this.yp.await_proc(`${db_name}.add_member`, newUser.id, permission, expiry_time);

        // 5. Grant hub permission
        await this.yp.await_proc(
          `${db_name}.permission_grant`,
          '*', newUser.id, expiry_time, permission, 'system', 'Resolved from pending_invitation on signup'
        );

        // Audit: invite redeemed on signup — never let a failure break the join.
        try {
          const { writeAudit } = require("./private/_audit");
          await writeAudit(this, {
            db: db_name,
            uid: newUser.id,
            action: 'invite_accepted',
            category: 'member',
            notify_to: 'admin',
            entity_id: hub_id,
            log: `Invite accepted — ${email} joined the workspace on signup`,
          });
        } catch (e) { /* audit only */ }

        // 6. Notify the (now online) user so the desk sidebar can pick up the
        // new workspace, mirroring hub.invite()'s notification for drumates.
        try {
          const hub = await this.yp.await_proc(`${db_name}.mfs_access_node`, newUser.id, hub_id);
          if (hub) {
            hub.ownpath = '/';
            hub.hub_id = hub.actual_hub_id;
            hub.db_name = hub.actual_db;
            const sockets = await this.yp.await_proc('user_sockets', newUser.id);
            await RedisStore.sendData(this.payload(hub, { service: "hub.invite_received" }), sockets);
            await RedisStore.sendData(this.payload(hub, { service: "hub.add_contributors" }), sockets);
          }
        } catch (err) {
          this.warn(`[_resolve_pending_invitation] WS notify failed for hub ${hub_id}:`, err && err.message);
        }

        // Tell online members a member joined so an open permission matrix
        // refreshes. (butler.js has no direct service boundary with hub.js, so
        // the shared helper is used instead of an inherited method.)
        await notifyMemberJoined(this, hub_id, newUser.id);

        this.debug(`[_resolve_pending_invitation] Added user ${newUser.id} to hub ${hub_id}`);
      } catch (err) {
        // Log per-hub failure but continue processing remaining hubs
        this.warn(`[_resolve_pending_invitation] Failed for hub ${hub_id}:`, err && err.message);
      }
    }

    // 6. Clean up all resolved pending_invitation entries for this email
    await this.yp.await_proc("pending_invitation_delete_by_email", email);
  }

  /**
   * 
   */
  async hello() {
    const geoip = require("geoip-lite");
    const ip = this.input.ip();
    const data = geoip.lookup(ip) || {};
    data.ip = ip;
    this.output.data(data);
  }

  /**
   * 
   */
  async unsubscribe() {
    const unsubscribe = this.input.get(Attr.email);
    await this.yp.await_query(`UPDATE emailing SET status='unsubscribed' WHERE email=?`, unsubscribe)
    this.output.data({ unsubscribe });
  }

  /**
   * 
   */
  ping() {
    const id = this.user.uid();
    this.yp.call_proc("get_visitor", id, this.output.data);
    this.output.list([
      { mfs_rooo: ["db_name", 2] },
      [{ db_name: "data" }],
      { domain_name: process.env.domain_name },
      ["1/1/1", 2],
      "/data",
    ]);
  }

  /**
   * Public OAuth callback for the Drive-scope flow initiated by
   * `google_drive.connect`. Upserts the user's oauth_accounts row
   * (provider='google') with access_token + refresh_token + scope +
   * expires_at — creating it when the user has no prior Google link —
   * then returns a small HTML page that signals the opener (via
   * BroadcastChannel + localStorage + postMessage) before closing.
   */
  async google_drive_callback() {
    const code = this.input.use('code');
    const state = this.input.use('state');
    if (!code || !state) {
      return this._closingPage(false, 'missing_code_or_state');
    }
    let payload;
    try {
      const raw = await this.yp.await_proc('get_redirect_state', state);
      const meta = raw && raw.metadata;
      payload = typeof meta === 'string' ? this.parseJSON(meta) : meta;
    } catch (e) {
      this.warn('[google_drive_callback] state lookup failed:', e && e.message);
      return this._closingPage(false, 'invalid_state');
    }
    // Single-use: consume the state row immediately so it can't be replayed
    // (the same `state` token attaching tokens onto a victim uid, or being
    // re-submitted after the window closed). Delete regardless of whether
    // the exchange below succeeds — a failed attempt must not leave a
    // reusable token behind.
    try {
      await this.yp.await_query('DELETE FROM yp.redirect_state WHERE id=?', state);
    } catch (e) {
      this.warn('[google_drive_callback] state consume failed:', e && e.message);
    }
    if (!payload || !payload.uid || payload.intent !== 'gdrive_migrate') {
      return this._closingPage(false, 'state_mismatch');
    }

    const { google } = require('googleapis');
    const { sysEnv } = require('@drumee/server-essentials');
    const { googleDriveCredentials } = require('./lib/google_credentials');
    const { id: client_id, secret: client_secret } = googleDriveCredentials();
    // Must stay byte-identical to google_drive._oauthClient() — Google
    // verifies this redirect_uri against the value used at generateAuthUrl.
    // svc_location is the endpoint-aware service path (same idiom as
    // loby/service/google.js); never hardcode it — it yields the correct
    // callback URL on every endpoint automatically.
    const { main_domain, svc_location } = sysEnv();
    const redirect_uri = `https://${main_domain}${svc_location}/butler.google_drive_callback?`;
    const oauth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uri);

    let tokens;
    try {
      const res = await oauth2.getToken(code);
      tokens = res.tokens;
    } catch (e) {
      this.warn('[google_drive_callback] exchange failed:', e && e.message);
      return this._closingPage(false, 'exchange_failed');
    }
    if (!tokens || !tokens.access_token) {
      return this._closingPage(false, 'no_access_token');
    }

    // Identify the Google account from the id_token (email+profile scope is
    // requested in google_drive.connect). provider_user_id (the `sub`) is
    // part of the oauth_accounts UNIQUE key, so it's required to upsert the
    // row — without it an email/password user (no prior Google-linked row)
    // would have nothing to UPDATE and the token would be silently dropped.
    let googleSub = null, googleEmail = '';
    try {
      if (tokens.id_token) {
        const ticket = await oauth2.verifyIdToken({ idToken: tokens.id_token, audience: client_id });
        const p = ticket.getPayload() || {};
        googleSub = p.sub || null;
        googleEmail = p.email || '';
      }
    } catch (e) {
      this.warn('[google_drive_callback] id_token verify failed:', e && e.message);
    }
    if (!googleSub) {
      return this._closingPage(false, 'no_identity');
    }

    const scope = tokens.scope || '';
    const expiresAt = tokens.expiry_date
      ? Math.floor(tokens.expiry_date / 1000)
      : Math.floor(Date.now() / 1000) + 3500;

    // Observability: a re-grant that replaces a legacy drive.readonly row
    // with drive.file flips the user to the Picker UI. By design the scope
    // column must describe the STORED token (a union would let mode=all run
    // against a file-only token), and the FE only re-OAuths when the old
    // grant is already dead — but log the transition so support can explain
    // "my whole-Drive option disappeared" reports.
    try {
      const prior = (await this.yp.await_query(
        'SELECT scope FROM oauth_accounts WHERE provider=? AND provider_user_id=?',
        'google', googleSub
      ))[0];
      if (prior && /drive\.readonly/.test(prior.scope || '') && !/drive\.readonly/.test(scope)) {
        this.warn(`[google_drive_callback] scope downgrade readonly→file for uid=${payload.uid}`);
      }
    } catch (_) { /* log-only */ }

    // Upsert keyed on the UNIQUE (provider, provider_user_id): creates the
    // row for a first-time connector (no prior Google login) and updates it
    // on re-grant. refresh_token is overwritten only when Google returns a
    // fresh one (prompt=consent forces it on first grant); otherwise the
    // stored one is preserved.
    await this.yp.await_query(
      `INSERT INTO oauth_accounts
         (user_id, provider, provider_user_id, email, access_token, refresh_token, scope, expires_at, ctime, mtime)
       VALUES (?, 'google', ?, ?, ?, ?, ?, ?, UNIX_TIMESTAMP(), UNIX_TIMESTAMP())
       ON DUPLICATE KEY UPDATE
         user_id       = VALUES(user_id),
         email         = VALUES(email),
         access_token  = VALUES(access_token),
         refresh_token = IF(VALUES(refresh_token) IS NOT NULL AND VALUES(refresh_token) <> '', VALUES(refresh_token), refresh_token),
         scope         = VALUES(scope),
         expires_at    = VALUES(expires_at),
         mtime         = UNIX_TIMESTAMP()`,
      payload.uid, googleSub, googleEmail, tokens.access_token, tokens.refresh_token || null, scope, expiresAt
    );

    // Confirm the connection is actually USABLE before signaling success. The
    // refresh_token clause above preserves the prior token when Google returns
    // none, which can silently keep a dead or wrong-client token on the row. If
    // after the upsert the row still lacks a refresh_token or a drive.readonly
    // scope, the migration worker would just fail with NEEDS_RECONNECT — so
    // surface it now as a failed connection instead of a false "connected".
    const { toArray } = require('@drumee/server-essentials').utils;
    const saved = toArray(await this.yp.await_query(
      // The user may hold several google rows (login client vs Drive client,
      // distinct provider_user_id) — the upsert above touched the DRIVE one,
      // so validate THAT row, not whichever the DB returns first.
      'SELECT refresh_token, scope FROM oauth_accounts WHERE user_id=? AND provider=? ORDER BY (scope LIKE "%drive.%") DESC, mtime DESC LIMIT 1',
      payload.uid, 'google'
    ))[0];
    if (!saved || !saved.refresh_token
        || !(saved.scope && /drive\.(file|readonly)/.test(saved.scope))) {
      this.warn('[google_drive_callback] connection unusable after upsert: has_refresh='
        + !!(saved && saved.refresh_token) + ' scope=' + (saved && saved.scope));
      return this._closingPage(false, 'needs_consent');
    }

    return this._closingPage(true);
  }

  /**
   * Minimal HTML that posts a status message to the opener window and
   * closes itself. The FE popup listens for `message` events filtered
   * by `type === 'gdrive-connected'`.
   */
  _closingPage(ok, reason) {
    const payloadJson = JSON.stringify({ type: 'gdrive-connected', ok: !!ok, reason: reason || null });
    const statusText = JSON.stringify(
      ok ? 'Connected. You can close this window.'
        : 'Connection failed: ' + (reason || 'unknown')
    );
    // Google's consent screen ships Cross-Origin-Opener-Policy, which severs
    // window.opener for this popup's browsing context for the rest of its
    // life. So postMessage to the opener silently no-ops AND window.close()
    // is typically blocked. Signal the still-open app via same-origin
    // channels that survive opener severance: BroadcastChannel + a
    // localStorage write (which fires a `storage` event in the app document).
    // postMessage is kept as a bonus for browsers where the opener survives.
    const body = `<!doctype html><html><body>
<script>
(function () {
  var payload = ${payloadJson};
  try { var bc = new BroadcastChannel('gdrive-oauth'); bc.postMessage(payload); bc.close(); } catch (e) {}
  try { payload.ts = Date.now(); localStorage.setItem('gdrive-oauth-result', JSON.stringify(payload)); } catch (e) {}
  try { if (window.opener && !window.opener.closed) window.opener.postMessage(payload, window.location.origin); } catch (e) {}
  try { window.close(); } catch (e) {}
  document.body.innerText = ${statusText};
})();
</script>
</body></html>`;
    this.output.html(body);
  }
}

module.exports = __butler;
