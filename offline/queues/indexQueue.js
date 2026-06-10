/**
 * SEO Indexing Queue
 * 
 * Bull Queue implementation for scalable document/image indexing
 * Integrates with existing Redis infrastructure
 */

const Queue = require('bull');
const { resolve } = require('path');
const { readFileSync } = require('jsonfile');
const { existsSync } = require('fs');
const { sysEnv } = require('@drumee/server-essentials');
const { data_dir } = sysEnv();
// Load Redis configuration
const credential_dir = process.env.credential_dir || "/etc/drumee/credential";
const instance = process.env.instance_name || "";

let redisConfFile = resolve(credential_dir, instance, "redis-config.json");
let defaultConfFile = "/etc/drumee/credential/redis.json";
let fallbackConfFile = "/etc/drumee/infrastructure/redis-config.json";

let conf = {};
if (existsSync(redisConfFile)) {
  conf = readFileSync(redisConfFile);
} else if (existsSync(defaultConfFile)) {
  conf = readFileSync(defaultConfFile);
} else if (existsSync(fallbackConfFile)) {
  conf = readFileSync(fallbackConfFile);
} else {
  console.warn('[IndexQueue] No Redis config found, using defaults');
}

// Redis configuration
const redisConfig = {
  host: conf.redisHost || 'localhost',
  port: conf.redisPort || 6379,
  password: conf.redisAuth || undefined,
  db: conf.redisDb || 0
};

console.log(`[IndexQueue] Connecting to Redis: ${redisConfig.host}:${redisConfig.port}`);

/**
 * Create Bull Queue for SEO indexing
 */
const indexQueue = new Queue('drumee:seo-indexing', {
  redis: redisConfig,
  prefix: 'drumee:queue',
  defaultJobOptions: {
    // Retry strategy
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000 // 2s, 4s, 8s
    },

    timeout: 300000, // 5 minutes max

    // Job retention
    removeOnComplete: 100, // Keep last 100 completed
    removeOnFail: true     // Clear queue after all attempts exhausted
  }
});

// Bull's native close, captured BEFORE `module.exports.close = close` (below)
// overwrites indexQueue.close. Since `module.exports = indexQueue`, that
// assignment replaces the Bull method with our wrapper, so a wrapper that calls
// `indexQueue.close()` would call itself → infinite recursion ("Maximum call
// stack size exceeded"), which crash-loops the indexWorker on shutdown.
const _bullClose = indexQueue.close.bind(indexQueue);

// Event Handlers for Monitoring //

indexQueue.on('error', (error) => {
  console.error('[IndexQueue] Queue error:', error.message);
  console.error(error.stack);
});

indexQueue.on('waiting', (jobId) => {
  console.log(`[IndexQueue] Job ${jobId} waiting`);
});

indexQueue.on('active', (job) => {
  console.log(`[IndexQueue] Job ${job.id} started: ${job.data.node?.filename || 'unknown'}`);
});

indexQueue.on('completed', (job, result) => {
  console.log(`[IndexQueue] Job ${job.id} completed successfully`);
  console.log(`  File: ${result.filename || 'unknown'}`);
  console.log(`  Words: ${result.words || 0}`);
  console.log(`  Duration: ${result.duration || 0}ms`);
});

indexQueue.on('failed', (job, err) => {
  console.error(`[IndexQueue] Job ${job.id} failed after ${job.attemptsMade} attempts`);
  console.error(`  File: ${job.data.node?.filename || 'unknown'}`);
  console.error(`  Error: ${err.message}`);

  try {
    const { Syslog } = require('@drumee/server-essentials');
    Syslog.error('[IndexQueue] Job failed', {
      job_id: job.id,
      filename: job.data.node?.filename,
      error: err.message
    });
  } catch (e) {
  }
});

indexQueue.on('stalled', (job) => {
  console.warn(`[IndexQueue] Job ${job.id} stalled (worker may have crashed)`);
});

