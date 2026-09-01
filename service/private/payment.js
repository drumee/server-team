// service/private/payment.js
const { Entity } = require('@drumee/server-core');
const { stripeClient } = require('../lib/stripe');
// Shared with promo.js's direct redeem — see lib/mkt-coupon for why the
// hold TTL must be one value across both.
const { COUPON_HOLD_TTL_SEC } = require('../lib/mkt-coupon');

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

  _row(res) {
    return Array.isArray(res) ? res[0] : res;
  }

  // Lazily create (or reuse) the Stripe Coupon for an MKT outreach code.
  // percent_off=0 → no Stripe coupon (free-months / warm_trial use trial_end only).
  // trial_days is applied separately via subscription_data.trial_end.
  async _ensureStripeCoupon(row) {
    const percent = parseInt(row && row.percent_off, 10) || 0;
    if (percent <= 0) return null;
    if (row && row.stripe_coupon_id) return row.stripe_coupon_id;
    const stripe = this._stripe();
    const code = String((row && row.code) || '').toUpperCase();
    const months = parseInt(row && row.duration_months, 10) || 0;
    const id = `mkt_${code.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`.slice(0, 40);
    const payload = {
      id,
      percent_off: percent,
      name: `MKT ${code}`,
      metadata: {
        mkt_code: code,
        partner: (row && row.partner) || '',
        kind: (row && row.kind) || '',
      },
    };
    // duration_months=0 → one-shot invoice discount; else repeating N cycles.
    if (months > 0) {
      payload.duration = 'repeating';
      payload.duration_in_months = months;
    } else {
      payload.duration = 'once';
    }
    let created;
    try {
      created = await stripe.coupons.create(payload);
    } catch (e) {
      // Idempotent: a previous checkout may have created the Stripe coupon
      // before YP got the id written (or the write failed).
      if (/already exists/i.test((e && e.message) || '')) {
        created = await stripe.coupons.retrieve(id);
      } else {
        throw e;
      }
    }
    if (row && row.coupon_id && created && created.id) {
      await this.yp.await_proc('mkt_coupon_set_stripe_id', row.coupon_id, created.id);
    }
    return created.id;
  }

  // Resolve free period length from coupon kind.
  // warm_trial / free_months: prefer trial_days; else duration_months × 30.
  _promoTrialDays(row) {
    const kind = String((row && row.kind) || '');
    let td = parseInt(row && row.trial_days, 10) || 0;
    const months = parseInt(row && row.duration_months, 10) || 0;
    if (td <= 0 && (kind === 'warm_trial' || kind === 'free_months') && months > 0) {
      td = months * 30;
    }
    return td;
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

  /**
   * Price an "Apply" click on the checkout promo field, without spending
   * the code. mkt_coupon_validate runs the same checks as
   * mkt_coupon_reserve but writes nothing, so a shopper can try a code,
   * see the discounted total, and change their mind — reserving here
   * would burn a redemption (and, with max_redemptions, someone else's
   * slot) for a purchase that may never happen.
   *
   * Returns the offer's shape, NOT a price: the amount is the catalog's
   * and the client already renders it, so the discount is applied there
   * against the same figures the summary is built from. The authoritative
   * application still happens in checkout(); this is a preview only.
   */
  async preview_coupon() {
    const code = String(
      this.input.use('promo_code', '') || this.input.use('coupon_code', '') || '',
    ).trim();
    if (!code) return this.output.data({ status: 'COUPON_INVALID' });

    const plan = String(this.input.use('plan', 'team')).trim().toLowerCase();
    // Same outer gate as checkout: any self-serve paid tier. Pro (personal,
    // 2026-08-03 revival) is couponable like the org tiers — the discount is
    // applied to the Stripe subscription the same way regardless of holder.
    if (!/^(pro|team|business)$/.test(plan)) {
      return this.output.data({ status: 'COUPON_PLAN_UNSUPPORTED', plan });
    }

    // Keyed by email exactly like reserve, or the "1 email = 1 live deal"
    // rule would pass here and fail at purchase.
    const payer = await this.yp.await_proc('payment_get_payer', this.uid);
    const email = (payer && payer.email) || '';
    if (!email) return this.output.data({ status: 'COUPON_EMAIL_REQUIRED' });

    const row = this._row(
      await this.yp.await_proc(
        'mkt_coupon_validate', code, email, plan, COUPON_HOLD_TTL_SEC,
      ),
    );
    if (!row || row.error) {
      return this.output.data({
        status: (row && row.error) || 'COUPON_INVALID',
        code: row && row.code,
        email: row && row.email,
        plan_scope: row && row.plan_scope,
        requested_plan: row && row.requested_plan,
      });
    }

    const percent_off = parseInt(row.percent_off, 10) || 0;
    const trial_days = this._promoTrialDays(row);
    // Mirrors checkout's own refusal: a code with neither a discount nor a
    // free period would render as "applied" and change nothing.
    if (!percent_off && !trial_days) {
      return this.output.data({ status: 'OFFER_INVALID', code: row.code });
    }

    this.output.data({
      status: 'OK',
      code: row.code,
      partner: row.partner || '',
      kind: row.kind || '',
      plan_scope: row.plan_scope || 'all',
      percent_off,
      trial_days,
      // 0 = Stripe duration 'once' (single invoice), else N billing cycles.
      duration_months: parseInt(row.duration_months, 10) || 0,
    });
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

    // Already paying? Then there is nothing to sell here. Stripe happily
    // creates a SECOND subscription on the same customer, and the webhook
    // would overwrite entitlement/period_end with the new one while the old
    // one keeps charging -- the caller is billed twice for one plan. The UI
    // gates its plan cards on the current plan, but the checkout TAB (and any
    // deep link, or a stale bundle) reaches this endpoint directly, so the
    // refusal has to live here.
    //
    // "Live" is not the same as "active". A subscription in the PENDING-CANCEL
    // window mirrors as status 'canceled' with a future period_end, but at
    // Stripe it is still an active subscription carrying
    // cancel_at_period_end -- buying now would run two paid subscriptions side
    // by side just as surely. That caller resumes instead. Only once the paid
    // period has actually lapsed (or the mirror row is gone) may they buy.
    //
    // past_due is live too. Stripe keeps retrying that invoice for weeks and
    // only then deletes the subscription, so a caller in dunning who is offered
    // checkout ends up paying for BOTH once their card recovers. They fix the
    // card in the Billing Portal, or switch plan in place (change_plan accepts
    // past_due for exactly this reason) -- they do not buy a second one.
    //
    // Cycle changes (month <-> year) are a subscription UPDATE, not a new
    // checkout, so they get their own status rather than a generic failure.
    //
    // A subscription held by the OTHER kind of entity cannot be served by an
    // in-place update — change_plan refuses it with PLAN_ENTITY_MISMATCH
    // because the plan is not sold to that entity kind. The working path is a
    // supersede CHECKOUT, which the webhook knows how to finish: it cancels
    // the superseded subscription once the new one is paid
    // (_cancelSupersededPersonalSubscription / metadata.supersede /
    // metadata.supersede_target). But it must carry the supersede flag —
    // without it the webhook cancels nothing and the caller simply pays for a
    // second, invisible plan. So a cross-entity checkout WITHOUT supersede is
    // refused below with USE_SUBSCRIPTION_UPDATE (the FE's warning + confirm
    // flow), same as a same-entity switch; only the confirmed retry proceeds.
    //
    // That cancel does NOT disturb the org it just paid for. yp.quota is keyed
    // UNIQUE(domain_id, payer_id) — a composite, verified against the deployed
    // schema, not the unshipped tables/quota.sql which claims domain_id alone —
    // so the org row (org_domain, org_id) and the payer's own
    // (org_domain, payer_uid) coexist. The customer.subscription.deleted for
    // the superseded personal subscription writes the payer's row, and the
    // tenant-first cascade in disk_limit/get_quota resolves the org row ahead
    // of it for every member, the payer included.
    const current = await this._subscription_row();
    const now = Math.floor(Date.now() / 1000);
    const status = String((current && current.status) || '');
    const pending_cancel = status === 'canceled' && ~~(current && current.period_end) > now;
    const live = /^(active|trialing|past_due)$/.test(status) || pending_cancel;
    const holder = current && current.entity_type === 'org' ? 'org' : 'user';
    // `supersede` is the caller saying, explicitly and after a warning, that
    // they want to replace the plan they hold rather than be told they already
    // have one. The refusals below exist to stop an ACCIDENTAL second
    // subscription; they must not stand in the way of a deliberate change.
    //
    // This is safe only because the webhook finishes the job: on
    // checkout.session.completed it cancels the entity's previous subscription
    // as soon as the new one is paid, so the two never bill in parallel. Do not
    // relax this guard without that half in place.
    const supersede = !!this.input.use('supersede', '');
    // A same-plan cycle switch used to be DEFERRED here: the new subscription
    // idled on a Stripe trial_end until the current one expired, so nothing
    // was charged on the day. Product moved it back to charging at checkout
    // like every other plan change, and the deferral had cost more than it
    // bought — Checkout can only express "no charge now" as a trial, which
    // Stripe renders as "N days free" under a "Start trial" button (fixed
    // copy, unrewordable) and settles with a $0 invoice that read as a failed
    // purchase. Nothing sets trial_end for a cycle switch now; the only
    // remaining source is an MKT promo's free days, below.
    let trial_end = 0;
    if (current?.subscription_id && live && !supersede) {
      let refusal;
      if (holder !== entity_type) {
        // CROSS-ENTITY without the supersede confirmation. The exception in
        // the comment above exists so a deliberate kind change (personal pro
        // <-> org plan) has a working path — but it must still be DELIBERATE.
        // Left open, this sold an org owner a personal Pro with no warning:
        // Stripe charged the $5, the org subscription kept running (the
        // webhook only cancels a replaced subscription when metadata.supersede
        // is present), and the org's plan row outranks the payer's, so the
        // UI still said Business — money taken, nothing changed (live case,
        // prod 2026-08-06). USE_SUBSCRIPTION_UPDATE routes the FE into the
        // same warning + supersede flow it already runs for same-entity
        // switches; the confirmed retry passes the guard via `supersede`.
        refusal = 'USE_SUBSCRIPTION_UPDATE';
      } else {
        const same_plan = String(current.plan || '') === String(this.input.use('plan', 'team'));
        if (pending_cancel) refusal = 'PENDING_CANCEL_RESUME_INSTEAD';
        // A caller in dunning is trying to fix a failed payment, not to shop.
        // "You're already subscribed" is true but unhelpful there — give the
        // state its own status so the client can point at the card instead.
        else if (status === 'past_due') refusal = 'SUBSCRIPTION_PAST_DUE';
        else if (same_plan && String(current.period || '') === period) refusal = 'ALREADY_SUBSCRIBED';
        else refusal = 'USE_SUBSCRIPTION_UPDATE';
      }
      return this.output.data({
        status: refusal,
        plan: current.plan,
        period: current.period,
        period_end: current.period_end,
      });
    }

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
    // Org checkout with an existing organisation never set email above —
    // MKT coupon reserve is keyed by email, so always resolve the payer.
    if (!email) {
      const payer = await this.yp.await_proc('payment_get_payer', this.uid);
      email = payer && payer.email;
      if (!name) name = (payer && payer.fullname) || name;
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
    } else if (supersede) {
      // Same-entity replacement (Team <-> Business). The webhook reads this to
      // cancel the subscription being replaced once this one is paid.
      metadata.supersede = '1';
      // Name the subscription being replaced EXPLICITLY. The webhook's stale
      // scan lists the session's customer, but the replaced subscription can
      // live on a DIFFERENT customer: a TEAM bootstrap subscribes on a
      // payer-keyed customer (the org doesn't exist yet), while the org's
      // next checkout uses the org-keyed customer — the scan never saw the
      // old subscription and it kept charging (live case: CS Team, Team
      // bootstrap sub still active after the Business upgrade was paid).
      // Resolved here, before Stripe, from the mirror the caller is looking
      // at — no webhook-ordering race can stale it.
      if (current && current.subscription_id) {
        metadata.supersede_target = current.subscription_id;
      }
    }
    if (org_bootstrap) {
      metadata.org_ident = org_bootstrap.ident;
      metadata.org_name = org_bootstrap.org_name;
    }

    // ── MKT outreach promo code (KOL / partners) ──────────────────────
    // First-party code in YP → reserve (anti-cheat) → Stripe Coupon +
    // trial_end on the Checkout session. Not Stripe Promotion Codes.
    const promo_code = String(
      this.input.use('promo_code', '') || this.input.use('coupon_code', '') || '',
    ).trim();
    let promo = null;
    let stripe_discount_coupon = null;
    let promo_trial_end = 0;
    if (promo_code) {
      if (trial_end) {
        // Deferred cycle switch already owns trial_end; stacking a promo
        // trial would silently change when billing starts.
        return this.output.data({ status: 'PROMO_WITH_DEFER' });
      }
      if (live && current && current.subscription_id) {
        // Already on a Stripe subscription — coupon is for first paid buy
        // (incl. LAUNCH30 → paid). Deliberate supersede is the only exception.
        if (!supersede) {
          return this.output.data({ status: 'COUPON_WITH_ACTIVE_SUB' });
        }
      }
      if (!/^(pro|team|business)$/.test(String(plan))) {
        return this.output.data({ status: 'COUPON_PLAN_UNSUPPORTED', plan });
      }
      if (!email) {
        return this.output.data({ status: 'COUPON_EMAIL_REQUIRED' });
      }
      const reserved = this._row(await this.yp.await_proc(
        'mkt_coupon_reserve',
        promo_code, email, this.uid, plan, period, entity_type, '',
        COUPON_HOLD_TTL_SEC,
      ));
      if (!reserved || reserved.error) {
        return this.output.data({
          status: (reserved && reserved.error) || 'COUPON_INVALID',
          code: reserved && reserved.code,
          email: reserved && reserved.email,
          // COUPON_PLAN_MISMATCH: the code is locked to one plan and this
          // is not it. Both sides travel so the client can name the plan
          // ("this code is for Team") instead of a bare "invalid code".
          plan_scope: reserved && reserved.plan_scope,
          requested_plan: reserved && reserved.requested_plan,
        });
      }
      promo = reserved;
      try {
        // percent_off=0 (free months) → no Stripe discount object.
        stripe_discount_coupon = await this._ensureStripeCoupon(reserved);
      } catch (e) {
        this.warn && this.warn('mkt stripe coupon failed', e && e.message);
        return this.output.data({
          status: 'COUPON_STRIPE_FAILED',
          reason: (e && e.message) || '',
        });
      }
      const td = this._promoTrialDays(reserved);
      if (td > 0) promo_trial_end = Math.floor(Date.now() / 1000) + (td * 86400);
      // A free-months code with no trial and no % would create a bare checkout
      // — refuse rather than silently charging full price.
      if (!stripe_discount_coupon && !promo_trial_end) {
        return this.output.data({ status: 'OFFER_INVALID', code: reserved.code });
      }
      metadata.mkt_code = reserved.code;
      metadata.mkt_kind = reserved.kind || '';
      metadata.mkt_redemption_id = String(reserved.id);
      if (reserved.partner) metadata.mkt_partner = reserved.partner;
    }
    const eff_trial_end = promo_trial_end || trial_end || 0;

    const create = (cust) => {
      const opts = {
        mode: 'subscription',
        customer: cust,
        line_items,
        // trial_end: MKT promo free days only. A cycle switch used to set it
        // too and no longer does — it is charged at checkout like every other
        // plan change.
        subscription_data: eff_trial_end
          ? { metadata, trial_end: eff_trial_end }
          : { metadata },
        metadata,
        success_url,
        cancel_url,
      };
      // discounts and allow_promotion_codes are mutually exclusive on Stripe.
      if (stripe_discount_coupon) {
        opts.discounts = [{ coupon: stripe_discount_coupon }];
      }
      return stripe.checkout.sessions.create(opts);
    };

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
      const clash = /combine currencies/i.test((e && e.message) || '');
      if (!clash) {
        this.warn && this.warn('payment.checkout failed', e && e.message);
        return this.output.data({ status: 'CHECKOUT_FAILED', reason: (e && e.message) || '' });
      }
      const fresh = await stripe.customers.create({
        email, name, metadata: { id: entity_id },
      });
      customer_id = fresh.id;
      session = await create(customer_id);
    }
    if (promo && promo.id && session && session.id) {
      try {
        await this.yp.await_proc('mkt_coupon_bind_session', promo.id, session.id);
      } catch (e) {
        this.warn && this.warn('mkt_coupon_bind_session failed', e && e.message);
      }
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
    const owns_org = !!(org && org.id);               // can pay for their own
    row.can_buy = is_personal || owns_org;
    if (!row.can_buy) row.buy_blocked = 'NOT_ORG_OWNER';
    // How many members the org ACTUALLY has, and how much it actually stores.
    // `seats` on this row is the plan's member CAP copied out of quota, so a
    // client warning about downgrades or cancellation that reads it as a
    // headcount says things like "your team has 100000 members" — the cap
    // compared against a cap. Only the real figures can tell a caller whether a
    // smaller plan would push anyone out or block uploads.
    //
    // Same filters as the platform's own headcount (yp member_list_stats):
    // archived members and system profiles are not seats anybody is using, and
    // counting them would contradict the number the Admin console shows.
    if (org && org.id) {
      const dom = ~~(org.domain_id || this.user.domain_id());
      let c = await this.yp.await_query(
        `SELECT COUNT(*) AS c
           FROM privilege p
           INNER JOIN drumate d ON p.uid = d.id
           INNER JOIN entity   e ON d.id = e.id
          WHERE p.domain_id = ?
            AND COALESCE(JSON_VALUE(d.profile, '$.category'), '') <> 'system'
            AND e.status <> 'archived'`,
        dom
      );
      if (Array.isArray(c)) c = c[0];
      row.member_count = ~~(c && c.c);
      // Org-wide usage, not the caller's own. The downgrade warning compares it
      // against the target plan's allowance, and Visitor.diskUsed() on the
      // client is only the signed-in user's share — an org well over the cap
      // looked fine to whoever happened to store little.
      // actual_usage is the recalculated figure; cached_usage is what the
      // running total says. Take the larger — under-reporting here would let a
      // downgrade through without the warning it exists to give.
      let u = await this.yp.await_query(
        `SELECT GREATEST(IFNULL(actual_usage, 0), IFNULL(cached_usage, 0)) AS used
           FROM quota_usage WHERE domain_id = ?`,
        dom
      );
      if (Array.isArray(u)) u = u[0];
      if (u && u.used != null) row.disk_used = Number(u.used) || 0;
    }
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

  // Self-serve plan/cycle switch on the EXISTING subscription — the path the
  // checkout() guard points at with USE_SUBSCRIPTION_UPDATE. Team <-> Business
  // are both org plans, so the switch is a price swap on the live Stripe
  // subscription, never a second checkout (which would double-bill — see the
  // guard in checkout()).
  //
  // Two things make the swap safe:
  // - metadata.plan/period are rewritten IN THE SAME update. The webhook
  //   derives entitlement from subscription metadata (stripe_webhook.js reads
  //   md.plan; there is no reverse price_id -> plan_code mapping), so a price
  //   swap that left the old metadata in place would keep applying the OLD
  //   plan's quota on every subsequent event.
  // - proration_behavior 'always_invoice' + payment_behavior
  //   'error_if_incomplete': an upgrade charges the prorated difference NOW
  //   and the whole update is rejected if that payment fails, so the
  //   subscription never half-switches. A downgrade's negative proration lands
  //   as a credit on the customer balance and offsets the next renewal.
  //
  // The webhook (customer.subscription.updated + the proration invoice.paid)
  // then re-mirrors yp.subscription_new and re-applies quota with the new
  // plan; the response carries the new state so the FE can flip immediately.
  async change_plan() {
    let stripe;
    try { stripe = this._stripe(); }
    catch (e) { return this.output.data({ status: 'STRIPE_NOT_CONFIGURED' }); }
    const plan = this.input.need('plan');
    const period = this.input.need('period');
    if (!/^(month|year)$/.test(period)) {
      return this.output.data({ status: 'PERIOD_INVALID', period });
    }

    // The DB mirror locates the subscription; it does NOT decide anything.
    // yp.subscription_new is only rewritten when the customer.subscription.
    // updated webhook lands, so between a change and its webhook (Stripe retry
    // backoff, an endpoint restart) it still describes the PREVIOUS state.
    // Deciding "nothing to change" or "does the interval change" from it would
    // no-op a real switch and report success. Stripe is the truth here.
    const sub = await this._subscription_row();
    const subscription_id = sub && sub.subscription_id;
    if (!subscription_id) return this.output.data({ status: 'NO_SUBSCRIPTION' });

    let live;
    try {
      live = await stripe.subscriptions.retrieve(subscription_id);
    } catch (e) {
      // The mirror points at a subscription Stripe no longer has (a deleted
      // event lost while the endpoint was down, a key/account rotation). Left
      // alone that row is a permanent dead end: checkout() still reads it as
      // live and refuses to sell, while every switch fails here. Clear it so
      // the caller can buy again, and say what is true — they have no
      // subscription.
      if (/resource_missing|No such subscription/i.test(String((e && e.message) || ''))) {
        try {
          await this.yp.await_proc('subscription_remove', sub.entity_id || this.uid, subscription_id);
        } catch (e2) { /* best effort: the answer below is right either way */ }
        return this.output.data({ status: 'NO_SUBSCRIPTION' });
      }
      return this.output.data({ status: 'CHANGE_FAILED', error: e && e.message });
    }
    const items = (live.items && live.items.data) || [];
    const item = items[0];
    const live_md = live.metadata || {};
    const cur_plan = String(live_md.plan || sub.plan || '');
    const cur_period = String(
      (item && item.price && item.price.recurring && item.price.recurring.interval)
      || live_md.period || sub.period || ''
    );
    const pending_cancel = !!live.cancel_at_period_end;
    // past_due counts: the subscription still exists at Stripe and checkout()
    // refuses to sell to its holder, so switching plan is their only self-serve
    // move. Telling them NO_SUBSCRIPTION would send them to buy a second one.
    if (!/^(active|trialing|past_due)$/.test(String(live.status || ''))) {
      // Gone at Stripe but still mirrored — same dead end as the 404 above.
      try {
        await this.yp.await_proc('subscription_remove', sub.entity_id || this.uid, subscription_id);
      } catch (e2) { /* best effort */ }
      return this.output.data({ status: 'NO_SUBSCRIPTION' });
    }
    if (cur_plan === plan && cur_period === period && !pending_cancel) {
      return this.output.data({ status: 'NOTHING_TO_CHANGE', plan, period });
    }

    const plan_row = await this.yp.await_proc('payment_get_plan', plan, period, CURRENCY);
    if (!plan_row || !plan_row.stripe_price_id) {
      return this.output.data({ status: 'NO_PRICE' });
    }
    // The target plan must be sold to the kind of entity that holds this
    // subscription. _subscription_row tags the tenant row entity_type='org'; a
    // personal row means 'user'. Crossing the kinds (a legacy personal 'pro'
    // reaching for an org plan) needs a supersede checkout, which is currently
    // unsafe — see the note in checkout(). Refuse and let the client say so.
    const holder = sub.entity_type === 'org' ? 'org' : 'user';
    if (plan_row.entity_type && plan_row.entity_type !== holder) {
      return this.output.data({
        status: 'PLAN_ENTITY_MISMATCH', plan, entity_type: holder, expected: plan_row.entity_type,
      });
    }
    // Swapping items[0] blind would replace an ADD-ON line on a legacy
    // multi-item subscription (storage_*/pro_seat), leaving the real plan line
    // in place and billing both. Those add-ons are retired, so this should not
    // occur — refuse rather than double-bill if it ever does. Checked AFTER the
    // entity-kind rule: the only multi-item subscriptions left are the legacy
    // personal ones, and PLAN_ENTITY_MISMATCH is the answer that actually tells
    // that caller what is going on.
    if (items.length !== 1) {
      return this.output.data({
        status: 'MULTI_ITEM_SUBSCRIPTION', items: items.length,
      });
    }

    const params = {
      items: [{ id: item.id, price: plan_row.stripe_price_id, quantity: 1 }],
      proration_behavior: 'always_invoice',
      payment_behavior: 'error_if_incomplete',
      // Switching plan implies staying: a pending-cancel sub is resumed by the
      // same update instead of bouncing the caller through resume first.
      cancel_at_period_end: false,
      metadata: { ...live_md, plan, period },
    };
    if (cur_period !== period) {
      // Interval changed and the caller wants it now: restart the cycle today.
      // They pay the new price immediately (minus the unused-time credit) and
      // renew a clean month/year from today, instead of a stub period on the
      // old anchor.
      params.billing_cycle_anchor = 'now';
    }

    let s;
    try {
      s = await stripe.subscriptions.update(subscription_id, params);
    } catch (e) {
      // error_if_incomplete keeps the switch atomic, but it also refuses
      // outright when the prorated charge needs the cardholder — 3DS/SCA
      // authentication, or a soft decline. Stripe returns an error instead of
      // a requires_action PaymentIntent, so there is no invoice to finish and
      // every retry fails identically. Say so specifically: the caller's way
      // out is a different card / the Billing Portal, not "try again".
      const code = String((e && (e.code || (e.raw && e.raw.code))) || '');
      const msg = String((e && e.message) || '');
      if (/requires_action|authentication|card_decline|card_declined|payment_intent|insufficient_funds/i.test(`${code} ${msg}`)) {
        return this.output.data({ status: 'PAYMENT_ACTION_REQUIRED', error: msg });
      }
      return this.output.data({ status: 'CHANGE_FAILED', error: msg });
    }
    const new_items = (s.items && s.items.data) || [];
    this.output.data({
      status: 'OK',
      plan,
      period,
      subscription_status: s.status || 'active',
      period_end: s.current_period_end || (new_items[0] && new_items[0].current_period_end) || sub.period_end || 0,
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
    // A session that charges nothing today: the subscription idles on a Stripe
    // trial until a later date, so session.amount_total is 0 and Stripe issues
    // a $0 invoice. The client had no way to tell that apart from a genuinely
    // free purchase and rendered "Total Payment $0.00" over a $290 switch.
    //
    // Cycle switches no longer produce this — they are charged at checkout —
    // but MKT promo free days still do, and subscriptions deferred before that
    // change are still live. Both need the same answer, so this stays. Say so
    // here — the banner on the billing page already branches on the same
    // condition (settings/account/billing skeleton, 'trialing').
    const subObj = (session.subscription && typeof session.subscription === 'object') ? session.subscription : null;
    const defer = md.defer === '1' || !!(subObj && subObj.status === 'trialing' && subObj.trial_end);
    // When the real billing starts, and what it will cost then. unit_amount
    // comes off the subscription item (subscriptions carry `items` without an
    // extra expand); the stored row is the fallback for the window before the
    // webhook has refreshed it.
    const item = subObj && subObj.items && subObj.items.data && subObj.items.data[0];
    const unit = item && item.price && item.price.unit_amount;
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
      defer,
      starts_at: (subObj && subObj.trial_end) || null, // epoch seconds
      upcoming_amount: unit != null
        ? unit
        : (sub && sub.price != null ? Math.round(Number(sub.price)) : null),
    });
  }

  // ── Downgrade over-limit resolution (service/lib/over-limit.js) ──────────
  //
  // over_limit_state: FRESH evaluation of the caller's domain — recomputes
  // usage + seats against the current entitlement, persists the flags and
  // returns the numbers the popup/banner render. A read that re-evaluates on
  // purpose: opening the popup self-heals any drift (and emits the resolved
  // push if the org has quietly come back within limits).
  async over_limit_state() {
    const OverLimit = require('../lib/over-limit');
    const dom = ~~this.user.domain_id();
    if (!OverLimit.enabled() || dom <= 1) {
      return this.output.data({ state: 'ok', enabled: OverLimit.enabled() ? 1 : 0 });
    }
    const { RedisStore } = require('@drumee/server-essentials');
    const res = await OverLimit.evaluate(this.yp, dom, {
      notify: (state) => OverLimit.notifyDomain(this.yp, RedisStore, state),
    });
    if (!res) return this.output.data({ state: 'ok', enabled: 1 });
    this.output.data({
      enabled: 1,
      state: res.state,
      flags: { storage: res.storage_over, seats: res.seats_over },
      grace_deadline: res.grace_deadline,
      disk_used: res.disk_used,
      disk_limit: res.disk_limit,
      seats_used: res.seats_used,
      seat_limit: res.seat_limit,
      plan: res.plan,
    });
  }

  // "Remind me later" — snooze the popup for THIS admin, server-side (the
  // design forbids localStorage: a dismissal must never outlive its intent;
  // resolution wipes the whole block, snoozes included). Default 24h,
  // OVER_LIMIT_SNOOZE_SEC to tune per environment.
  async over_limit_dismiss() {
    const OverLimit = require('../lib/over-limit');
    const dom = ~~this.user.domain_id();
    if (!OverLimit.enabled() || dom <= 1) return this.output.data({ status: 'OK' });
    let org = await this.yp.await_query(
      `SELECT id FROM organisation WHERE domain_id = ? LIMIT 1`, dom
    );
    if (Array.isArray(org)) org = org[0];
    if (!org || !org.id) return this.output.data({ status: 'OK' });
    const snooze = parseInt(process.env.OVER_LIMIT_SNOOZE_SEC, 10) || 24 * 3600;
    const until = Math.floor(Date.now() / 1000) + snooze;
    await this.yp.await_proc('org_over_limit_dismiss', org.id, this.uid, until);
    OverLimit.invalidate(dom);
    this.output.data({ status: 'OK', snoozed_until: until });
  }

  // upgrade_nudge_state: the desk's one boot-time question — "does THIS
  // member get an upgrade nudge right now?". All three trigger families
  // (storage / seats / age) and both suppression rules (once per threshold,
  // shared daily cap) are decided server-side in lib/upgrade-nudge + the yp
  // gate proc; a granted answer is already MARKED shown, so the FE renders
  // it unconditionally and never writes anything back.
  async upgrade_nudge_state() {
    const UpgradeNudge = require('../lib/upgrade-nudge');
    if (!UpgradeNudge.enabled()) {
      return this.output.data({ enabled: 0, show: 0 });
    }
    const res = await UpgradeNudge.grant(
      this.yp, this.user.domain_id(), this.uid
    );
    if (!res) return this.output.data({ enabled: 1, show: 0 });
    this.output.data({
      enabled: 1,
      show: 1,
      trigger: res.trigger,
      family: res.family,
      plan: res.plan,
      target_plan: res.target_plan,
      ...res.numbers,
    });
  }
}

module.exports = __private_payment;
