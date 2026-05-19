/**
 * Bull Queue for background trash deletion
 * Handles empty_bin operations asynchronously
 */

const Queue = require('bull');

// Redis configuration
const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  maxRetriesPerRequest: null,
  enableReadyCheck: false
};

console.log('[TrashQueue] Connecting to Redis:', `${redisConfig.host}:${redisConfig.port}`);


const trashQueue = new Queue('trashQueue', {
  redis: redisConfig,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000
    },
    removeOnComplete: 100,
    removeOnFail: false
  }
});

// Event handlers
trashQueue.on('error', (error) => {
  console.error('[TrashQueue] Error:', error.message);
});

trashQueue.on('waiting', (jobId) => {
  console.log('[TrashQueue] Job waiting:', jobId);
});

trashQueue.on('active', (job) => {
  console.log('[TrashQueue] Processing job:', job.id);
});

trashQueue.on('completed', (job, result) => {
  console.log('[TrashQueue] Job completed:', job.id);
});

trashQueue.on('failed', (job, err) => {
  console.error('[TrashQueue] Job failed:', job.id, err.message);
});

/**
 * Add trash cleanup job to queue
 */
async function emptyTrash(uid, hub_id, options = {}) {
  const { socket_id, priority = 5 } = options;
  
  const job = await trashQueue.add('empty_trash', {
    uid,
    hub_id,
    socket_id,
    timestamp: Date.now()
  }, {
    priority
  });
  
  console.log(`[TrashQueue] Added empty_trash job: ${job.id} for hub: ${hub_id}`);
  
  return job;
}

/**
 * Get queue statistics
 */
async function getStats() {
  const [waiting, active, completed, failed] = await Promise.all([
    trashQueue.getWaitingCount(),
    trashQueue.getActiveCount(),
    trashQueue.getCompletedCount(),
    trashQueue.getFailedCount()
  ]);
  
  return { waiting, active, completed, failed };
}

module.exports = {
  trashQueue,
  emptyTrash,
  getStats
};