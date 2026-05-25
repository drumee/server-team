// service/google_drive.js
//
// Google Drive migration endpoints. Heavy lifting (folder traversal +
// downloads) runs in offline/workers/gdriveWorker.js; this file only:
//   - mints the OAuth elevation URL (drive.readonly scope, offline),
//   - reads/writes the oauth_accounts row (via ensureFreshToken),
//   - enqueues / cancels / inspects migration_jobs rows,
//   - exposes the post-onboarding dismiss flag setter.

const { Attr, Cache, toArray } = require('@drumee/server-essentials');
const { google } = require('googleapis');
const ExtImport = require('../lib/ext_import');
const { migrationQueue } = require('../../offline/queues/migrationQueue');

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

class GoogleDrive extends ExtImport {

  initialize(opt) {
    super.initialize(opt);
    this.debug('GoogleDrive Service Initialized.');
  }

  /**
   * Returns `{ ok: true }` if the user already has a stored Google
   * access_token whose scope includes drive.readonly AND has a refresh_token
   * so we can recover from expiry.
   */
  async has_drive_scope() {
    const row = toArray(await this.yp.await_query(
      'SELECT scope, refresh_token FROM oauth_accounts WHERE user_id=? AND provider=?',
      this.uid, 'google'
    ))[0];
    const ok = !!(row && row.refresh_token && row.scope && row.scope.includes('drive.readonly'));
    this.output.data({ ok });
  }

  /**
   * Mint the OAuth URL the FE pops open. Scope = drive.readonly, prompt =
   * consent (force refresh_token on re-grant), state carries `uid` + `sid`
   * so `butler.google_drive_callback` knows which oauth_accounts row to
   * UPDATE.
   */
  async connect() {
    const oauth2 = this._oauthClient();
    const state = await this.yp.await_func('uniqueId');
    const statePayload = {
      uid: this.uid,
      sid: this.session.sid(),
      host: this.input.host(),
      intent: 'gdrive_migrate',
    };
    await this.yp.await_proc('set_redirect_state', state, JSON.stringify(statePayload));
    const auth_url = oauth2.generateAuthUrl({
      access_type: 'offline',
      scope: [DRIVE_SCOPE],
      prompt: 'consent',
      state,
    });
    this.output.data({ auth_url });
  }

  /**
   * Enqueue a migration. Creates the migration_jobs row first so the FE
   * gets a stable `job_id` even if Bull's `add()` is slow.
   */
  async start_migration() {
    const hub_id = this.input.need(Attr.hub_id);
    const nid = this.input.need(Attr.nid);
    const source_folder_id = this.input.use('source_folder_id', 'root');
    const include_shared_drives = this.input.use('include_shared_drives', 0) ? 1 : 0;
    const conflict_policy = this.input.use('conflict_policy', 'skip');
    if (!['skip', 'overwrite', 'rename'].includes(conflict_policy)) {
      throw new Error(`invalid conflict_policy: ${conflict_policy}`);
    }

    // Refuse if not connected; FE should have called has_drive_scope first
    // but we double-check so the worker doesn't waste a slot.
    const scopeRow = toArray(await this.yp.await_query(
      'SELECT scope, refresh_token FROM oauth_accounts WHERE user_id=? AND provider=?',
      this.uid, 'google'
    ))[0];
    if (!scopeRow || !scopeRow.refresh_token || !(scopeRow.scope || '').includes('drive.readonly')) {
      throw new Error('NEEDS_RECONNECT');
    }

    const insertRes = await this.yp.await_query(
      `INSERT INTO migration_jobs
         (user_id, provider, source_folder_id, dest_hub_id, dest_nid,
          status, conflict_policy, include_shared_drives, ctime)
       VALUES (?, 'google', ?, ?, ?, 'queued', ?, ?, UNIX_TIMESTAMP())`,
      this.uid, source_folder_id, hub_id, nid, conflict_policy, include_shared_drives
    );
    const job_id = insertRes && (insertRes.insertId || insertRes.lastInsertId || insertRes.affectedRows);
    if (!job_id) {
      throw new Error('Failed to create migration_jobs row');
    }

    await migrationQueue.add('migrate_google_drive', { job_id }, {
      removeOnComplete: 100,
      removeOnFail: false,
    });

    this.output.data({ job_id });
  }

