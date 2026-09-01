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
const { Attr, Remit, Cache, Messenger, toArray, RedisStore, Constants } = require("@drumee/server-essentials");
const { EMAIL_CHECKER, PHONE_CHECKER, FORGOT_PASSWORD } = Constants;
const { Mfs, MfsTools } = require('@drumee/server-core');
const { remove_dir } = MfsTools;

const { stringify } = JSON;
const { isEmpty, isArray } = require('lodash');
const Crypto = require("crypto");
const Uniqid = require('uniqid');
class __private_adminpanel extends Mfs {


  /**
   * 
   * @returns 
   */
  async members_whocansee() {
    let user_id = this.input.need(Attr.user_id);
    let res = {};

    let org = await this.yp.await_proc('organisation_get', this.user.domain_id())
    orgid = org.id;
    if (isEmpty(org)) return this.output.status('NO_ORG');

    let my_org = await this.yp.await_proc('my_organisation', user_id)
    if (isEmpty(my_org)) return this.output.status('NO_ORG');

    if (my_org.id != org.id) return this.output.status('INVALID_ORG');
    res.member = [];
    let contacts = await this.yp.await_proc('contact_assignment_get', user_id);
    if (!isEmpty(contacts)) {
      if (!isArray(contacts)) {
        contacts = [contacts]
      }
      for (let contact of contacts) {
        res.member.push(contact.uid)
      }
    }
    this.output.list(res);
  }


  /**
   * 
   * @returns 
   */
  async members_whocansee_update() {
    let user_id = this.input.need(Attr.user_id);
    let users = this.input.need(Attr.users) || [];
    let orgid //= this.input.need(Attr.orgid);
    let res = {};
    let contacts = {}

    let org = await this.yp.await_proc('organisation_get', this.user.domain_id())
    orgid = org.id;
    if (isEmpty(org)) return this.output.status('NO_ORG');

    let my_org = await this.yp.await_proc('my_organisation', user_id)
    if (isEmpty(my_org)) return this.output.status('NO_ORG');

    if (my_org.id != org.id) return this.output.status('INVALID_ORG');

    let isinvaliddrumate = 0;
    let isinvalidorg = 0;
    for (let entity_id of users) {
      let drumate = await this.yp.await_proc('drumate_exists', entity_id);
      if (user_id == entity_id) { isinvaliddrumate = isinvaliddrumate + 1 }
      if (isEmpty(drumate)) {
        isinvaliddrumate = isinvaliddrumate + 1
      }
      if (!isEmpty(drumate)) {
        let his_org = await this.yp.await_proc('my_organisation', drumate.id)
        if (!isEmpty(his_org)) {
          if (his_org.id != org.id) {
            isinvalidorg = isinvalidorg + 1
          }
        }
      }
    }

    if (isinvaliddrumate > 0) return this.output.status('NOT_VALID_DRUMATE');

    if (isinvalidorg > 0) return this.output.status('NOT_VALID_ORG');

    contacts = await this.yp.await_proc('contact_assignment_update', user_id, stringify(users));
    res.member = []
    if (!isEmpty(contacts)) {
      if (!isArray(contacts)) {
        contacts = [contacts]
      }
      for (let contact of contacts) {
        res.member.push(contact.uid)
      }
    }
    this.output.list(res);
  }

  /**
   * 
   * @returns 
   */
  async mimic_end_bytime() {
    // let orgid = this.input.need(Attr.orgid);
    const mimic_id = this.input.need(Attr.mimic_id);
    let res = {};
    await new Promise(resolve => setTimeout(resolve, 5000));
    let mimic = await this.yp.await_proc('mimic_get', mimic_id)

    if (isEmpty(mimic)) return this.output.status('NO_MIMIC');
    if (mimic.mimicker != this.mimicker) return this.output.status('INVALID_MIMIC');
    if (mimic.status != 'active') return this.output.status('INVALID_STATUS');
    if (mimic.remaining_time > 0) return this.output.status('INVALID_TIME');

    res.status = 'INVALID_STATUS';
    let final = await this.yp.await_proc('mimic_set_by_status', mimic_id, 'endbytime')
    if (final.status != 'active') {
      await this.yp.await_proc('uncast_user', mimic.mimicker, mimic.uid)
      res = await this.yp.await_proc('mimic_get', mimic_id)
      let recipients = await this.yp.await_proc('user_sockets', [mimic.uid, mimic.mimicker]);
      await RedisStore.sendData(this.payload(res), recipients);
    }
    this.output.list(res);
  }

  /**
   * 
   */
  async mimic_end_bymimic() {
    //const orgid = this.input.need(Attr.orgid);
    const mimic_id = this.input.need(Attr.mimic_id);

    let mimic = await this.yp.await_proc('mimic_get', mimic_id)
    if (isEmpty(mimic)) return this.output.status('NO_MIMIC');

    if (mimic.mimicker != this.mimicker) return this.output.status('INVALID_MIMIC');

    if (mimic.status != 'active') return this.output.status('INVALID_STATUS');
    let res = { status: 'INVALID_STATUS' };
    let final = await this.yp.await_proc('mimic_set_by_status', mimic_id, 'endbymimic')
    if (final.status != 'active') {
      await this.yp.await_proc('uncast_user', mimic.mimicker, mimic.uid)
      res = await this.yp.await_proc('mimic_get', mimic_id)
      let recipients = await this.yp.await_proc('user_sockets', [mimic.uid, mimic.mimicker]);
      await RedisStore.sendData(this.payload(res), recipients);
    }
    this.output.list(res);
  }

  /**
   * 
   * @returns 
   */
  async mimic_end_byuser() {
    const mimic_id = this.input.need(Attr.mimic_id);

    let mimic = await this.yp.await_proc('mimic_get', mimic_id)
    if (isEmpty(mimic)) return this.output.status('NO_MIMIC');

    if (mimic.uid != this.uid) return this.output.status('INVALID_MIMIC');

    if (mimic.status != 'active') return this.output.status('INVALID_STATUS');

    await this.yp.await_proc('mimic_set_by_status', mimic_id, 'endbyuser')
    await this.yp.await_proc('uncast_user', mimic.mimicker, mimic.uid)
    let res = await this.yp.await_proc('mimic_get', mimic_id)
    let recipients = await this.yp.await_proc('user_sockets', [mimic.uid, mimic.mimicker]);
    await RedisStore.sendData(this.payload(res), recipients);
    this.output.list(res);
  }

  /**
   * 
   * @returns 
   */
  async mimic_active() {
    let orgid //= this.input.need(Attr.orgid);
    const mimic_id = this.input.need(Attr.mimic_id);
    let res = {};

    let org = await this.yp.await_proc('organisation_get', this.user.domain_id())
    orgid = org.id;
    if (isEmpty(org)) return this.output.status('NO_ORG');

    let mimic = await this.yp.await_proc('mimic_get', mimic_id)
    if (isEmpty(mimic)) return this.output.status('NO_MIMIC');
    if (mimic.uid != this.uid) return this.output.status('INVALID_MIMIC');
    if (mimic.status != 'new') return this.output.status('INVALID_STATUS');

    let online = await this.yp.await_proc('socket_user_connections', mimic.mimicker)
    if (isEmpty(online)) {
      await this.yp.await_proc('mimic_set_by_status', mimic_id, 'noonline')
      res.member = await this.yp.await_proc('show_member_detail', mimic.mimicker, orgid);
      return this.output.status('NOT_ONLINE');
    }

    await this.yp.await_proc('mimic_set_by_status', mimic_id, 'active')
    await this.yp.await_proc('cast_user', mimic.mimicker, mimic.uid)
    res = await this.yp.await_proc('mimic_get', mimic_id)
    let recipients = await this.yp.await_proc('user_sockets', [mimic.uid, mimic.mimicker]);
    await RedisStore.sendData(this.payload(res), recipients);
    this.output.list(res);
  }

