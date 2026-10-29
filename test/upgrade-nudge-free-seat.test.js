// A Free organisation has 3 seats, not 1 (prod, 2026-10-29).
//
// An organisation without a quota row is on the Free plan. lib/upgrade-nudge
// fell back to a 1-seat cap for it, while the Free row in yp.quota (and
// over-limit.js, FREE_SEAT_CAP) say 3. One member therefore read as 100% of
// the seats and every Free organisation's owner was due the "almost out of
// seats" popup before anything else. The fallback now reads the Free row's
// seat (3 when the row carries none).
//
//   node --test test/upgrade-nudge-free-seat.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const nudge = require("../service/lib/upgrade-nudge");

const NOW = Math.floor(Date.now() / 1000);

// A yp stub answering exactly the reads grant() makes for an organisation.
function ypFor({ members, freeRow = { disk: 25000000000, seat: 3 }, orgRow = null, ageDays = 20 }) {
  const procs = [];
  return {
    procs,
    async await_query(sql) {
      if (/FROM organisation o/.test(sql)) {
        return [{ id: "org1", owner_id: "u1", metadata: null, ctime: NOW - ageDays * 86400 }];
      }
      if (/FROM quota WHERE domain_id/.test(sql)) return orgRow ? [orgRow] : [];
      if (/payer_id = 'ffffffffffffffff'/.test(sql)) return [freeRow];
      if (/FROM quota_usage/.test(sql)) return [{ used: 0 }];
      throw new Error(`unexpected query: ${sql}`);
    },
    async await_proc(name, ...args) {
      procs.push([name, ...args]);
      if (name === "member_list_stats") return [{ total_members: members, pending_invites: 0 }];
      if (name === "org_upgrade_nudge_mark") return [{ granted: 1, seen_already: 0, capped_today: 0 }];
      throw new Error(`unexpected proc: ${name}`);
    },
  };
}

test.beforeEach(() => { global.myDrumee = { upgrade_nudges: 1 }; });
test.afterEach(() => { delete global.myDrumee; });

test("a Free organisation with one member is not out of seats: the age popup comes first", async () => {
  const yp = ypFor({ members: 1, ageDays: 20 });
  const res = await nudge.grant(yp, 7, "u1");
  assert.ok(res, "a popup is granted");
  assert.equal(res.trigger, "age_14d");
  assert.equal(res.family, "age");
  assert.equal(res.plan, "free");
  assert.equal(res.target_plan, "team");
  assert.equal(res.numbers.seat_limit, 3);
  assert.equal(res.numbers.seats_used, 1);
  // The gate was asked about the age threshold, never about seats.
  assert.deepEqual(yp.procs.filter((p) => p[0] === "org_upgrade_nudge_mark").map((p) => p[3]), ["age_14d"]);
});

test("three members on the Free row fill the 3 seats: seats_90 wins over age", async () => {
  const yp = ypFor({ members: 3, ageDays: 20 });
  const res = await nudge.grant(yp, 7, "u1");
  assert.equal(res.trigger, "seats_90");
  assert.equal(res.numbers.seat_limit, 3);
});

test("a Free row that carries no seat still falls back to 3 (and 25 GB)", async () => {
  const yp = ypFor({ members: 1, freeRow: { disk: null }, ageDays: 40 });
  const res = await nudge.grant(yp, 7, "u1");
  assert.equal(res.trigger, "age_30d");
  assert.equal(res.numbers.seat_limit, 3);
  assert.equal(res.numbers.disk_limit, 25000000000);
});

test("an organisation on a Free quota row without a seat gets the Free cap too, as over-limit does", async () => {
  const yp = ypFor({ members: 1, orgRow: { plan: "free", disk: 25000000000, seat: null }, ageDays: 20 });
  const res = await nudge.grant(yp, 7, "u1");
  assert.equal(res.trigger, "age_14d");
  assert.equal(res.numbers.seat_limit, 3);
});

test("a paid row keeps its own seat cap", async () => {
  const yp = ypFor({ members: 9, orgRow: { plan: "team", disk: 100000000000, seat: 10 }, ageDays: 20 });
  const res = await nudge.grant(yp, 7, "u1");
  assert.equal(res.trigger, "seats_90");
  assert.equal(res.numbers.seat_limit, 10);
  assert.equal(res.target_plan, "business");
});
