/**
 * Trash Expiry Worker
 * 
 * Scheduled worker that runs daily to automatically delete expired trash items
 * Integrates with trash_expiry_config for system-wide settings
 * 
 * Schedule: Daily at 2 AM (configurable via EXPIRY_SCHEDULE env var)
 */

const { resolve } = require('path');
const { writeFileSync } = require('jsonfile');
const { mkdirSync } = require('fs');
const { spawn } = require('child_process');
const { CronJob } = require('cron');
const { Mariadb, RedisStore, sysEnv } = require('@drumee/server-essentials');

// Worker configuration
const WORKER_NAME = process.env.WORKER_NAME || 'expiry-worker-1';
const EXPIRY_SCHEDULE = process.env.EXPIRY_SCHEDULE || '0 2 * * *'; // Default: 2 AM daily

console.log(`[ExpiryWorker] Starting worker: ${WORKER_NAME}`);
console.log(`[ExpiryWorker] Schedule: ${EXPIRY_SCHEDULE}`);

const { tmp_dir } = sysEnv();
// Resolve the purge worker relative to THIS file, not sysEnv().server_home —
// server_home is the bare runtime/server root (no endpoint segment), so the old
// resolve(server_home, 'offline', 'media', 'purge.js') spawned a nonexistent
// path (ENOENT). __dirname stays inside the running endpoint's tree. Mirrors
// service/media.js's OFFLINE_DIR.
const PURGE_WORKER = resolve(__dirname, '..', 'media', 'purge.js');
const SPAWN_OPT = { detached: true, stdio: ['ignore', 'ignore', 'ignore'] };
const JSON_OPT = { spaces: 2, EOL: '\r\n' };

let yp;
let redisInitialized = false;

/**
 * Initialize database and Redis connections
 */
async function initialize() {
  try {
    yp = new Mariadb({ name: 'yp' });
    console.log('[ExpiryWorker] Database connected');

    await RedisStore.prototype.init.call(new RedisStore());
    redisInitialized = true;
    console.log('[ExpiryWorker] RedisStore initialized');

  } catch (error) {
    console.error('[ExpiryWorker] Initialization failed:', error.message);
    throw error;
  }
}

/**
 * Send WebSocket notification about trash cleanup
 * 
 * @param {String} hub_id
 * @param {Number} files_deleted
 */
async function sendNotification(hub_id, files_deleted) {
  if (!redisInitialized) return;

  try {
    const recipients = await yp.await_proc('entity_sockets', { hub_id });

    if (!recipients || recipients.length === 0) {
      console.warn(`[ExpiryWorker] No recipients found for hub: ${hub_id}`);
      return;
    }

    const payload = {
      service: 'trash.auto_deleted',
      status: 'success',
      hub_id,
      files_deleted,
      timestamp: Date.now()
    };

    await RedisStore.sendData(payload, recipients);

    console.log(`[ExpiryWorker] Notification sent to ${recipients.length} recipients in hub: ${hub_id}`);

  } catch (error) {
    console.error('[ExpiryWorker] Failed to send notification:', error.message);
  }
}

/**
 * Process expired trash for a single hub
 * 
 * @param {Object} hub - Hub info with expired items
 * @returns {Promise<Object>} - Result summary
 */
async function processHub(hub) {
  const { hub_id, db_name, expired_count } = hub;

  console.log(`[ExpiryWorker] Processing hub: ${hub_id} (${expired_count} expired items)`);

  let hubDb;

  try {
    hubDb = new Mariadb({ name: db_name });

    // Get expired items
    const expiredItems = await hubDb.await_proc('mfs_get_expired_trash');

    if (!expiredItems || expiredItems.length === 0) {
      console.log(`[ExpiryWorker] No expired items found in hub: ${hub_id}`);
      return { hub_id, status: 'no_items', deleted: 0 };
    }

    // Extract nids
    const nids = expiredItems.map(item => item.id);

    console.log(`[ExpiryWorker] Deleting ${nids.length} expired items from hub: ${hub_id}`);

    // Call mfs_delete_trash
    const deletedData = await hubDb.await_proc('mfs_delete_trash', JSON.stringify(nids));

    // Close database connection
    if (hubDb && hubDb.connection) {
      await hubDb.end();
    }

    if (!deletedData || deletedData.length === 0) {
      console.log(`[ExpiryWorker] No files to purge in hub: ${hub_id}`);
      return { hub_id, status: 'no_files', deleted: 0 };
    }

    // Prepare data for purge.js
    const entities = Array.isArray(deletedData) ? deletedData : [deletedData];

    console.log(`[ExpiryWorker] Spawning purge.js for ${entities.length} files`);

    // Spawn purge.js (path resolved relative to this worker — see PURGE_WORKER)
    const cmd = PURGE_WORKER;
    const args = {
      entities,
      uid: 'system' // System-triggered deletion
    };

    const queueDir = resolve(tmp_dir, 'offline', 'queue');
    mkdirSync(queueDir, { recursive: true });

    const argsFile = resolve(queueDir, `expiry_${Date.now()}_${hub_id}.json`);
    writeFileSync(argsFile, args, JSON_OPT);

    const child = spawn(cmd, [argsFile], SPAWN_OPT);
    child.unref();

    console.log(`[ExpiryWorker] purge.js spawned (PID: ${child.pid}) for hub: ${hub_id}`);

    // Send notification
    await sendNotification(hub_id, entities.length);

    return {
      hub_id,
      status: 'success',
      deleted: entities.length,
      purge_pid: child.pid
    };

  } catch (error) {
    console.error(`[ExpiryWorker] Error processing hub ${hub_id}:`, error.message);

    // Cleanup
    if (hubDb && hubDb.connection) {
      try {
        await hubDb.end();
      } catch (e) {
        console.error('[ExpiryWorker] Close error:', e.message);
      }
    }

    return {
      hub_id,
      status: 'error',
      error: error.message,
      deleted: 0
    };
  }
}

