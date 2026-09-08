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
const { secureShareCapPrivilege } = require('./lib/secure-share-write-guard');
const Jwt = require('jsonwebtoken');
const { resolve: _resolvePath } = require('path');
const { existsSync, readFileSync, statSync } = require('fs');
const { get_node_content } = require('@drumee/server-core/lib/utils/mfs');
const { PERM_READ } = Constants;
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


// Office extensions whose first page the server rasterizes into thumb.png.
// Mirrors the client's builtins/player/document/editable.js — keep in step.
const DOC_EDITABLE = new Set([
  'doc', 'docx', 'docm', 'dotx', 'dotm', 'odt', 'ott',
  'xlsx', 'xls', 'xlsm', 'xltx', 'xltm', 'xlsb', 'ods', 'ots',
  'pptx', 'ppt', 'pptm', 'potx', 'potm', 'ppsx', 'ppsm', 'odp', 'otp',
  'rtf',
]);

// A poster is never worth more than this many bytes on the wire. Sized so that
// video vignettes clear it — a 720p poster frame runs to ~120KB and is the most
// useful preview of the lot — while a pathologically large rendering does not.
const POSTER_MAX_BYTES = 192 * 1024;
// Nor is a whole listing's worth of them. A folder of videos spends this on the
// first few tiles; the rest fall back to icons rather than inflating the reply.
const POSTER_BUDGET_BYTES = 768 * 1024;

/**
 * Which already-rendered preview a row could show, in the order the desk grid
 * would prefer them. Mirrors media/core.js initURL(): a vector shows its own
 * source, a PDF or office document shows the rasterized first page (thumb),
 * everything else shows the vignette.
 *
 * The client picks exactly one format; this returns a short preference list
 * instead, because here the file must actually exist on disk and falling back
 * to the other rendering beats showing no poster at all.
 *
 * @returns {Array<[string, string, string]>} [format, extension, mime]
 */
