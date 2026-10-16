// service/lib/butler-mail.js
// Shared "butler" email sender, kept for its callers (the Stripe webhook's
// receipt and dunning mails). It now delegates to lib/send-mail.js, which sets
// the From, Reply-To and plain-text part for all user-facing mail.
const { sendMail } = require('./send-mail');

/**
 * @param {Messenger} msg - configured Messenger (subject, recipient, handler)
 * @param {{recipient:string, subject:string, html:string, text:string}} parts
 * @returns {Promise<{recipient:string[], error:null|string[]}|string>}
 */
async function sendButlerMail(msg, { recipient, subject, html, text }) {
  return sendMail(msg, { recipient, subject, html, text });
}

module.exports = { sendButlerMail };
