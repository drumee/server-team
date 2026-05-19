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

const {
  Attr, Constants, Messenger, Cache, sysEnv
} = require("@drumee/server-essentials");
const {
  DOWNLOAD_FOLDER,
  FILE_NOT_FOUND,
  MIME_ZIP,
  COOKIE_GUEST_SID,
  VFS_ROOT_NODE,
} = Constants;
const { mfs_dir, ui_base, server_home, instance } = sysEnv();
const { Mfs, MfsUtils } = require("@drumee/server-core");
const { remove_dir } = MfsUtils;

const { existsSync } = require("fs");
const { isEmpty, includes, isArray } = require("lodash");
const { stringify } = JSON;
const { resolve, join } = require("path");
const Script = require("@drumee/server-essentials/lex/script");
const Spawn = require("child_process").spawn;

class __transfer extends Mfs {

  /**
   * 
   */
  async create() {
    const pid = this.source_granted().id;
    let filename = this.randomString();
    let uid = this.uid;
    let token = this.randomString();
    let quota = 1000000 * 1000;
    let args = {
      owner_id: uid,
      filename,
      pid,
      category: Attr.folder,
      ext: "",
      mimetype: Attr.folder,
      filesize: 0,
    };

    let results = { show: 1 };
    let node = await this.db.await_proc(`mfs_create_node`, args, {}, results);

    await this.db.await_proc(
      "permission_grant",
      node.id,
      "*",
      7,
      7,
      "no_traversal",
      dirname
    );
    await this.yp.await_proc("cookie_add_guest", token, uid, this.input.ua());
    let p = await this.yp.await_proc(
      "dmz_grant_next",
      this.hub.get(Attr.id),
      node.id,
      uid,
      token,
      null
    );
    this.output.cookie(COOKIE_GUEST_SID, token, this.input.host());
    this.output.data({
      nid: node.id,
      privilege: 7,
    });
  }

  /**
   * 
   */
  async remove() {
    let nid = this.input.need(Attr.nid);
    let data = await this.db.await_proc("mfs_manifest", { nid, uid: this.uid, show_nodes: 1 });
    let files = data[0];
    if (!isArray(files)) {
      files = [files];
    }
    for (let file of files) {
      let dir = resolve(file.home_dir, VFS_ROOT_NODE, file.nid);
      this.debug("CLEANING NODE", dir);
      remove_dir(dir, 0);
    }
    await this.db.await_proc("mfs_delete_node", nid);
    this.output.data({ nid });
  }

  /**
   * 
   */
  async send_otp() {
    let nid = this.source_granted().id;
    const email = this.input.need(Attr.email, "");
    let emails = this.input.need(Attr.emails) || [];
    let metadata = {};
    metadata.otp = await this.generate_otp();
    metadata.otp_mail = email;
    metadata.otp_mail_verified = 0;
    const lang =
      this.supportedLanguage(this.input.get("Xlang")) ||
      this.user.language() ||
      this.input.app_language();
    await this.db.await_proc("mfs_set_metadata", nid, stringify(metadata), 0);
    let recipient_name = email.replace(/@.+$/, "");
    const subject = `${Cache.message("_transfer_otp_subject", lang)}`;
    const message = `${Cache.message
      .message("_transfer_otp_message", lang)
      .format(emails.join("<br>"), metadata.otp)}`;
    const msg = new Messenger({
      template: "butler/tranfer_otp",
      subject,
      recipient: metadata.otp_mail,
      lex: Cache.lex(lang),
      origin: "transfer",
      data: {
        recipient: recipient_name,
        message,
      },
    });
    await msg.send();
    this.output.data({ nid });
  }

  /**
   *
   * @returns
   */
  async generate_otp() {
    var digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let otp = "";
    for (let i = 0; i < 6; i++) {
      otp += digits[Math.floor(Math.random() * 36)];
    }
    return otp;
  }

  /**
   *
   * @param {*} code
   * @param {*} email
   * @returns
   */
  async is_valid_otp(code, email) {
    let valid = 0;
    let metadata = this.source_granted().node.metadata;
    metadata = this.parseJSON(metadata) || {};

    let otp = 0;
    if ("otp" in metadata) {
      otp = metadata.otp;
    }
    let otp_mail = "";
    if ("otp_mail" in metadata) {
      otp_mail = metadata.otp_mail;
    }
    if (otp == code && otp_mail == email) {
      valid = 1;
    }
    return valid;
  }

