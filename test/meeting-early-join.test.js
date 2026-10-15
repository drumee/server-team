// Anyone but the organizer who joins a scheduled meeting before it starts
// waits for it.
//
// A schedules a meeting 11:30-12:30 and invites B. B opened it at 10:54: the
// workspace room was empty, conference_join made B its host, and the whole
// workspace (A included) got "B started a meeting" with a Join button. Now
// conference.join answers {status: "waiting"} without joining, so the room is
// not started and nothing is announced. A join FROM that meeting
// (schedule_id) is held however early; an organizer, a meeting already
// running, or one at its start time join as before, and "Start a Meeting"
// (no schedule_id) starts one as it always did.
//
// Run: node --test test/meeting-early-join.test.js
const assert = require("node:assert/strict");
const test = require("node:test");

global.myDrumee = { arch: "pod", useEmail: 0, conference: { domain: "x" } };
global.verbosity = 0;
global.debug = {};

const { Attr, RedisStore } = require("@drumee/server-essentials");
const { earlyArrival, EARLY_JOIN_SEC } = require("../service/lib/meeting-early");
const Conference = require("../service/conference");

const sent = [];
RedisStore.sendData = async (payload, dest) => {
  sent.push({ payload, dest });
};

const HUB = "hub0000000000001";
const SCHED = "sched00000000001";
const A = "a000000000000001"; // organizer
const B = "b000000000000001"; // invitee
const NOW = 1_800_000_000; // 10:54 in the story
const AT_1130 = NOW + 36 * 60;

function meeting(extra = {}) {
  return { hub_id: HUB, nid: SCHED, stime: AT_1130, etime: AT_1130 + 3600,
    created_by: A, title: "Weekly", attendees: JSON.stringify([B]), recur: "",
    mtime: NOW - 86400, ...extra };
}

function svc({ area = "private", live = 0, rows = [meeting()] } = {}) {
  const calls = [];
  return {
    calls,
    hub: { get: (k) => (k === Attr.area ? area : k === Attr.id ? HUB : null) },
    yp: {
      await_query: async (sql, ...args) => {
        calls.push(["query", sql, ...args]);
        return /FROM meeting_schedule/.test(sql) ? rows : [{ n: live }];
      },
      await_proc: async (name, ...args) => {
        calls.push([name, ...args]);
        return [];
      },
    },
    warn: () => {},
  };
}

const ask = (s, o = {}) =>
  earlyArrival(s, {
    hub_id: HUB, uid: B, type: Attr.meeting, socket_id: "s-b", schedule_id: SCHED, now: NOW, ...o,
  });

test("an invitee 36 minutes early waits for the meeting they joined from", async () => {
  const s = svc();
  const early = await ask(s);
  assert.deepEqual(early, {
    schedule_id: SCHED, title: "Weekly",
    starts_at: AT_1130, opens_at: AT_1130 - EARLY_JOIN_SEC, organizer_id: A,
  });
  // THAT meeting of this workspace; the joining socket is not presence.
  const booked = s.calls.find((c) => c[0] === "query" && /FROM meeting_schedule/.test(c[1]));
  assert.deepEqual(booked.slice(2), [HUB, SCHED]);
  assert.doesNotMatch(booked[1].split("WHERE")[1], /etime/, "its end does not filter it");
  const live = s.calls.find((c) => c[0] === "query" && /FROM conference/.test(c[1]));
  assert.deepEqual(live.slice(2), [HUB, "s-b"]);
});

test("however early: two hours (the reopened case) or days ahead, still waits", async () => {
  for (const ahead of [2 * 3600, 3 * 86400]) {
    const early = await ask(svc({ rows: [meeting({ stime: NOW + ahead, etime: NOW + ahead + 3600 })] }));
    assert.equal(early && early.starts_at, NOW + ahead, `${ahead} s ahead`);
  }
});

test("no grace period: a minute before the start still waits", async () => {
  assert.equal(EARLY_JOIN_SEC, 0);
  const early = await ask(svc({ rows: [meeting({ stime: NOW + 60 })] }));
  assert.equal(early && early.starts_at, NOW + 60);
  assert.equal(early.opens_at, NOW + 60, "the waiting room opens the door at the start time");
});

test("at its start time, or once started, it is joined as usual", async () => {
  assert.equal(await ask(svc({ rows: [meeting({ stime: NOW + EARLY_JOIN_SEC })] })), null);
  assert.equal(await ask(svc({ rows: [meeting({ stime: NOW - 600 })] })), null);
});

test("'Start a Meeting' (no schedule_id) starts one, whatever is booked", async () => {
  const s = svc();
  assert.equal(await ask(s, { schedule_id: undefined }), null);
  assert.equal(s.calls.length, 0, "nothing is even looked up");
});

test("the organizer may open their own meeting early", async () => {
  assert.equal(await ask(svc(), { uid: A }), null);
});

test("a meeting somebody already started is joined as usual", async () => {
  assert.equal(await ask(svc({ live: 1 })), null);
});

