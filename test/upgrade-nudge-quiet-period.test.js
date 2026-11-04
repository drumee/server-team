// No upgrade nudge right after a payment (prod recording, 2026-11-02).
//
// A brand-new account paid for Team and landed on the desk under "Payment
// Success!" AND "Ready for more room? — Upgrade to Business". The org had
// claimed a pool hub whose entity.ctime was months old, so the age nudge
// fired on the first desk load. Two guards now: an org is quiet for a week
// after its creation, and any scope is quiet for a week after a plan change.
//
//   node --test test/upgrade-nudge-quiet-period.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const nudge = require("../service/lib/upgrade-nudge");

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

function ypFor({ ageDays, metadata = null, plan = "team", members = 1 }) {
  const procs = [];
  const queries = [];
  return {
    procs,
    queries,
    async await_query(sql, ...args) {
      queries.push([sql, ...args]);
      if (/FROM organisation o/.test(sql)) {
        return [{ id: "org1", owner_id: "u1", metadata, ctime: NOW - ageDays * DAY }];
      }
      if (/FROM quota WHERE domain_id/.test(sql)) return [{ plan, disk: 1e12, seat: 50 }];
      if (/FROM quota_usage/.test(sql)) return [{ used: 0 }];
      if (/^UPDATE organisation/.test(sql.trim())) return { affectedRows: 1 };
      throw new Error(`unexpected query: ${sql}`);
    },
    async await_proc(name, ...args) {
      procs.push([name, ...args]);
      if (name === "member_list_stats") return [{ total_members: members, pending_invites: 0 }];
      if (name === "org_upgrade_nudge_mark") return [{ granted: 1, seen_already: 0, capped_today: 0 }];
      if (name === "org_upgrade_nudge_reset") return [{ affected: 1 }];
      throw new Error(`unexpected proc: ${name}`);
    },
  };
}

test.beforeEach(() => { global.myDrumee = { upgrade_nudges: 1 }; });
test.afterEach(() => { delete global.myDrumee; });

test("a Team org created today gets no nudge, whatever its thresholds say", async () => {
  const yp = ypFor({ ageDays: 0, members: 50 });
  assert.equal(await nudge.grant(yp, 7, "u1"), null);
  assert.ok(!yp.procs.some((p) => p[0] === "org_upgrade_nudge_mark"), "the gate was never asked");
});

test("a Team org past the quiet week still gets its age nudge", async () => {
  const yp = ypFor({ ageDays: 15 });
  const res = await nudge.grant(yp, 7, "u1");
  assert.ok(res);
  assert.equal(res.trigger, "age_14d");
  assert.equal(res.target_plan, "business");
});

test("a detected plan change resets, stamps plan_changed_at and shows nothing", async () => {
  const yp = ypFor({ ageDays: 60, metadata: JSON.stringify({ upgrade_nudge: { plan: "free" } }) });
  assert.equal(await nudge.grant(yp, 7, "u1"), null);
  assert.ok(yp.procs.some((p) => p[0] === "org_upgrade_nudge_reset"));
  const stamp = yp.queries.find((q) => /plan_changed_at/.test(q[0]));
  assert.ok(stamp, "plan_changed_at was written");
  assert.equal(stamp[1], "org1");
});

test("within a week of the stamp nothing is granted; after it the nudge returns", async () => {
  const recent = ypFor({
    ageDays: 60,
    metadata: JSON.stringify({ upgrade_nudge: { plan_changed_at: NOW - 2 * DAY } }),
  });
  assert.equal(await nudge.grant(recent, 7, "u1"), null);

  const old = ypFor({
    ageDays: 60,
    metadata: JSON.stringify({ upgrade_nudge: { plan_changed_at: NOW - 8 * DAY } }),
  });
  const res = await nudge.grant(old, 7, "u1");
  assert.ok(res);
  assert.equal(res.trigger, "age_30d");
});

test("_inQuietPeriod ignores missing timestamps", () => {
  assert.equal(nudge._inQuietPeriod(null, 0, NOW), false);
  assert.equal(nudge._inQuietPeriod({}, null, NOW), false);
  assert.equal(nudge._inQuietPeriod({ plan_changed_at: NOW - DAY }, 0, NOW), true);
  assert.equal(nudge._inQuietPeriod(null, NOW - DAY, NOW), true);
});
