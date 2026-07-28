/**
 * Claim-reward campaign tracking.
 *
 * The reward onboarding flow (ui-team builtins/widget/reward-flow) kept all of
 * its progress in localStorage, so nothing outside that one browser knew who
 * finished and who walked away. `track` is the single write the widget makes,
 * fired on each step transition and on the terminal outcomes.
 *
 * The row is the caller's own — uid comes from the session, never from the
 * request — and yp.reward_claim_track advances status/step by rank, so a
 * duplicated or out-of-order post is harmless.
 *
 * Read side: analytics-server reward_tracking().
 */
const { Entity } = require('@drumee/server-core');
const { toArray } = require('@drumee/server-essentials');

const CAMPAIGN = 'free-storage';
/**
 * Statuses that open the flow.
 *
 * 'emailed' is deliberately NOT here. Being on the recipient list is an
 * invitation, not an entitlement — the user has to follow the campaign link.
 * Without that distinction anyone who was mailed got the walkthrough on their
 * next login whether or not they ever clicked, which is the step this closes.
 *
 * Terminal states (done, dropped) are excluded; a later send re-arms the row to
 * 'emailed', so a returning user has to click again before they are eligible.
 */
const OPEN = new Set(['clicked', 'started']);
/** States the client may report. 'clicked' is posted by the desk when it finds
 *  campaign-arrival evidence relayed through login; the rest come from the
 *  widget. 'emailed' is NOT here: it is seeded at send time by analytics-server
 *  and must never be claimable by a browser, or anyone could invite themselves. */
const STATUS = new Set(['clicked', 'started', 'dropped', 'done']);
const STEPS = ['step1', 'step2', 'step3'];

class __reward extends Entity {

  /**
   * Should the desk open the claim-reward flow for the caller, and where.
   *
   * This is the gate. It used to be `reward_flow_done` in localStorage, which
   * made "has this user finished" a fact about a BROWSER: it did not follow the
   * user to another device, it grew a key per user on a shared machine, and no
   * amount of clearing the table could reset it. Here the row IS the answer.
   *
   * A missing row means this user was never mailed, so they are not eligible —
   * that alone is what stops a second person on a shared browser from being
   * handed someone else's campaign.
   *
   * `step` is the furthest card step reached, so a user who wandered off
   * resumes where they were, on any device. Only sent when eligible; a
   * terminal row has nothing to resume.
   */
  async get_state() {
    const row = toArray(await this.yp.await_query(
      `SELECT status, step FROM reward_claim WHERE uid=?`, this.uid
    ))[0];
    const eligible = !!(row && OPEN.has(row.status));
    this.output.data({
      eligible: eligible ? 1 : 0,
      step: (eligible && row.step) || '',
    });
  }

  /**
   * Record the caller's progress in the claim-reward flow.
   *
   * Unknown values are rejected rather than stored: the funnel is only useful
   * if every row reads as one of the known states, and the widget is the only
   * caller, so anything else is a bug or a poke at the endpoint.
   */
  async track() {
    const status = String(this.input.need('status') || '').trim();
    if (!STATUS.has(status)) {
      return this.output.data({ ok: false, error: 'invalid status' });
    }
    // Step is optional — 'dropped' is posted without one when the user quits
    // from a transient state, and the proc keeps whatever it already had.
    const step = String(this.input.use('step', '') || '').trim();
    const campaign = String(this.input.use('campaign', CAMPAIGN) || CAMPAIGN).trim();

    await this.yp.await_proc(
      'reward_claim_track',
      this.uid,
      campaign || CAMPAIGN,
      status,
      STEPS.includes(step) ? step : ''
    );
    this.output.data({ ok: true, status, step });
  }
}

module.exports = __reward;
