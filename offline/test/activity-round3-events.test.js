#!/usr/bin/env node
//
// activity-round3-events.test.js — the notification types Duy reported as
// missing or wrong on 2026-08-21.
//
//   node offline/test/activity-round3-events.test.js
//
// Covers the server half of:
//   4 + 7  the folder chip on task rows        → _stampTaskFolderNames
//   5/6/8  task fields for the new task kinds  → flattenTaskFields
//   9 + 10 the scheduled-meeting rollup        → isScheduleRollup /
//          meetingNoticeKeys / isCoveredByNotice / _stampMeetingRollups
//   11     the meeting lifecycle notice        → flattenMeetingNotice
//   12     the folder chat mention             → _stampChatMentions
//
// Every check runs the REAL code, sliced out of service/private/activity.js and
// evaluated against stubs. A copy-paste would keep passing after the real code
// changed underneath it, which is worse than no test.
//
// The behaviour that matters most here is what must NOT happen:
//   * a DB round trip per row instead of per distinct target;
//   * a row silently DROPPED when nothing else covers it (that would lose a
//     notification, the one failure a user can never work around);
//   * a multi-item rollup relabelled as a meeting, hiding a real upload;
//   * a lookup failure taking the whole feed down with it.
//
// Exit code 0 = all pass, 1 = any failure.

const { readFileSync } = require('fs');
const { join } = require('path');

const SRC = join(__dirname, '../../service/private/activity.js');
const src = readFileSync(SRC, 'utf8');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  ✗ ${msg}`);
}
function eq(actual, expected, msg) {
  ok(actual === expected, `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function deepEq(actual, expected, msg) {
  eq(JSON.stringify(actual), JSON.stringify(expected), msg);
}

// ── the promise plumbing + report ──────────────────────────────────────────
// The methods under test are async; collect every assertion promise so the
// report cannot print a count that omits half the file.
const pending = [];
function return_await(promise, then) {
  pending.push(Promise.resolve(promise).then(then));
}


// ── slicers ────────────────────────────────────────────────────────────────
function sliceMethod(name) {
  const start = src.indexOf(`  async ${name}(`);
  if (start < 0) throw new Error(`${name} not found in ${SRC}`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}
function sliceFn(name) {
  const start = src.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in ${SRC}`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in function ${name}`);
}

const toArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

// The pure row-shaping helpers, all evaluated from source.
const helpers = new Function(
  `${sliceFn('flattenTaskFields')}
   ${sliceFn('flattenMeetingNotice')}
   ${sliceFn('isScheduleRollup')}
   ${sliceFn('meetingNoticeKeys')}
   ${sliceFn('isCoveredByNotice')}
   return { flattenTaskFields, flattenMeetingNotice, isScheduleRollup,
            meetingNoticeKeys, isCoveredByNotice };`,
)();
const {
  flattenTaskFields, flattenMeetingNotice,
  isScheduleRollup, meetingNoticeKeys, isCoveredByNotice,
} = helpers;

// Guard against a silent mis-slice: if these ever stop being the real thing the
// whole file would pass while testing nothing.
ok(sliceFn('flattenMeetingNotice').includes("r.event !== 'meeting_notice'"),
  'sliced flattenMeetingNotice guards on the event');
ok(sliceFn('isCoveredByNotice').includes('isScheduleRollup'),
  'sliced isCoveredByNotice still delegates to isScheduleRollup');

