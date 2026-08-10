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
/** The most recent ctx.yp / bound ctx.warn seen during the current window. */
let _yp = null;
let _warn = null;

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
  if (!ctx || !ctx.yp || typeof ctx.yp.await_proc !== 'function') return;
  _pending = { plan: signal.plan || '', paid_at: ~~signal.paid_at };
  // Refreshed on every call in the window, same as _reward_live.js: the
  // scheduled closure below fires after THIS request has finished, and
  // acl.js self-destroys the handler (session, input, output, websocket,
  // user, hub) shortly after the webhook responds — well inside 1500ms. A
  // ctx captured only from the call that opened the window would go stale
  // mid-burst, and everything after it would silently be dropped. yp and a
  // pre-bound warn are the two fields worth outliving the request for.
  _yp = ctx.yp;
  _warn = ctx.warn ? ctx.warn.bind(ctx) : null;
  if (_timer) return;
  _timer = setTimeout(async () => {
    const model = _pending;
    const yp = _yp;
    const warn = _warn;
    _timer = null;
    _pending = null;
    _yp = null;
    _warn = null;
    try {
      const sockets = toArray(await yp.await_proc('referral_live_sockets'));
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
      if (warn) warn('[revenue-live] push failed', e && e.message);
    }
  }, REVENUE_LIVE_DEBOUNCE_MS);
  // Do not hold the process open for a dashboard nobody has open.
  if (_timer && typeof _timer.unref === 'function') _timer.unref();
}

module.exports = { pushRevenueLive, REVENUE_LIVE_DEBOUNCE_MS };
