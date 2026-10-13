// activity-muted-chat-rows.test.js — a chat the viewer muted leaves the feed
// and every badge; its meeting notices and everything else stay.
//   node --test test/activity-muted-chat-rows.test.js
const assert = require('node:assert/strict');
const test = require('node:test');
global.myDrumee = { arch: 'pod', useEmail: 0 };
global.verbosity = 0;
global.debug = {};
const Activity = require('../service/private/activity');

const MUTED_HUB = 'hubmuted00000001';
const OPEN_HUB = 'hubopen000000002';
const MUTED_PEER = 'peermuted0000001';
const OTHER_PEER = 'peerother0000002';

// Raw notification_center_next rows, as the procedure returns them.
const teamchat = (hub, extra = {}) => ({
  category: 'teamchat', hub_id: hub, key_id: `nid-${hub}`, nid: `nid-${hub}`,
  entity_id: `nid-${hub}`, cnt: 3, last_id: 9, ctime: 100, ...extra,
});
const dm = (peer) => ({
  category: 'chat', hub_id: 'me00000000000001', entity_id: peer, drumate_id: peer,
  key_id: `contact-of-${peer}`, cnt: 2, last_id: 5, ctime: 90,
});

// `mutes` is what yp answers for the two mute procedures; `proc` overrides any
// _callUserProc answer by name.
function activity(opts = {}) {
  const { proc = {}, input = {} } = opts;
  // `undefined` is the driver's "failed / not deployed" answer, so an explicit
  // undefined must not fall back to "nothing muted".
  const hubMutes = 'hubMutes' in opts ? opts.hubMutes : [];
  const peerMutes = 'peerMutes' in opts ? opts.peerMutes : [];
  const a = Object.create(Activity.prototype);
  const calls = { yp: [], user: [], stored: null };
  Object.assign(a, {
    uid: 'me00000000000001',
    calls,
    debug() {},
    warn() {},
    input: { use: (k) => input[k], get: (k) => input[k], need: (k) => input[k] },
    yp: {
      async await_proc(name, ...args) {
        calls.yp.push(name);
        if (name === 'notification_mute_state') return hubMutes;
        if (name === 'notification_mute_peer_state') return peerMutes;
        return [];
      },
    },
    async _callUserProc(name, ...args) {
      calls.user.push([name, ...args]);
      return proc[name] !== undefined ? proc[name] : [];
    },
    async _storeRollups(items) { calls.stored = items; },
  });
  return a;
}

test('a muted workspace and a muted person leave the live rollups, and are not stored', async () => {
  const a = activity({
    hubMutes: [{ hub_id: MUTED_HUB }],
    peerMutes: [{ peer_id: MUTED_PEER }],
    proc: { notification_center_next: [teamchat(MUTED_HUB), teamchat(OPEN_HUB), dm(MUTED_PEER), dm(OTHER_PEER)] },
  });
  const rows = await a._notificationRollups();
  const keys = rows.map((r) => `${r.category}:${r.hub_id}:${r.key_id}`);
  assert.deepEqual(keys, [
    `teamchat:${OPEN_HUB}:nid-${OPEN_HUB}`,
    `chat:me00000000000001:${OTHER_PEER}`,
  ]);
  assert.deepEqual(a.calls.stored.map((r) => r.key_id), rows.map((r) => r.key_id));
});

test('a meeting start in a muted workspace stays, counted once and flagged for the rail', async () => {
  const a = activity({
    hubMutes: [{ hub_id: MUTED_HUB }],
    proc: { notification_center_next: [teamchat(MUTED_HUB, { meeting_action: 'start', cnt: 4 })] },
  });
  const [row] = await a._notificationRollups();
  assert.equal(row.bucket, 'meeting');
  assert.equal(row.muted, 1);
  assert.equal(row.cnt, 1);
});

test('a global mute hides every chat and keeps everything else', async () => {
  const a = activity({
    hubMutes: [{ hub_id: '' }],
    proc: {
      notification_hub_invites: [{ hub_id: OPEN_HUB, author_id: OTHER_PEER, hubname: 'Team', ctime: 70 }],
      notification_center_next: [
        teamchat(OPEN_HUB), dm(OTHER_PEER),
        teamchat(OPEN_HUB, { meeting_action: 'end' }),
        { category: 'media', hub_id: OPEN_HUB, nid: 'n1', cnt: 1, last_id: 1, ctime: 80 },
      ],
    },
  });
  const rows = await a._notificationRollups();
  assert.deepEqual(rows.map((r) => r.bucket), ['meeting', 'files', 'other']);
});

