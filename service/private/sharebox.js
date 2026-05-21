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
  Permission, Privilege,
  Attr, Constants,
  Messenger, Cache
} = require('@drumee/server-essentials/index.js');
const { stringify } = JSON;
const { isArray, isEmpty, } = require('lodash');
const { shouldSendNotification } = require("../lib/email-policy");


const __public = require('../sharebox.js');
class __private_sharebox extends __public {

  constructor(...args) {
    super(...args);
    this.pre_revoke = this.pre_revoke.bind(this);
    this.copy_to_sb = this.copy_to_sb.bind(this);
    this.pre_assign = this.pre_assign.bind(this);
    this.check_compliances = this.check_compliances.bind(this);
    this.pre_link = this.pre_link.bind(this);
    this.get_node_share_attr = this.get_node_share_attr.bind(this);
    this.get_outbound_node_attr = this.get_outbound_node_attr.bind(this);
    this.get_inbound_node_attr = this.get_inbound_node_attr.bind(this);
    this.create_link = this.create_link.bind(this);
    this.remove_link = this.remove_link.bind(this);
    this.update_link = this.update_link.bind(this);
    this.copy_link = this.copy_link.bind(this);
    this.notification_count = this.notification_count.bind(this);
    this.notification_list = this.notification_list.bind(this);
    this.accept_notification = this.accept_notification.bind(this);
    this.refuse_notification = this.refuse_notification.bind(this);
    this.revoke_permission = this.revoke_permission.bind(this);
    this.assign_permission = this.assign_permission.bind(this);
  }

  /**
   * 
   */
  async pre_revoke() {
    this.heap.nodes = this.source_nodes();
    this.heap.invalidemails = [];
    this.heap.fileexists = {};
    this._done();
  }

  /**
   * 
   */
  async copy_to_sb() {
    const src = this.heap.srcgrantlst;
    this.heap.nodes = this.source_nodes();
    for (let n of this.heap.srcgrantlst) {
      await this.db.await_proc('rename_trash',
        n.nid, n.hub_id, this.heap.sb.outbound, this.heap.sb.hub_id
      );
    }

    this.transact('mfs_copy_all');
  }

  /**
   * Prepare requirements to execute assign 
   */
  async pre_assign() {

    let emails = this.input.need(Constants.EMAIL);
    if (!isArray(emails)) {
      emails = [emails];
    }
    await this.pre_transact(0);
    this.heap.nodes = this.source_nodes();
    this.heap.emails = emails;
    this.heap.fileexists = [];
    this.heap.srclst = {};
    this.heap.invalidemails = [];
    this.heap.results = [];
    this.heap.guests = [];
    this.heap.drumates = [];
    let res;
    for (let node of this.heap.nodes) {
      let nids = node.nid;
      if (!isArray(nids)) {
        nids = [nids];
      }
      for (let nid of nids) {
        res = await this.db.await_proc('mfs_access_node', this.user.uid(), nid);
        if (!isEmpty(res)) {
          this.heap.srclst[nid] = res;
        }
      }
    }
    let row;
    let guest;
    for (var email of emails) {
      if ((email == null) || !email.isEmail()) {
        this.heap.invalidemails.push({ email });
      } else {
        row = await this.yp.await_proc('drumate_exists', email);
        if (isEmpty(row)) {
          guest = await this.yp.await_proc('yp_add_guest', email, '', '', 0);
          this.heap.guests.push(guest);
        } else {
          this.heap.drumates.push(row);
        }
      }
    }
    this.check_compliances();
  }

  /**
   * Prerequisite to execute moving
   * @returns 
   */
  check_compliances() {
    const src = this.heap.srcgrantlst; //this.heap.srclst;
    this._failed = false;
    if (isEmpty(this.heap.srcgrantlst)) {
      this.exception.user(Constants.INVALID_DATA);
      return;
    }

    if (!isEmpty(this.heap.invalidemails)) {
      this.exception.user(Constants.INVALID_EMAIL_FORMAT, '', this.heap.invalidemails);
      return;
    }
    this._done();
  }

