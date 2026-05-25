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
const { Mariadb, toArray, Cache } = require('@drumee/server-essentials');
const { existsSync, mkdirSync, cpSync, statSync, createWriteStream } = require('fs');
const { join, extname } = require('path');
const { createHash } = require('crypto');
const { google } = require('googleapis');
const { isCancelled } = require('../../queues/migrationQueue');

const PROGRESS_BATCH = 5;
const PAGE_SIZE = 1000;

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

    // Token refresh — throws NEEDS_RECONNECT if no refresh_token / refresh
    // call fails. Bull marks the job 'failed' and retries with exp backoff;
    // after attempts exhausted, errors carry the reason.
    const token = await this._ensureFreshToken(user_id);

    // Resolve dest folder via mfs_node_attr in the hub's DB.
    const hub = toArray(await this.yp.await_proc('entity_exists', hub_id))[0];
    if (!hub || !hub.db_name) throw new Error(`dest_hub ${hub_id} not found`);

    const hubDb = new Mariadb({ name: hub.db_name });
    try {
      const destFolder = await hubDb.await_proc('mfs_node_attr', nid);
      if (!destFolder || !destFolder.home_dir) {
        throw new Error(`dest_nid ${nid} invalid`);
      }

      await this._traverse({
        folderId: source_folder_id,
        destFolder,
        hubDb,
        accessToken: token,
        includeSharedDrives: !!include_shared_drives,
        conflictPolicy: conflict_policy,
        userId: user_id,
      });
    } finally {
      if (hubDb && hubDb.connection) await hubDb.end().catch(() => {});
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
   * Same logic as ExtImport.ensureFreshToken but takes user_id explicitly
   * (worker has no `this.uid`).
   */
  async _ensureFreshToken(user_id) {
    const row = toArray(await this.yp.await_query(
      'SELECT access_token, refresh_token, expires_at, scope FROM oauth_accounts WHERE user_id=? AND provider=?',
      user_id, 'google'
    ))[0];
    if (!row) throw new Error('NEEDS_RECONNECT');
    const now = Math.floor(Date.now() / 1000);
    if (row.expires_at && row.expires_at - 60 > now) return row.access_token;
    if (!row.refresh_token) throw new Error('NEEDS_RECONNECT');

    const oauth2 = new google.auth.OAuth2(
      Cache.getSysConf('google_client_id'),
      Cache.getSysConf('google_client_secret')
    );
    oauth2.setCredentials({ refresh_token: row.refresh_token });
    const { credentials } = await oauth2.refreshAccessToken();
    if (!credentials || !credentials.access_token) throw new Error('NEEDS_RECONNECT');
    const newExpiresAt = credentials.expiry_date
      ? Math.floor(credentials.expiry_date / 1000)
      : now + 3500;
    await this.yp.await_query(
      'UPDATE oauth_accounts SET access_token=?, expires_at=?, mtime=UNIX_TIMESTAMP() WHERE user_id=? AND provider=?',
      credentials.access_token, newExpiresAt, user_id, 'google'
    );
    return credentials.access_token;
  }

  async _listFolder(folderId, accessToken, includeSharedDrives) {
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
      items = await this._listFolder(opts.folderId, opts.accessToken, opts.includeSharedDrives);
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
      // Per-batch cancellation poll.
      if (countSinceUpdate >= PROGRESS_BATCH) {
        if (await this._checkCancelled()) return;
        countSinceUpdate = 0;
      }

      if (item.mimeType === 'application/vnd.google-apps.folder') {
        const subDestFolder = await this._createFolder(item.name, opts.destFolder, opts.hubDb);
        await this._traverse({ ...opts, folderId: item.id, destFolder: subDestFolder });
        continue;
      }

      try {
        await this._importItem(item, opts);
        this.processedFiles += 1;
        countSinceUpdate++;
        await this._pushProgress(opts, item.name);
      } catch (e) {
        this.errors.push({ file: item.name, code: 'IMPORT_FAILED', reason: e.message });
        await this._pushProgress(opts);
      }
    }
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
    let downloadUrl = item.webContentLink;
    let filename = item.name;

    if (!downloadUrl) {
      // Google Workspace file — export.
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
      downloadUrl = `https://www.googleapis.com/drive/v3/files/${item.id}/export?mimeType=${encodeURIComponent(exp.mime)}`;
      filename = `${filename}.${exp.ext}`;
    }

    // Conflict policy. Phase 1 = 'skip' only — Phase 2 expands.
    const pathname = join(opts.destFolder.file_path, filename);
    const existingId = await opts.hubDb.await_func('node_id_from_path', pathname);
    if (existingId != null) {
      if (opts.conflictPolicy === 'skip') return;        // silent skip
      throw new Error('conflict policy not implemented yet'); // Phase 2 handles overwrite/rename
    }

    // Download — cache in /tmp keyed by URL hash. Strip Drive's `?alt=…&t=…`
    // query so two requests for the same file hit the same cache slot.
    const ext = extname(filename).replace(/^\.+/, '');
    const stripped = downloadUrl.split('?')[0];
    const hash = createHash('md5').update(stripped).digest('hex');
    const cacheKey = ext ? `${hash}.${ext}` : hash;
    const source = join('/tmp', cacheKey);

    if (!existsSync(source)) {
      const dl = await axios.get(downloadUrl, {
        headers: { Authorization: `Bearer ${opts.accessToken}` },
        responseType: 'stream',
        maxRedirects: 5,
      });
      await new Promise((resolve, reject) => {
        const out = createWriteStream(source);
        dl.data.pipe(out);
        out.on('finish', resolve);
        out.on('error', reject);
      });
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
