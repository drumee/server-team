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
const axios = require('axios');
const ExtImport = require('../lib/ext_import');
const { googleDriveCredentials } = require('../lib/google_credentials');
const {
  addMigration,
  getJobStatus,
  getUserJob,
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
   * Mint the OAuth URL the FE pops open. Scope = email + profile + drive.readonly.
   *   - email/profile are required so the token exchange returns an
   *     id_token; butler.google_drive_callback reads its `sub` (Google
   *     account id) to upsert the oauth_accounts row. Without them the
   *     callback has no provider_user_id for the UNIQUE key and the row
   *     can't be created for email/password users (no prior Google link).
   *   - prompt=select_account+consent forces Google to show the account
   *     chooser AND the consent screen on every call. Without
   *     select_account, Google reuses the previously-authorized account
   *     and the user can't switch Drives without first disconnecting
   *     (which is blocked when Google is their only login). With
   *     consent, Google always emits a refresh_token even on re-grant.
   *   - state carries `uid` + `sid` so `butler.google_drive_callback`
   *     knows which user owns the connection.
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
      scope: ['email', 'profile', DRIVE_SCOPE],
      prompt: 'select_account consent',
      state,
    });
    this.output.data({ auth_url });
  }

  /**
   * Browse one Drive folder for the in-app picker tree. Read-only; My Drive
   * only (Shared Drives are an All-mode concern). Paginated: pass the returned
   * next_page_token back to fetch subsequent pages.
   *   in:  { folder_id='root', page_token? }
   *   out: { files: [{ id, name, is_folder, mime_type, size }], next_page_token }
   */
  async list() {
    const folder_id = this.input.use('folder_id', 'root');
    const page_token = this.input.use('page_token', null);

    let token;
    try {
      token = await this.ensureFreshToken('google');
    } catch (e) {
      // No refresh_token / revoked grant → FE drops back to the connect screen.
      throw new Error('NEEDS_RECONNECT');
    }

    const params = {
      q: `'${folder_id}' in parents and trashed = false`,
      pageSize: 200,
      // Drive sorts folders first, then by name — matches the picker ordering.
      orderBy: 'folder,name',
      fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime)',
    };
    if (page_token) params.pageToken = page_token;

    let res;
    try {
      res = await axios.get('https://www.googleapis.com/drive/v3/files', {
        headers: { Authorization: `Bearer ${token}` },
        params,
      });
    } catch (e) {
      console.warn(`[google_drive.list] folder=${folder_id} failed:`, e && e.message);
      throw new Error('LIST_FAILED');
    }

    const FOLDER = 'application/vnd.google-apps.folder';
    const files = (res.data.files || []).map((f) => ({
      id: f.id,
      name: f.name,
      is_folder: f.mimeType === FOLDER ? 1 : 0,
      mime_type: f.mimeType,
      size: f.size || null,
    }));
    this.output.data({ files, next_page_token: res.data.nextPageToken || null });
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
    const mode = this.input.use('mode', 'all') === 'selected' ? 'selected' : 'all';
    let selections = this.input.use('selections', null);
    // The input layer may deliver the object as a JSON string — normalize.
    if (typeof selections === 'string') {
      try { selections = JSON.parse(selections); } catch (_) { selections = null; }
    }
    if (mode === 'selected') {
      const folder_ids = (selections && Array.isArray(selections.folder_ids)) ? selections.folder_ids.filter(Boolean) : [];
      const file_ids   = (selections && Array.isArray(selections.file_ids))   ? selections.file_ids.filter(Boolean)   : [];
      if (!folder_ids.length && !file_ids.length) {
        throw new Error('NOTHING_SELECTED');
      }
      selections = { folder_ids, file_ids };
    } else {
      selections = null;
    }
    // Worker only implements 'skip' today — accepting overwrite/rename would
    // cause a mid-migration throw (importer.js: 'conflict policy not
    // implemented yet') and Bull would retry 3× with the same error.
    // Reject upfront so callers see the failure synchronously.
    if (conflict_policy !== 'skip') {
      throw new Error(`unsupported conflict_policy: ${conflict_policy} (only 'skip' implemented)`);
    }

    // Dedup guard: if the user already has a job in flight, never enqueue a
    // second one (a stale tab, a double-click, or two devices). Return the
    // existing job so the FE just reconnects to it instead of erroring.
    const existing = await getUserJob(this.uid);
    if (existing && ['active', 'waiting', 'delayed', 'paused'].includes(existing.state)) {
      this.output.data({ job_id: existing.id, already_running: 1 });
      return;
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
      mode,
      selections,
    });

    // Mark the migration prompt as "user has interacted" so the Desk
    // auto-launch hook stops showing it on subsequent boots.
    await this._setMigrationSkipped();

    this.output.data({ job_id: job.id });
  }

  /**
   * Normalize a Bull job snapshot (from getJobStatus/getUserJob) into the flat
   * shape the FE popup renders from. Shared by get_status (poll) and get_state
   * (reconnect on open) so both speak the same status vocabulary.
   */
  _shapeStatus(snap) {
    const prog = (snap.progress && typeof snap.progress === 'object') ? snap.progress : {};
    const ret = snap.returnvalue || {};
    // Translate Bull state → FE-friendly status the popup state machine
    // already understands (waiting/active map to queued/running UI states).
    let status = snap.state;
    if (status === 'waiting' || status === 'delayed' || status === 'paused') status = 'queued';
    else if (status === 'active') status = 'running';
    else if (status === 'completed') status = 'done';
    // 'failed' stays 'failed'
    // A cancelled job exits cleanly (the importer returns instead of throwing),
    // so Bull marks it 'completed'. Surface the returnvalue flag as 'cancelled'
    // rather than 'done' so the popup doesn't show "Migration complete".
    if (status === 'done' && ret.cancelled) status = 'cancelled';

    return {
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
    };
  }

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
    this.output.data(this._shapeStatus(snap));
  }

  /**
   * Consolidated state for the popup to call on OPEN. Returns everything the
   * FE state machine needs in one round-trip so it can reconnect to an
   * in-flight migration (or show a just-finished result once) instead of
   * defaulting to the "Start migration" screen:
   *   { ok: <has drive scope>, job: <shaped getUserJob|null>, seen_job_id }
   * `seen_job_id` is the last result the user dismissed (profile.gdrive_seen_job)
   * so a finished job is shown exactly once.
   */
  async get_state() {
    const scopeRow = toArray(await this.yp.await_query(
      'SELECT scope, refresh_token FROM oauth_accounts WHERE user_id=? AND provider=?',
      this.uid, 'google'
    ))[0];
    const ok = !!(scopeRow && scopeRow.refresh_token && scopeRow.scope && scopeRow.scope.includes('drive.readonly'));
    const snap = await getUserJob(this.uid);
    const job = snap ? this._shapeStatus(snap) : null;
    const seen_job_id = await this._getSeenJob();
    this.output.data({ ok, job, seen_job_id });
  }

  /** Read profile.gdrive_seen_job (id of the last result the user dismissed). */
  async _getSeenJob() {
    const row = toArray(await this.yp.await_query(`SELECT profile FROM drumate WHERE id=?`, this.uid))[0];
    let profile = {};
    if (row && row.profile) {
      try { profile = (typeof row.profile === 'string' ? JSON.parse(row.profile) : row.profile) || {}; }
      catch (_) { profile = {}; }
    }
    return profile.gdrive_seen_job || null;
  }

  /**
   * Mark a finished migration result as seen so reopening the popup won't show
   * it again (the "show result once" rule). FE calls this when the user closes
   * the popup from a done/failed/cancelled view.
   */
  async ack_result() {
    const job_id = String(this.input.need('job_id'));
    const row = toArray(await this.yp.await_query(`SELECT profile FROM drumate WHERE id=?`, this.uid))[0];
    let profile = {};
    if (row && row.profile) {
      try { profile = (typeof row.profile === 'string' ? JSON.parse(row.profile) : row.profile) || {}; }
      catch (_) { profile = {}; }
    }
    profile.gdrive_seen_job = job_id;
    await this.yp.await_proc('drumate_update_profile', this.uid, JSON.stringify(profile));
    this.output.data({ ok: true });
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
   * google_drive_callback. MUST stay byte-identical to the redirect_uri
   * built in butler.google_drive_callback: Google verifies the value sent
   * to generateAuthUrl matches the one sent to getToken.
   *
   * svc_location is the endpoint-aware service path (`/-/<instance>/svc`
   * on dev endpoints, `/-/svc` on main) — same idiom loby/service/google.js
   * uses for its callback. Never hardcode the path: svc_location yields the
   * correct callback URL on every endpoint automatically.
   */
  _oauthClient() {
    const { id: client_id, secret: client_secret } = googleDriveCredentials();
    const { main_domain, svc_location } = sysEnv();
    const redirect_uri = `https://${main_domain}${svc_location}/butler.google_drive_callback?`;
    return new google.auth.OAuth2(client_id, client_secret, redirect_uri);
  }
}

module.exports = GoogleDrive;
