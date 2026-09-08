// Where a Stripe round trip puts the buyer back down.
//
// THE REPORT (2026-09-08): "clicking a plan CTA on the Billing page sometimes
// sends me back to log in / through onboarding again."
//
// A plan CTA taken through to Stripe returns via callback.check_out_success or
// check_out_cancel, and BOTH ends of that trip dropped the host the buyer was
// actually on:
//
//   1. payment.checkout built success_url/cancel_url from a bare homepath(),
//      which answers the CONFIGURED base domain — Input.domain() maps the
//      request host onto public_domain / private_domain / main_domain. An org
//      member checking out from team-5202.drumee.in got URLs on drumee.in.
//   2. the two callbacks then redirected to an absolute homepath() as well, so
//      even a return that DID land on the vhost jumped off it again.
//
// The session cookie is HOST-scoped, so the desk boots on the base domain as a
// guest: apparent logout, and onboarding for a fresh session. Intermittent
// because a browser that also holds a base-domain session is re-resolved back
// to the vhost and never notices.
//
// portal_return was already fixed this way and its comment records the same
// finding, "verified live". These lock both halves.
const assert = require('node:assert/strict');
const test = require('node:test');

global.myDrumee = {arch: 'pod', useEmail: 0};
global.verbosity = 0;
global.debug = {};

const Callback = require('../service/callback');
const PaymentPrivate = require('../service/private/payment');

// homepath() as Input implements it: the configured base domain, or the
// hostname it is handed, plus the request path with the service part stripped.
function input(base, path) {
  // Input.homepath strips the service part off the request path, which is what
  // leaves the endpoint segment behind.
  const pathname = path.replace(/(svc|service).*$/, '');
  return {
    homepath(hostname) {
      return `https://${hostname || base}${pathname}`;
    },
  };
}

const VHOST = 'team-5202.drumee.in';
const BASE = 'drumee.in';
const ENDPOINT = '/-/';

// ── the bounce keeps the host ─────────────────────────────────────────────

// The emitted page is `<script> window.location.href = '<target>' </script>`.
function target(html) {
  const m = String(html).match(/href = '([^']*)'/);
  assert.ok(m, `no redirect in: ${html}`);
  return m[1];
}

function callback(query = {}) {
  const out = {html: null};
  return {
    input: {
      ...input(BASE, `${ENDPOINT}svc/`),
      use: (k, d) => (k in query ? query[k] : d),
    },
    output: {html(h) { out.html = h; }},
    _deskPath: Callback.prototype._deskPath,
    sent: () => target(out.html),
  };
}

test('the checkout return never names a host', async () => {
  const ok = callback({session_id: 'cs_test_abc123'});
  await Callback.prototype.check_out_success.call(ok);
  const success = ok.sent();

  const no = callback();
  await Callback.prototype.check_out_cancel.call(no);
  const cancel = no.sent();

  // A host here is the bug: it is resolved from config, not from the request,
  // so it lands the buyer on the base domain without their session cookie.
  for (const url of [success, cancel]) {
    assert.doesNotMatch(url, /^https?:\/\//, `${url} must be relative`);
    assert.doesNotMatch(url, /drumee\.in/, `${url} must not name a host`);
    assert.match(url, /^\/-\//, `${url} must keep the endpoint segment`);
  }

  // ...and everything the desk reads off the return still travels.
  assert.match(success, /\?checkout=success&session_id=cs_test_abc123/);
  assert.match(success, /#\/desk\/$/);
  assert.match(cancel, /\?checkout=cancel/);
  assert.match(cancel, /#\/desk\/$/);
});

test('portal_return still behaves exactly as it did', async () => {
  const c = callback();
  await Callback.prototype.portal_return.call(c);
  assert.equal(c.sent(), '/-/#/desk/');
});

test('the session id stays whitelisted to Stripe alphabet', async () => {
  const c = callback({session_id: "cs_live_x'--><script>"});
  await Callback.prototype.check_out_success.call(c);
  // Everything outside [A-Za-z0-9_] is dropped, so nothing can break out of
  // the quoted string this is interpolated into.
  assert.equal(c.sent(), "/-/?checkout=success&session_id=cs_live_xscript#/desk/");
});

test('a homepath that cannot be parsed still yields a usable path', async () => {
  const c = callback();
  c.input.homepath = () => 'not a url';
  await Callback.prototype.check_out_cancel.call(c);
  assert.equal(c.sent(), '/?checkout=cancel#/desk/');
});

// ── the return URL is built on the buyer's own host ───────────────────────

function payer(orgRow, {throws = false} = {}) {
  return {
    uid: 'u1',
    input: input(BASE, `${ENDPOINT}svc/`),
    _row: PaymentPrivate.prototype._row,
    warn() {},
    yp: {
      await_proc(proc, uid) {
        assert.equal(proc, 'payment_get_org');
        assert.equal(uid, 'u1');
        if (throws) throw new Error('yp is down');
        return orgRow;
      },
    },
  };
}

const home = (ctx) => PaymentPrivate.prototype._returnHome.call(ctx);

test('an org buyer comes back to their own vhost', async () => {
  const url = await home(payer({id: 'o1', link: VHOST}));
  assert.equal(url, `https://${VHOST}${ENDPOINT}`);
});

test('the org row may arrive as a single-row array', async () => {
  // await_proc hands back an array or a bare object depending on the driver;
  // _row is the class's own normaliser and both shapes must resolve the vhost.
  const url = await home(payer([{id: 'o1', link: VHOST}]));
  assert.equal(url, `https://${VHOST}${ENDPOINT}`);
});

test('a personal buyer keeps the base domain', async () => {
  // No organisation yet — the TEAM bootstrap included, whose org the webhook
  // has not created. The base domain IS their home.
  for (const row of [null, undefined, {}, []]) {
    assert.equal(await home(payer(row)), `https://${BASE}${ENDPOINT}`);
  }
});

test('a malformed link never reaches Stripe', async () => {
  // This string becomes success_url; a bad host makes Stripe refuse the
  // session, i.e. the purchase fails. Falling back is the safe direction.
  for (const link of ['https://team.drumee.in', 'team .drumee.in', 'a/b', '', 0]) {
    assert.equal(await home(payer({id: 'o1', link})), `https://${BASE}${ENDPOINT}`,
      `link ${JSON.stringify(link)} must not be used as a host`);
  }
});

test('a failed lookup does not block the purchase', async () => {
  assert.equal(await home(payer(null, {throws: true})), `https://${BASE}${ENDPOINT}`);
});

test('the endpoint segment survives on a dev endpoint', async () => {
  const ctx = payer({id: 'o1', link: VHOST});
  ctx.input = input(BASE, '/-/duynguyen/svc/');
  assert.equal(await home(ctx), `https://${VHOST}/-/duynguyen/`);
});
