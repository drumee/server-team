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
const { isEmpty, isArray, difference, map } = require('lodash');
const __public_room = require("../room");
const { Attr, Privilege, Cache, sysEnv } = require("@drumee/server-essentials")

//########################################
class __private_room extends __public_room {


  /**
 * 
 */
  _getShareLink(token) {
    let keysel = this.hub.get(Attr.id);
    const pathname = `?keysel=${keysel}/#/dmz/meeting`;
    let link = `${this.input.homepath()}${pathname}`;
    if (token) link = `${link}/${token}`;
    return link;
  }

  /**
   * 
   * @param {*} recipients 
   * @param {*} node 
   */
  async _commit_invitation(recipients, node, notify = 1) {
    if (isEmpty(recipients)) return;
    const permission = this.input.use(Attr.permission) || Privilege.write;
    const pw = this.input.get(Attr.password);
    const days = this.input.get(Attr.days) || 0;
    const hours = this.input.get(Attr.hours) || 0;
    const expiry = (hours * 1) + (days * 24);

    let hub_id = this.hub.get(Attr.id);
    let nid = node.id;

    if (!isArray(recipients)) {
      recipients = [recipients];
    }
    for (var r of recipients) {
      let g = await this.yp.await_proc('dmz_add_user', r.email, r.name);
      let p = await this.yp.await_proc('dmz_grant_next', hub_id, nid,
        g.id, this.randomString(), pw
      );
      await this.db.await_proc('permission_grant',
        nid, g.id, expiry, permission, 'no_traversal', r.email
      );

      let mail_title = `${Cache.message('_video_meeting_invitation', this.lang).format(this.username)}`;

      let opt = {
        recipient: r.email,
        subject: mail_title,
        template: "butler/external-meeting",
        title: node.title,
        date: node.date,
        message: node.message,
        sender: this.user.get('fullname'),
        headline: node.headline,
        recipient_name: r.name || r.email,
        link: this._getShareLink(p.token),
      }
      if (notify) {
        await this.notify_by_email({ hub_id: node.hub_id, ...opt });
      }
    }
  }

  /**
   * 
   */
  async public_link() {
    const nid = this.input.need(Attr.nid);
    const pw = this.input.get(Attr.password);
    const days = this.input.get(Attr.days) || 0;
    const hours = this.input.get(Attr.hours) || 0;
    const expiry = (hours * 1) + (days * 24);
    const permission = this.input.use(Attr.permission) || Privilege.write;

    let hub_id = this.hub.get(Attr.id);
    let public_id = Cache.getSysConf('public_id');

    let p = await this.yp.await_proc('dmz_grant_next', hub_id, nid,
      public_id, this.randomString(), pw
    );
    await this.db.await_proc('permission_grant',
      nid, public_id, expiry, permission, 'link', ''
    );
    this.debug("AAAA:104", p)
    let link = this._getShareLink(p.token)
    this.output.data({ link });
  }


  /**
   * 
   */
  async book() {
    let lang = this.user.get(Attr.profile).lang || this.input.ua_language();
    let name = this.user.get('fullname');
    const Moment = require('moment');
    Moment.locale(lang);
    let headline = this.user.locale_message('_meeting_scheduled_by_x').format(name);
    let title = this.input.use(Attr.title) || headline;
    let date = this.input.use(Attr.date) || Moment(Moment.now() / 1000, 'X').format('LLLL');
    if (title.length > 100) {
      title = title.slice(0, 100);
    }
    let message = this.input.use(Attr.message) || this.user.locale_message(
      '_x_invite_you_meeting'
    ).format(name);

    let args = {
      owner_id: this.uid,
      filename: title,
      pid: this.home_id,
      category: "schedule",
      ext: "schedule",
      mimetype: "application/json",
      filesischeduleze: 0,
      showResults: 1
    };
    let results = { isOutput: 1 };
    let metadata = {
      content: {
        attendees: [], title, message, date, room_id: "set-me"
      },
      room_status: 'booked'
    };
    let node = await this.db.await_proc("mfs_create_node", args, metadata, results);
    this.debug(`call mfs_create_node('${JSON.stringify(args)}', '${JSON.stringify(metadata)}')`);
    this.output.data(node);
  }

  /**
    * 
    */
  async update() {
    const Moment = require('moment');
    const flag = this.input.need(Attr.flag);
    const nid = this.input.need(Attr.nid);
    let name = this.user.get('fullname');

    let node = await this.db.await_proc('mfs_node_attr', nid);
    let metadata = this.parseJSON(node.metadata);
    let content = this.parseJSON(metadata.content);
    let attendees = content.attendees
    let title = content.title
    let message = content.message
    let date = content.date

    if (flag == 'when' || flag == 'all') {
      date = this.input.use(Attr.date) || Moment(Moment.now() / 1000, 'X').format('LLLL');
    }

    if (flag == 'title' || flag == 'all') {
      let headline = this.user.locale_message('_meeting_scheduled_by_x').format(name);
      title = this.input.use(Attr.title) || headline;
      if (title.length > 100) {
        title = title.slice(0, 100);
      }
      await this.db.await_proc('mfs_rename', nid, title);
    }

    if (flag == 'agenda' || flag == 'all') {
      message = this.input.use(Attr.message) || this.user.locale_message(
        '_x_invite_you_meeting'
      ).format(name);
    }
    if (flag == 'member' || flag == 'all') {
      attendees = this.input.need(Attr.attendees);
      if (!isEmpty(attendees)) {
        if (!isArray(attendees)) {
          attendees = [attendees];
        }
      }
      let members_mail = map(attendees, 'email');
      let delete_mails = difference(members_mail, attendees);
      let new_mails = difference(attendees, members_mail);
      let headline = this.user.locale_message('_meeting_scheduled_by_x').format(name);
      await this._commit_invitation(attendees, { ...node, message, date, title, headline });
    }
    await this.db.await_proc('mfs_set_metadata',
      nid,
      {
        content: {
          attendees, title, message, date, room_id: nid
        },
        room_status: 'booked'
      }, 1);
    content = {
      attendees, title, message, date
    };
    await this.output.data((content));
  }

  /**
   * 
   */
  async get_meeting_members() {
    const nid = this.input.need(Attr.nid);
    this.db.call_proc('dmz_get_meeting_members', this.uid, nid, this.output.data);
  }


  /**
   * 
   */
  async remove() {
    const nid = this.input.need(Attr.nid);
    await this.db.await_proc('permission_revoke', nid, "meeting");
    this.output.data({ nid });
  }

  /**
   * 
   */
  async invite() {
    let room_id = this.input.need(Attr.room_id);
    let guest = this.input.need('guest');
    let room_type = this.input.need('room_type');
    let opt = {
      room_id,
      type: room_type,
      user_id: guest.uid,
      socket_id: guest.socket_id,
      device_id: guest.device_id,
      role: Attr.listener
    }
    let r = await this.db.await_proc('room_invite_next', JSON.stringify(opt));
    // let my_node = Cache.getEnv(Attr.endpointAddress);
    // guest.node = my_node;
    let data = {
      type: 'linkup',
      service: 'signaling.message',
      origin: {
        socket_id: this.input.get(Attr.socket_id),
        uid: this.uid,
        ...r
      },
      target: guest
    };
    this.notify_socket({ ...guest, server: guest.node }, data);
    this.output.list([{ ...guest, server: guest.node }, data]);
  }
  // /**
  //  * @param {*} sessuin_id 
  //  * @param {*} socket_id 
  //  */
  // users() {
  //   this.db.call_proc('room_users', this.input.need(Attr.id), this.output.list);
  // }
}

module.exports = __private_room;
