// service/google_drive.js

const { Attr } = require('@drumee/server-essentials');
const axios = require('axios');
const ExtImport = require('../lib/ext_import');

class GoogleDrive extends ExtImport {

  initialize(opt) {
    super.initialize(opt);
    this.debug("GoogleDrive Service Initialized.");
  }

  /**
   * Get Google OAuth access token
   */
  async _getAccessToken() {
    return super._getAccessToken('google');
  }

  /**
   * List files from Google Drive
   */
  async list_files() {
    const accessToken = await this._getAccessToken();
    const folderId = this.input.get('folder_id') || 'root';

    try {
      const response = await axios.get('https://www.googleapis.com/drive/v3/files', {
        headers: { 'Authorization': `Bearer ${accessToken}` },
        params: {
          q: `'${folderId}' in parents and trashed = false`,
          pageSize: 100,
          fields: 'files(id, name, mimeType, iconLink, size, fileExtension, webViewLink, webContentLink)'
        }
      });
      this.output.data({ success: true, files: response.data.files });
    } catch (e) {
      this.warn(`[Import] Failed to list Google Drive files:`, e.response?.data || e.message);
      if (e.response && e.response.status === 401) {
        throw new Error("OAuth Token is invalid or expired. Please re-authenticate.");
      }
      throw new Error("Failed to list Google Drive files.");
    }
  }

  /**
   * Import file from Google Drive
   */
  async import_file() {
    const googleFileId = this.input.get('file_id');
    const destNodeId = this.input.get(Attr.nid);

    if (!googleFileId || !destNodeId) {
      throw new Error("Missing 'file_id' or 'nid' (destination folder ID) parameter.");
    }

    const accessToken = await this._getAccessToken();

    // Get file metadata from Google Drive
    let googleFile;
    try {
      const response = await axios.get(`https://www.googleapis.com/drive/v3/files/${googleFileId}`, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
        params: {
          fields: 'id, name, mimeType, webContentLink, size, fileExtension'
        }
      });
      googleFile = response.data;

      // Handle Google Workspace files (Docs, Sheets, etc.) - need export
      if (!googleFile.webContentLink) {
        const GOOGLE_EXPORT_TYPES = {
          'google-apps.document': { mime: 'application/pdf', ext: 'pdf' },
          'google-apps.spreadsheet': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' },
          'google-apps.presentation': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: 'pptx' },
          'google-apps.drawing': { mime: 'image/png', ext: 'png' }
        };

        let exportType = null;
        for (const [gType, exportInfo] of Object.entries(GOOGLE_EXPORT_TYPES)) {
          if (googleFile.mimeType.includes(gType)) {
            exportType = exportInfo;
            break;
          }
        }

        if (exportType) {
          googleFile.webContentLink = `https://www.googleapis.com/drive/v3/files/${googleFileId}/export?mimeType=${encodeURIComponent(exportType.mime)}`;
          googleFile.name = `${googleFile.name}.${exportType.ext}`;
          this.debug(`[Import] Exporting Google Workspace file as ${exportType.ext}`);
        } else {
          this.warn(`[Import] File ${googleFile.name} (mime: ${googleFile.mimeType}) is not downloadable.`);
          throw new Error("This file type is not directly downloadable or exportable.");
        }
      }
    } catch (e) {
      this.warn(`[Import] Failed to get Google file metadata:`, e.response?.data || e.message);
      throw new Error("Failed to get Google file metadata.");
    }

    // Get destination folder
    const destFolder = await this.db.await_proc('mfs_node_attr', destNodeId);
    if (!destFolder || !destFolder.home_dir) {
      throw new Error("Invalid destination folder ID (nid).");
    }

    const nodeAttributes = {
      mimetype: googleFile.mimeType,
      filesize: googleFile.size
    };

    // Import file using base class method
    const newNode = await this._importFileInternal(
      googleFile.webContentLink,
      googleFile.name,
      destFolder,
      nodeAttributes,
      accessToken
    );

    this.output.data({ success: true, node: newNode });
  }

  /**
   * Import directory recursively from Google Drive
   */
  async import_directory() {
    const folderId = this.input.get('folder_id');
    const destNodeId = this.input.get(Attr.nid);

    if (!folderId || !destNodeId) {
      throw new Error("Missing 'folder_id' or 'nid' (destination folder ID) parameter.");
    }

    const result = await this._importDirectoryRecursive(folderId, destNodeId);
    this.output.data({ success: true, ...result });
  }

  /**
   * Recursive implementation for Google Drive
   */
  async _importDirectoryRecursive(folderId, destNodeId) {
    const accessToken = await this._getAccessToken();
    let stats = { folders: 0, files: 0, skipped: 0, errors: [] };

    try {
      // Get folder metadata
      const folderResponse = await axios.get(`https://www.googleapis.com/drive/v3/files/${folderId}`, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
        params: { fields: 'id, name, mimeType' }
      });
      const folderName = folderResponse.data.name;

      // Get destination folder
      const destFolder = await this.db.await_proc('mfs_node_attr', destNodeId);
      if (!destFolder) {
        throw new Error("Invalid destination folder ID.");
      }

      // Create folder in Drumee
      const newFolder = await this._createFolder(folderName, destFolder);
      stats.folders++;

      // List all items in this folder
      const listResponse = await axios.get('https://www.googleapis.com/drive/v3/files', {
        headers: { 'Authorization': `Bearer ${accessToken}` },
        params: {
          q: `'${folderId}' in parents and trashed = false`,
          pageSize: 1000,
          fields: 'files(id, name, mimeType, size, fileExtension, webContentLink)'
        }
      });

      const items = listResponse.data.files;
      this.debug(`[Import] Found ${items.length} items in folder ${folderName}`);

      // Process each item
      for (const item of items) {
        try {
          if (item.mimeType === 'application/vnd.google-apps.folder') {
            // Recursive call for subfolder
            const subStats = await this._importDirectoryRecursive(item.id, newFolder.nid);
            stats.folders += subStats.folders;
            stats.files += subStats.files;
            stats.skipped += subStats.skipped;
            stats.errors.push(...subStats.errors);
          } else {
            // Import file
            try {
              // Handle export for Google Workspace files
              let downloadUrl = item.webContentLink;
              let filename = item.name;

              if (!downloadUrl) {
                const GOOGLE_EXPORT_TYPES = {
                  'google-apps.document': { mime: 'application/pdf', ext: 'pdf' },
                  'google-apps.spreadsheet': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' },
                  'google-apps.presentation': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: 'pptx' },
                  'google-apps.drawing': { mime: 'image/png', ext: 'png' }
                };

                let exportType = null;
                for (const [gType, exportInfo] of Object.entries(GOOGLE_EXPORT_TYPES)) {
                  if (item.mimeType.includes(gType)) {
                    exportType = exportInfo;
                    break;
                  }
                }

                if (exportType) {
                  downloadUrl = `https://www.googleapis.com/drive/v3/files/${item.id}/export?mimeType=${encodeURIComponent(exportType.mime)}`;
                  filename = `${filename}.${exportType.ext}`;
                } else {
                  this.warn(`[Import] Skipping non-downloadable file: ${filename}`);
                  stats.skipped++;
                  continue;
                }
              }

              await this._importFileInternal(
                downloadUrl,
                filename,
                newFolder,
                { mimetype: item.mimeType, filesize: item.size },
                accessToken
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

module.exports = GoogleDrive;