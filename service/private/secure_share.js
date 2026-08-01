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
  Attr, Cache, Messenger, RedisStore, toArray, sysEnv
} = require('@drumee/server-essentials');
const { Mfs } = require('@drumee/server-core');
const { isEmpty } = require('lodash');
const { shouldSendNotification } = require('../lib/email-policy');
const { hashPassword } = require('../lib/secure-share-password');

class __secure_share extends Mfs {

  /**
   * Create a secure share token for a file or folder.
   * v2: permission_level + allowed_emails array (null = public share, no email gate).
   * Backward compat: still accepts legacy email + domain_restriction fields.
   */
  async create() {
    const nid    = this.input.need(Attr.nid);
    const days   = this.input.get(Attr.days)  || 0;
    const hours  = this.input.get(Attr.hours) || 0;
    const expiryHours = (days * 24) + (hours * 1);

    // Shorter share token to keep the copyable link compact. 12 random bytes →
    // ~16 base64url chars (96 bits entropy — still unguessable for a bearer link),
    // vs the previous 16-byte (~22 char) default. Only affects NEW tokens; existing
    // tokens resolve by exact-match id (secure_share_token.id varchar(80), UNIQUE),
    // so older/longer links keep working. No length assumption exists downstream.
    const token    = this.randomString(12);
    const hub_id   = this.hub.get(Attr.id);
    const fullname = this.user.get('fullname');
    const lang     = this.user.language() || this.input.app_language();

    const VALID_LEVELS = ['can_view', 'can_download', 'can_chat', 'can_edit'];
    const rawLevel = (this.input.get('permission_level') || '').trim();
    const permissionLevel = VALID_LEVELS.includes(rawLevel) ? rawLevel : 'can_view';

    // v2 multi-select: an independent capability set (download/chat/edit). When
    // present it is the source of truth; the SP derives permission_level from it
    // for back-compat. Legacy single-select callers send only permission_level
    // and the SP derives the set from that. can_view is implicit (the baseline),
    // so we drop it from the stored set.
    const rawCaps = this.input.get('capabilities');
    const capabilities = Array.isArray(rawCaps)
      ? rawCaps.filter(c => VALID_LEVELS.includes(c) && c !== 'can_view')
      : undefined;

    const rawEmails = this.input.get('allowed_emails');
    const allowedEmails = (Array.isArray(rawEmails) && rawEmails.length > 0)
      ? rawEmails.map(e => String(e).toLowerCase().trim()).filter(Boolean)
      : undefined;
    // undefined → key omitted from JSON.stringify → SP reads SQL NULL → public share

    // v2: require_email is decoupled from allowed_emails (per Lexis 2026-06-17).
    //   - require_email + NO allowed_emails → "require email to view" (Mode 1): the
    //     gate accepts ANY valid-format email. Recipient identity is captured but not
    //     restricted; the email FORMAT is validated server-side at the gate
    //     (dmz.js _loginSecureShare) so a non-real value cannot pass.
    //   - require_email + allowed_emails → restrict to that list/domain (Mode 2).
    // Sent as integer 1/0 (SP reads it via JSON_VALUE).
    const requireEmail = this.input.get('require_email') ? 1 : 0;

    // Notify the sender in real time when a recipient opens the share. Defaults
    // to ON (1) when the field is omitted, preserving the previous always-notify
    // behaviour. Coerced to integer 1/0 to avoid the JSON-bool→TINYINT trap.
    const notifyOnOpen = (this.input.get('notify_on_open') === 0 || this.input.get('notify_on_open') === false) ? 0 : 1;

    const rawPassword = this.input.get('password') || '';
    const passwordHash = rawPassword.trim() ? hashPassword(rawPassword.trim()) : '';

    const procArgs = {
      token,
      hub_id,
      node_id       : nid,
      creator_id    : this.uid,
      permission_level: permissionLevel,
      expiry_hours  : expiryHours,
      require_email : requireEmail,
      notify_on_open: notifyOnOpen,
      password_hash : passwordHash || null,
    };
    if (allowedEmails) procArgs.allowed_emails = allowedEmails;
    if (capabilities)  procArgs.capabilities  = capabilities;

    const row = await this.yp.await_proc('secure_share_create', procArgs);

    if (isEmpty(row)) {
      return this.output.data({ status: 'CREATE_FAILED' });
    }

    const link = `${this._shareLinkBase()}#/dmz/share/${token}`;

    // Send invitation email only when sharing with exactly one named recipient (not domain, not public)
    const singleEmail = allowedEmails && allowedEmails.length === 1
      && allowedEmails[0].includes('@') && !allowedEmails[0].startsWith('@')
      ? allowedEmails[0] : null;

    if (singleEmail && await shouldSendNotification(this.yp, singleEmail)) {
      try {
        const attr    = await this.db.await_proc('mfs_node_attr', nid) || {};
        const filesize = require('filesize');
        const subject  = Cache.message('_sent_you_files', lang).format(fullname, 1);
        const msg = new Messenger({
          template  : 'butler/outbound',
          subject   : `Drumee: ${subject}`,
          recipient : singleEmail,
          lex       : Cache.lex(lang),
          data      : {
            icon      : this.hub.get(Attr.icon),
            files     : [{ filename: attr.filename || '', filesize: filesize(attr.filesize || 0) }],
            subject   : Cache.message('_outbound_default_msg', lang).format(fullname),
            message   : '',
            recipient : singleEmail.replace(/@.+$/, ''),
            signature : fullname,
            link,
          },
          handler : this.exception.email
        });
        await msg.send();
      } catch (e) {
        this.warn('[secure_share.create] email send failed:', e && e.message);
      }
    }

    this.output.data({ ...row, link });
  }

