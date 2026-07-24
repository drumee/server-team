/**
 * Per-job Google Drive importer (Bull-only).
 *
 * Constructed with a Bull `Job` instance; `run()` traverses the source
 * folder tree (paginated, includes Shared Drives if the job spec says so)
 * and downloads each file via an inline copy of the ExtImport
 * `_importFileInternal` logic (the worker doesn't carry a service-class
 * `this`, so duplication is intentional).
 *
 * Job lifecycle (Bull does the bookkeeping):
 *   - waiting → active: when the worker pulls the job
 *   - run(): does the work; pushes per-batch progress via `job.progress({...})`
 *   - return value → 'completed' state; thrown error → 'failed' state + retry
 *
 * Cancellation contract: between PROGRESS_BATCH files, the importer calls
 * `isCancelled(job.id)` which reads the Redis sentinel set by
 * `migrationQueue.cancelJob`. If true, the importer returns cleanly
 * (the job's final return value carries `cancelled: true`).
 */

const axios = require('axios');
const { Mariadb, toArray } = require('@drumee/server-essentials');
const { existsSync, createWriteStream, unlinkSync } = require('fs');
// Async fs ops (threadpool — don't block the event loop). A synchronous
// cpSync/rmSync of a large file/scratch dir blocked the loop long enough that
// Bull couldn't renew the job lock → "job stalled more than allowable limit".
const fsp = require('fs').promises;
const { join, extname } = require('path');
const { createHash } = require('crypto');
const { google } = require('googleapis');
const migrationQueue = require('../../queues/migrationQueue');
const { isCancelled } = migrationQueue;
const { withDriveRetry, classifyDriveError } = require('./retry');
const { googleDriveCredentials, googleDriveServiceAccount } = require('../../../service/lib/google_credentials');

const PROGRESS_BATCH = 5;
const PAGE_SIZE = 1000;

/**
 * Mirror of the filename rewriting mfs_create_node does before it stores a node
 * (schemas common/procedures/mfs/mfs_create_node.sql, the two REGEXP_REPLACE
 * calls right before unique_filename):
 *
 *   REGEXP_REPLACE(_fname, '^[/ ]+|\<.*\>|[/ ]+$', '')   -- (a)
 *   REGEXP_REPLACE(_fname, '( *)(/+)( *)', '')           -- (b)
 *
 * Drive allows '/' in a name; the MFS does not, so 'Marketing report 2024/2025'
 * is STORED as 'Marketing report 20242025'. Callers must therefore look the
 * node up by the rewritten name, never by the Drive name — see _createFolder.
 *
 * Verified against MariaDB (the authority) on: 'a<b>c<d>e'->'ae' (the <.*> is
 * greedy, so it eats everything between the FIRST '<' and the LAST '>'),
 * 'x<y'->'x<y', '<only>'->'', '/'->'', 'a / / b'->'ab', '  /lead'->'lead',
 * 'trail/  '->'trail', 'Tài liệu / Kế hoạch'->'Tài liệuKế hoạch'.
 *
 * NB `\<` in the SQL literal is just '<' (MariaDB drops the unknown escape).
 */
function storedNodeName(name) {
  return String(name == null ? '' : name)
    .replace(/^[/ ]+|<[\s\S]*>|[/ ]+$/g, '')
    .replace(/ *\/+ */g, '');
}
// Refresh the access token 60s before its server-side expiry so a
// long-running job (large files, slow network) doesn't fail mid-traverse
// with a 401 on every Drive request.
const TOKEN_SAFETY_SEC = 60;
// Per-request ceiling for EVERY Drive HTTP call. With the job-level timeout
// disabled (see migrationQueue.js), this is what reaps a hung socket: without
// it a stalled list/download would hang until Bull's stall-detector fires
// (minutes of dead time). For streamed downloads axios applies this to the
// response/inactivity, which is the case we care about (a wedged connection),
// not a slow-but-progressing transfer.
const DRIVE_HTTP_TIMEOUT_MS = 120000;
// Cap the RETAINED per-file error list so a pathological run (e.g. a 10k-file
// folder where every child fails NOT_GRANTED) can't bloat job.returnvalue,
// which is JSON-serialized into Redis. The TRUE total is tracked in errorCount.
const MAX_ERRORS = 200;
// File-level download concurrency WITHIN one job. The Bull worker already runs
// 2 jobs at once (gdriveWorker CONCURRENCY), so 2 × this bounds simultaneous
// Drive downloads — kept conservative (Drive rate-limits aggressively, and the
// retry layer absorbs the rest). FOLDER creation stays serial; only regular
// files inside a folder run through the pool.
const FILE_CONCURRENCY = Math.min(8, Math.max(1, parseInt(process.env.GDRIVE_FILE_CONCURRENCY || '4', 10)));
// Resume set TTL — mirrors the cancellation sentinel; a job that outlives 1h
// no longer needs cross-attempt resume state.
const DONE_TTL_SEC = 3600;

/**
 * Minimal promise semaphore (no dependency). Returns a `limit(fn)` that runs at
 * most `max` fns concurrently, queueing the rest. Used to bound file downloads.
 */
function makeSemaphore(max) {
  let active = 0;
  const queue = [];
  const pump = () => {
    if (active >= max || queue.length === 0) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => {
      active -= 1;
      pump();
    });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
}

