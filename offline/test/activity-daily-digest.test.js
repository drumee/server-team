#!/usr/bin/env node
//
// activity-daily-digest.test.js — Round 3 Phase 4, the once-a-day card.
//
//   node offline/test/activity-daily-digest.test.js
//
// The card shows three numbers that have no single-workspace source, so
// activity.daily_digest fans out across every workspace the desk belongs to
// and sums. What is worth defending:
//
//   · RECURRING MEETINGS MUST BE EXPANDED, NOT COUNTED. room_list_scheduled
//     returns every recurring meeting regardless of the window it was asked
//     for — deliberately, so the client can expand occurrences. Counting its
//     rows would report a weekly stand-up as "today" every day of the year.
//   · metadata.content IS DOUBLE-ENCODED. A single JSON.parse leaves `content`
//     a string, `.recur` reads undefined off it with no error, and every
//     recurring meeting silently becomes a one-off. The proc's own header
//     warns about this; the client's expander parses twice.
//   · `day` REACHES SQL THROUGH forward_proc, which builds a dynamic
//     statement out of an argument string. It is user input. It must be
//     rejected on pattern, never escaped or coerced — this is the one place in
//     the card where a mistake is a security bug rather than a wrong number.
//   · A WORKSPACE THAT FAILS CONTRIBUTES ZERO, it does not fail the card.
//     await_proc returns undefined rather than throwing, so an unmigrated
//     workspace must simply add nothing.
//
// It runs the REAL code: the method and both helpers are sliced out of
// service/private/activity.js and evaluated.
//
// Exit code 0 = all pass, 1 = any failure.

const { readFileSync } = require('fs');
const { join } = require('path');

