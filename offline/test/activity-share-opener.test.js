#!/usr/bin/env node
//
// activity-share-opener.test.js — "Someone opened X" in the notification feed.
//
//   node offline/test/activity-share-opener.test.js
//
// A share-open event records the recipient's email only when the recipient
// identified themselves, but it records `actor_id` whenever a signed-in user
// opened the link. The feed row was falling straight back to "Someone" and
// throwing that actor away, so opens by known people read as anonymous.
//
// The one thing that must NOT regress: `ffffffffffffffff` is the anonymous
// sentinel — an unauthenticated visitor on a public link. Those rows have to
// keep saying "Someone"; naming them would be worse than the original bug.
//
// Runs the REAL method, sliced out of service/private/activity.js against a
// stubbed yp, rather than a copy that could drift.
//
// Exit code 0 = all pass, 1 = any failure.

const { readFileSync } = require('fs');
const { join } = require('path');

const SRC = join(__dirname, '../../service/private/activity.js');
const src = readFileSync(SRC, 'utf8');

let pass = 0;
let fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log(`  ✗ ${m}`); } };
const eq = (a, e, m) => ok(a === e, `${m} — expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);

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

const toArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

const Holder = new Function(
  'toArray',
  `class Holder {
     constructor(people) {
       this.people = people || {};
       this.calls = [];
       this.debugs = [];
       const self = this;
       this.yp = {
         async await_proc(proc, key) {
           self.calls.push(key);
           if (self.people[key] === 'THROW') throw new Error('boom');
           return self.people[key] ? [self.people[key]] : [];
         },
       };
     }
     debug(...a) { this.debugs.push(a); }
     ${sliceMethod('_resolveOpeners')}
   }
   return Holder;`,
)(toArray);

const ANON = 'ffffffffffffffff';

(async () => {
  console.log('\n1. a signed-in opener with no recipient email gets named');
  {
    const h = new Holder({ A1: { fullname: 'Duy Nguyen' } });
    const names = await h._resolveOpeners([{ actor_id: 'A1' }]);
    eq(names.get('A1'), 'Duy Nguyen', 'resolved from fullname');
    eq(h.calls.length, 1, 'one lookup');
    eq(h.calls[0], 'A1', 'looked up the actor');
  }
  {
    // fullname is not always populated; firstname/lastname is the fallback.
    const h = new Holder({ A1: { firstname: 'Thao Linh', lastname: 'Hoang' } });
    const names = await h._resolveOpeners([{ actor_id: 'A1' }]);
    eq(names.get('A1'), 'Thao Linh Hoang', 'composed from first + last');
  }
  {
    const h = new Holder({ A1: { firstname: 'Solo' } });
    const names = await h._resolveOpeners([{ actor_id: 'A1' }]);
    eq(names.get('A1'), 'Solo', 'a lone firstname still names the row');
  }

  console.log('\n2. 🔒 the anonymous sentinel must stay anonymous');
  {
    const h = new Holder({ [ANON]: { fullname: 'SHOULD NEVER BE USED' } });
    const names = await h._resolveOpeners([{ actor_id: ANON }]);
    eq(names.get(ANON), undefined, 'ffffffffffffffff is never resolved');
    eq(h.calls.length, 0, 'and never even queried');
  }

  console.log('\n3. rows that must not cost a lookup');
  {
    const h = new Holder({ A1: { fullname: 'Named' } });
    const names = await h._resolveOpeners([
      { recipient_email: 'a@b.c', actor_id: 'A1' }, // already identified
      { actor_id: null },                           // no actor at all
      { actor_id: '' },                             // blank actor
      {},                                           // nothing
      null,                                         // junk
    ]);
    eq(h.calls.length, 0, 'an email or a missing actor means nothing to resolve');
    eq(names.size, 0, 'no names produced');
  }

  console.log('\n4. one lookup per distinct actor, and the cap holds');
  {
    const h = new Holder({ A1: { fullname: 'One' } });
    const names = await h._resolveOpeners(
      Array.from({ length: 20 }, () => ({ actor_id: 'A1' })),
    );
    eq(h.calls.length, 1, '20 opens by one person is ONE lookup');
    eq(names.get('A1'), 'One', 'still named');
  }
  {
    const people = {};
    const rows = [];
    for (let i = 0; i < 30; i++) {
      people[`A${i}`] = { fullname: `P${i}` };
      rows.push({ actor_id: `A${i}` });
    }
    const h = new Holder(people);
    await h._resolveOpeners(rows);
    ok(h.calls.length <= 12, `capped at 12, made ${h.calls.length}`);
    ok(h.calls.length > 0, 'but still resolves what it can');
  }

  console.log('\n5. unresolvable actors fall back to "Someone"');
  {
    // A deleted account / a guest with no drumate row returns nothing.
    const h = new Holder({});
    const names = await h._resolveOpeners([{ actor_id: 'GONE' }]);
    eq(names.get('GONE'), null, 'placeholder stays null so the caller falls back');
    ok(!names.get('GONE'), 'falsy, which is what the || chain needs');
  }
  {
    const h = new Holder({ A1: { fullname: '   ' } });
    const names = await h._resolveOpeners([{ actor_id: 'A1' }]);
    ok(!names.get('A1'), 'a whitespace-only name is not a name');
  }
  {
    const h = new Holder({ A1: 'THROW', A2: { fullname: 'Fine' } });
    const names = await h._resolveOpeners([{ actor_id: 'A1' }, { actor_id: 'A2' }]);
    ok(!names.get('A1'), 'a failed lookup leaves the row saying Someone');
    eq(names.get('A2'), 'Fine', 'and does not stop the others');
    eq(h.debugs.length, 1, 'the failure is recorded, not thrown');
  }

  console.log('\n6. degenerate input');
  {
    const h = new Holder({});
    for (const arg of [[], null, undefined, 'nope', [null, undefined]]) {
      const names = await h._resolveOpeners(arg);
      ok(names instanceof Map, 'always returns a Map');
      eq(names.size, 0, 'and an empty one');
    }
    eq(h.calls.length, 0, 'nothing queried');
  }

  console.log('\n7. the call site uses it without touching recipient_email');
  {
    // recipient_email is sent back to secure_share.mark_open_seen to persist the
    // seen state, so only the DISPLAY name may fall back.
    ok(/fullname\s*:\s*r\.recipient_email \|\| openers\.get\(r\.actor_id\) \|\| 'Someone'/.test(src),
      'fullname falls back email -> opener -> Someone');
    ok(/recipient_email:\s*r\.recipient_email,/.test(src),
      'recipient_email is passed through untouched');
  }

  console.log(`\n${'─'.repeat(56)}`);
  console.log(`share-open opener names — ${pass} passed, ${fail} failed`);
  if (!fail) {
    console.log(`
  All good: a signed-in opener is named from one lookup per person, the
  anonymous sentinel is never queried and never named, rows that already
  have an email cost nothing, the worst case is capped, and every
  unresolvable or failing case falls back to the original "Someone".`);
  }
  process.exit(fail ? 1 : 0);
})();
