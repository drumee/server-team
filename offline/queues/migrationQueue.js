/**
 * Migration Queue (Bull) for external-provider imports (Google Drive, etc.).
 *
 * Mirrors the indexQueue.js pattern:
 *  - 3-tier Redis config lookup
 *  - prefix `drumee:queue` so all Drumee Bull queues live under one namespace
 *  - retry with exponential backoff (10s, 20s, 40s) — import is slower than
 *    indexing so we wait longer between attempts
 *  - 30-minute per-job timeout (long folder trees, large downloads)
 *
 * Bull-only architecture: job state lives entirely in Bull (waiting/active/
 * completed/failed) + `job.progress` (a JSON object carrying processed_files,
 * total_files, etc.) + `job.returnvalue` (final summary). No DB state table.
 *
 * Cancellation uses a Redis sentinel key `gdrive:cancel:<job_id>` with a 1h
 * TTL. The worker polls that key between files (see importer.js).
 */

const Queue = require('bull');
const { resolve } = require('path');
const { readFileSync } = require('jsonfile');
const { existsSync } = require('fs');

// Load Redis configuration (3-tier lookup, same order as indexQueue) //
const credential_dir = process.env.credential_dir || '/etc/drumee/credential';
const instance = process.env.instance_name || '';

const redisConfFile = resolve(credential_dir, instance, 'redis-config.json');
const defaultConfFile = '/etc/drumee/credential/redis.json';
const fallbackConfFile = '/etc/drumee/infrastructure/redis-config.json';

let conf = {};
if (existsSync(redisConfFile)) {
  conf = readFileSync(redisConfFile);
} else if (existsSync(defaultConfFile)) {
  conf = readFileSync(defaultConfFile);
} else if (existsSync(fallbackConfFile)) {
  conf = readFileSync(fallbackConfFile);
} else {
  console.warn('[MigrationQueue] No Redis config found, using defaults');
}

const redisConfig = {
  host: conf.redisHost || 'localhost',
  port: conf.redisPort || 6379,
  password: conf.redisAuth || undefined,
  db: conf.redisDb || 0,
};

console.log(`[MigrationQueue] Connecting to Redis: ${redisConfig.host}:${redisConfig.port}`);

const CANCEL_PREFIX = 'gdrive:cancel:';
const CANCEL_TTL_SEC = 3600; // 1h — worker polls between files; a long-running
                             // job that survives past 1h likely doesn't need
                             // the sentinel anymore (user has moved on).

const migrationQueue = new Queue('drumee:migration', {
  redis: redisConfig,
  prefix: 'drumee:queue',
  // Lock tolerance: an import can briefly hold the event loop (large file
  // copy, big scratch cleanup) — give the lock headroom + tolerate transient
  // stalls so a long migration doesn't fail with "stalled more than allowable
  // limit". The importer also uses async fs I/O to keep the loop free.
  settings: {
    lockDuration: 60000,     // 60s (default 30s)
    lockRenewTime: 30000,    // renew at half the duration
    stalledInterval: 60000,  // stall-check cadence (default 30s)
    maxStalledCount: 3,      // tolerate a few transient stalls (default 1)
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 10000, // 10s → 20s → 40s
    },
    timeout: 30 * 60 * 1000, // 30 min — long-running import
    removeOnComplete: 100,   // keep last 100 for status polling after finish
    // Cap retained failures so Redis doesn't grow unbounded. Keep recent
    // ones (7 days / 200 max) for status polling + debugging; older ones
    // age out automatically. Fatal errors (NEEDS_RECONNECT, etc.) call
    // job.discard() in the importer so they don't burn all 3 attempts.
    removeOnFail: { age: 7 * 24 * 3600, count: 200 },
  },
});

// Event Handlers for Monitoring //

