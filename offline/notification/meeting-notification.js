#!/usr/bin/env node

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
const Minimist = require("minimist");
const { sendMail } = require("../../service/lib/send-mail");
const {
  Messenger,
  Mariadb,
  Cache,
  Offline,
} = require("@drumee/server-essentials");

/**
 *
 */
class __offline_meeting_notification_mail extends Offline {
  /**
   *
   * @param  {...any} args
   */
  constructor(...args) {
    super(...args);
  }

  /**
   *
   * spawn(cmd, [hub_id, message, flag, lang, username, link, icon, opt], {detached: true});
   */
  initialize() {
    const argv = Minimist(process.argv.slice(2));
    this.yp = new Mariadb({ user: process.env.USER });
    this.lang = argv._[0];
    this.sender = argv._[1];
    this.recipient = argv._[2];
    this.subject = argv._[3];
    this.template = argv._[4];
    this.title = argv._[5];
    this.date = argv._[6];
    this.message = argv._[7];
    this.headline = argv._[8];
    this.link = argv._[9];
    this.lang = this.lang || "en";
    new Cache();
    this.service = "room.book";
    Cache.load().then(this.prepare.bind(this));
  }

  async prepare() {
    let opt = {
      recipient: this.recipient,
      subject: this.subject,
      template: this.template,
      data: {
        title: this.title,
        date: this.date,
        message: this.message,
        sender: this.sender,
        headline: this.headline,
        recipient: this.recipient,
        link: this.link,
      },
    };

    const msg = new Messenger({
      template: opt.template || "butler/external-meeting",
      subject: `Drumee: ${opt.subject}`,
      recipient: opt.recipient,
      lex: Cache.lex(this.lang),
      data: {
        lang: this.lang,
        subject: opt.subject,
        sender: this.username,
        signature: this.username,
        ...opt.data,
      },
    });
    await sendMail(msg);
    process.exit(0);
  }
}

new __offline_meeting_notification_mail();
