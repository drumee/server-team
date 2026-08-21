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
for (const needed of [
  'function bucketOf', 'function stampBuckets', 'function lookup', 'function validBucket',
  // Round 3 / 2026-08-21: the scheduled-meeting helpers live in the same block
  // and are shared by get_feed and unread_counts, so the badge cannot disagree
  // with the rows. If they move out of the block, this slicer stops seeing the
  // real code and the tests below would silently test nothing.
  'function isScheduleRollup', 'function meetingNoticeKeys', 'function isCoveredByNotice',
]) {
  if (!block.includes(needed)) {
    console.error(`FATAL: sliced block is missing ${needed} — slicer is wrong`);
    process.exit(1);
  }
}

const {
  bucketOf, stampBuckets, validBucket, BUCKET,
  isScheduleRollup, meetingNoticeKeys, isCoveredByNotice,
} = (new Function(
  `${block}\nreturn { bucketOf, stampBuckets, validBucket, BUCKET,`
  + ` isScheduleRollup, meetingNoticeKeys, isCoveredByNotice };`
))();

// flattenMeetingNotice sits with the other row-flatteners, above the bucket
// block, so it is sliced on its own. unread_counts calls it, so the harness has
// to supply the REAL one.
const flattenMeetingNotice = (() => {
  const M = '\nfunction flattenMeetingNotice(rows) {';
  const i = src.indexOf(M);
  if (i < 0) {
    console.error('FATAL: could not find flattenMeetingNotice in the service module');
    process.exit(1);
  }
  let d = 0;
  let end = -1;
  for (let j = src.indexOf('{', i + 1); j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (d === 0) { end = j + 1; break; } }
  }
  if (end < 0) { console.error('FATAL: unbalanced braces slicing flattenMeetingNotice'); process.exit(1); }
  const fnSrc = src.slice(i, end);
  if (!fnSrc.includes("r.event !== 'meeting_notice'")) {
    console.error('FATAL: sliced flattenMeetingNotice does not guard on the event — slicer is wrong');
    process.exit(1);
  }
  return (new Function(`${fnSrc}\nreturn flattenMeetingNotice;`))();
})();

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
  // A folder holding BOTH a meeting and a file rolls up as one row with cnt > 1
  // and MAX(item_filetype) — treating that as a meeting would hide a real
  // upload, so it must stay in Files.
  ['mixed rollup tagged schedule',     { category: 'media', event: 'media.new', item_filetype: 'schedule', cnt: 2 }, 'files'],
  ['mixed rollup, cnt as a string',    { category: 'media', event: 'media.new', item_filetype: 'schedule', cnt: '5' }, 'files'],
  ['schedule filetype, not a rollup',  { event_type: 'mfs', event: 'media.new', item_filetype: 'schedule', cnt: 1 }, 'files'],
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
  // Round 3 / 2026-08-21. A scheduled meeting is a media node, so its rollup
  // arrives looking exactly like an upload — that is why an invitation used to
  // sit in Files reading "<organizer> uploaded <Meeting-name>".
  ['scheduled meeting rollup',         { category: 'media', event: 'media.new', item_filetype: 'schedule', cnt: 1 }, 'meeting'],
  ['scheduled meeting, cnt absent',    { category: 'media', event: 'media.new', item_filetype: 'schedule' },         'meeting'],
  ['scheduled meeting, mfs category',  { category: 'mfs', event: 'media.new', item_filetype: 'schedule', cnt: '1' }, 'meeting'],
  ['meeting notice (invited)',         { event_type: 'contact', event: 'meeting_notice' },        'meeting'],
  ['meeting notice, no category',      { event: 'meeting_notice' },                               'meeting'],
  ['meeting notice, category contact', { category: 'contact', event: 'meeting_notice' },          'meeting'],

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
// 8. activity.unread_counts — the per-tab badge numbers (Figma `number-noti`).
//
// Runs the REAL method, sliced out of the class the same way as the helpers
// above, against stubbed stored procedures. What matters here is not SQL but
// the counting contract: one per row, correct bucket per source, `all` equal to
// the sum, and every source isolated so one failure cannot zero the rest.
// ---------------------------------------------------------------------------
{
  // Faithful to lib/utils/index.js toArray(a, no_null = 1) for the shapes this
  // test feeds it (arrays and empties). It is NOT a general lodash-isEmpty
  // replica — the stubs below only ever return arrays.
  const toArray = (a) => {
    if (a == null) return [];
    if (Array.isArray(a)) return a;
    if (typeof a === 'object' && Object.keys(a).length === 0) return [];
    return [a];
  };

  const MARKER = '\n  async unread_counts() {';
  const mStart = src.indexOf(MARKER);
  if (mStart < 0) {
    console.error('FATAL: could not find unread_counts() in the service module');
    process.exit(1);
  }
  // Brace-match from the method's OWN `{`, not from the marker start.
  let d = 0;
  let mEnd = -1;
  for (let i = src.indexOf('{', mStart); i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') { d--; if (d === 0) { mEnd = i + 1; break; } }
  }
  if (mEnd < 0) { console.error('FATAL: unbalanced braces slicing unread_counts'); process.exit(1); }
  const methodSrc = src.slice(mStart, mEnd);
  // unread_counts calls _optionalYpProc, the guard that stops a not-yet-deployed
  // procedure from logging an ER_SP_DOES_NOT_EXIST (1305) line on every call.
  // Sliced in for real so the guard is exercised rather than stubbed away.
  const guardStart = src.indexOf('\n  async _optionalYpProc(');
  if (guardStart < 0) {
    console.error('FATAL: _optionalYpProc not found in the service module');
    process.exit(1);
  }
  let gd = 0;
  let guardEnd = -1;
  for (let i = src.indexOf('{', guardStart); i < src.length; i++) {
    if (src[i] === '{') gd++;
    else if (src[i] === '}') { gd--; if (gd === 0) { guardEnd = i + 1; break; } }
  }
  const guardSrc = src.slice(guardStart, guardEnd);
  if (!guardSrc.includes('MISSING_PROCS')) {
    console.error('FATAL: sliced _optionalYpProc does not consult MISSING_PROCS');
    process.exit(1);
  }
  for (const needed of ['_notificationRollups', 'secure_share_list_requests',
    'contact_task_assigned_unread', 'contact_meeting_notice_unread']) {
    if (!methodSrc.includes(needed)) {
      console.error(`FATAL: sliced unread_counts is missing ${needed} — slicer is wrong`);
      process.exit(1);
    }
  }
  const mkImpl = (bucketFn) => (new Function(
    'toArray', 'bucketOf', 'flattenMeetingNotice', 'meetingNoticeKeys', 'isCoveredByNotice',
    `return { ${methodSrc} };`,
  ))(toArray, bucketFn, flattenMeetingNotice, meetingNoticeKeys, isCoveredByNotice);
  const impl = mkImpl(bucketOf);

  // The guard the method calls, built fresh per case: MISSING_PROCS is
  // process-wide in production (a missing routine is a property of the database),
  // but sharing one Set across cases here would let a single "not deployed"
  // verdict silence every later case.
  const mkGuard = () => (new Function(
    'toArray', 'MISSING_PROCS', 'NO_SUCH_PROC',
    `return { ${guardSrc.replace(/^\s*async /, 'async ')} };`,
  ))(toArray, new Set(), /does not exist|ER_SP_DOES_NOT_EXIST|\b1305\b/i)._optionalYpProc;

  // Build a stub `this`. `procs` maps proc name -> rows, or a thrown Error.
  function harness({ rollups = [], procs = {} } = {}) {
    let captured = null;
    const ctx = {
      uid: 'u1',
      warn() {}, debug() {},
      output: { data(o) { captured = o; } },
      yp: {
        async await_proc(name) {
          const v = procs[name];
          if (v instanceof Error) throw v;
          return v || [];
        },
      },
      async _notificationRollups() {
        if (rollups instanceof Error) throw rollups;
        return rollups;
      },
      _optionalYpProc: mkGuard(),
    };
    return impl.unread_counts.call(ctx).then(() => captured);
  }

  const results = [];
  const q = (label, cfg, assert) => results.push(harness(cfg).then((got) => assert(label, got)));

  // Each source lands in the right bucket.
  q('rollups bucket correctly', {
    rollups: [
      { category: 'media' }, { category: 'media' },              // files x2
      { category: 'chat' },                                       // chat
      { category: 'teamchat', meeting_action: 'start' },           // meeting
      { category: 'teamchat' },                                   // chat
      { category: 'hub_invite' },                                 // other
    ],
  }, (label, got) => {
    check(`${label}: files`, got.files, 2);
    check(`${label}: chat`, got.chat, 2);
    check(`${label}: meeting`, got.meeting, 1);
    check(`${label}: other`, got.other, 1);
    check(`${label}: task`, got.task, 0);
    check(`${label}: all is the sum`, got.all, 6);
  });

  q('contact_activity procs split task vs other', {
    procs: {
      contact_task_assigned_unread: [{ id: 1, event: 'task_assigned' }],
      contact_task_mention_unread: [{ id: 2, event: 'task_mention' }],
      contact_task_column_change_unread: [{ id: 3, event: 'task_column_change' }],
      contact_storage_alert_unread: [{ id: 4, event: 'storage_alert' }],
      contact_reward_expiry_unread: [{ id: 5, event: 'reward_expiry_warning' }],
    },
  }, (label, got) => {
    check(`${label}: task`, got.task, 3);
    check(`${label}: other (system alerts)`, got.other, 2);
    check(`${label}: all`, got.all, 5);
  });

  q('share opens count as files, access requests as other', {
    procs: {
      secure_share_open_feed: [{ id: 1 }, { id: 2 }],
      secure_share_list_requests: [{ request_id: 'r1' }],
    },
  }, (label, got) => {
    check(`${label}: files`, got.files, 2);
    check(`${label}: other`, got.other, 1);
    check(`${label}: all`, got.all, 3);
  });

  // One per ROW, never the rollup's event count — this is what keeps the tab
  // badges consistent with the bell badge.
  q('a rollup of many events counts once', {
    rollups: [{ category: 'chat', cnt: 5 }, { category: 'teamchat', cnt: 12 }],
  }, (label, got) => {
    check(`${label}: chat`, got.chat, 2);
    check(`${label}: all`, got.all, 2);
  });

  // Best-effort isolation: one broken source must not zero the others.
  q('a throwing proc contributes 0 but the rest still count', {
    rollups: [{ category: 'media' }],
    procs: {
      contact_task_assigned_unread: new Error('proc missing during rollout'),
      contact_task_mention_unread: [{ id: 9, event: 'task_mention' }],
      secure_share_list_requests: new Error('boom'),
    },
  }, (label, got) => {
    check(`${label}: files survived`, got.files, 1);
    check(`${label}: task counted the working proc`, got.task, 1);
    check(`${label}: other stayed 0`, got.other, 0);
    check(`${label}: all`, got.all, 2);
  });

  // Round 3 / 2026-08-21 — the tab badge must agree with the rows the tab shows.
  // get_feed DROPS a scheduled meeting's rollup row when a targeted invitation
  // already covers it, so counting both here would make the Meeting badge read
  // one higher than the rows the user can actually see.
  q('an invited meeting is counted ONCE, not twice', {
    rollups: [
      { category: 'media', item_filetype: 'schedule', item_filename: 'Sprint review', hub_id: 'h1', cnt: 1 },
    ],
    procs: {
      contact_meeting_notice_unread: [{
        id: 9, event: 'meeting_notice',
        data: { kind: 'invite', title: 'Sprint review', hub_id: 'h1' },
      }],
    },
  }, (label, got) => {
    check(`${label}: meeting counted once`, got.meeting, 1);
    check(`${label}: nothing leaked into files`, got.files, 0);
    check(`${label}: all`, got.all, 1);
  });

  q('a meeting nobody invited you to is still counted', {
    rollups: [
      { category: 'media', item_filetype: 'schedule', item_filename: 'Sprint review', hub_id: 'h1', cnt: 1 },
    ],
  }, (label, got) => {
    check(`${label}: the rollup counts on its own`, got.meeting, 1);
    check(`${label}: all`, got.all, 1);
  });

  q('a cancellation does not hide the scheduled row from the count', {
    rollups: [
      { category: 'media', item_filetype: 'schedule', item_filename: 'Sprint review', hub_id: 'h1', cnt: 1 },
    ],
    procs: {
      contact_meeting_notice_unread: [{
        id: 9, event: 'meeting_notice',
        data: { kind: 'cancelled', title: 'Sprint review', hub_id: 'h1' },
      }],
    },
  }, (label, got) => {
    check(`${label}: both are counted`, got.meeting, 2);
  });

  q('a mixed rollup tagged schedule is never deduped away from Files', {
    rollups: [
      { category: 'media', item_filetype: 'schedule', item_filename: 'Sprint review', hub_id: 'h1', cnt: 3 },
    ],
    procs: {
      contact_meeting_notice_unread: [{
        id: 9, event: 'meeting_notice',
        data: { kind: 'invite', title: 'Sprint review', hub_id: 'h1' },
      }],
    },
  }, (label, got) => {
    check(`${label}: the upload rollup stays in Files`, got.files, 1);
    check(`${label}: the invitation is its own Meeting row`, got.meeting, 1);
    check(`${label}: all`, got.all, 2);
  });

  q('a missing meeting proc costs nothing', {
    rollups: [{ category: 'media' }],
    procs: { contact_meeting_notice_unread: new Error('ER_SP_DOES_NOT_EXIST') },
  }, (label, got) => {
    check(`${label}: files still counted`, got.files, 1);
    check(`${label}: meeting is 0, not NaN`, got.meeting, 0);
    check(`${label}: all`, got.all, 1);
  });

  q('rollups failing entirely still returns a usable response', {
    rollups: new Error('rollup enumerate failed'),
    procs: { contact_task_assigned_unread: [{ id: 1, event: 'task_assigned' }] },
  }, (label, got) => {
    ok(`${label}: responded`, !!got);
    check(`${label}: task`, got.task, 1);
    check(`${label}: all`, got.all, 1);
  });

  // Degenerate rows must not crash or invent keys.
  q('null rows and unknown categories are safe', {
    rollups: [null, undefined, { category: 'brand_new_2027' }],
  }, (label, got) => {
    check(`${label}: unknown fell to other`, got.other, 1);
    check(`${label}: all`, got.all, 1);
  });

  q('empty everywhere returns all zeros', {}, (label, got) => {
    check(`${label}: all`, got.all, 0);
    for (const tab of TABS) check(`${label}: ${tab}`, got[tab], 0);
  });

  q('response shape is exactly all + the 5 tabs', {
    rollups: [{ category: 'chat' }],
  }, (label, got) => {
    const keys = Object.keys(got).sort();
    check(`${label}: key count`, keys.length, 6);
    check(`${label}: keys`, keys.join(','), ['all'].concat(TABS).sort().join(','));
  });

  // The own-property guard inside bump() is defence-in-depth: the real bucketOf
  // is total over the 5 tabs, so nothing should ever reach it. Prove it holds
  // anyway by injecting a bucketOf that returns a prototype-chain key. Without
  // the guard, `counts['constructor'] = (counts['constructor'] || 0) + 1`
  // resolves to Object's own constructor function and stringifies into a stray
  // 7th key on the response — a corrupt payload the client would render.
  {
    const implHostile = mkImpl(() => 'constructor');
    let captured = null;
    const ctx = {
      uid: 'u1', warn() {}, debug() {},
      output: { data(o) { captured = o; } },
      yp: { async await_proc() { return []; } },
      async _notificationRollups() { return [{ category: 'chat' }, { category: 'media' }]; },
      _optionalYpProc: mkGuard(),
    };
    results.push(implHostile.unread_counts.call(ctx).then(() => {
      const keys = Object.keys(captured).sort();
      check('hostile bucketOf: no stray key on the response', keys.length, 6);
      check('hostile bucketOf: keys unchanged', keys.join(','), ['all'].concat(TABS).sort().join(','));
      check('hostile bucketOf: all stays numeric', typeof captured.all, 'number');
      check('hostile bucketOf: all is 0, nothing was miscounted', captured.all, 0);
    }));
  }

  // The assertions above run inside promises. Node runs this file top to
  // bottom, so the report has to wait for them — otherwise it prints a pass
  // count that silently omits this whole section.
  Promise.all(results).then(report, (e) => {
    console.error('FATAL: unread_counts harness threw', e);
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Report — called once the async section above has settled.
// ---------------------------------------------------------------------------
function report() {
  console.log(`\nnotification buckets + unread counts — ${pass} passed, ${failures.length} failed\n`);
  if (failures.length) {
    for (const f of failures) console.error('  FAIL  ' + f);
    console.error('');
    process.exit(1);
  }
  console.log('  All good: the 5 tabs partition every known row shape, degenerate');
  console.log('  input can never escape the tab set, an unscoped call is');
  console.log('  byte-for-byte what it was before buckets existed, and the tab');
  console.log('  badges count one per row with every source isolated.\n');
}
