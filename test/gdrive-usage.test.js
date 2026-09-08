// test/gdrive-usage.test.js
const assert = require("assert");

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

const { markMigrationUsage } = require("../offline/workers/gdrive/mark-usage");

/** Records the feature_mark calls a real yp handle would have received. */
function fakeYp(behaviour = () => Promise.resolve()) {
  const calls = [];
  return { calls, await_proc: (...a) => { calls.push(a); return behaviour(); } };
}

(async () => {
  await test("marks one migration carrying the byte total", async () => {
    const yp = fakeYp();
    const ok = await markMigrationUsage(yp, "u1", { processed_files: 12, total_bytes: 5000 });
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(yp.calls[0], ["feature_mark", "u1", "gdrive", 1, 5000]);
  });

  await test("a cancelled job that moved files still counts", async () => {
    const yp = fakeYp();
    const ok = await markMigrationUsage(yp, "u1", { cancelled: true, processed_files: 200, total_bytes: 900 });
    assert.strictEqual(ok, true);
    assert.strictEqual(yp.calls.length, 1);
  });

  await test("a job that moved nothing is not adoption", async () => {
    const yp = fakeYp();
    const ok = await markMigrationUsage(yp, "u1", { processed_files: 0, total_bytes: 0 });
    assert.strictEqual(ok, false);
    assert.strictEqual(yp.calls.length, 0);
  });

  await test("no user id, no row", async () => {
    const yp = fakeYp();
    const ok = await markMigrationUsage(yp, "", { processed_files: 5, total_bytes: 10 });
    assert.strictEqual(ok, false);
    assert.strictEqual(yp.calls.length, 0);
  });

  await test("a missing total_bytes marks zero rather than NaN", async () => {
    const yp = fakeYp();
    await markMigrationUsage(yp, "u1", { processed_files: 3 });
    assert.strictEqual(yp.calls[0][4], 0);
  });

  await test("a database failure never rejects", async () => {
    const yp = fakeYp(() => Promise.reject(new Error("gone")));
    const ok = await markMigrationUsage(yp, "u1", { processed_files: 3, total_bytes: 1 });
    assert.strictEqual(ok, false, "a failed mark reports false, it does not throw");
  });

  console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
  process.exit(failures ? 1 : 0);
})();
