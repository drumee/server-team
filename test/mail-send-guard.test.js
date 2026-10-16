const assert = require('node:assert/strict');
const test = require('node:test');
const { readdirSync, readFileSync, statSync } = require('node:fs');
const { join, relative } = require('node:path');

const ROOT = join(__dirname, '..');
const DIRECT_SEND = /\bmsg\.(send|dispatch)\(|\bmta\.sendMail\(/;

// The one sanctioned sender, and the developer-only test mailer.
const ALLOWED = new Set(['service/lib/send-mail.js', 'service/devel.js']);

// Files not migrated yet. Each migration task DELETES its lines; when the plan
// is done only ALLOWED remains. Never add to this list.
const PENDING = new Set([
  // Task 7 — notifications & sharing (service/)
  'service/lib/activity-mailer.js',
  'service/private/sharebox.js',
  'service/private/secure_share.js',
  'service/transfer.js',
  // Task 8 — offline workers
  'offline/drumate/backup.js',
  'offline/mail/index.js',
  'offline/notification/sharebox-notification.js',
  'offline/notification/sendmail.js',
  'offline/notification/meeting-notification.js',
  'offline/subscription/downgrade.js',
  'offline/media/transfer.js',
  'offline/workers/rewardExpiryWorker.js',
]);

function filesOf(dir, ext) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesOf(p, ext));
    else if (name.endsWith(ext)) out.push(p);
  }
  return out;
}

test('all mail leaves through service/lib/send-mail.js', () => {
  const offenders = [];
  for (const file of [...filesOf(join(ROOT, 'service'), '.js'), ...filesOf(join(ROOT, 'offline'), '.js')]) {
    const rel = relative(ROOT, file);
    if (ALLOWED.has(rel) || PENDING.has(rel)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (DIRECT_SEND.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `send through sendMail() instead:\n${offenders.join('\n')}`);
});

test('PENDING only lists files that still send directly', () => {
  const stale = [...PENDING].filter((rel) => !DIRECT_SEND.test(readFileSync(join(ROOT, rel), 'utf8')));
  assert.deepEqual(stale, [], `migrated — delete from PENDING:\n${stale.join('\n')}`);
});

test('mail templates: https links only, small enough not to be clipped', () => {
  const dirs = ['service/templates', 'service/private/templates'];
  const problems = [];
  for (const d of dirs) {
    for (const file of filesOf(join(ROOT, d), '.html')) {
      const src = readFileSync(file, 'utf8');
      const rel = relative(ROOT, file);
      if (/href="http:\/\//i.test(src)) problems.push(`${rel}: http:// link`);
      if (/src="http:\/\//i.test(src)) problems.push(`${rel}: http:// image`);
      // Gmail clips at ~102KB of rendered HTML; keep the source well under.
      if (Buffer.byteLength(src) > 80 * 1024) problems.push(`${rel}: ${Buffer.byteLength(src)} bytes`);
    }
  }
  assert.deepEqual(problems, []);
});
