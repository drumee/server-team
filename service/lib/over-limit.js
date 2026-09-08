/**
 * Downgrade over-limit resolution — the shared evaluation library.
 *
 * When a plan goes DOWN (Team->Free, Business->Team, trial expiry, cancel,
 * dunning) and the org is over the NEW plan's storage or seat limit, the
 * workspace enters a graced read-only state until the owner resolves it.
 * The state itself lives in organisation.metadata.$.over_limit and is owned
 * by the yp proc org_over_limit_set (two INDEPENDENT flags — storage and
 * seats — plus a one-shot grace deadline). This module is the single JS
 * entrance to that state machine:
 *
 *   evaluate(yp, domainId, opts)  recompute usage + seats vs the org's
 *                                 CURRENT entitlement and write the flags.
 *                                 Called after every plan-lowering commit
 *                                 (stripe_webhook, promo, promoExpiryWorker)
 *                                 and after every resolution action (purge /
 *                                 empty_bin / trash, member removal).
 *   getState(yp, domainId)        cached scalar read for the REST read-only
 *                                 clamp — 30s TTL so write-op enforcement
 *                                 costs at most one indexed yp query per
 *                                 domain per 30s. evaluate() invalidates.
 *   enabled()                     the whole feature is gated by
 *                                 `over_limit_enforcement` in myDrumee.json
 *                                 (same rollout switch pattern as
 *                                 billing_upgrade) — cloud-only, off by
 *                                 default, so self-hosted nodes and prod
 *                                 stay untouched until explicitly enabled.
 *
 * Never throws: quota enforcement must not take the request down with it.
 * On any lookup failure the answer is "last known state" (or 'ok') — the
 * design's own rule: a failed check never defaults to locked.
 */

const GRACE_SEC = parseInt(process.env.OVER_LIMIT_GRACE_SEC, 10) || 7 * 24 * 3600;

// Business's seat quota is a 100000 sentinel meaning unlimited (same read as
// hub.js _seatBudget). Free org rows don't exist (payment_clear_entitlement
// DELETES the row) — a downgraded-to-free org falls back to the free tier's
// seat cap and the free fallback row's disk allowance.
const SEAT_UNLIMITED = 100000;

// Free's member cap, counting the owner — the same number the catalog row
// carries (yp.plan free.quota.$.seat) and the same scale as Team's 10.
//
// Hard-coded here on purpose: this branch runs precisely when the org has NO
// entitlement row to read a number from, so there is nothing to query. It was
// 1 while Free was solo-locked; the 2026-08-14 pricing restructure moved Free
// to 3 members, and leaving this at 1 would flag every Free org with two or
// three people as seats-over and put it in graced read-only — the exact
// opposite of what opening up Free is for. If the catalog number moves again,
// this moves with it.
const FREE_SEAT_CAP = 3;

// Free's storage allowance, and a LAST RESORT only: the query below reads the
// canonical free fallback row, and this is what answers when that row is
// missing or reads 0. Same contract as FREE_SEAT_CAP — it mirrors the catalog
// (yp.plan free.quota.$.disk) and moves when the catalog moves. Raised from
// 5 GB by the 2026-08-18 pricing change (schemas
// yellow_page/patches/2026-08-18-free-plan-25gb.sql).
//
// Erring HIGH is the safe direction here: this figure is a disk LIMIT, so a
// value below the real allowance would mark a free org storage-over and drop
// it into graced read-only on a fallback path — punishing users for a missing
// row. Too high merely fails to flag someone.
const FREE_DISK_BYTES = 25000000000;

// domainId -> { at: epoch-ms, row: {...}|null } — null row = no org / clean.
const cache = new Map();
const CACHE_TTL_MS = 30 * 1000;

function enabled() {
  return !!(global.myDrumee && global.myDrumee.over_limit_enforcement);
}

function invalidate(domainId) {
  cache.delete(~~domainId);
}

