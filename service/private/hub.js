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
  isEmpty, filter, isArray, difference, map
} = require("lodash");
const {
  utils, RedisStore, Cache, Constants, Attr, Privilege, sysEnv, server_location
} = require("@drumee/server-essentials");
const {
  INTERNAL_ERROR,
  PERMISSION_DENIED,
  INVALID_EMAIL_FORMAT,
  EMAIL_NOT_FOUND,
  ID_NOT_FOUND,
} = Constants;
const { resolve } = require("path");
const { MfsTools } = require("@drumee/server-core");
const { remove_dir } = MfsTools;
const { toArray } = utils;
const { stringify } = JSON;

const Hub = require("../hub");
class __private_hub extends Hub {
  constructor(...args) {
    super(...args);
    this.get_members_by_type = this.get_members_by_type.bind(this);
    this.change_status = this.change_status.bind(this);
    this.change_history = this.change_history.bind(this);
    this.update_name = this.update_name.bind(this);
    this.update_title = this.update_title.bind(this);
    this.update_settings = this.update_settings.bind(this);
    this.update_favicon = this.update_favicon.bind(this);
    this.get_statistics = this.get_statistics.bind(this);
    this.update_ident = this.update_ident.bind(this);
    this.update_visibility = this.update_visibility.bind(this);
    this.get_contributors = this.get_contributors.bind(this);
    this.show_contributors = this.show_contributors.bind(this);
    this.get_settings = this.get_settings.bind(this);
    this.show_privilege = this.show_privilege.bind(this);
    this.add_contributors = this.add_contributors.bind(this);
    this.invite_received_get = this.invite_received_get.bind(this);
    this.invite_with_roles = this.invite_with_roles.bind(this);
    this.delete_contributor = this.delete_contributor.bind(this);
    this.get_space_usage = this.get_space_usage.bind(this);
    this.set_privilege = this.set_privilege.bind(this);
    this.change_owner = this.change_owner.bind(this);
    this.lookup_hubers = this.lookup_hubers.bind(this);
    this.add_font_link = this.add_font_link.bind(this);
    this.get_pr_node_attr = this.get_pr_node_attr.bind(this);
    this.set_node_permission = this.set_node_permission.bind(this);
    this.get_action_log = this.get_action_log.bind(this);
  }

  /**
   *
   */
  get_attributes() {
    this.output.data(this.hub.toJSON());
  }

  /**
   * 
   */
  get_action_log() {
    const user_id = this.user_id();
    const page = this.input.use(Attr.page, 1);
    this.db.call_proc("hub_get_action_log", user_id, page, this.output.list);
  }

  /**
   * 
   */
  get_members_by_type() {
    const type = this.input.need(Attr.type);
    const page = this.input.use(Attr.page, 1);
    this.db.call_proc(
      "hub_get_members_by_type",
      this.uid,
      type,
      page,
      this.output.list
    );
  }

  /**
   * 
   */
  change_status() {
    const user_id = this.user_id();
    const hub_id = this.hub.get(Attr.id);
    const status = this.input.need(Attr.status);
    const cb = function (data) {
      if (isEmpty(data)) {
        this.excetion.user(INTERNAL_ERROR);
      }
      if (data.valid_user === "0") {
        return this.excetion.user(PERMISSION_DENIED);
      } else {
        delete data.valid_user;
        data = { status };
        this.output.data(data);
      }
    }.bind(this);
    this.yp.call_proc(
      "yp_change_hub_status",
      user_id,
      hub_id,
      this.permission,
      status,
      cb
    );
  }

  /**
  * Gets disk space availability.
  * @param {*} id 
  * @returns 
  */
  get_occupied_drumate_space(id) {
    const total_size = this.user.get('quota').disk;
    return { total: total_size, user_data: this.user.get('disk_usage') };
  }

  /**
   * 
   */
  _getShareLink(token) {
    let keysel = this.hub.get(Attr.id);
    const pathname = `/?keysel=${keysel}/#/dmz/share/`;
    this.debug("AAA:142", this.input.homepath())
    let link = `${this.input.homepath(this.hub.get(Attr.hostname))}${pathname}`;
    if (token) return link + token;
    return link;
  }

  /**
 * 
 * @param {*} hub_id 
 * @param {*} message 
 * @param {*} flag 
 * @param {*} opt 
 * @returns 
 */
  async notify_external(hub_id, message, flag, opt = {}) {
    const link = this._getShareLink();
    const icon = this.hub.get(Attr.icon)

    // Offline File path
    let cmd = resolve(server_location, 'offline', 'notification', 'sharebox-notification.js');

    let members = await this.yp.await_proc('forward_proc', hub_id, 'dmz_notify_list', `'${flag}'`);
    if (isEmpty(members)) { return }
    members = toArray(members);
    // initiated the child process
    const username = this.user_id.get(Attr.firstname) || this.user_id.get(Attr.username);
    const lang = this.input.language();
    let args = [JSON.stringify({ hub_id, message, flag, lang, username, link, icon, options: opt })];
    const { spawn } = require('child_process');
    spawn(cmd, args, { detached: true });

    return members;
  }


  /**
   * 
   */
  change_history() {
    const id = this.input.use(Attr.id, "");
    const key = this.input.use(Attr.key, "");
    const from_date = this.input.use(Attr.from, 0);
    const to_date = this.input.use(Attr.to, 0);
    const page = this.input.use(Attr.page, 1);
    this.db.call_proc(
      "change_history",
      id,
      key,
      from_date,
      to_date,
      page,
      this.output.data
    );
  }

