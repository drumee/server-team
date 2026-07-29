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
const { Cache, toArray } = require('@drumee/server-essentials');

const CAMPAIGN = 'free-storage';
/**
 * How many users the campaign can ever reward, when nothing is configured.
 *
 * The campaign promises a limited number of places ("Limited 100 spots ONLY"
 * in the mail), so the flow has to CLOSE once they are gone rather than keep
 * handing out a reward that no longer exists.
 *
 * Overridable through the `reward_conf` sysconf ({"slots": N}) so the number
 * can be raised for a second wave without a redeploy. Both this service and
 * analytics-server fall back to the same literal, so an unprovisioned key
 * means 100 everywhere rather than "no limit" in one place and 100 in another.
 */
const SLOTS = 100;
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
 *  and must never be claimable by a browser, or anyone could invite themselves.
 *
 *  'missed' IS claimable, but reporting it can only ever cost the caller: it is
 *  how the widget says "I showed this user the sold-out screen and they
 *  dismissed it", and the proc's rank order keeps it under 'done', so a user
 *  who already holds a slot cannot post their way out of it. */
const STATUS = new Set(['clicked', 'started', 'dropped', 'done', 'missed']);
const STEPS = ['step1', 'step2', 'step3'];

class __reward extends Entity {

  /**
   * How many users this campaign may reward, for the GATE's purposes.
   *
   * The award itself does not go through here: reward_claim_track reads the
   * same `reward_conf` key in SQL, so the cap holds whatever this service
   * believes. This copy only decides whether to offer the flow, and the worst a
   * disagreement can do is offer a walkthrough that the completion then
   * refuses — which is the case the sold-out screen already exists to handle.
   *
   * Read per call rather than cached on the instance: sysconf can change under
   * a running server, and this is one JSON parse on a path that runs at most
   * twice per session.
   */
  _slotLimit() {
    try {
      const n = Number(JSON.parse(Cache.getSysConf('reward_conf') || '{}').slots);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : SLOTS;
    } catch (e) {
      return SLOTS;
    }
  }

  /**
   * Are all the campaign's slots gone?
   *
   * A DB failure answers YES. Everywhere else in this service the safe default
   * is "no reward": get_state already treats an unreachable server as
   * ineligible, and opening a flow whose prize may not exist is the one outcome
   * worth avoiding — the user would walk three steps to be turned away at the
   * end.
   */
  async _slotsFull() {
    try {
      // Read through await_query with an explicit alias rather than await_func:
      // the same toArray(...)[0] shape get_state below already relies on, and it
      // does not depend on how a bare `select fn()` unwraps.
      const row = toArray(await this.yp.await_query(
        `SELECT reward_slots_used() AS claimed`
      ))[0];
      const claimed = Number(row && row.claimed);
      return !Number.isFinite(claimed) || claimed >= this._slotLimit();
    } catch (e) {
      this.warn('[reward] slot count failed', e && e.message);
      return true;
    }
  }

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
   *
   * CAPPED is eligibility with the prize gone. The campaign is limited to
   * `reward_conf.slots` users, and once they are taken an invited user gets the
   * sold-out screen instead of the walkthrough — they were promised something,
   * so they are told, rather than silently seeing nothing like a user who was
   * never mailed. `step` is deliberately blanked: there is nothing to resume
   * into, and a capped run has one screen.
   *
   * Capped OUTRANKS resume on purpose. A user who was half-way through
   * yesterday and comes back after the cap closed is stopped here, rather than
   * being walked through three steps and refused at the end. That leaves the
   * refusal in reward_claim_track for the only case the gate cannot catch —
   * someone already mid-flow, in an open browser, when the last slot goes.
   */
  async get_state() {
    const row = toArray(await this.yp.await_query(
      `SELECT status, step FROM reward_claim WHERE uid=?`, this.uid
    ))[0];
    const eligible = !!(row && OPEN.has(row.status));
    const capped = eligible && await this._slotsFull();
    this.output.data({
      eligible: eligible ? 1 : 0,
      capped: capped ? 1 : 0,
      step: (!capped && eligible && row.step) || '',
    });
  }

  /**
   * Record the caller's progress in the claim-reward flow.
   *
   * Unknown values are rejected rather than stored: the funnel is only useful
   * if every row reads as one of the known states, and the widget is the only
   * caller, so anything else is a bug or a poke at the endpoint.
   *
   * Reporting 'done' is a REQUEST for one of the campaign's limited slots, not
   * a statement of fact — reward_claim_track awards it under a lock, or writes
   * 'missed' when the cap has closed. `granted` carries that answer back so the
   * widget knows whether to show Congratulations or the sold-out screen, and it
   * is the SERVER's answer: the browser cannot count slots, and two users
   * finishing together would both think they won.
   *
   * The row is read back with await_query rather than taken from the proc's own
   * trailing SELECT, which comes back as a raw multi-resultset and does not
   * parse into a row (same reason as survey.js).
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

    // No limit argument: the proc reads sys_conf.reward_conf itself, so this
    // signature never changes and a schema patch can land without waiting for a
    // server deploy. Passing it made the two repos deploy in lockstep — the
    // moment the proc required the extra argument, every runtime still on the
    // previous build failed with "Incorrect number of arguments".
    await this.yp.await_proc(
      'reward_claim_track',
      this.uid,
      campaign || CAMPAIGN,
      status,
      STEPS.includes(step) ? step : ''
    );

    // Only a completion can be refused, so only a completion pays for the
    // read-back. Anything else is granted by definition.
    let granted = 1;
    if (status === 'done') {
      const row = toArray(await this.yp.await_query(
        `SELECT status, completed_count FROM reward_claim WHERE uid=?`, this.uid
      ))[0];
      granted = row && row.completed_count > 0 ? 1 : 0;
    }
    this.output.data({ ok: true, status, step, granted });
  }
}

module.exports = __reward;
