#!/usr/bin/env node
//
// hub-invite-answer-notify.test.js — "<invitee> accepted / declined your
// invitation to <workspace>" for the admin who sent it
// (service/lib/hub-invite-answer-notify.js), the two hub.js call sites, and the
// feed wiring that makes those rows render, count and land in Other
// (service/private/activity.js).
//
//   node --test offline/test/hub-invite-answer-notify.test.js
//
// Zero-dependency: @drumee/server-essentials is stubbed, the yp connection is
// a fake that records every call, and the activity.js / hub.js pieces are read
// from the real source rather than copied, so a change there is what gets
// tested.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const sent = [];
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === '@drumee/server-essentials') {
    return {
      toArray: (v) => (v == null ? [] : (Array.isArray(v) ? v : [v])),
      RedisStore: { sendData: async (payload, to) => { sent.push({ payload, to }); } },
    };
  }
  return realLoad.call(this, request, ...rest);
};
const lib = require('../../service/lib/hub-invite-answer-notify');
Module._load = realLoad;

const INVITER = 'inviter000000001';
const INVITEE = 'invitee000000001';
const HUB = 'hub0000000000001';
const EMAIL = 'Ann@Example.com';
const ANON = 'ffffffffffffffff';

function fakeSvc({ inviterPerm = 31, account = INVITEE, name = 'Marketing', failLog = false } = {}) {
  const calls = [];
  const warns = [];
  const yp = {
    await_func: async (name_, ...args) => { calls.push([name_, ...args]); return 'hubdb_1'; },
    await_query: async (sql, ...args) => { calls.push(['query', sql, ...args]); return inviterPerm ? [{ permission: inviterPerm }] : []; },
    await_proc: async (name_, ...args) => {
      calls.push([name_, ...args]);
      if (name_ === 'drumate_exists') return account ? { id: account } : [];
      if (name_ === 'push_workspace_name') return name ? [{ workspace_name: name }] : [];
      if (name_ === 'contact_log_activity' && failLog) throw new Error('boom');
      if (name_ === 'user_sockets') return [{ socket_id: 's1' }];
      return [];
    },
  };
  return {
    yp, calls, warns,
    warn: (...a) => warns.push(a),
    payload: (data, opt) => ({ data, ...opt }),
  };
}

const logged = (svc) => svc.calls.filter((c) => c[0] === 'contact_log_activity');

test('accept: one hub_invite_accepted row from the invitee to the inviter, and a push', async () => {
  sent.length = 0;
  const svc = fakeSvc();
  const ok = await lib.notifyInviter(svc, { answer: 'accepted', hub_id: HUB, inviter_id: INVITER, email: EMAIL, actor: INVITEE });
  assert.strictEqual(ok, true);
  const rows = logged(svc);
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(rows[0].slice(0, 4), ['contact_log_activity', INVITEE, INVITER, 'hub_invite_accepted']);
  assert.deepStrictEqual(rows[0][4], { hub_id: HUB, hub_name: 'Marketing', email: 'ann@example.com', answer: 'accepted' });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].payload.service, 'activity.hub_invite_answer');
  assert.deepStrictEqual(sent[0].payload.data, { event: 'hub_invite_accepted', hub_id: HUB });
  // The signed-in caller IS the invitee: no lookup by address.
  assert.strictEqual(svc.calls.filter((c) => c[0] === 'drumate_exists').length, 0);
});

test('decline with no session: the account behind the invited address answers', async () => {
  const svc = fakeSvc();
  await lib.notifyInviter(svc, { answer: 'declined', hub_id: HUB, inviter_id: INVITER, email: EMAIL, actor: ANON });
  const [row] = logged(svc);
  assert.deepStrictEqual(row.slice(0, 4), ['contact_log_activity', INVITEE, INVITER, 'hub_invite_declined']);
  assert.strictEqual(row[4].answer, 'declined');
});

test('decline by an address with no account: anonymous author, named by email', async () => {
  const svc = fakeSvc({ account: null });
  assert.strictEqual(await lib.notifyInviter(svc, { answer: 'declined', hub_id: HUB, inviter_id: INVITER, email: EMAIL }), true);
  const [row] = logged(svc);
  assert.strictEqual(row[1], ANON);
  assert.strictEqual(row[4].email, 'ann@example.com');
});

