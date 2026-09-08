/**
 * Upgrade-nudge popups — the shared evaluation + gating library.
 *
 * Three trigger families ask a member to upgrade while the workspace is
 * still healthy (nothing here locks anything — that is over-limit.js's job):
 *
 *   storage   usage hits 70/80/90% of the org's disk entitlement
 *   seats     members+invites hit 70/90% of the plan's seat cap
 *   age       the workspace turns 14 then 30 days old
 *
 * Every trigger goes through ONE gate — yp org_upgrade_nudge_mark — which
 * owns the two suppression rules server-side (never localStorage):
 *   once per threshold   $.upgrade_nudge.seen.<trigger>.<uid>
 *   daily cap            $.upgrade_nudge.last_shown.<uid> — at most one
 *                        nudge per member per day, whatever the trigger
 *
 * "Until upgraded" is self-healing rather than webhook-hooked: the block is
 * stamped with the plan it was armed against, and state() wipes it when the
 * org's CURRENT plan differs. A same-plan renewal therefore re-arms
 * nothing, while an upgrade (or any plan change) re-arms every threshold
 * against the new limits on the next desk load.
 *
 * Candidate policy: within a family only the HIGHEST currently-true
 * threshold competes (nobody should see the 70% popup after the 90% one),
 * and families rank storage > seats > age. The first candidate the gate
 * grants is the popup; a seen_already answer falls through to the next
 * candidate, a capped_today answer stops the whole run.
 *
 * Never throws: a nudge is decoration on the desk boot — any lookup failure
 * answers "nothing to show".
 */

// Same reads as over-limit.js: quota row = the org's entitlement, huge
// sentinel = unlimited seats.
const SEAT_UNLIMITED = 100000;

const STORAGE_STEPS = [
  ["storage_90", 0.9],
  ["storage_80", 0.8],
  ["storage_70", 0.7],
];
const SEAT_STEPS = [
  ["seats_90", 0.9],
  ["seats_70", 0.7],
];
const AGE_STEPS = [
  ["age_30d", 30 * 24 * 3600],
  ["age_14d", 14 * 24 * 3600],
];

// Where a nudge can send people (designer's route list: Free → Pro,
// Pro → Team, Team → Business; Business → Self-hosted is an evergreen CTA,
// not a threshold popup). A downgraded ORG on the free row has no personal
// tier to go to, so it is sent to Team. Business gets no nudges at all.
const TARGET_PLAN = { free: "pro", pro: "team", team: "business" };
const ORG_TARGET_PLAN = { free: "team", pro: "team", team: "business" };

function enabled() {
  return !!(global.myDrumee && global.myDrumee.upgrade_nudges);
}

function firstRow(r) {
  return Array.isArray(r) ? r[0] : r;
}

/** UTC day the daily cap keys on — one calendar day for every member. */
function today() {
  return new Date().toISOString().slice(0, 10);
}

async function _org(yp, domainId) {
  const row = firstRow(await yp.await_query(
    `SELECT o.id, o.owner_id, o.metadata, e.ctime
       FROM organisation o LEFT JOIN entity e ON e.id = o.id
      WHERE o.domain_id = ? LIMIT 1`, ~~domainId
  ));
  return row && row.id ? row : null;
}

/** The org's current entitlement — quota row, or the free fallback. */
async function _limits(yp, domainId, orgId) {
  let row = firstRow(await yp.await_query(
    `SELECT plan, disk, seat FROM quota WHERE domain_id = ? AND payer_id = ? LIMIT 1`,
    ~~domainId, orgId
  ));
  if (row && row.disk != null) {
    return {
      plan: String(row.plan || "").toLowerCase(),
      // Number() everywhere a driver value enters arithmetic: mariadb hands
      // BIGINT columns (and COUNT()s) back as BigInt, and BigInt/Number
      // division throws — found live on the liam endpoint.
      disk: Number(row.disk) || 0,
      seat: row.seat == null ? null : Number(row.seat),
    };
  }
  let free = firstRow(await yp.await_query(
    `SELECT disk FROM quota WHERE payer_id = 'ffffffffffffffff' LIMIT 1`
  ));
  return { plan: "free", disk: Number(free && free.disk) || 5000000000, seat: 1 };
}

/**
 * Storage candidates — Task "Storage Threshold Popups".
 * Highest currently-true threshold only.
 */
