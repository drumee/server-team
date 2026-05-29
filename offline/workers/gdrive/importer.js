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
const { existsSync, mkdirSync, cpSync, statSync, createWriteStream, unlinkSync, rmSync } = require('fs');
const { join, extname } = require('path');
const { createHash } = require('crypto');
const { google } = require('googleapis');
const { isCancelled } = require('../../queues/migrationQueue');
const { googleDriveCredentials } = require('../../../service/lib/google_credentials');

const PROGRESS_BATCH = 5;
const PAGE_SIZE = 1000;
// Refresh the access token 60s before its server-side expiry so a
// long-running job (large files, slow network) doesn't fail mid-traverse
// with a 401 on every Drive request.
const TOKEN_SAFETY_SEC = 60;

class GoogleDriveImporter {
  /**
   * @param {import('bull').Job} job  — Bull job instance
   * @param {object} yp               — shared yp Mariadb connection
   */
  constructor(job, yp) {
    this.job = job;
    this.data = job.data || {};
    this.yp = yp;
    this.errors = [];
    this.processedFiles = 0;
    this.totalFolders = 0;
    this.totalFiles = 0;
    this._cancelled = false;
    // Token cache populated lazily; refreshed when expires_at - safety < now.
    this._tokenCache = null;          // { access_token, expires_at }
    // Per-job scratch dir — wiped on completion to avoid /tmp growing
    // unboundedly across migrations. Set in run() once job.id is known.
    this._scratchDir = null;
  }