class GoogleDriveImporter {
  /**
   * @param {import('bull').Job} job  — Bull job instance
   * @param {object} yp               — shared yp Mariadb connection
   */
  constructor(job, yp) {
    this.job = job;
    this.data = job.data || {};
    this.yp = yp;
    this.errors = [];          // retained sample, capped at MAX_ERRORS
    this.errorCount = 0;       // true total (may exceed errors.length)
    this.processedFiles = 0;
    this.totalFolders = 0;
    this.totalFiles = 0;
    this._cancelled = false;
    // Token cache populated lazily; refreshed when expires_at - safety < now.
    this._tokenCache = null;          // { access_token, expires_at }
    // Single-flight guard: collapse N concurrent token refreshes (file pool)
    // into one in-flight promise so they don't race the cache / oauth row.
    this._tokenRefreshing = null;
    // Bounded file-download pool (folder recursion stays serial).
    this._limit = makeSemaphore(FILE_CONCURRENCY);
    // Resume set: Drive item.ids already durably imported. Seeded from Redis in
    // run() so a retry/crash skips finished files instead of re-doing them.
    this._done = new Set();
    this._doneKey = null;
    // Progress is flushed every PROGRESS_BATCH completions across the pool.
    this._completedSinceUpdate = 0;
    // Per-job scratch dir — wiped on completion to avoid /tmp growing
    // unboundedly across migrations. Set in run() once job.id is known.
    this._scratchDir = null;
    // Per-parent-folder serialization of the create-node → resolve-id →
    // write-bytes critical section. The slow Drive download stays parallel
    // (FILE_CONCURRENCY); only the DB+disk write serializes per folder, which
    // lets us resolve the just-created node as the newest child under the
    // parent — correct even when Drive has duplicate filenames that
    // mfs_create_node auto-renames (S → S(1) → S(2)). pid → tail promise.
    this._pidLocks = new Map();
  }

  // Run fn while holding an exclusive lock for `pid`; concurrent calls for the
  // same pid run one at a time (different pids stay parallel). The stored tail
  // swallows errors so one failed file never wedges the folder's queue.
  async _withPidLock(pid, fn) {
    const prev = this._pidLocks.get(pid) || Promise.resolve();
    const run = prev.then(() => fn(), () => fn());
    this._pidLocks.set(pid, run.then(() => {}, () => {}));
    return run;
  }

  async run() {
    const {
      user_id,
      hub_id,
      nid,
      source_folder_id = 'root',
      include_shared_drives = 0,
      conflict_policy = 'skip',
      mode = 'all',
      selections = null,
    } = this.data;

    if (!user_id || !hub_id || !nid) {
      throw new Error(`importer: missing required job.data field(s)`);
    }

    this._userId = user_id;
    // Per-job scratch directory — every download lives here and the whole
    // tree is rm-rf'd in finally. Prevents /tmp from filling up across
    // jobs and also walls off cross-job cache leaks.
    this._scratchDir = join('/tmp', `gdrive-job-${this.job.id}`);
    await fsp.mkdir(this._scratchDir, { recursive: true });

    // Seed the resume set: Drive ids durably imported in a PRIOR attempt of this
    // same job (Bull retry / worker crash-restart). Best-effort — a Redis miss
    // just means re-importing (still idempotent via node_id_from_path). Keep
    // processedFiles at 0: the re-walk re-counts as it skips done files, so the
    // progress numbers stay self-consistent (no double-count of seeded totals).
    this._doneKey = `gdrive:done:${this.job.id}`;
    try {
      const ids = await migrationQueue.client.smembers(this._doneKey);
      this._done = new Set(ids || []);
    } catch (_) { this._done = new Set(); }

    // Prime the token cache — throws NEEDS_RECONNECT if no refresh_token.
    // Subsequent Drive calls use `_getFreshToken()` which lazily refreshes.
    // NEEDS_RECONNECT is not transient (user revoked OAuth) — discard so
    // Bull doesn't burn the remaining attempts retrying the same failure.
    try {
      await this._getFreshToken();
    } catch (e) {
      if (e && e.message === 'NEEDS_RECONNECT') {
        try { await this.job.discard(); } catch (_) {}
      }
      throw e;
    }

    // Resolve the destination hub's DB. get_db_name(id) does a direct
    // `SELECT db_name FROM entity WHERE id=?` (with a vhost fallback), so it
    // works for ANY entity — drumate OR hub — by id. get_entity's first
    // branch only matches drumates (INNER JOIN drumate), and the old
    // `entity_exists` proc doesn't exist at all (await_proc swallowed the
    // SQL error → returned nothing → always "dest_hub not found").
    let dbName = await this.yp.await_func('get_db_name', hub_id);
    // Fallback: if the FE-supplied hub_id can't be resolved (stale/mismatched
    // Visitor.id), use the authenticated user_id — always a valid entity for
    // a private-home migration. Keeps the job alive instead of hard-failing.
    if (!dbName && user_id && user_id !== hub_id) {
      console.warn(`[GDriveImporter] hub_id ${hub_id} unresolved; falling back to user_id ${user_id}`);
      dbName = await this.yp.await_func('get_db_name', user_id);
    }
    if (!dbName) throw new Error(`dest hub db unresolved: hub=${hub_id} user=${user_id}`);

    const hubDb = new Mariadb({ name: dbName });

    // The importer holds ONE hubDb connection for the whole job while doing many
    // slow Drive downloads between DB writes (it also uses the shared yp
    // connection for the per-file filecap lookup). During a download-heavy
    // stretch a connection sits idle long enough for MariaDB's wait_timeout (or
    // a network/LB idle timeout) to close it; the driver then emits an ASYNC
    // socket 'error' with no pending query. With no 'error' listener Node turns
    // that into an UNCAUGHT exception that CRASHES the worker mid-job — every
    // file after that point is silently never imported (the reported symptom:
    // sub-folder images missing / no thumbnail / won't open). Two guards keep
    // the job alive:
    //   1) attach an 'error' listener to the live connection so a dropped socket
    //      degrades to a reconnect-on-next-query (the wrapper's isValid() check
    //      re-dials) instead of crashing the process;
    //   2) a 60s keep-alive ping (well under wait_timeout) keeps hubDb + yp warm
    //      across downloads and re-arms the guard on the fresh connection object
    //      a reconnect creates.
    const guardConn = (db, label) => {
      const c = db && typeof db.connection === 'function' && db.connection();
      if (c && typeof c.on === 'function' && !c.__gdriveGuarded) {
        c.__gdriveGuarded = 1;
        c.on('error', (e) =>
          console.warn(`[GDriveImporter] ${label} socket error (reconnect on next query): ${e && (e.code || e.message)}`));
      }
    };
    const keepAlive = setInterval(() => {
      for (const [db, label] of [[hubDb, 'hubDb'], [this.yp, 'yp']]) {
        Promise.resolve()
          .then(() => db.await_query('SELECT 1'))
          .then(() => guardConn(db, label))
          .catch(() => {});
      }
    }, 60000);

    try {
      const destFolder = await hubDb.await_proc('mfs_node_attr', nid);
      // Arm the socket-error guard on the now-live connections.
      guardConn(hubDb, 'hubDb');
      guardConn(this.yp, 'yp');
      if (!destFolder || !destFolder.home_dir) {
        throw new Error(`dest_nid ${nid} invalid`);
      }

      // Authoritative storage root for the whole hub, captured once from the
      // validated home node and stripped of any trailing /__storage__ that
      // mfs_node_attr appends. File writes use this instead of a sub-folder's
      // home_dir, which may be absent on objects returned by mfs_create_node.
      const hubHomeDir = String(destFolder.home_dir).replace(/(\/__storage__.*)$/, '');

      // Everything imported lands in a dedicated "GoogleDriveMigration"
      // folder under the destination (the user's private home), so the
      // migration never scatters loose files into their home. Idempotent:
      // a re-run reuses the existing folder instead of duplicating it.
      const rootFolder = await this._createFolder('GoogleDriveMigration', destFolder, hubDb, user_id);
      // Exposed in the job result so the FE "Open in Drumee" lands on THIS
      // folder (the actual import root), not the destination's parent.
      this._destNidOut = rootFolder && rootFolder.nid;

      if (mode === 'selected' && selections) {
        await this._migrateSelected({
          selections,
          rootFolder,
          hubDb,
          hubHomeDir,
          conflictPolicy: conflict_policy,
          userId: user_id,
        });
      } else {
        await this._traverse({
          folderId: source_folder_id,
          destFolder: rootFolder,
          hubDb,
          hubHomeDir,
          includeSharedDrives: !!include_shared_drives,
          conflictPolicy: conflict_policy,
          userId: user_id,
        });
      }
    } finally {
      clearInterval(keepAlive);
      // Mariadb.end() returns undefined (not a promise) and swallows its own
      // errors internally. Chaining `.catch()` on it threw "Cannot read
      // properties of undefined (reading 'catch')" in this finally block —
      // failing the job at cleanup even after a successful import.
      if (hubDb && hubDb.connection) {
        try { hubDb.end(); } catch (_) {}
      }
      // Wipe the per-job scratch dir even on throw — prevents /tmp from
      // accumulating partial downloads across failed jobs.
      try {
        if (this._scratchDir) await fsp.rm(this._scratchDir, { recursive: true, force: true });
      } catch (e) {
        console.warn(`[GDriveImporter] scratch cleanup failed:`, e && e.message);
      }
    }

    // Terminal completion (success OR user-cancel — both reach here; a thrown /
    // timed-out attempt does NOT, so the resume set survives for the retry).
    // Clear the resume set now that this job is done with it.
    try { await migrationQueue.client.del(this._doneKey); } catch (_) {}

    // Bull will use this object as `job.returnvalue` on the 'completed'
    // event. The FE reads it via `get_status`.
    return {
      ok: true,
      cancelled: this._cancelled,
      processed_files: this.processedFiles,
      total_files: this.totalFiles,
      total_folders: this.totalFolders,
      errors: this.errors,                              // capped sample (≤ MAX_ERRORS)
      errors_count: this.errorCount,                    // true total
      errors_truncated: this.errorCount > this.errors.length,
      dest_nid: this._destNidOut || null,
    };
  }

