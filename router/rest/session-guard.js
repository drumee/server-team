/**
 * Session-change guard — a stale tab must not act as another account.
 *
 * Every account of an org signs in on the same origin, so a browser keeps ONE
 * session cookie for all of them: signing in as B in one tab (or signing out)
 * swaps the session under every other open tab. Those tabs keep drawing A's
 * desk while their requests run as B — measured on stage 2026-11-06, a tab
 * showing yipejo5194's desk sent media.attributes as s110@drumee.com and then
 * as nobody. Reads were refused; a write would have gone through as B.
 *
 * The UI (ui-team libs/session-guard) sends the uid it believes in as
 * `x-drumee-uid` on every same-origin /svc/ call. router/rest run() refuses a
 * mismatch with 412 SESSION_CHANGED BEFORE the service is even resolved.
 *
 * Inert by construction for anything that does not send a real uid: no
 * header, nobody, the guest id or garbage all pass — so this deploys ahead of
 * the UI and never refuses an older bundle. SESSION_GUARD=0 turns it off.
 */

const UID_RE = /^[0-9a-f]{16}$/;
const NOBODY = 'ffffffffffffffff';

// A stale tab must still be able to leave and to re-bootstrap: sign-out,
// session reset, the environment read at boot, and the auth family.
const SESSION_GUARD_EXEMPT = new Set([
  'drumate.logout',
  'yp.reset_session',
  'yp.get_env',
]);
const SESSION_GUARD_EXEMPT_PREFIX = ['bootstrap.', 'authn.'];

/**
 * @param {String} service
 * @returns {Boolean}
 */
function isExempt(service) {
  const s = String(service || '');
  if (SESSION_GUARD_EXEMPT.has(s)) return true;
  return SESSION_GUARD_EXEMPT_PREFIX.some((p) => s.startsWith(p));
}

/**
 * Does this request come from a tab that believes in a different account
 * than the session it carries?
 *
 * @param {*} claimed  the x-drumee-uid header value
 * @param {*} actual   session.uid() — the account the session really is
 * @param {String} service
 * @param {String} [guestId]  the platform guest id (Cache sysconf guest_id)
 * @returns {Boolean} true → refuse with 412 SESSION_CHANGED
 */
function sessionMismatch(claimed, actual, service, guestId) {
  if (typeof claimed !== 'string' || !claimed) return false;
  const c = claimed.trim().toLowerCase();
  if (!UID_RE.test(c)) return false;
  if (c === NOBODY) return false;
  if (guestId && c === String(guestId).toLowerCase()) return false;
  if (isExempt(service)) return false;
  const a = String(actual || NOBODY).toLowerCase();
  return c !== a;
}

/** Kill switch: SESSION_GUARD=0 (or "off"/"false") disables the check. */
function enabled() {
  const v = String(process.env.SESSION_GUARD || '').toLowerCase();
  return !['0', 'off', 'false', 'no'].includes(v);
}

module.exports = {
  NOBODY,
  SESSION_GUARD_EXEMPT,
  isExempt,
  sessionMismatch,
  enabled,
};
