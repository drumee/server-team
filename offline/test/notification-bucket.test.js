#!/usr/bin/env node
//
// notification-bucket.test.js — Round 3 / Sprint 1, Notification Center tabs.
//
// Verifies the server-side bucket mapper that decides which of the 5 tabs
// (Files / Task / Meeting / Chat / Other) a notification belongs to.
//
//   node offline/test/notification-bucket.test.js
//
// It runs the REAL mapper: the helper block is sliced out of
// service/private/activity.js and evaluated, rather than copy-pasted here. A
// copy would keep passing after the real code changed underneath it, which is
// the failure mode that makes a test worse than no test at all.
//
// Row shapes covered — every producer the service actually reads:
//   notification_center_next  → `category` (+ `meeting_action` on teamchat)
//   notification_hub_invites  → category 'hub_invite'
//   notification_contact_refused / _workspace_moves
//   secure_share_open_feed    → category 'share_open'
//   activity_get_feed_all     → `event_type` ('mfs' | 'contact'), no category
//   mfs_get_activity_feed     → NEITHER; only `event`
//   contact_*_unread procs    → contact_activity events (task / system alerts)
//
// Exit code 0 = all pass, 1 = any failure.

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Load the real helpers out of the service module.
// ---------------------------------------------------------------------------
const SERVICE_FILE = path.join(__dirname, '..', '..', 'service', 'private', 'activity.js');
const src = fs.readFileSync(SERVICE_FILE, 'utf8');

const START = '\nconst BUCKET = {';
const END_FN = '\nfunction validBucket(value) {';
const startIdx = src.indexOf(START);
const endFnIdx = src.indexOf(END_FN);
if (startIdx < 0 || endFnIdx < 0 || endFnIdx < startIdx) {
  console.error('FATAL: could not locate the bucket helper block in', SERVICE_FILE);
  console.error('The markers moved — fix this slicer, do not weaken the test.');
  process.exit(1);
}
// Extend past validBucket's own closing brace. Counting starts at that
// function's OWN `{` so a `= {}` default parameter can't be mistaken for the
// body (a real bug from an earlier harness of this shape).
let depth = 0;
let endIdx = -1;
for (let i = endFnIdx; i < src.length; i++) {
  const ch = src[i];
  if (ch === '{') depth++;
  else if (ch === '}') {
    depth--;
    if (depth === 0) { endIdx = i + 1; break; }
  }
}
if (endIdx < 0) {
  console.error('FATAL: unbalanced braces while slicing validBucket');
  process.exit(1);
}

const block = src.slice(startIdx, endIdx);
// Sanity-check that we sliced what we think we did, so a silent mis-slice can
// never masquerade as a passing run.
for (const needed of ['function bucketOf', 'function stampBuckets', 'function lookup', 'function validBucket']) {
  if (!block.includes(needed)) {
    console.error(`FATAL: sliced block is missing ${needed} — slicer is wrong`);
    process.exit(1);
  }
}

const { bucketOf, stampBuckets, validBucket, BUCKET } = (new Function(
  `${block}\nreturn { bucketOf, stampBuckets, validBucket, BUCKET };`
))();

const TABS = ['files', 'task', 'meeting', 'chat', 'other'];