  /**
   * 
   */
  async update_name() {
    const hub_id = this.hub.get(Attr.id);
    const name = this.input.need(Attr.name);
    let sql = "SELECT * FROM hub WHERE name=?"
    let { id } = await this.yp.await_query(sql, name);
    if (id) {
      this.output.data({ error: "ALREADY_EXISTS" });
      return;
    }

    await this.yp.await_proc("hub_update_name", hub_id, name);
    let hub = await this.yp.await_proc("get_hub", hub_id);
    let my_db = this.user.get(Attr.db_name)
    let recipients = await this.yp.await_proc("entity_sockets", hub_id);
    let node = await this.yp.await_proc(`${my_db}.mfs_access_node`, this.uid, hub_id);
    node.hubname = hub.hubname;
    node.name = hub.hubname;
    node.fieldName = 'hubname';
    await RedisStore.sendData(this.payload(node), recipients);
    this.output.data(node);
  }

  /**
   * 
   */
  update_title() {
    const hub_id = this.hub.get(Attr.id);
    const hub_title = this.input.need(Attr.hub_title);
    this.yp.call_proc("hub_update_title", hub_id, hub_title, this.output.data);
  }

  /**
   * 
   */
  update_settings() {
    const vars = this.input.need(Attr.vars);
    const hub_id = this.hub.get(Attr.id);
    async function f() {
      let v;
      for (let k in vars) {
        v = vars[k];
        await this.yp.await_proc("hub_change_settings", hub_id, k, v);
      }
      return null;
    }
    f()
      .then(function () {
        this.yp.call_proc("get_settings", hub_id, this.output.data);
      })
      .catch(this.fallback);
  }

  /**
   * 
   */
  update_favicon() {
    const hub_id = this.get(Attr.id);
    const favicon = this.input.need(Attr.favicon);
    this.yp.call_proc("hub_update_favicon", hub_id, favicon, this.output.data);
  }

  /**
   * 
   * @returns 
   */
  get_statistics() {
    return this.db.call_proc("get_statistics", this.output.data);
  }

  /**
   * 
   */
  update_ident() {
    const ident = this.input.need(Attr.ident);
    const id = this.input.use(Attr.id);
    this.yp.call_proc(
      "ident_exists",
      ident,
      function (row) {
        if (isEmpty(row)) {
          return this.yp.call_proc("update_ident", id, ident, () => {
            return this.yp.call_proc("get_hub", ident, this.output.data);
          });
        } else {
          return this.exception.user("_ident_already_exists");
        }
      }.bind(this)
    );
  }

  /**
   * 
   * @returns 
   */
  update_visibility() {
    const hub_id = this.hub.get(Attr.id);
    const visibility = this.input.need(Attr.value);
    return this.yp.call_proc(
      "hub_update_visibility",
      hub_id,
      visibility,
      this.output.data
    );
  }

  /**
   * 
   * @returns 
   */
  get_contributors() {
    const page = this.input.use(Attr.page, 1);
    const privilege = this.input.use(Attr.privilege) || 0;
    return this.db.call_proc("show_contributors", page, this.output.data);
  }

  /**
   * 
   */
  show_contributors() {
    const page = this.input.use(Attr.page, 1);
    this.db.call_proc("show_contributors", page, this.output.data);
  }

  /**
   * 
   */
  async get_settings() {
    let data = await this.yp.await_proc("get_hub_owner", this.hub.get(Attr.id));
    const opt = this.hub.get(Attr.settings);
    opt.default_privilege = opt.default_privilege || Privilege.DOWNLOAD;
    opt.owner = data;
    opt.hubname = this.hub.get(Attr.name);
    let visitor = await this.db.await_proc("member_show_privilege", this.uid);
    opt.visitor = visitor;
    let users = await this.db.await_proc(
      "hub_get_members_by_type",
      this.uid,
      "all",
      1
    );
    // opt.users = users;
    users = toArray(users);
    opt.users = filter(users, (el) => {
      return (el.privilege & 32) == 0;
    });

    this.output.data(opt);
  }

  /**
   * 
   * @returns 
   */
  async show_privilege() {
    let owner = {};
    if ([Attr.all, Attr.owner, 'not_owner', 'admin', Attr.other].includes(this.input.get(Attr.type))) {
      owner = await this.db.await_proc(
        "hub_get_members_by_type",
        this.uid,
        this.input.get(Attr.type),
        1
      )
    }
    let { filesize } = await this.db.await_query("SELECT sum(filesize) filesize FROM media");
    let visitor = await this.db.await_proc(
      "member_show_privilege",
      this.uid
    );
    this.output.data({ owner, visitor, filesize });
  }

