/**
 * How many wrong passwords a protected invite link takes before it pauses.
 *
 * A dmz link (a meeting's invite, a folder share) had no attempt counter:
 * secure shares lock at 3 in SQL, these took any number of passwords, through
 * dmz.login and through yp.guest_login, which both end in session.dmz_login.
 *
 * The count is per link, not per session, because a session id costs nothing
 * to replace. It is a window, not a lock: once the window runs out the link
 * takes passwords again, so typing wrong ones cannot shut a meeting's link for
 * good. With Redis unavailable there is no limit (the password itself is still
 * checked); nothing here throws.
 */
const { RedisStore } = require("@drumee/server-essentials");

const MAX_FAILURES = 10;
const WINDOW_SEC = 15 * 60;
const KEY = "dmz:pwfail:";

/**
 * @param {String} token
 * @returns {Promise<Number>} seconds until the link takes a password again, 0 when it does now
 */
async function retryAfter(token) {
  try {
    const client = RedisStore.getClient();
    if (!client || !token) return 0;
    const failures = parseInt(await client.get(KEY + token), 10) || 0;
    if (failures < MAX_FAILURES) return 0;
    const ttl = await client.ttl(KEY + token);
    return ttl > 0 ? ttl : WINDOW_SEC;
  } catch (e) {
    return 0;
  }
}

/**
 * Count one wrong password. The window starts with the first one; a count
 * left without a window (its expire failed) gets one here, so no link stays
 * paused for good.
 * @param {String} token
 */
async function recordFailure(token) {
  try {
    const client = RedisStore.getClient();
    if (!client || !token) return;
    const failures = await client.incr(KEY + token);
    if (failures === 1 || (await client.ttl(KEY + token)) < 0) {
      await client.expire(KEY + token, WINDOW_SEC);
    }
  } catch (e) { }
}

module.exports = { retryAfter, recordFailure, MAX_FAILURES, WINDOW_SEC };
