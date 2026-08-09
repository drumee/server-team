/**
 * @license
 * Copyright 2024 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3
 */

const { RedisStore, toArray } = require('@drumee/server-essentials');

/**
 * Tell every open analytics dashboard that a claim-reward row moved.
 *
 * The Claim reward tracking table only re-read itself when the admin sent a
 * campaign. Everything after that — the user following the CTA, walking the
 * flow, leaving, declining, finishing — was invisible until someone reloaded
 * the page by hand, which is the entire life of the campaign and the part the
 * admin is not driving.
 *
 * A SIGNAL, NOT A ROW, and that is the one place this differs from its twin
 * _referral_live.js.
 *
 * That one pushes a fully-built referral_members row because the board patches
 * it straight into the DOM. The reward table cannot: it is a List.Smart of
 * widget_user instances with no per-row part names, so there is nothing to
 * address a patch to. It re-reads instead, through the _reloadRewardTracking()
 * it already uses after a send — which re-queries the current page WITH its
 * filters and refreshes the summary chips and slot counter alongside it.
 *
 * Letting the client re-read is not a consolation prize. It means the SERVER
 * decides what the page should contain, so none of the hard parts of the
 * referral design exist here: no re-matching the row against the open filter,
 * no page-1-only insert rule, no idempotency requirement, and no reconciling
 * against a fetch that was already in flight. It also means nothing here has to
 * build a row in the table's shape, which would need a `uid` argument on
 * reward_tracking and would create a second definition of a row that could
 * drift from the polled one.
 *
 * The cost is one extra request per change rather than a DOM patch. At campaign
 * volume — a couple of hundred rows and a handful of moves a day — that is
 * nothing. It would be the wrong trade on the referral board, where every
 * signup and every first upload moves a row.
 *
 * NEVER THROWS, NEVER AWAITED BY THE CALLER. Every caller is reporting a write
 * that has already committed, so a failure here would announce a problem with
 * something that in fact succeeded — and a slow Redis, or a dashboard nobody
 * has open, must not add latency to a user claiming their reward.
 */

/**
 * How long a burst of events for one user is folded into a single trailing
 * push. A completion is the case that matters: reward.track writes 'done',
 * reward_claim_track grants the storage in the same call, and the widget's
 * step posts can land either side of it.
 */
const COALESCE_MS = 1500;

/**
 * uid -> { timer, again }. Module level on purpose: a service instance lives
 * for one request, and the point is to span the several requests a single run
 * through the flow makes.
 */
const PENDING = new Map();

/**
 * Send the signal. Resolves to nothing; all failures are swallowed.
 *
 * The recipient list IS the authorisation: reward_live_sockets — reused from
 * the referral board, where it is misleadingly named `referral_live_sockets` —
 * returns only sockets belonging to users who hold read permission on the
 * analytics hub. The acting user is somebody else entirely and is never a
 * recipient of their own push.
 *
 * @param {Object} yp    the yp database handle (ctx.yp)
 * @param {Function} warn
 * @param {String} uid
 * @param {String} status the status just written, carried for logging and for
 *   a future listener that wants to filter; the current client ignores it and
 *   simply re-reads.
 */
async function publish(yp, warn, uid, status) {
  try {
    const sockets = toArray(await yp.await_proc('referral_live_sockets'));
    if (!sockets || !sockets.length) return; // no dashboard open anywhere
    await RedisStore.sendData(
      {
        model: { uid, status: status || '' },
        // No top-level `service`: router/push stamps the envelope
        // "live.update", which is what routes it to the client's `live` event.
        // This name is how the dashboard knows what it received.
        options: { service: 'live.reward_claim', keys: '*' },
      },
      sockets
    );
  } catch (e) {
    if (warn) warn('[reward-live] push failed', e && e.message);
  }
}

/**
 * Report that a claim-reward row may have changed.
 *
 * Leading edge fires immediately, so the common case — one status moving once —
 * reaches the board in well under a second. A trailing push follows only if
 * more events arrived during the window, so a run through three steps costs two
 * socket lookups rather than one per post.
 *
 * @param {Object} ctx the handler `this` (needs yp.await_proc)
 * @param {String} uid the user whose row moved
 * @param {String} [status] the status just written
 */
function pushRewardLive(ctx, uid, status) {
  if (!ctx || !ctx.yp || typeof ctx.yp.await_proc !== 'function') return;
  if (!uid) return;
  // Captured rather than reached through `ctx` later: the trailing timer fires
  // after the request that scheduled it has finished, and the handler instance
  // is per-request. `yp` is the long-lived pool accessor and is safe to hold.
  const yp = ctx.yp;
  const warn = ctx.warn ? ctx.warn.bind(ctx) : null;

  const state = PENDING.get(uid);
  if (state) {
    state.again = true;      // fold into the trailing push already scheduled
    state.status = status;   // ...and let it report the LATEST status
    return;
  }

  const entry = { timer: null, again: false, status };
  PENDING.set(uid, entry);
  publish(yp, warn, uid, status);

  entry.timer = setTimeout(() => {
    const s = PENDING.get(uid);
    PENDING.delete(uid);
    if (s && s.again) publish(yp, warn, uid, s.status);
  }, COALESCE_MS);
  // Do not hold the process open for an analytics message.
  if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref();
}

module.exports = { pushRewardLive };
