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

function _emailMatchesAllowed(email, info) {
  let allowedList = null;
  if (info.allowed_emails) {
    try {
      const parsed = typeof info.allowed_emails === 'string'
        ? JSON.parse(info.allowed_emails)
        : info.allowed_emails;
      if (Array.isArray(parsed) && parsed.length > 0) allowedList = parsed;
    } catch (e) { /* malformed JSON — treat as no restriction */ }
  }
  if (allowedList) {
    const domain = email.split('@')[1] || '';
    return allowedList.some(entry => {
      const e = (entry || '').toLowerCase().trim();
      return e === email || (e.startsWith('@') && e.slice(1) === domain);
    });
  }
  // Legacy fallback for pre-v2 shares without allowed_emails
  const recipientEmail = (info.recipient_email || '').toLowerCase().trim();
  // No allowed list and no legacy recipient → the share only requires that *some*
  // email be entered (require_email decoupled from an allow-list), so any email is
  // accepted here. Pre-v2 / list-restricted shares always have one of the above set,
  // so their matching behaviour is unchanged.
  if (!recipientEmail) return true;
  if (email === recipientEmail) return true;
  if (info.domain_restriction) {
    return (email.split('@')[1] || '') === info.domain_restriction.toLowerCase().trim();
  }
  return false;
}


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
          // Never expose secrets/recipient lists to an unauthenticated info probe
          // (mirrors _loginSecureShare's safeInfo): allowed_emails would otherwise let
          // a viewer enumerate the allow-list before passing the gate.
          delete res.password_hash;
          delete res.allowed_emails;
        }
      } catch (e) {
        this.warn('[dmz.info] secure_share_info lookup failed:', e && e.message);
      }
    }

    if (isEmpty(res) || res.failed) {
      res = res || {};
      res.status = 'WRONG_TICKET';
    } else if (res.is_secure) {
      // Report the share's ACTUAL gate, not a blanket REQUIRED_EMAIL. A revoked/
      // expired share keeps its validity; a valid one is email-gated only if it
      // requires email (or a legacy single recipient), else password-gated, else
      // public (TICKET_OK). The only caller (sharebox revoke poller) acts solely on
      // TICKET_REVOKED/TICKET_EXPIRED, so this is safe for it.
      if (res.validity !== 'TICKET_OK') {
        res.status = res.validity;
      } else if (res.require_email || res.recipient_email) {
        res.status = 'REQUIRED_EMAIL';
      } else if (res.require_password) {
        res.status = 'REQUIRED_PASSWORD';
      } else {
        res.status = 'TICKET_OK';
      }
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

    if (info.is_locked) {
      return this.output.data({ status: 'TICKET_LOCKED', is_secure: 1 });
    }

    // Resolve logged-in side user from cookie (mirrors normal login flow)
    let user = this.user.toJSON();
    const guest_id = Cache.getSysConf("guest_id");
    // Reliable "this viewer has their own authenticated session" signal — set ONLY
    // when regsid resolves to a real (non-guest/non-nobody) account. `is_guest`
    // alone is unreliable for public shares (server returns is_guest=false for
    // anonymous viewers), so the recipient UI keys its viral-landing chrome off
    // this flag instead. Captured BEFORE the cookie_touch rebind below.
    let isAuthenticated = false;
    let { regsid } = this.input.get(Attr.cookie);
    if (regsid) {
      let u = await this.yp.await_proc("cookie_retrieve_user", regsid);
      if (u && ![ID_NOBODY, guest_id].includes(u.id)) {
        if (u.profile) {
          user.profile = u.profile;
          user.uid = u.id;
          user.id  = u.id;
          isAuthenticated = true;
        }
      }
    }

    // Sanitized copy of info for the gate responses. The recipient gate card
    // needs display fields (title, sender, require_email, require_password,
    // recipient_email) but must NOT receive secrets — strip the password hash
    // and the allowed-emails list before sending to an unauthenticated viewer.
    // Both gate statuses carry it so the unified gate card (email and/or
    // password) can render the right fields in one step.
    const safeInfo = { ...info };
    delete safeInfo.password_hash;
    delete safeInfo.allowed_emails;

    // Email gate: active for restricted shares (require_email=1 via v2 allowed_emails,
    // or legacy recipient_email set). Skipped entirely for public shares.
    const emailGateActive = !!info.require_email || !!(info.recipient_email);
    let submittedEmail = (this.input.get(Attr.email) || '').toLowerCase().trim();

    if (emailGateActive) {
      // Auto-grant logged-in Drumee members whose account email matches the share
      if (!submittedEmail && user.id && ![ID_NOBODY, guest_id].includes(user.id)) {
        try {
          const p = typeof user.profile === 'string' ? JSON.parse(user.profile) : (user.profile || {});
          const accountEmail = (p.email || '').toLowerCase().trim();
          if (accountEmail && _emailMatchesAllowed(accountEmail, info)) {
            submittedEmail = accountEmail;
          }
        } catch (e) {
          this.warn('[dmz.login] secure_share auto-grant parse failed:', e && e.message);
        }
      }

      if (!submittedEmail) {
        return this.output.data({ ...safeInfo, status: 'REQUIRED_EMAIL', is_secure: 1 });
      }

      if (!_emailMatchesAllowed(submittedEmail, info)) {
        return this.output.data({ status: 'EMAIL_MISMATCH', is_secure: 1 });
      }
    }

    // Password gate — only evaluated after email gate passes (or was skipped for public shares)
    if (info.require_password) {
      const submittedPassword = (this.input.get(Attr.password) || '').trim();
      if (!submittedPassword) {
        return this.output.data({ ...safeInfo, status: 'REQUIRED_PASSWORD', is_secure: 1 });
      }
      if (!verifySecureSharePassword(submittedPassword, storedPasswordHash)) {
        try { await this.yp.await_proc('secure_share_increment_attempts', token); } catch (e) {}
        // SP locks when new count >= 3; info.failed_attempts is the pre-increment value
        const attemptsUsed      = (info.failed_attempts || 0) + 1;
        const attemptsRemaining = Math.max(0, 3 - attemptsUsed);
        // Token is now locked — tell the client immediately instead of making them
        // submit again only to receive TICKET_LOCKED on the next request.
        if (attemptsRemaining === 0) {
          return this.output.data({ status: 'TICKET_LOCKED', is_secure: 1 });
        }
        return this.output.data({ status: 'WRONG_PASSWORD', is_secure: 1, attempts_remaining: attemptsRemaining });
      }
    }

    // Valid access — log it and notify sender in real time
    const actor_id = (guest_id === user.id) ? null : (user.id || null);
    try {
      const track = await this.yp.await_proc('secure_share_access_log', token, actor_id, this.input.get(Attr.socket_id));
      // v2: also record a per-visit access event (entered_at / last_seen_at) backing
      // the "View access list" table. Isolated in its own try so a failure can never
      // block the access counter, sender notification, or session binding below.
      try {
        await this.yp.await_proc(
          'secure_share_log_access_event',
          token, submittedEmail || null, actor_id, this.input.get(Attr.socket_id)
        );
      } catch (e) {
        this.warn('[dmz.login] secure_share access_event failed:', e && e.message);
      }
      const row   = toArray(track)[0] || {};
      // The access counter always updates above; the SENDER notification only
      // fires when the share has notify_on_open enabled (default 1; legacy rows
      // without the field keep notifying). info comes from secure_share_info.
      if (row.hub_id && info.notify_on_open != 0) {
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
      // Title must reflect the SHARED node (e.g. subfolder "vb"), not the workspace
      // root. secure_share_info returns the hub name as title; override it with the
      // node's own name. mfs_node_attr.filename = user_filename for a non-root node,
      // or the hub name for the root/hub node — correct in both cases. Capture before
      // the file→pid swap below so a file share titles on the file, not its parent.
      if (nodeAttr.filename) info.title = nodeAttr.filename;
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

    // Resolve the granted capability SET. v2 stores an independent set
    // (`capabilities`, e.g. ["can_download","can_chat","can_edit"]); legacy rows
    // fall back to the single `permission_level` enum. secure_share_info already
    // derives the array for legacy rows, but we re-derive defensively here in
    // case the JSON column arrives as a string from the driver.
    let caps = [];
    const rawCaps = info.capabilities;
    if (Array.isArray(rawCaps)) {
      caps = rawCaps.slice();
    } else if (typeof rawCaps === 'string' && rawCaps.trim()) {
      try { const p = JSON.parse(rawCaps); if (Array.isArray(p)) caps = p; } catch (e) { /* ignore */ }
    }
    if (!caps.length && info.permission_level && info.permission_level !== 'can_view') {
      caps = [info.permission_level];
    }

    // If the guest previously had an approved access request, that grant
    // REPLACES the base set (the sender deliberately chose what to grant).
    // The grant is keyed by requester_email. The email gate provides submittedEmail,
    // but a PUBLIC share has no gate — so a logged-in recipient who requested access
    // (the Request Access popup prefills their account email as requester_email) had
    // no email to match on refresh, and the approved grant was never applied → the
    // download/chat stayed gated even after approval. Fall back to the account email.
    let grantEmail = submittedEmail;
    // Explicit grant-lookup email replayed by the recipient UI from localStorage
    // (the email they sent the Request Access with). Used ONLY to match an approved
    // grant — never the email gate (the gate uses submittedEmail) — so it cannot let
    // anyone bypass a restricted share; it only resolves a grant already issued to
    // that exact email. Lets anonymous (incognito) recipients keep access after a
    // refresh, where there is no account email to key on.
    if (!grantEmail) {
      const ge = (this.input.get('grant_email') || '').toLowerCase().trim();
      if (ge) grantEmail = ge;
    }
    if (!grantEmail && isAuthenticated && user.profile) {
      try {
        const p = typeof user.profile === 'string' ? JSON.parse(user.profile) : user.profile;
        grantEmail = (p.email || '').toLowerCase().trim();
      } catch (e) { /* ignore */ }
    }
    if (grantEmail) {
      try {
        const grantRow = toArray(
          await this.yp.await_proc('secure_share_get_access_grant', token, grantEmail)
        )[0] || {};
        if (grantRow.granted_level) {
          info.permission_level = grantRow.granted_level;
          caps = (grantRow.granted_level === 'can_view') ? [] : [grantRow.granted_level];
        }
      } catch (e) {
        this.warn('[dmz.login] secure_share_get_access_grant failed:', e && e.message);
      }
    }

    // Detect whether the viewer is a real workspace MEMBER (or the owner) of the
    // shared node — resolved via mfs_access_node, whose `privilege` is the
    // authoritative user_permission(uid,node) and returns 0 for a non-member.
    // is_member is used ONLY to drop the guest chrome (the viral landing / "request
    // access" banner) for members — it does NOT elevate the share's capabilities.
    // The SHARE'S configured level always determines the functional experience, so a
    // view-only link presents view-only even to the owner/a member (e.g. previewing
    // their own link); a member who wants full access uses their own desk. Uses the
    // real recipient uid (resolved above), not the creator-bound session.
    let is_member = 0;
    if (isAuthenticated && user.id) {
      try {
        const accessRows = await this.yp.await_proc(
          'forward_proc', info.hub_id, 'mfs_access_node', `'${user.id}','${info.nid}'`
        );
        const memberPriv = parseInt((toArray(accessRows)[0] || {}).privilege, 10) || 0;
        if (memberPriv > 0) is_member = 1;
      } catch (e) {
        this.warn('[dmz.login] secure_share member access check failed:', e && e.message);
      }
    }

    // Translate the capability set to the privilege bitmask the UI uses for
    // show/hide decisions (_K.privilege in lex/constants.js: read=3, download=7,
    // write=15 — CUMULATIVE masks). We OR each capability's cumulative mask onto
    // the read/view baseline so existing canDownload()/canUpload() bit checks keep
    // working unchanged. can_chat carries NO extra privilege bit (permission.chat
    // overlaps read, so it can't be represented independently in the bitmask, and
    // mapping it to download was the old bug that leaked the download button); it
    // is surfaced as the explicit `can_chat` flag that the recipient UI gates the
    // chat tab on. Placed after the spreads so it always wins over ...user/...info.
    const CAP_PRIVILEGE = { can_view: 0b0000011, can_download: 0b0000111, can_edit: 0b0001111 };
    let privilege = 0b0000011; // read/view baseline
    for (const c of caps) privilege |= (CAP_PRIVILEGE[c] || 0);

    const hasCap = (c) => (caps.indexOf(c) !== -1 ? 1 : 0);

    return this.output.data({
      ...user,
      ...info,
      is_secure        : 1,
      status           : 'TICKET_OK',
      validity         : 'TICKET_OK',
      permission_level : info.permission_level || 'can_view',
      capabilities     : caps,
      can_download     : hasCap('can_download'),
      can_chat         : hasCap('can_chat'),
      can_edit         : hasCap('can_edit'),
      privilege,
      guest_id         : info.uid || guest_id,
      area,
      is_guest,
      // Reliable auth-state flags for the recipient UI (additive — does not change
      // any existing field). is_authenticated: the viewer has their own logged-in
      // session (vs anonymous). is_owner: that account is the share creator.
      is_authenticated : isAuthenticated ? 1 : 0,
      is_owner         : (isAuthenticated && String(user.id) === String(info.creator_id)) ? 1 : 0,
      // is_member: the viewer already has standing ACL on the shared node (a real
      // workspace member). The recipient UI uses it to suppress the guest "limited
      // access" banner / viral chrome for members.
      is_member        : is_member,
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
   * Submit a request for elevated access to a secure share.
   */
  async request_access() {
    const VALID_LEVELS = ['can_download', 'can_chat', 'can_edit'];
    const token          = this.input.need(Attr.token);
    const rawEmail       = (this.input.get(Attr.email) || '').toLowerCase().trim();
    const requestedLevel = (this.input.get('requested_level') || '').trim();
    const message        = (this.input.get('message') || '').trim() || null;

    if (!rawEmail || !rawEmail.includes('@')) {
      return this.output.data({ status: 'INVALID_EMAIL' });
    }
    if (!VALID_LEVELS.includes(requestedLevel)) {
      return this.output.data({ status: 'INVALID_LEVEL' });
    }

    const args = { token_id: token, requester_email: rawEmail, requested_level: requestedLevel };
    if (message) args.message = message;

    const row = toArray(
      await this.yp.await_proc('secure_share_create_access_request', args)
    )[0] || {};

    if (!row.id || row.status === 'INVALID_TOKEN') {
      return this.output.data({ status: 'INVALID_TOKEN' });
    }

    // Notify ONLY the share creator (their desk activity panel), not the whole hub.
    // A hub-wide broadcast (entity_sockets) carries requester_email + the free-form
    // message to every other recipient who has the share open — a privacy leak.
    if (row.creator_id) {
      try {
        const recipients = await this.yp.await_proc('user_sockets', row.creator_id);
        await RedisStore.sendData(
          this.payload(
            {
              event           : 'secure_share_access_requested',
              request_id      : row.id,
              token_id        : token,
              hub_id          : row.hub_id,
              node_id         : row.node_id,
              requester_email : rawEmail,
              requested_level : requestedLevel,
              message,
            },
            { service: 'share.track_event' }
          ),
          recipients
        );
      } catch (e) {
        this.warn('[dmz.request_access] notify creator failed:', e && e.message);
      }
    }

    return this.output.data({ status: 'REQUEST_SENT', request_id: row.id });
  }

  /**
   *
   */
  notification_list() {
    this.output.data([]);
  }

}


module.exports = __dmz;
