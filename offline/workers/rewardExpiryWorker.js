/**
 * @license
 * Copyright 2024 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3
 * https://www.gnu.org/licenses/agpl-3.0.html
 * =============================================================================
 *
 * Reward Expiry Warning Worker
 *
 * Warns claim-reward winners whose 5 years of unlimited storage are about to
 * end AND who are over the free allowance they will fall back to. Three
 * touches: 30 days out, 7 days out, and the day the term ends.
 *
 * THIS WORKER IS NOT LOAD-BEARING. The term itself ends at READ time, inside
 * yp.get_quota / disk_limit / disk_free / my_disk_limit. If this process is
 * never installed, never scheduled, or dies quietly, the allowance still drops
 * on the right day and enforcement still holds -- the users simply are not
 * warned. That is deliberate: a notification feature must not be able to break
 * the entitlement it describes, and nothing here should ever be given a job
 * that correctness depends on.
 *
 * Selection lives in SQL (yp.reward_expiry_due), not here. That proc answers
 * "who, at which stage", already excluding users under the allowance -- for whom
 * expiry changes a number and nothing else. This file is delivery only.
 *
 * WHAT IT NEVER DOES
 *
 * It never deletes anything, never touches quota rows, and never changes an
 * entitlement. The reward was a gift; when it ends the allowance returns to free
 * and files stay put, readable and shareable, indefinitely. Contrast
 * offline/subscription/downgrade.js, which for a LAPSED PAID PLAN escalates to
 * clean() and removes hubs outright. An unpaid invoice and an expired present
 * are not the same thing and must not share that ladder.
 *
 * Schedule: daily at 03:00 UTC, after expiryWorker's 02:00 trash purge so the
 * usage figures it reads are post-purge. Override with REWARD_EXPIRY_SCHEDULE.
 *
 * DRY RUN: set REWARD_EXPIRY_DRY_RUN=1 to log exactly what would be sent and
 * write nothing. Worth having by default on a job whose first real firing is
 * years after it was written, against ~100 addresses that have had five years to
 * go stale.
 */

const { resolve } = require('path');
const { CronJob } = require('cron');
const { Mariadb, RedisStore, Messenger, Cache, sysEnv, toArray } = require('@drumee/server-essentials');
const { isEmpty } = require('lodash');
const { readFileSync } = require('fs');

const WORKER_NAME = process.env.WORKER_NAME || 'reward-expiry-worker-1';
const SCHEDULE = process.env.REWARD_EXPIRY_SCHEDULE || '0 3 * * *';
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.REWARD_EXPIRY_DRY_RUN || '');
const TEMPLATE = resolve(__dirname, '..', '..', 'service', 'private', 'templates',
  'butler', 'reward-expiry-warning.html');

/** The actor on a system-generated contact_activity row. There is no human
 *  sender, and the column is NOT NULL; this is the same sentinel identity the
 *  seeded free quota row uses, so "system did it" reads consistently. */
const SYSTEM_UID = 'ffffffffffffffff';

/** Every stage, most urgent first. Used to mark the ones a catch-up run skipped:
 *  a user first seen at 5 days out gets the 7-day mail, and 30 is recorded as
 *  superseded so it can never fire afterwards saying "30 days remaining". */
const STAGES = [30, 7, 0];

let yp;
let redisInitialized = false;

async function initialize() {
  yp = new Mariadb({ name: 'yp' });
  console.log(`[RewardExpiry] Database connected`);
  // Locale + sysconf, for the support address and message catalogue.
  try {
    await Cache.load(yp);
  } catch (e) {
    console.warn(`[RewardExpiry] Cache.load failed, continuing:`, e && e.message);
  }
  try {
    await RedisStore.prototype.init.call(new RedisStore());
    redisInitialized = true;
    console.log(`[RewardExpiry] RedisStore initialized`);
  } catch (e) {
    // WS push is a nicety; the activity row and the email carry the message.
    console.warn(`[RewardExpiry] RedisStore unavailable, continuing without WS:`, e && e.message);
  }
}

/** Bytes -> a short human string. Deliberately local: this is display copy for
 *  one email, and pulling in a client-side formatter for it would be worse. */
