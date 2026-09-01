/**
 * @license
 * Copyright 2024 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3
 */

/**
 * Record a completed Google Drive migration for the analytics
 * Engagement > Aha moment page.
 *
 * ITS OWN MODULE BECAUSE gdriveWorker.js CANNOT BE REQUIRED: that file calls
 * startWorker() at import, so requiring it from a test boots a Bull worker.
 * The decision -- what counts as a migration -- is the part worth testing, so
 * it lives here and the worker calls it.
 *
 * NOT service/lib/feature-usage.js, deliberately. That lib batches marks in
 * memory to keep a database round-trip out of the upload REQUEST path. A
 * worker that has just spent thirty minutes importing has no latency budget to
 * protect, and batching would put the mark at risk of a restart it has no
 * reason to take.
 *
 * A CANCELLED JOB THAT MOVED FILES COUNTS. A user who cancelled after 200
 * files migrated 200 files, and importer.run() returns through the same
 * terminal path for success and for cancel. A thrown or timed-out attempt does
 * NOT reach that path, and so has no result to report here -- which is correct:
 * it moved nothing durable that this process can vouch for.
 *
 * NEVER REJECTS. The migration is finished and its files are on disk; an
 * analytics counter must not turn that into a failed job.
 *
 * @param {Object} yp      long-lived Mariadb handle (needs await_proc)
 * @param {String} userId  the migrating user; job.data.user_id
 * @param {Object} result  importer.run()'s resolved payload
 * @returns {Promise<Boolean>} true when a mark was posted
 */
async function markMigrationUsage(yp, userId, result) {
  const r = result || {};
  if (!yp || typeof yp.await_proc !== "function") return false;
  if (!userId) return false;
  // Files, not bytes, is the test for adoption: a migration of ten empty
  // files is still a migration, and total_bytes would read 0 for it.
  if (!(Number(r.processed_files) > 0)) return false;

  const bytes = Number(r.total_bytes) || 0;
  try {
    await yp.await_proc("feature_mark", userId, "gdrive", 1, bytes);
    return true;
  } catch (e) {
    console.warn("[GDriveWorker] feature_mark failed:", e && e.message);
    return false;
  }
}

module.exports = { markMigrationUsage };
