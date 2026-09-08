/**
 * @license
 * Copyright 2024 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3
 */

/**
 * Record that a user reached an activation milestone, for the analytics
 * Activation > Funnel page.
 *
 * Two callers, both in service/media.js, both reporting work that has already
 * committed:
 *   make_dir()  -> 'folder'
 *   store()     -> 'upload'   (media.new only; a replace is not a first upload)
 *
 * The third milestone, 'onboarded', is reported by loby onboarding.js, which
 * has its own copy of this call — it is a separate plugin and does not share
 * this file.
 *
 * 'activated' is never passed from here. yp.funnel_mark derives it from the
 * other two and refuses to be handed it directly, so the "both legs, either
 * order" rule lives in one place instead of in each handler.
 *
 * NEVER THROWS, NEVER AWAITED BY THE CALLER, for the same reasons as
 * pushReferralLive next door: the folder or the file is already on disk, so a
 * failure here must not surface as a failure of the operation, and an
 * analytics row must not add latency to an upload.
 *
 * CORRECTNESS DOES NOT DEPEND ON THIS FILE. yp.funnel_milestone has PRIMARY
 * KEY (uid, milestone) and funnel_mark is INSERT IGNORE, so calling on every
 * single upload is already safe. Everything below is load reduction only.
 */

/**
 * Milestones this process has already reported, as "uid:milestone".
 *
 * WHY IT EXISTS. store() runs once per FILE, so dropping a 500-file folder
 * would otherwise post 500 identical funnel_mark calls, 499 of which the
 * database throws away. The first call for a user is the only one that can
 * ever change anything; the rest are pure waste.
 *
 * WHY BEING WRONG IS HARMLESS. A restart, or an eviction below, loses the
 * memo and the next event posts one redundant INSERT IGNORE. That is the
 * failure mode in full — the database, not this Set, is what makes the
 * milestone first-time-only. Never add logic here that assumes a miss means
 * the user has NOT reached the milestone.
 */
const SEEN = new Set();

/**
 * Bound so a long-lived process cannot grow this without limit. Eviction is
 * whole-Set rather than LRU: an LRU's bookkeeping costs more than the
 * redundant INSERT IGNOREs it would save, and the consequence of clearing is
 * one extra no-op query per active user.
 */
const SEEN_MAX = 20000;

/**
 * @param {Object} ctx       the handler `this` (needs yp.await_proc)
 * @param {String} milestone 'folder' | 'upload'
 * @param {String} [uid]     defaults to ctx.uid
 */
function markFunnelMilestone(ctx, milestone, uid) {
  if (!ctx || !ctx.yp || typeof ctx.yp.await_proc !== 'function') return;
  const who = uid || ctx.uid;
  // No uid means no account: media.make_dir is reachable by a DMZ guest, and a
  // guest is not a signup. funnel_mark ignores these too — this is the cheap
  // half of the same guard.
  if (!who) return;

  const key = `${who}:${milestone}`;
  if (SEEN.has(key)) return;
  if (SEEN.size >= SEEN_MAX) SEEN.clear();
  SEEN.add(key);

  const warn = ctx.warn ? ctx.warn.bind(ctx) : null;
  // Captured, not reached through ctx later: the handler instance is
  // per-request and this promise outlives the response. `yp` is the
  // long-lived pool accessor and is safe to hold.
  ctx.yp.await_proc('funnel_mark', who, milestone).catch((e) => {
    // Drop the memo so the next event retries. Without this a transient
    // failure would silence the milestone for the life of the process.
    SEEN.delete(key);
    if (warn) warn('[funnel] mark failed', milestone, e && e.message);
  });
}

module.exports = { markFunnelMilestone };