test("a meeting whose end was left before its start still holds (the reopened case)", async () => {
  // Stage, 2026-10-15: "dev test" moved to 07:05 kept etime 23:30 the day
  // before, read as over, and the invitee walked in two hours early.
  const early = await ask(svc({ rows: [meeting({ stime: NOW + 7740, etime: NOW - 19800 })] }));
  assert.equal(early && early.starts_at, NOW + 7740);
});

test("the card's occurrence: a weekly meeting under way is joined, though its row is on next week", async () => {
  const started = NOW - 600;
  const rolled = meeting({ stime: started + 604800, etime: started + 604800 + 3600,
    recur: JSON.stringify({ freq: "weekly" }), mtime: started + 20 });
  assert.equal(await ask(svc({ rows: [rolled] }), { schedule_at: started }), null);
  // No occurrence said (the editor opened from a notification): the series
  // was rolled for one that is still on, so it counts as started too.
  assert.equal(await ask(svc({ rows: [rolled] }), { schedule_at: undefined }), null);
});

test("a series whose first occurrence is ahead is held, even at this time of day", async () => {
  // Daily from tomorrow 10:39, created two hours ago: "yesterday's" 10:39
  // never happened, so now (10:54) is not inside one.
  const first = NOW + 86400 - 900;
  const fresh = meeting({ stime: first, etime: first + 3600,
    recur: JSON.stringify({ freq: "daily" }), mtime: NOW - 7200 });
  const early = await ask(svc({ rows: [fresh] }), { schedule_at: first });
  assert.equal(early && early.starts_at, first);
});

test("a later occurrence's card waits for the series' next start, not its own", async () => {
  const early = await ask(svc(), { schedule_at: AT_1130 + 604800 });
  assert.equal(early && early.starts_at, AT_1130);
});

test("an unknown or other workspace's meeting is an ordinary join", async () => {
  assert.equal(await ask(svc({ rows: [] })), null);
  assert.equal(await ask(svc({ rows: [meeting({ hub_id: "other00000000001" })] })), null);
  assert.equal(await ask(svc({ rows: [meeting({ nid: "sched00000000002" })] })), null);
});

test("only workspace meetings wait: not 1:1 calls, not DMZ rooms", async () => {
  assert.equal(await ask(svc(), { type: Attr.connect }), null);
  assert.equal(await ask(svc({ area: "dmz" })), null);
});

test("a member who is not on the attendee list waits too: the room is the workspace's", async () => {
  const C = "c000000000000001";
  const early = await ask(svc({ rows: [meeting({ attendees: "[]" })] }), { uid: C });
  assert.equal(early && early.starts_at, AT_1130);
});

test("a failing lookup joins as before", async () => {
  const s = svc();
  s.yp.await_query = async () => { throw new Error("db down"); };
  assert.equal(await ask(s), null);
});

function joinCtx(uid, schedule_id = SCHED) {
  const procs = [];
  const out = {};
  const s = svc();
  return {
    procs,
    out,
    uid,
    hub: s.hub,
    input: {
      sid: () => "sid",
      need: (k) => ({ [Attr.socket_id]: "s-b", [Attr.metadata]: { type: Attr.meeting },
        [Attr.hub_id]: HUB }[k]),
      get: (k) => (k === Attr.room_id ? HUB : k === "schedule_id" ? schedule_id : null),
    },
    regularlUser: async () => ({ id: uid }),
    yp: {
      await_query: s.yp.await_query,
      await_proc: async (name, ...args) => {
        procs.push(name);
        return [];
      },
    },
    db: { await_proc: async () => ({}) },
    exception: { user: (e) => { out.error = e; } },
    output: { data: (d) => { out.data = d; } },
    debug: () => {},
    warn: () => {},
  };
}

async function join(c) {
  // Fixed clock for the lookup inside join().
  const realNow = Date.now;
  Date.now = () => NOW * 1000;
  try {
    await Conference.prototype.join.call(c);
  } finally {
    Date.now = realNow;
  }
}

test("conference.join: the early invitee is answered waiting, nothing joined, nothing announced", async () => {
  sent.length = 0;
  const c = joinCtx(B);
  await join(c);
  assert.equal(c.out.data.status, "waiting");
  assert.equal(c.out.data.starts_at, AT_1130);
  assert.equal(c.out.data.user, undefined);
  assert.ok(!c.procs.includes("conference_join"));
  assert.equal(sent.length, 0);
});

test("conference.join: the organizer goes on to conference_join", async () => {
  const c = joinCtx(A);
  await join(c);
  assert.ok(c.procs.includes("conference_join"));
  assert.notEqual(c.out.data && c.out.data.status, "waiting");
});

test("conference.join: no schedule_id ('Start a Meeting') goes on to conference_join", async () => {
  const c = joinCtx(B, null);
  await join(c);
  assert.ok(c.procs.includes("conference_join"));
  assert.notEqual(c.out.data && c.out.data.status, "waiting");
});
