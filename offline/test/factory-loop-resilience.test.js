#!/usr/bin/env node

/**
 * The hubs factory refills both pools from a single `while (1)` in
 * `initialize`, so every pass has to SETTLE and every branch of the pool check
 * has to return. Both invariants were broken at once — a rejected build left
 * `run`'s promise unsettled, and the healthy branch of `check_pool` called
 * `require("path").resolve` on a number — and the daemon's failure mode was
 * silence: pm2 reported it online with zero restarts while both pools drained
 * until `desk.create_hub` answered CREATION_FAILED.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const FACTORY_SOURCE = readFileSync(
  join(__dirname, "..", "factory", "index.js"),
  "utf8"
);

function extractAsyncMethod(name) {
  const start = FACTORY_SOURCE.indexOf(`  async ${name}(`);
  assert.notStrictEqual(start, -1, `${name} not found in factory`);
  const end = FACTORY_SOURCE.indexOf("\n  }\n", start);
  assert.notStrictEqual(end, -1, `${name} has no closing brace`);
  return FACTORY_SOURCE
    .slice(start, end + 4)
    .replace(/^\s*async\s+/, "async function ");
}

// eslint-disable-next-line no-new-func
const checkPool = new Function(`return (${extractAsyncMethod("check_pool")});`)();

function compileRun(LOG_CHANGED) {
  // eslint-disable-next-line no-new-func
  return new Function(
    "existsSync",
    "LOG_CHANGED",
    `return (${extractAsyncMethod("run")});`
  )(() => true, LOG_CHANGED);
}

// A stopped clock: the pass must be driven by its own awaits, not by wall time.
const factoryBase = () => ({
  timer: 15000,
  check_pool: checkPool,
  watermark: { hub: 210, drumate: 210 },
  pause: async () => {},
  script_path: (type, ext) => `/tmp/drumee-template-${type}.${ext || "sql"}`,
  error: () => assert.fail("must not treat a build failure as a bad template"),
});

test("a pool at its watermark reports its count instead of throwing", async () => {
  const factory = {
    ...factoryBase(),
    yp: { await_func: async () => "210" },
  };
  assert.strictEqual(await checkPool.call(factory, "hub"), 210);
});

test("a pool below its watermark reports 0 so the pass builds", async () => {
  const factory = {
    ...factoryBase(),
    yp: { await_func: async () => "4" },
  };
  assert.strictEqual(await checkPool.call(factory, "hub"), 0);
});

test("a pass settles when a build fails, and still visits the second pool", async () => {
  const built = [];
  const run = compileRun({});
  const factory = {
    ...factoryBase(),
    yp: { await_func: async () => "0" },
    make_schema: async (type) => {
      built.push(type);
      throw new Error("INCOMPLETE ENTITY");
    },
  };

  const originalError = console.error;
  console.error = () => {};
  try {
    // No timeout guard needed: an unsettled promise fails the test by hanging,
    // which is precisely the regression.
    await run.call(factory);
  } finally {
    console.error = originalError;
  }

  assert.deepStrictEqual(built, ["drumate", "hub"]);
  assert.strictEqual(factory.failures, 2);
});

// eslint-disable-next-line no-new-func
const discard = new Function(`return (${extractAsyncMethod("discard")});`)();

test("discarding a half-built entity always closes its connection", async () => {
  const calls = [];
  const schema = {
    // The real delete_entity reports the rollback by THROWING.
    delete_entity: async (reason) => {
      calls.push(`delete:${reason}`);
      throw `roll back on ${reason}`;
    },
    destroy: () => calls.push("destroy"),
  };

  const originalError = console.error;
  console.error = () => {};
  try {
    await discard.call({}, schema);
  } finally {
    console.error = originalError;
  }

  // Without the destroy() a retried build leaks one DB connection per attempt.
  assert.deepStrictEqual(calls, ["delete:Aborted", "destroy"]);
});

test("discard survives a schema that is already torn down", async () => {
  const schema = {
    delete_entity: async () => {},
    destroy: () => { throw new Error("already destroyed"); },
  };
  await discard.call({}, schema);
});

test("a successful build clears the failure streak", async () => {
  const run = compileRun({});
  const factory = {
    ...factoryBase(),
    failures: 7,
    yp: { await_func: async () => "0" },
    make_schema: async () => {},
  };
  await run.call(factory);
  assert.strictEqual(factory.failures, 0);
});
