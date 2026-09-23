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
const { notifyMemberJoined, notifyMembersChanged } = require("../lib/notify-member-joined");
const { butlerFrom } = require("../lib/mail-sender");
const { mailFailure } = require("../lib/mail-result");
const { resolveHubInviteName } = require("../lib/hub-invite-name");
const { resolveHubDisplayName } = require("../lib/hub-display-name");
const {
  CAN_CHAT, CHAT_UPLOAD_GRANT, privilegeAllows
} = require("../lib/member-capability");
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
// Invite emails go out this many at a time. Each message opens its own SMTP
// session to the relay, and the session costs ~4 s before a byte of mail is
// sent (connect + STARTTLS 1.8 s, AUTH 2.3 s - measured 2026-09-22), against
// ~1 s for the message itself. Sessions opened together pay that once, in
// parallel: 5 at a time measured 5.8 s per batch, the same as one message,
// so a 30-address invite still took 35 s. 25 keeps two concurrent hub.invite
// calls (the popup fires one per selected workspace) under Postfix's default
// 50 connections per client IP.
const INVITE_MAIL_BATCH = 25;

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
/**
 * The invite endpoints accept an "entity" that may be an email address OR a
 * bare user id. invite_track is keyed by (hub_id, email) — the same key
 * yp.pending_invitation uses — so anything that is not an address must resolve
 * to null rather than be stored as one: a row keyed by a uid could never be
 * matched by an acceptance, and would sit in `invites_sent` as a permanently
 * pending invitation that nobody can redeem.
 *
 * @param {*} v
 * @returns {string|null}
 */
