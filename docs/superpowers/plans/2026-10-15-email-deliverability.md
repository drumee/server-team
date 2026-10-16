# Email Deliverability (Keep Drumee Mail Out of Spam) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every email the server sends leaves through one helper that applies the deliverability rules mailbox providers grade on: one authenticated sender domain, a plain-text part, Reply-To, and RFC 8058 one-click unsubscribe on notification mail.

**Architecture:** A new `service/lib/send-mail.js` owns the outgoing message shape (From, Reply-To, text alternative, List-Unsubscribe headers, one SMTP transaction per recipient) and returns the same result shapes `Messenger.send()` does, so `service/lib/mail-result.js` and every caller keep working. A signed-link module (`unsubscribe-token.js`) plus a public `callback.unsubscribe` service turn the existing `email_notifications` account setting off. All 25 files that call `msg.send()` / `mta.sendMail()` today migrate to the helper, and a guard test keeps new code from bypassing it. DNS/relay authentication is verified first, because no code change rescues mail that fails SPF/DKIM/DMARC.

**Tech Stack:** Node 22, `node:test`, nodemailer 8 (via `@drumee/server-essentials` Messenger), `html-to-text` 8.2.1 (already a dependency), MariaDB stored procs `email_exists`, `get_entity_settings`, `entity_update_settings` (already exist).

**Spec:** No separate spec. Requirements come from the investigation recorded under "Findings" below (2026-10-15).

## Findings (the why behind each task)

| # | Finding | Evidence | Fixed by |
|---|---------|----------|----------|
| F1 | Mail goes out under TWO identities: `"Drumee" <contact@drumee.org>` (otp, yp, hub invites, activity, contact) and the bare SMTP login `butler@drumee.com` (every `msg.send()` with no `from`: password-forgot, signup, admin-invitation, sharebox, transfer, meeting, forms, …). Two domains split sender reputation and the `.com` one has no display name. | `grep -rn "msg.send(" service offline`; `Messenger.send` uses `FROM = email.json auth.user` | Task 2, Tasks 5–8 |
| F2 | About 30 of 35 send paths are HTML-only (no `text/plain` part) — a scored spam signal. Only `contact.js` and `butler-mail.js` send text. | same grep; `Messenger.send` deletes `html` when `text` is set and never builds one | Task 2 |
| F3 | No mail carries `List-Unsubscribe` / `List-Unsubscribe-Post`. Gmail and Yahoo require one-click unsubscribe on subscribed (non-transactional) mail. Our notification mail is opt-in (`settings.email_notifications`) and so qualifies. | `grep -rn List-Unsubscribe service` → comments only | Tasks 1, 3, 6, 7 |
| F4 | drumee.org DKIM is unproven for the relay. `mail._domainkey.drumee.org` exists but its key DIFFERS from `mail._domainkey.drumee.com`; the relay (mail.drumee.com, 135.125.104.154, logs in as `butler@drumee.com`) is only known to sign `d=drumee.com`. SPF for drumee.org does list `ip4:135.125.104.154`, so DMARC currently rests on SPF alone, which breaks on any forward. | `dig TXT mail._domainkey.drumee.{com,org}`; stage `/etc/drumee/credential/email.json` | Task 0, Task 9 |
| F5 | drumee.com DMARC has no `rua`, so nobody sees authentication failures. drumee.org DMARC is `p=none` (monitor only). | `dig TXT _dmarc.drumee.{com,org}` | Task 9 |
| F6 | Repo HTML templates are clean today: no `http://` links, all under 26KB (Gmail clips at ~102KB). Worth a regression guard, not a rewrite. | static scan of `service/**/templates/**/*.html` | Task 4 |

Out of scope (noted, separate work): `butler/outbound` template missing from the package; offline `media/transfer.js` `bb-templates` base_dir missing; `Messenger.getMTA()` never caches `transport` (new SMTP connection per send). These are about mail failing to send, not mail being filed as spam.

## Global Constraints

- Every user-facing mail is From `"Drumee" <contact@drumee.org>` (`MAIL_SENDER_ADDRESS` in `service/lib/mail-sender.js`) with Reply-To `contact@drumee.org`. If Task 0 proves drumee.org cannot be aligned, change that ONE constant — no call site names an address.
- No new npm dependencies. Use `html-to-text` (`const { convert } = require("html-to-text")`, v8.2.1).
- Do not edit anything under `node_modules/` (including `@drumee/server-essentials`).
- `NO_MTA` behaviour is preserved: when `msg.getMTA()` resolves `null`, return exactly what `msg.send({ html })` returns (the rendered HTML string). `service/private/role.js` shows that string to admins in dev, and `mail-result.js` reads it as `NO_MTA`.
- Security and transactional mail (OTP, password reset/change, email change, signup/welcome, invitations, receipts, dunning, contact-form, transfer OTP) NEVER carries `List-Unsubscribe` and is NEVER gated on `email_notifications`.
- `List-Unsubscribe` is added only to mail whose recipient is an ACCOUNT holder (the unsubscribe flips an account setting; a guest has no setting to flip).
- Tests are `test/<name>.test.js`, run with `node --test test/<name>.test.js`, style as in `test/mail-result.test.js` (`node:assert/strict`, `node:test`).
- Before editing an existing file, run `node --check <file>` after the edit; these service files have no unit harness.
- `test/invite-email-delivery.test.js` already fails 3/3 on `origin/preview` (stale: calls `_sendInviteEmail`, omits `accept_link`). Do not count it as a regression; do not fix it in this plan.

## Review Focus

1. **Mixed-case addresses.** A link minted for `John@Example.com` must verify when the provider posts it back, and must unsubscribe the account stored as `john@example.com`. → Task 1 test `sign/verify are case- and whitespace-insensitive`.
2. **Duplicate or blank recipients in an array** (hub invites pass arrays). One SMTP transaction per distinct address, blanks skipped, and only the rejected addresses reported. → Task 2 test `one transaction per distinct recipient; only rejects are reported`.
3. **A box with no `unsubscribe.json`** (new endpoint, fresh install). Notification mail must still send, just without the header — never throw. → Task 2 test `notification without a secret still sends, without the header`.
4. **Forged or mismatched signature.** A signature for a different address, a truncated one, or none at all changes nothing and says so. → Task 1 test `verify rejects a signature for another address or a tampered one`, Task 3 test `invalid signature changes nothing`.
5. **Other settings survive an unsubscribe.** `settings` holds unrelated keys (2FA, language). Turning notifications off must keep them, whether the row stores settings as a JSON string or an object. → Task 3 test `preserves every other setting (string or object storage)`.

---

## File Structure