// ── flattenTaskFields: the fields the new kinds need ──────────────────────
{
  const rows = [{
    event: 'task_mention',
    data: JSON.stringify({
      task_id: 't1', hub_id: 'h1', title: 'Ship it', nid: 'n1',
      kind: 'moved', column_key: 'in_progress', column_name: 'Doing', is_done: 0,
    }),
  }];
  flattenTaskFields(rows);
  const r = rows[0];
  eq(r.task_kind, 'moved', 'task_kind surfaced');
  eq(r.column_key, 'in_progress', 'column_key surfaced');
  eq(r.column_name, 'Doing', 'column_name surfaced');
  eq(r.task_is_done, 0, 'is_done surfaced (0 is a real value, not "absent")');
  eq(r.task_title, 'Ship it', 'title surfaced');
  eq(r.hub_id, 'h1', 'mention nav reads top-level hub_id');
  eq(r.nid, 'n1', 'mention nav reads top-level nid');

  const prio = [{ event: 'task_mention', data: { title: 'T', kind: 'priority', priority: 'urgent' } }];
  flattenTaskFields(prio);
  eq(prio[0].task_priority, 'urgent', 'priority surfaced');

  // Idempotent, and a plain mention gains none of the new fields.
  const plain = [{ event: 'task_mention', data: { title: 'T' } }];
  flattenTaskFields(plain);
  flattenTaskFields(plain);
  eq(plain[0].task_kind, undefined, 'a plain @-mention has no kind');
  eq(plain[0].task_priority, undefined, 'and no priority');
  eq(plain[0].column_key, undefined, 'and no column');

  // Never overwrites a value already on the row.
  const preset = [{ event: 'task_mention', task_priority: 'low', data: { kind: 'priority', priority: 'high' } }];
  flattenTaskFields(preset);
  eq(preset[0].task_priority, 'low', 'an existing value is never overwritten');

  // Other events are untouched.
  const other = [{ event: 'task_column_change', data: { kind: 'x', priority: 'high' } }];
  flattenTaskFields(other);
  eq(other[0].task_priority, undefined, 'task_column_change is not touched here');

  // Malformed JSON must not throw.
  const junk = [{ event: 'task_mention', data: '{not json' }, null, { event: 'task_mention' }];
  let threw = false;
  try { flattenTaskFields(junk); } catch (e) { threw = true; }
  ok(!threw, 'malformed data never throws');
}

// ── flattenMeetingNotice ──────────────────────────────────────────────────
{
  const rows = [{
    event: 'meeting_notice',
    data: JSON.stringify({
      kind: 'invite', hub_id: 'h1', nid: 'm1', pid: 'p1',
      title: 'Sprint review', stime: 1786000000, folder_name: 'Marketing',
    }),
  }];
  flattenMeetingNotice(rows);
  const r = rows[0];
  eq(r.meeting_kind, 'invite', 'kind surfaced');
  eq(r.meeting_title, 'Sprint review', 'title surfaced');
  eq(r.meeting_stime, 1786000000, 'stime surfaced');
  eq(r.meeting_nid, 'm1', 'node id surfaced');
  eq(r.meeting_pid, 'p1', 'PARENT surfaced — the click target');
  eq(r.meeting_hub_id, 'h1', 'hub surfaced');
  eq(r.folder_name, 'Marketing', 'the chip name travels with the row');

  // A cancelled meeting's node is gone by read time, which is exactly why the
  // title and folder are written at EMIT time. Prove the row survives with no
  // resolvable node.
  const cancelled = [{ event: 'meeting_notice', data: { kind: 'cancelled', title: 'Gone', pid: 'p1' } }];
  flattenMeetingNotice(cancelled);
  eq(cancelled[0].meeting_kind, 'cancelled', 'cancelled kind surfaced');
  eq(cancelled[0].meeting_title, 'Gone', 'title survives the node deletion');

  // Idempotent; other events untouched; junk safe.
  flattenMeetingNotice(rows);
  eq(rows[0].meeting_title, 'Sprint review', 'idempotent');
  // Idempotence is only meaningfully tested against a row that ALREADY carries a
  // different value — re-running over an unchanged row proves nothing.
  const preset = [{
    event: 'meeting_notice',
    meeting_title: 'Kept', meeting_kind: 'moved', meeting_stime: 7, meeting_pid: 'keep',
    data: { kind: 'invite', title: 'Overwritten', stime: 99, pid: 'other', folder_name: 'F' },
  }];
  flattenMeetingNotice(preset);
  eq(preset[0].meeting_title, 'Kept', 'an existing title is never overwritten');
  eq(preset[0].meeting_kind, 'moved', 'nor the kind');
  eq(preset[0].meeting_stime, 7, 'nor the start time');
  eq(preset[0].meeting_pid, 'keep', 'nor the click target');
  eq(preset[0].folder_name, 'F', 'but an ABSENT field is still filled in');
  const untouched = [{ event: 'task_mention', data: { title: 'T' } }];
  flattenMeetingNotice(untouched);
  eq(untouched[0].meeting_title, undefined, 'non-meeting rows untouched');
  let threw = false;
  try { flattenMeetingNotice([null, { event: 'meeting_notice', data: '{bad' }]); } catch (e) { threw = true; }
  ok(!threw, 'malformed meeting data never throws');
  const noMeta = [{ event: 'meeting_notice' }];
  flattenMeetingNotice(noMeta);
  eq(noMeta[0].meeting_title, '', 'a row with no data gets an empty title, not undefined');
}

