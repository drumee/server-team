/**
 * @license
 * Copyright 2024 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3.
 * https://www.gnu.org/licenses/agpl-3.0.html
 */

/**
 * Did a Messenger send actually deliver?
 *
 * This exists because Messenger has THREE return shapes and only one of them
 * carries an `error` field, so the obvious guard —
 *
 *   const result = await msg.send({ html });
 *   if (result && result.error) throw ...
 *
 * — reports success for two of the three. Both misses are silent:
 *
 *   1. `send()` returns `this._html`, a STRING, when `getMTA()` declines to
 *      build a transport (`myDrumee.useEmail` falsy). It logs `NO_MTA` and
 *      returns before touching SMTP. A string has no `.error`.
 *   2. `dispatch()` is fire-and-forget and returns `undefined` always. Its
 *      promise is never awaited, so an SMTP rejection lands in its own
 *      `.catch` and nowhere else. `undefined` has no `.error` either.
 *
 * Callers that trusted that guard reported `status: "ok"` for mail that was
 * never handed to an MTA — hub.invite told the panel "Invitation sent
 * successfully" while nothing left the box.
 *
 * So: fail closed. Only the documented `{ recipient, error }` object with a
 * falsy `error` counts as delivered; every other shape is a non-delivery.
 */

/** No MTA was ever asked to take the mail (`dispatch`, or an unknown shape). */
const NOT_DISPATCHED = "mail was not dispatched";

/** A transport was declined by config — `myDrumee.useEmail` is off. */
const NO_MTA = "no MTA is configured (myDrumee.useEmail is off)";

/**
 * @param {Object|String|undefined} result whatever Messenger.send/dispatch gave back
 * @returns {String|null} why it did not deliver, or null when it did
 */
function mailFailure(result) {
  // `dispatch()` (undefined) and anything else falsy: nothing was awaited, so
  // there is no evidence of delivery to report.
  if (!result) return NOT_DISPATCHED;

  // The NO_MTA early return hands back the rendered HTML. Reported apart from
  // NOT_DISPATCHED because the cure is different: this one is a config switch,
  // not a code path.
  if (typeof result === "string") return NO_MTA;

  // An array is not a result object; `.error` on it is undefined, which is
  // exactly the reading that used to pass for success.
  if (typeof result !== "object" || Array.isArray(result)) return NOT_DISPATCHED;

  // The one documented shape. `error` is null on full delivery, and otherwise
  // the list of recipients whose sendMail rejected.
  if (!("recipient" in result) && !("error" in result)) return NOT_DISPATCHED;
  if (!result.error) return null;

  const failed = Array.isArray(result.error)
    ? result.error.join(", ")
    : String(result.error);
  return `the MTA rejected ${failed}`;
}

module.exports = { NOT_DISPATCHED, NO_MTA, mailFailure };
