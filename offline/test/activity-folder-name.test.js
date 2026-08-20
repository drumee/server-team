#!/usr/bin/env node
//
// activity-folder-name.test.js — Round 3, Notification Center folder chip.
//
//   node offline/test/activity-folder-name.test.js
//
// Verifies `_stampFolderNames`, which resolves the folder/workspace a file row
// belongs to so the card can show it in a chip beside the timestamp.
//
// Rollup rows already name their folder (mapNotificationRow). Raw
// `yp.mfs_changelog` rows embed only the FILE's own node attributes in
// `src`/`dest`, so the parent has to be looked up by id — and that lookup is a
// DB round trip, which is why the behaviour under test is mostly about NOT
// making them: dedupe by (hub_id, parent_id), never re-resolve what a rollup
// already knows, and cap the worst case.
//
// It runs the REAL method: the source is sliced out of
// service/private/activity.js and evaluated against a stubbed `yp`, rather than
// copy-pasted here. A copy would keep passing after the real code changed.
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

// ── slice the real method ──────────────────────────────────────────────────
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
     constructor(nodes) {
       this.calls = [];
       this.nodes = nodes || {};
       this.debugs = [];
       const self = this;
       this.yp = {
         async await_proc(proc, hub, name, quotedId) {
           const id = String(quotedId).replace(/'/g, '');
           self.calls.push({ proc, hub, name, id });
           const key = hub + ':' + id;
           if (self.nodes[key] === 'THROW') throw new Error('boom');
           return self.nodes[key] ? [self.nodes[key]] : [];
         },
       };
     }
     debug(...a) { this.debugs.push(a); }
     ${sliceMethod('_stampFolderNames')}
   }
   return Holder;`,
)(toArray);

const upload = (over = {}) => ({
  event: 'media.new',
  hub_id: 'HUB1',
  src: JSON.stringify({ filename: 'document', parent_id: 'P1' }),
  ...over,
});

// ── 1. the resolved name lands on the row ──────────────────────────────────
(async () => {
  console.log('\n1. a changelog upload row gets its parent folder name');
  {
    const h = new Holder({ 'HUB1:P1': { filename: 'checkin' } });
    const rows = [upload()];
    await h._stampFolderNames(rows);
    eq(rows[0].folder_name, 'checkin', 'folder_name stamped');
    eq(h.calls.length, 1, 'exactly one lookup');
    eq(h.calls[0].name, 'mfs_node_attr', 'resolved via mfs_node_attr');
    eq(h.calls[0].id, 'P1', 'looked up the PARENT, not the file');
  }

  console.log('\n2. parent_id is read from dest, src or the top level');
  {
    const h = new Holder({ 'HUB1:PD': { filename: 'fromDest' }, 'HUB1:PT': { filename: 'fromTop' } });
    const rows = [
      upload({ dest: JSON.stringify({ parent_id: 'PD' }) }),
      upload({ src: null, parent_id: 'PT' }),
    ];
    await h._stampFolderNames(rows);
    eq(rows[0].folder_name, 'fromDest', 'dest wins over src');
    eq(rows[1].folder_name, 'fromTop', 'top-level parent_id works');
  }
  {
    // `pid` is the other name mfs_node_attr uses for the same value.
    const h = new Holder({ 'HUB1:PP': { filename: 'viaPid' } });
    const rows = [upload({ src: JSON.stringify({ pid: 'PP' }) })];
    await h._stampFolderNames(rows);
    eq(rows[0].folder_name, 'viaPid', 'pid is accepted');
  }

  console.log('\n3. lookups are deduped, not per row');
  {
    const h = new Holder({ 'HUB1:P1': { filename: 'checkin' } });
    const rows = [upload(), upload(), upload(), upload(), upload()];
    await h._stampFolderNames(rows);
    eq(h.calls.length, 1, '5 rows in one folder must cost ONE lookup');
    ok(rows.every((r) => r.folder_name === 'checkin'), 'every row still stamped');
  }
  {
    const h = new Holder({
      'HUB1:P1': { filename: 'one' },
      'HUB2:P1': { filename: 'two' },
    });
    const rows = [upload(), upload({ hub_id: 'HUB2' })];
    await h._stampFolderNames(rows);
    eq(h.calls.length, 2, 'same parent id in two hubs is two distinct nodes');
    eq(rows[0].folder_name, 'one', 'hub 1 name');
    eq(rows[1].folder_name, 'two', 'hub 2 name');
  }

  console.log('\n4. the worst case is bounded');
  {
    const nodes = {};
    const rows = [];
    for (let i = 0; i < 40; i++) {
      nodes[`HUB1:P${i}`] = { filename: `f${i}` };
      rows.push(upload({ src: JSON.stringify({ parent_id: `P${i}` }) }));
    }
    const h = new Holder(nodes);
    await h._stampFolderNames(rows);
    ok(h.calls.length <= 12, `capped at 12, made ${h.calls.length}`);
    ok(h.calls.length > 0, 'but it still resolves what it can');
    ok(rows.some((r) => r.folder_name), 'the rows within the cap are stamped');
  }

  console.log('\n5. rows that must be left alone');
  {
    const h = new Holder({ 'HUB1:P1': { filename: 'checkin' } });
    const rows = [
      upload({ folder_name: 'already' }),                       // a rollup resolved it
      upload({ event: 'media.workspace_move' }),                // says where it went itself
      { event: 'secure_share.opened', hub_id: 'HUB1', node_id: 'N' }, // not a file row
      { category: 'chat', hub_id: 'HUB1' },                     // no event
      upload({ src: JSON.stringify({ parent_id: '0' }) }),      // no real parent
      upload({ src: null, dest: null }),                        // nothing to go on
      upload({ hub_id: null }),                                 // no hub
    ];
    await h._stampFolderNames(rows);
    eq(h.calls.length, 0, 'none of these should cost a query');
    eq(rows[0].folder_name, 'already', 'an existing folder_name is never overwritten');
    for (let i = 1; i < rows.length; i++) {
      eq(rows[i].folder_name, undefined, `row ${i} left unstamped`);
    }
  }

  console.log('\n6. internal plumbing folders are not shown to users');
  {
    const h = new Holder({
      'HUB1:P1': { filename: '__upload__' },
      'HUB1:P2': { filename: '__chat__' },
      'HUB1:P3': { filename: '__weird' },
      'HUB1:P4': { filename: 'Real Folder' },
    });
    const rows = [1, 2, 3, 4].map((n) => upload({ src: JSON.stringify({ parent_id: `P${n}` }) }));
    await h._stampFolderNames(rows);
    eq(rows[0].folder_name, undefined, '__upload__ suppressed');
    eq(rows[1].folder_name, undefined, '__chat__ suppressed');
    eq(rows[2].folder_name, undefined, '__weird suppressed');
    eq(rows[3].folder_name, 'Real Folder', 'a real folder still shows');
  }

  console.log('\n7. failures never break the feed');
  {
    const h = new Holder({ 'HUB1:P1': 'THROW', 'HUB1:P2': { filename: 'fine' } });
    const rows = [
      upload(),
      upload({ src: JSON.stringify({ parent_id: 'P2' }) }),
    ];
    await h._stampFolderNames(rows);
    eq(rows[0].folder_name, undefined, 'a failed lookup leaves the chip off');
    eq(rows[1].folder_name, 'fine', 'and does not stop the other lookups');
    ok(h.debugs.length === 1, 'the failure is recorded, not thrown');
  }
  {
    const h = new Holder({ 'HUB1:P1': { /* no filename */ } });
    const rows = [upload()];
    await h._stampFolderNames(rows);
    eq(rows[0].folder_name, undefined, 'a node with no name yields no chip');
  }
  {
    // Unparseable src must not throw.
    const h = new Holder({});
    const rows = [upload({ src: '{not json' })];
    await h._stampFolderNames(rows);
    eq(rows[0].folder_name, undefined, 'bad JSON is ignored');
    eq(h.calls.length, 0, 'and costs nothing');
  }

  console.log('\n8. degenerate input');
  {
    const h = new Holder({});
    await h._stampFolderNames([]);
    await h._stampFolderNames(null);
    await h._stampFolderNames(undefined);
    await h._stampFolderNames('nope');
    await h._stampFolderNames([null, undefined]);
    eq(h.calls.length, 0, 'nothing to do, nothing done');
    ok(true, 'no throw on empty / non-array / null members');
  }

  console.log(`\n${'─'.repeat(56)}`);
  console.log(`folder-name resolution — ${pass} passed, ${fail} failed`);
  if (!fail) {
    console.log(`
  All good: the parent is resolved once per distinct folder, never for a
  row that already knows its folder or has no parent to resolve, the
  worst case is capped, internal plumbing names are withheld, and every
  failure path leaves the feed intact with the chip simply absent.`);
  }
  process.exit(fail ? 1 : 0);
})();
