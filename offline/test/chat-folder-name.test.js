#!/usr/bin/env node
//
// chat-folder-name.test.js — Round 3 Phase 2, the chat toast's location chip.
//
//   node offline/test/chat-folder-name.test.js
//
// `channel.post` used to push only ids, so a recipient had no way to say WHERE
// a message came from: the server's normalized `folder_name` exists solely on
// FEED rows, and resolving it in the client meant a per-recipient round trip
// that silently yielded nothing in the real environment — Duy saw no chip on a
// folder chat even after a hard reload. `_chat_folder_name` names it on the
// push instead, once, deterministically.
//
// The contract this pins is mostly about NOT breaking the post: chat is the
// hottest push path in the app, and a naming failure must cost nothing more
// than an absent chip.
//
// It runs the REAL method, sliced out of service/private/channel.js rather
// than copy-pasted — a copy would keep passing after the real code changed.
//
// Exit code 0 = all pass, 1 = any failure.

const { readFileSync } = require('fs');
const { join } = require('path');

const SRC = join(__dirname, '../../service/private/channel.js');
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

const Holder = new Function(
  'Attr',
  `class Holder {
     constructor(nodes, hubId) {
       this.calls = [];
       this.nodes = nodes || {};
       this._hubId = hubId === undefined ? 'HUB1' : hubId;
       const self = this;
       this.hub = { get: () => self._hubId };
       this.db = {
         async await_proc(proc, id) {
           self.calls.push({ proc, id });
           if (self.nodes[id] === 'THROW') throw new Error('boom');
           return self.nodes[id];
         },
       };
     }
     ${sliceMethod('_chat_folder_name')}
   }
   return Holder;`,
)({ id: 'id' });

(async () => {
  console.log('\nchat toast — folder name on the push\n');

  // ── the happy path ───────────────────────────────────────────────────────
  {
    const h = new Holder({ N1: { filename: 'Q3 Launch' } });
    eq(await h._chat_folder_name('N1'), 'Q3 Launch', 'names the folder');
    eq(h.calls.length, 1, 'exactly one lookup per message');
    eq(h.calls[0].proc, 'mfs_node_attr', 'via mfs_node_attr');
  }

  // ── workspace-level chat ────────────────────────────────────────────────
  {
    // A hub-level post carries no nid. mfs_node_attr answers with the
    // WORKSPACE name for the hub root, which is the right label for it.
    const h = new Holder({ HUB1: { filename: 'Marketing' } });
    eq(await h._chat_folder_name(null), 'Marketing', 'falls back to the hub root');
    eq(h.calls[0].id, 'HUB1', 'and looks up the hub id');
  }

  // ── never disturb the post ──────────────────────────────────────────────
  {
    const h = new Holder({ N1: 'THROW' });
    let threw = false;
    let out;
    try { out = await h._chat_folder_name('N1'); } catch (e) { threw = true; }
    ok(!threw, 'a failing lookup must never propagate — it would cost the message');
    eq(out, null, 'and yields no name');
  }

  // ── internal plumbing names are withheld ────────────────────────────────
  for (const name of ['__chat__', '__meeting__', '__whatever']) {
    const h = new Holder({ N1: { filename: name } });
    eq(await h._chat_folder_name('N1'), null, `withholds the internal name ${name}`);
  }
  {
    // ...but a real folder that merely CONTAINS underscores is fine.
    const h = new Holder({ N1: { filename: 'my__folder' } });
    eq(await h._chat_folder_name('N1'), 'my__folder', 'a normal name with underscores survives');
  }

  // ── nothing to resolve ──────────────────────────────────────────────────
  {
    const h = new Holder({}, null);
    eq(await h._chat_folder_name(null), null, 'no nid and no hub yields null');
    eq(h.calls.length, 0, 'and costs no lookup at all');
  }
  {
    const h = new Holder({}, '0');
    eq(await h._chat_folder_name('0'), null, 'the "0" sentinel is not a node');
    eq(h.calls.length, 0, 'and costs no lookup');
  }
  {
    const h = new Holder({ N1: undefined });
    eq(await h._chat_folder_name('N1'), null, 'a node with no attributes yields null');
  }
  {
    const h = new Holder({ N1: { filename: '' } });
    eq(await h._chat_folder_name('N1'), null, 'an empty filename yields null, never ""');
  }

  console.log(`\n${'─'.repeat(56)}`);
  console.log(`chat folder name — ${pass} passed, ${fail} failed`);
  if (!fail) {
    console.log(`
  All good: one lookup per message, the hub root stands in for a
  workspace-level chat, internal plumbing names are withheld, and every
  failure path leaves the post untouched with the chip simply absent.`);
  }
  process.exit(fail ? 1 : 0);
})();
