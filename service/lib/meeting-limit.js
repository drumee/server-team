/**
 * Group-meeting duration cap — the server side of the tier gate.
 *
 * WHY THE SERVER OWNS THE DEADLINE. The client already looks like it has
 * everything it needs (window/meeting renders a live elapsed timer off
 * `Date.now()`), and computing the cutoff there is wrong in four ways:
 *
 *   rejoin      `_meetingStartedAt` is per-SESSION. Reload the tab and the
 *               clock restarts, so a client-side cap is defeated by F5.
 *   clock       `Date.now()` is the local wall clock. A skewed clock, or a
 *               laptop resuming from sleep, moves the cutoff.
 *   whose plan  each client evaluating its own entitlement gives a different
 *               answer per participant. It has to be ONE answer for the room,
 *               and the room belongs to the workspace — so the WORKSPACE OWNER
 *               decides, resolved once, here.
 *   guests      a DMZ guest has no account and no quota at all, so there is
 *               nothing for their client to evaluate. They still have to be
 *               told when the meeting ends.
 *
 * WHERE THE START TIME COMES FROM, and why it is not in SQL. The live meeting
 * path is `conference.join` → yp.conference, which is a per-SOCKET
 * participant table with no timestamp of any kind; its rows are deleted when
 * a participant leaves. There is no per-ROOM record on this path at all —
 * yp.room (which does have `ctime`) belongs to the older room.* services the
 * meeting UI never calls, and yp.conference_host, which has exactly the right
 * shape, is declared and has never been written to.
 *
 * So the room's start is kept in Redis under `meeting:start:<room_id>`, set
 * with NX so the FIRST joiner wins and every later join — including a rejoin
 * after a reload — reads that same value back instead of restarting the
 * clock. This is what closes the reload loophole, and it does it without
 * touching the conference_join procedure or the yp.conference schema, i.e.
 * without putting a migration in the hottest path of the meeting feature.
 * The key carries a TTL so a meeting that dies badly cannot cap the next one.
 *
 * WHAT THIS IS NOT: a kill switch. Nothing here terminates a conference — the
 * clients do that on the deadline, via the MEETING_END broadcast that already
 * ends a meeting for everyone. This module's only job is to be the single
 * authority on WHEN.
 *
 * Never throws. Every failure path returns "no cap", which is the same answer
 * an unlimited plan gets: a check that cannot run must not end someone's call.
 */

const { RedisStore } = require("@drumee/server-essentials");

const START_KEY = "meeting:start:";

/**
 * How long a room's start timestamp lives BEYOND the cap it is serving.
 *
 * The key only has a job for as long as the meeting it stamps can legally run:
 * once the cap has fired there is nothing left to measure. So the TTL is the
 * cap itself plus this grace, and it is NEVER refreshed — see roomStart.
 *
 * WHY NOT A FLAT LONG TTL (this was 24h, refreshed on every join, and it was
 * a bug). For a workspace meeting `room_id` IS the workspace node id — the
 * team window launches with `room_id = nid` and `wm_unique_id` is per hub —
 * so every meeting a workspace ever holds reuses ONE key. A start time that
 * outlives its meeting is therefore inherited by the NEXT one: second meeting
 * of the day reads the first one's start, computes remaining_sec = 0, and is
 * killed the instant it opens, upsell card and all. Refreshing the TTL on
 * each join made it worse, pushing the stale value further out every attempt.
 *
 * The grace only has to cover the gap between the deadline passing and the
 * clients acting on it.
 */
const START_GRACE_SEC = 5 * 60;

/**
 * Is duration capping in force on this deployment?
 *
 * Mirrors the client's `libs/billing.billingAvailable()` decision, in the same
 * order and for the same reason, so the two cannot disagree about whether an
 * install gates at all:
 *
 *   1. capability floor — is the payment module actually loaded here? Without
 *      a checkout there is no way to lift the cap, and a limit nobody can pay
 *      to remove is a defect, not an upsell. This is AGPL software that other
 *      people run on their own hardware.
 *   2. the operator's explicit `billing_upgrade` switch, tri-state, wins.
 *   3. otherwise arch: 'cloud' sells, 'pod' does not.
 *
 * @returns {Boolean}
 */