  /**
   * Base URL for every share link. Anchored to the NEUTRAL share host
   * (share.<main_domain>) so links don't leak the workspace vhost name. This was
   * temporarily reverted to the per-vhost host on 2026-07-10 after the neutral host
   * caused an auth-session takeover (Lexis prod issue #3) — the neutral host
   * bootstrapped the generic fallback hub, so page.js never isolated the DMZ session
   * and it fell back to the apex-scoped regsid. RE-ENABLED once page.js
   * `refreshAuthorization` was taught to isolate the neutral share host onto its OWN
   * `share.<main_domain>`-scoped session cookie (narrower than the apex → can never be
   * the regsid auth session), so the takeover is now structurally impossible there.
   * homepath() supplies the per-endpoint scheme + mount path. Single source of truth —
   * used by create(), list() and access_list().
   */
  _shareLinkBase() {
    const { main_domain } = sysEnv();
    return this.input.homepath(`share.${main_domain}`);
  }

  /**
   * List all secure share tokens created by the current user for a given node.
   */
  async list() {
    const nid    = this.input.need(Attr.nid);
    const hub_id = this.hub.get(Attr.id);
    const rows   = toArray(await this.yp.await_proc('secure_share_list', hub_id, nid, this.uid));
    const base   = this._shareLinkBase();
    this.output.list(rows.map(r => ({ ...r, link: `${base}#/dmz/share/${r.id}` })));
  }

  /**
   * List pending access requests addressed to the current user (share creator).
   * Backs the sender's notification-panel entries (Figma 62). Read-only; the SP
   * filters by creator_id = this.uid, so it only ever returns the caller's own
   * pending requests.
   */
  async list_requests() {
    const rows = toArray(await this.yp.await_proc('secure_share_list_requests', this.uid));
    // Enrich each row with the SHARED node's own filename so the sender notification
    // shows the shared subfolder (e.g. "vb"), not just the workspace root name.
    // Best-effort + per-row guarded — pending requests are few, and a lookup failure
    // must never drop the row.
    for (const r of rows) {
      if (!r || !r.hub_id || !r.node_id) continue;
      try {
        const a = toArray(
          await this.yp.await_proc('forward_proc', r.hub_id, 'mfs_node_attr', `'${r.node_id}'`)
        )[0] || {};
        if (a.filename) r.node_name = a.filename;
      } catch (e) { /* keep workspace_name fallback */ }
    }
    this.output.list(rows);
  }