// ── the schedule-rollup / notice dedupe ───────────────────────────────────
{
  const rollup = (over) => ({
    category: 'media', event: 'media.new', item_filetype: 'schedule',
    item_filename: 'Sprint review', hub_id: 'h1', cnt: 1, ...over,
  });
  ok(isScheduleRollup(rollup()), 'a single-item schedule rollup is recognised');
  ok(!isScheduleRollup(rollup({ cnt: 2 })), 'cnt 2 is NOT a meeting — it would hide an upload');
  ok(!isScheduleRollup(rollup({ cnt: '3' })), 'cnt arrives as a string from the driver');
  ok(isScheduleRollup(rollup({ cnt: '1' })), 'and "1" is still a single item');
  ok(isScheduleRollup(rollup({ cnt: 0 })), 'cnt 0 counts as single');
  ok(!isScheduleRollup(rollup({ item_filetype: 'document' })), 'an ordinary upload is not a meeting');
  ok(!isScheduleRollup(rollup({ category: 'teamchat' })), 'only media rollups qualify');
  ok(!isScheduleRollup(null), 'null is safe');

  const notices = [
    { event: 'meeting_notice', meeting_kind: 'invite', meeting_title: 'Sprint review', meeting_hub_id: 'h1' },
    { event: 'meeting_notice', meeting_kind: 'cancelled', meeting_title: 'Old one', meeting_hub_id: 'h1' },
    { event: 'task_mention', meeting_title: 'Not a meeting' },
  ];
  const keys = meetingNoticeKeys(notices);
  eq(keys.size, 1, 'only an INVITATION stands in for the rollup');
  ok(keys.has('h1:Sprint review'), 'keyed on hub + title');

  ok(isCoveredByNotice(rollup(), keys), 'the rollup is covered by its invitation');
  ok(!isCoveredByNotice(rollup({ hub_id: 'h2' }), keys), 'same title in another workspace is NOT covered');
  ok(!isCoveredByNotice(rollup({ item_filename: 'Other' }), keys), 'a different meeting is not covered');
  ok(!isCoveredByNotice(rollup({ cnt: 2 }), keys), 'a multi-item rollup is never dropped');
  ok(!isCoveredByNotice(rollup(), new Set()), 'no notices means nothing is covered');
  ok(!isCoveredByNotice(rollup({ item_filename: '' }), keys), 'a nameless rollup is never dropped');

  // A cancelled/rescheduled notice must NOT hide the scheduled row: they are
  // different facts, and hiding it would leave the meeting invisible.
  const onlyCancel = meetingNoticeKeys([notices[1]]);
  ok(!isCoveredByNotice(rollup({ item_filename: 'Old one' }), onlyCancel),
    'a cancellation does not stand in for the scheduled row');
}

// ── _stampTaskFolderNames ─────────────────────────────────────────────────
const TaskFolders = new Function(
  'toArray',
  `class T {
     constructor(nodes) {
       this.calls = [];
       this.debugs = [];
       const self = this;
       this.yp = { async await_proc(proc, hub, fn, quoted) {
         const id = String(quoted).replace(/'/g, '');
         self.calls.push(hub + ':' + id);
         if (nodes[hub + ':' + id] === 'THROW') throw new Error('boom');
         const v = nodes[hub + ':' + id];
         return v ? [{ filename: v }] : [];
       } };
     }
     debug(...a) { this.debugs.push(a); }
     ${sliceMethod('_stampTaskFolderNames')}
   }
   return T;`,
)(toArray);

{
  const t = new TaskFolders({ 'h1:n1': 'Marketing', 'h1:n2': 'Finance' });
  const rows = [
    { event: 'task_assigned', task_hub_id: 'h1', task_nid: 'n1' },
    { event: 'task_assigned', task_hub_id: 'h1', task_nid: 'n1' }, // same target
    { event: 'task_mention', hub_id: 'h1', nid: 'n2' },
    { event: 'task_column_change', task_hub_id: 'h1', task_nid: 'n1' },
  ];
  return_await(t._stampTaskFolderNames(rows), () => {
    eq(rows[0].folder_name, 'Marketing', 'task_assigned reads task_hub_id/task_nid');
    eq(rows[1].folder_name, 'Marketing', 'a repeated target is stamped too');
    eq(rows[2].folder_name, 'Finance', 'task_mention reads top-level hub_id/nid');
    eq(rows[3].folder_name, 'Marketing', 'task_column_change reads task_* as well');
    eq(t.calls.length, 2, 'one lookup per DISTINCT target, not per row');
  });
}

