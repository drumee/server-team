#!/usr/bin/env node
//
// workspace-pins.test.js
//
// drumate.pinned_workspaces (Lexis, 2026-10-07): the rules in
// service/lib/workspace-pins.js, and the service method itself SLICED OUT of
// service/private/drumate.js and run against stubs -- so the shipped method is
// what is tested, not a retyped copy.
//
// The case that motivated the service: device B signed in before device A
// pinned something. B must not write its old list back over A's pin.
//
//   node offline/test/workspace-pins.test.js
//
// Exit code 0 = all pass, 1 = any failure.

const fs = require('fs');
const path = require('path');
const pins = require('../../service/lib/workspace-pins');

let passed = 0;
let failed = 0;
const failures = [];
function check(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) { passed++; return; }
  failed++;
  failures.push(`${label}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`);
}

// ---------------------------------------------------------------------------
// 1. The rules.
// ---------------------------------------------------------------------------
check('R1 readPins: junk dropped, dupes dropped',
  pins.readPins({ pinned_workspaces: ['hub:a1', 'hub:a1', 'x:1', 7, 'folder:b2', 'hub:a_b', 'hub:'] }),
  ['hub:a1', 'folder:b2']);
check('R2 readPins: not an array', pins.readPins({ pinned_workspaces: 'hub:a1' }), []);
check('R3 readPins: no settings', pins.readPins(null), []);
check('R4 readPins: capped',
  pins.readPins({ pinned_workspaces: Array.from({ length: 150 }, (_, i) => `hub:${i}`) }).length,
  pins.MAX_PINS);

check('C1 get needs no key', pins.checkOp('get'), null);
check('C2 unknown op', pins.checkOp('drop', 'hub:a1'), 'INVALID_OP');
check('C3 pin needs a key', pins.checkOp('pin', ''), 'INVALID_KEY');
check('C4 key shape enforced', pins.checkOp('pin', 'hub:a b'), 'INVALID_KEY');
check('C5 move to end', pins.checkOp('move', 'hub:a1', ''), null);
check('C6 move bad before', pins.checkOp('move', 'hub:a1', 'nope'), 'INVALID_KEY');

const L = ['hub:a', 'hub:b', 'hub:c'];
check('O1 pin goes to the top', pins.applyOp(L, 'pin', 'hub:d'), ['hub:d', 'hub:a', 'hub:b', 'hub:c']);
check('O2 re-pin moves to the top', pins.applyOp(L, 'pin', 'hub:c'), ['hub:c', 'hub:a', 'hub:b']);
check('O3 unpin', pins.applyOp(L, 'unpin', 'hub:b'), ['hub:a', 'hub:c']);
check('O4 move before', pins.applyOp(L, 'move', 'hub:c', 'hub:a'), ['hub:c', 'hub:a', 'hub:b']);
check('O5 move to end', pins.applyOp(L, 'move', 'hub:a', ''), ['hub:b', 'hub:c', 'hub:a']);
check('O6 move unknown key', pins.applyOp(L, 'move', 'hub:z', 'hub:a'), L);
check('O7 move unknown before', pins.applyOp(L, 'move', 'hub:a', 'hub:z'), L);
check('O8 input untouched', L, ['hub:a', 'hub:b', 'hub:c']);

