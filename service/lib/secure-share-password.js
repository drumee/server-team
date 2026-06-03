/**
 * Password hashing and verification for secure-share links.
 * Uses Node.js built-in crypto (pbkdf2 + timingSafeEqual) — no extra dependencies.
 */
const { pbkdf2Sync, randomBytes, timingSafeEqual } = require('crypto');

const ITERATIONS = 10000;
const KEYLEN     = 64;
const DIGEST     = 'sha512';

/**
 * Hash a plain-text password for storage.
 * Returns "salt:hash" (both hex-encoded).
 */
function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = pbkdf2Sync(password, salt, ITERATIONS, KEYLEN, DIGEST).toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Verify a submitted password against a stored "salt:hash" string.
 * Uses constant-time comparison to prevent timing attacks.
 */
function verifyPassword(submitted, stored) {
  if (!submitted || !stored) return false;
  const sep = stored.indexOf(':');
  if (sep === -1) return false;
  const salt = stored.slice(0, sep);
  const expectedHex = stored.slice(sep + 1);
  if (!salt || !expectedHex) return false;
  try {
    const derived = pbkdf2Sync(submitted, salt, ITERATIONS, KEYLEN, DIGEST).toString('hex');
    const a = Buffer.from(expectedHex, 'hex');
    const b = Buffer.from(derived, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword };
