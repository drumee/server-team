// File: service/private/activity.js
// Purpose: MFS activity notification service - handle read/unread status

const { Entity } = require('@drumee/server-core');
const { RedisStore, Attr, toArray } = require('@drumee/server-essentials');
const { createHash } = require('node:crypto');
const { resolveHubInviteName } = require('../lib/hub-invite-name');
const CONTACT_ACTIVITY_CATEGORIES = new Set([
  'contact_refused',
  'hub_invite',
  'task_assigned',
  'task_mention',
]);
const ROLLUP_MUTATION_CATEGORIES = new Set([
  'chat',
  'contact',
  'media',
  'teamchat',
  'ticket',
]);

function firstValue(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    return value;
  }
  return undefined;
}

function mapNotificationRow(r) {
  let keyId = r.key_id;
  switch (r.category) {
    case 'chat': keyId = firstValue(r.drumate_id, r.key_id); break;
    case 'contact': keyId = firstValue(r.contact_id, r.key_id); break;
    case 'media': keyId = firstValue(r.nid, r.hub_id, r.key_id); break;
    case 'teamchat': keyId = firstValue(r.key_id, r.nid, r.hub_id); break;
    case 'ticket': keyId = firstValue(r.key_id, r.hub_id); break;
  }
  const item = {
    category: r.category,
    key_id: keyId,
    source_id: firstValue(r.key_id, r.id),
    hub_id: r.hub_id,
    nid: r.nid,
    parent_id: r.parent_id,
    filename: r.filename || r.hubname || r.surname,
    last_id: r.last_id,
    cnt: r.cnt,
    ctime: r.ctime,
    firstname: r.firstname,
    lastname: r.lastname,
    surname: r.surname,
    email: r.email,
    status: r.status,
    contact_id: r.contact_id,
    drumate_id: r.drumate_id,
    guest_id: r.guest_id,
    area: r.area,
    tag_id: r.tag_id,
    author_id: r.author_id,
    author_firstname: r.author_firstname,
    author_lastname: r.author_lastname,
    author_email: r.author_email,
    // 'start' | 'end' for a team-chat rollup whose latest unread meeting event is
    // a [[MEETING:...]] system message (notification_center_next). Lets the client
    // render "started/ended a meeting in <folder>" instead of "posted in". Absent
    // (undefined) for every other category — the client falls back to "posted in".
    meeting_action: r.meeting_action,
  };

  if (r.category === 'media') {
    const targetName = firstValue(
      r.folder_name,
      r.target_name,
      r.filename,
      r.link_label,
      r.hubname,
      r.surname
    );
    item.event = firstValue(r.event, 'media.new');
    item.nid = firstValue(r.target_nid, r.folder_nid, r.nid);
    item.parent_id = firstValue(r.target_parent_id, r.parent_id, r.pid, '0');
    item.filetype = firstValue(r.target_filetype, r.filetype, 'folder');
    item.target_filetype = item.filetype;
    item.item_filetype = firstValue(r.item_filetype, r.uploaded_filetype, r.src_filetype);
    // The uploaded file's own name (notification_center_next surfaces it as
    // item_filename) so a single-file upload rollup can show the file name
    // instead of its destination folder/workspace. Absent for multi-file rollups.
    item.item_filename = r.item_filename;
    item.filename = targetName;
    item.link_label = targetName;
    item.author_id = firstValue(r.author_id, r.owner_id, r.drumate_id);
    item.author_firstname = firstValue(r.author_firstname, r.firstname);
    item.author_lastname = firstValue(r.author_lastname, r.lastname);
    item.author_email = firstValue(r.author_email, r.email);
  }

  return item;
}

