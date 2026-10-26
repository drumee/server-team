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
const {Mariadb, toArray, Cache, Messenger} = require('@drumee/server-essentials');
const {MfsTools} = require('@drumee/server-core');
const {remove_dir, make_home_dir } = MfsTools;
const yp = new Mariadb({ user: process.env.USER, verbose: 0 });
new Cache();

const {resolve} = require('path');
const {readFileSync} = require('jsonfile');
const Moment = require('moment');
const { sendMail } = require("../../service/lib/send-mail");


async function go() {
  await Cache.load(yp);
  let users = await yp.await_proc('renewal_expiry')
  users = toArray(users) || [];
  for (let drumate of users) {
    await send(drumate)

    if (drumate.next_action >= 5) {
      const quota = Cache.getSysConf('advanced_quota')
      yp.await_proc('drumate_update_profile', drumate.entity_id, JSON.stringify({ quota: quota }))

    }

    if (drumate.next_action == 19) {
      let disk_limit = await yp.await_proc('disk_limit', drumate.id);
      let avaialbe_disk_limit = disk_limit.available_disk
      console.log("------------------------CLEAN---------------", avaialbe_disk_limit)
      if (avaialbe_disk_limit <= 0) {
        await clean(drumate)
      }
    }
   await yp.await_proc('renewal_expiry_update', drumate.entity_id, drumate.subscription_id, drumate.next_action)
  }

  process.exit(1);

}

async function send(drumate) {
  let cache = new Cache({ yp: yp, lang: 'en' });
  // await cache.ready();
  await cache.loadSysConfigs();
  let email = drumate.email
  let lang = drumate.lang
  // let action = drumate.next_action
  // let renewal_date = drumate.next_renewal_time

  let p = resolve(__dirname, '../../dataset/locale', `${lang}.json`);
  let locale = readFileSync(p);
  Moment.locale(lang);


  let last_date = Moment(drumate.last_time, 'X').format("DD/MM/YYYY");

  //let message = `Your renewal has expired  ${expiry}  notify by ${drumate.next_action} notify at ${action_date} .`

  let subject = cache.message('_subscription_pro_expired_subject', lang)
  const message = cache.message('_subscription_pro_expired_message', lang).format(drumate.days_since, last_date, last_date)
  const label = cache.message('_subscription_pro_link', lang);
  let vhost = await yp.await_proc('domain_exists', 1);

  // let pathname = this.get(_a.location).pathname.replace(/(svc|service).*$/, '');
  //const link = `${input.homepath(vhost.name)}#`;

  let link;
  const msg = new Messenger({
    template: "butler/subscription-pro-expired",
    subject,
    recipient: email,
    lex: locale,
    data: {
      message: message,
      label: label,
      sender: drumate.fullname,
      recipient: drumate.email,
      redirect_link: link
    },

  });
  await sendMail(msg);

}


/**
 * 
 * @param {*} drumate 
 */
async function clean(drumate) {
  let hubs = await yp.await_proc('hub_all', drumate.id);
  hubs = toArray(hubs) || [];
  for (let hub of hubs) {
    if (hub.area != 'dmz') {
      //console.log("----", hub.area, hub.home_dir)
      await yp.await_proc(`forward_proc`, hub.id, 'remove_all_members', `'0'`);
      let entity = await yp.await_proc('entity_delete', hub.id);
      remove_dir(hub.home_dir, 1);
    }
    if (hub.area == 'dmz') {
      let home_dir = hub.home_dir + '__storage__/'
      //console.log("----", home_dir)
      remove_dir(home_dir, 1);
      make_home_dir(hub.home_dir)
      await yp.await_proc('wipe_wicket_hub', hub.id);
    }
  }

  let member = await yp.await_proc('drumate_exists', drumate.id);
  let member_home_dir = member.home_dir + '__storage__/'
  remove_dir(member_home_dir, 1);
  make_home_dir(member.home_dir)
  await yp.await_proc('wipe_user_desk', drumate.id);
  //await yp.await_proc('wipe_user_renewal', drumate.id);

}

go().then(()=>{
  process.exit(0)
}).catch((e)=>{
  console.error("Failed to run downgrad", e);
  process.exit(1);
});

