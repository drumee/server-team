// service/public/stripe_webhook.js
const { Entity } = require('@drumee/server-core');
const { Messenger } = require('@drumee/server-essentials');
const { resolve } = require('path');
const { stripeClient, endpointSecret } = require('../lib/stripe');
const { sendButlerMail } = require('../lib/butler-mail');

// "What's unlocked" checklist per plan (payment-receipt email, Figma 2803-1288).
// Static marketing copy matching the billing plans page; unknown plans get none.
const PLAN_FEATURES = {
  pro: ['50 GB storage', '5 editor seats included', '7-day version history', 'Permissions & roles', 'Guest access'],
  team: ['50 GB storage per seat', 'Org-wide entitlement', '30-day version history', 'Admin-managed billing'],
};

const CURRENCY_SYMBOL = { eur: '€', usd: '$', gbp: '£' };

class __public_stripe_webhook extends Entity {
  // "€169.90" from Stripe minor units; falls back to "<CODE> 12.34".
  _money(minor, currency) {
    const n = (Number(minor) || 0) / 100;
    const sym = CURRENCY_SYMBOL[(currency || 'eur').toLowerCase()];
    return sym ? `${sym}${n.toFixed(2)}` : `${(currency || '').toUpperCase()} ${n.toFixed(2)}`;
  }

