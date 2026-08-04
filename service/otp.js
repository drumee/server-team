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

const { Attr, Messenger, Cache, Constants, uniqueId, sysEnv } = require("@drumee/server-essentials");
const { FORGOT_PASSWORD } = Constants;
const { Entity } = require("@drumee/server-core");
const { resolve } = require("path");

const { butlerFrom, mailbox } = require("./lib/mail-sender");

/**
 * Configured envelope sender (email.json -> auth.user), resolved once.
 *
 * Only the reset-password mail still builds its From from this. The OTP mail
 * moved to the pinned brand address (lib/mail-sender); this one was left on the
 * credential-derived sender because it was not part of that change.
 */
let _butlerSender;
function butlerSender() {
  if (_butlerSender !== undefined) return _butlerSender;
  try {
    const { readFileSync } = require("fs");
    const f = resolve(sysEnv().credential_dir, "email.json");
    _butlerSender = (JSON.parse(readFileSync(f, "utf8")).auth || {}).user || null;
  } catch (e) {
    _butlerSender = null;
  }
  return _butlerSender;
}

class Otp extends Entity {


  /**
 * 
 */
  async _verify(ident) {
    const code = this.input.need(Attr.code);
    const secret = this.input.need(Attr.secret);
    const socket_id = this.input.need(Attr.socket_id);

    let socket_ok = await this.yp.await_func("is_socket_bound", socket_id, this.input.sid());
    if (!socket_ok) {
      return { error: 1, status: "no-socket" }
    }

    let user = await this.yp.await_proc("drumate_exists", ident);
    if (!user || !user.id) {
      return { error: 1, status: "no-user", user };
    }

    let otp = await this.yp.await_proc("secret_check", user.id, secret, code);
    if (!otp || otp.code != code) {
      return { error: 1, status: "wrong-code", user };
    }
    otp.uid = user.id;
    return otp;
  }

  /**
   * 
   */
  async verify() {
    const email = this.input.need(Attr.email);
    let otp = await this._verify(email)
    this.output.data(otp);
  }

  /**
   * 
   */
  async send() {
    const email = this.input.need(Attr.email);
    const socket_id = this.input.need(Attr.socket_id);
    let socket_ok = await this.yp.await_func("is_socket_bound", socket_id, this.input.sid());
    if (!socket_ok) {
      return this.exception.user("INVALID_SOCKET");
    }
    let user = await this.yp.await_proc("drumate_exists", email);
    this.debug("AAA:68", user)
    if (!user || !user.email) {
      return this.output.data({ status: "no-user", email });
    }
    let token = uniqueId();
    let { code, secret } = await this.yp.await_proc(`secret_create`, user.id, token);
    if (this.input.get(Attr.method) == "otp") {
      ({ code, secret } = await this.yp.await_proc(`otp_create`, user.id, token));
    }
    const ulang = this.input.ua_language();
    let lex = Cache.lex(ulang)
    let data = {
      heading: lex._your_otp,
      code,
      why_this_otp: lex._why_this_otp,
    }
    const msg = new Messenger({
      subject: lex._your_otp,
      recipient: user.email,
      handler: this.exception.email,
    });
    const tplPath = resolve(__dirname, "./templates/otp.html");
    const html = msg.renderFrom(tplPath, data);
    // Display-name From ("Drumee" <contact@drumee.org>) so the inbox shows
    // "Drumee", matching the other butler emails.
    const payload = { html, from: butlerFrom() };

    // Answer with the secret the moment it's minted — the SMTP round-trip is the
    // slow part (seconds) and the client only needs the secret to open the
    // code-entry modal. Blocking the response on delivery made the "Delete my
    // account" button look frozen, so users clicked again and minted extra codes.
    // `sent` is optimistic: the email is dispatched below without awaiting, and a
    // genuine delivery failure is recovered via the modal's Resend action.
    this.output.data({ status: 'ok', sent: 1, ...user, secret, email });

    // Fire-and-forget: the request is already answered, so a delivery error is
    // only logged here, never surfaced to the (already-served) caller.
    Promise.resolve(msg.send(payload))
      .then((result) => {
        if (result && result.error) {
          this.warn(`OTP email delivery failed: ${result.error}`);
        }
      })
      .catch((e) => this.warn(e));
  }

  /**
   * Send a password-reset *link* email (the Figma "Reset your Drumee password"
   * template). Like send(), but instead of an OTP code it generates a
   * forgot-password token, builds a reset link (#/welcome/reset/{uid}/{token})
   * and emails the styled reset-password.html template.
   */
  async send_link() {
    const email = this.input.need(Attr.email);
    // socket_id is best-effort. When present and bound it confirms a live
    // browser session, but right after logout the client's cached socket is
    // stale — its row was already deleted, and the still-open ws gets no close
    // event, so it stays stale until a page refresh rebinds it. Don't block a
    // legitimate password reset on that: the link is only ever emailed to an
    // existing user (drumate_exists below).
    const socket_id = this.input.get(Attr.socket_id);
    if (socket_id) {
      const socket_ok = await this.yp.await_func("is_socket_bound", socket_id, this.input.sid());
      if (!socket_ok) {
        this.warn(`send_link: socket ${socket_id} not bound to current session; proceeding (likely a stale socket after logout)`);
      }
    }
    const user = await this.yp.await_proc("drumate_exists", email);
    if (!user || !user.email) {
      return this.output.data({ status: "no-user", email });
    }

    // Generate a forgot-password token and build the reset link (same shape
    // the set_password flow validates via token_get_next).
    const token = uniqueId();
    await this.yp.await_proc("token_generate_next", email, email, token, FORGOT_PASSWORD, user.id);
    const link = `${this.input.homepath()}#/welcome/reset/${user.id}/${token}`;

    const ulang = this.input.ua_language();
    const lex = Cache.lex(ulang);
    const data = {
      recipient: user.firstname || user.fullname || "there",
      email: user.email,
      link,
      expiry: "1 hour",
      support_email: "contact@drumee.org",
      support_hours: "Monday - Friday, 9:00 AM - 6:00 PM EST",
    };

    const subject = (lex && lex._password_reset_link) || "Reset your Drumee password";
    const msg = new Messenger({
      subject,
      recipient: user.email,
      handler: this.exception.email,
    });
    const tplPath = resolve(__dirname, "./templates/reset-password.html");
    const html = msg.renderFrom(tplPath, data);
    // Via mailbox() rather than a hand-rolled `"Drumee" <${sender}>`: `sender`
    // is credential-derived (email.json auth.user), so a value that already
    // carries angle brackets would nest them and ship a "Drumee>" display name.
    const sender = butlerSender();
    const from = sender ? mailbox("Drumee", sender) : undefined;

    let sent = 0;
    try {
      const result = await msg.send(from ? { html, from } : { html });
      if (result && result.error) {
        this.warn(`Reset-link email delivery failed: ${result.error}`);
      } else {
        sent = 1;
      }
    } catch (e) {
      this.warn(e);
    }
    this.output.data({ status: 'ok', sent, email });
  }
}


module.exports = Otp;
