// channel.details / channel.media_list — the Chat details panel's two reads.
//
//   node --test test/channel-chat-details.test.js
//
// details() is one round trip: team-chat media counts + the hub's members
// with presence, both procs in parallel, numbers coerced (MariaDB SUMs come
// back as strings) and a single-row driver result normalised to an array.
// media_list() refuses an unknown kind without touching the database.
const assert = require('node:assert/strict');
const test = require('node:test');

global.myDrumee = { arch: 'pod', useEmail: 0 };
global.verbosity = 0;
global.debug = {};

const ChannelPrivate = require('../service/private/channel');

function ctx(procs, input = {}) {
  const calls = [];
  const seen = {};
  return {
    calls,
    seen,
    uid: 'me00000000000001',
    input: {
      need: (k) => {
        if (input[k] == null) throw new Error(`missing ${k}`);
        return input[k];
      },
      use: (k, d) => (input[k] == null ? d : input[k]),
    },
    db: {
      await_proc: async (name, ...args) => {
        calls.push([name, ...args]);
        return procs[name];
      },
    },
    output: {
      data: (d) => { seen.data = d; return d; },
      list: (l) => { seen.list = l; return l; },
    },
  };
}

test('details: counts coerced to numbers, members passed through', async () => {
  const c = ctx({
    channel_media_stats: [{ photos: '752', videos: '33', files: '175', links: '721' }],
    hub_member_presence: [{ id: 'a', online: 1, last_seen: 0 }, { id: 'b', online: 0, last_seen: 9 }],
  });
  await ChannelPrivate.prototype.details.call(c);
  assert.deepEqual(c.seen.data.stats, { photos: 752, videos: 33, files: 175, links: 721 });
  assert.deepEqual(c.seen.data.members.map((m) => m.id), ['a', 'b']);
  assert.deepEqual(c.calls.find((x) => x[0] === 'channel_media_stats'), ['channel_media_stats', 'me00000000000001']);
  assert.deepEqual(c.calls.find((x) => x[0] === 'hub_member_presence'), ['hub_member_presence']);
});

test('details: empty stats and a single-row member result', async () => {
  const c = ctx({ channel_media_stats: undefined, hub_member_presence: { id: 'solo' } });
  await ChannelPrivate.prototype.details.call(c);
  assert.deepEqual(c.seen.data.stats, { photos: 0, videos: 0, files: 0, links: 0 });
  assert.deepEqual(c.seen.data.members, [{ id: 'solo' }]);
});

test('media_list: forwards uid, kind and page', async () => {
  const c = ctx({ channel_media_list: [{ nid: 'i1' }] }, { kind: 'photo', page: '2' });
  await ChannelPrivate.prototype.media_list.call(c);
  assert.deepEqual(c.calls, [['channel_media_list', 'me00000000000001', 'photo', 2]]);
  assert.deepEqual(c.seen.list, [{ nid: 'i1' }]);
});

test('media_list: page defaults to 1, unknown kind never reaches the db', async () => {
  const ok = ctx({ channel_media_list: [] }, { kind: 'link' });
  await ChannelPrivate.prototype.media_list.call(ok);
  assert.equal(ok.calls[0][3], 1);

  const bad = ctx({}, { kind: 'drop table' });
  await ChannelPrivate.prototype.media_list.call(bad);
  assert.deepEqual(bad.calls, []);
  assert.deepEqual(bad.seen.list, []);
});

// Video rows: the media table has no duration (it lives in the node's
// __storage__/<nid>/info.json, orig.format.duration), so media_list fills it in.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('media_list: video rows get their duration from info.json', async () => {
  const c = ctx({
    channel_media_list: [
      { nid: 'v1', category: 'video', duration: null },
      { nid: 'v2', category: 'video', duration: null },
      { nid: 'v3', category: 'video', duration: 12 },
    ],
  }, { kind: 'video' });
  const asked = [];
  c._mediaInfoDuration = async (nid) => { asked.push(nid); return nid === 'v1' ? 540.129524 : null; };
  await ChannelPrivate.prototype.media_list.call(c);
  assert.deepEqual(c.seen.list.map((r) => r.duration), [540, null, 12]);
  assert.deepEqual(asked, ['v1', 'v2']); // a known duration is not re-read
});

test('media_list: photo rows are not touched', async () => {
  const c = ctx({ channel_media_list: [{ nid: 'i1', category: 'image' }] }, { kind: 'photo' });
  c._mediaInfoDuration = async () => { throw new Error('should not read'); };
  await ChannelPrivate.prototype.media_list.call(c);
  assert.deepEqual(c.seen.list, [{ nid: 'i1', category: 'image' }]);
});

test('_mediaInfoDuration reads orig.format.duration, null when absent or unreadable', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-home-'));
  const dir = path.join(home, '__storage__', 'v1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'info.json'), JSON.stringify({ orig: { format: { duration: '540.129524' } } }));
  fs.mkdirSync(path.join(home, '__storage__', 'v2'), { recursive: true });
  fs.writeFileSync(path.join(home, '__storage__', 'v2', 'info.json'), '{not json');
  const self = { hub: { get: (k) => (k === 'home_dir' ? home : undefined) } };
  const read = (nid) => ChannelPrivate.prototype._mediaInfoDuration.call(self, nid);
  assert.equal(await read('v1'), 540.129524);
  assert.equal(await read('v2'), null);
  assert.equal(await read('missing'), null);
  assert.equal(await read('../../etc'), null); // never leaves __storage__
  fs.rmSync(home, { recursive: true, force: true });
});