  /**
   * 
   * @returns 
   */
  async mimic_reject() {
    const mimic_id = this.input.need(Attr.mimic_id);

    let mimic = await this.yp.await_proc('mimic_get', mimic_id)
    if (isEmpty(mimic)) return this.output.status('NO_MIMIC');
    if (mimic.uid != this.uid) return this.output.status('INVALID_MIMIC');
    if (mimic.status != 'new') return this.output.status('INVALID_STATUS');

    await this.yp.await_proc('mimic_set_by_status', mimic_id, 'reject')
    res = await this.yp.await_proc('mimic_get', mimic_id)
    let recipients = await this.yp.await_proc('user_sockets', [mimic.uid, mimic.mimicker]);
    await RedisStore.sendData(this.payload(res), recipients);
    this.output.list(res);
  }

  /**
   * 
   */
  async mimic_new() {
    let user_id = this.input.need(Attr.user_id);

    if (this.uid == user_id) return this.output.status('INVALID_USER');

    let org = await this.yp.await_proc('organisation_get', this.user.domain_id())
    orgid = org.id;
    if (isEmpty(org)) return this.output.status('NO_ORG');

    let hismimic = await this.yp.await_proc('mimic_get_by_status', user_id, 'new')
    if (!isEmpty(hismimic)) return this.output.status('MIMIC_ALREADY');
    hismimic = await this.yp.await_proc('mimic_get_by_status', user_id, 'active')
    if (!isEmpty(hismimic)) return this.output.status('MIMIC_ALREADY');
    let mymimic = await this.yp.await_proc('mimic_get_by_status', this.uid, 'new')
    if (!isEmpty(mymimic)) return this.output.status('MIMIC_ALREADY');
    mymimic = await this.yp.await_proc('mimic_get_by_status', this.uid, 'active')
    if (!isEmpty(mymimic)) return this.output.status('MIMIC_ALREADY');

    let member = await this.yp.await_proc('show_member_detail', user_id, orgid);

    let online = await this.yp.await_proc('socket_user_connections', user_id)
    if (isEmpty(online) && ['active'].includes(member.status)) {
      res.member = member
      return this.output.status('NOT_ONLINE');
    }

    if (['locked', 'archived'].includes(member.status)) {
      mymimic = await this.yp.await_proc('mimic_new', user_id, this.uid)
      await this.yp.await_proc('mimic_set_by_status', mymimic.mimic_id, 'active')
      await this.yp.await_proc('cast_user', mymimic.mimicker, mymimic.uid)
      res = await this.yp.await_proc('mimic_get', mymimic.mimic_id)
    }
    else {
      res = await this.yp.await_proc('mimic_new', user_id, this.uid)
    }
    let recipients = await this.yp.await_proc('user_sockets', [user_id, this.uid]);
    await RedisStore.sendData(this.payload(res), recipients);
    this.output.data(res);
  }

  /**
   * 
   */
  async member_change_status() {
    let user_id = this.input.need(Attr.user_id);
    let status = this.input.need(Attr.status)
    if (this.uid == user_id) return this.output.status('INVALID_USER');

    if (!['archived', 'active', 'locked'].includes(status)) return this.output.status('INVALID_STATUS0');

    let org = await this.yp.await_proc('organisation_get', this.user.domain_id())
    orgid = org.id;
    if (isEmpty(org)) return this.output.status('NO_ORG');

    let my_org = await this.user.organization();
    if (isEmpty(my_org)) return this.output.status('NO_ORG');

    if (my_org.id != org.id) return this.output.status('INVALID_ORG');

    let his_org = await this.yp.await_proc('my_organisation', user_id)
    if (isEmpty(his_org)) return this.output.status('NO_ORG');

    if (his_org.id != org.id) return this.output.status('INVALID_ORG');

    let my_privilege = await this.yp.await_proc('domain_privilege', my_org.domain_id, this.uid);
    if (my_privilege.privilege < Remit.dom_admin) return this.output.status('NOT_ENOUGH_PRIVILEGE');

    let his_privilege = await this.yp.await_proc('domain_privilege', my_org.domain_id, user_id);
    if (isEmpty(his_privilege)) return this.output.status('INCORRECT_DOMAIN');

    if (my_privilege.privilege < his_privilege.privilege) return this.output.status('NOT_ENOUGH_PRIVILEGE');

    let member = await this.yp.await_proc('show_member_detail', user_id, orgid);

    if (isEmpty(member)) return this.output.status('NO_MEMBER');

    if (status == 'locked') {
      if (!['active', 'archived'].includes(member.status)) {
        return this.output.status('INVALID_STATUS1');
      }
    }

    if (status == 'archived') {
      if (member.status != 'locked') {
        return this.output.status('INVALID_STATUS2');
      }
    }

    if (status == 'active') {
      if (member.status != 'locked') {
        return this.output.status('INVALID_STATUS3');
      }
    }

    res = await this.yp.await_proc('update_member_status', user_id, status)
    if (status == 'archived') {
      let users = [];
      await this.yp.await_proc('contact_assignment_update', user_id, stringify(users));
      await this.yp.await_proc('forward_proc', user_id, 'my_contact_sync', `'${user_id}'`)
    }
    let data = await this.yp.await_proc('show_member_detail', user_id, orgid);
    if (!isEmpty(data)) {
      res = data;
    }
    this.output.list(res);
  }


  /**
   * 
   */
  async member_loginlog() {
    let orgid //= this.input.need(Attr.orgid);
    let user_id = this.input.need(Attr.user_id);
    const page = this.input.use(Attr.page) || 1;
    let res = [];

    let org = await this.yp.await_proc('organisation_get', this.user.domain_id())
    orgid = org.id;
    if (isEmpty(org)) return this.output.status('NO_ORG');

    let my_org = await this.user.organization();
    if (isEmpty(my_org)) return this.output.status('NO_ORG');

    if (my_org.id != org.id) return this.output.status('INVALID_ORG');

    let his_org = await this.yp.await_proc('my_organisation', user_id)
    if (isEmpty(his_org)) return this.output.status('NO_ORG');

    if (his_org.id != org.id) return this.output.status('INVALID_ORG');


    let my_privilege = await this.yp.await_proc('domain_privilege', my_org.domain_id, this.uid);
    if (my_privilege.privilege < Remit.dom_admin_view) return this.output.status('NOT_ENOUGH_PRIVILEGE');

    let his_privilege = await this.yp.await_proc('domain_privilege', my_org.domain_id, user_id);
    if (isEmpty(his_privilege)) return this.output.status('INCORRECT_DOMAIN');
    if (my_privilege.privilege < his_privilege.privilege) return this.output.status('NOT_ENOUGH_PRIVILEGE');

    let data = await this.yp.await_proc('show_login_log', user_id, page);
    this.output.list(data);
  }

