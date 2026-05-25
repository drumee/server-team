/**
 * Bull queue for external-provider migration jobs (Google Drive, etc.).
 * Each job carries `{ job_id }` — the worker reads the full job spec from
 * the migration_jobs row (avoids stale data + lets cancel() take effect
 * by mutating the row from the request side).
 */

const Queue = require('bull');

const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

console.log('[MigrationQueue] Connecting to Redis:', `${redisConfig.host}:${redisConfig.port}`);

const migrationQueue = new Queue('drumee:migration', {
  redis: redisConfig,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10000 },
    removeOnComplete: 100,
    removeOnFail: false,
  },
});

migrationQueue.on('error',     (err) => console.error('[MigrationQueue] Error:', err.message));
migrationQueue.on('waiting',   (id)  => console.log('[MigrationQueue] Waiting:', id));
migrationQueue.on('active',    (job) => console.log('[MigrationQueue] Active:', job.id, job.data));
migrationQueue.on('completed', (job) => console.log('[MigrationQueue] Completed:', job.id));
migrationQueue.on('failed',    (job, err) => console.error('[MigrationQueue] Failed:', job.id, err.message));

module.exports = { migrationQueue };
