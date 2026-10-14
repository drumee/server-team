/**
 * @license
 * Copyright 2026 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3.
 * https://www.gnu.org/licenses/agpl-3.0.html
 */

/**
 * Anyone but its organizer who opens a SCHEDULED meeting before it starts
 * waits for it.
 *
 * A workspace has one meeting room (room_id is the workspace node) and a
 * scheduled meeting is only a calendar entry pointing at it: every Join (the
 * calendar card, the invitation and reminder cards, the email) joins that one
 * room. So an invitee arriving half an hour early walked into an EMPTY room,
 * conference_join made them its host as its first joiner, and sendRoomInfo
 * told the whole workspace "B started a meeting", the organizer included,
 * with a Join button, long before the meeting.
 *
 * earlyArrival() is asked BEFORE conference_join and answers the meeting the
 * joiner is early for, or null to join as before. The joiner waits when all
 * of these hold:
 *   - a workspace meeting (type meeting, area private or share); DMZ rooms
 *     already wait for their owner inside conference_join;
 *   - nobody is in the room yet: a meeting the organizer, or anybody else,
 *     has already started is joined as usual;
 *   - a meeting is booked in this workspace within LOOKAHEAD_SEC, and none
 *     is due: none at its start time yet (less EARLY_JOIN_SEC), or started
 *     and not over;
 *   - they organize none of those: an organizer may always open their own
 *     meeting early.
 *
 * NOT ONLY THE INVITED. The meetings are the WORKSPACE's (yp.meeting_schedule
 * by hub_id), not the joiner's own list (meeting_schedule_range answers by
 * organizer or attendee): the room is the workspace's only one, and a member
 * who is not on the attendee list walks into it the same way. Tested on /liam
 * 2026-10-15, the early joiner was such a member and started the meeting.
 *
 * yp.meeting_schedule is written by room._index_meeting, and the reminder
 * worker rolls stime forward for recurring series, so it is the next
 * occurrence.
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
// How far ahead a scheduled meeting claims the room. Beyond this an empty
// room is an ad-hoc meeting, as it always was. One hour, not longer: the room
// is the workspace's only one, so for this long before their meeting an
// invitee cannot start an ad-hoc call there either.
const LOOKAHEAD_SEC = 60 * 60;

/**
 * @param {object} svc  service instance (needs .hub, .yp, .warn)
 * @param {object} o
 * @param {string} o.hub_id     workspace being joined
 * @param {string} o.uid        the joiner
 * @param {string} o.type       room type (meeting | connect)
 * @param {string} o.socket_id  the joining socket, not counted as presence
 * @param {number} [o.now]      epoch seconds, for tests
 * @returns {Promise<null|{schedule_id, title, starts_at, opens_at, organizer_id}>}
 */
async function earlyArrival(svc, { hub_id, uid, type, socket_id, now } = {}) {
  try {
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

    const booked = toArray(await svc.yp.await_query(
      "SELECT hub_id, nid, stime, etime, created_by, title FROM meeting_schedule" +
      " WHERE hub_id = ? AND stime > 0 AND stime <= ? AND (etime = 0 OR etime > ?)" +
      " ORDER BY stime LIMIT 10",
      hub_id, now + LOOKAHEAD_SEC, now,
    )).filter((m) =>
      m
      && String(m.hub_id) === String(hub_id)
      && Number(m.stime) > 0
      // Asked of the query, held here too: a row starting beyond the window
      // must not claim the room.
      && Number(m.stime) <= now + LOOKAHEAD_SEC);
    if (!booked.length) return null;
    if (booked.some((m) => Number(m.stime) - EARLY_JOIN_SEC <= now)) return null;
    if (booked.some((m) => String(m.created_by) === String(uid))) return null;

    const next = booked.reduce((a, m) => (Number(m.stime) < Number(a.stime) ? m : a));
    const starts_at = Number(next.stime);
    return {
      schedule_id: next.nid,
      title: next.title || "",
      starts_at,
      opens_at: starts_at - EARLY_JOIN_SEC,
      organizer_id: next.created_by || null,
    };
  } catch (e) {
    if (svc && svc.warn) svc.warn("[meeting-early] check failed", e && e.message);
    return null;
  }
}

module.exports = { earlyArrival, EARLY_JOIN_SEC, LOOKAHEAD_SEC };
