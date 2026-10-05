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
const { isEmpty } = require('lodash');
const Socket = require('./index');
const { Data, MfsTools } = require('@drumee/server-core');
const { copy_node } = MfsTools;
const { toArray } = require('@drumee/server-essentials');
const { sqlString } = require('../lib/sql-literal');

//########################################
class __push_chat extends Socket {

  // ========================
  // 
  // ========================
  constructor(...args) {
    super(...args);
    this.ring = this.ring.bind(this);
    this.send_contact_msg = this.send_contact_msg.bind(this);
    this.send_contact_file = this.send_contact_file.bind(this);
    this.send_group_msg = this.send_group_msg.bind(this);
    this.send_group_file = this.send_group_file.bind(this);
    this._copy_node = this._copy_node.bind(this);
    this._send = this._send.bind(this);
    this.transact = this.transact.bind(this);
  }

  // ========================
  // 
  // ========================
  ring(args) {
    const self = this;
    const sender = self.user.ident();
    const data = (args.isData) ? args : new Data(args);
    let recipient = data.recipient();
    let message = data.get('message') || data.get(2) || "Sent you a poke";
    // let recipient = data[1]
    self.debug("DATA", args, data.data());
    self.debug(`"RECIPIENT=${recipient}"`);
    self.debug("RING", `${sender} --> ${recipient}`, self.user.uid(), args);
    //const message = args[2] || "Sent you a poke";
    if (isEmpty(recipient)) {
      console.warn("RECIPIENT NOT SET");
      self.echo({ error: "Require id or email" });
      return;
    }
    self.sendTo(recipient, { message })
  }


  // ========================
  // 
  // ========================
  send_contact_msg(args) {
    const self = this;
    const data = this.parser(args);
    const recipient = data.recipient();
    const message = data.get("message");
    const forward = data.get('forward') || 0;
    //this.debug(`QQQQQ rZZZZZZZZZecipient=${recipient} ${message} ${forward}`, data);
    const uid = self.user.uid();
    async function f() {
      const c = await self.yp.await_proc(self.proc('my_contact_get'), recipient, null);
      if (isEmpty(c)) {
        self.echo({ error: "CONTACT_NOT_FOUND" });
        return null;
      }

      const r = await self.yp.await_proc('get_visitor', recipient);
      if (isEmpty(r) || r.id !== recipient) {
        self.echo({ error: "CONTACT_NOT_DRUMATE" });
        return null;
      }

      const msg = await self.yp.await_proc(self.proc('send_contact_message'), uid,
        recipient, message, forward);
      //self.debug("JJJJJJJJJJJJJ", message, forward, msg);
      return msg;
    };
    f().then(data => { if (data) self.transact(data) }).catch(self.fallback);
    self.echo({ status: "ok" });
  }



  // ========================
  // 
  // ========================
  send_contact_file(args) {
    const self = this;
    const data = this.parser(args);
    const recipient = data.recipient();
    const message = data.get("message");

    if (args.length !== 0) {
      is_forward = args.shift();
    }
    const uid = self.user.uid();
    async function f() {
      let contact = await self.yp.await_proc(self.proc('my_contact_get'), recipient, null);
      if (isEmpty(contact)) {
        self.echo({ error: `CONTACT_NOT_FOUND ${recipient}` });
        return;
      }
      let data = await self.yp.await_proc(self.proc('mfs_access_node'), uid, file_id);
      if (isEmpty(data)) {
        self.echo({ error: "FILE_NOT_FOUND" });
        return;
      }
      data = await self.yp.await_proc(self.proc('send_contact_file',
        uid, recipient, file_id, message, is_forward));
      return data;
    }

    f().then(function (data) {
      if (isEmpty(data)) {
        return;
      }
      self.transact(data);
    }).catch(self.fallback);
  }


  // ========================
  // 
  // ======================== 
  send_group_msg(args) {
    const group_id = args.shift();
    const message = args.shift();
    let is_forward = 0;
    if (args.length !== 0) {
      is_forward = args.shift();
    }
    const ident = self.user.uid();
    async function f() {
      let group = await self.yp.await_proc('forward_proc', self.user.uid(), 'contact_get_group', `${sqlString(group_id)}, ${sqlString(ident)}`)
      if (isEmpty(group)) {
        self.echo({ error: `${group_id} not found` });
        return;
      }
      let data = await self.yp.await_proc('forward_proc',
        self.user.uid(), 'send_group_message',
        `${sqlString(ident)}, ${sqlString(group_id)},${sqlString(message)}, ${sqlString(is_forward)}`);
      return data;
    }
    f().then(function (data) {
      if (isEmpty(data)) {
        return;
      }
      self.transact(data);
    }).catch(self.fallback);
  }

  // ========================
  // 
  // ========================
  send_group_file(args) {
    const group_id = args.shift();
    const file_id = args.shift();
    const message = args.shift();
    let is_forward = 0;
    if (args.length !== 0) {
      is_forward = args.shift();
    }
    const uid = self.user.uid();


    async function f() {
      let group = await self.yp.await_proc(self.proc('contact_get_group'), `'${group_id}', '${ident}'`)
      if (isEmpty(group)) {
        self.echo({ error: `${group_id} not found` });
        return;
      }
      let data = await self.yp.await_proc(self.proc('mfs_access_node'), `'${uid}', '${file_id}'`);
      if (isEmpty(data)) {
        self.echo({ error: "FILE_NOT_FOUND" });
        return;
      }
      data = await self.yp.await_proc(self.proc('send_group_file'),
        `'${ident}', '${group_id}',
        '${file_id}', '${message}', '${is_forward}'`);
      return data;
    }

    f().then(function (data) {
      if (isEmpty(data)) {
        return;
      }
      self.transact(data);
    }).catch(self.fallback);

  }

  // ========================
  // 
  // ========================
  _copy_node(node) {
    var profile = this.parseJSON(node.profile);
    var srclst = { 'nid': profile.id, "mfs_root": profile.home_dir };
    var deslst = { 'nid': profile.new_id, "mfs_root": profile.dest_home_dir };
    copy_node(srclst, deslst, 1);
  }

  // ========================
  // 
  // ========================
  _send(node) {
    var profile = this.parseJSON(node.profile);
    var output = {
      entity_id: this.user.uid(),
      room_name: profile.room_name,
      room_id: profile.room_id,
      message: profile.message,
      filename: profile.filename,
      chat_id: profile.chat_id,
      ctime: profile.time,
      name: profile.name
    };
    if (profile.file_id) {
      output.file_id = profile.file_id;
    }
    this.sendTo(profile.to_entity_id, output);
  }


  // ========================
  // 
  // ========================
  transact(data) {
    const self = this;
    data = toArray(data);
    async function f() {
      for (let node of data) {
        switch (node.action) {
          case 'copyone':
          case 'copy':
            self._copynode(node);
            break;
          case 'message':
          case 'file':
            self._send(node);
            break;
          default:
        }
      }
      return data;
    }
    f().then(function (rows) {
      self.debug("TRANSACT", rows);
    }).catch(self.fallback);
  }

}

module.exports = __push_chat;
