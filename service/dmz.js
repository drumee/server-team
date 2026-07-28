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
const { Attr, Constants, Messenger, Cache, RedisStore, toArray, sysEnv } = require("@drumee/server-essentials");
const { Mfs } = require('@drumee/server-core');
const { isEmpty } = require('lodash');
const {
  ID_NOBODY
} = Constants;
const { verifyPassword: verifySecureSharePassword } = require('./lib/secure-share-password');
const Jwt = require('jsonwebtoken');
const { resolve: _resolvePath } = require('path');
// Shared `drumee` secret, loaded ONCE at module load, used to sign a short-lived
// owner-edit assertion (see _loginSecureShare). The euroffice editor verifies it with
// the same secret. Best-effort: if the secret file is unavailable the feature is simply
// disabled — the secure-share login path is never affected.
let _ssOwnerSecret = null;
try {
  const _secPath = _resolvePath(sysEnv().credential_dir, 'crypto/secret.json');
  _ssOwnerSecret = JSON.parse(require('fs').readFileSync(_secPath, 'utf8')).drumee || null;
} catch (e) { /* owner_edit_token disabled when the secret is unavailable */ }

// Recipients the sender cut off this link individually (secure_share.revoke_email).
// Deny-only: it can refuse an address, never admit one, so it cannot widen access
// however the allow rule was written. Kept separate from allowed_emails so the
// sender's own configuration is never rewritten — and because emptying an
// allow-list would make the gate below read it as "no restriction".
function _isDeniedEmail(email, info) {
  if (!email || !info || !info.denied_emails) return false;
  let list = null;
  try {
    const parsed = typeof info.denied_emails === 'string'
      ? JSON.parse(info.denied_emails)
      : info.denied_emails;
    if (Array.isArray(parsed) && parsed.length > 0) list = parsed;
  } catch (e) {
    // Malformed JSON: fail CLOSED is not an option (it would lock out every
    // recipient of this link), so treat it as no denials — same posture as the
    // allow-list parse below, which is the pre-existing behaviour.
    return false;
  }
  if (!list) return false;
  const target = String(email).toLowerCase().trim();
  return list.some(entry => String(entry || '').toLowerCase().trim() === target);
}