function firstRow(r) {
  return Array.isArray(r) ? r[0] : r;
}

/**
 * Cheap cached read for the enforcement clamp. Returns the org_over_limit_get
 * row ({org_id, owner_id, state, storage_over, seats_over, grace_deadline})
 * or null when the domain has no org / no over-limit block. state is only
 * meaningful when non-null: 'over_limit' | 'hard_lock'.
 */
async function getState(yp, domainId) {
  const dom = ~~domainId;
  if (!enabled() || dom <= 1) return null;
  const hit = cache.get(dom);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.row;
  let row = null;
  try {
    row = firstRow(await yp.await_proc("org_over_limit_get", dom)) || null;
    if (row && !row.state) row = null;
  } catch (e) {
    // Fail-open: keep the stale row if we have one, otherwise treat as clean.
    console.warn("[over-limit] state lookup failed (fail-open):", e && e.message);
    return hit ? hit.row : null;
  }
  cache.set(dom, { at: Date.now(), row });
  return row;
}

/**
 * The org's current limits, from its own quota row — or the free tier when
 * payment_clear_entitlement already deleted it (cancel / trial expiry land
 * exactly there: members fall back to per-user free, and the org hubs are
 * measured against the free allowance).
 */
async function _limits(yp, domainId, orgId) {
  let row = firstRow(await yp.await_query(
    `SELECT plan, disk, seat FROM quota WHERE domain_id = ? AND payer_id = ? LIMIT 1`,
    ~~domainId, orgId
  ));
  if (row && row.disk != null) {
    return {
      plan: row.plan || "",
      disk: Number(row.disk) || 0,
      seat: row.seat == null ? null : ~~row.seat,
    };
  }
  // No org entitlement row -> free tier. Disk from the canonical free
  // fallback row (the last tier of every entitlement cascade); seats from
  // FREE_SEAT_CAP, which counts the owner.
  let free = firstRow(await yp.await_query(
    `SELECT disk FROM quota WHERE payer_id = 'ffffffffffffffff' LIMIT 1`
  ));
  return { plan: "free", disk: Number(free && free.disk) || FREE_DISK_BYTES, seat: FREE_SEAT_CAP };
}

/**
 * Re-evaluate one domain and persist the outcome. Returns the resulting
 * state row {prev_state, state, storage_over, seats_over, grace_deadline,
 * disk_used, disk_limit, seats_used, seat_limit, plan} or null when the
 * domain has no org (personal accounts never lock).
 *
 * opts.notify — async (uids, model) fan-out used for the WS push; injected
 * so entities and workers can share this code (they build the envelope
 * differently — see notifyDomain below for the ready-made one).
 */
