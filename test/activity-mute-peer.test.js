// activity-mute-peer.test.js — per-person DM popup mute.
//   node --test test/activity-mute-peer.test.js
const assert = require('node:assert/strict');
const test = require('node:test');
global.myDrumee = { arch: 'pod', useEmail: 0 };
global.verbosity = 0;
global.debug = {};
const Activity = require('../service/private/activity');

function ctx(input = {}, yp = {}) {
  const calls = [];
  const seen = {};
  const c = {
    calls, seen, uid: 'me00000000000001',
    input: { use: (k) => input[k], need: (k) => input[k], get: (k) => input[k] },
    yp: { await_proc: async (n, ...a) => { calls.push([n, ...a]); return typeof yp[n] === 'function' ? yp[n](...a) : yp[n]; } },
    output: { data: (d) => (seen.data = d) },
    debug() {},
    exception: { user: (code) => (seen.error = code) },
  };
  for (const m of ['_muteState', '_optionalYpProc', '_optionalYpProcResult', '_peerMutes', '_muteFlag']) {
    if (Activity.prototype[m]) c[m] = Activity.prototype[m];
  }
  return c;
}

test('mute_peer_set mutes a person and answers the full state with peers', async () => {
  const c = ctx({ peer_id: 'peer000000000002', muted: '1' }, {
    notification_mute_peer_set: [{ peer_id: 'peer000000000002', ctime: 5 }],
    notification_mute_state: [{ hub_id: 'hub0000000000001', ctime: 1 }],
  });
  await Activity.prototype.mute_peer_set.call(c);
  assert.deepEqual(c.calls[0], ['notification_mute_peer_set', 'me00000000000001', 'peer000000000002']);
  assert.equal(c.seen.data.status, 'ok');
  assert.equal(c.seen.data.muted, 1);
  assert.deepEqual(c.seen.data.peers, ['peer000000000002']);
  assert.deepEqual(c.seen.data.hubs, ['hub0000000000001']);
});

test('mute_peer_set with muted 0 unmutes that person', async () => {
  const c = ctx({ peer_id: 'peer000000000002', muted: '0' }, { notification_mute_peer_unset: [], notification_mute_state: [] });
  await Activity.prototype.mute_peer_set.call(c);
  assert.deepEqual(c.calls[0], ['notification_mute_peer_unset', 'me00000000000001', 'peer000000000002']);
  assert.deepEqual(c.seen.data.peers, []);
});

test('mute_peer_set rejects self and bad ids', async () => {
  for (const peer_id of ['me00000000000001', '', 'x;DROP', 'a'.repeat(17)]) {
    const c = ctx({ peer_id, muted: '1' });
    await Activity.prototype.mute_peer_set.call(c);
    assert.equal(c.seen.error, 'INVALID_PEER', peer_id);
    assert.equal(c.calls.length, 0, peer_id);
  }
});

test('mute_state carries peers (empty on an old schema)', async () => {
  const c = ctx({}, { notification_mute_state: [{ hub_id: '', ctime: 1 }], notification_mute_peer_state: [{ peer_id: 'p1', ctime: 2 }] });
  await Activity.prototype.mute_state.call(c);
  assert.deepEqual(c.seen.data, { global: 1, hubs: [], peers: ['p1'] });
});

test('global unmute also clears person mutes', async () => {
  const c = ctx({ hub_id: '', muted: '0' }, { notification_mute_unset: [], notification_mute_peer_unset: [] });
  await Activity.prototype.mute_set.call(c);
  assert.ok(c.calls.some((x) => x[0] === 'notification_mute_peer_unset' && x[2] === ''));
  assert.deepEqual(c.seen.data.peers, []);
  const one = ctx({ hub_id: 'hub0000000000001', muted: '0' }, { notification_mute_unset: [], notification_mute_peer_state: [{ peer_id: 'p1' }] });
  await Activity.prototype.mute_set.call(one);
  assert.ok(!one.calls.some((x) => x[0] === 'notification_mute_peer_unset'), 'a single workspace unmute keeps person mutes');
  assert.deepEqual(one.seen.data.peers, ['p1']);
});

// Last on purpose: a routine that answers undefined is remembered as missing
// (module-level MISSING_PROCS cooldown) for the rest of this process.
test('mute_state on an old schema (no person-mute routine) answers peers []', async () => {
  const old = ctx({}, { notification_mute_state: [], notification_mute_peer_state: undefined });
  await Activity.prototype.mute_state.call(old);
  assert.deepEqual(old.seen.data.peers, []);
});