  async run() {
    const {
      user_id,
      hub_id,
      nid,
      source_folder_id = 'root',
      include_shared_drives = 0,
      conflict_policy = 'skip',
    } = this.data;

    if (!user_id || !hub_id || !nid) {
      throw new Error(`importer: missing required job.data field(s)`);
    }

    this._userId = user_id;
    // Per-job scratch directory — every download lives here and the whole
    // tree is rm-rf'd in finally. Prevents /tmp from filling up across
    // jobs and also walls off cross-job cache leaks.
    this._scratchDir = join('/tmp', `gdrive-job-${this.job.id}`);
    mkdirSync(this._scratchDir, { recursive: true });

    // Prime the token cache — throws NEEDS_RECONNECT if no refresh_token.
    // Subsequent Drive calls use `_getFreshToken()` which lazily refreshes.
    // NEEDS_RECONNECT is not transient (user revoked OAuth) — discard so
    // Bull doesn't burn the remaining attempts retrying the same failure.
    try {
      await this._getFreshToken();
    } catch (e) {
      if (e && e.message === 'NEEDS_RECONNECT') {
        await this.job.discard().catch(() => {});
      }
      throw e;
    }

    // Resolve dest folder via mfs_node_attr in the hub's DB.
    const hub = toArray(await this.yp.await_proc('entity_exists', hub_id))[0];
    if (!hub || !hub.db_name) throw new Error(`dest_hub ${hub_id} not found`);

    const hubDb = new Mariadb({ name: hub.db_name });
    try {
      const destFolder = await hubDb.await_proc('mfs_node_attr', nid);
      if (!destFolder || !destFolder.home_dir) {
        throw new Error(`dest_nid ${nid} invalid`);
      }

      // Everything imported lands in a dedicated "GoogleDriveMigration"
      // folder under the destination (the user's private home), so the
      // migration never scatters loose files into their home. Idempotent:
      // a re-run reuses the existing folder instead of duplicating it.
      const rootFolder = await this._createFolder('GoogleDriveMigration', destFolder, hubDb);

      await this._traverse({
        folderId: source_folder_id,
        destFolder: rootFolder,
        hubDb,
        includeSharedDrives: !!include_shared_drives,
        conflictPolicy: conflict_policy,
        userId: user_id,
      });
    } finally {
      if (hubDb && hubDb.connection) await hubDb.end().catch(() => {});
      // Wipe the per-job scratch dir even on throw — prevents /tmp from
      // accumulating partial downloads across failed jobs.
      try {
        if (this._scratchDir) rmSync(this._scratchDir, { recursive: true, force: true });
      } catch (e) {
        console.warn(`[GDriveImporter] scratch cleanup failed:`, e && e.message);
      }
    }

    // Bull will use this object as `job.returnvalue` on the 'completed'
    // event. The FE reads it via `get_status`.
    return {
      ok: true,
      cancelled: this._cancelled,
      processed_files: this.processedFiles,
      total_files: this.totalFiles,
      total_folders: this.totalFolders,
      errors: this.errors,
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
    const row = toArray(await this.yp.await_query(
      'SELECT access_token, refresh_token, expires_at, scope FROM oauth_accounts WHERE user_id=? AND provider=?',
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
      console.warn(`[GDriveImporter] token refresh failed user=${this._userId}:`, e && e.message);
      throw new Error('NEEDS_RECONNECT');
    }
    if (!credentials || !credentials.access_token) throw new Error('NEEDS_RECONNECT');
    const newExpiresAt = credentials.expiry_date
      ? Math.floor(credentials.expiry_date / 1000)
      : now + 3500;
    await this.yp.await_query(
      'UPDATE oauth_accounts SET access_token=?, expires_at=?, mtime=UNIX_TIMESTAMP() WHERE user_id=? AND provider=?',
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
      // Re-read token before EACH page so a long pagination doesn't 401
      // halfway through a 10k-file folder.
      const accessToken = await this._getFreshToken();
      const res = await axios.get('https://www.googleapis.com/drive/v3/files', {
        headers: { Authorization: `Bearer ${accessToken}` },
        params,
      });
      items.push(...(res.data.files || []));
      pageToken = res.data.nextPageToken;
    } while (pageToken);
    return items;
  }

  async _traverse(opts) {
    // Cancellation gate at the start of each folder.
    if (await this._checkCancelled()) return;

    let items;
    try {
      items = await this._listFolder(opts.folderId, opts.includeSharedDrives);
    } catch (e) {
      this.errors.push({ folder: opts.folderId, code: 'LIST_FAILED', reason: e.message });
      await this._pushProgress(opts);
      return;
    }
    this.totalFolders += 1;
    this.totalFiles += items.filter((i) => i.mimeType !== 'application/vnd.google-apps.folder').length;
    await this._pushProgress(opts);

    let countSinceUpdate = 0;
    for (const item of items) {
      // Cancellation gate before EACH item — keeps the response time
      // tight; was previously `>= PROGRESS_BATCH` which allowed up to 4
      // more files to import after the user clicked Cancel.
      if (await this._checkCancelled()) return;

      if (item.mimeType === 'application/vnd.google-apps.folder') {
        const subDestFolder = await this._createFolder(item.name, opts.destFolder, opts.hubDb);
        await this._traverse({ ...opts, folderId: item.id, destFolder: subDestFolder });
        // Propagate cancel upward from nested folder.
        if (this._cancelled) return;
        continue;
      }

      try {
        await this._importItem(item, opts);
        this.processedFiles += 1;
        countSinceUpdate++;
        // Only flush progress every PROGRESS_BATCH files to avoid hammering
        // Redis for tiny per-file updates.
        if (countSinceUpdate >= PROGRESS_BATCH) {
          await this._pushProgress(opts, item.name);
          countSinceUpdate = 0;
        }
      } catch (e) {
        this.errors.push({ file: item.name, code: 'IMPORT_FAILED', reason: e.message });
        await this._pushProgress(opts);
      }
    }
    if (countSinceUpdate > 0) await this._pushProgress(opts);
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
      errors_count: this.errors.length,
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
      const EXPORT = {
        'google-apps.document':     { mime: 'application/pdf',                                                                      ext: 'pdf'  },
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

    // Conflict policy. Phase 1 = 'skip' only — Phase 2 expands.
    const pathname = join(opts.destFolder.file_path, filename);
    const existingId = await opts.hubDb.await_func('node_id_from_path', pathname);
    if (existingId != null) {
      if (opts.conflictPolicy === 'skip') return;        // silent skip
      throw new Error('conflict policy not implemented yet'); // Phase 2 handles overwrite/rename
    }

    const ext = extname(filename).replace(/^\.+/, '');
    // Cache key includes file.id + (optional) export mime so two different
    // Workspace export formats of the same doc don't collide on the URL
    // base. The cache lives in the per-job scratch dir so it's wiped at
    // end-of-job (fixes /tmp growth + cross-job leaks).
    const keyInput = `${item.id}|${exportMime || ''}`;
    const hash = createHash('md5').update(keyInput).digest('hex');
    const cacheKey = ext ? `${hash}.${ext}` : hash;
    const source = join(this._scratchDir, cacheKey);

    if (!existsSync(source)) {
      // Always refresh token before the download — long downloads can
      // outlive the token if we read it at start-of-job.
      const accessToken = await this._getFreshToken();
      // Atomic write: stream to `.part`, rename on full success. Without
      // the rename gate, a mid-stream network drop leaves a truncated
      // file at `source` that subsequent calls would happily re-use.
      const partFile = `${source}.part`;
      const dl = await axios.get(downloadUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
        responseType: 'stream',
        maxRedirects: 5,
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
      // rename is atomic on the same filesystem — readers will only ever
      // see the complete file at `source`.
      const { renameSync } = require('fs');
      renameSync(partFile, source);
    }

    const stat = statSync(source);
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

    let { home_dir, owner_id, nid } = opts.destFolder;
    home_dir = home_dir.replace(/(\/__storage__.*)$/, '');

    const filenameWithoutExt = filename.replace(new RegExp(`\\.(${ext})$`, 'i'), '');

    const node = await opts.hubDb.await_proc(
      'mfs_create_node',
      {
        owner_id,
        filename: filenameWithoutExt,
        pid: nid,
        category: filetype,
        ext,
        mimetype,
        filesize: item.size || stat.size,
        showResults: 1,
      },
      {},
      { isOutput: 1 }
    );
    if (!node || !node.id) throw new Error('mfs_create_node returned no id');

    const base = join(home_dir, '__storage__', node.id);
    const orig = join(base, `orig.${ext}`);
    mkdirSync(base, { recursive: true });
    cpSync(source, orig, { force: true });
  }

  async _createFolder(name, parentFolder, hubDb) {
    const pathname = join(parentFolder.file_path, name);
    const existingId = await hubDb.await_func('node_id_from_path', pathname);
    if (existingId != null) return await hubDb.await_proc('mfs_node_attr', existingId);
    return await hubDb.await_proc('mfs_create_node', {
      owner_id: parentFolder.owner_id,
      filename: name,
      pid: parentFolder.nid,
      category: 'folder',
      showResults: 1,
    }, {}, { isOutput: 1 });
  }
}

module.exports = GoogleDriveImporter;