{
  // Rows that must produce NO lookup at all.
  const t = new TaskFolders({});
  const rows = [
    { event: 'task_assigned', task_hub_id: 'h1', task_nid: 'n1', folder_name: 'Already' },
    { event: 'media.new', hub_id: 'h1', nid: 'n1' },
    { event: 'task_assigned', task_hub_id: 'h1' },
    { event: 'task_assigned', task_nid: 'n1' },
    { event: 'task_assigned', task_hub_id: 'h1', task_nid: '0' },
    { event: 'task_assigned', task_hub_id: 'h1', task_nid: 'null' },
    null,
  ];
  return_await(t._stampTaskFolderNames(rows), () => {
    eq(t.calls.length, 0, 'nothing resolvable, nothing looked up');
    eq(rows[0].folder_name, 'Already', 'a resolved name is never re-resolved');
  });
}

{
  // Internal plumbing names are withheld; a failed lookup leaves no chip.
  const t = new TaskFolders({ 'h1:n1': '__chat__', 'h1:n2': 'THROW', 'h1:n3': '__upload__' });
  const rows = [
    { event: 'task_assigned', task_hub_id: 'h1', task_nid: 'n1' },
    { event: 'task_assigned', task_hub_id: 'h1', task_nid: 'n2' },
    { event: 'task_assigned', task_hub_id: 'h1', task_nid: 'n3' },
  ];
  return_await(t._stampTaskFolderNames(rows), () => {
    eq(rows[0].folder_name, undefined, '__chat__ is plumbing, not a folder');
    eq(rows[1].folder_name, undefined, 'a throwing lookup leaves the row alone');
    eq(rows[2].folder_name, undefined, '__upload__ likewise');
    eq(t.debugs.length, 1, 'the failure was logged, not raised');
  });
}

{
  // The lookup cap: 30 distinct folders must not become 30 queries.
  const nodes = {};
  const rows = [];
  for (let i = 0; i < 30; i++) {
    nodes[`h1:n${i}`] = `F${i}`;
    rows.push({ event: 'task_assigned', task_hub_id: 'h1', task_nid: `n${i}` });
  }
  const t = new TaskFolders(nodes);
  return_await(t._stampTaskFolderNames(rows), () => {
    ok(t.calls.length <= 12, `lookups capped, got ${t.calls.length}`);
    ok(rows.some((r) => r.folder_name), 'the rows within the cap are still stamped');
  });
}

// ── _stampChatMentions ────────────────────────────────────────────────────
const ChatMentions = new Function(
  'toArray',
  `class C {
     constructor(perHub) {
       this.uid = 'me';
       this.calls = [];
       this.debugs = [];
       const self = this;
       this.yp = { async await_proc(proc, hub, fn, args) {
         self.calls.push({ hub, fn, args });
         if (perHub[hub] === 'THROW') throw new Error('boom');
         return perHub[hub] || [];
       } };
     }
     debug(...a) { this.debugs.push(a); }
     ${sliceMethod('_stampChatMentions')}
   }
   return C;`,
)(toArray);

{
  const c = new ChatMentions({ h1: [{ scope_nid: 'f1' }, { scope_nid: 'null' }] });
  const rows = [
    { category: 'teamchat', hub_id: 'h1', nid: 'f1', filename: 'Marketing', folder_name: 'Marketing' },
    { category: 'teamchat', hub_id: 'h1', nid: 'f2', filename: 'Sales' },
    { category: 'teamchat', hub_id: 'h1', nid: null, filename: 'My workspace' },
    { category: 'media', hub_id: 'h1', nid: 'f1' },
  ];
  return_await(c._stampChatMentions(rows), () => {
    eq(rows[0].mentioned_in, 'Marketing', 'the mentioned folder is flagged');
    eq(rows[1].mentioned_in, undefined, 'a folder with no mention is untouched');
    eq(rows[2].mentioned_in, 'My workspace', "a hub-level mention maps to the rollup's null scope");
    eq(rows[3].mentioned_in, undefined, 'non-teamchat rows are not considered');
    eq(c.calls.length, 1, 'one call per hub');
    ok(String(c.calls[0].args).includes("'me','mention',1,1"), 'asks only for unread mentions');
  });
}