async function evaluate(yp, domainId, opts = {}) {
  const dom = ~~domainId;
  if (!enabled() || dom <= 1) return null;
  let out = null;
  try {
    const org = firstRow(await yp.await_query(
      `SELECT id, owner_id FROM organisation WHERE domain_id = ? LIMIT 1`, dom
    ));
    if (!org || !org.id) return null;

    // Drift repair BEFORE measuring: quota_usage carries known leaks (version
    // bytes never reclaimed, restore double-counts) that could otherwise hold
    // an org "over limit" it cannot fix. recalculate_domain_usage re-sums the
    // per-hub yp.disk_usage rows for this one domain — cheap, indexed.
    try { await yp.await_proc("recalculate_domain_usage", dom); } catch (e) { /* keep cached */ }

    const usage = firstRow(await yp.await_query(
      `SELECT GREATEST(IFNULL(actual_usage, 0), IFNULL(cached_usage, 0)) AS used
         FROM quota_usage WHERE domain_id = ?`, dom
    ));
    const diskUsed = Number(usage && usage.used) || 0;

    const limits = await _limits(yp, dom, org.id);

    // Same occupancy the seat guards and the Admin console show:
    // members + pending invites (member_list_stats).
    let seatsUsed = 0;
    try {
      const stats = firstRow(await yp.await_proc("member_list_stats", org.id));
      seatsUsed = ~~(stats && stats.total_members) + ~~(stats && stats.pending_invites);
    } catch (e) {
      console.warn("[over-limit] member stats failed, seats flag skipped:", e && e.message);
    }

    const seatCap = (limits.seat == null || limits.seat <= 0 || limits.seat >= SEAT_UNLIMITED)
      ? (limits.plan === "free" ? FREE_SEAT_CAP : null)
      : limits.seat;

    const storageOver = limits.disk > 0 && diskUsed > limits.disk ? 1 : 0;
    const seatsOver = seatCap != null && seatsUsed > seatCap ? 1 : 0;

    const res = firstRow(await yp.await_proc(
      "org_over_limit_set",
      org.id, storageOver, seatsOver, GRACE_SEC,
      diskUsed, limits.disk, seatsUsed, seatCap == null ? 0 : seatCap, limits.plan
    ));

    out = {
      org_id: org.id,
      owner_id: org.owner_id,
      domain_id: dom,
      prev_state: res && res.prev_state,
      state: (res && res.state) || "ok",
      storage_over: storageOver,
      seats_over: seatsOver,
      grace_deadline: res && res.grace_deadline ? ~~res.grace_deadline : 0,
      disk_used: diskUsed,
      disk_limit: limits.disk,
      seats_used: seatsUsed,
      seat_limit: seatCap == null ? 0 : seatCap,
      plan: limits.plan,
    };
    invalidate(dom);

    if (opts.notify) {
      const changed = (out.prev_state || "ok") !== out.state;
      // Push on every evaluation while a block exists (numbers move as the
      // owner deletes/removes), and once more on the resolving transition.
      if (out.state !== "ok" || changed) {
        try { await opts.notify(out); } catch (e) {
          console.warn("[over-limit] notify failed:", e && e.message);
        }
      }
    }
  } catch (e) {
    console.warn("[over-limit] evaluate failed (state unchanged):", e && e.message);
  }
  return out;
}

/**
 * Ready-made WS fan-out: pushes the state to EVERY member of the domain (the
 * lock banner is for everyone, not just the owner). Explicit
 * {model, options:{service}} envelope — the exact shape reminderWorker uses —
 * so the FE handler can switch on options.service regardless of transport.
 */
async function notifyDomain(yp, RedisStore, state) {
  const uids = await yp.await_query(
    `SELECT DISTINCT p.uid FROM privilege p
      INNER JOIN drumate d ON p.uid = d.id
      WHERE p.domain_id = ?
        AND COALESCE(JSON_VALUE(d.profile, '$.category'), '') <> 'system'`,
    state.domain_id
  );
  const list = (Array.isArray(uids) ? uids : [uids]).filter(Boolean).map((r) => r.uid);
  if (!list.length) return;
  // user_sockets takes a JSON param — pass the ARRAY like reminderWorker
  // does. A comma-joined string arrives as one scalar, matches no uid, and
  // the whole push silently fans out to nobody (found live on stage).
  const recipients = await yp.await_proc("user_sockets", list);
  const rows = Array.isArray(recipients) ? recipients : [recipients];
  if (!rows.filter(Boolean).length) return;
  await RedisStore.sendData(
    {
      model: {
        state: state.state,
        flags: { storage: ~~state.storage_over, seats: ~~state.seats_over },
        grace_deadline: state.grace_deadline,
        disk_used: state.disk_used,
        disk_limit: state.disk_limit,
        seats_used: state.seats_used,
        seat_limit: state.seat_limit,
        plan: state.plan,
        timestamp: Date.now(),
      },
      options: { service: "payment.plan_state_changed", keys: "*" },
    },
    rows.filter(Boolean)
  );
}

module.exports = {
  GRACE_SEC,
  enabled,
  evaluate,
  getState,
  invalidate,
  notifyDomain,
};
