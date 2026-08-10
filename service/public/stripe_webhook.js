// service/public/stripe_webhook.js
const { Entity } = require('@drumee/server-core');
const { Messenger } = require('@drumee/server-essentials');
const { resolve } = require('path');
const { stripeClient, endpointSecret } = require('../lib/stripe');
const { sendButlerMail } = require('../lib/butler-mail');
const { pushRevenueLive } = require('../private/_revenue_live');

// "What's unlocked" checklist per plan (payment-receipt email, Figma 2803-1288).
// Static marketing copy matching the billing plans page (the July 2026 FINAL
// pricing table: flat plans, Business self-serve); unknown plans get none.
// 'pro' is the retired B2C tier — kept so receipts for its remaining renewals
// still describe what the subscriber actually has.
const PLAN_FEATURES = {
  pro: ['50 GB storage', '5 editor seats included', '7-day version history', 'Permissions & roles', 'Guest access'],
  team: ['100 GB storage', 'Up to 10 members', '30-day version history', 'Granular permissions (role-based)', 'Guest access', 'Admin panel'],
  business: ['Multiple workspaces', 'Unlimited members', '1 TB storage', '1-year version history', 'Granular permissions + audit', 'Admin panel + audit logs', 'API access', 'SSO / SAML', 'Priority support + SLA'],
};

const CURRENCY_SYMBOL = { eur: '€', usd: '$', gbp: '£' };

