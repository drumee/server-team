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

const { Attr, Messenger, Cache, uniqueId, sysEnv } = require("@drumee/server-essentials");
const { Entity } = require("@drumee/server-core");
const { resolve } = require("path");

/**
 * Configured envelope sender (email.json -> auth.user), resolved once. Used to
 * build a "Drumee" <addr> display-name From, matching the other butler emails.
 * The address is read at runtime (it differs per deployment) not hardcoded.
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
    // Display-name From ("Drumee" <butler@...>) so the inbox shows "Drumee",
    // matching the other butler emails. Falls back to default sender if unset.
    const sender = butlerSender();
    const from = sender ? `"Drumee" <${sender}>` : undefined;
    let sent = 0;
    try {
      const result = await msg.send(from ? { html, from } : { html });
      if (result && result.error) {
        this.warn(`OTP email delivery failed: ${result.error}`);
      } else {
        sent = 1;
      }
    } catch (e) {
      this.warn(e);
    }
    this.output.data({ status: 'ok', sent, ...user, secret, email });
  }
}


module.exports = Otp;
