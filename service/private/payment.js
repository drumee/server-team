// service/private/payment.js
const { Entity } = require('@drumee/server-core');
const { stripeClient } = require('../lib/stripe');

// Billing currency for every catalog / plan lookup. The 2026-07 pricing
// rebuild moved the catalog to USD; the old EUR rows are deactivated in
// yp.plan (a Stripe price's currency cannot be changed, so they are separate
// rows). Lookups pass this explicitly, so it must match the active rows.
const CURRENCY = 'usd';

class __private_payment extends Entity {
  // Lazy Stripe client. catalog()/subscription_status() are DB-only and MUST
  // work even when Stripe isn't configured yet (no stripe_skey in sys_conf).
  _stripe() {
    if (this.__stripe) return this.__stripe;
    this.__stripe = stripeClient(); // throws STRIPE_KEY_MISSING if unconfigured
    return this.__stripe;
  }

  // Priced catalog from yp.plan. Enriched with the live Stripe unit amount when
  // a price id + key exist, so the FE can display the authoritative price.
  // Returns every active row so the billing UI stays catalog-driven rather
  // than hardcoding amounts. Since the 2026-07 rebuild that is free + team +
  // business; the B2C Pro tier and its add-ons are deactivated in yp.plan.
  async catalog() {
    const rows = (await this.yp.await_proc('payment_get_catalog', CURRENCY, '')) || [];
    const plans = Array.isArray(rows) ? rows : [rows];
    let stripe = null;
    try { stripe = this._stripe(); } catch (e) { stripe = null; }
    if (stripe) {
      for (const p of plans) {
        if (!p || !p.stripe_price_id) continue;
        try {
          const price = await stripe.prices.retrieve(p.stripe_price_id);
          p.amount = price.unit_amount;            // minor units (cents)
          p.currency = price.currency || p.currency;
        } catch (e) { /* leave amount unset on lookup failure */ }
      }
    }
    this.output.data({ plans });
  }

  // ── TEAM org bootstrap ────────────────────────────────────────────────
  // The subdomain (org ident) is collected BEFORE Stripe Checkout (product
  // decision 2026-07-17) and threaded through the session metadata; the
  // webhook provisions the organisation atomically (yp org_provision) on
  // checkout.session.completed. These helpers validate the ident up-front.