function enabled() {
  // Lazy require: router/rest pulls in the module registry, and this file is
  // reached from a service the router itself loads.
  let services;
  try {
    services = require("../../router/rest").getServices() || {};
  } catch (e) {
    return false;
  }
  if (!(services.payment && services.payment.checkout)) return false;

  const conf = global.myDrumee || {};
  // Deliberately tri-state, matching env.js: "unset" and "explicitly 0" mean
  // different things, so `undefined` falls through to the arch rule rather
  // than reading as off.
  if (conf.billing_upgrade !== undefined) return truthy(conf.billing_upgrade);
  return (conf.arch || "pod") === "cloud";
}

/**
 * myDrumee.json is hand-edited, so 1 / "1" / true / "true" / "on" / "yes" all
 * mean on. Same tolerance as the client's `envFlag()`.
 */
function truthy(raw) {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  const s = String(raw).trim().replace(/^"|"$/g, "").toLowerCase();
  return ["1", "true", "on", "yes", "enabled"].includes(s);
}

/**
 * The cap, in minutes, that a given user's plan carries.
 *
 * Reads `$.meeting_minutes` from the entitlement via the get_quota FUNCTION —
 * not the PROCEDURE of the same name, which returns a fixed column list and
 * would drop this key. The function resolves org-before-personal and falls
 * back to the free sentinel row for an account with no entitlement of its own.
 *
 * 0 / absent / unparseable all mean NO CAP. Absent is the important one: the
 * key does not exist until the schemas patch runs, so until then this feature
 * is inert rather than capping everybody at zero minutes.
 *
 * THE RESULT MAY BE A JSON STRING, NOT AN OBJECT. await_func returns the raw
 * column value, and a MariaDB function declared `RETURNS JSON` comes back as
 * a string on this driver often enough that every other caller in the tree
 * guards for it (service/private/hub.js seatBudget, service/private/promo.js
 * `isFreePersonal`). Without the guard `q.meeting_minutes` is undefined, so
 * capMinutes answers 0, so no room is ever capped — and because this feature
 * fails OPEN by design, that failure is completely silent: no throw, no log,
 * nothing but a gate that quietly does not exist.
 *
 * @returns {Promise<Number>} minutes, or 0 for uncapped
 */
async function capMinutes(view, uid) {
  if (!uid) return 0;
  try {
    const raw = await view.yp.await_func("get_quota", uid);
    let q = raw;
    if (typeof q === "string") {
      try {
        q = JSON.parse(q || "{}");
      } catch (e) {
        return 0;
      }
    }
    const m = parseInt(q && q.meeting_minutes, 10);
    return Number.isFinite(m) && m > 0 ? m : 0;
  } catch (e) {
    return 0;
  }
}

/**
 * When this room started — the FIRST join wins.
 *
 * `SET NX` is the whole mechanism: the first caller writes its timestamp, and
 * every caller after it (a second participant, or the same person after a
 * reload) fails the NX and reads the existing value. Without NX each rejoin
 * would stamp a new start and the cap would reset, which is the exact hole a
 * client-side timer has.
 *
 * Two commands rather than SET..NX..GET on purpose: the GET option needs Redis
 * 6.2, and this has no business caring what the deployment runs. The race
 * between them is benign — whoever loses the NX reads a value that is already
 * final, because NX means it can never be rewritten.
 *
 * THE TTL IS NOT REFRESHED, deliberately. The expiry is set once, by the
 * winner of the NX, to the cap plus a grace — the exact span over which this
 * value can still mean anything. Re-arming it on later joins would let a
 * finished meeting's start time survive into the next one; see
 * START_GRACE_SEC. Between this and clearRoomStart() a stale key is bounded
 * two ways: the room emptying, and the clock.
 *
 * @param {String} roomId
 * @param {Number} minutes the cap this start time will be measured against
 * @returns {Promise<Number>} unix seconds, or 0 when Redis is unavailable
 */