function asEmail(v) {
  const s = `${v == null ? "" : v}`.trim();
  return s.indexOf("@") !== -1 ? s : null;
}

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
   * The invite CTA: the sign-in form, with the invited workspace named on the URL.
   *
   *   <endpoint>/#/welcome/signin?hub_id=<hub_id>&name=<workspace>
   *
   * The frontend does the rest. welcome/index.js reads both params and arms them
   * (libs/hub-deep-link); once the recipient is authenticated — however they got
   * there, by sign-in, sign-up, or an already-live session — the desk offers to
   * open the workspace ("Open Workspace" / "Cancel"), and confirming opens it
   * through the app's own #/desk/wm/open/ deep link.
   *
   * `name` is display copy for that prompt, nothing more: it names the workspace in
   * the message instead of the generic fallback. It is never trusted as an
   * identity — `hub_id` alone selects the workspace, and the services behind it
   * authorise the caller's own session.
   *
   * Replaces the former guest landing page (?view=guest&scope=…&token=…&hub=…),
   * which cost two extra clicks — one to leave the landing page, one on the desk's
   * "Open Workspace" prompt — to show a preview this email already contains. See
   * docs/superpowers/specs/2026-08-02-invite-cta-skip-guest-landing-design.md.
   * Links already sitting in inboxes still carry the old query and still work:
   * nothing on the guest path has been removed.
   *
   * `hub_id` grants nothing on its own — every service behind it still authorises
   * the caller's session, and the recipient is being invited to this workspace.
   *
   * @param {string|number} hub_id the workspace being invited to
   * @param {string} [hubname] workspace display name, for the prompt's copy
   * @returns {string} absolute URL
   */
  _inviteCtaLink(hub_id, hubname) {
    const base = `${this._endpointBase()}/#/welcome/signin`;
    if (!hub_id) return base;
    const q = [`hub_id=${encodeURIComponent(hub_id)}`];
    if (hubname) q.push(`name=${encodeURIComponent(hubname)}`);
    return `${base}?${q.join("&")}`;
  }

  /**
   * The Accept and Decline links in an invitation email.
   *
   * Built on the SAME route the CTA uses, and carrying the same `?invite=`
   * parameter the front end has understood since the token flow shipped
   * (modules/welcome, _redeemInviteThenEnter) — so an Accept link is the
   * existing, exercised redemption path with nothing new behind it. What is new
   * is `invite_action`, which tells the page which of the two answers was
   * pressed.
   *
   * 🚨 ACCEPT AND DECLINE HAVE DIFFERENT AUTHENTICATION NEEDS, and the front
   * end is where that is enforced, not here:
   *
   *   accept   requires a session. Membership is granted to an ACCOUNT, so
   *            there has to be one; the welcome route signs them in (or up)
   *            first and redeems afterwards, which is what it already did.
   *   decline  requires none. Holding the secret is the authorisation, and
   *            hub.decline_invite is scoped accordingly. Demanding a sign-in to
   *            say no would mean the one answer that needs no account could
   *            only be given by creating one.
   *
   * `hub_id` and `name` ride along for the same reason the CTA carries them —
   * the desk can name and open the workspace once the answer is in — and grant
   * nothing on their own.
   *
   * @param {string} token   the invitation's secret
   * @param {string} hub_id  the workspace being invited to
   * @param {string} [hubname] workspace display name, for the page's copy
   * @param {string} action  "accept" | "decline"
   * @returns {string} absolute URL
   */
  _inviteAnswerLink(token, hub_id, hubname, action) {
    const base = `${this._endpointBase()}/#/welcome/signin`;
    const q = [
      `invite=${encodeURIComponent(token)}`,
      `invite_action=${encodeURIComponent(action)}`,
    ];
    if (hub_id) q.push(`hub_id=${encodeURIComponent(hub_id)}`);
    if (hubname) q.push(`name=${encodeURIComponent(hubname)}`);
    return `${base}?${q.join("&")}`;
  }

  /**
   * Canonical app base for links mailed to people who are NOT yet in a workspace:
   * `https://<main_domain><endpoint_path>`, the same shape analytics-server's
   * _endpointBase() uses for the reward campaign's desk link.
   *
   * Deliberately NOT input.homepath(hub.hostname), which the share links use. That
   * builds a per-hub host from the request's own path, which is right for opening a
   * specific workspace but wrong for a generic app route: the guest landing page is
   * served by the app at its endpoint, not per workspace. `endpoint_path` already
   * carries the endpoint name on a non-main install (sysEnv joins it onto
   * app_routing_mark), so this stays correct on multi-endpoint deployments.
   *
   * @returns {string} e.g. "https://drumee.com/-"
   */
  _endpointBase() {
    const { main_domain, endpoint_path } = sysEnv();
    return `https://${main_domain}${endpoint_path || "/-"}`;
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
   * Ensure the hub HAS an anonymous public share room, and return its token.
   *
   * On an existing room the area-based permission is re-applied via
   * dmz_update_permission_next so the share token is preserved (not regenerated)
   * for previously-sent links.
   *
   * invite() calls this for the SIDE EFFECTS alone and drops the token: the CTA is
   * now the sign-in form (_inviteCtaLink), not a share link. The room still has to
   * exist and still has to carry the right guest permission, because copy_link and
   * the share panel both hand that same room out.
   *
   * @returns {string} the share token, or "" when the room has none
   */
  async _ensurePublicShareToken() {
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
    return (res && res.link) || "";
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
      // Prefer the live hub name over whatever was stored at invite time (older
      // rows had the hub id pasted in here, and a rename leaves the stored name
      // stale). Shared with activity.js's mapHubInviteRow so this list and the
      // bell feed can never disagree about a workspace's name again.
      const hub_id = meta.hub_id || null;
      const hub_name = resolveHubInviteName(r, meta);
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
        privilege: meta.privilege || null,
        // WHAT MAKES THE ROW ANSWERABLE. Present only on rows written by
        // _notifyInvitee — a real invitation — and absent on the receipt
        // _grantMembership writes when an admin adds somebody directly
        // (add_contributors), which is not an invitation and has nothing to
        // accept. The client keys its Accept/Decline buttons on it, so an
        // older row simply renders as it always did.
        //
        // Safe to hand over: it is this user's own invitation, the same secret
        // their email already carries, and notification_hub_invites is scoped
        // to the recipient.
        invite_token: meta.token || null
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
    const privilege = this.input.use(Attr.privilege) || this.hub.get(Attr.settings).default_privilege;
    const hours = this.input.use(Attr.hours, 0)
    const days = this.input.use(Attr.days, 0);
    const expiry = hours * 1 + days * 24;
    const lang = this.user.language() || this.input.app_language();
    let mfs_home = await this.db.await_proc("mfs_home");
    // This used to be this.hub.get(Attr.name) alone, which is yp.hub.hubname --
    // the HEX ID. Everything downstream inherited it: the invitation email, the
    // two audit lines, and (through _grantMembership) the workspace name stored
    // on the invitee's notification, where a hex id renders as no name at all.
    // Same resolver and same chain as invite(); mfs_home was already fetched
    // here for the chat-upload grant, so this costs no extra query.
    const hubname = resolveHubDisplayName(
      mfs_home,
      this.hub.get(Attr.hubname),
      this.hub.get(Attr.name),
      this.hub.get(Attr.id),
    );
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
  /**
   * Refresh this workspace's member count in yp.workspace_members, which is
   * what "Avg team size" on the dashboard's Viral loop page divides down.
   *
   * WHY A ROLLUP EXISTS AT ALL: membership is not stored in yp. It lives in
   * each hub's own `permission` table (resource_id = '*'), the rows
   * hub_get_members_by_type reads, so counting it system-wide means visiting
   * every hub database — which the dashboard's read path must never do.
   * yp.membership looks like the table for this and is not: zero rows on every
   * install checked, nothing writes it.
   *
   * TAKES NO COUNT. workspace_members_set does its own COUNT against the hub's
   * permission table, so this cannot pass a number taken before its own write,
   * and the live writers can never disagree with the backfill crawl — they run
   * the same query.
   *
   * NEVER THROWS. Tracking must not be able to break the membership change that
   * triggered it: an invitation that succeeded and then reported a failure
   * because a counter could not be written is strictly worse than a stale
   * count, which the next mutation (or a backfill re-run) corrects anyway.
   *
   * @param {string} hub_id
   */
  async _trackWorkspaceMembers(hub_id) {
    if (!hub_id) return;
    try {
      await this.yp.await_proc("workspace_members_set", hub_id);
    } catch (err) {
      this.warn(
        "[hub] workspace member tracking failed for", hub_id,
        err && err.message
      );
    }
  }

  /**
   * Record that a workspace invitation was SENT, for the Viral loop page.
   *
   * 🚨 TWO PROCEDURES, AND THE CALLER MUST SAY WHICH. They differ on one rule:
   * what had_account = 1 implies.
   *
   *   invite_track_mark     stamps accept_time = sent_time for an existing
   *                         account, because the caller GRANTED membership on
   *                         the spot — the invitation was accepted by
   *                         construction and no later answer is coming.
   *   invite_track_mark_v2  leaves accept_time NULL, because the caller SENT an
   *                         invitation the recipient must answer.
   *
   * `answerable` picks between them, and it DEFAULTS TO THE OLD ONE on purpose.
   * invite() opts in; invite_with_roles still grants immediately and must keep
   * the old semantics, or every one of its grants would be recorded as an
   * invitation nobody ever answered. A default that silently changed under it
   * is exactly the failure mode the _v2 split exists to prevent, and it would
   * be invisible — same arity, no error, wrong number.
   *
   * had_account IS STILL NOT COSMETIC: it separates invitations that had to
   * talk somebody into opening an account from ones that only had to be said
   * yes to, and viral_loop reports both rates.
   *
   * NEVER THROWS, for the same reason as _trackWorkspaceMembers: a failed
   * counter must not fail an invitation that actually went out.
   *
   * @param {object} o
   * @param {string} o.hub_id       workspace invited into
   * @param {string} o.email        address invited
   * @param {string} [o.invitee_uid] set when the invitee already has an account
   * @param {boolean} o.had_account true when the invitee already had an account
   * @param {string} o.source       which call site wrote it
   * @param {boolean} [o.answerable] true when the recipient must accept before
   *   becoming a member — routes to invite_track_mark_v2. Default false keeps
   *   the instant-grant semantics for callers that still grant.
   */
  async _trackInviteSent({ hub_id, email, invitee_uid, had_account, source, answerable = false }) {
    if (!hub_id || !email) return;
    try {
      await this.yp.await_proc(
        answerable ? "invite_track_mark_v2" : "invite_track_mark",
        this.uid, hub_id, email, invitee_uid || null,
        had_account ? 1 : 0, source || "hub_invite"
      );
    } catch (err) {
      this.warn(
        "[hub] invite tracking failed for", email, err && err.message
      );
    }
  }

  /**
   * Write membership: add_member, the permission grants, the audit line, the
   * "you are in" notification and the member-count rollup.
   *
   * 🚨 NOT REACHED BY hub.invite ANY MORE. Inviting mints an invitation and
   * stops; membership is written when the person accepts, by accept_invite,
   * which does its own add_member with the seat and over-limit guards an
   * answered invitation needs. The remaining callers are the paths that add
   * somebody DIRECTLY, without asking: add_contributors (an admin picking an
   * existing contact) and the dead invite_with_roles.
   *
   * The `hub_invite_received` row it writes therefore means what it always
   * meant HERE — a receipt for a membership that now exists — and not the
   * answerable invitation _notifyInvitee writes. That one carries a token; this
   * one does not, which is what the notification row keys its Accept/Decline
   * buttons on.
   */
  async _grantMembership(uid, privilege, expiry, message, mfs_home, hub_name, from_fullname) {
    const r = await this.db.await_proc("add_member", uid, privilege, expiry);
    if (!r || !r.db_name) return null;
    await this.db.await_proc(
      "permission_grant", "*", uid, expiry, privilege, "system", message
    );
    // Chat attachments stage in a hidden folder before they become a message.
    // A member who may chat has to write there even though the role carries no
    // write bit for the workspace at large -- 'no_traversal' keeps that raised
    // access on this one folder. A view-only member may not chat, so granting
    // it would hand them an upload path they are not entitled to.
    if (privilegeAllows(privilege, CAN_CHAT)) {
      await this.db.await_proc(
        "permission_grant", mfs_home.chat_upload_id, uid, 0, CHAT_UPLOAD_GRANT,
        "no_traversal", "chat upload permission"
      );
    }
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
    // Notify online members (admins with the Folder settings permission matrix
    // open) so the new member appears immediately without a manual reload.
    await notifyMemberJoined(this, this.hub.get(Attr.id), uid);
    // Single choke point for granting, so no second place to forget when
    // another caller is added later.
    await this._trackWorkspaceMembers(this.hub.get(Attr.id));
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
  /**
   * Seat budget of the organisation that owns `domainId`, or null when no cap
   * applies (no organisation, Free — refused elsewhere — or an unlimited tier).
   *
   * `used` counts members AND invitations still outstanding: a pending invite
   * holds a seat, because it can be redeemed at any moment. Same arithmetic as
   * admin-api's `_orgSeatsUsed`, deliberately — invite, accept and member_add
   * must not disagree about how full a plan is, or the one with the loosest
   * sum becomes the way around the other two.
   *
   * Every failure returns null (no cap) rather than throwing: a stats query
   * that times out must not make a workspace uninvitable. The accept guard is
   * the backstop that keeps occupancy correct either way.
   */
  /**
   * Everyone who ALREADY holds or reserves a seat on this domain, as a set of
   * lowercased emails plus uids.
   *
   * A seat belongs to a person, not to a grant. Inviting somebody into a
   * second folder is not a second person: the budget below already counts
   * them (as a member, or as a pending invite), so charging the invitation
   * again refuses an org that has not actually grown. Reported 2026-08-11 —
   * invite an address into folder A, then into another, and the second call
   * answers SEAT_LIMIT_REACHED for one human being.
   *
   * Both identifiers go in because callers pass either: `invite` takes
   * emails, `invite_with_roles` takes contact "entities" that may be a uid.
   *
   * Pending comes from pending_invites_by_domain — the same proc behind the
   * admin console's Pending Invites card and the same three sources
   * member_list_stats counts, so the guard and the number the owner reads can
   * never disagree.
   *
   * @param {Number} domainId
   * @returns {Promise<Set<String>>}
   */
  async _seatedIdentities(domainId) {
    const out = new Set();
    // parseInt||0, not Math.trunc: a missing domain must read as 0 so the
    // guard below returns an empty set, and Math.trunc(undefined) is NaN,
    // which would sail past `dom <= 1`.
    const dom = Number.parseInt(domainId, 10) || 0;
    if (dom <= 1) return out;
    const add = (v) => {
      const k = String(v == null ? '' : v).trim().toLowerCase();
      if (k) out.add(k);
    };
    try {
      const rows = toArray(await this.yp.await_query(
        `SELECT p.uid, d.email
           FROM privilege p
           INNER JOIN drumate d ON d.id = p.uid
           INNER JOIN entity e ON e.id = d.id
          WHERE p.domain_id = ?
            AND COALESCE(JSON_VALUE(d.profile, '$.category'), '') <> 'system'
            AND e.status NOT IN ('archived', 'frozen', 'deleted')`,
        dom
      ));
      for (const r of rows) { if (r) { add(r.uid); add(r.email); } }
    } catch (e) {
      this.warn('[hub] seated members lookup failed:', e?.message);
    }
    try {
      const rows = toArray(await this.yp.await_proc('pending_invites_by_domain', dom, ''));
      for (const r of rows) { if (r) add(r.email); }
    } catch (e) {
      this.warn('[hub] pending invites lookup failed:', e?.message);
    }
    return out;
  }

  /**
   * How many of these addresses would take a NEW seat.
   * @param {Number} domainId
   * @param {Array} entries emails, or contact entities (email | uid)
   */
  async _newcomers(domainId, entries) {
    const seated = await this._seatedIdentities(domainId);
    if (!seated.size) return toArray(entries);
    return toArray(entries).filter((e) => {
      const raw = (e && (e.email || e.uid || e.id)) || e;
      const k = String(raw == null ? '' : raw).trim().toLowerCase();
      return !k || !seated.has(k);
    });
  }

  async _seatBudget(domainId) {
    try {
      const dom = ~~domainId;
      if (dom <= 1) return null;
      const org = await this.yp.await_proc('organisation_get', String(dom));
      if (isEmpty(org) || !org.id) return null;
      const raw = await this.yp.await_func('get_quota', org.owner_id || this.uid);
      const quota = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
      const seat = parseInt(quota && quota.seat, 10) || 0;
      // 0 = Free (org creation is blocked upstream); the huge sentinel is the
      // unlimited tier. Neither is a finite budget to spend here.
      if (seat <= 0 || seat >= 100000) return null;
      let stats = await this.yp.await_proc('member_list_stats', org.id);
      if (isArray(stats)) stats = stats[0];
      const members = parseInt(stats && stats.total_members, 10) || 0;
      const pending = parseInt(stats && stats.pending_invites, 10) || 0;
      return {
        seat, members, pending,
        used: members + pending,
        free: Math.max(0, seat - members - pending),
      };
    } catch (e) {
      this.warn('[hub] seat budget lookup failed:', e && e.message);
      return null;
    }
  }

  /**
   * Domain that owns a hub — the invitee's own domain is not it.
   *
   * No `type='hub'` filter: a personal workspace is the drumate's own entity
   * (type 'drumate') and its id is used as a hub id throughout. Filtering on
   * 'hub' silently returned nothing for exactly those, which made the accept
   * guard below no-op on the most common workspace there is.
   */
  async _hubDomainId(hubId) {
    try {
      const row = await this.yp.await_query(
        "SELECT dom_id FROM entity WHERE id=? LIMIT 1", hubId
      );
      const r = isArray(row) ? row[0] : row;
      return ~~(r && r.dom_id);
    } catch (e) {
      return 0;
    }
  }

  /**
   * Wildcard permission this user already holds on a workspace, 0 when none.
   *
   * The '*' row is the workspace-wide grant — the same row permission_grant
   * writes — so it is the figure an invitation would overwrite.
   *
   * db_name comes from get_db_name (derived from the token's own hub id), but
   * it is interpolated rather than bound, so it is checked against the
   * identifier charset before use. Any failure reads as 0: the caller then
   * treats them as a new member, which grants rather than withholds access —
   * the safe direction for a lookup that could not answer.
   */
  async _hubPermission(db_name, uid) {
    try {
      if (!/^[A-Za-z0-9_]+$/.test(String(db_name || ''))) return 0;
      let row = await this.yp.await_query(
        `SELECT permission FROM \`${db_name}\`.permission
          WHERE resource_id='*' AND entity_id=? LIMIT 1`,
        uid
      );
      if (isArray(row)) row = row[0];
      return ~~(row && row.permission);
    } catch (e) {
      return 0;
    }
  }

  async invite() {
    let invitees = toArray(this.input.need("invitees"));
    // Seats are spent HERE, not at redemption: an existing drumate is granted
    // membership immediately below, and a newcomer gets a token that reserves
    // one. Until 2026-08 this path had no cap at all — a Team org with one
    // member could send fifteen invitations, every one accepted, and land at
    // sixteen members on ten seats once they were redeemed.
    //
    // Refuse the whole call rather than filling the remaining seats and
    // dropping the rest: a partial invite silently loses people, and the
    // caller cannot tell which of the addresses they typed actually went out.
    const budget = await this._seatBudget(this.user.domain_id());
    // Charge for PEOPLE the org does not already have. Someone already a
    // member, or already holding a live invitation, is being added to one
    // more folder — the budget counts them once and this must not count them
    // again (see _seatedIdentities).
    const newcomers = budget
      ? await this._newcomers(this.user.domain_id(), invitees)
      : invitees;
    if (budget && newcomers.length > budget.free) {
      return this.output.data({
        status: 'SEAT_LIMIT_REACHED',
        seat: budget.seat,
        used: budget.used,
        free: budget.free,
        requested: newcomers.length,
      });
    }
    const privilege = this.input.use(Attr.privilege)
      || this.hub.get(Attr.settings).default_privilege;
    const lang = this.user.language() || this.input.app_language();
    const username = this.user.get("fullname");
    const hubId = this.hub.get(Attr.id);
    // mfs_home reads yp.hub.name directly (the actual display name);
    // this.hub.get(Attr.name/hubname) returns yp.hub.hubname (a technical id).
    // The chain itself now lives in service/lib/hub-display-name.js, because
    // the other two invite endpoints got it wrong by each carrying their own.
    const mfs_home = await this.db.await_proc("mfs_home");
    const hubname = resolveHubDisplayName(
      mfs_home,
      this.hub.get(Attr.hubname),
      this.hub.get(Attr.name),
      hubId,
    );
    const area = this.hub.get(Attr.area);
    // The ONE axis the email body varies on: internal (private) vs external
    // (shared) workspace. Also decides whether the workspace preview is redacted.
    const workspace_external = isExternalArea(area);
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
    // Called for its SIDE EFFECTS only, which is why the token it returns is
    // discarded: it creates the external room on first use and re-applies the
    // area-based guest permission, and copy_link plus the share panel both depend
    // on that room existing. The CTA itself no longer carries a share token —
    // see _inviteCtaLink.
    await this._ensurePublicShareToken();
    // One CTA for everyone: the sign-in form, carrying the workspace so the desk
    // can offer to open it once the recipient is authenticated.
    const ctaLink = this._inviteCtaLink(hubId, hubname);
    // Address-book context resolved once for the whole call (see
    // _rememberInvitee). Null when the inviter has no drumate DB — the invite
    // still goes through, it just isn't remembered.
    const contactBook = await this._contactBookContext();
    // The popup fires one hub.invite per selected workspace with the same email
    // list, and a caller may repeat an address; remember each person once.
    const remembered = new Set();
    const toRemember = [];
    // Indexed by position so the reply lists invitees in the order they were
    // typed, even though the email step below runs in batches.
    const results = new Array(invitees.length);
    // Everyone whose membership/pending work succeeded, waiting for the mail
    // step. The DB work is milliseconds per address; the mail is not.
    const mailQueue = [];

    for (const [idx, email] of invitees.entries()) {
      // WHAT ACTUALLY LANDED before the email step, so a mail failure can say
      // so rather than reading as "nothing happened" — see _inviteFailureReason
      // and the catch at the bottom of this loop. Reset per invitee: one bad
      // address must not colour the next one's report.
      let granted = false;
      let pending = false;
      try {
        let drumate = await this.yp.await_proc("drumate_exists", email);
        if (isArray(drumate)) drumate = drumate[0];
        const isDrumate = drumate && drumate.id;

        // --- ONE INVITATION, WHATEVER THE ACCOUNT STATUS ---
        //
        // 🚨 AN EXISTING ACCOUNT USED TO BE ADDED TO THE WORKSPACE RIGHT HERE,
        // by _grantMembership, before the email had even been composed. The
        // recipient was never asked: the first they knew of it was a workspace
        // appearing in their sidebar, and the email that followed announced
        // something already done. There was no accept and no decline because
        // there was nothing left to answer.
        //
        // Both branches now MINT AN INVITATION and stop. Membership is written
        // by hub.accept_invite, when the person says yes — from the email's
        // Accept link or from the Accept button on the notification row.
        //
        // What is left of the account-status branch is one thing only: whether
        // there is a Drumee user to notify. Everything else — the token, the
        // pending row, the audit line, the tracking, the email — is identical
        // for both, which is the point. Two half-shaped invitations that had to
        // be told apart everywhere downstream are now one.
        //
        // THE TOKEN IS THE INVITATION. It is what Accept redeems and what
        // Decline closes, and its secret has to reach the recipient: by email
        // for everyone, and additionally inside the notification row for
        // somebody who already has an account.
        const token = await this._addInviteToken(email, hubId, privilege, expiryTs);
        // THE PENDING ROW IS WHAT SIGNUP GRANTS FROM. create_account calls
        // _resolve_pending_invitation(email), which reads
        // pending_invitation_get_by_email and adds the new account to each hub;
        // nothing redeems the TOKEN during sign-up. So an invitation that
        // writes only a token leaves a newcomer with no membership at all —
        // that was the share-workspace bug, where the invitee signed up and
        // landed on a desk showing only the three default workspaces.
        //
        // Written for an existing account too, and harmlessly: that row is only
        // ever read at account creation, which has already happened for them.
        // It is also what makes them visible to the admin console's Pending
        // Invites, which was blind to this branch while it granted on the spot.
        // hub.decline_invite and hub.accept_invite both delete it
        // (pending_invitation_delete), so a refusal cannot be undone by signing
        // up afterwards.
        await this.yp.await_proc(
          "yp_add_pending_invitation", hubId, 0, privilege, email
        );
        pending = true;
        // Now written for BOTH branches. The existing-account branch left no
        // audit line at all while it granted instead of inviting, so an
        // administrator reading the workspace's log saw only 'added' with no
        // invitation before it.
        await writeAudit(this, {
          db: this.hub.get(Attr.db_name),
          uid: this.uid,
          action: 'invite_sent',
          category: 'member',
          notify_to: 'admin',
          entity_id: hubId,
          log: `Invite sent to ${email} for workspace '${hubname}'`,
        });
        // _v2, and the version is the whole point: the old procedure stamps
        // accept_time = sent_time whenever had_account = 1, because its caller
        // granted membership itself. Nothing is granted here, so an invitation
        // to an existing account is as unanswered as any other until it is
        // accepted. See invite_track_mark_v2.
        await this._trackInviteSent({
          hub_id: hubId,
          email,
          invitee_uid: isDrumate ? drumate.id : null,
          had_account: !!isDrumate,
          source: "hub_invite",
          answerable: true,
        });
        if (isDrumate) {
          await this._notifyInvitee(drumate.id, {
            hub_id: hubId,
            hub_name: hubname,
            message,
            from_fullname: username,
            privilege,
            token,
          });
        }

        // The email itself is sent after this loop, in batches — see below.
        // `token` rides along: unlike the rest of the email it is PER PERSON.
        mailQueue.push({ idx, email, granted, pending, drumate, token, had_account: !!isDrumate });
      } catch (err) {
        this.warn("[hub] invite failed for", email, err && err.message);
        results[idx] = {
          email,
          status: "failed",
          // The caller needs these to know whether "failed" means "nothing
          // happened" or "everything happened except the email".
          granted,
          pending,
          reason: this._inviteFailureReason(email, hubname, granted, pending, err),
        };
      }
    }

    // --- One email per invitee, sent in batches ---
    // Batched, not one awaited send per invitee: each send is a full SMTP
    // handshake with the relay (~4.5 s measured on production), and paying it
    // serially made the request time grow linearly with the guest list — a
    // 30-address invite held the popup for over two minutes.
    //
    // 🚨 NOT ONE MESSAGE TO THE WHOLE BATCH. The Accept and Decline links carry
    // each invitee's OWN token, so every recipient needs their own rendering —
    // sending one body to the batch would hand everybody the first person's
    // invitation. The batch is therefore sent as concurrent single-recipient
    // sends. Same connection profile as a multi-recipient send: Messenger keeps
    // one module-level transport and posts one sendMail per recipient either
    // way, so INVITE_MAIL_BATCH still bounds the open SMTP sessions.
    //
    // THE SUBJECT NO LONGER CLAIMS THE DEED IS DONE. "added you to" was
    // literally true while this granted membership on the spot; it is a lie
    // now, and the one line of the email most people read.
    const subject = workspace_external
      ? `${username} invited you to ${hubname}`
      : `${username} invited you to join ${hubname}`;
    const mailData = (token) => ({
      inviter_name: username,
      workspace_name: hubname,
      // Kept, and still the target of the workspace preview's own links, so an
      // email opened by somebody who has already answered is not a dead end.
      link: ctaLink,
      // The two answers. Both carry the token and nothing else identifying —
      // holding the secret IS the authorisation, exactly as it already was for
      // redemption.
      accept_link: this._inviteAnswerLink(token, hubId, hubname, "accept"),
      decline_link: this._inviteAnswerLink(token, hubId, hubname, "decline"),
      workspace_external,
      preview_items,
      recent_messages,
    });
    for (let i = 0; i < mailQueue.length; i += INVITE_MAIL_BATCH) {
      const batch = mailQueue.slice(i, i + INVITE_MAIL_BATCH);
      // One verdict per invitee: an Error, or null when it was delivered.
      const verdicts = await Promise.all(batch.map(async ({ email, token }) => {
        try {
          const rejected = await this._sendInviteEmails(
            WORKSPACE_INVITE_TPL, [email], subject, mailData(token),
          );
          return rejected.has(String(email).trim().toLowerCase())
            ? new Error(`Email delivery to ${email} failed: the MTA rejected ${email}`)
            : null;
        } catch (err) {
          // Nothing was dispatched (no MTA, unknown reply shape).
          return new Error(`Email delivery to ${email} failed: ${err.message}`);
        }
      }));
      batch.forEach(({ idx, email, granted, pending, drumate, had_account }, j) => {
        const err = verdicts[j];
        if (err) {
          this.warn("[hub] invite failed for", email, err.message);
          results[idx] = {
            email,
            status: "failed",
            granted,
            pending,
            reason: this._inviteFailureReason(email, hubname, granted, pending, err),
          };
          return;
        }
        results[idx] = { email, status: "ok", granted, pending, had_account };
        // Queue for address-book bookkeeping — only invitees whose branch
        // actually succeeded (a failure must leave no contact).
        // Deliberately deferred until every invite is done, see below.
        const key = String(email).trim().toLowerCase();
        if (!remembered.has(key)) {
          remembered.add(key);
          toRemember.push({ email, drumate });
        }
      });
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

    this.output.data({ results: results.filter(Boolean) });
  }

  /**
   * Mint a hub_invite token: the invitation itself, and the only thing that can
   * redeem or refuse one. Every invitee gets one now, not just an address with
   * no Drumee account — see invite().
   *
   * THE SECRET IS RETURNED, and callers need it. It is what the email's Accept
   * and Decline links carry, and what the notification row hands back to
   * hub.accept_invite / hub.decline_invite. Before invitations could be
   * answered this only had to exist, so nothing read it.
   *
   * REPLACE semantics live in token_hub_invite_add: re-inviting the same
   * address to the same workspace as the same inviter supersedes the previous
   * token, so a refusal does not block a later invitation.
   */
  async _addInviteToken(email, hubId, privilege, expiryTs) {
    const { randomBytes } = require("crypto");
    const secret = randomBytes(24).toString("hex");
    const method = `hub_invite:${hubId}`;
    const metadata = JSON.stringify({ hub_id: hubId, permission: privilege });
    await this.yp.await_proc(
      "token_hub_invite_add", email, "", secret, method, this.uid, metadata, expiryTs
    );
    // ONE LIVE INVITATION PER PERSON PER WORKSPACE. The REPLACE above only
    // covers a re-send by the SAME admin — its unique key carries inviter_id —
    // so a second admin inviting the same address leaves the first row beside
    // the new one, refusals included. token_hub_invite_decline parks a refusal
    // with expiry 0 so it never ages out, and hub_invitations reports the
    // newest row that still qualifies: once the NEW invitation lapses, the old
    // undying refusal is the only one left and the panel says "Declined" for an
    // invitation the person never answered. Superseding here is also what was
    // asked for — re-inviting somebody who declined turns their row back to
    // Pending instead of stacking a second one.
    //
    // Best-effort: the invitation itself is already minted and must not fail
    // because a tidy-up did. The worst case is the stale row this removes.
    try {
      await this.yp.await_proc(
        "token_hub_invite_supersede", email, method, secret
      );
    } catch (err) {
      this.warn("[hub] invite: superseding older tokens failed", err && err.message);
    }
    return secret;
  }

  /**
   * Tell an invitee who already has an account that they have been invited.
   *
   * THE NOTIFICATION IS THE INVITATION on this branch, not a receipt for
   * something already done. It used to be written by _grantMembership, after
   * the membership had been created — "you are in" — and the row carried no way
   * to answer because there was nothing to answer. It now carries the token, so
   * the row can offer Accept and Decline (activity item skeleton reads
   * `invite_token`).
   *
   * 🚨 `hub.add_contributors` IS NOT PUSHED HERE, and its absence is the
   * feature. That is the client's "you are now a member" signal — window/utils
   * newContent() adds the workspace tile on it — and pushing it for somebody who
   * has not accepted would put the workspace on their desk, which is exactly
   * the auto-join being removed. Only `hub.invite_received` goes out: the
   * activity panel refreshes its feed on it, which is how the invitation
   * appears without a reload.
   *
   * NEVER THROWS. A notification is not the invitation's record — the token and
   * the pending row are — so a socket that is not there, or a contact_activity
   * write that fails, must not fail an invitation whose email is about to go
   * out. The invitee still gets the email, and the row is rebuilt from
   * contact_activity on their next feed read.
   */
  async _notifyInvitee(uid, { hub_id, hub_name, message, from_fullname, privilege, token }) {
    try {
      await this.yp.await_proc(
        "contact_log_activity", this.uid, uid, "hub_invite_received",
        {
          hub_id,
          hub_name,
          message,
          from_fullname,
          privilege,
          // Read back out by activity.mapHubInviteRow and
          // hub.invite_received_get, both of which surface it as
          // `invite_token`. Safe to hand to this user: it is their own
          // invitation, the same secret their email already carries, and the
          // feed procs are scoped to the recipient.
          token,
        }
      );
    } catch (err) {
      this.warn("[hub] invite: activity row failed for", uid, err && err.message);
    }
    try {
      const sockets = await this.yp.await_proc('user_sockets', uid);
      await RedisStore.sendData(
        this.payload({ hub_id, hub_name }, { service: "hub.invite_received" }),
        sockets
      );
    } catch (err) {
      this.warn("[hub] invite: ws notify failed for", uid, err && err.message);
    }
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
    // What this person already holds on the workspace, before anything is
    // written. Two different decisions below depend on it.
    const held = await this._hubPermission(db_name, this.uid);
    let meta = {};
    try {
      meta = typeof tokenRow.metadata === 'string'
        ? JSON.parse(tokenRow.metadata)
        : (tokenRow.metadata || {});
    } catch (e) { }
    const permission = meta.permission || 7;
    // The proc's third argument is JSON and means "keep what is there" when
    // empty — but await_proc turns null into '', and '' is not valid JSON, so
    // the call errored and the driver swallowed it. Silently: every redemption
    // logged "Origin of error: call yp.token_hub_invite_set_status(…, '')" and
    // carried on, leaving the token 'active'. An invite link is single-use by
    // design (the status check above answers 'already_used'), and it never
    // became one — any copy of the link stayed redeemable until it expired.
    // Hand back the metadata it already holds: valid JSON, same value.
    const keep_meta = typeof tokenRow.metadata === 'string'
      ? tokenRow.metadata
      : JSON.stringify(tokenRow.metadata || {});

    // Already in, with at least what the invitation offers: redeem the token
    // and touch nothing else.
    //
    // permission_grant is a REPLACE, so it overwrites whatever the person had
    // — it cannot tell a new member from an existing one. An invitation
    // carrying the default 7 sent to a workspace admin, or to its owner, took
    // their access AWAY. Seen for real: an owner on 63 dropped to 7 by
    // redeeming a link to their own workspace, which then failed every
    // owner-scoped service on it (all of payment.*, since its ACL is
    // scope:hub/src:owner).
    if (held >= permission) {
      await this.yp.await_proc('token_hub_invite_set_status', secret, 'accepted', keep_meta);
      // The invitation is ANSWERED even though nothing was granted, so it has
      // to stop being pending: the panel would keep listing somebody who is
      // already a member, and their bell would keep offering them buttons.
      // Access itself is deliberately untouched here — see the note above.
      await this._closeInvitation(hub_id, tokenRow.email, { accepted: 1 });
      return this.output.data({ hub_id, already_member: 1 });
    }

    // Occupancy guard. Invitations sent before the cap existed — or sent by a
    // path that never checked — must not be able to seat more people than the
    // plan sells. This is the backstop: the invite side reserves, this side is
    // what actually fills a seat.
    //
    // Skipped for someone already on the workspace (held > 0): they are being
    // raised from one access level to another, not taking a new seat, and a
    // full plan must not block that.
    //
    // Measured against MEMBERS, not members+pending: the person accepting is
    // themselves one of the pending, so comparing the combined figure would
    // refuse the very invitations the org legitimately reserved room for.
    // Members-only lets every reserved seat be taken and stops exactly at the
    // cap — nine pending on a ten-seat plan with one member all get in; a
    // twelfth, over-issued before the cap landed, does not.
    //
    // Scoped to the HUB's organisation: the person accepting is typically
    // still on their personal domain, so their own domain says nothing.
    const hubDom = held > 0 ? 0 : await this._hubDomainId(hub_id);
    const budget = await this._seatBudget(hubDom);
    if (budget && budget.members >= budget.seat) {
      return this.output.data({
        status: 'SEAT_LIMIT_REACHED',
        hub_id,
        seat: budget.seat,
        members: budget.members,
      });
    }
    // Downgrade over-limit: while the workspace is over its downgraded
    // plan's limits, growing the membership is paused along with every other
    // mutation. This has to live HERE, not in the REST clamp: the redeemer
    // is anonymous / on their own personal domain, so the clamp inspects the
    // wrong domain. Role upgrades (held > 0 → hubDom 0) stay allowed — they
    // take no seat.
    if (hubDom > 0) {
      try {
        const OverLimit = require('../lib/over-limit');
        const st = await OverLimit.getState(this.yp, hubDom);
        if (st && st.state) {
          return this.output.data({ status: 'OVER_LIMIT', hub_id });
        }
      } catch (e) { /* fail-open, same rule as the clamp */ }
    }
    await this.yp.await_proc(`${db_name}.add_member`, this.uid, permission, 0);
    await this.yp.await_proc(
      `${db_name}.permission_grant`,
      '*', this.uid, 0, permission, 'system', 'Redeemed hub invite token'
    );
    // 🚨 THE CHAT STAGING GRANT, which this path has never written.
    //
    // A member whose role is Chat has no write bit for the workspace, by
    // design, and is meant to get write on the hidden '/__chat__/__upload__'
    // folder alone so an attachment can be staged before it becomes a message.
    // _grantMembership writes that grant; redeeming a token did not, so anybody
    // who joined by link could not attach a file to a chat — the same 403 that
    // was chased and fixed on the other path (schemas 2026-09-17,
    // chat_upload_grant_repair).
    //
    // It was survivable while token redemption was the rare branch. It is now
    // how EVERY member joins, so leaving it out would reintroduce that bug as
    // the normal case, on the one path nobody had looked at.
    //
    // Gated on CAN_CHAT exactly as _grantMembership gates it: a view-only
    // member may not chat, so handing them an upload path would give them
    // something their role does not carry. 'no_traversal' keeps the raised
    // access on that one folder and stops user_permission letting it reach
    // anything inside.
    //
    // mfs_home() reads DATABASE(), which inside a routine is the routine's OWN
    // database — so the cross-database call resolves the INVITED workspace's
    // staging folder, not the caller's. Never allowed to fail the join: a
    // member without this grant has a working workspace and a chat that cannot
    // attach, which is strictly better than an invitation that would not
    // redeem.
    if (privilegeAllows(permission, CAN_CHAT)) {
      try {
        const home = await this.yp.await_proc(`${db_name}.mfs_home`);
        if (home && home.chat_upload_id) {
          await this.yp.await_proc(
            `${db_name}.permission_grant`,
            home.chat_upload_id, this.uid, 0, CHAT_UPLOAD_GRANT,
            'no_traversal', 'chat upload permission'
          );
        }
      } catch (err) {
        this.warn(
          "[hub] accept_invite: chat upload grant failed for", this.uid,
          err && err.message
        );
      }
    }
    await this.yp.await_proc('token_hub_invite_set_status', secret, 'accepted', keep_meta);
    await this._closeInvitation(hub_id, tokenRow.email, { accepted: 1 });
    await writeAudit(this, {
      db: db_name,
      uid: this.uid,
      action: 'invite_accepted',
      category: 'member',
      notify_to: 'admin',
      entity_id: hub_id,
      log: `Invite accepted — ${this.user.get(Attr.email) || this.uid} joined the workspace`,
    });
    // Notify the workspace's online members that a member just joined via
    // token redemption — accept_invite pushed nothing before, so admins with
    // the Folder settings matrix open were stuck with a stale member list.
    await notifyMemberJoined(this, hub_id, this.uid);
    this.output.data({ hub_id });
  }

  /**
   * Everything an ANSWERED invitation has to stop being, whichever answer it
   * got. Called by accept_invite and decline_invite so the two cannot drift
   * into closing different halves of the same thing.
   *
   * The answer itself is recorded by the caller — the token's status is what
   * says accepted or declined — and this is the cleanup around it:
   *
   *   pending_invitation   🚨 THE ONE THAT MATTERS. That table is not a record
   *     of an invitation, it is the QUEUE signup grants membership from
   *     (_resolve_pending_invitation, in both signup.js and butler.js). Leave
   *     the row behind after a REFUSAL and the invitee declines, creates their
   *     account, and is put into the workspace they just turned down. Leave it
   *     after an ACCEPTANCE and signup grants a membership that already exists
   *     — harmless today because add_member is idempotent, but the invitation
   *     also goes on reading as unanswered to everything that counts that
   *     table, including the admin console's Pending Invites.
   *
   *   contact_activity     takes the row out of the invitee's bell. Cannot be
   *     left to the client: an answer given from the EMAIL knows only the
   *     token, never the notification's id, so the row would survive and keep
   *     offering Accept and Decline on a spent token.
   *
   *   invite_track         the analytics outcome, per workspace. Both
   *     procedures are the per-hub variants for the reason spelled out in
   *     invite_track_accept_hub: the per-address ones would answer somebody's
   *     OTHER pending invitations on the strength of this one.
   *
   * NEVER THROWS. The answer has already been written by the time this runs —
   * membership granted, or the token marked declined — so a failure here must
   * not turn a completed answer into an error the user sees and retries. Each
   * step is independently guarded so one failing does not skip the rest.
   *
   * @param {string} hub_id     the workspace answered about
   * @param {string} email      the address the invitation was sent to; may be
   *   absent on an old token, in which case only the notification is cleared
   * @param {object} o
   * @param {boolean} [o.accepted] true for accept, false/absent for decline
   */
  async _closeInvitation(hub_id, email, { accepted = false } = {}) {
    if (!hub_id) return;
    if (email) {
      try {
        await this.yp.await_proc('pending_invitation_delete', hub_id, email);
      } catch (err) {
        this.warn("[hub] invitation cleanup: pending row", err && err.message);
      }
    }
    if (this.uid) {
      try {
        await this.yp.await_proc(
          'contact_activity_dismiss_hub_invite', this.uid, hub_id
        );
      } catch (err) {
        this.warn("[hub] invitation cleanup: notification", err && err.message);
      }
    }
    if (email) {
      try {
        if (accepted) {
          await this.yp.await_proc(
            'invite_track_accept_hub', hub_id, email, this.uid || null
          );
        } else {
          await this.yp.await_proc('invite_track_decline', hub_id, email);
        }
      } catch (err) {
        this.warn("[hub] invitation cleanup: tracking", err && err.message);
      }
    }
  }

  /**
   * Turn down a workspace invitation.
   *
   * 🚨 NO SESSION IS REQUIRED, and that is deliberate rather than an oversight.
   * HOLDING THE SECRET IS THE AUTHORISATION, exactly as it already is for
   * redemption — and this is the strictly less dangerous of the two, because
   * accepting with a secret GRANTS access to a workspace while declining only
   * destroys an invitation addressed to one email.
   *
   * Requiring a sign-in would mean the one answer that needs no account could
   * only be given by creating one: an invitation is most often sent to somebody
   * who has no Drumee account, and "no thanks" must not cost them a signup.
   *
   * WHAT IT CANNOT DO is as important as what it can. It never removes
   * membership — leaving a workspace is desk.leave_hub, a different act behind
   * a different permission — and token_hub_invite_decline refuses anything that
   * is not an ACTIVE hub_invite token, so a stale link pressed after joining
   * cannot rewrite how somebody got in.
   *
   * IDEMPOTENT by construction: declining twice keeps the first answer (the
   * proc's own WHERE clause), and so does invite_track_decline. The second
   * press reports the same `declined` rather than an error, because from the
   * user's side nothing is wrong — they said no, twice.
   */
  async decline_invite() {
    const secret = this.input.need('token');
    const rows = await this.yp.await_proc('token_hub_invite_decline', secret);
    const tokenRow = isArray(rows) ? rows[0] : rows;
    // No row at all: not a hub-invite token, or one already swept away by the
    // expiry cleanup in token_hub_invite_add. Nothing to answer.
    if (!tokenRow || !tokenRow.secret) {
      return this.output.data({ status: 'invalid' });
    }
    const hub_id = tokenRow.hub_id
      || String(tokenRow.method || '').slice('hub_invite:'.length);
    // Already accepted — say so rather than claiming a refusal that did not
    // happen. The proc left the token alone, and the person is a member.
    if (tokenRow.status === 'accepted') {
      return this.output.data({ status: 'already_used', hub_id });
    }
    await this._closeInvitation(hub_id, tokenRow.email, { accepted: false });
    // Audited on the WORKSPACE, so its administrators can see that an
    // invitation they sent was turned down — the Pending Invitations list shows
    // the state, this records the moment. Best-effort: the refusal is already
    // written and must not be undone by a logging failure, and the hub db may
    // not resolve for a caller with no session.
    try {
      const db_name = await this.yp.await_func('get_db_name', hub_id);
      if (db_name) {
        await writeAudit(this, {
          db: db_name,
          uid: this.uid || null,
          action: 'invite_declined',
          category: 'member',
          notify_to: 'admin',
          entity_id: hub_id,
          log: `Invite declined — ${tokenRow.email} turned down the invitation`,
        });
      }
    } catch (err) {
      this.warn("[hub] decline_invite: audit failed", err && err.message);
    }
    this.output.data({ status: 'declined', hub_id });
  }

  /**
   * The invitations this workspace is still waiting on, plus the ones that were
   * turned down — the "Pending Invitations" section of the Access panel.
   *
   * 🚨 CURRENT MEMBERS ARE FILTERED OUT HERE, and they have to be filtered
   * somewhere. hub_invitations reads yp, and membership lives in the
   * workspace's own database, so the procedure cannot know. The usual case it
   * catches: an address invited while an older invitation of its own was still
   * active, then added straight to the workspace by add_contributors — which
   * asks nobody and leaves the invitation open. Without this the panel would
   * list the same person under Pending and under Members at once.
   *
   * Matched on the ADDRESS, lowercased on both sides, because an invitation has
   * no uid to match on until the invitee has an account.
   */
  async invitations() {
    const hub_id = this.hub.get(Attr.id);
    const rows = toArray(await this.yp.await_proc('hub_invitations', hub_id));
    let members = [];
    try {
      // Through _members_by_type, not a bare proc call: it is the one place
      // that knows a PERSONAL entity's database has no hub_get_members_by_type
      // at all, and that calling it there raises ER_SP_DOES_NOT_EXIST and tears
      // down this request's DB connection.
      members = toArray(await this._members_by_type('all', 1));
    } catch (err) {
      // A member list we could not read is not a reason to hide the
      // invitations: showing one row too many is recoverable by the admin,
      // showing nothing looks like the invitations were never sent.
      this.warn("[hub] invitations: member list failed", err && err.message);
    }
    const seated = new Set(
      members
        .map((m) => String((m && m.email) || "").trim().toLowerCase())
        .filter(Boolean)
    );
    this.output.list(
      rows.filter(
        (r) => !seated.has(String(r.email || "").trim().toLowerCase())
      )
    );
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
   * WHAT TO TELL THE CALLER when one invitee's turn threw.
   *
   * The loop above is ordered mint-then-notify, so where the throw happened
   * decides what is true afterwards:
   *
   *   - after the pending row   → the invitation EXISTS. It is in the Pending
   *     Invitations list, and an invitee who already has an account can still
   *     accept it from their notification row even if the email never left.
   *   - before it               → nothing happened.
   *
   * 🚨 `granted` IS ALWAYS FALSE NOW and the branch that read it is dead code
   * kept deliberately. Nothing in invite() grants membership any more — that
   * moved to hub.accept_invite — so no throw here can leave somebody a member.
   * The parameter stays because the result shape is part of this service's
   * contract with three callers (the Access panel, the rail's Invite popup and
   * the folder window), and because reviving the grant behind this function's
   * back would otherwise report "nothing was granted" while the person had
   * access.
   *
   * Reporting all three as a bare "the MTA rejected <address>" is wrong in the
   * direction that costs the admin the most: they read it as "the invite did
   * not go through", re-invite, get the identical failure, and never learn the
   * person already has access — while the permissions matrix in front of them
   * shows no new row, because the panel treats `status: "failed"` as "nothing
   * to refetch". State what LANDED first, then what did not.
   *
   * @param {String} email    the invitee
   * @param {String} hubname  workspace display name, for the message
   * @param {Boolean} granted membership was written
   * @param {Boolean} pending an invitation was recorded for a future signup
   * @param {Error}  err      whatever threw
   * @returns {String} the `reason` the caller surfaces
   */
  _inviteFailureReason(email, hubname, granted, pending, err) {
    const why = (err && err.message) || "unknown error";
    const ws = hubname ? `'${hubname}'` : "this workspace";
    // Kept to one sentence of consequence each: what failed, then what stands.
    // The advice that used to follow ("tell them another way", "do not
    // re-invite") is what the fact already implies, and it pushed the card past
    // the height its message deserves.
    if (granted) {
      return `${why}. Membership was actually granted: ${email} HAS been added `
        + `to ${ws} and can open it now.`;
    }
    if (pending) {
      return `${why}. The invitation to ${ws} is recorded — ${email} can still `
        + `accept it, and it will be honoured when they sign up.`;
    }
    return `${why}. Nothing was invited — ${email} has no invitation to ${ws}.`;
  }

  /**
   * Send the SAME invite email (service/private/templates/butler/<tpl>.html)
   * to a batch of addresses at once.
   *
   * Messenger.send accepts an array of recipients, posts them concurrently on
   * one transport and answers `{ recipient, error }`, where `error` lists the
   * addresses whose sendMail rejected (null when every one was delivered).
   *
   * AWAITED, and the reply judged by SHAPE rather than by a truthy `.error`
   * — see service/lib/mail-result for why that distinction is the whole bug.
   * dispatch() returns undefined before the mail reaches an MTA, and send()
   * returns the rendered HTML when no transport is configured; both read as
   * success under an `.error` test, which is how an invite came to report
   * status:"ok" while nothing ever left the box.
   *
   * @param {string}   tpl        template name under templates/butler
   * @param {string[]} recipients addresses for this batch
   * @param {string}   subject
   * @param {Object}   data       template data, the same for every recipient
   * @returns {Promise<Set<string>>} addresses (lowercased) the MTA rejected
   * @throws {Error} when nothing in the batch was dispatched at all
   */
  async _sendInviteEmails(tpl, recipients, subject, data) {
    const tplPath = resolve(__dirname, "templates", "butler", `${tpl}.html`);
    const msg = new Messenger({
      subject,
      recipient: recipients,
      handler: this.exception.email,
    });
    const html = msg.renderFrom(tplPath, data);
    // Display-name From ("Drumee" <contact@drumee.org>) so the inbox shows
    // "Drumee", matching the contact-add emails.
    const from = butlerFrom();
    const result = await msg.send({ html, from });
    const perRecipient = !!(result && Array.isArray(result.error));
    const reason = mailFailure(result);
    if (reason && !perRecipient) {
      throw new Error(reason);
    }
    const rejected = new Set();
    if (perRecipient) {
      for (const r of result.error) {
        rejected.add(String(r).trim().toLowerCase());
      }
    }
    return rejected;
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

    // Same seat rule as `invite` — this is the multi-workspace variant of the
    // same act, so it cannot be the way around the cap.
    const budget = await this._seatBudget(this.user.domain_id());
    // ...including the part that matters most here: this call assigns ONE
    // person to SEVERAL workspaces at once, so counting the entries would
    // charge a seat per workspace for a single human being.
    const newcomers = budget
      ? await this._newcomers(this.user.domain_id(), users)
      : users;
    if (budget && newcomers.length > budget.free) {
      return this.output.data({
        success: false,
        status: 'SEAT_LIMIT_REACHED',
        seat: budget.seat,
        used: budget.used,
        free: budget.free,
        requested: newcomers.length,
      });
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

      // mfs_home is needed for the chat_upload_id permission grant below, and
      // it is also the ONLY thing here that knows the workspace's display name:
      // get_hub returns `IF(_exists, h.hubname, _org_name) AS name`, so both of
      // its name columns are the hex id. Reading them is why this endpoint used
      // to mail "<inviter> added you to team 218881d8218881dc". Fetched before
      // the name now; the get_hub call stays because it is what creates a hub's
      // yp.disk_usage row on demand, and it still supplies the last-resort
      // fallbacks for a workspace whose yp.hub.name is genuinely NULL.
      const mfs_home = await this.yp.await_proc(`${hub_db}.mfs_home`);
      const hubInfo = await this.yp.await_proc('get_hub', hub_id);
      const hubname = resolveHubDisplayName(
        mfs_home,
        hubInfo && hubInfo.hubname,
        hubInfo && hubInfo.name,
        hub_id,
      );
      const msg = Cache.message('_x_add_you_to_team', lang).format(username, hubname);

      const members = []; // UIDs to add immediately
      const rows = []; // Results from add_member (for WebSocket notify)
      // uid -> address it was invited at, for invite_track. The immediate-grant
      // branches resolve an entity (which may be an email OR a uid) down to a
      // uid, but invite_track is keyed by (hub_id, email) — the same key
      // pending_invitation uses — so the address has to be carried forward
      // rather than re-derived after the fact.
      const memberEmail = new Map();

      // Resolve each user entity
      for (const entity of users) {
        try {
          // 1. Check inviter's contact list
          const contact = await this.yp.await_proc(contact_proc, 'entity', entity, '', '');

          if (!isEmpty(contact)) {
            if (contact.status === 'active') {
              // Known active contact → add immediately
              members.push(contact.uid);
              memberEmail.set(contact.uid, contact.email || asEmail(entity));
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
              await this._trackInviteSent({
                hub_id,
                email: asEmail(entity),
                had_account: false,
                source: "invite_with_roles",
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
              memberEmail.set(drumate.id, drumate.email || asEmail(entity));
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
              await this._trackInviteSent({
                hub_id,
                email: asEmail(entity),
                had_account: false,
                source: "invite_with_roles",
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
        // Same shape as invite()'s existing-account branch: granted on the
        // spot, so accept_time equals sent_time. Skipped when the entity was a
        // bare uid with no resolvable address — invite_track is keyed by email
        // and a row without one could never be matched by an acceptance.
        await this._trackInviteSent({
          hub_id,
          email: memberEmail.get(uid),
          invitee_uid: uid,
          had_account: true,
          source: "invite_with_roles",
        });

        // Grant resource-level permission on hub root
        await this.yp.await_proc(
          `${hub_db}.permission_grant`,
          '*', uid, expiry, privilege, 'system', msg
        );

        // Write access to the chat staging folder only, and only for a role
        // that may chat -- see _grantMembership for why it is scoped this way.
        if (mfs_home && mfs_home.chat_upload_id &&
            privilegeAllows(privilege, CAN_CHAT)) {
          await this.yp.await_proc(
            `${hub_db}.permission_grant`,
            mfs_home.chat_upload_id,
            uid,
            0,    // no expiry on chat upload
            CHAT_UPLOAD_GRANT,
            'no_traversal',
            'chat upload permission'
          );
        }
      }

      // Grants here bypass _grantMembership (this endpoint writes add_member and
      // permission_grant itself), so the rollup refresh that lives there does
      // not fire — refresh once per workspace after its members are in.
      if (members.length) await this._trackWorkspaceMembers(hub_id);

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

      // One broadcast per hub is enough — the matrix refetches the whole
      // member list. uid is left null: this is an admin-driven multi-add, so
      // every online member (including the acting admin) should refresh.
      await notifyMemberJoined(this, hub_id, null);

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
      // Avg team size has to fall when people leave, not only rise when they
      // join — a rollup refreshed on one side only climbs forever.
      await this._trackWorkspaceMembers(hub_id);
      // media.remove and hub.member_removed above went to the removed members
      // only. Every remaining member with the permission matrix open still
      // showed them; tell the hub, last, so the refetch reads the final list.
      await notifyMembersChanged(this, hub_id, {
        change: "removed",
        users: members,
      });
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

      // A role change has to move the chat staging grant in BOTH directions.
      // Granting on the way up is what lets a chat member attach a file;
      // revoking on the way down is what stops a member demoted to view-only
      // from keeping an upload path the new role does not carry.
      if (privilegeAllows(privilege, CAN_CHAT)) {
        await this.db.await_proc(
          "permission_grant",
          mfs_home.chat_upload_id,
          uid,
          0,
          CHAT_UPLOAD_GRANT,
          "no_traversal",
          "chat upload permission"
        );
      } else {
        await this.db.await_proc(
          "permission_revoke", mfs_home.chat_upload_id, uid
        );
      }

      hub = {};
      hub.privilege = privilege;
      hub.hub_id = this.hub.get(Attr.hub_id);
      hub.area = this.hub.get(Attr.area);
      let sockets = await this.yp.await_proc("user_sockets", uid);
      await RedisStore.sendData(this.payload(hub), sockets);
    }
    // The pushes above reach only the members being changed, for their own
    // windows. Everybody else with the permission matrix open is told here,
    // once, after every write has landed.
    await notifyMembersChanged(this, this.hub.get(Attr.id), {
      change: "privilege",
      users,
    });
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
