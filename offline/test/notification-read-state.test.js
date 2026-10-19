#!/usr/bin/env node
//
// notification-read-state.test.js — Lexis 2026-08-28: reading a notification
// must no longer remove it from the panel, and the trash button must remove it
// for good.
//
//   node offline/test/notification-read-state.test.js
//
// Covers the three service helpers that make that work:
//   _dropDeleted    — hides what the trash button removed
//   _storeRollups   — captures a live rollup so it survives being read
//   _storedRollups  — reads those captures back into renderable rows
//
// The helpers are SLICED OUT of service/private/activity.js and evaluated, not
// copy-pasted: a copy keeps passing after the real code changes underneath it,
// which is the failure mode that makes a test worse than no test at all. Same
// approach as notification-bucket.test.js.
//
// Exit code 0 = all pass, 1 = any failure.

const fs = require('fs');
const path = require('path');
const { toArray } = require('@drumee/server-essentials');

const SERVICE_FILE = path.join(__dirname, '..', '..', 'service', 'private', 'activity.js');
const src = fs.readFileSync(SERVICE_FILE, 'utf8');

// --------------------------------------------------------------------------
// Slicing
// --------------------------------------------------------------------------
// Index just PAST the closing brace of the first `{` at or after startIdx.
// Counting starts at that brace rather than at the marker so a `= {}` default
// parameter cannot be mistaken for the body.
function braceEnd(startIdx, what) {
  let depth = 0;
  for (let i = src.indexOf('{', startIdx); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return i + 1; }
  }
  console.error(`FATAL: unbalanced braces slicing ${what}`);
  process.exit(1);
}

function sliceBraced(startIdx, what) {
  return src.slice(startIdx, braceEnd(startIdx, what));
}

function sliceMethod(name) {
  const marker = `\n  async ${name}(`;
  const i = src.indexOf(marker);
  if (i < 0) {
    console.error(`FATAL: could not find method ${name} in ${SERVICE_FILE}`);
    console.error('The method moved or was renamed — fix this slicer, do not weaken the test.');
    process.exit(1);
  }
  return sliceBraced(i + 1, name);
}

// stampBuckets and its dependencies, needed because _storedRollups calls it.
const bucketStart = src.indexOf('\nconst BUCKET = {');
const validStart = src.indexOf('\nfunction validBucket(value) {');
if (bucketStart < 0 || validStart < 0 || validStart < bucketStart) {
  console.error('FATAL: could not locate the bucket helper block — fix this slicer');
  process.exit(1);
}
const bucketBlock = src.slice(bucketStart, braceEnd(validStart + 1, 'validBucket'));
if (!bucketBlock.includes('function stampBuckets')) {
  console.error('FATAL: sliced bucket block is missing stampBuckets — slicer is wrong');
  process.exit(1);
}

const ROLLUP_LINE = src.match(/const ROLLUP_CATEGORIES = new Set\(\[[^\]]*\]\);/);
if (!ROLLUP_LINE) {
  console.error('FATAL: ROLLUP_CATEGORIES not found at module scope — fix this slicer');
  process.exit(1);
}

const dropDeletedSrc = sliceMethod('_dropDeleted');
const storeRollupsSrc = sliceMethod('_storeRollups');
const storedRollupsSrc = sliceMethod('_storedRollups');
const clickedSrc = sliceMethod('_clickedRollup');
const deleteRollupSrc = sliceMethod('delete_rollup');
// Module-scope helper the alias sweep keys on.
const dismissKeyStart = src.indexOf('\nfunction rollupDismissKey(r) {');
if (dismissKeyStart < 0) {
  console.error('FATAL: rollupDismissKey not found at module scope — fix this slicer');
  process.exit(1);
}
const dismissKeySrc = sliceBraced(dismissKeyStart + 1, 'rollupDismissKey');
const supersededStart = src.indexOf('\nfunction supersededRollups(live, stored) {');
if (supersededStart < 0) {
  console.error('FATAL: supersededRollups not found at module scope — fix this slicer');
  process.exit(1);
}
const supersededSrc = sliceBraced(supersededStart + 1, 'supersededRollups');
const retireSrc = sliceMethod('_retireRollups');