  /**
   * List recent share-open events across the current user's secure shares, for the
   * activity notification panel ("{who} opened {folder}"). The SP filters by
   * creator_id + notify_on_open and dedupes per recipient. Read-only; mirrors
   * list_requests' node-name enrichment so the panel can show the shared folder.
   */
  async list_open_notifications() {
    const rows = toArray(await this.yp.await_proc('secure_share_list_open_notifications', this.uid));
    for (const r of rows) {
      if (!r || !r.hub_id || !r.node_id) continue;
      try {
        const a = toArray(
          await this.yp.await_proc('forward_proc', r.hub_id, 'mfs_node_attr', `'${r.node_id}'`)
        )[0] || {};
        if (a.filename) r.node_name = a.filename;
      } catch (e) { /* keep fallback */ }
    }
    this.output.list(rows);
  }

  /**
   * Mark a share-open notification group (token + recipient) as seen by the
   * creator, so it leaves the Unread feed but still shows under Unread OFF and
   * survives a reload. Persistence replaces the old session-only dismiss. The SP
   * is scoped to the caller's own shares (creator_id), so a user can never mark
   * another creator's events. recipient_email is omitted/null for anonymous opens.
   * Endpoint: POST /secure_share.mark_open_seen
   */
  async mark_open_seen() {
    const token_id = this.input.need('token_id');
    const recipient_email = this.input.use('recipient_email', null) || null;
    await this.yp.await_proc('secure_share_mark_open_seen', this.uid, token_id, recipient_email);
    this.output.data({ status: 'OK' });
  }

  /**
   * Turn the sender's "notify me when someone opens this" preference on or off
   * for one of their OWN links, after the link has been created.
   *
   * notify_on_open was writable only at create time, but the panel's toggle sits
   * below the Get-link button, so turning it off once the link existed persisted
   * nothing and the sender kept receiving open notifications with the toggle
   * visibly off. Both notification paths already honour the stored flag (the
   * real-time secure_share_opened push in dmz.js, and the share_open feed row
   * via secure_share_open_feed), so persisting it is all that was missing.
   *
   * The SP is scoped to creator_id, so a user can only ever change their own
   * link, and returns nothing when the token is not theirs — which is also why
   * "no such token" and "not yours" are answered identically here.
   * Endpoint: POST /secure_share.set_notify_on_open
   */
  async set_notify_on_open() {
    const token = this.input.need(Attr.token);
    const raw   = this.input.need('notify_on_open');
    // Explicit setter, so read the caller's intent strictly rather than reusing
    // create()'s "absent means ON" default: only a recognised truthy form turns
    // notifications on. The value is required above, so this never has to guess
    // for a missing field. The SP's own IF(... = 0, 0, 1) is the last-resort net.
    const notify_on_open = (raw === 1 || raw === '1' || raw === true) ? 1 : 0;

    const row = toArray(
      await this.yp.await_proc('secure_share_set_notify_on_open', token, this.uid, notify_on_open)
    )[0] || {};

    if (isEmpty(row)) {
      return this.output.data({ status: 'NOT_FOUND' });
    }
    // Echo what was actually STORED, not what was asked for, so the panel can
    // revert its toggle if the two ever disagree.
    this.output.data({ status: 'OK', notify_on_open: Number(row.notify_on_open) ? 1 : 0 });
  }

