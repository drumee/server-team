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
  Attr, Messenger, Cache, sysEnv, uniqueId
} = require("@drumee/server-essentials");
const { resolve } = require('path');
const { isEmpty } = require("lodash");
const { Mfs } = require("@drumee/server-core");

class __signup extends Mfs {

  /**
   * Create a new Drumee account via the signup plugin (no socket binding required).
   * Checks for duplicate email, creates the account schema, auto-logs in, sends
   * a welcome email, and resolves any pending hub invitations.
   */
  async create_account() {
    const email = this.input.need(Attr.email).trim();
    const password = this.input.need(Attr.password).trim();

    const existingUser = await this.yp.await_proc("drumate_exists", email);
    if (existingUser && existingUser.email) {
      return this.output.data({ status: "user_exists", email });
    }

    const { main_domain: domain } = sysEnv();
    let username = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '');
    username = await this.yp.await_func("ensure_username", { username: username.toLowerCase(), domain });

    // Referral attribution: the signup UI forwards the referrer handle from a
    // ?ref=<member> link. Persisted as profile.ref so the analytics plugin's
    // `referrals` / `signup_sources` procs can count referred signups. Kept
    // short/sanitized (lowercased so `ref=V` and `ref=v` unify at the store,
    // not just at query time); omitted entirely when absent.
    const ref = (this.input.get("ref") || "").toString().trim().toLowerCase().slice(0, 64);

    // UTM campaign params (source attribution) — stored as profile.utm.
    const utm = {};
    for (const k of ["utm_source", "utm_medium", "utm_campaign"]) {
      const v = (this.input.get(k) || "").toString().trim().slice(0, 64);
      if (v) utm[k] = v;
    }

    const profile = {
      username,
      sharebox: uniqueId(),
      otp: 0,
      category: "trial",
      profile_type: "trial",
      // Product default is English — never derive a new account's language
      // from the request (session/Xlang/accept-language).
      lang: 'en',
      firstname: "",
      lastname: "",
      email,
      auth_method: "local",
      password_set: 1,
      ...(ref ? { ref } : {}),
      ...(Object.keys(utm).length ? { utm } : {}),
    };

    const user = await this.yp.await_proc("drumate_create", password, profile);
    if (!user || !user[0]) {
      return this.output.data({ status: "server_error" });
    }
    if (user[0].failed === 2) {
      return this.output.data({ status: "server_busy" });
    }
    if (user[0].failed) {
      return this.output.data({ status: "server_error" });
    }

    const { permission } = user[0];
    const { drumate } = user[2] || {};
    if (!drumate || !permission) {
      return this.output.data({ status: "unexpected_error" });
    }

    // Auto-login via session.signin (returns data; we output it).
    // signin uses session_signin proc which has no domain-link filter,
    // unlike session_login_next (used by session.login) which requires o.link = host.
    let loginResult;
    try {
      const { main_domain } = sysEnv();
      loginResult = await this.session.signin({ uid: email, email, password, host: main_domain });
    } catch (e) {
      this.warn("[signup.create_account] Auto login failed", e);
      return this.output.data({ status: "internal_error" });
    }
    if (!loginResult || loginResult.status === "WRONG_CREDENTIALS") {
      this.warn("[signup.create_account] signin returned", loginResult);
      return this.output.data({ status: "internal_error" });
    }
    loginResult.status = "ok";

    // Send welcome email (non-blocking — don't fail the signup if mail fails)
    try {
      const tpl = resolve(__dirname, "./templates/welcome.html");
      const ulang = "en";
      const lex = Cache.lex(ulang);
      const { main_domain: mail_domain } = sysEnv();
      const mailData = {
        heading: lex._your_account_is_all_set,
        message: lex._mail_signup_drumee,
        workspace: lex._discover_drumee_desk,
        link: `https://${mail_domain}/-/`,
        signature: lex._drumee_team,
        reminder: lex._copyright.format(`${new Date().getFullYear()}`),
        hello: lex._hello_x.format(""),
      };
      const msg = new Messenger({
        subject: lex._welcome_on_drumee,
        recipient: email,
        handler: this.exception.email,
      });
      const html = msg.renderFrom(tpl, mailData);
      await msg.send({ html });
    } catch (e) {
      this.warn("[signup.create_account] Welcome email failed", e && e.message);
    }

    // Resolve pending hub invitations registered before this account existed
    try {
      await this._resolve_pending_invitation(email);
    } catch (e) {
      this.warn("[signup.create_account] Pending invitations failed", e && e.message);
    }

    this.output.data(loginResult);
  }

  /**
   * Resolve pending hub invitations for a newly created user.
   *
   * The body of this used to live here, duplicated byte-for-byte in butler.js,
   * and reachable from account creation ONLY. Both copies now defer to
   * `service/lib/resolve-pending-invitation`, which the login path and the
   * repair script share — see that module for why that matters.
   */
  async _resolve_pending_invitation(email) {
    const { resolvePendingInvitations } = require("./lib/resolve-pending-invitation");
    return resolvePendingInvitations(this, email, { source: "signup" });
  }
}

module.exports = __signup;