function _emailMatchesAllowed(email, info) {
  // A denied recipient is refused before any allow rule is considered — this is
  // the single point both gate call sites (signed-in and anonymous) go through.
  if (_isDeniedEmail(email, info)) return false;
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
          delete res.denied_emails;
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
    // Same reason as allowed_emails: who the sender revoked is sender-only data,
    // and must never reach a viewer sitting at the gate.
    delete safeInfo.denied_emails;

    // Email gate: active for restricted shares (require_email=1 via v2 allowed_emails,
    // or legacy recipient_email set). Skipped entirely for public shares.
    const emailGateActive = !!info.require_email || !!(info.recipient_email);
    let submittedEmail = (this.input.get(Attr.email) || '').toLowerCase().trim();

    if (emailGateActive) {
      const isOwnerViewer = isAuthenticated && String(user.id) === String(info.creator_id);
      if (isOwnerViewer) {
        // The creator previewing their OWN share is not a recipient — skip the
        // recipient email gate (their own account need not be on the allow-list).
        // Mirrors the pre-existing is_owner handling in the response below; without
        // this the strict check below would lock an owner out of their own share.
      } else if (isAuthenticated) {
        // Restricted share opened by a LOGGED-IN (non-owner) viewer: gate STRICTLY
        // on the VERIFIED account email. A signed-in user must NOT type a different
        // invited address to get in — the only identity that counts is the one they
        // authenticated as (product rule: "only the invited email; sign in / sign
        // up as that address"). Using the account email (never the client-supplied
        // value) also closes the soft-gate bypass where a def@ session could submit
        // abc@ to pass (the typed email was never ownership-verified). A logged-in
        // viewer whose own account is not on the allow-list is refused here; if they
        // are a workspace member they still reach the content via their own desk.
        let accountEmail = '';
        try {
          const p = typeof user.profile === 'string' ? JSON.parse(user.profile) : (user.profile || {});
          accountEmail = (p.email || '').toLowerCase().trim();
        } catch (e) {
          this.warn('[dmz.login] secure_share account email parse failed:', e && e.message);
        }
        if (!accountEmail || !_emailMatchesAllowed(accountEmail, info)) {
          return this.output.data({ status: 'EMAIL_MISMATCH', is_secure: 1 });
        }
        submittedEmail = accountEmail;
      } else {
        // ANONYMOUS viewer: existing typed-email gate (soft — no ownership proof).
        // Verified-identity enforcement for anonymous recipients arrives with the
        // capped guest-principal follow-up; left unchanged here to avoid a flow
        // regression.
        if (!submittedEmail) {
          return this.output.data({ ...safeInfo, status: 'REQUIRED_EMAIL', is_secure: 1 });
        }
        // "Require email to view" with no allow-list (Mode 1) accepts ANY email, so the
        // submitted value must at least be a real email format — _emailMatchesAllowed
        // returns true for any string when there is no list. The recipient UI already
        // validates the format; this is the server-side guard against a crafted call.
        // (List/legacy shares implicitly enforce format via the exact/domain match below.)
        if (!submittedEmail.isEmail()) {
          return this.output.data({ status: 'EMAIL_MISMATCH', is_secure: 1 });
        }
        if (!_emailMatchesAllowed(submittedEmail, info)) {
          return this.output.data({ status: 'EMAIL_MISMATCH', is_secure: 1 });
        }
      }
    }

    // Password gate — only evaluated after email gate passes (or was skipped for public shares)
    if (info.require_password) {
      const submittedPassword = (this.input.get(Attr.password) || '').trim();
      if (submittedPassword) {
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
        // Correct password — remember it for THIS share session (the hub-cookie sid,
        // which page.js persists and shares across the browser's tabs) so a later load
        // doesn't re-prompt. Notably: after the recipient clicks Login, the share
        // re-opens in a NEW tab that shares this same hub cookie, so the gate is skipped
        // there instead of asking for the password a second time. Best-effort.
        try { await this._markSharePasswordOk(token); } catch (e) { /* non-fatal */ }
      } else {
        // No password submitted — allow ONLY if this same session already proved it.
        let alreadyOk = false;
        try { alreadyOk = await this._isSharePasswordOk(token); } catch (e) { alreadyOk = false; }
        if (!alreadyOk) {
          return this.output.data({ ...safeInfo, status: 'REQUIRED_PASSWORD', is_secure: 1 });
        }
      }
    }

    // Both gates are behind us, so nothing downstream needs the recipient lists —
    // and the success response below spreads `info` straight to the viewer. Drop
    // them here so a recipient who passes the gate can enumerate neither who else
    // was invited nor who the sender revoked.
    //
    // allowed_emails was already stripped from the gate responses (safeInfo) and
    // from the unauthenticated info() probe, but NOT from this success path, so
    // every recipient of a multi-address link received the whole invite list.
    delete info.allowed_emails;
    delete info.denied_emails;

    // Valid access — log it and notify sender in real time.
    // Attribute the open to the viewer's OWN account ONLY when they are genuinely
    // authenticated. An anonymous recipient runs in the creator-bound guest session
    // (user.id === creator_id), so the previous `guest_id === user.id` check logged
    // the SENDER as the visitor — which then surfaced the sender's email in the
    // access list. Anonymous viewers are logged as an anonymous open (no actor).
    const actor_id = isAuthenticated ? (user.id || null) : null;
    // Recipient email for the access list + the "opened" notification. A password-only
    // share carries no submitted email, so fall back to the authenticated account's
    // own email (resolved from its regsid above) — never the creator's.
    let _recipientEmail = submittedEmail || null;
    // The creator previewing their OWN share is not a recipient — don't fall back to
    // their account email (it would persist on the access event and show the sender as
    // a recipient, which the list_access_events creator skip can't undo once stored).
    if (!_recipientEmail && isAuthenticated && user.profile && String(user.id) !== String(info.creator_id)) {
      try {
        const _p = (typeof user.profile === 'string') ? JSON.parse(user.profile) : user.profile;
        _recipientEmail = (_p && _p.email) ? String(_p.email).toLowerCase().trim() : null;
      } catch (e) { /* ignore malformed profile */ }
    }
    try {
      const track = await this.yp.await_proc('secure_share_access_log', token, actor_id, this.input.get(Attr.socket_id));
      // v2: also record a per-visit access event (entered_at / last_seen_at) backing
      // the "View access list" table. Isolated in its own try so a failure can never
      // block the access counter, sender notification, or session binding below.
      try {
        await this.yp.await_proc(
          'secure_share_log_access_event',
          token, _recipientEmail, actor_id, this.input.get(Attr.socket_id)
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
              recipient_email : _recipientEmail,
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

    // NOTE: the session cookie_touch (principal binding) is DEFERRED to after the
    // capability set + member privilege are resolved below, so a logged-in recipient
    // can be bound to their OWN capped principal instead of the share creator. See
    // the binding block near the end of this method. Nothing between here and there
    // depends on the bound session (all DB calls pass explicit hub_id/uid args).

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
      // Only remap a real FILE to its parent. Containers — folder, hub, AND the
      // workspace 'root' node (its filetype is 'root', not 'folder'/'hub') — must
      // keep their own nid so show_node_by lists their children and the folder
      // node-grant below is issued on the shared node. Without exempting 'root',
      // a workspace-root share (Manage access) was treated as a file → file_nid set
      // → the recipient grant branch skipped → recipient had 0 permission on every
      // child → blank list (uploads still wrote via the token path).
      if (nodeAttr.filetype && nodeAttr.filetype !== 'folder' && nodeAttr.filetype !== 'hub' && nodeAttr.filetype !== 'root' && nodeAttr.pid) {
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

    // If the guest previously had an approved access request, that grant ADDS to
    // the share's base capabilities — it does NOT replace them. The Request Access
    // popup grants one level at a time, so a chat-only share whose recipient is
    // later approved for download must end up with chat AND download.
    // The grant is keyed by requester_email. The email gate provides submittedEmail,
    // but a PUBLIC share has no gate — so a logged-in recipient who requested access
    // (the Request Access popup prefills their account email as requester_email) had
    // no email to match on refresh, and the approved grant was never applied → the
    // download/chat stayed gated even after approval. Fall back to the account email.
    let grantEmail = submittedEmail;
    // Authenticated viewers: key the grant lookup to their OWN account email, and
    // NEVER a client-supplied grant_email. Otherwise one signed-in account could
    // replay another requester's approved email (the response event even carries
    // requester_email) to claim that grant. Account email takes precedence; the
    // client value is ignored for an authenticated session.
    if (!grantEmail && isAuthenticated && user.profile) {
      try {
        const p = typeof user.profile === 'string' ? JSON.parse(user.profile) : user.profile;
        grantEmail = (p.email || '').toLowerCase().trim();
      } catch (e) { /* ignore */ }
    }
    // ANONYMOUS (incognito) viewers only: fall back to the email they requested with,
    // replayed by the UI from localStorage, so they keep access after a refresh (no
    // account email to key on). It only resolves a grant already issued to that exact
    // email and never affects the email gate (which uses submittedEmail).
    // ⚠ KNOWN RESIDUAL: on a PUBLIC link this is replayable — a determined anonymous
    // viewer who learns another requester's approved email could claim that grant.
    // Fully closing it needs the anonymous guest-identity fix (see
    // secure-share-enforcement-gap.md). Guarded to !isAuthenticated so it can never
    // override an authenticated session's own account email.
    if (!grantEmail && !isAuthenticated) {
      const ge = (this.input.get('grant_email') || '').toLowerCase().trim();
      if (ge) grantEmail = ge;
    }
    if (grantEmail) {
      try {
        const grantRows = toArray(
          await this.yp.await_proc('secure_share_get_access_grant', token, grantEmail)
        );
        // UNION every approved grant onto the share's base caps (do not overwrite —
        // that dropped the chat cap when a chat-share recipient was approved for
        // download). The SP returns all approved grants for this recipient, latest
        // first; older deployments returned only the latest, and the union is
        // correct for both. can_view carries no extra capability, so it is skipped.
        // granted_level is now a SET (comma-list) — a single approval may grant
        // several levels at once (multi-select request). Split and union each.
        for (const g of grantRows) {
          const raw = g && g.granted_level;
          if (!raw) continue;
          for (const lvl of String(raw).split(',').map(s => s.trim()).filter(Boolean)) {
            if (lvl === 'can_view') continue;
            if (caps.indexOf(lvl) === -1) caps.push(lvl);
          }
        }
        // permission_level is a legacy single-value display field — reflect the
        // latest approved grant (first row); the capabilities array above is the
        // authoritative set the recipient UI gates on.
        if (grantRows[0] && grantRows[0].granted_level) {
          info.permission_level = grantRows[0].granted_level;
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
    let memberPriv = 0;
    if (isAuthenticated && user.id) {
      try {
        const accessRows = await this.yp.await_proc(
          'forward_proc', info.hub_id, 'mfs_access_node', `'${user.id}','${info.nid}'`
        );
        memberPriv = parseInt((toArray(accessRows)[0] || {}).privilege, 10) || 0;
        if (memberPriv > 0) is_member = 1;
      } catch (e) {
        this.warn('[dmz.login] secure_share member access check failed:', e && e.message);
      }
    }

    // Distinguish a TRUE standing principal (real workspace member/owner, or a
    // manual collaborator grant) from a recipient who only holds their OWN prior
    // secure-share grant on this node. memberPriv above is the EFFECTIVE privilege
    // (user_permission), which resolves to the recipient's own node grant when they
    // are NOT a member — so memberPriv alone cannot tell the two apart. That is what
    // caused grant-clobber: a recipient who opened a lower link first looked like a
    // member (memberPriv>0) and was never re-granted the higher link's level.
    // user_permission() returns a '*' membership BEFORE any node grant, so for a
    // non-member memberPriv EQUALS their own node-grant priv, while a real member's
    // memberPriv EXCEEDS it. Read the directly-stored grant row to compare.
    // The comparison must read the grant on the SAME node memberPriv was measured
    // on (info.nid above): the shared node itself for a folder share, its PARENT for
    // a file share (info.nid is remapped to the parent at ~L497). Reading node_id for
    // a file share would compare cross-node and mis-read a file-share recipient as a
    // member, because the file-share fix below leaves them a PERSISTENT read-only
    // 'root' grant on that parent — so every LATER file share in the same folder was
    // treated as standing, skipped the node grant, and rendered blank (Lexis/Tina
    // prod report 2026-07-28). Fail-safe: on any error treat as no direct grant,
    // which collapses hasStanding to the prior memberPriv>0 behaviour.
    // NOTE permission_get_direct's signature is (resource, entity) — passing them
    // the other way round silently matches nothing and makes this check inert.
    let ownShareGrant = 0;
    let hasStanding = memberPriv > 0;
    if (isAuthenticated && user.id && info.nid && info.node_id) {
      const readDirectGrant = async (resource_id) => {
        try {
          return toArray(await this.yp.await_proc(
            'forward_proc', info.hub_id, 'permission_get_direct', `'${resource_id}','${user.id}'`
          ))[0] || null;
        } catch (e) {
          this.warn('[dmz.login] secure_share permission_get_direct failed:', e && e.message);
          return null;
        }
      };
      const isShareGrant = (row) => !!row &&
        String(row.message || '').indexOf('Secure share access') === 0;
      const rowPriv = (row) => (row ? (parseInt(row.permission, 10) || 0) : 0);

      // standing = access from anything OTHER than their own secure-share grant:
      //  - memberPriv exceeds their own grant (a '*' membership wins in user_permission), OR
      //  - a non-secure-share direct row exists (a manual collaborator grant — never touch it).
      const standing = await readDirectGrant(info.nid);
      const standingIsOwn = isShareGrant(standing);
      hasStanding = (memberPriv > (standingIsOwn ? rowPriv(standing) : 0)) ||
        (!!standing && !standingIsOwn && rowPriv(standing) > 0);

      // UPGRADE-ONLY baseline: the recipient's own prior secure-share privilege on
      // the SHARED node (=== info.nid for a folder share; the file for a file share),
      // so opening a lower link after a higher one never downgrades them.
      const own = String(info.node_id) === String(info.nid)
        ? standing
        : await readDirectGrant(info.node_id);
      if (isShareGrant(own)) ownShareGrant = rowPriv(own);
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

    // ---------------------------------------------------------------------
    // Bind the share session to its operating principal.
    //
    // Historically this bound the session to the share CREATOR so the
    // authenticated media stack could resolve the shared node — but that made the
    // recipient operate with the creator's FULL privilege (the enforcement gap:
    // nested folders exposed owner capabilities; write/invite/call/manage all ran
    // as the owner). Instead, for a LOGGED-IN recipient of a RESTRICTED FOLDER
    // share, bind to the recipient's OWN uid and give them a node-scoped grant at
    // the share's CAPPED privilege. The central ACL then enforces exactly the
    // share's level at every depth (grants inherit to descendants), and grantPriv
    // <= 15 means admin(16)/owner(32) ops (invite, manage-access, call) are denied
    // automatically.
    //
    // grantPriv uses the STORED cumulative scale (lib/privilege.js): read=3,
    // write=7, delete/modify=15. can_chat needs write(7) — chat.post asks 'write';
    // can_edit needs delete(15) — move/rename/trash ask 'delete'. Download is
    // read-level (3), separated from view by the media.js download guard.
    //
    // Scope is deliberately tight to avoid regressions:
    //   - any AUTHENTICATED recipient (PUBLIC or restricted share). Per the standard
    //     share-link model, a logged-in viewer gets the link's caps and must request
    //     access to elevate (they are already signed in → the request-access flow).
    //     ANONYMOUS viewers stay creator-bound until the capped guest principal lands
    //     (then they too are capped to the link's level; elevating requires login).
    //   - BOTH folder and single-FILE shares: the node-scoped grant is issued on the
    //     shared node (info.node_id — the file itself for a file share; only info.nid
    //     was remapped to the parent for the listing). The recipient then operates as
    //     THEMSELVES for chat / downloads / notifications instead of the creator (Lexis
    //     prod issue #4). File-share VIEWING keeps working because media.show_node_by
    //     is src=anonymous + token-scoped: it lists the parent and hard-filters to the
    //     shared file (see media.js `_secureShareListTarget`), so no parent ACL is
    //     needed and no sibling is exposed. This also CLOSES the old sibling/nested
    //     over-exposure that the creator-bound file session had.
    //   - member/owner already hold standing ACL → bind to self, NO extra grant.
    //   - a non-member gets the node-scoped grant; if the grant FAILS we keep the
    //     creator binding (still CLAMPED by the ceiling) so the share degrades safely.
    // The share is guaranteed valid here (TICKET_REVOKED/EXPIRED/LOCKED returned
    // at the top of this method).
    // ---------------------------------------------------------------------
    let bindUid = info.creator_id;
    // Privilege ceiling to stamp on THIS share session (enforced by router/rest):
    // anonymous = read-only (3); a signed-in NON-member recipient gets their cap level
    // (view/download 3, chat 7) so the gate clamps the grant's over-reach; edit (15) and
    // owner/member get NO ceiling (full / own access). null = no clamp.
    let ceilingToStamp = !isAuthenticated ? 3 : null;
    if (isAuthenticated && user.id && info.node_id) {
      if (hasStanding || String(user.id) === String(info.creator_id)) {
        // Real member, manual collaborator, or owner — standing access independent
        // of any secure-share grant; operate as themselves. No extra grant. Any
        // stale ceiling from an earlier lower-level open on this reused sid is
        // cleared at the stamp site below (ceilingToStamp stays null here).
        bindUid = user.id;
      } else {
        // Pure recipient — holds only their own (or no) secure-share grant on this
        // node (the shared FILE or FOLDER, info.node_id). Grant capped node access,
        // then bind to their uid. UPGRADE-ONLY: max with any already-earned
        // secure-share priv so opening a lower link after a higher one never
        // downgrades, and re-opening the same link is a no-op REPLACE.
        let newCapPriv = 0b0000011;                                    // read / view / download
        if (caps.indexOf('can_chat') !== -1) newCapPriv = 0b0000111;   // write — chat.post
        if (caps.indexOf('can_edit') !== -1) newCapPriv = 0b0001111;   // delete/modify — edit
        const grantTarget = Math.max(newCapPriv, ownShareGrant);
        // Clamp view/download (3) and chat (7) recipients with a session ceiling so
        // router/rest denies file-writes (the node grant alone can't — chat grant 7
        // carries the write bit). Edit (15) = full edit intended → no ceiling. Set
        // BEFORE the grant so a grant FAILURE degrades to a CLAMPED creator binding,
        // never an un-clamped creator session.
        ceilingToStamp = grantTarget < 0b0001111 ? grantTarget : null;
        try {
          const db_name = await this.yp.await_func('get_db_name', info.hub_id);
          if (db_name) {
            await this.yp.await_proc(
              `${db_name}.permission_grant`,
              info.node_id, user.id, 0, grantTarget, 'system', 'Secure share access'
            );
            // FILE share: the grant above lands on the file (info.node_id), but
            // media.show_node_by lists the file's PARENT (info.nid, remapped ~L455).
            // show_node_by is src=anonymous, yet its ACL gate resolves the caller's
            // real user_permission on that parent BEFORE the worker body runs — and a
            // logged-in NON-member has 0 there (the file grant does not confer parent
            // access), so the listing is DENIED → 403 → the recipient sees no file.
            // (Anonymous escapes this: it stays creator-bound; members have standing;
            // folder shares grant the listed node itself.) Grant the recipient a
            // READ-ONLY, NON-INHERITING grant on the parent so the gate passes without
            // exposing siblings:
            //   * assign_via='root' makes parent_permission() treat this grant as 0 for
            //     CHILDREN (its anchor CASEs 'root' → 0), so siblings' user_permission
            //     stays 0 → no sibling is listable or directly reachable. Only
            //     parent_permission consumes assign_via='root'; nothing else keys off it
            //     (membership is resource_id='*' + assign_via='system').
            //   * read-only bits only (grantTarget & 0b0000011) → never write/edit on
            //     the parent folder (defense-in-depth with the file-share write block).
            //   * media.show_node_by ALSO hard-filters to info.file_nid → belt & braces.
            // Gated on a real FILE share (info.file_nid set AND parent !== the file); a
            // no-op for folder/workspace shares, anonymous, members, and non-share desk.
            if (info.file_nid && info.nid && info.nid !== info.node_id) {
              await this.yp.await_proc(
                `${db_name}.permission_grant`,
                info.nid, user.id, 0, (grantTarget & 0b0000011), 'root', 'Secure share access'
              );
            }
            bindUid = user.id;            // rebind ONLY after the grant(s) succeed
          }
        } catch (e) {
          this.warn('[dmz.login] secure_share node grant failed; keeping creator binding (clamped):', e && e.message);
        }
      }
    }
    // ---------------------------------------------------------------------
    // SECURITY GUARD (hotfix 2026-07-10 — regsid hijack, Lexis prod issue #3).
    // The principal binding + ceiling below MUST only ever touch the share's
    // ISOLATED hub-cookie session (page.js gives a dmz/share page its own sid).
    // If this.input.sid() is instead the caller's `regsid` — the main_domain-scoped
    // AUTH cookie that app.drumee.com reads — then:
    //   * cookie_touch(uid=creator) would rebind the recipient's auth session to the
    //     share creator → they are logged into the CREATOR's account on the main
    //     domain (the reported account takeover); and
    //   * set_session_priv_ceiling would clamp the recipient's OWN account to
    //     read-only across the main domain.
    // This happened once share links were served from the neutral host
    // (share.<domain>), whose default-hub bootstrap skipped the page.js isolation so
    // this.input.sid() fell back to regsid. NEVER apply either op to the regsid
    // session: a share that ever resolves to it degrades (may not render) but can
    // never hijack or clamp the auth session. Isolated sessions (sid != regsid) are
    // completely unaffected — this is a no-op for every normal share open.
    const _activeSid = this.input.sid();
    const _isAuthSession = !!(regsid && _activeSid === regsid);
    if (_isAuthSession) {
      this.warn(
        '[dmz.login][SECURITY] secure_share bind skipped: DMZ session resolved to the main-domain regsid (would hijack/clamp the auth session)',
        { token, creator_id: info && info.creator_id, bindUid }
      );
    }

    // socket_id must be passed so entity_sockets() includes this guest socket in
    // hub broadcasts (e.g. secure_share_revoked). page.js ensures the hub cookie
    // has its own independent session id, so this never touches the authenticated
    // user's regsid row (belt-and-suspenders: the _isAuthSession guard above).
    if (bindUid && !_isAuthSession) {
      try {
        await this.yp.await_proc('cookie_touch', {
          sid       : this.input.sid(),
          uid       : bindUid,
          socket_id : this.input.get(Attr.socket_id)
        });
      } catch (e) {
        this.warn('[dmz.login] secure_share cookie_touch failed:', e && e.message);
      }
    }

    // Stamp the session privilege ceiling computed above (read-only 3 / chat 7), bound
    // to bindUid. get_session_priv_ceiling() returns it ONLY while cookie.uid still
    // equals ceiling_uid, so it self-clears if an anonymous visitor later signs up (uid
    // changes). router/rest enforces it: read-only (3) denies ALL mutations incl
    // channel.post; chat (7) additionally PERMITS channel.post (text chat) while still
    // denying file-writes/calls/invite. The ceiling lands on THIS share session's sid
    // (the hub cookie — page.js gives it an independent sid), so a signed-in recipient's
    // main account (regsid) is never clamped. Owner/member/edit → ceilingToStamp null →
    // no clamp. Best-effort; on failure we keep the prior (un-clamped) binding.
    //
    // Set the ceiling when there is a real one (3/7); otherwise CLEAR any ceiling
    // left on this sid by an earlier lower-level open. get_session_priv_ceiling()
    // self-clears only on a uid CHANGE, so a same-uid elevation (view/chat → edit, or
    // a recipient who became a member) would otherwise keep a stale clamp and the
    // router would wrongly deny their writes. clear_session_priv_ceiling avoids
    // passing NULL to set_session_priv_ceiling's TINYINT `_ceiling` (the driver
    // serialises JS null to '' → ER_TRUNCATED_WRONG_VALUE). Best-effort: on failure
    // (e.g. the SP not yet applied to this DB) we keep the prior binding — fail-open
    // to today's behaviour, never blocking access.
    if (bindUid && !_isAuthSession) {
      try {
        if (ceilingToStamp != null) {
          await this.yp.await_proc('set_session_priv_ceiling', this.input.sid(), ceilingToStamp, bindUid);
        } else {
          await this.yp.await_proc('clear_session_priv_ceiling', this.input.sid());
        }
      } catch (e) {
        this.warn('[dmz.login] secure_share priv ceiling update failed:', e && e.message);
      }
    }

    // Genuine owner opening their own share link: mint a short-lived signed assertion
    // (verified by the euroffice editor with the same `drumee` secret) so the creator
    // can follow the link's edit permission. Minted ONLY for a genuinely authenticated
    // owner (isAuthenticated && uid===creator) — an anonymous creator-bound session
    // never receives it and cannot forge it, so the editor's anonymous-edit block is
    // not weakened. Best-effort; never blocks login.
    let owner_edit_token = null;
    if (isAuthenticated && String(user.id) === String(info.creator_id) && _ssOwnerSecret) {
      try {
        owner_edit_token = Jwt.sign(
          { kind: 'ss_owner', token, owner_uid: info.creator_id },
          _ssOwnerSecret,
          { expiresIn: '12h' }
        );
      } catch (e) {
        this.warn('[dmz.login] owner_edit_token sign failed:', e && e.message);
      }
    }

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
      owner_edit_token,
    });
  }

  /**
   * One-time-per-session password gate marker. Keyed by the share TOKEN + the
   * share-session sid (the hub cookie, which page.js persists and shares across the
   * browser's tabs), so once this session has entered the correct password it is not
   * re-prompted — including in the new tab the Login button opens, which carries the
   * same hub cookie. Stored in Redis with a bounded TTL; both helpers are best-effort
   * and fail CLOSED (a Redis error → no marker → the password is required), so they
   * can never grant access without a real password.
   */
  _sharePasswordKey(token) {
    const sid = this.input.sid();
    if (!token || !sid) return null;
    return `ss:pwok:${token}:${sid}`;
  }

  async _markSharePasswordOk(token) {
    const key = this._sharePasswordKey(token);
    if (!key) return;
    const client = RedisStore.getClient();
    if (!client) return;
    // 12h: long enough to cover the enter-password → login → return flow and a normal
    // working session, short enough that a shared browser re-asks later.
    await client.set(key, '1', { EX: 12 * 3600 });
  }

  async _isSharePasswordOk(token) {
    const key = this._sharePasswordKey(token);
    if (!key) return false;
    const client = RedisStore.getClient();
    if (!client) return false;
    const v = await client.get(key);
    return v === '1';
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
      // Same regsid-hijack guard as _loginSecureShare (defense-in-depth): NEVER rebind
      // the caller's main-domain auth cookie (regsid) to the legacy share identity.
      // Legacy links are per-vhost (isolated hub-cookie sid != regsid) so this normally
      // binds the share's own hub-cookie session; the guard only trips if a legacy share
      // ever resolves to regsid, in which case rebinding would clobber the auth session.
      if (regsid && this.input.sid() === regsid) {
        this.warn('[dmz.login][SECURITY] legacy dmz bind skipped: DMZ session resolved to the main-domain regsid', { share_uid: info.uid });
      } else {
        await this.yp.await_proc('cookie_touch', {
          sid: this.input.sid(), uid: info.uid
        });
      }
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
    // Multi-level: the recipient may request several permissions at once (e.g.
    // chat + edit). Accept a comma-list, normalise (dedupe, drop blanks), and
    // require every level to be valid. Stored into the requested_level SET column.
    const requestedLevels = Array.from(new Set(
      (this.input.get('requested_level') || '')
        .split(',').map(s => s.trim()).filter(Boolean)
    ));
    const requestedLevel  = requestedLevels.join(',');
    const message         = (this.input.get('message') || '').trim() || null;

    if (!rawEmail || !rawEmail.includes('@')) {
      return this.output.data({ status: 'INVALID_EMAIL' });
    }
    if (!requestedLevels.length || requestedLevels.some(l => !VALID_LEVELS.includes(l))) {
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