function bookmarkKey(row) {
  const event = String(row.event || '');
  let category = String(row.category || row.event_type || event || 'unknown');
  if (['hub_invite', 'contact_refused', 'task_assigned', 'task_mention'].includes(category)) {
    category = 'contact';
  } else if (event.startsWith('media.')) {
    category = 'mfs';
  }
  const key = firstValue(row.key_id, row.history_id, row.id);
  if (key === undefined) return null;
  // A rollup's last_id advances whenever another event lands. It must not be
  // part of the bookmark identity: otherwise a saved card silently becomes
  // unsaved after refresh, and the durable history row created on read cannot
  // recover the saved state. category + canonical key + hub identify the same
  // notification stream across unread and history representations; raw MFS and
  // contact rows already use their immutable row id as `key`. Contact events
  // deliberately omit hub_id because their unread adapters may enrich it while
  // activity_get_feed_all represents the same yp.contact_activity row without
  // one. The immutable contact-activity id is sufficient and mode-stable.
  const identity = [
    category,
    String(key),
    ...(category === 'contact' ? [] : [String(row.hub_id || '')]),
  ];
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

// Surface task fields at the top level from the nested contact_activity `data`
// JSON so the client renders the right text and can navigate to the task,
// without relying on the nested JSON surviving the LETC model. Handles BOTH
// task_assigned ("assigned you to <task>") and task_mention ("mentioned you in
// <task>"). Idempotent; only touches those two events. The two events use
// different client field names (assignment nav reads task_hub_id/task_nid;
// mention nav reads top-level hub_id/nid), so flatten to each one's contract.
function flattenTaskFields(rows) {
  for (const r of rows) {
    if (!r) continue;
    if (r.event !== 'task_assigned' && r.event !== 'task_mention') continue;
    let meta = r.data;
    if (typeof meta === 'string') {
      try { meta = JSON.parse(meta); } catch (e) { meta = null; }
    }
    meta = meta || {};
    if (r.task_title == null) r.task_title = meta.title || '';
    if (r.task_id == null) r.task_id = meta.task_id || null;
    if (r.event === 'task_assigned') {
      if (r.task_nid == null) r.task_nid = meta.nid || null;
      if (r.task_hub_id == null) r.task_hub_id = meta.hub_id || null;
    } else {
      // task_mention: the client nav branch reads top-level hub_id/nid.
      // activity_get_feed_all sets hub_id NULL for contact rows, so populate
      // it (and nid, when the task carries one) from the task meta.
      if (meta.hub_id != null) r.hub_id = meta.hub_id;
      if (r.nid == null && meta.nid != null) r.nid = meta.nid;
      // A reply to your comment rides the same row with kind='reply'; surfacing
      // it lets the item say "replied to your comment in" instead of the
      // (untrue) "mentioned you in". Absent on real @-mentions.
      if (r.task_kind == null && meta.kind != null) r.task_kind = meta.kind;
    }
  }
  return rows;
}

function mapTaskNotificationRow(r) {
  const hubId = firstValue(r.task_hub_id, r.hub_id);
  const nodeId = firstValue(r.task_nid, r.nid);
  return {
    category: r.event,
    key_id: String(r.id),
    hub_id: hubId,
    nid: nodeId,
    filename: r.task_title || '',
    last_id: r.id,
    cnt: 1,
    ctime: firstValue(r.timestamp, r.ctime),
  };
}

// Shape a hub-invite row (yp.contact_activity 'hub_invite_received') into the
// same notification item shape as mapNotificationRow. Extracted so both list()
// and get_feed() build hub-invite items identically (single source of truth).
function mapHubInviteRow(r) {
  let meta = {};
  if (r.data) {
    try { meta = typeof r.data === 'string' ? JSON.parse(r.data) : r.data; } catch (_) { }
  }
  const hub_id = meta.hub_id || null;
  return {
    category: 'hub_invite',
    key_id: String(r.id),
    hub_id,
    last_id: r.id,
    cnt: 1,
    ctime: r.ctime,
    firstname: meta.from_firstname || r.inviter_firstname,
    lastname: meta.from_lastname || r.inviter_lastname,
    surname: meta.from_fullname || r.hub_headline,
    email: r.inviter_email,
    author_id: r.author_id,
    // Shared with hub.invite_received_get so the two surfaces cannot drift
    // apart again — that drift is what left this one rendering a blank name.
    hub_name: resolveHubInviteName(r, meta),
  };
}

// Shape a refused-invitation row into the common notification item shape.
function mapContactRefusedRow(r) {
  return {
    category: 'contact_refused',
    key_id: String(r.id),
    last_id: r.id,
    cnt: 1,
    ctime: r.ctime,
    firstname: r.firstname,
    lastname: r.lastname,
    email: r.email,
    author_id: r.author_id,
    drumate_id: r.author_id,
  };
}

// Flatten watched-column metadata so the activity row can render and open the
// affected task after it was created or moved.
function flattenTaskColumnChange(rows) {
  for (const r of rows) {
    if (!r || r.event !== 'task_column_change') continue;
    let meta = r.data;
    if (typeof meta === 'string') {
      try { meta = JSON.parse(meta); } catch (e) { meta = null; }
    }
    meta = meta || {};
    if (r.task_title == null) r.task_title = meta.title || '';
    if (r.task_nid == null) r.task_nid = meta.nid || null;
    if (r.task_hub_id == null) r.task_hub_id = meta.hub_id || null;
    if (r.task_id == null) r.task_id = meta.task_id || null;
    if (r.column_key == null) r.column_key = meta.column_key || null;
    if (r.task_action == null) r.task_action = meta.action || 'moved';
  }
  return rows;
}

class MfsActivity extends Entity {


  /**
   * Call stored procedure in user's database
   * Ensures procedures run in user context, not hub context
   * 
   * @param {string} procName - Procedure name
   * @param {...any} args - Procedure arguments
   */
  async _callUserProc(procName, ...args) {
    // const argsStr = args.map(arg => {
    //   if (typeof arg === 'string') return `'${arg}'`;
    //   if (typeof arg === 'object') return `'${JSON.stringify(arg)}'`;
    //   return String(arg);
    // }).join(', ');
    const proc = `${this.user.get(Attr.db_name)}.${procName}`;
    this.debug(`[MFS_ACTIVITY] Calling ${proc}`, ...args);

    // Call via forward_proc to ensure it runs in user's database
    const result = await this.yp.await_proc(`${proc}`, ...args);

    // this.debug(`[MFS_ACTIVITY] Result from ${procName}:`, result);

    return result;
  }

  /**
   * Get count of unread notifications
   * Endpoint: GET /mfs_activity.get_unread_count
   * 
   * Output:
   * - unread_count: Number of unread notifications
   */
  async get_unread_count() {
    const result = await this._callUserProc('mfs_get_unread_count', this.uid);
    const data = toArray(result)[0] || { unread_count: 0 };

    return this.output.data({
      status: 'ok',
      unread_count: data.unread_count
    });
  }

  /**
   * Mark all notifications as read
   * Endpoint: POST /mfs_activity.mark_all_read
   * 
   * Input:
   * - last_id (optional): Specific changelog ID to mark as last read
   *                       If not provided, will use the latest changelog ID
   * 
   * Output:
   * - status: ok or error
   * - last_read_id: The ID that was marked as last read
   */
  async mark_all_read() {

    const lastId = parseInt(this.input.get('last_id')) || 0;

    this.debug(`[MFS_ACTIVITY] Marking all read for user ${this.uid}, last_id: ${lastId}`);

    // Snapshot and clear rollups BEFORE mfs_mark_all_read advances P2P pointers;
    // otherwise direct-chat rows disappear before durable history captures them.
    // (media/chat/teamchat/contact/ticket) — otherwise they reappear on reload.
    // Reuse the already-tested procs: enumerate with notification_center_next.
    // Read-capable rollups snapshot privacy-safe history before advancing their
    // pointers; media/contact retain their existing clear behavior.
    try {
      const rollups = toArray(await this._callUserProc('notification_center_next'));
      for (const r of rollups) {
        if (!r || !r.category) continue;
        let keyId;
        switch (r.category) {
          case 'chat':     keyId = r.drumate_id || r.key_id; break;
          case 'media':    keyId = r.nid || r.hub_id || r.key_id; break;
          case 'teamchat': keyId = r.key_id || r.nid || r.hub_id; break;
          case 'contact':  keyId = r.contact_id || r.key_id; break;
          case 'ticket':   keyId = r.key_id || r.hub_id; break;
          default:         continue; // only rollup categories
        }
        if (!keyId) continue;
        const category = String(r.category);
        const args = [
          category,
          String(keyId),
          String(r.hub_id || ''),
          parseInt(r.last_id || 0),
        ];
        if (['chat', 'teamchat', 'ticket'].includes(category)) {
          await this._callUserProc(
            'notification_read',
            ...args,
            parseInt(r.ctime || 0),
          );
        } else {
          await this._callUserProc('notification_dismiss', ...args);
        }
      }
    } catch (e) {
      // Do not advance the global MFS/P2P pointers after an enumerate,
      // snapshot, or per-rollup mutation failure. That would make unread chat
      // disappear without its durable history row while still reporting
      // success to the client.
      this.warn('[MFS_ACTIVITY] mark_all_read: rollup phase failed', e && e.message);
      return this.exception.server('MARK_ALL_READ_FAILED');
    }

    const result = await this._callUserProc('mfs_mark_all_read', this.uid, lastId);
    const data = toArray(result)[0];

    // "Mark all as read" must also clear share-open notifications, which ride the
    // feed via secure_share_open_feed / creator_seen_at (not mfs_mark_all_read).
    // Best-effort — never fail the whole mark-all if this errors.
    try {
      await this.yp.await_proc('secure_share_mark_all_open_seen', this.uid);
    } catch (e) {
      this.warn('[MFS_ACTIVITY] mark_all_read: secure_share_mark_all_open_seen failed', e && e.message);
    }

    if (data && data.status === 'ok') {
      return this.output.data({
        status: 'ok',
        message: 'All notifications marked as read',
        last_read_id: data.last_read_id,
        mtime: data.mtime
      });
    }

    this.warn('[MFS_ACTIVITY] mark_all_read failed:', data);
    return this.output.data({
      status: 'error',
      message: 'Failed to mark as read',
      last_read_id: 0,
    });
  }

  /**
   * Get activity feed with pagination
   * Endpoint: GET /mfs_activity.get_feed
   * 
   * Input:
   * - limit (optional): Number of items per page (default: 20)
   * - offset (optional): Offset for pagination (default: 0)
   * 
   * Output:
   * - items: Array of activity items with read status
   * - pagination: { limit, offset, has_more }
   */
  async get_feed() {
    const page = this.input.use(Attr.page) || 1;
    const filter = this.input.use('filter') || 'all';
    const unreadOnly = parseInt(this.input.use('unread_only') || 0);
    // unread_only=1 → unread-only feed (mfs_get_activity_feed, unchanged).
    // unread_only=0 → full feed (read + unread together) via
    // activity_get_feed_all, which returns the unified log with a correct
    // is_read flag. This intentionally does NOT use activity_get_log: that proc
    // filters out read/dismissed rows (so "off" could never surface a
    // notification the user already opened) and is still served as-is by the
    // separate activity.log endpoint.
    let result;
    if (unreadOnly) {
      result = await this._callUserProc('mfs_get_activity_feed', this.uid, page);
    } else {
      // Full-feed callers require real read history. Failing closed is safer
      // than silently returning the legacy unread/dismissed log under an OFF
      // toggle, which would misrepresent the selected contract.
      result = await this._callUserProc('activity_get_feed_all', this.uid, page);
    }
    result = toArray(result);
    for (const row of result) {
      if (row) row.feed_page_source = 'base';
    }
    if (filter === 'mentions') {
      result = result.filter((row) => row.event !== 'media.share');
    } else if (filter === 'shares') {
      result = result.filter((row) => row.event === 'media.share');
    }

    // Merge secure-share "open" notifications ("{email} opened {folder}") into the
    // All-activity feed so they behave like ordinary feed events — chronological,
    // toggle-aware (unread_only) and persistently dismissable — instead of a pinned
    // rolling alert. Bounded (<=50), enriched with the shared node's name, merged
    // on page 1 only so they aren't repeated per page (trade-off: an old open can
    // sit on page 1). Best-effort — a failure here never breaks the rest of the feed.
    if (filter !== 'mentions' && filter !== 'shares' && page <= 1) {
      try {
        const opens = toArray(await this.yp.await_proc('secure_share_open_feed', this.uid, unreadOnly));
        for (const r of opens) {
          if (!r) continue;
          let nodeName = '';
          if (r.hub_id && r.node_id) {
            try {
              const a = toArray(
                await this.yp.await_proc('forward_proc', r.hub_id, 'mfs_node_attr', `'${r.node_id}'`)
              )[0] || {};
              if (a.filename) nodeName = a.filename;
            } catch (e) { /* keep fallback */ }
          }
          result.push({
            category       : 'share_open',
            event          : 'secure_share.opened',
            id             : r.id,
            token_id       : r.token_id,
            hub_id         : r.hub_id,
            node_id        : r.node_id,
            node_name      : nodeName,
            recipient_email: r.recipient_email,
            fullname       : r.recipient_email || 'Someone',
            is_read        : r.is_read ? 1 : 0,
            timestamp      : r.last_seen_at,
            ctime          : r.last_seen_at,
          });
        }
        result.sort((a, b) => (Number(b.timestamp || b.ctime || 0) - Number(a.timestamp || a.ctime || 0)));
      } catch (e) {
        this.warn('[ACTIVITY] secure_share_open_feed merge failed', e && e.message);
      }
    }

    // Interleave rollup + task notifications chronologically into the
    // All-activity feed, instead of the client pinning them in a separate box on
    // top (product request: one single time-sorted list, newest first). Merged
    // on page 1 only (same as the share-open merge above) so they aren't repeated
    // per page; they're extra rows beyond pagelength, so none are dropped and the
    // feed's pagination of older items is unaffected. The client still fetches
    // these via activity.list / channel.list_notifications for the unread BADGE —
    // this only changes WHERE they render. Best-effort: a failure never breaks
    // the rest of the feed.
    if (filter !== 'mentions' && filter !== 'shares' && page <= 1) {
      try {
        // chat/media/teamchat/ticket rollups are NOT returned by
        // activity_get_feed_all, so merge them in BOTH modes. contact /
        // hub-invite / refused-invitation rollups ARE returned by
        // activity_get_feed_all (the Unread-OFF feed), so only merge them under
        // Unread ON — otherwise the same event double-shows under Unread OFF.
        const ALWAYS = new Set(['chat', 'media', 'teamchat', 'ticket']);
        const rollups = await this._notificationRollups();
        for (const r of rollups) {
          if (!r) continue;
          // Shared-workspace membership is not available to every legacy MFS
          // feed deployment. Add the dedicated workspace-move row when the
          // base changelog feed did not return it; the id check prevents a
          // duplicate once that feed includes it.
          if (r.category === 'workspace_move') {
            const exists = result.some((item) => (
              String(item.id) === String(r.key_id)
              && item.event === 'media.workspace_move'
            ));
            if (!exists) {
              result.push({
                ...r,
                id: r.key_id,
                event_type: 'mfs',
                is_read: 0,
                timestamp: r.ctime,
              });
            }
            continue;
          }
          if (!ALWAYS.has(r.category) && !unreadOnly) continue;
          // Item skeleton + sort read `timestamp` first, then `ctime`; rollups
          // only carry ctime, so mirror it to timestamp for correct ordering.
          if (r.timestamp == null) r.timestamp = r.ctime;
          // Rollups come from unread-only procedures and historically omitted
          // is_read. The unified mobile contract must not guess their state.
          if (r.is_read == null) r.is_read = 0;
          result.push(r);
        }
        // Task @-mentions / assignments and admin-console storage alerts live
        // in yp.contact_activity → under Unread OFF they already come from
        // activity_get_feed_all; merge their UNREAD rows only under Unread ON
        // so they show in the default view without double-showing under OFF.
        // Every new contact_activity event needs its own *_unread proc here —
        // storage_alert was added without one, so recipients got the email but
        // no in-app notification (the panel opens on Unread ON). Each proc is
        // independently best-effort so a missing/failing one never sinks the
        // others.
        if (unreadOnly) {
          for (const proc of [
            'contact_task_assigned_unread',
            'contact_task_mention_unread',
            'contact_task_column_change_unread',
            'contact_storage_alert_unread',
            // Claim-reward term ending (offline/workers/rewardExpiryWorker.js).
            // Added with the event, not after it, per the note above.
            'contact_reward_expiry_unread',
          ]) {
            try {
              const rows = toArray(await this.yp.await_proc(proc, this.uid));
              for (const r of rows) {
                if (!r) continue;
                if (r.timestamp == null) r.timestamp = r.ctime;
                result.push(r);
              }
            } catch (e) {
              // debug (not warn) on purpose: a missing proc during the rollout
              // window (server deployed before the SQL is applied) is expected
              // and degrades gracefully (task items still show under Unread OFF
              // via activity_get_feed_all). warn would spam the Telegram alert
              // bot every call until the proc lands.
              this.debug(`[ACTIVITY] ${proc} merge skipped`, e && e.message);
            }
          }
        }
        result.sort((a, b) => (Number(b.timestamp || b.ctime || 0) - Number(a.timestamp || a.ctime || 0)));
      } catch (e) {
        this.warn('[ACTIVITY] rollup merge failed', e && e.message);
      }
    }

    // Flatten task fields onto the feed rows so the client can render and open
    // assignments, mentions, and watched-column create/move notifications.
    flattenTaskFields(result);
    flattenTaskColumnChange(result);

    this.output.list(await this._decorateBookmarks(result));
  }

  async _decorateBookmarks(rows) {
    let saved = [];
    try {
      saved = toArray(await this._callUserProc(
        'notification_activity_bookmark_list',
      ));
    } catch (e) {
      this.debug('[ACTIVITY] bookmark list unavailable', e && e.message);
    }
    const savedKeys = new Set(saved.map(row => row && row.bookmark_key).filter(Boolean));
    return rows.map(row => {
      const key = bookmarkKey(row);
      return {
        ...row,
        ...(key ? {bookmark_key: key, is_saved: savedKeys.has(key) ? 1 : 0} : {}),
      };
    });
  }

  /**
   * List undismissed task assignments and watched-column notifications for the
   * pinned activity section + bell badge. Rows are shaped like
   * activity_get_feed_all's contact branch, with task metadata flattened so
   * the client can render and open the task.
   * Endpoint: POST /activity.list_task_assignments
   */
  async list_task_assignments() {
    let rows = [];
    try {
      rows = toArray(await this.yp.await_proc('contact_task_assigned_unread', this.uid));
    } catch (e) {
      this.warn('[ACTIVITY] contact_task_assigned_unread failed', e && e.message);
      return this.output.list([]);
    }
    flattenTaskFields(rows);
    // Merge undismissed column-watch notifications into the same unread list so
    // they show in the pinned section + bump the badge, exactly like assignments.
    try {
      const colRows = toArray(
        await this.yp.await_proc('contact_task_column_change_unread', this.uid),
      );
      flattenTaskColumnChange(colRows);
      rows = rows.concat(colRows);
      rows.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    } catch (e) {
      this.warn('[ACTIVITY] contact_task_column_change_unread failed', e && e.message);
    }
    this.output.list(rows);
  }


  /**
   * Get unified activity log (contacts + MFS)
   * Endpoint: GET /activity.log
   * 
   * Priority: ALL contact events first, then ALL MFS events
   */
  async log() {
    const page = this.input.use(Attr.page) || 1;
    this.debug(`[ACTIVITY] Getting unified log for user ${this.uid}, page: ${page}`);

    const result = await this._callUserProc('activity_get_log', this.uid, page);

    this.output.list(result);
  }

  /**
   * Get activity log for a specific folder
   * Endpoint: GET /activity.folder_log
   * Shows MFS events related to a specific folder/node
   */
  async folder_log() {
    const nid = this.input.need(Attr.nid);
    const page = this.input.use(Attr.page) || 1;

    this.debug(`[ACTIVITY] Getting folder log for nid: ${nid}, user: ${this.uid}, page: ${page}`);

    const result = await this._callUserProc('activity_get_folder_log', this.uid, nid, page);

    this.output.list(result);
  }

  /**
   * Get last read information
   * Endpoint: GET /mfs_activity.get_last_read
   * 
   * Output:
   * - last_read_id: Last changelog ID marked as read
   */
  async get_last_read() {
    // Get user's database name
    const userDb = await this.yp.await_query(
      'SELECT db_name FROM yp.entity WHERE id = ?',
      this.uid
    );
    const userDbName = toArray(userDb)[0]?.db_name;

    if (!userDbName) {
      this.warn(`[MFS_ACTIVITY] User database not found for ${this.uid}`);
      return this.output.data({
        user_id: this.uid,
        last_read_id: 0,
        mtime: 0
      });
    }

    this.debug(`[MFS_ACTIVITY] Querying mfs_ack from ${userDbName}`);

    // Query mfs_ack from user's database
    const result = await this.db.await_query(
      `SELECT user_id, last_read_id, mtime FROM ${userDbName}.mfs_ack WHERE user_id = ?`,
      this.uid
    );

    const data = toArray(result)[0];

    if (data) {
      this.output.data(data);
    } else {
      this.output.data({
        user_id: this.uid,
        last_read_id: 0,
        mtime: 0
      });
    }

  }

  /**
  * Acknowledge/mark a specific file as seen
  * 
  * This replaces the old media.mark_as_seen which used JSON metadata
  * New approach: Uses mfs_changelog + mfs_ack for better performance
  * 
  */
  async acknowledge_file() {
    const nodeId = this.input.need(Attr.nid);
    const userId = this.uid;

    this.debug(`[MFS_ACTIVITY] Acknowledging file: ${nodeId} for user: ${userId}`);

    const result = await this._callUserProc('mfs_acknowledge_file', userId, nodeId);
    const data = toArray(result)[0];

    if (data && data.status === 'ok') {
      const recipients = await this.yp.await_proc('user_sockets', userId);
      const keys = { entity_id: Attr.hub_id };

      await RedisStore.sendData(
        this.payload(data, { keys }),
        recipients
      );

      await RedisStore.sendData(
        this.payload({}, { service: 'notification.resync' }),
        recipients
      );

      return this.output.data({
        status: 'ok',
        message: 'File acknowledged',
        last_read_id: data.last_read_id,
        mtime: data.mtime
      });

    }
    this.warn('[MFS_ACTIVITY] acknowledge_file failed:', data);
    this.output.data({
      status: 'error',
      message: 'File not acknowledged',
    });

  }

  async dismiss() {
    const changelogId = parseInt(this.input.need('changelog_id'));
    const result = await this._callUserProc('mfs_dismiss_activity', this.uid, changelogId);
    const data = toArray(result)[0] || {};
    this.output.data(data);
  }

  /**
   * Hide a single contact_activity row (hub invite, contact invite, etc.)
   * from the user's activity feed. Underlying event stays around for audit.
   * Endpoint: POST /activity.dismiss_contact_event
   * Input: activity_id (integer)
   */
  async dismiss_contact_event() {
    const activityId = parseInt(this.input.need('activity_id'));
    const result = await this._callUserProc('contact_activity_dismiss', this.uid, activityId);
    const data = toArray(result)[0] || {};
    this.output.data(data);
  }

  /**
   * Unified notification dismiss for any rollup returned by drumate.notification_center.
   * Routes by `category` to the right read-pointer / status update.
   * Endpoint: POST /activity.notification_dismiss
   * Input: category (string), key_id (string), hub_id (string), last_id (integer)
   */
  async notification_dismiss() {
    const category = String(this.input.need('category'));
    const keyId = String(this.input.need('key_id'));
    const hubId = String(this.input.use('hub_id') || '');
    const lastId = Number(this.input.need('last_id'));
    if (category !== 'contact' && (!Number.isSafeInteger(lastId) || lastId < 1)) {
      return this.exception.bad_request('INVALID_DATA');
    }
    const row = await this._visibleNotificationRollup(category, keyId, hubId, lastId);
    if (!row) return this.exception.bad_request('INVALID_DATA');
    const result = await this._callUserProc(
      'notification_dismiss',
      category,
      String(row.key_id),
      String(row.hub_id || ''),
      Number(row.last_id || 0),
    );
    const data = toArray(result)[0] || {};
    this.output.data(data);
  }

  // ============================================================
  // Unified activity API (Approach C: wrap-only consolidation)
  //
  // The activity panel and any other client should use only these
  // four endpoints; underlying tables stay where they are.
  // ============================================================

  /**
   * Single-call notification feed. Aggregates the 5 rollup categories from
   * `notification_center_next` plus the standalone hub-invite stream from
   * `yp.contact_activity` (event = 'hub_invite_received'). Result is a flat
   * array; client renders by `category`.
   *
   * Endpoint: POST /activity.list
   */
  async list() {
    // Web Activity owns task assignment/mention queries separately. Keeping
    // them out of this legacy priority-rollup endpoint prevents double badge
    // counts; the chronological mobile surface uses activity.get_feed instead.
    this.output.list(await this._notificationRollups());
  }

  async _taskNotificationRollups() {
    const rows = [];
    for (const proc of [
      'contact_task_assigned_unread',
      'contact_task_mention_unread',
    ]) {
      try {
        rows.push(...toArray(await this.yp.await_proc(proc, this.uid)));
      } catch (e) {
        this.debug(`[ACTIVITY] ${proc} unavailable`, e && e.message);
      }
    }
    flattenTaskFields(rows);
    return rows
      .filter(row => row && row.id &&
        (row.event === 'task_assigned' || row.event === 'task_mention'))
      .map(mapTaskNotificationRow);
  }

  /**
   * Build the flat list of rollup notification items (the 5 notification_center
   * rollup categories + hub-invites + refused-invitations), each mapped to the
   * common item shape. Shared by `list()` (the badge/priority source) and
   * `get_feed()` (which now interleaves these rollups chronologically into the
   * activity feed instead of the client pinning them in a separate section).
   * Best-effort: a failing sub-source degrades to [] rather than throwing.
   */
  async _notificationRollups() {
    const [rollups, hubInvites] = await Promise.all([
      this._callUserProc('notification_center_next'),
      this._callUserProc('notification_hub_invites'),
    ]);
    const rows = toArray(rollups);
    const hubs = toArray(hubInvites);
    let refused = [];
    let workspaceMoves = [];
    try {
      refused = toArray(await this._callUserProc('notification_contact_refused'));
    } catch (_) { }
    try {
      workspaceMoves = toArray(await this._callUserProc('notification_workspace_moves'));
    } catch (e) {
      // Allow the server rollout to precede the schema patch without breaking
      // the existing notification badge.
      this.debug('[ACTIVITY] notification_workspace_moves unavailable', e && e.message);
    }
    return [
      ...rows.map(mapNotificationRow),
      ...hubs.map(mapHubInviteRow),
      ...refused.map(mapContactRefusedRow),
      ...workspaceMoves,
    ];
  }

  async _visibleNotificationRollup(category, keyId, hubId, lastId) {
    if (!ROLLUP_MUTATION_CATEGORIES.has(category)) return null;
    const rows = await this._notificationRollups();
    return rows.find(row => (
      row
      && String(row.category || '') === category
      && String(row.key_id || '') === keyId
      && String(row.hub_id || '') === hubId
      && (category === 'contact' || Number(row.last_id || 0) === lastId)
    )) || null;
  }

  /**
   * Alias of `notification_dismiss` under the consolidated activity.* API.
   * Hides the rollup row from the activity feed.
   * Endpoint: POST /activity.dismiss
   */
  async dismiss_rollup() {
    const category = String(this.input.need('category'));
    if (CONTACT_ACTIVITY_CATEGORIES.has(category)) {
      const activityId = Number(this.input.need('key_id'));
      if (!Number.isSafeInteger(activityId) || activityId < 1) {
        return this.exception.bad_request('INVALID_DATA');
      }
      const result = await this._callUserProc(
        'contact_activity_dismiss',
        this.uid,
        activityId,
      );
      return this.output.data(toArray(result)[0] || {});
    }
    return this.notification_dismiss();
  }

  async dismiss_history() {
    const historyId = Number(this.input.need('history_id'));
    if (!Number.isSafeInteger(historyId) || historyId < 1) {
      return this.exception.bad_request('INVALID_DATA');
    }
    const result = await this._callUserProc(
      'notification_history_hide',
      historyId,
    );
    return this.output.data(toArray(result)[0] || {});
  }

  async bookmark_add() {
    const bookmarkKey = String(this.input.need('bookmark_key'));
    if (!/^[a-f0-9]{64}$/.test(bookmarkKey)) {
      return this.exception.bad_request('INVALID_DATA');
    }
    const result = await this._callUserProc(
      'notification_activity_bookmark_add',
      bookmarkKey,
    );
    return this.output.data(toArray(result)[0] || {});
  }

  async bookmark_remove() {
    const bookmarkKey = String(this.input.need('bookmark_key'));
    if (!/^[a-f0-9]{64}$/.test(bookmarkKey)) {
      return this.exception.bad_request('INVALID_DATA');
    }
    const result = await this._callUserProc(
      'notification_activity_bookmark_remove',
      bookmarkKey,
    );
    return this.output.data(toArray(result)[0] || {});
  }

  /**
   * Mark a rollup as read without hiding it. For backends that distinguish
   * between read-pointer and dismissed-flag (contact, mfs_changelog), we only
   * advance the read pointer. For the others (chat/teamchat/ticket) read and
   * dismiss collapse into the same operation, so we just delegate.
   * Endpoint: POST /activity.read
   */
  async read() {
    const category = String(this.input.need('category'));
    const keyId = String(this.input.need('key_id'));
    if (CONTACT_ACTIVITY_CATEGORIES.has(category)) {
      const activityId = Number(keyId);
      if (!Number.isSafeInteger(activityId) || activityId < 1) {
        return this.exception.bad_request('INVALID_DATA');
      }
      return this.output.data({status: 'ok', changed: 0});
    }
    const hubId = String(this.input.use('hub_id') || '');
    const lastId = Number(this.input.need('last_id'));
    if (!Number.isSafeInteger(lastId) || lastId < 1) {
      return this.exception.bad_request('INVALID_DATA');
    }
    const row = await this._visibleNotificationRollup(category, keyId, hubId, lastId);
    if (!row) return this.exception.bad_request('INVALID_DATA');
    const result = await this._callUserProc(
      'notification_read',
      category,
      String(row.key_id),
      String(row.hub_id || ''),
      Number(row.last_id || 0),
      Number(row.ctime || 0),
    );
    const data = toArray(result)[0] || {};
    this.output.data(data);
  }

  /**
   * Publish a new notification. Routes by `category` to the appropriate
   * underlying table. Public callers rarely need this — most events are
   * created as side-effects of chat.post / media.new / hub.invite. This
   * endpoint exists so future system integrations can inject notifications
   * via the `activity.*` namespace.
   * Endpoint: POST /activity.create
   * Input: category (string), key_id (string), hub_id (string), payload (object)
   */
  async create() {
    const category = String(this.input.need('category'));
    const key_id = String(this.input.need('key_id'));
    const hub_id = String(this.input.use('hub_id') || '');
    const payload = this.input.use('payload') || {};
    const result = await this.yp.await_proc(
      'activity_publish',
      category,
      this.uid,
      key_id,
      hub_id,
      JSON.stringify(payload)
    );
    const data = toArray(result)[0] || { status: 'ok', category, key_id };
    this.output.data(data);
  }
}

MfsActivity.bookmarkKey = bookmarkKey;
module.exports = MfsActivity;