  /**
   * 
   */
  async member_authentification() {
    let orgid //= this.input.need(Attr.orgid);
    let user_id = this.input.need(Attr.user_id);
    let option = this.input.use(Attr.option) || '0';  // 'double' 

    let res = {};
    let profile = {};

    let org = await this.yp.await_proc('organisation_get', this.user.domain_id())
    orgid = org.id;
    if (isEmpty(org)) return this.output.status('NO_ORG');

    let my_org = await this.user.organization();
    if (isEmpty(my_org)) return this.output.status('NO_ORG');

    if (my_org.id != org.id) return this.output.status('INVALID_ORG');

    let his_org = await this.yp.await_proc('my_organisation', user_id)
    if (isEmpty(his_org)) return this.output.status('NO_ORG');

    if (his_org.id != org.id) return this.output.status('INVALID_ORG');

    let my_privilege = await this.yp.await_proc('domain_privilege', my_org.domain_id, this.uid);
    if (my_privilege.privilege < Remit.dom_admin) return this.output.status('NOT_ENOUGH_PRIVILEGE');

    let his_privilege = await this.yp.await_proc('domain_privilege', my_org.domain_id, user_id);
    if (isEmpty(his_privilege)) return this.output.status('INCORRECT_DOMAIN');

    if (my_privilege.privilege < his_privilege.privilege) return this.output.status('NOT_ENOUGH_PRIVILEGE');

    let phone = await this.yp.await_proc('show_member_detail', user_id, orgid);
    if (isEmpty(phone)) return this.output.status('NO_USER');
    if (isEmpty(phone.mobile) && (option == 'sms')) return this.output.status('NO_PHOME');

    profile.otp = option;
    res = await this.yp.await_proc('drumate_update_profile', user_id, profile);
    let recipients = await this.yp.await_proc('user_sockets', res.id);
    await RedisStore.sendData(this.payload(res), recipients);

    this.output.list(res);
  }


  /* Need to delete */
  async member_block() {
    let orgid //= this.input.need(Attr.orgid);
    let user_id = this.input.need(Attr.user_id);
    let res = {};
    let profile = {};

    let org = await this.yp.await_proc('organisation_get', this.user.domain_id())
    orgid = org.id;
    if (isEmpty(org)) return this.output.status('NO_ORG');

    let my_org = await this.user.organization();
    if (isEmpty(my_org)) return this.output.status('NO_ORG');

    if (my_org.id != org.id) return this.output.status('INVALID_ORG');

    let his_org = await this.yp.await_proc('my_organisation', user_id)
    if (isEmpty(his_org)) return this.output.status('NO_ORG');

    if (his_org.id != org.id) return this.output.status('INVALID_ORG');

    let my_privilege = await this.yp.await_proc('domain_privilege', my_org.domain_id, this.uid);
    if (my_privilege.privilege < Remit.dom_admin) return this.output.status('NOT_ENOUGH_PRIVILEGE');

    let his_privilege = await this.yp.await_proc('domain_privilege', my_org.domain_id, user_id);
    if (isEmpty(his_privilege)) return this.output.status('INCORRECT_DOMAIN');

    if (my_privilege.privilege < his_privilege.privilege) return this.output.status('NOT_ENOUGH_PRIVILEGE');

    profile.blocked = 'yes'
    res = await this.yp.await_proc('drumate_update_profile', user_id, profile);
    let recipients = await this.yp.await_proc('user_sockets', res.id);
    await RedisStore.sendData(this.payload(res), recipients);
    this.output.list(res);
  }

  /* Need to delete */
  async member_unblock() {
    let orgid //= this.input.need(Attr.orgid);
    let user_id = this.input.need(Attr.user_id);
    let res = {};
    let profile = {};

    let org = await this.yp.await_proc('organisation_get', this.user.domain_id())
    orgid = org.id;
    if (isEmpty(org)) return this.output.status('NO_ORG');

    let my_org = await this.user.organization();
    if (isEmpty(my_org)) return this.output.status('NO_ORG');

    if (my_org.id != org.id) return this.output.status('INVALID_ORG');

    let his_org = await this.yp.await_proc('my_organisation', user_id)
    if (isEmpty(his_org)) return this.output.status('NO_ORG');

    if (his_org.id != org.id) return this.output.status('INVALID_ORG');

    let my_privilege = await this.yp.await_proc('domain_privilege', my_org.domain_id, this.uid);
    if (my_privilege.privilege < Remit.dom_admin) return this.output.status('NOT_ENOUGH_PRIVILEGE');

    let his_privilege = await this.yp.await_proc('domain_privilege', my_org.domain_id, user_id);
    if (isEmpty(his_privilege)) return this.output.status('INCORRECT_DOMAIN');

    if (my_privilege.privilege < his_privilege.privilege) return this.output.status('NOT_ENOUGH_PRIVILEGE');

    profile.blocked = 'no'
    res = await this.yp.await_proc('drumate_update_profile', user_id, profile);
    let recipients = await this.yp.await_proc('user_sockets', res.id);
    await RedisStore.sendData(this.payload(res), recipients);
    this.output.list(res);
  }

  /**
   * 
   * @param {*} result 
   * @param {*} option 
   * @param {*} domain_name 
   * @param {*} this 
   * @returns 
   */
  async import_validate(result, option, domain_name, this) {
    let member = {}
    let importdata = {}
    importdata.members = []
    importdata.valid = true
    let skip;
    let valid;
    let status = [];
    let idx = 0;
    let chk
    for (var e of result) {
      skip = false;
      member = e;
      status = [];
      if (isEmpty(e.firstname)) {
        if (isEmpty(e.lastname)) {
          status.push("EMPTY_NAMES")
          skip = true;
        }
      }

      if (isEmpty(e.email)) {
        status.push("EMPTY_EMAIL")
        skip = true;
      }

      if (isEmpty(e.mobile)) {
        status.push("EMPTY_MOBLIE")
        skip = true;
      }

      if (isEmpty(e.areacode)) {
        status.push("EMPTY_AREACODE")
        skip = true;
      }

      if (!isEmpty(e.email)) {
        if (!EMAIL_CHECKER.test(e.email)) {
          status.push("INVALID_EMAIL_FORMAT")
          skip = true;
        }
      }

      if (!isEmpty(e.mobile)) {
        if (!PHONE_CHECKER.test(e.mobile)) {
          status.push("INVALID_PHONE_FORMAT")
          skip = true;
        }
      }
      if (isEmpty(e.ident)) {
        status.push("EMPTY_IDENT")
        skip = true;
      }
      if (!isEmpty(e.email)) {
        chk = await this.yp.await_proc('email_exists', e.email)
        if (!isEmpty(chk)) {
          status.push("EMAIL_NOT_AVAILABLE")
          skip = true;
        }
      }

      if (!isEmpty(e.ident)) {
        chk = await this.yp.await_proc('get_user_in_domain', e.ident, domain_name)
        if (chk.exists == 1) {
          status.push("IDENT_NOT_AVAILABLE")
          skip = true;
        }
      }
      for (var m of importdata.members) {
        if (m.ident == e.ident && (!isEmpty(e.ident))) {
          skip = true;
          status.push('IDENT_DUPLICATE (' + m.index + ')')
        }

        if (m.email == e.email && (!isEmpty(e.email))) {
          skip = true;
          status.push('EMAIL_DUPLICATE  (' + m.index + ')')
        }
      }
      member.error = skip;
      if (!isEmpty(status)) { member.errorstatus = status; }
      member.index = idx;
      importdata.valid = importdata.valid && (!skip)
      importdata.members.push(member)
      idx++;
    }
    return importdata
  }




