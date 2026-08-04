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
  Attr, Constants, toArray, RedisStore, sysEnv, Cache, Messenger
} = require("@drumee/server-essentials");

const {
  INVALID_DATA,
  VIGNETTE,
} = Constants;
const { Entity, FileIo } = require("@drumee/server-core");
const { existsSync, readFileSync } = require("fs");
const { isEmpty, isArray, isString } = require("lodash");
const { get_env, platform } = require('./lib/env');
const { logConnection, revokeConnectionLog } = require('./lib/connection_log');
const { resolve } = require("path");
const { credential_dir } = sysEnv();
let keyFile = resolve(credential_dir, `crypto/public.pem`);
const publicKey = readFileSync(keyFile);

const { butlerFrom } = require("./lib/mail-sender");


//########################################
class __yp extends Entity {

  constructor(...args) {
    super(...args);
    this.platform = platform.bind(this);
    this._get_env = get_env.bind(this);
  }

  /**
   *
   */
  async get_env() {
    let data = await this._get_env();
    this.output.data(data);
  }


  /**
   *
   */
  async get_hub() {
    const hub = this.hub.toJSON();
    hub.stylesheets = await this.db.await_proc("style_get_files");
    hub.fonts_links = await this.db.await_proc("get_fonts_links");
    hub.fonts_faces = await this.db.await_proc("get_fonts_faces");
    if (hub.hostname == null) {
      this.exception.not_found("HUB_NOT_FOUND");
      return;
    }
    this.output.data(hub);
  }

  /**
   *
   */
  tutorial() {
    this.yp.call_proc(
      "get_tutorial",
      this.input.get(Attr.name),
      this.output.data
    );
  }

  /**
   *
   */
  async tutorials() {
    let data = await this.yp.await_query("SELECT * FROM tutorial");
    this.output.data(data);
  }

  /**
   *  Device Registration
   */
  async device_registration() {
    let device_id = this.input.need("device_id");
    let device_type = this.input.need("device_type");
    let push_token = this.input.need("push_token");
    let data = await this.yp.await_proc(
      "device_registration",
      device_id,
      device_type,
      push_token,
      this.uid,
      "active"
    );
    this.output.data(data);
  }

  /**
   *
   */
  files_formats() {
    const yp = this.yp;
    // const hub = this.hub.toJSON();
    this.yp.query(
      "select extension, category, mimetype, capability from filecap",
      this.output.list
    );
  }

  /**
   *
   */
  async sys_var() {
    let name = this.input.need(Attr.name);
    let r = await this.yp.await_run(
      "SELECT * FROM sys_var WHERE `name`=? ",
      name
    );
    this.output.data(r);
  }


  /**
   *
   */
  async authenticate() {
    let secret = this.input.need(Attr.secret);
    let code = this.input.need(Attr.code);
    const { ident } = this.input.use("vars") || {};
    if (this.session.isAnonymous()) {
      await this.session.authenticate(secret, code);
    } else {
      let user_id = this.user.get(Attr.id);
      let { uid } = (await this.yp.await_proc("otp_get", secret, code)) || {};
      if (uid) {
        if (uid == user_id) {
          this.output.data({ status: "ALREADY_SIGNED_IN" });
        } else {
          this.output.data({
            status: "CROSS_SIGNED_IN",
            current: profile.email,
            uid: this.user.get(Attr.id),
            input: ident,
          });
        }
      } else {
        this.output.data({ status: "ALREADY_ONLINE" });
      }
    }
  }

  /**
   * 
   */
  async request_otp() {
    this.output.data({ status: "NOT_IN_USE" });
  }


  /**
   * 
   */
  async login() {
    let vars = this.input.use("vars") || {};
    vars.uid = (vars.username || vars.uid || vars.ident).trim();
    vars.password = vars.password.trim();
    if (!vars.uid.isEmail()) {
      vars.username = vars.uid;
      vars.host = this.input.get(Attr.vhost) || this.input.host();
    }

    // Override session.send_otp for email-based 2FA so it uses the new otp.html
    // template instead of the legacy butler/otp.tpl baked into @drumee/server-core.
    // SMS/passkey paths defer to the original implementation.
    const session = this.session;
    const origSendOtp = session.send_otp.bind(session);
    session.send_otp = async (user) => {
      let { profile } = user;
      if (isString(profile)) profile = session.parseJSON(profile);
      if (profile && profile.otp === Attr.email) {
        return this._send2faOtpEmail(user);
      }
      return origSendOtp(user);
    };

    let r = await session.signin(vars);

    // Block accounts whose email is still pending verification. The signup
    // email-verification flow stages the address in drumate.unverified_email and
    // clears it only when the verify link is clicked. registration_verified alone
    // is unreliable (legacy accounts default to 0 with no pending email), so gate
    // on unverified_email being set. Tear down the session that signin just
    // established (mirrors the BLOCKED/ARCHIVED handling inside session.signin).
    if (r && r.status === "ok" && r.user && r.user.id) {
      let row = await this.yp.await_query(
        "SELECT unverified_email FROM drumate WHERE id=?", r.user.id
      );
      if (isArray(row)) row = row[0];
      row = row || {};
      if (row.unverified_email) {
        await this.yp.await_proc(
          "session_reset", this.input.sid(), r.user.id, this.input.get(Attr.socket_id)
        );
        // session.signin() logged an accepted connection BEFORE we got here --
        // it has no idea this gate exists -- so without this the user is refused
        // entry and their "last login" advances anyway. Take it back rather than
        // reorder the check: the credentials have to be resolved before there is
        // a uid to look unverified_email up by.
        await revokeConnectionLog(this, r.user.id, "EMAIL_NOT_VERIFIED");
        return this.output.data({ status: "EMAIL_NOT_VERIFIED", email: row.unverified_email });
      }
    }

    this.output.data(r);
  }

