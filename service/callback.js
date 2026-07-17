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

  // Stripe Billing Portal return. The portal's return_url points HERE (a
  // same-origin /svc endpoint) rather than straight at the desk, on purpose:
  // the session cookie is SameSite=Strict, so it is withheld on the FIRST
  // request of a cross-site top-level navigation (the browser coming back from
  // billing.stripe.com). Landing directly on the SPA would boot it without the
  // cookie → yp.get_env sees a guest → the user appears logged out. This tiny
  // HTML bounce turns the return into a SAME-SITE navigation (drumee.in's own
  // script setting location), so the cookie IS sent on the desk load and the
  // session survives — the exact mechanism the checkout success/cancel returns
  // already rely on.
  async portal_return() {
    this.output.html(`<script> window.location.href = '${this.input.homepath()}#/desk/' </script>`);
  }
}

module.exports = __callback;
