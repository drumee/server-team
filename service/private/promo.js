// service/private/promo.js
//
// LAUNCH30 — "Start your 1-month Team Plan today". Design doc 2026-07-30:
// claimed with NO credit card and NO Stripe object whatsoever (no customer,
// no payment method, no subscription) — a raw yp.quota entitlement, separate
// from the Stripe-backed subscription system in payment.js/stripe_webhook.js.
//
// Eligibility is re-checked here on every call — the client's job is to
// render state and call claim, never to decide it (same rule as the promo
// design doc's API contract).
const { Entity } = require('@drumee/server-core');
const { isEmpty } = require('lodash');
const { COUPON_HOLD_TTL_SEC } = require('../lib/mkt-coupon');
const { pushPromoLiveFrom } = require('./_promo_live');

// Env-overridable, defaults are the real product/business values — same
// pattern as the workers (reminderWorker's REMINDER_INTERVAL_SEC,
// promoExpiryWorker's PROMO_EXPIRY_INTERVAL_SEC): no code change to test a
// near-term expiry on stage, or to move the real date on prod, across
// test/stage/preview/prod without touching this file.
const TRIAL_DAYS = parseInt(process.env.PROMO_LAUNCH30_TRIAL_DAYS, 10) || 30;

// Founder decision 2026-07-31: 30 days from launch, no cap extension.
// Default below is the real business date; PROMO_LAUNCH30_ENDS_AT (unix
// seconds) overrides it per-environment. Noon UTC, not end-of-day: the FE
// formats this in the browser's LOCAL timezone (Dayjs has no UTC plugin
// loaded here), and a 23:59:59 UTC cutoff rolled over to "Aug 31" for any
// viewer east of UTC — noon keeps the displayed calendar date correct
// across every real-world timezone (UTC-11..+13), at the cost of a few
// hours of claim generosity.
const CAMPAIGN_ENDS_AT =
  parseInt(process.env.PROMO_LAUNCH30_ENDS_AT, 10) || 1788091200; // 2026-08-30T12:00:00Z

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

// Product decision 2026-07-31 (D1): SEEDED position, not real inventory.
// "You're #67 to claim this offer" — stable per account, social proof
// without an invented "N spots left" claim (the doc's own D1 discussion
// flags a fabricated counter as a deceptive-practice risk under the EU UCP
// Directive for a brand sold on trust). Stable across reloads: seeded from
// uid, never random per render — a number that changes on refresh destroys
// the offer's credibility (doc's own edge-case table). Range 50-99, same
// shape as the design's own crc32(user_id)-based formula.
function seededPosition(uid) {
  let hash = 0;
  const s = String(uid || '');
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  }
  return 50 + (hash % 50);
}

class __private_promo extends Entity {
  // The caller's own LAUNCH30 state. Called on app boot (home) and on
  // Billing page mount — read-only, computes eligibility fresh every time
  // rather than trusting a cached client flag.
  async get_state() {
    const row = await this._row();
    if (row && row.status === 'claimed') {
      const expired = ~~row.trial_ends_at > 0 && ~~row.trial_ends_at < Math.floor(Date.now() / 1000);
      return this.output.data({
        state: expired ? 'claimed_expired' : 'claimed_active',
        trial_ends_at: row.trial_ends_at,
        home_seen_at: row.home_seen_at,
        billing_seen_at: row.billing_seen_at,
        // Drives the one-shot Modal B auto-show on the new org domain's
        // first home mount after a claim (tester feedback 2026-07-31 #2):
        // the domain redirect happens too fast for the client to reliably
        // show Modal B before the page navigates away, so the client no
        // longer tries on the claiming page — it shows once here instead.
        welcome_seen: !!row.welcome_seen_at,
        // Also reported here, not just in the 'expired' branch below: a trial
        // whose date has passed reads as claimed_expired from THIS branch for
        // as long as promoExpiryWorker has not run yet (it sweeps on a timer).
        // The gate has to work in that window too, or it flickers on for one
        // mount and off again once the row flips to status='expired'.
        ended_seen: !!row.ended_seen_at,
      });
    }
    if (row && row.status === 'expired') {
      return this.output.data({
        state: 'claimed_expired',
        trial_ends_at: row.trial_ends_at,
        home_seen_at: row.home_seen_at,
        billing_seen_at: row.billing_seen_at,
        // Drives the trial-ended gate. Unlike the *_seen flags this one means
        // "the owner ANSWERED" — the modal has no close button and returns on
        // every home mount until it is set, so this is the only thing that
        // stops it.
        ended_seen: !!row.ended_seen_at,
      });
    }

    const eligible = await this._isEligible();
    const seen = !!(row && (row.home_seen_at || row.billing_seen_at));
    return this.output.data({
      state: eligible ? (seen ? 'eligible_seen' : 'eligible_unseen') : 'ineligible',
      home_seen_at: row && row.home_seen_at,
      billing_seen_at: row && row.billing_seen_at,
      position: eligible ? seededPosition(this.uid) : undefined,
      campaign_ends_at: eligible ? CAMPAIGN_ENDS_AT : undefined,
    });
  }

