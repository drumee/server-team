/**
 * "<invitee> accepted / declined your invitation to <workspace>", addressed to
 * the admin who SENT the workspace invitation (the token's inviter_id).
 *
 * Called by hub.accept_invite and hub.decline_invite once the answer is
 * written. The Access panel already shows the answer as a Pending / Declined
 * line; this is the bell notification that tells the inviter it happened
 * (Lexis 2026-11-02).
 *
 * The row is a yp.contact_activity event, like every other person-to-person
 * notification (invite_accepted for a contact invitation, file_edited, ...):
 *   uid        the invitee -- their account when they have one, else the
 *              anonymous sentinel (an address with no Drumee account that
 *              declined from the email link); the row then names them by
 *              data.email.
 *   target_uid the inviter.
 *
 * Best-effort by contract: the answer has already been recorded when this
 * runs, so nothing here throws, and a skipped notification is only logged.
 */
const { RedisStore, toArray } = require("@drumee/server-essentials");
const { hubWildcardPermission } = require("./hub-owner");

const HUB_INVITE_ACCEPTED = "hub_invite_accepted";
const HUB_INVITE_DECLINED = "hub_invite_declined";
const EVENT_BY_ANSWER = {
  accepted: HUB_INVITE_ACCEPTED,
  declined: HUB_INVITE_DECLINED,
};
// Live refresh of the inviter's notification panel and badge.
const PUSH_SERVICE = "activity.hub_invite_answer";
const ID_RE = /^[0-9a-zA-Z_-]{1,32}$/;
// Somebody with no session (same sentinel as lib/file-owner-notify and
// private/secure_share.js).
const ANONYMOUS_UID = "ffffffffffffffff";
const isUser = (uid) => ID_RE.test(String(uid || "")) && String(uid) !== ANONYMOUS_UID;

/**
 * The account the invitation was answered by: the signed-in caller, else the
 * account registered under the invited address, else the anonymous sentinel.
 */
async function answeredBy(yp, actor, email) {
  if (isUser(actor)) return String(actor);
  if (email) {
    try {
      const d = toArray(await yp.await_proc("drumate_exists", email))[0];
      if (d && isUser(d.id)) return String(d.id);
    } catch (e) { /* unknown address: anonymous below */ }
  }
  return ANONYMOUS_UID;
}

/**
 * @param {Object} svc a service (Entity) instance: yp, payload(), warn()
 * @param {Object} args
 *   answer      'accepted' | 'declined'
 *   hub_id      the workspace the invitation was for
 *   inviter_id  the token's inviter_id -- who is told
 *   email       the address the invitation was sent to
 *   actor       the caller's uid (may be absent / anonymous on a decline)
 * @returns {Promise<boolean>} true when a notification was written
 */
async function notifyInviter(svc, args = {}) {
  const event = Object.prototype.hasOwnProperty.call(EVENT_BY_ANSWER, args.answer)
    ? EVENT_BY_ANSWER[args.answer] : null;
  const hub_id = String(args.hub_id || "");
  const inviter = String(args.inviter_id || "");
  const email = String(args.email || "").trim().toLowerCase();
  try {
    if (!event || !ID_RE.test(hub_id) || !isUser(inviter)) return false;
    const yp = svc.yp;
    const actor = await answeredBy(yp, args.actor, email);
    // Inviting yourself is not news to you.
    if (actor === inviter) return false;

    // An inviter who has since left the workspace, or been removed from it,
    // is not told about it any more.
    const db_name = await yp.await_func("get_db_name", hub_id);
    if (!db_name || !(await hubWildcardPermission(yp, db_name, inviter))) return false;

    // The workspace's display name (yp.hub.name), read-only.
    let hub_name = null;
    try {
      const row = toArray(await yp.await_proc("push_workspace_name", hub_id))[0];
      hub_name = (row && String(row.workspace_name || "").trim()) || null;
    } catch (e) { /* the row still names the workspace by id */ }

    const data = { hub_id, hub_name, email: email || null, answer: args.answer };
    await yp.await_proc("contact_log_activity", actor, inviter, event, data);

    try {
      const sockets = await yp.await_proc("user_sockets", [inviter]);
      if (sockets && toArray(sockets).length) {
        await RedisStore.sendData(
          svc.payload({ event, hub_id }, { service: PUSH_SERVICE }),
          sockets
        );
      }
    } catch (e) {
      svc.warn("[hub-invite-answer-notify] push failed:", e && e.message);
    }
    return true;
  } catch (e) {
    svc.warn("[hub-invite-answer-notify] skipped:", event, hub_id, e && e.message);
    return false;
  }
}

module.exports = {
  notifyInviter,
  HUB_INVITE_ACCEPTED,
  HUB_INVITE_DECLINED,
  PUSH_SERVICE,
  ANONYMOUS_UID,
};
