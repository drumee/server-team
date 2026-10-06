// A workspace made from desk.create_hub opens with the two example tasks of
// Figma Board 922:159854 ("Task 1", "Task 2" in To Do). The server inserts
// them itself — no stored procedure — so it works for every workspace created
// after the deploy, pool hubs included, with nothing to patch in hub DBs.
// Best effort: a hub without a task table, an error, or a workspace that
// already has tasks leaves creation exactly as before.
//
// Run: node --test --test-force-exit test/desk-create-hub-example-tasks.test.js
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

global.myDrumee = { arch: "pod", useEmail: 0 };
global.verbosity = 0;
global.debug = {};

const { buildSeedInsert, REQUIRED_COLUMNS } = require("../service/lib/example-tasks");
const DeskPrivate = require("../service/private/desk");
const seed = DeskPrivate.prototype._seedExampleTasks;

const ALL_COLUMNS = [...REQUIRED_COLUMNS, "rank", "reporter_uid", "start_date"];

// ── buildSeedInsert (pure) ────────────────────────────────────────────────
test("insert: both Figma tasks in To Do, medium, due a week out, one statement", () => {
  const { sql, params } = buildSeedInsert("hub_db_1", ALL_COLUMNS, ["id1", "id2"], "uOwner", "home1");
  assert.match(sql, /^INSERT INTO `hub_db_1`\.task \(/);
  assert.match(sql, /'todo'/);
  assert.match(sql, /'medium'/);
  assert.match(sql, /CURDATE\(\) \+ INTERVAL 7 DAY/);
  assert.match(sql, /WHERE NOT EXISTS \(SELECT 1 FROM `hub_db_1`\.task\)/);
  assert.deepEqual(params, [
    "id1", "Task 1", "Enter the description for task", "uOwner", "home1",
    "id2", "Task 2", "Enter the description for task", "uOwner", "home1",
  ]);
});

test("insert: rank only when the column exists; reporter_uid never (NULL = creator)", () => {
  const withRank = buildSeedInsert("h", ALL_COLUMNS, ["a", "b"], "u", "n").sql;
  assert.match(withRank, /, rank\)/);
  const noRank = buildSeedInsert("h", REQUIRED_COLUMNS, ["a", "b"], "u", "n").sql;
  assert.doesNotMatch(noRank, /rank/);
  assert.doesNotMatch(withRank, /reporter_uid/);
});

test("insert: refuses a missing required column or an unsafe db name", () => {
  assert.equal(buildSeedInsert("h", REQUIRED_COLUMNS.filter((c) => c !== "due_date"), ["a", "b"], "u", "n"), null);
  assert.equal(buildSeedInsert("h`; DROP", ALL_COLUMNS, ["a", "b"], "u", "n"), null);
  assert.equal(buildSeedInsert("h", ALL_COLUMNS, ["a"], "u", "n"), null);
});

// ── _seedExampleTasks (desk) ──────────────────────────────────────────────
function fake({ columns = ALL_COLUMNS, insert = { affectedRows: 2 }, insertFails = false } = {}) {
  const calls = [];
  const warns = [];
  let n = 0;
  return {
    uid: "uOwner",
    calls,
    warns,
    warn: (...a) => warns.push(a.join(" ")),
    yp: { await_func: async (name) => (calls.push({ yp: name }), `id${++n}`) },
    db: {
      await_query: async (sql, ...args) => {
        calls.push({ sql, args });
        if (/information_schema\.columns/.test(sql)) {
          // The driver unwraps a single-row answer to an object.
          const rows = columns.map((c) => ({ c }));
          return rows.length === 1 ? rows[0] : rows;
        }
        return insertFails ? undefined : insert;
      },
    },
  };
}

test("seeds 2 into THAT hub's task table, with fresh ids", async () => {
  const f = fake();
  assert.equal(await seed.call(f, "hub_db_1", "home1"), 2);
  assert.deepEqual(f.calls[0].args, ["hub_db_1"]);
  assert.equal(f.calls.filter((c) => c.yp === "uniqueId").length, 2);
  const ins = f.calls.find((c) => c.sql && c.sql.startsWith("INSERT"));
  assert.match(ins.sql, /`hub_db_1`\.task/);
  assert.deepEqual(ins.args.slice(0, 2), ["id1", "Task 1"]);
});