  // Records that `surface` ('home' | 'billing' | 'welcome') has shown its
  // modal to this account, once, forever (server flag — see
  // promo_launch30_mark_seen). 'welcome' is Modal B — the client marks it
  // seen as soon as it renders, not on explicit dismissal (tester feedback
  // 2026-07-31 #3: the full modal must show at most once per surface).
  async dismiss() {
    // 'ended' is the trial-ended gate. It is recorded through the same proc,
    // but it means the owner ANSWERED rather than merely saw — see
    // promo_launch30_mark_seen.
    const surface = String(this.input.use('surface', '') || '');
    if (!['home', 'billing', 'welcome', 'ended'].includes(surface)) {
      return this.output.status('SURFACE_INVALID');
    }
    await this.yp.await_proc('promo_launch30_mark_seen', this.uid, surface);
    // A first sighting CREATES the analytics row, so this is the only event
    // that changes the size of the dashboard's table rather than moving a row
    // within it. Not awaited, and it cannot throw — see _promo_live.js.
    pushPromoLiveFrom(this, this.uid, 'seen');
    this.output.json({ status: 'OK' });
  }

  // End an active LAUNCH30 trial early (Billing → Cancel plan). There is no
  // Stripe subscription to schedule cancel_at_period_end against — the same
  // revert the expiry worker runs: payment_clear_entitlement on the org,
  // then promo_launch30_mark_expired. Immediate: the user asked to leave
  // Team now, and keeping access until trial_ends_at would make Cancel a
  // no-op (the trial already ends there with nothing to renew).
  async cancel() {
    const row = await this._row();
    if (!row || row.status !== 'claimed') {
      return this.output.status('NOT_ACTIVE');
    }
    const orgId = row.org_id;
    if (!orgId) {
      return this.output.status('NOT_ACTIVE');
    }
    await this.yp.await_proc('payment_clear_entitlement', orgId);
    await this.yp.await_proc('promo_launch30_mark_expired', this.uid);
    // Reported here rather than after the over-limit sweep below: the revert is
    // committed at this point, and the sweep is best-effort work that must not
    // decide whether the dashboard hears about it.
    pushPromoLiveFrom(this, this.uid, 'cancelled');

    // Downgrade over-limit: the org just fell to the free tier — measure it
    // against the free limits and set the flags/grace if it no longer fits.
    try {
      const OverLimit = require('../lib/over-limit');
      if (OverLimit.enabled()) {
        let org = await this.yp.await_query(
          `SELECT domain_id FROM organisation WHERE id = ? LIMIT 1`, orgId
        );
        if (Array.isArray(org)) org = org[0];
        const dom = ~~(org && org.domain_id);
        if (dom > 1) {
          const { RedisStore } = require('@drumee/server-essentials');
          await OverLimit.evaluate(this.yp, dom, {
            notify: (state) => OverLimit.notifyDomain(this.yp, RedisStore, state),
          });
        }
      }
    } catch (e) { /* best-effort — the revert above is already committed */ }

    let quota;
    try {
      quota = await this.yp.await_func('get_quota', this.uid);
      if (typeof quota === 'string') { try { quota = JSON.parse(quota); } catch (e) { quota = undefined; } }
      await this.notify_user(this.uid, {
        service: 'payment.plan_updated',
        plan: 'free',
        status: 'canceled',
        quota,
      });
    } catch (e) { /* best-effort */ }

    this.output.json({ status: 'OK', plan: 'free', quota });
  }