| File | Responsibility |
|------|----------------|
| Create `service/lib/unsubscribe-token.js` | Sign/verify an address with an HMAC secret from `credential_dir/unsubscribe.json`; build the one-click URL. Pure apart from reading the secret once. |
| Create `service/lib/send-mail.js` | `buildMailOptions()` (pure: From, Reply-To, text part, unsubscribe headers) and `sendMail(msg, parts)` (per-recipient SMTP, Messenger-compatible results). The only module allowed to call `mta.sendMail` / `msg.send`. |
| Create `service/lib/unsubscribe.js` | `unsubscribeEmail(yp, email)` (turns `email_notifications` off, preserving other settings) and `unsubscribePage(state)` (the HTML answer). |
| Modify `service/lib/email-policy.js` | Export its existing `_parseSettings` as `parseSettings` so Task 3 reuses it. |
| Modify `service/callback.js`, `acl/callback.json` | Public `callback.unsubscribe` service. |
| Create `test/unsubscribe-token.test.js`, `test/send-mail.test.js`, `test/unsubscribe.test.js` | Unit tests. |
| Create `test/mail-send-guard.test.js` | Fails if any file outside the allowlist calls `msg.send(` / `msg.dispatch(` / `mta.sendMail(`; template hygiene guard. |
| Modify 25 sender files (Tasks 5–8) | Replace direct sends with `sendMail`. |

---

### Task 0: Baseline authentication measurement (manual, no code)

Decides whether `contact@drumee.org` can stay the sender (Global Constraints, first line). Run on **stage** (drumee.in), which relays through the same mail.drumee.com as production.

**Files:** none.

- [ ] **Step 1: Get a test inbox.** Open https://www.mail-tester.com and copy the one-time address it shows (e.g. `test-abc123@srv1.mail-tester.com`).

- [ ] **Step 2: Send one mail that uses `contact@drumee.org`.** In a browser on https://drumee.in, use "Forgot password" for an account whose email you control and that forwards to, or IS, a Gmail address. Separately, trigger an OTP mail (account deletion's code step) to the same account. Then, for mail-tester: create a throwaway stage account with the mail-tester address and request "Forgot password" for it.

- [ ] **Step 3: Record results.** On mail-tester, record the score and the "authenticated" section. In Gmail, open the message → ⋮ → "Show original" and record the `SPF`, `DKIM` and `DMARC` lines, plus the `Authentication-Results:` header, especially `dkim=… header.d=…`.

- [ ] **Step 4: Apply the decision rule.**
  - `dkim=pass header.d=drumee.org` AND `dmarc=pass`: keep `contact@drumee.org`. Proceed.
  - `dkim=pass header.d=drumee.com` only (drumee.org passes DMARC via SPF alone): proceed with the code, and add Task 9 Step 2 (relay signs drumee.org) as a release blocker.
  - `spf=fail` or `dmarc=fail`: STOP. Do not ship code that moves more mail onto drumee.org. Either fix DNS first (Task 9 Steps 2–3) or change `MAIL_SENDER_ADDRESS` to `contact@drumee.com` in Task 2 Step 3 (drumee.com is signed by the relay and covered by `v=spf1 mx a`, MX = mail.drumee.com).

- [ ] **Step 5: Write the result** (score, three verdicts, chosen sender) at the top of this plan under "Findings" as a new row F0, so later tasks inherit it.

---

### Task 1: Signed unsubscribe token

**Files:**
- Create: `service/lib/unsubscribe-token.js`
- Test: `test/unsubscribe-token.test.js`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `sign(email: string): string|null`: base64url HMAC, or `null` when there is no secret or the address is empty.
  - `verify(email: string, sig: string): boolean`
  - `unsubscribeUrl(email: string, base?: string): string|null`: `${base}/svc/?service=callback.unsubscribe&email=<lowercased, encoded>&sig=<sig>`. `base` defaults to `appBase()`.
  - `appBase(): string`: `https://<main_domain><endpoint_path || "/-">`
  - `_setSecretForTest(secret: string|undefined): void`

- [ ] **Step 1: Write the failing test** at `test/unsubscribe-token.test.js`:

```js
const assert = require('node:assert/strict');
const test = require('node:test');

const token = require('../service/lib/unsubscribe-token');

const SECRET = 'x'.repeat(48);
const BASE = 'https://drumee.test/-';

test.beforeEach(() => token._setSecretForTest(SECRET));
test.after(() => token._setSecretForTest(undefined));

test('a signature verifies for the address it was minted for', () => {
  const sig = token.sign('ann@example.com');
  assert.equal(typeof sig, 'string');
  assert.ok(sig.length >= 40);
  assert.equal(token.verify('ann@example.com', sig), true);
});

test('sign/verify are case- and whitespace-insensitive', () => {
  const sig = token.sign('John@Example.com');
  assert.equal(sig, token.sign('  john@example.com '));
  assert.equal(token.verify('JOHN@EXAMPLE.COM', sig), true);
});

test('verify rejects a signature for another address or a tampered one', () => {
  const sig = token.sign('ann@example.com');
  assert.equal(token.verify('bob@example.com', sig), false);
  assert.equal(token.verify('ann@example.com', sig.slice(0, -2)), false);
  assert.equal(token.verify('ann@example.com', sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A')), false);
  assert.equal(token.verify('ann@example.com', ''), false);
  assert.equal(token.verify('ann@example.com', undefined), false);
});

test('no secret: nothing is signed and nothing verifies', () => {
  token._setSecretForTest(null);
  assert.equal(token.sign('ann@example.com'), null);
  assert.equal(token.verify('ann@example.com', 'anything'), false);
  assert.equal(token.unsubscribeUrl('ann@example.com', BASE), null);
});

test('the URL targets callback.unsubscribe with the lowercased address', () => {
  const url = token.unsubscribeUrl('Ann+tag@Example.com', BASE);
  const u = new URL(url);
  assert.equal(`${u.origin}${u.pathname}`, 'https://drumee.test/-/svc/');
  assert.equal(u.searchParams.get('service'), 'callback.unsubscribe');
  assert.equal(u.searchParams.get('email'), 'ann+tag@example.com');
  assert.equal(token.verify('ann+tag@example.com', u.searchParams.get('sig')), true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/unsubscribe-token.test.js`
Expected: FAIL with `Cannot find module '../service/lib/unsubscribe-token'`.

- [ ] **Step 3: Implement** `service/lib/unsubscribe-token.js`:

```js
/**
 * @license
 * Copyright 2026 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3
 */

// service/lib/unsubscribe-token.js
// Signs the one-click unsubscribe link carried in the List-Unsubscribe header
// of notification mail (service/lib/send-mail.js) and verifies it when the
// mailbox provider posts it back (callback.unsubscribe).
//
// THE SIGNATURE IS THE AUTHORISATION. The endpoint has no session — Gmail
// posts to it on the user's behalf — so anything unsigned must change nothing.
// The secret lives in credential_dir/unsubscribe.json ({"secret": "<>=32
// chars>"}), created at deploy (plan Task 9). Without it nothing is signed and
// notification mail goes out WITHOUT the header rather than with a link that
// cannot work.
//
// The address is case-folded before signing: providers echo the URL verbatim,
// but the same person can be mailed as John@ and john@ from different paths.

const crypto = require("crypto");
const { readFileSync } = require("fs");
const { resolve } = require("path");

let _secret;

function _loadSecret() {
  if (_secret !== undefined) return _secret;
  _secret = null;
  try {
    // Lazy: server-essentials reads its environment at require time.
    const { sysEnv } = require("@drumee/server-essentials");
    const file = resolve(sysEnv().credential_dir, "unsubscribe.json");
    const secret = JSON.parse(readFileSync(file, "utf8")).secret;
    if (typeof secret === "string" && secret.length >= 32) _secret = secret;
  } catch (e) {
    _secret = null;
  }
  return _secret;
}

/** Test seam: a string sets the secret, null forces "none", undefined reloads. */
function _setSecretForTest(secret) {
  _secret = secret;
}

function _norm(email) {
  return String(email == null ? "" : email).trim().toLowerCase();
}

/**
 * @param {string} email
 * @returns {string|null} base64url HMAC-SHA256, null without a secret/address
 */
function sign(email) {
  const secret = _loadSecret();
  const addr = _norm(email);
  if (!secret || !addr) return null;
  return crypto
    .createHmac("sha256", secret)
    .update(`unsubscribe:${addr}`)
    .digest("base64url");
}

/**
 * @param {string} email
 * @param {string} sig
 * @returns {boolean}
 */
function verify(email, sig) {
  const want = sign(email);
  if (!want || typeof sig !== "string" || !sig) return false;
  const a = Buffer.from(want);
  const b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Same base the invite links use (hub.js _endpointBase). */
function appBase() {
  const { sysEnv } = require("@drumee/server-essentials");
  const { main_domain, endpoint_path } = sysEnv();
  return `https://${main_domain}${endpoint_path || "/-"}`;
}

/**
 * @param {string} email
 * @param {string} [base] e.g. "https://drumee.com/-"
 * @returns {string|null}
 */
function unsubscribeUrl(email, base) {
  const sig = sign(email);
  if (!sig) return null;
  const root = base || appBase();
  return `${root}/svc/?service=callback.unsubscribe`
    + `&email=${encodeURIComponent(_norm(email))}&sig=${sig}`;
}

module.exports = { sign, verify, unsubscribeUrl, appBase, _setSecretForTest };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/unsubscribe-token.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add service/lib/unsubscribe-token.js test/unsubscribe-token.test.js
git commit -m "feat(mail): signed one-click unsubscribe token"
```

---

### Task 2: The single send path (`send-mail.js`)

**Files:**
- Create: `service/lib/send-mail.js`
- Test: `test/send-mail.test.js`

**Interfaces:**
- Consumes: `unsubscribeUrl(email, base)` and `_setSecretForTest` from Task 1; `butlerFrom()` and `MAIL_SENDER_ADDRESS` from `service/lib/mail-sender.js` (existing).
- Produces:
  - `TRANSACTIONAL = "transactional"`, `NOTIFICATION = "notification"`
  - `textFromHtml(html: string): string`
  - `buildMailOptions({ to, subject, html?, text?, kind?, appBase? }): object` (nodemailer options for ONE recipient)
  - `sendMail(msg: Messenger, parts?: { recipient?, subject?, html?, text?, kind? }): Promise<{recipient: string[], error: string[]|null} | string>`. `recipient`, `subject`, `html` and `text` default to `msg.get("recipient")`, `msg.get("subject")`, `msg._html` and `msg._text`. Returns `msg.send({html})`'s value when there is no MTA.

- [ ] **Step 1: Write the failing test** at `test/send-mail.test.js`:

```js
const assert = require('node:assert/strict');
const test = require('node:test');

const token = require('../service/lib/unsubscribe-token');
const {
  TRANSACTIONAL, NOTIFICATION, buildMailOptions, sendMail, textFromHtml,
} = require('../service/lib/send-mail');

const BASE = 'https://drumee.test/-';
const HTML = '<h1>Welcome</h1><p>Hello <a href="https://drumee.test/-/#/desk">Open Drumee</a></p>';

// A Messenger stand-in: the fields send-mail reads, an MTA that records or
// rejects, and Messenger.send()'s NO_MTA answer (the rendered HTML string).
function fakeMsg({ noMta = false, reject = [], recipient = 'ann@example.com', subject = 'Hi' } = {}) {
  const sent = [];
  return {
    sent,
    _html: HTML,
    _text: undefined,
    get: (k) => ({ recipient, subject })[k],
    getMTA: async () => (noMta ? null : {
      sendMail: async (opts) => {
        if (reject.includes(opts.to)) throw new Error('550 rejected');
        sent.push(opts);
      },
    }),
    send: async () => '<html>rendered</html>',
    warn: () => {},
  };
}

test.beforeEach(() => token._setSecretForTest('s'.repeat(40)));
test.after(() => token._setSecretForTest(undefined));

