// channel-topics.test.js — folder chat topics: channel.topic_list /
// topic_create, and the scope helpers channel.messages and channel.post use
// for a topic_id.
//
//   node --test test/channel-topics.test.js
const assert = require('node:assert/strict');
const test = require('node:test');

global.myDrumee = { arch: 'pod', useEmail: 0 };
global.verbosity = 0;
global.debug = {};

const Channel = require('../service/private/channel');
const P = Channel.prototype;

const HELPERS = ['_topicInFolder', '_listRowsForScope', '_markScopeRead', '_postTopicGuard', '_scopeMetadata'];

// procs: name → value | (…args) => value. priv: the caller's privilege on the
// hub root (memberCan reads it through mfs_access_node; 7 = chat, 3 = view).
function ctx({ input = {}, procs = {}, priv = 7 } = {}) {
  const calls = [];
  const seen = {};
  const c = {
    calls, seen, uid: 'me00000000000001',
    input: {
      use: (k, d) => (input[k] == null ? d : input[k]),
      need: (k) => input[k],
      get: (k) => input[k],
    },
    db: {
      await_proc: async (n, ...a) => {
        if (n === 'mfs_home') return { home_id: 'root000000000001' };
        if (n === 'mfs_access_node') return { privilege: priv };
        calls.push([n, ...a]);
        const v = procs[n];
        return typeof v === 'function' ? v(...a) : v;
      },
    },
    output: { data: (d) => (seen.data = d), list: (l) => (seen.list = l) },
    exception: { forbiden: () => (seen.forbidden = 1) },
    warn() {},
  };
  for (const m of HELPERS) if (P[m]) c[m] = P[m];
  return c;
}
const TOPIC = { id: 't000000000000001', folder_nid: 'fA', name: 'Design', emoji: '😀' };

test('topic_list passes the folder and answers the rows', async () => {
  const c = ctx({ input: { folder_nid: 'fA' }, procs: { channel_topic_list: [{ ...TOPIC, unread: 2 }] } });
  await P.topic_list.call(c);
  assert.deepEqual(c.calls, [['channel_topic_list', 'me00000000000001', 'fA']]);
  assert.deepEqual(c.seen.list, [{ ...TOPIC, unread: 2 }]);
});

test('topic_create validates name (1–60 after trim) and emoji (non-empty, ≤16 bytes)', async () => {
  for (const input of [
    { folder_nid: 'fA', name: '', emoji: '😀' },
    { folder_nid: 'fA', name: '   ', emoji: '😀' },
    { folder_nid: 'fA', name: 'x'.repeat(61), emoji: '😀' },
    { folder_nid: 'fA', name: 'Design', emoji: '' },
    { folder_nid: 'fA', name: 'Design', emoji: '😀'.repeat(5) },
    { folder_nid: '', name: 'Design', emoji: '😀' },
  ]) {
    const c = ctx({ input });
    await P.topic_create.call(c);
    assert.equal(c.seen.data.status, 'INVALID_TOPIC', JSON.stringify(input));
    assert.equal(c.calls.length, 0);
  }
  const ok = ctx({ input: { folder_nid: 'fA', name: '  Design  ', emoji: '😀' }, procs: { channel_topic_create: [TOPIC] } });
  await P.topic_create.call(ok);
  assert.deepEqual(ok.calls, [['channel_topic_create', 'me00000000000001', 'fA', 'Design', '😀']]);
  assert.deepEqual(ok.seen.data, TOPIC);
});

test('topic_create answers TOPIC_EXISTS from the proc', async () => {
  const c = ctx({ input: { folder_nid: 'fA', name: 'Design', emoji: '😀' }, procs: { channel_topic_create: [{ error: 'TOPIC_EXISTS' }] } });
  await P.topic_create.call(c);
  assert.deepEqual(c.seen.data, { status: 'TOPIC_EXISTS' });
});

test('no chat access: topic_list empty, topic_create refused', async () => {
  const l = ctx({ input: { folder_nid: 'fA' }, priv: 3, procs: { channel_topic_list: [TOPIC] } });
  await P.topic_list.call(l);
  assert.deepEqual(l.seen.list, []);
  assert.equal(l.calls.length, 0);
  const c = ctx({ input: { folder_nid: 'fA', name: 'Design', emoji: '😀' }, priv: 3 });
  await P.topic_create.call(c);
  assert.deepEqual(c.seen.data, { status: 'FORBIDDEN' });
  assert.equal(c.calls.length, 0);
});