{
  // A meeting rollup must not be turned into a mention: it renders and buckets
  // as a meeting, so a mention flag there would be dead weight at best.
  const c = new ChatMentions({ h1: [{ scope_nid: 'f1' }] });
  const rows = [
    { category: 'teamchat', hub_id: 'h1', nid: 'f1', filename: 'Marketing', meeting_action: 'start' },
    { category: 'teamchat', hub_id: 'h1', nid: 'f1', filename: 'Marketing', meeting_action: 'end' },
  ];
  return_await(c._stampChatMentions(rows), () => {
    eq(rows[0].mentioned_in, undefined, 'a meeting start outranks a mention');
    eq(rows[1].mentioned_in, undefined, 'so does a meeting end');
    eq(c.calls.length, 0, 'and no lookup is even made');
  });
}

{
  // A failing hub must not take the feed with it, and must not block others.
  const c = new ChatMentions({ h1: 'THROW', h2: [{ scope_nid: 'f9' }] });
  const rows = [
    { category: 'teamchat', hub_id: 'h1', nid: 'f1', filename: 'A' },
    { category: 'teamchat', hub_id: 'h2', nid: 'f9', filename: 'B' },
  ];
  return_await(c._stampChatMentions(rows), () => {
    eq(rows[0].mentioned_in, undefined, 'the failing hub leaves its row unchanged');
    eq(rows[1].mentioned_in, 'B', 'the healthy hub still resolves');
    eq(c.debugs.length, 1, 'the failure was logged, not raised');
  });
}

{
  // No rollup with an empty name may end up with an empty sentence.
  const c = new ChatMentions({ h1: [{ scope_nid: 'f1' }] });
  const rows = [{ category: 'teamchat', hub_id: 'h1', nid: 'f1' }];
  return_await(c._stampChatMentions(rows), () => {
    ok(!('mentioned_in' in rows[0]), 'a nameless folder is not flagged at all');
  });
}

// ── _stampMeetingRollups ──────────────────────────────────────────────────
const MeetingRollups = new Function(
  'toArray', 'isScheduleRollup', 'meetingNoticeKeys', 'isCoveredByNotice',
  `class M {
     constructor(perHub) {
       this.calls = [];
       this.debugs = [];
       const self = this;
       this.yp = { async await_proc(proc, hub, fn, args) {
         self.calls.push({ hub, fn });
         if (perHub[hub] === 'THROW') throw new Error('boom');
         return perHub[hub] || [];
       } };
     }
     debug(...a) { this.debugs.push(a); }
     ${sliceMethod('_stampMeetingRollups')}
   }
   return M;`,
)(toArray, isScheduleRollup, meetingNoticeKeys, isCoveredByNotice);

{
  const m = new MeetingRollups({
    h1: [{ id: 'm1', filename: 'Sprint review', stime: 1786000000 }],
  });
  const rows = [
    { category: 'media', item_filetype: 'schedule', item_filename: 'Sprint review', hub_id: 'h1', cnt: 1 },
    { category: 'media', item_filetype: 'document', item_filename: 'x.pdf', hub_id: 'h1', cnt: 1 },
  ];
  return_await(m._stampMeetingRollups(rows), (out) => {
    eq(out.length, 2, 'nothing is dropped when no invitation covers it');
    eq(out[0].meeting_stime, 1786000000, 'the start time is resolved for the sentence');
    eq(out[0].meeting_nid, 'm1', 'and the node id, for matching');
    eq(out[1].meeting_stime, undefined, 'an ordinary upload is untouched');
    eq(m.calls.length, 1, 'one hub, one lookup');
  });
}