  /**
   * Revoke a secure share token (soft delete).
   * Broadcasts a real-time event so the recipient loses access immediately.
   */
  async revoke() {
    const token  = this.input.need(Attr.token);
    const hub_id = this.hub.get(Attr.id);

    const row = toArray(
      await this.yp.await_proc('secure_share_revoke', token, this.uid)
    )[0] || {};

    // Only broadcast if the revoke actually happened (procedure returns empty otherwise)
    if (!isEmpty(row) && row.revoked_at) {
      const eventData = {
        event           : 'secure_share_revoked',
        token,
        nid             : row.node_id,
        recipient_email : row.recipient_email,
      };
      const svcOpt = { service: 'share.track_event' };

      try {
        // Broadcast to the SHARE's hub (row.hub_id), not the revoker's current
        // workspace (this.hub) — same fix as respond_to_access_request, so the
        // sender's list refreshes even when revoking from a different/global context.
        const recipients = await this.yp.await_proc('entity_sockets', { hub_id: row.hub_id || hub_id });
        await RedisStore.sendData(this.payload(eventData, svcOpt), recipients);
      } catch (e) {
        this.warn('[secure_share.revoke] hub broadcast failed:', e && e.message);
      }

      // Also target the recipient's socket directly using the socket_id stored at
      // access time — entity_sockets() won't include guest sockets.
      if (row.active_socket_id) {
        try {
          await RedisStore.sendData(
            this.payload(eventData, svcOpt),
            [{ socket_id: row.active_socket_id }]
          );
        } catch (e) {
          this.warn('[secure_share.revoke] recipient broadcast failed:', e && e.message);
        }
      }

      // Revoking the token must ALSO remove any node-scoped permission grants the
      // capped-principal binding (dmz.js::_loginSecureShare) issued to authenticated
      // recipients of this share — otherwise a revoked recipient keeps standing ACL
      // on the shared node. Enumerate this share's recipients from the access-event
      // log and drop each one's node-scoped grant. permission_revoke deletes only
      // the (node_id, uid) row, so a recipient who is ALSO a real workspace member
      // keeps their '*' membership untouched. Best-effort.
      // RESIDUAL (Codex P1): a non-member COLLABORATOR holding a manual node-scoped
      // grant (resource_id=node, not '*') who opened this share would have that grant
      // removed by the blunt permission_revoke. Rare; the precise fix is an assign_via-
      // scoped delete (only 'system'/'Secure share access' rows), bundled with the
      // capped-guest-principal lifecycle redesign.
      // KNOWN RESIDUAL: secure_share_list_access_events excludes PUBLIC shares, so a
      // logged-in recipient of a PUBLIC share (also rebound + granted) is NOT
      // enumerated here — their node grant survives revoke. Low-severity (the content
      // was public; the grant is invisible to their desk, only crafted-API reachable).
      // To be closed by an all-shares cleanup bundled with the capped-guest-principal
      // schema (a token-scoped recipient enumeration).
      if (row.node_id && row.hub_id) {
        try {
          const db_name = await this.yp.await_func('get_db_name', row.hub_id);
          const events  = toArray(
            await this.yp.await_proc('secure_share_list_access_events', row.hub_id, row.node_id, this.uid)
          );
          if (db_name) {
            const seen = new Set();
            for (const ev of events) {
              const uid = ev && ev.actor_id;
              if (!uid || uid === 'ffffffffffffffff' || uid === this.uid || seen.has(uid)) continue;
              // Only THIS token's recipients — a node can carry several secure shares;
              // without this filter, revoking one token would also strip recipients of
              // the other still-valid shares on the same node (Codex P2).
              if (ev.token_id && String(ev.token_id) !== String(token)) continue;
              seen.add(uid);
              try {
                await this.yp.await_proc(`${db_name}.permission_revoke`, row.node_id, uid);
              } catch (e) {
                this.warn('[secure_share.revoke] node grant revoke failed:', e && e.message);
              }
            }
          }
        } catch (e) {
          this.warn('[secure_share.revoke] grant cleanup failed:', e && e.message);
        }
      }
    }

    this.output.data(row);
  }

  /**
   * Return the full share list for a node — same data as list(), used by the v2 panel.
   */
  async access_list() {
    const nid    = this.input.need(Attr.nid);
    const hub_id = this.hub.get(Attr.id);
    const rows   = toArray(await this.yp.await_proc('secure_share_list', hub_id, nid, this.uid));
    const base   = this._shareLinkBase();
    this.output.list(rows.map(r => ({ ...r, link: `${base}#/dmz/share/${r.id}` })));
  }

