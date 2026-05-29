// lib/ext_import.js
// Base class for external cloud storage import services

const { Mfs } = require("@drumee/server-core");
const { toArray, sysEnv, Network } = require('@drumee/server-essentials');
const { existsSync, mkdirSync, cpSync, statSync } = require("fs");
const { join, extname } = require("path");
const { createHash } = require("crypto");
const { tmp_dir } = sysEnv();

const TMPDIR = `/${tmp_dir}`;

class ExtImport extends Mfs {
  
  /**
   * Get OAuth access token for current user
   * @param {string} provider - 'google', 'dropbox', etc.
   */
  async _getAccessToken(provider) {
    const userId = this.uid;
    if (!userId) {
      throw new Error("User is not authenticated (this.uid is null).");
    }
    
    const tokenData = toArray(await this.yp.await_query(
      'SELECT access_token FROM oauth_accounts WHERE user_id = ? AND provider = ?',
      userId, provider
    ))[0];
    
    if (!tokenData || !tokenData.access_token) {
      this.warn(`[Import] User ${userId} has not linked ${provider} account or token is missing.`);
      throw new Error(`User has not linked ${provider} account or token is missing.`);
    }
    return tokenData.access_token;
  }

  /**
   * Read the current access token; if it's expired (or about to be — 60s
   * safety window) refresh it via the stored refresh_token and persist the
   * new token + expiry back to oauth_accounts.
   *
   * Throws `NEEDS_RECONNECT` if there's no refresh_token (i.e. the row was
   * created by sign-in only, before the elevated scope flow) — caller is
   * expected to surface this to the FE so the user can re-authorize.
   *
   * @param {string} provider — 'google' | 'dropbox' | 'onedrive'
   * @returns {Promise<string>} fresh access_token
   */
  async ensureFreshToken(provider) {
    if (!this.uid) throw new Error('User is not authenticated.');
    const row = toArray(await this.yp.await_query(
      'SELECT access_token, refresh_token, expires_at, scope FROM oauth_accounts WHERE user_id=? AND provider=?',
      this.uid, provider
    ))[0];
    if (!row) throw new Error('NEEDS_RECONNECT');

    const now = Math.floor(Date.now() / 1000);
    const SAFETY = 60;
    // expires_at NULL = unknown (legacy row) → force refresh if possible.
    if (row.expires_at && row.expires_at - SAFETY > now) {
      return row.access_token;
    }
    if (!row.refresh_token) throw new Error('NEEDS_RECONNECT');

    // Provider-specific refresh. Other providers can be added when needed.
    if (provider !== 'google') {
      throw new Error(`Refresh not implemented for provider=${provider}`);
    }
    const { google } = require('googleapis');
    const { googleDriveCredentials } = require('./google_credentials');
    const { id, secret } = googleDriveCredentials();
    const oauth2 = new google.auth.OAuth2(id, secret);
    oauth2.setCredentials({ refresh_token: row.refresh_token });

    let credentials;
    try {
      const res = await oauth2.refreshAccessToken();
      credentials = res.credentials;
    } catch (e) {
      this.warn(`[ext_import] Refresh failed for user=${this.uid} provider=${provider}:`, e.message);
      throw new Error('NEEDS_RECONNECT');
    }
    if (!credentials || !credentials.access_token) {
      throw new Error('NEEDS_RECONNECT');
    }
    const newExpiresAt = credentials.expiry_date
      ? Math.floor(credentials.expiry_date / 1000)
      : Math.floor(Date.now() / 1000) + 3500;

    await this.yp.await_query(
      'UPDATE oauth_accounts SET access_token=?, expires_at=?, mtime=UNIX_TIMESTAMP() WHERE user_id=? AND provider=?',
      credentials.access_token, newExpiresAt, this.uid, provider
    );
    return credentials.access_token;
  }