  /**
   * 
   * @param {*} uid 
   * @param {*} option 
   */
  async set_wallpaper(uid, option) {
    let entity = await this.yp.await_proc('entity_touch', uid);
    let old_settings;
    if (isEmpty(entity) || isEmpty(entity.settings)) {
      old_settings = {};
    } else {
      old_settings = this.parseJSON(entity.settings);
    }
    let settings = {};
    if (option == 'b2c') {
      settings.wallpaper = Cache.getSysConf('wallpaper_b2c');
    } else {
      settings.wallpaper = Cache.getSysConf('wallpaper_b2b');
    }

    const merged_settings = { ...old_settings, ...settings };
    const settings_str = stringify(merged_settings);
    this.yp.call_proc('drumate_update_settings', uid, settings_str);
  }

  /**
   * 
   * @param {*} email 
   * @returns 
   */
  async invite_link(email) {
    const token = this.randomString();
    const username = this.user.get(Attr.fullname);
    await this.yp.await_proc('token_generate_next', email, email, token, FORGOT_PASSWORD, '');
    let user = await this.yp.await_proc('get_visitor', email);
    const ulang = this.input.ua_language();
    //const pathname = this.input.use(Attr.location).pathname.replace(/service.*$/, '');
    let host = (await this.user.organization()).link;// || process.env.domain_name;
    const link = `${this.input.homepath(host)}#/welcome/reset/${user.id}/${token}/reason=new-account`;
    const subject = `${Cache.message('_admin_network_subject', ulang)}`;
    const msg = new Messenger({
      template: "butler/admin-invitation",
      subject: subject,
      recipient: email,
      lex: Cache.lex(ulang),
      data: {
        sender: username,
        link: link,
        recipient: user.fullname
      },
      handler: this.exception.email
    });
    let body = await msg.send();
    if (_.isString(body)) {
      return {
        subject,
        email,
        body,
        link
      }
    }
  }


  /**
   * 
   */
  async setPassword() {
    let id = this.input.need(Attr.id);
    let password = this.input.need(Attr.password);
    await this.yp.await_proc('set_password', id, password);
    this.output.data({});
  }


  /**
   * 
   * @param {*} email 
   */
  async password_link(email) {
    const token = this.randomString();
    await this.yp.await_proc('token_generate_next', email, email, token, FORGOT_PASSWORD, '');
    let user = await this.yp.await_proc('get_visitor', email);
    const ulang = this.input.ua_language();
    //const pathname = this.input.use(Attr.location).pathname.replace(/service.*$/, '');
    const link = `${this.input.homepath()}#/welcome/reset/${user.id}/${token}`;
    const subject = Cache.message("_admin_password_reset_link", ulang);
    const msg = new Messenger({
      template: "butler/password-change",
      subject,
      recipient: email,
      lex: Cache.lex(ulang),
      data: {
        icon: this.hub.get(Attr.icon),
        recipient: user.fullname,
        link,
        home: process.env.domain_name,
      },
      handler: this.exception.email
    });
    let body = await msg.send();
    if (_.isString(body)) {
      return {
        subject,
        email,
        body,
        link
      }
    }
  }



  /**
   * 
   * @param {*} email 
   */
  async email_change_link(email) {
    const token = this.randomString();
    await this.yp.await_proc('token_generate_next', email, email, token, FORGOT_PASSWORD, '');
    let user = await this.yp.await_proc('get_visitor', email);
    const ulang = this.input.ua_language();
    //const pathname = this.input.use(Attr.location).pathname.replace(/service.*$/, '');
    const link = `${this.input.homepath()}#/welcome/reset/${user.id}/${token}`;
    const subject = Cache.message("_admin_email_reset_link", ulang);
    const msg = new Messenger({
      template: "butler/email-change",
      subject,
      recipient: email,
      lex: Cache.lex(ulang),
      data: {
        icon: this.hub.get(Attr.icon),
        recipient: user.fullname,
        link,
        home: process.env.domain_name,
      },
      handler: this.exception.email
    });
    let body = await msg.send();
    if (_.isString(body)) {
      return {
        subject,
        email,
        body,
        link
      }
    }
  }