  /**
   * Prerequisite to share through link
   */
  async pre_link() {
    await this.pre_transact(0);
    this.check_compliances();
  }


  /**
   * 
   */
  pre_share_in() {
    this.check_sanity(1);
    this._done();
  }

  /**
   * 
   */
  async get_node_share_attr() {
    const nid = this.input.need(Constants.NODE_ID);
    const option = this.input.need(Attr.option);
    const sb_db = this.visitor.get('sb_db');

    let data = await this.db.await_proc(
      `${sb_db}.get_node_share_attr`,
      nid, this.uid, option, null
    );
    this.output.data(data);
  }

  /**
   * 
   */
  async get_outbound_node_attr() {
    let nid = this.input.need(Constants.NODE_ID);
    if (!isArray(nid)) {
      nid = [nid];
    }

    let data = await this.db.await_proc(
      "get_outbound_node_attr",
      stringify(nid), this.uid
    );
    this.output.list(data);
  }

  /**
   * 
   */
  async get_inbound_node_attr() {
    let nid = this.input.need(Constants.NODE_ID);
    if (!isArray(nid)) {
      nid = [nid];
    }

    let data = await this.db.await_proc(
      "get_inbound_node_attr", stringify(nid), this.uid
    );
    this.output.data(data);
  }


  /**
   * 
   */
  async create_link() {
    let share_id = this.randomString();
    const ids = [];
    const permission = this.input.get(Attr.permission) || Permission.download;
    const days = this.input.get(Attr.days) || 0;
    const hours = this.input.get(Attr.hours) || 0;
    const expiry = days * 24 + hours;
    let sb_db = this.user.get('sb_db');
    for (var node of this.heap.srcgrantlst) {
      ids.push(node.nid);
      let share = await this.yp.await_proc(`${sb_db}.dmz_check_share`,
        share_id, node.nid, this.uid, '*'
      );
      if (share_id === share.share_id) {
        let p = await this.yp.await_proc(`${sb_db}.permission_grant`,
          node.nid, '*',
          expiry, permission, 'link', share.share_id
        );
        await this.yp.await_proc(`${sb_db}.dmz_add_link`,
          share.share_id, p.id, this.uid, '*'
        );
      } else {
        share_id = share.share_id;
      }
    }
    let data = await this.yp.await_proc(
      `${sb_db}.get_outbound_node_attr`, stringify(ids), this.uid
    );
    this.output.list(data);
  }

  /**
   * 
   */
  async create_public_box() {
    const name = this.input.need(Attr.name);
    const permission = this.input.get(Attr.permission) || Privilege.download;
    const pw = this.input.get(Attr.password) || '';
    const days = this.input.get(Attr.days) || 0;
    const hours = this.input.get(Attr.hours) || 0;
    const expiry = days * 24 + hours;
    let res = {};
    let share;
    let node;
    let share_id
    let metadata = {};


    node = await this.db.await_proc("mfs_make_dir", this.home_id, stringify([name]), 1);
    if (isEmpty(node)) {
      res.status = 'LINK_FAILED';
      return this.output.data(res);
    }
    metadata.sharebox = 'private'
    await this.db.await_proc("mfs_update_metadata", node.id, stringify(metadata));

    share_id = this.randomString();
    share = await this.db.await_proc('dmz_check_share',
      share_id, 'public', node.nid, this.uid
    );

    if (share.state == 'private') {
      res.status = 'INVALID_STATE';
      return this.output.data(res);
    }

    if (share_id != share.share_id) {
      share_id = share.share_id;
    }
    let p = await this.db.await_proc("permission_grant", node.id, '*', expiry, permission, 'link', share_id);
    await this.db.await_proc('dmz_add_share',
      share_id, p.id, this.uid, '*', 'private', node.id, pw);

    res = await this.db.await_proc('dmz_show_link_content', share_id)
    let host = this.hub.get(Attr.vhost);
    res.link = `${this.input.homepath(host)}/#/dmz/inbound/token=${share_id}`;
    this.output.data(res);
  }

