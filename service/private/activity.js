// File: service/private/activity.js
// Purpose: MFS activity notification service - handle read/unread status

const { Entity } = require('@drumee/server-core');
const { RedisStore, Attr, toArray } = require('@drumee/server-essentials');
const { resolveHubInviteName } = require('../lib/hub-invite-name');

function firstValue(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    return value;
  }
  return undefined;
}

function mapNotificationRow(r) {
  const item = {
    category: r.category,
    key_id: r.category === 'media' ? firstValue(r.hub_id, r.key_id) : r.key_id,
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

// ---------------------------------------------------------------------------
// Notification buckets — the 5 Notification Center tabs (Round 3 / Sprint 1).
//
// The tab a notification belongs to is decided HERE, server-side, and shipped on
// every row as `bucket`. The client only reads it and never re-derives one: an
// event maps to exactly one bucket at generation time, so the same event cannot
// land in two different tabs on two different surfaces.
//
// Rows arrive in three different shapes, which is why the checks are ordered
// instead of being a single lookup:
//   - notification_center_next rollups → `category` (chat|teamchat|media|ticket|
//     contact), plus `meeting_action` on teamchat rows
//   - activity_get_feed_all rows       → `event_type` ('mfs' | 'contact')
//   - mfs_get_activity_feed rows       → neither, only `event`
// ---------------------------------------------------------------------------
const BUCKET = {
  files: 'files',
  task: 'task',
  meeting: 'meeting',
  chat: 'chat',
  other: 'other',
};

// Matched FIRST, by exact event name. Task events live in yp.contact_activity,
// so their category AND event_type both resolve to 'contact' — without this
// every task notification would land in Other. The client's getActivityMeta()
// works around the same trap to pick its copy, so the two must stay in step.
const BUCKET_BY_EVENT = {
  task_assigned: BUCKET.task,
  task_mention: BUCKET.task,
  task_column_change: BUCKET.task,
  // A bare @-mention row (channel.list_notifications, type='mention') carries no
  // category at all; a chat mention belongs to Chat.
  mention: BUCKET.chat,
};

const BUCKET_BY_CATEGORY = {
  // Files — uploads, folder creates, shares, removes, workspace moves.
  //
  // ⚠️ Link-sharing notifications (`share_open`, `media.share`) belong to FILES,
  // and that is deliberate even though the backlog's row-4 text lists "Files/
  // Folders's link sharing activity" under Other. Lexis (PO) was asked directly
  // on 2026-08-19 — including the folder-link case — and ruled Files, because
  // Other is defined as member invites plus miscellaneous. The PO's call wins
  // over the sheet's prose; do not "fix" this back from the sheet.
  media: BUCKET.files,
  mfs: BUCKET.files,
  workspace_move: BUCKET.files,
  share_open: BUCKET.files,
  // Chat — p2p messages and folder chat. A teamchat rollup carrying a
  // meeting_action is re-routed to Meeting below, before this lookup runs.
  chat: BUCKET.chat,
  teamchat: BUCKET.chat,
  meeting: BUCKET.meeting,
  // Other — workspace/team invites, contacts, tickets, access requests and
  // (via the default) every system alert.
  contact: BUCKET.other,
  contact_invite: BUCKET.other,
  contact_refused: BUCKET.other,
  hub_invite: BUCKET.other,
  ticket: BUCKET.other,
  access_request: BUCKET.other,
};

// Last resort for rows that carry only an `event`: mfs_get_activity_feed (the
// Unread-ON feed) returns no category and no event_type whatsoever.
const BUCKET_BY_EVENT_PREFIX = [
  ['media.', BUCKET.files],
  ['secure_share.', BUCKET.files],
  ['chat.', BUCKET.chat],
  ['channel.', BUCKET.chat],
  ['conference.', BUCKET.meeting],
  ['room.', BUCKET.meeting],
  ['contact.', BUCKET.other],
  ['hub.', BUCKET.other],
];

// Own-property lookup only. `event` / `category` come straight from the DB, so a
// row whose value happens to be an Object.prototype key ('constructor',
// 'toString', …) would otherwise resolve to an inherited function and be stamped
// as the bucket. Not reachable from user input today, but a plain `map[key]`
// here is a silent correctness hole, not a style question.
function lookup(map, key) {
  if (!key) return null;
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
}

function bucketOf(row) {
  if (!row) return BUCKET.other;
  const event = String(row.event || '');

  const byEvent = lookup(BUCKET_BY_EVENT, event);
  if (byEvent) return byEvent;

  // A folder-chat rollup whose latest unread event is a meeting start/end is a
  // MEETING, not a chat message. notification_center_next surfaces that as
  // meeting_action and the client already renders meeting copy for it ("started
  // a meeting in <folder>"), so the bucket has to agree — otherwise the row
  // would read as a meeting while sitting in the Chat tab.
  if (row.meeting_action === 'start' || row.meeting_action === 'end') {
    return BUCKET.meeting;
  }

  const byCategory = lookup(BUCKET_BY_CATEGORY, row.category || row.event_type || row.type);
  if (byCategory) return byCategory;

  for (const [prefix, bucket] of BUCKET_BY_EVENT_PREFIX) {
    if (event.startsWith(prefix)) return bucket;
  }

  // Anything unrecognised — including every future system alert — falls into
  // Other. Never drop a row: an unmapped notification must stay reachable.
  return BUCKET.other;
}

// Stamp `bucket` on every row, in place. Idempotent, and never overwrites a
// bucket a row already carries.
function stampBuckets(rows) {
  for (const r of rows) {
    if (r && r.bucket == null) r.bucket = bucketOf(r);
  }
  return rows;
}

// A caller-supplied bucket is only honoured when it names one of the 5 tabs;
// anything else (absent, empty, typo'd) means "no bucket scope" and every path
// keeps its pre-existing, unscoped behaviour.
function validBucket(value) {
  return lookup(BUCKET, String(value || '').trim());
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
    // Round 3: "Mark as all read" acts on the tab the user is looking at.
    // null = unscoped = clear everything, exactly as before this existed.
    const bucket = validBucket(this.input.use('bucket'));
    // The changelog read pointer and the share-open seen flag both back the Files
    // tab, so they are skipped when the user is clearing a different tab. Without
    // this, clearing "Chat" would silently mark every file notification read too.
    const clearFiles = !bucket || bucket === BUCKET.files;

    this.debug(`[MFS_ACTIVITY] Marking all read for user ${this.uid}, last_id: ${lastId}, bucket: ${bucket || 'all'}`);

    // Seeded with the same shape the proc returns, so a scoped call that never
    // touches the changelog still answers with a stable payload instead of an
    // undefined last_read_id.
    let data = { status: 'ok', last_read_id: 0 };
    if (clearFiles) {
      const result = await this._callUserProc('mfs_mark_all_read', this.uid, lastId);
      data = toArray(result)[0];
    }

    // "Mark all as read" must also clear share-open notifications, which ride the
    // feed via secure_share_open_feed / creator_seen_at (not mfs_mark_all_read).
    // Best-effort — never fail the whole mark-all if this errors.
    if (clearFiles) {
      try {
        await this.yp.await_proc('secure_share_mark_all_open_seen', this.uid);
      } catch (e) {
        this.warn('[MFS_ACTIVITY] mark_all_read: secure_share_mark_all_open_seen failed', e && e.message);
      }
    }

    // "Mark all as read" must also persist-clear the pinned rollups
    // (media/chat/teamchat/contact/ticket) — otherwise they reappear on reload.
    // Reuse the already-tested procs: enumerate with notification_center_next,
    // then notification_dismiss each with the same per-category key resolution the
    // individual (trash-button) dismiss uses. Server-side loop so the client makes
    // one call. Best-effort per rollup — never fail the whole mark-all.
    try {
      const rollups = toArray(await this._callUserProc('notification_center_next'));
      for (const r of rollups) {
        if (!r || !r.category) continue;
        // Same bucket rule the tabs are built from, so "clear this tab" clears
        // exactly the rows that tab shows — a teamchat rollup carrying a
        // meeting_action is cleared by Meeting, not by Chat.
        if (bucket && bucketOf(r) !== bucket) continue;
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
        try {
          await this._callUserProc(
            'notification_dismiss',
            String(r.category),
            String(keyId),
            String(r.hub_id || ''),
            parseInt(r.last_id || 0)
          );
        } catch (e) {
          this.warn('[MFS_ACTIVITY] mark_all_read: rollup dismiss failed', r.category, e && e.message);
        }
      }
    } catch (e) {
      this.warn('[MFS_ACTIVITY] mark_all_read: rollup enumerate failed', e && e.message);
    }

    // Task rows are yp.contact_activity events, NOT notification_center_next
    // rollups, so the loop above has never been able to clear them — clearing
    // "all" left them behind. The 5-tab UI makes that visible: a Mark-as-all-read
    // on the Task tab would appear to do nothing at all.
    //
    // Scoped to bucket === 'task' ON PURPOSE. Doing it unscoped would clear rows
    // the unscoped call has never cleared, which is a behaviour change to a path
    // that works today — so the capability is added only on the new code path.
    // Pre-existing unscoped behaviour stays untouched.
    if (bucket === BUCKET.task) {
      for (const proc of [
        'contact_task_assigned_unread',
        'contact_task_mention_unread',
        'contact_task_column_change_unread',
      ]) {
        try {
          const rows = toArray(await this.yp.await_proc(proc, this.uid));
          for (const r of rows) {
            const activityId = parseInt(r && r.id);
            if (!activityId) continue;
            try {
              await this._callUserProc('contact_activity_dismiss', this.uid, activityId);
            } catch (e) {
              this.warn('[MFS_ACTIVITY] mark_all_read: task dismiss failed', activityId, e && e.message);
            }
          }
        } catch (e) {
          // A missing proc during a rollout window must not sink the whole call —
          // same reasoning as the get_feed merge above (debug, not warn, so the
          // alert bot isn't spammed until the SQL lands).
          this.debug(`[MFS_ACTIVITY] mark_all_read: ${proc} skipped`, e && e.message);
        }
      }
    }

    if (data && data.status === 'ok') {
      return this.output.data({
        status: 'ok',
        // The unscoped wording is unchanged on purpose; only a tab-scoped call
        // gets different copy, because claiming "all" there would be false.
        message: bucket
          ? `Notifications marked as read for ${bucket}`
          : 'All notifications marked as read',
        bucket: bucket || null,
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
    // Round 3: one of the 5 Notification Center tabs. null = unscoped, i.e. the
    // exact pre-existing behaviour for every caller that doesn't send it.
    const bucket = validBucket(this.input.use('bucket'));
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
      // Fail-safe: if activity_get_feed_all isn't present on this DB instance
      // yet (schema not applied), degrade to the legacy unified log instead of
      // erroring out the whole panel. Worst case = prior "off" behaviour.
      try {
        result = await this._callUserProc('activity_get_feed_all', this.uid, page);
      } catch (e) {
        this.warn('[ACTIVITY] activity_get_feed_all unavailable, falling back to activity_get_log', e);
        result = await this._callUserProc('activity_get_log', this.uid, page);
      }
    }
    result = toArray(result);
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

    // Stamp the tab on every row, then (only when the caller asked for a tab)
    // narrow to it. Deliberately AFTER every merge above, so a row is judged by
    // its final shape — the rollup merge is what supplies `category` and
    // `meeting_action`, and flattenTaskFields runs before this too.
    //
    // Filtering the assembled page rather than filtering in SQL matches how the
    // existing `mentions` / `shares` tabs have always worked (see the filter
    // branch near the top of this method): a tab's page N holds that tab's share
    // of feed page N. Same trade-off, no new behaviour — and crucially, without
    // a `bucket` the output is byte-for-byte what it was before.
    stampBuckets(result);
    if (bucket) {
      result = result.filter((row) => row && row.bucket === bucket);
    }

    this.output.list(result);
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
    // These rows are pinned into the panel alongside activity.list rows, so they
    // need the same `bucket` field or the client cannot filter them by tab. They
    // resolve to `task` via their event name — the client relabels their
    // `category` to 'contact_invite' for dismiss routing, which would otherwise
    // send them to Other.
    stampBuckets(rows);
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
    const key_id = String(this.input.need('key_id'));
    const hub_id = String(this.input.use('hub_id') || '');
    const last_id = parseInt(this.input.use('last_id') || 0);
    const result = await this._callUserProc(
      'notification_dismiss',
      category,
      key_id,
      hub_id,
      last_id
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
    this.output.list(await this._notificationRollups());
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
    // Stamp `bucket` here so BOTH consumers get it from one place: list() (the
    // badge / priority source) and get_feed()'s chronological merge. Purely
    // additive — an existing client that ignores the field is unaffected.
    return stampBuckets([
      ...rows.map(mapNotificationRow),
      ...hubs.map(mapHubInviteRow),
      ...refused.map(mapContactRefusedRow),
      ...workspaceMoves,
    ]);
  }

  /**
   * Unread count per Notification Center tab, for the badges on the tab bar
   * (Figma `number-noti`). One call, so the panel does not fan out per tab.
   *
   * Counting convention is ONE PER ROW, not the sum of each rollup's `cnt` —
   * the same convention the bell badge already uses. "Tran sent 3 messages"
   * is one row the user sees, so it is one, not three. Changing that here
   * would make the tab badges disagree with the bell.
   *
   * Every source is best-effort and independent: a failing or not-yet-deployed
   * proc contributes 0 rather than sinking the whole response, because a wrong
   * badge is far better than a panel that cannot render its tab bar.
   *
   * Endpoint: POST /activity.unread_counts
   * Output: { all, files, task, meeting, chat, other }
   */
  async unread_counts() {
    const counts = { files: 0, task: 0, meeting: 0, chat: 0, other: 0 };
    // bucketOf only ever returns one of the five, but guard the write anyway so
    // an unexpected value can never create a stray key on the response.
    const bump = (row) => {
      const bucket = bucketOf(row);
      if (Object.prototype.hasOwnProperty.call(counts, bucket)) counts[bucket] += 1;
    };

    // 1. The rollup categories + hub invites + refused invitations + workspace
    //    moves. Already bucket-stamped; bucketOf is idempotent on them.
    try {
      for (const r of await this._notificationRollups()) if (r) bump(r);
    } catch (e) {
      this.warn('[ACTIVITY] unread_counts: rollups failed', e && e.message);
    }

    // 2. yp.contact_activity unread rows. Task events land in Task; the system
    //    alerts (storage, reward expiry) land in Other. Same proc list get_feed
    //    merges, so the badge and the feed agree on what exists.
    for (const proc of [
      'contact_task_assigned_unread',
      'contact_task_mention_unread',
      'contact_task_column_change_unread',
      'contact_storage_alert_unread',
      'contact_reward_expiry_unread',
    ]) {
      try {
        for (const r of toArray(await this.yp.await_proc(proc, this.uid))) if (r) bump(r);
      } catch (e) {
        // debug, not warn: a proc missing during a rollout window is expected
        // and must not spam the alert bot.
        this.debug(`[ACTIVITY] unread_counts: ${proc} skipped`, e && e.message);
      }
    }

    // 3. Unread secure-share opens ("{email} opened {folder}") — Files, per the
    //    PO's ruling that link-sharing activity belongs to Files.
    try {
      const opens = toArray(await this.yp.await_proc('secure_share_open_feed', this.uid, 1));
      for (const r of opens) if (r) bump({ ...r, category: 'share_open' });
    } catch (e) {
      this.debug('[ACTIVITY] unread_counts: secure_share_open_feed skipped', e && e.message);
    }

    // 4. Pending secure-share access requests addressed to this user — Other.
    //    The panel counts these into the bell badge today, so leaving them out
    //    would make the tabs sum to less than the bell.
    try {
      const reqs = toArray(await this.yp.await_proc('secure_share_list_requests', this.uid));
      for (const r of reqs) if (r) bump({ ...r, category: 'access_request' });
    } catch (e) {
      this.debug('[ACTIVITY] unread_counts: secure_share_list_requests skipped', e && e.message);
    }

    const all = counts.files + counts.task + counts.meeting + counts.chat + counts.other;
    this.output.data({ all, ...counts });
  }

  /**
   * Alias of `notification_dismiss` under the consolidated activity.* API.
   * Hides the rollup row from the activity feed.
   * Endpoint: POST /activity.dismiss
   */
  async dismiss_rollup() {
    return this.notification_dismiss();
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
    const key_id = String(this.input.need('key_id'));
    const hub_id = String(this.input.use('hub_id') || '');
    const last_id = parseInt(this.input.use('last_id') || 0);
    const result = await this._callUserProc(
      'notification_read',
      category,
      key_id,
      hub_id,
      last_id
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

module.exports = MfsActivity;