test('text part is generated from the HTML, headings not shouted', () => {
  const text = textFromHtml(HTML);
  assert.match(text, /Welcome/);
  assert.doesNotMatch(text, /WELCOME/);
  assert.match(text, /Open Drumee/);
  assert.match(text, /https:\/\/drumee\.test\/-\/#\/desk/);
});

test('every mail: one brand From, Reply-To, a text part', () => {
  const o = buildMailOptions({ to: 'ann@example.com', subject: 'Hi', html: HTML });
  assert.equal(o.from, '"Drumee" <contact@drumee.org>');
  assert.equal(o.replyTo, 'contact@drumee.org');
  assert.equal(o.to, 'ann@example.com');
  assert.equal(o.html, HTML);
  assert.ok(o.text.length > 10);
});

test('an explicit text part is kept as given', () => {
  const o = buildMailOptions({ to: 'a@b.c', subject: 'Hi', html: HTML, text: 'Plain.' });
  assert.equal(o.text, 'Plain.');
});

test('transactional mail never carries List-Unsubscribe', () => {
  const o = buildMailOptions({ to: 'a@b.c', subject: 'Code', html: HTML, kind: TRANSACTIONAL, appBase: BASE });
  assert.equal(o.headers, undefined);
});

test('notification mail carries RFC 8058 one-click headers', () => {
  const o = buildMailOptions({ to: 'Ann@Example.com', subject: 'Activity', html: HTML, kind: NOTIFICATION, appBase: BASE });
  assert.equal(o.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  const m = o.headers['List-Unsubscribe'].match(/^<(https:\/\/[^>]+)>$/);
  assert.ok(m, o.headers['List-Unsubscribe']);
  const u = new URL(m[1]);
  assert.equal(u.searchParams.get('service'), 'callback.unsubscribe');
  assert.equal(token.verify('ann@example.com', u.searchParams.get('sig')), true);
});

test('notification without a secret still sends, without the header', async () => {
  token._setSecretForTest(null);
  const o = buildMailOptions({ to: 'a@b.c', subject: 'Activity', html: HTML, kind: NOTIFICATION, appBase: BASE });
  assert.equal(o.headers, undefined);
});

test('missing subject or body, or an unknown kind, throws', () => {
  assert.throws(() => buildMailOptions({ to: 'a@b.c', html: HTML }), /subject/);
  assert.throws(() => buildMailOptions({ to: 'a@b.c', subject: 'x' }), /html or text/);
  assert.throws(() => buildMailOptions({ to: 'a@b.c', subject: 'x', html: HTML, kind: 'promo' }), /kind/);
});

test('sendMail reads recipient, subject and rendered template off the Messenger', async () => {
  const msg = fakeMsg();
  const res = await sendMail(msg);
  assert.deepEqual(res, { recipient: ['ann@example.com'], error: null });
  assert.equal(msg.sent.length, 1);
  assert.equal(msg.sent[0].subject, 'Hi');
  assert.equal(msg.sent[0].html, HTML);
});

test('one transaction per distinct recipient; only rejects are reported', async () => {
  const msg = fakeMsg({
    recipient: ['ann@example.com', ' ', 'bob@example.com', 'ann@example.com'],
    reject: ['bob@example.com'],
  });
  const res = await sendMail(msg);
  assert.deepEqual(msg.sent.map((o) => o.to), ['ann@example.com']);
  assert.deepEqual(res, { recipient: ['ann@example.com', 'bob@example.com'], error: ['bob@example.com'] });
});

test('no MTA: returns what Messenger.send returns (NO_MTA string)', async () => {
  const res = await sendMail(fakeMsg({ noMta: true }));
  assert.equal(res, '<html>rendered</html>');
});

test('a bad request throws before anything is sent', async () => {
  const msg = fakeMsg({ subject: '' });
  await assert.rejects(sendMail(msg), /subject/);
  assert.equal(msg.sent.length, 0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/send-mail.test.js`
Expected: FAIL with `Cannot find module '../service/lib/send-mail'`.

- [ ] **Step 3: Implement** `service/lib/send-mail.js`:

```js
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
//     transactional mail must never offer it (mail-sender/email-policy rules).
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
  return convert(String(html || ""), TEXT_OPTIONS).trim();
}

function _recipients(value) {
  const list = (Array.isArray(value) ? value : [value])
    .map((r) => String(r == null ? "" : r).trim())
    .filter(Boolean);
  return [...new Set(list)];
}

/**
 * Nodemailer options for ONE recipient. Pure, so the rules are testable.
 * @param {{to:string, subject:string, html?:string, text?:string,
 *          kind?:string, appBase?:string}} p
 * @returns {Object}
 */
function buildMailOptions({ to, subject, html, text, kind = TRANSACTIONAL, appBase } = {}) {
  if (!to || typeof to !== "string") throw new Error("send-mail: one recipient address required");
  if (!subject) throw new Error("send-mail: subject required");
  if (!html && !text) throw new Error("send-mail: html or text required");
  if (kind !== TRANSACTIONAL && kind !== NOTIFICATION) {
    throw new Error(`send-mail: unknown kind ${JSON.stringify(kind)}`);
  }
  const opts = {
    from: butlerFrom(),
    replyTo: MAIL_SENDER_ADDRESS,
    to,
    subject: String(subject),
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
```

If Task 0 chose `contact@drumee.com`, also change `MAIL_SENDER_ADDRESS` in `service/lib/mail-sender.js` and the two expected strings in the "every mail" test.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/send-mail.test.js test/unsubscribe-token.test.js test/mail-result.test.js`
Expected: PASS, all tests. If `text part is generated…` fails on the URL assertion, print `textFromHtml(HTML)` and adjust only `TEXT_OPTIONS`, not the test.

- [ ] **Step 5: Commit**

```bash
git add service/lib/send-mail.js test/send-mail.test.js
git commit -m "feat(mail): single send path with text part, Reply-To and one-click unsubscribe"
```

---

### Task 3: `callback.unsubscribe` endpoint

**Files:**
- Create: `service/lib/unsubscribe.js`
- Modify: `service/lib/email-policy.js` (export `parseSettings`)
- Modify: `service/callback.js` (add `unsubscribe()` before `portal_return()`)
- Modify: `acl/callback.json` (add the `unsubscribe` service before `portal_return`)
- Test: `test/unsubscribe.test.js`

**Interfaces:**
- Consumes: `verify(email, sig)` from Task 1.
- Produces:
  - `unsubscribeEmail(yp, email): Promise<{changed: boolean, reason?: "no_account"|"already_off"}>`
  - `unsubscribePage(state: "done"|"invalid"|"error"): string`
  - Service `callback.unsubscribe` with params `email`, `sig`, GET or POST, no session.

- [ ] **Step 1: Write the failing test** at `test/unsubscribe.test.js`:

```js
const assert = require('node:assert/strict');
const test = require('node:test');

const { unsubscribeEmail, unsubscribePage } = require('../service/lib/unsubscribe');

// Records proc calls; answers email_exists / get_entity_settings from `db`.
function fakeYp(db) {
  const calls = [];
  return {
    calls,
    await_proc: async (name, ...args) => {
      calls.push([name, ...args]);
      if (name === 'email_exists') return db.account ? { id: db.account } : {};
      if (name === 'get_entity_settings') return { settings: db.settings };
      if (name === 'entity_update_settings') return {};
      throw new Error(`unexpected proc ${name}`);
    },
  };
}

test('turns email_notifications off for the account', async () => {
  const yp = fakeYp({ account: 'u1', settings: { email_notifications: 1 } });
  assert.deepEqual(await unsubscribeEmail(yp, 'ann@example.com'), { changed: true });
  const upd = yp.calls.find((c) => c[0] === 'entity_update_settings');
  assert.equal(upd[1], 'u1');
  assert.equal(JSON.parse(upd[2]).email_notifications, 0);
});

test('preserves every other setting (string or object storage)', async () => {
  for (const settings of [
    { email_notifications: '1', mfa: 1, lang: 'fr' },
    JSON.stringify({ email_notifications: 1, mfa: 1, lang: 'fr' }),
  ]) {
    const yp = fakeYp({ account: 'u1', settings });
    await unsubscribeEmail(yp, 'ann@example.com');
    const upd = yp.calls.find((c) => c[0] === 'entity_update_settings');
    assert.deepEqual(JSON.parse(upd[2]), { email_notifications: 0, mfa: 1, lang: 'fr' });
  }
});

test('already off: nothing is written', async () => {
  const yp = fakeYp({ account: 'u1', settings: { email_notifications: 0 } });
  assert.deepEqual(await unsubscribeEmail(yp, 'ann@example.com'), { changed: false, reason: 'already_off' });
  assert.ok(!yp.calls.some((c) => c[0] === 'entity_update_settings'));
});

test('no account: nothing is written', async () => {
  const yp = fakeYp({ account: null });
  assert.deepEqual(await unsubscribeEmail(yp, 'guest@example.com'), { changed: false, reason: 'no_account' });
  assert.equal(yp.calls.length, 1);
});

test('pages are complete HTML and say what happened', () => {
  assert.match(unsubscribePage('done'), /<html[\s\S]*no longer receive/i);
  assert.match(unsubscribePage('invalid'), /not valid/i);
  assert.match(unsubscribePage('error'), /try again/i);
  assert.match(unsubscribePage('anything-else'), /not valid/i);
});

test('invalid signature changes nothing', async () => {
  const token = require('../service/lib/unsubscribe-token');
  token._setSecretForTest('k'.repeat(40));
  try {
    assert.equal(token.verify('ann@example.com', token.sign('bob@example.com')), false);
  } finally {
    token._setSecretForTest(undefined);
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/unsubscribe.test.js`
Expected: FAIL with `Cannot find module '../service/lib/unsubscribe'`.

- [ ] **Step 3: Export `parseSettings`.** In `service/lib/email-policy.js`, replace the last line

```js
module.exports = { shouldSendNotification };
```

with

```js
module.exports = { shouldSendNotification, parseSettings: _parseSettings };
```

- [ ] **Step 4: Implement** `service/lib/unsubscribe.js`:

```js
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
  invalid: "This unsubscribe link is not valid.",
  error: "Something went wrong. Please try again later.",
};

/** @param {string} state "done" | "invalid" | "error" @returns {string} */
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
```

- [ ] **Step 5: Run the unit tests**

Run: `node --test test/unsubscribe.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 6: Add the service.** In `service/callback.js`, add after the `require('@drumee/server-core')` line:

```js
const { verify } = require('./lib/unsubscribe-token');
const { unsubscribeEmail, unsubscribePage } = require('./lib/unsubscribe');
```

and insert this method immediately above `async portal_return() {`:

```js
  // One-click unsubscribe (RFC 8058): the List-Unsubscribe target that
  // service/lib/send-mail.js puts on NOTIFICATION mail. Gmail/Yahoo POST
  // "List-Unsubscribe=One-Click" here; other clients open it as a GET after
  // the user presses their Unsubscribe button. Both act — the URL only ever
  // appears in a header, which link scanners do not prefetch.
  //
  // `sig` is the authorisation (lib/unsubscribe-token): no session, and an
  // unsigned or mismatched request changes nothing.
  async unsubscribe() {
    const email = String(this.input.use('email', '')).trim().toLowerCase();
    const sig = String(this.input.use('sig', ''));
    if (!email || !verify(email, sig)) {
      return this.output.html(unsubscribePage('invalid'));
    }
    try {
      await unsubscribeEmail(this.yp, email);
    } catch (e) {
      this.warn('[callback] unsubscribe failed', e && e.message);
      return this.output.html(unsubscribePage('error'));
    }
    this.output.html(unsubscribePage('done'));
  }

```

- [ ] **Step 7: Register it in the ACL.** In `acl/callback.json`, insert before the `"portal_return": {` entry (same indentation as `"open"`):

```json
    "unsubscribe": {
      "doc": "One-click unsubscribe (RFC 8058): the List-Unsubscribe target on notification mail (service/lib/send-mail.js). Turns the account's settings.email_notifications off; transactional mail is unaffected. Authorised by `sig`, an HMAC of the address (service/lib/unsubscribe-token.js) — no session.",
      "scope": "hub",
      "permission": {
        "src": "read",
        "fast_check": "public-api"
      },
      "params": {
        "email": { "type": "string", "required": true, "doc": "Address the link was minted for" },
        "sig": { "type": "string", "required": true, "doc": "base64url HMAC-SHA256 of the lowercased address" }
      }
    },
```

- [ ] **Step 8: Check syntax and JSON**

Run: `node --check service/callback.js && node -e "JSON.parse(require('fs').readFileSync('acl/callback.json','utf8')); console.log('acl ok')"`
Expected: `acl ok`, no syntax errors.

- [ ] **Step 9: Commit**

```bash
git add service/lib/unsubscribe.js service/lib/email-policy.js service/callback.js acl/callback.json test/unsubscribe.test.js
git commit -m "feat(mail): callback.unsubscribe one-click endpoint"
```

---

### Task 4: Guard tests (no bypass, template hygiene)

**Files:**
- Create: `test/mail-send-guard.test.js`

**Interfaces:**
- Consumes: the existence of `service/lib/send-mail.js` (Task 2).
- Produces: `PENDING`, a list of files still allowed to send directly. Tasks 5–8 each delete their entries, and Task 8 ends with only `service/devel.js` left.

- [ ] **Step 1: Write the test** at `test/mail-send-guard.test.js`:

```js
const assert = require('node:assert/strict');
const test = require('node:test');
const { readdirSync, readFileSync, statSync } = require('node:fs');
const { join, relative } = require('node:path');

const ROOT = join(__dirname, '..');
const DIRECT_SEND = /\bmsg\.(send|dispatch)\(|\bmta\.sendMail\(/;

// The one sanctioned sender, and the developer-only test mailer.
const ALLOWED = new Set(['service/lib/send-mail.js', 'service/devel.js']);

// Files not migrated yet. Each migration task DELETES its lines; when the plan
// is done only ALLOWED remains. Never add to this list.
const PENDING = new Set([
  // Task 5 — auth & account
  'service/otp.js',
  'service/lobby.js',
  'service/butler.js',
  'service/signup.js',
  'service/yp.js',
  'service/dmz.js',
  'service/private/drumate.js',
  'service/private/role.js',
  // Task 6 — invites, contacts, billing, forms
  'service/private/hub.js',
  'service/private/contact.js',
  'service/lib/butler-mail.js',
  'service/form.js',
  // Task 7 — notifications & sharing (service/)
  'service/lib/activity-mailer.js',
  'service/private/sharebox.js',
  'service/private/secure_share.js',
  'service/transfer.js',
  // Task 8 — offline workers
  'offline/drumate/backup.js',
  'offline/mail/index.js',
  'offline/notification/sharebox-notification.js',
  'offline/notification/sendmail.js',
  'offline/notification/meeting-notification.js',
  'offline/subscription/downgrade.js',
  'offline/media/transfer.js',
  'offline/workers/rewardExpiryWorker.js',
]);

function jsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...jsFiles(p));
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('all mail leaves through service/lib/send-mail.js', () => {
  const offenders = [];
  for (const file of [...jsFiles(join(ROOT, 'service')), ...jsFiles(join(ROOT, 'offline'))]) {
    const rel = relative(ROOT, file);
    if (ALLOWED.has(rel) || PENDING.has(rel)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (DIRECT_SEND.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `send through sendMail() instead:\n${offenders.join('\n')}`);
});

test('PENDING only lists files that still send directly', () => {
  const stale = [...PENDING].filter((rel) => !DIRECT_SEND.test(readFileSync(join(ROOT, rel), 'utf8')));
  assert.deepEqual(stale, [], `migrated — delete from PENDING:\n${stale.join('\n')}`);
});

test('mail templates: https links only, small enough not to be clipped', () => {
  const dirs = ['service/templates', 'service/private/templates'];
  const problems = [];
  for (const d of dirs) {
    for (const file of jsFilesOf(join(ROOT, d), '.html')) {
      const src = readFileSync(file, 'utf8');
      const rel = relative(ROOT, file);
      if (/href="http:\/\//i.test(src)) problems.push(`${rel}: http:// link`);
      if (/src="http:\/\//i.test(src)) problems.push(`${rel}: http:// image`);
      // Gmail clips at ~102KB of rendered HTML; keep the source well under.
      if (Buffer.byteLength(src) > 80 * 1024) problems.push(`${rel}: ${Buffer.byteLength(src)} bytes`);
    }
  }
  assert.deepEqual(problems, []);
});

function jsFilesOf(dir, ext) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...jsFilesOf(p, ext));
    else if (name.endsWith(ext)) out.push(p);
  }
  return out;
}
```

- [ ] **Step 2: Run it**

Run: `node --test test/mail-send-guard.test.js`
Expected: PASS, 3 tests. If test 1 names a file, it is a sender the investigation missed: add it to the matching task's group in `PENDING` (this is the ONE time adding is allowed) and to that task's file list.

- [ ] **Step 3: Prove the guard bites.** Temporarily delete `'service/form.js',` from `PENDING`, run the test, and confirm it FAILS naming `service/form.js:139` and `:162`. Restore the line.

- [ ] **Step 4: Commit**

```bash
git add test/mail-send-guard.test.js
git commit -m "test(mail): guard that all mail goes through send-mail, template hygiene"
```

---

### Task 5: Migrate auth & account senders

All transactional. **Rule for every site:** add the require at the top of the file (below the existing `require` lines), then replace the send line exactly as shown.

Require path by location:
- `service/<file>.js` → `const { sendMail } = require("./lib/send-mail");`
- `service/private/<file>.js` → `const { sendMail } = require("../lib/send-mail");`

**Files:**
- Modify: `service/otp.js`, `service/lobby.js`, `service/butler.js`, `service/signup.js`, `service/yp.js`, `service/dmz.js`, `service/private/drumate.js`, `service/private/role.js`
- Modify: `test/mail-send-guard.test.js` (delete the 8 "Task 5" lines from `PENDING`)

**Interfaces:**
- Consumes: `sendMail(msg, parts)` from Task 2.
- Produces: nothing new.

- [ ] **Step 1: Shrink the allowlist first (red).** Delete the eight `// Task 5` entries and their comment from `PENDING` in `test/mail-send-guard.test.js`. Run `node --test test/mail-send-guard.test.js`. Expected: FAIL listing the eight files.

- [ ] **Step 2: `service/otp.js`.**
  - Add `const { sendMail } = require("./lib/send-mail");`.
  - Line ~119: `const payload = { html, from: butlerFrom() };` → `const payload = { html };`
  - Line ~131: `Promise.resolve(msg.send(payload))` → `Promise.resolve(sendMail(msg, payload))`
  - Lines ~192–199: delete the 3-line comment above `const sender = butlerSender();`, delete `const sender = butlerSender();` and `const from = sender ? mailbox("Drumee", sender) : undefined;`, and replace `const result = await msg.send(from ? { html, from } : { html });` with `const result = await sendMail(msg, { html });`
  - Delete the now-unused `butlerSender()` function and its `_butlerSender` variable (the block that starts `let _butlerSender;` around line 32), including its doc comment.
  - Change `const { butlerFrom, mailbox } = require("./lib/mail-sender");` to remove the import entirely if `grep -n "butlerFrom\|mailbox" service/otp.js` shows no other uses.

- [ ] **Step 3: Single-line sites.** Replace each line exactly, then add the require:

| File | Line (approx.) | Old | New |
|------|------|-----|-----|
| `service/lobby.js` | 155 | `await msg.send();` | `await sendMail(msg);` |
| `service/butler.js` | 216 | `await msg.send();` | `await sendMail(msg);` |
| `service/butler.js` | 686 | `await msg.send({ html });` | `await sendMail(msg, { html });` |
| `service/signup.js` | 145 | `await msg.send({ html });` | `await sendMail(msg, { html });` |
| `service/yp.js` | 379 | `await msg.send({ html, from: butlerFrom() });` | `await sendMail(msg, { html });` |
| `service/dmz.js` | 230 | `await msg.send();` | `await sendMail(msg);` |
| `service/private/drumate.js` | 354 | `await msg.send();` | `await sendMail(msg);` |
| `service/private/drumate.js` | 979 | `await msg.send();` | `await sendMail(msg);` |
| `service/private/role.js` | 655, 703, 741 | `let body = await msg.send();` | `let body = await sendMail(msg);` |

In `service/yp.js`, remove `butlerFrom` from its `require("./lib/mail-sender")` import if `grep -n butlerFrom service/yp.js` shows no other use.

`role.js` keeps working because `sendMail` returns the same string `msg.send()` did when there is no MTA (`_.isString(body)` branch).

- [ ] **Step 4: Syntax-check every touched file**

Run: `for f in service/otp.js service/lobby.js service/butler.js service/signup.js service/yp.js service/dmz.js service/private/drumate.js service/private/role.js; do node --check $f || echo "FAIL $f"; done`
Expected: no output.

- [ ] **Step 5: Run the guard and unit tests (green)**

Run: `node --test test/mail-send-guard.test.js test/send-mail.test.js test/mail-result.test.js test/password-policy.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add service/otp.js service/lobby.js service/butler.js service/signup.js service/yp.js service/dmz.js service/private/drumate.js service/private/role.js test/mail-send-guard.test.js
git commit -m "refactor(mail): auth and account mail through send-mail"
```

---

### Task 6: Migrate invites, contacts, billing, forms

**Files:**
- Modify: `service/private/hub.js` (`_sendInviteEmails`, ~2577–2600)
- Modify: `service/private/contact.js` (`_sendButlerMail`, ~489–521; callers at ~555 and ~606)
- Modify: `service/lib/butler-mail.js` (`sendButlerMail`)
- Modify: `service/form.js` (~139, ~162)
- Modify: `test/mail-send-guard.test.js` (delete the 4 "Task 6" lines from `PENDING`)

**Interfaces:**
- Consumes: `sendMail`, `NOTIFICATION` from Task 2.
- Produces: `contact._sendButlerMail(msg, parts, kind?)` gains an optional third argument, default transactional.

- [ ] **Step 1: Red.** Delete the four `// Task 6` entries from `PENDING`; run `node --test test/mail-send-guard.test.js`; expect FAIL naming the four files.

- [ ] **Step 2: `service/private/hub.js`.** Add `const { sendMail } = require("../lib/send-mail");`. In `_sendInviteEmails`, replace

```js
    const html = msg.renderFrom(tplPath, data);
    // Display-name From ("Drumee" <contact@drumee.org>) so the inbox shows
    // "Drumee", matching the contact-add emails.
    const from = butlerFrom();
    const result = await msg.send({ html, from });
```

with

```js
    const html = msg.renderFrom(tplPath, data);
    const result = await sendMail(msg, { html });
```

The `perRecipient` / `rejected` logic below is unchanged; `sendMail` returns the same `{recipient, error: string[]|null}` shape. If `grep -n butlerFrom service/private/hub.js` shows no other use, remove it from the `mail-sender` import.

- [ ] **Step 3: `service/private/contact.js`.** Add `const { sendMail, NOTIFICATION } = require("../lib/send-mail");`. Replace the whole `_sendButlerMail` method body (keep its doc comment, updating the first line to say it delegates to `lib/send-mail.js`) with:

```js
  async _sendButlerMail(msg, { recipient, subject, html, text }, kind) {
    try {
      return await sendMail(msg, { recipient, subject, html, text, kind });
    } catch (e) {
      if (this.exception && this.exception.email) this.exception.email(e);
      return { recipient, error: [recipient] };
    }
  }
```

At the `send_drumate_mail` call site (~606, the account holder who opted in, gated by `shouldSendNotification` at ~578), change

```js
    return this._sendButlerMail(msg, { recipient: email, subject, html, text });
```

to

```js
    return this._sendButlerMail(msg, { recipient: email, subject, html, text }, NOTIFICATION);
```

Leave the `send_mail` call site (~555, a non-account invitee) transactional. If `butlerFrom` is no longer used in the file, remove it from its import.

- [ ] **Step 4: `service/lib/butler-mail.js`.** Replace the file body from `let _butlerSender;` to the end with:

```js
const { sendMail } = require('./send-mail');

/**
 * Kept for its callers (service/public/stripe_webhook.js). Delegates to
 * lib/send-mail.js, which sets the From, Reply-To and text part for all mail.
 * @param {Messenger} msg
 * @param {{recipient:string, subject:string, html:string, text:string}} parts
 * @returns {Promise<{recipient:string[], error:null|string[]}|string>}
 */
async function sendButlerMail(msg, { recipient, subject, html, text }) {
  return sendMail(msg, { recipient, subject, html, text });
}

module.exports = { sendButlerMail };
```

and delete the now-unused `readFileSync`, `resolve`, `sysEnv` and `mailbox` requires at the top. First confirm nothing imports `butlerSender` from it: `grep -rn "butler-mail" service offline | grep butlerSender`. If something does, keep `butlerSender` and its helpers.

- [ ] **Step 5: `service/form.js`.** Add `const { sendMail } = require("./lib/send-mail");`; replace both `await msg.send();` (~139, ~162) with `await sendMail(msg);`.

- [ ] **Step 6: Syntax + tests**

Run: `for f in service/private/hub.js service/private/contact.js service/lib/butler-mail.js service/form.js service/public/stripe_webhook.js; do node --check $f || echo "FAIL $f"; done && node --test test/mail-send-guard.test.js test/send-mail.test.js test/contact-invite-guard.test.js test/invite-failure-reason.test.js test/invite-pushes-pending.test.js test/hub-cancel-invite.test.js`
Expected: no `FAIL` lines; tests PASS. Run `test/invite-email-delivery.test.js` separately and confirm it still fails only with its pre-existing `_sendInviteEmail is not a function` / `accept_link is not defined` errors (Global Constraints).

- [ ] **Step 7: Commit**

```bash
git add service/private/hub.js service/private/contact.js service/lib/butler-mail.js service/form.js test/mail-send-guard.test.js
git commit -m "refactor(mail): invites, contacts, billing and forms through send-mail"
```

---

### Task 7: Migrate notifications & sharing (service/)

**Files:**
- Modify: `service/lib/activity-mailer.js` (~121)
- Modify: `service/private/sharebox.js` (~429, ~473, ~787)
- Modify: `service/private/secure_share.js` (~155)
- Modify: `service/transfer.js` (~139, ~700)
- Modify: `test/mail-send-guard.test.js` (delete the 4 "Task 7" lines)

**Interfaces:**
- Consumes: `sendMail`, `NOTIFICATION` from Task 2.

- [ ] **Step 1: Red.** Delete the `// Task 7` entries from `PENDING`; run the guard; expect FAIL naming the four files.

- [ ] **Step 2: Notification sites** (recipients are account holders who opted in):
  - `service/lib/activity-mailer.js`: add `const { sendMail, NOTIFICATION } = require("./send-mail");`. Replace `await msg.send({ html, from: butlerFrom() });` with `await sendMail(msg, { html, kind: NOTIFICATION });`, then remove `butlerFrom` from its import if unused.
  - `service/private/sharebox.js` lines ~429 (`_send_inbound_link_old`) and ~473 (`_send_inbound_link`): first confirm each is preceded by a `shouldSendNotification` check (`sed -n 400,475p service/private/sharebox.js`). For each one that IS gated, replace `await msg.send();` with `await sendMail(msg, { kind: NOTIFICATION });`. For any that is not gated, use `await sendMail(msg);`.

- [ ] **Step 3: Transactional sites** (guest delivery or user-requested):
  - `service/private/sharebox.js` ~787 (`assign_guest_permission`, a guest with no account): `await msg.send();` → `await sendMail(msg);`
  - `service/private/secure_share.js` ~155: `await msg.send();` → `await sendMail(msg);`
  - `service/transfer.js` ~139 (transfer OTP) and ~700 (download ack): `await msg.send();` → `await sendMail(msg);`
  - Requires: `service/private/*` → `require("../lib/send-mail")`; `service/transfer.js` → `require("./lib/send-mail")`. Import `NOTIFICATION` only where it is used.

- [ ] **Step 4: Syntax + tests**

Run: `for f in service/lib/activity-mailer.js service/private/sharebox.js service/private/secure_share.js service/transfer.js; do node --check $f || echo "FAIL $f"; done && node --test test/mail-send-guard.test.js test/send-mail.test.js`
Expected: no `FAIL`; PASS.

- [ ] **Step 5: Commit**

```bash
git add service/lib/activity-mailer.js service/private/sharebox.js service/private/secure_share.js service/transfer.js test/mail-send-guard.test.js
git commit -m "refactor(mail): notification and sharing mail through send-mail, one-click unsubscribe on opt-in notifications"
```

---

### Task 8: Migrate offline workers

All transactional. Require path from `offline/<dir>/<file>.js`: `const { sendMail } = require("../../service/lib/send-mail");`

**Files:**
- Modify: `offline/drumate/backup.js` (~372), `offline/mail/index.js` (~38), `offline/notification/sharebox-notification.js` (~124), `offline/notification/sendmail.js` (~88), `offline/notification/meeting-notification.js` (~91), `offline/subscription/downgrade.js` (~99), `offline/media/transfer.js` (~109, ~146), `offline/workers/rewardExpiryWorker.js` (~214–222)
- Modify: `test/mail-send-guard.test.js` (delete the "Task 8" lines; `PENDING` becomes empty)

- [ ] **Step 1: Red.** Delete the `// Task 8` entries; `PENDING` is now `new Set([])`. Run the guard; expect FAIL naming the eight files.

- [ ] **Step 2: Single-line sites.** Replace exactly, then add the require:

| File | Old | New |
|------|-----|-----|
| `offline/drumate/backup.js` | `await msg.send({ html });` | `await sendMail(msg, { html });` |
| `offline/mail/index.js` | `await msg.send();` | `await sendMail(msg);` |
| `offline/notification/sharebox-notification.js` | `await msg.send();` | `await sendMail(msg);` |
| `offline/notification/sendmail.js` | `await msg.send();` | `await sendMail(msg);` |
| `offline/notification/meeting-notification.js` | `await msg.send();` | `await sendMail(msg);` |
| `offline/subscription/downgrade.js` | `await msg.send();` | `await sendMail(msg);` |
| `offline/media/transfer.js` (×2) | `await msg.send();` | `await sendMail(msg);` |

- [ ] **Step 3: `offline/workers/rewardExpiryWorker.js`.** Replace

```js
  const html = msg.renderFrom(TEMPLATE, data);
  const sender = butlerSender();
  const from = sender ? `"Drumee" <${sender}>` : undefined;
```

with

```js
  const html = msg.renderFrom(TEMPLATE, data);
```

and `const result = await msg.send(from ? { html, from } : { html });` with `const result = await sendMail(msg, { html });`. Then delete the worker's `butlerSender()` helper if `grep -n butlerSender offline/workers/rewardExpiryWorker.js` shows no other use (also drop `readFileSync` from its imports if it becomes unused). The `NO_MTA` check below (`typeof result === 'string'`) still holds.

- [ ] **Step 4: Syntax + full mail test suite**

Run: `for f in offline/drumate/backup.js offline/mail/index.js offline/notification/sharebox-notification.js offline/notification/sendmail.js offline/notification/meeting-notification.js offline/subscription/downgrade.js offline/media/transfer.js offline/workers/rewardExpiryWorker.js; do node --check $f || echo "FAIL $f"; done && node --test test/mail-send-guard.test.js test/send-mail.test.js test/unsubscribe-token.test.js test/unsubscribe.test.js test/mail-result.test.js`
Expected: no `FAIL`; all PASS.

- [ ] **Step 5: Collapse the allowlist.** In `test/mail-send-guard.test.js`, replace the now-empty `PENDING` set with `const PENDING = new Set();` and delete its "Each migration task…" comment. Re-run the guard: PASS.

- [ ] **Step 6: Commit**

```bash
git add offline test/mail-send-guard.test.js
git commit -m "refactor(mail): offline workers through send-mail; no direct sends remain"
```

---

### Task 9: Deploy, DNS, and verify in real inboxes

Infra and verification. Stage/production writes need an explicit go-ahead from the owner of each box (they are not covered by approving this plan).

**Files:** none in the repo.

- [ ] **Step 1: Unsubscribe secret on every server box** (stage first, then production). Same owner and mode as `email.json`:

```bash
sudo sh -c 'node -e "console.log(JSON.stringify({secret: require(\"crypto\").randomBytes(32).toString(\"base64url\")}))" > /etc/drumee/credential/unsubscribe.json'
sudo chown --reference=/etc/drumee/credential/email.json /etc/drumee/credential/unsubscribe.json
sudo chmod 600 /etc/drumee/credential/unsubscribe.json
```

Without this file the code still works; it just omits List-Unsubscribe (Task 2 test).

- [ ] **Step 2: Relay signs drumee.org (release blocker if Task 0 showed `header.d=drumee.com`).** On mail.drumee.com, the opendkim `KeyTable`/`SigningTable` must have an entry for `drumee.org` with selector `mail`, whose private key matches the published `mail._domainkey.drumee.org` record. Check that the public part matches:

```bash
dig +short TXT mail._domainkey.drumee.org | tr -d '" \n' | sed 's/.*p=//'   # published
sudo openssl rsa -in /etc/opendkim/keys/drumee.org/mail.private -pubout 2>/dev/null | grep -v '^-----' | tr -d '\n'   # relay's key, path per KeyTable
```

The two strings must be identical. If they differ or the key is missing, generate a key pair (`opendkim-genkey -d drumee.org -s mail`), add it to the tables, restart opendkim, and publish the new `mail._domainkey.drumee.org` TXT.

- [ ] **Step 3: DMARC reporting and policy.**
  - drumee.com: `_dmarc.drumee.com` TXT → `v=DMARC1; p=quarantine; sp=quarantine; adkim=r; aspf=r; rua=mailto:<a mailbox someone reads>`. It has no `rua` today.
  - drumee.org: keep `p=none` with the existing `rua=mailto:rua@dmarc.brevo.com` for 2 weeks after release. If the reports show only aligned passes from 135.125.104.154, raise it to `p=quarantine`.
  - Register drumee.org (and drumee.com) in Google Postmaster Tools (https://postmaster.google.com) to watch spam rate and domain reputation. Target: spam rate below 0.1%, never above 0.3%.

- [ ] **Step 4: Deploy to stage** with the normal `npm run deploy` flow, then confirm the deployed copy has the helper: `ssh huan@drumee.in 'ls /srv/drumee/runtime/server/main/service/lib/send-mail.js'`.

- [ ] **Step 5: Verify with mail-tester.** Repeat Task 0 Steps 1–3 on stage for (a) a password reset, (b) a workspace invite, (c) an activity notification to an opted-in account. Expected for each: mail-tester ≥ 9/10; Gmail "Show original" shows `SPF: PASS`, `DKIM: PASS` (domain drumee.org, or the Task 0 choice), `DMARC: PASS`. The raw source contains a `Content-Type: text/plain` part and `Reply-To: contact@drumee.org`. Only (c) shows `List-Unsubscribe:` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, and Gmail displays an "Unsubscribe" link next to the sender.

- [ ] **Step 6: Verify one-click.** Copy the `List-Unsubscribe` URL from (c) and POST it the way Gmail does:

```bash
curl -s -X POST -H 'Content-Type: application/x-www-form-urlencoded' -d 'List-Unsubscribe=One-Click' '<URL from the header>'
```

Expected: the "no longer receive notification emails" page, and that account's Settings toggle now shows notifications off. The same URL with one character of `sig` changed must return "not valid" and change nothing.

- [ ] **Step 7: Production.** Repeat Steps 1, 4 (production deploy flow), 5 and 6 against production. Record the scores in the PR description.

---

## Self-Review

- **Coverage.** F1 → Task 2 (From) + Tasks 5–8 (every site). F2 → Task 2 (text part). F3 → Tasks 1, 2, 3, 6 and 7 (headers, endpoint, notification sites). F4 → Task 0, Task 9 Step 2. F5 → Task 9 Step 3. F6 → Task 4 hygiene guard. No finding is left without a task.
- **Placeholders.** One deliberate operator input remains: the DMARC `rua` mailbox in Task 9 Step 3, which is a business choice of inbox, not code. Line numbers are marked "~" and every replacement quotes the exact old text, so a drifted line is found by content.
- **Names.** `sendMail`, `buildMailOptions`, `textFromHtml`, `TRANSACTIONAL`/`NOTIFICATION`, `unsubscribeUrl(email, base)`, `sign`/`verify`, `_setSecretForTest`, `unsubscribeEmail(yp, email)`, `unsubscribePage(state)` and `parseSettings` are used identically in every task that references them.
- **Review Focus.** Each of the five lines has a named test in Task 1, 2 or 3.