  /**
   * Lazy access-token getter. Caches `{access_token, expires_at}` on the
   * instance; refreshes when expiry approaches. Called BEFORE every Drive
   * HTTP request so a 30-min+ migration doesn't 401 after the token's 1h
   * TTL elapses mid-job.
   */
  async _getFreshToken() {
    const now = Math.floor(Date.now() / 1000);
    if (this._tokenCache && this._tokenCache.expires_at - TOKEN_SAFETY_SEC > now) {
      return this._tokenCache.access_token;
    }
    // Single-flight: under the file pool, N tasks can all miss the cache at
    // once. Each refreshing would race the _tokenCache write AND (OAuth path)
    // write-skew the shared oauth_accounts row — the exact token-clobber class a
    // prior fix closed. Share ONE in-flight refresh across all callers; it spans
    // BOTH the SA jwt.authorize and the OAuth SELECT+refresh+UPDATE branches.
    if (this._tokenRefreshing) return this._tokenRefreshing;
    this._tokenRefreshing = this._refreshToken(now)
      .finally(() => { this._tokenRefreshing = null; });
    return this._tokenRefreshing;
  }

  /**
   * The actual SA/OAuth refresh. Never call directly — always go through
   * _getFreshToken so concurrent refreshes collapse into one (single-flight).
   */
  async _refreshToken(now) {
    // Service-account jobs (whole-folder import via share-to-SA): the SA
    // reads with its OWN auth — no oauth_accounts row involved at all.
    if (this.data.auth_kind === 'sa') {
      const sa = googleDriveServiceAccount();
      if (!sa) throw new Error('SA_NOT_CONFIGURED');
      const jwt = new google.auth.JWT({
        email: sa.client_email,
        key: sa.private_key,
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      });
      const { access_token, expiry_date } = await jwt.authorize();
      if (!access_token) throw new Error('SA_AUTH_FAILED');
      this._tokenCache = {
        access_token,
        expires_at: expiry_date ? Math.floor(expiry_date / 1000) : now + 3500,
      };
      return access_token;
    }
    const row = toArray(await this.yp.await_query(
      // Several google rows can coexist per user (login vs Drive client) —
      // the worker must refresh with the DRIVE row.
      'SELECT access_token, refresh_token, expires_at, scope FROM oauth_accounts WHERE user_id=? AND provider=? ORDER BY (scope LIKE "%drive.%") DESC, mtime DESC LIMIT 1',
      this._userId, 'google'
    ))[0];
    if (!row) throw new Error('NEEDS_RECONNECT');
    // If the row still has time left use it directly (another process may
    // have refreshed since we last looked).
    if (row.expires_at && row.expires_at - TOKEN_SAFETY_SEC > now) {
      this._tokenCache = { access_token: row.access_token, expires_at: row.expires_at };
      return row.access_token;
    }
    if (!row.refresh_token) throw new Error('NEEDS_RECONNECT');

    const { id, secret } = googleDriveCredentials();
    const oauth2 = new google.auth.OAuth2(id, secret);
    oauth2.setCredentials({ refresh_token: row.refresh_token });
    let credentials;
    try {
      const r = await oauth2.refreshAccessToken();
      credentials = r.credentials;
    } catch (e) {
      // Distinguish a DEAD token (fatal — the user must re-authorize) from a
      // TRANSIENT failure (network / Google 5xx — Bull should retry). Folding
      // both into NEEDS_RECONNECT + job.discard() permanently kills a job that
      // a transient outage would have recovered on retry. google-auth surfaces
      // the OAuth error at e.response.data.error: 'invalid_grant' when the
      // refresh_token is revoked OR was minted by a DIFFERENT OAuth client
      // (e.g. a later Google *login* clobbered the Drive-client token on the
      // shared oauth_accounts row); 'invalid_client'/'unauthorized_client'
      // means the server's drive.json credentials are wrong (retry won't help).
      const gerr = (e && e.response && e.response.data && e.response.data.error) || '';
      const msg = (e && e.message) || '';
      const fatal = /^(invalid_grant|invalid_client|unauthorized_client)$/.test(gerr)
        || /invalid_grant|invalid_client|unauthorized_client/i.test(msg);
      console.warn(
        `[GDriveImporter] token refresh failed user=${this._userId} fatal=${fatal} code=${e && e.code} oauth_error=${gerr || msg}`
      );
      if (fatal) throw new Error('NEEDS_RECONNECT');
      // Transient: rethrow the original error so Bull's retry/backoff handles
      // it instead of run() discarding the job as a permanent reconnect.
      throw e;
    }
    if (!credentials || !credentials.access_token) throw new Error('NEEDS_RECONNECT');
    const newExpiresAt = credentials.expiry_date
      ? Math.floor(credentials.expiry_date / 1000)
      : now + 3500;
    await this.yp.await_query(
      // Persist on the DRIVE row only — see ext_import.ensureFreshToken.
      'UPDATE oauth_accounts SET access_token=?, expires_at=?, mtime=UNIX_TIMESTAMP() WHERE user_id=? AND provider=? AND scope LIKE "%drive.%"',
      credentials.access_token, newExpiresAt, this._userId, 'google'
    );
    this._tokenCache = { access_token: credentials.access_token, expires_at: newExpiresAt };
    return credentials.access_token;
  }

