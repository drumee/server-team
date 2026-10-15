/**
 * @license
 * Copyright 2026 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3.
 * https://www.gnu.org/licenses/agpl-3.0.html
 */

/**
 * Anyone but its organizer who joins a SCHEDULED meeting before it starts
 * waits for it.
 *
 * A workspace has one meeting room (room_id is the workspace node) and a
 * scheduled meeting is only a calendar entry pointing at it. So an invitee
 * who pressed the meeting's Join half an hour early walked into an EMPTY
 * room, conference_join made them its host as its first joiner, and
 * sendRoomInfo told the whole workspace "B started a meeting", the organizer
 * included, with a Join button, long before the meeting.
 *
 * earlyArrival() is asked BEFORE conference_join and answers the meeting the
 * joiner is early for, or null to join as before. The joiner waits when all
 * of these hold:
 *   - they joined FROM a scheduled meeting: schedule_id, sent by its
 *     calendar card and its editor. "Start a Meeting" starts one there and
 *     then, as it always did: held by whatever is on the calendar, members
 *     of a workspace with meetings booked could never call each other;
 *   - a workspace meeting (type meeting, area private or share); DMZ rooms
 *     already wait for their owner inside conference_join;
 *   - nobody is in the room yet: a meeting the organizer, or anybody else,
 *     has already started is joined as usual;
 *   - that meeting is this workspace's and not at its start time yet,
 *     however far off it is. No window: this used to hold only the hour
 *     before, and QA joined two hours early and walked in. Its END is not
 *     asked: editing a meeting's day can leave etime before stime (13 of 74
 *     rows on stage), and that read as "over" and let everyone in;
 *   - they did not organize it: an organizer may always open their own
 *     meeting early.
 *
 * yp.meeting_schedule is written by room._index_meeting (nid is the meeting
 * node, as the calendar knows it). The reminder worker rolls a recurring
 * series' stime to its NEXT occurrence the moment one starts, so the row alone
 * would hold the first arrival at a weekly meeting until next week. The card
 * says which occurrence it was (schedule_at), and without that a series whose
 * previous occurrence is still on counts as started.
 *
 * Never throws: a failed check joins as before.
 */

const { Attr, toArray } = require("@drumee/server-essentials");

// How long before the start an invitee may walk in without the host: not at
// all. They wait for the start time or for the host (product call
// 2026-10-15; at 5 minutes, an invitee there at 11:26 still started the
// meeting and the organizer got "B started a meeting"). Kept as a constant so
// a grace period stays a one-line change.
const EARLY_JOIN_SEC = 0;

/**
 * @param {object} svc  service instance (needs .hub, .yp, .warn)
 * @param {object} o
 * @param {string} o.hub_id       workspace being joined
 * @param {string} o.uid          the joiner
 * @param {string} o.type         room type (meeting | connect)
 * @param {string} o.socket_id    the joining socket, not counted as presence
 * @param {string} o.schedule_id  the scheduled meeting joined from, if any
 * @param {number} [o.schedule_at] start of the occurrence joined, if known
 * @param {number} [o.now]        epoch seconds, for tests
 * @returns {Promise<null|{schedule_id, title, starts_at, opens_at, organizer_id}>}
 */
async function earlyArrival(svc, { hub_id, uid, type, socket_id, schedule_id, schedule_at, now } = {}) {
  try {
    if (!schedule_id) return null;
    if (type !== Attr.meeting || !hub_id || !uid || !svc || !svc.yp) return null;
    const area = svc.hub && svc.hub.get(Attr.area);
    if (area !== Attr.private && area !== Attr.share) return null;
    if (now == null) now = Math.floor(Date.now() / 1000);

    const live = toArray(await svc.yp.await_query(
      "SELECT COUNT(*) AS n FROM conference c INNER JOIN socket s ON s.id = c.socket_id" +
      " WHERE c.hub_id = ? AND c.type = 'meeting' AND s.state = 'active' AND c.socket_id <> ?",
      hub_id, socket_id || "",
    ));
    if (!live.length || Number(live[0].n) > 0) return null;

    // Unknown or another workspace's: an ordinary join.
    const [meeting] = toArray(await svc.yp.await_query(
      "SELECT hub_id, nid, stime, etime, created_by, title, recur, mtime FROM meeting_schedule" +
      " WHERE hub_id = ? AND nid = ? AND stime > 0",
      hub_id, schedule_id,
    )).filter((m) =>
      m
      && String(m.hub_id) === String(hub_id)
      && String(m.nid) === String(schedule_id)
      && Number(m.stime) > 0);
    if (!meeting) return null;
    if (String(meeting.created_by) === String(uid)) return null;

    // The occurrence the card stood for, never later than the row: the
    // series' next start opens the room either way.
    const next = Number(meeting.stime);
    const at = Number(schedule_at) || 0;
    const starts_at = at > 0 ? Math.min(next, at) : next;
    if (starts_at - EARLY_JOIN_SEC <= now) return null;
    if (occurrenceOn(meeting, now)) return null;
    return {
      schedule_id: meeting.nid,
      title: meeting.title || "",
      starts_at,
      opens_at: starts_at - EARLY_JOIN_SEC,
      organizer_id: meeting.created_by || null,
    };
  } catch (e) {
    if (svc && svc.warn) svc.warn("[meeting-early] check failed", e && e.message);
    return null;
  }
}

/**
 * Is the occurrence before the row's (a recurring series, rolled forward when
 * it started) still on? Only if the row WAS rolled for it: rolling stamps
 * mtime (meeting_schedule_mark_fired), while a series whose first occurrence
 * is still ahead has no earlier one at all. Its length is the row's, or an
 * hour when the row has none (etime missing or before stime). Months step as
 * the reminder worker steps them.
 */
function occurrenceOn(row, now) {
  let recur = row.recur;
  if (typeof recur === "string") {
    try { recur = JSON.parse(recur); } catch (e) { recur = null; }
  }
  const freq = recur && recur.freq;
  const stime = Number(row.stime) || 0;
  if (!stime || !freq || freq === "none") return false;
  let prev;
  if (freq === "daily") prev = stime - 86400;
  else if (freq === "weekly") prev = stime - 604800;
  else if (freq === "monthly") {
    const d = new Date(stime * 1000);
    d.setMonth(d.getMonth() - 1);
    prev = Math.floor(d.getTime() / 1000);
  } else return false;
  const etime = Number(row.etime) || 0;
  const length = etime > stime ? etime - stime : 3600;
  return prev <= now && now < prev + length && Number(row.mtime) >= prev;
}

module.exports = { earlyArrival, EARLY_JOIN_SEC };
