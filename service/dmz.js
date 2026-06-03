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
const { verifyPassword: verifySecureSharePassword } = require('./lib/secure-share-password');


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
    const token = this.input.need(Attr.token);
    let res = await this.yp.await_proc('dmz_info_next', token);

    // If not found in dmz_token, check secure_share_token (no-op for normal DMZ tokens)
    if (isEmpty(res) || res.failed) {
      try {
        const secureRes = await this.yp.await_proc('secure_share_info', token);
        if (!isEmpty(secureRes) && !secureRes.failed) {
          res = secureRes;
          delete res.password_hash;
        }
      } catch (e) {
        this.warn('[dmz.info] secure_share_info lookup failed:', e && e.message);
      }
    }

    if (isEmpty(res) || res.failed) {
      res = res || {};
      res.status = 'WRONG_TICKET';
    } else if (res.is_secure) {
      res.status = res.validity === 'TICKET_OK' ? 'REQUIRED_EMAIL' : res.validity;
    } else if (res.require_password) {
      res.status = 'REQUIRED_PASSWORD';
    }
    const guest_id = Cache.getSysConf("guest_id");
    res.guest_id = guest_id;
    this.output.data(res);
  }


  /**
   *
   */
  async _loginSecureShare(token, info) {
    // Extract password_hash before any early returns — never expose it to the client
    const storedPasswordHash = info.password_hash || null;
    delete info.password_hash;

    if (info.validity === 'TICKET_REVOKED') {
      return this.output.data({ status: 'TICKET_REVOKED', is_secure: 1 });
    }
    if (info.validity === 'TICKET_EXPIRED') {
      return this.output.data({ status: 'TICKET_EXPIRED', is_secure: 1 });
    }

    // Resolve logged-in side user from cookie (mirrors normal login flow)
    let user = this.user.toJSON();
    const guest_id = Cache.getSysConf("guest_id");
    let { regsid } = this.input.get(Attr.cookie);
    if (regsid) {
      let u = await this.yp.await_proc("cookie_retrieve_user", regsid);
      if (u && ![ID_NOBODY, guest_id].includes(u.id)) {
        if (u.profile) {
          user.profile = u.profile;
          user.uid = u.id;
          user.id  = u.id;
        }
      }
    }

    // Email validation — logged-in Drumee members skip the form if their account
    // email matches the share (session auth is stronger proof than typing an email)
    let submittedEmail = (this.input.get(Attr.email) || '').toLowerCase().trim();

    if (!submittedEmail && user.id && ![ID_NOBODY, guest_id].includes(user.id)) {
      try {
        const p = typeof user.profile === 'string' ? JSON.parse(user.profile) : (user.profile || {});
        const accountEmail = (p.email || '').toLowerCase().trim();
        if (accountEmail) {
          const recipientCheck = (info.recipient_email || '').toLowerCase().trim();
          let autoMatch = (accountEmail === recipientCheck);
          if (!autoMatch && info.domain_restriction) {
            autoMatch = (accountEmail.split('@')[1] || '') === info.domain_restriction.toLowerCase().trim();
          }
          if (autoMatch) submittedEmail = accountEmail;
        }
      } catch (e) {
        this.warn('[dmz.login] secure_share auto-grant parse failed:', e && e.message);
      }
    }

    if (!submittedEmail) {
      return this.output.data({ ...info, status: 'REQUIRED_EMAIL', is_secure: 1 });
    }

    const recipientEmail = (info.recipient_email || '').toLowerCase().trim();
    let emailValid = (submittedEmail === recipientEmail);

    if (!emailValid && info.domain_restriction) {
      const submittedDomain = submittedEmail.split('@')[1] || '';
      emailValid = (submittedDomain === info.domain_restriction.toLowerCase().trim());
    }

    if (!emailValid) {
      return this.output.data({ status: 'EMAIL_MISMATCH', is_secure: 1 });
    }

    // Password gate — only evaluated after email is confirmed valid
    if (info.require_password) {
      const submittedPassword = (this.input.get(Attr.password) || '').trim();
      if (!submittedPassword) {
        return this.output.data({ status: 'REQUIRED_PASSWORD', is_secure: 1 });
      }
      if (!verifySecureSharePassword(submittedPassword, storedPasswordHash)) {
        return this.output.data({ status: 'WRONG_PASSWORD', is_secure: 1 });
      }
    }

    // Valid access — log it and notify sender in real time
    const actor_id = (guest_id === user.id) ? null : (user.id || null);
    try {
      const track = await this.yp.await_proc('secure_share_access_log', token, actor_id, this.input.get(Attr.socket_id));
      const row   = toArray(track)[0] || {};
      if (row.hub_id) {
        const recipients = await this.yp.await_proc('entity_sockets', { hub_id: row.hub_id });
        await RedisStore.sendData(
          this.payload(
            {
              event           : 'secure_share_opened',
              token,
              nid             : info.node_id,
              recipient_email : submittedEmail,
              access_count    : (info.access_count || 0) + 1,
            },
            { service: 'share.track_event' }
          ),
          recipients
        );
      }
    } catch (e) {
      this.warn('[dmz.login] secure_share access_log failed:', e && e.message);
    }

    // Associate session with share creator so hub endpoints (media.show_node_by) work —
    // mirrors the cookie_touch done for normal DMZ tokens at login line 330.
    // socket_id must be passed so entity_sockets() includes this guest socket in
    // hub broadcasts (e.g. secure_share_revoked) — same pattern as session.dmz_login.
    // Safe: page.js ensures the hub cookie always has its own independent session id,
    // so this UPDATE never touches the authenticated user's regsid row.
    if (info.creator_id) {
      try {
        await this.yp.await_proc('cookie_touch', {
          sid       : this.input.sid(),
          uid       : info.creator_id,
          socket_id : this.input.get(Attr.socket_id)
        });
      } catch (e) {
        this.warn('[dmz.login] secure_share cookie_touch failed:', e && e.message);
      }
    }

    // Hub-level expiry display fields (same as normal login)
    let rows = await this.yp.await_proc('forward_proc', info.hub_id, 'dmz_settings', ``);
    if (rows && rows[0]) {
      info.hours      = rows[0].hours;
      info.days       = rows[0].days;
      info.dmz_expiry = rows[0].dmz_expiry;
    }

    // If the shared node is a file (not a folder/hub), show_node_by(file_nid) returns
    // empty because files have no children. Use the parent folder instead so the file
    // appears in the listing. Keep node_id as-is for reference.
    try {
      const nodeRows = await this.yp.await_proc('forward_proc', info.hub_id, 'mfs_node_attr', `'${info.nid}'`);
      const nodeAttr = toArray(nodeRows)[0] || {};
      if (nodeAttr.filetype && nodeAttr.filetype !== 'folder' && nodeAttr.filetype !== 'hub' && nodeAttr.pid) {
        info.file_nid = info.nid;  // specific file — sent to UI for filtering
        info.nid = nodeAttr.pid;   // parent folder — used by show_node_by
      }
    } catch (e) {
      this.warn('[dmz.login] secure_share node type check failed:', e && e.message);
    }

    let area     = this.hub.get(Attr.area);
    let is_guest = (guest_id === user.id);
    if (user.profile) {
      user.profile.is_guest = is_guest;
    }
    user.uid = user.id;

    return this.output.data({
      ...user,
      ...info,
      is_secure : 1,
      status    : 'TICKET_OK',
      validity  : 'TICKET_OK',
      guest_id  : info.uid || guest_id,
      area,
      is_guest,
    });
  }

  /**
   *
   */
  async login() {
    let token = this.input.need(Attr.token);
    let password = this.input.get(Attr.password);

    // Check secure_share_token first — leaves normal dmz_token flow completely untouched
    try {
      const secureInfo = await this.yp.await_proc('secure_share_info', token);
      if (!isEmpty(secureInfo) && !secureInfo.failed) {
        return this._loginSecureShare(token, secureInfo);
      }
    } catch (e) {
      this.warn('[dmz.login] secure_share_info lookup failed:', e && e.message);
    }

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

    // If a specific file nid is provided (Share button URL has /<file_nid>/play),
    // navigate to its parent folder — same pattern as _loginSecureShare.
    // Validate as 16-char hex before any DB call to prevent SQL injection.
    const req_file_nid = this.input.use('file_nid');
    const NID_RE = /^[0-9a-f]{16}$/;
    if (NID_RE.test(req_file_nid) && out.validity === 'TICKET_OK') {
      try {
        const nodeRows = await this.yp.await_proc('forward_proc', info.hub_id, 'mfs_node_attr', `'${req_file_nid}'`);
        const nodeAttr = toArray(nodeRows)[0] || {};
        if (nodeAttr.pid && nodeAttr.filetype !== 'folder' && nodeAttr.filetype !== 'hub') {
          // Set file_nid so show_node_by filters to just this file (fast,
          // works for both root and subfolder files).
          // For root files out.nid stays workspace root (nodeAttr.pid === info.nid);
          // for subfolder files out.nid becomes the parent folder.
          out.file_nid = req_file_nid;
          out.nid = nodeAttr.pid;
        }
      } catch (e) {
        this.warn('[dmz.login] file_nid navigation failed:', e && e.message);
      }
    }

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