{
  // The row Duy asked to be REPLACED by the invitation.
  const m = new MeetingRollups({ h1: [{ id: 'm1', filename: 'Sprint review', stime: 1 }] });
  const rows = [
    { category: 'media', item_filetype: 'schedule', item_filename: 'Sprint review', hub_id: 'h1', cnt: 1 },
    { event: 'meeting_notice', meeting_kind: 'invite', meeting_title: 'Sprint review', meeting_hub_id: 'h1' },
  ];
  return_await(m._stampMeetingRollups(rows), (out) => {
    eq(out.length, 1, 'the rollup is dropped in favour of the invitation');
    eq(out[0].event, 'meeting_notice', 'and the invitation is what survives');
    eq(m.calls.length, 0, 'a dropped row needs no time resolved');
  });
}

{
  // The load-bearing safety property: with NO invitation present the rollup must
  // survive even though the viewer may well be an attendee. Dropping it on
  // attendance alone would lose the notification whenever room.js's
  // best-effort write failed.
  const m = new MeetingRollups({ h1: 'THROW' });
  const rows = [
    { category: 'media', item_filetype: 'schedule', item_filename: 'Sprint review', hub_id: 'h1', cnt: 1 },
  ];
  return_await(m._stampMeetingRollups(rows), (out) => {
    eq(out.length, 1, 'a failed lookup never drops a row');
    eq(out[0].meeting_stime, undefined, 'it just has no time to show');
    eq(m.debugs.length, 1, 'logged, not raised');
  });
}

{
  // A multi-item rollup keeps its Files behaviour and is never touched.
  const m = new MeetingRollups({ h1: [{ id: 'm1', filename: 'Sprint review', stime: 1 }] });
  const rows = [
    { category: 'media', item_filetype: 'schedule', item_filename: 'Sprint review', hub_id: 'h1', cnt: 4 },
    { event: 'meeting_notice', meeting_kind: 'invite', meeting_title: 'Sprint review', meeting_hub_id: 'h1' },
  ];
  return_await(m._stampMeetingRollups(rows), (out) => {
    eq(out.length, 2, 'cnt > 1 is never dropped');
    eq(out[0].meeting_stime, undefined, 'and never gets meeting treatment');
    eq(m.calls.length, 0, 'nor a lookup');
  });
}

{
  // Nothing to do → the SAME array back, no lookups.
  const m = new MeetingRollups({});
  const rows = [{ category: 'chat' }];
  return_await(m._stampMeetingRollups(rows), (out) => {
    ok(out === rows, 'the untouched case returns the array unchanged');
    eq(m.calls.length, 0, 'and makes no query');
  });
  return_await(m._stampMeetingRollups([]), (out) => {
    deepEq(out, [], 'an empty page is safe');
  });
  return_await(m._stampMeetingRollups(null), (out) => {
    eq(out, null, 'a null page is handed straight back');
  });
}

{
  // Two meetings, the earliest-starting title match wins (room_list_scheduled is
  // ORDER BY stime ASC). Documented ambiguity, asserted so it stays deliberate.
  const m = new MeetingRollups({
    h1: [
      { id: 'a', filename: 'Standup', stime: 100 },
      { id: 'b', filename: 'Standup', stime: 900 },
    ],
  });
  const rows = [
    { category: 'media', item_filetype: 'schedule', item_filename: 'Standup', hub_id: 'h1', cnt: 1 },
  ];
  return_await(m._stampMeetingRollups(rows), (out) => {
    eq(out[0].meeting_stime, 100, 'the earliest match wins on a duplicate title');
  });
}

// ── mark_all_read: clearing the tab the user is looking at ────────────────
//
// A notification that cannot be cleared is worse than one that never arrived,
// and each tab clears through a DIFFERENT backend: the changelog read pointer
// (Files), notification_dismiss (the rollups) and contact_activity_dismiss (the
// task + meeting events). The rules that matter:
//   * clearing Meeting must dismiss the meeting notices;
//   * clearing Meeting must NOT advance the changelog pointer, or it would mark
//     every FILE notification read as a side effect;
//   * clearing Task must not touch the meeting notices, and vice versa;
//   * an UNSCOPED call must behave exactly as it did before tabs existed.
// The guard mark_all_read now routes its optional procs through: a not-yet-
// deployed routine must be skipped after the FIRST failure, because the mariadb
// driver logs an ER_SP_DOES_NOT_EXIST (1305) line before the exception ever
// reaches our catch — 141 of them in one browsing session, measured live, and
// 1305 is exactly what the PROD alert bot reports.
function sliceGuard() {
  const start = src.indexOf('\n  async _optionalYpProc(');
  if (start < 0) throw new Error('_optionalYpProc not found');
  let d = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}' && --d === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced braces in _optionalYpProc');
}
const guardSrc = sliceGuard();
ok(guardSrc.includes('MISSING_PROCS'), 'the sliced guard consults MISSING_PROCS');
// Fresh cache per build: process-wide is right in production, but shared across
// cases here it would let one verdict silence the rest.
const mkGuard = () => (new Function(
  'toArray', 'MISSING_PROCS', 'NO_SUCH_PROC',
  `return { ${guardSrc.replace(/^\s*async /, 'async ')} };`,
))(toArray, new Set(), /does not exist|ER_SP_DOES_NOT_EXIST|\b1305\b/i)._optionalYpProc;

