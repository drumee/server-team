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
  async check_out_cancel() {
    // ?checkout=cancel lets the desk show the payment-failure/cancel modal.
    this.output.html(`<script> window.location.href = '${this.input.homepath()}?checkout=cancel#/desk/' </script>`);
  }

  async check_out_success() {
    // Carry the Checkout Session id back so the desk can show the payment-success
    // modal with real receipt details (payment.checkout_result). The id is
    // whitelisted to Stripe's session-id alphabet before being echoed into HTML.
    const sid = String(this.input.use('session_id', '')).replace(/[^a-zA-Z0-9_]/g, '');
    const flag = sid ? `?checkout=success&session_id=${sid}` : '?checkout=success';
    this.output.html(`<script> window.location.href = '${this.input.homepath()}${flag}#/desk/' </script>`);
  }

  // Same-site bounce into the desk. Used as the Stripe Billing Portal
  // return_url AND as the "Open Drumee" target in outgoing emails, on purpose:
  // the session cookie is SameSite=Strict, so it is withheld on the FIRST
  // request of a cross-site top-level navigation (coming back from
  // billing.stripe.com, or clicking a link in Gmail). Landing directly on the
  // SPA would boot it without the cookie → yp.get_env sees a guest → the user
  // appears logged out. This tiny HTML bounce turns the arrival into a
  // SAME-SITE navigation (our own script setting location), so the cookie IS
  // sent on the desk load and the session survives.
  //
  // The redirect is RELATIVE (path only, no host): the session cookie is
  // HOST-scoped — an org member's session lives on their org vhost
  // (e.g. team.drumee.in), and homepath() on this cookie-less request resolves
  // to the MAIN domain, which would jump off the vhost and land signed-out
  // (verified live). Keeping only homepath's PATH preserves the endpoint
  // segment (/-/<endpoint>/) while the browser keeps the host.
  async portal_return() {
    let path = '/';
    try { path = new URL(this.input.homepath()).pathname || '/'; } catch (e) { }
    if (!/\/$/.test(path)) path = `${path}/`;
    this.output.html(`<script> window.location.href = '${path}#/desk/' </script>`);
  }
}

module.exports = __callback;
