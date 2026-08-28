/**
 * @license
 * Copyright 2026 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3
 */

/**
 * Maps a CTA name from the wire to its yp.feature_usage key, for the
 * analytics Engagement > Extended page.
 *
 * ITS OWN MODULE SO THE DECISION IS TESTABLE. The handler that uses it is a
 * request method on desk.js with no test harness; this is the part with a
 * wrong answer worth catching.
 *
 * AN UNKNOWN CTA RETURNS null RATHER THAN A BUILT KEY. The obvious
 * implementation -- `${cta}_click` -- would forward a typo to feature_mark,
 * whose SIGNAL on an unknown feature does not reject: the driver rolls back
 * and ENDS THE SHARED yp CONNECTION, which surfaces as stalled sibling
 * requests rather than a logged warning. So a bad value from the wire has to
 * die here, in a comparison against a fixed list, and never reach SQL.
 */

/** The only values accepted from the wire. Mirrors acl/desk.json's enum. */
const CTA_FEATURES = ["upgrade", "selfhosted"];

/**
 * @param {*} cta value as received from the request
 * @returns {String|null} the feature key, or null if `cta` is not one of ours
 */
function ctaFeature(cta) {
  // Strict membership, not a string build: typeof guards the coercion cases
  // (0, {}, ['upgrade']) that would otherwise slip through an == check.
  if (typeof cta !== "string") return null;
  if (!CTA_FEATURES.includes(cta)) return null;
  return `${cta}_click`;
}

module.exports = { ctaFeature, CTA_FEATURES };
