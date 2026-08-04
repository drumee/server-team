/**
 * @license
 * Copyright 2026 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3.
 * https://www.gnu.org/licenses/agpl-3.0.html
 */

/**
 * Writes to yp.services_log from application code, for sessions that
 * @drumee/server-core did not open itself.
 *
 * server-core records a connection in exactly two places -- session.signin()
 * and session.login() -- via its private _log_connection, which stamps the row
 * with args.success=1 plus ip/geodata/headers. Every other way into a live
 * session opens it with a PROCEDURE (session_login_otp,
 * session_login_with_oauth, session_login_next) and leaves no trace.
 *
 * That matters because two readers treat this table as the record of who got
 * in and when: yp.show_login_log, and the analytics "Last login" column, which
 * takes MAX(ctime) over rows carrying args.success='1'. A login that writes no
 * row is a user who appears never to have signed in.
 *
 * Lives here rather than on a base class because the services that need it do
 * not share one: yp.js extends Entity while lobby.js and butler.js extend Mfs.
 */

/**
 * Record an accepted sign-in for `uid`.
 *
 * The service instance is passed in rather than bound, so this works from any
 * scope. `_log_connection` fills in the service name, ip, geodata and headers
 * from the live request; the explicit uid is what makes it usable before
 * `this.user` has been populated, which is the normal state on a proc-opened
 * session.
 *
 * NEVER LET THIS BREAK A LOGIN. The caller is already authenticated by the time
 * we run, so a logging failure must cost an analytics row and not a session.
 * Every failure is warned and swallowed.
 *
 * @param {Object} svc calling service instance (`this`)
 * @param {String} uid
 */
async function logConnection(svc, uid) {
  try {
    await svc.session._log_connection({ uid });
  } catch (e) {
    svc.warn("connection_log: failed to record login for", uid, e && e.message);
  }
}

/**
 * Take back a connection log that session.signin() wrote before a later gate
 * refused the sign-in.
 *
 * signin() logs as soon as the credentials check out, so a caller that then
 * tears the session down (see the unverified-email gate in yp.login) leaves a
 * row behind saying the user got in. Marking it success=0 files it with the
 * other refusals: both readers select on args.success, so it stops counting as
 * a login without vanishing from the audit trail.
 *
 * Targets the newest success row for the uid, which within a single request is
 * the one signin() just wrote. A concurrent login by the SAME user in the
 * window between the two statements could see the wrong row marked; that costs
 * an analytics timestamp, which is not worth a lock.
 *
 * @param {Object} svc calling service instance (`this`)
 * @param {String} uid
 * @param {String} reason recorded as args.reason, matching how server-core
 *                        labels its own refusals (WRONG_CREDENTIALS etc.)
 */
async function revokeConnectionLog(svc, uid, reason) {
  try {
    await svc.yp.await_query(
      `UPDATE services_log
          SET args = JSON_SET(args, '$.success', 0, '$.reason', ?)
        WHERE uid = ? AND JSON_VALUE(args, '$.success') = '1'
        ORDER BY sys_id DESC LIMIT 1`,
      reason, uid
    );
  } catch (e) {
    svc.warn("connection_log: failed to revoke login for", uid, e && e.message);
  }
}

module.exports = { logConnection, revokeConnectionLog };
