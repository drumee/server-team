/**
 * SEO Indexing Worker
 * 
 * Bull Queue worker that processes document/image indexing jobs
 * Integrates with Drumee infrastructure for notifications
 */

const { resolve } = require('path');
const indexQueue = require('../queues/indexQueue');
const { indexFile } = require('../media/seo_lib');
const { Mariadb, RedisStore } = require('@drumee/server-essentials');
let yp;

// Worker configuration
const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '5');
const WORKER_NAME = process.env.WORKER_NAME || 'seo-worker-1';

console.log(`[IndexWorker] Starting worker: ${WORKER_NAME}`);
console.log(`[IndexWorker] Concurrency: ${CONCURRENCY}`);

let redisInitialized = false;

async function initRedis() {
  if (redisInitialized) return;
  try {
    await RedisStore.prototype.init.call(new RedisStore());
    redisInitialized = true;
    yp = new Mariadb({ name: 'yp' });
    console.log('[IndexWorker] RedisStore initialized for notifications');
  } catch (error) {
    console.error('[IndexWorker] Failed to initialize RedisStore:', error.message);
    // Continue without notifications
  }
}

/**
 * Send WebSocket notification to user
 * 
 * @param {Object} data - Job data
 * @param {Object} result - Indexing result
 */
async function sendNotification(data, result) {
  if (!redisInitialized) return;

  const { node, uid, socket_id, hub_id } = data;

  try {
    // Get user sockets

    let recipients = [];

    // Try to get entity sockets (includes all hub members)
    if (hub_id) {
      try {
        recipients = await yp.await_proc('entity_sockets', { hub_id });
      } catch (e) {
        console.warn('[IndexWorker] Failed to get entity_sockets:', e.message);
      }
    }

    // Fallback: get user sockets
    if (!recipients || recipients.length === 0) {
      if (uid) {
        try {
          recipients = await yp.await_proc('user_sockets', uid);
        } catch (e) {
          console.warn('[IndexWorker] Failed to get user_sockets:', e.message);
        }
      }
    }

    // Fallback: use socket_id if provided
    if (!recipients || recipients.length === 0) {
      if (socket_id) {
        recipients = [{ socket_id }];
      }
    }

    await yp.end();

    if (!recipients || recipients.length === 0) {
      console.warn('[IndexWorker] No recipients found for notification');
      return;
    }

    // Send notification
    const payload = {
      service: 'seo.indexed',
      status: result.success ? 'success' : 'error',
      nid: node.id,
      hub_id: node.hub_id,
      filename: node.filename,
      words: result.words || 0,
      duration: result.duration || 0,
      error: result.error || null
    };

    await RedisStore.sendData(payload, recipients);

    console.log(`[IndexWorker] Notification sent to ${recipients.length} recipients`);

  } catch (error) {
    console.error('[IndexWorker] Failed to send notification:', error.message);
    // Don't throw - notification failure shouldn't fail the job
  }
}

/**
 * Process indexing job
 * 
 * @param {Job} job - Bull job
 */
async function processJob(job) {
  const { node, uid } = job.data;

  console.log(`[IndexWorker] Processing job ${job.id}: ${node.filename}`);
  try {
    await job.progress(10);
    job.log(`Starting indexing: ${node.filename}`);

    if (!redisInitialized) {
      await initRedis();
    }

    await job.progress(20);

    const result = await indexFile(node, {
      uid,
      jobLog: (msg) => job.log(msg)
    });

    await job.progress(80);
    job.log(`Indexed ${result.words} words in ${result.duration}ms`);
    job.data.db_name = job.data.xdb;
    await sendNotification(job.data, result);

    await job.progress(100);
    job.log('Indexing complete');

    return {
      success: true,
      filename: node.filename,
      words: result.words,
      duration: result.duration,
      extension: result.extension
    };

  } catch (error) {
    console.error(`[IndexWorker] Job ${job.id} failed:`, error.message);
    job.log(`Error: ${error.message}`);

    await sendNotification(job.data, {
      success: false,
      error: error.message
    });

    throw error;
  }
}

/**
 * Start worker
 */
async function startWorker() {
  console.log('[IndexWorker] Initializing...');

  await initRedis();

  indexQueue.process('index-file', CONCURRENCY, processJob);

  console.log('[IndexWorker] Worker started, waiting for jobs...');

  // Log stats every minute
  setInterval(async () => {
    try {
      const stats = await indexQueue.getStats();
      console.log('[IndexWorker] Queue stats:', {
        waiting: stats.waiting,
        active: stats.active,
        completed: stats.completed,
        failed: stats.failed,
        worker: WORKER_NAME
      });
    } catch (e) {
      console.error('[IndexWorker] Failed to get stats:', e.message);
    }
  }, 60000);
}

/**
 * Graceful shutdown
 */
async function shutdown() {
  console.log('[IndexWorker] Shutting down gracefully...');

  try {
    await indexQueue.close(30000);  // 30s timeout
    console.log('[IndexWorker] Queue closed');
  } catch (error) {
    console.error('[IndexWorker] Error during shutdown:', error.message);
  }

  process.exit(0);
}

// Handle signals
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('[IndexWorker] Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[IndexWorker] Unhandled rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Start the worker
startWorker().catch((error) => {
  console.error('[IndexWorker] Failed to start worker:', error);
  process.exit(1);
});

console.log('[IndexWorker] Worker process started (PID:', process.pid, ')');