// Redeeming a workspace invitation that was never granted.
//
// THE REPORT: "I skipped creating a workspace during onboarding, a colleague
// invited me to theirs, and I cannot see it." The invitation had been written
// to yp.pending_invitation instead of being granted (hub.add_contributors
// refused to grant across domains, and a free account sits in domain 1 until
// org_provision moves it). Nothing redeems a pending row for an account that
// ALREADY EXISTS — both old redeemers ran at account creation only — so there
// was no add_member, therefore no join_hub, therefore no workspace under the
// invitee's home root and nothing for desk.home to list. Invisible, reload
// after reload.
//
// These lock the redeemer's contract: who gets granted, what is cleared, and
// what is deliberately left behind to be retried.
const assert = require('node:assert/strict');
const test = require('node:test');

global.myDrumee = { arch: 'pod', useEmail: 0 };
global.verbosity = 0;
global.debug = {};

const HOUR = 3600;
const NOW = () => Math.floor(Date.now() / 1000);

// The lib destructures RedisStore once at load, so patching the method on that
// same object is what lets a test see the push without a live redis.
const essentials = require('@drumee/server-essentials');
const sent = [];
essentials.RedisStore.sendData = async (payload, dest) => { sent.push({ payload, dest }); };

const { resolvePendingInvitations } = require('../service/lib/resolve-pending-invitation');

/**
 * A yp double that records every call and answers the happy path by default.
 * `answers` overrides one proc by name; `null` from an override means "no row".
 */
function fakeSvc(pending, answers = {}) {
  const calls = [];
  const pick = (name, args) => {
    if (Object.prototype.hasOwnProperty.call(answers, name)) {
      const a = answers[name];
      return typeof a === 'function' ? a(...args) : a;
    }
    return undefined;
  };
  const yp = {
    async await_proc(name, ...args) {
      calls.push([name, ...args]);
      const o = pick(name, args);
      if (o !== undefined) return o;
      if (name === 'pending_invitation_get_by_email') return pending;
      if (/\.add_member$/.test(name)) return { id: 'u_invitee', db_name: 'a_invitee' };
      if (/\.mfs_home$/.test(name)) return { chat_upload_id: 'chat1' };
      if (/\.mfs_access_node$/.test(name)) return { actual_hub_id: args[1], actual_db: 'f_hub' };
      if (name === 'user_sockets') return [{ id: 's1' }];
      if (name === 'entity_sockets') return [{ id: 's2' }];
      return {};
    },
    async await_func(name, ...args) {
      calls.push([name, ...args]);
      const o = pick(name, args);
      if (o !== undefined) return o;
      if (name === 'get_db_name') return 'f_hub1';
      return null;
    },
    // Routed by shape, because three different reads go through await_query:
    // the live membership, the invitee's home-root row, and the hub's owner.
    async await_query(sql, ...args) {
      calls.push(['query', sql, ...args]);
      if (/FROM `[^`]+`\.permission/.test(sql)) {
        return answers.live === undefined ? [] : [{ permission: answers.live }];
      }
      if (/FROM `[^`]+`\.media/.test(sql)) {
        return answers.visible ? [{ id: args[0] }] : [];
      }
      return [{ owner_id: 'u_owner', name: 'Marketing' }];
    },
  };
  return {
    yp,
    calls,
    warn: () => {},
    debug: () => {},
    payload: (data, opt) => ({ ...data, ...opt }),
  };
}

const named = (svc, re) => svc.calls.filter((c) => re.test(c[0]));