test('a workspace with no display name still notifies (name null)', async () => {
  const svc = fakeSvc({ name: null });
  await lib.notifyInviter(svc, { answer: 'accepted', hub_id: HUB, inviter_id: INVITER, email: EMAIL, actor: INVITEE });
  assert.strictEqual(logged(svc)[0][4].hub_name, null);
});

test('an inviter who answers their own invitation is not notified', async () => {
  const svc = fakeSvc();
  assert.strictEqual(await lib.notifyInviter(svc, { answer: 'accepted', hub_id: HUB, inviter_id: INVITER, email: EMAIL, actor: INVITER }), false);
  assert.strictEqual(logged(svc).length, 0);
});

test('an inviter no longer on the workspace is not notified', async () => {
  const svc = fakeSvc({ inviterPerm: 0 });
  assert.strictEqual(await lib.notifyInviter(svc, { answer: 'declined', hub_id: HUB, inviter_id: INVITER, email: EMAIL, actor: INVITEE }), false);
  assert.strictEqual(logged(svc).length, 0);
});

test('unknown answer, bad ids and a missing / anonymous inviter write nothing', async () => {
  const cases = [
    { answer: 'maybe', hub_id: HUB, inviter_id: INVITER, actor: INVITEE },
    { answer: 'constructor', hub_id: HUB, inviter_id: INVITER, actor: INVITEE },
    { answer: 'accepted', hub_id: "x' OR 1", inviter_id: INVITER, actor: INVITEE },
    { answer: 'accepted', hub_id: HUB, inviter_id: null, actor: INVITEE },
    { answer: 'accepted', hub_id: HUB, inviter_id: ANON, actor: INVITEE },
  ];
  for (const c of cases) {
    const svc = fakeSvc();
    assert.strictEqual(await lib.notifyInviter(svc, c), false, JSON.stringify(c));
    assert.strictEqual(svc.calls.length, 0, JSON.stringify(c));
  }
});

test('never throws: a DB failure is logged and swallowed', async () => {
  const svc = fakeSvc({ failLog: true });
  assert.strictEqual(await lib.notifyInviter(svc, { answer: 'accepted', hub_id: HUB, inviter_id: INVITER, email: EMAIL, actor: INVITEE }), false);
  assert.strictEqual(svc.warns.length, 1);
});

// ---------------------------------------------------------------------------
// hub.js call sites.
// ---------------------------------------------------------------------------
const HUB_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'service', 'private', 'hub.js'), 'utf8');