  /**
   * 
   */
  async create_private_box() {
    const email = this.input.need(Attr.email);
    const permission = this.input.get(Attr.permission) || Privilege.upload;
    const pw = this.input.get(Attr.password) || '';
    const days = this.input.get(Attr.days) || 10;
    const hours = this.input.get(Attr.hours) || 0;
    const expiry = days * 24 + hours;
    let drumate;
    let guest;
    let res = {};
    let share;
    let node;
    let share_id
    let metadata = {};

    drumate = await this.yp.await_proc('drumate_exists', email);
    if (!isEmpty(drumate)) {
      res.status = 'DRUMATE_EMAIL';
      return this.output.data(res);
    }
    guest = await this.yp.await_proc('yp_add_guest', email, '', '', 0);

    node = await this.db.await_proc("mfs_make_dir", this.home_id, stringify([email]), 1);
    if (isEmpty(node)) {
      res.status = 'LINK_FAILED';
      return this.output.data(res);
    }
    metadata.sharebox = 'private'
    await this.db.await_proc("mfs_update_metadata", node.id, stringify(metadata));
    share_id = this.randomString();

    share = await this.db.await_proc('dmz_check_share',
      share_id, 'private', node.nid, this.uid
    );
    if (share.state == 'public') {
      res.status = 'INVALID_STATE';
      return this.output.data(res);
    }

    if (share_id != share.share_id) {
      share_id = share.share_id;
    }
    let p = await this.db.await_proc("permission_grant", node.id, '*', expiry, permission, 'link', share_id);
    res = await this.db.await_proc('dmz_add_share',
      share_id, p.id, this.uid, guest.id, 'private', node.id, pw);

    let host = this.hub.get(Attr.vhost);
    res.link = `${this.input.homepath(host)}/#/dmz/inbound/token=${share_id}`;
    this.output.data(res);
  }

  /**
   * 
   */
  async get_box_attr() {
    const nid = this.input.need(Constants.NODE_ID);
    let res = {};
    res = await this.db.await_proc('dmz_show_link_content', nid)
    let host = this.hub.get(Attr.vhost);
    res.link = `${this.input.homepath(host)}/#/dmz/inbound/token=${res.share_id}`;
    this.output.data(res);
  }

  /**
   * 
   */
  async update_box() {
    const nid = this.input.need(Constants.NODE_ID);
    const permission = this.input.use(Attr.permission) || Privilege.upload;
    const pw = this.input.get(Attr.password) || '';
    const days = this.input.get(Attr.days) || 0;
    const hours = this.input.get(Attr.hours) || 0;
    const expiry = days * 24 + hours;
    let res = {};
    let share;
    let share_id
    share_id = this.randomString();
    share = await this.db.await_proc('dmz_check_share',
      share_id, 'public', nid, this.uid
    );
    if (share_id == share.share_id) {
      res.status = 'INVALID_NID';
      return this.output.data(res);
    }
    share_id = share.share_id;
    let p = await this.db.await_proc("permission_grant", nid, '*', expiry, permission, 'link', share_id);
    await this.db.await_proc('dmz_add_share',
      share_id, p.id, this.uid, '*', 'private', nid, pw);

    res = await this.db.await_proc('dmz_show_link_content', share_id)
    let host = this.hub.get(Attr.vhost);
    res.link = `${this.input.homepath(host)}/#/dmz/inbound/token=${share_id}`;

    this.output.data(res);
  }