/**
 * Main expiry job - runs on schedule
 */
async function runExpiryJob() {
  const startTime = Date.now();

  console.log('[ExpiryWorker] ========================================');
  console.log('[ExpiryWorker] Starting expiry job at:', new Date().toISOString());

  try {
    // Get configuration
    const config = await yp.await_proc('get_trash_config');

    if (!config) {
      console.error('[ExpiryWorker] Failed to get trash config');
      return;
    }

    const { expiry_days, auto_delete_enabled } = config;

    console.log(`[ExpiryWorker] Config: expiry_days=${expiry_days}, auto_delete=${auto_delete_enabled}`);

    // Check if auto-delete is enabled
    if (auto_delete_enabled !== 1) {
      console.log('[ExpiryWorker] Auto-delete is disabled, skipping job');
      return;
    }

    // Find all expired trash across hubs
    console.log(`[ExpiryWorker] Scanning for expired trash (older than ${expiry_days} days)`);

    const expiredHubs = await yp.await_proc('find_all_expired_trash', expiry_days);

    if (!expiredHubs || expiredHubs.length === 0) {
      console.log('[ExpiryWorker] No expired trash found');
      await yp.await_proc('update_trash_last_run');
      return;
    }

    console.log(`[ExpiryWorker] Found ${expiredHubs.length} hubs with expired trash`);

    // Process each hub
    const results = [];
    let totalDeleted = 0;

    for (const hub of expiredHubs) {
      const result = await processHub(hub);
      results.push(result);
      totalDeleted += result.deleted || 0;
    }

    // Update last_run_time
    await yp.await_proc('update_trash_last_run');

    const duration = Date.now() - startTime;

    console.log('[ExpiryWorker] ========================================');
    console.log('[ExpiryWorker] Job completed at:', new Date().toISOString());
    console.log(`[ExpiryWorker] Duration: ${duration}ms`);
    console.log(`[ExpiryWorker] Hubs processed: ${results.length}`);
    console.log(`[ExpiryWorker] Total files deleted: ${totalDeleted}`);
    console.log('[ExpiryWorker] Results:', JSON.stringify(results, null, 2));
    console.log('[ExpiryWorker] ========================================');

  } catch (error) {
    console.error('[ExpiryWorker] Job failed:', error);
    console.error(error.stack);
  }
}

/**
 * Manual trigger (for testing)
 */
async function manualRun() {
  console.log('[ExpiryWorker] Manual run triggered');
  await runExpiryJob();
}

/**
 * Start the scheduled worker
 */
async function startWorker() {
  console.log('[ExpiryWorker] Initializing...');

  await initialize();

  // Create cron job
  const job = new CronJob(
    EXPIRY_SCHEDULE,
    runExpiryJob,
    null,    // onComplete
    true,    // start now
    'UTC'    // timezone
  );

  console.log('[ExpiryWorker] Cron job created');
  console.log('[ExpiryWorker] Next run:', job.nextDate().toISO());

  // Allow manual trigger via SIGUSR2
  process.on('SIGUSR2', async () => {
    console.log('[ExpiryWorker] SIGUSR2 received - manual run');
    await manualRun();
  });

  console.log('[ExpiryWorker] Worker started, waiting for schedule...');
  console.log('[ExpiryWorker] Send SIGUSR2 to trigger manual run: kill -USR2', process.pid);

  // Keep process alive
  setInterval(() => {
    console.log('[ExpiryWorker] Heartbeat - next run:', job.nextDate().toISO());
  }, 3600000); // Every hour
}

/**
 * Graceful shutdown
 */
async function shutdown() {
  console.log('[ExpiryWorker] Shutting down gracefully...');

  try {
    if (yp && yp.connection) {
      await yp.end();
      console.log('[ExpiryWorker] Database closed');
    }
  } catch (error) {
    console.error('[ExpiryWorker] Error during shutdown:', error.message);
  }

  process.exit(0);
}

// Handle signals
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('[ExpiryWorker] Uncaught exception:', error);
  console.error(error.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[ExpiryWorker] Unhandled rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Start the worker
startWorker().catch((error) => {
  console.error('[ExpiryWorker] Failed to start worker:', error);
  process.exit(1);
});

console.log('[ExpiryWorker] Worker process started (PID:', process.pid, ')');

// Export for testing
module.exports = {
  runExpiryJob,
  manualRun
};