{
  // The guard's own contract, exercised directly.
  const calls = [];
  const ctx = {
    debug() {},
    _optionalYpProc: mkGuard(),
    yp: { async await_proc(n) {
      calls.push(n);
      if (n === 'gone') { const e = new Error('PROCEDURE yp.gone does not exist'); e.errno = 1305; throw e; }
      if (n === 'broken') throw new Error('Deadlock found when trying to get lock');
      return [{ id: 1 }];
    } },
  };
  return_await((async () => {
    deepEq(await ctx._optionalYpProc('fine'), [{ id: 1 }], 'a deployed proc returns its rows');
    deepEq(await ctx._optionalYpProc('gone'), [], 'a missing proc degrades to no rows');
    deepEq(await ctx._optionalYpProc('gone'), [], 'and again');
    eq(calls.filter((n) => n === 'gone').length, 1,
      'a missing proc is called ONCE, then never again — this is the alert-spam fix');
    let rethrown = null;
    try { await ctx._optionalYpProc('broken'); } catch (e) { rethrown = e.message; }
    ok(/Deadlock/.test(rethrown || ''),
      'a REAL error is re-thrown, never mistaken for "not deployed yet"');
    eq(calls.filter((n) => n === 'broken').length, 1, 'and a real error does not blacklist the proc');
    await ctx._optionalYpProc('broken').catch(() => {});
    eq(calls.filter((n) => n === 'broken').length, 2, 'so it is retried next time');
  })(), () => {});
}

