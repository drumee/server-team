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
  utils, RedisStore, Cache, Constants, Attr, Privilege, sysEnv, server_location, Messenger
} = require("@drumee/server-essentials");
const {
  INTERNAL_ERROR,
  PERMISSION_DENIED,
  INVALID_EMAIL_FORMAT,
  EMAIL_NOT_FOUND,
  ID_NOT_FOUND,
} = Constants;
const { resolve } = require("path");

/**
 * Configured envelope sender (email.json -> auth.user), resolved once. Used to
 * build a "Drumee" <addr> display-name From for butler invite emails, matching
 * the contact-add emails. The address is read at runtime (it differs per
 * deployment) rather than hardcoded.
 */
let _butlerSender;
function butlerSender() {
  if (_butlerSender !== undefined) return _butlerSender;
  try {
    const { readFileSync } = require("fs");
    const f = resolve(sysEnv().credential_dir, "email.json");
    _butlerSender = (JSON.parse(readFileSync(f, "utf8")).auth || {}).user || null;
  } catch (e) {
    _butlerSender = null;
  }
  return _butlerSender;
}
const { MfsTools } = require("@drumee/server-core");
const { remove_dir } = MfsTools;
const { toArray } = utils;
const { stringify } = JSON;
const { writeAudit } = require("./_audit");

// Workspace areas that count as EXTERNAL (shared outside the member circle).
// Everything else in the yp.entity.area enum — private, public, personal,
// restricted, limited, dmz-public, dmz-private, pool, pool/dmz, … — is INTERNAL.
//
// This is the single source of truth. The same expression used to be written out
// four times (_publicSharePermission, invite's workspace_restricted,
// _workspacePreviewItems' per-row flag, and the frontend's own isSharedArea),
// and they drifted: see the note on isExternalArea below.
const EXTERNAL_AREAS = ["share", "dmz"];

// The single invite email. Every invitee gets this one, with or without a Drumee
// account; only the body copy varies (internal vs external workspace).
// Replaces the former hub-invite-added / hub-invite-link / hub-invite-signup trio.
const WORKSPACE_INVITE_TPL = "workspace-invite-member";

/**
 * True when a workspace area is shared outside the member circle.
 *
 * The app labels area `private` as "Internal" and area `share` as "External"
 * (ui-team window/skeleton/toolkit AREA_LABELS), and this predicate follows that
 * split — it is what decides the invite email's body copy and whether the
 * workspace preview is redacted.
 *
 * KNOWN GAP, deliberately preserved here: `public` is NOT in EXTERNAL_AREAS, so an
 * open/public workspace is classified internal and its preview is redacted. The
 * frontend's dmz/sharebox/area.js treats `public` as shared and notes that prod
 * returns `area='public'` for open share links. Adding it here would change what
 * invite emails expose, so it is left as a separate decision rather than folded
 * into this refactor.
 *
 * @param {string} [area] a yp.entity.area value
 * @returns {boolean} true = external/shared, false = internal
 */