const rows = [
  { message_id: 'm1', metadata: JSON.stringify({ _scope_nid: 'fA' }) },
  { message_id: 'm2', metadata: JSON.stringify({ _scope_nid: 'fA', _topic_id: TOPIC.id }) },
  { message_id: 'm3', metadata: JSON.stringify({ _scope_nid: 'fB' }) },
  { message_id: 'm4', metadata: null },
];

test('messages scope: absent / all keep topic messages; general drops them', async () => {
  for (const topic_id of [undefined, 'all']) {
    const c = ctx({ procs: { channel_list_messages: rows } });
    const got = await c._listRowsForScope('fA', topic_id, 'desc', 1);
    assert.deepEqual(got.map((r) => r.message_id), ['m1', 'm2', 'm4'], String(topic_id));
  }
  const g = ctx({ procs: { channel_list_messages: rows } });
  assert.deepEqual((await g._listRowsForScope('fA', 'general', 'desc', 1)).map((r) => r.message_id), ['m1', 'm4']);
});

test('messages scope: a topic id lists that topic; marks it read (mark_read=0 does not)', async () => {
  const c = ctx({ procs: { channel_topic_get: [TOPIC], channel_topic_messages: [rows[1]] } });
  const got = await c._listRowsForScope('fA', TOPIC.id, 'desc', 2);
  assert.deepEqual(got.map((r) => r.message_id), ['m2']);
  assert.ok(c.calls.some((x) => x[0] === 'channel_topic_messages' && x[2] === TOPIC.id && x[4] === 2));
  await c._markScopeRead(TOPIC.id, { message_id: 'm2' }, true);
  assert.ok(c.calls.some((x) => x[0] === 'channel_topic_mark_read' && x[2] === TOPIC.id));
  assert.ok(!c.calls.some((x) => x[0] === 'channel_read_messages'), 'a topic read never moves the hub cursor');
  const n = ctx();
  await n._markScopeRead(TOPIC.id, { message_id: 'm2' }, false);
  assert.equal(n.calls.length, 0);
  const all = ctx();
  await all._markScopeRead(undefined, { message_id: 'm9' }, true);
  assert.deepEqual(all.calls, [['channel_read_messages', 'm9', 'me00000000000001']]);
});

test('topic of another folder is refused (post and messages)', async () => {
  const c = ctx({ procs: { channel_topic_get: [{ ...TOPIC, folder_nid: 'fB' }] } });
  assert.deepEqual(await c._listRowsForScope('fA', TOPIC.id, 'desc', 1), []);
  assert.ok(!c.calls.some((x) => x[0] === 'channel_topic_messages'));
  assert.deepEqual(await c._postTopicGuard(TOPIC.id, 'fA'), { ok: false, status: 'INVALID_TOPIC' });
  const gone = ctx({ procs: { channel_topic_get: [] } });
  assert.deepEqual(await gone._postTopicGuard(TOPIC.id, 'fA'), { ok: false, status: 'INVALID_TOPIC' });
  const ok = ctx({ procs: { channel_topic_get: [TOPIC] } });
  assert.deepEqual(await ok._postTopicGuard(TOPIC.id, 'fA'), { ok: true });
  const none = ctx();
  assert.deepEqual(await none._postTopicGuard(undefined, 'fA'), { ok: true });
  assert.equal(none.calls.length, 0);
});

test('post metadata: _topic_id next to _scope_nid; none without a topic', () => {
  const c = ctx();
  assert.deepEqual(c._scopeMetadata('fA', TOPIC.id), { _scope_nid: 'fA', _topic_id: TOPIC.id });
  assert.deepEqual(c._scopeMetadata('fA', undefined), { _scope_nid: 'fA' });
  assert.equal(c._scopeMetadata('', undefined), undefined);
});

test('topic_id must be [0-9a-zA-Z]{1,16} (it reaches a proc-call string)', async () => {
  for (const bad of ["x';DROP", 'a'.repeat(17), 'a-b']) {
    const c = ctx({ procs: { channel_topic_get: [TOPIC] } });
    assert.deepEqual(await c._postTopicGuard(bad, 'fA'), { ok: false, status: 'INVALID_TOPIC' }, bad);
    assert.deepEqual(await c._listRowsForScope('fA', bad, 'desc', 1), [], bad);
    assert.equal(c.calls.length, 0, bad);
  }
});