  /**
   * 
   * @returns 
   */
  async member_add() {
    let orgid //= this.input.need(Attr.orgid);
    let firstname = this.input.need(Attr.firstname);
    let lastname = this.input.need(Attr.lastname);
    let email = this.input.need(Attr.email)
    let ident = this.input.use(Attr.ident);
    if (!isEmpty(ident)) {
      ident = ident.toLowerCase().trim();
    }
    let address = this.input.use(Attr.address)
    let mobile = this.input.use(Attr.mobile)
    let areacode = this.input.use(Attr.areacode)
    let users = this.input.need(Attr.users) || [];
    let role = this.input.use(Attr.role) || this.input.use(Attr.list) || [];
    let otp = this.input.get('otp') || 0;
    if (![1, 0, '1', '0'].includes(otp)) {
      otp = 0;
    }
    let res = {};
    let profile = {};
    let newuser;
    let list = []
    let password = Crypto.randomBytes(20).toString('hex');
    profile.email_verified = 'no';
    profile.otp = otp;
    profile.connected = '0';
    profile.sharebox = Uniqid();
    if (!isEmpty(firstname)) { profile.firstname = firstname }
    if (!isEmpty(lastname)) { profile.lastname = lastname }
    if (!isEmpty(address)) { profile.address = address }
    if (!isEmpty(email)) { profile.email = email }

    let a;
    if (isEmpty(ident)) {
      a = email.split('@');
      a = a[0].split(/[\.-_]/);
      const base = a[0] || "a";
      let i = await this.yp.await_proc("unique_ident", base);
      ident = i.ident;
    }

    if (!isEmpty(ident)) {
      profile.ident = ident
      profile.username = ident
    }

    if (!isEmpty(mobile) && (mobile != '')) {
      profile.mobile_verified = 'no'
      profile.mobile = mobile
    }

    if (isEmpty(profile.mobile) && (otp == 'sms')) return this.output.status('MOBILE_EMPTY');

    if (!isEmpty(mobile)) {
      profile.mobile = profile.mobile.trim()
    }

    if ((profile.mobile == "") && (otp == 'sms')) return this.output.status('MOBILE_EMPTY');

    if (!isEmpty(profile.areacode)) {
      profile.areacode = areacode.trim()
    }

    if (isEmpty(profile.areacode) && (otp == 'sms')) return this.output.status('AREACODE_EMPTY');
    if ((profile.areacode == "") && (otp == 'sms')) return this.output.status('AREACODE_EMPTY');

    // Product default is English — do not stamp the INVITER's browser
    // language onto the invited member's account.
    profile.lang = 'en'
    profile.privilege = Remit.dom_member
    let org = await this.yp.await_proc('organisation_get', this.user.domain_id())
    orgid = org.id;
    if (isEmpty(org)) return this.output.status('NO_ORG');

    let my_org = await this.user.organization();
    if (isEmpty(my_org)) return this.output.status('NO_ORG');

    if (my_org.id != org.id) return this.output.status('INVALID_ORG');

    let my_privilege = await this.yp.await_proc('domain_privilege', my_org.domain_id, this.uid);
    if (my_privilege.privilege < Remit.dom_admin_memeber) return this.output.status('NOT_ENOUGH_PRIVILEGE');

    let domain = await this.yp.await_proc('domain_exists', my_org.domain_id);
    profile.domain = domain.name;

    let chk = await this.yp.await_proc('get_user_in_domain', ident, domain.name)
    if (chk.exists == 1) return this.output.status('IDENT_NOT_AVAILABLE');
    chk = await this.yp.await_proc('email_exists', email)
    if (!isEmpty(chk)) return this.output.status('EMAIL_NOT_AVAILABLE');

    if (!isEmpty(role)) {
      for (let id of role) {
        let data = await this.yp.await_proc('role_exists', id, orgid);
        if (isEmpty(data)) {
          return this.output.status('ROLE_NOT_EXISTS');
        }
      }
    }

    let isinvaliddrumate = 0;
    let isinvalidorg = 0;
    for (let entity_id of users) {
      let drumate = await this.yp.await_proc('drumate_exists', entity_id);

      if (isEmpty(drumate)) {
        isinvaliddrumate = isinvaliddrumate + 1
      }
      if (!isEmpty(drumate)) {
        let his_org = await this.yp.await_proc('my_organisation', drumate.id)
        if (!isEmpty(his_org)) {
          if (his_org.id != org.id) {
            isinvalidorg = isinvalidorg + 1
          }
        }
      }
    }

    if (isinvaliddrumate > 0) return this.output.status('NOT_VALID_DRUMATE');
    if (isinvalidorg > 0) return this.output.status('NOT_VALID_ORG');

    const rows = await this.yp.await_proc("drumate_create", password, stringify(profile));
    if (isEmpty(rows)) return this.exception.server("Failed to create account -- Factory Empty");

    for (let r of rows) {
      if (r && r.failed) return this.exception.server("Failed to create account -- Factory Failed");
    }
    for (let r of rows) {
      if (typeof r.drumate !== "undefined") {
        newuser = this.parseJSON(r.drumate);
      }
    }
    this.debug("QQQQQQQQQ 2099", newuser);
    if (!isEmpty(role)) {
      await this.yp.await_proc('role_map', newuser.id, stringify(role), orgid);
    }

    await this.defaultContent(newuser)

    let quota = Cache.getSysConf('company_quota') || {};
    if (_.isString(quota)) {
      try { quota = JSON.parse(quota) } catch (e) { quota = {} };
    }
    quota.watermark = global.myQuota.watermark || '0';

    await this.yp.await_proc('drumate_update_profile', newuser.id, JSON.stringify({ quota }))

    res = await this.yp.await_proc('drumate_update_profile', newuser.id, stringify(profile));
    //await this.password_link(email)
    let message = await this.invite_link(email);
    await this.set_wallpaper(newuser.id, 'b2b');
    if (isEmpty(users)) {

      list = await this.yp.await_proc('member_list_all', newuser.id, orgid);
      if (!isArray(list)) {
        list = [list]
      }
      for (let entity of list) { users.push(entity.drumate_id) }
    }
    await this.yp.await_proc('contact_assignment_update', newuser.id, stringify(users));
    await this.yp.await_proc('ticket_grant_permission', newuser.id);

    let data = await this.yp.await_proc('show_member_detail', newuser.id, orgid);
    if (!isEmpty(data)) {
      res = data;
    }
    data = await this.yp.await_proc('org_user_role', newuser.id, orgid);
    data = toArray(data);
    if (data.length) {
      res.role = data;
    }
    if (message) res.email = message;
    if (!isEmpty(res.address)) res.address = this.parseJSON(r.address);
    this.output.data(res);;
  }