  // Claim: bootstrap (or reuse) the caller's organisation, then grant the
  // Team entitlement for TRIAL_DAYS with no Stripe object anywhere.
  // Idempotent — a retried call after a partial failure (org created, grant
  // not yet written) completes rather than double-provisions or double-grants.
  async claim() {
    if (!(await this._isEligible())) {
      return this.output.status('NOT_ELIGIBLE');
    }
    const existing = await this._row();
    if (existing && existing.status !== 'unclaimed') {
      // Already claimed/expired by a previous call — return that state
      // rather than erroring; the source_surface param is telemetry only.
      return this.output.json({ status: 'OK', already: 1, ...existing });
    }

    const org = await this._provisionOrg();
    if (!org || org.error) {
      return this.output.status(org && org.error ? org.error : 'PROVISION_FAILED');
    }

    const res = await this.yp.await_proc(
      'promo_launch30_grant', this.uid, org.id, org.domain_id, TRIAL_DAYS,
    );
    const row = Array.isArray(res) ? res[0] : res;

    // The grant is committed. Two different audiences hear about it and neither
    // substitutes for the other: notify_user below tells the CLAIMANT their own
    // session moved to Team, this tells every open analytics DASHBOARD that a
    // row in its table moved from 'shown' to 'trialing'.
    pushPromoLiveFrom(this, this.uid, 'claimed');

    // Same event the Stripe webhook emits on a real plan change — the
    // billing widget's existing onWsMessage('payment.plan_updated') handler
    // already calls Visitor.respawn + re-renders, so the claimant's already-
    // open session reflects Team live, no reload (mirrors the admin-access
    // grant fix 2026-07-30 — every entitlement change needs this, not just
    // the ones that happen to route through the webhook).
    let quota;
    try {
      quota = await this.yp.await_func('get_quota', this.uid);
      if (typeof quota === 'string') { try { quota = JSON.parse(quota); } catch (e) { quota = undefined; } }
      await this.notify_user(this.uid, {
        service: 'payment.plan_updated',
        plan: 'team',
        status: 'trialing',
        period_end: row && row.trial_ends_at,
        quota,
      });
    } catch (e) { /* best-effort */ }

    // quota is returned so the FE can Visitor.respawn immediately — the
    // home-surface claim path has no billing widget listening for
    // payment.plan_updated, so without this the sidebar still gates Admin
    // Console on plan=free until a full reload.
    this.output.json({
      status: 'OK',
      org_id: org.id,
      domain_id: org.domain_id,
      trial_ends_at: row && row.trial_ends_at,
      quota,
    });
  }

