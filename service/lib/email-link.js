/**
 * Links mailed into the app go through a same-site bounce.
 *
 * The session cookie (regsid) is SameSite=Strict and set on the main domain,
 * so every app host (main, organisation, workspace vhosts) shares it. A click
 * out of a mail client is a cross-site navigation: the browser withholds the
 * cookie on that first request, the app boots as a guest, and the page response
 * sets a FRESH guest regsid that replaces the real one — the recipient is not
 * just shown the sign-in page, they are signed out everywhere (measured on
 * drumee.in 2026-10-09).
 *
 * callback.open is a tiny page served by the svc endpoint (which sets no
 * cookie) whose own script navigates to the target — a same-site navigation,
 * so the cookie is sent. Same mechanism as callback.portal_return, which the
 * billing/reward mails already use, generalised to any path + hash on the
 * same host.
 *
 * NOT for hosts with their own session cookie (share.<main_domain>, links
 * carrying ?keysel=): those never touched regsid and are left as they are.
 */

/** What callback.open accepts; everything else is percent-encoded first. */
const SAFE = /[A-Za-z0-9\-._~!$&()*+,;=:@%/?#]/;

function _pct(c) {
  const code = c.charCodeAt(0);
  if (code < 0x80) return `%${code.toString(16).toUpperCase().padStart(2, "0")}`;
  return encodeURIComponent(c);
}

/**
 * Same-host relative target, normalised to the alphabet callback.open
 * accepts (a quote, for instance, survives encodeURIComponent unescaped).
 * @param {URL} u
 * @returns {string}
 */
function _dest(u) {
  return Array.from(`${u.pathname}${u.search}${u.hash}`)
    .map((c) => (SAFE.test(c) ? c : _pct(c)))
    .join("");
}

/**
 * Wrap an absolute app URL in the same-site bounce, on the SAME host.
 * The bounce lives under the target's own endpoint directory
 * (`/-/` → `/-/svc/`, `/-/preview/` → `/-/preview/svc/`, `/` → `/svc/`).
 * Anything that does not parse is returned unchanged.
 * @param {string} url absolute http(s) URL into the app
 * @returns {string}
 */
function bounceLink(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch (e) {
    return url;
  }
  if (!/^https?:$/.test(u.protocol)) return url;
  // The endpoint directory: drop a target that is itself a service call
  // (/-/svc/media.download → /-/), the last segment, and the stray double
  // slash some builders leave (homepath() + "/#/…").
  const dir = u.pathname
    .replace(/\/svc\/.*$/, "/")
    .replace(/[^/]*$/, "")
    .replace(/\/{2,}/g, "/") || "/";
  return `${u.origin}${dir}svc/?service=callback.open&dest=${encodeURIComponent(_dest(u))}`;
}

module.exports = { bounceLink };
