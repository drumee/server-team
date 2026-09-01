#!/usr/bin/env node
//
// task-column-set-done.test.js — the writer for task_column.is_done.
//
//   node offline/test/task-column-set-done.test.js
//
// is_done has existed on every database since
// common/patches/alter_task_column_add_is_done.sql, and the whole completion
// model already rests on it — task_update_status stamps completed_at from it,
// task_list.subtask_done counts it, the client keeps the done columns as a set.
// The one thing missing was a way to SET it, so only the seeded built-in
// 'complete' was ever a done column.
//
// What is pinned here, in descending order of how much it would cost to get
// wrong:
//
//   · THE EXISTING COLUMN PROCS KEEP THEIR SIGNATURES. Adding an is_done
//     parameter to task_column_create / task_column_update_v2 is a breaking
//     change: every deployed caller passes four arguments, and the house rule
//     is that a changed signature forces a _vN rename. The whole reason this
//     feature is a separate routine is to avoid that, so a test has to hold
//     the line — otherwise the "simplification" of folding it into
//     column_update looks harmless in review.
//   · AN EMPTY RESULT IS A FAILURE, NOT AN EMPTY SUCCESS. await_run does not
//     throw: the driver logs, ends the connection and returns nothing. So a
//     hub DB without the routine applied yet answers exactly like a column
//     that does not exist, and the only safe reading of both is "the write did
//     not land". Acking it would tell the user a column is now their done
//     column while every completion count still says otherwise.
//   · is_done IS NORMALISED TO 0/1. '0' and 'false' arrive from form payloads
//     as STRINGS and both are truthy in JS, so a naive read turns every
//     "clear the flag" into "set the flag" — the failure nobody reports
//     because the switch appears to work.
//   · THE FLAG IS PER COLUMN, NOT A RADIO. A board may legitimately treat
//     several columns as finished, so this must never clear the others.
//
// It runs the REAL code: the method is sliced out of service/private/task.js
// and evaluated, rather than copy-pasted here.
//
// Exit code 0 = all pass, 1 = any failure.

const { readFileSync, existsSync } = require('fs');
const { join } = require('path');

const SRC = join(__dirname, '../../service/private/task.js');
const src = readFileSync(SRC, 'utf8');
const ACL = join(__dirname, '../../acl/task.json');
const aclRaw = readFileSync(ACL, 'utf8');
const acl = JSON.parse(aclRaw);

// The schemas repo is a separate checkout, so the SQL assertions run only when
// it sits at the conventional sibling path. The skip is printed loudly rather
// than silently counted as a pass.
const SCHEMAS = join(__dirname, '../../../schemas');

let pass = 0;
let fail = 0;
let skipped = 0;
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

// ── slice the real method ──────────────────────────────────────────────────
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

// Parameter names of a stored procedure. The obvious
// /CREATE PROCEDURE `x`\(([\s\S]*?)\)/ is WRONG and silently returns just the
// first parameter: it is non-greedy, so it stops at the `)` inside the first
// type — VARCHAR(16). Anchor on the closing paren that starts its own line.
function sqlParams(sql, name) {
  const m = new RegExp('CREATE PROCEDURE `' + name + '`\\(([\\s\\S]*?)\\n\\)').exec(sql);
  if (!m) return null;
  return m[1]
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => x.split(/\s+/)[1]);
}

const isEmpty = (v) =>
  v == null || (Array.isArray(v) ? v.length === 0 : typeof v === 'object' ? Object.keys(v).length === 0 : v === '');
const Attr = { id: 'id' };

const Holder = new Function(
  'isEmpty', 'Attr',
  `class Holder {
     constructor(answer, input) {
       this.uid = 'U1';
       this.calls = [];
       this.broadcasts = [];
       this.exceptions = [];
       this.sent = undefined;
       this.answer = answer;
       const self = this;
       this.input = {
         use(k, d) { return input && k in input ? input[k] : d; },
         need(k) { return input ? input[k] : undefined; },
       };
       this.output = { data(d) { self.sent = d; }, list(d) { self.sent = d; } };
       this.exception = { user(code) { self.exceptions.push(code); return code; } };
       this.db = {
         async await_run(sql, args) {
           self.calls.push({ sql, args });
           return self.answer;
         },
       };
     }
     async _broadcast(service, data) { this.broadcasts.push({ service, data }); }
     ${sliceMethod('column_set_done')}
   }
   return Holder;`,
)(isEmpty, Attr);

const ROW = { id: 'C1', nid: 'N1', name: 'Released', theme: 'green', position: 4, is_done: 1 };