  /**
   * 
   * @param {*} share_id 
   * @param {*} host 
   * @param {*} email 
   */
  async _send_inbound_link_old(share_id, host, email) {
    let message = this.input.use(Attr.message) || '';
    const lang = this.user.language() || this.input.app_language();
    message = message.replace(/\n/g, '<br>');
    const username = this.user.get('fullname');
    const link = `${this.input.homepath(host)}/#/dmz/inbound/token=${share_id}`;
    const subject = `${Cache.message('_sent_you_drop_link', lang)
      .format(username)}`;

    // Inbound share notification — gate by recipient's email_notifications.
    if (!(await shouldSendNotification(this.yp, email))) return;

    const msg = new Messenger({
      template: "butler/inbound",
      subject: `Drumee: ${subject}`,
      recipient: email,
      lex: Cache.lex(lang),
      data: {
        icon: this.hub.get(Attr.icon),
        lang,
        subject: Cache.message('_inbound_mailbox', lang).format(username),
        message: message,
        recipient: email.replace(/@.+$/, ''),
        signature: username,
        link,
      },
      handler: this.exception.email
    });
    await msg.send();
  }

  /**
   * 
   * @param {*} args 
   * @returns 
   */
  async _send_inbound_link(args) {
    let message = this.input.use(Attr.message) || '';
    const lang = this.user.language() || this.input.app_language();
    const email = this.input.need(Attr.email);
    message = message.replace(/\n/g, '<br>');
    if (args == null) {
      this.exception('Failed to create link');
      return;
    }
    let node = args.node;
    let share_id = args.share.share_id;
    const username = this.user.get('fullname');
    const link = `${this.input.homepath(host)}/#/dmz/inbound/token=${share_id}`;
    const subject = `${Cache.message('_sent_you_drop_link', lang)
      .format(username)}`;
    for (let recipient of email) {
      // Inbound share notification — gate per-recipient by their preference.
      if (!(await shouldSendNotification(this.yp, recipient))) continue;
      const msg = new Messenger({
        template: "butler/inbound",
        subject: `Drumee: ${subject}`,
        recipient: recipient,
        lex: Cache.lex(lang),
        data: {
          icon: this.hub.get(Attr.icon),
          lang,
          subject: Cache.message('_inbound_mailbox', lang).format(username),
          message: message,
          recipient: recipient.replace(/@.+$/, ''),
          signature: username,
          link,
        },
        handler: this.exception.email
      });
      await msg.send();
    }
    this.output.data(node);
  }

  /**
   * 
   * @returns 
   */
  async create_inbound_link() {
    const email = this.input.need(Attr.email);
    const nid = this.input.need(Attr.nid);
    if (!isArray(email)) {
      email = [email];
    }
    let share_id = this.randomString();
    const days = this.input.get(Attr.days) || 0;
    const hours = this.input.get(Attr.hours) || 0;
    const expiry = days * 24 + ~~hours;
    const node = await this.db.await_proc("mfs_make_dir", nid, stringify(email), 1);
    if (isEmpty(node)) {
      this.exception('Failed to create link');
      return;
    }
    const share = await this.db.await_proc('dmz_check_share',
      share_id, node.id, this.uid, Constants.ID_NOBODY);
    if (isEmpty(share)) {
      this.exception('Failed to create link');
      return;
    }

    let p = await this.db.await_proc('permission_grant', node.id, '*',
      expiry, Permission.upload, 'link', share.share_id);
    await this.db.await_proc('dmz_add_link',
      share.share_id, p.id, this.uid, Constants.ID_NOBODY
    );
    await this._send_inbound_link({ node, share });
  }


  /**
   * 
   */
  async remove_link() {
    const nid = this.input.need(Attr.nid);
    const sid = this.input.need(Attr.share_id);
    await this.db.await_proc('dmz_delete_share', nid, sid);
    let data = await this.db.await_proc(
      'get_outbound_node_attr', stringify([nid]), this.uid
    );
    this.output.data(data);
  }

  /**
   * 
   */
  async update_link() {
    const vars = this.normalize_ids(this.input.need(Attr.nid));
    const sid = this.input.need(Attr.share_id);
    const nid = [];
    const perm = this.input.use(Attr.permission) || Permission.view;
    const hours = this.input.use('hours') || 0;
    const days = this.input.use('days') || 0;
    const expiry = ((~~days) * 24) + ~~hours;


    for (let data of vars) {
      nid.push(data.nid);
      await this.db.await_proc(
        'permission_grant', data.nid, '*', expiry, perm, 'link', sid
      );
    }
    let data = await this.db.await_proc(
      'get_outbound_node_attr',
      stringify(nid), this.uid
    );
    this.output.data(data);

  }

