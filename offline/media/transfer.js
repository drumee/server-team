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

const stringify = require('json-stringify');
const Minimist = require('minimist');
const _ = require('lodash');
const { exit } = require('process');
const { Script } = require('@drumee/server-essentials');
const Jsonfile = require('jsonfile');
const Path = require('path');
const Shell = require('shelljs');
const { remove_dir } = require('@drumee/server-core').MfsTools;
const Fs = require("fs");
const Crypto = require("crypto");
const Moment = require('moment');

const { Attr, Constants, Messenger, Mariadb, Offline, Cache } = require('@drumee/server-essentials');

class __offline_media_zip extends Offline {

  // ========================
  // initialize
  // ========================
  initialize() {
    const argv = Minimist(process.argv.slice(2));
    let data;
    try {
      data = JSON.parse(argv._[0]);
    } catch (e) {
      data = {
        lang: 'en',
        username: "Team Drumee"
      };
    }
    this.yp = new Mariadb({ user: process.env.USER });
    this.lang = this.supportedLanguage(data.lang || 'en');
    //let p = Path.resolve(process.env.DRUMEE_SERVER_HOME, 'locale', `${this.lang}.json`);

    let p = Path.resolve(__dirname, '../../dataset/locale', `${this.lang}.json`);
    this.debug("Getting locale from", p);
    Cache.message = Jsonfile.readFileSync(p);
    this.nid = data.nid;
    Cache.message = Jsonfile.readFileSync(p);
    if (data.instance == "main") {
      this.service = '/_/';
    } else {
      this.service = `/_/${data.instance}/`;
    }

    this.sender_lang = data.sender_lang;
    this.emails = data.emails;
    this.db_name = data.db_name;
    this.ui_base = data.ui_base;
    this.verbose = data.verbose;
    this.email = data.email;
    this.pw = data.pw;
    this.expiry = data.expiry
    this.message = data.message
    this.hub_id = data.hub_id
    this.days = data.days;
    //this.debug("data", data);
    this.db = new Mariadb({ name: data.db_name, user: process.env.USER });
    //this.get_branch_nodes();
    this.zipid = this.randomString();
    this.deleteid = this.randomString();
    Moment.locale(this.lang);
    let e = Moment.now() / 1000;
    this.base_dir = `/drumee-transfer-${Moment(e, 'X').format("YYYY-MM-DD-hhmm")}`;
    this.build();
  }

  async send_ack_mail(emails, node) {

    let sender_name = emails.join('<br>')
    let recipient_name = this.email.replace(/@.+$/, '');
    const lang = this.lang;
    let subject = Cache.message._drumee_transfer_ack;
    const link = `https://${node.vhost}${this.service}?${node.id}/${this.deleteid}`;
    const msg = new Messenger({
      template: "butler/transfer_ack",
      base_dir: Path.resolve(this.ui_base, "bb-templates/node/email"),
      subject,
      recipient: this.email,
      lex: Cache.message,
      origin: "transfer",
      data: {
        link: link,
        recipient: recipient_name,
        password: this.pw,
        message: Cache.message._drumee_transfer_download_ack_message.format(sender_name, this.days),
      },
    });
    await msg.send();

  }
  /**
   * 
   * @param {*} email 
   * @param {*} message 
   * @param {*} token 
   */
  async send_mail(email, node, token) {
    let recipient_name = email.replace(/@.+$/, '');
    let sender_name = this.email.replace(/@.+$/, '');
    const lang = this.lang;
    const subject = Cache.message._drumee_transfer_download_link.format(this.email);
    let message = this.message
    message = message.replace(/(?:\r\n|\r|\n)/g, '<br>');
    //await this.yp.await_proc('db_log_put', message);
    const link = `https://${node.vhost}${this.service}?${node.id}/${token}`;
    console.log(`Sending to${email}`, subject, link);
    const msg = new Messenger({
      template: "butler/transfer",
      base_dir: Path.resolve(this.ui_base, "bb-templates/node/email"),
      subject,
      recipient: email,
      lex: Cache.message,
      origin: "transfer",
      data: {
        //username   : username
        // firstname: this.user.get('firstname'),
        // sender: this.user.get('fullname'),
        recipient: recipient_name,
        link: link,
        message,
        password: "",
        sys_message: Cache.message._drumee_transfer_download_message.format(sender_name),
      },
    });
    await msg.send();
  }

  /**
 * 
 * @param {*} opt 
 * @returns 
 */
  async cleanup(node, files) {
    for (let file of files) {
      let dir = Path.resolve(file.home_dir, Constants.VFS_ROOT_NODE, file.nid);
      if (this.verbose) this.debug("CLEANING NODE", dir);
      await this.db.await_proc("mfs_purge", file.nid);
      remove_dir(dir, 0);
    }
  }



