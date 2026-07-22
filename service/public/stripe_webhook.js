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
    const plan = (smd.plan || 'pro').toLowerCase();
    const plan_label = plan.charAt(0).toUpperCase() + plan.slice(1);
    const cycle_label = (smd.period || 'month') === 'year' ? 'billed yearly' : 'billed monthly';
    const currency = invoice.currency || 'eur';
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
          let entity_id = md.entity_id;
          const plan = md.plan || 'pro';
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
            const status = obj.cancel_at_period_end ? 'canceled'
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
            // Resume confirmation email (Figma 3050-96856): a pending cancel
            // flipping back to renewing. previous_attributes carries only the
            // changed fields, so cancel_at_period_end true→false IS the resume
            // signal — covers both the in-app Resume and the Billing Portal.
            // No new invoice is issued on resume; attach the latest one as the
            // receipt. A mail failure must never fail the webhook.
            const prev = (event.data && event.data.previous_attributes) || {};
            if (event.type === 'customer.subscription.updated'
              && prev.cancel_at_period_end === true && !obj.cancel_at_period_end) {
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
          // Bootstrap-era org subscriptions carry entity_id = payer uid —
          // resolve (and, on an early invoice.paid racing the session event,
          // provision) the real org before applying entitlement.
          const eid = await this._resolveOrgEntity(smd, stripe);
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
              // Dunning email (retry notice / final warning). Mail failures log
              // only — a 500 here would make Stripe re-deliver the whole event.
              try {
                await this._sendDunningEmail(stripe, obj, sub, smd);
              } catch (e5) {
                this.error(`dunning email failed for ${event.id}: ${e5.message}`);
              }
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