migrationQueue.on('error',     (err) => console.error('[MigrationQueue] Error:', err.message));
migrationQueue.on('waiting',   (id)  => console.log(`[MigrationQueue] Waiting: ${id}`));
migrationQueue.on('active',    (job) => console.log(`[MigrationQueue] Active: ${job.id} provider=${job.data.provider}`));
migrationQueue.on('completed', (job, result) => {
  console.log(`[MigrationQueue] Completed: ${job.id}`);
  if (result) {
    console.log(`  processed_files: ${result.processed_files || 0}, errors: ${(result.errors || []).length}`);
  }
});
migrationQueue.on('failed', (job, err) => {
  console.error(`[MigrationQueue] Failed: ${job.id} (attempts=${job.attemptsMade}): ${err.message}`);
});
migrationQueue.on('stalled', (job) => {
  console.warn(`[MigrationQueue] Stalled: ${job.id} (worker may have crashed)`);
});

// Helper Functions //

/**
 * Add a Google Drive migration job to the queue.
 *
 * The full job spec lives in `job.data` so the worker is self-contained.
 * Bull preserves job.data as JSON in Redis — fine for the small (<1KB) opts
 * payload, NOT used for per-file error log (that lives in returnvalue +
 * job.progress).
 *
 * @param {object} opts
 * @param {string} opts.user_id              Drumee entity id (FK in audit logs)
 * @param {string} opts.hub_id               Destination hub id
 * @param {string} opts.nid                  Destination folder node id
 * @param {string} [opts.source_folder_id='root']
 * @param {0|1}    [opts.include_shared_drives=0]
 * @param {string} [opts.conflict_policy='skip']  skip | overwrite | rename
 * @returns {Promise<import('bull').Job>}
 */
async function addMigration(opts = {}) {
  const {
    user_id,
    hub_id,
    nid,
    source_folder_id = 'root',
    include_shared_drives = 0,
    conflict_policy = 'skip',
    mode = 'all',
    selections = null,
  } = opts;

  if (!user_id) throw new Error('addMigration: user_id required');
  if (!hub_id)  throw new Error('addMigration: hub_id required');
  if (!nid)     throw new Error('addMigration: nid required');

  const job = await migrationQueue.add('migrate_google_drive', {
    provider: 'google',
    user_id,
    hub_id,
    nid,
    source_folder_id,
    include_shared_drives,
    conflict_policy,
    mode,
    selections,
    queued_at: new Date().toISOString(),
  });

  console.log(`[MigrationQueue] Queued migration job ${job.id} for user ${user_id}`);
  return job;
}

/**
 * Get a job's current status snapshot. Returns null if the job doesn't
 * exist (already removed by `removeOnComplete` or never created).
 */
async function getJobStatus(jobId) {
  try {
    const job = await migrationQueue.getJob(jobId);
    if (!job) return null;
    const state = await job.getState();
    return {
      id: job.id,
      state,                       // waiting | active | completed | failed | delayed | paused
      progress: job.progress(),    // our struct (processed_files, total_files, …)
      attempts: job.attemptsMade,
      timestamp: job.timestamp,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
      failedReason: job.failedReason,
      returnvalue: job.returnvalue,
      data: job.data,
    };
  } catch (e) {
    console.error(`[MigrationQueue] getJobStatus(${jobId}) failed:`, e.message);
    return null;
  }
}

/**
 * Find the most relevant migration job for a user WITHOUT knowing its id.
 * Scans the (bounded — removeOnComplete:100 / removeOnFail:200) retained jobs
 * and filters by job.data.user_id. Prefers an in-flight job
 * (active/waiting/delayed/paused); otherwise returns the most recently
 * finished one. Returns the same snapshot shape as getJobStatus, or null.
 *
 * This is the source of truth that lets the FE popup reconnect to a running
 * migration after it was closed / the page reloaded / on another tab.
 */