  /**
   * 
   * @param {*} opt 
   * @returns 
   */
  async send(opt) {
    this.debug("SENDING");
    let args = {
      owner_id: "*",
      filename: opt.filename,
      pid: opt.parent_id,
      category: Attr.folder,
      ext: "",
      mimetype: Attr.folder,
      filesize: 0,
      showResults: 1
    };

    let md = {};
    md.fingerprint = this.pw;
    md.expiry = this.expiry;
    md.email = this.email
    md.deleteid = this.deleteid
    md.zipid = this.zipid
    md.sender_lang = this.sender_lang || 'en'
    md.branch = await this.db.await_proc('mfs_get_by', this.nid);
    let receiver_hash = [];
    let receiver_tokens = [];
    for (let email of this.emails) {
      let key = this.randomString()
      md[key] = email;
      receiver_tokens.push(key)
      receiver_hash.push(Crypto.createHash('sha256').update(JSON.stringify(email)).digest('hex'))
    }

    receiver_tokens.push(this.deleteid)
    md.receiver_tokens = receiver_tokens
    let results = { isOutput: 1 };

    let node = await this.db.await_proc("mfs_create_node", args, md, results);

    let analytic = {};
    analytic.size = opt.size
    analytic.receiver = this.emails.length
    analytic.is_download = 0
    analytic.receiver_hash = receiver_hash
    analytic.sender_hash = Crypto.createHash('sha256').update(JSON.stringify(this.email)).digest('hex')
    analytic.file_count = opt.files.length - 1
    await this.db.await_proc('update_analytic_transfer', node.id, stringify(analytic));

    await this.db.await_proc('permission_grant',
      node.id, '*', this.expiry, 3, 'no_traversal', this.zipid
    );

    await this.yp.await_proc('dmz_add_media', node.id, this.hub_id)
    await this.db.await_proc('permission_revoke', opt.node.id, null);

    let idx = 1
    for (let token of receiver_tokens) {

      if (token == this.deleteid) {
        await this.yp.await_proc('dmz_grant_next', this.hub_id, node.id,
          'DELETEID', token, this.pw
        );
        await this.send_ack_mail(this.emails, node);

      } else {
        await this.yp.await_proc('dmz_grant_next', this.hub_id, node.id,
          idx, token, this.pw
        );
        await this.send_mail(metadata[token], node, token);
        idx++;
      }
    }

    await this.cleanup(opt.node, opt.files);
    _.delay(this.stop.bind(this), 2000);
  }



  /**
   * 
   * @param {*} msg 
   */
  stop(msg) {
    let status = 0;
    if (_.isString(msg)) {
      console.error(msg);
      status = 1;
    }
    console.log("DONE!!!", msg);
    this.db.end();
    this.clear();
    //const batch = Path.resolve(this.data_dir, Constants.BATCH_FILE);
    //this.sh_rm(batch);
    exit(status);
  }

  /**
   * 
   * @param {*} msg 
   */

  // ========================
  //
  // ========================
  sh_mkdir(dirname, opt = '-p') {
    //let status = Shell.mkdir(opt, dirname);
    Fs.mkdirSync(dirname, { recursive: true });
  }

  /**
   * 
   * @param  {...any} o 
   */
  sh_cp(...o) {
    let status = Shell.cp(...o);
    if (status.code !== 0) {
      this.warn({ error: `FAILED_COPY_FILE : ${status.stderr}` });
      return false;
    }
    return true;
  }

  /**
   * 
   * @param  {...any} o 
   */
  sh_ln(target, pointer) {
    if (Fs.existsSync(Path.join(pointer, 'dont-remove-this-dir'))) {
      this.warn({ error: `FAILED_LINK_FILE : ${status.stderr}` });
      return false;
    }
    let status = Shell.ln('-sf', target, pointer);
    return true;
  }

  /**
   * 
   * @param  {...any} o 
   */
  sh_rm(...o) {
    let status = Shell.rm(...o);
    if (status.code !== 0) {
      this.warn({ error: `FAILED_REMOVE_FILE : ${status.stderr}` });
      return false;
    }
    return true;
  }



  /**
   * 
   * @param {*} files 
   * @param {*} socket
   * @returns 
   */
  async build() {
    let node = await this.db.await_proc('mfs_node_attr', this.nid);
    let e = await this.db.await_func("user_expiry", "*", this.nid);
    let expiry = Moment(e, 'X').format("YYYY MM DD hh:mm");
    node.expiry = expiry;
    this.verbose = 1;
    let uid = 'ffffffffffffffff';
    let data = await this.db.await_proc('mfs_manifest', { nid: this.nid, uid, show_nodes: 1 });
    let files = data[0];
    let size = data[1];
    size = size.size
    this.filename = files[0].filename;
    // console.log("path  ", 'process.env.DRUMEE_MFS_DIR',
    //   process.env.DRUMEE_MFS_DIR, 'Constants.DOWNLOAD_FOLDER', Constants.DOWNLOAD_FOLDER,
    //   'this.zipid', this.zipid, node);

    let dest_dir = Path.join(
      process.env.DRUMEE_MFS_DIR, Constants.DOWNLOAD_FOLDER, this.zipid
    );

    Fs.mkdirSync(dest_dir, { recursive: true });

    let re = new RegExp('^' + node.file_path)
    for (let i in files) {
      let fp = files[i].filepath;
      if (!fp) continue;
      files[i].filepath = fp.replace(re, '');
      //this.debug("LINK ", node.file_path, files[i].filepath, fp);
    }

    let dump = this.makeArchiveList(files, dest_dir);
    //if (this.verbose) this.debug("LINK ", dump);
    let count = 0;
    // let length = dump.length;

    for (let k of dump) {
      if (Fs.existsSync(k.src)) {
        this.sh_ln(k.src, k.dest);
      }
      count++;
    }
    let zname = this.filename.replace(/[ \n\<\>'"\(\)\/]/g, '-');

    const spawn = require('child_process').spawn;
    this.zipname = zname;
    const sp = spawn(`${Script.archive}`, [dest_dir, 'index']);
    sp.on('exit', (s) => {
      this.send({
        node,
        files,
        exit: s,
        size,
        finished: 1
      }).catch((e) => {
        this.stop("GOT ERROR", e);
      })
    });

    // sp.stdout.on('data', (data) => {
    //   let line = data.toString();
    //   let size = line.match(/(^.+) ([0-9]{1,3}\%).+$/);
    //   this.debug("Processing", line);
    // });
    sp.stderr.on('data', (e) => {
      console.error("Got error", e.toString());
      this.stop("GOT ERROR");
    });
  }

}

new __offline_media_zip();
//module.exports = __offline_media_zip;
