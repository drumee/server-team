// MKT offer rules (yp mkt_offer_check / mkt_offer_claim) and the second half
// of a once_per_card offer checkout (TEAM1).
//
// Shared by service/private/payment.js (preview, checkout, checkout_result)
// and service/public/stripe_webhook.js, which finalizes a card-saving session
// itself when the shopper never comes back to the success page. Neither
// caller is a natural owner, so the logic lives here and takes its context:
//
//   ctx = { yp, stripe: () => Stripe client, uid: payer id, warn: fn }
//
// stripe is a getter so the read-only rule check works without Stripe
// configured, like payment.catalog().
const { classifyEmail } = require('./offer-email');
const { COUPON_HOLD_TTL_SEC } = require('./mkt-coupon');

const CURRENCY = 'usd';

const row0 = (res) => (Array.isArray(res) ? res[0] : res);

/**
 * The offer rules of an MKT coupon: billing cycle, never-paid workspace, not
 * combinable with Reward Hub / LAUNCH30, once per company email domain, once
 * per card, no disposable email. Runs for every code — one without rules
 * answers OK — after mkt_coupon_validate/reserve, which keep owning the base
 * checks.
 *
 * @param {Object} ctx
 * @param {string} code
 * @param {string} email   payer email
 * @param {string} period  'month' | 'year'
 * @param {Object} [opt]   { exclude_id: the caller's own reserved row,
 *                           fingerprint: Stripe card fingerprint }
 * @returns {Promise<Object>} { error } or the coupon's offer fields, plus
 *   domain_key (the company domain to claim on the redemption)
 */
async function offerCheck(ctx, code, email, period, opt = {}) {
  const { domain_key, disposable } = classifyEmail(email);
  let row;
  try {
    row = row0(await ctx.yp.await_proc(
      'mkt_offer_check', code, ctx.uid, email, period, domain_key,
      opt.fingerprint || '', opt.exclude_id || 0, COUPON_HOLD_TTL_SEC,
    ));
  } catch (e) {
    // Code deployed ahead of the schema patch: no offer rules exist yet, so
    // there is nothing to enforce — do not take every other code down.
    if (/does not exist/i.test(e?.message || '')) return { domain_key };
    throw e;
  }
  if (!row || row.error) return { error: row?.error || 'COUPON_INVALID' };
  if (Number(row.block_disposable) === 1 && disposable) return { error: 'OFFER_EMAIL_DISPOSABLE' };
  return { ...row, domain_key };
}

/**
 * Claim the company domain or the card for a pending redemption, atomically
 * (yp mkt_offer_claim holds a lock across check + write, so two shoppers on
 * the same card at the same moment cannot both pass).
 *
 * @returns {Promise<Object>} { error } or the claimed row
 */
async function offerClaim(ctx, redemption_id, domain_key, fingerprint) {
  const row = row0(await ctx.yp.await_proc(
    'mkt_offer_claim', redemption_id, domain_key || '', fingerprint || '', COUPON_HOLD_TTL_SEC,
  ));
  if (!row || row.error) return { error: row?.error || 'COUPON_INVALID' };
  return row;
}

// checkout_result's shape for a subscription bought by offerFinalize.
function offerResult(md, sub, pm) {
  const inv = typeof sub.latest_invoice === 'object' ? sub.latest_invoice : null;
  const item = sub.items?.data?.[0];
  return {
    status: 'complete',
    payment_status: inv?.status === 'paid' ? 'paid' : 'unpaid',
    plan: md.plan || null,
    period: md.period || null,
    entity_type: md.entity_type || 'user',
    amount_total: inv ? inv.amount_paid : null,
    currency: inv?.currency || CURRENCY,
    invoice_number: inv?.number,
    paid_at: inv?.status_transitions?.paid_at || sub.created,
    card_brand: pm?.card?.brand || null,
    card_last4: pm?.card?.last4 || null,
    defer: false,
    starts_at: null,
    upcoming_amount: item?.price ? item.price.unit_amount : null,
    offer_code: md.mkt_code || null,
  };
}

// The subscription already bought from this setup session, if any.
async function findOfferSubscription(stripe, customer, session_id) {
  const held = await stripe.subscriptions.list({
    customer, status: 'all', limit: 20, expand: ['data.latest_invoice', 'data.default_payment_method'],
  });
  return (held.data || []).find((s) => s.metadata?.offer_session === session_id) || null;
}

// The card a setup session saved, with its fingerprint.
async function offerCard(stripe, session) {
  const si_id = typeof session.setup_intent === 'string' ? session.setup_intent : session.setup_intent?.id;
  const si = await stripe.setupIntents.retrieve(si_id, { expand: ['payment_method'] });
  return typeof si?.payment_method === 'object' ? si.payment_method : null;
}