function isExternalArea(area) {
  return EXTERNAL_AREAS.includes(area);
}

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
    this.invite = this.invite.bind(this);
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
   * hub_get_members_by_type is a hub-only proc. When a hub-scoped endpoint is
   * reached with a personal/drumate entity as hub_id (e.g. a P2P/personal
   * context whose hub_id is a personal entity_id), the resolved DB may lack the
   * proc (ER_SP_DOES_NOT_EXIST), which tears down the request's DB connection.
   * A personal space has no workspace members, so return an empty set. Real
   * hubs (area private/org/share/dmz/…) are never 'personal' and are unaffected.
   */
  async _members_by_type(type, page) {
    if (this.hub.get(Attr.area) === "personal") return [];
    return await this.db.await_proc(
      "hub_get_members_by_type",
      this.uid,
      type,
      page
    );
  }

  /**
   *
   */
  async get_members_by_type() {
    const type = this.input.need(Attr.type);
    const page = this.input.use(Attr.page, 1);
    let members = await this._members_by_type(type, page);
    members = await this._hydrateMemberProfileNames(members, { type, page });
    this.output.list(members);
  }

  _cleanMemberName(value) {
    return `${value || ""}`.trim();
  }

  _memberDisplayName(member = {}) {
    const email = this._cleanMemberName(member.email);
    const fullname = this._cleanMemberName(member.fullname);
    if (fullname && fullname !== email) return fullname;

    const name = [member.firstname, member.lastname]
      .map((name) => this._cleanMemberName(name))
      .filter(Boolean)
      .join(" ");
    if (name) return name;

    const surname = this._cleanMemberName(member.surname);
    if (surname && surname !== email) return surname;

    return "";
  }

  _mergeLiveProfileName(member = {}, profile = {}) {
    const profileName = this._memberDisplayName(profile);
    if (!profileName || this._memberDisplayName(member)) return member;

    const firstname = this._cleanMemberName(profile.firstname);
    const lastname = this._cleanMemberName(profile.lastname);

    return {
      ...member,
      firstname: firstname || member.firstname,
      lastname: lastname || member.lastname,
      fullname: profileName,
      surname: profileName,
    };
  }

  async _hydrateMemberProfileNames(members, context = {}) {
    const rows = toArray(members);
    const ids = rows
      .filter((member) => !this._memberDisplayName(member))
      .map((member) => this._cleanMemberName(member.id))
      .filter(Boolean);

    if (!ids.length) return rows;

    const profileEntries = await Promise.all(
      [...new Set(ids)].map(async (id) => {
        try {
          const profile = await this.yp.await_proc("get_user", id);
          return [id, toArray(profile)[0] || {}];
        } catch (e) {
          this.syslog(
            "get_members_by_type live profile lookup failed",
            stringify({
              uid: this.uid,
              member_id: id,
              error: e && e.message,
            })
          );
          return [id, {}];
        }
      })
    );
    const profiles = new Map(profileEntries);
    const resolved = profileEntries.filter(([, profile]) =>
      this._memberDisplayName(profile)
    ).length;
    this.syslog(
      "get_members_by_type hydrated missing display names",
      stringify({
        uid: this.uid,
        type: context.type,
        page: context.page,
        total: rows.length,
        missing_display: ids.length,
        resolved,
      })
    );

    return rows.map((member) =>
      this._mergeLiveProfileName(
        member,
        profiles.get(this._cleanMemberName(member.id))
      )
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
   * Recipient-facing share link for the Manage-access panel ONLY — the clean
   * secure_share.js format (no keysel). The `?keysel=<hub_id>` prefix that
   * `_getShareLink` adds is consumed by the socket/session layer as a session-key
   * selector, so a recipient (who has no session for that keysel) lands in an
   * offline guest loop. The share resolves by token and the FE reads hub_id from
   * the dmz.login response, so keysel isn't needed. Kept separate so invite-email /
   * notify / copy_link links (still on `_getShareLink`) are unchanged.
   */
  _getPanelShareLink(token) {
    const link = `${this.input.homepath(this.hub.get(Attr.hostname))}#/dmz/share/`;
    if (token) return link + token;
    return link;
  }

  /**
   * Anonymous guest landing page for an INTERNAL workspace — the signin plugin's
   * signin_guest widget (Figma 1602:76946 "Guest Landing Page (Viral) Restricted"):
   * the workspace shown as redacted placeholders behind a "Content Restricted"
   * card, with Login / Join Workspace CTAs.
   *
   * Used instead of the #/dmz/share/<token> view because an internal workspace has
   * nothing a guest may browse — the share view would render an empty or view-only
   * folder. An EXTERNAL workspace keeps the share link, which is the page in Figma
   * 1602:77081 ("Link shared") and is already implemented by ui-team's dmz_sharebox.
   *
   * `name` rides along so the landing page's header shows the real workspace name
   * instead of its generic localized fallback; the page itself stays API-free.
   *
   * @param {string} hubname workspace display name
   * @returns {string} absolute URL
   */
  _guestLandingLink(hubname) {
    const base = this.input.homepath(this.hub.get(Attr.hostname));
    const q = `view=guest&name=${encodeURIComponent(hubname || "")}`;
    return `${base}#/welcome/signin?${q}`;
  }

  /**
   * Anonymous/guest permission for this hub's public share, derived from the
   * workspace area (see isExternalArea):
   *   - internal workspace -> Privilege.VIEW     (browse/read only)
   *   - external workspace -> Privilege.DOWNLOAD (browse + download)
   * This is the single source of truth for the permission granted to anyone
   * opening a public hub link (invite emails, copy_link, external-room share).
   */
  _publicSharePermission() {
    return isExternalArea(this.hub.get(Attr.area))
      ? Privilege.DOWNLOAD
      : Privilege.VIEW;
  }

  /**
   * Return the hub's anonymous public share link (#/dmz/share/<token>), creating
   * the external room on first use. Invite emails point here so recipients can
   * open the workspace with no login (the dmz module + dmz.login + show_node_by
   * are all anonymous-scoped), instead of the private #/desk/wm/hub/ route.
   *
   * On an existing room the area-based permission is re-applied via
   * dmz_update_permission_next so the share token is preserved (not regenerated)
   * for previously-sent links.
   */
  async _ensurePublicShareLink() {
    const nid = this.home_id;
    const hub_id = this.hub.get(Attr.id);
    let rows = await this.db.await_proc("dmz_settings") || [];
    let res = rows.shift();
    if (isEmpty(res)) {
      await this._update_external_room();
      rows = await this.db.await_proc("dmz_settings") || [];
      res = rows.shift();
    } else {
      await this.yp.await_proc("dmz_update_permission_next", hub_id, nid, this._publicSharePermission());
    }
    return this._getShareLink(res && res.link);
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
    const old_name = this.hub.get(Attr.name) || this.hub.get('hubname');
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

    await writeAudit(this, {
      db: this.hub.get(Attr.db_name),
      uid: this.uid,
      action: 'changed',
      category: 'title',
      entity_id: hub_id,
      log: `Workspace renamed from '${old_name || hub_id}' to '${name}'`,
    });

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
    const hub_db = this.hub.get(Attr.db_name);
    const hub_name = this.hub.get(Attr.name) || hub_id;
    const self = this;
    async function f() {
      let v;
      const changed = [];
      for (let k in vars) {
        v = vars[k];
        await self.yp.await_proc("hub_change_settings", hub_id, k, v);
        changed.push(k);
      }
      if (changed.length) {
        await writeAudit(self, {
          db: hub_db,
          uid: self.uid,
          action: 'change_policy',
          category: 'admin',
          notify_to: 'admin',
          entity_id: hub_id,
          log: `Workspace '${hub_name}' settings updated: ${changed.join(', ')}`,
        });
      }
      return null;
    }
    f()
      .then(function () {
        self.yp.call_proc("get_settings", hub_id, self.output.data);
      })
      .catch(self.fallback);
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
    let users = await this._members_by_type("all", 1);
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
      owner = await this._members_by_type(this.input.get(Attr.type), 1)
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
    // Delegated to drumate.notification_hub_invites so both this endpoint and
    // activity.list (also a caller of the same proc) return identical data,
    // including the per-(inviter, hub_id) dedupe.
    const db_name = this.user.get(Attr.db_name);
    const result = await this.yp.await_proc(`${db_name}.notification_hub_invites`);
    const rows = toArray(result);
    const out = rows.map((r) => {
      let meta = {};
      if (r.data) {
        try {
          meta = typeof r.data === "string" ? JSON.parse(r.data) : r.data;
        } catch (_) { meta = {}; }
      }
      const firstname = meta.from_firstname || r.inviter_firstname || "";
      const lastname = meta.from_lastname || r.inviter_lastname || "";
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
        target_uid: this.uid,
        event: "hub_invite_received",
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
            await writeAudit(this, {
              db: this.hub.get(Attr.db_name),
              uid: this.uid,
              action: 'invite_sent',
              category: 'member',
              notify_to: 'admin',
              entity_id: this.hub.get(Attr.id),
              log: `Invite sent to ${entity} for workspace '${hubname}'`,
            });
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
            await writeAudit(this, {
              db: this.hub.get(Attr.db_name),
              uid: this.uid,
              action: 'invite_sent',
              category: 'member',
              notify_to: 'admin',
              entity_id: this.hub.get(Attr.id),
              log: `Invite sent to ${entity} for workspace '${hubname}'`,
            });
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
      const r = await this._grantMembership(uid, privilege, expiry, message, mfs_home, hubname, username);
      if (r) rows.push(r);
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
        hub.db_name = hub.actual_db;
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
        "channel_post_message",
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
    users = await this._members_by_type("not_owner", 1);
    this.output.data(users);
  }

  /**
   * Cấp membership cho một drumate đã có tài khoản vào hub hiện tại.
   * Dùng chung bởi add_contributors và invite (nhánh B).
   * @param {string} uid         drumate id
   * @param {number} privilege   bitmask quyền
   * @param {number} expiry      số giờ hết hạn (0 = vĩnh viễn)
   * @param {string} message
   * @param {object} mfs_home    kết quả mfs_home (có chat_upload_id)
   * @param {string} hub_name    tên hub (để ghi log activity)
   * @param {string} from_fullname  tên người mời (để ghi log activity)
   * @returns {object|null} row từ add_member
   */
  async _grantMembership(uid, privilege, expiry, message, mfs_home, hub_name, from_fullname) {
    const r = await this.db.await_proc("add_member", uid, privilege, expiry);
    if (!r || !r.db_name) return null;
    await this.db.await_proc(
      "permission_grant", "*", uid, expiry, privilege, "system", message
    );
    await this.db.await_proc(
      "permission_grant", mfs_home.chat_upload_id, uid, 0, 4,
      "no_traversal", "chat upload permission"
    );
    await writeAudit(this, {
      db: this.hub.get(Attr.db_name),
      uid: this.uid,
      action: 'added',
      category: 'member',
      notify_to: 'admin',
      entity_id: uid,
      log: `Member added to workspace '${hub_name || this.hub.get(Attr.id)}'`,
    });
    try {
      await this.yp.await_proc(
        "contact_log_activity", this.uid, uid, "hub_invite_received",
        {
          hub_id: this.hub.get(Attr.id),
          hub_name: hub_name,
          message: message,
          from_fullname: from_fullname,
          privilege: privilege,
        }
      );
    } catch (err) {
      this.warn(
        "[hub] _grantMembership: log activity failed for", uid,
        err && err.message
      );
    }
    return r;
  }

  /**
   * Resolve the context needed to write into the inviter's personal address
   * book. The `contact` table lives in the inviter's drumate DB (`a_*`) while
   * this service runs against the hub DB (`f_*`), so every contact proc has to
   * be called cross-database — same pattern as add_contributors.
   * Returns null when the DB can't be resolved; callers treat that as "skip".
   */
  async _contactBookContext() {
    try {
      const db_name = await this.yp.await_func("get_db_name", this.uid);
      if (!db_name) {
        this.warn("[hub] _contactBookContext: no contact db for", this.uid);
        return null;
      }
      const { domain_id } = this.user.toJSON();
      return {
        domain_id,
        contactDb: {
          await_proc: (proc, ...args) =>
            this.yp.await_proc(`${db_name}.${proc}`, ...args)
        }
      };
    } catch (err) {
      this.warn("[hub] _contactBookContext failed", err && err.message);
      return null;
    }
  }

  /**
   * Derive a first/last name from an email local part, so a remembered contact
   * renders as a name rather than a bare address. Mirrors contact.invite.
   */
  _nameFromEmail(email) {
    const localPart = (String(email).split("@")[0] || "").trim();
    if (localPart.indexOf(".") !== -1) {
      const parts = localPart.split(".");
      return { firstname: parts[0], lastname: parts.slice(1).join(" ") };
    }
    return { firstname: localPart, lastname: null };
  }

  /**
   * Remember an invited email in the inviter's address book, so inviting the
   * same person into a second workspace can autocomplete them.
   *
   * Deliberately SILENT: writes a `memory` contact and nothing else. It does
   * NOT call contact.invite / the contact_invite proc, because both send the
   * invitee a second email (a personal contact request) on top of the
   * workspace invitation, and contact_invite also promotes the row to
   * 'sent'/'informed' — i.e. it would claim the inviter asked to be their
   * contact, which they didn't.
   *
   * Never throws: address-book bookkeeping must not fail a workspace invite.
   */
  async _rememberInvitee(email, drumate, ctx) {
    if (!ctx || !ctx.contactDb) return;
    if (!email || String(email).indexOf("@") === -1) return;
    // contact.entity / contact_email.email are varchar(255). Overflowing them
    // raises a truncation error, and the mariadb wrapper answers any SQL error
    // by ending the shared connection — so screen it out here rather than let
    // an absurd address take the request down.
    if (String(email).length > 255) {
      this.warn("[hub] _rememberInvitee: address too long, not remembered");
      return;
    }
    const { contactDb, domain_id } = ctx;
    try {
      // Same-domain colleagues are already returned by `my_contact`'s domain
      // UNION branch. Giving them a contact row too makes them appear twice in
      // every picker that queries with status='paper' (sharebox invitation,
      // schedule invitation). contact.invite refuses these with SAME_DOMAIN for
      // the same reason — keep the policies aligned.
      if (
        drumate && drumate.domain_id != null &&
        domain_id > 1 && domain_id === drumate.domain_id
      ) return;

      const entity = (drumate && drumate.id) ? drumate.id : email;

      // Look under BOTH keys before inserting. A contact remembered before the
      // invitee had an account is keyed by the raw email; once they sign up the
      // same person resolves to a uid, and inserting again would create a
      // second row for one human.
      //
      // We intentionally do NOT re-key the old row onto the uid:
      // my_contact_update_next deletes `yp.token WHERE email = <old entity>`
      // for the inviter, which would revoke that person's still-pending
      // hub-invite / signup link. Leaving the row as-is costs nothing — it
      // stays searchable through the generated `source` column.
      let existing = await contactDb.await_proc(
        "my_contact_exists", "entity", entity, "", ""
      );
      if (isEmpty(existing) && entity !== email) {
        existing = await contactDb.await_proc(
          "my_contact_exists", "entity", email, "", ""
        );
      }
      if (!isEmpty(existing)) return;

      const { firstname, lastname } = this._nameFromEmail(email);
      // `contact.source` is a generated column over metadata.$.source, and it
      // is the only field in contact_search_next / my_contact that matches on
      // the email itself — without it the row is unreachable by typing an
      // address. `is_auto` marks rows the user never created by hand.
      const metadata = { source: email, is_auto: 1, origin: "hub_invite" };
      const contact = await contactDb.await_proc(
        "my_contact_add_next",
        entity, null, firstname, lastname, "independant", null, null, metadata
      );
      if (isEmpty(contact) || !contact.id) {
        this.warn("[hub] _rememberInvitee: my_contact_add_next empty for", email);
        return;
      }

      // Required, not cosmetic: my_contact resolves the displayed address as
      // coalesce(du.email, de.email, ce.email), and both drumate joins are NULL
      // for an email-keyed contact. Without this row the suggestion renders
      // with an empty address and the invite popup rejects it.
      await contactDb.await_proc(
        "my_contact_mail_add",
        contact.id,
        stringify([{ email, category: "priv", is_default: "1" }])
      );
    } catch (err) {
      this.warn("[hub] _rememberInvitee failed for", email, err && err.message);
    }
  }

  /**
   * Mời người vào workspace.
   *
   * Every invitee gets the SAME email (WORKSPACE_INVITE_TPL) whether or not they
   * already have a Drumee account — the body differs only by workspace scope,
   * internal (private) vs external (shared), via isExternalArea. The CTA is the
   * anonymous public share link, which works with or without an account.
   *
   * Account status still drives the non-email work below, because that part is
   * functional rather than presentational: an existing drumate is granted
   * membership and notified over the websocket, while a newcomer gets an invite
   * token (+ a pending_invitation fallback) so they can join after signing up.
   *
   * Input: { hub_id, invitees:[email], privilege, message? }
   */
  async invite() {
    let invitees = toArray(this.input.need("invitees"));
    const privilege = this.input.use(Attr.privilege)
      || this.hub.get(Attr.settings).default_privilege;
    const lang = this.user.language() || this.input.app_language();
    const username = this.user.get("fullname");
    const hubId = this.hub.get(Attr.id);
    // mfs_home reads yp.hub.name directly (the actual display name);
    // this.hub.get(Attr.name/hubname) returns yp.hub.hubname (a technical id).
    const mfs_home = await this.db.await_proc("mfs_home");
    const hubname = (mfs_home && mfs_home.name)
      || this.hub.get(Attr.hubname)
      || this.hub.get(Attr.name)
      || hubId;
    const area = this.hub.get(Attr.area);
    // The ONE axis the email body varies on: internal (private) vs external
    // (shared) workspace. Also decides whether the workspace preview is redacted.
    const workspace_external = isExternalArea(area);
    // Narrower than workspace_external (excludes `dmz`) and used ONLY to gate the
    // pending_invitation fallback below, preserving the pre-existing behaviour.
    const isShareLink = (area === "share");
    const EXPIRY_DAYS = 7;
    const expiryTs = Math.floor(Date.now() / 1000) + EXPIRY_DAYS * 86400;
    const message = this.input.use(Attr.message)
      || Cache.message("_x_add_you_to_team", lang).format(username, hubname);
    // Top-3 workspace preview shared by all invite emails (same workspace for
    // every invitee in this call), fetched once. Each item carries a
    // `restricted` flag so the template dims internal rows and leaves external
    // ones clear.
    const preview_items = await this._workspacePreviewItems();
    // Latest 2 non-meeting messages for the "Recent Activity" preview; shown
    // (clear) for external workspaces, kept redacted for internal ones.
    const recent_messages = await this._recentMessages();
    // Anonymous public share link for the hub. Still resolved unconditionally —
    // it creates the external room on first use and re-applies the area-based guest
    // permission, both of which must happen whatever the email links to. Computed
    // once (one shared token per hub).
    const publicLink = await this._ensurePublicShareLink();
    // Where the email's CTA goes, per workspace scope:
    //   external -> the share view itself (Figma 1602:77081, ui-team dmz_sharebox)
    //   internal -> the guest landing gate (Figma 1602:76946, signin_guest)
    // Both open with no login; neither exposes content the scope doesn't allow.
    const ctaLink = workspace_external
      ? publicLink
      : this._guestLandingLink(hubname);
    // Address-book context resolved once for the whole call (see
    // _rememberInvitee). Null when the inviter has no drumate DB — the invite
    // still goes through, it just isn't remembered.
    const contactBook = await this._contactBookContext();
    // The popup fires one hub.invite per selected workspace with the same email
    // list, and a caller may repeat an address; remember each person once.
    const remembered = new Set();
    const toRemember = [];
    const results = [];

    for (const email of invitees) {
      try {
        let drumate = await this.yp.await_proc("drumate_exists", email);
        if (isArray(drumate)) drumate = drumate[0];
        const isDrumate = drumate && drumate.id;

        // --- Functional work, still keyed on account status (NOT the email) ---
        if (isDrumate) {
          // Existing account: grant membership now and push it over the socket, so
          // the workspace shows up in a live session without a reload.
          const r = await this._grantMembership(drumate.id, privilege, 0, message, mfs_home, hubname, username);
          if (r) {
            try {
              const hub = await this.yp.await_proc(
                `${r.db_name}.mfs_access_node`, drumate.id, hubId
              );
              if (hub) {
                hub.message = message;
                hub.ownpath = '/';
                hub.hub_id = hub.actual_hub_id;
                hub.db_name = hub.actual_db;
                const sockets = await this.yp.await_proc('user_sockets', drumate.id);
                await RedisStore.sendData(this.payload(hub, { service: "hub.invite_received" }), sockets);
                await RedisStore.sendData(this.payload(hub, { service: "hub.add_contributors" }), sockets);
              }
            } catch (err) {
              this.warn("[hub] invite: ws notify failed for", drumate.id, err && err.message);
            }
          }
        } else {
          // No account yet: mint an invite token so the address can be redeemed
          // after sign-up. `isShareLink` (area === "share" exactly) still gates the
          // pending_invitation fallback — unchanged on purpose, since which rows a
          // newcomer's invite writes is functional behaviour, not email copy.
          await this._addInviteToken(email, hubId, privilege, expiryTs);
          if (!isShareLink) {
            await this.yp.await_proc(
              "yp_add_pending_invitation", hubId, 0, privilege, email
            );
          }
          await writeAudit(this, {
            db: this.hub.get(Attr.db_name),
            uid: this.uid,
            action: 'invite_sent',
            category: 'member',
            notify_to: 'admin',
            entity_id: hubId,
            log: `Invite sent to ${email} for workspace '${hubname}'`,
          });
        }

        // --- One email for everyone, varying only by workspace scope ---
        await this._sendInviteEmail(
          WORKSPACE_INVITE_TPL,
          email,
          workspace_external
            ? `${username} shared ${hubname} with you`
            : `${username} added you to ${hubname}`,
          {
            inviter_name: username,
            workspace_name: hubname,
            link: ctaLink,
            workspace_external,
            preview_items,
            recent_messages,
          },
        );
        results.push({ email, status: "ok" });
        // Queue for address-book bookkeeping — only invitees whose branch
        // actually succeeded (a failure throws above and must leave no contact).
        // Deliberately deferred until every invite is done, see below.
        const key = String(email).trim().toLowerCase();
        if (!remembered.has(key)) {
          remembered.add(key);
          toRemember.push({ email, drumate });
        }
      } catch (err) {
        this.warn("[hub] invite failed for", email, err && err.message);
        results.push({ email, status: "failed", reason: err && err.message });
      }
    }

    // Bookkeeping runs LAST, never interleaved with invite work. Reason: the
    // mariadb wrapper reacts to an ordinary SQL error (e.g. an ER_DUP_ENTRY on
    // contact.entity from a concurrent invite) by rolling back and calling
    // end() on the shared `yp` connection — and it swallows the error instead
    // of rejecting, so a try/catch can't see it. Every later yp call in this
    // request would then quietly return {failed:1} while still being reported
    // as status:"ok". Draining the queue here bounds that worst case to "the
    // contact wasn't remembered" instead of "the remaining invites silently
    // did nothing".
    for (const { email, drumate } of toRemember) {
      await this._rememberInvitee(email, drumate, contactBook);
    }

    this.output.data({ results });
  }

  /**
   * Mint a hub_invite token for an address with no Drumee account yet, so the
   * invite can be redeemed after sign-up (accept_invite). Token only — the email
   * is sent once by invite(), the same one every invitee gets.
   */
  async _addInviteToken(email, hubId, privilege, expiryTs) {
    const { randomBytes } = require("crypto");
    const secret = randomBytes(24).toString("hex");
    const method = `hub_invite:${hubId}`;
    const metadata = JSON.stringify({ hub_id: hubId, permission: privilege });
    await this.yp.await_proc(
      "token_hub_invite_add", email, "", secret, method, this.uid, metadata, expiryTs
    );
  }

  /**
   * Redeem a hub_invite token and join the workspace.
   * Called by the FE after sign-in when the welcome URL carries ?invite=SECRET.
   * Scope is "anonymous" because the user may have just signed up (session is
   * fresh); this.uid is checked manually to enforce authentication.
   */
  async accept_invite() {
    if (!this.uid) {
      return this.output.data({ status: 'not_authenticated' });
    }
    const secret = this.input.need('token');
    const tokenRow = await this.yp.await_proc('token_get_next', secret);
    if (!tokenRow || !tokenRow.secret) {
      return this.output.data({ status: 'invalid' });
    }
    const method = tokenRow.method || '';
    if (!method.startsWith('hub_invite:')) {
      return this.output.data({ status: 'invalid' });
    }
    const hub_id = method.slice('hub_invite:'.length);
    const now = Math.floor(Date.now() / 1000);
    if (tokenRow.expiry > 0 && now > tokenRow.expiry) {
      return this.output.data({ status: 'expired', hub_id });
    }
    if (tokenRow.status !== 'active') {
      // Already redeemed — user is already a member; return hub_id for navigation.
      return this.output.data({ status: 'already_used', hub_id });
    }
    const db_name = await this.yp.await_func('get_db_name', hub_id);
    if (!db_name) {
      return this.output.data({ status: 'hub_not_found' });
    }
    let meta = {};
    try {
      meta = typeof tokenRow.metadata === 'string'
        ? JSON.parse(tokenRow.metadata)
        : (tokenRow.metadata || {});
    } catch (e) { }
    const permission = meta.permission || 7;
    await this.yp.await_proc(`${db_name}.add_member`, this.uid, permission, 0);
    await this.yp.await_proc(
      `${db_name}.permission_grant`,
      '*', this.uid, 0, permission, 'system', 'Redeemed hub invite token'
    );
    await this.yp.await_proc('token_hub_invite_set_status', secret, 'accepted', null);
    await writeAudit(this, {
      db: db_name,
      uid: this.uid,
      action: 'invite_accepted',
      category: 'member',
      notify_to: 'admin',
      entity_id: hub_id,
      log: `Invite accepted — ${this.user.get(Attr.email) || this.uid} joined the workspace`,
    });
    this.output.data({ hub_id });
  }

  /**
   * Top-3 workspace items (folders first, then files) for the invite email
   * previews. Listing is read from the inviter's perspective (this.uid) since a
   * not-yet-existing invitee has no permission on the workspace yet. Each item
   * is { name, date, icon, restricted }; `restricted` is false only for share/
   * dmz nodes (the "shared" mode in the app) — templates dim restricted rows and
   * leave shared rows clear. Returns [] on any error so the email renders no
   * preview rows.
   */
  async _workspacePreviewItems() {
    const ICON_BASE = "https://content.app.drumee.com/icons";
    try {
      const params = JSON.stringify({ sort_by: "rank", order: "asc", page: 1, type: "all" });
      const rows = await this.db.await_proc("mfs_show_node_by", "0", this.uid, params);
      const list = isArray(rows) ? rows : (rows ? [rows] : []);
      const isFolder = (it) => it.ftype === "folder" || it.ftype === "hub" || it.filetype === "folder";
      const top = [...list.filter(isFolder), ...list.filter((it) => !isFolder(it))].slice(0, 3);
      return top.map((it) => {
        const base = it.ext ? `${it.filename}.${it.ext}` : it.filename;
        const name = base.length > 32 ? `${base.slice(0, 31)}…` : base;
        const ftype = it.ftype || it.filetype;
        const ts = Number(it.mtime || it.ctime || 0) * 1000;
        const date = ts
          ? new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" })
          : "";
        // Per-row scope, same rule as the workspace itself (isExternalArea):
        // internal rows are dimmed/redacted, external ones render clear.
        const restricted = !isExternalArea(it.area);
        // Icon by type: folders reflect shared/restricted state; files and
        // images use their own glyphs.
        let icon;
        if (ftype === "folder" || ftype === "hub") icon = restricted ? "restricted.png" : "shared.png";
        else if (ftype === "image") icon = "image.png";
        else icon = "files.png";
        return { name, date, icon: `${ICON_BASE}/${icon}`, restricted };
      });
    } catch (err) {
      this.warn("[hub] invite: preview fetch failed", err && err.message);
      return [];
    }
  }

  /**
   * Latest 2 real chat messages (newest first) for the invite email "Recent
   * Activity" preview. Excludes [[MEETING:...]] system messages. Uses a plain
   * SELECT — NOT channel_list_messages, which has a read-marking side effect
   * (writes read_channel / _seen_) we must not trigger from an invite. Each
   * item is { text, initials }. Returns [] on any error.
   */
  async _recentMessages() {
    try {
      const sql =
        "SELECT c.message AS message, " +
        "COALESCE(CONCAT(d.firstname, ' ', d.lastname), du.name, '') AS fullname " +
        "FROM channel c " +
        "LEFT JOIN yp.drumate d ON c.author_id = d.id " +
        "LEFT JOIN yp.dmz_user du ON c.author_id = du.id " +
        "WHERE c.status = 'active' AND c.message NOT LIKE '[[MEETING:%' " +
        "ORDER BY c.sys_id DESC LIMIT 2";
      const rows = await this.db.await_query(sql);
      const list = isArray(rows) ? rows : (rows ? [rows] : []);
      return list.map((m) => {
        const text = String(m.message || "").replace(/\s+/g, " ").trim();
        const name = String(m.fullname || "").trim();
        const parts = name.split(/\s+/).filter(Boolean);
        const initials = parts.length >= 2
          ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
          : (name.slice(0, 2) || "?").toUpperCase();
        return { text: text.length > 80 ? `${text.slice(0, 79)}…` : text, initials };
      });
    } catch (err) {
      this.warn("[hub] invite: recent messages fetch failed", err && err.message);
      return [];
    }
  }

  /**
   * Gửi 1 email mời theo template app-local service/private/templates/butler/<tpl>.html
   */
  async _sendInviteEmail(tpl, recipient, subject, data) {
    const tplPath = resolve(__dirname, "templates", "butler", `${tpl}.html`);
    const msg = new Messenger({ subject, recipient, handler: this.exception.email });
    const html = msg.renderFrom(tplPath, data);
    // Display-name From ("Drumee" <butler@...>) so the inbox shows "Drumee",
    // matching the contact-add emails. Falls back to the default sender when
    // no address is configured.
    const sender = butlerSender();
    const from = sender ? `"Drumee" <${sender}>` : undefined;
    // Messenger.send() always resolves { recipient, error } — it never rejects
    // (errors are routed to the handler). Inspect `error` so an SMTP-time
    // rejection (e.g. unknown mailbox -> 550) surfaces as a failed invitee
    // instead of a silent status:"ok".
    const result = msg.dispatch(from ? { html, from } : { html });
    if (result && result.error) {
      throw new Error(`Email delivery to ${recipient} failed: ${result.error}`);
    }
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
              await writeAudit(this, {
                db: hub_db,
                uid: this.uid,
                action: 'invite_sent',
                category: 'member',
                notify_to: 'admin',
                entity_id: hub_id,
                log: `Invite sent to ${entity} for workspace '${hubname}'`,
              });
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
              await writeAudit(this, {
                db: hub_db,
                uid: this.uid,
                action: 'invite_sent',
                category: 'member',
                notify_to: 'admin',
                entity_id: hub_id,
                log: `Invite sent to ${entity} for workspace '${hubname}'`,
              });

              // Only send email if entity looks like an email address
              const isEmail = typeof entity === 'string' && entity.indexOf('@') !== -1;
              if (isEmail) {
                try {
                  const ContactPrivate = require('./contact');
                  const contactSvc = new ContactPrivate({
                    session: this.session,
                    permission: this.permission || { scope: 'hub' },
                  });
                  contactSvc.db = {
                    await_proc: (proc, ...args) =>
                      this.yp.await_proc(`${contact_db}.${proc}`, ...args),
                    end: () => Promise.resolve(),
                  };
                  const origEmail = this.input.use(Attr.email);
                  const origMessage = this.input.use(Attr.message);
                  this.input.set(Attr.email, entity);
                  this.input.set(Attr.message, msg);
                  this.input.set('_contact_db_name', contact_db);
                  await contactSvc.invite();
                  if (origEmail !== undefined) this.input.set(Attr.email, origEmail);
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
        await writeAudit(this, {
          db: hub_db,
          uid: this.uid,
          action: 'added',
          category: 'member',
          notify_to: 'admin',
          entity_id: uid,
          log: `Member added to workspace '${hubname}'`,
        });

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
        const hub = await this.yp.await_proc(
          `${recipient.db_name}.mfs_access_node`,
          recipient.id,
          hub_id
        );
        hub.message = msg;
        hub.ownpath = '/';
        hub.hub_id = hub.actual_hub_id;
        hub.db_name = hub.actual_db;
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
    let outout = { ...old_node, uid: this.uid, nid: hub_id, id: hub_id, hub_id }

    // Write to deleter's drumate — hub DB is about to be dropped.
    const hub_name = data.name || data.filename || hub_id;
    await writeAudit(this, {
      db: this.user.get(Attr.db_name),
      uid: this.uid,
      action: 'deleted',
      category: 'admin',
      notify_to: 'admin',
      entity_id: hub_id,
      log: `Workspace '${hub_name}' deleted`,
    });

    let sockets = await this.yp.await_proc("entity_sockets", hub_id);
    await RedisStore.sendData(this.payload(outout), sockets);

    await this.db.await_proc(`remove_all_members`, 0);
    // Respond BEFORE entity_delete: that proc drops the hub's whole database,
    // which scales with workspace size (seconds+ for big hubs) and used to
    // hold the HTTP response — the deleting client sat frozen for all of it.
    // Every client was already notified via the WS broadcast above, and the
    // directory removal is a detached `rm -rf` child process either way.
    // Deferring the drop only risks a brief flicker on a hard refresh while
    // it completes; failures are logged for ops.
    this.output.data(outout);
    this.yp.await_proc("entity_delete", hub_id)
      .then((entity) => {
        if (entity && entity.home_dir) remove_dir(entity.home_dir, 1);
      })
      .catch((e) => {
        this.warn(`delete_hub: deferred entity_delete failed for ${hub_id}`, (e && e.message) || e);
      });
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
    // Manage-access panel link → clean format (no keysel). Invite-email / notify /
    // copy_link paths keep _getShareLink unchanged.
    res.link = this._getPanelShareLink(res.link);
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
    // Guest permission is area-driven (restricted -> view, shared -> download),
    // not a manual picker — consistent with invite links and copy_link.
    const permission = this._publicSharePermission();
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

    const permission = this._publicSharePermission();
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
    const permission = this._publicSharePermission();
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

    const permission = this._publicSharePermission();
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
      pw,
      validityMode = "infinity",
      days = 0,
      hours = 0
    } = opt;

    // Anonymous/guest permission always follows workspace area (restricted ->
    // view, shared -> download), consistent with invite links.
    const permission = this._publicSharePermission();

    let expiry = hours * 1 + days * 24;

    if (validityMode == "infinity") expiry = 0;

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
    const pw = this.input.get(Attr.password);
    const validityMode = this.input.get("validity_mode") || "infinity";
    const days = this.input.get(Attr.days) || 0;
    const hours = this.input.get(Attr.hours) || 0;
    await this._update_external_room({
      emails, pw, validityMode, days, hours
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
    const hub_db = this.hub.get(Attr.db_name);
    // A workspace's display name lives in its profile (same source as
    // conference.hubDisplayName). `Attr.name` is often unset, and falling back
    // to the id put a raw id in front of the user — the removal notice named
    // the workspace "5f2c…" instead of "Design team". Send nothing rather than
    // an id; the desk phrases the notice around a missing name.
    const hub_profile = this.hub.get(Attr.profile) || {};
    const hub_display = hub_profile.name || this.hub.get(Attr.name) || '';
    const hub_name = String(hub_display) === String(hub_id) ? '' : hub_display;
    for (let uid of members) {
      let { db_name } = await this.yp.await_proc("get_entity", uid);
      await this.yp.await_proc(`${db_name}.leave_hub`, hub_id);
      let node = this.granted_node();
      node.nid = node.id = hub_id;
      let sockets = await this.yp.await_proc("user_sockets", uid);
      let payload = this.payload(node, { service });
      await RedisStore.sendData(payload, sockets);
      // media.remove above only tidies the removed member's own sidebar. Any
      // window they still have open on this workspace stays live, and their
      // next action there fails the ACL with a bare 403 that the UI reports as
      // a network error. This dedicated push lets the desk lock the workspace
      // out at once and name who removed them.
      await RedisStore.sendData(
        this.payload(
          { hub_id, name: hub_name, removed_by: this._actor_name() },
          { service: "hub.member_removed" }
        ),
        sockets
      );
      await writeAudit(this, {
        db: hub_db,
        uid: this.uid,
        action: 'removed',
        category: 'member',
        notify_to: 'admin',
        entity_id: uid,
        log: `Member removed from workspace '${hub_name}'`,
      });
    }
    if (members.length) {
      // Losing membership also drops them off this workspace's tasks. Runs after
      // the per-member work — including the audit rows — because any SQL error
      // ends this request's DB connection (mariadb _handleError), and losing the
      // audit trail would be a worse trade than a lingering assignee row.
      await this._unassign_tasks(members);
      // Remaining members may have a task board open showing the ex-member as an
      // assignee. task.update_assignee is what the task panel already listens to
      // for a live reload, so reuse it rather than inventing a new signal.
      await this._broadcast_task_unassign(hub_id);
    }
    users = await this._members_by_type("not_owner", 1);
    this.output.list(users);
  }

  /**
   * Display name of the member performing the current request, for messages
   * shown to somebody else ("removed by ..."). Falls back through the same
   * chain the member list uses so it is never empty.
   *
   * @returns {string}
   */
  _actor_name() {
    const u = this.user;
    if (!u) return "";
    const fullname = `${u.get("fullname") || ""}`.trim();
    if (fullname) return fullname;
    const name = [u.get(Attr.firstname), u.get(Attr.lastname)]
      .filter((p) => `${p || ""}`.trim())
      .join(" ")
      .trim();
    return name || `${u.get(Attr.email) || ""}`.trim();
  }

  /**
   * Clear users' task assignments in THIS workspace.
   *
   * The task panel resolves an assignee uid against the workspace member list
   * (hub.get_members_by_type). Once the user is no longer a member the uid
   * resolves to nothing, and the assignee chip fell back to rendering the raw
   * uid — a name-shaped string of random characters. Dropping the rows leaves
   * those tasks plainly unassigned instead.
   *
   * The table is probed first rather than letting a DELETE fail: workspaces
   * created before the task tables shipped have no task_assignee, and this DB
   * layer answers ER_NO_SUCH_TABLE by rolling back and ENDING the connection
   * (mariadb _handleError default branch) — which would take the rest of the
   * request down with it. information_schema is always readable.
   *
   * @param {Array} uids members being removed
   */
  async _unassign_tasks(uids) {
    const list = toArray(uids).filter(Boolean);
    if (!list.length) return;
    try {
      const probe = await this.db.await_run(
        "SELECT COUNT(*) AS n FROM information_schema.tables" +
        " WHERE table_schema = DATABASE() AND table_name = 'task_assignee'"
      );
      const row = toArray(probe)[0] || {};
      if (!Number(row.n)) return;
      const holes = list.map(() => "?").join(",");
      await this.db.await_run(
        `DELETE FROM task_assignee WHERE uid IN (${holes})`,
        list
      );
    } catch (e) {
      this.warn(
        "[hub.delete_contributor] failed to unassign tasks",
        list,
        e && e.message
      );
    }
  }

  /**
   * Tell the workspace's remaining members that assignees changed, so open
   * task boards reload instead of keeping the ex-member's avatar on the cards.
   * The removed member is already out of entity_sockets by this point, so this
   * never reaches them.
   *
   * @param {string} hub_id
   */
  async _broadcast_task_unassign(hub_id) {
    if (!hub_id) return;
    let dest = toArray(await this.yp.await_proc("entity_sockets", hub_id));
    if (isEmpty(dest)) return;
    await RedisStore.sendData(
      this.payload({ hub_id }, { service: "task.update_assignee" }),
      dest
    );
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
    await writeAudit(this, {
      db: this.hub.get(Attr.db_name),
      uid: this.uid,
      action: 'grant_access',
      category: 'permission',
      notify_to: 'admin',
      entity_id: uid,
      log: `Member privilege set to ${privilege} in workspace '${this.hub.get(Attr.name) || this.hub.get(Attr.id)}'`,
    });
    let users = await this._members_by_type("not_owner", 1);
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