// Sanity-check the slices, so a silent mis-slice can never masquerade as a pass.
const guards = [
  [dropDeletedSrc, "activity_get_deleted_ids", '_dropDeleted must call the deleted-ids proc'],
  [dropDeletedSrc, "row.event_type === 'mfs'", '_dropDeleted must discriminate on event_type'],
  [storeRollupsSrc, 'notification_rollup_put', '_storeRollups must call the put proc'],
  [storedRollupsSrc, 'notification_rollup_list', '_storedRollups must call the list proc'],
  [clickedSrc, 'rollupDismissKey', '_clickedRollup must match on the dismiss key'],
  [clickedSrc, 'last_id', '_clickedRollup must tell rows apart by last_id'],
  [deleteRollupSrc, '_clickedRollup', 'delete_rollup must resolve the clicked row'],
  [retireSrc, 'notification_rollup_delete', '_retireRollups must flag through the delete proc'],
  [supersededSrc, 'rollupDismissKey', 'supersededRollups must key on the dismiss key'],
];
for (const [blk, needle, why] of guards) {
  if (!blk.includes(needle)) { console.error(`FATAL: ${why}`); process.exit(1); }
}

const helpers = (new Function('toArray', `
  ${ROLLUP_LINE[0]}
  ${bucketBlock}
  ${dismissKeySrc}
  ${supersededSrc}
  return {
    supersededRollups,
    ${dropDeletedSrc},
    ${storeRollupsSrc},
    ${storedRollupsSrc},
    ${clickedSrc},
    ${deleteRollupSrc},
    ${retireSrc}
  };
`))(toArray);

// --------------------------------------------------------------------------
// Harness
// --------------------------------------------------------------------------
let pass = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  failures.push(`${label}\n    expected ${e}\n    actual   ${a}`);
}

// A stand-in for the service instance. `calls` records what the helper asked
// the database for, so a test can assert on the CALL as well as the result.
function fakeCtx(procImpl) {
  const calls = [];
  return {
    uid: 'u1',
    calls,
    debug() {},
    async _callUserProc(name, ...args) {
      calls.push({ name, args });
      if (typeof procImpl === 'function') return procImpl(name, ...args);
      return undefined;
    },
  };
}