  /**
   * Poll endpoint for FE. Either `job_id` (specific job) or `latest_only=1`
   * (the user's most recent job — Desk auto-launch uses this to decide
   * whether to show the popup).
   */
  async get_status() {
    const latest = parseInt(this.input.use('latest_only', 0)) ? 1 : 0;
    let row;
    if (latest) {
      row = toArray(await this.yp.await_query(
        `SELECT id, status, conflict_policy, source_folder_id, dest_hub_id, dest_nid,
                total_files, processed_files, total_folders, errors_json,
                started_at, finished_at, ctime
         FROM migration_jobs
         WHERE user_id=? AND provider='google'
         ORDER BY ctime DESC LIMIT 1`,
        this.uid
      ))[0];
    } else {
      const job_id = this.input.need('job_id');
      row = toArray(await this.yp.await_query(
        `SELECT id, status, conflict_policy, source_folder_id, dest_hub_id, dest_nid,
                total_files, processed_files, total_folders, errors_json,
                started_at, finished_at, ctime
         FROM migration_jobs
         WHERE id=? AND user_id=?`,
        job_id, this.uid
      ))[0];
    }
    if (!row) {
      this.output.data({ status: 'none' });
      return;
    }
    let errors = [];
    if (row.errors_json) {
      try { errors = JSON.parse(row.errors_json) || []; } catch (_) { errors = []; }
    }
    this.output.data({
      job_id: row.id,
      status: row.status,
      conflict_policy: row.conflict_policy,
      source_folder_id: row.source_folder_id,
      dest_hub_id: row.dest_hub_id,
      dest_nid: row.dest_nid,
      total_files: row.total_files,
      processed_files: row.processed_files,
      total_folders: row.total_folders,
      errors,
      started_at: row.started_at,
      finished_at: row.finished_at,
    });
  }

  /**
   * Mark the job cancelled. If it's still in the Bull queue, remove the job
   * so the worker never picks it up. If it's already running, the worker
   * polls `status` between files and exits cleanly.
   */
  async cancel() {
    const job_id = this.input.need('job_id');
    const row = toArray(await this.yp.await_query(
      `SELECT status FROM migration_jobs WHERE id=? AND user_id=?`,
      job_id, this.uid
    ))[0];
    if (!row) throw new Error('job not found');
    if (['done', 'failed', 'cancelled'].includes(row.status)) {
      this.output.data({ ok: true, already_terminal: true });
      return;
    }
    await this.yp.await_query(
      `UPDATE migration_jobs SET status='cancelled', finished_at=UNIX_TIMESTAMP() WHERE id=?`,
      job_id
    );
    // Best-effort removal from Bull. If the job is already active, the
    // worker will see status='cancelled' on its next poll and bail.
    try {
      const jobs = await migrationQueue.getJobs(['waiting', 'delayed', 'paused']);
      for (const j of jobs) {
        if (j.data && j.data.job_id == job_id) await j.remove();
      }
    } catch (e) {
      this.warn('[google_drive.cancel] Bull cleanup failed:', e && e.message);
    }
    this.output.data({ ok: true });
  }

  /**
   * Desk auto-launch sets `profile.tools_migration_skipped.google_drive=1`
   * so the popup doesn't re-appear on every reload. The user can still
   * launch it manually from Settings → Linked accounts.
   */
  async dismiss_post_onboarding() {
    const row = toArray(await this.yp.await_query(
      `SELECT profile FROM drumate WHERE id=?`, this.uid
    ))[0];
    let profile = {};
    if (row && row.profile) {
      try { profile = JSON.parse(row.profile) || {}; } catch (_) { profile = {}; }
    }
    profile.tools_migration_skipped = profile.tools_migration_skipped || {};
    profile.tools_migration_skipped.google_drive = 1;
    await this.yp.await_proc('drumate_update_profile', this.uid, JSON.stringify(profile));
    this.output.data({ ok: true });
  }

  /**
   * Shared OAuth client factory — used by `connect()` and by butler's
   * google_drive_callback.
   */
  _oauthClient() {
    const client_id = Cache.getSysConf('google_client_id');
    const client_secret = Cache.getSysConf('google_client_secret');
    const redirect_uri = this.input.servicepath({ service: 'butler.google_drive_callback' });
    return new google.auth.OAuth2(client_id, client_secret, redirect_uri);
  }
}

module.exports = GoogleDrive;