function methodBody(src, name) {
  const start = src.indexOf(`\n  async ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  let depth = 0;
  for (let i = src.indexOf('{', src.indexOf(')', start)); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

test('accept_invite tells the inviter on both successful branches, after closing the invitation', () => {
  const body = methodBody(HUB_SRC, 'accept_invite');
  const calls = body.match(/await this\._notifyInviter\(tokenRow, hub_id, 'accepted'\);/g) || [];
  assert.strictEqual(calls.length, 2);
  // each one right after the _closeInvitation it follows
  const pairs = body.match(/_closeInvitation\(hub_id, tokenRow\.email, \{ accepted: 1 \}\);\s*await this\._notifyInviter/g) || [];
  assert.strictEqual(pairs.length, 2);
});

test('a decline is attributed to the invited address, an accept to the signed-in account', () => {
  const body = methodBody(HUB_SRC, '_notifyInviter');
  assert.match(body, /actor: answer === 'accepted' \? this\.uid : null,/);
});

test('decline_invite tells the inviter only when this call declined a live invitation', () => {
  const body = methodBody(HUB_SRC, 'decline_invite');
  assert.ok(body.indexOf("token_get_next") < body.indexOf("token_hub_invite_decline"), 'state read BEFORE the decline');
  assert.match(body, /if \(wasActive && tokenRow\.status === 'declined'\) \{\s*await this\._notifyInviter\(tokenRow, hub_id, 'declined'\);/);
  assert.ok(body.indexOf("'already_used'") < body.indexOf('_notifyInviter'), 'an accepted token returns before');
});

// ---------------------------------------------------------------------------
// activity.js wiring, sliced from the real source.
// ---------------------------------------------------------------------------
const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'service', 'private', 'activity.js'), 'utf8');

function sliceFunction(name) {
  const start = SRC.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `${name} not found in activity.js`);
  let depth = 0;
  for (let i = SRC.indexOf('{', SRC.indexOf(')', start)); i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) return SRC.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

test('flattenHubInviteAnswer stamps category, author, workspace and email from data', () => {
  const flatten = new Function(
    `const ANONYMOUS_UID = '${ANON}';\nconst HUB_INVITE_ANSWER_EVENTS = new Set(['hub_invite_accepted', 'hub_invite_declined']);\n`
    + `${sliceFunction('flattenHubInviteAnswer')}\nreturn flattenHubInviteAnswer;`
  )();
  const rows = flatten([
    { id: 1, uid: INVITEE, event: 'hub_invite_accepted', event_type: 'contact', hub_id: null,
      data: JSON.stringify({ hub_id: HUB, hub_name: 'Marketing', email: 'ann@example.com', answer: 'accepted' }) },
    { id: 2, uid: ANON, event: 'hub_invite_declined', event_type: 'contact', firstname: 'nobody', fullname: 'nobody@local.drumee',
      data: { hub_id: HUB, hub_name: null, email: 'bob@example.com', answer: 'declined' } },
    { id: 3, uid: INVITEE, event: 'invite_accepted', data: '{}' },
  ]);
  assert.strictEqual(rows[0].category, 'hub_invite_accepted');
  assert.strictEqual(rows[0].author_id, INVITEE);
  assert.strictEqual(rows[0].hub_id, HUB);
  assert.strictEqual(rows[0].hub_name, 'Marketing');
  assert.strictEqual(rows[1].category, 'hub_invite_declined');
  assert.strictEqual(rows[1].author_id, undefined, 'no avatar for the anonymous sentinel');
  assert.strictEqual(rows[1].email, 'bob@example.com');
  assert.strictEqual(rows[1].fullname, 'bob@example.com', 'named by the invited address');
  assert.strictEqual(rows[1].firstname, null);
  assert.strictEqual(rows[2].category, undefined, 'other events untouched');
  // idempotent
  assert.deepStrictEqual(flatten([{ ...rows[0] }])[0], rows[0]);
});

test('the flatten is applied in get_feed and its event set matches the lib', () => {
  assert.match(SRC, /flattenFileOwnerActivity\(result\);\s*flattenHubInviteAnswer\(result\);/);
  assert.match(SRC, /HUB_INVITE_ANSWER_EVENTS = new Set\(\['hub_invite_accepted', 'hub_invite_declined'\]\)/);
  assert.strictEqual(lib.HUB_INVITE_ACCEPTED, 'hub_invite_accepted');
  assert.strictEqual(lib.HUB_INVITE_DECLINED, 'hub_invite_declined');
});

test('both events land in Other, are counted, cleared by the Other tab and bookmark as contact', () => {
  assert.match(SRC, /hub_invite_accepted: BUCKET\.other,/);
  assert.match(SRC, /hub_invite_declined: BUCKET\.other,/);
  assert.match(SRC, /contact_hub_invite_accepted_unread: 'hub_invite_accepted',/);
  assert.match(SRC, /contact_hub_invite_declined_unread: 'hub_invite_declined',/);
  const procs = SRC.slice(SRC.indexOf('const CONTACT_UNREAD_PROCS'), SRC.indexOf('const CONTACT_UNREAD_EVENTS'));
  assert.match(procs, /'contact_hub_invite_accepted_unread'/);
  assert.match(procs, /'contact_hub_invite_declined_unread'/);
  const clear = SRC.slice(SRC.indexOf('const CONTACT_CLEAR'), SRC.indexOf('if (bucket && lookup(CONTACT_CLEAR'));
  const other = clear.slice(clear.indexOf('[BUCKET.other]'));
  assert.match(other, /'contact_hub_invite_accepted_unread'/);
  assert.match(other, /'contact_hub_invite_declined_unread'/);
  const bookmark = sliceFunction('bookmarkKey');
  assert.match(bookmark, /'hub_invite_accepted', 'hub_invite_declined'\]\.includes\(category\)/);
});
