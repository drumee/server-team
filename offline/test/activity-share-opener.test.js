#!/usr/bin/env node
//
// activity-share-opener.test.js — who opened a share, in the notification feed.
//
//   node offline/test/activity-share-opener.test.js
//
// A share-open event records the recipient's email only when the recipient
// identified themselves, but it records `actor_id` whenever a signed-in user
// opened the link. The row used to fall straight back to "Someone" with the
// workspace icon, throwing that identity away. It now drives both the display
// name and the avatar.
//
// Two things must NOT regress:
//
//   * `ffffffffffffffff` is the anonymous sentinel — an unauthenticated visitor
//     on a public link. Those rows have to keep saying "Someone" with no face;
//     naming them would be worse than the original bug.
//   * `author_id` may only ever be an id the lookup CONFIRMED exists. An id that
//     does not resolve makes the client's avatar fall back to the current user,
//     which is the "every row shows my own face" bug.
//
// Runs the REAL method and the REAL key helper, sliced out of
// service/private/activity.js against a stubbed yp, rather than copies that
// could drift.
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

function slice(head, name) {
  const start = src.indexOf(`${head}${name}(`);
  if (start < 0) throw new Error(`${name} not found in ${SRC}`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const toArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const ANON = 'ffffffffffffffff';

const Holder = new Function(
  'toArray',
  `const ANONYMOUS_UID = '${ANON}';
   ${slice('function ', 'openerKeyOf')}
   class Holder {
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
     keyOf(r) { return openerKeyOf(r); }
     ${slice('  async ', '_resolveOpeners')}
   }
   return Holder;`,
)(toArray);

// What the row builder does with the resolver's output, mirrored here so the
// name/avatar decisions are asserted as a pair.
const render = (r, openers) => {
  const opener = openers.get(new Holder().keyOf(r)) || null;
  const row = { fullname: r.recipient_email || (opener && opener.name) || 'Someone' };
  if (opener && opener.id) row.author_id = opener.id;
  return row;
};

(async () => {
  console.log('\n1. which identity gets looked up');
  {
    const h = new Holder();
    eq(h.keyOf({ actor_id: 'A1' }), 'A1', 'a bare actor is looked up by id');
    eq(h.keyOf({ recipient_email: 'a@b.c' }), 'a@b.c', 'an email is looked up by email');
    // The email is what the row already displays, so resolving THAT keeps the
    // name and the face the same person.
    eq(h.keyOf({ recipient_email: 'a@b.c', actor_id: 'A1' }), 'a@b.c', 'email wins over actor');
    eq(h.keyOf({ actor_id: ANON }), null, 'the anonymous sentinel is not an identity');
    eq(h.keyOf({ actor_id: '' }), null, 'blank actor');
    eq(h.keyOf({}), null, 'nothing to go on');
    eq(h.keyOf(null), null, 'junk row');
  }

  console.log('\n2. a signed-in opener with no recipient email is named AND depicted');
  {
    const h = new Holder({ A1: { id: 'A1', fullname: 'Duy Nguyen' } });
    const r = { actor_id: 'A1' };
    const openers = await h._resolveOpeners([r]);
    eq(openers.get('A1').name, 'Duy Nguyen', 'resolved from fullname');
    eq(openers.get('A1').id, 'A1', 'and carries the confirmed id');
    const row = render(r, openers);
    eq(row.fullname, 'Duy Nguyen', 'the row is named');
    eq(row.author_id, 'A1', 'and shows that person, not the workspace');
    eq(h.calls.length, 1, 'one lookup');
  }
  {
    const h = new Holder({ A1: { id: 'A1', firstname: 'Thao Linh', lastname: 'Hoang' } });
    const openers = await h._resolveOpeners([{ actor_id: 'A1' }]);
    eq(openers.get('A1').name, 'Thao Linh Hoang', 'composed from first + last');
  }
  {
    const h = new Holder({ A1: { id: 'A1', firstname: 'Solo' } });
    const openers = await h._resolveOpeners([{ actor_id: 'A1' }]);
    eq(openers.get('A1').name, 'Solo', 'a lone firstname still names the row');
  }

  console.log('\n3. 🔒 the anonymous sentinel stays anonymous, with no face');
  {
    const h = new Holder({ [ANON]: { id: ANON, fullname: 'SHOULD NEVER BE USED' } });
    const r = { actor_id: ANON };
    const openers = await h._resolveOpeners([r]);
    eq(h.calls.length, 0, 'never even queried');
    const row = render(r, openers);
    eq(row.fullname, 'Someone', 'still Someone');
    eq(row.author_id, undefined, 'and NO author_id, so the workspace icon stays');
  }

  console.log('\n4. an identified recipient keeps its email as the name, and gains a face');
  {
    const h = new Holder({ 'a@b.c': { id: 'U9', fullname: 'Anna B' } });
    const r = { recipient_email: 'a@b.c', actor_id: 'A1' };
    const openers = await h._resolveOpeners([r]);
    eq(h.calls[0], 'a@b.c', 'looked up by email, not by the actor');
    const row = render(r, openers);
    eq(row.fullname, 'a@b.c', 'the displayed name is UNCHANGED — still the email');
    eq(row.author_id, 'U9', 'the avatar is the person that email belongs to');
  }

  console.log('\n5. one lookup per distinct person, and the cap holds');
  {
    const h = new Holder({ A1: { id: 'A1', fullname: 'One' } });
    const openers = await h._resolveOpeners(
      Array.from({ length: 20 }, () => ({ actor_id: 'A1' })),
    );
    eq(h.calls.length, 1, '20 opens by one person is ONE lookup');
    eq(openers.get('A1').name, 'One', 'still resolved');
  }
  {
    const people = {};
    const rows = [];
    for (let i = 0; i < 30; i++) {
      people[`A${i}`] = { id: `A${i}`, fullname: `P${i}` };
      rows.push({ actor_id: `A${i}` });
    }
    const h = new Holder(people);
    await h._resolveOpeners(rows);
    ok(h.calls.length <= 12, `capped at 12, made ${h.calls.length}`);
    ok(h.calls.length > 0, 'but still resolves what it can');
  }

  console.log('\n6. 🔒 an unconfirmed identity never becomes an avatar');
  {
    // A deleted account / a guest with no drumate row returns nothing. Setting
    // author_id from the raw id here is what shows the CURRENT user's face.
    const h = new Holder({});
    const r = { actor_id: 'GONE' };
    const openers = await h._resolveOpeners([r]);
    eq(openers.get('GONE'), null, 'placeholder stays null');
    const row = render(r, openers);
    eq(row.fullname, 'Someone', 'falls back to Someone');
    eq(row.author_id, undefined, 'and NO author_id');
  }
  {
    // A row with no id must never be trusted, even if it carries a name.
    const h = new Holder({ A1: { fullname: 'No Id Here' } });
    const r = { actor_id: 'A1' };
    const openers = await h._resolveOpeners([r]);
    eq(openers.get('A1'), null, 'a result without an id is not an identity');
    eq(render(r, openers).author_id, undefined, 'so no avatar');
  }
  {
    const h = new Holder({ A1: { id: 'A1', fullname: '   ' } });
    const r = { actor_id: 'A1' };
    const openers = await h._resolveOpeners([r]);
    const row = render(r, openers);
    eq(row.fullname, 'Someone', 'a whitespace-only name is not a name');
    eq(row.author_id, 'A1', 'but the confirmed account can still be depicted');
  }
  {
    const h = new Holder({ A1: 'THROW', A2: { id: 'A2', fullname: 'Fine' } });
    const openers = await h._resolveOpeners([{ actor_id: 'A1' }, { actor_id: 'A2' }]);
    ok(!openers.get('A1'), 'a failed lookup leaves the row as it was');
    eq(openers.get('A2').name, 'Fine', 'and does not stop the others');
    eq(h.debugs.length, 1, 'the failure is recorded, not thrown');
  }

  console.log('\n7. degenerate input');
  {
    const h = new Holder({});
    for (const arg of [[], null, undefined, 'nope', [null, undefined]]) {
      const openers = await h._resolveOpeners(arg);
      ok(openers instanceof Map, 'always returns a Map');
      eq(openers.size, 0, 'and an empty one');
    }
    eq(h.calls.length, 0, 'nothing queried');
  }

  console.log('\n8. the call site wires it up the way this test assumes');
  {
    ok(/fullname\s*:\s*r\.recipient_email \|\| \(opener && opener\.name\) \|\| 'Someone'/.test(src),
      'fullname falls back email -> opener name -> Someone');
    // recipient_email goes back to secure_share.mark_open_seen to persist the
    // seen state, so it must never be rewritten.
    ok(/recipient_email:\s*r\.recipient_email,/.test(src),
      'recipient_email is passed through untouched');
    ok(/if \(opener && opener\.id\) row\.author_id = opener\.id;/.test(src),
      'author_id is set ONLY from a confirmed id');
    ok(/const opener = openers\.get\(openerKeyOf\(r\)\) \|\| null;/.test(src),
      'the row builder keys the map with the same helper the resolver used');
  }

  console.log(`\n${'─'.repeat(56)}`);
  console.log(`share-open opener identity — ${pass} passed, ${fail} failed`);
  if (!fail) {
    console.log(`
  All good: a signed-in opener is named and depicted from one lookup per
  person, an identified recipient keeps its email as the name while gaining
  the right face, the anonymous sentinel is never queried and never named,
  and no unconfirmed id ever reaches author_id — every failure path falls
  back to "Someone" with the workspace icon.`);
  }
  process.exit(fail ? 1 : 0);
})();