(async () => {
  // ── 1. the write reaches the right routine, scoped ───────────────────────
  console.log('\n1. the call itself');
  {
    const h = new Holder([ROW], { id: 'C1', nid: 'N1', is_done: 1 });
    await h.column_set_done();
    eq(h.calls.length, 1, 'exactly one DB call');
    ok(
      /CALL task_column_set_done\(\?, \?, \?\)/.test(h.calls[0].sql),
      'calls task_column_set_done with three placeholders',
    );
    deq(h.calls[0].args, ['C1', 'N1', 1], 'id, folder scope and the flag, in that order');
    // The folder scope is the whole reason this cannot key on id alone:
    // built-in ids are literal status keys stored once PER board.
    ok(h.calls[0].args[1] === 'N1', 'nid is forwarded, so one board is touched and not every board');
  }

  // ── 2. is_done is normalised — the string trap ───────────────────────────
  console.log('\n2. is_done normalisation');
  {
    const cases = [
      [1, 1, 'number 1'],
      ['1', 1, "string '1'"],
      [0, 0, 'number 0'],
      ['0', 0, "string '0' — truthy in JS, must still clear"],
      ['', 0, 'empty string'],
      [undefined, 0, 'absent parameter defaults to clearing'],
      ['nonsense', 0, 'unparseable input clears rather than sets'],
    ];
    for (const [given, want, label] of cases) {
      const input = { id: 'C1', nid: 'N1' };
      if (given !== undefined) input.is_done = given;
      const h = new Holder([ROW], input);
      await h.column_set_done();
      eq(h.calls[0].args[2], want, `${label} → ${want}`);
      ok(
        h.calls[0].args[2] === 0 || h.calls[0].args[2] === 1,
        `${label} stores a real 0/1, never a third state`,
      );
    }
  }

  // ── 3. an empty answer is a failure, never a silent success ──────────────
  console.log('\n3. empty result handling');
  {
    for (const [answer, label] of [
      [[], 'empty array — no such column in this scope'],
      [undefined, 'undefined — the driver swallowed a SQL error'],
      [null, 'null'],
    ]) {
      const h = new Holder(answer, { id: 'C1', nid: 'N1', is_done: 1 });
      await h.column_set_done();
      deq(h.exceptions, ['COLUMN_NOT_FOUND'], `${label} raises COLUMN_NOT_FOUND`);
      eq(h.sent, undefined, `${label} sends no data`);
      eq(h.broadcasts.length, 0, `${label} broadcasts nothing`);
    }
  }

  // ── 4. a real write answers and tells the other members ──────────────────
  console.log('\n4. the success path');
  {
    const h = new Holder([ROW], { id: 'C1', nid: 'N1', is_done: 1 });
    await h.column_set_done();
    deq(h.exceptions, [], 'no exception');
    deq(h.sent, [ROW], 'the updated row is returned');
    eq(h.broadcasts.length, 1, 'one broadcast');
    eq(h.broadcasts[0].service, 'task.column_set_done', 'under its own service name');
    ok(
      h.broadcasts[0].service !== 'task.column_update',
      'not folded into column_update — the client reloads columns for both, but a distinct name keeps the two revertible apart',
    );
  }

  // ── 5. the ACL entry ─────────────────────────────────────────────────────
  console.log('\n5. acl/task.json');
  {
    const s = acl.services && acl.services.column_set_done;
    ok(s, 'column_set_done is declared');
    eq(s && s.scope, 'hub', 'scope: hub — it writes into a workspace DB');
    eq(s && s.permission && s.permission.src, 'write', 'src: write — a viewer must not flip completion');
    ok(s && s.params && s.params.id && s.params.id.required === true, 'id is required');
    ok(s && s.params && s.params.nid, 'nid is declared, so the folder scope is part of the contract');
    ok(s && s.params && s.params.is_done, 'is_done is declared');
    ok(
      (s.errors || []).some((e) => e.code === 'COLUMN_NOT_FOUND'),
      'COLUMN_NOT_FOUND is documented and matches the implementation',
    );
    // The ACL is the routing table: a typo here is a 404 at runtime with no
    // compile-time signal.
    ok(
      /column_set_done\(\)/.test(src),
      'the worker really implements the method the ACL names',
    );
  }

  // ── 6. THE NON-NEGOTIABLE — no signature change on the existing procs ────
  console.log('\n6. the existing column procs are untouched');
  {
    // Reachable from the service code regardless of the schemas checkout:
    // every call site still passes four arguments.
    const create = /CALL task_column_create\(([^)]*)\)/.exec(src);
    const update = /CALL task_column_update_v2\(([^)]*)\)/.exec(src);
    ok(create, 'task_column_create is still called');
    ok(update, 'task_column_update_v2 is still called');
    eq(create && create[1].split(',').length, 4, 'task_column_create still takes 4 arguments');
    eq(update && update[1].split(',').length, 4, 'task_column_update_v2 still takes 4 arguments');
    // Slice the METHOD BODY, not the source between two offsets: the doc
    // comment that precedes column_set_done explains is_done at length, and a
    // range-based slice swallows it and fails on the explanation rather than
    // on the code. (It did, the first time this test ran.)
    ok(
      !/is_done/.test(sliceMethod('column_update')),
      'column_update never reads or writes is_done',
    );
    const cu = acl.services.column_update;
    ok(!(cu.params && cu.params.is_done), 'the ACL for column_update gained no is_done parameter');
    const cc = acl.services.column_create;
    ok(!(cc.params && cc.params.is_done), 'the ACL for column_create gained no is_done parameter');
  }

  // ── 7. the SQL routine, when the schemas checkout is next door ───────────
  console.log('\n7. common/procedures/task/task_column_set_done.sql');
  if (!existsSync(SCHEMAS)) {
    skipped += 1;
    console.log(`  ⚠ SKIPPED — no schemas checkout at ${SCHEMAS}`);
  } else {
    const f = join(SCHEMAS, 'common/procedures/task/task_column_set_done.sql');
    ok(existsSync(f), 'the routine file exists');
    if (existsSync(f)) {
      const sql = readFileSync(f, 'utf8');
      ok(/DROP PROCEDURE IF EXISTS `task_column_set_done`\$/.test(sql), 'idempotent DROP before CREATE');
      const params = sqlParams(sql, 'task_column_set_done');
      ok(params, 'the signature parses');
      deq(params, ['_id', '_nid', '_is_done'], 'exactly (_id, _nid, _is_done)');
      ok(/IN _id/.test(sql) && /IN _nid/.test(sql) && /IN _is_done/.test(sql), 'every parameter carries IN');
      ok(/END\$/.test(sql) && !/END \$/.test(sql), 'END$ with no space, per house style');
      // The two properties that make it safe to run on a fleet.
      //
      // Assert INSIDE the UPDATE statement, not across the file. The obvious
      // /UPDATE task_column[\s\S]*?IFNULL\(nid, ''\) = _scope/ passes even on
      // a completely UNSCOPED update, because [\s\S]*? happily runs past the
      // statement's own semicolon and finds the scope clause in the SELECT
      // below. A mutation run proved it: dropping the scope from the UPDATE
      // left this test green.
      const stmts = sql.split(';');
      const updates = stmts.filter((s) => /\bUPDATE\s+task_column\b/.test(s));
      eq(updates.length, 1, 'exactly one UPDATE statement');
      ok(
        updates[0] && /WHERE id = _id/.test(updates[0]),
        'the UPDATE names a single column id',
      );
      ok(
        updates[0] && /IFNULL\(nid, ''\) = _scope/.test(updates[0]),
        'the UPDATE itself carries the folder scope — without it the flag hits every board in the workspace',
      );
      ok(
        !/UPDATE task_column[\s\S]*?SET is_done = 0[\s\S]*?WHERE id <> _id/.test(sql),
        'it never clears the other columns — several may be done columns',
      );
      ok(/DECLARE _scope VARCHAR\(16\) CHARACTER SET ascii/.test(sql), 'ascii scope var, or the compare raises 1267');
      ok(!/DROP TABLE/i.test(sql), 'no DROP TABLE anywhere near a fleet apply');
      ok(!/ALTER TABLE/i.test(sql), 'no table change — is_done already exists everywhere');
    }

    // And the existing procs must still be four-parameter.
    for (const [name, want] of [
      ['task_column_create', ['_id', '_nid', '_name', '_theme']],
      ['task_column_update_v2', ['_id', '_nid', '_name', '_theme']],
    ]) {
      const p = join(SCHEMAS, `common/procedures/task/${name}.sql`);
      if (!existsSync(p)) { ok(false, `${name}.sql found`); continue; }
      const sql = readFileSync(p, 'utf8');
      deq(
        sqlParams(sql, name),
        want,
        `${name} still takes exactly ${want.length} parameters — a fifth would be a breaking change`,
      );
    }
  }

  console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
  process.exit(fail ? 1 : 0);
})();
