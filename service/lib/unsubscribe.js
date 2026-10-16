/**
 * @license
 * Copyright 2026 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3
 */

// service/lib/unsubscribe.js
// What callback.unsubscribe does, separated from the request so it is
// testable. It turns OFF the same `email_notifications` setting the Settings
// toggle writes (drumate.update_settings) — the one email-policy.js gates
// notification mail on — and keeps every other key (2FA, language, …).
// It never deletes the account's address or touches transactional mail.

const { escape } = require("lodash");
const { parseSettings } = require("./email-policy");

/**
 * @param {object} yp    await_proc-capable yellow_page connection
 * @param {string} email already verified and lowercased
 * @returns {Promise<{changed:boolean, reason?:string}>}
 */
async function unsubscribeEmail(yp, email) {
  const row = await yp.await_proc("email_exists", email);
  if (!row || !row.id) return { changed: false, reason: "no_account" };
  const r = await yp.await_proc("get_entity_settings", row.id);
  const settings = parseSettings(r && r.settings);
  if (!parseInt(settings.email_notifications)) {
    return { changed: false, reason: "already_off" };
  }
  settings.email_notifications = 0;
  await yp.await_proc("entity_update_settings", row.id, JSON.stringify(settings));
  return { changed: true };
}

const MESSAGES = {
  done: "You will no longer receive notification emails from Drumee. "
    + "Security emails such as sign-in codes are still sent. "
    + "You can turn notifications back on in your account settings.",
  no_account: "There is no Drumee account for this address, so there is "
    + "nothing to unsubscribe from.",
  invalid: "This unsubscribe link is not valid.",
  error: "Something went wrong. Please try again later.",
};

/** @param {string} state "done" | "no_account" | "invalid" | "error" @returns {string} */
function unsubscribePage(state) {
  const text = MESSAGES[state] || MESSAGES.invalid;
  return "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"UTF-8\">"
    + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
    + "<title>Drumee email preferences</title></head>"
    + "<body style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;"
    + "max-width:480px;margin:64px auto;padding:0 16px;color:#282538;line-height:1.5;\">"
    + `<p>${escape(text)}</p></body></html>`;
}

module.exports = { unsubscribeEmail, unsubscribePage };
