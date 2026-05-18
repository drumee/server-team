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
const { Attr, Constants } = require("@drumee/server-essentials");
const {resolve} = require('path');
const {isArray, map, isString} = require('lodash');
const {Mfs} = require('@drumee/server-core');
const {writeFileSync, readFileSync} = require('jsonfile');
const {Messenger, Cache} = require('@drumee/server-essentials');

//########################################
class __form extends Mfs {

  /**
   * 
   * @param {*} schema 
   */
  async insert(conf, data) {
    //this.debug("AAAA:26", schema, data);
    const uaParser = require('ua-parser-js');
    const Geoip = require('geoip-lite');
    const Moment = require('moment');
    let schema = conf.schema;
    let node = this.source_granted().node;
    let table = `form_${node.id}`;
    if (schema.ctime) {
      data.ctime = data.ctime || Math.floor(Moment.now() / 1000);
    }
    if (schema.ua) {
      if (!data.ua) {
        let d = uaParser(this.input.ua());
        if (d.type) {
          data.ua = `${d.device.vendor}/${d.device.model}/${d.device.type}`;
        } else {
          data.ua = `${d.os.name}/${d.browser.name}/${d.browser.version}`;
        }
      }
    }
    if (schema.geoloc) {
      if (!data.geoloc) {
        let g = Geoip.lookup(this.input.ip());
        if(g){
          data.geoloc = `${g.city}, ${g.region}, ${g.country}`;
        }
      }
    }
    let columns = `(`;
    for (var k in schema) {
      if (data[k] != null) {
        columns = `${columns} \`${k}\`, `;
      }
    }
    columns = columns.replace(/, *$/, ')');
    let sql = `INSERT INTO ${table} ${columns} VALUES(`;
    let values = [];
    for (var k in schema) {
      if (data[k] != null) {
        sql = `${sql} ?,`
        values.push(data[k]);
      }
    }
    sql = sql.replace(/, *$/, ')');
    await this.db.await_run(sql, values);
    sql = `SELECT * FROM ${table} ORDER BY ctime DESC LIMIT 1`;
    let key = conf.keys.primary;
    let item = await this.db.await_run(sql);
    return item[key] || item.ctime;
  }

  /**
   * 
   */
  getInfo(){
    let node = this.source_granted().node;
    let file = resolve(node.mfs_root, node.id, `orig.${node.ext}`);
    let conf = readFileSync(file);
    return {node, conf, file}
  }

  /**
   * 
   * @param {*} data 
   * @param {*} ticket_id 
   * @param {*} type 
   */
  async sendToBackoffice(data, ticket_id, type) {
    this.debug("AAAA:82", type);
    const lang = this.user.language() || this.input.app_language();
    const subject = Cache.message('_contact_request', lang).format(ticket_id);
    let recipients = [];

    let list = async (t)=> {
      if (!/^(owner|admin)$/.test(t)) return [];
      let r = await this.db.await_proc('hub_get_members_by_type', this.uid, t, 1);
      if(r && !isArray(r)) r = [r];
      return map(r, function(e){return e.email});
    }

    if(isArray(type)){
      for(var t of type){
        if(t.isEmail && t.isEmail()){
          recipients.push(t);
        }else if(/^(owner|admin)$/.test(t)){
          let r = await list(t);
          recipients = recipients.concat(r)
        }
      }
    }else if(isString(type)){
      recipients = await list(type);
    }
    this.debug("AAAA:87", recipients);
    const msg = new Messenger({
      template: "butler/contact-request",
      subject: `Drumee: ${subject}`,
      recipient:recipients,
      lex: Cache.lex(lang),
      data: {
        ...data,
        icon: this.hub.get(Attr.icon),
        lang,
        subject,
        recipient: "Drumee Team",
      },
      handler: this.exception.email
    });
    await msg.send();
  }

  /**
   * 
   * @param {*} emails 
   * @param {*} node 
   */
  async sendAck(data, ticket_id) {
    const lang = this.user.language() || this.input.app_language();
    const subject = Cache.message('_contact_ack', lang).format(ticket_id);
    const message = Cache.message('_contact_ack_message', lang);

    const msg = new Messenger({
      template: "butler/contact-ack",
      subject,
      recipient: data.email,
      lex: Cache.lex(lang),
      data: {
        recipient: data.contact_name,
        message
      },
    });
    await msg.send();

  }

  /**
   * 
   */
   async submit() {
    let data = this.input.get(Attr.data);
    let {node, conf} = this.getInfo();
    let ticket_id = await this.insert(conf, data);
    await this.sendToBackoffice(data, ticket_id, conf.recipients);
    await this.sendAck(data, ticket_id);
    this.output.data(node);
  }

 /**
   * 
   */
  async update() {
    const easyReading = { spaces: 2, EOL: '\r\n' };
    let name = this.input.get(Attr.name);
    let value = this.input.get(Attr.value);
    let {conf,file} = this.getInfo();
    if(name && value){
      conf[name] = value;
    }
    writeFileSync(file, conf, easyReading);
    this.output.data(conf);
  }
 /**
   * 
   */
  async info() {
    let {conf} = this.getInfo();
    this.output.data(conf);
  }

}


module.exports = __form;