  // "January 7, 2026" (en-US, UTC) from a unix timestamp.
  _longDate(ts) {
    if (!ts) return '';
    return new Date(Number(ts) * 1000).toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
    });
  }

  /**
   * Payment-receipt email for a paid invoice (Figma 2803-1288). Recipient is
   * the Stripe customer email, falling back to the payer's account email.
   * Stripe never emails customers in test mode (and live receipts are a
   * dashboard opt-in), so the app owns this email. Callers must not let a
   * mail failure fail the webhook.
   */
  async _sendReceiptEmail(invoice, sub, smd, { seat_total } = {}) {
    let recipient = invoice.customer_email || null;
    if (!recipient && smd.entity_id && (smd.entity_type || 'user') !== 'org') {
      const payer = await this.yp.await_proc('payment_get_payer', smd.entity_id);
      recipient = (payer && payer.email) || null;
    }
    if (!recipient) {
      this.warn(`receipt email skipped for ${invoice.id}: no recipient email`);
      return;
    }
    const plan = (smd.plan || 'pro').toLowerCase();
    const plan_label = plan.charAt(0).toUpperCase() + plan.slice(1);
    const cycle_label = (smd.period || 'month') === 'year' ? 'billed yearly' : 'billed monthly';
    const paidTs = (invoice.status_transitions && invoice.status_transitions.paid_at) || invoice.created;
    const items = (sub && sub.items && sub.items.data) || [];
    const nextTs = (sub && sub.current_period_end) || (items[0] && items[0].current_period_end) || 0;
    const currency = invoice.currency || 'eur';
    const lines = ((invoice.lines && invoice.lines.data) || []).map((l) => ({
      label: l.description || plan_label,
      amount: this._money(l.amount, l.currency || currency),
    }));
    let app_link = '';
    try { app_link = this.input.homepath(); } catch (e) { app_link = ''; }
    const subject = `Your Drumee ${plan_label} plan is active — receipt ${invoice.number || ''}`.trim();
    const msg = new Messenger({ subject, recipient, handler: this.exception && this.exception.email });
    const tpl = resolve(__dirname, '..', 'private', 'templates', 'butler', 'payment-receipt.html');
    const html = msg.renderFrom(tpl, {
      plan_label,
      cycle_label,
      seats: Number(seat_total) || 0,
      next_billing_date: nextTs ? this._longDate(nextTs) : '',
      amount: this._money(invoice.amount_paid, currency),
      paid_date_long: this._longDate(paidTs),
      invoice_number: invoice.number || invoice.id || '',
      invoice_url: invoice.hosted_invoice_url || '',
      receipt_url: invoice.invoice_pdf || '',
      lines,
      total: this._money(invoice.amount_paid, currency),
      features: PLAN_FEATURES[plan] || [],
      app_link,
      support_email: 'contact@drumee.org',
    });
    const text = [
      `Your Drumee ${plan_label} plan is active.`,
      ``,
      `Receipt from Drumee: ${this._money(invoice.amount_paid, currency)} — paid ${this._longDate(paidTs)}.`,
      `Invoice number: ${invoice.number || invoice.id || ''}`,
      ...(nextTs ? [`Next billing date: ${this._longDate(nextTs)}`] : []),
      ...(invoice.hosted_invoice_url ? [``, `Download invoice: ${invoice.hosted_invoice_url}`] : []),
      ``,
      `Need help? contact@drumee.org`,
      `drumee.org · Privacy Policy: https://drumee.com/privacy/`,
    ].join('\n');
    await sendButlerMail(msg, { recipient, subject, html, text });
  }

  // Classify subscription line items: the base plan item (quantity = seats for
  // org) vs add-on items (entity_type='addon' in yp.plan) — storage add-ons sum
  // disk * quantity into extra_disk (P4); pro_seat add-ons sum seat * quantity
  // into extra_seats (C1 Pro per-seat).
  async _itemsEntitlement(items) {
    let seats = 1, price = 0, extra_disk = 0, extra_seats = 0;
    for (const it of (items || [])) {
      const pid = it && it.price && it.price.id;
      const ad = pid ? await this.yp.await_proc('payment_get_addon', pid) : null;
      if (ad && (Number(ad.disk) || Number(ad.seat))) {
        if (Number(ad.disk)) extra_disk += Number(ad.disk) * (it.quantity || 1);
        if (Number(ad.seat)) extra_seats += Number(ad.seat) * (it.quantity || 1);
      } else {
        seats = it.quantity || 1;
        price = (it.price && it.price.unit_amount) || 0;
      }
    }
    return { seats, price, extra_disk, extra_seats };
  }

  // Seat total to record on the entitlement. Org (team): the base line's
  // quantity IS the seat count. Individual (pro): the plan includes
  // quota.$.seat seats; purchased pro_seat add-ons extend that. Returning 0
  // keeps the plan's default $.seat (guard in payment_apply_entitlement).
  async _seatTotal(entity_type, plan, period, base_seats, extra_seats) {
    if (entity_type === 'org') return base_seats;
    if (!extra_seats) return 0;
    let included = 0;
    try {
      const row = await this.yp.await_proc('payment_get_plan', plan, period, 'eur');
      // quota may be a parsed object or a JSON string — handle both.
      const q = row && row.quota;
      const obj = q && typeof q === 'object' ? q : JSON.parse(q || '{}');
      included = ~~obj.seat || 0;
    } catch (e) { included = 0; }
    return included + extra_seats;
  }

  async receive() {
    let stripe, secret;
    try { stripe = stripeClient(); secret = endpointSecret(); }
    catch (e) { return this.exception.bad_request('_webhook_signature_invalid'); }
    if (!secret) return this.exception.bad_request('_webhook_signature_invalid');
    const raw = this.input.rawString();              // STRING form — not this.input.raw() (an array)
    const sig = (this.input.headers() || {})['stripe-signature'];
    let event;
    try {
      event = stripe.webhooks.constructEvent(raw, sig, secret);
    } catch (err) {
      return this.exception.bad_request('_webhook_signature_invalid'); // HTTP 400, blocking
    }
    // Idempotency: UNIQUE(event_id). seen.duplicate==1 => already handled.
    const seen = await this.yp.await_proc('stripe_event_seen', event.id, event.type);
    if (seen && Number(seen.duplicate) === 1) {
      return this.output.data({ ok: 1, duplicate: 1 });
    }
    const obj = (event.data && event.data.object) || {};
    const md = obj.metadata || {};
    try {
      switch (event.type) {
        case 'checkout.session.completed':
        case 'customer.subscription.created':
        case 'customer.subscription.updated': {
          const entity_id = md.entity_id;
          const plan = md.plan || 'pro';
          const period = md.period || 'month';
          if (entity_id) {
            // Mirror the live subscription for the status panel + Billing Portal.
            const customer_id = obj.customer || null;
            // checkout.session.completed carries the SESSION in obj — its
            // .subscription may still be null and the session id (cs_…, 66
            // chars) must never be mirrored as a subscription id (VARCHAR(30)
            // overflow silently killed the mirror row).
            const subscription_id = obj.object === 'checkout.session'
              ? (typeof obj.subscription === 'string' ? obj.subscription : null)
              : (obj.id || null);
            // A pending cancellation (portal "Cancel subscription" = cancel at
            // period end) keeps Stripe status 'active'; mirror it as 'canceled'
            // so the UI status line reads "will be canceled on {period_end}"
            // (the design's Settings-card copy). Entitlement stays until the
            // final customer.subscription.deleted.
            const status = obj.cancel_at_period_end ? 'canceled' : (obj.status || 'active');
            const entity_type = md.entity_type || 'user';
            // Line items: the subscription object carries them; a checkout.session
            // does not, so retrieve the subscription to read base + add-ons.
            let items = (obj.items && obj.items.data) || null;
            let period_end = obj.current_period_end || (items && items[0] && items[0].current_period_end) || 0;
            if (!items && subscription_id) {
              try {
                const s = await stripe.subscriptions.retrieve(subscription_id);
                items = (s.items && s.items.data) || [];
                period_end = period_end || s.current_period_end || (items[0] && items[0].current_period_end) || 0;
              } catch (e3) { items = []; }
            }
            const { seats, price, extra_disk, extra_seats } = await this._itemsEntitlement(items);
            const seat_total = await this._seatTotal(entity_type, plan, period, seats, extra_seats);
            // 0, not null: await_proc maps null -> '' which a strict-mode INT param rejects.
            // Mirror only with a real subscription id — the subscription.created/
            // updated events carry it when the session doesn't.
            if (subscription_id) {
              await this.yp.await_proc('subscription_update', entity_id, customer_id, subscription_id, plan, period, 1, price, 0, status);
            }
            await this.yp.await_proc('payment_apply_entitlement', entity_id, plan, period_end, entity_type, seat_total, extra_disk);
            // Push the REAL status (canceled when cancel_at_period_end), not a
            // hardcoded 'active' — a pending cancel must reach the client so the
            // billing screen flips to "ends on {period_end}" in realtime. Carry
            // period_end so the FE can render the date without a refetch.
            await this.notify_user(entity_id, { service: 'payment.plan_updated', plan, status, period_end });
          }
          break;
        }
        case 'customer.subscription.deleted': {
          const entity_id = md.entity_id;
          if (entity_id) {
            const etype = md.entity_type || 'user';
            await this.yp.await_proc('subscription_remove', entity_id, obj.id || '');
            if (etype === 'org') {
              // Team cancel: DELETE the org entitlement row so every member
              // falls back to the per-user free tier. Applying a 'free' plan to
              // an org yields disk 0 (no ('free','org') plan row → 50GB*0 seats)
              // and locks out the whole team.
              await this.yp.await_proc('payment_clear_entitlement', entity_id);
            } else {
              await this.yp.await_proc('payment_apply_entitlement', entity_id, 'free', 0, 'user', 0, 0);
            }
            await this.notify_user(entity_id, { service: 'payment.plan_updated', plan: 'free', status: 'canceled' });
          }
          break;
        }
        case 'invoice.paid':
        case 'invoice.payment_failed': {
          // Invoices don't carry the subscription metadata directly — resolve it.
          const subId = obj.subscription
            || (obj.parent && obj.parent.subscription_details && obj.parent.subscription_details.subscription)
            || null;
          let sub = null;
          if (subId) { try { sub = await stripe.subscriptions.retrieve(subId); } catch (e2) {} }
          const smd = (sub && sub.metadata) || {};
          const eid = smd.entity_id;
          if (eid) {
            if (event.type === 'invoice.paid') {
              // Recurring renewal succeeded -> re-apply entitlement (bumps period_end).
              const items = (sub && sub.items && sub.items.data) || [];
              const pend = (sub && sub.current_period_end) || (items[0] && items[0].current_period_end) || 0;
              const { seats, extra_disk, extra_seats } = await this._itemsEntitlement(items);
              const seat_total = await this._seatTotal(smd.entity_type || 'user', smd.plan || 'pro', smd.period || 'month', seats, extra_seats);
              await this.yp.await_proc('payment_apply_entitlement', eid, smd.plan || 'pro', pend, smd.entity_type || 'user', seat_total, extra_disk);
              await this.notify_user(eid, { service: 'payment.plan_updated', plan: smd.plan, status: 'active' });
              // Payment-receipt email (initial payment AND every renewal both
              // arrive as invoice.paid). A mail failure must never fail the
              // webhook — the entitlement above is already applied and Stripe
              // would re-deliver the whole event on a 500.
              try {
                await this._sendReceiptEmail(obj, sub, smd, { seat_total });
              } catch (e4) {
                this.error(`receipt email failed for ${event.id}: ${e4.message}`);
              }
            } else {
              // Payment failed -> keep entitlement during Stripe's smart retries
              // (grace); final failure downgrades via customer.subscription.deleted.
              await this.notify_user(eid, { service: 'payment.payment_failed', plan: smd.plan, status: 'past_due' });
            }
          }
          break;
        }
        default:
          break; // unhandled types are acknowledged (already deduped)
      }
    } catch (e) {
      this.error(`stripe reducer failed for ${event.id}: ${e.message}`); // message only, no secrets
      // Undo the 'seen' row so Stripe's retry re-processes this event instead of
      // hitting the duplicate guard and skipping it (which would silently drop a
      // cancellation/downgrade). Return 500 so Stripe actually retries.
      try { await this.yp.await_proc('stripe_event_delete', event.id); } catch (e2) {}
      return this.exception.server({ error: '_internal_error', service: 'stripe_webhook' });
    }
    await this.yp.await_proc('stripe_event_processed', event.id);
    this.output.data({ ok: 1 });
  }
}

module.exports = __public_stripe_webhook;
