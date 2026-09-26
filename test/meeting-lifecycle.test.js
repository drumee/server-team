/**
 * Cover for service/lib/meeting-lifecycle — the "X started a meeting" popup
 * that users kept seeing for meetings that did not exist.
 *
 *   1. announce once per room lifetime (a rejoin / promoted host / post-restart
 *      join must not re-announce), kept alive by the diagnostics heartbeat,
 *      and fail open when Redis is down;
 *   2. only workspace members ('*' grant) receive it, and an unknown member
 *      list never drops everyone;
 *   3. an emptied room flips every still-live start card for THAT room, and
 *      leaves other rooms' cards and ended cards alone.
 *
 * Run: node test/meeting-lifecycle.test.js
 */
const assert = require("assert");

// In-memory Redis with the node-redis v4 calls the module uses.
const store = new Map();
let redisDown = false;
const client = {
  async set(k, v, opt = {}) {
    if (redisDown) throw new Error("redis down");
    if (opt.NX && store.has(k)) return null;
    store.set(k, v);
    return "OK";
  },
  async del(k) {
    if (redisDown) throw new Error("redis down");
    store.delete(k);
  },
  expired: [],
  async expire(k, sec) {
    if (redisDown) throw new Error("redis down");
    this.expired.push([k, sec]);
    return store.has(k) ? 1 : 0;
  },
};
const sent = [];
require.cache[require.resolve("@drumee/server-essentials")] = {
  exports: {
    RedisStore: {
      getClient: () => client,
      sendData: async (payload, dest) => { sent.push({ payload, dest }); },
    },
    toArray: (v) => (Array.isArray(v) ? v : v == null ? [] : [v]),
  },
};

const lib = require("../service/lib/meeting-lifecycle");

const card = (message_id, payload, metadata) => ({
  message_id,
  message: `[[MEETING:start:${JSON.stringify(payload)}]]`,
  metadata: metadata === undefined ? null : JSON.stringify(metadata),
});

/**
 * A yp stand-in that serves entity + one hub channel table and records writes.
 * Answers like the real driver: a single row collapses to an object.
 */