function _storageCandidates(diskUsed, diskLimit) {
  if (!(diskLimit > 0)) return [];
  const ratio = diskUsed / diskLimit;
  for (const [trigger, step] of STORAGE_STEPS) {
    if (ratio >= step) return [trigger];
  }
  return [];
}

/**
 * Seat candidates — Task "Member Invitation Threshold Popups".
 * Cap = the plan tier's finite seat limit; unlimited/absent caps nudge nothing.
 */
function _seatCandidates(seatsUsed, seatCap) {
  if (seatCap == null || seatCap <= 0 || seatCap >= SEAT_UNLIMITED) return [];
  const ratio = seatsUsed / seatCap;
  for (const [trigger, step] of SEAT_STEPS) {
    if (ratio >= step) return [trigger];
  }
  return [];
}

/**
 * Age candidates — Task "Duration Threshold Popups".
 * Measured from the WORKSPACE's creation (entity.ctime of the org id),
 * not any per-user login age.
 */
function _ageCandidates(ctime, nowSec) {
  const born = Number(ctime || 0);
  if (!born) return [];
  const age = nowSec - born;
  for (const [trigger, step] of AGE_STEPS) {
    if (age >= step) return [trigger];
  }
  return [];
}

/**
 * Evaluate the caller's domain and, when a trigger passes the gate, GRANT
 * this member their popup (marking it shown in the same statement).
 *
 * Returns null when there is nothing to show; otherwise
 *   { trigger, family, target_plan, plan, numbers } where numbers carries
 *   what the popup renders (used/limit bytes, seats, age days).
 */
async function grant(yp, domainId, uid) {
  const dom = ~~domainId;
  if (!enabled() || !uid) return null;
  try {
    // Two scopes, one gate. An organisation member is nudged about the
    // WORKSPACE (org numbers, org-wide seen map); a personal Free/Pro
    // account about its own desk (drumate.profile home, Free → Pro → Team).
    const org = dom > 1 ? await _org(yp, dom) : null;
    if (!org) return _grantPersonal(yp, uid);

    const limits = await _limits(yp, dom, org.id);

    // "Until upgraded": block armed against another plan → wipe, re-arm.
    // Runs BEFORE the top-tier bail-out so an upgrade to Business (no next
    // tier, nothing to show) still clears the old counters — otherwise a
    // later downgrade back to Team would find the stale block and never
    // nudge again (found live on stage, case D5).
    let block = null;
    try {
      const md = typeof org.metadata === "string" ? JSON.parse(org.metadata) : org.metadata;
      block = (md && md.upgrade_nudge) || null;
    } catch (e) { block = null; }
    if (block && block.plan && block.plan !== limits.plan) {
      await yp.await_proc("org_upgrade_nudge_reset", org.id);
      block = null;
    }

    const target = ORG_TARGET_PLAN[limits.plan];
    if (!target) return null; // top tier — nowhere to nudge to

    // ---- live numbers (same sources as over-limit.js) ----
    const usage = firstRow(await yp.await_query(
      `SELECT GREATEST(IFNULL(actual_usage, 0), IFNULL(cached_usage, 0)) AS used
         FROM quota_usage WHERE domain_id = ?`, dom
    ));
    const diskUsed = Number(usage && usage.used) || 0;

    let seatsUsed = 0;
    try {
      const stats = firstRow(await yp.await_proc("member_list_stats", org.id));
      // COUNT()s arrive as BigInt — Number() before any arithmetic.
      seatsUsed = Number((stats && stats.total_members) || 0)
        + Number((stats && stats.pending_invites) || 0);
    } catch (e) { /* seats family just yields nothing */ }

    const nowSec = Math.floor(Date.now() / 1000);

    // Families in priority order; inside each, only the top threshold.
    const candidates = [
      ..._storageCandidates(diskUsed, limits.disk).map((t) => ({ trigger: t, family: "storage" })),
      ..._seatCandidates(seatsUsed, limits.seat).map((t) => ({ trigger: t, family: "seats" })),
      ..._ageCandidates(org.ctime, nowSec).map((t) => ({ trigger: t, family: "age" })),
    ];
    if (!candidates.length) return null;

    const day = today();
    for (const cand of candidates) {
      const res = firstRow(await yp.await_proc(
        "org_upgrade_nudge_mark", org.id, uid, cand.trigger, day, limits.plan
      ));
      if (res && Number(res.granted)) {
        return {
          trigger: cand.trigger,
          family: cand.family,
          plan: limits.plan,
          target_plan: target,
          numbers: {
            disk_used: diskUsed,
            disk_limit: limits.disk,
            seats_used: seatsUsed,
            seat_limit: limits.seat == null ? 0 : Number(limits.seat),
            age_days: org.ctime ? Math.floor((nowSec - Number(org.ctime)) / 86400) : 0,
          },
        };
      }
      if (res && Number(res.capped_today)) return null; // shared daily cap — stop
      // seen_already → next candidate
    }
    return null;
  } catch (e) {
    console.warn("[upgrade-nudge] grant failed (nothing shown):", e && e.message);
    return null;
  }
}


