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
  Attr, Messenger, Cache, sysEnv, uniqueId, RedisStore
} = require("@drumee/server-essentials");
const { resolve } = require('path');
const { isEmpty } = require("lodash");
const { notifyMemberJoined } = require("./lib/notify-member-joined");
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
   * Mirrors butler._resolve_pending_invitation.
   */
  async _resolve_pending_invitation(email) {
    const { toArray } = require("@drumee/server-essentials").utils;

    const newUser = await this.yp.await_proc("drumate_exists", email);
    if (isEmpty(newUser) || !newUser.id) return;

    const pending = await this.yp.await_proc("pending_invitation_get_by_email", email);
    const rows = toArray(pending);
    if (isEmpty(rows)) return;

    for (const row of rows) {
      const { hub_id, permission, expiry_time } = row;
      try {
        const db_name = await this.yp.await_func("get_db_name", hub_id);
        if (!db_name) continue;
        await this.yp.await_proc(`${db_name}.add_member`, newUser.id, permission, expiry_time);
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

        // Notify the (now online) user so the desk sidebar can pick up the
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
          this.warn(`[signup._resolve_pending_invitation] WS notify failed for hub ${hub_id}:`, err && err.message);
        }

        // Tell online members a member joined so an open permission matrix
        // refreshes (mirrors butler.js _resolve_pending_invitation).
        await notifyMemberJoined(this, hub_id, newUser.id);
      } catch (err) {
        this.warn(`[signup._resolve_pending_invitation] Failed for hub ${hub_id}:`, err && err.message);
      }
    }

    await this.yp.await_proc("pending_invitation_delete_by_email", email);
  }
}

module.exports = __signup;
