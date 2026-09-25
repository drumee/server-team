// test/seen-readers.test.js
const assert = require("assert");

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL ${name}: ${e.message}`); failed++; }
}

const { pruneSeen, pruneToCurrentReaders } = require("../service/lib/seen-readers");

(async () => {
  await test("drops readers who are no longer in the hub, keeps string metadata a string", () => {
    const rows = [{ metadata: JSON.stringify({ _seen_: { a: 1, gone: 2 }, _delivered_: { a: 1 } }) }];
    pruneSeen(rows, new Set(["a"]));
    assert.strictEqual(typeof rows[0].metadata, "string");
    const md = JSON.parse(rows[0].metadata);
    assert.deepStrictEqual(md._seen_, { a: 1 });
    assert.deepStrictEqual(md._delivered_, { a: 1 });
  });

  await test("leaves a row untouched when every reader is current", () => {
    const raw = '{"_seen_":{"a":1},"x":"keep"}';
    const rows = [{ metadata: raw }];
    pruneSeen(rows, new Set(["a"]));
    assert.strictEqual(rows[0].metadata, raw);
  });

  await test("edits object metadata in place and skips rows without _seen_ or bad JSON", () => {
    const rows = [{ metadata: { _seen_: { a: 1, b: 2 } } }, { metadata: "{bad" }, { metadata: null }, {}];
    pruneSeen(rows, new Set(["b"]));
    assert.deepStrictEqual(rows[0].metadata._seen_, { b: 2 });
    assert.strictEqual(rows[1].metadata, "{bad");
  });

  await test("reads the reader set from channel_reader_ids", async () => {
    const calls = [];
    const ctx = { db: { await_proc: (...a) => { calls.push(a); return Promise.resolve([{ uid: "a" }]); } } };
    const rows = [{ metadata: '{"_seen_":{"a":1,"b":2}}' }];
    await pruneToCurrentReaders(ctx, rows);
    assert.deepStrictEqual(calls, [["channel_reader_ids"]]);
    assert.deepStrictEqual(JSON.parse(rows[0].metadata)._seen_, { a: 1 });
  });

  await test("fails open when the procedure is missing", async () => {
    const warns = [];
    const ctx = { warn: (...a) => warns.push(a), db: { await_proc: () => Promise.reject(new Error("PROCEDURE does not exist")) } };
    const raw = '{"_seen_":{"a":1}}';
    const rows = [{ metadata: raw }];
    await pruneToCurrentReaders(ctx, rows);
    assert.strictEqual(rows[0].metadata, raw);
    assert.strictEqual(warns.length, 1);
  });

  await test("does not query for an empty list", async () => {
    let called = false;
    await pruneToCurrentReaders({ db: { await_proc: () => { called = true; } } }, []);
    assert.strictEqual(called, false);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