/**
 * Personal Free/Pro account — same families, same gate semantics, personal
 * sources: entitlement from get_quota(uid), usage from the disk_usage(uid)
 * function (own desk + owned hubs), age from the account's own entity
 * ctime, seats from drumate_seat_usage (members + live invites across the
 * hubs it owns, against the plan's 3-seat cap). State lives in
 * drumate.profile.$.upgrade_nudge via the drumate_* twin procs.
 */
async function _grantPersonal(yp, uid) {
  let raw = await yp.await_func("get_quota", uid);
  if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch (e) { raw = null; } }
  const q = raw && typeof raw === "object" ? raw : {};
  const limits = {
    plan: String(q.plan || "free").toLowerCase(),
    disk: Number(q.disk || q.storage) || 0,
    seat: q.seat == null ? null : Number(q.seat),
  };

  const me = firstRow(await yp.await_query(
    `SELECT d.profile, e.ctime FROM drumate d LEFT JOIN entity e ON e.id = d.id
      WHERE d.id = ? LIMIT 1`, uid
  ));
  if (!me) return null;

  let block = null;
  try {
    const pf = typeof me.profile === "string" ? JSON.parse(me.profile) : me.profile;
    block = (pf && pf.upgrade_nudge) || null;
  } catch (e) { block = null; }
  if (block && block.plan && block.plan !== limits.plan) {
    await yp.await_proc("drumate_upgrade_nudge_reset", uid);
    block = null;
  }

  const target = TARGET_PLAN[limits.plan];
  if (!target) return null;

  let diskUsed = 0;
  try { diskUsed = Number(await yp.await_func("disk_usage", uid)) || 0; } catch (e) { /* 0 */ }

  let seatsUsed = 0;
  try {
    const stats = firstRow(await yp.await_proc("drumate_seat_usage", uid));
    seatsUsed = Number((stats && stats.total_members) || 0)
      + Number((stats && stats.pending_invites) || 0);
  } catch (e) { /* seats family just yields nothing */ }

  const nowSec = Math.floor(Date.now() / 1000);
  const candidates = [
    ..._storageCandidates(diskUsed, limits.disk).map((t) => ({ trigger: t, family: "storage" })),
    ..._seatCandidates(seatsUsed, limits.seat).map((t) => ({ trigger: t, family: "seats" })),
    ..._ageCandidates(me.ctime, nowSec).map((t) => ({ trigger: t, family: "age" })),
  ];
  if (!candidates.length) return null;

  const day = today();
  for (const cand of candidates) {
    const res = firstRow(await yp.await_proc(
      "drumate_upgrade_nudge_mark", uid, cand.trigger, day, limits.plan
    ));
    if (res && Number(res.granted)) {
      return {
        trigger: cand.trigger,
        family: cand.family,
        plan: limits.plan,
        // Seats: Free and Pro share the same 3-member cap, so the seat nudge
        // sells Team on both (content doc: "Free / Pro → Team").
        target_plan: cand.family === "seats" && limits.plan === "free" ? "team" : target,
        numbers: {
          disk_used: diskUsed,
          disk_limit: limits.disk,
          seats_used: seatsUsed,
          seat_limit: limits.seat == null ? 0 : Number(limits.seat),
          age_days: me.ctime ? Math.floor((nowSec - Number(me.ctime)) / 86400) : 0,
        },
      };
    }
    if (res && Number(res.capped_today)) return null;
  }
  return null;
}

module.exports = {
  enabled,
  grant,
  // exported for tests
  _storageCandidates,
  _seatCandidates,
  _ageCandidates,
  TARGET_PLAN,
  ORG_TARGET_PLAN,
};