function fakeYp(rows, { db_name = "hub_db" } = {}) {
  const updates = [];
  const byId = new Map(rows.map((r) => [r.message_id, { ...r }]));
  return {
    updates,
    byId,
    async await_query(sql, ...args) {
      if (/FROM entity/.test(sql)) return db_name ? { db_name } : [];
      if (/^UPDATE/.test(sql)) {
        const r = byId.get(args[0]);
        const md = JSON.parse((r && r.metadata) || "{}");
        md.meeting_status = "ended";
        if (r) r.metadata = JSON.stringify(md);
        updates.push(args[0]);
        return { affectedRows: 1 };
      }
      if (/WHERE message LIKE/.test(sql)) return [...byId.values()];
      if (/WHERE message_id = \?/.test(sql)) return byId.get(args[0]) || [];
      throw new Error("unexpected sql " + sql);
    },
    async await_proc(name) {
      assert.strictEqual(name, "entity_sockets");
      return [{ socket_id: "s1", uid: "u1" }, { socket_id: "s2", uid: "u2" }];
    },
  };
}

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}: ${e.message}`); }
}

(async () => {
  // ── announcement ──────────────────────────────────────────────────────────
  await test("first claim wins, every later claim loses until the room empties", async () => {
    store.clear();
    assert.strictEqual(await lib.claimStartAnnouncement("room1"), true);
    // host reload / promoted host / first join after a server restart
    assert.strictEqual(await lib.claimStartAnnouncement("room1"), false);
    assert.strictEqual(await lib.claimStartAnnouncement("room1"), false);
    // another workspace is independent
    assert.strictEqual(await lib.claimStartAnnouncement("room2"), true);
    await lib.forgetStartAnnouncement("room1");
    assert.strictEqual(await lib.claimStartAnnouncement("room1"), true, "next meeting announces again");
  });

  await test("the marker carries a bounded TTL", async () => {
    let seen;
    const orig = client.set;
    client.set = async (k, v, opt) => { seen = opt; return "OK"; };
    await lib.claimStartAnnouncement("room-ttl");
    client.set = orig;
    assert.strictEqual(seen.NX, true);
    assert.ok(seen.EX > 0 && seen.EX <= 24 * 3600, `EX=${seen.EX}`);
  });

  await test("heartbeat re-arms a live marker and can never create one", async () => {
    store.clear();
    client.expired.length = 0;
    await lib.touchStartAnnouncement("ghost");
    assert.strictEqual(store.has(lib.ANNOUNCED_KEY + "ghost"), false, "touch must not create");
    await lib.claimStartAnnouncement("live");
    await lib.touchStartAnnouncement("live");
    assert.deepStrictEqual(client.expired[1], [lib.ANNOUNCED_KEY + "live", lib.ANNOUNCED_TTL_SEC]);
    // the TTL is a heartbeat window, not hours: a dead room frees up quickly
    assert.ok(lib.ANNOUNCED_TTL_SEC <= 10 * 60, `TTL=${lib.ANNOUNCED_TTL_SEC}`);
    // and long enough to survive background-tab throttling of a 30 s ping
    assert.ok(lib.ANNOUNCED_TTL_SEC >= 2 * 60, `TTL=${lib.ANNOUNCED_TTL_SEC}`);
  });

  await test("fails open when Redis is unavailable (pre-fix behaviour, not silence)", async () => {
    redisDown = true;
    assert.strictEqual(await lib.claimStartAnnouncement("room3"), true);
    await lib.forgetStartAnnouncement("room3"); // must not throw
    await lib.touchStartAnnouncement("room3"); // must not throw
    redisDown = false;
  });

  // ── recipients ────────────────────────────────────────────────────────────
  await test("only sockets of workspace members are kept", async () => {
    const db = { await_query: async () => [{ entity_id: "u1" }, { entity_id: "u3" }] };
    const members = await lib.workspaceMemberIds(db);
    const out = lib.onlyMembers(
      [{ socket_id: "a", uid: "u1" }, { socket_id: "b", uid: "u2" }, { socket_id: "c", uid: "u3" }],
      members,
    );
    assert.deepStrictEqual(out.map((s) => s.socket_id), ["a", "c"]);
  });

  await test("a single-row member answer (collapsed object) still counts", async () => {
    const db = { await_query: async () => ({ entity_id: "u1" }) };
    const members = await lib.workspaceMemberIds(db);
    assert.ok(members && members.has("u1"));
  });

  await test("unknown membership keeps the unfiltered list instead of dropping everyone", async () => {
    const sockets = [{ socket_id: "a", uid: "u1" }, { socket_id: "b", uid: "u2" }];
    for (const db of [
      { await_query: async () => [] },
      { await_query: async () => { throw new Error("db down"); } },
      null,
    ]) {
      const members = await lib.workspaceMemberIds(db);
      assert.strictEqual(members, null);
      assert.strictEqual(lib.onlyMembers(sockets, members).length, 2);
    }
  });

  // ── card matching ─────────────────────────────────────────────────────────
  await test("isLiveCardFor matches room_id, falls back to nid, skips ended / other rooms", () => {
    assert.ok(lib.isLiveCardFor(card("m1", { room_id: "R", nid: "R" }), "R"));
    assert.ok(lib.isLiveCardFor(card("m2", { nid: "R" }), "R"), "legacy card without room_id");
    assert.ok(!lib.isLiveCardFor(card("m3", { room_id: "X", nid: "X" }), "R"));
    assert.ok(!lib.isLiveCardFor(card("m4", { room_id: "R" }, { meeting_status: "ended" }), "R"));
    assert.ok(lib.isLiveCardFor(card("m5", { room_id: "R" }, { _seen_: {} }), "R"), "other metadata keys");
    assert.ok(!lib.isLiveCardFor({ message_id: "m6", message: "hello" }, "R"));
    assert.ok(!lib.isLiveCardFor({ message_id: "m7", message: "[[MEETING:start:{not json]]" }, "R"));
  });

  // ── emptied room ──────────────────────────────────────────────────────────
  await test("flips every live card of the emptied room and broadcasts each", async () => {
    sent.length = 0;
    const yp = fakeYp([
      card("live1", { room_id: "R", nid: "R" }),
      card("live2", { nid: "R" }), // duplicate from before the fix
      card("other", { room_id: "X", nid: "X" }),
      card("done", { room_id: "R" }, { meeting_status: "ended" }),
    ]);
    const n = await lib.endLiveMeetingCards(yp, { hub_id: "H", room_id: "R" });
    assert.strictEqual(n, 2);
    assert.deepStrictEqual(yp.updates.sort(), ["live1", "live2"]);
    assert.strictEqual(sent.length, 2);
    for (const { payload, dest } of sent) {
      assert.strictEqual(payload.options.service, "channel.meeting_end");
      assert.strictEqual(payload.model.key_id, "H");
      assert.strictEqual(payload.model.hub_id, "H");
      assert.strictEqual(JSON.parse(payload.model.metadata).meeting_status, "ended");
      assert.strictEqual(dest.length, 2);
    }
  });

  await test("nothing to flip → no write, no broadcast", async () => {
    sent.length = 0;
    const yp = fakeYp([card("other", { room_id: "X" })]);
    assert.strictEqual(await lib.endLiveMeetingCards(yp, { hub_id: "H", room_id: "R" }), 0);
    assert.strictEqual(yp.updates.length, 0);
    assert.strictEqual(sent.length, 0);
  });

  await test("an unsafe or missing db name is refused", async () => {
    for (const db_name of ["x`; DROP TABLE t; --", ""]) {
      const yp = fakeYp([card("c", { room_id: "R" })], { db_name });
      assert.strictEqual(await lib.endLiveMeetingCards(yp, { hub_id: "H", room_id: "R" }), 0);
      assert.strictEqual(yp.updates.length, 0);
    }
  });

  await test("never throws on a DB failure", async () => {
    const yp = { await_query: async () => { throw new Error("db down"); } };
    assert.strictEqual(await lib.endLiveMeetingCards(yp, { hub_id: "H", room_id: "R" }), 0);
    await lib.onRoomEmptied(yp, { hub_id: "H", room_id: "R" });
  });

  await test("onRoomEmptied re-arms the announcement AND flips the card", async () => {
    store.clear();
    sent.length = 0;
    await lib.claimStartAnnouncement("R");
    const yp = fakeYp([card("live", { room_id: "R" })]);
    await lib.onRoomEmptied(yp, { hub_id: "H", room_id: "R" });
    assert.deepStrictEqual(yp.updates, ["live"]);
    assert.strictEqual(await lib.claimStartAnnouncement("R"), true);
  });

  console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
  process.exit(failures ? 1 : 0);
})();
