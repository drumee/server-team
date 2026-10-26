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
const Jsonfile  = require('jsonfile');
const Path      = require('path');
const {Mariadb, Messenger, Offline} = require('@drumee/server-essentials');
const { sendMail } = require("../../service/lib/send-mail");

class __send_mail extends Offline {

// ========================
// initialize
// ========================
  async initialize() {
    const argv      = Minimist(process.argv.slice(2));
    this.yp         = new Mariadb({user:process.env.USER});
    let id   = argv._[0];
    const batch = Path.resolve(process.env.DRUMEE_TMP_DIR, '.mail', `${id}.json`);
    const data = Jsonfile.readFileSync(batch);
    this.set(data);

    const msg = new Messenger(data);
    await sendMail(msg);    
  }
  
}

new __send_mail();
//module.exports = __send_mail;
