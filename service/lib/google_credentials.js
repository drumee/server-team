// service/lib/google_credentials.js
//
// Loads the Google Drive OAuth app credentials from
// /etc/drumee/credential/google/drive.json — a dedicated OAuth client for the
// Drive migration feature, separate from the login app (google/info.json read
// by loby/service/google.js). Shape: { id, secret }.
//
// Mirrors the loby file-based pattern instead of DB sysconf so the Drive app
// can be rotated independently of the login app.

const { resolve } = require('path');
const { readFileSync } = require('jsonfile');
const { sysEnv } = require('@drumee/server-essentials');

let _cache = null;

/**
 * @returns {{ id: string, secret: string }} Drive OAuth client id/secret.
 * @throws if the file is missing, malformed, or lacks id/secret.
 */
function googleDriveCredentials() {
  if (_cache) return _cache;
  const { credential_dir } = sysEnv();
  const file = resolve(credential_dir, 'google/drive.json');
  let c;
  try {
    c = readFileSync(file);
  } catch (e) {
    throw new Error(`google/drive.json unreadable (${file}): ${e && e.message}`);
  }
  if (!c || !c.id || !c.secret) {
    throw new Error(`google/drive.json missing id/secret (${file})`);
  }
  _cache = { id: c.id, secret: c.secret };
  return _cache;
}

module.exports = { googleDriveCredentials };
