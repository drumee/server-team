// service/lib/subscription-cancel.js
// One rule for every "stop this subscription" request -- the in-app Cancel,
// a Billing Portal cancel, and an account deletion:
//
//  - Paid up (active / trialing): end at period end. The customer keeps what
//    they already paid for and is never charged again.
//  - Owing (past_due / unpaid / incomplete): end NOW and void the unpaid
//    invoice. Cancelling at period end here kept Stripe dunning the renewal
//    invoice it had already issued, for a period the customer had just said
//    they did not want -- live case Lionet Technology, 2026-10-21: renewal
//    declined, cancelled the same day, still retried for days after.
//    Product decision (Iris, 2026-10-26): no payment, no paid period.

const OWING = /^(past_due|unpaid|incomplete)$/;

// A pending cancellation takes either form: the in-app Cancel sets
// cancel_at_period_end, while the Billing Portal (current API) sets cancel_at
// and leaves cancel_at_period_end false.
function isPendingCancel(sub) {
  return !!(sub && (sub.cancel_at_period_end || sub.cancel_at));
}

// Update params that undo whichever form the pending cancellation took.
// Stripe refuses cancel_at and cancel_at_period_end in the same call.
function clearCancelParams(sub) {
  if (sub && !sub.cancel_at_period_end && sub.cancel_at) return { cancel_at: '' };
  return { cancel_at_period_end: false };
}

function isMissing(e) {
  return /resource_missing|No such subscription/i.test(String((e && (e.code || e.message)) || ''));
}

// Best effort: Stripe already stops collecting a cancelled subscription's open
// invoices; voiding also takes the debt off the customer's portal and receipts.
async function voidOpenInvoices(stripe, subscription_id, warn) {
  try {
    const open = await stripe.invoices.list({ subscription: subscription_id, status: 'open', limit: 20 });
    for (const inv of open.data || []) {
      try { await stripe.invoices.voidInvoice(inv.id); }
      catch (e) { warn && warn(`void ${inv.id} failed: ${e.message}`); }
    }
  } catch (e) {
    warn && warn(`open invoices of ${subscription_id} unreadable: ${e.message}`);
  }
}

/**
 * Apply the rule above to one subscription.
 * @returns {{sub: object, ended: boolean}} the live subscription after the
 *   change; ended=true when it is over now rather than at period end.
 */
async function endSubscription(stripe, subscription_id, warn) {
  let sub = await stripe.subscriptions.retrieve(subscription_id);
  if (OWING.test(String(sub.status || ''))) {
    // Cancel before voiding: voiding first settles the subscription back to
    // 'active' for a moment and the webhook mirrors that.
    sub = await stripe.subscriptions.cancel(subscription_id);
    await voidOpenInvoices(stripe, subscription_id, warn);
    return { sub, ended: true };
  }
  if (/^(canceled|incomplete_expired)$/.test(String(sub.status || ''))) return { sub, ended: true };
  // Already scheduled (either form): leave the date the customer chose alone.
  if (!isPendingCancel(sub)) {
    sub = await stripe.subscriptions.update(subscription_id, { cancel_at_period_end: true });
  }
  return { sub, ended: false };
}

/**
 * Stop billing everything an account pays for, before the account is deleted:
 * its personal subscription and the one of the organisation it owns. A deleted
 * account used to keep being charged -- nothing in the delete path spoke to
 * Stripe at all.
 * Throws when Stripe could not be reached for a subscription that exists, so
 * the caller can refuse to delete rather than leave a live charge behind.
 */
async function endSubscriptionsOf(yp, stripe, uid, warn) {
  const ids = [];
  const own = await yp.await_proc('payment_get_subscription', uid);
  if (own && own.subscription_id) ids.push(own.subscription_id);
  const org = await yp.await_proc('payment_get_org', uid);
  if (org && org.id) {
    const orgSub = await yp.await_proc('payment_get_subscription', org.id);
    if (orgSub && orgSub.subscription_id) ids.push(orgSub.subscription_id);
  }
  for (const id of ids) {
    try {
      await endSubscription(stripe, id, warn);
    } catch (e) {
      if (isMissing(e)) continue;
      throw e;
    }
  }
  return ids.length;
}

module.exports = { isPendingCancel, clearCancelParams, endSubscription, endSubscriptionsOf };
