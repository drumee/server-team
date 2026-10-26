/**
 * @license
 * Copyright 2026 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3
 */

// service/lib/send-mail.js
// THE way user-facing mail leaves this server. Everything that decides
// whether a mailbox provider files a message as spam, and that is ours to set,
// is set here once (plan: docs/superpowers/plans/2026-10-15-email-deliverability.md):
//
//   - ONE sender identity (mail-sender.js). Messenger.send() falls back to the
//     SMTP login (butler@drumee.com), so mail used to arrive from two domains
//     and split their reputation.
//   - A text/plain part on every message. HTML-only mail is a scored signal.
//   - Reply-To a monitored mailbox.
//   - RFC 8058 one-click unsubscribe on NOTIFICATION mail only. Security and
//     transactional mail must never offer it (see email-policy.js).
//   - One SMTP transaction per recipient, so one person's address is never
//     disclosed to another and one rejection does not sink the batch.
//
// Results keep Messenger.send()'s shapes — {recipient, error} or, with no MTA,
// the rendered HTML string — so mail-result.mailFailure() and every caller
// read them unchanged. test/mail-send-guard.test.js fails if anything else
// calls msg.send()/mta.sendMail().

const { convert } = require("html-to-text");
const { butlerFrom, MAIL_SENDER_ADDRESS } = require("./mail-sender");
const { unsubscribeUrl } = require("./unsubscribe-token");

const TRANSACTIONAL = "transactional";
const NOTIFICATION = "notification";

const TEXT_OPTIONS = {
  wordwrap: 78,
  selectors: [
    { selector: "img", format: "skip" },
    { selector: "h1", options: { uppercase: false } },
    { selector: "h2", options: { uppercase: false } },
    { selector: "h3", options: { uppercase: false } },
    { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
  ],
};

/** @param {string} html @returns {string} */
function textFromHtml(html) {
  return convert(String(html || ""), TEXT_OPTIONS)
    // Layout spacer cells (&nbsp;) leave lines of only spaces/NBSPs: empty
    // them, then keep at most one blank line between blocks.
    .split("\n")
    .map((line) => (/\S/.test(line.replace(/\u00a0/g, " ")) ? line.replace(/[ \u00a0]+$/, "") : ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function _recipients(value) {
  const list = (Array.isArray(value) ? value : [value])
    .map((r) => String(r == null ? "" : r).trim())
    .filter(Boolean);
  return [...new Set(list)];
}

/**
 * Nodemailer options for ONE recipient. Pure, so the rules are testable.
 * A missing subject sends as "" rather than throwing: refusing would turn a
 * missing lexicon key into a failed password-reset request.
 * @param {{to:string, subject:string, html?:string, text?:string,
 *          kind?:string, appBase?:string}} p
 * @returns {Object}
 */
function buildMailOptions({ to, subject, html, text, kind = TRANSACTIONAL, appBase } = {}) {
  if (!to || typeof to !== "string") throw new Error("send-mail: one recipient address required");
  if (!html && !text) throw new Error("send-mail: html or text required");
  if (kind !== TRANSACTIONAL && kind !== NOTIFICATION) {
    throw new Error(`send-mail: unknown kind ${JSON.stringify(kind)}`);
  }
  const opts = {
    from: butlerFrom(),
    replyTo: MAIL_SENDER_ADDRESS,
    to,
    subject: String(subject == null ? "" : subject),
    text: text || textFromHtml(html),
  };
  if (html) opts.html = html;
  if (kind === NOTIFICATION) {
    const url = unsubscribeUrl(to, appBase);
    if (url) {
      opts.headers = {
        "List-Unsubscribe": `<${url}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      };
    }
  }
  return opts;
}

/**
 * @param {Messenger} msg  configured Messenger; recipient/subject/template come from it
 * @param {{recipient?:string|string[], subject?:string, html?:string,
 *          text?:string, kind?:string}} [parts] overrides
 * @returns {Promise<{recipient:string[], error:string[]|null}|string>}
 */
async function sendMail(msg, parts = {}) {
  const html = parts.html || msg._html;
  const text = parts.text || msg._text;
  const subject = parts.subject || msg.get("subject");
  const kind = parts.kind || TRANSACTIONAL;
  const recipients = _recipients(parts.recipient || msg.get("recipient"));
  // No address at all (a null row.email, an empty batch) is a failure, not a
  // delivery: report it the way mail-result reads a rejection.
  if (!recipients.length) return { recipient: [], error: ["(no recipient)"] };
  // Validate once, before the first transaction: a malformed request must not
  // half-send.
  const prepared = recipients.map((to) => buildMailOptions({ to, subject, html, text, kind }));

  const mta = await msg.getMTA();
  if (!mta) return msg.send({ html });

  const error = [];
  for (const opts of prepared) {
    try {
      await mta.sendMail(opts);
    } catch (e) {
      error.push(opts.to);
      if (msg.warn) msg.warn(`send-mail: ${opts.to} rejected`, e && e.message);
    }
  }
  return { recipient: recipients, error: error.length ? error : null };
}

module.exports = {
  TRANSACTIONAL,
  NOTIFICATION,
  textFromHtml,
  buildMailOptions,
  sendMail,
};