test('an address that already has an account is granted, in HOURS', async () => {
  // The stored value is an ABSOLUTE timestamp (yp_add_pending_invitation
  // converts hours with TIMESTAMPADD before storing) while add_member takes
  // hours from now. Handing the stored number straight over — which both old
  // copies did — asks for a grant expiring in ~1.8 billion hours.
  const expires = NOW() + 48 * HOUR;
  const svc = fakeSvc([{ hub_id: 'h1', email: 'a@b.c', permission: 6, expiry_time: expires }]);

  const res = await resolvePendingInvitations(svc, 'a@b.c', { uid: 'u_invitee' });

  assert.equal(res.redeemed, 1);
  const add = named(svc, /\.add_member$/)[0];
  assert.deepEqual(add.slice(0, 3), ['f_hub1.add_member', 'u_invitee', 6]);
  assert.ok(add[3] >= 47 && add[3] <= 48, `expiry converted back to hours, got ${add[3]}`);
  assert.equal(named(svc, /^pending_invitation_delete_by_email$/).length, 1,
    'a redeemed invitation is cleared');
});

test('no expiry stays permanent', async () => {
  const svc = fakeSvc([{ hub_id: 'h1', email: 'a@b.c', permission: 15, expiry_time: 0 }]);
  await resolvePendingInvitations(svc, 'a@b.c', { uid: 'u_invitee' });
  assert.equal(named(svc, /\.add_member$/)[0][3], 0);
});

test('the membership grant is followed by the hub-root permission', async () => {
  const svc = fakeSvc([{ hub_id: 'h1', email: 'a@b.c', permission: 6, expiry_time: 0 }]);
  await resolvePendingInvitations(svc, 'a@b.c', { uid: 'u_invitee' });
  const grants = named(svc, /\.permission_grant$/);
  assert.equal(grants[0][1], '*', 'membership is the star grant');
  assert.equal(grants[0][4], 6);
  assert.ok(grants.some((g) => g[1] === 'chat1'),
    'chat upload too — neither old copy made this grant, so a member who '
    + 'arrived this way could not attach a file in the workspace chat');
});

test('the invitee is told over the socket, on the name the desk listens for', async () => {
  sent.length = 0;
  const svc = fakeSvc([{ hub_id: 'h1', email: 'a@b.c', permission: 6, expiry_time: 0 }]);
  await resolvePendingInvitations(svc, 'a@b.c', { uid: 'u_invitee' });
  assert.ok(sent.some((s) => s.payload.service === 'hub.invite_received'),
    'the switcher and the sidebar both key off this exact service name');
});

test('notify:false keeps an offline repair silent', async () => {
  sent.length = 0;
  const svc = fakeSvc([{ hub_id: 'h1', email: 'a@b.c', permission: 6, expiry_time: 0 }]);
  await resolvePendingInvitations(svc, 'a@b.c', { uid: 'u_invitee', notify: false });
  assert.equal(sent.length, 0);
});

test('an address with NO account is left alone for account creation', async () => {
  const svc = fakeSvc(
    [{ hub_id: 'h1', email: 'nobody@b.c', permission: 6, expiry_time: 0 }],
    { drumate_exists: null }
  );
  const res = await resolvePendingInvitations(svc, 'nobody@b.c');
  assert.equal(res.redeemed, 0);
  assert.equal(named(svc, /\.add_member$/).length, 0);
  assert.equal(named(svc, /^pending_invitation_delete_by_email$/).length, 0,
    'the invitation is still waiting — deleting it would lose it');
});

test('an invitation that expired before redemption is dropped, not granted', async () => {
  const svc = fakeSvc([
    { hub_id: 'h1', email: 'a@b.c', permission: 6, expiry_time: NOW() - HOUR },
  ]);
  const res = await resolvePendingInvitations(svc, 'a@b.c', { uid: 'u_invitee' });
  assert.equal(res.redeemed, 0);
  assert.equal(named(svc, /\.add_member$/).length, 0);
  assert.equal(named(svc, /^pending_invitation_delete_by_email$/).length, 1,
    'nothing to grant and nothing to retry');
});

test('an invitation into a workspace that no longer exists is dropped', async () => {
  const svc = fakeSvc(
    [{ hub_id: 'gone', email: 'a@b.c', permission: 6, expiry_time: 0 }],
    { get_db_name: null }
  );
  const res = await resolvePendingInvitations(svc, 'a@b.c', { uid: 'u_invitee' });
  assert.equal(res.redeemed, 0);
  assert.equal(named(svc, /^pending_invitation_delete_by_email$/).length, 1,
    'a dead hub must not be retried on every login');
});

