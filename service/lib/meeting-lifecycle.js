/**
 * Workspace-meeting lifecycle: WHEN a meeting counts as started (and is
 * announced to the workspace), WHO that announcement reaches, and cleaning up
 * the "X started a meeting" chat card when the room empties.
 *
 * WHY THIS EXISTS. Users kept getting "X started a meeting" for meetings that
 * did not exist. Three server-side causes, each fixed here:
 *
 *   1. conference.start fired on every HOST join, not on the start. Since
 *      conference_join hands the host role to the first edit-tier joiner of a
 *      hostless room, a host who reloads, a network blip, a Retry on the
 *      blocked-media screen, or a member joining after the host stepped out
 *      each re-announced a meeting that had been running for an hour.
 *      → only the FIRST joiner announces, and only once per room lifetime
 *        (claimStartAnnouncement).
 *
 *   2. A server restart (socket_reset) wipes yp.conference while the Jitsi
 *      call carries on, so the next person to join a RUNNING meeting looked
 *      like its first joiner. The per-room Redis marker survives the restart,
 *      so that join is recognised as a continuation and not announced.
 *
 *   3. The announcement went to entity_sockets, which matches ANY row in the
 *      hub's permission table — single-file shares, links, expired or zeroed
 *      grants — so people outside the workspace were told about its meetings.
 *      → filtered to workspace-level members (workspaceMemberIds). NOT fixed
 *        inside entity_sockets itself: every hub broadcast (chat posts, file
 *        threads, …) goes through it, and those recipients are a separate
 *        question.
 *
 * And the chat card: it was flipped to "ended" only by the client, from the
 * meeting window's teardown — which never runs when the last tab is closed,
 * crashes or loses its network. The card then offered "Join meeting" forever,
 * and clicking it STARTED a new meeting (the clicker is the first joiner),
 * which re-announced to everyone. endLiveMeetingCards flips it server-side
 * when the room empties, on both the clean leave and the dropped-socket path.
 *
 * `room_id` for a workspace meeting is the workspace node and is reused by
 * every meeting the workspace holds — the marker is therefore cleared when the
 * room empties, and otherwise lives only as long as the room shows signs of
 * life (see ANNOUNCED_TTL_SEC).
 *
 * Nothing here throws: a failed announcement check or cleanup must never fail
 * a join or a leave.
 */

const { RedisStore, toArray } = require("@drumee/server-essentials");

const ANNOUNCED_KEY = "meeting:announced:";

/**
 * How long an announcement marker outlives the last sign of life in its room.
 *
 * It is normally deleted when the room empties (forgetStartAnnouncement). The
 * TTL covers the case where that never happens — a server restart wipes
 * yp.conference, then everyone just closes their tab: no conference.leave, and
 * the disconnect path finds no row to release. A long fixed TTL would then
 * silently swallow the NEXT genuine meeting's announcement for hours.
 *
 * So the marker is a HEARTBEAT instead: short-lived, and re-armed by every
 * participant's periodic diagnostics ping (conference.update event=diag, every
 * 30 s per joined client — webrtc/room/jitsi.js DIAG_PERIOD_MS). That ping
 * needs no conference row, so it keeps a running meeting marked even after a
 * restart, and a dead meeting frees its room within this window. 5 min leaves
 * room for background-tab timer throttling (down to ~1 call/min in Chrome).
 * A client that never pings degrades to the first-joiner rule alone.
 */
const ANNOUNCED_TTL_SEC = 5 * 60;

const MEETING_CARD_PREFIX = "[[MEETING:start:";

/**
 * Take the right to announce this room's meeting. The first caller wins (SET
 * NX); every later caller — a rejoin, a promoted host, a join after a server
 * restart wiped the conference rows — loses until the room empties.
 *
 * Fails OPEN (true) when Redis is unavailable: that is the pre-fix behaviour
 * (announce the first joiner), not silence.
 *
 * @param {String} roomId
 * @returns {Promise<Boolean>}
 */
async function claimStartAnnouncement(roomId) {
  if (!roomId) return true;
  try {
    const client = RedisStore.getClient();
    if (!client) return true;
    const won = await client.set(
      ANNOUNCED_KEY + roomId,
      String(Math.floor(Date.now() / 1000)),
      { NX: true, EX: ANNOUNCED_TTL_SEC },
    );
    return !!won;
  } catch (e) {
    return true;
  }
}

/**
 * Someone is still in this room (their diagnostics ping arrived): push the
 * marker's expiry out. EXPIRE on a missing key is a no-op, so this can never
 * create a marker — only the first joiner's claim does.
 * @param {String} roomId
 */
async function touchStartAnnouncement(roomId) {
  if (!roomId) return;
  try {
    const client = RedisStore.getClient();
    if (!client) return;
    await client.expire(ANNOUNCED_KEY + roomId, ANNOUNCED_TTL_SEC);
  } catch (e) { }
}

/**
 * The room is empty: its next join is a new meeting again.
 * @param {String} roomId
 */
async function forgetStartAnnouncement(roomId) {
  if (!roomId) return;
  try {
    const client = RedisStore.getClient();
    if (!client) return;
    await client.del(ANNOUNCED_KEY + roomId);
  } catch (e) { }
}