// EVERY optional-procedure call site must go through the guard. This is a source
// assertion on purpose: the stubs in these harnesses answer either route
// identically, so behaviour cannot tell them apart — but a call site that
// bypasses the guard silently reintroduces the 1305 log spam, which is the whole
// reason the guard exists. The guard's own behaviour is covered above.
{
  const optionalProcs = [
    'contact_task_assigned_unread',
    'contact_task_mention_unread',
    'contact_task_column_change_unread',
    'contact_storage_alert_unread',
    'contact_reward_expiry_unread',
    'contact_meeting_notice_unread',
  ];
  // No optional proc may be reached through a bare yp.await_proc(proc, ...) loop.
  const bareLoops = [...src.matchAll(/await this\.yp\.await_proc\(\s*proc\s*[,)]/g)];
  eq(bareLoops.length, 0,
    'an optional proc is still being called without the 1305 guard');
  // And the one place that names the meeting proc directly must use the guard too.
  const direct = [...src.matchAll(/_optionalYpProc\('contact_meeting_notice_unread'/g)];
  ok(direct.length >= 1, 'list_task_assignments must call the meeting proc through the guard');
  ok(!/await this\.yp\.await_proc\('contact_meeting_notice_unread'/.test(src),
    'the meeting proc must never be called bare');
  // Sanity: the procs really are referenced somewhere, so this is not vacuous.
  for (const name of optionalProcs) {
    ok(src.includes(name), `${name} is no longer referenced — update this list`);
  }
}

// The real helpers, sliced from source: validBucket decides whether a caller's
// bucket is honoured at all, and bucketOf decides which tab owns each rollup.
const bucketHelpers = new Function(
  `${sliceFn('lookup')}
   ${src.slice(src.indexOf('\nconst BUCKET = {'), src.indexOf('\nfunction isScheduleRollup('))}
   ${sliceFn('isScheduleRollup')}
   ${sliceFn('validBucket')}
   ${sliceFn('bucketOf')}
   return { BUCKET, validBucket, bucketOf, lookup };`,
)();

{
  const Klass = new Function(
    'toArray', 'validBucket', 'bucketOf', 'BUCKET', 'lookup', 'GUARD',
    `class R {
       constructor(bucket, rollups) {
         this.uid = 'u1';
         this.userProcs = [];
         this.ypProcs = [];
         this.dismissed = [];
         this.captured = null;
         this._rollups = rollups || [];
         this.input = { use: (k) => (k === 'bucket' ? bucket : undefined),
                        get: () => undefined };
         this.output = { data: (o) => { this.captured = o; return o; } };
       }
       warn() {} debug() {}
       async _callUserProc(name, ...args) {
         this.userProcs.push(name);
         if (name === 'notification_center_next') return this._rollups;
         if (name === 'contact_activity_dismiss') { this.dismissed.push(args[1]); return {}; }
         if (name === 'mfs_mark_all_read') return [{ status: 'ok', last_read_id: 42 }];
         return [];
       }
       get yp() {
         const self = this;
         return { async await_proc(name) {
           self.ypProcs.push(name);
           if (/_unread$/.test(name)) return [{ id: 7 }];
           return [];
         } };
       }
       _optionalYpProc = GUARD;
       ${sliceMethod('mark_all_read')}
     }
     return R;`,
  )(toArray, bucketHelpers.validBucket, bucketHelpers.bucketOf,
    bucketHelpers.BUCKET, bucketHelpers.lookup, mkGuard());

  {
    const r = new Klass('meeting');
    return_await(r.mark_all_read(), () => {
      ok(r.ypProcs.includes('contact_meeting_notice_unread'),
        'clearing Meeting enumerates the meeting notices');
      ok(!r.ypProcs.includes('contact_task_assigned_unread'),
        'clearing Meeting leaves the task events alone');
      ok(r.dismissed.length > 0, 'and actually dismisses what it found');
      ok(!r.userProcs.includes('mfs_mark_all_read'),
        'clearing Meeting must NOT advance the changelog read pointer');
      eq(r.captured.bucket, 'meeting', 'the response names the tab it cleared');
    });
  }
  {
    const r = new Klass('task');
    return_await(r.mark_all_read(), () => {
      ok(r.ypProcs.includes('contact_task_assigned_unread'), 'Task still clears assignments');
      ok(r.ypProcs.includes('contact_task_mention_unread'), 'and mentions (the new kinds ride this)');
      ok(r.ypProcs.includes('contact_task_column_change_unread'), 'and column changes');
      ok(!r.ypProcs.includes('contact_meeting_notice_unread'),
        'Task must not clear the meeting notices');
    });
  }
  {
    // The pre-existing unscoped behaviour, unchanged: clears the changelog and
    // the rollups, and touches NO contact_activity rows.
    const r = new Klass(undefined);
    return_await(r.mark_all_read(), () => {
      ok(r.userProcs.includes('mfs_mark_all_read'), 'unscoped still clears the changelog');
      ok(!r.ypProcs.some((p) => /_unread$/.test(p)),
        'unscoped touches no contact_activity rows, exactly as before');
      eq(r.captured.bucket, null, 'and reports no bucket');
      eq(r.captured.message, 'All notifications marked as read', 'with the unchanged wording');
    });
  }
  {
    // A scheduled meeting's rollup is cleared by the MEETING tab now, not Files
    // — the tab that shows a row is the tab that clears it.
    const rollup = {
      category: 'media', item_filetype: 'schedule', item_filename: 'Sprint review',
      cnt: 1, nid: 'n1', hub_id: 'h1', last_id: 5,
    };
    const meeting = new Klass('meeting', [rollup]);
    return_await(meeting.mark_all_read(), () => {
      ok(meeting.userProcs.includes('notification_dismiss'),
        'the Meeting tab dismisses the scheduled-meeting rollup');
    });
    const files = new Klass('files', [rollup]);
    return_await(files.mark_all_read(), () => {
      ok(!files.userProcs.includes('notification_dismiss'),
        'and the Files tab no longer claims it');
    });
  }
}


Promise.all(pending).then(
  () => {
    console.log(`\nRound 3 notification events — ${pass} passed, ${fail} failed\n`);
    process.exit(fail ? 1 : 0);
  },
  (e) => {
    console.error('FATAL: harness threw', e);
    process.exit(1);
  },
);