test('a failed mute lookup hides nothing, for this request only', async () => {
  const a = activity({
    hubMutes: undefined,
    peerMutes: undefined,
    proc: { notification_center_next: [teamchat(MUTED_HUB), dm(MUTED_PEER)] },
  });
  assert.equal((await a._notificationRollups()).length, 2);
  // No process-wide cooldown: the next request reads the mutes again.
  const b = activity({
    hubMutes: [{ hub_id: MUTED_HUB }],
    proc: { notification_center_next: [teamchat(MUTED_HUB)] },
  });
  assert.equal((await b._notificationRollups()).length, 0);
});

test('the mutes are read once per request', async () => {
  const a = activity({ proc: { notification_center_next: [teamchat(OPEN_HUB)] } });
  await a._notificationRollups();
  await a._notificationRollups();
  assert.equal(a.calls.yp.filter((n) => n === 'notification_mute_state').length, 1);
});

test('"Mark all as read" on the Chat tab leaves a muted conversation unread', async () => {
  const a = activity({
    hubMutes: [{ hub_id: MUTED_HUB }],
    peerMutes: [{ peer_id: MUTED_PEER }],
    input: { last_id: '0', bucket: 'chat' },
    proc: { notification_center_next: [teamchat(MUTED_HUB), teamchat(OPEN_HUB), dm(MUTED_PEER)] },
  });
  a.output = { data() {} };
  await a.mark_all_read();
  const read = a.calls.user.filter(([name]) => name === 'notification_read').map((c) => c[3]);
  assert.deepEqual(read, [OPEN_HUB]);
});

test('get_feed drops stored copies of a muted chat and keeps the paged base rows', async () => {
  const history = (category, hub, key) => ({
    id: `h-${key}`, timestamp: 50, event: 'notification.history', event_type: 'notification_history',
    is_read: 1, hub_id: hub, category, key_id: key, history_id: `h-${key}`,
  });
  const mention = (from) => ({
    id: `m-${from}`, timestamp: 60, uid: from, event: 'p2p_mention', event_type: 'contact',
    data: JSON.stringify({ peer_id: from, message: 'hi' }), is_read: 0,
  });
  const a = activity({
    hubMutes: [{ hub_id: MUTED_HUB }],
    peerMutes: [{ peer_id: MUTED_PEER }],
    input: { page: 1, filter: 'all', unread_only: '0' },
    proc: {
      activity_get_feed_all: [history('teamchat', MUTED_HUB, `nid-${MUTED_HUB}`), mention(MUTED_PEER)],
    },
  });
  let sent;
  a.output = { data(d) { sent = d; }, list(d) { sent = d; } };
  a._storedRollups = async () => [
    { category: 'teamchat', key_id: `nid-${MUTED_HUB}`, hub_id: MUTED_HUB, bucket: 'chat', ctime: 40, timestamp: 40 },
    { category: 'teamchat', key_id: `nid-${OPEN_HUB}x`, hub_id: OPEN_HUB, bucket: 'chat', ctime: 40, timestamp: 40 },
    // A DM copy stored under the earlier keying: key_id is the contact id.
    { category: 'chat', key_id: 'contact-77', drumate_id: MUTED_PEER, hub_id: 'me00000000000001', bucket: 'chat', ctime: 40, timestamp: 40 },
  ];
  a._retireRollups = async () => {};
  await a.get_feed();
  const rows = Array.isArray(sent) ? sent : (sent && (sent.rows || sent.items || sent.list)) || [];
  const ids = rows.map((r) => r.id || `${r.category}:${r.key_id}`);
  assert.ok(ids.includes(`teamchat:nid-${OPEN_HUB}x`), JSON.stringify(ids));
  assert.ok(!ids.includes(`teamchat:nid-${MUTED_HUB}`), JSON.stringify(ids));
  assert.ok(!ids.includes('chat:contact-77'), JSON.stringify(ids));
  // Base rows stay: dropping them after the page is read would end paging.
  assert.ok(ids.includes(`h-nid-${MUTED_HUB}`) && ids.includes(`m-${MUTED_PEER}`), JSON.stringify(ids));
});

// Runs last: it leaves notification_mute_state latched for PROC_RETRY_MS.
test('a mute routine failing three times in a row is skipped for a while', async () => {
  const run = async () => {
    const a = activity({ hubMutes: undefined, proc: { notification_center_next: [teamchat(MUTED_HUB)] } });
    await a._notificationRollups();
    return a.calls.yp.filter((n) => n === 'notification_mute_state').length;
  };
  assert.deepEqual([await run(), await run(), await run()], [1, 1, 1]);
  assert.equal(await run(), 0);
});