  /**
   * Redeem an MKT partner code straight into a plan — no Stripe Checkout,
   * no card. Lives here rather than in payment.js because it is the
   * LAUNCH30 shape, not the Stripe one: provision the org, write a
   * yp.quota row, let the expiry worker revert it. _provisionOrg and the
   * no-Stripe grant already exist here; duplicating them next to
   * payment.checkout would give the same feature two implementations.
   *
   * ONLY free-period codes qualify (percent_off = 0, trial_days > 0). A
   * percent-off code discounts a subscription that still charges money —
   * handing the plan over for free here would give away the product. The
   * proc enforces this too; the check is repeated so the client gets a
   * useful answer without a round trip through a grant that would fail.
   *
   * The caller CHOOSES the plan (a coupon says where it may be spent via
   * plan_scope, never which plan to hand out). plan_scope still gates it.
   */
  async redeem() {
    const code = String(
      this.input.use('promo_code', '') || this.input.use('code', '') || '',
    ).trim();
    if (!code) return this.output.data({ status: 'COUPON_INVALID' });

    const plan = String(this.input.use('plan', '') || '').trim().toLowerCase();
    if (!/^(pro|team|business)$/.test(plan)) {
      return this.output.data({ status: 'COUPON_PLAN_UNSUPPORTED', plan });
    }
    // Pro is PERSONAL (entity_type 'user', organization 0). It grants to the
    // redeemer themselves, so none of the organisation machinery below —
    // the move-semantics guard, the provisioning — applies to it.
    const needsOrg = /^(team|business)$/.test(plan);
    // Same move-semantics guard as the LAUNCH30 claim and the checkout org
    // bootstrap: someone already inside another org's domain cannot be
    // handed a second organisation.
    //
    // "Another org's" is load-bearing. A successful redeem moves the caller
    // into the domain of the org it just created for them, so a plain
    // domain_id > 1 test would reject their own retry — exactly the case
    // mkt_coupon_redeem's idempotency exists to serve (client never saw the
    // OK, user presses Redeem again). Let an owner through: org_provision
    // returns their existing org rather than a second one, and the grant
    // proc answers already=1 without re-granting.
    if (needsOrg && ~~this.user.domain_id() > 1) {
      const own = this._row2(await this.yp.await_proc(
        'organisation_get', String(this.user.domain_id()),
      ));
      if (!own || own.owner_id !== this.uid) {
        return this.output.data({ status: 'ALREADY_IN_OTHER_DOMAIN' });
      }
    }

    const payer = await this.yp.await_proc('payment_get_payer', this.uid);
    const email = (payer && payer.email) || this.user.get('email') || '';
    if (!email) return this.output.data({ status: 'COUPON_EMAIL_REQUIRED' });

    // Validate BEFORE provisioning. _provisionOrg is irreversible — it
    // creates an organisation, a domain and a vhost, and moves the payer
    // into that domain. Doing it first meant a rejected code (a typo, a
    // discount code, an exhausted one) still left a junk org behind AND
    // pushed domain_id above 1, which the guard above then reads as
    // "already belongs to an organisation" — permanently locking the user
    // out of redeeming anything. Observed on stage: one refused
    // COUPON_NOT_REDEEMABLE moved a Free payer from domain 1 to 43.
    //
    // mkt_coupon_validate writes nothing and runs the same checks the grant
    // will, so an invalid code now costs a lookup and nothing else. The
    // grant re-checks everything anyway (defense in depth against a race
    // between these two calls).
    const check = this._row2(await this.yp.await_proc(
      'mkt_coupon_validate', code, email, plan, COUPON_HOLD_TTL_SEC,
    ));
    if (!check || check.error) {
      return this.output.data({
        status: (check && check.error) || 'COUPON_INVALID',
        code: check && check.code,
        email: check && check.email,
        plan_scope: check && check.plan_scope,
        requested_plan: check && check.requested_plan,
      });
    }
    // The free-period rule, checked here too so a discount code is refused
    // before it can cost the caller an organisation.
    if ((parseInt(check.percent_off, 10) || 0) !== 0
        || (parseInt(check.trial_days, 10) || 0) <= 0) {
      return this.output.data({
        status: 'COUPON_NOT_REDEEMABLE',
        code: check.code,
        kind: check.kind,
        percent_off: check.percent_off,
        trial_days: check.trial_days,
      });
    }

    // Personal plans provision nothing: the grant lands on the redeemer,
    // on whatever domain they already live on. Creating an organisation for
    // a Pro redemption would hand them a tenant the plan does not include
    // (organization 0) and move their domain_id, which is exactly the
    // irreversible side effect the ordering fix above exists to avoid.
    let org = null;
    if (needsOrg) {
      org = await this._provisionOrg();
      if (!org || org.error) {
        return this.output.data({
          status: (org && org.error) || 'PROVISION_FAILED',
        });
      }
    }

    // The proc reads entity_type from the catalog and picks the quota holder
    // itself; for a personal plan these two arguments are simply unused.
    const row = this._row2(await this.yp.await_proc(
      'mkt_coupon_redeem',
      code, email, this.uid, plan,
      org ? org.id : '', org ? org.domain_id : 0,
      COUPON_HOLD_TTL_SEC,
    ));
    if (!row || row.error) {
      return this.output.data({
        status: (row && row.error) || 'COUPON_INVALID',
        code: row && row.code,
        email: row && row.email,
        plan_scope: row && row.plan_scope,
        requested_plan: row && row.requested_plan,
        kind: row && row.kind,
      });
    }

    // Same event the Stripe webhook emits on a real plan change, so an
    // already-open billing tab reflects the new plan without a reload.
    let quota;
    try {
      quota = await this.yp.await_func('get_quota', this.uid);
      if (typeof quota === 'string') {
        try { quota = JSON.parse(quota); } catch (e) { quota = undefined; }
      }
      await this.notify_user(this.uid, {
        service: 'payment.plan_updated',
        plan,
        status: 'trialing',
        period_end: row.trial_ends_at,
        quota,
      });
    } catch (e) { /* best-effort */ }

    this.output.data({
      status: 'OK',
      already: ~~row.already === 1 ? 1 : 0,
      code: row.code,
      plan: row.plan,
      org_id: row.org_id,
      domain_id: row.domain_id,
      trial_ends_at: row.trial_ends_at,
      quota,
    });
  }