(async () => {
  // ------------------------------------------------------------------
  // _dropDeleted
  // ------------------------------------------------------------------
  const rows = () => ([
    { id: 5, event_type: 'mfs', label: 'file' },
    { id: 5, event_type: 'contact', label: 'invite' },
    { id: 5, category: 'chat', label: 'rollup' },
    { id: 9, event_type: 'mfs', label: 'kept-file' },
  ]);

  // The safety property that matters most: when the procedure or its columns
  // are not there yet, await_proc returns undefined and we must filter NOTHING.
  // The alternative — treating undefined as "everything is deleted" — would
  // empty the user's panel silently.
  let ctx = fakeCtx(() => undefined);
  check('missing proc filters nothing',
    (await helpers._dropDeleted.call(ctx, rows())).map(r => r.label),
    ['file', 'invite', 'rollup', 'kept-file']);

  ctx = fakeCtx(() => { throw new Error('boom'); });
  check('throwing proc filters nothing',
    (await helpers._dropDeleted.call(ctx, rows())).map(r => r.label),
    ['file', 'invite', 'rollup', 'kept-file']);

  ctx = fakeCtx(() => []);
  check('no deletions filters nothing',
    (await helpers._dropDeleted.call(ctx, rows())).map(r => r.label),
    ['file', 'invite', 'rollup', 'kept-file']);

  // changelog ids and contact_activity ids are independent sequences, so id 5
  // exists in both. Deleting the mfs one must not take the contact one — nor
  // the rollup row, which carries no event_type at all.
  ctx = fakeCtx(() => [{ kind: 'mfs', id: 5 }]);
  check('mfs deletion hits only the mfs row',
    (await helpers._dropDeleted.call(ctx, rows())).map(r => r.label),
    ['invite', 'rollup', 'kept-file']);

  ctx = fakeCtx(() => [{ kind: 'contact', id: 5 }]);
  check('contact deletion hits only the contact row',
    (await helpers._dropDeleted.call(ctx, rows())).map(r => r.label),
    ['file', 'rollup', 'kept-file']);

  ctx = fakeCtx(() => [{ kind: 'mfs', id: 5 }, { kind: 'contact', id: 5 }]);
  check('both deletions leave the rollup untouched',
    (await helpers._dropDeleted.call(ctx, rows())).map(r => r.label),
    ['rollup', 'kept-file']);

  // The procedure returns ids as strings over the wire often enough that a
  // strict === against a number would silently filter nothing.
  ctx = fakeCtx(() => [{ kind: 'mfs', id: '9' }]);
  check('string ids still match',
    (await helpers._dropDeleted.call(ctx, rows())).map(r => r.label),
    ['file', 'invite', 'rollup']);

  // --- share_open ---------------------------------------------------------
  // These carry no usable id: the feed reports MAX(sys_id) over a GROUP, so the
  // stable identity is the (token_id, recipient_email) pair the procedure acts
  // on. A mismatch here silently un-deletes every share-open notification.
  const shareRows = () => ([
    { category: 'share_open', id: 1, token_id: 'TOK1', recipient_email: 'a@b.c', label: 'named' },
    { category: 'share_open', id: 2, token_id: 'TOK2', recipient_email: null, label: 'anonymous' },
    { category: 'share_open', id: 3, token_id: 'TOK3', recipient_email: 'x@y.z', label: 'other' },
    { category: 'share_open', id: 4, label: 'no-token' },
    { id: 1, event_type: 'mfs', label: 'unrelated-mfs' },
  ]);

  ctx = fakeCtx(() => [{ kind: 'share_open', id: 'TOK1|a@b.c' }]);
  check('a named share-open group is filtered by its token+recipient key',
    (await helpers._dropDeleted.call(ctx, shareRows())).map(r => r.label),
    ['anonymous', 'other', 'no-token', 'unrelated-mfs']);

  // The procedure writes IFNULL(recipient_email,''), so an anonymous open's key
  // ends in a bare pipe. Building it any other way never matches and the row
  // comes back from the dead on every reload.
  ctx = fakeCtx(() => [{ kind: 'share_open', id: 'TOK2|' }]);
  check('an anonymous share-open group matches on the empty recipient',
    (await helpers._dropDeleted.call(ctx, shareRows())).map(r => r.label),
    ['named', 'other', 'no-token', 'unrelated-mfs']);

  // A row with no token cannot be addressed on the server, so it must never be
  // filtered by an accidental "undefined|" key collision.
  ctx = fakeCtx(() => [{ kind: 'share_open', id: 'undefined|' }]);
  check('a share-open row with no token is never filtered',
    (await helpers._dropDeleted.call(ctx, shareRows())).map(r => r.label),
    ['named', 'anonymous', 'other', 'no-token', 'unrelated-mfs']);

  // A share-open deletion must not spill into the id-keyed categories: id 1
  // exists in both sets here.
  ctx = fakeCtx(() => [{ kind: 'share_open', id: 'TOK1|a@b.c' }]);
  check('a share-open deletion never touches an mfs row with the same id',
    (await helpers._dropDeleted.call(ctx, shareRows())).filter(r => r.label === 'unrelated-mfs').length,
    1);

  ctx = fakeCtx(() => [{ kind: 'mfs', id: 5 }]);
  check('empty input is returned as-is', await helpers._dropDeleted.call(ctx, []), []);

  // ------------------------------------------------------------------
  // _storeRollups
  // ------------------------------------------------------------------
  ctx = fakeCtx(() => ({ status: 'ok' }));
  await helpers._storeRollups.call(ctx, [
    { category: 'chat', key_id: 'p1' },
    { category: 'teamchat', key_id: 'n1' },
    { category: 'media', key_id: 'h1' },
    { category: 'ticket', key_id: 't1' },
    { category: 'contact', key_id: 'c1' },      // persists on its own
    { category: 'hub_invite', key_id: 'h9' },   // persists on its own
    { category: 'chat', key_id: null },         // unaddressable
  ]);
  check('put called once', ctx.calls.length, 1);
  check('only the four derived categories are stored',
    JSON.parse(ctx.calls[0].args[1]).map(r => `${r.category}:${r.key_id}`),
    ['chat:p1', 'teamchat:n1', 'media:h1', 'ticket:t1']);

  ctx = fakeCtx(() => ({ status: 'ok' }));
  await helpers._storeRollups.call(ctx, [{ category: 'contact', key_id: 'c1' }]);
  check('nothing storable makes no database call', ctx.calls.length, 0);

  ctx = fakeCtx(() => { throw new Error('boom'); });
  let threw = false;
  try { await helpers._storeRollups.call(ctx, [{ category: 'chat', key_id: 'p1' }]); }
  catch (e) { threw = true; }
  check('a failed capture never throws', threw, false);

  // ------------------------------------------------------------------
  // _storedRollups
  // ------------------------------------------------------------------
  ctx = fakeCtx(() => undefined);
  check('missing list proc yields no rows', await helpers._storedRollups.call(ctx), []);

  ctx = fakeCtx(() => [
    { category: 'chat', key_id: 'p1', hub_id: null, ctime: 500, payload: '{"cnt":3,"surname":"Tran"}' },
  ]);
  let out = await helpers._storedRollups.call(ctx);
  check('string payload is parsed', [out.length, out[0].cnt, out[0].surname], [1, 3, 'Tran']);
  check('column ctime is mirrored onto timestamp', [out[0].ctime, out[0].timestamp], [500, 500]);

  ctx = fakeCtx(() => [
    { category: 'chat', key_id: 'p1', ctime: 1, payload: { cnt: 2 } },
  ]);
  out = await helpers._storedRollups.call(ctx);
  check('object payload is accepted', out[0].cnt, 2);

  ctx = fakeCtx(() => [
    { category: 'chat', key_id: 'p1', ctime: 1, payload: 'not json' },
    { category: 'chat', key_id: 'p2', ctime: 2, payload: '{"cnt":1}' },
  ]);
  out = await helpers._storedRollups.call(ctx);
  check('a malformed payload is skipped, not fatal', out.map(r => r.key_id), ['p2']);

  // The store owns identity and ordering; a stale snapshot must not override
  // them, or a renamed key would resurrect under its old identity.
  ctx = fakeCtx(() => [
    { category: 'chat', key_id: 'RIGHT', ctime: 900, payload: '{"category":"WRONG","key_id":"WRONG","ctime":1}' },
  ]);
  out = await helpers._storedRollups.call(ctx);
  check('columns win over the snapshot for identity and time',
    [out[0].category, out[0].key_id, out[0].ctime], ['chat', 'RIGHT', 900]);

  // ------------------------------------------------------------------
  // delete_rollup — the trash button deletes exactly the row pressed
  // (drumee.in 2026-09-30/10-01: a row stored under an older key_id came back;
  // a chat had two rows, old key 7e4e53dc… and current key 20cdcad3…)
  // ------------------------------------------------------------------
  const delCtx = ({ input, live = [], stored = [], liveThrows, storedThrows }) => {
    const c = fakeCtx(() => [{ status: 'ok' }]);
    c.input = { need: (k) => input[k], use: (k) => input[k] };
    c.output = { data: (d) => { c.out = d; } };
    c._notificationRollups = async () => { if (liveThrows) throw new Error('boom'); return live; };
    c._storedRollups = async () => { if (storedThrows) throw new Error('boom'); return stored; };
    c._clickedRollup = helpers._clickedRollup;
    return c;
  };
  const writes = (c) => c.calls.map(x => [x.name, ...(x.name === 'notification_rollup_delete' ? x.args.slice(1) : x.args)]);
  const chatOld = { category: 'chat', key_id: '7e4e53dc7e4e53e2', drumate_id: '20cdcad320cdcad9', last_id: 1788172484 };
  const chatNew = { category: 'chat', key_id: '20cdcad320cdcad9', drumate_id: '20cdcad320cdcad9', last_id: 1790767001 };

  let dc = delCtx({
    input: { category: 'chat', key_id: '20cdcad320cdcad9', hub_id: 'h', last_id: 1788172484 },
    stored: [chatNew, chatOld],
  });
  await helpers.delete_rollup.call(dc);
  check('trash on the OLD chat row flags only its own key and moves no read pointer',
    writes(dc), [['notification_rollup_delete', 'chat', '7e4e53dc7e4e53e2']]);

  dc = delCtx({
    input: { category: 'chat', key_id: '20cdcad320cdcad9', hub_id: 'h', last_id: 1790767001 },
    stored: [chatNew, chatOld],
  });
  await helpers.delete_rollup.call(dc);
  check('trash on the NEW (read) chat row flags only its own key',
    writes(dc), [['notification_rollup_delete', 'chat', '20cdcad320cdcad9']]);

  dc = delCtx({
    input: { category: 'chat', key_id: '20cdcad320cdcad9', hub_id: 'h', last_id: 1790767001 },
    live: [chatNew], stored: [chatOld],
  });
  await helpers.delete_rollup.call(dc);
  check('trash on an UNREAD row dismisses it, then flags it',
    writes(dc), [['notification_dismiss', 'chat', '20cdcad320cdcad9', 'h', 1790767001], ['notification_rollup_delete', 'chat', '20cdcad320cdcad9']]);

  dc = delCtx({
    input: { category: 'media', key_id: '7def13177def131b', hub_id: '7d500ab67d500aba', last_id: 39 },
    stored: [{ category: 'media', key_id: '7d500ab67d500aba', nid: '7def13177def131b', last_id: 39 }],
  });
  await helpers.delete_rollup.call(dc);
  check('media copy stored under its hub key is flagged by that key',
    writes(dc), [['notification_rollup_delete', 'media', '7d500ab67d500aba']]);

  // Not identifiable -> byte-for-byte the previous behaviour.
  const legacy = [['notification_dismiss', 'media', 'n9', 'h', 5], ['notification_rollup_delete', 'media', 'n9']];
  dc = delCtx({ input: { category: 'media', key_id: 'n9', hub_id: 'h', last_id: 5 }, stored: [chatOld] });
  await helpers.delete_rollup.call(dc);
  check('nothing matches: previous behaviour', writes(dc), legacy);

  dc = delCtx({ input: { category: 'media', key_id: 'n9', hub_id: 'h', last_id: 6 },
    stored: [{ category: 'media', key_id: 'n9', nid: 'n9', last_id: 5 }] });
  await helpers.delete_rollup.call(dc);
  check('last_id moved on since the panel drew it: previous behaviour',
    writes(dc), [['notification_dismiss', 'media', 'n9', 'h', 6], ['notification_rollup_delete', 'media', 'n9']]);

  dc = delCtx({ input: { category: 'media', key_id: 'n9', hub_id: 'h', last_id: 5 }, liveThrows: true, storedThrows: true });
  await helpers.delete_rollup.call(dc);
  check('both lookups failing: previous behaviour', writes(dc), legacy);

  dc = delCtx({ input: { category: 'media', key_id: 'n9', hub_id: 'h' }, stored: [{ category: 'media', key_id: 'n9', nid: 'n9', last_id: 0 }] });
  await helpers.delete_rollup.call(dc);
  check('no last_id sent: previous behaviour',
    writes(dc), [['notification_dismiss', 'media', 'n9', 'h', 0], ['notification_rollup_delete', 'media', 'n9']]);
  check('the response is still the proc result', dc.out, { status: 'ok' });

  // ------------------------------------------------------------------
  // supersededRollups / _retireRollups — one conversation shown twice
  // ------------------------------------------------------------------
  const keys = (set) => [...set].map(r => r.key_id).sort();
  check('old chat copy is superseded by the stored copy under the peer id',
    keys(helpers.supersededRollups([], [chatNew, chatOld])), ['7e4e53dc7e4e53e2']);
  check('old chat copy is superseded by a LIVE row under the peer id',
    keys(helpers.supersededRollups([chatNew], [chatOld])), ['7e4e53dc7e4e53e2']);
  check('a lone old-keyed copy stays (only record of its notification)',
    keys(helpers.supersededRollups([], [chatOld, { category: 'media', key_id: '7d500ab67d500aba', nid: '7def13177def131b' }])), []);
  check('old media copy under the hub key is superseded by its folder row',
    keys(helpers.supersededRollups([{ category: 'media', key_id: 'f1', nid: 'f1' }], [{ category: 'media', key_id: 'hub1', nid: 'f1', hub_id: 'hub1' }])), ['hub1']);
  check('current-keyed rows are never superseded',
    keys(helpers.supersededRollups([], [chatNew, { category: 'media', key_id: 'f1', nid: 'f1' }])), []);
  check('teamchat / ticket are never touched (their dismiss key is the key_id)',
    keys(helpers.supersededRollups([{ category: 'teamchat', key_id: 'x' }], [{ category: 'teamchat', key_id: 'y', nid: 'x' }, { category: 'ticket', key_id: 't', hub_id: 'x' }])), []);
  check('another peer is not a duplicate',
    keys(helpers.supersededRollups([], [chatOld, { category: 'chat', key_id: '70ba905970ba905d', drumate_id: '70ba905970ba905d' }])), []);
  check('a media key that is another category is not a duplicate',
    keys(helpers.supersededRollups([{ category: 'chat', key_id: 'f1' }], [{ category: 'media', key_id: 'hub1', nid: 'f1' }])), []);

  let rc = fakeCtx(() => [{ status: 'ok' }]);
  await helpers._retireRollups.call(rc, new Set([chatOld]));
  check('a superseded copy is flagged by its own key',
    rc.calls.map(c => [c.name, ...c.args]), [['notification_rollup_delete', 'u1', 'chat', '7e4e53dc7e4e53e2']]);
  rc = fakeCtx(() => { throw new Error('boom'); });
  threw = false;
  try { await helpers._retireRollups.call(rc, new Set([chatOld])); } catch (e) { threw = true; }
  check('a failing retire does not throw', threw, false);
  rc = fakeCtx(() => [{ status: 'ok' }]);
  await helpers._retireRollups.call(rc, new Set());
  check('nothing superseded: no write', rc.calls.length, 0);

  // ------------------------------------------------------------------
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.error(`  FAIL: ${f}`);
    process.exit(1);
  }
  process.exit(0);
})();
