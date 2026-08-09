/**
 * Promo Expiry Worker
 *
 * Reverts the two kinds of entitlement that were granted WITHOUT a Stripe
 * subscription, and therefore have nothing else to end them:
 *
 *   1. LAUNCH30 claims        yp.quota source='promo-launch30'  (30 days)
 *   2. Direct coupon redeems  yp.quota source='mkt-coupon'      (the code's
 *      free period) — promo.redeem, no Checkout, no card
 *
 * Anything that DID go through Stripe Checkout is deliberately out of scope:
 * Stripe owns its end date, and reverting it here would cancel a plan the
 * customer is still paying for. mkt_coupon_redeem_due encodes that exclusion.
 *
 * Both revert the same way an org's Stripe cancellation already does:
 * payment_clear_entitlement DELETEs the org-keyed quota row, so every member
 * falls to their own per-user free tier (tier-4) rather than a locked-out
 * ('free','org') row. reward_grant_storage re-materialising inside that same
 * proc does not fire here — these payers have no yp.reward_claim completion —
 * so the net effect is exactly "back to Free".
 *
 * Model: mirrors reminderWorker.js — plain setTimeout self-rescheduler (the
 * runtime ships Bull, not `cron`), short interval since trials expire at an
 * arbitrary time of day, not at midnight.
 *
 * Env:
 *   PROMO_EXPIRY_INTERVAL_SEC  poll cadence (default 900 = 15 min)
 */

const { Mariadb, RedisStore } = require('@drumee/server-essentials');
const OverLimit = require('../../service/lib/over-limit');
const { pushPromoLive } = require('../../service/private/_promo_live');

const WORKER_NAME = process.env.WORKER_NAME || 'promo-expiry-worker-1';
const INTERVAL_MS = (parseInt(process.env.PROMO_EXPIRY_INTERVAL_SEC, 10) || 900) * 1000;

console.log(`[PromoExpiryWorker] Starting worker: ${WORKER_NAME}`);
console.log(`[PromoExpiryWorker] Poll interval: ${INTERVAL_MS / 1000}s`);

let yp;
let redisReady = false;

function asArray(x) {
  if (Array.isArray(x)) return x;
  return x == null ? [] : [x];
}

async function initialize() {
  yp = new Mariadb({ name: 'yp' });
  console.log('[PromoExpiryWorker] Database connected');
  // For the over-limit push after a revert. Best-effort: without Redis the
  // flags are still written; clients pick them up on next boot.
  try {
    await RedisStore.prototype.init.call(new RedisStore());
    redisReady = true;
    console.log('[PromoExpiryWorker] RedisStore initialized');
  } catch (e) {
    console.warn('[PromoExpiryWorker] RedisStore unavailable:', e.message);
  }
}

// Downgrade over-limit: a promo/coupon revert is a plan-lowering commit like
// any Stripe cancel — measure the org against the free tier it just fell to.
async function evaluateOverLimit(org_id) {
  try {
    if (!OverLimit.enabled()) return;
    let org = await yp.await_query(
      `SELECT domain_id FROM organisation WHERE id = ? LIMIT 1`, org_id
    );
    if (Array.isArray(org)) org = org[0];
    const dom = ~~(org && org.domain_id);
    if (dom <= 1) return;
    await OverLimit.evaluate(yp, dom, {
      notify: redisReady ? (state) => OverLimit.notifyDomain(yp, RedisStore, state) : null,
    });
  } catch (e) {
    console.warn(`[PromoExpiryWorker] over-limit evaluation failed for org=${org_id}:`, e.message);
  }
}

async function expireOne(row) {
  const { payer_id, org_id } = row;
  try {
    // Same revert path an org's Stripe cancel takes — see the module doc.
    await yp.await_proc('payment_clear_entitlement', org_id);
    await yp.await_proc('promo_launch30_mark_expired', payer_id);
    // THE ONLY WRITER THE DASHBOARD CANNOT OTHERWISE LEARN FROM. Every other
    // move in the promo table follows something a user did in a request; this
    // one happens out here on a timer, so without the push a row sits at
    // 'lapsing' on every open dashboard until somebody reloads by hand — which
    // reads as this worker not running, the exact fault that bucket exists to
    // surface. Not awaited and it cannot throw; see _promo_live.js.
    //
    // Guarded on Redis because this process starts whether or not Redis came
    // up (see redisReady), unlike a request handler, which cannot run without
    // it.
    if (redisReady) pushPromoLive(yp, console.warn, payer_id, 'expired');
    await evaluateOverLimit(org_id);
    console.log(`[PromoExpiryWorker] expired promo for payer=${payer_id} org=${org_id}`);
    return true;
  } catch (error) {
    console.error(`[PromoExpiryWorker] failed to expire payer=${payer_id} org=${org_id}:`, error.message);
    return false;
  }
}

