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
const Minimist  = require('minimist');
const _         = require('lodash');
const {Cache, Messenger, Mariadb, Offline} = require('@drumee/server-essentials');
const { sqlString } = require('../../service/lib/sql-literal');

/**
 * 
 */
class __offline_sharebox_notification_mail extends Offline {
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
    const argv      = Minimist(process.argv.slice(2));
    this.yp         = new Mariadb({user:process.env.USER});
    // this.hub_id     = argv._[0];
    // this.message    = argv._[1] + '';
    // this.flag       = argv._[2];
    // this.lang       = argv._[3];
    // this.username   = argv._[4];
    // this.link       = argv._[5];
    // this.icon       = argv._[6];
    // this.opt        = argv._[7];
    let data;
    try {
      data = JSON.parse(argv._[0]);
    } catch (e) {
      data = {
        lang : 'en',
        username : "Team Drumee"
      };
    }
    this.lang  = data.lang || 'en';
    this.hub_id = data.hub_id;
    this.message = data.message;
    this.flag = data.flag;
    this.lang = data.lang;
    this.username = data.username;
    this.link = data.link;
    this.opt  = data.options || {};
    new Cache();
    for(let name of ['hub_id', 'flag']){
      if (_.isEmpty(this[name])) {
        let msg =  `attribute *${name}* must bet set`;
        this.stop(msg);
      }
    }
    this.service = 'hub.external_notification';
    this.prepare(data).then(()=>{
      this.debug("Normal ternimation");
      process.exit(0);
    }).catch((e)=>{
      this.debug("Abnormal termination\n", e);
      process.exit(1);
    });    
  }

  /**
   * 
   * @return promise 
   */
  async prepare(data) {
    //
    await Cache.load(this.yp)
    this.debug("AAAA:63", data);

    //Get the members list 
    let members = await this.yp.await_proc('forward_proc', this.hub_id, 'dmz_notify_list', `${sqlString(this.flag)}`);
    if (_.isEmpty(members)) { return }
    if (!_.isArray(members)) { members = [members]; }

    let message = this.message.replace(/\n/g, '<br>');
    const subject = this.opt.subject || `${Cache.message('_sent_you_sharebox', this.lang)
      .format(this.username)}`;
    for (let m of members) {

      let link = `${this.link}/${m.token}`;
      if(m.email == Cache.getSysConf('public_email')) continue;
      this.debug("SENDING TO", m.email);
      const msg = new Messenger({
        template: this.opt.template || "butler/sharebox",
        subject: `Drumee: ${subject}`,
        recipient: m.email,
        lex: Cache.lex(this.lang),
        data: {
          icon: this.icon,
          lang: this.lang,
          sender:this.username,
          subject: Cache.message('_inbound_mailbox', this.lang).format(this.username),
          message,
          recipient: m.email.replace(/@.+$/, ''),
          signature: this.username,
          link,
          ...this.opt.data
        },
      });
      await msg.send();
      await this.yp.await_proc('dmz_update_notify', m.token);
    }
  }

}

new __offline_sharebox_notification_mail();