// Buy the discounted subscription on the saved card. Declined / needs action
// → Stripe creates nothing and charges nothing (error_if_incomplete). One
// idempotency key per session: the success page and the webhook may both get
// here, and only one subscription may come out.
function offerSubscribe(stripe, session, customer, pm) {
  const md = session.metadata || {};
  const sub_md = { ...md, offer_session: session.id };
  delete sub_md.offer_setup; delete sub_md.offer_price; delete sub_md.offer_coupon;
  return stripe.subscriptions.create({
    customer,
    items: [{ price: md.offer_price, quantity: 1 }],
    discounts: [{ coupon: md.offer_coupon }],
    default_payment_method: pm.id,
    payment_behavior: 'error_if_incomplete',
    metadata: sub_md,
    expand: ['latest_invoice'],
  }, { idempotencyKey: `offer_${session.id}` });
}

// Marks the redemption used. Idempotent (only a pending row moves), so it is
// run again whenever a finished purchase is seen — a confirm that failed once
// must not leave the offer reusable.
async function offerConfirm(ctx, session, sub, email) {
  try {
    await ctx.yp.await_proc('mkt_coupon_confirm', session.id, sub.id, ctx.uid, email || '');
  } catch (e) {
    ctx.warn?.(`mkt_coupon_confirm (offer) failed: ${e?.message}`);
  }
}

/**
 * Second half of a once_per_card offer checkout: the Checkout session only
 * saved the card (payment.checkout). Reads the card's fingerprint, re-runs
 * the offer rules with it, claims it, and only then creates the discounted
 * subscription and charges the first cycle. The webhook's
 * customer.subscription.created then provisions the org and applies the
 * entitlement as for any checkout — the subscription carries the same
 * metadata.
 *
 * Called from the success page (payment.checkout_result) and from the
 * webhook (checkout.session.completed), whichever comes first; safe to run
 * twice or at once: a subscription already made from this session is found
 * by metadata.offer_session and reported instead of charging again.
 *
 * @param {Object} ctx      ctx.uid must be the session's payer
 * @param {Object} session  Checkout Session (mode 'setup', metadata.offer_setup)
 * @returns {Promise<Object>} same shape as payment.checkout_result
 */
async function offerFinalize(ctx, session) {
  const md = session.metadata || {};
  if (md.payer_id !== ctx.uid) return { status: 'SESSION_NOT_FOUND' };
  if (session.status !== 'complete') {
    return { status: session.status || 'open', payment_status: 'unpaid' };
  }
  const stripe = ctx.stripe();
  const customer = typeof session.customer === 'string' ? session.customer : session.customer?.id;
  const payer = await ctx.yp.await_proc('payment_get_payer', ctx.uid);
  const email = payer?.email || '';

  const done = await findOfferSubscription(stripe, customer, session.id);
  if (done) {
    await offerConfirm(ctx, session, done, email);
    return offerResult(md, done, typeof done.default_payment_method === 'object' ? done.default_payment_method : null);
  }

  const pm = await offerCard(stripe, session);
  const fingerprint = pm?.card?.fingerprint || '';
  if (!fingerprint) return { status: 'OFFER_CARD_REQUIRED', payment_status: 'unpaid' };

  const rid = Math.trunc(Number(md.mkt_redemption_id)) || 0;
  const refuse = async (status) => {
    try { await ctx.yp.await_proc('mkt_offer_release', rid); } catch (e) { /* the hold ages out by TTL anyway */ }
    return { status, payment_status: 'unpaid', offer_code: md.mkt_code || null };
  };
  const offer = await offerCheck(ctx, md.mkt_code, email, md.period, { exclude_id: rid, fingerprint });
  if (offer.error) return refuse(offer.error);
  const claim = await offerClaim(ctx, rid, '', fingerprint);
  if (claim.error) return refuse(claim.error);

  let sub;
  try {
    sub = await offerSubscribe(stripe, session, customer, pm);
  } catch (e) {
    // The other caller (page or webhook) is creating it under the same
    // idempotency key right now: report its subscription once it exists.
    if (e?.code === 'idempotency_key_in_use') {
      await new Promise((r) => setTimeout(r, 2000));
      sub = await findOfferSubscription(stripe, customer, session.id);
    }
    if (!sub) {
      ctx.warn?.(`offer subscription failed: ${e?.message}`);
      return {
        status: 'OFFER_PAYMENT_FAILED', payment_status: 'unpaid', reason: e?.message || '', offer_code: md.mkt_code || null,
      };
    }
  }
  await offerConfirm(ctx, session, sub, email);
  return offerResult(md, sub, pm);
}

module.exports = { offerCheck, offerClaim, offerFinalize };
