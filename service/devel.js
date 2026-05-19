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
/** ===================== */
const { Entity } = require('@drumee/server-core');
const { readFileSync } = require('jsonfile');
const { readFileSync: readFile } = require('fs');
const { keys } = require('lodash');
const { existsSync } = require("fs");
const { sysEnv, Messenger, Cache } = require("@drumee/server-essentials");
const { instance } = sysEnv();
const { resolve } = require('path');
const ENDPOINTS = '/etc/drumee/infrastructure/instances.json';
class Devel extends Entity {


  /**
   * 
   */
  instances() {
    let instances = [instance];
    if (existsSync(ENDPOINTS)) {
      instances = readFileSync(ENDPOINTS)
    }
    this.output.list(keys(instances));
  }

  /**
   * 
   */
  async _send_email(subject, recipient, data, tpl_file = 'message.html') {
    const ulang = this.input.ua_language();
    let lex = Cache.lex(ulang)
    let tpl = resolve(__dirname, "./templates", tpl_file)
    const msg = new Messenger({
      subject,
      recipient,
      handler: this.exception.email,
    });
    data.subject = subject;
    data.heading = data.heading || "Drumee, built to be yours";
    data.signature = data.signature || lex._drumee_team;
    data.footer = data.footer || lex._copyright.format(`${new Date().getFullYear()}`)
    data.hello = data.hello || lex._hello_x.format(data.fullname || "")
    data.lex = data.lex || lex;
    let html = msg.renderFrom(tpl, data)
    let status = await msg.send({ html });
    this.debug("AAA:58", recipient, status)
  }

  /**
   * 
   * */
  async test_email() {
    const subject = this.input.get('subject') || "Test email"
    const recipient = this.input.get('recipient');
    const data = this.input.get('data') || {};
    await this._send_email(subject, recipient, data, "mail/share.html")
    this.output.list(recipient)
  }
}

module.exports = Devel;
