// service/lib/butler-mail.js
// Shared "butler" email sender: multipart/alternative (plain-text + HTML) with
// deliverability headers (display-name From). Extracted from the pattern in
// service/private/contact.js (_sendButlerMail) so non-contact senders (e.g. the
// Stripe webhook's payment receipt) reuse it instead of re-implementing;
// contact.js can migrate to this helper later.
const { readFileSync } = require('fs');
const { resolve } = require('path');
const { sysEnv } = require('@drumee/server-essentials');
const { mailbox } = require('./mail-sender');

let _butlerSender;
/**
 * The configured MTA auth user (the only From we can send as without SPF/DKIM
 * misalignment). null when no MTA credential is configured.
 * @returns {string|null}
 */
function butlerSender() {
  if (_butlerSender !== undefined) return _butlerSender;
  try {
    const f = resolve(sysEnv().credential_dir, 'email.json');
    _butlerSender = (JSON.parse(readFileSync(f, 'utf8')).auth || {}).user || null;
  } catch (e) {
    _butlerSender = null;
  }
  return _butlerSender;
}

/**
 * Send a butler email as multipart/alternative (text + html). Falls back to
 * Messenger.send() (HTML-only) when no MTA or no usable sender is configured,
 * preserving the NO_MTA handling.
 * @param {Messenger} msg - configured Messenger (subject, recipient, handler)
 * @param {{recipient:string, subject:string, html:string, text:string}} parts
 * @returns {Promise<{recipient:string, error:null|string[]}>}
 */
async function sendButlerMail(msg, { recipient, subject, html, text }) {
  const mta = await msg.getMTA();
  if (!mta) return msg.send({ html });
  const sender = butlerSender();
  if (!sender) return msg.send({ html });
  const mailOptions = {
    // Via mailbox() rather than a hand-rolled `"Drumee" <${sender}>`: `sender`
    // is credential-derived (email.json auth.user), so a value that already
    // carries angle brackets would nest them and ship a "Drumee>" display name.
    from: mailbox("Drumee", sender),
    to: recipient,
    subject,
    text,
    html,
  };
  await mta.sendMail(mailOptions);
  return { recipient, error: null };
}

module.exports = { butlerSender, sendButlerMail };
