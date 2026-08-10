/**
 * Cover for the revenue live push.
 *
 * Two properties matter and neither is visible from the payment path:
 *   1. it never throws — it is called from inside a Stripe webhook that has
 *      already committed money, and an exception there makes Stripe redeliver
 *      the whole event.
 *   2. it debounces — the 1st of the month is a renewal storm, and one push
 *      per invoice would have every open dashboard refetch five services each.
 *
 * Run: node test/revenue-live.test.js
 */
const assert = require("assert");

// Stub the two things the module reaches for before requiring it.
const sent = [];
require.cache[require.resolve("@drumee/server-essentials")] = {
  exports: {
    RedisStore: { sendData: async (payload, dest) => { sent.push({ payload, dest }); } },
    toArray: (v) => (Array.isArray(v) ? v : v == null ? [] : [v]),
  },
};

const { pushRevenueLive, REVENUE_LIVE_DEBOUNCE_MS } = require("../service/private/_revenue_live");

const ctx = (rows) => ({
  yp: { await_proc: async () => rows },
  warn: () => {},
});

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}: ${e.message}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await test("returns synchronously and does not throw when yp blows up", async () => {
    const bad = { yp: { await_proc: async () => { throw new Error("db down"); } }, warn: () => {} };
    assert.strictEqual(pushRevenueLive(bad, { plan: "team", paid_at: 1 }), undefined);
    await sleep(REVENUE_LIVE_DEBOUNCE_MS + 60);
    assert.strictEqual(sent.length, 0, "nothing sent when sockets cannot be resolved");
  });

  await test("a burst produces exactly one push", async () => {
    sent.length = 0;
    const c = ctx([{ cookie: "c", uid: "u", socket_id: "s1" }]);
    for (let i = 0; i < 5; i++) pushRevenueLive(c, { plan: "team", paid_at: 1000 + i });
    await sleep(REVENUE_LIVE_DEBOUNCE_MS + 60);
    assert.strictEqual(sent.length, 1, `expected 1 push, got ${sent.length}`);
  });

  await test("a burst uses the LATEST call's ctx and payload, not the first", async () => {
    sent.length = 0;
    // First call in the window has a ctx whose yp is broken; a later call in
    // the SAME window has a healthy ctx with sockets. If the debounce closure
    // captured ctx only from the call that opened the window, this would
    // silently drop the whole burst (sent.length === 0) instead of using the
    // latest, healthy ctx and latest payload.
    const bad = { yp: { await_proc: async () => { throw new Error("db down"); } }, warn: () => {} };
    const good = ctx([{ cookie: "c", uid: "u", socket_id: "s1" }]);
    pushRevenueLive(bad, { plan: "team", paid_at: 1 });
    await sleep(100); // still well inside REVENUE_LIVE_DEBOUNCE_MS
    pushRevenueLive(good, { plan: "pro", paid_at: 999 });
    await sleep(REVENUE_LIVE_DEBOUNCE_MS + 60);
    assert.strictEqual(sent.length, 1, `expected 1 push via the later, healthy ctx; got ${sent.length}`);
    assert.deepStrictEqual(sent[0].payload.model, { plan: "pro", paid_at: 999 });
  });

  await test("payload is the signal only, on the agreed service name", async () => {
    sent.length = 0;
    pushRevenueLive(ctx([{ cookie: "c", uid: "u", socket_id: "s1" }]), { plan: "pro", paid_at: 42 });
    await sleep(REVENUE_LIVE_DEBOUNCE_MS + 60);
    assert.strictEqual(sent.length, 1);
    assert.deepStrictEqual(sent[0].payload.model, { plan: "pro", paid_at: 42 });
    assert.strictEqual(sent[0].payload.options.service, "live.revenue_paid");
  });

  await test("no sockets means no send", async () => {
    sent.length = 0;
    pushRevenueLive(ctx([]), { plan: "team", paid_at: 1 });
    await sleep(REVENUE_LIVE_DEBOUNCE_MS + 60);
    assert.strictEqual(sent.length, 0);
  });

  console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
  process.exit(failures ? 1 : 0);
})();
