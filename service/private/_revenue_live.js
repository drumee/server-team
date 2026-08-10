/**
 * @license
 * Copyright 2024 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3
 */

const { RedisStore, toArray } = require('@drumee/server-essentials');

/**
 * Tell every open analytics dashboard that money moved.
 *
 * A SIGNAL, NOT A ROW — the same choice _reward_live.js makes, for the same
 * reason. The dashboard re-reads its five revenue services, so the SERVER
 * decides what the page holds: no re-matching the new invoice against the open
 * year/plan/date filter, no page-1 insert rule, no reconciling against a fetch
 * already in flight, and no second definition of a ledger row living out here
 * in the push path where it could drift from the proc's.
 *
 * NEVER THROWS, NEVER AWAITED BY THE CALLER. Every caller is reporting a
 * payment that has already been taken and an entitlement that has already been
 * applied. An exception here would fail the webhook, Stripe would redeliver the
 * whole event, and a slow Redis would add latency to a customer's checkout.
 *
 * Recipients come from referral_live_sockets — "every socket allowed to read
 * the analytics hub". That proc exists precisely because these pushes are
 * CROSS-USER (the person paying is not the person watching the board) and
 * because more than one repo publishes them; putting the dashboard's access
 * rule in a second codebase is how the two drift.
 */

/**
 * How long a burst is folded into one trailing push.
 *
 * Renewals cluster: Stripe bills a whole cohort within a few seconds on the 1st
 * of the month, and each one fires invoice.paid. Un-debounced, thirty renewals
 * would have every open dashboard run five queries thirty times over for a
 * screen that only needs to be right once.
 */
const REVENUE_LIVE_DEBOUNCE_MS = 1500;

/** Trailing-edge timer. One global: the payload carries no per-row identity. */
let _timer = null;
/** The most recent signal seen during the current window. */
let _pending = null;

/**
 * Report that money moved.
 *
 * Trailing-edge only (unlike _reward_live.js's leading edge): a renewal storm
 * arrives as a burst from the start, so there is no "first event" worth
 * rushing out — folding the whole window into one push after it settles is
 * strictly better here.
 *
 * @param {Object} ctx    the webhook instance (needs ctx.yp.await_proc, ctx.warn)
 * @param {Object} signal {plan, paid_at} — the payload the dashboard receives
 */
function pushRevenueLive(ctx, signal = {}) {
  _pending = { plan: signal.plan || '', paid_at: ~~signal.paid_at };
  if (_timer) return;
  _timer = setTimeout(async () => {
    const model = _pending;
    _timer = null;
    _pending = null;
    try {
      const sockets = toArray(await ctx.yp.await_proc('referral_live_sockets'));
      if (!sockets || !sockets.length) return; // no dashboard open anywhere
      await RedisStore.sendData(
        {
          model,
          // No top-level `service`: router/push stamps the envelope
          // "live.update", which is what routes it to the client's `live`
          // event. This name is how the dashboard knows what it received.
          options: { service: 'live.revenue_paid', keys: '*' },
        },
        sockets
      );
    } catch (e) {
      // Log and swallow: see the header. The payment already succeeded.
      if (ctx && ctx.warn) ctx.warn('[revenue-live] push failed', e && e.message);
    }
  }, REVENUE_LIVE_DEBOUNCE_MS);
  // Do not hold the process open for a dashboard nobody has open.
  if (_timer && typeof _timer.unref === 'function') _timer.unref();
}

module.exports = { pushRevenueLive, REVENUE_LIVE_DEBOUNCE_MS };