  // Shared validation for the org ident (subdomain label).
  async _validateOrgIdent(ident) {
    ident = String(ident || '').trim().toLowerCase();
    // DNS label: 2-63 chars, a-z 0-9 hyphen, no leading/trailing hyphen.
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])$/.test(ident)) {
      return { status: 'IDENT_INVALID', ident };
    }
    // Move-semantics membership: a payer already inside another domain
    // cannot bootstrap a second organisation.
    if (~~this.user.domain_id() > 1) {
      return { status: 'ALREADY_IN_OTHER_DOMAIN', ident };
    }
    let taken = await this.yp.await_proc('ident_exists', ident);
    if (Array.isArray(taken) ? taken.length : (taken && taken.id)) {
      return { status: 'IDENT_NOT_AVAILABLE', ident };
    }
    // The org URL is `${ident}.${main_domain()}` (domain_create convention) —
    // reject when the fqdn or domain row already exists.
    // COLLATE utf8mb4_general_ci on both CONCATs: the bound `?` parameter
    // gives the expression a "NONE" collation derivation (driver binds it
    // without the connection's collation), which clashes with vhost.fqdn /
    // domain.name's column collation (utf8mb4_general_ci, "IMPLICIT") on
    // comparison — ER_CANT_AGGREGATE_2COLLATIONS (1267), confirmed live on
    // prod 2026-07-23. Forcing the expression's collation resolves it.
    let rows = await this.yp.await_query(
      `SELECT (SELECT COUNT(*) FROM vhost  WHERE fqdn = CONCAT(?, '.', main_domain()) COLLATE utf8mb4_general_ci)
            + (SELECT COUNT(*) FROM domain WHERE name = CONCAT(?, '.', main_domain()) COLLATE utf8mb4_general_ci) AS c`,
      ident, ident
    );
    if (Array.isArray(rows)) rows = rows[0];
    if (rows && ~~rows.c > 0) {
      return { status: 'IDENT_NOT_AVAILABLE', ident };
    }
    let fqdn = await this.yp.await_query(
      `SELECT CONCAT(?, '.', main_domain()) AS fqdn`, ident
    );
    if (Array.isArray(fqdn)) fqdn = fqdn[0];
    return { status: 'OK', ident, fqdn: fqdn && fqdn.fqdn };
  }

  // Pre-checkout validation endpoint for the FE subdomain step.
  async validate_org_ident() {
    const ident = this.input.need('ident');
    const res = await this._validateOrgIdent(ident);
    this.output.data(res);
  }

  // Hosted Checkout. entity_type 'user' (individual Free->Pro) or 'org' (team,
  // flat: Stripe quantity is always 1, customer = the org the caller owns).
  async checkout() {
    let stripe;
    try { stripe = this._stripe(); }
    catch (e) { return this.output.data({ status: 'STRIPE_NOT_CONFIGURED' }); }
    // entity_type decides which branch of this method runs, so it must be a
    // closed set. It used to be a free string compared with === 'org', which
    // meant 'ORG', 'Org', 'organization', 'org ' or a typo all fell silently
    // into the PERSONAL branch — skipping the org ident requirement, the
    // move-semantics guard and the owner check — while payment_get_plan
    // happily returned the org-only Team price. The caller was charged $29 for
    // a plan they could not receive. Reject the value instead of guessing.
    const entity_type = String(this.input.use('entity_type', 'user')).trim().toLowerCase();
    if (entity_type !== 'user' && entity_type !== 'org') {
      return this.output.data({ status: 'ENTITY_TYPE_INVALID', entity_type });
    }
    const period = this.input.need('period');           // 'month' | 'year'

    let plan, entity_id, email, name, existing_customer;
    let org_bootstrap = null;
    if (entity_type === 'org') {
      plan = this.input.use('plan', 'team');
      const org = await this.yp.await_proc('payment_get_org', this.uid);
      if (org && org.id) {
        entity_id = org.id; name = org.name; existing_customer = org.customer_id;
      } else {
        // TEAM bootstrap: no organisation yet — the FE collected the
        // subdomain; validate it now, thread it through the session
        // metadata and let the webhook provision atomically after payment.
        const ident = this.input.use('ident', '');
        const org_name = this.input.use('org_name', '') || this.input.use('name', '');
        if (!ident || !org_name) {
          return this.output.data({ status: 'ORG_IDENT_REQUIRED' });
        }
        const v = await this._validateOrgIdent(ident);
        if (v.status !== 'OK') return this.output.data(v);
        org_bootstrap = { ident: v.ident, org_name: String(org_name).trim() };
        // Stripe customer keyed by the PAYER while the org doesn't exist yet.
        entity_id = this.uid;
        const payer = await this.yp.await_proc('payment_get_payer', this.uid);
        email = payer && payer.email; name = org_bootstrap.org_name;
        existing_customer = payer && payer.customer_id;
      }
    } else {
      plan = this.input.use('plan', 'team');
      entity_id = this.uid;
      const payer = await this.yp.await_proc('payment_get_payer', this.uid);
      email = payer && payer.email; name = payer && payer.fullname; existing_customer = payer && payer.customer_id;
    }

    const plan_row = await this.yp.await_proc('payment_get_plan', plan, period, CURRENCY);
    if (!plan_row || !plan_row.stripe_price_id) {
      return this.output.data({ status: 'NO_PRICE' });
    }
    // payment_get_plan matches on plan_code + period + currency only — it has
    // no entity_type filter — so asking for an ORG plan as a 'user' returns the
    // org price and bills for it. The entitlement side then looks the plan up
    // WITH entity_type, finds nothing, and falls back to a bare 20 GB personal
    // grant: money taken, wrong product delivered. Refuse the mismatch here.
    if (plan_row.entity_type && plan_row.entity_type !== entity_type) {
      return this.output.data({
        status: 'PLAN_ENTITY_MISMATCH', plan, entity_type, expected: plan_row.entity_type,
      });
    }
    // ensure a Stripe customer keyed by metadata.id = entity_id (idempotent)
    let customer_id = existing_customer;
    if (!customer_id) {
      const found = await stripe.customers.search({ query: `metadata['id']:'${entity_id}'` });
      customer_id = (found.data[0] && found.data[0].id) || null;
    }
    if (!customer_id) {
      const created = await stripe.customers.create({ email, name, metadata: { id: entity_id } });
      customer_id = created.id;
    }
    // One line item, quantity 1. Every plan is FLAT since the 2026-07 pricing
    // rebuild: Team is $29 for 100 GB and up to 10 members, not $x per seat, so
    // the subscription quantity no longer carries the seat count — sending
    // `seats` here would multiply the bill. The per-seat add-on (pro_seat) and
    // the storage bundles (storage_*) are retired with the B2C Pro tier and
    // deactivated in yp.plan, so there are no extra lines to add.
    const line_items = [{ price: plan_row.stripe_price_id, quantity: 1 }];
    // Build the return URLs from homepath (host-derived, endpoint-aware).
    // servicepath() resolves the endpoint segment to 'undefined' on dev
    // endpoints (/-/undefined/svc/...), which broke the post-payment redirect.
    const svcbase = this.input.homepath().replace(/\/+$/, '') + '/svc/?service=';
    const success_url = `${svcbase}callback.check_out_success&session_id={CHECKOUT_SESSION_ID}`;
    const cancel_url = `${svcbase}callback.check_out_cancel`;
    // payer_id always travels with the subscription so the webhook can
    // resolve/provision the organisation regardless of which event arrives
    // first; org_ident/org_name are present only on the TEAM bootstrap.
    const metadata = { entity_type, entity_id, plan, period, payer_id: this.uid };
    // Team→Pro switch: the FE flags a personal checkout that supersedes the
    // caller's ORG subscription (confirmed by the user in the switch popup).
    // Threaded through the session metadata; the webhook cancels the org's
    // Team sub at period end once THIS payment completes. Only honoured for
    // personal (user) checkouts — an org checkout cancels the personal sub
    // through _cancelSupersededPersonalSubscription instead.
    if (entity_type === 'user' && this.input.use('supersede', '') === 'org') {
      metadata.supersede = 'org';
    }
    if (org_bootstrap) {
      metadata.org_ident = org_bootstrap.ident;
      metadata.org_name = org_bootstrap.org_name;
    }
    const create = (cust) => stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: cust,
      line_items,
      subscription_data: { metadata },
      metadata,
      success_url,
      cancel_url,
    });

    let session;
    try {
      session = await create(customer_id);
    } catch (e) {
      // "You cannot combine currencies on a single customer."
      //
      // The 2026-07 rebuild moved the catalog from EUR to USD, and Stripe pins
      // a customer to the currency of its first subscription or open Checkout
      // session. Every customer created under the old catalog therefore CANNOT
      // start a USD checkout — it fails with a 400 that surfaced to the client
      // as a bare SERVICE_FAILED. A customer record carries no value we need to
      // preserve here (invoices and payment history stay on the old record and
      // remain visible in Stripe), so the recovery is simply to mint a fresh
      // one for this entity and retry once.
      const clash = /combine currencies/i.test(e?.message || '');
      if (!clash) {
        this.warn?.('payment.checkout failed', e?.message);
        return this.output.data({ status: 'CHECKOUT_FAILED', reason: e?.message || '' });
      }
      const fresh = await stripe.customers.create({
        email, name, metadata: { id: entity_id },
      });
      customer_id = fresh.id;
      session = await create(customer_id);
    }
    this.output.data({ url: session.url, id: session.id });
  }

  // Subscription mirror row for the caller. The webhook keys org (team)
  // subscriptions by the ORGANISATION id, so when the personal row is empty
  // fall back to the org the caller owns — org owners see their team sub.
  async _subscription_row() {
    // Tenant-first: the ORG subscription outranks a leftover personal one —
    // a pro→team upgrader owns both for a while, and the plan they're ON is
    // the tenant's (the Billing page otherwise kept showing 'pro' after a
    // successful TEAM upgrade). Mirrors the quota cascade fix in
    // disk_limit/my_disk_limit/get_quota.
    const org = await this.yp.await_proc('payment_get_org', this.uid);
    if (org && org.id) {
      const orgRow = await this.yp.await_proc('payment_get_subscription', org.id);
      if (orgRow && orgRow.subscription_id) {
        orgRow.entity_type = 'org';
        orgRow.org_name = org.name;
        return orgRow;
      }
    }
    const row = await this.yp.await_proc('payment_get_subscription', this.uid);
    return row || {};
  }

  async subscription_status() {
    const row = await this._subscription_row();
    // Whether THIS caller can actually reach checkout, decided by the same two
    // rules checkout() enforces — so the client stops having to guess.
    //
    // It was guessing with domainCan(owner), the DOMAIN permission bit, while
    // the server resolves the payer through organisation.owner_id. Those are
    // different things: a member can hold `owner` on the domain and still not
    // be the owner_id row. Such a caller saw live CTAs and only found out at
    // the pay step, where checkout answers ORG_IDENT_REQUIRED (payment_get_org
    // matched nothing they own) or ALREADY_IN_OTHER_DOMAIN (the move-semantics
    // guard refuses a second org). Only the server can settle this, so it says
    // so here.
    const org = await this.yp.await_proc('payment_get_org', this.uid);
    const is_personal = ~~this.user.domain_id() <= 1; // can bootstrap an org
    const owns_org = !!org?.id;                        // can pay for their own
    row.can_buy = is_personal || owns_org;
    if (!row.can_buy) row.buy_blocked = 'NOT_ORG_OWNER';
    this.output.data(row);
  }

  // Stripe Billing Portal: one hosted surface for invoice history, cancel/resume,
  // card update + proration. Requires a Stripe customer (set by the webhook mirror).
  async portal() {
    let stripe;
    try { stripe = this._stripe(); }
    catch (e) { return this.output.data({ status: 'STRIPE_NOT_CONFIGURED' }); }
    const sub = await this._subscription_row();
    const customer_id = sub && sub.customer_id;
    if (!customer_id) return this.output.data({ status: 'NO_CUSTOMER' });
    // Return through a same-origin /svc bounce (callback.portal_return), not
    // straight at the desk: the session cookie is SameSite=Strict and is
    // withheld on the first request of the cross-site return from Stripe, so a
    // direct return lands the SPA as a guest → apparent logout. The bounce
    // makes the final desk navigation same-site, so the cookie is sent. Same
    // pattern as the checkout success/cancel URLs above.
    const return_url = this.input.homepath().replace(/\/+$/, '') + '/svc/?service=callback.portal_return';
    const session = await stripe.billingPortal.sessions.create({
      customer: customer_id,
      return_url,
    });
    this.output.data({ url: session.url });
  }

  // Native in-app cancel: schedule the subscription to end at the current
  // period end (Stripe cancel_at_period_end=true). The user keeps the paid tier
  // until period_end; the customer.subscription.updated webhook mirrors
  // status='canceled', and the entitlement is dropped only by the final
  // customer.subscription.deleted. Returns the live status + period_end so the
  // FE flips to "ends on {date}" immediately, without waiting on the webhook.
  // _subscription_row() is caller-scoped (own sub, or the org this owner owns),
  // so a member can never cancel someone else's / a team they don't own.
  async cancel_subscription() {
    let stripe;
    try { stripe = this._stripe(); }
    catch (e) { return this.output.data({ status: 'STRIPE_NOT_CONFIGURED' }); }
    const sub = await this._subscription_row();
    const subscription_id = sub && sub.subscription_id;
    if (!subscription_id) return this.output.data({ status: 'NO_SUBSCRIPTION' });
    let s;
    try {
      s = await stripe.subscriptions.update(subscription_id, { cancel_at_period_end: true });
    } catch (e) {
      return this.output.data({ status: 'CANCEL_FAILED', error: e && e.message });
    }
    const items = (s.items && s.items.data) || [];
    this.output.data({
      status: 'canceled',
      cancel_at_period_end: true,
      period_end: s.current_period_end || (items[0] && items[0].current_period_end) || (sub && sub.period_end) || 0,
    });
  }

  // Undo a scheduled cancellation (Stripe cancel_at_period_end=false) — the
  // subscription resumes normal renewal. The webhook re-mirrors status='active'.
  async resume_subscription() {
    let stripe;
    try { stripe = this._stripe(); }
    catch (e) { return this.output.data({ status: 'STRIPE_NOT_CONFIGURED' }); }
    const sub = await this._subscription_row();
    const subscription_id = sub && sub.subscription_id;
    if (!subscription_id) return this.output.data({ status: 'NO_SUBSCRIPTION' });
    let s;
    try {
      s = await stripe.subscriptions.update(subscription_id, { cancel_at_period_end: false });
    } catch (e) {
      return this.output.data({ status: 'RESUME_FAILED', error: e && e.message });
    }
    const items = (s.items && s.items.data) || [];
    this.output.data({
      status: s.status || 'active',
      cancel_at_period_end: false,
      period_end: s.current_period_end || (items[0] && items[0].current_period_end) || (sub && sub.period_end) || 0,
    });
  }

  // Post-Checkout receipt details for the success/failure modal: total paid,
  // invoice number, payment date and card brand/last4, straight from the
  // Checkout Session the browser was redirected back with.
  async checkout_result() {
    let stripe;
    try { stripe = this._stripe(); }
    catch (e) { return this.output.data({ status: 'STRIPE_NOT_CONFIGURED' }); }
    const session_id = this.input.need('session_id');
    let session;
    try {
      session = await stripe.checkout.sessions.retrieve(session_id, {
        expand: ['invoice', 'subscription'],
      });
    } catch (e) {
      return this.output.data({ status: 'SESSION_NOT_FOUND' });
    }
    // The session must belong to the caller (their personal or org customer).
    const sub = await this._subscription_row();
    const md = session.metadata || {};
    const owns = (md.entity_id === this.uid) || (sub && sub.customer_id && sub.customer_id === session.customer);
    if (!owns) {
      const org = await this.yp.await_proc('payment_get_org', this.uid);
      if (!(org && org.id && md.entity_id === org.id)) {
        return this.output.data({ status: 'SESSION_NOT_FOUND' });
      }
    }
    const inv = (session.invoice && typeof session.invoice === 'object') ? session.invoice : null;
    let card_brand = null, card_last4 = null;
    try {
      const piId = inv && (typeof inv.payment_intent === 'string' ? inv.payment_intent : inv.payment_intent && inv.payment_intent.id);
      if (piId) {
        const pi = await stripe.paymentIntents.retrieve(piId, { expand: ['payment_method'] });
        const pm = pi && pi.payment_method;
        if (pm && pm.card) { card_brand = pm.card.brand; card_last4 = pm.card.last4; }
      }
    } catch (e) { /* card details are cosmetic — leave unset */ }
    this.output.data({
      status: session.status,                          // complete | open | expired
      payment_status: session.payment_status,          // paid | unpaid | no_payment_required
      plan: md.plan || null,
      period: md.period || null,
      entity_type: md.entity_type || 'user',
      amount_total: session.amount_total,              // minor units
      currency: session.currency,
      invoice_number: inv && inv.number,
      paid_at: (inv && inv.status_transitions && inv.status_transitions.paid_at) || session.created,
      card_brand,
      card_last4,
    });
  }
}

module.exports = __private_payment;
