// chat.p2p_details / chat.p2p_media_list — the Chat details panel for a
// DIRECT conversation, plus the shared video-duration helper.
//
//   node --test test/chat-p2p-details.test.js
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

global.myDrumee = { arch: 'pod', useEmail: 0 };
global.verbosity = 0;
global.debug = {};

const ChatPrivate = require('../service/private/chat');
const { mediaInfoDuration } = require('../service/lib/media-duration');

function ctx(db = {}, yp = {}, input = {}, homes = {}) {
  const calls = { db: [], yp: [], q: [] };
  const seen = {};
  return {
    calls, seen,
    _p2pRelated: ChatPrivate.prototype._p2pRelated,
    uid: 'me00000000000001',
    input: {
      need: (k) => { if (input[k] == null) throw new Error(`missing ${k}`); return input[k]; },
      use: (k, d) => (input[k] == null ? d : input[k]),
      get: (k) => input[k],
    },
    db: {
      await_proc: async (n, ...a) => { calls.db.push([n, ...a]); return db[n]; },
      // p2p_time: one row per conversation partner, whichever side wrote.
      await_query: async (sql, id) => (/p2p_time/.test(sql) && (db.p2p_time || []).includes(id) ? [{ ok: 1 }] : []),
    },
    yp: {
      await_proc: async (n, ...a) => { calls.yp.push([n, ...a]); return yp[n]; },
      await_query: async (sql, id) => { calls.q.push(id); return homes[id] ? [{ home_dir: homes[id] }] : []; },
    },
    output: { data: (d) => (seen.data = d), list: (l) => (seen.list = l) },
  };
}

test('p2p_details: counts coerced, members are the two participants with presence', async () => {
  const c = ctx(
    { p2p_media_stats: [{ photos: '2', videos: '0', files: '5', links: '1' }], p2p_time: ['peer'] },
    { drumate_presence: [{ id: 'me00000000000001', online: 1 }, { id: 'peer', online: 0, last_seen: 9 }] },
    { peer_id: 'peer' },
  );
  await ChatPrivate.prototype.p2p_details.call(c);
  assert.deepEqual(c.seen.data.stats, { photos: 2, videos: 0, files: 5, links: 1 });
  assert.deepEqual(c.seen.data.members.map((m) => m.id), ['me00000000000001', 'peer']);
  assert.deepEqual(c.calls.db.filter((x) => x[0] === 'p2p_media_stats'), [['p2p_media_stats', 'peer']]);
  assert.deepEqual(c.calls.yp, [['drumate_presence', JSON.stringify(['me00000000000001', 'peer'])]]);
});

test('p2p_media_list: forwards peer, kind, page; unknown kind never reaches the db', async () => {
  const ok = ctx({ p2p_media_list: [{ nid: 'i1', hub_id: 'h1' }], p2p_time: ['peer'] }, {}, { peer_id: 'peer', kind: 'photo', page: '2' });
  await ChatPrivate.prototype.p2p_media_list.call(ok);
  assert.deepEqual(ok.calls.db.filter((x) => x[0] === 'p2p_media_list'), [['p2p_media_list', 'peer', 'photo', 2]]);
  assert.deepEqual(ok.seen.list, [{ nid: 'i1', hub_id: 'h1' }]);
  const bad = ctx({}, {}, { peer_id: 'peer', kind: 'drop' });
  await ChatPrivate.prototype.p2p_media_list.call(bad);
  assert.deepEqual(bad.calls.db, []);
  assert.deepEqual(bad.seen.list, []);
});

test('p2p_media_list: video durations come from each row hub info.json, one home lookup per hub', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-home-'));
  fs.mkdirSync(path.join(home, '__storage__', 'v1'), { recursive: true });
  fs.writeFileSync(path.join(home, '__storage__', 'v1', 'info.json'), JSON.stringify({ orig: { format: { duration: '75.4' } } }));
  const c = ctx(
    { p2p_media_list: [
      { nid: 'v1', hub_id: 'hA', duration: null },
      { nid: 'v2', hub_id: 'hA', duration: null },
      { nid: 'v3', hub_id: 'hB', duration: 12 },
    ], p2p_time: ['peer'] },
    {}, { peer_id: 'peer', kind: 'video' }, { hA: home },
  );
  await ChatPrivate.prototype.p2p_media_list.call(c);
  assert.deepEqual(c.seen.list.map((r) => r.duration), [75, null, 12]);
  assert.deepEqual(c.calls.q, ['hA']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('mediaInfoDuration: seconds from orig.format.duration, null when absent, never outside __storage__', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-home-'));
  fs.mkdirSync(path.join(home, '__storage__', 'v1'), { recursive: true });
  fs.writeFileSync(path.join(home, '__storage__', 'v1', 'info.json'), JSON.stringify({ orig: { format: { duration: 540.1 } } }));
  assert.equal(await mediaInfoDuration(home, 'v1'), 540.1);
  assert.equal(await mediaInfoDuration(home, 'missing'), null);
  assert.equal(await mediaInfoDuration(home, '../x'), null);
  assert.equal(await mediaInfoDuration(null, 'v1'), null);
  fs.rmSync(home, { recursive: true, force: true });
});

// Review: p2p_details must not hand out a stranger's email / presence for any
// id: only a contact or someone the viewer has a conversation with.
test('p2p_details: a stranger gets neither presence nor counts — only the viewer', async () => {
  const c = ctx(
    { p2p_media_stats: [{ photos: '3' }] },
    { drumate_presence: [{ id: 'me00000000000001', online: 1 }] },
    { peer_id: 'stranger' },
  );
  await ChatPrivate.prototype.p2p_details.call(c);
  assert.deepEqual(c.calls.yp, [['drumate_presence', JSON.stringify(['me00000000000001'])]]);
  assert.ok(!c.calls.db.some((x) => x[0] === 'p2p_media_stats'));
  assert.deepEqual(c.seen.data.stats, { photos: 0, videos: 0, files: 0, links: 0 });
  assert.deepEqual(c.seen.data.members.map((m) => m.id), ['me00000000000001']);
});

test('p2p_details: a contact with no conversation yet is a participant', async () => {
  const c = ctx(
    { p2p_media_stats: [{}], my_contact_exists: [{ uid: 'friend' }] },
    { drumate_presence: [{ id: 'me00000000000001' }, { id: 'friend' }] },
    { peer_id: 'friend' },
  );
  await ChatPrivate.prototype.p2p_details.call(c);
  assert.deepEqual(c.calls.yp, [['drumate_presence', JSON.stringify(['me00000000000001', 'friend'])]]);
});

test('p2p_media_list: a stranger gets an empty page and the proc never runs', async () => {
  const c = ctx({ p2p_media_list: [{ nid: 'i1', hub_id: 'h1' }] }, {}, { peer_id: 'stranger', kind: 'photo' });
  await ChatPrivate.prototype.p2p_media_list.call(c);
  assert.ok(!c.calls.db.some((x) => x[0] === 'p2p_media_list'));
  assert.deepEqual(c.seen.list, []);
});
