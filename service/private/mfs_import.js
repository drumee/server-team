// File: server-team/service/mfs_import.js
// Purpose: MFS Import service - Import files/folders from another Drumee instance

const { Mfs } = require('@drumee/server-core');
const { Attr, toArray, Network, sysEnv } = require('@drumee/server-essentials');
const { existsSync, mkdirSync, cpSync } = require('fs');
const { join } = require('path');
const { createHash } = require('crypto');

class MfsImport extends Mfs {

  initialize(opt) {
    super.initialize(opt);
    this.debug("[MFS_IMPORT] Service initialized");
  }

  async _fetchManifest(sourceUrl, hubId, nodeId, token) {
    try {
      const manifestUrl = `${sourceUrl}/-/svc/media.manifest?hub_id=${hubId}&nid=${nodeId}`;
      
      this.debug(`[MFS_IMPORT] Fetching manifest from: ${manifestUrl}`);

      const response = await Network.request({
        method: 'GET',
        url: manifestUrl,
        headers: {
          'x-param-mfs-token': token
        }
      });

      if (!response || response.status !== 'ok') {
        throw new Error(`Failed to fetch manifest: ${response ? response.error : 'no response'}`);
      }

      this.debug(`[MFS_IMPORT] Manifest fetched: ${response.nodes.length} nodes`);
      
      return response;

    } catch (error) {
      this.warn(`[MFS_IMPORT] Exception fetching manifest:`, error.message);
      throw error;
    }
  }

  async _importFile(sourceUrl, hubId, nodeId, token, parentFolder, filename, extension, attr = {}) {
    try {
      const downloadUrl = `${sourceUrl}/-/svc/media.orig?hub_id=${hubId}&nid=${nodeId}`;
      
      this.debug(`[MFS_IMPORT] Importing file: ${filename}.${extension}`);

      let hash = createHash('md5');
      hash.update(`${hubId}-${nodeId}`);
      let cacheKey = hash.digest('hex');
      if (extension) {
        cacheKey = `${cacheKey}.${extension}`;
      }

      const { tmp_dir } = sysEnv();
      const TMPDIR = `/${tmp_dir}`;
      const cachePath = join(TMPDIR, cacheKey);

      if (!existsSync(cachePath)) {
        this.debug(`[MFS_IMPORT] Downloading to cache: ${cachePath}`);
        
        await Network.request({
          method: 'GET',
          url: downloadUrl,
          outfile: cachePath,
          headers: {
            'x-param-mfs-token': token
          }
        });
      } else {
        this.debug(`[MFS_IMPORT] Using cached file: ${cachePath}`);
      }

      let { filetype, mimetype } = attr;
      if (!filetype || !mimetype) {
        let r = await this.yp.await_query(
          `SELECT category filetype, mimetype FROM filecap WHERE extension = ?`, 
          extension
        );
        ({ filetype, mimetype } = toArray(r)[0] || {});
      }
      if (!mimetype) mimetype = `application/${extension}`;
      if (!filetype) filetype = 'other';

      const { home_dir } = await this.db.await_proc('mfs_home');

      const args = {
        owner_id: parentFolder.owner_id,
        filename: filename,
        pid: parentFolder.nid,
        category: filetype,
        ext: extension,
        mimetype: mimetype,
        filesize: attr.filesize,
        showResults: 1
      };

      const item = await this.db.await_proc('mfs_create_node', args, {}, { isOutput: 1 });
      if (!item || !item.id) {
        this.warn('[MFS_IMPORT] Failed to create MFS node:', args);
        throw new Error('Failed to create MFS node');
      }

      const base = join(home_dir, '__storage__', item.id);
      const orig = join(base, `orig.${extension}`);
      mkdirSync(base, { recursive: true });
      
      this.debug(`[MFS_IMPORT] Copying ${cachePath} -> ${orig}`);
      cpSync(cachePath, orig, { force: true });

      this.debug(`[MFS_IMPORT] File imported successfully: ${item.file_path}`);
      
      return item;

    } catch (error) {
      this.warn(`[MFS_IMPORT] Exception importing file:`, error.message);
      throw error;
    }
  }

