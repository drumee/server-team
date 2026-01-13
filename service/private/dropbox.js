// service/dropbox.js

const { Attr } = require('@drumee/server-essentials');
const axios = require('axios');
const ExtImport = require('../lib/ext_import');

class Dropbox extends ExtImport {

  initialize(opt) {
    super.initialize(opt);
    this.debug("Dropbox Service Initialized.");
  }

  /**
   * Get Dropbox OAuth access token
   */
  async _getAccessToken() {
    return super._getAccessToken('dropbox');
  }

  /**
   * List files from Dropbox
   */
  async list_files() {
    const accessToken = await this._getAccessToken();
    const path = this.input.get('path') || '';

    try {
      const response = await axios.post('https://api.dropboxapi.com/2/files/list_folder',
        {
          path: path,
          limit: 100
        },
        {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });

      this.output.data({ success: true, files: response.data.entries });
    } catch (e) {
      this.warn(`[Import] Failed to list Dropbox files:`, e.response?.data || e.message);
      if (e.response && e.response.status === 401) {
        throw new Error("OAuth Token is invalid or expired. Please re-authenticate.");
      }
      throw new Error("Failed to list Dropbox files.");
    }
  }

  /**
   * Import file from Dropbox
   */
  async import_file() {
    const dropboxFileId = this.input.get('file_id');
    const destNodeId = this.input.get(Attr.nid);

    if (!dropboxFileId || !destNodeId) {
      throw new Error("Missing 'file_id' or 'nid' (destination folder ID) parameter.");
    }

    const accessToken = await this._getAccessToken();

    // Get temporary download link from Dropbox
    let dropboxFile;
    let downloadUrl;
    try {
      const response = await axios.post('https://api.dropboxapi.com/2/files/get_temporary_link',
        {
          path: dropboxFileId
        },
        {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });

      downloadUrl = response.data.link;
      dropboxFile = response.data.metadata;

      if (!downloadUrl) {
        throw new Error("Failed to get temporary download link from Dropbox.");
      }
    } catch (e) {
      this.warn(`[Import] Failed to get Dropbox file metadata:`, e.response?.data || e.message);
      throw new Error("Failed to get Dropbox file metadata.");
    }

    // Get destination folder
    const destFolder = await this.db.await_proc('mfs_node_attr', destNodeId);
    if (!destFolder || !destFolder.home_dir) {
      throw new Error("Invalid destination folder ID (nid).");
    }

    const nodeAttributes = {
      mimetype: dropboxFile['.tag'] === 'file' ? (dropboxFile.mime_type || 'application/octet-stream') : 'application/octet-stream',
      filesize: dropboxFile.size
    };

    // Import file using base class method
    const newNode = await this._importFileInternal(
      downloadUrl,
      dropboxFile.name,
      destFolder,
      nodeAttributes,
      null
    );

    this.output.data({ success: true, node: newNode });
  }

  /**
   * Import directory recursively from Dropbox
   */
  async import_directory() {
    const folderPath = this.input.get('folder_path');
    const destNodeId = this.input.get(Attr.nid);

    if (!folderPath || !destNodeId) {
      throw new Error("Missing 'folder_path' or 'nid' (destination folder ID) parameter.");
    }

    const result = await this._importDirectoryRecursive(folderPath, destNodeId);
    this.output.data({ success: true, ...result });
  }

  /**
   * Recursive implementation for Dropbox
   */
  async _importDirectoryRecursive(folderPath, destNodeId) {
    const accessToken = await this._getAccessToken();
    let stats = { folders: 0, files: 0, skipped: 0, errors: [] };

    try {
      // Get folder name from path
      const folderName = folderPath.split('/').filter(Boolean).pop() || 'root';

      // Get destination folder
      const destFolder = await this.db.await_proc('mfs_node_attr', destNodeId);
      if (!destFolder) {
        throw new Error("Invalid destination folder ID.");
      }

      // Create folder in Drumee
      const newFolder = await this._createFolder(folderName, destFolder);
      stats.folders++;

      // List all items in this folder
      let entries = [];
      let hasMore = true;
      let cursor = null;

      while (hasMore) {
        const listParams = cursor
          ? { cursor }
          : { path: folderPath, limit: 2000 };

        const endpoint = cursor
          ? 'https://api.dropboxapi.com/2/files/list_folder/continue'
          : 'https://api.dropboxapi.com/2/files/list_folder';

        const response = await axios.post(endpoint, listParams, {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        entries.push(...response.data.entries);
        hasMore = response.data.has_more;
        cursor = response.data.cursor;
      }

      this.debug(`[Import] Found ${entries.length} items in folder ${folderName}`);

      // Process each item
      for (const item of entries) {
        try {
          if (item['.tag'] === 'folder') {
            // Recursive call for subfolder
            const subStats = await this._importDirectoryRecursive(item.path_lower, newFolder.nid);
            stats.folders += subStats.folders;
            stats.files += subStats.files;
            stats.skipped += subStats.skipped;
            stats.errors.push(...subStats.errors);
          } else if (item['.tag'] === 'file') {
            // Import file
            try {
              // Get temporary download link
              const linkResponse = await axios.post('https://api.dropboxapi.com/2/files/get_temporary_link',
                { path: item.path_lower },
                { headers: { 'Authorization': `Bearer ${accessToken}` } }
              );

              const downloadUrl = linkResponse.data.link;

              await this._importFileInternal(
                downloadUrl,
                item.name,
                newFolder,
                { mimetype: item.mime_type || 'application/octet-stream', filesize: item.size },
                null
              );
              stats.files++;
            } catch (fileError) {
              this.warn(`[Import] Failed to import file ${item.name}:`, fileError.message);
              stats.errors.push({ file: item.name, error: fileError.message });
            }
          }
        } catch (itemError) {
          this.warn(`[Import] Failed to process item ${item.name}:`, itemError.message);
          stats.errors.push({ item: item.name, error: itemError.message });
        }
      }

      return stats;
    } catch (error) {
      this.warn(`[Import] Failed to import directory:`, error.message);
      throw error;
    }
  }
}

module.exports = Dropbox;