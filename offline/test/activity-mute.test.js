#!/usr/bin/env node
//
// activity-mute.test.js — Round 3 Phase 3, the notification popup mute.
//
//   node offline/test/activity-mute.test.js
//
// Covers `activity.mute_state` / `activity.mute_set` and the two helpers they
// rest on, `_muteState` and `_optionalYpProcResult`.
//
// The properties worth defending here are mostly about NOT doing things:
//
//   · the feed must never learn about mute — a muted user keeps every row in
//     the Notification Center and keeps the bell badge, so the only thing that
//     may change is whether a popup card appears;
//   · '0' and 'false' arrive from form and query payloads as STRINGS, and both
//     are truthy in JS — reading them naively would turn every unmute into a
//     mute, which is the failure the user would never report because the
//     button appears to work;
//   · await_proc does not throw. It logs, ends the connection and returns
//     undefined, so "the routine is not deployed" and "you have nothing muted"
//     are both `[]` — a write path that cannot tell them apart would confirm a
//     mute that never reached the database.
//
// It runs the REAL code: every method is sliced out of
// service/private/activity.js and evaluated, rather than copy-pasted here. A
// copy would keep passing after the real code changed under it.
//
// Exit code 0 = all pass, 1 = any failure.

const { readFileSync } = require('fs');
const { join } = require('path');

const SRC = join(__dirname, '../../service/private/activity.js');
const src = readFileSync(SRC, 'utf8');
const ACL = join(__dirname, '../../acl/activity.json');
const acl = JSON.parse(readFileSync(ACL, 'utf8'));

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
function deq(actual, expected, msg) {
  eq(JSON.stringify(actual), JSON.stringify(expected), msg);
}

