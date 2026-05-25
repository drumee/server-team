/**
 * Per-job Google Drive importer. Constructed with a `job_id`; `run()`
 * traverses the source folder tree (paginated, includes Shared Drives if
 * the job spec says so) and downloads each file via an inline copy of
 * the ExtImport._importFileInternal logic (the worker doesn't carry a
 * service-class `this`, so duplication is intentional).
 *
 * Side effects:
 *  - UPDATEs migration_jobs (status, processed_files, total_folders, errors_json).
 *  - Phase 2 wires WS push via RedisStore.sendData; Phase 1 leaves
 *    progress polling-only.
 *
 * Cancellation contract: the worker reads migration_jobs.status between
 * files. If it's 'cancelled', the importer returns early. Bull `attempts`
 * still apply on uncaught throws.
 */

const axios = require('axios');
const { Mariadb, toArray, Cache } = require('@drumee/server-essentials');
const { existsSync, mkdirSync, cpSync, statSync, createWriteStream } = require('fs');
const { join, extname } = require('path');
const { createHash } = require('crypto');
const { google } = require('googleapis');

const PROGRESS_BATCH = 5;
const PAGE_SIZE = 1000;

class GoogleDriveImporter {
  constructor(job_id, yp /* shared yp connection */) {
    this.job_id = job_id;
    this.yp = yp;
    this.errors = [];
  }

  async run() {
    const job = await this._loadJob();
    if (!job) throw new Error(`job ${this.job_id} not found`);
    if (job.status !== 'queued' && job.status !== 'running') {
      console.log(`[GDriveImporter] job ${this.job_id} status=${job.status} — skipping`);
      return;
    }

    await this._setRunning();
    let token;
    try {
      token = await this._ensureFreshToken(job.user_id);
    } catch (e) {
      await this._fail(`NEEDS_RECONNECT: ${e.message}`);
      return;
    }

    // Resolve dest folder via mfs_node_attr in the hub's DB.
    const hub = toArray(await this.yp.await_proc('entity_exists', job.dest_hub_id))[0];
    if (!hub || !hub.db_name) {
      await this._fail(`dest_hub ${job.dest_hub_id} not found`);
      return;
    }
    const hubDb = new Mariadb({ name: hub.db_name });
    let destFolder;
    try {
      destFolder = await hubDb.await_proc('mfs_node_attr', job.dest_nid);
      if (!destFolder || !destFolder.home_dir) {
        await this._fail(`dest_nid ${job.dest_nid} invalid`);
        return;
      }

      await this._traverse({
        folderId: job.source_folder_id || 'root',
        destFolder,
        hubDb,
        accessToken: token,
        includeSharedDrives: !!job.include_shared_drives,
        conflictPolicy: job.conflict_policy || 'skip',
        userId: job.user_id,
      });
    } finally {
      if (hubDb && hubDb.connection) await hubDb.end().catch(() => {});
    }

    await this._complete();
  }

  async _loadJob() {
    return toArray(await this.yp.await_query(
      `SELECT id, user_id, provider, source_folder_id, dest_hub_id, dest_nid,
              status, conflict_policy, include_shared_drives
       FROM migration_jobs WHERE id=?`, this.job_id
    ))[0];
  }

  async _setRunning() {
    await this.yp.await_query(
      `UPDATE migration_jobs SET status='running', started_at=UNIX_TIMESTAMP() WHERE id=?`,
      this.job_id
    );
  }

  async _fail(reason) {
    this.errors.push({ code: 'JOB_FAILED', reason });
    await this.yp.await_query(
      `UPDATE migration_jobs
         SET status='failed', errors_json=?, finished_at=UNIX_TIMESTAMP()
       WHERE id=?`,
      JSON.stringify(this.errors), this.job_id
    );
    console.warn(`[GDriveImporter] job ${this.job_id} failed: ${reason}`);
  }

  async _complete() {
    await this.yp.await_query(
      `UPDATE migration_jobs
         SET status='done', errors_json=?, finished_at=UNIX_TIMESTAMP()
       WHERE id=? AND status='running'`,
      JSON.stringify(this.errors), this.job_id
    );
  }

  /**
   * Same logic as ExtImport.ensureFreshToken but called from the worker
   * context (no `this.uid`); takes user_id explicitly.
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
    const fresh = await this._loadJob();
    if (!fresh || fresh.status === 'cancelled') return;

    let items;
    try {
      items = await this._listFolder(opts.folderId, opts.accessToken, opts.includeSharedDrives);
    } catch (e) {
      this.errors.push({ folder: opts.folderId, code: 'LIST_FAILED', reason: e.message });
      await this._persistErrors();
      return;
    }
    // Count this folder + its subfolders as we discover them.
    await this.yp.await_query(
      `UPDATE migration_jobs SET total_folders = total_folders + 1 WHERE id=?`,
      this.job_id
    );

    let countSinceUpdate = 0;
    for (const item of items) {
      // Per-file cancellation poll.
      if (countSinceUpdate >= PROGRESS_BATCH) {
        const fresh2 = await this._loadJob();
        if (!fresh2 || fresh2.status === 'cancelled') return;
        countSinceUpdate = 0;
      }

      if (item.mimeType === 'application/vnd.google-apps.folder') {
        // Subfolder — create in MFS, recurse.
        const subDestFolder = await this._createFolder(item.name, opts.destFolder, opts.hubDb);
        await this._traverse({ ...opts, folderId: item.id, destFolder: subDestFolder });
        continue;
      }

      try {
        await this._importItem(item, opts);
        await this.yp.await_query(
          `UPDATE migration_jobs SET processed_files = processed_files + 1 WHERE id=?`,
          this.job_id
        );
        countSinceUpdate++;
      } catch (e) {
        this.errors.push({ file: item.name, code: 'IMPORT_FAILED', reason: e.message });
        await this._persistErrors();
      }
    }
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

  async _persistErrors() {
    await this.yp.await_query(
      `UPDATE migration_jobs SET errors_json=? WHERE id=?`,
      JSON.stringify(this.errors), this.job_id
    );
  }
}

module.exports = GoogleDriveImporter;
