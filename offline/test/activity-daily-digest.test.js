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
const Holder = new Function(
  'toArray', 'countMeetingsInWindow',
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
)(toArray, countMeetingsInWindow);

// 2026-08-27 UTC
const DAY = '2026-08-27';
const START = Math.floor(Date.UTC(2026, 7, 27, 0, 0, 0) / 1000);
const END = START + 86400;
const at = (y, mo, d, h) => Math.floor(Date.UTC(y, mo - 1, d, h) / 1000);

// room_list_scheduled row shape: metadata is JSON whose `content` is a JSON STRING.
const room = (stime, recur, until) => ({
  id: 'n' + stime,
  stime,
  metadata: JSON.stringify({
    content: JSON.stringify({ stime, title: 't', ...(recur ? { recur: { freq: recur, ...(until ? { until } : {}) } } : {}) }),
  }),
});

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
        H1: { hub_daily_counts: [{ unread_messages: 5, due_tasks: 2 }], room_list_scheduled: [room(at(2026, 8, 27, 9))] },
        H2: { hub_daily_counts: [{ unread_messages: 30, due_tasks: 3 }], room_list_scheduled: [room(at(2026, 1, 5, 9), 'daily')] },
        // H3 answers nothing at all — an unmigrated workspace.
        H3: {},
      },
    });
    await h.daily_digest();
    deq(h.exceptions, [], 'no exception');
    eq(h.sent.unread_messages, 35, 'unread messages are summed across workspaces');
    eq(h.sent.due_tasks, 5, 'due tasks are summed');
    eq(h.sent.meetings, 2, 'meetings are summed, with the daily series counted once');
    eq(h.sent.workspaces, 3, 'reports how many workspaces were summed');
    eq(h.sent.truncated, 0, 'not truncated');
    // The workspace that answered nothing must not have broken anything.
    ok(h.sent.unread_messages === 35 && h.sent.due_tasks === 5,
      'a workspace that answers undefined contributes zero rather than failing the card');
    // uid comes from the session and is passed through, with the validated day.
    const countCall = h.calls.find((c) => c.name === 'hub_daily_counts');
    eq(countCall.args, `'ME','${DAY}'`, 'uid and the validated day are what reach the proc');
    ok(h.calls.some((c) => c.userProc === 'desk_my_workspaces'),
      'workspaces come from desk_my_workspaces — the desk register, which includes JOINED workspaces');
  }

  // ── 5b. share / dmz containers are not workspaces ────────────────────────
  console.log('\n5b. area filtering');
  {
    const h = new Holder({
      input: { day: DAY, stime: START, etime: END },
      workspaces: [
        { hub_id: 'P1', area: 'private' },
        { hub_id: 'P2', area: 'public' },
        { hub_id: 'S1', area: 'share' },
        { hub_id: 'D1', area: 'dmz' },
        { hub_id: 'N1' },
      ],
      answers: {
        P1: { hub_daily_counts: [{ unread_messages: 1, due_tasks: 1 }] },
        P2: { hub_daily_counts: [{ unread_messages: 2, due_tasks: 0 }] },
        S1: { hub_daily_counts: [{ unread_messages: 100, due_tasks: 100 }] },
        D1: { hub_daily_counts: [{ unread_messages: 100, due_tasks: 100 }] },
        N1: { hub_daily_counts: [{ unread_messages: 100, due_tasks: 100 }] },
      },
    });
    await h.daily_digest();
    eq(h.sent.workspaces, 2, 'only private and public areas are summed');
    eq(h.sent.unread_messages, 3, 'a secure-share container does not inflate the message count');
    eq(h.sent.due_tasks, 1, 'nor the task count');
    ok(!h.calls.some((c) => c.hubId === 'S1' || c.hubId === 'D1'),
      'and they are not even queried — the fan-out is smaller as well as more honest');
    ok(!h.calls.some((c) => c.hubId === 'N1'),
      'a row with no area at all is skipped rather than guessed at');
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
