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

// Which identity to look up for a share-open event, or null when the opener is
// genuinely anonymous. Shared by the resolver and the row builder so the two can
// never disagree about what was looked up.
//
// The recipient's email wins over the actor id when both exist: the email is the
// identity the row already displays, so resolving THAT keeps the name and the
// avatar the same person. `ffffffffffffffff` is the anonymous sentinel — an
// unauthenticated visitor on a public link (same guard as
// service/private/secure_share.js).
const ANONYMOUS_UID = 'ffffffffffffffff';
function openerKeyOf(r) {
  if (!r) return null;
  if (r.recipient_email) return r.recipient_email;
  const id = r.actor_id;
  if (!id || id === ANONYMOUS_UID) return null;
  return id;
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

  // A folder chat rollup names the folder the message was posted in, which is
  // the chip. The sentence therefore no longer has to carry it — see the
  // teamchat branch in the row skeleton.
  if (r.category === 'teamchat') {
    item.folder_name = item.filename;
  }

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
    // The containing folder/workspace, for the card's folder chip (Figma
    // component property `folder-name`). On a media rollup `targetName` IS the
    // destination folder — the uploaded file's own name is item_filename — so
    // the chip and the sentence read from two different fields and cannot
    // duplicate each other. Raw mfs_changelog rows carry only the file, and get
    // this resolved from their parent id instead; see _stampFolderNames.
    item.folder_name = targetName;
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
      // The other kinds that ride this event (Round 3, Duy 2026-08-21) need one
      // extra field each for their sentence. All optional and all guarded, so a
      // plain mention or a reply is shaped exactly as before.
      //   priority → the new priority         ("… to High")
      //   moved    → the destination column    ("… moved to In progress")
      //              and whether it is a DONE column ("… marked as completed")
      if (r.task_priority == null && meta.priority != null) r.task_priority = meta.priority;
      if (r.column_key == null && meta.column_key != null) r.column_key = meta.column_key;
      if (r.column_name == null && meta.column_name != null) r.column_name = meta.column_name;
      if (r.task_is_done == null && meta.is_done != null) r.task_is_done = meta.is_done;
    }
  }
  return rows;
}

// Surface the scheduled-meeting fields from a `meeting_notice` row's nested
// `data` JSON (written by service/private/room.js) so the client can render the
// sentence and open the meeting's folder without re-parsing the JSON. Same
// contract and same idempotence as flattenTaskFields; touches no other event.
function flattenMeetingNotice(rows) {
  for (const r of rows) {
    if (!r || r.event !== 'meeting_notice') continue;
    let meta = r.data;
    if (typeof meta === 'string') {
      try { meta = JSON.parse(meta); } catch (e) { meta = null; }
    }
    meta = meta || {};
    // 'invite' | 'moved' | 'cancelled'. The client defaults an unknown kind to
    // the invitation wording rather than falling through to contact copy.
    if (r.meeting_kind == null && meta.kind != null) r.meeting_kind = meta.kind;
    if (r.meeting_title == null) r.meeting_title = meta.title || '';
    if (r.meeting_stime == null && meta.stime != null) r.meeting_stime = meta.stime;
    if (r.meeting_nid == null && meta.nid != null) r.meeting_nid = meta.nid;
    // The meeting node's PARENT — the folder the click opens. Deliberately not
    // the node itself: a cancelled meeting's node is hard-deleted
    // (permission_revoke DELETEs a `schedule` row), so opening it would render
    // "the file you requested does not exist".
    if (r.meeting_pid == null && meta.pid != null) r.meeting_pid = meta.pid;
    if (r.meeting_hub_id == null && meta.hub_id != null) r.meeting_hub_id = meta.hub_id;
    // The chip. Resolved by room.js at write time from the parent node, because
    // a cancelled meeting can no longer be looked up when the row is READ.
    if (r.folder_name == null && meta.folder_name != null) r.folder_name = meta.folder_name;
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
  // A scheduled-meeting notice (invited / rescheduled / cancelled). Another
  // yp.contact_activity event, so its category resolves to 'contact' and it
  // would otherwise land in Other.
  meeting_notice: BUCKET.meeting,
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

  // A SCHEDULED meeting is a media node (room.book creates a `schedule` node),
  // so notification_center_next rolls it up as an upload and it used to sit in
  // Files reading "<organizer> uploaded <Meeting-name>" (Duy 2026-08-21).
  //
  // The `cnt <= 1` guard is load-bearing and MUST match the client's: the rollup
  // groups per folder and reports MAX(item_filetype), so a folder holding a
  // meeting AND an ordinary file arrives tagged 'schedule' with cnt > 1. Moving
  // that row to Meeting would hide a real upload behind meeting copy, so a
  // multi-item rollup keeps its existing Files behaviour untouched.
  if (isScheduleRollup(row)) return BUCKET.meeting;

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

// ---------------------------------------------------------------------------
// Scheduled meetings arrive on TWO channels, and exactly one row must survive.
//
//   1. the media rollup for the meeting's `schedule` node — what every workspace
//      member sees, reading "<Meeting-name> on <time>" (Figma's scheduled card);
//   2. a targeted `meeting_notice` invitation — what an ATTENDEE sees, reading
//      "<organizer> invited you to <Meeting-name>".
//
// Duy 2026-08-21 asked for the invitation to REPLACE the rollup row, so when
// both are present for the same meeting the rollup is dropped. The two are
// matched on (hub, title): notification_center_next does not carry the meeting
// node's own id, so the title is the only key both channels share.
//
// Deciding this from the rows actually present — rather than from "is the viewer
// an attendee" — is deliberate: room.js writes the notice best-effort, and a
// failed write must never leave the attendee with NO notification at all.
//
// Shared by get_feed and unread_counts so the tab badge can never disagree with
// the rows the tab shows.
// ---------------------------------------------------------------------------
function isScheduleRollup(r) {
  return !!r
    && r.item_filetype === 'schedule'
    && (r.category === 'media' || r.category === 'mfs')
    && (parseInt(r.cnt, 10) || 0) <= 1;
}

function meetingNoticeKeys(rows) {
  const keys = new Set();
  if (!Array.isArray(rows)) return keys;
  for (const r of rows) {
    if (!r || r.event !== 'meeting_notice') continue;
    // Only an invitation stands in for the rollup. A "rescheduled" or
    // "cancelled" notice is a different fact and must not hide it.
    if (r.meeting_kind && r.meeting_kind !== 'invite') continue;
    const title = r.meeting_title;
    if (!title) continue;
    keys.add(`${r.meeting_hub_id || r.hub_id || ''}:${title}`);
  }
  return keys;
}

function isCoveredByNotice(row, keys) {
  if (!keys || !keys.size || !isScheduleRollup(row)) return false;
  const title = row.item_filename;
  // Defence-in-depth, not load-bearing: meetingNoticeKeys never adds a key for
  // an empty title, so a nameless rollup could not match one anyway. Kept
  // because the two functions are the only thing standing between "one row per
  // meeting" and "a notification silently disappears", and a future change to
  // either side must not be able to make an untitled row droppable.
  if (!title) return false;
  return keys.has(`${row.hub_id || ''}:${title}`);
}

// ---------------------------------------------------------------------------
// Procedures that may not exist yet.
//
// Several merges below call an *_unread procedure that a given database may not
// have applied. The try/catch around each one does NOT cover that case, and it
// never did: @drumee/server-essentials' `_handleError` (lib/mariadb.js) logs the
// failure at WARN, rolls back, calls `this.end()` on the connection and returns
// UNDEFINED — it only re-throws when `throwOnError` is set or the error is
// fatal. So a missing procedure never raises; it just logs and drops a
// connection, on every single call.
//
// Measured on the dev endpoint with contact_meeting_notice_unread deliberately
// unapplied: an ER_SP_DOES_NOT_EXIST (1305) line per call, and 1305 is exactly
// the signature the PROD alert bot reports (same warning in
// service/lib/activity-mailer.js).
//
// `undefined` is therefore the failure signal — a SUCCESSFUL call always yields
// a result value, even when it selects no rows. Recording it lets the procedure
// be skipped for a short cooldown instead of retried on every request.
//
// The cooldown is short on purpose: "not deployed" and "one transient failure"
// are indistinguishable from here, so a real hiccup must cost this one optional
// source a minute, never a permanent blackout. Process-wide rather than
// per-user, because whether a routine exists is a property of the database.
// ---------------------------------------------------------------------------
// ── Daily-reminder meeting counting ─────────────────────────────────────────
//
// room_list_scheduled returns every RECURRING meeting regardless of the window
// it was asked for -- deliberately, so the client can expand occurrences -- so
// counting its rows would report a weekly stand-up as "today" every day of the
// year. This applies the same expansion the client's normalizeMeetings does
// (folder/skeleton/meeting-schedule.js), so the card and the calendar can
// never disagree about what "today" contains.
//
// metadata.content is DOUBLE-ENCODED: metadata is JSON whose `content` member
// is itself a JSON *string* (room.book/update write it that way). A single
// parse yields a string, and reading `.recur` off it silently gives undefined
// -- which would make every recurring meeting look like a one-off.
function meetingContent(m) {
  try {
    const md = typeof m.metadata === 'string' ? JSON.parse(m.metadata) : m.metadata || {};
    const c = typeof md.content === 'string' ? JSON.parse(md.content) : md.content || {};
    return c && typeof c === 'object' ? c : {};
  } catch (e) {
    return {};
  }
}

// Advance an epoch-seconds instant by n periods, in UTC. Months are handled on
// the calendar rather than as 30 days, so a monthly meeting stays on its date.
function addPeriods(epoch, freq, n) {
  const d = new Date(epoch * 1000);
  if (freq === 'daily') d.setUTCDate(d.getUTCDate() + n);
  else if (freq === 'weekly') d.setUTCDate(d.getUTCDate() + 7 * n);
  else d.setUTCMonth(d.getUTCMonth() + n);
  return Math.floor(d.getTime() / 1000);
}

// How many meetings fall inside [start, end)? Counts OCCURRENCES, so a daily
// stand-up counts once for the day, not once per row.
function countMeetingsInWindow(rows, start, end) {
  if (!Array.isArray(rows) || !rows.length) return 0;
  if (!(end > start)) return 0;
  let n = 0;
  for (const m of rows) {
    if (!m) continue;
    const content = meetingContent(m);
    const s = Number(m.stime || content.stime);
    // A legacy node with no queryable epoch is skipped rather than guessed at
    // -- the client's expander skips it too.
    if (!s) continue;

    const recur = content.recur;
    const freq = recur && recur.freq;
    if (!freq || freq === 'none') {
      if (s >= start && s < end) n += 1;
      continue;
    }
    if (freq !== 'daily' && freq !== 'weekly' && freq !== 'monthly') {
      // An unknown frequency is treated as a one-off rather than expanded: a
      // wrong guess here repeats a phantom meeting every single day.
      if (s >= start && s < end) n += 1;
      continue;
    }

    const until = Number(recur.until) || 0;
    // Pure short-circuit, NOT a correctness guard: the walk below re-checks
    // `until` before counting, so deleting this line changes no answer — a
    // mutation run proved that. It exists so an ended daily series does not
    // walk thousands of iterations to reach the same conclusion.
    if (until && until < start) continue;
    // Walk from the series start. The window is ONE day, so the guard only
    // has to survive a long-running series, not a wide range.
    let occ = s;
    let guard = 0;
    const GUARD_MAX = 4000;
    while (occ < start && guard++ < GUARD_MAX) occ = addPeriods(occ, freq, 1);
    if (occ >= start && occ < end && (!until || occ <= until)) n += 1;
  }
  return n;
}

const MISSING_PROCS = new Map(); // proc name -> epoch ms to retry after
const PROC_RETRY_MS = 60 * 1000;

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
  /**
   * Call an optional yp procedure. Returns [] instead of throwing when the
   * routine is absent, and stops calling it after the first such failure — see
   * MISSING_PROCS above for why the try/catch alone is not enough.
   *
   * Any OTHER error is re-thrown to the caller's own catch, so a real failure
   * (a deadlock, a bad argument) is still reported exactly as before and is
   * never mistaken for "not deployed yet".
   */
  async _optionalYpProc(name, ...args) {
    const now = Date.now();
    const retryAfter = MISSING_PROCS.get(name);
    if (retryAfter && now < retryAfter) return [];
    // Not wrapped in try/catch on purpose: this path does not raise (see
    // MISSING_PROCS above). A caller that DOES want to catch still can — the
    // callers all keep their own try/catch for the fatal/throwOnError cases.
    const rows = await this.yp.await_proc(name, ...args);
    if (rows === undefined) {
      MISSING_PROCS.set(name, now + PROC_RETRY_MS);
      this.debug(`[ACTIVITY] ${name} failed or is not deployed; skipping it for ${PROC_RETRY_MS / 1000}s`);
      return [];
    }
    // A successful call clears any earlier verdict immediately, so applying the
    // schema takes effect on the next request rather than after the cooldown.
    if (retryAfter) MISSING_PROCS.delete(name);
    return toArray(rows);
  }

  /**
   * As _optionalYpProc, but also says WHETHER the routine actually ran.
   *
   * Read paths cannot use that distinction — an absent routine and a user with
   * nothing to report both mean "show nothing" — so they keep calling
   * _optionalYpProc unchanged. A WRITE path needs it: `[]` is also the
   * legitimate answer for "you have nothing muted", so without this flag a mute
   * that never reached the database would be indistinguishable from one that
   * succeeded, and would be confirmed to the user anyway.
   *
   * 🔑 It DELEGATES rather than re-implementing the cooldown, and reads the
   * verdict back out of MISSING_PROCS afterwards. Two reasons: the bookkeeping
   * stays in exactly one place, and _optionalYpProc keeps the self-contained
   * body that two existing suites slice out and run on their own. An entry
   * under this name after the call means the routine did not answer (or was
   * still standing down); a successful call removes it.
   */
  async _optionalYpProcResult(name, ...args) {
    const rows = await this._optionalYpProc(name, ...args);
    return { ok: !MISSING_PROCS.has(name), rows };
  }

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
    // Same rule, same reasoning, for the Meeting tab's scheduled-meeting
    // notices: they are contact_activity rows, so the rollup loop above has
    // never been able to clear them. Scoped to bucket === 'meeting' ONLY, so the
    // pre-existing unscoped behaviour is untouched.
    const CONTACT_CLEAR = {
      [BUCKET.task]: [
        'contact_task_assigned_unread',
        'contact_task_mention_unread',
        'contact_task_column_change_unread',
      ],
      [BUCKET.meeting]: [
        'contact_meeting_notice_unread',
      ],
    };
    if (bucket && lookup(CONTACT_CLEAR, bucket)) {
      for (const proc of lookup(CONTACT_CLEAR, bucket)) {
        try {
          const rows = await this._optionalYpProc(proc, this.uid);
          for (const r of rows) {
            const activityId = parseInt(r && r.id);
            if (!activityId) continue;
            try {
              await this._callUserProc('contact_activity_dismiss', this.uid, activityId);
            } catch (e) {
              this.warn('[MFS_ACTIVITY] mark_all_read: contact dismiss failed', bucket, activityId, e && e.message);
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
        // Identify who opened each share, for the row's name AND its avatar:
        // without this the row reads "Someone opened X" even when we know
        // exactly who it was, and shows the workspace icon rather than a face.
        const openers = await this._resolveOpeners(opens);
        for (const r of opens) {
          if (!r) continue;
          let nodeName = '';
          // Round 3 Phase 1c: the client also needs the shared node's TYPE and
          // PARENT. Without them it cannot tell a shared file from a shared
          // folder and was building the deep link with `filetype=folder&pid=0`
          // hardcoded, so a shared FILE opened a phantom empty folder named
          // after the file. Both already come back from the mfs_node_attr call
          // this loop makes anyway (it returns filetype/ftype and parent_id) —
          // no extra query and no schema change, just stop discarding them.
          let nodeFiletype = '';
          let nodeParentId = '';
          if (r.hub_id && r.node_id) {
            try {
              const a = toArray(
                await this.yp.await_proc('forward_proc', r.hub_id, 'mfs_node_attr', `'${r.node_id}'`)
              )[0] || {};
              if (a.filename) nodeName = a.filename;
              if (a.filetype || a.ftype) nodeFiletype = a.filetype || a.ftype;
              if (a.parent_id != null) nodeParentId = String(a.parent_id);
            } catch (e) { /* keep fallback */ }
          }
          const opener = openers.get(openerKeyOf(r)) || null;
          const row = {
            category       : 'share_open',
            event          : 'secure_share.opened',
            id             : r.id,
            token_id       : r.token_id,
            hub_id         : r.hub_id,
            node_id        : r.node_id,
            node_name      : nodeName,
            // Deliberately NOT named `filetype`/`parent_id`: those keys already
            // drive isFolder() and the media deep link in the row widget, and
            // reusing them would change behaviour outside this row type.
            node_filetype  : nodeFiletype,
            node_parent_id : nodeParentId,
            recipient_email: r.recipient_email,
            // `recipient_email` itself is NOT touched — the client sends it back
            // to secure_share.mark_open_seen to persist the seen state. Only the
            // display name falls back through the resolved opener.
            fullname       : r.recipient_email || (opener && opener.name) || 'Someone',
            is_read        : r.is_read ? 1 : 0,
            timestamp      : r.last_seen_at,
            ctime          : r.last_seen_at,
          };
          // Show the person who opened it instead of the workspace icon. Only
          // when the lookup actually returned an account: getAuthorId falls back
          // to hub_id without this, but an id that does not resolve makes the
          // avatar render the CURRENT user's face — so an unverified id is worse
          // than no id. Anonymous opens keep the workspace icon, as before.
          if (opener && opener.id) row.author_id = opener.id;
          result.push(row);
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
            // Scheduled-meeting notices (room.book/update/remove). Under Unread
            // OFF these already arrive via activity_get_feed_all's generic
            // contact branch, so the feature degrades to "visible with the
            // toggle off" if this proc has not been applied yet.
            'contact_meeting_notice_unread',
          ]) {
            try {
              const rows = await this._optionalYpProc(proc, this.uid);
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
    flattenMeetingNotice(result);

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
    // Resolve the containing folder for file rows that only carry the file's
    // own attributes. Must run before the bucket filter only in the sense that
    // it is cheaper here (one pass over the assembled page); it is independent
    // of bucketing either way.
    await this._stampFolderNames(result);
    // The folder chip for task rows, and the two Round 3 enrichments Duy asked
    // for on 2026-08-21. Each one is independently best-effort and each only
    // ADDS fields (except the meeting rollup, which can drop a row that a
    // targeted invitation already covers), so a failure anywhere leaves the feed
    // exactly as it renders today.
    await this._stampTaskFolderNames(result);
    await this._stampChatMentions(result);
    result = await this._stampMeetingRollups(result);

    stampBuckets(result);
    if (bucket) {
      result = result.filter((row) => row && row.bucket === bucket);
    }

    this.output.list(result);
  }

  /**
   * Identify the person behind each share-open row: `{ id, name }` per lookup
   * key, for the row's display name AND its avatar.
   *
   * A share-open event records the recipient's email only when the recipient
   * identified themselves, but it records `actor_id` whenever a signed-in user
   * opened the link. `drumate_get` accepts EITHER (`WHERE id = _key OR email =
   * _key`), so one proc covers both and the key is simply whichever we have.
   *
   * Why the avatar needs the resolved `id` and not the raw one: an id that does
   * not resolve makes the client's avatar fall back to the CURRENT user, which
   * is the "every row shows my own face" bug. So `id` is taken from the row the
   * proc returned — proof the account exists — and the caller sets author_id
   * only when it is present.
   *
   * `ffffffffffffffff` is the anonymous sentinel: an unauthenticated visitor on
   * a public link, so there is genuinely nobody to name or depict and the row
   * must keep saying "Someone" with no face. Same guard as
   * service/private/secure_share.js. A deleted account or a guest with no
   * drumate row resolves to nothing and falls back the same way.
   *
   * One lookup per DISTINCT person (a page is usually two or three), capped, and
   * best-effort: any failure leaves the row exactly as it was before.
   */
  async _resolveOpeners(opens) {
    const MAX_LOOKUPS = 12;
    const found = new Map();
    if (!Array.isArray(opens) || !opens.length) return found;

    const pending = [];
    for (const r of opens) {
      const key = openerKeyOf(r);
      if (!key || found.has(key)) continue;
      if (pending.length >= MAX_LOOKUPS) continue;
      found.set(key, null);
      pending.push(key);
    }
    for (const key of pending) {
      try {
        const d = toArray(await this.yp.await_proc('drumate_get', key))[0] || {};
        if (!d.id) continue; // no such account — stays anonymous
        const name = String(d.fullname || `${d.firstname || ''} ${d.lastname || ''}`).trim();
        found.set(key, { id: d.id, name });
      } catch (e) {
        this.debug('[ACTIVITY] opener lookup failed', key, e && e.message);
      }
    }
    return found;
  }

  /**
   * Stamp `folder_name` on file rows that carry only the FILE's attributes.
   *
   * The Figma card shows the containing folder/workspace in a chip next to the
   * timestamp, so the client needs ONE field it can trust regardless of where a
   * row came from. Rollup rows already resolve it (mapNotificationRow), but raw
   * `yp.mfs_changelog` rows embed only the file's own node attributes in
   * `src`/`dest` — the parent's NAME appears nowhere on them, just its id.
   *
   * Resolved per DISTINCT (hub_id, parent_id), not per row: a page of uploads is
   * normally a handful of folders, so this is a few lookups rather than one per
   * row. `mfs_node_attr` already returns the WORKSPACE name when the parent is
   * the hub root, which is exactly what the chip should read for a file dropped
   * at the top level of a workspace.
   *
   * Deliberately conservative:
   *  - never overwrites a folder_name a rollup already resolved;
   *  - MAX_LOOKUPS bounds the worst case, so a pathological page can never fan
   *    out into an unbounded number of queries;
   *  - internal plumbing folders (`__chat__`, `__upload__`) are dropped rather
   *    than shown to a user;
   *  - every failure is swallowed — an absent chip is the pre-existing look,
   *    whereas throwing here would take out the whole feed.
   */
  async _stampFolderNames(rows) {
    const MAX_LOOKUPS = 12;
    if (!Array.isArray(rows) || !rows.length) return;

    const asObject = (v) => {
      if (!v) return null;
      if (typeof v === 'object') return v;
      try { return JSON.parse(v); } catch (e) { return null; }
    };
    // A name Drumee uses for plumbing, not a folder a person put a file in.
    const internal = (n) => !n || /^__.*__$/.test(n) || n.indexOf('__') === 0;

    const wanted = new Map(); // "hub:parent" -> { hub_id, parent_id }
    const targets = [];       // [row, key]
    for (const r of rows) {
      if (!r || r.folder_name) continue;
      if (!/^media\./.test(String(r.event || ''))) continue;
      // workspace_move already says where it went, in its own sentence.
      if (r.event === 'media.workspace_move') continue;
      // Read ACROSS src and dest instead of picking one. `dest` on an upload row
      // parses to an EMPTY object, which is truthy — so `dest || src` selected
      // {} and never looked at src, where the parent id actually lives. That
      // silently left every changelog row without a chip.
      const dest = asObject(r.dest) || {};
      const source = asObject(r.src) || {};
      const parentId = r.parent_id || dest.parent_id || dest.pid
        || source.parent_id || source.pid;
      const hubId = r.hub_id || dest.hub_id || source.hub_id;
      if (!parentId || !hubId || `${parentId}` === '0') continue;
      const key = `${hubId}:${parentId}`;
      if (!wanted.has(key)) {
        if (wanted.size >= MAX_LOOKUPS) continue;
        wanted.set(key, { hub_id: hubId, parent_id: parentId });
      }
      targets.push([r, key]);
    }
    if (!wanted.size) return;

    const names = new Map();
    for (const [key, { hub_id, parent_id }] of wanted) {
      try {
        const a = toArray(
          await this.yp.await_proc('forward_proc', hub_id, 'mfs_node_attr', `'${parent_id}'`)
        )[0] || {};
        if (a.filename && !internal(a.filename)) names.set(key, a.filename);
      } catch (e) {
        this.debug('[ACTIVITY] folder name lookup failed', key, e && e.message);
      }
    }
    for (const [row, key] of targets) {
      const name = names.get(key);
      if (name) row.folder_name = name;
    }
  }

  /**
   * Stamp `folder_name` on TASK rows, so the card can show which folder the
   * task lives in (Duy 2026-08-21: "I don't know he has assigned me in which
   * folder").
   *
   * _stampFolderNames above only looks at `media.*` events, and a task row is a
   * yp.contact_activity row — so no task notification has ever carried a folder.
   * The folder id IS on the row already (flattenTaskFields puts the task's `nid`
   * there); only its NAME has to be resolved, and a task's nid points at the
   * folder itself rather than at a parent.
   *
   * Deliberately mirrors _stampFolderNames' safety rules: one lookup per
   * DISTINCT (hub, node), a hard cap on lookups, internal plumbing names
   * withheld, never overwrites a name already present, and every failure
   * swallowed — an absent chip is the pre-existing look, while throwing here
   * would take out the whole feed.
   *
   * A workspace-level task (no nid) gets no chip: mfs_node_attr returns the
   * WORKSPACE name for a hub root, which is what the chip should read, so a task
   * whose nid IS the root resolves correctly; one with no nid at all has no
   * container to name.
   */
  async _stampTaskFolderNames(rows) {
    const MAX_LOOKUPS = 12;
    if (!Array.isArray(rows) || !rows.length) return;
    const TASK_EVENTS = new Set(['task_assigned', 'task_mention', 'task_column_change']);
    const internal = (n) => !n || /^__.*__$/.test(n) || n.indexOf('__') === 0;

    const wanted = new Map(); // "hub:node" -> { hub_id, nid }
    const targets = [];
    for (const r of rows) {
      if (!r || r.folder_name) continue;
      if (!TASK_EVENTS.has(String(r.event || ''))) continue;
      // task_assigned / task_column_change flatten to task_hub_id + task_nid;
      // task_mention flattens onto the top-level hub_id + nid (the two events
      // have different client nav contracts — see flattenTaskFields).
      const hubId = r.task_hub_id || r.hub_id;
      const nid = r.task_nid || r.nid;
      if (!hubId || !nid || `${nid}` === '0' || `${nid}` === 'null') continue;
      const key = `${hubId}:${nid}`;
      if (!wanted.has(key)) {
        if (wanted.size >= MAX_LOOKUPS) continue;
        wanted.set(key, { hub_id: hubId, nid });
      }
      targets.push([r, key]);
    }
    if (!wanted.size) return;

    const names = new Map();
    for (const [key, { hub_id, nid }] of wanted) {
      try {
        const a = toArray(
          await this.yp.await_proc('forward_proc', hub_id, 'mfs_node_attr', `'${nid}'`)
        )[0] || {};
        if (a.filename && !internal(a.filename)) names.set(key, a.filename);
      } catch (e) {
        this.debug('[ACTIVITY] task folder lookup failed', key, e && e.message);
      }
    }
    for (const [row, key] of targets) {
      const name = names.get(key);
      if (name) row.folder_name = name;
    }
  }

  /**
   * Turn a scheduled meeting's rollup row into a MEETING row (Duy 2026-08-21,
   * issues 9 + 10).
   *
   * room.book() creates the meeting as a media node (`category: 'schedule'`), so
   * notification_center_next rolls it up as an upload — which is why an
   * invitation read "<organizer> uploaded <Meeting-name>" and sat in the Files
   * tab. bucketOf already re-routes such a row to Meeting; this fills in what
   * the sentence needs:
   *
   *   - `meeting_stime` → "…on Aug 14, 10:00 AM" (Figma's scheduled card).
   *   - dropping the row when a targeted `meeting_notice` invitation for the SAME
   *     meeting is already on this page, so an attendee sees exactly ONE row —
   *     the invitation, which is what Duy asked to replace the upload row with.
   *
   * Why check for the notice instead of just checking attendance: dropping the
   * rollup on attendance alone would rely on room.js's best-effort write having
   * succeeded, and a failed write would leave the attendee with NO notification
   * at all. Deciding from what is actually on the page can never lose a row.
   *
   * Resolution uses the EXISTING room_list_scheduled proc (one call per distinct
   * hub, capped), so there is no schema change. It returns every scheduled
   * meeting in the hub; the rollup identifies its meeting only by title, because
   * notification_center_next does not carry the meeting node's own id. Duplicate
   * titles in one workspace are therefore ambiguous — the earliest-starting match
   * wins, which affects only the time shown, never which tab the row lands in.
   *
   * Returns the (possibly shorter) row array. Best-effort throughout.
   */
  async _stampMeetingRollups(rows) {
    const MAX_LOOKUPS = 8;
    if (!Array.isArray(rows) || !rows.length) return rows;

    const pending = rows.filter(isScheduleRollup);
    if (!pending.length) return rows;

    // Meetings this user has already been told about by a targeted invitation.
    const covered = meetingNoticeKeys(rows);
    const drop = new Set(pending.filter((r) => isCoveredByNotice(r, covered)));
    // Only the survivors need a time resolved — a dropped row is never rendered.
    const needTime = pending.filter((r) => !drop.has(r));
    if (!needTime.length) return rows.filter((r) => !drop.has(r));

    const byHub = new Map(); // hub_id -> [meeting rows]
    for (const r of needTime) {
      if (!r.hub_id || byHub.has(r.hub_id)) continue;
      if (byHub.size >= MAX_LOOKUPS) continue;
      byHub.set(r.hub_id, null);
    }
    for (const hubId of [...byHub.keys()]) {
      try {
        const list = toArray(
          await this.yp.await_proc('forward_proc', hubId, 'room_list_scheduled', 'NULL,NULL')
        );
        byHub.set(hubId, list);
      } catch (e) {
        this.debug('[ACTIVITY] room_list_scheduled failed', hubId, e && e.message);
      }
    }

    for (const r of needTime) {
      const list = byHub.get(r.hub_id);
      if (!Array.isArray(list)) continue;
      const title = String(r.item_filename || '');
      // room_list_scheduled is ORDER BY stime ASC, so the first title match is
      // the earliest-starting one.
      const hit = list.find((m) => m && String(m.filename || '') === title);
      if (!hit) continue;
      if (hit.stime) r.meeting_stime = hit.stime;
      if (hit.id) r.meeting_nid = String(hit.id);
    }
    if (!drop.size) return rows;
    return rows.filter((r) => !drop.has(r));
  }

  /**
   * Flag folder-chat rollups that contain an @-mention of the caller (Duy
   * 2026-08-21, issue 12: "I only receive the noti 'memberA sent a message'").
   *
   * notification_center_next rolls team chat up per FOLDER and carries no
   * mention information, so a message that named you was indistinguishable from
   * any other. `channel_list_notifications(uid,'mention',…)` already knows
   * exactly which unread messages mention you, and returns the folder as
   * `scope_nid` — so the rollup can be annotated from it with no schema change.
   *
   * Annotating the rollup rather than surfacing the mention rows separately is
   * deliberate: the panel would then show BOTH ("mentioned you in X" and "sent a
   * message" for the same folder), which is the double-row this avoids.
   *
   * One call per DISTINCT hub that actually has a teamchat rollup on the page,
   * capped, and best-effort: a failure leaves the row reading exactly as it does
   * today.
   */
  async _stampChatMentions(rows) {
    const MAX_LOOKUPS = 8;
    if (!Array.isArray(rows) || !rows.length) return;
    const pending = rows.filter((r) => r && r.category === 'teamchat' && !r.mentioned_in
      // A rollup whose latest unread event is a meeting start/end renders (and
      // buckets) as a meeting; a mention flag there would be ignored anyway.
      && r.meeting_action !== 'start' && r.meeting_action !== 'end');
    if (!pending.length) return;

    const hubs = [];
    for (const r of pending) {
      if (!r.hub_id || hubs.includes(r.hub_id)) continue;
      if (hubs.length >= MAX_LOOKUPS) break;
      hubs.push(r.hub_id);
    }

    // "hub:folder" for every folder holding an unread mention. '' = a
    // hub-level/legacy chat message, which the rollup groups with nid NULL.
    const mentioned = new Set();
    for (const hubId of hubs) {
      try {
        const list = toArray(
          await this.yp.await_proc(
            'forward_proc', hubId, 'channel_list_notifications',
            `'${this.uid}','mention',1,1`
          )
        );
        for (const m of list) {
          if (!m) continue;
          const scope = (m.scope_nid == null || m.scope_nid === 'null') ? '' : String(m.scope_nid);
          mentioned.add(`${hubId}:${scope}`);
        }
      } catch (e) {
        this.debug('[ACTIVITY] mention lookup failed', hubId, e && e.message);
      }
    }
    if (!mentioned.size) return;

    for (const r of pending) {
      const scope = (r.nid == null || r.nid === 'null') ? '' : String(r.nid);
      if (!mentioned.has(`${r.hub_id}:${scope}`)) continue;
      // The name the sentence reads ("mentioned you in <Folder>"). `filename` is
      // the folder for a teamchat rollup, already falling back to the workspace
      // name for hub-level chat (notification_center_next COALESCEs h.name).
      r.mentioned_in = r.folder_name || r.filename || '';
      if (!r.mentioned_in) delete r.mentioned_in;
    }
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
    // Scheduled-meeting notices ride this endpoint too. Not a task event, so the
    // name no longer describes the whole payload — but this is the ONE call the
    // panel makes for the bell badge's contact_activity share, and a notice that
    // is missing here would make the Meeting tab badge exceed the bell. The
    // panel filters by `event`, so an older client simply ignores these rows.
    try {
      const meetingRows = await this._optionalYpProc('contact_meeting_notice_unread', this.uid);
      flattenMeetingNotice(meetingRows);
      rows = rows.concat(meetingRows);
      rows.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    } catch (e) {
      // debug, not warn: the proc may not be applied yet during a rollout.
      this.debug('[ACTIVITY] contact_meeting_notice_unread skipped', e && e.message);
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

    // 2. is counted BEFORE 1. on purpose: a scheduled meeting's rollup row is
    //    dropped from the feed when a targeted invitation already covers it, so
    //    the badge has to know about the invitations before it counts rollups —
    //    otherwise the Meeting badge would read one higher than the rows the tab
    //    actually shows. Collected here, counted below.
    const contactRows = [];
    for (const proc of [
      'contact_task_assigned_unread',
      'contact_task_mention_unread',
      'contact_task_column_change_unread',
      'contact_storage_alert_unread',
      'contact_reward_expiry_unread',
      // Scheduled-meeting notices → Meeting, via BUCKET_BY_EVENT. Listed here
      // for the same reason as the rest: the tab badge and the feed must agree
      // on what exists.
      'contact_meeting_notice_unread',
    ]) {
      try {
        for (const r of await this._optionalYpProc(proc, this.uid)) if (r) contactRows.push(r);
      } catch (e) {
        // debug, not warn: a proc missing during a rollout window is expected
        // and must not spam the alert bot.
        this.debug(`[ACTIVITY] unread_counts: ${proc} skipped`, e && e.message);
      }
    }
    flattenMeetingNotice(contactRows);
    for (const r of contactRows) bump(r);

    // 1. The rollup categories + hub invites + refused invitations + workspace
    //    moves. Already bucket-stamped; bucketOf is idempotent on them. A
    //    scheduled-meeting rollup already covered by an invitation counted above
    //    is skipped, exactly as get_feed drops it from the page.
    try {
      const covered = meetingNoticeKeys(contactRows);
      for (const r of await this._notificationRollups()) {
        if (!r) continue;
        if (isCoveredByNotice(r, covered)) continue;
        bump(r);
      }
    } catch (e) {
      this.warn('[ACTIVITY] unread_counts: rollups failed', e && e.message);
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

  // ============================================================
  // Notification popup mute (Round 3 / Sprint 1 row 6)
  //
  // 🚨 THE POPUP CHANNEL ONLY. Nothing in this section may ever be read by
  // list(), get_feed() or unread_counts(): a muted user keeps every row in the
  // Notification Center and keeps the bell badge, they just stop being
  // interrupted by a card. Muting is "stop talking to me", not "stop
  // recording". Both feed paths are deliberately left untouched.
  //
  // The suppression itself happens on the CLIENT, which reads this state once
  // and re-reads it from the return value of every mute_set. The chat push
  // path is not touched at all — no per-message, per-recipient lookup is added
  // to the hottest push we have, and no popup decision depends on a round trip
  // that can fail silently mid-message.
  // ============================================================

  /**
   * Rows -> the shape the client caches: a global flag plus the muted
   * workspaces. Shared by mute_state and mute_set so the two can never
   * disagree about how a row is read.
   *
   * A global row (hub_id = '') is decisive on its own; the stored procedures
   * clear the per-workspace rows when it is written, so the two cannot
   * legitimately arrive together, but this does not assert on that — it
   * reports what is there.
   */
  _muteState(rows) {
    let global = 0;
    const hubs = [];
    for (const r of toArray(rows)) {
      if (!r) continue;
      const id = r.hub_id == null ? '' : String(r.hub_id);
      if (id === '') global = 1;
      else if (!hubs.includes(id)) hubs.push(id);
    }
    return { global, hubs };
  }

  /**
   * The caller's current popup-mute state.
   * Endpoint: POST /activity.mute_state
   *
   * Best-effort by design: before the schema is applied this answers "nothing
   * muted", which is the safe direction — popups keep working exactly as they
   * do today rather than everything falling silent on a missing routine.
   */
  async mute_state() {
    const rows = await this._optionalYpProc('notification_mute_state', this.uid);
    this.output.data(this._muteState(rows));
  }

  /**
   * Mute or unmute the popups for one workspace, or for all of them.
   * Endpoint: POST /activity.mute_set
   * Input: hub_id (string, empty or absent = all workspaces),
   *        muted (boolean, default true)
   *
   * Returns the FULL resulting state, not just an acknowledgement, so the
   * client refreshes its cache from the write itself instead of following
   * every mute with a second call.
   *
   * `status` is reported honestly: await_proc does not throw — it logs, drops
   * the connection and returns undefined — so a write that never landed would
   * otherwise be indistinguishable from one that did and would be confirmed to
   * the user regardless. The client shows its confirmation on ok only.
   */
  async mute_set() {
    const hub_id = String(this.input.use('hub_id') || '');
    const raw = this.input.use('muted');
    // Absent means mute: the endpoint is named for what it usually does, and
    // only the explicit falsey values unmute. Strings are checked because form
    // and query payloads arrive as strings, where '0' and 'false' are both
    // truthy in JS and would silently invert the caller's intent.
    const muted =
      raw === undefined || raw === null || raw === ''
        ? true
        : !(raw === 0 || raw === '0' || raw === false || raw === 'false');
    const proc = muted ? 'notification_mute_set' : 'notification_mute_unset';
    const { ok, rows } = await this._optionalYpProcResult(proc, this.uid, hub_id);
    this.output.data({
      status: ok ? 'ok' : 'error',
      muted: muted ? 1 : 0,
      hub_id,
      ...this._muteState(rows),
    });
  }
  // ── Daily reminder card (Round 3 / Sprint 1 row 7) ───────────────
  //
  // Three numbers for the once-a-day "Hi X, today you have ..." card. None of
  // them has a single-workspace source, so this fans out across every
  // workspace the desk belongs to and sums. That is affordable ONLY because
  // the card is shown once a day -- do not reuse this on any interactive path.
  //
  // The DAY WINDOW COMES FROM THE CLIENT, on purpose. "Today" is the viewer's
  // today, and the server has no idea what timezone they are in; deriving it
  // here would tell someone in UTC+7 about yesterday's tasks for most of their
  // working morning. The client already knows, because it decides on its own
  // clock whether the card is due at all.
  //
  // 🚨 `day` reaches SQL through forward_proc, which builds a dynamic
  // statement out of the argument string -- so it is validated against a
  // strict date pattern and rejected outright, never escaped or coerced. The
  // epoch bounds go through Number(). uid comes from the session, not input.
  async daily_digest() {
    const day = String(this.input.use('day', '') || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return this.exception.user('INVALID_DAY');
    }
    const dayStart = Number(this.input.use('stime', 0)) || 0;
    const dayEnd = Number(this.input.use('etime', 0)) || 0;
    if (!Number.isFinite(dayStart) || !Number.isFinite(dayEnd) || dayEnd <= dayStart) {
      return this.exception.user('INVALID_DAY');
    }

    // Areas that count. A desk's hub register also holds the containers created
    // for secure shares ('share') and public/guest access ('dmz') -- on a real
    // stage account, 20 share and 2 dmz against 23 private and 3 public. Those
    // are plumbing, not places the user works, and counting their chat as "your
    // unread messages" would inflate the card with rows the user never thinks
    // of as a workspace. They are filtered HERE rather than in the proc so this
    // stays a one-line change if that judgement turns out to be wrong -- no
    // schema re-apply needed.
    const COUNTED_AREAS = ['private', 'public'];
    const workspaces = toArray(await this._callUserProc('desk_my_workspaces'))
      .filter((w) => w && COUNTED_AREAS.includes(String(w.area || '')));
    // A cap so one pathological account cannot turn a daily card into a
    // hundreds-of-query storm. Reported back so the client -- and anyone
    // reading a bug report -- can tell a real total from a floor.
    const MAX_WORKSPACES = 60;
    const capped = workspaces.slice(0, MAX_WORKSPACES);

    let unread_messages = 0;
    let due_tasks = 0;
    let meetings = 0;

    for (const w of capped) {
      const hubId = w && w.hub_id;
      if (!hubId) continue;

      // Counts. await_proc does not throw -- it logs, ends the connection and
      // returns undefined -- so an unmigrated workspace simply contributes
      // nothing instead of failing the whole card.
      let row = null;
      try {
        row = toArray(
          await this.yp.await_proc(
            'forward_proc', hubId, 'hub_daily_counts', `'${this.uid}','${day}'`
          )
        )[0];
      } catch (e) {
        this.debug('[ACTIVITY] hub_daily_counts failed', hubId, e && e.message);
        row = null;
      }
      if (row) {
        unread_messages += Number(row.unread_messages) || 0;
        due_tasks += Number(row.due_tasks) || 0;
      }

      // Meetings. room_list_scheduled already exists per hub, so this needs no
      // SQL of its own -- but it returns EVERY recurring meeting regardless of
      // the window (by design, so the client can expand occurrences), which is
      // why the day filter is applied here rather than passed as bounds.
      // The catch wraps ONLY the round trip. It used to wrap the counting
      // too, and that hid a genuine ReferenceError as a quiet "0 meetings" --
      // a catch wide enough to swallow a programming error reports a wrong
      // number instead of failing, which is worse than either.
      let rooms = [];
      try {
        rooms = toArray(
          await this.yp.await_proc('forward_proc', hubId, 'room_list_scheduled', 'NULL,NULL')
        );
      } catch (e) {
        this.debug('[ACTIVITY] room_list_scheduled failed', hubId, e && e.message);
        rooms = [];
      }
      meetings += countMeetingsInWindow(rooms, dayStart, dayEnd);
    }

    this.output.data({
      unread_messages,
      due_tasks,
      meetings,
      workspaces: capped.length,
      // true = the numbers are a floor, not a total.
      truncated: workspaces.length > capped.length ? 1 : 0,
    });
  }

}

module.exports = MfsActivity;