  /**
   * Per-access-event list for the v2 "View access list" table — one row per visit
   * (recipient email, access time, duration). Creator-scoped inside the SP, so a
   * caller only sees events for shares they own on this node.
   */
  async list_access_events() {
    const nid    = this.input.need(Attr.nid);
    const hub_id = this.hub.get(Attr.id);
    const rows   = toArray(
      await this.yp.await_proc('secure_share_list_access_events', hub_id, nid, this.uid)
    );
    // Resolve the recipient identity for SIGNED-IN opens on shares WITHOUT an email
    // gate (e.g. a password-only link): those events are logged with actor_id but no
    // recipient_email, so the "View access list" had nothing to show. Look the
    // account up via the directory SP and fill recipient_email (the field the table
    // already renders) plus actor_name/actor_email. No schema change — the stored
    // access-event rows are untouched. Deduped per actor_id; best-effort (a lookup
    // failure just leaves the row as-is).
    const _cache = {};
    for (const r of rows) {
      if (!r || !r.actor_id || (r.recipient_email && String(r.recipient_email).trim())) continue;
      // Never resolve an event whose actor is the share CREATOR (= this.uid, since the
      // SP is creator-scoped): such rows are either the owner's own preview or a legacy
      // event mis-attributed to the creator-bound anonymous session (fixed at the
      // source in dmz.js). Leave them unresolved so they render as an anonymous open
      // instead of showing the sender as a recipient.
      if (String(r.actor_id) === String(this.uid)) continue;
      if (!(r.actor_id in _cache)) {
        try {
          _cache[r.actor_id] = toArray(await this.yp.await_proc('get_user', r.actor_id))[0] || null;
        } catch (e) {
          this.warn('[secure_share.list_access_events] actor lookup failed:', e && e.message);
          _cache[r.actor_id] = null;
        }
      }
      const u = _cache[r.actor_id];
      // get_user falls back to the guest account when the id is unknown — only use a
      // genuine match so a stale/foreign actor_id can't surface a wrong identity.
      if (!u || String(u.id) !== String(r.actor_id)) continue;
      let email = null;
      if (u.profile) {
        try {
          const p = (typeof u.profile === 'string') ? JSON.parse(u.profile) : u.profile;
          email = p && p.email ? String(p.email) : null;
        } catch (e) { /* ignore malformed profile */ }
      }
      const name = (u.fullname && String(u.fullname).trim())
        || [u.firstname, u.lastname].filter(Boolean).join(' ').trim()
        || null;
      if (email) r.recipient_email = email;
      r.actor_email = email;
      r.actor_name  = name;
    }
    this.output.list(rows);
  }

  /**
   * Drop a recipient's node-scoped secure-share grant — the exact inverse of the
   * permission_grant(node_id, uid, ...) issued in _grantHubMembership. Best-effort
   * and safe to call with no uid (anonymous viewers never held one).
   *
   * permission_revoke deletes only the (node_id, uid) row, so a recipient who is
   * ALSO a real workspace member keeps their '*' membership untouched.
   *
   * @returns {Promise<boolean>} true when a grant was actually revoked
   */
  async _revokeNodeGrant(hub_id, node_id, uid) {
    if (!uid || !hub_id || !node_id) return false;
    try {
      const db_name = await this.yp.await_func('get_db_name', hub_id);
      if (!db_name) return false;
      await this.yp.await_proc(`${db_name}.permission_revoke`, node_id, uid);
      return true;
    } catch (e) {
      this.warn('[secure_share] permission_revoke failed:', e && e.message);
      return false;
    }
  }

  /**
   * Revoke a single recipient's current access grant for this node and drop their
   * rows from the access-event log. "Revoke current grant only" — the email is NOT
   * blocklisted, so the recipient can request access again later. Best-effort and
   * idempotent: a recipient with no standing grant (e.g. an anonymous public viewer)
   * simply has their log rows cleared, with no permission change.
   */
  async revoke_recipient() {
    const nid    = this.input.need(Attr.nid);
    const hub_id = this.hub.get(Attr.id);
    let   email  = (this.input.get(Attr.email) || '').toLowerCase().trim();
    let   uid    = (this.input.get(Attr.uid) || '').trim() || null;

    // Only the secure-share CREATOR may revoke a recipient. secure_share_list is
    // creator-scoped (filters by this.uid), so a non-empty result means the caller
    // owns a share on this node. Otherwise deny — a workspace contributor with mere
    // write access on the node must not be able to strip another user's grant.
    const owned = toArray(await this.yp.await_proc('secure_share_list', hub_id, nid, this.uid));
    if (!owned.length) {
      return this.output.data({ status: 'FORBIDDEN' });
    }

    // Resolve the uid from the email when the row didn't carry one (signed-in
    // recipients have actor_id; anonymous public viewers do not).
    if (!uid && email) {
      let member = await this.yp.await_proc('drumate_exists', email);
      if (Array.isArray(member)) member = member[0];
      uid = member && member.id ? member.id : null;
    }

    const revoked = await this._revokeNodeGrant(hub_id, nid, uid);

    // Clear the recipient's access-event rows so they drop off the list.
    if (email) {
      try {
        await this.yp.await_proc('secure_share_delete_access_events', hub_id, nid, this.uid, email);
      } catch (e) {
        this.warn('[secure_share.revoke_recipient] delete_access_events failed:', e && e.message);
      }
    }

    this.output.data({ status: 'OK', revoked, email, uid });
  }

