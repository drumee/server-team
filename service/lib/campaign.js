// service/lib/campaign.js
//
// Paid-campaign funnel events. Everything here writes to the yp.campaign_event
// outbox and returns; offline/workers/campaignEventWorker.js does the sending.
// A failure is a reporting gap, never a failed payment, so emit() swallows.

const TEAM_1USD = 'team-1usd';

const OFFERS = {
  [TEAM_1USD]: {
    plan: 'team',
    period: 'month',
    ends_at: Date.parse('2026-11-30T23:59:59+01:00'),
    // $29 first invoice down to $1. A percentage cannot land on $1 exactly.
    coupon_id: 'team_1usd_first_month',
    amount_off: 2800,
    currency: 'usd',
  },
};

/**
 * Record one funnel event for an account in a campaign cohort. Accounts with no
 * offer are skipped by the SELECT, so ordinary traffic costs one indexed lookup.
 * @param {Object} yp
 * @param {string} uid
 * @param {string} event
 * @param {{plan?:string, slot?:string}} [opt] slot makes it repeatable
 */
async function emit(yp, uid, event, opt = {}) {
  if (!uid) return;
  try {
    await yp.await_query(
      'INSERT IGNORE INTO campaign_event (uid, event, slot, plan, ctime)'
      + ' SELECT uid, ?, ?, ?, UNIX_TIMESTAMP() FROM campaign_attribution'
      + ' WHERE uid = ? AND offer IS NOT NULL',
      event, opt.slot || '', opt.plan || null, uid,
    );
  } catch (e) {
    console.warn(`[campaign] ${event} not recorded:`, e && e.message);
  }
}

/**
 * Stamp the organisation on the account's attribution, and copy the attribution
 * into organisation.metadata. Neither side overwrites an earlier value.
 */
async function bindOrg(yp, uid, org_id) {
  if (!uid || !org_id) return;
  try {
    await yp.await_query(
      'UPDATE campaign_attribution SET org_id = ? WHERE uid = ? AND org_id IS NULL',
      org_id, uid,
    );
    await yp.await_query(
      "UPDATE organisation o JOIN campaign_attribution a ON a.org_id = o.id"
      + " SET o.metadata = JSON_SET(COALESCE(o.metadata, '{}'), '$.attribution', JSON_OBJECT("
      + " 'offer', a.offer, 'utm_source', a.utm_source, 'utm_medium', a.utm_medium,"
      + " 'utm_campaign', a.utm_campaign, 'utm_content', a.utm_content, 'utm_term', a.utm_term,"
      + " 'gclid', a.gclid, 'li_fat_id', a.li_fat_id, 'fbclid', a.fbclid, 'country', a.country))"
      + " WHERE a.uid = ? AND o.id = ?"
      + " AND JSON_EXISTS(COALESCE(o.metadata, '{}'), '$.attribution') = 0",
      uid, org_id,
    );
  } catch (e) {
    console.warn('[campaign] org not bound:', e && e.message);
  }
}

/**
 * The offer this checkout qualifies for, or null. Server-side on purpose: the
 * browser only ever said which campaign it came from, never what it pays.
 */
async function offerForCheckout(yp, uid, plan, period, now = Date.now()) {
  try {
    const row = await yp.await_query(
      'SELECT a.offer, (SELECT COUNT(*) FROM campaign_event e WHERE e.uid = a.uid'
      + " AND e.event = 'card_added_1usd') used"
      + ' FROM campaign_attribution a WHERE a.uid = ? LIMIT 1',
      uid,
    );
    const r = Array.isArray(row) ? row[0] : row;
    const offer = r && OFFERS[r.offer];
    if (!offer || Number(r.used) > 0) return null;
    if (now > offer.ends_at || plan !== offer.plan || period !== offer.period) return null;
    return { name: r.offer, ...offer };
  } catch (e) {
    console.warn('[campaign] offer lookup failed:', e && e.message);
    return null;
  }
}

/** The Stripe coupon for an offer, created on first use. */
async function ensureOfferCoupon(stripe, offer) {
  try {
    const c = await stripe.coupons.retrieve(offer.coupon_id);
    if (c && c.valid !== false) return c.id;
  } catch (e) {
    if (!e || e.code !== 'resource_missing') throw e;
  }
  const created = await stripe.coupons.create({
    id: offer.coupon_id,
    name: 'Team $1 first month',
    amount_off: offer.amount_off,
    currency: offer.currency,
    duration: 'once',
  });
  return created.id;
}

/**
 * The funnel events a verified Stripe event stands for.
 * Pure, so the mapping can be tested without Stripe or a database.
 * @param {Object} event  Stripe event
 * @param {Object} md     subscription or session metadata
 * @returns {Array<{event:string, slot?:string, plan?:string}>}
 */
function stripeEventsFor(event, md = {}) {
  if (!md.offer || !OFFERS[md.offer]) return [];
  const obj = (event.data && event.data.object) || {};
  const plan = md.plan || OFFERS[md.offer].plan;
  switch (event.type) {
    case 'checkout.session.completed':
      return obj.payment_status === 'paid' || obj.payment_status === 'no_payment_required'
        ? [{ event: 'card_added_1usd', plan }] : [];
    case 'invoice.payment_failed':
      return obj.billing_reason === 'subscription_create'
        ? [{ event: 'card_failed_1usd', plan, slot: event.id }] : [];
    case 'payment_intent.payment_failed':
      return [{ event: 'card_failed_1usd', plan, slot: event.id }];
    case 'invoice.paid':
      return obj.billing_reason === 'subscription_cycle' && obj.amount_paid === 2900
        ? [{ event: 'renew_29', plan }] : [];
    case 'customer.subscription.deleted':
      return [{ event: 'subscription_cancelled', plan }];
    default:
      return [];
  }
}

const GA_TEXT_MAX = 100;

/**
 * One outbox row, joined to its attribution, as a Measurement Protocol body.
 * GA4 rejects values over 100 characters on a standard property, so long click
 * ids are clipped here; the full value stays in campaign_attribution.
 */
function gaPayload(row) {
  const params = {
    workspace_id: row.org_id || '',
    account_id: row.uid,
    plan: row.plan || OFFERS[row.offer]?.plan || '',
    offer: row.offer || '',
    country: row.country || '',
  };
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
    'gclid', 'li_fat_id', 'fbclid']) {
    if (row[k]) params[k] = String(row[k]).slice(0, GA_TEXT_MAX);
  }
  return {
    // A server event with no browser behind it still needs a stable id.
    client_id: row.ga_client_id || `srv.${row.uid}`,
    timestamp_micros: Number(row.ctime) * 1000000,
    events: [{ name: row.event, params }],
  };
}

module.exports = {
  TEAM_1USD, OFFERS, emit, bindOrg, offerForCheckout, ensureOfferCoupon, stripeEventsFor, gaPayload,
};
