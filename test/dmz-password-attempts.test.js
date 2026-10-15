/**
 * Cover for the pause a protected dmz link takes after too many wrong passwords.
 * Run: node test/dmz-password-attempts.test.js
 */
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const { RedisStore } = require("@drumee/server-essentials");
const attempts = require("../service/lib/dmz-password-attempts");

// An in-memory Redis with a clock the test moves.
let now = 0;
const store = new Map();
const live = (k) => { const e = store.get(k); if (e && e.until && e.until <= now) store.delete(k); return store.get(k); };
const fake = {
  get: async (k) => (live(k) ? String(live(k).v) : null),
  incr: async (k) => { const e = live(k) || { v: 0, until: 0 }; e.v++; store.set(k, e); return e.v; },
  expire: async (k, s) => { const e = live(k); if (e) e.until = now + s; return 1; },
  ttl: async (k) => { const e = live(k); return !e ? -2 : e.until ? e.until - now : -1; },
};
let client = fake;
RedisStore.getClient = () => client;

(async () => {
  const { MAX_FAILURES, WINDOW_SEC } = attempts;
  {
    for (let i = 1; i < MAX_FAILURES; i++) await attempts.recordFailure("t1");
    assert.strictEqual(await attempts.retryAfter("t1"), 0, "below the limit the link takes passwords");
    await attempts.recordFailure("t1");
    assert.strictEqual(await attempts.retryAfter("t1"), WINDOW_SEC);
    assert.strictEqual(await attempts.retryAfter("t2"), 0, "the count is per link");
    // It is a window, not a lock.
    now += WINDOW_SEC;
    assert.strictEqual(await attempts.retryAfter("t1"), 0);
  }
  {
    // A count whose expire never landed still gets a window.
    store.set("dmz:pwfail:t3", { v: MAX_FAILURES - 1, until: 0 });
    await attempts.recordFailure("t3");
    assert.ok(await attempts.retryAfter("t3") > 0);
    now += WINDOW_SEC;
    assert.strictEqual(await attempts.retryAfter("t3"), 0);
  }
  {
    // Redis down or failing: no pause, and nothing throws.
    client = null;
    assert.strictEqual(await attempts.retryAfter("t1"), 0);
    client = { get: async () => { throw new Error("down"); }, incr: async () => { throw new Error("down"); } };
    await attempts.recordFailure("t1");
    assert.strictEqual(await attempts.retryAfter("t1"), 0);
    client = fake;
  }
  {
    // yp.guest_login is the other way a password is tried: it pauses too.
    const SRC = fs.readFileSync(path.join(__dirname, "../service/yp.js"), "utf8");
    const start = SRC.indexOf("\n  async guest_login() {");
    const body = SRC.slice(start, SRC.indexOf("\n  }\n", start) + 4).trim()
      .replace(/^async\s+guest_login\s*\(/, "async function guest_login(");
    const guest_login = new Function("Attr", "retryAfter", "recordFailure", `return ${body}`)(
      { token: "token", password: "password" }, async () => 600, async () => {});
    let tried = 0, out = null;
    await guest_login.call({
      input: { need: () => "tok", get: () => "pw" },
      session: { dmz_login: async () => { tried++; return {}; } },
      output: { data: (d) => { out = d; } },
    });
    assert.deepStrictEqual(out, { status: "TOO_MANY_ATTEMPTS", validity: "TOO_MANY_ATTEMPTS", retry_after: 600 });
    assert.strictEqual(tried, 0);
  }
  console.log("dmz-password-attempts: ok");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