const SRC = join(__dirname, '../../service/private/activity.js');
const src = readFileSync(SRC, 'utf8');
const ACL = JSON.parse(readFileSync(join(__dirname, '../../acl/activity.json'), 'utf8'));

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; return; } fail++; console.log(`  ✗ ${msg}`); }
function eq(a, b, msg) { ok(a === b, `${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function deq(a, b, msg) { eq(JSON.stringify(a), JSON.stringify(b), msg); }

function sliceMethod(name) {
  let start = src.indexOf(`\n  async ${name}(`);
  if (start < 0) start = src.indexOf(`\n  ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  start += 1;
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}
function sliceFunction(name) {
  const start = src.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start + 1, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const toArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

// The two pure helpers, exactly as shipped.
const { countMeetingsInWindow, meetingContent } = new Function(
  `${sliceFunction('meetingContent')}
   ${sliceFunction('addPeriods')}
   ${sliceFunction('countMeetingsInWindow')}
   return { countMeetingsInWindow, meetingContent };`,
)();

// countMeetingsInWindow is a module-scope helper the method calls; it must be
// injected or the method's own reference to it is a ReferenceError. That is
// exactly how the first run of this test failed — and, because the catch was
// then wide enough to swallow it, the failure surfaced as a quiet "0 meetings"
// rather than an error. The catch has since been narrowed to the round trip.
const { sqlString } = require('../../service/lib/sql-literal');
const { countDayTasks, takesPartIn } = require('../../service/lib/day-tasks');
const Holder = new Function(
  'toArray', 'countMeetingsInWindow', 'sqlString', 'countDayTasks', 'takesPartIn', 'meetingContent',
  `class Holder {
     constructor(opt) {
       opt = opt || {};
       this.uid = 'ME';
       this.input = { use: (k, d) => (opt.input && k in opt.input ? opt.input[k] : d) };
       this.sent = undefined;
       this.exceptions = [];
       this.calls = [];
       this.debugs = [];
       const self = this;
       this.output = { data(d) { self.sent = d; }, list(d) { self.sent = d; } };
       this.exception = { user(c) { self.exceptions.push(c); return c; } };
       this._workspaces = opt.workspaces || [];
       this._answers = opt.answers || {};
       this.yp = {
         async await_proc(proc, hubId, name, args) {
           self.calls.push({ proc, hubId, name, args });
           const per = self._answers[hubId] || {};
           return per[name];
         },
       };
     }
     debug(...a) { this.debugs.push(a); }
     async _callUserProc(name) { this.calls.push({ userProc: name }); return this._workspaces; }
     ${sliceMethod('daily_digest')}
   }
   return Holder;`,
)(toArray, countMeetingsInWindow, sqlString, countDayTasks, takesPartIn, meetingContent);

// 2026-08-27 UTC
const DAY = '2026-08-27';
const START = Math.floor(Date.UTC(2026, 7, 27, 0, 0, 0) / 1000);
const END = START + 86400;
const at = (y, mo, d, h) => Math.floor(Date.UTC(y, mo - 1, d, h) / 1000);

// room_list_scheduled row shape: metadata is JSON whose `content` is a JSON STRING.
// Organized by the caller ('ME') unless `who` says otherwise.
const room = (stime, recur, until, who) => ({
  id: 'n' + stime,
  stime,
  metadata: JSON.stringify({
    content: JSON.stringify({
      stime, title: 't', created_by: 'ME', attendees: [],
      ...(who || {}),
      ...(recur ? { recur: { freq: recur, ...(until ? { until } : {}) } } : {}),
    }),
  }),
});
// task_list_range row shape. Workspace tasks carry their assignees; a personal
// task has none.
const task = (id, extra) => ({ id, title: id, due_date: '2026-08-27', status: 'todo', status_is_done: 0, assignee_uids: 'ME', ...(extra || {}) });

(async () => {
  // ── 1. the double-encoded metadata ───────────────────────────────────────
  console.log('\n1. metadata parsing');
  {
    const c = meetingContent(room(START, 'weekly'));
    eq(c.stime, START, 'content.stime is reachable');
    ok(c.recur && c.recur.freq === 'weekly', 'content.recur survives the SECOND parse — one parse leaves content a string and .recur undefined');
    deq(meetingContent({ metadata: 'not json' }), {}, 'garbage metadata yields {}, never throws');
    deq(meetingContent({}), {}, 'absent metadata yields {}');
    deq(meetingContent({ metadata: JSON.stringify({ content: 'not json' }) }), {}, 'garbage inner content yields {}');
  }

  // ── 2. one-off meetings ──────────────────────────────────────────────────
  console.log('\n2. one-off meetings');
  {
    eq(countMeetingsInWindow([room(at(2026, 8, 27, 9))], START, END), 1, 'inside the day counts');
    eq(countMeetingsInWindow([room(at(2026, 8, 26, 9))], START, END), 0, 'yesterday does not');
    eq(countMeetingsInWindow([room(at(2026, 8, 28, 9))], START, END), 0, 'tomorrow does not');
    eq(countMeetingsInWindow([room(START)], START, END), 1, 'exactly at the start counts');
    eq(countMeetingsInWindow([room(END)], START, END), 0, 'exactly at the end does not — the window is half-open');
    eq(countMeetingsInWindow([{ id: 'x', metadata: '{}' }], START, END), 0, 'a node with no epoch is skipped, not guessed');
    eq(countMeetingsInWindow([], START, END), 0, 'no rows');
    eq(countMeetingsInWindow(null, START, END), 0, 'null rows');
    eq(countMeetingsInWindow([room(START)], END, START), 0, 'an inverted window counts nothing');
  }

  // ── 3. THE POINT — recurring meetings are expanded, not counted ──────────
  console.log('\n3. recurrence');
  {
    // A daily stand-up that started long ago: exactly ONE occurrence today.
    eq(countMeetingsInWindow([room(at(2026, 1, 5, 9), 'daily')], START, END), 1,
      'a daily series started in January counts ONCE today');
    // Weekly, started 2026-08-27 is a Thursday; 7 days earlier is also Thursday.
    eq(countMeetingsInWindow([room(at(2026, 8, 20, 9), 'weekly')], START, END), 1,
      'a weekly series on the same weekday counts today');
    eq(countMeetingsInWindow([room(at(2026, 8, 21, 9), 'weekly')], START, END), 0,
      'a weekly series on a DIFFERENT weekday does not');
    // Monthly on the 27th.
    eq(countMeetingsInWindow([room(at(2026, 6, 27, 9), 'monthly')], START, END), 1,
      'a monthly series on the 27th counts today');
    eq(countMeetingsInWindow([room(at(2026, 6, 15, 9), 'monthly')], START, END), 0,
      'a monthly series on the 15th does not');
    // A series that has ended.
    eq(countMeetingsInWindow([room(at(2026, 1, 5, 9), 'daily', at(2026, 6, 1, 9))], START, END), 0,
      'a series whose `until` has passed counts nothing');
    eq(countMeetingsInWindow([room(at(2026, 1, 5, 9), 'daily', at(2026, 12, 1, 9))], START, END), 1,
      'a series still running counts');
    // A series that has not started.
    eq(countMeetingsInWindow([room(at(2026, 9, 5, 9), 'daily')], START, END), 0,
      'a series starting in the future counts nothing today');
    // Unknown frequency is treated as a one-off rather than repeated forever.
    // This case DISCRIMINATES: addPeriods falls through to a MONTHLY step for
    // any unrecognised frequency, so a series starting on the 27th would land
    // on today if unknown frequencies were expanded. An earlier version of
    // this test started the series on the 5th, where monthly expansion misses
    // today anyway — so it passed whether or not the guard was there. A
    // mutation run is what exposed that.
    eq(countMeetingsInWindow([room(at(2026, 6, 27, 9), 'fortnightly')], START, END), 0,
      'an unknown frequency is NOT expanded, even when a monthly step would have landed on today');
    eq(countMeetingsInWindow([room(at(2026, 1, 5, 9), 'fortnightly')], START, END), 0,
      'an unknown frequency starting on another date counts nothing either');
    eq(countMeetingsInWindow([room(at(2026, 8, 27, 9), 'fortnightly')], START, END), 1,
      '...but its own start date still counts');
    // The bug this whole function exists to prevent.
    const naive = [room(at(2026, 1, 5, 9), 'daily'), room(at(2026, 1, 6, 10), 'weekly'), room(at(2020, 1, 1, 9), 'monthly')].length;
    eq(naive, 3, 'a naive row count would say 3...');
    ok(countMeetingsInWindow([room(at(2026, 1, 5, 9), 'daily'), room(at(2026, 1, 6, 10), 'weekly'), room(at(2020, 1, 1, 9), 'monthly')], START, END) < naive,
      '...and the expander says fewer, because only some recur onto this day');
  }

  // ── 4. `day` is validated, not escaped ───────────────────────────────────
  console.log('\n4. day validation');
  {
    for (const bad of [
      "2026-08-27','x", "'; DROP", '2026-8-27', '20260827', '', 'today',
      "2026-08-27' UNION SELECT", '2026-08-270',
    ]) {
      const h = new Holder({ input: { day: bad, stime: START, etime: END } });
      await h.daily_digest();
      deq(h.exceptions, ['INVALID_DAY'], `rejects ${JSON.stringify(bad)}`);
      eq(h.calls.length, 0, `${JSON.stringify(bad)} never reaches a proc`);
    }
    // A well-formed day is accepted.
    const good = new Holder({ input: { day: DAY, stime: START, etime: END } });
    await good.daily_digest();
    deq(good.exceptions, [], 'a real date is accepted');
    // And an unusable window is refused too.
    for (const [s, e, label] of [[END, START, 'inverted'], [START, START, 'empty'], [0, 0, 'absent']]) {
      const h = new Holder({ input: { day: DAY, stime: s, etime: e } });
      await h.daily_digest();
      deq(h.exceptions, ['INVALID_DAY'], `rejects an ${label} window`);
    }
  }

  // ── 5. the fan-out sums, and tolerates a broken workspace ────────────────
  console.log('\n5. the fan-out');
  {
    const h = new Holder({
      input: { day: DAY, stime: START, etime: END },
      workspaces: [
        { hub_id: 'H1', area: 'private' },
        { hub_id: 'H2', area: 'private' },
        { hub_id: 'H3', area: 'private' },
      ],
      answers: {
        // hub_daily_counts' own due_tasks (overdue + subtasks) is NOT read any more.
        H1: { hub_daily_counts: [{ unread_messages: 5, due_tasks: 99 }], task_list_range: [task('a'), task('b')], room_list_scheduled: [room(at(2026, 8, 27, 9))] },
        H2: { hub_daily_counts: [{ unread_messages: 30, due_tasks: 99 }], task_list_range: [task('c'), task('d'), task('e')], room_list_scheduled: [room(at(2026, 1, 5, 9), 'daily')] },
        // H3 answers nothing at all — an unmigrated workspace.
        H3: {},
      },
    });
    await h.daily_digest();
    deq(h.exceptions, [], 'no exception');
    eq(h.sent.unread_messages, 35, 'unread messages are summed across workspaces');
    eq(h.sent.due_tasks, 5, "today's tasks are summed from task_list_range, not hub_daily_counts");
    eq(h.sent.meetings, 2, 'meetings are summed, with the daily series counted once');
    eq(h.sent.workspaces, 3, 'reports how many workspaces were summed');
    eq(h.sent.truncated, 0, 'not truncated');
    // The workspace that answered nothing must not have broken anything.
    ok(h.sent.unread_messages === 35 && h.sent.due_tasks === 5,
      'a workspace that answers undefined contributes zero rather than failing the card');
    // uid comes from the session and is passed through, with the validated day.
    const countCall = h.calls.find((c) => c.name === 'hub_daily_counts');
    eq(countCall.args, `'ME','${DAY}'`, 'uid and the validated day are what reach the proc');
    const taskCall = h.calls.find((c) => c.name === 'task_list_range' && c.hubId === 'H1');
    eq(taskCall.args, `'${DAY}','${DAY}'`, 'task_list_range is asked for exactly ONE day: the validated one');
    ok(h.calls.some((c) => c.userProc === 'desk_my_workspaces'),
      'workspaces come from desk_my_workspaces — the desk register, which includes JOINED workspaces');
  }

  // ── 5b. the counted areas are EXACTLY the sidebar's ──────────────────────
  console.log('\n5b. area filtering');
  {
    const h = new Holder({
      input: { day: DAY, stime: START, etime: END },
      workspaces: [
        { hub_id: 'A1', area: 'private' },
        { hub_id: 'A2', area: 'public' },
        { hub_id: 'A3', area: 'share' },
        { hub_id: 'A4', area: 'restricted' },
        { hub_id: 'D1', area: 'dmz' },
        { hub_id: 'PL', area: 'pool' },
        { hub_id: 'PE', area: 'personal' },
        { hub_id: 'N1' },
      ],
      answers: {
        A1: { hub_daily_counts: [{ unread_messages: 1, due_tasks: 0 }], task_list_range: [task('a1')] },
        A2: { hub_daily_counts: [{ unread_messages: 2, due_tasks: 0 }] },
        A3: { hub_daily_counts: [{ unread_messages: 4, due_tasks: 0 }], task_list_range: [task('a3'), task('a3b')] },
        A4: { hub_daily_counts: [{ unread_messages: 8, due_tasks: 0 }] },
        D1: { hub_daily_counts: [{ unread_messages: 100, due_tasks: 100 }], task_list_range: [task('D1')] },
        PL: { hub_daily_counts: [{ unread_messages: 100, due_tasks: 100 }], task_list_range: [task('PL')] },
        PE: { hub_daily_counts: [{ unread_messages: 100, due_tasks: 100 }], task_list_range: [task('PE')] },
        N1: { hub_daily_counts: [{ unread_messages: 100, due_tasks: 100 }], task_list_range: [task('N1')] },
      },
    });
    await h.daily_digest();
    eq(h.sent.workspaces, 4, 'share, private, restricted and public all count');
    eq(h.sent.unread_messages, 15, 'summed across every collaborative area');
    eq(h.sent.due_tasks, 3, 'tasks likewise');
    // 'share' is the one that matters: it is a COLLABORATIVE area the sidebar
    // lists, and on a real account it is 20 of 48 workspaces. Counting only
    // private+public under-reported by more than a third and made the card
    // disagree with the list the user is looking at.
    ok(h.calls.some((c) => c.hubId === 'A3'), "a 'share' workspace IS counted — the sidebar lists it");
    ok(h.calls.some((c) => c.hubId === 'A4'), "so is 'restricted'");
    for (const skipped of ['D1', 'PL', 'PE', 'N1']) {
      ok(!h.calls.some((c) => c.hubId === skipped),
        `${skipped} is not a workspace and is never even queried`);
    }
  }

  // ── 5c. the gate must not drift from the client's ────────────────────────
  console.log('\n5c. the gate matches the sidebar');
  {
    // modules/desk/workspace-list/index.js decides what a person sees listed
    // as a workspace, with /^(share|private|restricted|public)$/. desk.home
    // and mfs_show_node_by apply no area filter at all, so that regex is the
    // only gate — and this one must equal it, or the tile disagrees with the
    // list beside it.
    const m = /const COUNTED_AREAS = \[([^\]]*)\]/.exec(src);
    ok(m, 'COUNTED_AREAS parses');
    const got = [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]).sort();
    deq(got, ['private', 'public', 'restricted', 'share'], 'exactly the sidebar gate, no more and no less');
  }

  // ── 6. the workspace cap is reported, not silent ─────────────────────────
  console.log('\n6. the cap');
  {
    const many = [];
    for (let i = 0; i < 75; i++) many.push({ hub_id: 'H' + i, area: 'private' });
    const answers = {};
    for (const w of many) answers[w.hub_id] = { hub_daily_counts: [{ unread_messages: 1, due_tasks: 0 }] };
    const h = new Holder({ input: { day: DAY, stime: START, etime: END }, workspaces: many, answers });
    await h.daily_digest();
    eq(h.sent.workspaces, 60, 'the fan-out is capped');
    eq(h.sent.unread_messages, 60, 'only the capped set is summed');
    eq(h.sent.truncated, 1, 'and the client is TOLD the total is a floor rather than being misled');
  }

  // ── 6b. the card counts what TODAY's day view draws (Lexis, 2026-11-03) ──
  console.log("\n6b. day-view rules");
  {
    const other = { created_by: 'SOMEONE', attendees: [] };
    const h = new Holder({
      input: { day: DAY, stime: START, etime: END },
      workspaces: [{ hub_id: 'W1', area: 'private' }],
      answers: {
        // The caller's own database: personal tasks carry no assignee.
        ME: {
          task_list_range: [
            task('p_open', { assignee_uids: null }),
            task('p_done', { assignee_uids: null, status: 'complete', status_is_done: null }),
          ],
          room_list_scheduled: [room(at(2026, 8, 27, 8))],
        },
        W1: {
          hub_daily_counts: [{ unread_messages: 2, due_tasks: 41 }],
          task_list_range: [
            task('mine'),
            task('shared', { assignee_uids: 'OTHER,ME' }),
            task('not_mine', { assignee_uids: 'OTHER' }),
            task('nobody', { assignee_uids: null }),
            // Done by a CUSTOM column, whatever its status word says.
            task('custom_done', { status: 'abcdef0123456789', status_is_done: 1 }),
            // Not a due column, though not flagged done either.
            task('released', { status: 'db61e386db61e38b', status_label: 'Released', status_is_done: 0 }),
            task('in_test', { status: 'to_review', status_label: 'In Test', status_is_done: 0 }),
            task('reopened', { status: 'da6a788cda6a7893', status_label: 'Reopen', status_is_done: 0 }),
            // An unseeded board: only 'complete' is done.
            task('unseeded_open', { status: 'in_progress', status_is_done: null }),
            task('unseeded_done', { status: 'complete', status_is_done: null }),
            // task_list_range(day, day) also answers a duration task that merely
            // SPANS today, but the day view draws it only on its due date.
            task('spans_today', { start_date: '2026-08-25', due_date: '2026-08-29' }),
            // A DATE that arrives as a Date object (local midnight) still matches.
            task('as_date', { due_date: new Date(2026, 7, 27) }),
          ],
          room_list_scheduled: [
            room(at(2026, 8, 27, 9)),
            room(at(2026, 8, 27, 10), null, null, other),
            room(at(2026, 8, 27, 11), null, null, { created_by: 'SOMEONE', attendees: [{ uid: 'ME' }] }),
            room(at(2026, 8, 27, 12), null, null, { created_by: 'SOMEONE', attendees: ['ME'] }),
            room(at(2026, 8, 27, 13), null, null, { created_by: undefined, attendees: [] }),
          ],
        },
      },
    });
    await h.daily_digest();
    deq(h.exceptions, [], 'no exception');
    eq(h.sent.due_tasks, 6,
      'p_open + mine + shared + unseeded_open + as_date + reopened: not someone else\'s, not unassigned, not outside To do / In progress / Reopen, not merely spanning today');
    eq(h.sent.meetings, 4,
      'organized (personal + workspace) or attended (uid or {uid}); someone else\'s meeting and an organizer-less one are not mine');
    eq(h.sent.unread_messages, 2, 'unread messages still come from hub_daily_counts');
    eq(h.sent.workspaces, 1, 'the personal database is not reported as a workspace');
    const mineCalls = h.calls.filter((c) => c.hubId === 'ME');
    deq(mineCalls.map((c) => c.name).sort(), ['room_list_scheduled', 'task_list_range'],
      'the personal database is read for tasks and meetings, never for team chat');
  }

  // ── 6c. the per-row rules, directly ──────────────────────────────────────
  console.log('\n6c. lib/day-tasks');
  {
    eq(countDayTasks(null, 'ME', false, DAY), 0, 'no rows');
    eq(countDayTasks([null, {}, task('x')], 'ME', false, DAY), 1, 'a row without an id is skipped');
    eq(countDayTasks([task('x', { assignee_uids: 'MEX' })], 'ME', false, DAY), 0, 'assignee match is exact, not a substring');
    eq(countDayTasks([task('x', { status_is_done: '0' })], 'ME', false, DAY), 1, "status_is_done arriving as a string '0' is open");
    eq(countDayTasks([task('x', { status_is_done: '1' })], 'ME', false, DAY), 0, "...and '1' is done");
    eq(countDayTasks([task('x', { due_date: '2026-08-20' })], 'ME', false, DAY), 0, 'an OVERDUE task is not counted');
    eq(countDayTasks([task('x', { due_date: null })], 'ME', false, DAY), 0, 'a task with NO due date is not counted');
    eq(countDayTasks([task('x', { due_date: '2026-08-27T00:00:00.000Z' })], 'ME', false, DAY), 1, 'a datetime string reads by its date part');
    eq(countDayTasks([task('x')], 'ME', false, undefined), 0, 'no day, nothing counts — never "every task"');
    eq(countDayTasks([task('x', { assignee_uids: null })], 'ME', true, DAY), 1, 'a personal task needs no assignee');
    // Only To do, In progress and Reopen count (Duy, 2026-11-03). Shapes
    // measured on a real PROD board: to_review renamed "In Test", custom
    // "Reopen", "In Preview" and "Released" (is_done 0) columns.
    const col = (status, status_label, status_is_done) => [task('x', { status, status_label, status_is_done })];
    eq(countDayTasks(col('todo', 'To do', 0), 'ME', false, DAY), 1, 'To do counts');
    eq(countDayTasks(col('in_progress', 'In progress', 0), 'ME', false, DAY), 1, 'In progress counts');
    eq(countDayTasks(col('todo', 'Backlog', 0), 'ME', false, DAY), 1, 'a RENAMED To do still counts — matched by its built-in id');
    eq(countDayTasks(col('da6a788cda6a7893', 'Reopen', 0), 'ME', false, DAY), 1, 'a custom "Reopen" column counts');
    eq(countDayTasks(col('aaaa0000aaaa0001', ' re-open ', 0), 'ME', false, DAY), 1, '"re-open" with case, hyphen and spaces counts');
    eq(countDayTasks(col('aaaa0000aaaa0002', 'Reopened', 0), 'ME', false, DAY), 1, '"Reopened" counts');
    eq(countDayTasks(col('aaaa0000aaaa0003', 'reopen 2', 0), 'ME', false, DAY), 0, '"reopen 2" is another column and does not count');
    eq(countDayTasks(col('da6a788cda6a7893', 'Reopen', 1), 'ME', false, DAY), 0, 'a Reopen column flagged done does not count');
    eq(countDayTasks(col('to_review', 'To review', 0), 'ME', false, DAY), 0, 'To review does not count');
    eq(countDayTasks(col('to_review', 'In Test', 0), 'ME', false, DAY), 0, 'To review renamed "In Test" does not count');
    eq(countDayTasks(col('81a3138d81a31390', 'In Preview', 0), 'ME', false, DAY), 0, 'a custom "In Preview" column does not count');
    eq(countDayTasks(col('db61e386db61e38b', 'Released', 0), 'ME', false, DAY), 0, 'a custom "Released" column does not count even though it is not flagged done');
    eq(countDayTasks(col('complete', 'Complete', 1), 'ME', false, DAY), 0, 'Complete does not count');
    eq(countDayTasks(col('todo', null, null), 'ME', false, DAY), 1, 'an unseeded board: todo counts by id');
    eq(countDayTasks(col('to_review', null, null), 'ME', false, DAY), 0, 'an unseeded board: to_review does not');
    ok(!takesPartIn(null, 'ME'), 'no content, no participation');
    ok(!takesPartIn({ created_by: 'ME' }, ''), 'no uid, no participation');
    ok(takesPartIn({ created_by: 'ME', attendees: 'garbage' }, 'ME'), 'malformed attendees do not hide the organizer');
  }

  // ── 7. the ACL contract ──────────────────────────────────────────────────
  console.log('\n7. acl/activity.json');
  {
    const s = ACL.services && ACL.services.daily_digest;
    ok(s, 'daily_digest is declared');
    eq(s && s.permission && s.permission.src, 'read', 'src: read — it only counts');
    ok(s && s.params && s.params.day && s.params.day.required === true, 'day is required');
    ok(s && s.params && s.params.stime && s.params.etime, 'the day window is part of the contract');
    ok((s.errors || []).some((e) => e.code === 'INVALID_DAY'), 'INVALID_DAY is documented and matches the code');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