function filesize(n) {
  const b = Number(n) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = b;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i += 1; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** The recipient's own host, bounced through callback.portal_return.
 *
 *  Two things make a naive link land the user signed out: the session cookie is
 *  HOST-scoped, so an org member's session lives on their org vhost rather than
 *  the main domain; and it is SameSite=Strict, so it is withheld entirely on a
 *  cross-site click out of a mail client. Same mechanism as the storage-alert
 *  mail in admin-dash-server and the billing receipt. */
function appLink(vhost, path) {
  const { main_domain, protocol } = sysEnv() || {};
  const host = vhost || main_domain || 'drumee.com';
  const p = `/${String(path || '').replace(/^\/+/, '')}`;
  return `${protocol || 'https'}://${host}/svc/?service=callback.portal_return&redirect=${encodeURIComponent(p)}`;
}

let _sender;
function butlerSender() {
  if (_sender !== undefined) return _sender;
  try {
    const f = resolve(sysEnv().credential_dir, 'email.json');
    _sender = (JSON.parse(readFileSync(f, 'utf8')).auth || {}).user || null;
  } catch (e) {
    _sender = null;
  }
  return _sender;
}

/** Record the send. This row is BOTH the in-app notification the activity feed
 *  renders (via yp.contact_reward_expiry_unread) and the ledger
 *  yp.reward_expiry_due reads to know it has been done -- which is why there is
 *  no separate table tracking what was sent.
 *
 *  SUPERSEDED rows carry no user-visible message. They exist only to close off a
 *  stage a catch-up run jumped over, so a "30 days remaining" mail can never go
 *  out afterwards. They are inserted with dismissed_at ALREADY SET, because the
 *  feed proc filters on `dismissed_at IS NULL` like every other one -- without
 *  that the user would see a stack of blank notifications.
 *
 *  INSERT ... SELECT with a NOT EXISTS guard rather than a bare INSERT: a stage
 *  can already hold a real row (the user was mailed at 30, then crossed into the
 *  7-day window), and re-inserting it as superseded would both duplicate the
 *  ledger and, worse, sit a dismissed duplicate next to a genuine notification.
 *  Observed in the scratch run before this guard existed. */
async function record(uid, stage, data, superseded) {
  const payload = JSON.stringify({ ...data, stage, superseded: superseded ? 1 : 0 });
  await yp.await_query(
    `INSERT INTO contact_activity (timestamp, uid, target_uid, event, data, dismissed_at)
     SELECT UNIX_TIMESTAMP(), ?, ?, 'reward_expiry_warning', ?,
            IF(? = 1, UNIX_TIMESTAMP(), NULL)
      FROM (SELECT 1) x
     WHERE NOT EXISTS (
       SELECT 1 FROM contact_activity ca
        WHERE ca.target_uid = ?
          AND ca.event = 'reward_expiry_warning'
          AND CAST(JSON_VALUE(ca.data, '$.stage') AS SIGNED) = ?)`,
    SYSTEM_UID, uid, payload, superseded ? 1 : 0, uid, stage
  );
}

async function notify(uid) {
  if (!redisInitialized) return false;
  try {
    const recipients = await yp.await_proc('user_sockets', uid);
    if (isEmpty(recipients)) return false;
    await RedisStore.sendData(
      { service: 'notification.resync', data: {} }, recipients
    );
    return true;
  } catch (e) {
    console.warn(`[RewardExpiry] WS resync failed for ${uid}:`, e && e.message);
    return false;
  }
}

async function sendWarning(row) {
  const stage = Number(row.stage);
  const endDate = new Date(Number(row.period_end) * 1000)
    .toISOString().slice(0, 10);
  const used = filesize(row.used_bytes);
  const free = filesize(row.free_bytes);
  const excess = filesize(row.excess_bytes);

  // The recipient's own vhost, so the session cookie is in scope.
  let vhost = null;
  try {
    const org = toArray(await yp.await_proc('my_organisation', row.uid))[0];
    vhost = (org && org.link) || null;
  } catch (e) { /* solo user, no org: main domain is correct */ }

  // contact@drumee.org is what the other butler mails use (stripe_webhook.js in
  // three places, otp.js), and there is no support_email sysconf provisioned --
  // so that literal is the convention, with the key honoured if it ever appears.
  const support = Cache.getSysConf('support_email') || 'contact@drumee.org';
  const data = {
    recipient_name: row.fullname || row.email,
    used_label: used,
    free_label: free,
    excess_label: excess,
    end_date: endDate,
    stage,
    storage_link: appLink(vhost, 'settings/storage'),
    team_link: appLink(vhost, 'settings/billing'),
    support_email: support,
  };

  const subject = stage === 0
    ? 'Your free storage boost has ended'
    : `Your free storage boost ends on ${endDate}`;

  if (DRY_RUN) {
    console.log(`[RewardExpiry] DRY RUN would mail ${row.email} stage=${stage} ` +
      `used=${used} free=${free} excess=${excess} ends=${endDate}`);
    return { sent: false, dry: true };
  }

  const msg = new Messenger({ subject, recipient: row.email });
  const html = msg.renderFrom(TEMPLATE, data);
  const sender = butlerSender();
  const from = sender ? `"Drumee" <${sender}>` : undefined;

  // Await the real send. dispatch() is fire-and-forget and returns undefined,
  // which would report success even when delivery failed; send() returns
  // {recipient, error} normally but the rendered HTML STRING when no MTA is
  // configured, and that is not a delivery. Same check as send_storage_alert.
  const result = await msg.send(from ? { html, from } : { html });
  if (!result || typeof result === 'string') return { sent: false, error: 'NO_MTA' };
  if (!isEmpty(result.error)) return { sent: false, error: 'DELIVERY_FAILED' };
  return { sent: true };
}

async function runJob() {
  const started = Date.now();
  console.log(`[RewardExpiry] Run starting${DRY_RUN ? ' (DRY RUN)' : ''}`);
  let due = [];
  try {
    due = toArray(await yp.await_proc('reward_expiry_due'));
  } catch (e) {
    console.error(`[RewardExpiry] reward_expiry_due failed:`, e && e.message);
    return;
  }
  if (!due.length) {
    console.log(`[RewardExpiry] Nobody due. Done in ${Date.now() - started}ms`);
    return;
  }
  console.log(`[RewardExpiry] ${due.length} user(s) due`);

  let sent = 0;
  let failed = 0;
  for (const row of due) {
    if (!row || !row.uid) continue;
    if (!row.email) {
      // No address after five years is entirely possible. Record it anyway, so
      // the run does not retry this user every night forever.
      console.warn(`[RewardExpiry] ${row.uid} has no email; recording stage ${row.stage}`);
      if (!DRY_RUN) await record(row.uid, Number(row.stage), { error: 'NO_EMAIL' }, false);
      failed += 1;
      continue;
    }
    let outcome;
    try {
      outcome = await sendWarning(row);
    } catch (e) {
      console.error(`[RewardExpiry] send threw for ${row.uid}:`, e && e.message);
      outcome = { sent: false, error: 'SEND_THREW' };
    }
    if (outcome.dry) continue;

    const stage = Number(row.stage);
    const base = {
      days_left: Number(row.days_left),
      used_bytes: Number(row.used_bytes),
      free_bytes: Number(row.free_bytes),
      email_sent: outcome.sent ? 1 : 0,
      email_error: outcome.error || null,
    };

    // Recorded whether or not the mail got out. The row is the notification as
    // well as the ledger, so an in-app reader still sees it -- and a permanently
    // undeliverable address must not make this user due again tomorrow, and the
    // night after, until the term ends.
    await record(row.uid, stage, base, false);

    // Any EARLIER stage this run jumped over is closed off now. Without this a
    // user first seen at 5 days out would get the 7-day mail today and a "30
    // days remaining" mail tomorrow, which is simply false.
    for (const s of STAGES) {
      if (s > stage) await record(row.uid, s, { superseded_by: stage }, true);
    }

    await notify(row.uid);
    if (outcome.sent) sent += 1; else failed += 1;
  }
  console.log(`[RewardExpiry] Done: ${sent} sent, ${failed} failed, ` +
    `${Date.now() - started}ms`);
}

async function startWorker() {
  console.log(`[RewardExpiry] Starting worker: ${WORKER_NAME}`);
  console.log(`[RewardExpiry] Schedule: ${SCHEDULE}${DRY_RUN ? ' (DRY RUN)' : ''}`);
  await initialize();

  const job = new CronJob(SCHEDULE, runJob, null, true, 'UTC');
  console.log(`[RewardExpiry] Next run:`, job.nextDate().toISOString());

  process.on('SIGUSR2', async () => {
    console.log(`[RewardExpiry] SIGUSR2 received - manual run`);
    await runJob();
  });
  console.log(`[RewardExpiry] Send SIGUSR2 to trigger a manual run: kill -USR2`, process.pid);

  setInterval(() => {
    console.log(`[RewardExpiry] Heartbeat - next run:`, job.nextDate().toISOString());
  }, 3600000);
}

async function shutdown() {
  console.log(`[RewardExpiry] Shutting down gracefully...`);
  try {
    if (yp && yp.connection) await yp.end();
  } catch (e) {
    console.error(`[RewardExpiry] Error during shutdown:`, e && e.message);
  }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (e) => {
  console.error(`[RewardExpiry] Unhandled rejection:`, e);
});

// `--once` runs a single pass and exits: what a cron entry or a manual check
// wants, without leaving a scheduler resident.
if (process.argv.includes('--once')) {
  initialize()
    .then(runJob)
    .then(() => shutdown())
    .catch((e) => { console.error(`[RewardExpiry] Failed:`, e); process.exit(1); });
} else {
  startWorker().catch((e) => {
    console.error(`[RewardExpiry] Failed to start:`, e);
    process.exit(1);
  });
}