  /**
   *
   * @param {*} nid
   * @param {*} password
   * @param {*} days
   */
  async create_link() {
    const self = this;
    let node = self.source_granted().node;
    let nid = node.id;
    const deviceId = self.input.use("deviceId");
    const pw = self.input.use(Attr.password) || "";
    const days = self.input.use(Attr.days) || 7;
    const expiry = days * 24;
    const sender_lang =
      this.input.get("Xlang") ||
      this.supportedLanguage(this.input.get("Xlang")) ||
      this.user.language() ||
      this.input.app_language() ||
      "en";
    const Moment = require("moment");
    async function f() {
      let res = {};
      Moment.locale(self.lang);
      let e = Moment.now() / 1000;
      let base_dir = `/drumee-transfer-${Moment(e, "X").format(
        "YYYY-MM-DD-hhmm"
      )}`;

      let ext = new RegExp(`.${node.extension}`);


      let data = await self.db.await_proc("mfs_manifest", { nid, uid: self.uid, show_nodes: 1 });
      let files = data[0];
      let size = data[1];
      size = size.total_size;
      let filename = files[0].user_filename;

      let zipid = self.randomString();

      let dest_dir = join(mfs_dir, DOWNLOAD_FOLDER, zipid);

      self.debug(base_dir, filename, dest_dir);
      if (!self.sh_mkdir(dest_dir)) {
        res.status = "Failed to create zip dir";
        return res;
      }

      let re = new RegExp("^" + node.file_path);
      for (let i in files) {
        let fp = files[i].filepath;
        if (!fp) continue;
        files[i].filepath = fp.replace(re, "");
      }

      let dump = self.makeArchiveList(files, dest_dir);

      for (let k of dump) {
        if (existsSync(k.src)) {
          self.sh_ln(k.src, k.dest);
        }
      }

      let child = Spawn(Script.archive, [dest_dir, "index"], { detached: true });
      child.unref();

      let args = {
        owner_id: "*",
        filename: node.filename,
        pid: node.parent_id,
        category: Attr.folder,
        ext: "",
        mimetype: Attr.folder,
        filesize: 0,
      };
      let md = {};
      md.fingerprint = pw;
      md.expiry = expiry;
      md.deleteid = self.randomString();
      md.zipid = zipid;
      md.branch = await self.db.await_proc("mfs_get_by", nid);
      md.sender_lang = sender_lang || "en";
      md.receiver_tokens = [];
      md.receiver_tokens.push(zipid);

      let results = { show: 1 };
      let zipnode = await self.db.await_proc(`mfs_create_node`, args, md, results);

      let analytic = {};
      analytic.size = size;
      analytic.receiver = 1;
      analytic.is_download = 0;
      analytic.sender_hash = deviceId;
      analytic.file_count = files.length - 1;
      await self.db.await_proc(
        "update_analytic_transfer",
        zipnode.id,
        stringify(analytic)
      );

      await self.db.await_proc(
        "permission_grant",
        zipnode.id,
        "*",
        expiry,
        3,
        "no_traversal",
        zipid
      );

      await self.yp.await_proc(
        "dmz_add_media",
        zipnode.id,
        self.hub.get(Attr.id)
      );
      await self.yp.await_proc(
        "dmz_grant_next",
        self.hub.get(Attr.id),
        zipnode.id,
        zipnode.id,
        zipid,
        pw
      );

      await self.db.await_proc("permission_revoke", node.id, null);

      await self.cleanup(node, files);

      const pathname = self.input.basepath();
      res.link = `https://${zipnode.vhost}${pathname}${zipnode.id}/${zipid}`;
      await self.db.await_proc(
        "analytic_transfer_log",
        zipnode.id,
        self.input.ua()
      );
      return res;
    }
    f()
      .then(async function (r) {
        self.output.data(r);
      })
      .catch(self.fallback);
  }

  /**
   *
   */
  async cleanup(node, files) {
    // Delete original files
    for (let file of files) {
      let dir = resolve(file.home_dir, VFS_ROOT_NODE, file.nid);
      if (this.verbose) this.debug("CLEANING NODE", dir);
      await this.db.await_proc("mfs_purge", file.nid);
      remove_dir(dir, 0);
    }
    // Recreate maiden folder with the same name for future access
  }

  /**
   * Only analyr=tics purpose
   */
  async visite() {
    this.output.data({});
  }


  /**
   * 
   */
  async send_link(id, vcf) {
    let nid = this.source_granted().id;
    let valid_otp = true;
    const pw = this.input.use(Attr.password) || "";
    const days = this.input.use(Attr.days) || 7;
    const expiry = days * 24;
    const message = this.input.use(Attr.message, "");
    const email = this.input.need(Attr.email, "");
    const sender_lang =
      this.input.get("Xlang") ||
      this.supportedLanguage(this.input.get("Xlang")) ||
      this.user.language() ||
      this.input.app_language() ||
      "en";
    const lang =
      this.supportedLanguage(this.input.get("Xlang")) ||
      this.user.language() ||
      this.input.app_language();
    // @todo  Uncomment this line if OTP Check Needed
    // let valid_otp = await this.is_valid_otp(code, email)
    if (valid_otp) {
      let args = {
        nid,
        pw,
        email,
        expiry,
        message,
        days,
        hub_id: this.hub.get(Attr.id),
        db_name: this.hub.get(Attr.db_name),
        lang,
        sender_lang,
        emails: this.input.need(Attr.emails),
        ui_base,
        instance,
      };
      let cmd = resolve(
        server_home,
        "offline",
        "media",
        "transfer.js"
      );
      Spawn(cmd, [JSON.stringify(args)], { detached: true });
      this.output.data({ nid });
    } else {
      let res = {};
      res.status = "INVALID_OTP";
      this.output.data(res);
    }
  }

