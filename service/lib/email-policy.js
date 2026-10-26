/**
 * @license
 * Copyright 2024 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3.
 * https://www.gnu.org/licenses/agpl-3.0.html
 */

const { isEmpty } = require("lodash");

function _parseSettings(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

/**
 * Resolve recipient's `email_notifications` preference — OPT-IN.
 *
 * A registered Drumate user receives notification mail only when they have
 * explicitly enabled the Settings toggle (`settings.email_notifications`
 * truthy). A missing key means "never enabled" and mails are NOT sent —
 * this matches the Settings UI, which renders the toggle off until the
 * user turns it on.
 *
 * Non-Drumate recipients (external guests of a share/invite — no account,
 * so no toggle to consult) always receive: the email IS the feature there.
 * Same when the account lookup itself fails — favor delivery over silently
 * dropping an external guest's share link. A registered user whose settings
 * row cannot be read is treated as not opted in.
 *
 * Use ONLY for activity/notification emails (share-received, contact-added,
 * etc.). NEVER call this before OTP, password reset, email change, account
 * deletion, admin invitations, or other security/transactional mails — those
 * must always be delivered.
 *
 * @param {object} yp     `await_proc`-capable yellow_page connection
 * @param {string} email  recipient address
 * @returns {Promise<boolean>} true → caller should send; false → caller should skip
 */
async function shouldSendNotification(yp, email) {
  if (!yp || isEmpty(email) || typeof email !== "string") return true;
  let row;
  try {
    row = await yp.await_proc("email_exists", email);
  } catch (_) {
    return true;
  }
  if (!row || !row.id) return true;
  let settings;
  try {
    const r = await yp.await_proc("get_entity_settings", row.id);
    settings = _parseSettings(r && r.settings);
  } catch (_) {
    return false;
  }
  return !!parseInt(settings.email_notifications);
}

/**
 * Whether `email` belongs to a Drumee account. Notification mail offers
 * one-click unsubscribe only to account holders: the link turns an ACCOUNT
 * setting off, so a guest's link could only promise something it cannot do.
 * False on a lookup error — the safe answer is "no header".
 *
 * @param {object} yp     `await_proc`-capable yellow_page connection
 * @param {string} email
 * @returns {Promise<boolean>}
 */
async function hasAccount(yp, email) {
  if (!yp || isEmpty(email) || typeof email !== "string") return false;
  try {
    const row = await yp.await_proc("email_exists", email);
    return !!(row && row.id);
  } catch (_) {
    return false;
  }
}

module.exports = { shouldSendNotification, hasAccount, parseSettings: _parseSettings };
