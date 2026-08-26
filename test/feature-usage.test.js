// test/feature-usage.test.js
const assert = require("assert");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL ${name}: ${e.message}`); failed++; }
}

async function asyncTest(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL ${name}: ${e.message}`); failed++; }
}

const lib = require("../service/lib/feature-usage");

/** A stand-in handler: records the calls feature_mark would have received. */
function fakeCtx() {
  const calls = [];
  return {
    calls,
    uid: "u1",
    warn: () => {},
    yp: { await_proc: (...a) => { calls.push(a); return Promise.resolve(); } },
  };
}

test("accumulates hits in memory instead of posting per event", () => {
  lib._reset();
  const ctx = fakeCtx();
  lib.markFeatureUsage(ctx, "upload", { hits: 1, volume: 100 });
  lib.markFeatureUsage(ctx, "upload", { hits: 1, volume: 200 });
  lib.markFeatureUsage(ctx, "upload", { hits: 1, volume: 300 });
  assert.strictEqual(ctx.calls.length, 0, "nothing posted before flush");
});

test("flush posts one call carrying the summed delta", () => {
  lib._reset();
  const ctx = fakeCtx();
  lib.markFeatureUsage(ctx, "upload", { hits: 1, volume: 100 });
  lib.markFeatureUsage(ctx, "upload", { hits: 1, volume: 200 });
  lib._flushNow();
  assert.strictEqual(ctx.calls.length, 1);
  assert.deepStrictEqual(ctx.calls[0], ["feature_mark", "u1", "upload", 2, 300]);
});

test("separate features flush as separate calls", () => {
  lib._reset();
  const ctx = fakeCtx();
  lib.markFeatureUsage(ctx, "chat", { hits: 1 });
  lib.markFeatureUsage(ctx, "task", { hits: 1 });
  lib._flushNow();
  assert.strictEqual(ctx.calls.length, 2);
});

test("no uid means no write", () => {
  lib._reset();
  const ctx = fakeCtx();
  ctx.uid = null;
  lib.markFeatureUsage(ctx, "chat", { hits: 1 });
  lib._flushNow();
  assert.strictEqual(ctx.calls.length, 0);
});

test("dedupe key collapses repeats within the window", () => {
  lib._reset();
  const ctx = fakeCtx();
  lib.markFeatureUsage(ctx, "meeting", { hits: 1, dedupe: "room-7" });
  lib.markFeatureUsage(ctx, "meeting", { hits: 1, dedupe: "room-7" });
  lib.markFeatureUsage(ctx, "meeting", { hits: 1, dedupe: "room-9" });
  lib._flushNow();
  assert.deepStrictEqual(ctx.calls[0], ["feature_mark", "u1", "meeting", 2, 0]);
});

test("a failed flush does not throw at the caller", () => {
  lib._reset();
  const ctx = fakeCtx();
  ctx.yp.await_proc = () => Promise.reject(new Error("db down"));
  lib.markFeatureUsage(ctx, "chat", { hits: 1 });
  assert.doesNotThrow(() => lib._flushNow());
});

test("a second flush posts only the new increment, not a cumulative total", () => {
  lib._reset();
  const ctx = fakeCtx();
  lib.markFeatureUsage(ctx, "upload", { hits: 1, volume: 100 });
  lib._flushNow();
  lib.markFeatureUsage(ctx, "upload", { hits: 1, volume: 50 });
  lib._flushNow();
  assert.strictEqual(ctx.calls.length, 2);
  assert.deepStrictEqual(ctx.calls[1], ["feature_mark", "u1", "upload", 1, 50]);
});

async function main() {
  // The synchronous "does not throw" test above only proves _flushNow()
  // itself doesn't throw -- it says nothing about a .catch()-less rejected
  // promise inside flush(), which surfaces asynchronously (as an
  // unhandledRejection) after _flushNow() has already returned. Trap that
  // explicitly and let pending microtasks settle before asserting.
  await asyncTest("a failed flush's rejection does not surface as unhandled", async () => {
    lib._reset();
    const ctx = fakeCtx();
    ctx.yp.await_proc = () => Promise.reject(new Error("db down"));
    lib.markFeatureUsage(ctx, "chat", { hits: 1 });

    let trapped = null;
    const onUnhandledRejection = (err) => { trapped = err; };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      assert.doesNotThrow(() => lib._flushNow());
      // Give the rejected promise a turn of the microtask queue to surface
      // as an unhandledRejection before we check whether it did.
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(trapped, null, "flush left an unhandled rejection");
    } finally {
      process.removeListener("unhandledRejection", onUnhandledRejection);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
