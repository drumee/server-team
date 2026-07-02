/**
 * Version Retention Worker
 *
 * Scheduled worker that enforces the per-organisation "Versioning Retention
 * Policy" set in the admin console (Storage tab). For every org that opted in
 * (organisation.metadata.version_retention_days), it purges OLD file versions
 * (is_active=0) older than the window across the org's hubs, and refreshes the
 * cached "version history" footprint used by the Versioning Impact card.
 *
 * Model: mirrors expiryWorker.js (trash expiry). DB-only purge, matching the
 * existing file_version_delete_old admin action.
 *
 * Schedule: daily at 3 AM UTC (configurable via VERSION_RETENTION_SCHEDULE).
 */

const { Mariadb } = require('@drumee/server-essentials');

const WORKER_NAME = process.env.WORKER_NAME || 'version-retention-worker-1';
// Hour of day (UTC) for the daily purge. Plain setTimeout scheduler — the
// runtime does not ship the `cron` module (it ships Bull, not cron).
const RUN_HOUR = parseInt(process.env.VERSION_RETENTION_HOUR, 10);
const SCHEDULE_HOUR =
  Number.isInteger(RUN_HOUR) && RUN_HOUR >= 0 && RUN_HOUR <= 23 ? RUN_HOUR : 3;

console.log(`[VersionRetention] Starting worker: ${WORKER_NAME}`);
console.log(`[VersionRetention] Daily run hour (UTC): ${SCHEDULE_HOUR}`);

let yp;

function asArray(x) {
  if (Array.isArray(x)) return x;
  return x == null ? [] : [x];
}

async function initialize() {
  yp = new Mariadb({ name: 'yp' });
  console.log('[VersionRetention] Database connected');
}

/**
 * Enforce retention on a single hub + report its version footprint.
 *
 * @param {Object} hub  - { id, db_name }
 * @param {Number} days - retention window
 * @returns {Promise<{ purged: number, history_bytes: number }>}
 */
async function processHub(hub, days) {
  const { id: hub_id, db_name } = hub;
  let hubDb;
  try {
    hubDb = new Mariadb({ name: db_name });

    // 1) Purge old versions past the retention window (DB-only).
    const purgeRes = asArray(await hubDb.await_proc('file_version_purge_expired', days))[0] || {};
    const purged = parseInt(purgeRes.purged, 10) || 0;

    // 2) Measure the remaining version footprint for the impact cache.
    const sizeRes = asArray(await hubDb.await_proc('get_hub_version_size'))[0] || {};
    const history_bytes = parseInt(sizeRes.history_bytes, 10) || 0;

    if (purged > 0) {
      console.log(`[VersionRetention] hub ${hub_id}: purged ${purged} expired versions`);
    }
    return { purged, history_bytes };
  } catch (error) {
    console.error(`[VersionRetention] Error on hub ${hub_id}:`, error.message);
    return { purged: 0, history_bytes: 0 };
  } finally {
    try {
      if (hubDb && hubDb.connection) await hubDb.end();
    } catch (e) {
      console.error('[VersionRetention] hub close error:', e.message);
    }
  }
}

async function runRetentionJob() {
  const startTime = Date.now();
  console.log('[VersionRetention] ========================================');
  console.log('[VersionRetention] Starting job at:', new Date().toISOString());

  try {
    const orgs = asArray(await yp.await_proc('organisation_list_retention'));
    if (!orgs.length) {
      console.log('[VersionRetention] No orgs with a retention policy — nothing to do');
      return;
    }
    console.log(`[VersionRetention] ${orgs.length} org(s) with a retention policy`);

    let totalPurged = 0;
    for (const org of orgs) {
      const days = parseInt(org.retention_days, 10) || 0;
      if (!days) continue; // 0 = keep everything; skip

      const hubs = asArray(await yp.await_proc('member_list_hubs_by_domain', org.domain_id));
      let historyTotal = 0;
      for (const hub of hubs) {
        if (!hub || !hub.db_name) continue;
        const r = await processHub(hub, days);
        totalPurged += r.purged;
        historyTotal += r.history_bytes;
      }

      // Cache the org-wide old-version footprint for the Versioning Impact card.
      await yp.await_proc('organisation_cache_version_history', org.org_id, historyTotal);
      console.log(
        `[VersionRetention] org ${org.org_id}: ${days}d window, ${hubs.length} hub(s), ` +
        `history=${historyTotal} bytes`
      );
    }

    console.log('[VersionRetention] ========================================');
    console.log(`[VersionRetention] Done in ${Date.now() - startTime}ms, total purged: ${totalPurged}`);
  } catch (error) {
    console.error('[VersionRetention] Job failed:', error);
    console.error(error.stack);
  }
}

async function manualRun() {
  console.log('[VersionRetention] Manual run triggered');
  await runRetentionJob();
}

function msUntilNextRun() {
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), SCHEDULE_HOUR, 0, 0, 0
  ));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

function scheduleDaily() {
  const delay = msUntilNextRun();
  const nextAt = new Date(Date.now() + delay).toISOString();
  console.log(`[VersionRetention] Next run at ${nextAt} (in ${Math.round(delay / 60000)} min)`);
  setTimeout(async () => {
    try {
      await runRetentionJob();
    } finally {
      scheduleDaily(); // reschedule for the following day
    }
  }, delay);
}

async function startWorker() {
  console.log('[VersionRetention] Initializing...');
  await initialize();

  scheduleDaily();

  process.on('SIGUSR2', async () => {
    console.log('[VersionRetention] SIGUSR2 — manual run');
    await manualRun();
  });

  console.log('[VersionRetention] Worker started. Manual run: kill -USR2', process.pid);
}

async function shutdown() {
  console.log('[VersionRetention] Shutting down...');
  try {
    if (yp && yp.connection) await yp.end();
  } catch (error) {
    console.error('[VersionRetention] Shutdown error:', error.message);
  }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', (error) => {
  console.error('[VersionRetention] Uncaught exception:', error);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[VersionRetention] Unhandled rejection:', reason);
  process.exit(1);
});

startWorker().catch((error) => {
  console.error('[VersionRetention] Failed to start worker:', error);
  process.exit(1);
});

console.log('[VersionRetention] Worker process started (PID:', process.pid, ')');

module.exports = { runRetentionJob, manualRun };