class __public_stripe_webhook extends Entity {
  // "€169.90" from Stripe minor units; falls back to "<CODE> 12.34". Negative
  // amounts (downgrade proration credits) render as "-$58.00", not "$-58.00".
  _money(minor, currency) {
    const n = (Number(minor) || 0) / 100;
    const sign = n < 0 ? '-' : '';
    const abs = Math.abs(n);
    const sym = CURRENCY_SYMBOL[(currency || 'usd').toLowerCase()];
    return sym ? `${sign}${sym}${abs.toFixed(2)}` : `${sign}${(currency || '').toUpperCase()} ${abs.toFixed(2)}`;
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
   * heading/intro/subject override the default "plan is active" copy — the
   * resume confirmation (Figma 3050-96856) sends the same receipt shell with
   * "plan is resumed" copy.
   */
  async _sendReceiptEmail(invoice, sub, smd, { seat_total, heading, intro, subject } = {}) {
    let recipient = invoice.customer_email || null;
    // Org (Team) subscriptions: the org's Stripe customer is created without
    // an email when the organisation already exists (payment.checkout sets
    // email only on the payer-keyed bootstrap customer), so customer_email
    // can be null. payer_id always travels in the subscription metadata —
    // fall back to the paying user's account email.
    if (!recipient && smd.payer_id) {
      const payer = await this.yp.await_proc('payment_get_payer', smd.payer_id);
      recipient = (payer && payer.email) || null;
    }
    if (!recipient && smd.entity_id && (smd.entity_type || 'user') !== 'org') {
      const payer = await this.yp.await_proc('payment_get_payer', smd.entity_id);
      recipient = (payer && payer.email) || null;
    }
    if (!recipient) {
      this.warn(`receipt email skipped for ${invoice.id}: no recipient email`);
      return;
    }
    const plan = (smd.plan || 'team').toLowerCase();
    const plan_label = plan.charAt(0).toUpperCase() + plan.slice(1);
    const cycle_label = (smd.period || 'month') === 'year' ? 'billed yearly' : 'billed monthly';
    const paidTs = (invoice.status_transitions && invoice.status_transitions.paid_at) || invoice.created;
    const items = (sub && sub.items && sub.items.data) || [];
    const nextTs = (sub && sub.current_period_end) || (items[0] && items[0].current_period_end) || 0;
    const currency = invoice.currency || 'usd';
    const lines = ((invoice.lines && invoice.lines.data) || []).map((l) => ({
      label: l.description || plan_label,
      amount: this._money(l.amount, l.currency || currency),
    }));
    // "Open Drumee" must (a) target the RECIPIENT's host — the session cookie
    // is host-scoped, so an org member's session lives on their org vhost and
    // a main-domain link lands signed-out — and (b) go through the
    // callback.portal_return same-site bounce: the cookie is SameSite=Strict,
    // so it is withheld on the cross-site click from the mail client; the
    // bounce re-enters same-site and the session survives (QA: "click Open
    // Drumee → it requires sign in again").
    let app_link = '';
    try {
      const home = new URL(this.input.homepath());
      if ((smd.entity_type || 'user') === 'org' && smd.payer_id) {
        const org = await this.yp.await_proc('payment_get_org', smd.payer_id);
        if (org && org.link) home.host = org.link;
      }
      let path = home.pathname || '/';
      if (!/\/$/.test(path)) path = `${path}/`;
      app_link = `${home.protocol}//${home.host}${path}svc/?service=callback.portal_return`;
    } catch (e) { app_link = ''; }
    heading = heading || `Your Drumee ${plan_label} plan is active`;
    intro = intro || "Your payment went through. Here's your receipt.";
    subject = subject || `${heading} — receipt ${invoice.number || ''}`.trim();
    const msg = new Messenger({ subject, recipient, handler: this.exception && this.exception.email });
    const tpl = resolve(__dirname, '..', 'private', 'templates', 'butler', 'payment-receipt.html');
    const html = msg.renderFrom(tpl, {
      heading,
      intro,
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
      `${heading}.`,
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

  // "Visa **** 2363" from the failed invoice's charge, when retrievable.
  // Purely decorative — every caller treats '' as "omit the row".
  async _cardLabel(stripe, invoice) {
    try {
      const chargeId = typeof invoice.charge === 'string' ? invoice.charge : null;
      if (!chargeId) return '';
      const charge = await stripe.charges.retrieve(chargeId);
      const card = charge && charge.payment_method_details && charge.payment_method_details.card;
      if (!card || !card.last4) return '';
      const brand = (card.brand || 'card').replace(/^\w/, (c) => c.toUpperCase());
      return `${brand} **** ${card.last4}`;
    } catch (e) { return ''; }
  }

  /**
   * Dunning emails for a failed renewal charge (Figma 2803-2624 / 2803-2971).
   * Stripe fires invoice.payment_failed on EVERY smart-retry attempt:
   *  - next_payment_attempt set   → "we couldn't process your payment, we'll
   *    retry on {date}" (workspace stays active meanwhile).
   *  - next_payment_attempt null  → FINAL warning: retries exhausted, the plan
   *    lapses to Free ("no further reminders after this one").
   * Callers must not let a mail failure fail the webhook.
   */
  async _sendDunningEmail(stripe, invoice, sub, smd) {
    let recipient = invoice.customer_email || null;
    if (!recipient && smd.entity_id && (smd.entity_type || 'user') !== 'org') {
      const payer = await this.yp.await_proc('payment_get_payer', smd.entity_id);
      recipient = (payer && payer.email) || null;
    }
    if (!recipient) {
      this.warn(`dunning email skipped for ${invoice.id}: no recipient email`);
      return;
    }
    const plan = (smd.plan || 'team').toLowerCase();
    const plan_label = plan.charAt(0).toUpperCase() + plan.slice(1);
    const cycle_label = (smd.period || 'month') === 'year' ? 'billed yearly' : 'billed monthly';
    const currency = invoice.currency || 'usd';
    const card_label = await this._cardLabel(stripe, invoice);
    let billing_link = '';
    try { billing_link = this.input.homepath(); } catch (e) { billing_link = ''; }
    const isFinal = !invoice.next_payment_attempt;
    const tplName = isFinal ? 'payment-final-warning.html' : 'payment-failed.html';
    const subject = isFinal
      ? `Final reminder — your Drumee ${plan_label} plan is about to downgrade`
      : `Action needed — we couldn't process your Drumee payment`;
    const msg = new Messenger({ subject, recipient, handler: this.exception && this.exception.email });
    const tpl = resolve(__dirname, '..', 'private', 'templates', 'butler', tplName);
    let html, text;
    if (isFinal) {
      // Retries exhausted: the sub lapses at cancel_at when Stripe's dunning is
      // configured to cancel, else at the already-paid period's end.
      const downTs = (sub && (sub.cancel_at || sub.current_period_end)) || 0;
      const downgrade_date = downTs ? this._longDate(downTs) : '';
      html = msg.renderFrom(tpl, {
        plan_label, card_label, downgrade_date,
        features: PLAN_FEATURES[plan] || [],
        billing_link, support_email: 'contact@drumee.org',
      });
      text = [
        `Your Drumee ${plan_label} plan is about to downgrade.`,
        ``,
        `We still haven't been able to process your payment. Without payment, your workspace moves to Free${downgrade_date ? ` on ${downgrade_date}` : ''}. No further reminders after this one.`,
        ...(billing_link ? [``, `Update payment method: ${billing_link}`] : []),
        ``,
        `Need help? contact@drumee.org`,
      ].join('\n');
    } else {
      const retry_hint = invoice.next_payment_attempt ? `on ${this._longDate(invoice.next_payment_attempt)}` : '';
      html = msg.renderFrom(tpl, {
        plan_label, cycle_label, card_label,
        amount_due: this._money(invoice.amount_due, currency),
        attempted_on: this._longDate(invoice.created),
        retry_hint,
        billing_link, support_email: 'contact@drumee.org',
      });
      text = [
        `We couldn't process your payment for the Drumee ${plan_label} plan.`,
        ``,
        `Amount due: ${this._money(invoice.amount_due, currency)} — attempted ${this._longDate(invoice.created)}.`,
        `We'll automatically retry this charge${retry_hint ? ` ${retry_hint}` : ''}. Your workspace stays active in the meantime.`,
        ...(billing_link ? [``, `Update payment method: ${billing_link}`] : []),
        ``,
        `Need help? contact@drumee.org`,
      ].join('\n');
    }
    await sendButlerMail(msg, { recipient, subject, html, text });
  }

  // A payer who upgrades to TEAM after already paying for a personal plan
  // (e.g. Pro bought before the org existed) must not keep being billed for
  // both — the org entitlement supersedes the personal one entirely. Cancels
  // the payer's own Stripe subscription immediately (not cancel_at_period_end:
  // they're gaining entitlement, not losing it, so there is no "keep access
  // until period end" to honor). The resulting customer.subscription.deleted
  // event cleans up the personal mirror/quota row through the normal path.
  // Best-effort and idempotent: an already-canceled/missing subscription
  // throws from Stripe, which is caught and ignored — never let this fail
  // the org webhook event that triggered it.
  async _cancelSupersededPersonalSubscription(payer_id, stripe) {
    const personal = await this.yp.await_proc('payment_get_subscription', payer_id);
    const subId = personal && personal.subscription_id;
    if (!subId || personal.status === 'canceled') return;
    try {
      // Team→Pro switch guard: a personal sub bought to SUPERSEDE the org
      // (metadata.supersede='org') must never be killed from the org
      // direction — the very cancel_at_period_end update that switch puts on
      // the org sub re-enters this path and would otherwise cancel the
      // just-purchased Pro.
      const live = await stripe.subscriptions.retrieve(subId);
      if (live && live.metadata && live.metadata.supersede === 'org') return;
      await stripe.subscriptions.cancel(subId);
    } catch (e) {
      this.warn(`superseded personal subscription cancel skipped for ${payer_id}: ${e.message}`);
    }
  }

  // Team→Pro switch (metadata.supersede='org', set by payment.checkout when
  // the owner confirmed the switch popup): cancel the payer's ORG/Team
  // subscription AT PERIOD END once the personal checkout completes — the
  // Team workspace stays fully usable until the paid period runs out, then
  // the owner continues on the new personal plan. Contrast with the Pro→Team
  // direction above, which cancels the superseded personal sub immediately
  // (the owner moves onto the org domain the moment the org is provisioned).
  // Idempotent: re-applying cancel_at_period_end is a no-op, and a mirror
  // already marked canceled is skipped.
  async _cancelSupersededOrgSubscription(payer_id, stripe) {
    const org = await this.yp.await_proc('payment_get_org', payer_id);
    if (!org || !org.id) return;
    const sub = await this.yp.await_proc('payment_get_subscription', org.id);
    const subId = sub && sub.subscription_id;
    if (!subId || sub.status === 'canceled') return;
    try {
      await stripe.subscriptions.update(subId, { cancel_at_period_end: true });
    } catch (e) {
      this.warn(`superseded org subscription cancel skipped for ${payer_id}: ${e.message}`);
    }
  }

  // TEAM bootstrap resolution: metadata for org subscriptions created before
  // the org existed carries entity_id = payer uid plus payer_id (+ org_ident/
  // org_name on the bootstrap checkout). Resolve the payer's organisation —
  // provisioning it atomically on first contact (yp org_provision is
  // idempotent: an existing org for this owner is returned untouched, so the
  // session event and an early invoice.paid can race safely). A provisioning
  // failure throws so the event returns 500 and Stripe retries instead of
  // applying a mis-keyed entitlement.
  async _resolveOrgEntity(md, stripe) {
    if ((md.entity_type || 'user') !== 'org' || !md.payer_id) return md.entity_id;
    let org = await this.yp.await_proc('payment_get_org', md.payer_id);
    if ((!org || !org.id) && md.org_ident) {
      const provisioned = await this.yp.await_proc(
        'org_provision', md.payer_id, md.org_name || md.org_ident, md.org_ident
      );
      if (provisioned && provisioned.error) {
        throw new Error(`org_provision failed: ${provisioned.error}`);
      }
      org = await this.yp.await_proc('payment_get_org', md.payer_id);
      if (org && org.id) {
        // Tell the payer's live session about its new home so the FE can
        // transition (the next full bootstrap lands on the new domain anyway).
        await this.notify_user(md.payer_id, {
          service: 'payment.org_provisioned',
          domain_id: org.domain_id,
          ident: org.ident,
          link: org.link,
        });
      }
    }
    if (org && org.id && stripe) {
      await this._cancelSupersededPersonalSubscription(md.payer_id, stripe);
    }
    return (org && org.id) ? org.id : md.entity_id;
  }

  // Classify subscription line items: the base plan item (quantity = seats for
  // org) vs add-on items (entity_type='addon' in yp.plan) — storage add-ons sum
  // disk * quantity into extra_disk (P4); pro_seat add-ons sum seat * quantity
  // into extra_seats (C1 Pro per-seat).
  // Resolve what a subscription is ACTUALLY on, from the price its items carry.
  //
  // Everything downstream — the yp.subscription mirror, the quota applied by
  // payment_apply_entitlement, the receipt heading — reads plan/period out of
  // the subscription METADATA, which is written once at checkout and rewritten
  // only by payment.change_plan. A price switched by any other route (the
  // Stripe Billing Portal, a dashboard edit, a support action) leaves that
  // metadata behind: the customer is charged the new price while the OLD plan's
  // quota keeps being applied, and the receipt names the plan they just left.
  // yp.plan holds the price ids, so the mapping back is a lookup — take it when
  // it disagrees, and fall back to the metadata when there is nothing to find
  // (an add-on-only item, a price retired from the catalog).
  //
  // Returns null when the items resolve to no catalog plan.
  async _planFromItems(items) {
    for (const it of (items || [])) {
      const pid = it && it.price && it.price.id;
      if (!pid) continue;
      let row = await this.yp.await_query(
        `SELECT plan_code, period, entity_type FROM plan
          WHERE stripe_price_id = ? AND active = 1 AND entity_type <> 'addon' LIMIT 1`,
        pid
      );
      if (Array.isArray(row)) row = row[0];
      if (row && row.plan_code) {
        // entity_type travels with the plan. Correcting the plan while leaving
        // the metadata's entity kind behind is worse than not correcting at
        // all: payment_apply_entitlement looks the plan up WITH entity_type, so
        // an org plan applied as 'user' matches no row and falls back to a bare
        // 20 GB personal grant — the customer pays for Team and receives less
        // than Free.
        return {
          plan: String(row.plan_code),
          period: String(row.period || ''),
          entity_type: String(row.entity_type || ''),
        };
      }
    }
    return null;
  }

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
      // 'usd': the pricing rebuild deactivated every EUR row, so the old
      // hardcoded 'eur' matched nothing and silently reported no included
      // seats. Unrelated to seat sales — this lookup is on the legacy
      // individual path and was wrong either way.
      const row = await this.yp.await_proc('payment_get_plan', plan, period, 'usd');
      // quota may be a parsed object or a JSON string — handle both.
      const q = row && row.quota;
      const obj = q && typeof q === 'object' ? q : JSON.parse(q || '{}');
      included = ~~obj.seat || 0;
    } catch (e) { included = 0; }
    return included + extra_seats;
  }

  // Fresh quota for a payment.plan_updated notify. Without it the client's
  // Visitor.respawn keeps its cached quota (ui-core skips absent keys), so
  // every surface reading Visitor.quota() — Settings→Storage, the disk toast
  // — showed the OLD capacity until a full reload re-ran get_env. For an org
  // the tenant-first cascade gives every member the same org quota, so the
  // payer's view is correct for all recipients.
  //
  // Best-effort: the entitlement is already applied and the FE re-reads it on
  // reload, so a failed lookup just means the payload goes out without quota.
  async _freshQuota(payer_id, entity_id, entity_type) {
    const uid = payer_id || (entity_type !== 'org' ? entity_id : '');
    if (!uid) return undefined;
    try {
      let q = await this.yp.await_func('get_quota', uid);
      // await_func returns SQL-function JSON as a string.
      if (typeof q === 'string') { try { q = JSON.parse(q); } catch (e) { q = null; } }
      return q && typeof q === 'object' ? q : undefined;
    } catch (e) { return undefined; }
  }

  // Downgrade over-limit: re-evaluate the org's usage/seats against the
  // entitlement THIS webhook just wrote. Every plan-lowering path commits
  // through payment_apply_entitlement / payment_clear_entitlement in this
  // file, so hooking the three call sites covers checkout-supersede,
  // change_plan, Billing-Portal downgrades, cancel->free and dunning in one
  // move. Personal plans never lock a workspace (evaluate() ignores
  // domain<=1), and upgrades that clear an existing block also flow through
  // here — that is what flips the workspace back to 'ok' live.
  // Best-effort by design: the entitlement is already committed, and a
  // failed evaluation must not 500 the webhook (Stripe would re-deliver).
  async _evaluateOverLimit(entity_id, entity_type) {
    try {
      if (entity_type !== 'org') return;
      const OverLimit = require('../lib/over-limit');
      if (!OverLimit.enabled()) return;
      let org = await this.yp.await_query(
        `SELECT domain_id FROM organisation WHERE id = ? LIMIT 1`, entity_id
      );
      if (Array.isArray(org)) org = org[0];
      const dom = ~~(org && org.domain_id);
      if (dom <= 1) return;
      const { RedisStore } = require('@drumee/server-essentials');
      await OverLimit.evaluate(this.yp, dom, {
        notify: (state) => OverLimit.notifyDomain(this.yp, RedisStore, state),
      });
    } catch (e) {
      this.warn && this.warn('[over-limit] post-entitlement evaluation failed:', e && e.message);
    }
  }

  // An Invoice's own subscription link. On API version 2026-05-27.dahlia
  // (and later), Invoice.subscription is gone; the id lives at
  // invoice.parent.subscription_details.subscription instead. Kept as one
  // helper so invoice.paid, invoice.payment_failed and charge.refunded read
  // the same shape and can't drift apart — the refund path missing this was
  // empirically proven on stage to skip every single refund (91 invoices, 91
  // skips) because invoice.subscription is always undefined on this version.
  _invoiceSubscriptionId(invoice) {
    return (invoice && typeof invoice.subscription === 'string' ? invoice.subscription : null)
      || (invoice && invoice.parent && invoice.parent.subscription_details
        && invoice.parent.subscription_details.subscription)
      || null;
  }

  /**
   * Turn a Stripe invoice into the ledger row payment_ledger_upsert takes.
   *
   * ONE BUILDER, TWO EVENTS. invoice.paid and charge.refunded both write the
   * same row and differ only in the amounts Stripe reports at the time. Two
   * hand-built objects is how a refund ends up storing a different plan or a
   * blank email than the payment it corrects.
   *
   * THE EMAIL IS THE ONE STRIPE BILLED, falling back to the payer's account
   * address. It cannot come from a drumate join on entity_id: an org plan keys
   * entity_id to the ORGANISATION, so that join is NULL for every business and
   * team subscription (visible on stage today).
   *
   * @param {Object} invoice  Stripe Invoice
   * @param {Object} sub      Stripe Subscription (may be null)
   * @param {Object} smd      subscription metadata
   * @param {String} entity_id resolved org/user id
   * @param {Object} eff      { plan, period, entity_type } already resolved by the caller
   * @returns {Promise<Object>} args for payment_ledger_upsert
   */
  async _ledgerRowFromInvoice(invoice, sub, smd, entity_id, eff) {
    const md = smd || {};
    const payer_id = md.payer_id || (eff.entity_type === 'user' ? entity_id : null);
    let email = (invoice.customer_email)
      || (invoice.customer_details && invoice.customer_details.email)
      || '';
    if (!email && payer_id) {
      try {
        const payer = await this.yp.await_proc('payment_get_payer', payer_id);
        email = (payer && payer.email) || '';
      } catch (e) { /* the row is still worth storing without an address */ }
    }
    // post_payment_credit_notes_amount catches an invoice credited AFTER
    // payment. It is the ONLY refund figure available here: a Stripe Invoice
    // carries no refunded total of its own, and the charge that would know one
    // is not fetched on this path. The charge-side figure arrives through
    // charge.refunded, which re-reads this same invoice and calls the same
    // upsert with the larger of the two — see that handler.
    const refunded = ~~invoice.post_payment_credit_notes_amount;
    return {
      invoice_id: invoice.id,
      subscription_id: this._invoiceSubscriptionId(invoice) || (sub && sub.id) || null,
      customer_id: (typeof invoice.customer === 'string' ? invoice.customer : null),
      entity_id,
      payer_id,
      email,
      entity_type: eff.entity_type === 'org' ? 'org' : 'user',
      plan: eff.plan,
      period: eff.period === 'year' ? 'year' : 'month',
      amount_paid: ~~invoice.amount_paid,
      amount_refunded: refunded,
      currency: String(invoice.currency || 'usd').toLowerCase(),
      billing_reason: invoice.billing_reason || null,
      // status_transitions.paid_at is when the money actually moved; `created`
      // is when the invoice was drafted, which for a renewal is days earlier
      // and would file the payment in the wrong month.
      paid_at: ~~((invoice.status_transitions && invoice.status_transitions.paid_at)
        || invoice.created),
      promo_code: md.mkt_code || null,
      source: 'webhook',
    };
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
          let entity_id = md.entity_id;
          const plan = md.plan || 'team';
          const period = md.period || 'month';
          // TEAM bootstrap: the organisation may not exist at checkout time —
          // resolve (and provision if needed) before billing the ORG entity.
          entity_id = await this._resolveOrgEntity(md, stripe);
          // Team→Pro switch: a personal checkout flagged to supersede the
          // payer's org subscription — end the Team plan (at period end) now
          // that the Pro payment is confirmed.
          if ((md.entity_type || 'user') === 'user' && md.supersede === 'org'
            && md.payer_id && stripe) {
            await this._cancelSupersededOrgSubscription(md.payer_id, stripe);
          }
          // A subscription.updated event about a subscription that has already
          // been REPLACED must not touch the mirror. The deferred cycle switch
          // marks the old subscription cancel_at_period_end, and that very
          // update lands here carrying status 'canceled' — written as-is it
          // flips the mirror back to the dying subscription and the UI reports
          // the plan the user just replaced as "will be canceled", hiding the
          // one they bought. Newer-for-the-same-entity on the same customer =
          // this event is the tail of a replacement: skip it. (created /
          // checkout.completed are always about the newest subscription, and
          // the deleted handler has its own copy of this guard.)
          if (event.type === 'customer.subscription.updated'
            && entity_id && stripe && obj.customer && obj.id) {
            try {
              const held = await stripe.subscriptions.list({
                customer: obj.customer, status: 'all', limit: 20,
              });
              const newer = (held.data || []).some(
                (s) => s.id !== obj.id
                  && /^(active|trialing|past_due)$/.test(s.status)
                  && s.metadata && s.metadata.entity_id === entity_id
                  && ~~s.created >= ~~obj.created,
              );
              if (newer) {
                this.debug(`ignoring update of superseded subscription ${obj.id} for ${entity_id}`);
                break;
              }
            } catch (e8) {
              // Unreachable Stripe: process the event as before the guard.
              this.warn(`supersede check failed for ${entity_id}: ${e8.message}`);
            }
          }
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
            // checkout.session.completed carries the SESSION in obj, whose
            // status is 'complete' — a session status, not a subscription one.
            // subscription_new.status is a strict-mode ENUM of SUBSCRIPTION
            // statuses, so mirroring 'complete' raised 1265 Data truncated on
            // the shared yp handle and killed the CONCURRENT invoice.paid
            // handler mid-flight — before its payment receipt email — which is
            // why a Pro→Team upgrade paid fine but never emailed. A completed
            // session means the subscription is live: mirror 'active'.
            // For a checkout SESSION prefer the retrieved subscription's real
            // status over a hardcoded 'active': a deferred cycle switch
            // creates the new subscription TRIALING (it starts billing when
            // the old cycle lapses), and stamping 'active' here erased that —
            // the UI could not tell "running now" from "starts later"
            // (tester 2026-07-30: banner said "renews" for a plan that had
            // not started). `sub_status` is resolved below alongside items.
            let status = obj.cancel_at_period_end ? 'canceled'
              : (obj.object === 'checkout.session' ? 'active' : (obj.status || 'active'));
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
                // Real subscription status for the session event (see the
                // status declaration above). trial_end doubles as period_end
                // for a trialing sub: it IS the date the new cycle starts.
                if (obj.object === 'checkout.session' && s.status && !obj.cancel_at_period_end) {
                  status = s.status;
                  if (s.status === 'trialing' && s.trial_end) period_end = s.trial_end;
                }
              } catch (e3) { items = []; }
            }
            // SUPERSEDE, same entity. A subscriber who deliberately changed
            // plan through checkout (payment.checkout with supersede=1) now has
            // a SECOND Stripe subscription on the same customer: the mirror row
            // is keyed UNIQUE(entity_id), so the upsert below would point at
            // the new one while the old kept charging, unseen. Cancel it here,
            // once the new subscription is confirmed paid.
            //
            // The pre-existing supersede helpers only cover a change of entity
            // kind (personal <-> org); this covers the same entity moving
            // between plans, which is the common case (Team <-> Business).
            //
            // Immediate cancel, not at period end: the user was warned they
            // lose the current plan, and leaving it running to its date is the
            // double charge this exists to prevent.
            // Only on the checkout event. All three of checkout.session.completed,
            // customer.subscription.created and invoice.paid land in this same
            // case and arrive together, so without this the cancel ran three
            // times over — one succeeding and two logging "No such
            // subscription" against an id already gone.
            if (subscription_id && md.supersede && event.type === 'checkout.session.completed') {
              try {
                // Ask Stripe which subscriptions the customer still holds
                // rather than reading our mirror. The mirror is upserted by the
                // sibling events of this same replacement, so by the time we
                // get here it may already name the NEW subscription — and then
                // the old one would never be cancelled and would keep charging.
                //
                // Scoped to this entity: one customer can carry both a personal
                // and an org subscription (see the personal supersede helper
                // above), and those must survive.
                // status 'all', then filter: a DEFERRED replacement (below)
                // leaves the new subscription 'trialing' until the old one
                // expires, and a later switch must be able to displace that
                // pending one too — listing only 'active' would miss it.
                const live = await stripe.subscriptions.list({
                  customer: customer_id, status: 'all', limit: 20,
                });
                const stale = (live.data || []).filter(
                  (s) => s.id !== subscription_id
                    && /^(active|trialing|past_due)$/.test(s.status)
                    && s.metadata && s.metadata.entity_id === entity_id,
                );
                // The customer scan cannot see a replaced subscription living
                // on a DIFFERENT customer — a TEAM bootstrap subscribes on a
                // payer-keyed customer (no org yet), the org's next checkout
                // on the org-keyed one. payment.checkout therefore names the
                // subscription it is replacing (metadata.supersede_target,
                // resolved from the mirror BEFORE the session was created, so
                // no webhook ordering can stale it). Add it if the scan
                // missed it and it is still alive.
                if (md.supersede_target && md.supersede_target !== subscription_id
                  && !stale.some((s) => s.id === md.supersede_target)) {
                  try {
                    const t = await stripe.subscriptions.retrieve(md.supersede_target);
                    if (t && /^(active|trialing|past_due)$/.test(t.status)) stale.push(t);
                  } catch (e9) { /* already gone — nothing to cancel */ }
                }
                for (const s of stale) {
                  if (md.defer) {
                    // Deferred cycle switch: the replaced subscription runs to
                    // the end the customer already paid for, then stops; the
                    // new one (created with trial_end = that same moment)
                    // starts charging right as it lapses. A pending
                    // replacement caught in `stale` is 'trialing' and has paid
                    // for nothing yet — cancel_at_period_end ends it at its
                    // trial end without ever charging.
                    await stripe.subscriptions.update(s.id, { cancel_at_period_end: true });
                    this.debug(`superseded subscription ${s.id} left to expire for ${entity_id}`);
                  } else {
                    await stripe.subscriptions.cancel(s.id);
                    this.debug(`superseded subscription ${s.id} cancelled for ${entity_id}`);
                  }
                }
              } catch (e6) {
                // Never fail the webhook over this — the new subscription is
                // paid and entitlement must still be applied. A leftover is
                // visible in Stripe and recoverable; a dropped event is not.
                this.error(`superseded cancel failed for ${entity_id}: ${e6.message}`);
              }
            }
            const { seats, price, extra_disk, extra_seats } = await this._itemsEntitlement(items);
            // The price on the subscription outranks the metadata: see
            // _planFromItems. Without this a Billing Portal price switch kept
            // applying the plan the caller left.
            const actual = await this._planFromItems(items);
            const eff_plan = (actual && actual.plan) || plan;
            const eff_period = (actual && actual.period) || period;
            const eff_entity = (actual && actual.entity_type) || entity_type;
            const seat_total = await this._seatTotal(eff_entity, eff_plan, eff_period, seats, extra_seats);
            // 0, not null: await_proc maps null -> '' which a strict-mode INT param rejects.
            // Mirror only with a real subscription id — the subscription.created/
            // updated events carry it when the session doesn't.
            if (subscription_id) {
              await this.yp.await_proc('subscription_update', entity_id, customer_id, subscription_id, eff_plan, eff_period, 1, price, 0, status);
            }
            await this.yp.await_proc('payment_apply_entitlement', entity_id, eff_plan, period_end, eff_entity, seat_total, extra_disk);
            // MKT outreach coupon: confirm the pending redemption once Checkout
            // completes so analytics can attribute email ↔ partner code. Only
            // on the session event (created/updated also land here).
            if (event.type === 'checkout.session.completed') {
              try {
                const session_id = obj.object === 'checkout.session' ? (obj.id || '') : '';
                const cust_email = (obj.customer_details && obj.customer_details.email)
                  || (obj.customer_email) || '';
                if (session_id || md.mkt_code || md.mkt_redemption_id) {
                  await this.yp.await_proc(
                    'mkt_coupon_confirm',
                    session_id,
                    subscription_id || '',
                    md.payer_id || '',
                    cust_email || '',
                  );
                }
              } catch (eMkt) {
                this.warn && this.warn(`mkt_coupon_confirm failed: ${eMkt.message}`);
              }
            }
            // Push the REAL status (canceled when cancel_at_period_end), not a
            // hardcoded 'active' — a pending cancel must reach the client so the
            // billing screen flips to "ends on {period_end}" in realtime. Carry
            // period_end so the FE can render the date without a refetch.
            await this.notify_user(entity_id, {
              service: 'payment.plan_updated', plan: eff_plan, status, period_end,
              quota: await this._freshQuota(md.payer_id, entity_id, eff_entity),
            });
            await this._evaluateOverLimit(entity_id, eff_entity);
            // Resume confirmation email (Figma 3050-96856): a pending cancel
            // flipping back to renewing. previous_attributes carries only the
            // changed fields, so cancel_at_period_end true→false IS the resume
            // signal — covers both the in-app Resume and the Billing Portal.
            // No new invoice is issued on resume; attach the latest one as the
            // receipt. A mail failure must never fail the webhook.
            //
            // payment.change_plan also clears cancel_at_period_end (switching
            // plan implies staying), so a plan change made from the
            // pending-cancel window trips this same signal. Its latest_invoice
            // is the PRORATION invoice, whose own invoice.paid already sends
            // "your plan is now X" — sending the resume receipt too would mail
            // two differently-worded receipts for one invoice, the first
            // announcing a plan the user never held. prev.items is present
            // exactly when the update also swapped the price, so it separates
            // a bare resume from a resume-by-plan-change.
            const prev = (event.data && event.data.previous_attributes) || {};
            if (event.type === 'customer.subscription.updated'
              && prev.cancel_at_period_end === true && !obj.cancel_at_period_end
              && !prev.items) {
              try {
                const invId = typeof obj.latest_invoice === 'string'
                  ? obj.latest_invoice : (obj.latest_invoice && obj.latest_invoice.id);
                if (invId) {
                  const invoice = await stripe.invoices.retrieve(invId);
                  const plan_label = plan.charAt(0).toUpperCase() + plan.slice(1);
                  await this._sendReceiptEmail(invoice, obj, md, {
                    seat_total,
                    heading: `Your Drumee ${plan_label} plan is resumed`,
                    subject: `Your Drumee ${plan_label} plan is resumed`,
                    intro: "Your subscription has been resumed. Here's your receipt, and what's new.",
                  });
                }
              } catch (e5) {
                this.error(`resume email failed for ${event.id}: ${e5.message}`);
              }
            }
          }
          break;
        }
        case 'customer.subscription.deleted': {
          let entity_id = md.entity_id;
          const etype = md.entity_type || 'user';
          // Bootstrap-era org subscriptions carry entity_id = payer uid in
          // their metadata (the org didn't exist at checkout) — resolve the
          // real org so the cancel clears the ORG entitlement row.
          if (etype === 'org' && md.payer_id) {
            const org = await this.yp.await_proc('payment_get_org', md.payer_id);
            if (org && org.id) entity_id = org.id;
          }
          if (entity_id) {
            // Is this the subscription the entity actually HOLDS, or one that
            // was replaced?
            //
            // A plan change through checkout cancels the old subscription the
            // moment the new one is paid, and Stripe then sends this event for
            // the OLD id. Acting on it destroys the entitlement the new,
            // already-paid subscription just established: subscription_remove
            // drops the mirror, and payment_clear_entitlement deletes the quota
            // row by payer_id alone with no subscription check. Live symptom —
            // an org paid $99 for Business and landed on free/5 GB.
            //
            // Ask STRIPE, not our own mirror. The mirror is written by the
            // sibling events of the replacement (subscription.created /
            // checkout.session.completed) and this deletion routinely overtakes
            // them — they arrive in the same second and each handler is several
            // awaits deep, so reading our own row here saw it empty and cleared
            // the entitlement anyway. Stripe knows what the customer holds
            // regardless of how far our writes have got.
            let superseded = false;
            if (stripe && obj.customer && obj.id) {
              try {
                // status 'all', then filter: on a deferred cycle switch the
                // replacement is still 'trialing' at the exact moment the old
                // subscription expires and this event fires — listing only
                // 'active' would miss it and clear the entitlement the
                // customer has already committed to.
                const live = await stripe.subscriptions.list({
                  customer: obj.customer, status: 'all', limit: 20,
                });
                // Scoped to this entity, like the cancel above: one customer
                // can carry both a personal and an org subscription, and a
                // genuine cancellation of one must not be waved off because
                // the other is still running.
                superseded = (live.data || []).some(
                  (x) => x.id !== obj.id
                    && /^(active|trialing|past_due)$/.test(x.status)
                    && x.metadata && x.metadata.entity_id === entity_id,
                );
              } catch (e7) {
                // Unreachable Stripe: fall through and clear, which is the
                // pre-existing behaviour for a genuine cancellation.
                this.warn(`supersede check failed for ${entity_id}: ${e7.message}`);
              }
            }
            // Second signal: the entity's mirror. The customer scan cannot see
            // a replacement on a DIFFERENT customer (TEAM bootstrap subs live
            // on a payer-keyed customer, the org's later checkouts on the
            // org-keyed one) — live case: cancelling the leftover bootstrap
            // sub cleared the Business entitlement the org had just paid for.
            // By the time WE cancel a superseded subscription its replacement
            // is paid and mirrored, so a mirror naming another id is a
            // replacement; the Stripe scan still covers the same-customer
            // race where the mirror write hasn't landed yet.
            if (!superseded) {
              try {
                const held = await this.yp.await_proc('payment_get_subscription', entity_id);
                const heldId = held && held.subscription_id;
                if (heldId && obj.id && heldId !== obj.id) superseded = true;
              } catch (e10) { /* keep the scan's verdict */ }
            }
            if (superseded) {
              this.debug(`ignoring deletion of superseded subscription ${obj.id}; ${entity_id} holds a newer one`);
              break;
            }
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
            await this.notify_user(entity_id, {
              service: 'payment.plan_updated', plan: 'free', status: 'canceled',
              quota: await this._freshQuota(md.payer_id, entity_id, etype),
            });
            await this._evaluateOverLimit(entity_id, etype);
          }
          break;
        }
        case 'invoice.paid':
        case 'invoice.payment_failed': {
          // Invoices don't carry the subscription metadata directly — resolve it.
          const subId = this._invoiceSubscriptionId(obj);
          let sub = null;
          if (subId) { try { sub = await stripe.subscriptions.retrieve(subId); } catch (e2) {} }
          const smd = (sub && sub.metadata) || {};
          // Bootstrap-era org subscriptions carry entity_id = payer uid —
          // resolve (and, on an early invoice.paid racing the session event,
          // provision) the real org before applying entitlement.
          const eid = await this._resolveOrgEntity(smd, stripe);
          if (eid) {
            // What the subscription is ACTUALLY on, from the price its items
            // carry rather than the metadata (see _planFromItems). Resolved
            // once here so the paid and failed branches describe the same plan.
            const inv_items = (sub && sub.items && sub.items.data) || [];
            const actual = await this._planFromItems(inv_items);
            const eff_plan = (actual && actual.plan) || smd.plan || 'team';
            const eff_period = (actual && actual.period) || smd.period || 'month';
            const eff_entity = (actual && actual.entity_type) || smd.entity_type || 'user';
            if (event.type === 'invoice.paid') {
              // Recurring renewal succeeded -> re-apply entitlement (bumps period_end).
              const items = inv_items;
              const pend = (sub && sub.current_period_end) || (items[0] && items[0].current_period_end) || 0;
              // Since the 2026-07 pricing rebuild every plan is flat and the
              // add-ons (pro_seat, storage_*) are retired, so in practice this
              // resolves to quantity 1 / no extra disk, and payment_apply_
              // entitlement ignores the seat total for org rows (quota.$.seat
              // is the plan's member cap, not a purchased quantity). Kept so a
              // subscription created under the old catalog still reduces
              // correctly on renewal.
              const { seats, extra_disk, extra_seats } = await this._itemsEntitlement(items);
              const seat_total = await this._seatTotal(eff_entity, eff_plan, eff_period, seats, extra_seats);
              await this.yp.await_proc('payment_apply_entitlement', eid, eff_plan, pend, eff_entity, seat_total, extra_disk);
              // Ledger, then signal. Both are best-effort: the entitlement above
              // is already applied and a 500 here would make Stripe redeliver
              // the whole event. A row missed this way is picked up by
              // analytics-server bin/revenue-reconcile.js, which is the reason
              // that job exists.
              try {
                const ledger = await this._ledgerRowFromInvoice(
                  obj, sub, smd, eid,
                  { plan: eff_plan, period: eff_period, entity_type: eff_entity },
                );
                await this.yp.await_proc('payment_ledger_upsert', ledger);
                pushRevenueLive(this, { plan: ledger.plan, paid_at: ledger.paid_at });
              } catch (eLedger) {
                this.error(`payment_ledger write failed for ${event.id}: ${eLedger.message}`);
              }
              await this.notify_user(eid, {
                service: 'payment.plan_updated', plan: eff_plan, status: 'active',
                quota: await this._freshQuota(md.payer_id, eid, eff_entity),
              });
              await this._evaluateOverLimit(eid, eff_entity);
              // Payment-receipt email (initial payment AND every renewal both
              // arrive as invoice.paid). A mail failure must never fail the
              // webhook — the entitlement above is already applied and Stripe
              // would re-deliver the whole event on a 500.
              //
              // A proration invoice (billing_reason 'subscription_update' —
              // payment.change_plan swapping Team <-> Business) is a plan
              // CHANGE, not a renewal: say so. The metadata is rewritten in
              // the same subscriptions.update, so plan_label already names
              // the NEW plan here.
              try {
                const changed = obj.billing_reason === 'subscription_update';
                const plan_label = String(eff_plan)
                  .replace(/^\w/, (c) => c.toUpperCase());
                // The receipt describes what they now have, so it reads the
                // effective plan too — otherwise a portal-side switch mailed a
                // 'plan is now X' naming the plan they just left.
                await this._sendReceiptEmail(obj, sub, { ...smd, plan: eff_plan, period: eff_period }, {
                  seat_total,
                  ...(changed ? {
                    heading: `Your Drumee plan is now ${plan_label}`,
                    subject: `Your Drumee plan is now ${plan_label}`,
                    intro: "Your plan change is confirmed. Here's your receipt, and what's included.",
                  } : {}),
                });
              } catch (e4) {
                this.error(`receipt email failed for ${event.id}: ${e4.message}`);
              }
            } else {
              // Payment failed -> keep entitlement during Stripe's smart retries
              // (grace); final failure downgrades via customer.subscription.deleted.
              await this.notify_user(eid, { service: 'payment.payment_failed', plan: eff_plan, status: 'past_due' });
              // Dunning email (retry notice / final warning). Mail failures log
              // only — a 500 here would make Stripe re-deliver the whole event.
              try {
                await this._sendDunningEmail(stripe, obj, sub, { ...smd, plan: eff_plan, period: eff_period });
              } catch (e5) {
                this.error(`dunning email failed for ${event.id}: ${e5.message}`);
              }
            }
          }
          break;
        }
        // A refund moves revenue as surely as a payment does. Stripe reports it
        // against the CHARGE, so the invoice has to be re-read: its
        // amount_paid is unchanged and only the charge knows what went back.
        //
        // NO NEW ROW. This goes through the same builder and the same upsert as
        // invoice.paid, keyed on the same invoice_id, so it can only ever
        // update the row the payment created.
        case 'charge.refunded': {
          const invId = typeof obj.invoice === 'string' ? obj.invoice : (obj.invoice && obj.invoice.id);
          // A charge with no invoice is not a subscription payment (a one-off
          // PaymentIntent). Nothing in the ledger corresponds to it.
          if (!invId) break;
          let invoice = null;
          try { invoice = await stripe.invoices.retrieve(invId); } catch (e7) { invoice = null; }
          if (!invoice) break;
          const rSubId = this._invoiceSubscriptionId(invoice);
          let rSub = null;
          if (rSubId) {
            try { rSub = await stripe.subscriptions.retrieve(rSubId); } catch (e7) {
              this.warn(`refund subscription retrieve failed for ${event.id}: ${e7.message}`);
            }
          }
          const rmd = (rSub && rSub.metadata) || {};
          // Unlike invoice.paid, nothing but a ledger row is at stake here —
          // there is no entitlement to grant, so a throw buys nothing but an
          // infinite Stripe redelivery loop (the outer catch below deletes
          // the 'seen' row on any escape and returns 500). invoice.paid lets
          // the same calls throw on purpose: a payment must not go
          // ungranted, and redelivery is how that retries. A refund has no
          // such urgency, and any row this path misses is picked up by
          // analytics-server's revenue-reconcile job — so log and break
          // instead of propagating.
          let rEid = null;
          try { rEid = await this._resolveOrgEntity(rmd, stripe); } catch (e7b) {
            this.error(`refund entity resolve failed for ${event.id}: ${e7b.message}`);
          }
          if (!rEid) break;
          const rItems = (rSub && rSub.items && rSub.items.data) || [];
          let rActual = null;
          try { rActual = await this._planFromItems(rItems); } catch (e7c) {
            this.warn(`refund plan resolve failed for ${event.id}: ${e7c.message}`);
          }
          const row = await this._ledgerRowFromInvoice(invoice, rSub, rmd, rEid, {
            plan: (rActual && rActual.plan) || rmd.plan || 'team',
            period: (rActual && rActual.period) || rmd.period || 'month',
            entity_type: (rActual && rActual.entity_type) || rmd.entity_type || 'user',
          });
          // The CHARGE is authoritative on what was refunded; the invoice's
          // credit-note total covers the other way money comes back. Take the
          // larger rather than adding them — a credit note raised to settle a
          // refund would otherwise be counted twice and drive net negative.
          row.amount_refunded = Math.max(
            ~~obj.amount_refunded,
            ~~invoice.post_payment_credit_notes_amount,
          );
          try {
            await this.yp.await_proc('payment_ledger_upsert', row);
            pushRevenueLive(this, { plan: row.plan, paid_at: row.paid_at });
          } catch (eRef) {
            this.error(`payment_ledger refund write failed for ${event.id}: ${eRef.message}`);
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