  async _listFolder(folderId, includeSharedDrives) {
    const items = [];
    let pageToken;
    do {
      const params = {
        q: `'${folderId}' in parents and trashed = false`,
        pageSize: PAGE_SIZE,
        pageToken,
        fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, createdTime, fileExtension, webContentLink, shortcutDetails)',
      };
      if (includeSharedDrives) {
        params.supportsAllDrives = true;
        params.includeItemsFromAllDrives = true;
        params.corpora = 'allDrives';
      }
      // Re-read token before EACH page (inside the retried fn) so a long
      // pagination doesn't 401 halfway through a 10k-file folder; a 429/5xx on a
      // page now backs off + retries instead of abandoning the whole folder.
      const res = await withDriveRetry(async () => {
        const accessToken = await this._getFreshToken();
        return axios.get('https://www.googleapis.com/drive/v3/files', {
          headers: { Authorization: `Bearer ${accessToken}` },
          params,
          timeout: DRIVE_HTTP_TIMEOUT_MS,
        });
      }, { onAuth: () => { this._tokenCache = null; }, isCancelled: () => this._checkCancelled() });
      items.push(...(res.data.files || []));
      pageToken = res.data.nextPageToken;
    } while (pageToken);
    return items;
  }

  /**
   * Fetch a single item's metadata (selected mode). The server resolves the
   * name/mimeType itself — never trusts client-supplied names.
   */
  async _getMeta(id) {
    const res = await withDriveRetry(async () => {
      const token = await this._getFreshToken();
      return axios.get(`https://www.googleapis.com/drive/v3/files/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { fields: 'id, name, mimeType, size' },
        timeout: DRIVE_HTTP_TIMEOUT_MS,
      });
    }, { onAuth: () => { this._tokenCache = null; }, isCancelled: () => this._checkCancelled() });
    return res.data;
  }

  /**
   * Selected mode: migrate an explicit pick set under the GoogleDriveMigration
   * root. Each selected folder is recreated by name and traversed (whole
   * subtree); each selected file is imported directly into the root.
   */
  async _migrateSelected(opts) {
    const { selections, rootFolder } = opts;
    const base = {
      hubDb: opts.hubDb,
      hubHomeDir: opts.hubHomeDir,
      conflictPolicy: opts.conflictPolicy,
      userId: opts.userId,
      includeSharedDrives: false,
    };

    for (const folderId of (selections.folder_ids || [])) {
      if (await this._checkCancelled()) return;
      let meta;
      try {
        meta = await this._getMeta(folderId);
      } catch (e) {
        this._pushError({ folder: folderId, code: this._grantCode(e, 'META_FAILED'), reason: e.message });
        await this._pushProgress(base);
        continue;
      }
      const sub = await this._createFolder(meta.name, rootFolder, opts.hubDb, opts.userId);
      const filesBefore = this.totalFiles;
      await this._traverse({ ...base, folderId, destFolder: sub });
      if (this._cancelled) return;
      // drive.file gotcha: picking a FOLDER often grants only the folder
      // node — its children list back EMPTY (silently, no 403). Without
      // this hint the user sees "imported 0 files, 0 errors" and assumes
      // the feature is broken. NOT for SA jobs: the SA has real read access,
      // so an empty result there just means the folder IS empty.
      if (this.totalFiles === filesBefore && this.data.auth_kind !== 'sa') {
        this._pushError({ folder: meta.name, code: 'NOT_GRANTED', reason: 'folder children not granted' });
      }
    }

    for (const fileId of (selections.file_ids || [])) {
      if (await this._checkCancelled()) return;
      let meta;
      try {
        meta = await this._getMeta(fileId);
      } catch (e) {
        this._pushError({ file: fileId, code: this._grantCode(e, 'META_FAILED'), reason: e.message });
        await this._pushProgress(base);
        continue;
      }
      this.totalFiles += 1;
      try {
        await this._importItem(meta, { ...base, destFolder: rootFolder });
        this.processedFiles += 1;
        await this._pushProgress(base, meta.name);
      } catch (e) {
        this._pushError({ file: meta.name, code: this._grantCode(e, 'IMPORT_FAILED'), reason: e.message });
        await this._pushProgress(base);
      }
    }
  }

  /**
   * drive.file 403/404 on an id usually means the per-app Picker grant did
   * not cover it (e.g. children of a picked folder the Picker never "saw").
   * Surface it as NOT_GRANTED so the FE can tell the user to re-pick those
   * items, instead of a generic failure.
   */
  _grantCode(e, fallback) {
    // Only a genuine grant gap (403 non-rate / 404) is NOT_GRANTED. A
    // rate-limited 403 whose retries were exhausted must NOT be mislabeled — it
    // falls back to LIST_FAILED/IMPORT_FAILED so the FE doesn't tell the user to
    // re-pick files that were merely throttled.
    return classifyDriveError(e) === 'fatal_grant' ? 'NOT_GRANTED' : fallback;
  }

  async _traverse(opts) {
    // Cancellation gate at the start of each folder.
    if (await this._checkCancelled()) return;

    let items;
    try {
      items = await this._listFolder(opts.folderId, opts.includeSharedDrives);
    } catch (e) {
      this._pushError({ folder: opts.folderId, code: this._grantCode(e, 'LIST_FAILED'), reason: e.message });
      await this._pushProgress(opts);
      return;
    }
    // Shortcuts can point anywhere — other drives, loops, or (under the
    // drive.file scope) targets the user never granted. Same policy as
    // uppy's picker importer: never follow them, record the skip.
    items = items.filter((i) => {
      if (i.mimeType === 'application/vnd.google-apps.shortcut') {
        this._pushError({ file: i.name, code: 'SHORTCUT_SKIPPED', reason: 'shortcuts are not followed' });
        return false;
      }
      return true;
    });
    const FOLDER = 'application/vnd.google-apps.folder';
    const subFolders = items.filter((i) => i.mimeType === FOLDER);
    const files = items.filter((i) => i.mimeType !== FOLDER);
    this.totalFolders += 1;
    this.totalFiles += files.length;
    await this._pushProgress(opts);

    // Folders FIRST, SERIALLY: a child node needs its parent to exist before
    // creation, and _createFolder idempotency relies on ordered creation —
    // never parallelize this.
    for (const folder of subFolders) {
      if (await this._checkCancelled()) return;
      const subDestFolder = await this._createFolder(folder.name, opts.destFolder, opts.hubDb, opts.userId);
      await this._traverse({ ...opts, folderId: folder.id, destFolder: subDestFolder });
      if (this._cancelled) return; // propagate cancel up from a nested folder
    }

    // Files: bounded-parallel through the instance semaphore. Downloads overlap;
    // the per-folder DB create+resolve is race-safe because filenames are unique
    // within a Drive folder (see _importItem id resolution). _importItemGuarded
    // never rejects, so allSettled keeps siblings alive when one file fails.
    const tasks = [];
    for (const file of files) {
      if (await this._checkCancelled()) break;       // stop DISPATCHING new work
      tasks.push(this._limit(() => this._importItemGuarded(file, opts)));
    }
    await Promise.allSettled(tasks);                  // keep this frame alive until all settle
    await this._pushProgress(opts);                   // flush the final partial batch
    if (this._cancelled) return;
  }

  /**
   * Pool task for one file: resume-skip, import, synchronous counter update,
   * capped error capture, batched progress. NEVER rejects (paired with
   * Promise.allSettled) so one bad file can't abort its folder's pool.
   */
  async _importItemGuarded(item, opts) {
    if (this._cancelled) return;                      // drain fast once cancelled
    // Already imported in a prior attempt of this job (keyed by Drive id) —
    // skip the download + DB work, just account for it.
    if (this._done.has(item.id)) {
      this.processedFiles += 1;
      this._onFileComplete(opts);
      return;
    }
    try {
      await this._importItem(item, opts);
      this.processedFiles += 1;                       // synchronous, immediately post-await
      await this._markDone(item.id);
      this._onFileComplete(opts, item.name);
    } catch (e) {
      // A cancel-induced throw (download aborted mid-backoff) is not a real file
      // error — don't pollute errors[] with it.
      if (this._cancelled) return;
      this._pushError({ file: item.name, code: this._grantCode(e, 'IMPORT_FAILED'), reason: e.message });
      this._onFileComplete(opts);
    }
  }

  /**
   * Flush progress every PROGRESS_BATCH completions across the pool. The counter
   * body is synchronous (no await) so concurrent callers can't interleave it;
   * the progress write is fire-and-forget (it self-catches) to keep tasks short.
   */
  _onFileComplete(opts, currentFilename) {
    this._completedSinceUpdate += 1;
    if (this._completedSinceUpdate >= PROGRESS_BATCH) {
      this._completedSinceUpdate = 0;
      this._pushProgress(opts, currentFilename);
    }
  }

  /**
   * Record a file as durably imported: in-memory (this run's de-dup) + Redis
   * (cross-attempt resume, TTL-bounded). One pipelined round-trip; best-effort.
   */
  async _markDone(itemId) {
    this._done.add(itemId);
    try {
      await migrationQueue.client.multi()
        .sadd(this._doneKey, itemId)
        .expire(this._doneKey, DONE_TTL_SEC)
        .exec();
    } catch (_) { /* in-memory set still de-dups this run */ }
  }

  /**
   * Append an error, but cap the RETAINED list at MAX_ERRORS so a run with
   * thousands of failing files can't bloat job.returnvalue (Redis). errorCount
   * keeps the true total; the FE shows it as "N errors (M shown)".
   */
  _pushError(entry) {
    this.errorCount += 1;
    if (this.errors.length < MAX_ERRORS) this.errors.push(entry);
  }

  /**
   * Push the latest counts to Bull. The FE reads `job.progress` via
   * `get_status` between polls.
   */
  async _pushProgress(_opts, currentFilename) {
    const payload = {
      processed_files: this.processedFiles,
      total_files: this.totalFiles,
      total_folders: this.totalFolders,
      errors_count: this.errorCount,
    };
    if (currentFilename) payload.current_filename = currentFilename;
    try {
      await this.job.progress(payload);
    } catch (e) {
      // Bull progress write failures are non-fatal — log only.
      console.warn(`[GDriveImporter] job.progress failed:`, e && e.message);
    }
  }

  /**
   * Returns true if the Redis cancellation sentinel is set OR the job has
   * been removed (cancellation by `job.remove()` for waiting jobs).
   */
  async _checkCancelled() {
    try {
      if (await isCancelled(this.job.id)) {
        this._cancelled = true;
        return true;
      }
    } catch (_) {}
    return false;
  }

  /**
   * Per-file import. Mirrors the existing ExtImport._importFileInternal
   * inline because the worker doesn't have access to `this` of the
   * ExtImport subclass.
   */
  async _importItem(item, opts) {
    let filename = item.name;
    let exportMime = null;
    // Shared-drive files need supportsAllDrives on the download call too.
    const sharedParam = opts.includeSharedDrives ? '&supportsAllDrives=true' : '';
    // Canonical authenticated download. webContentLink is a browser-cookie
    // link: for files >25MB Drive serves a virus-scan interstitial HTML page,
    // and it can 302 to a googleusercontent host that ignores the Bearer
    // header — both silently corrupt the import. alt=media streams raw bytes.
    let downloadUrl = `https://www.googleapis.com/drive/v3/files/${item.id}?alt=media${sharedParam}`;

    const isWorkspaceDoc =
      typeof item.mimeType === 'string' &&
      item.mimeType.startsWith('application/vnd.google-apps');
    if (isWorkspaceDoc) {
      // Google Workspace doc — has no binary content; must be exported.
      // Docs export as DOCX (editable, layout preserved) to match the
      // Sheets→XLSX / Slides→PPTX convention — PDF froze the document into a
      // non-editable, often distorted rendering.
      const EXPORT = {
        'google-apps.document':     { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',              ext: 'docx' },
        'google-apps.spreadsheet':  { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',                    ext: 'xlsx' },
        'google-apps.presentation': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',            ext: 'pptx' },
        'google-apps.drawing':      { mime: 'image/png',                                                                            ext: 'png'  },
      };
      const match = Object.entries(EXPORT).find(([k]) => item.mimeType.includes(k));
      if (!match) {
        throw new Error(`unsupported Workspace type: ${item.mimeType}`);
      }
      const [, exp] = match;
      downloadUrl = `https://www.googleapis.com/drive/v3/files/${item.id}/export?mimeType=${encodeURIComponent(exp.mime)}${sharedParam}`;
      filename = `${filename}.${exp.ext}`;
      exportMime = exp.mime;
    }

    // Conflict policy (Phase 1 = 'skip'). The dedup check needs the dest
    // folder's logical path; mfs_node_attr may omit file_path ("by security")
    // for an existing folder, so guard it — skip the check and create rather
    // than crash on join(undefined, …). Worst case: a duplicate on re-run.
    const destPath = opts.destFolder && opts.destFolder.file_path;
    if (destPath) {
      // Probe with the name the node is actually STORED under, not the Drive
      // one: mfs_create_node rewrites it (storedNodeName).
      // A '/' happens to survive this probe either way — node_id_from_path
      // compares REPLACE(file_path,'/','') against REPLACE(_path,'/',''), so
      // '<dest>/a/b.pdf' and the stored '<dest>/ab.pdf' collapse to the same
      // string. The rewrites it does NOT tolerate are the other ones: a name
      // like 'doc <v2>.docx' is stored as 'doc .docx' and 'trailing .pdf' as
      // 'trailing.pdf', so probing the raw name missed them and a re-run
      // duplicated the file instead of skipping it.
      const probeExt = extname(filename).replace(/^\.+/, '').toLowerCase();
      const probeBase = storedNodeName(
        probeExt ? filename.slice(0, -(probeExt.length + 1)) : filename
      );
      const probeName = probeExt ? `${probeBase}.${probeExt}` : probeBase;
      const existingId = await opts.hubDb.await_func('node_id_from_path', join(destPath, probeName));
      if (existingId != null) {
        if (opts.conflictPolicy === 'skip') return;        // silent skip
        throw new Error('conflict policy not implemented yet'); // Phase 2 handles overwrite/rename
      }
    }

    // Lowercase the extension. It flows into BOTH the media node's `extension`
    // column AND the on-disk file name (`orig.<ext>`). The server always reads
    // the original back as `orig.<ext.toLowerCase()>` (get_node_content), so an
    // uppercase Drive extension (e.g. "L.PNG") would write `orig.PNG` but be read
    // as `orig.png` — a mismatch on a case-sensitive (Linux) filesystem → the
    // file is "not found" → the image shows no thumbnail and won't open. The
    // filecap lookup is case-insensitive either way.
    const ext = extname(filename).replace(/^\.+/, '').toLowerCase();
    // Cache key includes file.id + (optional) export mime so two different
    // Workspace export formats of the same doc don't collide on the URL
    // base. The cache lives in the per-job scratch dir so it's wiped at
    // end-of-job (fixes /tmp growth + cross-job leaks).
    const keyInput = `${item.id}|${exportMime || ''}`;
    const hash = createHash('md5').update(keyInput).digest('hex');
    const cacheKey = ext ? `${hash}.${ext}` : hash;
    const source = join(this._scratchDir, cacheKey);

    if (!existsSync(source)) {
      // Atomic write: stream to `.part`, rename on full success. The whole
      // download (token fetch + GET + stream) is retried as a unit so a 429/5xx
      // or a mid-stream ECONNRESET re-streams cleanly: createWriteStream
      // truncates `.part` on each attempt, the rename runs only after a complete
      // stream, and the token is re-read inside so a long download can't 401.
      const partFile = `${source}.part`;
      await withDriveRetry(async () => {
        const accessToken = await this._getFreshToken();
        const dl = await axios.get(downloadUrl, {
          headers: { Authorization: `Bearer ${accessToken}` },
          responseType: 'stream',
          maxRedirects: 5,
          timeout: DRIVE_HTTP_TIMEOUT_MS,
        });
        await new Promise((resolve, reject) => {
          const out = createWriteStream(partFile);
          let settled = false;
          const done = (err) => {
            if (settled) return;
            settled = true;
            if (err) {
              try { unlinkSync(partFile); } catch (_) {}
              reject(err);
            } else resolve();
          };
          dl.data.on('error', done);
          out.on('error', done);
          out.on('finish', () => done(null));
          dl.data.pipe(out);
        });
      }, { onAuth: () => { this._tokenCache = null; }, isCancelled: () => this._checkCancelled() });
      // rename is atomic on the same filesystem — readers will only ever
      // see the complete file at `source`.
      await fsp.rename(partFile, source);
    }

    const stat = await fsp.stat(source);
    if (stat.isDirectory()) throw new Error('downloaded source is a directory');

    // Resolve filetype/mimetype from Drumee filecap table.
    let filetype, mimetype = item.mimeType;
    const cap = toArray(await this.yp.await_query(
      `SELECT category, mimetype FROM filecap WHERE extension=?`, ext
    ))[0];
    if (cap) {
      filetype = cap.category;
      mimetype = cap.mimetype || mimetype;
    }
    if (!filetype) filetype = 'other';

    // home_dir = the hub-wide root captured in run() (never a sub-folder's,
    // which may be absent). owner_id falls back to the migrating user when the
    // dest folder doesn't expose it (mfs_node_attr has no owner_id column).
    // pid = the dest folder's node id (files become its children).
    const home_dir = opts.hubHomeDir;
    // Valid owner_id is required (NULL → mfs_create_node rolls back). Prefer
    // the migrating user (like media.make_dir's owner_id = uid); the dest
    // folder's hub_id is the same entity for a private-home migration.
    const owner_id = opts.userId
      || (opts.destFolder && (opts.destFolder.owner_id || opts.destFolder.hub_id));
    const pid = opts.destFolder && opts.destFolder.nid;
    if (!home_dir || !pid) throw new Error('dest folder unresolved (home_dir/pid missing)');

    const filenameWithoutExt = filename.replace(new RegExp(`\\.(${ext})$`, 'i'), '');

    // Create the node, resolve its id, and write the bytes as ONE critical
    // section serialized per parent folder (_withPidLock). mfs_create_node's
    // CALL return shape is unreliable in the worker, so the id is resolved with
    // a direct SELECT — and because mfs_create_node AUTO-RENAMES a duplicate
    // filename (S → S(1)), a match by the ORIGINAL name would resolve the wrong
    // (already-written) node, leaving the duplicate byte-less (no thumbnail /
    // won't open). Resolving the NEWEST child under pid instead is exact — but
    // only while creates under this pid don't interleave, which the lock
    // guarantees. Downloads (the slow part) already ran in parallel above.
    await this._withPidLock(pid, async () => {
      await opts.hubDb.await_proc(
        'mfs_create_node',
        {
          owner_id,
          filename: filenameWithoutExt,
          pid,
          category: filetype,
          ext,
          mimetype,
          filesize: item.size || stat.size,
          showResults: 1,
        },
        {},
        { isOutput: 1 }
      );
      const nodeId = await this._findNewestChildId(opts.hubDb, pid);
      if (!nodeId) throw new Error(`could not resolve created file '${filenameWithoutExt}' under pid=${pid}`);

      const base = join(home_dir, '__storage__', nodeId);
      await fsp.mkdir(base, { recursive: true });
      await fsp.copyFile(source, join(base, `orig.${ext}`));
    });
    // Free the scratch copy immediately after the durable write so peak /tmp
    // stays at ~one file instead of the whole tree — a 10k-file import would
    // otherwise accumulate every downloaded byte until the end-of-job rm in
    // run() (→ ENOSPC). async fsp.unlink (never unlinkSync) per the Bull
    // lock-stall invariant. Best-effort: the end-of-job rm is the backstop.
    // Trade-off: defeats the in-job same-id dedup (existsSync on `source`) for
    // a file.id|exportMime that appears twice in one tree — rare, acceptable.
    try { await fsp.unlink(source); } catch (_) {}
  }

  /**
   * Find a child node's id by (parent, name) via a direct media SELECT.
   * mfs_create_node is a CALL with an OUT param: its result shape through the
   * worker's connection is unreliable (a raw [resultSet, okPacket] array, not
   * a clean row), so we never read the id from its return. A plain SELECT
   * (await_query) yields clean rows, so we resolve the id this way instead.
   * Returns the id string or null.
   */
  async _findChildId(hubDb, pid, name, isFolder) {
    const rows = await hubDb.await_query(
      `SELECT id FROM media
         WHERE parent_id = ? AND user_filename = ?
           ${isFolder ? "AND category = 'folder'" : "AND category <> 'folder'"}
         ORDER BY id ASC LIMIT 1`,
      pid, name
    );
    const row = toArray(rows)[0];
    return (row && row.id) || null;
  }

  /**
   * Resolve the id of the just-created FILE node as the newest non-folder child
   * under `pid` (highest sys_id). Correct only while called inside the pid lock
   * (no interleaving creates under this pid) — but then it's exact even when
   * mfs_create_node auto-renamed a duplicate filename, which a name match can't
   * handle. Returns the id string or null.
   */
  async _findNewestChildId(hubDb, pid) {
    const rows = await hubDb.await_query(
      `SELECT id FROM media
         WHERE parent_id = ? AND category <> 'folder'
         ORDER BY sys_id DESC LIMIT 1`,
      pid
    );
    const row = toArray(rows)[0];
    return (row && row.id) || null;
  }

  /**
   * Folder counterpart of _findNewestChildId, with the same contract: exact
   * only while called inside the pid lock. Needed as the last-resort resolve
   * after a create, because unique_filename() auto-renames a duplicate
   * (S → S(1)) and a by-name lookup cannot follow that rename.
   */
  async _findNewestFolderChildId(hubDb, pid) {
    const rows = await hubDb.await_query(
      `SELECT id FROM media
         WHERE parent_id = ? AND category = 'folder'
         ORDER BY sys_id DESC LIMIT 1`,
      pid
    );
    const row = toArray(rows)[0];
    return (row && row.id) || null;
  }

  async _createFolder(name, parentFolder, hubDb, ownerId) {
    const pid = parentFolder && parentFolder.nid;
    if (pid == null) throw new Error(`_createFolder: parent has no nid (name=${name})`);
    // owner_id MUST be a valid entity id. mfs_create_node looks it up
    // (db_name/username) and runs user_permission() in its result SELECT — a
    // NULL owner_id throws inside the proc, its SQLEXCEPTION handler rolls the
    // whole INSERT back, and the folder is silently not created. mfs_node_attr
    // doesn't expose owner_id, so fall back to the migrating user / hub entity
    // (this is exactly what media.make_dir does: owner_id = uid).
    const owner_id = ownerId
      || (parentFolder && (parentFolder.owner_id || parentFolder.hub_id || parentFolder.home_id));
    // mfs_create_node REWRITES the filename before storing it (storedNodeName
    // mirrors the proc's regexes): Drive allows '/' in a name, the MFS does
    // not, so a folder 'Marketing report 2024/2025' is stored as
    // 'Marketing report 20242025'. Look up AND create with that stored form.
    //
    // Matching on the raw Drive name instead used to miss the node the proc had
    // just created, and since this throw is NOT caught per-item (unlike files,
    // which go through _importItemGuarded) it aborted the entire migration —
    // reported to the user as "Migration failed … 0 errors". Worse, the
    // existence check missed it too, so every "Try again" left behind another
    // unique_filename duplicate ('…(1)', '…(2)', …).
    //
    // A name that rewrites to empty (a folder literally called '/' or '<x>')
    // cannot be matched meaningfully; fall back to a usable name. Two such
    // folders under one parent would then share a node — vanishingly rare, and
    // still better than aborting the run.
    const stored = storedNodeName(name) || 'folder';
    // Serialize per parent, like the file path already does: the newest-child
    // fallback below is only exact while creates under this pid can't
    // interleave. Folders are created serially by _traverse anyway, so this
    // costs no parallelism.
    return await this._withPidLock(pid, async () => {
      // Idempotent: reuse an existing child folder, else create. Resolve the id
      // with a direct query (not the unreliable mfs_create_node CALL return),
      // then re-read via mfs_node_attr for a clean { nid, file_path, home_dir }.
      let id = await this._findChildId(hubDb, pid, stored, true);
      if (id == null) {
        await hubDb.await_proc('mfs_create_node', {
          owner_id,
          filename: stored,
          pid,
          category: 'folder',
          ext: '',
          // media.mimetype is NOT NULL — a folder INSERT with a null mimetype
          // hits the proc's SQLEXCEPTION handler and silently rolls back (files
          // worked because they resolve a mimetype from filecap). 'folder'
          // mirrors what media.make_dir stores.
          mimetype: 'folder',
          filesize: 0,
          showResults: 1,
        }, {}, { isOutput: 1 });
        id = await this._findChildId(hubDb, pid, stored, true);
        // unique_filename() auto-renames a duplicate (S → S(1)), which a
        // by-name lookup cannot follow. Inside the lock, the newest folder
        // child under pid IS the node we just created.
        if (id == null) id = await this._findNewestFolderChildId(hubDb, pid);
      }
      if (id == null) {
        throw new Error(
          `could not resolve folder '${name}' (stored as '${stored}') under pid=${pid} (owner_id=${owner_id})`
        );
      }
      return await hubDb.await_proc('mfs_node_attr', id);
    });
  }
}

module.exports = GoogleDriveImporter;