  /**
   * 
   */
  async copy_link() {
    const nid = this.input.need(Constants.NODE_ID);
    const permission = this.input.use(Attr.permission, 1);
    const message = this.input.use(Attr.message, '');
    const days = this.input.use(Attr.days, 0);
    const hours = this.input.use(Attr.hours, 0);
    const expiry = (hours * 1) + (days * 24);
    await this.db.await_proc(
      'permission_grant', nid, 'nobody', expiry, permission, 'link', message
    );
    let data = await this.db.await_proc('get_node_link', nid, 'nobody');
    this.output.data(data);
  }


  /**
   * 
   */
  notification_count() {
    this.yp.call_proc('yp_notification_count', this.uid, this.output.data);
  }

  /**
   * 
   */
  notification_list() {
    this.yp.call_proc('yp_notification_receive_list', this.uid, this.output.list);
  }

  /**
   * 
   * @returns 
   */
  async accept_notification() {
    const nid = this.input.need(Constants.NODE_ID);
    let data = await this.yp.await_proc('yp_notification_accept', nid, this.uid);
    if (!data.status) {
      this.output.data();
      return;
    }
    const { owner_id } = data;
    const { permission } = data;
    const expiry = data.expiry_time;
    const { message } = data;
    await this.db.await_proc(
      'sbx_accept', owner_id, nid, this.uid, permission, expiry, message
    );
    await this.yp.await_proc('yp_notification_receive_list', this.uid);
    data = await this.db.await_proc('mfs_node_attr', nid);
    this.output.data(data);
  }

  /**
   * 
   */
  async refuse_notification() {
    const nid = this.input.need(Constants.NODE_ID);
    await this.yp.await_proc('yp_notification_remove', nid, this.uid);
    let data = await this.yp.await_proc('yp_notification_receive_list', this.uid);
    this.output.data(data);
  }

  /**
   * 
   */
  async revoke_permission() {
    let uids = this.input.need(Attr.user_id);
    if (!isArray(uids)) {
      uids = [uids];
    }
    let drumate;
    for (let uid of uids) {
      drumate = await this.yp.await_proc('drumate_exists', uid);
      for (let node of this.heap.nodes) {
        let nid = node.nid
        //  for(let nid of node.nid){
        if (isEmpty(drumate)) {
          await this.db.await_proc('dmz_remove_link', nid, uid);
        } else {
          await this.db.await_proc('sbx_remove', this.user.uid(), nid, uid);
        };
        await this.db.await_proc('permission_revoke', nid, uid);
        await this.yp.await_proc('yp_notification_remove', nid, uid);
        //   }
      }
    }
    this.output.data(drumate);
  }

  /**
   * 
   * @returns 
   */
  async assign_permission() {
    const heap = this.heap;
    let error, nid;
    const objerr = [];
    const nids = [];

    for (nid in heap.srclst) {
      const node = heap.srclst[nid];
      if ((node === undefined) || (node === "") || (node.nid === undefined)) {
        error = Constants.FILE_NOT_FOUND;
        objerr.push({ nid });
      } else {
        nids.push(nid);
      }
    }

    if (objerr.length) {
      this.exception.user(error, objerr);
      return;
    }

    const nb = (heap.drumates.length + heap.guests.length + heap.guests.length);

    if (!nb) {
      this.exception.user(Constants.INVALID_DATA);
      return;
    }

    await this.assign_drumate_permission();
    await this.assign_guest_permission();
    let data = await this.db.await_proc(
      "get_outbound_node_attr",
      stringify(nids), this.user.uid()
    );
    this.output.data(data);
  }