// ── slice the real methods (async and plain) ───────────────────────────────
function sliceMethod(name) {
  let start = src.indexOf(`\n  async ${name}(`);
  if (start < 0) start = src.indexOf(`\n  ${name}(`);
  if (start < 0) throw new Error(`${name} not found in ${SRC}`);
  start += 1;
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const toArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const MISSING_PROCS = new Map();
const PROC_RETRY_MS = 60 * 1000;

// `answers` maps a proc name to what await_proc returns. `undefined` is the
// real driver's "it failed or is not deployed" signal — NOT an exception.
const Holder = new Function(
  'toArray', 'MISSING_PROCS', 'PROC_RETRY_MS',
  `class Holder {
     constructor(answers, input) {
       this.uid = 'U1';
       this.calls = [];
       this.debugs = [];
       this.answers = answers || {};
       this.sent = undefined;
       const self = this;
       this.input = {
         use(k) { return input ? input[k] : undefined; },
         need(k) { return input ? input[k] : undefined; },
       };
       this.output = { data(d) { self.sent = d; }, list(d) { self.sent = d; } };
       this.yp = {
         async await_proc(proc, ...args) {
           self.calls.push({ proc, args });
           return self.answers[proc];
         },
       };
     }
     debug(...a) { this.debugs.push(a); }
     ${sliceMethod('_optionalYpProc')}
     ${sliceMethod('_optionalYpProcResult')}
     ${sliceMethod('_muteState')}
     ${sliceMethod('mute_state')}
     ${sliceMethod('mute_set')}
   }
   return Holder;`,
)(toArray, MISSING_PROCS, PROC_RETRY_MS);

const reset = () => MISSING_PROCS.clear();

(async () => {
  // ── 1. _muteState reads rows the way both endpoints must agree on ────────
  console.log('\n1. _muteState — row shape');
  {
    const h = new Holder();
    deq(h._muteState([]), { global: 0, hubs: [] }, 'nothing muted is the default');
    deq(h._muteState([{ hub_id: '' }]), { global: 1, hubs: [] }, "hub_id '' is the GLOBAL row");
    deq(
      h._muteState([{ hub_id: 'H1' }, { hub_id: 'H2' }]),
      { global: 0, hubs: ['H1', 'H2'] },
      'per-workspace rows land in hubs',
    );
    // The procedures clear per-hub rows when the global one is written, so this
    // cannot arise from them — but a report must not lose either fact.
    deq(
      h._muteState([{ hub_id: '' }, { hub_id: 'H1' }]),
      { global: 1, hubs: ['H1'] },
      'a mixed result reports what is actually there',
    );
  }

  console.log('\n2. _muteState — degenerate rows never throw');
  {
    const h = new Holder();
    deq(h._muteState(null), { global: 0, hubs: [] }, 'null');
    deq(h._muteState(undefined), { global: 0, hubs: [] }, 'undefined');
    deq(h._muteState([null, undefined]), { global: 0, hubs: [] }, 'null members skipped');
    // A NULL hub_id from the driver must not become the string "null" and be
    // reported as a muted workspace named null.
    deq(h._muteState([{ hub_id: null }]), { global: 1, hubs: [] }, 'NULL hub_id reads as global');
    deq(h._muteState([{ hub_id: 'H1' }, { hub_id: 'H1' }]), { global: 0, hubs: ['H1'] }, 'deduped');
    deq(h._muteState([{ hub_id: 7 }]), { global: 0, hubs: ['7'] }, 'a numeric id is stringified');
  }

  // ── 3. mute_set routes to the right procedure ────────────────────────────
  console.log('\n3. mute_set — set vs unset');
  {
    reset();
    const h = new Holder({ notification_mute_set: [{ hub_id: 'H1' }] }, { hub_id: 'H1' });
    await h.mute_set();
    eq(h.calls[0].proc, 'notification_mute_set', 'absent `muted` MUTES');
    deq(h.calls[0].args, ['U1', 'H1'], 'called with uid then hub_id');
    eq(h.sent.status, 'ok', 'status ok');
    eq(h.sent.muted, 1, 'reports that it muted');
    deq(h.sent.hubs, ['H1'], 'returns the resulting state');
  }
  {
    reset();
    const h = new Holder({ notification_mute_unset: [] }, { hub_id: 'H1', muted: false });
    await h.mute_set();
    eq(h.calls[0].proc, 'notification_mute_unset', 'muted:false UNMUTES');
    eq(h.sent.muted, 0, 'reports that it unmuted');
    eq(h.sent.global, 0, 'resulting state is unmuted');
  }
  {
    reset();
    const h = new Holder({ notification_mute_set: [{ hub_id: '' }] }, {});
    await h.mute_set();
    eq(h.calls[0].proc, 'notification_mute_set', 'no hub_id still mutes');
    deq(h.calls[0].args, ['U1', ''], "absent hub_id becomes '' = all workspaces");
    eq(h.sent.global, 1, 'global mute reported');
    eq(h.sent.hub_id, '', 'echoes the scope acted on');
  }

  // ── 4. THE STRING TRAP ───────────────────────────────────────────────────
  console.log("\n4. mute_set — '0' and 'false' are STRINGS and both truthy in JS");
  {
    for (const raw of ['0', 'false', 0, false]) {
      reset();
      const h = new Holder({ notification_mute_unset: [] }, { hub_id: 'H1', muted: raw });
      await h.mute_set();
      eq(h.calls[0].proc, 'notification_mute_unset',
        `muted:${JSON.stringify(raw)} must UNMUTE, not mute`);
      eq(h.sent.muted, 0, `muted:${JSON.stringify(raw)} reports 0`);
    }
  }
  {
    // Everything else means mute — including the strings a form sends for true.
    for (const raw of ['1', 'true', 1, true, undefined, null, '']) {
      reset();
      const h = new Holder({ notification_mute_set: [] }, { hub_id: 'H1', muted: raw });
      await h.mute_set();
      eq(h.calls[0].proc, 'notification_mute_set',
        `muted:${JSON.stringify(raw)} must MUTE`);
    }
  }

  // ── 5. an undeployed routine is reported, not confirmed ──────────────────
  console.log('\n5. mute_set — await_proc returns undefined instead of throwing');
  {
    reset();
    const h = new Holder({}, { hub_id: 'H1' }); // no answer => undefined
    await h.mute_set();
    eq(h.sent.status, 'error', 'a write that never landed is NOT reported as ok');
    deq(h.sent.hubs, [], 'no state is invented');
    ok(h.debugs.length > 0, 'and it is logged');
  }
  {
    // The cooldown must then stop us calling it again — that is what keeps a
    // missing routine from logging ER_SP_DOES_NOT_EXIST on every click and
    // dropping a DB connection each time.
    reset();
    const h = new Holder({}, { hub_id: 'H1' });
    await h.mute_set();
    await h.mute_set();
    eq(h.calls.length, 1, 'second call inside the cooldown does not reach the DB');
    eq(h.sent.status, 'error', 'and still reports honestly');
  }
  {
    // A routine that answers clears the verdict immediately, so applying the
    // schema takes effect on the next request rather than a minute later.
    reset();
    const h = new Holder({}, { hub_id: 'H1' });
    await h.mute_set();
    h.answers.notification_mute_set = [{ hub_id: 'H1' }];
    MISSING_PROCS.clear(); // the cooldown elapsing
    await h.mute_set();
    eq(h.sent.status, 'ok', 'recovers once the routine exists');
    deq(h.sent.hubs, ['H1'], 'and returns real state');
  }

  // ── 6. mute_state ────────────────────────────────────────────────────────
  console.log('\n6. mute_state — read path stays best-effort');
  {
    reset();
    const h = new Holder({ notification_mute_state: [{ hub_id: '' }] });
    await h.mute_state();
    eq(h.calls[0].proc, 'notification_mute_state', 'reads the state routine');
    deq(h.calls[0].args, ['U1'], 'for the caller only');
    deq(h.sent, { global: 1, hubs: [] }, 'global mute reported');
  }
  {
    reset();
    const h = new Holder({}); // not deployed
    await h.mute_state();
    deq(h.sent, { global: 0, hubs: [] },
      'before the schema is applied it answers "nothing muted" — popups keep working');
  }

  // ── 7. the refactored helper must not change for its existing callers ────
  console.log('\n7. _optionalYpProc — unchanged contract for the 4 feed callers');
  {
    reset();
    const h = new Holder({ some_proc: [{ a: 1 }] });
    const r = await h._optionalYpProc('some_proc', 'x');
    ok(Array.isArray(r), 'still returns a plain ARRAY, not the {ok,rows} wrapper');
    deq(r, [{ a: 1 }], 'with the rows in it');
  }
  {
    reset();
    const h = new Holder({});
    const r = await h._optionalYpProc('gone_proc');
    deq(r, [], 'still returns [] when the routine is absent');
    const r2 = await h._optionalYpProc('gone_proc');
    deq(r2, [], 'still [] inside the cooldown');
    eq(h.calls.length, 1, 'and still only calls it once');
  }
  {
    reset();
    const h = new Holder({ scalar_proc: { a: 1 } });
    deq(await h._optionalYpProc('scalar_proc'), [{ a: 1 }], 'still toArray-wraps a bare row');
  }

  // ── 8. the feed must not know about mute ─────────────────────────────────
  console.log('\n8. mute is invisible to the feed and the badge');
  {
    const feedMethods = ['list', 'get_feed', 'unread_counts', '_notificationRollups'];
    for (const name of feedMethods) {
      const body = sliceMethod(name);
      ok(!/mute/i.test(body), `${name}() must never read the mute flags`);
    }
    // And the popup suppression must not have been pushed onto the server's
    // chat push path either — that is the hottest push we have.
    ok(!/notification_mute/.test(readFileSync(join(__dirname, '../../service/private/channel.js'), 'utf8')),
      'channel.js (the chat push path) does not consult the mute table');
  }

  // ── 9. the ACL agrees with the implementation ────────────────────────────
  console.log('\n9. ACL entries');
  {
    ok(!!acl.services.mute_state, 'mute_state is declared');
    ok(!!acl.services.mute_set, 'mute_set is declared');
    eq(acl.services.mute_state.permission.src, 'read', 'reading state needs read');
    eq(acl.services.mute_set.permission.src, 'write', 'changing it needs write');
    eq(acl.services.mute_state.scope, 'hub', 'mute_state is hub-scoped');
    eq(acl.services.mute_set.scope, 'hub', 'mute_set is hub-scoped');
    // The repo rule: doc strings carry no curly braces.
    for (const k of ['mute_state', 'mute_set']) {
      ok(!/[{}]/.test(acl.services[k].doc), `${k} doc has no curly braces`);
    }
  }

  console.log(`\n${'─'.repeat(56)}`);
  console.log(`notification mute — ${pass} passed, ${fail} failed`);
  if (!fail) {
    console.log(`
  All good: '0' and 'false' unmute rather than mute, a routine that is
  not deployed is reported as an error instead of being confirmed to the
  user, the cooldown keeps a missing routine off the DB, the read path
  degrades to "nothing muted" so popups keep working, _optionalYpProc's
  contract is unchanged for its existing callers, and neither the feed,
  the badge nor the chat push path can see the mute flags.`);
  }
  process.exit(fail ? 1 : 0);
})();
