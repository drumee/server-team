#!/usr/bin/env node

/**
 * @license
 * Copyright 2024 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.gnu.org/licenses/agpl-3.0.html
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const Minimist = require('minimist');
const { exit } = require('process');
const {
  RedisStore, Mariadb, Attr, Constants, Offline, sysEnv, Script,
  Messenger, toArray
} = require('@drumee/server-essentials');
const { archive } = Script;
const { resolve, dirname, join } = require('path');
const { existsSync, symlinkSync, mkdirSync, writeFileSync, statSync } = require('fs');
const { spawn } = require('child_process');
const Moment = require('moment');
const { isEmpty, isString } = require('lodash');
const { tmp_dir, data_dir, domain } = sysEnv();
const { DOWNLOAD_FOLDER } = Constants;

// CSV helpers
function _csvEsc(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  return (s.includes(',') || s.includes('"') || s.includes('\n'))
    ? '"' + s.replace(/"/g, '""') + '"'
    : s;
}

function _toRow(values) {
  return values.map(_csvEsc).join(',');
}

// Worker
class __offline_drumate_backup extends Offline {

  /**
   * 
   */
  initialize() {
    const argv = Minimist(process.argv.slice(2));
    this.yp = new Mariadb({ user: process.env.USER });

    let data = {};
    try {
      data = JSON.parse(argv._[0]);
    } catch (e) { /* use defaults */ }

    this.lang = data.lang || 'en';
    this.uid = data.uid;
    this.hub_id = data.hub_id;
    this.zipid = data.zipid;
    this.flags = Array.isArray(data.flags) ? data.flags : [];
    this.socket_id = data.socket_id;
    this.email = data.email;
    this.db_name = data.db_name;

    this.timestamp = Moment(Moment.now() / 1000, 'X').format('YYYY-MM-DD HH:mm');
    this.service = 'drumate.backup';

    for (const name of ['uid', 'zipid', 'socket_id', 'db_name']) {
      if (isEmpty(this[name])) {
        this.stop(`attribute *${name}* must be set`);
      }
    }
    if (!this.flags.length) {
      this.stop('attribute *flags* must be a non-empty array');
    }

    global.verbosity = 3;
    const res = new RedisStore();
    res.init().then(() => {
      this.prepare().catch((e) => {
        this.warn('Backup error:', e);
        exit(1);
      });
    });
  }

  /**
   * Messaging
   */
  async send(model, message) {
    if (!this.socket_id) return;
    this._payload.model = { ...this._payload.model, ...model };
    if (message) {
      this._payload.options.message = message;
    } else if (model.message) {
      this._payload.options.message = model.message;
    }
    await RedisStore.sendData(this._payload, this.socket_id);
  }

  stop(msg) {
    let status = 0;
    if (isString(msg)) {
      console.error(msg);
      status = 1;
    }
    this.yp.end();
    this.clear();
    exit(status);
  }

  /**
   * Main entry
   */
  async prepare() {
    this.data_dir = resolve(tmp_dir, DOWNLOAD_FOLDER, this.uid, this.zipid);
    mkdirSync(this.data_dir, { recursive: true });

    this.sender = await this.yp.await_proc('get_user', this.uid);
    this._payload = this.payload(
      { phase: 'prepare', progress: 0, zipid: this.zipid },
      { service: this.service, tag: this.service, keys: ['zipid'], message: 'IN_PREPARATION' }
    );
    await this.send({ phase: 'prepare', progress: 0, zipid: this.zipid });

    const total = this.flags.length;
    let step = 0;

    let exportFiles = 0;
    for (const flag of this.flags) {
      step++;
      await this.send({
        phase: flag,
        progress: Math.ceil(100 * (step / (total + 1))),
        zipid: this.zipid,
        message: 'IN_PREPARATION'
      });
      switch (flag) {
        case 'files':
        case 'workspace':
          exportFiles = 1;
          break;

        case 'chat': await this._exportChat(); break;
        case 'activity': await this._exportActivity(); break;
        default:
          this.warn(`Unknown backup flag ignored: ${flag}`);
      }
    }
    if (exportFiles) {
      await this._exportTree()
    }
    await this._createArchive();
  }

  /**
   * personal: user's own files
   */
  async _exportTree() {
    const hub = await this.yp.await_proc('get_hub', this.hub_id);
    if (!hub || !hub.db_name || !hub.home_id) {
      this.warn('_exportTree: hub not found for hub_id', this.hub_id);
      return;
    }
    const result = await this.yp.await_proc(
      `${hub.db_name}.mfs_manifest`, { nid: hub.home_id, uid: this.uid, show_nodes: 1 }
    );
    let files = [];
    let workspace = []
    for (let row of toArray(result[0])) {
      if (row.area == Attr.personal) {
        if (row.filetype !== Attr.hub) files.push(row)
      } else {
        workspace.push(row)
      }
    }
    if (files.length && this.flags.includes('files')) {
      this._buildSymlinks(files, 'my-files');
    }
    if (workspace.length && this.flags.includes('workspace')) {
      this._buildSymlinks(workspace, 'my-workspaces');
    }

  }



  /**
   * Chat: P2P chat history, one CSV per peer 
   * Note: single-write design — only messages sent by this user are in their
   * drumate DB. Messages received from peers are in respective peer DBs.
   */
  async _exportChat() {
    const chatDir = resolve(this.data_dir, 'chat');
    mkdirSync(chatDir, { recursive: true });

    // Get all hubs user belongs to
    const hubs = toArray(await this.yp.await_proc(`${this.db_name}.show_hubs`));

    for (const hub of hubs) {
      if (!hub.db_name) continue;

      // Query hub's channel table (team chat)
      const rows = toArray(await this.yp.await_query(
        `SELECT c.author_id, d.firstname, d.lastname, d.email,
                c.message, c.message_id, c.thread_id,
                c.attachment, c.is_forward, c.mention_ids,
                c.status, c.ctime
         FROM \`${hub.db_name}\`.channel c
         LEFT JOIN yp.drumate d ON d.id = c.author_id
         WHERE c.status != 'trashed'
         ORDER BY c.ctime ASC`
      ));

      if (!rows.length) continue;

      const safeName = (hub.name || hub.id).replace(/[^a-zA-Z0-9_\- ]/g, '_');
      const csvPath = resolve(chatDir, `${safeName}.csv`);

      const header = _toRow([
        'author_id', 'firstname', 'lastname', 'email',
        'message', 'message_id', 'thread_id',
        'attachment', 'is_forward', 'mention_ids', 'status', 'ctime'
      ]);
      const lines = [header, ...rows.map(r => _toRow([
        r.author_id, r.firstname, r.lastname, r.email,
        r.message, r.message_id, r.thread_id,
        r.attachment, r.is_forward, r.mention_ids, r.status, r.ctime
      ]))];

      writeFileSync(csvPath, lines.join('\n'), 'utf8');
    }
  }

  /**
   * logs: activity logs as CSV
   */
  async _exportActivity() {
    const logsDir = resolve(this.data_dir, 'logs');
    mkdirSync(logsDir, { recursive: true });

    // services_log — API call history
    const services = toArray(await this.yp.await_query(
      `SELECT name, uid, hub_id, args, ctime
       FROM yp.services_log
       WHERE uid = '${this.uid}'
       ORDER BY ctime DESC
       LIMIT 10000`
    ));
    {
      const header = _toRow(['service', 'uid', 'hub_id', 'args', 'ctime']);
      const lines = [header, ...services.map(r =>
        _toRow([r.name, r.uid, r.hub_id, r.args, r.ctime])
      )];
      writeFileSync(resolve(logsDir, 'services.csv'), lines.join('\n'), 'utf8');
    }

    // mfs_changelog — file events
    const fileEvents = toArray(await this.yp.await_query(
      `SELECT event, uid, hub_id, src, dest, timestamp
       FROM yp.mfs_changelog
       WHERE uid = '${this.uid}'
       ORDER BY timestamp DESC`
    ));
    {
      const header = _toRow(['event', 'uid', 'hub_id', 'src', 'dest', 'timestamp']);
      const lines = [header, ...fileEvents.map(r =>
        _toRow([r.event, r.uid, r.hub_id, r.src, r.dest, r.timestamp])
      )];
      writeFileSync(resolve(logsDir, 'files.csv'), lines.join('\n'), 'utf8');
    }

    // contact_activity — contact events
    const contacts = toArray(await this.yp.await_query(
      `SELECT * FROM yp.contact_activity
       WHERE uid = '${this.uid}'
       ORDER BY timestamp DESC`
    ));
    if (contacts.length) {
      const keys = Object.keys(contacts[0]);
      const header = _toRow(keys);
      const lines = [header, ...contacts.map(r => _toRow(keys.map(k => r[k])))];
      writeFileSync(resolve(logsDir, 'contacts.csv'), lines.join('\n'), 'utf8');
    }
  }

  /**
   * Archive
   */
  async _createArchive() {
    const zname = `${(this.sender.fullname || this.email || this.uid).replace(/[ \n<>'"()/]/g, '-')}__${domain}`;
    this.zipname = zname;
    let total = 0
    const sp = spawn(`${archive}`, [this.data_dir, zname]);
    let dest = join(this.data_dir, 'index.zip')
    sp.on('exit', async (s) => {
      await this.send({
        exit: s,
        phase: 'exit',
        zipid: this.zipid,
        zipname: this.zipname,
        message: 'DOWNLOADING',
        finished: 1
      });
      if (s === 0 && this.email) {
        await this._sendDownloadEmail();
      }
      setTimeout(this.stop.bind(this), 2000);
    });

    this.progress = 0;
    sp.stdout.on('data', async (data) => {
      const line = data.toString();
      const size = line.match(/([0-9]{1,3}\%)(.+)$/)
      if (size) {
        const p = parseInt(size[1]);
        if (p > this.progress) {
          this.progress = p;
          await this.send({
            phase: Attr.archive,
            zipid: this.zipid,
            zipname: this.zipname,
            message: 'BEING_CREATED',
            progress: p,
            cancelId: sp.pid
          });
        }
      }
    });

    sp.stderr.on('data', async (e) => {
      console.error('Archive error:', e.toString());
      await this.send({ phase: 'error', message: e.toString() });
      this.stop('ARCHIVE_ERROR');
    });

    sp.unref();
  }

  /**
   * Email
   */
  async _sendDownloadEmail() {
    try {
      const vhost = this.sender.vhost ||
        (await this.yp.await_proc('get_hub', this.hub_id))?.vhost;
      if (!vhost) {
        this.warn('_sendDownloadEmail: vhost not found, skipping email');
        return;
      }
      const downloadUrl = `https://${vhost}/-/svc/media.download?zipid=${this.zipid}`;
      const html = `<p>Hello ${this.sender.fullname || ''},</p>
        <p>Your Drumee data export is ready. Click the link below to download your archive:</p>
        <p><a href="${downloadUrl}">${downloadUrl}</a></p>
        <p>Exported on: ${this.timestamp}</p>`;

      const msg = new Messenger({
        subject: 'Your Drumee data export is ready',
        recipient: this.email,
        handler: null
      });
      await msg.send({ html });
    } catch (e) {
      this.warn('_sendDownloadEmail failed:', e.message);
    }
  }

  /**
   * Helper: symlink file tree
   */
  _buildSymlinks(files, type) {
    this.data_dir = resolve(tmp_dir, DOWNLOAD_FOLDER, this.uid, this.zipid);
    let subdir = resolve(this.data_dir, type)
    mkdirSync(subdir, { recursive: true });
    for (const file of files) {
      if (!file.home_dir || !file.ownpath) continue;
      if (['folder', 'root', 'hub'].includes(file.filetype)) continue;
      const src = resolve('/', file.home_dir, '__storage__', file.nid, `orig.${file.ext}`);
      const dest = join(subdir, file.filepath);
      mkdirSync(dirname(dest), { recursive: true });
      if (existsSync(src) && !existsSync(dest)) {
        symlinkSync(src, dest);
      } else {
        console.warn("Failed to create symlinks", `${dest} -> ${src}`)
      }
    }
  }
}

new __offline_drumate_backup();