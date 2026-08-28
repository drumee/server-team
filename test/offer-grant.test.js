// claim_offer / resend_offer — the two calls that stand between a mailed link
// and a discount.
//
// The coupon is no longer in the mail. `g` is an opaque grant token, and
// claim_offer is the only thing that turns it into a code. That makes these two
// methods the entire security boundary for the campaign, so what is asserted
// here is not "does it work" but the four things whose absence would quietly
// give the discount away:
//
//   where the identity comes from    a second source is how the previous,
//                                    browser-side check became unreliable
//   what a refusal says              a forwarded link must not become an
//                                    oracle for the address or the code
//   that a claim is one-way          no read-only probe
//   that the caller names nothing    no campaign, no code on the resend
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const SRC = readFileSync(
  join(__dirname, "../service/private/payment.js"), "utf8");
const ACL = JSON.parse(readFileSync(
  join(__dirname, "../acl/payment.json"), "utf8"));

const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1")
  .replace(/\n\s*\n+/g, "\n");

/** One method, lifted whole and comment-stripped. */
function method(sig) {
  const i = SRC.indexOf(sig);
  assert.ok(i > 0, `${sig} not found`);
  const end = SRC.indexOf("\n  }", i);
  assert.ok(end > i, `${sig} has no closing brace`);
  return stripComments(SRC.slice(i, end + 4));
}

// ── identity ───────────────────────────────────────────────────────────
test("the claim reads its identity from payment_get_payer, not the request", () => {
  const body = method("async claim_offer() {");
  assert.match(body, /payment_get_payer/,
    "the signed-in address is not resolved server-side");
  assert.match(body, /await this\.yp\.await_proc\(\s*'mkt_grant_claim'/,
    "the token is not exchanged through mkt_grant_claim");
  // The address must not be readable off the request. That is the second
  // identity source, and when two sources disagree the offer dies in the gap —
  // which is exactly what made the old browser-side `for=` check unreliable.
  assert.ok(!/input\.use\(\s*['"]email/.test(body),
    "claim_offer takes an email from the caller — anyone could claim as anyone");
  // Same source as the two calls that actually spend the code, or the three
  // disagree about who is buying.
  for (const sig of ["async preview_coupon() {", "async checkout() {"]) {
    assert.match(method(sig), /payment_get_payer/,
      `${sig} keys on a different identity than claim_offer`);
  }
});

test("resend_offer names nothing — not a campaign, not a code", () => {
  const body = method("async resend_offer() {");
  assert.match(body, /payment_get_payer/, "it does not resolve the caller");
  assert.match(body, /'mkt_grant_resend',\s*''/,
    "a campaign is passed through — the proc must resolve the newest grant "
    + "itself, or the button becomes a way to ask for any offer in the table");
  assert.ok(!/input\.use\(\s*['"](campaign|code|promo)/.test(body),
    "the caller can name which offer to re-issue");
  assert.deepEqual(Object.keys(ACL.services.resend_offer.params || {}), [],
    "the ACL accepts parameters the method must not honour");
});

// ── a refusal must say nothing ─────────────────────────────────────────
test("a refused claim echoes only the status", () => {
  const body = method("async claim_offer() {");
  const refusal = body.slice(body.indexOf("if (!row || row.error)"),
    body.indexOf("const percent_off"));
  assert.match(refusal, /status:/, "the refusal carries no status to act on");
  for (const leak of ["row.code", "row.email", "row.campaign"]) {
    assert.ok(!refusal.includes(leak),
      `a refusal echoes ${leak} — a forwarded link becomes an oracle for it`);
  }
});

test("no read-only probe for a token", () => {
  // One would let anyone holding a forwarded link test whether it is live,
  // which is most of what the token was hiding.
  const body = stripComments(SRC);
  assert.ok(!/mkt_grant_peek|mkt_grant_state|async offer_state/.test(body),
    "a probe exists — a claim must be the only way to learn a token's fate");
});

// ── the resend's limits are the proc's, not this file's ────────────────
test("resend_offer passes NULL for the limits, never 0", () => {
  // In mkt_grant_issue these are deliberately different: NULL takes the
  // default (30 days / 3 sends / 15 min), 0 DISABLES the limit. Passing 0 here
  // — the obvious "no opinion" value — would silently turn off the cooldown
  // and the send cap on the one path a user can trigger at will.
  const body = method("async resend_offer() {");
  const call = body.slice(body.indexOf("'mkt_grant_resend'"));
  const args = call.slice(0, call.indexOf(")"));
  assert.ok(!/,\s*0\s*[,)]/.test(args),
    `resend passes a 0 limit, which DISABLES it: ${args.trim()}`);
  assert.match(args, /null,\s*null,\s*null/,
    "the three limits are not left to the proc's defaults");
});

test("a mail failure does not fail the resend", () => {
  const body = method("async resend_offer() {");
  const mail = body.slice(body.indexOf("_mailOfferLink"));
  assert.match(mail, /catch/,
    "an unsent mail fails the whole call — the grant has already been "
    + "re-issued by then, so the user would press the button again and spend "
    + "another of their three sends on something that already worked");
  assert.match(body, /status: 'OK'/, "a successful resend does not report OK");
  assert.match(body, /\bg: row\.token\b/,
    "the fresh token is not returned — the in-session half of the escape "
    + "hatch is the one that carries the traffic");
});

test("the resend mail builds its own link", () => {
  const body = method("async _mailOfferLink(email, grant) {");
  assert.match(body, /g=\$\{encodeURIComponent\(grant\.token\)\}/,
    "the mail does not carry the fresh token");
  assert.ok(!/input\.use\(\s*['"]link/.test(body),
    "the caller can choose where their own offer mail points");
  assert.ok(!/promo=/.test(body),
    "the coupon code is back in a mailed link");
});

// ── the ACL ────────────────────────────────────────────────────────────
test("both services are declared, owner-scoped like preview_coupon", () => {
  for (const name of ["claim_offer", "resend_offer"]) {
    const s = ACL.services[name];
    assert.ok(s, `${name} is not in the ACL — the client cannot call it`);
    assert.equal(s.scope, ACL.services.preview_coupon.scope,
      `${name} has a different scope than the other coupon services`);
    assert.deepEqual(s.permission, ACL.services.preview_coupon.permission,
      `${name} is not owner-only`);
  }
  assert.equal(ACL.services.claim_offer.params.g.required, true,
    "the grant token is optional — a call with none would reach the proc");
});
