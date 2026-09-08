/**
 * Google Drive Migration Worker
 *
 * Bull Queue worker that drains drumee:migration jobs and dispatches them to
 * the provider-specific importer. Mirrors the indexWorker.js structure:
 *   - async startWorker() boots Bull AFTER yp + RedisStore are ready
 *   - uncaughtException / unhandledRejection crash the process so pm2 restarts
 *   - SIGTERM / SIGINT close Bull cleanly before exit
 *   - 60s health log
 *
 * Concurrency is intentionally low (2) so a single user's migration doesn't
 * starve the other queues sharing the same Redis instance.
 */

const migrationQueue = require('../queues/migrationQueue');
const { Mariadb } = require('@drumee/server-essentials');
const GoogleDriveImporter = require('./gdrive/importer');
const { markMigrationUsage } = require('./gdrive/mark-usage');

const CONCURRENCY = parseInt(process.env.GDRIVE_WORKER_CONCURRENCY || '2');
const WORKER_NAME = process.env.WORKER_NAME || 'gdrive-worker-1';

console.log(`[GDriveWorker] Starting worker: ${WORKER_NAME}`);
console.log(`[GDriveWorker] Concurrency: ${CONCURRENCY}`);

let yp;

async function processJob(job) {
  console.log(`[GDriveWorker] Processing job ${job.id} for user ${job.data.user_id}`);
  const importer = new GoogleDriveImporter(job, yp);
  const result = await importer.run();
  // Aha moment -> the "Google migration" bar. Marked HERE rather than on a Bull
  // 'completed' listener because this function already holds the worker's
  // long-lived yp handle and the job data; a listener would need its own
  // handle and would fire in whichever process attached it. Awaited but
  // non-throwing (see mark-usage.js), so the job's own result is unaffected.
  await markMigrationUsage(yp, job.data.user_id, result);
  return result;
}

async function startWorker() {
  console.log('[GDriveWorker] Initializing...');

  yp = new Mariadb({ name: 'yp' });

  // Mariadb's pool connects asynchronously. If a job is already waiting when
  // we boot, Bull pulls it the instant `process()` registers — and the
  // importer would query an unconnected handle. Ping first so the pool is
  // live before we accept work.
  try {
    await yp.await_query('SELECT 1');
  } catch (e) {
    console.error('[GDriveWorker] yp not ready, retrying once in 2s:', e && e.message);
    await new Promise((r) => setTimeout(r, 2000));
    await yp.await_query('SELECT 1'); // throw → crash → pm2 restarts
  }

  // The shared yp connection is long-lived and used by every job for the
  // per-file filecap lookup. If it drops (wait_timeout / network idle) the
  // driver emits an async socket 'error' with no pending query — without a
  // listener that becomes an uncaught exception (see the process handler
  // below). Attach a listener so a drop degrades to reconnect-on-next-query
  // (the Mariadb wrapper re-dials via its isValid() check) instead of a crash.
  try {
    const c = typeof yp.connection === 'function' && yp.connection();
    if (c && typeof c.on === 'function') {
      c.on('error', (e) =>
        console.warn('[GDriveWorker] yp socket error (reconnect on next query):', e && (e.code || e.message)));
    }
  } catch (_) {}

  migrationQueue.process('migrate_google_drive', CONCURRENCY, processJob);

  console.log('[GDriveWorker] Worker started, waiting for jobs...');

  setInterval(async () => {
    try {
      const stats = await migrationQueue.getStats();
      console.log('[GDriveWorker] Queue stats:', {
        waiting: stats.waiting,
        active: stats.active,
        completed: stats.completed,
        failed: stats.failed,
        worker: WORKER_NAME,
      });
    } catch (e) {
      console.error('[GDriveWorker] stats error:', e.message);
    }
  }, 60000);
}

async function shutdown() {
  console.log('[GDriveWorker] Shutting down gracefully...');
  try {
    await migrationQueue.close();
    console.log('[GDriveWorker] Queue closed');
  } catch (e) {
    console.error('[GDriveWorker] Error during shutdown:', e.message);
  }
  try {
    if (yp && yp.connection) await yp.end();
  } catch (e) {
    console.error('[GDriveWorker] yp.end error:', e.message);
  }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

process.on('uncaughtException', (error) => {
  // A dropped DB socket surfaces here as a fatal async error with no pending
  // query (errno 45009 / ER_SOCKET_UNEXPECTED_CLOSE / PROTOCOL_CONNECTION_LOST /
  // ECONNRESET). The Mariadb wrapper re-dials on the next query (isValid check),
  // so it's recoverable — log and KEEP the worker (and every in-flight import)
  // alive rather than crashing mid-migration, which would leave the imported
  // tree half-populated (files after the drop silently never land). Any other
  // uncaught error still exits so pm2 restarts a genuinely broken worker.
  const blob = `${(error && error.code) || ''} ${(error && error.message) || ''}`;
  const recoverableDbDrop =
    error && (error.fatal || error.errno === 45009) &&
    /SOCKET|CONNECTION_LOST|CLOSED|ECONNRESET|EPIPE|ETIMEDOUT|08S01/i.test(blob);
  if (recoverableDbDrop) {
    console.warn('[GDriveWorker] recoverable DB connection drop (continuing):', blob.trim());
    return;
  }
  console.error('[GDriveWorker] Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[GDriveWorker] Unhandled rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

startWorker().catch((error) => {
  console.error('[GDriveWorker] Failed to start worker:', error);
  process.exit(1);
});

console.log('[GDriveWorker] Worker process started (PID:', process.pid, ')');