async function getUserJob(userId) {
  if (!userId) return null;
  try {
    const jobs = await migrationQueue.getJobs(
      ['active', 'waiting', 'delayed', 'paused', 'completed', 'failed'], 0, 300
    );
    const mine = (jobs || []).filter((j) => j && j.data && j.data.user_id === userId);
    if (!mine.length) return null;
    const RUNNING = ['active', 'waiting', 'delayed', 'paused'];
    const withState = [];
    for (const j of mine) {
      let state;
      try { state = await j.getState(); } catch (_) { state = 'unknown'; }
      withState.push({ j, state });
    }
    const running = withState.filter((x) => RUNNING.includes(x.state));
    const pool = running.length ? running : withState;
    // Most recent first (finishedOn for terminal jobs, else enqueue timestamp).
    pool.sort((a, b) =>
      (b.j.finishedOn || b.j.timestamp || 0) - (a.j.finishedOn || a.j.timestamp || 0));
    const picked = pool[0];
    return picked ? await getJobStatus(picked.j.id) : null;
  } catch (e) {
    console.error('[MigrationQueue] getUserJob failed:', e.message);
    return null;
  }
}

/**
 * Cancel a job. For 'waiting'/'delayed' jobs, removes from the queue
 * directly. For 'active' jobs, sets a Redis sentinel key — the worker
 * polls it between files and bails cleanly at the next boundary.
 *
 * Returns `{ ok, terminal, removed, sentinel, state }` so the HTTP layer
 * can shape its response without inspecting Bull internals.
 */
async function cancelJob(jobId) {
  const job = await migrationQueue.getJob(jobId);
  if (!job) return { ok: false, reason: 'not_found' };
  const state = await job.getState();
  if (['completed', 'failed'].includes(state)) {
    return { ok: true, terminal: true, state };
  }
  if (state === 'waiting' || state === 'delayed' || state === 'paused') {
    try {
      await job.remove();
      return { ok: true, removed: true, state };
    } catch (e) {
      console.error(`[MigrationQueue] cancelJob remove failed for ${jobId}:`, e.message);
      return { ok: false, reason: e.message };
    }
  }
  // active — drop the sentinel key and let the worker observe it
  try {
    await migrationQueue.client.set(`${CANCEL_PREFIX}${jobId}`, '1', 'EX', CANCEL_TTL_SEC);
    return { ok: true, sentinel: true, state };
  } catch (e) {
    console.error(`[MigrationQueue] cancel sentinel failed for ${jobId}:`, e.message);
    return { ok: false, reason: e.message };
  }
}

/**
 * Worker-side helper — check whether the cancellation sentinel for this
 * job is set. Cheap Redis GET; called between files.
 */
async function isCancelled(jobId) {
  try {
    const v = await migrationQueue.client.get(`${CANCEL_PREFIX}${jobId}`);
    return !!v;
  } catch (e) {
    return false;
  }
}

/**
 * Counts per state — useful for /metrics, the FE health card, or a CLI.
 */
async function getStats() {
  try {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      migrationQueue.getWaitingCount(),
      migrationQueue.getActiveCount(),
      migrationQueue.getCompletedCount(),
      migrationQueue.getFailedCount(),
      migrationQueue.getDelayedCount(),
    ]);
    return { waiting, active, completed, failed, delayed };
  } catch (e) {
    return { error: e.message };
  }
}

let closed = false;
async function close() {
  if (closed) return;
  closed = true;
  try {
    await migrationQueue.close();
    console.log('[MigrationQueue] Closed');
  } catch (e) {
    console.error('[MigrationQueue] Close error:', e.message);
  }
}

// Graceful Shutdown //

process.on('SIGTERM', async () => {
  console.log('[MigrationQueue] Received SIGTERM, closing gracefully...');
  await close();
  process.exit(0);
});
process.on('SIGINT', async () => {
  console.log('[MigrationQueue] Received SIGINT, closing gracefully...');
  await close();
  process.exit(0);
});

// Exports //

module.exports = migrationQueue;
module.exports.migrationQueue = migrationQueue;
module.exports.addMigration = addMigration;
module.exports.getJobStatus = getJobStatus;
module.exports.getUserJob = getUserJob;
module.exports.cancelJob = cancelJob;
module.exports.isCancelled = isCancelled;
module.exports.getStats = getStats;
module.exports.close = close;
