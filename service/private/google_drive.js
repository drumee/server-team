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
const { googleDriveCredentials, googleDriveServiceAccount } = require('../lib/google_credentials');
const {
  addMigration,
  getJobStatus,
  getUserJob,
  cancelJob,
} = require('../../offline/queues/migrationQueue');

// drive.file is NON-SENSITIVE: no CASA / restricted-scope verification needed
// for external accounts. The app only sees files the user explicitly picked
// via the Google Picker (FE) plus files it created. The previous
// drive.readonly (RESTRICTED — 100-user cap + 7-day tokens while unverified)
// is still ACCEPTED on existing oauth_accounts rows so users who granted it
// before the switch keep working — see DRIVE_SCOPE_RE.
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
// Either grant lets the worker read the content it is asked to import.
const DRIVE_SCOPE_RE = /drive\.(file|readonly)/;

class GoogleDrive extends ExtImport {

  initialize(opt) {
    super.initialize(opt);
    this.debug('GoogleDrive Service Initialized.');
  }

  /**
   * Returns `{ ok: true }` if the user already has a stored Google
   * access_token whose scope includes a usable Drive grant (drive.file, or
   * legacy drive.readonly) AND has a refresh_token so we can recover from
   * expiry.
   */
  async has_drive_scope() {
    const row = toArray(await this.yp.await_query(
      // A user can hold SEVERAL google rows (login client vs Drive connect —
      // different provider_user_id). Always pick the one carrying the Drive
      // grant, never whichever the DB returns first.
      'SELECT scope, refresh_token FROM oauth_accounts WHERE user_id=? AND provider=? ORDER BY (scope LIKE "%drive.%") DESC, mtime DESC LIMIT 1',
      this.uid, 'google'
    ))[0];
    const ok = !!(row && row.refresh_token && row.scope && DRIVE_SCOPE_RE.test(row.scope));
    this.output.data({ ok });
  }

  /**
   * Access token + config for the FE Google Picker (drive.file flow). The
   * OAuth client, the REST API key and the appId (Cloud project NUMBER — not
   * the project id) MUST all belong to the same Cloud project, otherwise
   * Drive answers 403/404 on the very ids the user just picked.
   *   out: { access_token, api_key, app_id }
   */
  async picker_token() {
    const creds = googleDriveCredentials();
    if (!creds.api_key || !creds.project_number) {
      // google/drive.json lacks api_key/project_number — FE shows a clear
      // "feature not configured" message instead of a broken picker.
      throw new Error('PICKER_NOT_CONFIGURED');
    }
    let access_token;
    try {
      access_token = await this.ensureFreshToken('google');
    } catch (e) {
      throw new Error('NEEDS_RECONNECT');
    }
    this.output.data({
      access_token,
      api_key: creds.api_key,
      app_id: String(creds.project_number),
    });
  }

  // ───────── Service-account whole-folder import (share-to-SA) ─────────
  // The Picker's drive.file grant does NOT cover a picked folder's children
  // (live-verified). For true whole-tree import the user SHARES the folder
  // with our service account's email; the SA then reads the entire tree
  // with its own auth — no OAuth scopes, no verification.

