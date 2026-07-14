/**
 * Bull Queue worker that processes trash deletion jobs
 */

const { resolve } = require('path');
const { writeFileSync } = require('jsonfile');
const { mkdirSync } = require('fs');
const { spawn } = require('child_process');
const { trashQueue } = require('../queues/trashQueue');
const { Mariadb, sysEnv } = require('@drumee/server-essentials');

// Worker configuration
const CONCURRENCY = parseInt(process.env.TRASH_WORKER_CONCURRENCY || '2');
const WORKER_NAME = process.env.WORKER_NAME || 'trash-worker-1';

console.log(`[TrashWorker] Starting worker: ${WORKER_NAME}`);
console.log(`[TrashWorker] Concurrency: ${CONCURRENCY}`);

const { tmp_dir } = sysEnv();
// Resolve the purge worker relative to THIS file, not sysEnv().server_home —
// server_home comes back as the bare runtime/server root (no endpoint segment),
// so `resolve(server_home, 'offline', 'media', 'purge.js')` pointed at a path
// that doesn't exist (the worker lives under <endpoint>/offline/media/purge.js),
// spawning ENOENT and failing every empty-trash job. __dirname is always inside
// the running endpoint's tree. Mirrors service/media.js's OFFLINE_DIR.
const PURGE_WORKER = resolve(__dirname, '..', 'media', 'purge.js');
const SPAWN_OPT = { detached: true, stdio: ['ignore', 'ignore', 'ignore'] };
const JSON_OPT = { spaces: 2, EOL: '\r\n' };

const yp = new Mariadb({ name: 'yp' });

/**
 * Process empty_trash job
 */
trashQueue.process('empty_trash', CONCURRENCY, async (job) => {
  const { uid, hub_id } = job.data;
  
  console.log(`[TrashWorker] Processing empty_trash: hub=${hub_id}, user=${uid}`);
  
  let userDb;
  
  try {
    const entity = await yp.await_proc('entity_exists', hub_id);
    
    if (!entity || !entity.db_name) {
      throw new Error(`Database not found for hub: ${hub_id}`);
    }
    
    const db_name = entity.db_name;
    console.log(`[TrashWorker] Database: ${db_name}`);
    
    userDb = new Mariadb({ name: db_name });
    
    console.log(`[TrashWorker] Calling mfs_empty_trash`);
    const data = await userDb.await_proc('mfs_empty_trash');
    
    // Close database connection
    if (userDb && userDb.connection) {
      await userDb.end();
    }
    
    if (!data || data.length === 0) {
      console.log(`[TrashWorker] No files to delete`);
      return { 
        status: 'success', 
        message: 'No files to delete',
        hub_id,
        uid
      };
    }
    
    // Prepare data for purge.js
    const entities = Array.isArray(data) ? data : [data];
    
    console.log(`[TrashWorker] Found ${entities.length} files to purge`);
    
    // Spawn purge.js (path resolved relative to this worker — see PURGE_WORKER)
    const cmd = PURGE_WORKER;
    const args = { entities, uid };
    
    const queueDir = resolve(tmp_dir, 'offline', 'queue');
    mkdirSync(queueDir, { recursive: true });
    
    const argsFile = resolve(queueDir, `trash_${Date.now()}_${uid}.json`);
    writeFileSync(argsFile, args, JSON_OPT);
    
    console.log(`[TrashWorker] Spawning purge.js`);
    
    const child = spawn(cmd, [argsFile], SPAWN_OPT);
    child.unref();
    
    console.log(`[TrashWorker] purge.js spawned (PID: ${child.pid})`);
    
    return {
      status: 'success',
      message: 'Trash cleanup initiated',
      hub_id,
      uid,
      files_count: entities.length,
      purge_pid: child.pid
    };
    
  } catch (error) {
    console.error(`[TrashWorker] Error:`, error);
    
    // Cleanup
    if (userDb && userDb.connection) {
      try {
        await userDb.end();
      } catch (e) {
        console.error(`[TrashWorker] Close error:`, e.message);
      }
    }
    
    throw error;
  }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[TrashWorker] SIGTERM received');
  await trashQueue.close();
  if (yp && yp.connection) {
    await yp.end();
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[TrashWorker] SIGINT received');
  await trashQueue.close();
  if (yp && yp.connection) {
    await yp.end();
  }
  process.exit(0);
});

console.log(`[TrashWorker] Worker started, waiting for jobs...`);

// Stats logging
setInterval(async () => {
  const [waiting, active, completed, failed] = await Promise.all([
    trashQueue.getWaitingCount(),
    trashQueue.getActiveCount(),
    trashQueue.getCompletedCount(),
    trashQueue.getFailedCount()
  ]);
  
  console.log('[TrashWorker] Stats:', { waiting, active, completed, failed });
}, 60000);