  /**
   * Send the 2FA login OTP via email using the new otp.html template.
   */
  async _send2faOtpEmail(user) {
    let { profile, fullname, firstname } = user;
    if (isString(profile)) profile = this.session.parseJSON(profile);
    profile.displayName = firstname || fullname;
    const token = this.session.randomString();
    const lang = this.input.app_language() || this.input.page_language() || "en";
    const otp = await this.yp.await_proc("otp_create", user.id, token);
    const lex = Cache.lex(lang);
    const data = {
      heading: lex._your_otp,
      code: otp.code,
      why_this_otp: lex._why_this_otp,
    };
    const msg = new Messenger({
      subject: lex._your_otp,
      recipient: profile.email,
      handler: this.exception && this.exception.email,
    });
    const tplPath = resolve(__dirname, "./templates/otp.html");
    const html = msg.renderFrom(tplPath, data);
    // Display-name From ("Drumee" <contact@drumee.org>) so the inbox shows
    // "Drumee" instead of the raw sender address, matching otp.js.
    try {
      await msg.send({ html, from: butlerFrom() });
    } catch (e) {
      this.warn("2FA OTP email send failed", e);
    }
    return { secret: otp.secret };
  }

  /**
   * Second leg of a 2FA sign-in: verify the emailed code and open the session.
   *
   * This COMPLETES the login that login() started -- session.signin() returns at
   * its `status == "otp"` branch without logging anything, because at that point
   * nobody is signed in yet. The connection is therefore logged here, and only
   * here: session_login_otp is a plain proc and writes no services_log row, so
   * without this every 2FA account showed a permanently stale "Last login" in
   * analytics while signing in perfectly normally.
   */
  async login_top() {
    const uid = this.input.get(Attr.id) || this.input.get(Attr.uid) || this.uid;
    const code = this.input.get(Attr.code);
    const secret = this.input.get(Attr.secret);
    const result = await this.yp.await_proc("session_login_otp", uid, code, secret, this.input.sid());
    if (!result || result.status !== 'success') {
      return this.output.data({ status: 'error' });
    }
    await logConnection(this, uid);
    const user = await this.yp.await_proc('get_user', uid);
    this.output.data(user);
  }

  // /**
  //  *
  //  */
  // async signin() {
  //   let res = await this.session.signin(this.input.use("vars"));
  //   this.output.data(res)
  // }

  /**
   *
   */
  async guest_login() {
    let token = this.input.need(Attr.token);
    let res = await this.session.dmz_login(token, this.input.get(Attr.password));
    if (res.failed) {
      res.validity = res.error;
    }
    let info = await this.yp.await_proc("dmz_info_next", token);

    let rows = await this.yp.await_proc(
      "forward_proc",
      info.hub_id,
      "dmz_settings",
      ``
    );
    info.hours = rows[0].hours;
    info.days = rows[0].days;
    if (info.is_public && !res.guest_name) {
      res.require_name = 1;
    }
    if (res.is_verified) info.require_password = 0;
    if (info.require_password) {
      info.validity = "REQUIRED_PASSWORD";
    }

    let metadata = {};

    if (!res.failed) {
      let r = await this.db.await_proc("mfs_access_node", "*", res.id);
      metadata = this.parseJSON(r.metadata);

      if (!isEmpty(metadata)) {
        metadata.branch = this.parseJSON(metadata.branch);
        if (!isArray(metadata.branch)) {
          metadata.branch = [metadata.branch];
        }
        if (!isEmpty(metadata.session)) {
          delete metadata["session"];
        }

        if (!isEmpty(metadata.fingerprint)) {
          delete metadata["fingerprint"];
        }
        res = {};
        info = {};
        res = metadata;
      }
    }
    this.output.data({ ...res, ...info });
  }

  /**
   *
   */
  async hello() {
    let user = await this.yp.await_proc("get_user", this.uid);
    user.plan_detail = await this.yp.await_proc(
      "renewal_get_next",
      this.uid,
      0
    );
    if (this.user.get("signed_in")) {
      user.signed_in = 1;
      user.connection = "online";
    } else {
      user.signed_in = 0;
      user.connection = "offline";
    }
    this.output.data(user);
  }

