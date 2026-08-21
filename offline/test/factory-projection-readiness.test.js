#!/usr/bin/env node

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const REPO_ROOT = join(__dirname, "..", "..");
const SCHEMA_SOURCE = readFileSync(
  join(REPO_ROOT, "offline", "factory", "schema.js"),
  "utf8"
);

const Attr = { type: "type" };
const isEmpty = (value) => value == null || value === "";

function extractAsyncMethod(name) {
  const start = SCHEMA_SOURCE.indexOf(`  async ${name}(`);
  assert.notStrictEqual(start, -1, `${name} not found in factory schema`);
  const end = SCHEMA_SOURCE.indexOf("\n  }\n", start);
  assert.notStrictEqual(end, -1, `${name} has no closing brace`);
  return SCHEMA_SOURCE
    .slice(start, end + 4)
    .replace(/^\s*async\s+/, "async function ");
}

// Compile the real methods without loading private runtime dependencies.
// eslint-disable-next-line no-new-func
const publishSearchProjection = new Function(
  `return (${extractAsyncMethod("publish_search_projection")});`
)();
// eslint-disable-next-line no-new-func
const createEntity = new Function(
  "Attr",
  "isEmpty",
  `return (${extractAsyncMethod("create_entity")});`
)(Attr, isEmpty);

test("factory publishes the search projection before advertising a clean pool entity", async () => {
  const calls = [];
  const entity = { id: "hub-1", db_name: "hub_db", home_id: "root-1" };
  const factory = {
    get: (key) => key === Attr.type ? "hub" : undefined,
    yp: {
      await_proc: async (name, type) => {
        calls.push(["entity_create", name, type]);
        return entity;
      },
      await_query: async (sql) => calls.push(["pool_clean", sql]),
    },
    load_sql: async () => {
      calls.push(["load_sql"]);
      return true;
    },
    create_vfs_root: async () => {
      calls.push(["create_vfs_root"]);
      return true;
    },
    publish_search_projection: async () => {
      calls.push(["publish_search_projection"]);
      return true;
    },
    delete_entity: async () => assert.fail("successful creation must not delete"),
  };

  assert.strictEqual(await createEntity.call(factory), true);
  assert.deepStrictEqual(calls.map(([name]) => name), [
    "entity_create",
    "load_sql",
    "create_vfs_root",
    "publish_search_projection",
    "pool_clean",
  ]);
  assert.match(calls.at(-1)[1], /\$\.pool_state", "clean"/);
});

test("factory never marks the pool clean when projection publication fails", async () => {
  const calls = [];
  const factory = {
    get: () => "drumate",
    yp: {
      await_proc: async () => ({ id: "user-1", db_name: "user_db" }),
      await_query: async () => calls.push("pool_clean"),
    },
    load_sql: async () => true,
    create_vfs_root: async () => true,
    publish_search_projection: async () => false,
    delete_entity: async () => {},
  };

  assert.strictEqual(await createEntity.call(factory), undefined);
  assert.deepStrictEqual(calls, []);
});

test("projection publication accepts only a positive READY generation", async () => {
  const cases = [
    { result: { state: "READY", generation: 1 }, expected: true },
    { result: [{ state: "READY", generation: "2" }], expected: true },
    { result: { state: "BUILDING", generation: 2 }, expected: false },
    { result: { state: "READY", generation: 0 }, expected: false },
    { result: null, expected: false },
  ];

  const originalError = console.error;
  console.error = () => {};
  try {
    for (const { result, expected } of cases) {
      const calls = [];
      const factory = {
        db: {
          await_proc: async (name) => {
            calls.push(name);
            return result;
          },
        },
      };
      assert.strictEqual(
        await publishSearchProjection.call(factory),
        expected
      );
      assert.deepStrictEqual(calls, ["mfs_search_projection_rebuild"]);
    }
  } finally {
    console.error = originalError;
  }
});
