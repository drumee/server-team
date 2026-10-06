// A workspace made from "New workspace" (desk.create_hub) opens with the two
// example tasks of Figma Board 922:159854, through schemas'
// task_seed_examples. Seeding is best effort: a hub that lacks the procedure
// (pool built before the patch) or a failing CALL must leave creation as it was.
//
// Run: node --test --test-force-exit test/desk-create-hub-example-tasks.test.js
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

global.myDrumee = { arch: "pod", useEmail: 0 };
global.verbosity = 0;
global.debug = {};

const DeskPrivate = require("../service/private/desk");
const seed = DeskPrivate.prototype._seedExampleTasks;

function fake({ hasProc = true, callThrows = false, seeded = 2 } = {}) {
  const calls = [];
  const warns = [];
  return {
    uid: "uOwner",
    calls,
    warns,
    warn: (...a) => warns.push(a.join(" ")),
    db: {
      await_query: async (sql, ...args) => {
        calls.push({ sql, args });
        return { n: hasProc ? 1 : 0 };
      },
      await_proc: async (name, ...args) => {
        calls.push({ name, args });
        if (callThrows) throw new Error("Unknown column 'reporter_uid'");
        return { seeded };
      },
    },
  };
}

test("calls the hub's task_seed_examples with the Figma copy", async () => {
  const f = fake();
  assert.equal(await seed.call(f, "hub_db_1", "home1"), 2);
  const call = f.calls.find((c) => c.name);
  assert.equal(call.name, "hub_db_1.task_seed_examples");
  assert.deepEqual(call.args, ["uOwner", "home1", "Task 1", "Task 2", "Enter the description for task"]);
});

test("checks information_schema for the procedure in THAT hub db first", async () => {
  const f = fake();
  await seed.call(f, "hub_db_1", "home1");
  assert.match(f.calls[0].sql, /information_schema\.routines/);
  assert.match(f.calls[0].sql, /task_seed_examples/);
  assert.deepEqual(f.calls[0].args, ["hub_db_1"]);
});

test("missing procedure: no CALL, creation unaffected", async () => {
  const f = fake({ hasProc: false });
  assert.equal(await seed.call(f, "hub_db_1", "home1"), 0);
  assert.equal(f.calls.filter((c) => c.name).length, 0, "never CALL a missing proc (ERROR 1305 desyncs the connection)");
});

test("CALL throws: warned, creation unaffected", async () => {
  const f = fake({ callThrows: true });
  assert.equal(await seed.call(f, "hub_db_1", "home1"), 0);
  assert.equal(f.warns.length, 1);
});

// What production actually does on an SQL error: server-essentials'
// mariadb _handleError logs "SQL failure", closes the connection and
// RESOLVES undefined — it does not reject (verified against the real driver
// in the final review). The helper must still answer 0 and say why.
test("CALL fails in the driver (resolves undefined): 0, and warned", async () => {
  const f = fake();
  f.db.await_proc = async (name, ...args) => {
    f.calls.push({ name, args });
    return undefined;
  };
  assert.equal(await seed.call(f, "hub_db_1", "home1"), 0);
  assert.equal(f.warns.length, 1);
  assert.match(f.warns[0], /example tasks not seeded/);
});

test("a no-op seed (workspace already has tasks) is not a warning", async () => {
  const f = fake({ seeded: 0 });
  assert.equal(await seed.call(f, "hub_db_1", "home1"), 0);
  assert.equal(f.warns.length, 0);
});

test("no hub db or no root nid: nothing is attempted", async () => {
  for (const [db, nid] of [[null, "home1"], ["hub_db_1", null]]) {
    const f = fake();
    assert.equal(await seed.call(f, db, nid), 0);
    assert.equal(f.calls.length, 0);
  }
});

test("only create_hub seeds — not the wicket, DM hubs or copy_workspace", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "service/private/desk.js"), "utf8");
  const body = (name) => {
    const a = src.indexOf(`  async ${name}(`);
    const b = src.indexOf("\n  async ", a + 1);
    return src.slice(a, b);
  };
  const create = body("create_hub");
  assert.match(create, /await this\._seedExampleTasks\(hub_db, media\.actual_home_id\);/);
  assert.ok(
    create.indexOf("_seedExampleTasks") < create.indexOf("this.output.data(media)"),
    "seed before answering, so the Task tab's first list sees the rows",
  );
  assert.doesNotMatch(body("create_wicket"), /_seedExampleTasks/);
  assert.doesNotMatch(body("_createHub"), /_seedExampleTasks/);
  const others = ["service/private/channel.js", "service/private/media.js", "service/lib/env.js"]
    .map((p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8"));
  for (const s of others) assert.doesNotMatch(s, /task_seed_examples|_seedExampleTasks/);
});