function _posterCandidates(row) {
  const ext = String(row.ext || '').toLowerCase();
  const ftype = String(row.filetype || row.ftype || '').toLowerCase();

  // Containers have no content of their own; text-ish files are the two
  // negative gates in the client's imgCapable() and would only ever produce a
  // thumbnail of a wall of text.
  if (['folder', 'hub', 'root'].includes(ftype)) return [];
  if (/shell|script|text/.test(ftype)) return [];
  if (/^text/.test(String(row.mimetype || ''))) return [];

  if (ftype === 'vector' || ext === 'svg') return [['orig', 'svg', 'image/svg+xml']];
  if (ext === 'pdf' || DOC_EDITABLE.has(ext)) {
    return [['thumb', 'png', 'image/png'], ['vignette', 'png', 'image/png']];
  }
  return [['vignette', 'png', 'image/png'], ['thumb', 'png', 'image/png']];
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
      // This push is NOT a notification and must never be gated on
      // notify_on_open. Its only consumer is the sender's own sharing panel,
      // which refreshes its links list and access list on any
      // 'share.track_event' — the activity panel narrows the same service down
      // to 'secure_share_access_requested', so 'secure_share_opened' notifies
      // nobody.
      //
      // Notification suppression lives entirely in the two feed procedures,
      // which both carry `AND t.notify_on_open != 0`
      // (secure_share_open_feed and secure_share_list_open_notifications).
      // Gating here as well meant turning the toggle off also killed the live
      // refresh, so the access list only caught up on a reload or on reopening
      // the folder — while the requirement is the opposite: no notification,
      // but the access list keeps updating normally.
      //
      // It was invisible until now only because notify_on_open could not
      // actually be set to 0 before the panel toggle was made to persist.
      if (row.hub_id) {
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

    // is_member must mean "a TRUE standing principal", which is exactly hasStanding —
    // NOT the raw memberPriv > 0 it was first derived from above. memberPriv is the
    // EFFECTIVE privilege, so for a non-member it resolves to the recipient's OWN prior
    // secure-share grant: anyone who had ever opened any share in this workspace was
    // reported as a member, and the recipient UI therefore suppressed the "limited
    // access / Request access" banner for them permanently (Duy, prod 2026-07-29 —
    // duinguyen88 had zero '*' membership rows yet three leftover 'Secure share access'
    // grants, so user_permission returned 7 and is_member came back 1).
    // Same defect class the hasStanding block above was introduced to fix; is_member
    // simply never moved over to it. Real members keep is_member=1 (a '*' row makes
    // memberPriv exceed their own grant) and so do manual collaborators (a non-share
    // direct row); the creator is excluded separately via is_owner. is_member has a
    // single consumer — the banner condition in the recipient UI — and can only ever
    // become MORE restrictive here, so it cannot grant capability or affect any gate.
    is_member = hasStanding ? 1 : 0;

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

    // Bind the isolated cookie, its live socket, numeric ceiling, and durable share
    // marker in one YP transaction. A partial bind without ceiling_uid would turn a
    // later tokenless request into apparently normal authenticated traffic, so this
    // step fails the share login instead of preserving an unsafe half-written session.
    // The _isAuthSession guard above still prevents any write to the main regsid.
    if (bindUid && !_isAuthSession) {
      try {
        const contextResult = await this.yp.await_proc('set_session_share_context', {
          sid          : this.input.sid(),
          uid          : bindUid,
          socket_id    : this.input.get(Attr.socket_id),
          priv_ceiling : ceilingToStamp
        });
        // Mariadb.await_proc normally rethrows only when throwOnError is set;
        // the default wrapper swallows ordinary SQL failures and resolves
        // undefined (or a failed envelope).  A try/catch alone would therefore
        // report a successful login with an unmarked cookie.  Treat every
        // missing/failed result as a hard binding failure so the share remains
        // fail-closed even when the shared YP client is not configured to throw.
        if (contextResult == null || contextResult.failed === 1) {
          throw new Error('SECURE_SHARE_SESSION_CONTEXT_FAILED');
        }
      } catch (e) {
        this.warn('[dmz.login] secure_share session context update failed:', e && e.message);
        return this.exception.user('SECURE_SHARE_SESSION_CONTEXT_FAILED');
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

  /**
   * The row's already-rendered preview, as a data URI, or null.
   *
   * Why inline rather than a URL: the desk grid points `background-image` at
   * file/<format>/<nid>/<hub_id>, which is media.<format>, whose ACL resolves
   * an acl_check grant against the CALLER'S session — the very grant a
   * main-domain anonymous visitor cannot hold (see list_by_token's preamble).
   * Handing out a URL would therefore mean opening a second anonymous route
   * with its own authorisation story. Returning the bytes through the call
   * that is already token-gated adds no new surface at all: there is nothing
   * to guess, nothing to share on, and nothing reachable without the token.
   *
   * Deliberately serves ONLY what is already on disk and NEVER generates.
   * media._send_thumb() rasterizes on demand, which is fine behind a login but
   * would let an anonymous caller spend server CPU by the folder-full. A file
   * nobody has viewed yet simply shows its filetype icon.
   *
   * @param {object} row     listing row (nid, ext, filetype, mimetype, privilege)
   * @param {string} mfsRoot storage root of the share's hub
   * @param {{left: number}} budget mutable byte budget for the whole response
   * @returns {string|null} "data:image/png;base64,…"
   */
  _posterFor(row, mfsRoot, budget) {
    // nid indexes a directory name; it comes from the DB, but validate anyway
    // so a malformed row can never escape the storage root.
    const nid = String(row.nid || '');
    if (!mfsRoot || !/^[0-9a-f]{16}$/.test(nid)) return null;
    // A share that does not grant read does not get to show content either.
    if (!((row.privilege || 0) & PERM_READ)) return null;
    if (budget.left <= 0) return null;

    for (const [format, ext, mime] of _posterCandidates(row)) {
      let path;
      try {
        path = get_node_content({ ...row, id: nid, mfs_root: mfsRoot }, format, ext);
      } catch (e) {
        continue;
      }
      if (!path || !existsSync(path)) continue;
      let size;
      try {
        size = statSync(path).size;
      } catch (e) {
        continue;
      }
      // Video vignettes in particular can run to six figures. Over the cap the
      // icon is the better answer — do not spend the whole budget on one tile.
      if (!size || size > POSTER_MAX_BYTES || size > budget.left) return null;
      try {
        const b64 = readFileSync(path).toString('base64');
        budget.left -= size;
        return `data:${mime};base64,${b64}`;
      } catch (e) {
        this.debug(`[dmz.list_by_token] poster unreadable nid=${nid}:`, e.message);
        return null;
      }
    }
    return null;
  }

  /**
   * Read-only listing of a share's contents, authorised BY THE TOKEN ALONE.
   *
   * Why this exists: dmz.login refuses to bind a share identity onto a
   * main-domain session (see the regsid guard in login/_loginSecureShare — it
   * would hijack or clamp the caller's auth session). So a page served from the
   * main domain, such as the signin plugin's guest landing page, can never
   * obtain the grant that media.show_node_by requires, and every listing there
   * comes back 403. This answers from the token instead and NEVER touches the
   * caller's session: no cookie_touch, no grant, no identity change.
   *
   * It is deliberately narrow — it lists, and nothing else:
   *
   *   - the target is derived from the token, never from client input. A client
   *     cannot name a nid, so it cannot walk out of the share.
   *   - a share that is not plainly open is refused: revoked, expired, invalid,
   *     locked, password-gated or email-gated all return a status and NO items.
   *     This endpoint performs no gate, so it must not serve gated content.
   *   - a FILE share lists the parent folder hard-filtered to that one file, so
   *     siblings are never exposed (same remap as _loginSecureShare).
   *   - displayed privilege is the anonymous guest's, then clamped again by the
   *     share's own capability set.
   *   - the reply carries only what a viewer needs. secure_share_info also
   *     returns sender-only data (password_hash, allowed_emails, denied_emails,
   *     recipient_email, creator ids); none of it is echoed.
   *
   * Input:  token {String} required, page {Number} optional
   * Output: { status, title, nid, hub_id, items[] }
   */
  /**
   * Resolve a share from its token alone, refusing anything not plainly open.
   *
   * Shared by every *_by_token endpoint so they can never drift apart on what
   * counts as an acceptable share — a gate relaxed in one place but not the
   * other is exactly the bug this prevents.
   *
   * Two kinds of token exist and the caller cannot be expected to know which it
   * holds, so it resolves as dmz.login does: secure share first, legacy dmz
   * token second, both normalised to one shape.
   *
   * @param {string} token
   * @param {string} tag caller name, for log lines
   * @returns {Promise<{info: object, viewerUid: ?string, legacyPrivilege: ?number}
   *                  |{status: string}>} `status` set means REFUSED, no data.
   */
  async _shareByToken(token, tag) {
    let info = null;
    let viewerUid = null;
    let legacyPrivilege = null;
    try {
      const secure = toArray(await this.yp.await_proc('secure_share_info', token))[0];
      if (secure && !secure.failed && secure.creator_id) info = secure;
    } catch (e) {
      this.warn(`[${tag}] secure_share_info failed:`, e && e.message);
    }
    if (!info) {
      try {
        const legacy = await this.yp.await_proc('dmz_info_next', token);
        if (legacy && !legacy.failed && legacy.hub_id) {
          info = legacy;
          // A legacy share owns a guest user; view as that identity and cap by
          // the privilege the share itself grants.
          viewerUid = legacy.uid || legacy.guest_id || null;
          legacyPrivilege = legacy.privilege == null ? null : Number(legacy.privilege);
        }
      } catch (e) {
        this.warn(`[${tag}] dmz_info_next failed:`, e && e.message);
      }
    }
    if (!info || !info.hub_id || !(info.node_id || info.nid)) {
      return { status: 'TICKET_INVALID' };
    }
    if (info.validity && info.validity !== 'TICKET_OK') {
      return { status: info.validity };
    }
    // Gated shares are the gate's business, not these endpoints'.
    if (info.is_locked) return { status: 'TICKET_LOCKED' };
    if (info.require_password) return { status: 'REQUIRED_PASSWORD' };
    if (info.require_email) return { status: 'REQUIRED_EMAIL' };
    return { info, viewerUid, legacyPrivilege };
  }

  async list_by_token() {
    const token = this.input.need(Attr.token);
    const page = parseInt(this.input.use(Attr.page, 1), 10) || 1;
    const deny = (status) => this.output.data({ status, items: [] });

    const share = await this._shareByToken(token, 'dmz.list_by_token');
    if (share.status) return deny(share.status);
    const { info, viewerUid, legacyPrivilege } = share;

    // Listing target from the token. A real file → list its parent, filtered to
    // the file itself; a folder / hub / root → list it directly.
    let nid = info.node_id || info.nid;
    let file_nid = null;
    // Doubles as the storage-root lookup: every node physically in this hub
    // lives under the same mfs_root, so one probe covers the whole listing.
    // A row that is actually a cross-hub mount resolves to a path that does not
    // exist, which costs it its poster and nothing else.
    let mfs_root = null;
    try {
      const attr = toArray(
        await this.yp.await_proc('forward_proc', info.hub_id, 'mfs_node_attr', `'${nid}'`)
      )[0] || {};
      mfs_root = attr.mfs_root || null;
      if (attr.filetype && !['folder', 'hub', 'root'].includes(attr.filetype) && attr.pid) {
        file_nid = nid;
        nid = attr.pid;
      }
    } catch (e) {
      // Probe failed → treat the shared node as a container, and show no posters.
    }

    // The anonymous guest is the viewing identity: mfs_show_node_by uses the uid
    // for the per-row privilege/ownership columns, so this keeps the reply from
    // ever describing the creator's own access.
    const guest_id = viewerUid || Cache.getSysConf('guest_id');
    const params = JSON.stringify({ sort_by: 'rank', order: 'asc', page, type: 'all' });
    let rows;
    try {
      rows = toArray(await this.yp.await_proc(
        'forward_proc', info.hub_id, 'mfs_show_node_by',
        `'${nid}', '${guest_id}', '${params}'`
      ));
    } catch (e) {
      this.warn('[dmz.list_by_token] listing failed:', e && e.message);
      return deny('TICKET_INVALID');
    }

    if (file_nid) rows = rows.filter((r) => r && r.nid === file_nid);

    // Clamp each row's displayed privilege to the share's caps, as
    // media.show_node_by does. Anonymous caller → no recipient email.
    let capPriv = legacyPrivilege;
    if (capPriv == null) {
      try {
        capPriv = await secureShareCapPrivilege(this.yp, token, '');
      } catch (e) {
        capPriv = 0; // unknown caps → advertise none rather than the node's own
      }
    }

    // Whitelist the columns that leave the server. Everything the viewer does
    // not need — owner ids, db names, vhosts, metadata — stays here.
    // Posters are opt-in and cost far more than the rest of the reply put
    // together (a single video frame outweighs a whole folder of metadata), so
    // the default answer stays small and the caller asks for them on a second
    // pass once it has something on screen. Same endpoint, same token gate.
    const wantPosters = /^(1|true|yes)$/i.test(String(this.input.use('with_posters', '')));
    const budget = { left: wantPosters ? POSTER_BUDGET_BYTES : 0 };
    const items = rows.map((r) => {
      const privilege = capPriv == null ? r.privilege : (r.privilege || 0) & capPriv;
      const item = {
        nid: r.nid,
        filename: r.filename,
        ext: r.ext,
        ftype: r.ftype || r.filetype,
        filetype: r.filetype || r.ftype,
        mimetype: r.mimetype,
        filesize: r.filesize,
        ctime: r.ctime,
        mtime: r.mtime,
        privilege,
      };
      const poster = this._posterFor({ ...r, privilege }, mfs_root, budget);
      if (poster) item.poster = poster;
      return item;
    });

    this.output.data({
      status: 'TICKET_OK',
      title: info.title || '',
      nid,
      hub_id: info.hub_id,
      items,
    });
  }

  /**
   * Read-only workspace chat for a share, authorised BY THE TOKEN ALONE.
   *
   * The companion to list_by_token, and it exists for the same reason:
   * channel.messages is scope hub / src read, so its ACL resolves an acl_check
   * grant against the caller's session, which a main-domain anonymous visitor
   * cannot hold. This answers from the token and never touches the session.
   *
   * Scoped the same way the folder window scopes its team chat: messages carry
   * a metadata._scope_nid, and only those matching the SHARED node are
   * returned. That matters — a hub's channel table holds every folder's
   * conversation, so without the filter a share of one folder would leak the
   * chat of all the others.
   *
   * Legacy rows (written before _scope_nid existed) appear in every folder
   * context in the app. Here they are DROPPED instead: in-app that fallback
   * shows an old message to someone who already has hub access, whereas here it
   * would hand an unscoped message to an anonymous visitor.
   *
   * The reply carries what it takes to render a bubble — author display name,
   * text, time — and deliberately not the author's email or the delivery and
   * seen maps in metadata.
   *
   * Input:  token {String} required, page {Number} optional
   * Output: { status, nid, messages[] }
   */
  async chat_by_token() {
    const token = this.input.need(Attr.token);
    const page = parseInt(this.input.use(Attr.page, 1), 10) || 1;
    const deny = (status) => this.output.data({ status, messages: [] });

    const share = await this._shareByToken(token, 'dmz.chat_by_token');
    if (share.status) return deny(share.status);
    const { info, viewerUid } = share;

    // Chat belongs to the shared container. A file share shows the chat of the
    // folder it sits in, which is the same conversation the app shows there.
    let nid = info.node_id || info.nid;
    try {
      const attr = toArray(
        await this.yp.await_proc('forward_proc', info.hub_id, 'mfs_node_attr', `'${nid}'`)
      )[0] || {};
      if (attr.filetype && !['folder', 'hub', 'root'].includes(attr.filetype) && attr.pid) {
        nid = attr.pid;
      }
    } catch (e) {
      // Probe failed → treat the shared node as the container.
    }

    const guest_id = viewerUid || Cache.getSysConf('guest_id');
    let rows;
    try {
      rows = toArray(await this.yp.await_proc(
        'forward_proc', info.hub_id, 'channel_list_messages',
        `'${guest_id}', 'date', 'asc', ${page}`
      ));
    } catch (e) {
      this.warn('[dmz.chat_by_token] channel_list_messages failed:', e && e.message);
      return deny('TICKET_INVALID');
    }

    // Scope filter — see above on why an absent _scope_nid is dropped here.
    rows = rows.filter((r) => {
      if (!r || r.status !== 'active') return false;
      let meta = r.metadata;
      try {
        if (typeof meta === 'string') meta = JSON.parse(meta);
      } catch (e) {
        return false;
      }
      return meta && `${meta._scope_nid}` === `${nid}`;
    });

    // One contact lookup per distinct author, not per message.
    //
    // channel.messages forwards this proc to the VIEWER's own db, resolving the
    // author out of the viewer's contacts. A guest has no db, so it runs in the
    // AUTHOR's db instead — every drumate has the proc, and asked about itself
    // it returns that person's own profile.
    const authors = {};
    for (const r of rows) {
      const id = r.author_id;
      if (!id || authors[id] !== undefined) continue;
      authors[id] = '';
      try {
        const row = toArray(await this.yp.await_proc(
          'forward_proc', id, 'shareroom_contact_get', `'${id}'`
        ))[0] || {};
        // A real name when the account has one. Otherwise the LOCAL PART of
        // the address the proc returns in `surname` — enough to tell two
        // participants apart, which a conversation needs, without handing an
        // anonymous visitor a working address. The domain is never sent.
        const name = [row.firstname, row.lastname].filter(Boolean).join(' ').trim();
        authors[id] = name || String(row.surname || '').split('@')[0].trim();
      } catch (e) {
        this.debug('[dmz.chat_by_token] contact lookup failed for', id, e && e.message);
      }
    }

    // channel_list_messages answers newest-first whatever order is asked for,
    // and a conversation reads oldest-first.
    rows.sort((a, b) => Number(a.ctime || 0) - Number(b.ctime || 0));

    const messages = rows.map((r) => ({
      message_id: r.message_id,
      author_id: r.author_id,
      author: authors[r.author_id] || '',
      message: r.message,
      ctime: r.ctime,
      is_reply: r.thread_id ? 1 : 0,
    }));

    this.output.data({ status: 'TICKET_OK', nid, messages });
  }

}


module.exports = __dmz;