  /**
   * Import file from external URL to Drumee MFS
   * @param {string} url - Download URL
   * @param {string} filename - Original filename
   * @param {object} destFolder - Destination folder attributes from mfs_node_attr
   * @param {object} attr - File attributes (mimetype, filesize, etc.)
   * @param {string} oauthToken - OAuth token for authorization (optional)
   * @returns {object} Created MFS node
   */
  async _importFileInternal(url, filename, destFolder, attr = {}, oauthToken = null) {
    let { home_dir, owner_id, nid } = destFolder;
    
    // Generate cache key from URL
    const { pathname: urlPath, host } = new URL(url);
    let hash = createHash("md5");
    hash.update(`${host}-${urlPath}`);
    let cacheKey = hash.digest("hex");
    
    let ext = extname(filename).replace(/^\.+/, '');
    if (ext) {
      cacheKey = `${cacheKey}.${ext}`;
    }
    
    const re = new RegExp(`\\.(${ext})$`, 'i');
    const filenameWithoutExt = filename.replace(re, '');
    const pathname = join(destFolder.file_path, filename);
    
    this.debug(`[Import] Importing from ${url} -> ${pathname}`);
    
    // Check if file already exists in MFS
    let existingId = await this.db.await_func('node_id_from_path', pathname);
    if (existingId != null) {
      const orig = join(home_dir, '__storage__', existingId, `orig.${ext}`);
      if (existsSync(orig)) {
        this.debug(`[Import] File already exists at ${pathname}. Skipped.`);
        let node = await this.db.await_proc('mfs_node_attr', existingId);
        return { ...node, ownpath: node.file_path };
      }
      // Node exists but file missing, clean up old record
      this.debug(`[Import] Node exists but file missing. Cleaning up...`);
      await this.db.await_query('DELETE FROM media WHERE id=?', existingId);
    }
    
    // Download file with cache
    const source = join(TMPDIR, cacheKey);
    if (!existsSync(source)) {
      this.debug(`[Import] Downloading ${url} to ${source}`);
      const downloadOptions = {
        method: 'GET',
        outfile: source,
        url: url,
        headers: {}
      };

      if (oauthToken) {
        downloadOptions.headers['Authorization'] = `Bearer ${oauthToken}`;
      }
      
      await Network.request(downloadOptions);
    } else {
      this.debug(`[Import] Using cached file: ${source}`);
    }
    
    // Validate downloaded file
    const stat = statSync(source);
    if (stat.isDirectory()) {
      this.warn(`[Import] Downloaded source is a directory, not a file!`);
      throw new Error("Downloaded source is a directory.");
    }
    
    // Get file type and mimetype from database
    let { filetype, mimetype } = attr;
    if (!filetype || !mimetype) {
      let r = await this.yp.await_query(
        `SELECT category filetype, mimetype FROM filecap WHERE extension = ?`, ext
      );
      ({ filetype, mimetype } = toArray(r)[0] || {});
    }
    if (!mimetype) mimetype = `application/${ext}`;
    if (!filetype) filetype = 'other';
    
    // Clean home_dir path
    home_dir = home_dir.replace(/(\/__storage__.*)$/, '');

    // Create MFS node
    const args = {
      owner_id,
      filename: filenameWithoutExt,
      pid: nid,
      category: filetype,
      ext: ext,
      mimetype: mimetype,
      filesize: attr.filesize || stat.size,
      showResults: 1
    };
    
    const item = await this.db.await_proc("mfs_create_node", args, {}, { isOutput: 1 });
    if (!item || !item.id) {
      this.warn("[Import] Failed to create MFS node with", item, args);
      throw new Error("Failed to create MFS node.");
    }
    
    // Copy file to storage
    const base = join(home_dir, '__storage__', item.id);
    const orig = join(base, `orig.${ext}`);
    mkdirSync(base, { recursive: true });
    
    this.debug(`[Import] Copying ${source} -> ${orig}`);
    cpSync(source, orig, { force: true });
    
    this.debug(`[Import] Successfully imported ${filename} to ${item.file_path}`);
    return item;
  }

  /**
   * Create a folder in MFS
   * @param {string} folderName - Folder name
   * @param {object} parentFolder - Parent folder attributes
   * @returns {object} Created folder node
   */
  async _createFolder(folderName, parentFolder) {
    const pathname = join(parentFolder.file_path, folderName);
    
    // Check if folder already exists
    let existingId = await this.db.await_func('node_id_from_path', pathname);
    if (existingId != null) {
      this.debug(`[Import] Folder already exists: ${pathname}`);
      return await this.db.await_proc('mfs_node_attr', existingId);
    }
    
    // Create folder
    const args = {
      owner_id: parentFolder.owner_id,
      filename: folderName,
      pid: parentFolder.nid,
      category: 'folder',
      showResults: 1
    };
    
    const folder = await this.db.await_proc("mfs_create_node", args, {}, { isOutput: 1 });
    if (!folder || !folder.id) {
      this.warn("[Import] Failed to create folder with", folder, args);
      throw new Error("Failed to create folder.");
    }
    
    this.debug(`[Import] Created folder: ${pathname}`);
    return folder;
  }

  /**
   * Import directory recursively (to be implemented by subclasses)
   * @param {string} itemId - Directory ID from cloud provider
   * @param {string} destNodeId - Destination folder ID in Drumee
   * @returns {object} Import result with statistics
   */
  async _importDirectoryRecursive(itemId, destNodeId) {
    throw new Error("_importDirectoryRecursive must be implemented by subclass");
  }
}

module.exports = ExtImport;