// ---------------------------------------------------------------------------
// Tiny assertion harness (no test runner is wired up in this repo).
// ---------------------------------------------------------------------------
let pass = 0;
const failures = [];
function check(label, actual, expected) {
  if (actual === expected) { pass++; return; }
  failures.push(`${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
}
function ok(label, cond) { check(label, !!cond, true); }

// ---------------------------------------------------------------------------
// 1. Every real row shape maps to the right tab.
// ---------------------------------------------------------------------------
const CASES = [
  // --- Files -------------------------------------------------------------
  ['media rollup (upload)',            { category: 'media', event: 'media.new' },              'files'],
  ['media rollup, folder create',      { category: 'media', event: 'media.make_dir' },         'files'],
  ['feed row: mfs event_type',         { event_type: 'mfs', event: 'media.new' },              'files'],
  ['feed row: media.share',            { event_type: 'mfs', event: 'media.share' },            'files'],
  ['feed row: media.remove',           { event_type: 'mfs', event: 'media.remove' },           'files'],
  ['feed row: media.view',             { event_type: 'mfs', event: 'media.view' },              'files'],
  ['feed row: media.rename',           { event_type: 'mfs', event: 'media.rename' },           'files'],
  ['unread feed row (event only)',     { event: 'media.new' },                                  'files'],
  ['workspace move rollup',            { category: 'workspace_move' },                          'files'],
  ['workspace move as feed row',       { event_type: 'mfs', event: 'media.workspace_move' },   'files'],
  ['share-open row',                   { category: 'share_open', event: 'secure_share.opened' },'files'],
  ['share-open, event only',           { event: 'secure_share.opened' },                        'files'],

  // --- Task --------------------------------------------------------------
  // The whole reason the mapper is ordered: these are contact rows.
  ['task assigned (category contact)', { category: 'contact', event: 'task_assigned' },         'task'],
  ['task assigned (event_type)',       { event_type: 'contact', event: 'task_assigned' },       'task'],
  ['task mention',                     { event_type: 'contact', event: 'task_mention' },        'task'],
  ['task comment reply (task_mention)',{ event_type: 'contact', event: 'task_mention', task_kind: 'reply' }, 'task'],
  ['task column change',               { event_type: 'contact', event: 'task_column_change' },  'task'],
  ['task row with no category at all', { event: 'task_assigned' },                              'task'],

  // --- Meeting -----------------------------------------------------------
  ['teamchat rollup, meeting start',   { category: 'teamchat', meeting_action: 'start' },        'meeting'],
  ['teamchat rollup, meeting end',     { category: 'teamchat', meeting_action: 'end' },          'meeting'],
  ['client-side meeting row',          { category: 'meeting', event: 'conference.start' },       'meeting'],
  ['conference event only',            { event: 'conference.start' },                            'meeting'],
  ['scheduled meeting push',           { event: 'room.scheduled' },                              'meeting'],
  ['meeting reminder push',            { event: 'room.reminder' },                               'meeting'],

  // --- Chat --------------------------------------------------------------
  ['p2p chat rollup',                  { category: 'chat', cnt: 3 },                             'chat'],
  ['folder chat rollup (no meeting)',  { category: 'teamchat', cnt: 2 },                         'chat'],
  ['teamchat, meeting_action null',    { category: 'teamchat', meeting_action: null },            'chat'],
  ['bare mention row',                 { event: 'mention' },                                     'chat'],
  ['chat.post event',                  { event: 'chat.post' },                                   'chat'],
  ['channel.post event',               { event: 'channel.post' },                                'chat'],

  // --- Other -------------------------------------------------------------
  ['hub invite rollup',                { category: 'hub_invite' },                               'other'],
  ['hub invite as feed row',           { event_type: 'contact', event: 'hub_invite_received' },  'other'],
  ['contact invite',                   { category: 'contact', event: 'contact.invite' },         'other'],
  ['contact accepted',                 { category: 'contact', event: 'contact.accept_informed' },'other'],
  ['contact refused',                  { category: 'contact_refused' },                          'other'],
  ['support ticket',                   { category: 'ticket' },                                   'other'],
  ['secure-share access request',      { category: 'access_request' },                           'other'],
  ['storage alert (system)',           { event_type: 'contact', event: 'storage_alert' },        'other'],
  ['reward expiry (system)',           { event_type: 'contact', event: 'reward_expiry_warning' },'other'],
];

for (const [label, row, expected] of CASES) {
  check(`bucketOf: ${label}`, bucketOf(row), expected);
}

// ---------------------------------------------------------------------------
// 2. Totality — the 5 tabs must PARTITION every row. No row may be dropped,
//    and no row may land outside the tab set, or a notification becomes
//    unreachable in the UI.
// ---------------------------------------------------------------------------
for (const [label, row] of CASES.map((c) => [c[0], c[1]])) {
  ok(`is a real tab: ${label}`, TABS.includes(bucketOf(row)));
}
const covered = new Set(CASES.map((c) => c[2]));
for (const tab of TABS) {
  ok(`tab '${tab}' has at least one case`, covered.has(tab));
}

// ---------------------------------------------------------------------------
// 3. Degenerate input must never throw and never escape the tab set.
// ---------------------------------------------------------------------------
const DEGENERATE = [
  ['null row', null], ['undefined row', undefined], ['empty object', {}],
  ['unknown category', { category: 'brand_new_thing_2027' }],
  ['unknown event', { event: 'something.unheard_of' }],
  ['empty strings', { category: '', event: '', event_type: '' }],
  ['numeric category', { category: 7 }],
  ['event not a string', { event: { nope: 1 } }],
  // Prototype-chain keys: `event`/`category` come from the DB, and a plain
  // map[key] lookup would resolve these to inherited functions and stamp a
  // FUNCTION as the bucket. Guarded by lookup() — these must be 'other'.
  ['event = constructor', { event: 'constructor' }],
  ['event = toString', { event: 'toString' }],
  ['category = constructor', { category: 'constructor' }],
  ['category = hasOwnProperty', { category: 'hasOwnProperty' }],
  ['event_type = __proto__', { event_type: '__proto__' }],
];
for (const [label, row] of DEGENERATE) {
  let got;
  try { got = bucketOf(row); }
  catch (e) { failures.push(`bucketOf threw on ${label}: ${e.message}`); continue; }
  ok(`degenerate stays in the tab set: ${label}`, TABS.includes(got));
  check(`degenerate falls to other: ${label}`, got, 'other');
}

// ---------------------------------------------------------------------------
// 4. Precedence — the ordering inside bucketOf is load-bearing, so pin it.
// ---------------------------------------------------------------------------
check('task beats its contact category',
  bucketOf({ category: 'contact', event: 'task_assigned' }), 'task');
check('meeting_action beats the teamchat category',
  bucketOf({ category: 'teamchat', event: 'channel.post', meeting_action: 'start' }), 'meeting');
check('explicit category beats the event prefix',
  bucketOf({ category: 'media', event: 'chat.post' }), 'files');
check('event_type is used when category is absent',
  bucketOf({ event_type: 'mfs', event: 'unknown.thing' }), 'files');
check('a meeting_action other than start/end does not force meeting',
  bucketOf({ category: 'teamchat', meeting_action: 'weird' }), 'chat');

// ---------------------------------------------------------------------------
// 5. stampBuckets — in place, idempotent, non-destructive.
// ---------------------------------------------------------------------------
{
  const rows = [{ category: 'chat' }, { category: 'media' }, null, { category: 'hub_invite' }];
  const out = stampBuckets(rows);
  ok('stampBuckets returns the same array', out === rows);
  check('stamped chat', rows[0].bucket, 'chat');
  check('stamped media', rows[2 - 1].bucket, 'files');
  ok('null entry survives untouched', rows[2] === null);
  check('stamped hub_invite', rows[3].bucket, 'other');

  // Must not overwrite a bucket a row already carries.
  const preset = [{ category: 'chat', bucket: 'other' }];
  stampBuckets(preset);
  check('does not overwrite an existing bucket', preset[0].bucket, 'other');

  // Idempotent.
  const twice = [{ category: 'media' }];
  stampBuckets(twice); stampBuckets(twice);
  check('idempotent', twice[0].bucket, 'files');

  // Every other field is left alone — get_feed's rows carry the payload the
  // client renders from, so the stamp must be purely additive.
  const rich = [{ category: 'media', event: 'media.new', filename: 'x.pdf', cnt: 4, id: 12 }];
  stampBuckets(rich);
  check('keeps filename', rich[0].filename, 'x.pdf');
  check('keeps cnt', rich[0].cnt, 4);
  check('keeps id', rich[0].id, 12);
  check('keeps event', rich[0].event, 'media.new');
  check('adds exactly one key', Object.keys(rich[0]).length, 6);
}

// ---------------------------------------------------------------------------
// 6. validBucket — the gate that decides scoped vs unscoped. Getting this
//    wrong is the regression risk: anything it wrongly accepts silently
//    narrows a caller that never asked for a tab.
// ---------------------------------------------------------------------------
for (const tab of TABS) {
  check(`validBucket accepts '${tab}'`, validBucket(tab), tab);
}
check('trims whitespace', validBucket('  chat  '), 'chat');
for (const [label, input] of [
  ['undefined', undefined], ['null', null], ['empty', ''], ['whitespace', '   '],
  ['unknown', 'inbox'], ['wrong case', 'Files'], ['plural', 'tasks'],
  ['zero', 0], ['false', false], ['object', {}], ['array', []],
  // Same prototype-chain trap as above: these must NOT read as a valid tab, or
  // the feed would be filtered against a bucket no row can ever equal and the
  // tab would render empty.
  ['constructor', 'constructor'], ['toString', 'toString'],
  ['hasOwnProperty', 'hasOwnProperty'], ['__proto__', '__proto__'],
]) {
  check(`validBucket rejects ${label}`, validBucket(input), null);
}

// ---------------------------------------------------------------------------
// 7. Regression guard: the unscoped path must be untouched. With no bucket,
//    filtering is skipped entirely, so the row set is identical — the field is
//    additive only. This mirrors what get_feed / mark_all_read do with a null
//    bucket, and is the promise the whole change rests on.
// ---------------------------------------------------------------------------
{
  const original = CASES.map((c) => Object.assign({}, c[1]));
  const rows = CASES.map((c) => Object.assign({}, c[1]));
  stampBuckets(rows);
  const bucket = validBucket(undefined);
  const result = bucket ? rows.filter((r) => r && r.bucket === bucket) : rows;
  check('unscoped keeps every row', result.length, original.length);
  let sameOrder = true;
  let sameFields = true;
  for (let i = 0; i < original.length; i++) {
    if (result[i] !== rows[i]) sameOrder = false;
    for (const k of Object.keys(original[i])) {
      if (JSON.stringify(result[i][k]) !== JSON.stringify(original[i][k])) sameFields = false;
    }
  }
  ok('unscoped preserves order', sameOrder);
  ok('unscoped preserves every pre-existing field value', sameFields);

  // And a scoped call returns exactly the rows of that tab — no more, no less.
  for (const tab of TABS) {
    const scoped = rows.filter((r) => r && r.bucket === tab);
    const expected = CASES.filter((c) => c[2] === tab).length;
    check(`scoped '${tab}' returns only that tab`, scoped.length, expected);
    ok(`scoped '${tab}' rows all carry that bucket`, scoped.every((r) => r.bucket === tab));
  }
  const totalScoped = TABS.reduce((n, tab) => n + rows.filter((r) => r.bucket === tab).length, 0);
  check('the 5 tabs sum to the whole feed (partition, no gaps/overlap)', totalScoped, rows.length);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
console.log(`\nnotification bucket mapper — ${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error('  FAIL  ' + f);
  console.error('');
  process.exit(1);
}
console.log('  All good: the 5 tabs partition every known row shape, degenerate');
console.log('  input can never escape the tab set, and an unscoped call is');
console.log('  byte-for-byte what it was before buckets existed.\n');