test('a failure keeps the row so the next attempt retries it', async () => {
  const svc = fakeSvc(
    [{ hub_id: 'h1', email: 'a@b.c', permission: 6, expiry_time: 0 }],
    { 'f_hub1.add_member': () => { throw new Error('hub db down'); } }
  );
  const res = await resolvePendingInvitations(svc, 'a@b.c', { uid: 'u_invitee' });
  assert.equal(res.redeemed, 0);
  assert.equal(res.failed, 1);
  assert.equal(named(svc, /^pending_invitation_delete_by_email$/).length, 0,
    'a transient failure must not silently destroy the invitation');
});

test('add_member writing nothing is a failure, not a silent success', async () => {
  // It answers with a db_name-carrying row only when the membership was
  // actually written; anything else means it bailed, and a permission_grant on
  // top of that is a grant with no membership behind it.
  const svc = fakeSvc(
    [{ hub_id: 'h1', email: 'a@b.c', permission: 6, expiry_time: 0 }],
    { 'f_hub1.add_member': { db_name: null } }
  );
  const res = await resolvePendingInvitations(svc, 'a@b.c', { uid: 'u_invitee' });
  assert.equal(res.failed, 1);
  assert.equal(named(svc, /\.permission_grant$/).length, 0);
});

test('an empty table costs one lookup and nothing else', async () => {
  const svc = fakeSvc([]);
  const res = await resolvePendingInvitations(svc, 'a@b.c', { uid: 'u_invitee' });
  assert.equal(res.redeemed, 0);
  assert.equal(svc.calls.length, 1,
    'this runs on every login — the common path must stop at the lookup');
});

// ── the guard against walking over a membership that already works ──────────
//
// A pending row is deleted only when it is redeemed, so a stale one outlives a
// membership later granted properly through hub.invite — and the redeemer runs
// on EVERY login. Without these it would re-grant from the stale row on each
// one: demoting a privilege that was raised since, and re-running join_hub,
// whose REPLACE re-derives the home-root filename and resets its rank.

test('a stale invitation beside a working membership writes nothing', async () => {
  const svc = fakeSvc(
    [{ hub_id: 'h1', email: 'a@b.c', permission: 4, expiry_time: 0 }],
    { live: 15, visible: true }
  );
  const res = await resolvePendingInvitations(svc, 'a@b.c', { uid: 'u_invitee' });
  assert.equal(res.alreadyMember, 1);
  assert.equal(res.redeemed, 0);
  assert.equal(named(svc, /\.add_member$/).length, 0,
    'an admin at 15 must not be pushed back down to the invitation\'s 4');
  assert.equal(named(svc, /\.permission_grant$/).length, 0);
  assert.equal(named(svc, /^pending_invitation_delete_by_email$/).length, 1,
    'the stale row is still cleared — that is the repair');
});

test('permission without the home-root row is still repaired', async () => {
  // add_member writes into two databases. Half-applied is precisely the state
  // this module exists to finish: the grant is there, the workspace is not.
  const svc = fakeSvc(
    [{ hub_id: 'h1', email: 'a@b.c', permission: 4, expiry_time: 0 }],
    { live: 4, visible: false }
  );
  const res = await resolvePendingInvitations(svc, 'a@b.c', { uid: 'u_invitee' });
  assert.equal(res.redeemed, 1);
  assert.equal(named(svc, /\.add_member$/).length, 1, 'join_hub has to be re-run');
});

test('a repair never lowers a privilege raised since the invitation', async () => {
  const svc = fakeSvc(
    [{ hub_id: 'h1', email: 'a@b.c', permission: 4, expiry_time: 0 }],
    { live: 15, visible: false }
  );
  await resolvePendingInvitations(svc, 'a@b.c', { uid: 'u_invitee' });
  assert.equal(named(svc, /\.add_member$/)[0][2], 15);
  assert.equal(named(svc, /\.permission_grant$/)[0][4], 15);
});