  /**
   * 
   * @returns 
   */
  async assign_drumate_permission() {
    const perm = this.input.need(Attr.privilege) || this.input.need(Attr.permission) || priv.read;
    let message = this.input.use(Attr.message) || ""; //Cache.message('_outbound_default_msg');
    const days = this.input.use(Attr.days, 0);
    const hours = this.input.use(Attr.hours, 0);
    const expiry = (hours * 1) + (days * 24);
    let heap = this.heap;
    for (var drumate of heap.drumates) {
      for (let nid of heap.nodes) {
        let node = await this.yp.await_proc('yp_notification_next',
          this.uid, nid.nid, drumate.id, null, expiry, perm, message);
        if (isEmpty(node)) continue;
        node.nid = nid;
        var content = {
          message: message,
          nid: nid
        };
        // node.service = 'share.inbound';
        await this.notify_user(drumate.id, content);
        //recipients.push([drumate.id, content]);
        if (node.status === 'change') {
          await this.db.await_proc('sbx_accept',
            this.user.uid(), nid.nid, drumate.id, perm, expiry, message);
        }
      }
    }
    return 1;
  }


  /**
   * 
   * @returns 
   */
  async assign_guest_permission() {
    const ulang = this.user.language() || this.input.app_language();
    const fullname = this.user.get('fullname');
    const perm = this.input.need(Attr.privilege) || this.input.need(Attr.permission) || priv.read;
    let message = this.input.use(Attr.message) || "";
    const days = this.input.use(Attr.days, 0);
    const hours = this.input.use(Attr.hours, 0);
    const expiry = (hours * 1) + (days * 24);
    let heap = this.heap;
    let username, share, node;
    let subject = Cache.message('_sent_you_files', ulang)
      .format(fullname, heap.nodes.length);
    for (var guest of heap.guests) {
      if (guest.firstname != null) {
        username = guest.firstname;
      } else {
        username = guest.email.split('@')[0];
      }
      var share_id = this.randomString();
      for (node of heap.nodes) {
        share = await this.db.await_proc('dmz_check_share',
          share_id, node.nid, this.user.uid(), guest.id);
        let attr = await this.db.await_proc('mfs_node_attr', node.nid);
        if (isEmpty(share)) continue;
        await this.yp.await_proc('yp_notification_next',
          this.uid, node.nid, guest.id, share.share_id, expiry, perm, message);
        // guest id is not bound to a password, it's so unecessary to add it 
        // into the permission list. In fact, this may create breach 
        // wildrcard is enough as the access is only protect by sahre_id
        // guest.id is used only to identify recipent email/name
        //@db.await_proc 'permission_grant', nid, guest.id, expiry, perm, 'share', msg, ()=>

        let p = await this.db.await_proc('permission_grant',
          node.nid, '*', expiry, perm, 'share', message);

        await this.db.await_proc('dmz_add_link',
          share.share_id, p.id, this.uid, guest.id);
        let host = this.hub.get(Attr.vhost);
        let link = `${this.input.homepath(host)}/#/dmz/${share.share_id}`;
        if (!isEmpty(message)) {
          message = message.replace(/\n/g, '<br>');
        }
        const lang = this.user.language() || this.input.app_language();
        const filesize = require("filesize");
        // Outbound share notification — gate by recipient's preference.
        if (!(await shouldSendNotification(this.yp, guest.email))) continue;
        let msg = new Messenger({
          //template  : "en/guest-share",
          template: "butler/outbound",
          subject: `Drumee: ${subject}`,
          recipient: guest.email,
          lex: Cache.lex(ulang),
          data: {
            icon: this.hub.get(Attr.icon),
            files: [{ filename: attr.filename, filesize: filesize(attr.filesize) }],
            subject: Cache.message('_outbound_default_msg', lang).format(fullname),
            message,
            recipient: guest.email.replace(/@.+$/, ''),
            signature: fullname,
            link,
          },
          handler: this.exception.email
        });
         await msg.send();
      }
    }
    return 1;
  }
}


module.exports = __private_sharebox;