  /**
   * Workspace invitations addressed to the current user.
   * Resolves inviter and hub names at read time so older rows render correctly.
   */
  async invite_received_get() {
    const rows = await this.yp.await_query(
      "SELECT a.id, a.timestamp AS ctime, a.uid AS author_id, " +
      "       a.target_uid, a.event, a.data, " +
      "       d.firstname    AS inviter_firstname, " +
      "       d.lastname     AS inviter_lastname,  " +
      "       d.email        AS inviter_email,     " +
      "       e.headline     AS hub_headline,      " +
      "       e.ident        AS hub_ident          " +
      "  FROM yp.contact_activity a " +
      "  LEFT JOIN yp.drumate d ON d.id = a.uid " +
      "  LEFT JOIN yp.entity  e " +
      "         ON e.id = JSON_UNQUOTE(JSON_EXTRACT(a.data, '$.hub_id')) " +
      " WHERE a.target_uid = ? AND a.event = 'hub_invite_received' " +
      " ORDER BY a.timestamp DESC LIMIT 50",
      this.uid
    );
    const out = (rows || []).map((r) => {
      let meta = {};
      if (r.data) {
        try {
          meta = typeof r.data === "string" ? JSON.parse(r.data) : r.data;
        } catch (_) { meta = {}; }
      }
      const firstname = meta.from_firstname || r.inviter_firstname || "";
      const lastname  = meta.from_lastname  || r.inviter_lastname  || "";
      const fullname =
        meta.from_fullname ||
        `${firstname} ${lastname}`.trim() ||
        r.inviter_email ||
        null;
      // Prefer the live hub name from yp.entity over whatever was stored at
      // invite time (older rows had the hub id pasted in here).
      const hub_id = meta.hub_id || null;
      const hub_name =
        r.hub_headline ||
        r.hub_ident ||
        (meta.hub_name && meta.hub_name !== hub_id ? meta.hub_name : null) ||
        null;
      return {
        id: r.id,
        ctime: r.ctime,
        author_id: r.author_id,
        target_uid: r.target_uid,
        event: r.event,
        hub_id,
        hub_name,
        firstname,
        lastname,
        fullname,
        from_fullname: fullname,
        message: meta.message || null,
        privilege: meta.privilege || null
      };
    });
    this.output.list(out);
  }