  /**
   * Cut ONE recipient off a link while the link keeps working for everyone else.
   *
   * The address goes on the token's deny list, which the DMZ gate refuses before
   * it considers any allow rule — so it holds whether the link names addresses,
   * allows a whole @domain, or accepts any email. It is deny-only: it can never
   * admit someone, so it cannot widen access.
   *
   * Enforcement is exact for a SIGNED-IN recipient (their email comes from their
   * authenticated account). For an anonymous visitor the email gate is a typed
   * value with no ownership proof (pre-existing — see the capped-guest-principal
   * work), so a denied person could return under another accepted address; on a
   * public link there is no gate at all, which is why the panel offers this only
   * where an email was actually captured.
   */
  async revoke_email() {
    const token = this.input.need(Attr.token);
    const email = (this.input.need(Attr.email) || '').toLowerCase().trim();
    if (!email) {
      return this.output.data({ status: 'INVALID_EMAIL', denied: 0 });
    }

    // Creator-scoped inside the SP: an empty row means the token is unknown or is
    // not this caller's, and nothing was written.
    const row = toArray(
      await this.yp.await_proc('secure_share_deny_email', token, this.uid, email)
    )[0] || {};
    if (isEmpty(row) || !row.denied) {
      return this.output.data({ status: 'FORBIDDEN', denied: 0 });
    }

    // Resolve the account behind the address so an already-granted recipient also
    // loses the standing node grant the capped-principal binding gave them —
    // otherwise the gate refuses them while their ACL quietly still holds.
    let uid = null;
    try {
      let member = await this.yp.await_proc('drumate_exists', email);
      if (Array.isArray(member)) member = member[0];
      uid = member && member.id ? member.id : null;
    } catch (e) {
      this.warn('[secure_share.revoke_email] drumate lookup failed:', e && e.message);
    }
    const revoked = await this._revokeNodeGrant(row.hub_id, row.node_id, uid);

    // Cut a session this person already has open on THIS link. Targeted at their
    // own sockets (never the token's active socket, which may belong to someone
    // else still legitimately using the link); the sharebox only reacts when the
    // event's token matches the share it has open.
    if (uid) {
      try {
        const targets = await this.yp.await_proc('user_sockets', uid);
        if (!isEmpty(targets)) {
          await RedisStore.sendData(
            this.payload(
              { event: 'secure_share_revoked', token, nid: row.node_id, recipient_email: email },
              { service: 'share.track_event' }
            ),
            targets
          );
        }
      } catch (e) {
        this.warn('[secure_share.revoke_email] recipient broadcast failed:', e && e.message);
      }
    }

    // The access-event history is deliberately kept: the sender's panel is built on
    // it, and erasing a visit does not un-happen it.
    this.output.data({ status: 'OK', denied: 1, token, email, revoked });
  }

  /**
   * Hard-delete a token. Only allowed when it is already revoked or expired.
   */
  async delete() {
    const token = this.input.need(Attr.token);
    const res   = toArray(
      await this.yp.await_proc('secure_share_delete', token, this.uid)
    )[0] || {};
    this.output.data(res);
  }