  async import_folder() {
    try {
      const sourceUrl = this.input.get('source_url');
      const hubId = this.input.get(Attr.hub_id);
      const nodeId = this.input.get(Attr.nid);
      const token = this.input.get('token');
      const destNodeId = this.input.get('dest_nid');

      if (!sourceUrl || !hubId || !nodeId || !token) {
        this.debug('[MFS_IMPORT] Missing required parameters');
        return this.output.data({
          status: 'error',
          error: 'missing_parameters',
          message: 'source_url, hub_id, nid, and token are required'
        });
      }

      this.debug(`[MFS_IMPORT] Starting import from ${sourceUrl}`);
      this.debug(`[MFS_IMPORT] Source: hub_id=${hubId}, nid=${nodeId}`);

      const manifest = await this._fetchManifest(sourceUrl, hubId, nodeId, token);
      const { dirname, origin, nodes } = manifest;

      let destFolder;
      if (destNodeId) {
        destFolder = await this.db.await_proc('mfs_node_attr', destNodeId);
        if (!destFolder || !destFolder.nid) {
          return this.output.data({
            status: 'error',
            error: 'invalid_dest',
            message: 'Invalid destination folder ID'
          });
        }
      } else {
        const { home_id } = await this.db.await_proc('mfs_home');
        destFolder = await this.db.await_proc('mfs_node_attr', home_id);
      }

      this.debug(`[MFS_IMPORT] Destination: ${destFolder.file_path}`);

      let stats = {
        folders: 0,
        files: 0,
        skipped: 0,
        errors: []
      };

      const re = new RegExp(`^${dirname}`);

      for (const node of nodes) {
        try {
          if (/^(hub|folder)$/i.test(node.filetype)) {
            continue;
          }

          let ownpath = node.ownpath.replace(re, '');
          let pathParts = ownpath.split(/\/+/);
          pathParts.pop();
          pathParts = pathParts.filter(f => f);
          let dir = '/' + pathParts.join('/');

          let parent;
          let id = await this.db.await_func('node_id_from_path', dir);
          
          if (id) {
            parent = await this.db.await_proc('mfs_node_attr', id);
          } else {
            if (!pathParts.length) {
              parent = destFolder;
            } else {
              parent = await this.db.await_proc('mfs_make_dir', destFolder.nid, pathParts, 1);
              stats.folders++;
            }
          }

          if (!parent || !parent.nid) {
            this.warn(`[MFS_IMPORT] Failed to create parent folder: ${dir}`);
            stats.errors.push({ file: node.filename, error: 'parent_folder_creation_failed' });
            continue;
          }

          await this._importFile(
            origin,
            hubId,
            node.nid,
            token,
            parent,
            node.filename,
            node.ext,
            {
              mimetype: node.mimetype,
              filesize: node.filesize
            }
          );

          stats.files++;

        } catch (error) {
          this.warn(`[MFS_IMPORT] Error importing ${node.filename}:`, error.message);
          stats.errors.push({ file: node.filename, error: error.message });
        }
      }

      this.debug(`[MFS_IMPORT] Import completed: ${stats.files} files, ${stats.folders} folders, ${stats.errors.length} errors`);

      return this.output.data({
        status: 'ok',
        message: 'Import completed',
        stats: stats
      });

    } catch (error) {
      this.warn('[MFS_IMPORT] Exception in import_folder:', error.message);
      return this.output.data({
        status: 'error',
        error: 'internal_error',
        message: 'Failed to import: ' + error.message
      });
    }
  }

  async import_file() {
    try {
      const sourceUrl = this.input.get('source_url');
      const hubId = this.input.get(Attr.hub_id);
      const nodeId = this.input.get(Attr.nid);
      const token = this.input.get('token');
      const destNodeId = this.input.get('dest_nid');
      const overrideFilename = this.input.get('filename');

      if (!sourceUrl || !hubId || !nodeId || !token) {
        this.debug('[MFS_IMPORT] Missing required parameters');
        return this.output.data({
          status: 'error',
          error: 'missing_parameters',
          message: 'source_url, hub_id, nid, and token are required'
        });
      }

      let destFolder;
      if (destNodeId) {
        destFolder = await this.db.await_proc('mfs_node_attr', destNodeId);
        if (!destFolder || !destFolder.nid) {
          return this.output.data({
            status: 'error',
            error: 'invalid_dest',
            message: 'Invalid destination folder ID'
          });
        }
      } else {
        const { home_id } = await this.db.await_proc('mfs_home');
        destFolder = await this.db.await_proc('mfs_node_attr', home_id);
      }

      const manifest = await this._fetchManifest(sourceUrl, hubId, nodeId, token);
      
      if (!manifest.nodes || manifest.nodes.length === 0) {
        return this.output.data({
          status: 'error',
          error: 'node_not_found',
          message: 'File not found in source'
        });
      }

      const sourceNode = manifest.nodes[0];

      const newNode = await this._importFile(
        manifest.origin,
        hubId,
        sourceNode.nid,
        token,
        destFolder,
        overrideFilename || sourceNode.filename,
        sourceNode.ext,
        {
          mimetype: sourceNode.mimetype,
          filesize: sourceNode.filesize
        }
      );

      return this.output.data({
        status: 'ok',
        message: 'File imported successfully',
        node: newNode
      });

    } catch (error) {
      this.warn('[MFS_IMPORT] Exception in import_file:', error.message);
      return this.output.data({
        status: 'error',
        error: 'internal_error',
        message: 'Failed to import file: ' + error.message
      });
    }
  }

}

module.exports = MfsImport;