/**
 * @license
 * Copyright 2026 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3
 */

// service/lib/unsubscribe-token.js
// Signs the one-click unsubscribe link carried in the List-Unsubscribe header
// of notification mail (service/lib/send-mail.js) and verifies it when the
// mailbox provider posts it back (callback.unsubscribe).
//
// THE SIGNATURE IS THE AUTHORISATION. The endpoint has no session — Gmail
// posts to it on the user's behalf — so anything unsigned must change nothing.
// The secret lives in credential_dir/unsubscribe.json ({"secret": "<>=32
// chars>"}), created at deploy. Without it nothing is signed and notification
// mail goes out WITHOUT the header rather than with a link that cannot work.
//
// The address is case-folded before signing: providers echo the URL verbatim,
// but the same person can be mailed as John@ and john@ from different paths.

const crypto = require("crypto");
const { readFileSync } = require("fs");
const { resolve } = require("path");

let _secret;

function _loadSecret() {
  if (_secret !== undefined) return _secret;
  _secret = null;
  try {
    // Lazy: server-essentials reads its environment at require time.
    const { sysEnv } = require("@drumee/server-essentials");
    const file = resolve(sysEnv().credential_dir, "unsubscribe.json");
    const secret = JSON.parse(readFileSync(file, "utf8")).secret;
    if (typeof secret === "string" && secret.length >= 32) _secret = secret;
  } catch (e) {
    _secret = null;
  }
  return _secret;
}

/** Test seam: a string sets the secret, null forces "none", undefined reloads. */
function _setSecretForTest(secret) {
  _secret = secret;
}

function _norm(email) {
  return String(email == null ? "" : email).trim().toLowerCase();
}

/**
 * @param {string} email
 * @returns {string|null} base64url HMAC-SHA256, null without a secret/address
 */
function sign(email) {
  const secret = _loadSecret();
  const addr = _norm(email);
  if (!secret || !addr) return null;
  return crypto
    .createHmac("sha256", secret)
    .update(`unsubscribe:${addr}`)
    .digest("base64url");
}

/**
 * @param {string} email
 * @param {string} sig
 * @returns {boolean}
 */
function verify(email, sig) {
  const want = sign(email);
  if (!want || typeof sig !== "string" || !sig) return false;
  const a = Buffer.from(want);
  const b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Same base the invite links use (hub.js _endpointBase). */
function appBase() {
  const { sysEnv } = require("@drumee/server-essentials");
  const { main_domain, endpoint_path } = sysEnv();
  return `https://${main_domain}${endpoint_path || "/-"}`;
}

/**
 * @param {string} email
 * @param {string} [base] e.g. "https://drumee.com/-"
 * @returns {string|null}
 */
function unsubscribeUrl(email, base) {
  const sig = sign(email);
  if (!sig) return null;
  const root = base || appBase();
  return `${root}/svc/?service=callback.unsubscribe`
    + `&email=${encodeURIComponent(_norm(email))}&sig=${sig}`;
}

module.exports = { sign, verify, unsubscribeUrl, appBase, _setSecretForTest };