  /**
   * Approve or deny a pending secure share access request.
   * Caller must be the share creator. Notifies the guest and broadcasts to hub.
   */
  async respond_to_access_request() {
    const VALID_ACTIONS = ['approve', 'deny'];
    const VALID_LEVELS  = ['can_view', 'can_download', 'can_chat', 'can_edit'];
    // CUMULATIVE privilege masks, consistent with dmz._loginSecureShare: can_chat
    // carries NO download bit (it is gated by the can_chat flag, not the bitmask).
    const LEVEL_TO_PRIVILEGE = { can_view: 3, can_download: 7, can_chat: 3, can_edit: 15 };

    const requestId    = this.input.need('request_id');
    const action       = (this.input.get('action') || '').trim();
    // Multi-level: the sender may grant several levels at once (multi-select
    // request). Normalise the comma-list, dedupe, and require every level valid.
    const grantedLevels = Array.from(new Set(
      (this.input.get('granted_level') || '').split(',').map(s => s.trim()).filter(Boolean)
    ));
    const grantedLevel = grantedLevels.join(',') || null;

    if (!VALID_ACTIONS.includes(action)) {
      return this.output.data({ status: 'INVALID_ACTION' });
    }
    if (action === 'approve' && (!grantedLevels.length || grantedLevels.some(l => !VALID_LEVELS.includes(l)))) {
      return this.output.data({ status: 'INVALID_LEVEL' });
    }

    const row = toArray(
      await this.yp.await_proc(
        'secure_share_respond_to_access_request',
        requestId, this.uid, action, grantedLevel || ''
      )
    )[0] || {};

    if (!row.id || row.error) {
      return this.output.data({ status: row.error || 'INVALID_REQUEST' });
    }

    // On approval, grant the requester workspace membership with the granted
    // capability. Best-effort: a failure here must not block the response or the
    // notifications below.
    if (action === 'approve') {
      try {
        await this._grantHubMembership(row);
      } catch (e) {
        this.warn('[secure_share.respond] membership grant failed:', e && e.message);
      }
    }

    // Real-time notify. The FULL grant payload (privilege/caps) must travel with the
    // event so the recipient unlocks correctly — the old hub broadcast carried only
    // {event,request_id,action}, which would reload the recipient as view-only.
    // requester_email lets each recipient match ITS own approval (a hub broadcast
    // reaches every viewer of the share). Broadcast to entity_sockets(hub_id): the
    // guest's DMZ socket is included there (cookie_touch passes socket_id for exactly
    // this), which is reliable — unlike the single, often-stale active_socket_id.
    // granted_level is a SET (comma-list) — split it and union the privilege so a
    // multi-level grant (e.g. chat + edit) carries every cap to the recipient.
    const grantedSet = String(row.granted_level || '').split(',').map(s => s.trim()).filter(Boolean);
    let grantedPriv = 3;
    for (const lvl of grantedSet) grantedPriv |= (LEVEL_TO_PRIVILEGE[lvl] || 0);
    const respondedPayload = {
      event          : 'secure_share_access_responded',
      request_id     : row.id,
      action,
      requester_email: (row.requester_email || '').toLowerCase().trim(),
      granted_level  : row.granted_level,
      privilege      : grantedPriv,
      capabilities   : grantedSet.filter(l => l !== 'can_view'),
      can_download   : grantedSet.includes('can_download') ? 1 : 0,
      can_chat       : grantedSet.includes('can_chat') ? 1 : 0,
      can_edit       : grantedSet.includes('can_edit') ? 1 : 0,
    };
    try {
      // Target the SHARE's hub (row.hub_id from the request), NOT the approver's
      // current workspace context (this.hub) — the sender often approves from the
      // global activity panel while in a different/no workspace, so this.hub did
      // not match the share's hub, and the broadcast reached neither the guest
      // (whose DMZ socket is bound into the share's hub via the creator) nor the
      // sender → the approval never arrived real-time. Fall back to this.hub only
      // if the row somehow lacks it.
      const hub_id = row.hub_id || this.hub.get(Attr.id);
      const targets = await this.yp.await_proc('entity_sockets', { hub_id });
      // Include the recipient's last-known socket too, in case it isn't in the hub set.
      if (row.guest_socket_id) targets.push({ socket_id: row.guest_socket_id });
      await RedisStore.sendData(
        this.payload(respondedPayload, { service: 'share.track_event' }),
        targets
      );
    } catch (e) {
      this.warn('[secure_share.respond] access-responded notify failed:', e && e.message);
    }

    return this.output.data({
      ...row,
      status: action === 'approve' ? 'APPROVED' : 'DENIED',
    });
  }

