// service/google_drive.js
//
// Google Drive migration endpoints — Bull-only (no DB state table).
// Job state lives in Bull (waiting/active/completed/failed/delayed) plus
// `job.progress` (struct: processed_files, total_files, total_folders,
// errors_count, current_filename) and `job.returnvalue` (final summary).
//
// Endpoints:
//   has_drive_scope          → { ok }
//   connect                  → { auth_url }
//   start_migration          → { job_id } + sets profile.tools_migration_skipped.google_drive=1
//   get_status               → { job_id, status, processed_files, total_files, ... }
//   cancel                   → { ok, state, sentinel?, removed?, terminal? }
//   dismiss_post_onboarding  → { ok } sets profile.tools_migration_skipped.google_drive=1

const { Attr, Cache, Constants, toArray, sysEnv } = require('@drumee/server-essentials');
const { google } = require('googleapis');
const ExtImport = require('../lib/ext_import');
const {
  addMigration,
  getJobStatus,
  cancelJob,
} = require('../../offline/queues/migrationQueue');

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
   * Mint the OAuth URL the FE pops open. Scope = drive.readonly.
   *   - prompt=select_account+consent forces Google to show the account
   *     chooser AND the consent screen on every call. Without
   *     select_account, Google reuses the previously-authorized account
   *     and the user can't switch Drives without first disconnecting
   *     (which is blocked when Google is their only login). With
   *     consent, Google always emits a refresh_token even on re-grant.
   *   - state carries `uid` + `sid` so `butler.google_drive_callback`
   *     knows which oauth_accounts row to UPDATE.
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
      prompt: 'select_account consent',
      state,
    });
    this.output.data({ auth_url });
  }

  /**
   * Enqueue a migration. Also sets `profile.tools_migration_skipped.google_drive=1`
   * so the Desk auto-launch treats the user as "has interacted with the
   * prompt" — they won't be nagged again on reload, even if the migration
   * never finishes.
   */
  async start_migration() {
    const hub_id = this.input.need(Attr.hub_id);
    const nid = this.input.need(Attr.nid);
    const source_folder_id = this.input.use('source_folder_id', 'root');
    const include_shared_drives = this.input.use('include_shared_drives', 0) ? 1 : 0;
    const conflict_policy = this.input.use('conflict_policy', 'skip');
    // Worker only implements 'skip' today — accepting overwrite/rename would
    // cause a mid-migration throw (importer.js: 'conflict policy not
    // implemented yet') and Bull would retry 3× with the same error.
    // Reject upfront so callers see the failure synchronously.
    if (conflict_policy !== 'skip') {
      throw new Error(`unsupported conflict_policy: ${conflict_policy} (only 'skip' implemented)`);
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

    // Write-privilege gate on the DESTINATION node. ACL (scope=hub,
    // src=owner) already proves the caller owns `hub_id`, but `nid` can be
    // any folder inside that hub — including a sub-folder the user only has
    // read access to. The worker imports with the hub owner's rights, so
    // without this check a read-only member could write into a restricted
    // sub-tree. `mfs_access_node` returns the caller's computed privilege.
    const WRITE = (Constants.permission && Constants.permission.write) || 4;
    const access = toArray(await this.db.await_proc('mfs_access_node', this.uid, nid))[0];
    if (!access || ((access.privilege || 0) & WRITE) !== WRITE) {
      throw new Error('FORBIDDEN: no write access to destination folder');
    }

    const job = await addMigration({
      user_id: this.uid,
      hub_id,
      nid,
      source_folder_id,
      include_shared_drives,
      conflict_policy,
    });

    // Mark the migration prompt as "user has interacted" so the Desk
    // auto-launch hook stops showing it on subsequent boots.
    await this._setMigrationSkipped();

    this.output.data({ job_id: job.id });
  }

  /**
   * Poll endpoint for FE. Returns a flat shape the popup renders from.
   * Verifies the caller owns the job (job.data.user_id === this.uid) so
   * users can't peek at each other's jobs.
   */
  async get_status() {
    const job_id = this.input.need('job_id');
    const snap = await getJobStatus(job_id);
    if (!snap) {
      this.output.data({ status: 'none', job_id });
      return;
    }
    if (snap.data && snap.data.user_id !== this.uid) {
      throw new Error('forbidden');
    }
    const prog = (snap.progress && typeof snap.progress === 'object') ? snap.progress : {};
    const ret = snap.returnvalue || {};
    // Translate Bull state → FE-friendly status the popup state machine
    // already understands (waiting/active map to queued/running UI states).
    let status = snap.state;
    if (status === 'waiting' || status === 'delayed' || status === 'paused') status = 'queued';
    else if (status === 'active') status = 'running';
    else if (status === 'completed') status = 'done';
    // 'failed' stays 'failed'

    this.output.data({
      job_id: snap.id,
      status,
      processed_files: prog.processed_files || ret.processed_files || 0,
      total_files:     prog.total_files     || ret.total_files     || 0,
      total_folders:   prog.total_folders   || ret.total_folders   || 0,
      current_filename: prog.current_filename || null,
      errors:           ret.errors || prog.errors || [],
      attempts:         snap.attempts,
      failed_reason:    snap.failedReason,
      started_at:       snap.processedOn ? Math.floor(snap.processedOn / 1000) : null,
      finished_at:      snap.finishedOn ? Math.floor(snap.finishedOn / 1000) : null,
    });
  }

  /**
   * Cancel a job. Returns the queue helper's verdict (terminal | removed |
   * sentinel | not_found). For active jobs, the worker observes the
   * sentinel between files and exits cleanly.
   */
  async cancel() {
    const job_id = this.input.need('job_id');
    // Ownership check: load the job once and verify user_id before we
    // mutate anything (cancelJob doesn't know who the caller is).
    const snap = await getJobStatus(job_id);
    if (!snap) { this.output.data({ ok: false, reason: 'not_found' }); return; }
    if (snap.data && snap.data.user_id !== this.uid) throw new Error('forbidden');

    const res = await cancelJob(job_id);
    this.output.data(res);
  }

  /**
   * Desk auto-launch sets `profile.tools_migration_skipped.google_drive=1`
   * so the popup doesn't re-appear on every reload. The user can still
   * launch it manually from Settings → Linked accounts.
   */
  async dismiss_post_onboarding() {
    await this._setMigrationSkipped();
    this.output.data({ ok: true });
  }

  /**
   * Shared writer for `profile.tools_migration_skipped.google_drive=1`.
   * Reads current profile, merges, writes back via drumate_update_profile
   * (which expects a JSON string).
   */
  async _setMigrationSkipped() {
    const row = toArray(await this.yp.await_query(
      `SELECT profile FROM drumate WHERE id=?`, this.uid
    ))[0];
    let profile = {};
    if (row && row.profile) {
      try { profile = (typeof row.profile === 'string' ? JSON.parse(row.profile) : row.profile) || {}; }
      catch (_) { profile = {}; }
    }
    profile.tools_migration_skipped = profile.tools_migration_skipped || {};
    profile.tools_migration_skipped.google_drive = 1;
    await this.yp.await_proc('drumate_update_profile', this.uid, JSON.stringify(profile));
  }

  /**
   * Shared OAuth client factory — used by `connect()` and by butler's
   * google_drive_callback.
   *
   * input.servicepath() destructures `instance` from sysEnv() but
   * sysEnv only exposes `endpoint_name`, so the URL ends up with
   * "undefined" and Google rejects with redirect_uri_mismatch.
   * Build the URL the same way loby/service/google.js does (direct
   * concatenation from sysEnv values), which is the pattern that
   * works for the existing google-login flow.
   */
  _oauthClient() {
    const client_id = Cache.getSysConf('google_client_id');
    const client_secret = Cache.getSysConf('google_client_secret');
    const { main_domain, svc_location } = sysEnv();
    const redirect_uri = `https://${main_domain}${svc_location}/butler.google_drive_callback?`;
    return new google.auth.OAuth2(client_id, client_secret, redirect_uri);
  }
}

module.exports = GoogleDrive;