// ---------------------------------------------------------------------------
// 2. The service method, against a fake yp + Redis.
// ---------------------------------------------------------------------------
const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'service', 'private', 'drumate.js'), 'utf8');
const start = SRC.indexOf('\n  async pinned_workspaces() {');
const end = SRC.indexOf('\n  }\n', start);
const body = SRC.slice(start, end + 4).trim().replace(/^async pinned_workspaces\(/, 'async function pinned_workspaces(');

function makeWorker({ db, sent, input, uid = 'U1' }) {
  const RedisStore = { sendData: async (p, r) => { sent.push({ p, r }); } };
  const toArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
  const __pinQueue = makeWorker.queue;
  const fn = new Function('pins', 'toArray', 'RedisStore', '__pinQueue', `return ${body}`)(
    pins, toArray, RedisStore, __pinQueue);
  const out = {};
  const self = {
    uid,
    input: { use: (k) => input[k] },
    exception: { bad_request: (code) => { out.error = code; } },
    parseJSON: (s) => { try { return JSON.parse(s); } catch (e) { return null; } },
    payload: (data, opt) => ({ ...opt, data }),
    warn: () => {},
    output: { data: (d) => { out.data = d; } },
    yp: {
      await_proc: async (name, ...args) => {
        // A real round trip yields; that is where two requests can interleave.
        await new Promise((r) => setImmediate(r));
        if (name === 'get_entity_settings') return [{ id: uid, settings: db.settings }];
        if (name === 'entity_update_settings') { db.settings = args[1]; db.writes++; return []; }
        if (name === 'user_sockets') return [{ id: 'sock-1' }, { id: 'sock-2' }];
        throw new Error(`unexpected proc ${name}`);
      },
    },
  };
  return { run: () => fn.call(self), out };
}
makeWorker.queue = new Map();

(async () => {
  {
    // The motivating case: the server holds A's newer list; B asks to pin.
    const db = { settings: JSON.stringify({ wallpaper: 'w', pinned_workspaces: ['hub:a', 'hub:b'] }), writes: 0 };
    const sent = [];
    const w = makeWorker({ db, sent, input: { op: 'pin', key: 'hub:c' } });
    await w.run();
    const stored = JSON.parse(db.settings);
    check('S1 pin applies to the STORED list', stored.pinned_workspaces, ['hub:c', 'hub:a', 'hub:b']);
    check('S2 other settings kept', stored.wallpaper, 'w');
    check('S3 answer is the whole list', w.out.data, { pinned_workspaces: ['hub:c', 'hub:a', 'hub:b'] });
    check('S4 pushed once to every socket of the user',
      sent.map((s) => [s.p.service, s.p.data, s.r.length]),
      [['drumate.pinned_workspaces', { pinned_workspaces: ['hub:c', 'hub:a', 'hub:b'] }, 2]]);
  }
  {
    // Two devices at the same moment: both changes survive.
    const db = { settings: JSON.stringify({ pinned_workspaces: ['hub:a'] }), writes: 0 };
    const sent = [];
    const w1 = makeWorker({ db, sent, input: { op: 'pin', key: 'hub:b' } });
    const w2 = makeWorker({ db, sent, input: { op: 'pin', key: 'hub:c' } });
    await Promise.all([w1.run(), w2.run()]);
    check('S5 concurrent pins both kept', JSON.parse(db.settings).pinned_workspaces, ['hub:c', 'hub:b', 'hub:a']);
    check('S6 queue emptied', makeWorker.queue.size, 0);
  }
  {
    // Nothing changes: no write, no push.
    const db = { settings: JSON.stringify({ pinned_workspaces: ['hub:a'] }), writes: 0 };
    const sent = [];
    const w = makeWorker({ db, sent, input: { op: 'unpin', key: 'hub:zz' } });
    await w.run();
    check('S7 no-op: no write', db.writes, 0);
    check('S8 no-op: no push', sent.length, 0);
    check('S9 no-op: list answered', w.out.data, { pinned_workspaces: ['hub:a'] });
  }
  {
    const db = { settings: null, writes: 0 };
    const sent = [];
    const w = makeWorker({ db, sent, input: {} });
    await w.run();
    check('S10 get with no settings at all', w.out.data, { pinned_workspaces: [] });
    check('S11 get never writes or pushes', [db.writes, sent.length], [0, 0]);
  }
  {
    const db = { settings: '{}', writes: 0 };
    const sent = [];
    const w = makeWorker({ db, sent, input: { op: 'pin', key: "hub:x'; DROP" } });
    await w.run();
    check('S12 bad key refused before any DB work', [w.out.error, db.writes, w.out.data], ['INVALID_KEY', 0, undefined]);
  }

  for (const f of failures) console.log('  ✗ ' + f);
  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed ? 1 : 0);
})();