  /**
   * 
   */
  async member_update() {
    let orgid //= this.input.need(Attr.orgid);
    let user_id = this.input.need(Attr.user_id);
    let firstname = this.input.need(Attr.firstname);
    let lastname = this.input.need(Attr.lastname);
    let address = this.input.use(Attr.address)
    let email = this.input.need(Attr.email)
    let mobile = this.input.use(Attr.mobile)
    let areacode = this.input.use(Attr.areacode)
    let ident = this.input.need(Attr.ident);
    ident = ident.toLowerCase();
    let users = [];
    let role = this.input.use(Attr.role) || this.input.use(Attr.list) || [];
    let option = this.input.need(Attr.option) || '0';
    this.debug("ZZZ:1999*********************************");
    let otp = this.input.get('otp') || 0;
    if (![1, 0, '1', '0'].includes(otp)) {
      otp = 0;
    }

    let res = {};
    let chk = {};
    let profile = {};
    let notify = 0;
    let email_change = 0

    let org = await this.yp.await_proc('organisation_get', this.user.domain_id())
    orgid = org.id;
    if (isEmpty(org)) return this.output.status('NO_ORG');


    let my_org = await this.user.organization();
    if (isEmpty(my_org)) return this.output.status('NO_ORG');
    if (my_org.id != org.id) return this.output.status('INVALID_ORG');

    let his_org = await this.yp.await_proc('my_organisation', user_id)
    if (isEmpty(his_org)) return this.output.status('NO_ORG');
    if (his_org.id != org.id) return this.output.status('INVALID_ORG');

    let my_privilege = await this.yp.await_proc('domain_privilege', my_org.domain_id, this.uid);
    if (my_privilege.privilege < Remit.dom_admin_memeber) return this.output.status('NOT_ENOUGH_PRIVILEGE');

    let drumate = await this.yp.await_proc('drumate_exists', user_id);

    if (isEmpty(drumate)) return this.output.status('DRUMATE_NOT_EXISTS');

    let domain = await this.yp.await_proc('domain_exists', my_org.domain_id);
    if (drumate.ident != ident) {
      chk = await this.yp.await_proc('get_user_in_domain', ident, domain.name)
      if (chk.exists == 1) return this.output.status('IDENT_NOT_AVAILABLE');
    }

    if (drumate.email != email) {
      chk = await this.yp.await_proc('email_exists', email)
      if (!isEmpty(chk)) return this.output.status('EMAIL_NOT_AVAILABLE');
    }

    let his_privilege = await this.yp.await_proc('domain_privilege', my_org.domain_id, user_id);
    if (isEmpty(his_privilege)) return this.output.status('INCORRECT_DOMAIN');

    if (my_privilege.privilege < his_privilege.privilege) return this.output.status('NOT_ENOUGH_PRIVILEGE');

    if (!isEmpty(role)) {
      for (let id of role) {
        let data = await this.yp.await_proc('role_exists', id, orgid);
        if (isEmpty(data)) return this.output.status('ROLE_NOT_EXISTS');
      }
    }

    let member = await this.yp.await_proc('show_member_detail', user_id, orgid);

    if (isEmpty(member)) return this.output.status('NO_MEMBER');
    if (isEmpty(mobile) && otp) return this.output.status('MOBILE_EMPTY');
    if (isEmpty(areacode) && otp) return this.output.status('AREACODE_EMPTY');
    if (!email || !email.isEmail()) return this.output.status("INVALID_EMAIL_FORMAT")
    if (!isEmpty(mobile)) {
      if (!mobile || !mobile.phoneNumber()) {
        return this.output.status('INVALID_PHONE_FORMAT');
      }
    }

    if (!isEmpty(mobile) && !isEmpty(member.mobile) && (mobile != '')) {
      if (member.mobile != mobile) {
        profile.mobile_verified = 'no'
        if (otp) { notify = 1; }
      }
    }

    if (!isEmpty(areacode) && !isEmpty(member.areacode) && (areacode != '')) {
      if (member.areacode != areacode) {
        profile.mobile_verified = 'no'
        if (otp) { notify = 1; }
      }
    }

    if (!isEmpty(email) && !isEmpty(member.email) && (email != '')) {
      if (member.email != email) {
        profile.email_verified = 'no'
        notify = 1;
        email_change = 1;
      }
    }

    let contacts = await this.yp.await_proc('contact_assignment_get', user_id);
    if (!isEmpty(contacts)) {
      if (!isArray(contacts)) {
        contacts = [contacts]
      }
      for (let contact of contacts) {
        users.push(contact.uid)
      }
    }

    profile.firstname = firstname || '';
    profile.lastname = lastname || '';
    profile.address = address || '';
    profile.email = email || '';
    profile.mobile = mobile || '';
    profile.areacode = areacode || '';

    if (!isEmpty(ident)) {
      profile.ident = ident
      profile.username = ident
    }
    profile.otp = otp;

    if (!isEmpty(role)) {
      await this.yp.await_proc('role_map', user_id, stringify(role), orgid);
    }
    if (drumate.ident != ident) {
      await this.yp.await_proc('drumate_change_username', user_id, ident);
    }
    await this.yp.call_proc('drumate_update_profile', user_id, stringify(profile));
    await this.yp.call_proc('contact_sync_update', user_id);
    await this.yp.await_proc('contact_assignment_update', user_id, stringify(users));

    let need_otp = 1;
    if (isEmpty(mobile) || /(^0+$)|^( *)$/.test(mobile)) {
      await this.yp.call_proc('drumate_remove_profile', user_id, 'mobile');
      need_otp = 0;
    }

    if (isEmpty(areacode) || /(^0+$)|^( *)$/.test(areacode)) {
      await this.yp.call_proc('drumate_remove_profile', user_id, 'areacode');
      need_otp = 0;
    }

    if (need_otp == 0) {
      await this.yp.call_proc('drumate_remove_profile', user_id, 'otp');
    }

    let data = await this.yp.await_proc('show_member_detail', user_id, orgid);
    let connected = data.connected;
    if (!isEmpty(data)) {
      res = data;
    }
    data = await this.yp.await_proc('org_user_role', user_id, orgid);
    data = toArray(data);
    if (data) {
      res.role = data;
    }
    let message;
    if (notify == 1) {
      let recipients = await this.yp.await_proc('user_sockets', user_id);
      await RedisStore.sendData(this.payload(res), recipients);
      if (connected == '1') {
        if (email_change == 1) {
          message = await this.email_change_link(email);
        } else {
          message = await this.password_link(email);
        }
      } else {
        message = await this.invite_link(email);
      }
      await this.yp.await_proc('socket_user_connections', user_id)
      await this.yp.await_proc('session_logout_by_admin', user_id)
    }
    if (message) res.email = message;
    if (!isEmpty(res.address)) {
      res.address = this.parseJSON(res.address);
    }
    this.output.data(res);;
  }

  /**
   * 
   */
  async member_delete() {
    let orgid //= this.input.need(Attr.orgid);
    let user_id = this.input.need(Attr.user_id);

    let org = await this.yp.await_proc('organisation_get', this.user.domain_id())
    orgid = org.id;
    if (isEmpty(org)) return this.output.status('NO_ORG');

    let member = await this.yp.await_proc('show_member_detail', user_id, orgid);

    if (isEmpty(member)) return this.output.status('NO_MEMBER');

    if ('archived' != member.status) return this.output.status('INVALID_STATUS');


    if (member.is_able_delete != 'yes') return this.output.status('INVALID_TIME');


    let my_org = await this.user.organization();
    if (isEmpty(my_org)) return this.output.status('NO_ORG');

    if (my_org.id != org.id) return this.output.status('INVALID_ORG');

    let his_org = await this.yp.await_proc('my_organisation', user_id)
    if (isEmpty(his_org)) return this.output.status('NO_ORG');

    if (his_org.id != org.id) return this.output.status('INVALID_ORG');

    let my_privilege = await this.yp.await_proc('domain_privilege', my_org.domain_id, this.uid);
    if (my_privilege.privilege < Remit.dom_admin) return this.output.status('NOT_ENOUGH_PRIVILEGE');

    let his_privilege = await this.yp.await_proc('domain_privilege', my_org.domain_id, user_id);
    if (isEmpty(his_privilege)) return this.output.status('INCORRECT_DOMAIN');

    if (my_privilege.privilege < his_privilege.privilege) return this.output.status('NOT_ENOUGH_PRIVILEGE');
    let hubs = await this.yp.await_proc('forward_proc', user_id, 'show_hubs', '')
    hubs = toArray(hubs) || [];

    for (let hub of hubs) {
      await this.yp.await_proc('forward_proc', user_id, 'leave_hub', `'${hub.id}'`)
      if (hub.owner_id == user_id) {
        let huber = await this.yp.await_proc('forward_proc', hub.id, 'hub_get_members_by_type', `'${this.uid}','owner',1`)
        if (isEmpty(huber)) {
          huber = await this.yp.await_proc('forward_proc', hub.id, 'hub_get_members_by_type', `'${this.uid}','admin',1`)
        }
        if (isEmpty(huber)) {
          huber = await this.yp.await_proc('forward_proc', hub.id, 'hub_get_members_by_type', `'${this.uid}','all',1`)
        }
        if (!isEmpty(huber)) {
          huber = toArray(huber) || [];
          await this.yp.await_proc('forward_proc', hub.id, 'permission_grant', `'*','${huber[0].id}',0,63,'system',0`)
        }
        else {
          await this.yp.await_proc(`entity_delete`, hub.id);
          remove_dir(hub.home_dir)
        }
      }
    }
    let user = await this.yp.await_proc(`drumate_delete`, user_id);
    remove_dir(user.home_dir);
    this.output.data(user);
  }