  /** Mint a short-lived SA access token (drive.readonly on shared items). */
  async _saToken() {
    const sa = googleDriveServiceAccount();
    if (!sa) throw new Error('SA_NOT_CONFIGURED');
    const jwt = new google.auth.JWT({
      email: sa.client_email,
      key: sa.private_key,
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
    const { access_token } = await jwt.authorize();
    if (!access_token) throw new Error('SA_AUTH_FAILED');
    return access_token;
  }

  /**
   * Accepts a Drive folder OR file/Docs link (or a bare id); returns the id.
   * Folder: …/folders/ID · file: …/file/d/ID · Google Docs/Sheets/Slides:
   * …/document|spreadsheets|presentation/d/ID (all match /d/ID) · ?id=ID.
   */
  _parseFolderId(input) {
    const s = String(input || '').trim();
    const m = s.match(/\/folders\/([A-Za-z0-9_-]{10,})/)
      || s.match(/\/d\/([A-Za-z0-9_-]{10,})/)
      || s.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
    if (m) return m[1];
    if (/^[A-Za-z0-9_-]{10,}$/.test(s)) return s;
    return null;
  }

  /**
   * Share-gated verification (product decision: no owner check). The item just
   * has to be VISIBLE to the SA — i.e. the user shared it with the SA email.
   * That share + the pasted link IS the access grant, so a folder OR a file
   * owned by ANY account can be imported (not only the connected one).
   * Returns { id, name, is_folder }.
   */
  async _saVerifyShared(item_id) {
    const token = await this._saToken();
    let res;
    try {
      res = await axios.get(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(item_id)}`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { fields: 'id,name,mimeType', supportsAllDrives: true },
      });
    } catch (e) {
      // 404/403 for the SA = the share hasn't reached it (or wrong id).
      throw new Error('SA_NOT_SHARED');
    }
    const f = res.data || {};
    if (!f.id) throw new Error('SA_NOT_SHARED');
    return {
      id: f.id,
      name: f.name,
      is_folder: f.mimeType === 'application/vnd.google-apps.folder',
    };
  }

  /** FE setup card: the email the user must share their folder/file with. */
  async sa_info() {
    const sa = googleDriveServiceAccount();
    this.output.data({ configured: sa ? 1 : 0, email: sa ? sa.client_email : null });
  }

  /** Validate a pasted folder/file link/id before starting; returns its name. */
  async sa_check() {
    const item_id = this._parseFolderId(this.input.need('folder'));
    if (!item_id) throw new Error('SA_BAD_LINK');
    const f = await this._saVerifyShared(item_id);
    this.output.data({ ok: 1, folder_id: f.id, name: f.name, is_folder: f.is_folder ? 1 : 0 });
  }

  /**
   * Forget the Drive connection: best-effort revoke at Google, then clear the
   * tokens on the Drive-scoped row WITHOUT deleting it (keeps Google sign-in
   * intact — login re-OAuths and doesn't rely on the stored refresh_token).
   * After this get_state.ok is false → the FE returns to the connect screen,
   * where Connect can pick a different account.
   */
  async disconnect() {
    const row = toArray(await this.yp.await_query(
      'SELECT refresh_token FROM oauth_accounts WHERE user_id=? AND provider=? AND scope LIKE "%drive.%" ORDER BY mtime DESC LIMIT 1',
      this.uid, 'google'
    ))[0];
    if (row && row.refresh_token) {
      try {
        await axios.post(
          'https://oauth2.googleapis.com/revoke',
          new URLSearchParams({ token: row.refresh_token }).toString(),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
      } catch (_) { /* token may already be invalid — ignore */ }
    }
    await this.yp.await_query(
      'UPDATE oauth_accounts SET refresh_token=NULL, access_token=NULL WHERE user_id=? AND provider=? AND scope LIKE "%drive.%"',
      this.uid, 'google'
    );
    this.output.data({ ok: true });
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
    const auth_kind = this.input.use('auth_kind', 'user') === 'sa' ? 'sa' : 'user';
    // direct_into=1: land the import IN `nid` itself instead of a
    // GoogleDriveMigration wrapper under it. Set by the folder-window "+ New"
    // launch, where the user picked the destination by standing in it; the
    // settings/Home/onboarding launches keep the wrapper so loose files never
    // scatter into a home. The write-privilege gate below covers `nid` the
    // same either way.
    const direct_into = this.input.use('direct_into', 0) ? 1 : 0;
    let mode = this.input.use('mode', 'all') === 'selected' ? 'selected' : 'all';
    let selections = this.input.use('selections', null);
    if (auth_kind === 'sa') {
      // Share-to-SA import: re-validate server-side (never trust the FE's
      // sa_check) and shape it as a single-item selection — folder OR file —
      // the importer path is identical, only the token source differs.
      const item_id = this._parseFolderId(this.input.need('sa_folder'));
      if (!item_id) throw new Error('SA_BAD_LINK');
      const f = await this._saVerifyShared(item_id);
      mode = 'selected';
      selections = f.is_folder
        ? JSON.stringify({ folder_ids: [f.id], file_ids: [] })
        : JSON.stringify({ folder_ids: [], file_ids: [f.id] });
    }
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
    if (auth_kind === 'user') {
      const scopeRow = toArray(await this.yp.await_query(
        // A user can hold SEVERAL google rows (login client vs Drive connect —
        // different provider_user_id). Always pick the one carrying the Drive
        // grant, never whichever the DB returns first.
        'SELECT scope, refresh_token FROM oauth_accounts WHERE user_id=? AND provider=? ORDER BY (scope LIKE "%drive.%") DESC, mtime DESC LIMIT 1',
        this.uid, 'google'
      ))[0];
      if (!scopeRow || !scopeRow.refresh_token || !DRIVE_SCOPE_RE.test(scopeRow.scope || '')) {
        throw new Error('NEEDS_RECONNECT');
      }
      // A drive.file grant only sees items the user picked — a whole-Drive
      // walk ("all" mode) would import (nearly) nothing and confuse the
      // user. Only legacy drive.readonly rows may still run mode=all.
      if (mode === 'all' && !(scopeRow.scope || '').includes('drive.readonly')) {
        throw new Error('SELECTED_MODE_REQUIRED');
      }
      // Pre-flight the SOURCE with the user's own token. Until now nothing
      // touched the Drive API before enqueueing, so a folder whose share had
      // already been revoked on Google's side sailed straight into the worker
      // (reported 2026-07-29: "removed access, can still migrate") — which
      // then swallowed the per-item 403/404s and reported success. A revoked
      // item answers 403/404 to files.get; refuse the start right here where
      // the caller can see it.
      const ids = mode === 'selected'
        ? [...selections.folder_ids, ...selections.file_ids]
        : (source_folder_id && source_folder_id !== 'root' ? [source_folder_id] : []);
      if (ids.length) {
        const token = await this.ensureFreshToken('google');
        // Cap the pre-flight: a Picker multi-select can carry many file ids,
        // and each check is a round-trip. Folders first — they are the case
        // that walks a whole subtree unchecked.
        for (const id of ids.slice(0, 15)) {
          try {
            await axios.get(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`, {
              headers: { Authorization: `Bearer ${token}` },
              params: { fields: 'id', supportsAllDrives: true },
            });
          } catch (e) {
            const status = e && e.response && e.response.status;
            if (status === 403 || status === 404) {
              throw new Error('SOURCE_ACCESS_REVOKED');
            }
            if (status === 401) throw new Error('NEEDS_RECONNECT');
            // Anything else (network blip, 5xx) must not block a legitimate
            // start — the worker's own retry ladder handles transient trouble.
            this.warn(`[start_migration] pre-flight ${id} skipped:`, e && e.message);
          }
        }
      }
    }
    // (auth_kind 'sa': no oauth row needed — the SA authenticates itself and
    // _saVerifyFolder above already proved share + ownership.)

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
      direct_into,
      source_folder_id,
      include_shared_drives,
      conflict_policy,
      mode,
      selections,
      auth_kind,
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
      bytes_total:      prog.bytes_total     || 0,
      bytes_done:       prog.bytes_done      || 0,
      bytes_in_flight:  prog.bytes_in_flight || 0,
      errors:           ret.errors || prog.errors || [],
      // The GoogleDriveMigration folder's nid — "Open in Drumee" target.
      dest_nid:         ret.dest_nid || null,
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
      // A user can hold SEVERAL google rows (login client vs Drive connect —
      // different provider_user_id). Always pick the one carrying the Drive
      // grant, never whichever the DB returns first.
      'SELECT scope, refresh_token, email FROM oauth_accounts WHERE user_id=? AND provider=? ORDER BY (scope LIKE "%drive.%") DESC, mtime DESC LIMIT 1',
      this.uid, 'google'
    ))[0];
    const scope = (scopeRow && scopeRow.scope) || '';
    const ok = !!(scopeRow && scopeRow.refresh_token && DRIVE_SCOPE_RE.test(scope));
    // The Google account currently connected — shown on the ready screen so
    // the user can confirm which Drive they're importing from / disconnect.
    const email = ok ? ((scopeRow && scopeRow.email) || null) : null;
    // FE branches its picker UI on this: 'readonly' keeps the legacy in-app
    // tree (whole-Drive capable), 'file' switches to the Google Picker.
    const scope_kind = scope.includes('drive.readonly')
      ? 'readonly'
      : (scope.includes('drive.file') ? 'file' : null);
    let picker = 0;
    try {
      const creds = googleDriveCredentials();
      picker = creds.api_key && creds.project_number ? 1 : 0;
    } catch (_) { /* credentials missing — picker stays 0 */ }
    // Whole-folder import path (share-to-SA) availability + the email to
    // share with — the FE only offers it when the key file is present.
    let sa = 0;
    let sa_email = null;
    const saCreds = googleDriveServiceAccount();
    if (saCreds) { sa = 1; sa_email = saCreds.client_email; }
    const snap = await getUserJob(this.uid);
    const job = snap ? this._shapeStatus(snap) : null;
    const seen_job_id = await this._getSeenJob();
    this.output.data({ ok, email, scope_kind, picker, sa, sa_email, job, seen_job_id });
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
    // Write the merged profile DIRECTLY — NOT via drumate_update_profile. That
    // proc rebuilds `profile` from a fixed whitelist of keys and silently DROPS
    // anything not on it; gdrive_seen_job isn't whitelisted, so going through it
    // never persists the ack and the finished job replays as "Migration failed /
    // access expired" forever (even after a healthy reconnect). A plain UPDATE
    // of the full JSON keeps every existing key AND the new gdrive_seen_job.
    await this.yp.await_query(
      `UPDATE drumate SET profile=? WHERE id=?`, JSON.stringify(profile), this.uid
    );
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