indexQueue.on('progress', (job, progress) => {
  console.log(`[IndexQueue] Job ${job.id} progress: ${progress}%`);
});

indexQueue.on('removed', (job) => {
  console.log(`[IndexQueue] Job ${job.id} removed from queue`);
});

indexQueue.on('cleaned', (jobs, type) => {
  console.log(`[IndexQueue] Cleaned ${jobs.length} ${type} jobs`);
});

// Helper Functions //

/**
 * Add file to indexing queue
 * 
 * @param {Object} node - File node from MFS
 * @param {Object} options - Queue options
 * @returns {Promise<Job>}
 */
async function addFile(node, options = {}) {
  const {
    uid = null,
    socket_id = null,
    hub_id = null,
    priority = null
  } = options;

  // Validation
  if (!node || !node.id || !node.hub_id || !node.xdb) {
    throw new Error('Invalid node: missing id or hub_id xdb');
  }

  // Calculate priority
  let jobPriority = priority;
  if (jobPriority === null) {
    const filesize = node.filesize || 0;
    const category = node.filetype || node.category;

    // Images: Always high priority
    if (category === 'image') {
      jobPriority = 8;
    }
    // PDFs with text: Medium priority
    else if (node.extension === 'pdf' && filesize < 5 * 1024 * 1024) {
      jobPriority = 6;
    }
    // Small documents: High priority
    else if (filesize < 1024 * 1024) {
      jobPriority = 7;
    }
    // Medium files: Normal priority
    else if (filesize < 10 * 1024 * 1024) {
      jobPriority = 5;
    }
    // Large files: Low priority
    else {
      jobPriority = 3;
    }
  }

  // Create unique job ID to prevent duplicates
  const jobId = `${node.hub_id}-${node.id}`;

  try {
    console.log(`[IndexQueue] Adding node`, node);
    node.xpath = node.mfs_root.replace(new RegExp(data_dir), '/data_dir/'); /** Prevent filtering by sanitizer */
    const job = await indexQueue.add('index-file', {
      node,
      uid,
      socket_id,
      hub_id: hub_id || node.hub_id,
      queued_at: new Date().toISOString()
    }, {
      jobId,
      priority: jobPriority,
      removeOnComplete: true,
      removeOnFail: true     // Clear queue after all attempts exhausted
    });

    console.log(`[IndexQueue] Queued: ${node.filename} (job ${job.id}, priority ${jobPriority})`);
    return job;
  } catch (error) {
    console.error(`[IndexQueue] Failed to queue ${node.filename}:`, error.message);
    throw error;
  }
}

/**
 * Get queue statistics
 * 
 * @returns {Promise<Object>}
 */
async function getStats() {
  try {
    const [waiting, active, completed, failed, delayed, paused] = await Promise.all([
      indexQueue.getWaitingCount(),
      indexQueue.getActiveCount(),
      indexQueue.getCompletedCount(),
      indexQueue.getFailedCount(),
      indexQueue.getDelayedCount(),
      indexQueue.isPaused()
    ]);

    return {
      waiting,
      active,
      completed,
      failed,
      delayed,
      paused,
      total: waiting + active + delayed
    };
  } catch (error) {
    console.error('[IndexQueue] Failed to get stats:', error.message);
    return {
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      paused: false,
      total: 0,
      error: error.message
    };
  }
}

/**
 * Get job status by ID
 * 
 * @param {String} jobId
 * @returns {Promise<Object|null>}
 */
async function getJobStatus(jobId) {
  try {
    const job = await indexQueue.getJob(jobId);
    if (!job) return null;

    const state = await job.getState();
    return {
      id: job.id,
      state,
      progress: job.progress(),
      attempts: job.attemptsMade,
      timestamp: job.timestamp,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
      failedReason: job.failedReason,
      data: job.data
    };
  } catch (error) {
    console.error(`[IndexQueue] Failed to get job ${jobId}:`, error.message);
    return null;
  }
}

/**
 * Retry a failed job
 * 
 * @param {String} jobId
 * @returns {Promise<void>}
 */