  /**
   * @returns
   */
  async add_contributors() {
    let users = this.input.need(Attr.users);
    const username = this.user.get("fullname");
    const hubname = this.hub.get(Attr.name);
    const privilege = this.input.use(Attr.privilege) || this.hub.get(Attr.settings).default_privilege;
    const hours = this.input.use(Attr.hours, 0)
    const days = this.input.use(Attr.days, 0);
    const expiry = hours * 1 + days * 24;
    const lang = this.user.language() || this.input.app_language();
    let mfs_home = await this.db.await_proc("mfs_home");
    let msg = Cache.message("_x_add_you_to_team", lang).format(
      username,
      hubname
    );
    let message = this.input.use(Attr.message) || msg;
    users = toArray(users);
    let members = [];
    let rows = [];
    if (isEmpty(users)) {
      this.output.data([]);
      return;
    }
    let { domain_id } = this.user.toJSON();
    let db_name = await this.yp.await_func("get_db_name", this.uid);
    if (!db_name) {
      this.warn("[hub] add_contributors: no contact db for hub", this.uid);
      this.output.data([]);
      return;
    }
    let proc = `${db_name}.my_contact_exists`;
    for (let entity of users) {
      try {
        let contact = await this.yp.await_proc(proc, 'entity', entity, '', '');
        if (!isEmpty(contact)) {
          if (contact.status == "active") {
            members.push(contact.uid);
          } else {
            await this.yp.await_proc(
              "yp_add_pending_invitation",
              this.hub.get(Attr.id),
              expiry,
              privilege,
              entity
            );
          }
        } else {
          let drumate = null;
          try {
            drumate = await this.yp.await_proc("drumate_exists", entity);
            if (isArray(drumate)) drumate = drumate[0];
          } catch (e) {
            this.warn("[hub] add_contributors: drumate_exists for entity", entity, e);
          }
          const sameDomain = drumate && drumate.domain_id != null && domain_id === drumate.domain_id;
          if (sameDomain) {
            members.push(drumate.id);
          } else {
            // Not a contact: register as pending invitation and send contact invitation.
            // Two cases: (1) Email already has Drumee account → contact.invite sends in-app mail.
            // (2) Email not in system → contact.invite sends signup/invite email with token.
            await this.yp.await_proc(
              "yp_add_pending_invitation",
              this.hub.get(Attr.id),
              expiry,
              privilege,
              entity
            );
            const isEmail = typeof entity === "string" && entity.indexOf("@") !== -1;
            if (isEmail) {
              try {
                const ContactPrivate = require("./contact");
                const contactSvc = new ContactPrivate({
                  session: this.session,
                  permission: this.permission || { scope: "hub" }
                });
                contactSvc.db = {
                  await_proc: (proc, ...args) => this.yp.await_proc(`${db_name}.${proc}`, ...args),
                  end: () => Promise.resolve()
                };
                const origEmail = this.input.use(Attr.email) ?? this.input.get(Attr.email);
                const origMessage = this.input.use(Attr.message);
                this.input.set(Attr.email, entity);
                this.input.set(Attr.message, message);
                this.input.set("_contact_db_name", db_name);
                await contactSvc.invite();
                if (origEmail !== undefined) this.input.set(Attr.email, origEmail);
                if (origMessage !== undefined) this.input.set(Attr.message, origMessage);
              } catch (err) {
                this.warn("[hub] add_contributors: send invitation failed for entity", entity, err);
              }
            }
          }
        }
      } catch (err) {
        this.warn("[hub] add_contributors: failed for entity", entity, err);
      }
    }
    for (let uid of members) {
      let r = await this.db.await_proc("add_member", uid, privilege, expiry);
      if (!r || !r.db_name) continue;
      rows.push(r);
      await this.db.await_proc(
        "permission_grant",
        "*",
        uid,
        expiry,
        privilege,
        "system",
        message
      );
      await this.db.await_proc(
        "permission_grant",
        mfs_home.chat_upload_id,
        uid,
        0,
        4,
        "no_traversal",
        "chat upload permission"
      );
      try {
        await this.yp.await_proc(
          "contact_log_activity",
          this.uid,
          uid,
          "hub_invite_received",
          {
            hub_id: this.hub.get(Attr.id),
            hub_name: hubname,
            message: message,
            from_fullname: username,
            privilege: privilege
          }
        );
      } catch (err) {
        this.warn(
          "[hub] add_contributors: log activity failed for", uid,
          err && err.message
        );
      }
    }
    if (!isEmpty(rows)) {
      for (let recipient of toArray(rows)) {
        let hub = await this.yp.await_proc(
          `${recipient.db_name}.mfs_access_node`,
          recipient.id,
          this.hub.get(Attr.id)
        );
        hub.message = message;
        hub.ownpath = '/';
        hub.hub_id = hub.actual_hub_id;
        hub.db_name = hub.actual_db_name;
        let sockets = await this.yp.await_proc("user_sockets", recipient.id);
        await RedisStore.sendData(
          this.payload(hub, { service: "hub.invite_received" }),
          sockets
        );
      }
    }

    message = this.input.use(Attr.message);
    if (!isEmpty(message)) {
      let input = {};
      let message_id = await this.db.await_proc("message_id");
      message_id = message_id.id;
      input.author_id = this.uid;
      input.uid = this.uid;
      input.message_id = message_id;
      message = message.replace(/'/gi, "''");
      let data = await this.yp.await_proc(
        "forward_proc",
        this.hub.get(Attr.id),
        "channel_post_message_next",
        `'${stringify(input)}','${message}'`
      );
      data.is_attachment = 0;
      let profile = this.user.get("profile") || {};
      data.firstname = this.user.attributes.firstname;
      data.lastname = profile.lastname;
      data.hub_id = this.hub.get(Attr.id);

      let sockets = await this.yp.await_proc(
        "entity_sockets",
        this.hub.get(Attr.id)
      );
      await RedisStore.sendData(this.payload(data), sockets);
    }

    // res = await this.db.await_proc(
    //   "hub_get_members_by_type",
    //   this.uid,
    //   type,
    //   1
    // );
    // res = toArray(res);
    // res = filter(res, (el) => {
    //   return (el.privilege & 32) == 0;
    // });
    users = await this.db.await_proc(
      "hub_get_members_by_type",
      this.uid,
      "not_owner",
      1
    );
    this.output.data(users);
  }

  /**
   * Invite one or more users to multiple workspaces with per-workspace privilege.
   * Called from the Home page "Invite" button.
   *
   *
   * Input:
   *   users {string[]} — array of user IDs or email addresses
   *   assignments {object[]} — [{hub_id, privilege}]
   *
   * Privilege bitmask:
   *   2  = Chat only
   *   4  = Edit (read + write)
   *   6  = Edit + Chat
   *   15 = Admin
   *
   * Flow per assignment:
   *   1. Resolve hub_db via get_db_name
   *   2. Get hub name for notification message
   *   3. Get mfs_home for chat_upload_id
   *   4. For each user entity:
   *      a. Check my_contact_exists (inviter's contact DB)
   *         - active contact → add to members[] immediately
   *         - pending contact → yp_add_pending_invitation
   *      b. If not a contact: drumate_exists
   *         - same domain → add to members[] immediately
   *         - different domain → yp_add_pending_invitation + send invite email
   *   5. For confirmed members: add_member + permission_grant (both * and chat_upload_id)
   *   6. WebSocket notify each added member
   *
   * Returns: { success: boolean, results: [{hub_id, added}] }
   */
  async invite_with_roles() {
    let users = this.input.need(Attr.users);
    let assignments = this.input.need('assignments');
 
    users = toArray(users);
    assignments = toArray(assignments);
 
    if (isEmpty(users) || isEmpty(assignments)) {
      this.output.data({ success: false, results: [] });
      return;
    }
 
    const username = this.user.get('fullname');
    const lang = this.user.language() || this.input.app_language();
    const { domain_id } = this.user.toJSON();
    const expiry = 0; // No expiry option in UI
 
    // Inviter's contact DB — used for my_contact_exists lookups
    const contact_db = await this.yp.await_func('get_db_name', this.uid);
    if (!contact_db) {
      this.warn('[hub] invite_with_roles: no contact db for uid', this.uid);
      this.output.data({ success: false, results: [] });
      return;
    }
    const contact_proc = `${contact_db}.my_contact_exists`;
 
    const results = [];
 
    for (const assignment of assignments) {
      const { hub_id, privilege } = assignment;
      if (!hub_id || privilege == null) {
        this.warn('[hub] invite_with_roles: skipping invalid assignment', assignment);
        continue;
      }
 
      // Resolve target hub's DB — explicit db_name, no forward_proc
      const hub_db = await this.yp.await_func('get_db_name', hub_id);
      if (!hub_db) {
        this.warn('[hub] invite_with_roles: no db found for hub_id', hub_id);
        continue;
      }
 
      // Hub display name for notification message
      const hubInfo = await this.yp.await_proc('get_hub', hub_id);
      const hubname = (hubInfo && (hubInfo.hubname || hubInfo.name)) || hub_id;
      const msg = Cache.message('_x_add_you_to_team', lang).format(username, hubname);
 
      // mfs_home needed for chat_upload_id permission grant
      const mfs_home = await this.yp.await_proc(`${hub_db}.mfs_home`);
 
      const members = []; // UIDs to add immediately
      const rows = []; // Results from add_member (for WebSocket notify)
 
      // Resolve each user entity
      for (const entity of users) {
        try {
          // 1. Check inviter's contact list
          const contact = await this.yp.await_proc(contact_proc, 'entity', entity, '', '');
 
          if (!isEmpty(contact)) {
            if (contact.status === 'active') {
              // Known active contact → add immediately
              members.push(contact.uid);
            } else {
              // Pending contact → store for deferred grant
              await this.yp.await_proc(
                'yp_add_pending_invitation',
                hub_id, expiry, privilege, entity
              );
            }
          } else {
            // Not in contact list — check if user exists in Drumee
            let drumate = null;
            try {
              drumate = await this.yp.await_proc('drumate_exists', entity);
              if (isArray(drumate)) drumate = drumate[0];
            } catch (e) {
              this.warn('[hub] invite_with_roles: drumate_exists failed for', entity, e);
            }
 
            const sameDomain =
              drumate &&
              drumate.domain_id != null &&
              domain_id === drumate.domain_id;
 
            if (sameDomain) {
              // Exists on same domain → add immediately
              members.push(drumate.id);
            } else {
              // Unknown user or different domain → pending + invite email
              await this.yp.await_proc(
                'yp_add_pending_invitation',
                hub_id, expiry, privilege, entity
              );
 
              // Only send email if entity looks like an email address
              const isEmail = typeof entity === 'string' && entity.indexOf('@') !== -1;
              if (isEmail) {
                try {
                  const ContactPrivate = require('./contact');
                  const contactSvc = new ContactPrivate({
                    session:    this.session,
                    permission: this.permission || { scope: 'hub' },
                  });
                  contactSvc.db = {
                    await_proc: (proc, ...args) =>
                      this.yp.await_proc(`${contact_db}.${proc}`, ...args),
                    end: () => Promise.resolve(),
                  };
                  const origEmail   = this.input.use(Attr.email);
                  const origMessage = this.input.use(Attr.message);
                  this.input.set(Attr.email, entity);
                  this.input.set(Attr.message, msg);
                  this.input.set('_contact_db_name', contact_db);
                  await contactSvc.invite();
                  if (origEmail   !== undefined) this.input.set(Attr.email, origEmail);
                  if (origMessage !== undefined) this.input.set(Attr.message, origMessage);
                } catch (err) {
                  this.warn(
                    '[hub] invite_with_roles: send invitation failed for',
                    entity, err
                  );
                }
              }
            }
          }
        } catch (err) {
          this.warn('[hub] invite_with_roles: failed for entity', entity, err);
        }
      }
 
      // Add confirmed members
      for (const uid of members) {
        // Grant membership in hub DB
        const r = await this.yp.await_proc(`${hub_db}.add_member`, uid, privilege, expiry);
        if (!r || !r.db_name) continue;
        rows.push(r);
 
        // Grant resource-level permission on hub root
        await this.yp.await_proc(
          `${hub_db}.permission_grant`,
          '*', uid, expiry, privilege, 'system', msg
        );
 
        // Grant chat upload permission if chat folder exists
        if (mfs_home && mfs_home.chat_upload_id) {
          await this.yp.await_proc(
            `${hub_db}.permission_grant`,
            mfs_home.chat_upload_id,
            uid,
            0,    // no expiry on chat upload
            4,    // read+write for uploads
            'no_traversal',
            'chat upload permission'
          );
        }
      }
 
      // WebSocket notify each successfully added member
      for (const recipient of toArray(rows)) {
        const hub     = await this.yp.await_proc(
          `${recipient.db_name}.mfs_access_node`,
          recipient.id,
          hub_id
        );
        hub.message = msg;
        hub.ownpath = '/';
        hub.hub_id = hub.actual_hub_id;
        hub.db_name = hub.actual_db_name;
        const sockets = await this.yp.await_proc('user_sockets', recipient.id);
        await RedisStore.sendData(this.payload(hub), sockets);
      }
 
      results.push({ hub_id, added: members.length });
    }
 
    this.output.data({ success: true, results });
  }

  /**
   * 
   */
  async delete_hub() {
    const hub_id = this.input.need(Attr.hub_id);
    let data = this.hub.toJSON();
    if (data.type !== Attr.hub) {
      this.warn("delete_hub: WRONG_ENTITY_TYPE", hub_id)
      return this.exception.user("WRONG_ENTITY_TYPE");
    }
    // let db_name = this.user.get(Attr.db_name);
    let old_node = this.granted_node(); //await this.yp.await_proc(`${db_name}.mfs_access_node`, this.uid, hub_id);
    let outout = { ...old_node, uid: this.uid, nid:hub_id, id: hub_id, hub_id }

    let sockets = await this.yp.await_proc("entity_sockets", hub_id);
    await RedisStore.sendData(this.payload(outout), sockets);

    await this.db.await_proc(`remove_all_members`, 0);
    let entity = await this.yp.await_proc("entity_delete", hub_id);
    remove_dir(entity.home_dir, 1);
    this.output.data(outout);
  }

  /**
   *
   */
  async get_external_room_attr() {
    let rows = await this.db.await_proc("dmz_settings") || [];

    let res = rows.shift();
    if (isEmpty(res)) {
      await this._update_external_room()
      rows = await this.db.await_proc("dmz_settings") || [];
      res = rows.shift();
    }
    res.details = rows;
    res.members = [];

    let members = await this.db.await_proc("dmz_get_members", this.uid);
    members = toArray(members);
    res.members = members;
    this.debug(res)
    res.link = this._getShareLink(res.link);
    this.output.data(res);
  }

  /**
   *
   */
  async external_notification() {
    let message = this.input.use(Attr.message) || "";
    let members = await this.notify_external(
      this.hub.get(Attr.id),
      message,
      "all"
    );
    this.output.data({ members });
  }

  /**
   *
   */
  async delete_external_member() {
    let emails = this.input.need(Attr.email);
    let nid = this.home_id;
    let email;
    let hub_id = this.hub.get(Attr.id);
    const data = { id: this.hub.get(Attr.id) };

    if (!isEmpty(emails)) {
      emails = toArray(emails);
      for (email of emails) {
        let g = await this.yp.await_proc("dmz_add_user", email, null);
        await this.db.await_proc("dmz_remove_member", g.id, hub_id, nid);
      }
    }

    this.output.data({ emails });
  }

  /**
   *
   */
  async update_external_settings() {
    const permission = this.input.use(Attr.permission) || Privilege.GUEST;
    const passwordSet = this.input.use("passwordSet") || 0;
    const password = this.input.get(Attr.password) || "";
    const days = this.input.get(Attr.days) || 0;
    const hours = this.input.get(Attr.hours) || 0;
    const expiry = hours * 1 + days * 24;
    let res = {};
    let nid = this.home_id;
    let hub_id = this.hub.get(Attr.id);
    const validityMode = expiry === 0 ? "infinity" : "limited";
    this.debug("AAAA:53", { passwordSet, password, permission, validityMode, days, expiry })
    if (permission) {
      await this.yp.await_proc(
        "dmz_update_permission_next",
        hub_id,
        nid,
        permission
      );
      res.permission = permission;
    }
    if (passwordSet) {
      if (password) await this.yp.await_proc("dmz_update_password", hub_id, nid, password);
    } else {
      await this.yp.await_proc("dmz_update_password", hub_id, nid, '');
    }

    await this.yp.await_proc(
      "dmz_update_expiry_new",
      hub_id,
      nid,
      validityMode,
      expiry
    );
    res.hours = hours;
    res.days = days;
    res.dmz_expiry = "active";
    if (expiry == 0) {
      res.dmz_expiry = "expired";
    }
    if (validityMode == "infinity") {
      res.dmz_expiry = "infinity";
    }

    this.output.data(res);
  }

  /**
   * 
   */
  async update_external_members() {
    let emails = this.input.use(Attr.emails) || this.input.use(Attr.email);
    emails = toArray(emails);
    let members = await this.db.await_proc("dmz_get_members", this.uid);
    members = toArray(members);

    let members_mail = map(members, "email");
    let delete_mails = difference(members_mail, emails);
    let new_mails = difference(emails, members_mail);

    let nid = this.home_id;
    let hub_id = this.hub.get(Attr.id);
    for (email of delete_mails) {
      let g = await this.yp.await_proc("dmz_add_user", email, null);
      await this.db.await_proc("dmz_remove_member", g.id, hub_id, nid);
    }

    for (var email of new_mails) {
      await this.add_contact(email);
      let g = await this.yp.await_proc("dmz_add_user", email, null);
      await this.yp.await_proc(
        "dmz_grant_next",
        hub_id,
        nid,
        g.id,
        this.randomString(),
        null
      );
      await this.db.await_proc("permission_grant", nid, g.id, 0, 1, "link", "");
    }

    let rows = (await this.db.await_proc("dmz_settings")) || [];
    let settings = rows.shift();

    const permission = settings.permission || 1;
    const expiry = settings.expiry_time || 0;
    const fingerprint = settings.fingerprint || "";
    await this.yp.await_proc(
      "dmz_update_settings",
      hub_id,
      nid,
      fingerprint,
      expiry,
      permission
    );

    this.output.data({ emails });
  }

  /**
   *
   */
  async copy_link() {
    let res = {};
    let nid = this.input.need(Attr.nid);
    let hub_id = this.hub.get(Attr.id);
    let home_id = this.home_id;

    let rows = (await this.db.await_proc("dmz_settings")) || [];
    let settings = rows.shift();
    const permission = settings.permission || 1;
    const expiry = settings.expiry_time || 0;
    const fingerprint = settings.fingerprint || "";

    await this.yp.await_proc("dmz_add_media", nid, hub_id);

    let node = await this.db.await_proc("mfs_access_node", this.uid, nid);

    if (node.ftype == "folder") {
      res = await this.yp.await_proc(
        "dmz_grant_next",
        hub_id,
        nid,
        nid,
        this.randomString(),
        fingerprint
      );
    } else {
      res = await this.yp.await_proc(
        "dmz_grant_next",
        hub_id,
        node.parent_id,
        nid,
        this.randomString(),
        fingerprint
      );

      await this.db.await_proc(
        "permission_grant",
        node.parent_id,
        nid,
        0,
        1,
        "root",
        ""
      );
    }

    await this.db.await_proc("permission_grant", nid, nid, 0, 1, "link", "");
    await this.yp.await_proc(
      "dmz_update_settings",
      hub_id,
      nid,
      fingerprint,
      expiry,
      permission
    );
    res.link = this._getShareLink(res.link);
    this.output.data(res);
  }

  /**
   *
   */
  async add_external_member() {
    let emails = this.input.use(Attr.emails) || this.input.use(Attr.email) || [];
    let nid = this.home_id;
    let hub_id = this.hub.get(Attr.id);

    let rows = (await this.db.await_proc("dmz_settings")) || [];
    let settings = rows.shift();

    const permission = settings.permission || 1;
    const expiry = settings.expiry_time || 0;
    const fingerprint = settings.fingerprint || "";

    emails = toArray(emails);

    for (var email of emails) {
      let g = await this.yp.await_proc("dmz_add_user", email, null);
      await this.yp.await_proc(
        "dmz_grant_next",
        hub_id,
        nid,
        g.id,
        this.randomString(),
        null
      );
      await this.db.await_proc("permission_grant", nid, g.id, 0, 1, "link", "");
    }

    await this.yp.await_proc(
      "dmz_update_settings",
      hub_id,
      nid,
      fingerprint,
      expiry,
      permission
    );
    //await this.notify_external(hub_id, '', 'new');
    this.output.data({ emails });
  }

  /**
   * 
   * @returns 
   */
  async _update_external_room(opt = {}) {
    let {
      emails = [],
      permission = Privilege.WRITE,
      pw,
      validityMode = "infinity",
      days = 0,
      hours = 0
    } = opt;

    let expiry = hours * 1 + days * 24;

    if (validityMode == "infinity") expiry = 0;

    if (permission > Privilege.WRITE) permission = Privilege.WRITE;

    let nid = this.home_id;
    let hub_id = this.hub.get(Attr.id);
    //let public_id = Cache.getSysConf("public_id");
    let guest_id = Cache.getSysConf("guest_id");
    let g = await this.yp.await_proc(
      "dmz_grant_next",
      hub_id,
      nid,
      guest_id,
      this.randomString(),
      pw
    );
    await this.db.await_proc(
      "permission_grant",
      nid,
      guest_id,
      expiry,
      permission,
      "link",
      ""
    );

    emails = toArray(emails);
    for (var email of emails) {
      await this.add_contact(email);
      g = await this.yp.await_proc("dmz_add_user", email, null);
      await this.yp.await_proc(
        "dmz_grant_next",
        hub_id,
        nid,
        g.id,
        this.randomString(),
        pw
      );
      await this.db.await_proc(
        "permission_grant",
        nid,
        g.id,
        expiry,
        permission,
        "link",
        ""
      );
    }

  }


  /**
   *
   */
  async update_external_room() {
    let emails = this.input.use(Attr.emails) || this.input.use(Attr.email) || [];
    let permission = this.input.use(Attr.permission) || Privilege.GUEST;
    const pw = this.input.get(Attr.password);
    const validityMode = this.input.get("validity_mode") || "infinity";
    const days = this.input.get(Attr.days) || 0;
    const hours = this.input.get(Attr.hours) || 0;
    await this._update_external_room({
      emails, permission, pw, validityMode, days, hours
    })

    this.output.data({ emails });
  }

  /**
   * 
   * @param {*} email 
   */
  async add_contact(email) {
    let entity = email;
    let firstname;
    let lastname;
    let drumate = await this.yp.await_proc("drumate_exists", entity);
    entity = drumate.id || entity;
    const { db_name } = this.user.toJSON();
    let proc = `${db_name}.my_contact_exists`;
    let mycontact = await this.yp.await_proc(proc, 'entity', entity, '', '');
    if (isEmpty(mycontact)) {
      let a = email.split("@");
      a[1] = a[0];
      if (a[0].indexOf(".") !== -1) {
        a = a[0].split(".");
      }
      firstname = a[0];
      lastname = a[1];
      let metadata = {
        source: email,
        imported: this.session.timestamp,
        from: "exroom",
      };
      proc = `${db_name}.my_contact_add_next`;
      let contact = await this.yp.await_proc(proc, entity, null, firstname, lastname, 'independant', null, null, metadata);
      let node = {};
      node.email = email;
      node.category = "priv";
      node.is_default = "1";
      proc = `${db_name}.my_contact_mail_add`;
      await this.yp.await_proc(contact.id, node);
    }
  }

  /**
   * 
   */
  async delete_contributor() {
    let users = this.input.need(Attr.users);
    users = toArray(users);
    let members = [];
    for (let uid of users) {
      if (uid != this.uid) {
        members.push(uid);
      }
    }

    let service = "media.remove";
    let hub_id = this.hub.get(Attr.id);
    for (let uid of members) {
      let { db_name } = await this.yp.await_proc("get_entity", uid);
      await this.yp.await_proc(`${db_name}.leave_hub`, hub_id);
      let node = this.granted_node();
      node.nid = node.id = hub_id;
      let sockets = await this.yp.await_proc("user_sockets", uid);
      let payload = this.payload(node, { service });
      await RedisStore.sendData(payload, sockets);
    }
    users = await this.db.await_proc(
      "hub_get_members_by_type",
      this.uid,
      "not_owner",
      1
    );
    this.output.list(users);
  }

  /**
   * 
   * @returns 
   */
  get_space_usage() {
    const data = this.get_occupied_hubs_space(
      this.hub("owner_id"),
      this.get(Attr.id)
    );
    const drumate_space = this.get_occupied_drumate_space(this.hub("owner_id"));
    data.total = drumate_space.total;
    data.others = data.others + drumate_space.user_data;
    data.free = data.total - data.others - data.selected;
    return this.output.data(data);
  }

  /**
   * 
   */
  async set_privilege() {
    let users = this.input.need(Attr.users);
    const privilege =
      this.input.use(Attr.privilege) ||
      this.input.use(Attr.permission) ||
      this.hub.get(Attr.settings).default_privilege ||
      1;

    let mfs_home = await this.db.await_proc("mfs_home");

    users = toArray(users);
    let hub;

    for (let uid of users) {
      await this.db.await_proc("permission_set", uid, privilege);

      await this.db.await_proc(
        "permission_grant",
        mfs_home.chat_upload_id,
        uid,
        0,
        4,
        "no_traversal",
        "chat upload permission"
      );

      hub = {};
      hub.privilege = privilege;
      hub.hub_id = this.hub.get(Attr.hub_id);
      hub.area = this.hub.get(Attr.area);
      let sockets = await this.yp.await_proc("user_sockets", uid);
      await RedisStore.sendData(this.payload(hub), sockets);
    }
    this.output.data(users);
  }

  /**
   * 
   * @returns 
   */
  async set_member_privilege() {
    const uid = this.input.need(Attr.uid);
    const days = this.input.use(Attr.days, 0);
    const hours = this.input.use(Attr.hours, 0);
    const expiry = hours * 1 + days * 24;
    const privilege =
      this.input.use(Attr.privilege) ||
      this.input.use(Attr.permission) ||
      this.hub.get(Attr.settings).default_privilege ||
      1;
    await this.db.await_proc(
      "permission_grant",
      '*',
      uid,
      expiry,
      privilege,
      "system",
      `Granted by ${this.user.get(Attr.email)}`
    )
    let users = await this.db.await_proc(
      "hub_get_members_by_type",
      this.uid,
      "not_owner",
      1
    );
    this.output.list(users);
  }

  /**
   * 
   */
  change_owner() {
    const new_owner = this.input.need(Attr.id);
    this.db.call_proc("change_owner", new_owner, this.output.data);
  }

  /**
   * 
   */
  lookup_hubers() {
    const name = this.input.use(Attr.name, "");
    const page = this.input.use(Attr.page, 1);
    const exclude = this.input.use(Attr.exclude);
    this.db.call_proc(
      "lookup_hubers",
      name,
      page,
      function (data) {
        data = toArray(data);
        if (data && exclude != null) {
          data = data.filter((x) => x.id !== exclude);
        }
        this.output.data(data);
      }.bind(this)
    );
  }

  /**
   * 
   * @returns 
   */
  add_font_link() {
    const name = this.input.need(Attr.name);
    const variant = this.input.need(Attr.variant);
    const url = this.input.need(Attr.url);
    return this.db.call_proc(
      "hub_add_font_link",
      name,
      variant,
      url,
      this.output.data
    );
  }

  /**
   * 
   */
  get_pr_node_attr() {
    const nid = this.input.need(Attr.nid);
    this.db.call_proc("get_pr_node_attr", nid, this.output.data);
  }

  /**
   *
   */
  async poke() {
    const uid = this.input.need(Attr.uid);
    let service = "user.poke";
    let data = {
      uid,
      name: this.hub.get(Attr.name) || "",
      sender: this.user.get(Attr.firstname),
      hub_id: this.hub.get(Attr.id),
      nid: this.input.need(Attr.nid),
      kind: this.input.need(Attr.kind),
    };
    let sockets = await this.yp.await_proc("user_sockets", uid);
    await RedisStore.sendData(this.payload(data, { service }), sockets);
    //this.pushLiveUpdate(content);
    this.output.data({ sender: this.uid, recipient: uid });
  }

  /**
   * 
   * @returns 
   */
  set_node_permission() {
    let cnt_valid;
    const nid = this.input.need(Attr.nid);
    const email = this.input.need(Attr.email);
    const permission = this.input.use(Attr.permission, 1);
    message = this.input.use(Attr.message, "");
    const days = this.input.use(Attr.days, 0);
    const hours = this.input.use(Attr.hours, 0);
    const expiry = hours * 1 + days * 24;

    let invalid_email = 0;
    if (email == null || !email.isEmail()) {
      invalid_email = 1;
    }

    let uid = "";
    this.yp.call_proc(
      "drumate_exists",
      email,
      function (row) {
        if (!isEmpty(row)) {
          uid = row.id;
        }
        return cnt_valid();
      }.bind(this)
    );

    let node = "";
    this.db.call_proc(
      "mfs_access_node",
      this.uid,
      nid,
      function (row) {
        if (!isEmpty(row)) {
          node = row.nid;
        }
        return cnt_valid();
      }.bind(this)
    );

    const fn_valid = () => {
      if (invalid_email == 1) {
        return this.exception.user(INVALID_EMAIL_FORMAT);
      } else if (uid === "") {
        return this.exception.user(EMAIL_NOT_FOUND);
      } else if (node === "") {
        return this.exception.user(ID_NOT_FOUND);
      } else {
        this.db.call_proc(
          "permission_grant",
          node,
          uid,
          expiry,
          permission,
          "system",
          message,
          this.output.data
        );
      }
    };

    return (cnt_valid = _.after(2, fn_valid));
  }
}

module.exports = __private_hub;
