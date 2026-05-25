/**
 * Bull Queue worker — drains drumee:migration jobs, dispatches to the
 * provider-specific importer. Concurrency is intentionally low (2) so a
 * single user's migration doesn't starve other queues.
 */

const { migrationQueue } = require('../queues/migrationQueue');
const { Mariadb } = require('@drumee/server-essentials');
const GoogleDriveImporter = require('./gdrive/importer');

const CONCURRENCY = parseInt(process.env.GDRIVE_WORKER_CONCURRENCY || '2');
const WORKER_NAME = process.env.WORKER_NAME || 'gdrive-worker-1';

console.log(`[GDriveWorker] Starting ${WORKER_NAME}, concurrency=${CONCURRENCY}`);

const yp = new Mariadb({ name: 'yp' });

migrationQueue.process('migrate_google_drive', CONCURRENCY, async (job) => {
  const { job_id } = job.data;
  console.log(`[GDriveWorker] Processing job_id=${job_id}`);
  const importer = new GoogleDriveImporter(job_id, yp);
  await importer.run();
  return { ok: true };
});

process.on('SIGTERM', async () => {
  console.log('[GDriveWorker] SIGTERM');
  await migrationQueue.close();
  if (yp.connection) await yp.end();
  process.exit(0);
});
process.on('SIGINT', async () => {
  console.log('[GDriveWorker] SIGINT');
  await migrationQueue.close();
  if (yp.connection) await yp.end();
  process.exit(0);
});

// Health log every 60s.
setInterval(async () => {
  try {
    const [w, a, c, f] = await Promise.all([
      migrationQueue.getWaitingCount(),
      migrationQueue.getActiveCount(),
      migrationQueue.getCompletedCount(),
      migrationQueue.getFailedCount(),
    ]);
    console.log('[GDriveWorker] Stats:', { waiting: w, active: a, completed: c, failed: f });
  } catch (e) {
    console.error('[GDriveWorker] stats error:', e.message);
  }
}, 60000);
