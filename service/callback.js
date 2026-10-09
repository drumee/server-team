/**
 * @license
 * Copyright 2024 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.gnu.org/licenses/agpl-3.0.html
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

const {Entity} = require('@drumee/server-core');

// The Stripe webhook now lives in service/public/stripe_webhook.js (signature
// verified, idempotent, no secret logging). callback.js keeps only the two
// UX-only Checkout return redirects. Entitlement is applied by the webhook;
// the FE plan updates via the WS payment.plan_updated event.
class __callback extends Entity {
  // The desk path every bounce below redirects to — RELATIVE, path only, never
  // a host. Two separate reasons, and both have to hold or the user lands
  // signed out.
  //
  // 1. The bounce itself. Each of these is the return leg of a cross-site
  //    top-level navigation (back from checkout.stripe.com / billing.stripe.com,
  //    or a link clicked in Gmail). The session cookie is SameSite=Strict, so
  //    the browser withholds it on that FIRST request. Landing straight on the
  //    SPA would boot it cookie-less → yp.get_env sees a guest → the user
  //    appears logged out. This tiny HTML page makes the arrival a SAME-SITE
  //    navigation (our own script setting location), so the cookie IS sent on
  //    the desk load.
  //
  // 2. No host. The session cookie is HOST-scoped, and an org member's session
  //    lives on their org vhost (team-5202.drumee.in). homepath() answers the
  //    CONFIGURED base domain — Input.domain() maps the request host onto
  //    public_domain/private_domain/main_domain — so an absolute redirect jumps
  //    off the vhost onto drumee.in, where that cookie does not exist. Keeping
  //    only homepath's PATH preserves the endpoint segment (/-/<endpoint>/)
  //    while the browser keeps the host it is already on.
  //
  // portal_return was fixed this way (verified live). check_out_success and
  // check_out_cancel kept the absolute form and carried the same defect, which
  // is why a plan CTA taken through to Stripe and back — paid OR cancelled —
  // could drop an org user onto the base domain's login / onboarding
  // (reported 2026-09-08). They share this helper now so the two cannot drift
  // apart again. Note the return URLs themselves must also stay on the
  // caller's host — see payment.checkout's svcbase.
  _deskPath() {
    let path = '/';
    try { path = new URL(this.input.homepath()).pathname || '/'; } catch (e) { }
    if (!/\/$/.test(path)) path = `${path}/`;
    return path;
  }

  async check_out_cancel() {
    // ?checkout=cancel lets the desk show the payment-failure/cancel modal.
    this.output.html(`<script> window.location.href = '${this._deskPath()}?checkout=cancel#/desk/' </script>`);
  }

  async check_out_success() {
    // Carry the Checkout Session id back so the desk can show the payment-success
    // modal with real receipt details (payment.checkout_result). The id is
    // whitelisted to Stripe's session-id alphabet before being echoed into HTML.
    const sid = String(this.input.use('session_id', '')).replace(/[^a-zA-Z0-9_]/g, '');
    const flag = sid ? `?checkout=success&session_id=${sid}` : '?checkout=success';
    this.output.html(`<script> window.location.href = '${this._deskPath()}${flag}#/desk/' </script>`);
  }

  // Contact-invitation email links (contact._joinLink / _acceptLink). Same
  // same-site bounce as portal_return — a click out of a mail client is a
  // cross-site navigation, the SameSite=Strict session cookie is withheld on
  // it, and the recipient who IS signed in was shown the sign-in page — but it
  // has to land on the welcome route that carries the invitation, not the
  // desk. The hash is REBUILT here from strictly validated values, never
  // echoed: this writes into a <script>.
  async contact_invite() {
    const ID = /^[0-9a-f]{16}$/;
    const TOKEN = /^[A-Za-z0-9_-]{8,128}$/;
    const accept = String(this.input.use('contact_accept', ''));
    const forUid = String(this.input.use('for', ''));
    const token = String(this.input.use('contact_invite', ''));
    const email = String(this.input.use('email', ''));
    let hash = '#/desk/';
    if (ID.test(accept) && ID.test(forUid)) {
      hash = `#/welcome/signin?contact_accept=${accept}&for=${forUid}`;
    } else if (TOKEN.test(token)) {
      const q = [];
      // Prefill only; anything unexpected is dropped rather than encoded.
      if (/^[^\s@'"<>\\]+@[^\s@'"<>\\]+$/.test(email) && email.length <= 254) {
        q.push(`email=${encodeURIComponent(email)}`);
      }
      q.push(`contact_invite=${token}`);
      hash = `#/welcome/signup?${q.join('&')}`;
    }
    this.output.html(`<script> window.location.href = '${this._deskPath()}${hash}' </script>`);
  }

  // Any app link mailed out (service/lib/email-link.js bounceLink): the same
  // same-site bounce as portal_return, to a path + hash on THIS host. `dest`
  // must be a same-host absolute path ("/…", never "//…" or "/\…", no scheme)
  // drawn from a URL-safe alphabet with no quote, backslash, angle bracket or
  // whitespace — it is written into a <script>. Anything else lands on the
  // desk, as portal_return does.
  async open() {
    const dest = String(this.input.use('dest', ''));
    const ok = dest.length <= 2048
      && /^\/(?![\/\\])[A-Za-z0-9\-._~!$&()*+,;=:@%\/?#]*$/.test(dest);
    const to = ok ? dest : `${this._deskPath()}#/desk/`;
    this.output.html(`<script> window.location.href = '${to}' </script>`);
  }

  // Stripe Billing Portal return_url, and the "Open Drumee" target in outgoing
  // emails. See _deskPath above for why this is a bounce and why it is relative.
  async portal_return() {
    this.output.html(`<script> window.location.href = '${this._deskPath()}#/desk/' </script>`);
  }
}

module.exports = __callback;
