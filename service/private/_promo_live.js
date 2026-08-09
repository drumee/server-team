/**
 * @license
 * Copyright 2024 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3
 */

const { RedisStore, toArray } = require('@drumee/server-essentials');

/**
 * Tell every open analytics dashboard that a Promo Launch 30 row moved.
 *
 * Modelled on _reward_live.js, its twin, and sharing every one of its
 * guarantees. The difference is WHO writes the rows this reports.
 *
 * The claim-reward table's rows are seeded by the dashboard's own server, so a
 * dashboard already knows about a send the moment it makes one; the push is
 * there for what users do afterwards. Nothing about the promo is admin-driven
 * at all. A row appears when somebody is shown a modal, moves when they claim,
 * and moves again when the expiry worker reverts a trial in a different process
 * entirely — the dashboard has no way to learn about any of it. Without this it
 * would only ever be as current as the last manual reload.
 *
 * A SIGNAL, NOT A ROW, the same call _reward_live.js makes and for the same two
 * reasons. Mechanically: the table is widget_user instances with no per-row part
 * names, so there is nothing to address a patch to. Better: letting the client
 * re-read means the SERVER decides what the page should contain, so none of the
 * hard parts exist — no re-matching the row against the open filter, no page-1
 * insert rule, no idempotency requirement, no reconciling against a fetch
 * already in flight. It also means nothing here has to build a row in the
 * table's shape, which would need a uid argument on promo_tracking and would
 * create a second definition of a row that could drift from the polled one.
 *
 * The cost is one extra request per change rather than a DOM patch. A campaign
 * that runs for thirty days and is capped by a date produces a handful of
 * events an hour; that is nothing. It would be the wrong trade on the referral
 * board, where every signup moves a row.
 *
 * NEVER THROWS, NEVER AWAITED BY THE CALLER. Every caller is reporting a write
 * that has already committed, so a failure here would announce a problem with
 * something that in fact succeeded — and a slow Redis, or a dashboard nobody
 * has open, must not add latency to someone claiming a free month.
 */

/**
 * How long a burst of events for one payer is folded into a single trailing
 * push. A claim is the case that matters: promo.js writes the grant, reads the
 * quota back and emits payment.plan_updated in one call, and the dismiss that
 * marked the modal seen can land either side of it.
 */
const COALESCE_MS = 1500;

/**
 * payer_id -> { timer, again }. Module level on purpose: a service instance
 * lives for one request, and the point is to span the several requests one
 * pass through the promo makes.
 */
const PENDING = new Map();

/**
 * Send the signal. Resolves to nothing; all failures are swallowed.
 *
 * The recipient list IS the authorisation: referral_live_sockets returns only
 * sockets belonging to users who hold read permission on the analytics hub. It
 * is reused as-is — nothing about it is referral-specific, its name is a
 * misnomer already noted in the reward live spec, and renaming it would couple
 * a schema patch to a server deploy across two repos.
 *
 * The acting user is somebody else entirely and is never a recipient of their
 * own push.
 *
 * @param {Object} yp     the yp database handle
 * @param {Function} warn
 * @param {String} uid    the payer whose row moved
 * @param {String} event  what just happened — 'seen' | 'claimed' | 'cancelled'
 *   | 'expired'. Carried for logging and for a future listener that wants to
 *   filter; the current client ignores it and simply re-reads.
 */
async function publish(yp, warn, uid, event) {
  try {
    const sockets = toArray(await yp.await_proc('referral_live_sockets'));
    if (!sockets || !sockets.length) return; // no dashboard open anywhere
    await RedisStore.sendData(
      {
        model: { uid, event: event || '' },
        // No top-level `service`: router/push stamps the envelope
        // "live.update", which is what routes it to the client's `live` event.
        // This name is how the dashboard knows what it received.
        options: { service: 'live.promo_launch30', keys: '*' },
      },
      sockets
    );
  } catch (e) {
    if (warn) warn('[promo-live] push failed', e && e.message);
  }
}

/**
 * Report that a Promo Launch 30 row may have changed.
 *
 * Leading edge fires immediately, so the common case — one row moving once —
 * reaches the dashboard in well under a second. A trailing push follows only if
 * more events arrived during the window.
 *
 * TAKES A yp HANDLE, NOT A CONTEXT, which is where this differs from
 * pushRewardLive. One of the four callers is the expiry worker: it runs
 * out-of-process with no service instance to hand, and it is the only writer
 * that moves a row from 'lapsing' to 'ended'. Taking the handle directly is
 * what lets the same function serve both it and the three request handlers.
 *
 * @param {Object} yp        long-lived yp pool accessor (needs await_proc)
 * @param {Function|null} warn
 * @param {String} uid       the payer whose row moved
 * @param {String} [event]   what happened, see publish()
 */
function pushPromoLive(yp, warn, uid, event) {
  if (!yp || typeof yp.await_proc !== 'function') return;
  if (!uid) return;

  const state = PENDING.get(uid);
  if (state) {
    state.again = true;    // fold into the trailing push already scheduled
    state.event = event;   // ...and let it report the LATEST event
    return;
  }

  const entry = { timer: null, again: false, event };
  PENDING.set(uid, entry);
  publish(yp, warn, uid, event);

  entry.timer = setTimeout(() => {
    const s = PENDING.get(uid);
    PENDING.delete(uid);
    if (s && s.again) publish(yp, warn, uid, s.event);
  }, COALESCE_MS);
  // Do not hold the process open for an analytics message. The worker is a
  // long-running process and this would be harmless there, but promo.js runs
  // inside a request and must not keep anything alive behind it.
  if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref();
}

/**
 * The shape the three request handlers in promo.js want: pull the handle and
 * the logger off `this` so a call site reads like its reward twin.
 *
 * @param {Object} ctx    the handler `this` (needs yp.await_proc)
 * @param {String} uid
 * @param {String} [event]
 */
function pushPromoLiveFrom(ctx, uid, event) {
  if (!ctx || !ctx.yp) return;
  // `yp` is captured rather than reached through `ctx` later: the trailing
  // timer fires after the request that scheduled it has finished, and the
  // handler instance is per-request. The pool accessor is safe to hold.
  return pushPromoLive(ctx.yp, ctx.warn ? ctx.warn.bind(ctx) : null, uid, event);
}

module.exports = { pushPromoLive, pushPromoLiveFrom };