  /**
   * Grant the approved requester membership of the shared workspace.
   * Mirrors signup._resolve_pending_invitation:
   *  - existing account  → add_member + permission_grant + WS notify (desk sidebar)
   *  - no account yet    → queue a pending_invitation so signup adds them later
   * The granted_level maps to the same cumulative privilege masks used elsewhere
   * in the secure-share flow (can_chat carries no download bit).
   * @param {object} row  the row returned by secure_share_respond_to_access_request
   */
  async _grantHubMembership(row) {
    // SERVER-ENFORCEMENT privilege (lib/privilege.js STORED cumulative scale) — this
    // is the value written to the permission table that user_permission/ACL enforce,
    // NOT the client-UI scale used for the broadcast payload in respond_to_access_request.
    // download is read-level (3): downloading is a 'read' op, so it needs no write bit
    // (keeping it at 3 stops a download-only recipient from chatting / passing the
    // upload ACL). can_chat needs write (7) because chat.post asks 'write' — granting
    // only 3 is why signed-in recipients previously could not post. can_edit needs
    // delete/modify (15) for move/rename/trash. Matches dmz.js::_loginSecureShare grantPriv.
    const LEVEL_TO_PRIVILEGE = { can_view: 3, can_download: 3, can_chat: 7, can_edit: 15 };
    // granted_level is a SET (comma-list) — union the cumulative privilege masks
    // over every granted level so a multi-level grant gets the combined privilege.
    const privilege = String(row.granted_level || '').split(',').map(s => s.trim()).filter(Boolean)
      .reduce((p, lvl) => p | (LEVEL_TO_PRIVILEGE[lvl] || 0), 3);
    const hub_id    = row.hub_id;
    const email     = (row.requester_email || '').toLowerCase().trim();
    if (!hub_id || !email) return;

    const db_name = await this.yp.await_func('get_db_name', hub_id);
    if (!db_name) return;

    let member = await this.yp.await_proc('drumate_exists', email);
    if (Array.isArray(member)) member = member[0];
    const uid = member && member.id ? member.id : null;

    // No account yet — queue a pending invitation; signup._resolve_pending_invitation
    // will add them to the hub with this privilege when they register.
    if (!uid) {
      await this.yp.await_proc('yp_add_pending_invitation', hub_id, 0, privilege, email);
      return;
    }

    // Existing user — grant access to the SHARED NODE only (e.g. subfolder "vb"),
    // NOT membership of the whole workspace root. add_member/join_hub + a '*' grant
    // would make them a full root member — that is the bug being fixed (an approved
    // recipient was auto-joining the parent workspace, not just the shared folder).
    // node-scoped permission_grant is the exact inverse of revoke_recipient's
    // node-scoped permission_revoke.
    await this.yp.await_proc(
      `${db_name}.permission_grant`,
      row.node_id, uid, 0, privilege, 'system', 'Secure share access approved'
    );

    // Notify the user so their desk picks up the shared node (scoped to node_id, not
    // the workspace root, to match the node-scoped grant above).
    try {
      let hub = await this.yp.await_proc(`${db_name}.mfs_access_node`, uid, row.node_id);
      if (Array.isArray(hub)) hub = hub[0];
      if (hub) {
        hub.ownpath = '/';
        hub.hub_id  = hub.actual_hub_id;
        hub.db_name = hub.actual_db;
        const sockets = await this.yp.await_proc('user_sockets', uid);
        await RedisStore.sendData(this.payload(hub, { service: 'hub.invite_received' }), sockets);
        await RedisStore.sendData(this.payload(hub, { service: 'hub.add_contributors' }), sockets);
      }
    } catch (err) {
      this.warn('[secure_share.respond] member WS notify failed:', err && err.message);
    }
  }

}

module.exports = __secure_share;
