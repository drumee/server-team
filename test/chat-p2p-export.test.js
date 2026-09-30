// chat-p2p-export.test.js — chat.p2p_export_scope / chat.p2p_export.
//   node --test test/chat-p2p-export.test.js
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
global.myDrumee = { arch: 'pod', useEmail: 0 };
global.verbosity = 0;
global.debug = {};
const ChatPrivate = require('../service/private/chat');
const { normalizeP2pRow, gatherP2pSection } = require('../service/lib/p2p-export');

function ctx({ input = {}, related = true, count = 2, pages = [[
  { message_id: 'm1', author_id: 'me', message: 'hello', ctime: 100, fullname: 'Me Mine' },
  { message_id: 'm4', author_id: 'peer', message: 'hi back', ctime: 200, fullname: 'Ann Peer' },
]] } = {}) {
  const calls = [];
  const seen = {};
  return {
    calls, seen, uid: 'me',
    input: { need: (k) => input[k], use: (k) => input[k] },
    _p2pRelated: async () => related,
    _p2pPeerName: ChatPrivate.prototype._p2pPeerName,
    randomString: () => 'zip123',
    db: { await_proc: async (n, ...a) => {
      calls.push([n, ...a]);
      if (n === 'p2p_export_count') return [{ message_count: count }];
      if (n === 'p2p_export_messages') return pages[(a[3] || 1) - 1] || [];
      return [];
    } },
    yp: { await_proc: async (n, ...a) => (calls.push([n, ...a]), [{ id: 'peer', fullname: 'Ann Peer' }]) },
    output: { data: (d) => (seen.data = d) },
  };
}

test('normalizeP2pRow maps a p2p row onto the export message shape', () => {
  const m = normalizeP2pRow({ message_id: 'm1', author_id: 'a', message: 'x', ctime: 5, fullname: 'An A', attachment: '[{"nid":"n","hub_id":"h","filename":"f.pdf"}]' });
  assert.deepEqual(m.author, { id: 'a', name: 'An A' });
  assert.equal(m.text, 'x');
  assert.equal(m.attachments.length, 1);
});

test('gatherP2pSection pages until a short page', async () => {
  const full = Array.from({ length: 45 }, (_, i) => ({ message_id: `a${i}`, author_id: 'me', message: 'x', ctime: i }));
  const c = ctx({ pages: [full, [{ message_id: 'z', author_id: 'peer', message: 'y', ctime: 99 }]] });
  const s = await gatherP2pSection(c.db, 'peer', 'Ann Peer', null, null);
  assert.equal(s.type, 'direct_chat');
  assert.equal(s.name, 'Ann Peer');
  assert.equal(s.messages.length, 46);
});

test('p2p_export_scope answers the export_scope shape', async () => {
  const c = ctx({ input: { peer_id: 'peer' } });
  await ChatPrivate.prototype.p2p_export_scope.call(c);
  assert.deepEqual(c.seen.data, { hub: { name: 'Ann Peer', message_count: 2, mtime: null }, folders: [], file_threads: [] });
});

test("a stranger's DM is not exported (scope or export)", async () => {
  const s = ctx({ input: { peer_id: 'x' }, related: false });
  await ChatPrivate.prototype.p2p_export_scope.call(s);
  assert.equal(s.seen.data.hub.message_count, 0);
  assert.ok(!s.calls.some((x) => x[0] === 'p2p_export_count'));
  const e = ctx({ input: { peer_id: 'x', format: 'json' }, related: false });
  await ChatPrivate.prototype.p2p_export.call(e);
  assert.equal(e.seen.data.status, 'INVALID_PEER');
  assert.ok(!e.calls.some((x) => x[0] === 'p2p_export_messages'));
});

test('export guards: format, socket for pdf, 10k cap', async () => {
  const bad = ctx({ input: { peer_id: 'peer', format: 'docx' } });
  await ChatPrivate.prototype.p2p_export.call(bad);
  assert.equal(bad.seen.data.status, 'INVALID_FORMAT');
  const pdf = ctx({ input: { peer_id: 'peer', format: 'pdf' } });
  await ChatPrivate.prototype.p2p_export.call(pdf);
  assert.equal(pdf.seen.data.status, 'MISSING_SOCKET_ID');
  const big = ctx({ input: { peer_id: 'peer', format: 'json' }, count: 10001 });
  await ChatPrivate.prototype.p2p_export.call(big);
  assert.equal(big.seen.data.status, 'EXPORT_TOO_LARGE');
});

test('the DM manifest pins the viewer\'s own hub; JSON is staged inline', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-exp-'));
  const c = ctx({ input: { peer_id: 'peer', format: 'json', start_date: '50' } });
  c._exportStageRoot = tmp; // test seam: chat.js resolves stage dirs under this when set
  await ChatPrivate.prototype.p2p_export.call(c);
  assert.equal(c.seen.data.wait, 0);
  assert.equal(c.seen.data.zipid, 'zip123');
  assert.match(c.seen.data.zipname, /\.json$/);
  const dir = path.join(tmp, 'me', 'zip123');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.file-thread-access.json'), 'utf8'));
  assert.deepEqual(manifest, { schema_version: 1, hub_id: 'me', file_threads: [] });
  const out = JSON.parse(fs.readFileSync(path.join(dir, c.seen.data.zipname), 'utf8'));
  assert.equal(out.sections[0].type, 'direct_chat');
  assert.equal(out.sections[0].messages.length, 2);
  assert.ok(c.calls.some((x) => x[0] === 'p2p_export_count' && x[2] === 50));
});