async function roomStart(roomId, minutes) {
  try {
    const client = RedisStore.getClient();
    if (!client) return 0;
    const key = START_KEY + roomId;
    const now = Math.floor(Date.now() / 1000);
    const ttl = Math.max(60, ~~minutes * 60 + START_GRACE_SEC);
    const won = await client.set(key, String(now), { NX: true, EX: ttl });
    if (won) return now;
    const existing = parseInt(await client.get(key), 10);
    if (Number.isFinite(existing) && existing > 0) return existing;
    return now;
  } catch (e) {
    return 0;
  }
}

/**
 * Forget a room's start time.
 *
 * Called when the last participant leaves (conference.leave), which is what
 * makes the NEXT meeting in that workspace a new meeting with a full cap
 * rather than a continuation of the one that just finished — `room_id` is
 * reused across meetings, so without this the key outlives its meeting.
 *
 * This is also, intentionally, the rule that lets a room restart after being
 * cut off: everyone is ejected, the room empties, the key goes, and reopening
 * gets a fresh cap. That is the same bargain Zoom's free tier makes — the
 * limit is on how long ONE meeting may run, not on how many minutes a day a
 * workspace gets.
 *
 * Never throws: failing to clean up must not fail a leave.
 */
async function clearRoomStart(roomId) {
  if (!roomId) return;
  try {
    const client = RedisStore.getClient();
    if (!client) return;
    await client.del(START_KEY + roomId);
  } catch (e) { }
}

/**
 * The deadline for a room, if it has one.
 *
 * @param {Object} view  the service instance (needs `.yp`)
 * @param {Object} opt
 * @param {String} opt.room_id
 * @param {String} opt.type     room type; only 'meeting' is capped
 * @param {String} opt.owner_id workspace owner — their plan governs the room
 * @returns {Promise<{expires_at:Number, duration_limit:Number, remaining_sec:Number}|null>}
 *          null when uncapped
 */
async function roomDeadline(view, opt = {}) {
  try {
    const { room_id, type, owner_id } = opt;
    if (!room_id) return null;
    // GROUP meetings only. 'connect' is the 1:1 call and is not part of this
    // gate; 'screen' and 'webinar' are not either. Scoped here rather than at
    // the call site so a future caller cannot accidentally cap a 1:1.
    if (String(type) !== "meeting") return null;
    if (!enabled()) return null;

    const minutes = await capMinutes(view, owner_id);
    if (!minutes) return null;

    const start = await roomStart(room_id, minutes);
    if (!start) return null;

    const expires_at = start + minutes * 60;

    return {
      expires_at,
      duration_limit: minutes,
      /**
       * How long the client should actually wait, measured HERE.
       *
       * Handing over `expires_at` alone would quietly reintroduce the clock
       * problem: the client would have to evaluate `expires_at - Date.now()`,
       * and `Date.now()` is exactly the local wall clock this design exists to
       * stop trusting — a browser ten minutes fast would cut the meeting ten
       * minutes early.
       *
       * A DURATION has no such problem. Both timestamps in this subtraction
       * come from one clock, and measuring an interval is something a client
       * can do accurately even with no idea what time it is. expires_at still
       * goes along for display and for anything reasoning about the absolute
       * moment.
       */
      remaining_sec: Math.max(0, expires_at - Math.floor(Date.now() / 1000)),
    };
  } catch (e) {
    // See the header: a failed check never ends a call.
    return null;
  }
}

module.exports = {
  enabled,
  capMinutes,
  roomStart,
  clearRoomStart,
  roomDeadline,
  START_KEY,
};