  /**
   *
   */
  guest_logout() {
    this.session.dmz_logout();
  }

  /**
   *
   */
  async reset_session() {
    let socket_id = this.input.need(Attr.socket_id);
    let sid = this.input.sid();
    if (!sid || [null, "null", undefined, "undefined"].includes(sid)) {
      return this.excetion.user(INVALID_DATA);
    }
    await this.yp.await_proc("session_reset", sid, this.uid, socket_id);
    this.output.data({ sid, uid: this.uid });
  }

  /**
   *
   */
  get_external_share() {
    const share_id = this.input.need(Attr.share_id);
    this.yp.call_proc("get_external_share", share_id, this.output.data);
  }

  /**
   *
   */
  notification_count() {
    this.yp.call_proc("yp_notification_count", this.uid, this.output.data);
  }

  /**
   * 
   */
  notification_list() {
    this.yp.call_proc(
      "yp_notification_receive_list",
      this.uid,
      this.output.data
    );
  }

  /**
   * 
   */
  get_ident_availablility() {
    const ident = this.input.need(Attr.ident);
    this.yp.call_proc("available_ident", ident, this.output.data);
  }

  /**
   * 
   */
  username_exists() {
    const value = this.input.use(Attr.value);
    this.yp.call_proc(
      "get_user_in_domain",
      value,
      this.input.host(),
      this.output.data
    );
  }

  /**
   * 
   */
  async host_exists() {
    const host = this.input.use(Attr.host);
    let h = await this.yp.await_proc("get_hub", host);
    this.debug("AAA:327", host, h)
    this.output.data(h)
  }

  /**
   * 
   */
  ident_exists() {
    const value = this.input.use(Attr.value);
    this.yp.call_proc("ident_exists", value, this.output.data);
  }

  /**
   * 
   */
  email_exists() {
    const value = this.input.use(Attr.value);
    this.yp.call_proc("email_exists", value, this.output.data);
  }

  /**
   * 
   */
  get_laguages() {
    const name = this.input.use(Attr.value, "") || this.input.use(Attr.name, "");
    const page = this.input.use(Attr.page) || 1;
    this.yp.call_proc("get_laguages", name, page, this.output.data);
  }

  /**
   * 
   */
  public_key() {
    this.output.text(publicKey);
  }

  /**
   * 
   * @returns 
   */
  async avatar() {
    const { resolve } = require("path");
    const type = this.input.get(Attr.type) || VIGNETTE;
    const id = this.input.get(Attr.id) || this.user.get(Attr.id);

    let row = await this.yp.await_proc("get_user", id);
    if (isEmpty(row)) {
      this.output.data({});
      return;
    }
    const png = resolve(row.home_dir, `__config__/icons/avatar-${type}.png`);
    const svg = resolve(row.home_dir, `__config__/icons/avatar-${type}.svg`);
    let filename;
    const file = new FileIo(this);
    if (existsSync(png)) {
      filename = png;
    } else if (existsSync(svg)) {
      filename = svg;
    } else {
      this.output.data({});
      return;
    }
    file.content(filename);
  }

  /**
   * 
   */
  verify_email() {
    const user_id = this.input.use(Attr.uid) || this.user_id();
    const email_hash = this.input.need(Attr.email);
    const token = this.input.need(Attr.token);
    const cb = function (data) {
      if (!isEmpty(data)) {
        this.output.data();
      } else {
        this.excetion.user(INVALID_DATA);
      }
    }.bind(this);
    this.yp.call_proc("drumate_verify_email", user_id, email_hash, token, cb);
  }

  /**
   * Accept id or email
   */
  check_drumate_exist() {
    const id = this.input.need(Attr.id);
    this.yp.call_proc("drumate_exists", id, this.output.data);
  }

  /**
   *
   * @param {*} s
   * @returns
   */
  async broadcastStatus(s) {
    let rows = await this.yp.await_proc("drumate_online_state", this.uid);
    rows = toArray(rows);
    let payload = {
      options: {
        service: "user.connection_status",
        keys: ["user_id"],
      },
    };
    for (var s of rows) {
      payload.socket_id = s.id;
      payload.model = { user_id: s.my_id, status: s.my_state };
      await RedisStore.sendData(payload, s.id);
    }
  }

  /**
   *
   */
  async ping() {
    let { type, nid } = this.input.data();
    switch (type) {
      case "debug":
        const me = await this.yp.await_proc(`get_user`, this.uid);
        let data = { verbosity: global.verbosity, modules: global.debug, me:me.profile }
        this.output.data(data);
        let recipients = await this.yp.await_proc('user_sockets', this.uid);
        await RedisStore.sendData(this.payload(data), recipients);
        return
      case "test":
        let t1 = new Date().getTime()
        let t2 = new Date().getTime()
        this.debug("AAA:159", t2 - t1)
        this.output.list({ t1, t2 });
        return
      default:
        this.output.data({ type });
    }
  }

  /**
   *
   */
  clear_share() {
    this.output.output({});
  }
}

module.exports = __yp;