  _row2(res) {
    return Array.isArray(res) ? res[0] : res;
  }

  async _row() {
    const res = await this.yp.await_proc('promo_launch30_get_state', this.uid);
    return Array.isArray(res) ? res[0] : res;
  }

  // plan=free (never bought/traded up before), not already living in
  // someone else's org domain (same guard payment.js's org-bootstrap ident
  // validation uses — _validateOrgIdent: "a payer already inside another
  // domain cannot bootstrap a second organisation"), and the campaign is
  // still live.
  async _isEligible() {
    if (Math.floor(Date.now() / 1000) > CAMPAIGN_ENDS_AT) return false;
    if (~~this.user.domain_id() > 1) return false;
    try {
      let q = await this.yp.await_func('get_quota', this.uid);
      if (typeof q === 'string') { try { q = JSON.parse(q); } catch (e) { q = null; } }
      const plan = q && (q.plan || q.category);
      return !plan || plan === 'free';
    } catch (e) {
      return false;
    }
  }

  // Auto-generates an org name/ident — the whole point of LAUNCH30 is one
  // click, no form. Retries the ident on collision (ident_exists covers
  // entity + organisation + vhost/domain — see org_provision's own guard —
  // a race there still surfaces as org.error and the caller can retry).
  async _provisionOrg() {
    const fullname = this.user.get('fullname') || '';
    const email = this.user.get('email') || '';
    const localPart = email.split('@')[0] || 'team';
    const base = slugify(localPart) || 'team';
    const name = fullname ? `${fullname}'s Team` : 'My Team';

    let ident = base;
    for (let attempt = 0; attempt < 5; attempt++) {
      const taken = await this.yp.await_proc('ident_exists', ident);
      const isTaken = Array.isArray(taken) ? taken.length > 0 : !isEmpty(taken);
      if (!isTaken) break;
      ident = `${base}-${Math.floor(1000 + Math.random() * 9000)}`;
    }

    const res = await this.yp.await_proc('org_provision', this.uid, name, ident);
    return Array.isArray(res) ? res[0] : res;
  }
}

module.exports = __private_promo;