/**
 * Same revert, different bookkeeping: an MKT partner code redeemed
 * DIRECTLY (promo.redeem — no Stripe Checkout, no card) also leaves a
 * yp.quota row with nothing to end it. mkt_coupon_redeem_due deliberately
 * excludes redemptions that DID go through Checkout, so a paying
 * customer's subscription is never touched here.
 *
 * Clear first, mark second: if the process dies between the two the row
 * stays 'confirmed' and the next run simply retries, rather than being
 * recorded as expired while the entitlement is still live.
 */
async function expireOneRedemption(row) {
  const { id, code, org_id, email } = row;
  try {
    await yp.await_proc('payment_clear_entitlement', org_id);
    await yp.await_proc('mkt_coupon_redeem_mark_expired', id);
    await evaluateOverLimit(org_id);
    console.log(`[PromoExpiryWorker] expired coupon redemption id=${id} code=${code} org=${org_id} email=${email}`);
    return true;
  } catch (error) {
    console.error(`[PromoExpiryWorker] failed to expire redemption id=${id} org=${org_id}:`, error.message);
    return false;
  }
}

async function runExpiryJob() {
  // The two campaigns are independent: a failure to read one must not stop
  // the other from being reverted.
  try {
    const due = asArray(await yp.await_proc('promo_launch30_due'));
    if (due.length) {
      console.log(`[PromoExpiryWorker] ${due.length} LAUNCH30 trial(s) due for expiry`);
      let expired = 0;
      for (const row of due) {
        if (await expireOne(row)) expired++;
      }
      console.log(`[PromoExpiryWorker] LAUNCH30 done — ${expired}/${due.length} expired`);
    }
  } catch (error) {
    console.error('[PromoExpiryWorker] LAUNCH30 job failed:', error);
  }

  try {
    const dueCodes = asArray(await yp.await_proc('mkt_coupon_redeem_due'));
    if (dueCodes.length) {
      console.log(`[PromoExpiryWorker] ${dueCodes.length} coupon redemption(s) due for expiry`);
      let expired = 0;
      for (const row of dueCodes) {
        if (await expireOneRedemption(row)) expired++;
      }
      console.log(`[PromoExpiryWorker] coupons done — ${expired}/${dueCodes.length} expired`);
    }
  } catch (error) {
    console.error('[PromoExpiryWorker] coupon redemption job failed:', error);
  }
}

function scheduleNext() {
  setTimeout(async () => {
    try {
      await runExpiryJob();
    } finally {
      scheduleNext();
    }
  }, INTERVAL_MS);
}

async function startWorker() {
  await initialize();
  await runExpiryJob(); // catch up immediately on boot, then settle into the interval
  scheduleNext();
  process.on('SIGUSR2', async () => {
    console.log('[PromoExpiryWorker] SIGUSR2 — manual run');
    await runExpiryJob();
  });
  console.log('[PromoExpiryWorker] Worker started. Manual run: kill -USR2', process.pid);
}

async function shutdown() {
  console.log('[PromoExpiryWorker] Shutting down...');
  try {
    if (yp && yp.connection) await yp.end();
  } catch (error) {
    console.error('[PromoExpiryWorker] Shutdown error:', error.message);
  }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', (error) => {
  console.error('[PromoExpiryWorker] Uncaught exception:', error);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[PromoExpiryWorker] Unhandled rejection:', reason);
  process.exit(1);
});

startWorker().catch((error) => {
  console.error('[PromoExpiryWorker] Failed to start worker:', error);
  process.exit(1);
});

console.log('[PromoExpiryWorker] Worker process started (PID:', process.pid, ')');

module.exports = { runExpiryJob };
