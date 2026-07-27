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

const CAMPAIGN = 'free-storage';
/** Terminal and in-flight states the client may report. 'emailed' is NOT here:
 *  it is seeded at send time by analytics-server, never claimed by a browser. */
const STATUS = ['started', 'dropped', 'done'];
const STEPS = ['step1', 'step2', 'step3'];

class __reward extends Entity {

  /**
   * Record the caller's progress in the claim-reward flow.
   *
   * Unknown values are rejected rather than stored: the funnel is only useful
   * if every row reads as one of the known states, and the widget is the only
   * caller, so anything else is a bug or a poke at the endpoint.
   */
  async track() {
    const status = String(this.input.need('status') || '').trim();
    if (!STATUS.includes(status)) {
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