  /**
   * 
   */
  async link_info() {
    const self = this;
    let nid = self.source_granted().id;
    let token = self.input.need(Attr.token);
    let session = this.input.sid();
    async function f() {
      let res = {};
      if (isEmpty(nid)) {
        res.status = "EXPIRED_TOKEN";
        return res;
      }

      let metadata = self.source_granted().node.metadata;
      metadata = self.parseJSON(metadata);
      let receiver_tokens = self.parseJSON(metadata.receiver_tokens);

      let filepath = resolve(
        mfs_dir,
        DOWNLOAD_FOLDER,
        metadata.zipid,
        "index.zip"
      );

      if (!includes(receiver_tokens, token)) {
        res.status = "WRONG_TOKEN";
        return res;
      }

      if (!includes(receiver_tokens, token)) {
        if (!existsSync(filepath)) {
          res.status = "WRONG_TOKEN";
          return res;
        }
      }

      let chk_session = "0";
      if (!isEmpty(metadata.session)) {
        chk_session = metadata.session[session] || "0";
      }
      let pw = 0;
      if (!isEmpty(metadata.fingerprint)) {
        pw = 1;
      }

      if (pw == 1 && chk_session == 0) {
        res.status = "PASSWORD_REQUIRED";
        return res;
      }

      if (chk_session == "0") {
        await self.db.await_proc("update_transfer_session", nid, session);
      }

      metadata.session = session;
      metadata.branch = self.parseJSON(metadata.branch);

      if (!isArray(metadata.branch)) {
        metadata.branch = [metadata.branch];
      }

      let analytic = await self.db.await_proc("get_analytic_transfer", nid);
      metadata.analytic = self.parseJSON(analytic.metadata);

      metadata.days = await self.yp.await_func(
        "duration_days",
        metadata.expiry
      );
      metadata.hours = await self.yp.await_func(
        "duration_hours",
        metadata.expiry
      );

      metadata.is_delete_token = 0;
      if (metadata.deleteid == token) {
        metadata.is_delete_token = 1;
      }

      delete metadata["session"];
      delete metadata["fingerprint"];
      delete metadata["deleteid"];
      delete metadata["zipid"];
      delete metadata["receiver_tokens"];
      for (let token of receiver_tokens) {
        self.debug("eeeeee", token);
        delete metadata[token];
      }

      return metadata;
    }
    f()
      .then(async function (r) {
        self.output.data(r);
      })
      .catch(self.fallback);
  }

  /**
   * 
   */
  async chk_password() {
    const self = this;
    const pw = this.input.use(Attr.password) || "";
    let nid = self.source_granted().id;
    let token = self.input.need(Attr.token);
    let session = this.input.sid();

    async function f() {
      let res = {};
      if (isEmpty(nid)) {
        res.status = "EXPIRED_TOKEN";
        return res;
      }

      let metadata = self.source_granted().node.metadata;
      metadata = self.parseJSON(metadata);
      let receiver_tokens = self.parseJSON(metadata.receiver_tokens);

      let filepath = resolve(
        mfs_dir,
        DOWNLOAD_FOLDER,
        metadata.zipid,
        "index.zip"
      );

      if (!includes(receiver_tokens, token)) {
        res.status = "WRONG_TOKEN";
        return res;
      }

      if (includes(receiver_tokens, token)) {
        if (!existsSync(filepath)) {
          res.status = "WRONG_TOKEN";
          return res;
        }
      }

      let chk = await self.yp.await_func(
        "chk_fingerprint",
        pw,
        metadata.fingerprint
      );

      if (chk == 0) {
        res.status = "INVALID_PASSWORD";
        return res;
      }

      await self.db.await_proc("update_transfer_session", nid, session);

      metadata.branch = self.parseJSON(metadata.branch);
      if (!isArray(metadata.branch)) {
        metadata.branch = [metadata.branch];
      }

      metadata.days = await self.yp.await_func(
        "duration_days",
        metadata.expiry
      );
      metadata.hours = await self.yp.await_func(
        "duration_hours",
        metadata.expiry
      );

      metadata.is_delete_token = 0;
      if (metadata.deleteid == token) {
        metadata.is_delete_token = 1;
      }

      delete metadata["session"];
      delete metadata["fingerprint"];
      delete metadata["deleteid"];
      delete metadata["zipid"];
      delete metadata["receiver_tokens"];
      for (let token of receiver_tokens) {
        self.debug("eeeeee", token);
        delete metadata[token];
      }

      return metadata;
    }
    f()
      .then(async function (r) {
        self.output.data(r);
      })
      .catch(self.fallback);
  }