test("hub without a task table: nothing inserted, no warning", async () => {
  const f = fake({ columns: [] });
  assert.equal(await seed.call(f, "hub_db_1", "home1"), 0);
  assert.equal(f.calls.filter((c) => c.sql && c.sql.startsWith("INSERT")).length, 0);
  assert.equal(f.warns.length, 0);
});

test("workspace already has tasks (affectedRows 0): 0, not a warning", async () => {
  const f = fake({ insert: { affectedRows: 0 } });
  assert.equal(await seed.call(f, "hub_db_1", "home1"), 0);
  assert.equal(f.warns.length, 0);
});

// The driver resolves undefined on an SQL error (logs, closes, never rejects).
test("insert fails in the driver (resolves undefined): 0, and warned", async () => {
  const f = fake({ insertFails: true });
  assert.equal(await seed.call(f, "hub_db_1", "home1"), 0);
  assert.equal(f.warns.length, 1);
  assert.match(f.warns[0], /example tasks not seeded/);
});

test("a drifted table missing a required column: warned, nothing inserted", async () => {
  const f = fake({ columns: REQUIRED_COLUMNS.filter((c) => c !== "description") });
  assert.equal(await seed.call(f, "hub_db_1", "home1"), 0);
  assert.equal(f.calls.filter((c) => c.sql && c.sql.startsWith("INSERT")).length, 0);
  assert.equal(f.warns.length, 1);
});

test("a rejecting driver call: 0, and warned", async () => {
  const f = fake();
  f.db.await_query = async () => { throw new Error("boom"); };
  assert.equal(await seed.call(f, "hub_db_1", "home1"), 0);
  assert.equal(f.warns.length, 1);
});

test("no hub db or no root nid: nothing is attempted", async () => {
  for (const [db, nid] of [[null, "home1"], ["hub_db_1", null]]) {
    const f = fake();
    assert.equal(await seed.call(f, db, nid), 0);
    assert.equal(f.calls.length, 0);
  }
});

test("only create_hub seeds — not the wicket, DM hubs or copy_workspace; no stored procedure", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "service/private/desk.js"), "utf8");
  const body = (name) => {
    const a = src.indexOf(`  async ${name}(`);
    const b = src.indexOf("\n  async ", a + 1);
    return src.slice(a, b);
  };
  const create = body("create_hub");
  assert.match(create, /await this\._seedExampleTasks\(hub_db, media\.actual_home_id\);/);
  assert.ok(create.indexOf("_seedExampleTasks") < create.indexOf("this.output.data(media)"));
  assert.doesNotMatch(body("create_wicket"), /_seedExampleTasks/);
  assert.doesNotMatch(body("_createHub"), /_seedExampleTasks/);
  assert.doesNotMatch(src, /task_seed_examples/);
  for (const p of ["service/private/channel.js", "service/private/media.js", "service/lib/env.js"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "..", p), "utf8"), /_seedExampleTasks|example-tasks/);
  }
});

// ── Against real MariaDB (local socket), through the real driver ──────────
const SOCKET = "/var/run/mysqld/mysqld.sock";
test("real MariaDB: inserts 2, then 0; rows read back as designed", { skip: !fs.existsSync(SOCKET) }, async () => {
  const { execSync } = require("node:child_process");
  const db = "example_tasks_test";
  const sh = (s) => execSync(`mariadb -N -e ${JSON.stringify(s)}`).toString().trim();
  sh(`DROP DATABASE IF EXISTS ${db}; CREATE DATABASE ${db} CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`);
  execSync(`mariadb ${db} < ${path.join(__dirname, "../../schemas/common/tables/task.sql")}`);
  try {
    const DB = require("@drumee/server-essentials/lib/mariadb");
    const conn = new DB({ name: "information_schema" }, { socketPath: SOCKET });
    let n = 0;
    const host = {
      uid: "uOwner",
      warn: () => {},
      yp: { await_func: async () => `seedid0000000${++n}`.slice(-16) },
      db: conn,
    };
    assert.equal(await seed.call(host, db, "home1"), 2);
    assert.equal(await seed.call(host, db, "home1"), 0);
    assert.equal(
      sh(`SELECT GROUP_CONCAT(CONCAT_WS('|',title,status,priority,due_date=CURDATE()+INTERVAL 7 DAY,IFNULL(reporter_uid,'NULL'),nid) ORDER BY rank SEPARATOR ';') FROM ${db}.task`),
      "Task 1|todo|medium|1|NULL|home1;Task 2|todo|medium|1|NULL|home1",
    );
  } finally {
    sh(`DROP DATABASE IF EXISTS ${db}`);
  }
});