  async member_disconnect() {
    let orgid //= this.input.need(Attr.orgid);
    let user_id = this.input.need(Attr.user_id);
    let res = {};
    let chk = {};
    let profile = {};


    let org = await this.yp.await_proc('organisation_get', this.user.domain_id())
    orgid = org.id;
    if (isEmpty(org)) return this.output.status('NO_ORG');

    let member = await this.yp.await_proc('show_member_detail', user_id, orgid);

    if (isEmpty(member)) return this.output.status('NO_MEMBER');

    if ('1' == member.connected) return this.output.status('INVALID_STATUS');

    let my_org = await this.user.organization();
    if (isEmpty(my_org)) return this.output.status('NO_ORG');
    if (my_org.id != org.id) return this.output.status('INVALID_ORG');

    let his_org = await this.yp.await_proc('my_organisation', user_id)
    if (isEmpty(his_org)) return this.output.status('NO_ORG');
    if (his_org.id != org.id) return this.output.status('INVALID_ORG');

    let my_privilege = await this.yp.await_proc('domain_privilege', my_org.domain_id, this.uid);
    if (my_privilege.privilege < Remit.dom_admin) return this.output.status('NOT_ENOUGH_PRIVILEGE');

    let his_privilege = await this.yp.await_proc('domain_privilege', my_org.domain_id, user_id);
    if (isEmpty(his_privilege)) return this.output.status('INCORRECT_DOMAIN');

    if (my_privilege.privilege < his_privilege.privilege) return this.output.status('NOT_ENOUGH_PRIVILEGE');
    let hubs = await this.yp.await_proc('forward_proc', user_id, 'show_hubs', '')
    hubs = toArray(hubs) || [];

    for (let hub of hubs) {
      await this.yp.await_proc('forward_proc', user_id, 'leave_hub', `'${hub.id}'`)
      if (hub.owner_id == user_id) {
        let huber = await this.yp.await_proc('forward_proc', hub.id, 'hub_get_members_by_type', `'${this.uid}','owner',1`)
        if (isEmpty(huber)) {
          huber = await this.yp.await_proc('forward_proc', hub.id, 'hub_get_members_by_type', `'${this.uid}','admin',1`)
        }
        if (isEmpty(huber)) {
          huber = await this.yp.await_proc('forward_proc', hub.id, 'hub_get_members_by_type', `'${this.uid}','all',1`)
        }
        if (!isEmpty(huber)) {
          huber = toArray(huber) || [];
          await this.yp.await_proc('forward_proc', hub.id, 'permission_grant', `'*','${huber[0].id}',0,63,'system',0`)
        }
        else {
          await this.yp.await_proc(`entity_delete`, hub.id);
          remove_dir(hub.home_dir)
        }
      }
    }
    let user = await this.yp.await_proc(`drumate_vanish`, user_id);
    remove_dir(user.home_dir);
    this.output.data(user);
  }


  /**
   * 
   */
  async role_assigned() {
    let user_id = this.input.need(Attr.user_id);
    let orgid //= this.input.need(Attr.orgid);

    let org = await this.yp.await_proc('organisation_get', this.user.domain_id())
    orgid = org.id;
    if (isEmpty(org)) return this.output.status('NO_ORG');

    let tag = await this.yp.await_proc('role_assigned', user_id, orgid)
    this.output.list(tag);
  }

  /**
   * 
   * @returns 
   */
  async role_assign() {
    let user_id = this.input.need(Attr.user_id);
    let orgid //= this.input.need(Attr.orgid);
    let role = this.input.need(Attr.role) || this.input.use(Attr.list) || [];
    let res = {};
    let org = await this.yp.await_proc('organisation_get', this.user.domain_id())
    orgid = org.id;
    if (isEmpty(org)) return this.output.status('NO_ORG');

    let my_org = await this.user.organization();
    if (isEmpty(my_org)) return this.output.status('NO_ORG');

    if (my_org.id != org.id) return this.output.status('INVALID_ORG');


    for (let id of role) {
      let data = await this.yp.await_proc('role_exists', id, orgid);
      if (isEmpty(data)) {
        return this.output.status('ROLE_NOT_EXISTS');
      }
    }
    await this.yp.await_proc('role_map', user_id, stringify(role), orgid);
    res = await this.yp.await_proc('role_assigned', user_id, orgid)
    this.output.list(res);
  }

  /**
   * 
   */
  async role_delete() {
    let role_id = this.input.need(Attr.role_id);
    let orgid //= this.input.need(Attr.orgid);
    let res = {};

    let org = await this.yp.await_proc('organisation_get', this.user.domain_id())
    orgid = org.id;
    if (isEmpty(org)) return this.output.status('NO_ORG');

    let my_privilege = await this.yp.await_proc('domain_privilege', org.domain_id, this.uid);
    if (my_privilege.privilege < Remit.dom_admin_memeber) return this.output.status('NOT_ENOUGH_PRIVILEGE');

    let data = await this.yp.await_proc('role_exists', role_id, orgid);
    if (isEmpty(data)) return this.output.status('ROLE_NOT_EXISTS');
    res = this.yp.await_proc('role_delete', role_id, orgid);
    this.output.data(res);
  }


  /* List the role for a domain */
  async role_show() {
    let orgid //= this.input.need(Attr.orgid);
    const page = this.input.use(Attr.page) || 1;
    let res = {};

    let org = await this.yp.await_proc('organisation_get', this.user.domain_id())
    orgid = org.id;
    if (isEmpty(org)) return this.output.status('NO_ORG');

    let my_privilege = await this.yp.await_proc('domain_privilege', org.domain_id, this.uid);
    if (my_privilege.privilege < Remit.dom_admin_view) return this.output.status('NOT_ENOUGH_PRIVILEGE');

    res = this.yp.await_proc('role_get', orgid, page);
    this.output.list(res);
  }


  /**
   * 
   */
  role_reposition() {
    const list = this.input.use(Attr.content);
    this.db.call_proc('role_reposition', stringify(list), this.output.list);
  }


  /* adding a role to a domain */
  async role_rename() {
    let name = this.input.need(Attr.name);
    let orgid //= this.input.need(Attr.orgid);
    let role_id = this.input.need(Attr.role_id);

    let res = {};

    let org = await this.yp.await_proc('organisation_get', this.user.domain_id())
    orgid = org.id;
    if (isEmpty(org)) {
      return this.output.status('NO_ORG');
    }

    let my_privilege = await this.yp.await_proc('domain_privilege', org.domain_id, this.uid);
    if (my_privilege.privilege < Remit.dom_admin_memeber) {
      return this.output.status('NOT_ENOUGH_PRIVILEGE');
    }

    let data = await this.yp.await_proc('role_exists', role_id, orgid);
    if (isEmpty(data)) {
      return this.output.status('ROLE_NOT_EXISTS');
    }
    if (data.name != name) {
      res = this.yp.await_proc('role_rename', role_id, orgid, name);
    } else {
      res = data
    }

    this.output.data(res);

  }



  /* adding a role to a domain */
  async role_add() {
    let name = this.input.need(Attr.name);
    let orgid //= this.input.need(Attr.orgid);

    let res = {};

    let org = await this.yp.await_proc('organisation_get', this.user.domain_id())
    orgid = org.id;
    if (isEmpty(org)) {
      return this.output.status('NO_ORG');
    }

    let my_privilege = await this.yp.await_proc('domain_privilege', org.domain_id, this.uid);
    if (my_privilege.privilege < Remit.dom_admin_memeber) {
      return this.output.status('NOT_ENOUGH_PRIVILEGE');
    }
    res = this.yp.await_proc('role_add', name, orgid);
    this.output.data(res);
  }


