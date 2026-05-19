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
const { Attr, Constants, Messenger, Cache, RedisStore, toArray } = require("@drumee/server-essentials");
const { Mfs } = require('@drumee/server-core');
const { isEmpty } = require('lodash');
const {
  ID_NOBODY
} = Constants;


//########################################
class __dmz extends Mfs {


  /**
   * 
   */
  async signup() {
    const token = this.input.need(Attr.token);
    let sid = this.input.sid();
    let res = await this.yp.await_proc('dmz_info_next', token);

    if (isEmpty(res)) {
      res.status = 'WRONG_TICKET'
      return this.output.data(res);
    }
    let is_verified = 0

    if (sid) {
      let cookie = await this.yp.await_proc('cookie_check_guest',
        sid, this.input.get(Attr.socket_id)
      );
      if (cookie && cookie.session_id == sid) {
        is_verified = 1
      }
    }

    if (!is_verified) {
      res.status = 'REQUIRED_PASSWORD'
      return this.output.data(res);
    }

    let user = await this.yp.await_proc('drumate_get', res.email);
    if (!isEmpty(user)) {
      res.status = 'EMAIL_EXIST'
      return this.output.data(res);
    }
    const lang = this.input.ua_language();
    const link = `${this.input.homepath()}#/welcome/signup/${token}`;
    const subject = Cache.message("_signup_activation", lang);
    const method = 'signup';
    let email = res.email;
    let name = email;
    await this.yp.await_proc('token_generate_next', email, name, token, method, '');
    let pass = await this.yp.await_proc('token_get_next', token);
    if (isEmpty(pass)) {
      res.status = 'FACTORY_FAILED'
      return this.output.data(res);
    }

    if (res.privilege >= 0) {
      await this.yp.await_proc('dmz_update_sync', token, 1);
    }
    const msg = new Messenger({
      template: "butler/signup",
      subject,
      recipient: email,
      lex: Cache.lex(lang),
      data: {
        recipient: email.replace(/@.+$/, ''),
        link,
        home: process.env.domain_name,
      },
      handler: this.exception.email
    });


    let metadata = {}
    metadata = this.parseJSON(pass.metadata)
    metadata.sharebox = res.hub_id;
    await this.yp.await_proc('token_update', token, metadata);
    await msg.send();

    // Track signup_from_share_link
    const shareHubId = res.hub_id || null;
    const shareNid   = res.nid   || null;
    try {
      if (shareHubId) {
        const hubDbName = await this.yp.await_func("get_db_name", shareHubId);
        if (hubDbName) {
          const track = await this.yp.await_proc(
            `${hubDbName}.share_track_add`, 'signup_from_share_link', null, shareNid
          );
          const row = toArray(track)[0] || {};
          if (row.inserted) {
            const recipients = await this.yp.await_proc('entity_sockets', { hub_id: shareHubId });
            await RedisStore.sendData(
              this.payload(
                { event: 'signup_from_share_link', nid: shareNid },
                { service: 'share.track_event' }
              ),
              recipients
            );
          }
        }
      }
    } catch (e) {
      this.warn('[dmz.signup] signup_from_share_link tracking failed:', e && e.message);
    }
    res = {};
    res.link = link;
    return this.output.data(res);
  }



  /**
 * 
 */
  async info() {
    let res = await this.yp.await_proc('dmz_info_next', this.input.need(Attr.token));
    if (isEmpty(res)) {
      res.status = 'WRONG_TICKET'
    } else if (res.require_password) {
      res.status = 'REQUIRED_PASSWORD'
    }
    const guest_id = Cache.getSysConf("guest_id");
    res.guest_id = guest_id;
    this.output.data(res);
  }


  /**
   * 
   */
  async login() {
    let token = this.input.need(Attr.token);
    let password = this.input.get(Attr.password);
    let info = await this.yp.await_proc('dmz_info_next', token);
    if (!info) {
      this.output.data({ status: "TICKET_INVALID" });
      return;
    }

    let user = this.user.toJSON();
    const guest_id = Cache.getSysConf("guest_id");
    let { regsid } = this.input.get(Attr.cookie);
    if (regsid) {
      /** Side user */
      let u = await this.yp.await_proc("cookie_retrieve_user", regsid);
      if (u && ![ID_NOBODY, guest_id].includes(u.id)) {
        if (u.profile) {
          user.profile = u.profile;
          user.uid = u.id;
          user.id = u.id;
        }
      }
    }
    let rows = await this.yp.await_proc('forward_proc', info.hub_id, 'dmz_settings', ``);
    // dmz_expiry (infinity / active / expired) must be forwarded even when
    // days/hours are NULL — duration_hours() returns NULL for an *expired*
    // share, and the old `hours !== null` guard dropped the status exactly
    // when it mattered. days/hours being null is tolerated downstream.
    if (rows[0]) {
      info.hours = rows[0].hours;
      info.days = rows[0].days;
      info.dmz_expiry = rows[0].dmz_expiry;
    }
    info.require_pwd = info.require_password;
    let node = await this.db.await_proc('mfs_access_node', this.uid, info.nid) || {};
    if (info.require_pwd && !node.privilege) {
      info.status = 'REQUIRED_PASSWORD';
      if (!password) {
        return this.output.data(info);
      }
      let res = await this.session.dmz_login(token, password);
      if (res.is_verified) {
        res.require_pwd = 0;
        info.status = 'TICKET_OK';
        this.output.data(res);
        return;
      }

      if (res.failed) {
        info.status = 'WRONG_PASSWORD';
        res.validity = res.error;
        this.output.data(res);
        return;
      }
    }

    if (info.validity == 'TICKET_OK' && info.uid) {
      await this.yp.await_proc('cookie_touch', {
        sid: this.input.sid(), uid: info.uid
      });
    }

    if (info.is_public && !user.guest_name) {
      user.require_name = 1;
    }
    user.uid = user.id;
    let area = this.hub.get(Attr.area);
    let is_guest = (guest_id == info.uid);
    if(user.profile){
      user.profile.is_guest = is_guest;
    }
    let out = { ...user, ...info, guest_id: info.uid, area, is_guest };

    // Track link_opened
    try {
      const actor_id = is_guest ? null : (user.id || null);
      const track = await this.db.await_proc('share_track_add', 'link_opened', actor_id, info.nid || null);
      const row = toArray(track)[0] || {};
      if (row.inserted) {
        const recipients = await this.yp.await_proc('entity_sockets', { hub_id: info.hub_id });
        await RedisStore.sendData(
          this.payload(
            { event: 'link_opened', actor_id, nid: info.nid || null },
            { service: 'share.track_event' }
          ),
          recipients
        );
      }
    } catch (e) {
      this.warn('[dmz.login] link_opened tracking failed:', e && e.message);
    }
    this.output.data(out);
  }

  /**
   * 
   */
  logout() {
    this.session.dmz_logout();
  }

  /**
   * 
   */
  async reset_sessions() {
    let members = await this.db.await_proc('dmz_notify_list', `all`) || [];
    for (let m of members) {
      await this.yp.await_proc('session_logout_by_admin', m.recipient_id);
    }
    this.output.data(members);
  }

  /**
   * 
   */
  notification_list() {
    this.output.data([]);
  }

}


module.exports = __dmz;
