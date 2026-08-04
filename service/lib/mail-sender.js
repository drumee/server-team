// service/lib/mail-sender.js
// The address user-facing Drumee mail is sent FROM, and the RFC 5322 mailbox
// built from it.
//
// Pinned here rather than read from credential/email.json — which is what the
// butlerSender() copy in each sending module used to do. That file holds the
// transport's SMTP *login*: an unmonitored `butler@<domain>` mailbox. Deriving
// the public From from it meant the two could never differ, so a reprovisioned
// credential silently rewrote who user-facing mail appeared to come from, and on
// a box whose email.json was written before the domain resolved it addressed
// mail from the literal `butler@undefined`. A constant can do neither.
//
// The login is unaffected: the transport still authenticates as whatever
// email.json says. Only the header changes.
//
// DEPLOYMENT REQUIREMENT, not satisfied by this file. drumee.org is not the
// domain the relay's DKIM key signs (d=drumee.com), and its SPF record
// ("v=spf1 a mx ~all") lists only Firebase hosting and Google's MX — not the
// relay. Its DMARC is published twice (p=none and p=quarantine), which per
// RFC 7489 makes receivers discard the set entirely. Until drumee.org publishes
// an SPF entry for the relay and its own DKIM selector, everything sent from
// this address is unauthenticated mail — and the templates on this path include
// 2FA codes and email verification, where landing in spam locks a user out of
// signing in.
const MAIL_SENDER_NAME = "Drumee";
const MAIL_SENDER_ADDRESS = "contact@drumee.org";

/**
 * Build an RFC 5322 mailbox, accepting EITHER a bare address or a mailbox that
 * already carries its own angle brackets.
 *
 * This exists because of a real bug. Every sending module in this repo used to
 * format its From by hand as `"Drumee" <${sender}>`, which is correct only if
 * `sender` is a bare address. Hand it a full mailbox and the brackets nest:
 *
 *   `"Drumee" <"Drumee" <contact@drumee.org>>`
 *      -> parsers report { name: "Drumee>", address: "contact@drumee.org" }
 *
 * The address still resolves, so the mail is delivered and nothing is logged —
 * the closing bracket is silently absorbed into the display name and every
 * recipient sees "Drumee>". Since butlerFrom() returns a full mailbox and
 * butlerSender() returns a bare address, the two shapes are one keystroke apart
 * at any call site, so the wrapping is centralised here where it can only
 * happen once.
 *
 * @param {String} name    display name; quotes are escaped, never passed raw
 * @param {String} address bare address, or a mailbox like `X <a@b>`
 * @returns {String} e.g. `"Drumee" <contact@drumee.org>`
 * @throws {Error} if no address can be recovered — a broken From is worse than
 *                 a loud failure, because it delivers and looks fine in logs
 */
function mailbox(name, address) {
  const raw = String(address == null ? "" : address).trim();
  // The innermost <...> pair is the address; a value with no pair is already
  // bare, and any loose bracket on it is stripped rather than re-emitted.
  const angled = raw.match(/<([^<>]*)>/);
  const addr = (angled ? angled[1] : raw.replace(/[<>]/g, "")).trim();
  if (!addr) {
    throw new Error(`mail-sender: cannot build a From, no address in ${JSON.stringify(address)}`);
  }
  // A bare quote in the phrase would terminate it early and turn the rest of
  // the header into stray tokens — the same class of break as the nested `>`.
  const phrase = String(name == null ? "" : name).replace(/[\\"]/g, "\\$&");
  return `"${phrase}" <${addr}>`;
}

/**
 * The From header for user-facing mail, display name included.
 *
 * The name is what an inbox actually shows; without it the mail arrives as a
 * bare address no recipient recognises.
 *
 * @returns {String} RFC 5322 mailbox, e.g. `"Drumee" <contact@drumee.org>`
 */
function butlerFrom() {
  return mailbox(MAIL_SENDER_NAME, MAIL_SENDER_ADDRESS);
}

module.exports = { MAIL_SENDER_NAME, MAIL_SENDER_ADDRESS, mailbox, butlerFrom };
