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
const { writeFileSync, readFileSync } = require('jsonfile');
const { resolve, join, basename } = require('path');
const { normalizeWideSections, isWordprocessing } = require('./normalize-docx-sections');
const { remove_dir } = require('@drumee/server-core').MfsTools;
const { getPdfInfo } = require('@drumee/server-core').Document;
const { rmSync, renameSync, mkdirSync, existsSync } = require("fs");

const {
  RedisStore, Mariadb, Offline, Script, Attr
} = require('@drumee/server-essentials');

class __pdf_builder extends Offline {
  // ========================
  // initialize
  // ========================
  initialize() {
    this.onCompletion = this.onCompletion.bind(this)
    console.log(`Starting PDF builder`);
    this.info = this.checkSanity();
    if (this.info.locked) {
      this.syslog(`${this.info.origFile} is locked since ${this.info.locked}`);
      if ((new Date().getTime() - this.info.locked) < 120) {
        this.syslog(`Exiting: too early`);
        process.exit(1);
      }
    }

    let res = new RedisStore();
    res.init().then(() => {
      this.prepare()
        .then(async () => {
          await this.build();
        })
        .catch(async (e) => {
          this.syslog("Failed to build [44]:", e);
          if (this.failedReason == 'no_dest') {
            this.syslog("Trying to build without socket");
            try {
              await this.build();
            } catch (e) {
              this.syslog("Failed to build - gave up", e);
              rmSync(this.lockFile, { force: true });
              process.exit(1);
            }
          };
        });
    });
  }

  syslog(...args) {
    console.log(...args);
    super.syslog(...args);
  }
  /**
   * 
   */
  async build() {
    if (this.info.origFile) {
      this.syslog(`Building from MFS location`);
      await this.buildFromOrig();
    } else {
      this.syslog(`Building from cache location`);
      await this.buildFromCache();
    }

    this.syslog(`FINISHED SUCCESSFULY`);
    await this.onCompletion();
    this.syslog(`Build completed successfully. ${this._preview}`);
    setTimeout(() => {
      rmSync(this.lockFile, { force: true });
      process.exit(0);
    }, 3000);
  }

  /**
 * 
 */
  async onCompletion() {
    if (!this._payload) {
      this._payload = {
        service: this.service,
        keys: [Attr.nid, Attr.hub_id],
        message: 'PREVIEW_GENERATION',
        progress: 0,
        options: {}
      };
    }
    console.log("AAA:130", this._payload)
    this._payload.options.message = "PREVIEW_DONE";
    this._payload.options.progress = 100;
    await RedisStore.sendData(this._payload, this.recipients);
  }


  /**
   * 
   */
  checkSanity() {
    const Minimist = require('minimist');
    const argv = Minimist(process.argv.slice(2));
    let { node, socket_id, uid, noSocket } = JSON.parse(argv._[0]);
    this.noSocket = noSocket;
    if (!node.mfs_root) {
      if (!/__storage__/.test(node.home_dir)) {
        node.mfs_root = resolve(node.home_dir, '__storage__');
      } else {
        node.mfs_root = node.home_dir;
      }
    }

    const mfs_dir = resolve(node.mfs_root, node.id);
    this.socket_id = socket_id;
    this.uid = uid;
    this.lockFile = join(mfs_dir, `lock.json`);
    this.node = node;
    this.mfs_dir = node.mfs_root;

    this.yp = new Mariadb({ user: process.env.USER });
    let origFile = resolve(mfs_dir, `orig.${node.extension || node.ext}`);
    this.origFile = origFile;
    if (existsSync(this.lockFile)) {
      return readFileSync(this.lockFile);
    }

    this.infoFile = resolve(mfs_dir, `info.json`);
    if (!existsSync(this.infoFile)) {
      throw `Info file (${this.infoFile}) not found`
    }
    let json = readFileSync(this.infoFile);
    if (!json.tmpfile || !existsSync(json.tmpfile)) {
      if (existsSync(origFile)) {
        json.origFile = origFile;
      } else {
        throw `Tmp file (${json.tmpfile}) not found`;
      }
    }
    json.buildState = 'started';
    writeFileSync(this.infoFile, json);
    return json;
  }