  /**
   * 
   */
  async my_privilege() {
    let res = {};
    res.privilege = 0
    let chk = await this.yp.await_proc('my_subscription', this.uid)
    if (!isEmpty(chk)) {
      res.privilege = Remit.dom_owner
    }
    else {
      // chk = await this.yp.await_proc('my_organisation', this.uid)
      chk = await this.user.organization();
      if (!isEmpty(chk)) {
        res.privilege = chk.privilege
      }
    }
    this.output.data(res);
  }

  /**
   * 
   */
  async my_subscription() {
    let res = await this.yp.await_proc('my_subscription', this.uid)
    this.output.data(res);
  }


  /**
   * 
   */
  async my_organisation() {
    let data = await this.user.organization();
    this.output.data(data);
  }

  /**
   * 
   */
  async organisation_add() {
    let name = this.input.need(Attr.name);
    let ident = this.input.need(Attr.ident);
    ident = ident.toLowerCase();
    let recds = {};
    let org;
    if (!isEmpty(name)) { recds.name = name }
    if (!isEmpty(ident)) { recds.ident = ident }

    let chk = await this.yp.await_proc('my_subscription', this.uid)
    if (isEmpty(chk)) return this.output.status('INVALID_SUBSCRIPTION');

    // chk = await this.yp.await_proc('my_organisation', this.uid)
    chk = await this.user.organization();
    if (!isEmpty(chk)) return this.output.status('ORGANISATION_ALREADY_EXITS');


    chk = await this.yp.await_proc('ident_exists', ident)
    if (!isEmpty(chk)) return this.output.status('IDENT_NOT_AVAILABLE');

    let domain = await this.yp.await_proc('domain_create', ident);
    await this.yp.await_proc('domain_grant', domain.id, Remit.dom_owner, this.uid, 1);
    recds.domain_id = domain.id;
    recds.owner_id = this.id;
    recds.link = domain.name;
    org = await this.yp.await_proc('organisation_add', this.uid, name, domain.name, ident, domain.id, stringify(recds));
    this.output.data(org);
  }


  /**
   * 
   * @returns 
   */
  async organisation_update() {
    let name = this.input.need(Attr.name);
    let orgid //= this.input.need(Attr.orgid);

    let org = await this.yp.await_proc('organisation_get', this.user.domain_id())
    orgid = org.id;
    if (isEmpty(org)) return this.output.status('NO_ORG');

    // let my_org = await this.yp.await_proc('my_organisation', this.uid)
    let my_org = await this.user.organization();
    if (isEmpty(my_org)) return this.output.status('NO_ORG_TO_UPDATE');
    if (my_org.id != org.id) return this.output.status('INVALID_ORG');

    let my_privilege = await this.yp.await_proc('domain_privilege', my_org.domain_id, this.uid);
    if (my_privilege.privilege < Remit.dom_admin) return this.output.status('NOT_ENOUGH_PRIVILEGE');

    let domain = await this.yp.await_proc('domain_update', org.ident, org.domain_id);
    let link = domain.name.replace(/^http.*:\/\//, '');

    org = await this.yp.await_proc('organisation_update', this.uid, orgid, name, link, org.ident);
    this.output.data(org);
  }

  /**
   * 
   * @returns 
   */
  async organisation_update_password_level() {
    let option = this.input.need(Attr.option);
    let orgid //= this.input.need(Attr.orgid);
    let org = await this.yp.await_proc('organisation_get', this.user.domain_id())
    orgid = org.id;
    if (isEmpty(org)) return this.output.status('NO_ORG');

    // let my_org = await this.yp.await_proc('my_organisation', this.uid)
    let my_org = await this.user.organization();
    if (isEmpty(my_org)) return this.output.status('NO_ORG_TO_UPDATE');

    if (my_org.id != org.id) return this.output.status('INVALID_ORG');

    let my_privilege = await this.yp.await_proc('domain_privilege', my_org.domain_id, this.uid);
    if (my_privilege.privilege < Remit.dom_admin_security) return this.output.status('NOT_ENOUGH_PRIVILEGE');

    org = await this.yp.await_proc('organisation_update_password_level', this.uid, orgid, option);
    this.output.data(org);
  }

  /**
   * 
   * @returns 
   */
  async organisation_update_double_auth() {
    let option = this.input.need(Attr.option);
    let orgid //= this.input.need(Attr.orgid);
    let org = await this.yp.await_proc('organisation_get', this.user.domain_id())
    orgid = org.id;
    if (isEmpty(org)) return this.output.status('NO_ORG');

    let my_org = await this.user.organization();
    if (isEmpty(my_org)) return this.output.status('NO_ORG_TO_UPDATE');

    if (my_org.id != org.id) return this.output.status('INVALID_ORG');

    let my_privilege = await this.yp.await_proc('domain_privilege', my_org.domain_id, this.uid);
    if (my_privilege.privilege < Remit.dom_admin_security) return this.output.status('NOT_ENOUGH_PRIVILEGE');

    org = await this.yp.await_proc('organisation_update_double_auth', this.uid, orgid, option);
    this.output.data(org);
  }


  /**
   * 
   * @returns 
   */
  async organisation_update_dir_visiblity() {
    let option = this.input.need(Attr.option);
    let orgid //= this.input.need(Attr.orgid);
    let org = await this.yp.await_proc('organisation_get', this.user.domain_id())
    orgid = org.id;
    if (isEmpty(org)) return this.output.status('NO_ORG');

    let my_org = await this.user.organization();
    if (isEmpty(my_org)) return this.output.status('NO_ORG_TO_UPDATE');

    if (my_org.id != org.id) return this.output.status('INVALID_ORG');

    let my_privilege = await this.yp.await_proc('domain_privilege', my_org.domain_id, this.uid);
    if (my_privilege.privilege < Remit.dom_admin_security) return this.output.status('NOT_ENOUGH_PRIVILEGE');

    org = await this.yp.await_proc('organisation_update_dir_visiblity', this.uid, orgid, option);
    this.output.data(org);
  }


  /**
   * 
   * @returns 
   */
  async organisation_update_dir_info() {
    let option = this.input.need(Attr.option);
    let orgid //= this.input.need(Attr.orgid);

    let org = await this.yp.await_proc('organisation_get', this.user.domain_id())
    orgid = org.id;
    if (isEmpty(org)) return this.output.status('NO_ORG');

    let my_org = await this.user.organization();
    if (isEmpty(my_org)) return this.output.status('NO_ORG_TO_UPDATE');

    if (my_org.id != org.id) return this.output.status('INVALID_ORG');

    let my_privilege = await this.yp.await_proc('domain_privilege', my_org.domain_id, this.uid);
    if (my_privilege.privilege < Remit.dom_admin_security) return this.output.status('NOT_ENOUGH_PRIVILEGE');

    org = await this.yp.await_proc('organisation_update_dir_info', this.uid, orgid, option);
    this.output.data(org);
  }


}


module.exports = __private_adminpanel;
