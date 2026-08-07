/**
 * @license
 * Copyright 2024 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3
 */

const { RedisStore, toArray } = require('@drumee/server-essentials');

/**
 * Push one referred user's row to every open analytics dashboard.
 *
 * The Referral users board polls every two minutes. These pushes are what make
 * a row turn over as the user causes it to instead of up to two minutes later.
 * Three things move a row, and each calls this after its own write:
 *   onboarded = 1     loby onboarding.update_profile   (New -> Onboarding)
 *   first upload      service/media.js store()          (Uploads, and possibly
 *                                                        Onboarding -> Activated)
 *   first workspace   service/private/desk.js track_workspace  (-> Activated)
 *
 * NEVER THROWS, NEVER AWAITED BY THE CALLER. Every caller is reporting on work
 * that has already committed, so a failure here would mean announcing a
 * problem with something that in fact succeeded — and a slow Redis, or a
 * dashboard nobody has open, must not add latency to an upload.
 *
 * THE ROW IS NOT BUILT HERE. referral_members owns the status CASE and the
 * column arithmetic; this asks it for the row and forwards what it gets, so a
 * live row and a polled row cannot disagree. That call is also the cohort
 * gate: it answers nothing for a user who was never referred, and no push goes
 * out for them.
 */

/**
 * How long a burst of events for one user is folded into a single trailing
 * push. Uploads arrive one `store()` per FILE, so a 100-file bundle would
 * otherwise run 100 gate queries and fan 100 messages at every open dashboard.
 */
const COALESCE_MS = 1500;

/**
 * uid -> { timer, again }. Module level on purpose: a service instance lives
 * for one request, and the whole point is to span the many requests a bundle
 * upload makes.
 */
const PENDING = new Map();

/**
 * Read the row and send it. Resolves to nothing; all failures are swallowed.
 * @param {Object} yp    the yp database handle (ctx.yp)
 * @param {Function} warn
 * @param {String} uid
 */
async function publish(yp, warn, uid) {
  try {
    const rows = toArray(await yp.await_proc('referral_members', { uid }));
    const model = rows && rows[0];
    if (!model) return; // not a referred user — nothing on that board to move
    const sockets = toArray(await yp.await_proc('referral_live_sockets'));
    if (!sockets || !sockets.length) return; // no dashboard open anywhere
    await RedisStore.sendData(
      {
        model,
        // No top-level `service`: router/push stamps the envelope
        // "live.update", which is what routes it to the client's `live`
        // event. This name is how the widget knows what it received.
        options: { service: 'live.referral_member', keys: '*' },
      },
      sockets
    );
  } catch (e) {
    if (warn) warn('[referral-live] push failed', e && e.message);
  }
}

/**
 * Report that this user's referral row may have changed.
 *
 * Leading edge fires immediately, so a single upload — the case that matters,
 * a referred user's FIRST one — reaches the board in well under a second. A
 * trailing push follows only if more events arrived during the window, and it
 * re-reads the row, so the board ends on the final counts. A burst therefore
 * costs two gate queries rather than one per file.
 *
 * @param {Object} ctx the handler `this` (needs yp.await_proc)
 * @param {String} uid the user whose row moved
 */
function pushReferralLive(ctx, uid) {
  if (!ctx || !ctx.yp || typeof ctx.yp.await_proc !== 'function') return;
  if (!uid) return;
  // Captured rather than reached through `ctx` later: the trailing timer fires
  // after the request that scheduled it has finished, and the handler instance
  // is per-request. `yp` is the long-lived pool accessor and is safe to hold.
  const yp = ctx.yp;
  const warn = ctx.warn ? ctx.warn.bind(ctx) : null;

  const state = PENDING.get(uid);
  if (state) {
    state.again = true; // fold into the trailing push already scheduled
    return;
  }

  const entry = { timer: null, again: false };
  PENDING.set(uid, entry);
  publish(yp, warn, uid);

  entry.timer = setTimeout(() => {
    const s = PENDING.get(uid);
    PENDING.delete(uid);
    if (s && s.again) publish(yp, warn, uid);
  }, COALESCE_MS);
  // Do not hold the process open for an analytics message.
  if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref();
}

module.exports = { pushReferralLive };
