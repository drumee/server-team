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
    try {
      const destFolder = await hubDb.await_proc('mfs_node_attr', nid);
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

  /**
   * Fetch a single item's metadata (selected mode). The server resolves the
   * name/mimeType itself — never trusts client-supplied names.
   */
  async _getMeta(id) {
    const token = await this._getFreshToken();
    const res = await axios.get(`https://www.googleapis.com/drive/v3/files/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { fields: 'id, name, mimeType, size' },
    });
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
        this.errors.push({ folder: folderId, code: 'META_FAILED', reason: e.message });
        await this._pushProgress(base);
        continue;
      }
      const sub = await this._createFolder(meta.name, rootFolder, opts.hubDb, opts.userId);
      await this._traverse({ ...base, folderId, destFolder: sub });
      if (this._cancelled) return;
    }

    for (const fileId of (selections.file_ids || [])) {
      if (await this._checkCancelled()) return;
      let meta;
      try {
        meta = await this._getMeta(fileId);
      } catch (e) {
        this.errors.push({ file: fileId, code: 'META_FAILED', reason: e.message });
        await this._pushProgress(base);
        continue;
      }
      this.totalFiles += 1;
      try {
        await this._importItem(meta, { ...base, destFolder: rootFolder });
        this.processedFiles += 1;
        await this._pushProgress(base, meta.name);
      } catch (e) {
        this.errors.push({ file: meta.name, code: 'IMPORT_FAILED', reason: e.message });
        await this._pushProgress(base);
      }
    }
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
        const subDestFolder = await this._createFolder(item.name, opts.destFolder, opts.hubDb, opts.userId);
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

    // Conflict policy (Phase 1 = 'skip'). The dedup check needs the dest
    // folder's logical path; mfs_node_attr may omit file_path ("by security")
    // for an existing folder, so guard it — skip the check and create rather
    // than crash on join(undefined, …). Worst case: a duplicate on re-run.
    const destPath = opts.destFolder && opts.destFolder.file_path;
    if (destPath) {
      const existingId = await opts.hubDb.await_func('node_id_from_path', join(destPath, filename));
      if (existingId != null) {
        if (opts.conflictPolicy === 'skip') return;        // silent skip
        throw new Error('conflict policy not implemented yet'); // Phase 2 handles overwrite/rename
      }
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
    // Resolve the new node id with a direct query (mfs_create_node's CALL
    // return shape is unreliable in the worker). Match by (pid, name); fall
    // back to the most-recent non-folder child under pid — files are imported
    // sequentially within a job, so that's the one just created.
    let nodeId = await this._findChildId(opts.hubDb, pid, filenameWithoutExt, false);
    if (!nodeId) {
      const rows = await opts.hubDb.await_query(
        `SELECT id FROM media WHERE parent_id = ? AND category <> 'folder' ORDER BY id DESC LIMIT 1`,
        pid
      );
      nodeId = (toArray(rows)[0] || {}).id || null;
    }
    if (!nodeId) throw new Error(`could not resolve created file '${filenameWithoutExt}' under pid=${pid}`);

    const base = join(home_dir, '__storage__', nodeId);
    const orig = join(base, `orig.${ext}`);
    await fsp.mkdir(base, { recursive: true });
    await fsp.copyFile(source, orig);
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
    // Idempotent: reuse an existing child folder, else create. Resolve the id
    // with a direct query (not the unreliable mfs_create_node CALL return),
    // then re-read via mfs_node_attr for a clean { nid, file_path, home_dir }.
    let id = await this._findChildId(hubDb, pid, name, true);
    if (id == null) {
      await hubDb.await_proc('mfs_create_node', {
        owner_id,
        filename: name,
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
      id = await this._findChildId(hubDb, pid, name, true);
    }
    if (id == null) throw new Error(`could not resolve folder '${name}' under pid=${pid} (owner_id=${owner_id})`);
    return await hubDb.await_proc('mfs_node_attr', id);
  }
}

module.exports = GoogleDriveImporter;