async function retryJob(jobId) {
  try {
    const job = await indexQueue.getJob(jobId);
    if (!job) {
      throw new Error('Job not found');
    }

    await job.retry();
    console.log(`[IndexQueue] Retrying job ${jobId}`);
  } catch (error) {
    console.error(`[IndexQueue] Failed to retry job ${jobId}:`, error.message);
    throw error;
  }
}

/**
 * Retry all failed jobs
 * 
 * @returns {Promise<Number>} - Number of jobs retried
 */
async function retryAllFailed() {
  try {
    const failed = await indexQueue.getFailed();
    let count = 0;

    for (let job of failed) {
      try {
        await job.retry();
        count++;
      } catch (e) {
        console.error(`[IndexQueue] Failed to retry job ${job.id}:`, e.message);
      }
    }

    console.log(`[IndexQueue] Retried ${count} failed jobs`);
    return count;
  } catch (error) {
    console.error('[IndexQueue] Failed to retry all:', error.message);
    return 0;
  }
}

/**
 * Clean old completed jobs
 * 
 * @param {Number} olderThan - Milliseconds (default 24 hours)
 * @returns {Promise<Number>} - Number of jobs cleaned
 */
async function cleanOldJobs(olderThan = 24 * 3600 * 1000) {
  try {
    const cleaned = await indexQueue.clean(olderThan, 'completed');
    console.log(`[IndexQueue] Cleaned ${cleaned.length} old completed jobs`);
    return cleaned.length;
  } catch (error) {
    console.error('[IndexQueue] Failed to clean old jobs:', error.message);
    return 0;
  }
}

/**
 * Pause the queue
 */
async function pause() {
  try {
    await indexQueue.pause();
    console.log('[IndexQueue] Queue paused');
  } catch (error) {
    console.error('[IndexQueue] Failed to pause:', error.message);
    throw error;
  }
}

/**
 * Resume the queue
 */
async function resume() {
  try {
    await indexQueue.resume();
    console.log('[IndexQueue] Queue resumed');
  } catch (error) {
    console.error('[IndexQueue] Failed to resume:', error.message);
    throw error;
  }
}

/**
 * Get queue health status
 * 
 * @returns {Promise<Object>}
 */
async function getHealth() {
  try {
    const stats = await getStats();
    const isPaused = await indexQueue.isPaused();

    // Consider unhealthy if:
    // - Queue is paused
    // - Failed rate > 10%
    // - Too many waiting jobs (> 1000)
    const totalProcessed = stats.completed + stats.failed;
    const failureRate = totalProcessed > 0 ? (stats.failed / totalProcessed) : 0;

    const healthy = !isPaused &&
      failureRate < 0.1 &&
      stats.waiting < 1000;

    return {
      healthy,
      paused: isPaused,
      failureRate: Math.round(failureRate * 100) / 100,
      stats
    };
  } catch (error) {
    console.error('[IndexQueue] Failed to get health:', error.message);
    return {
      healthy: false,
      error: error.message
    };
  }
}

/**
 * Close queue gracefully
 */
async function close() {
  try {
    await _bullClose();
    console.log('[IndexQueue] Queue closed');
  } catch (error) {
    console.error('[IndexQueue] Error closing queue:', error.message);
  }
}

// Graceful Shutdown //

process.on('SIGTERM', async () => {
  console.log('[IndexQueue] Received SIGTERM, closing gracefully...');
  await close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[IndexQueue] Received SIGINT, closing gracefully...');
  await close();
  process.exit(0);
});

// Export //

module.exports = indexQueue;

// Export helper functions
module.exports.addFile = addFile;
module.exports.getStats = getStats;
module.exports.getJobStatus = getJobStatus;
module.exports.retryJob = retryJob;
module.exports.retryAllFailed = retryAllFailed;
module.exports.cleanOldJobs = cleanOldJobs;
module.exports.pause = pause;
module.exports.resume = resume;
module.exports.getHealth = getHealth;
module.exports.close = close;