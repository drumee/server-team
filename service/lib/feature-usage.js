/**
 * @license
 * Copyright 2024 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3
 */

/**
 * Record that a user used a core feature, for the analytics
 * Engagement > Core function page.
 *
 * Six callers, all reporting work that has already committed:
 *   service/media.js store()                  -> 'upload'  (+ filesize)
 *   service/private/chat.js post()            -> 'chat'
 *   service/private/channel.js post()         -> 'chat'
 *   service/private/channel.js file_thread_post() -> 'chat'
 *   service/private/task.js create()          -> 'task'
 *   service/conference.js join()              -> 'meeting' (deduped per room)
 *
 * NEVER THROWS, NEVER AWAITED BY THE CALLER, for the same reasons as
 * markFunnelMilestone and pushReferralLive next door: the file, the message or
 * the task is already committed, so a failure here must not surface as a
 * failure of the operation, and an analytics row must not add latency to an
 * upload.
 *
 * WHY THIS BATCHES WHERE funnel-milestone.js MEMOISES. That file keeps a SEEN
 * set and DROPS repeats, which is correct there because only the first
 * occurrence can change anything -- funnel_milestone is INSERT IGNORE and the
 * 500th upload is genuinely a no-op. Here every event moves a counter, so
 * dropping one loses data. Repeats are accumulated instead and posted as a
 * single call carrying the delta: a 500-file drop becomes one feature_mark
 * with hits = 500, not 500 calls and not one call that lost 499 of them.
 *
 * WHAT A CRASH COSTS. Whatever is in PENDING at the moment the process dies,
 * which is at most FLUSH_MS of events. That is the failure mode in full, it is
 * bounded, and it is the price of not putting a database round-trip in the
 * upload path. Never add logic that assumes PENDING has been persisted.
 */

/**
 * Accumulated deltas awaiting a flush, keyed "uid:feature".
 * Value: { ctx, uid, feature, hits, volume, seen }.
 *
 * `ctx` is captured for its `yp` accessor only -- the long-lived pool, which
 * is safe to hold past the request that created it. Never reach into it for
 * request state at flush time; the handler instance is per-request and by then
 * its response has long gone.
 */
const PENDING = new Map();

/** How long a delta may sit unposted. Short enough that a restart loses little,
 *  long enough that a bulk upload coalesces into one call. */
const FLUSH_MS = 5000;

/**
 * Bound on distinct dedupe keys remembered per pending entry, so a long-lived
 * meeting-heavy process cannot grow one without limit. Eviction is whole-Set:
 * the consequence of clearing is that a rejoin after the clear counts as a
 * second meeting, which is a far smaller error than unbounded memory.
 */
const DEDUPE_MAX = 500;

let timer = null;

function schedule() {
  if (timer) return;
  timer = setTimeout(flush, FLUSH_MS);
  // Do not hold the process open for an analytics counter.
  if (timer.unref) timer.unref();
}

function flush() {
  timer = null;
  const batch = Array.from(PENDING.values());
  PENDING.clear();
  for (const e of batch) {
    if (!e.hits && !e.volume) continue;
    try {
      // This .catch is defensive, not the primary error path -- keep it.
      // Mariadb._run ends in .catch(this._handleError), and _handleError
      // WARNS, ROLLS BACK, TRIGGERS ERROR AND ENDS THE CONNECTION rather than
      // rejecting, for the default (non-throwOnError, non-fatal) case. So for
      // an ordinary failure -- e.g. `feature_mark` missing from
      // information_schema.routines -- this .catch essentially never fires
      // and "[feature] mark failed" essentially never gets logged. What you
      // see instead is the shared `yp` connection desyncing/ending, which
      // shows up elsewhere as stalled or hanging concurrent requests, not as
      // a warning here. This .catch still matters for the paths that do
      // reject (throwOnError set, e.fatal, a thrown non-DB error).
      e.ctx.yp
        .await_proc("feature_mark", e.uid, e.feature, e.hits, e.volume)
        .catch((err) => {
          if (e.warn) e.warn("[feature] mark failed", e.feature, err && err.message);
        });
    } catch (err) {
      if (e.warn) e.warn("[feature] mark threw", e.feature, err && err.message);
    }
  }
}

/**
 * @param {Object} ctx      the handler `this` (needs yp.await_proc)
 * @param {String} feature  'upload' | 'chat' | 'task' | 'meeting'
 * @param {Object} [opts]
 * @param {String} [opts.uid]     defaults to ctx.uid
 * @param {Number} [opts.hits]    defaults to 1
 * @param {Number} [opts.volume]  bytes; upload only, defaults to 0
 * @param {String} [opts.dedupe]  collapse repeats sharing this key into one hit
 */
function markFeatureUsage(ctx, feature, opts) {
  const o = opts || {};
  if (!ctx || !ctx.yp || typeof ctx.yp.await_proc !== "function") return;
  const who = o.uid || ctx.uid;
  // This only catches a genuinely absent uid (e.g. a system actor with no
  // account at all). It does NOT catch the DMZ guest: the shared guest
  // account (guest@local.drumee) is a real, truthy `yp.drumate` row, so `who`
  // is truthy for it and this guard lets it through. Guests are skipped at
  // the call site instead -- see the explicit guest/nobody check in
  // conference.js before it calls markFeatureUsage.
  if (!who) return;

  const key = `${who}:${feature}`;
  let e = PENDING.get(key);
  if (!e) {
    e = {
      ctx,
      uid: who,
      feature,
      hits: 0,
      volume: 0,
      seen: null,
      warn: ctx.warn ? ctx.warn.bind(ctx) : null,
    };
    PENDING.set(key, e);
  }

  if (o.dedupe) {
    if (!e.seen) e.seen = new Set();
    if (e.seen.has(o.dedupe)) {
      // Already counted this room/object in this window. The volume still
      // accrues -- a dedupe key says "one occurrence", not "no bytes".
      e.volume += Number(o.volume) || 0;
      schedule();
      return;
    }
    if (e.seen.size >= DEDUPE_MAX) e.seen.clear();
    e.seen.add(o.dedupe);
  }

  e.hits += o.hits == null ? 1 : Number(o.hits) || 0;
  e.volume += Number(o.volume) || 0;
  schedule();
}

module.exports = {
  markFeatureUsage,
  /** Tests only: post everything now, synchronously. */
  _flushNow: flush,
  /** Tests only: drop all state. */
  _reset() {
    PENDING.clear();
    if (timer) clearTimeout(timer);
    timer = null;
  },
};