/**
 * Workspace members: the account-wide ('*') grant with a live privilege — the
 * same definition hub_get_members_by_type uses. A row on a single node (a
 * shared file, a link, a chat attachment) does NOT make someone a member.
 *
 * Returns null when the answer is unknown (query failed, or came back empty,
 * which for a workspace — it always has an owner row — means failure). The
 * caller then keeps its unfiltered list rather than dropping everyone.
 *
 * @param {Object} db the hub's own connection (service `this.db`)
 * @returns {Promise<Set<String>|null>}
 */
async function workspaceMemberIds(db) {
  if (!db || typeof db.await_query !== "function") return null;
  try {
    const rows = toArray(
      await db.await_query(
        "SELECT DISTINCT entity_id FROM permission WHERE resource_id='*' " +
        "AND permission > 0 AND (expiry_time = 0 OR expiry_time > UNIX_TIMESTAMP())"
      )
    ).filter((r) => r && r.entity_id);
    if (!rows.length) return null;
    return new Set(rows.map((r) => String(r.entity_id)));
  } catch (e) {
    return null;
  }
}

/**
 * Keep only the sockets of workspace members. Unknown membership → unchanged.
 * @param {Array} sockets entity_sockets rows ({socket_id, uid})
 * @param {Set<String>|null} members
 */
function onlyMembers(sockets, members) {
  const list = toArray(sockets).filter(Boolean);
  if (!members) return list;
  return list.filter((s) => s.uid != null && members.has(String(s.uid)));
}

function parseJson(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string" || !raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

/**
 * Is this chat row a still-live start card for `roomId`? Same matching rule as
 * the client's window_meeting._findLiveMeetingCardId: the payload's room_id,
 * or — for cards posted before room_id was carried — its nid (a workspace
 * meeting's room_id IS its node id).
 */
function isLiveCardFor(row, roomId) {
  if (!row || typeof row.message !== "string") return false;
  const m = row.message.match(/^\[\[MEETING:start:([\s\S]*)\]\]$/);
  if (!m) return false;
  const payload = parseJson(m[1]) || {};
  const rid = payload.room_id != null ? payload.room_id : payload.nid;
  if (rid == null || String(rid) !== String(roomId)) return false;
  const md = parseJson(row.metadata);
  return !(md && md.meeting_status === "ended");
}

/**
 * The room just emptied: flip every still-live start card for it to "ended"
 * and push the updated rows to the workspace, exactly as channel.meeting_end
 * does when a client asks. Idempotent with that path — a client that also
 * flips (clean teardown) re-writes the same value.
 *
 * Every live card, not only the newest: duplicates posted before this fix
 * (restart / double-start) would otherwise keep offering "Join meeting".
 *
 * @param {Object} yp    yp connection (reaches the hub DB by name)
 * @param {Object} opt
 * @param {String} opt.hub_id
 * @param {String} opt.room_id
 * @returns {Promise<Number>} cards flipped
 */
async function endLiveMeetingCards(yp, opt = {}) {
  const { hub_id, room_id } = opt;
  if (!yp || !hub_id || !room_id) return 0;
  try {
    const ent = toArray(
      await yp.await_query("SELECT db_name FROM entity WHERE id=?", hub_id)
    )[0];
    const db = ent && ent.db_name;
    // Interpolated as an identifier, so it must be a plain name.
    if (!db || !/^\w+$/.test(db)) return 0;

    const rows = toArray(
      await yp.await_query(
        `SELECT message_id, message, metadata FROM \`${db}\`.channel ` +
        "WHERE message LIKE ? AND status = 'active'",
        `${MEETING_CARD_PREFIX}%`
      )
    ).filter((r) => isLiveCardFor(r, room_id));
    if (!rows.length) return 0;

    let recipients = null;
    let flipped = 0;
    for (const r of rows) {
      // Same targeted write as hub channel_meeting_end: only meeting_status
      // changes, every other metadata key is kept.
      await yp.await_query(
        `UPDATE \`${db}\`.channel SET metadata = JSON_SET(` +
        "COALESCE(NULLIF(metadata, ''), '{}'), '$.meeting_status', 'ended') " +
        "WHERE message_id = ?",
        r.message_id
      );
      const message = toArray(
        await yp.await_query(
          `SELECT * FROM \`${db}\`.channel WHERE message_id = ?`,
          r.message_id
        )
      )[0];
      if (!message) continue;
      flipped++;
      // key_id is what channel.meeting_end already sends (chat inbox rows find
      // the conversation by it); hub_id is what the folder window's Start
      // button checks before it will un-light "Join meeting".
      message.key_id = hub_id;
      message.hub_id = hub_id;
      if (!recipients) {
        recipients = toArray(await yp.await_proc("entity_sockets", { hub_id }));
      }
      await RedisStore.sendData(
        { model: message, options: { service: "channel.meeting_end", keys: "*" } },
        recipients
      );
    }
    return flipped;
  } catch (e) {
    return 0;
  }
}

/**
 * Everything "the room is now empty" means for a workspace meeting.
 * @param {Object} yp
 * @param {Object} opt { hub_id, room_id }
 */
async function onRoomEmptied(yp, opt = {}) {
  await forgetStartAnnouncement(opt.room_id);
  await endLiveMeetingCards(yp, opt);
}

module.exports = {
  ANNOUNCED_KEY,
  ANNOUNCED_TTL_SEC,
  claimStartAnnouncement,
  touchStartAnnouncement,
  forgetStartAnnouncement,
  workspaceMemberIds,
  onlyMembers,
  isLiveCardFor,
  endLiveMeetingCards,
  onRoomEmptied,
};
