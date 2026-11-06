// test/session-guard.test.js — a stale tab must not act as another account.
//
// Every account of an org signs in on the same origin, so a sign-in in one tab
// swaps the session cookie under the others. The UI sends the uid it believes
// in as `x-drumee-uid`; the REST router refuses a mismatch with
// 412 SESSION_CHANGED before the service runs (router/rest/session-guard.js).
//
//   node --test test/session-guard.test.js
const assert = require('node:assert/strict');
const test = require('node:test');

const { sessionMismatch, isExempt } = require('../router/rest/session-guard');

const A = '4900ac004900ac06';
const B = '1fe9136a1fe9137f';
const NOBODY = 'ffffffffffffffff';
const GUEST = 'eeeeeeeeeeeeeeee';

test('no header never refuses', () => {
  assert.equal(sessionMismatch(undefined, B, 'media.attributes', GUEST), false);
  assert.equal(sessionMismatch('', B, 'media.attributes', GUEST), false);
});

test('a claim that is not a real uid never refuses', () => {
  assert.equal(sessionMismatch(NOBODY, B, 'media.attributes', GUEST), false);
  assert.equal(sessionMismatch(GUEST, B, 'media.attributes', GUEST), false);
  assert.equal(sessionMismatch('not-a-uid', B, 'media.attributes', GUEST), false);
  assert.equal(sessionMismatch(['x'], B, 'media.attributes', GUEST), false);
});

test('same uid passes', () => {
  assert.equal(sessionMismatch(A, A, 'media.attributes', GUEST), false);
});

test('different uid is refused', () => {
  assert.equal(sessionMismatch(A, B, 'media.attributes', GUEST), true);
  assert.equal(sessionMismatch(A, B, 'hub.invite', GUEST), true);
});

test('session signed out elsewhere (actual nobody) is refused', () => {
  assert.equal(sessionMismatch(A, NOBODY, 'media.upload', GUEST), true);
  assert.equal(sessionMismatch(A, undefined, 'media.upload', GUEST), true);
});

test('sign-out and boot services are exempt', () => {
  for (const svc of ['drumate.logout', 'yp.reset_session', 'yp.get_env',
    'bootstrap.authn', 'bootstrap.anything', 'authn.signin']) {
    assert.equal(isExempt(svc), true, svc);
    assert.equal(sessionMismatch(A, B, svc, GUEST), false, svc);
  }
  assert.equal(isExempt('media.attributes'), false);
  assert.equal(isExempt('bootstrapx.foo'), false);
});

test('uid comparison ignores case', () => {
  assert.equal(sessionMismatch(A.toUpperCase(), A, 'media.attributes', GUEST), false);
});

// ── wiring: router/rest run() asks the guard before resolving the service ──
test('router run() refuses a mismatch with 412 before Acl.getModule', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../router/rest/index.js'), 'utf8');
  const run = src.slice(src.indexOf('static run(session)'));
  const guard = run.indexOf('sessionMismatch(');
  const acl = run.indexOf('Acl.getModule(');
  assert.ok(guard > 0, 'run() calls sessionMismatch');
  assert.ok(guard < acl, 'the guard runs before Acl.getModule');
  assert.match(run.slice(guard, acl), /x-drumee-uid/);
  assert.match(run.slice(guard, acl), /precondition\(\s*["']SESSION_CHANGED["']\s*\)/);
});