  /**
   * 
   */
  async download() {
    let nid = this.source_granted().id;
    const deviceId = this.input.need("deviceId");
    let token = this.input.need(Attr.token);
    let session = this.input.sid();

    if (isEmpty(nid)) {
      this.warn(`ERROR : EXPIRED_TOKEN`);
      this.exception.user("EXPIRED_TOKEN");
      return;
    }

    let metadata = this.source_granted().node.metadata;
    metadata = this.parseJSON(metadata);
    let receiver_tokens = this.parseJSON(metadata.receiver_tokens);

    if (!includes(receiver_tokens, token)) {
      this.warn(`ERROR : EXPIRED_TOKEN`);
      this.exception.user("EXPIRED_TOKEN");
      return;
    }

    let filepath = resolve(
      mfs_dir,
      DOWNLOAD_FOLDER,
      metadata.zipid,
      "index.zip"
    );

    if (!existsSync(filepath)) {
      // Fileio.not_found(filepath);
      this.warn(`ERROR : ${filepath} not found`);
      this.exception.user(FILE_NOT_FOUND);
      return;
    }

    let chk_session = "0";
    if (!isEmpty(metadata.session)) {
      chk_session = metadata.session[session] || "0";
    }

    let analytic = {};
    analytic.is_download = 1;
    analytic.download_by = deviceId;

    await this.db.await_proc(
      "update_analytic_transfer",
      nid,
      stringify(analytic)
    );

    if (!isEmpty(metadata.email)) {
      analytic = await this.db.await_proc("get_analytic_transfer", nid);
      analytic.metadata = this.parseJSON(analytic.metadata);
      this.down_ack_mail(
        metadata[token],
        metadata.email,
        analytic.metadata.download_at,
        nid,
        metadata.deleteid
      );
    }
    const opt = {
      path: filepath,
      name: "drumee-transfer.zip",
      mimetype: MIME_ZIP,
      code: 200,
    };
    const fileio = new Fileio(this);
    fileio.static(opt, 0);
  }

  /**
   * 
   */
  async down_ack_mail(receiver_email, email, download_at, nid, deleteid) {
    const lang =
      this.supportedLanguage(this.input.get("Xlang")) ||
      this.user.language() ||
      this.input.app_language();
    const len = download_at.length;
    var date = new Date(download_at[len - 1] * 1000);

    let recipient_name = email.replace(/@.+$/, "");
    const subject = `${Cache.message(
      "_transfer_downloaded_subject",
      lang
    )}`;
    const message = `${Cache.message
      .message("_transfer_downloaded_message", lang)
      .format(receiver_email, date.toUTCString())}`;
    const pathname = this.input.basepath();
    let link = `https://${this.input.host()}${pathname}${nid}/${deleteid}`;
    const msg = new Messenger({
      template: "butler/tranfer_download_ack",
      subject,
      recipient: email,
      lex: Cache.lex(lang),
      origin: "transfer",
      data: {
        link: link,
        recipient: recipient_name,
        message,
      },
    });
    await msg.send();
  }

    /**
   * 
   */

  async delete() {
    let nid = this.source_granted().id;
    let token = this.input.need(Attr.token);
    let hub_id = this.hub.get(Attr.id);

    if (isEmpty(nid)) {
      this.warn(`ERROR : EXPIRED_TOKEN`);
      this.exception.user("EXPIRED_TOKEN");
      return;
    }

    let metadata = this.source_granted().node.metadata;
    metadata = this.parseJSON(metadata);

    if (metadata.deleteid != token) {
      this.warn(`ERROR : WRONG_TOKEN`);
      this.exception.user("token");
      return;
    }

    let filepath = resolve(
      mfs_dir,
      DOWNLOAD_FOLDER,
      metadata.zipid
    );
    console.log(`download file path=${filepath}(${existsSync(filepath)})`);

    await this.db.await_proc("permission_revoke", nid, null);
    await this.db.await_proc("mfs_purge", nid);
    await this.yp.await_proc("dmz_remove_media", nid);
    await this.yp.await_proc("dmz_revoke", hub_id, nid, null);

    if (existsSync(filepath)) {
      remove_dir(filepath, 0);
    }

    this.output.data(filepath);
  }
}

module.exports = __transfer;