  /**
   * 
   */
  async prepare() {
    if (this.origFile) {
      writeFileSync(this.lockFile, {
        locked: new Date().getTime(),
        origFile: this.origFile
      });
    }
    if (!this.uid || this.noSocket) return;
    this.sender = await this.yp.await_proc("get_user", this.uid);
    this.recipients = await this.yp.await_proc("entity_sockets", this.uid);
    this.service = "media.status";
    let model = this.node;
    let options = {
      service: this.service,
      keys: [Attr.nid, Attr.hub_id],
      message: 'PREVIEW_GENERATION',
      progress: 0
    };
    this._payload = this.payload(model, options)

    await RedisStore.sendData(this._payload, this.recipients);

  }


  /**
   * For wordprocessing docs, rewrite any portrait section whose widest table or
   * inline image overflows the page into landscape BEFORE soffice runs — soffice
   * renders faithfully and would otherwise clip that content off the right edge.
   * The normalized copy keeps the original basename (so the .pdf output name is
   * unchanged) and lives in a throwaway `.norm` dir; the stored original is never
   * touched. Any failure falls back to converting the original untouched.
   * @returns {Promise<string>} path of the file soffice should convert
   */
  async normalizeInput(inputFile, outdir) {
    try {
      if (!inputFile || !isWordprocessing(inputFile)) return inputFile;
      const dir = resolve(outdir, '.norm');
      mkdirSync(dir, { recursive: true });
      const target = join(dir, basename(inputFile));
      const res = await normalizeWideSections(inputFile, target);
      if (res && res.changed) {
        this.syslog(`Normalized overflowing sections ${JSON.stringify(res.sections)} -> landscape`);
        return target;
      }
      return inputFile;
    } catch (e) {
      this.syslog(`Section normalization skipped (non-fatal):`, (e && e.message) || e);
      return inputFile;
    }
  }

  /**
   *
   */
  async buildFromCache() {
    let node = this.node;
    let mfs_root = node.mfs_root || this.mfs_dir;
    const mfs_dir = resolve(mfs_root, node.id);

    let outdir = resolve(this.info.fastdir, 'pdfout');
    let tmp_pdf = resolve(outdir, 'orig.pdf');
    mkdirSync(outdir, { recursive: true });

    // Build PDF from this.info.tmpfile into tmp_pdf
    const src = await this.normalizeInput(this.info.tmpfile, outdir);
    let cmd = `${Script.soffice} ${outdir} ${src}`;
    this.exec(cmd);
    if (!existsSync(tmp_pdf)) {
      throw `Failed to build preview with CMD=${cmd}`;
    }
    let json = getPdfInfo(tmp_pdf);
    this.syslog(`CONVERT 471 cmd=${cmd}`, tmp_pdf);
    let preview = join(mfs_dir, `preview.pdf`);
    json.pdf = preview;
    json.buildState = 'done';
    writeFileSync(this.infoFile, json);
    this.syslog(`Renaming =${tmp_pdf} to ${preview}`);
    renameSync(tmp_pdf, preview);
    if (!existsSync(preview)) {
      throw `NOENT : buildFromCache file=${preview}`;
    }
    this._preview = preview;
    remove_dir(this.info.fastdir);
  }

  /**
   * 
   */
  async buildFromOrig() {
    let node = this.node;
    let mfs_root = node.mfs_root || this.mfs_dir;
    const mfs_dir = resolve(mfs_root, node.id);
    const orig_pdf = join(mfs_dir, 'orig.pdf');
    const preview = join(mfs_dir, 'preview.pdf');

    const src = await this.normalizeInput(this.info.origFile, mfs_dir);
    let cmd = `${Script.soffice} ${mfs_dir} ${src}`;
    this.exec(cmd);
    rmSync(resolve(mfs_dir, '.norm'), { recursive: true, force: true });

    if (!existsSync(orig_pdf)) {
      throw `Failed to build preview with CMD=${cmd}`;
    }

    let json = getPdfInfo(orig_pdf);
    json.pdf = preview;
    json.buildState = 'done';
    this.infoFile = resolve(mfs_dir, `info.json`);
    writeFileSync(this.infoFile, json);

    // Add rename operation
    this.syslog(`Renaming ${orig_pdf} to ${preview}`);
    renameSync(orig_pdf, preview);

    if (!existsSync(preview)) {
      throw `NOENT : buildFromOrig file=${preview}`;
    }

    this._preview = preview;
  }
}

try {
  new __pdf_builder();
} catch (e) {
  let msg = "Failed to run pdf builder" + e.toString();
  const Syslog = require("syslog-client-tls");
  const SyslogClient = Syslog.createClient("127.0.0.1");
}
module.exports = __pdf_builder;