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
 * Resolve recipient's `email_notifications` preference. Returns false only
 * when the recipient is a Drumate user who has explicitly opted out
 * (`settings.email_notifications === 0`). Returns true for non-Drumate
 * recipients, missing settings, or any lookup failure — never silently
 * drop a security/transactional email.
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
    return true;
  }
  if (settings.email_notifications === undefined) return true;
  return !!parseInt(settings.email_notifications);
}

module.exports = { shouldSendNotification };
