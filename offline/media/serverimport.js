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
const stringify = require("json-stringify");
const Minimist = require("minimist");
const { exit } = require("process");
const shell = require("shelljs");
const { readdirSync, statSync, existsSync } = require("fs");
const { parse, join } = require("path");
const Jsonfile = require("jsonfile");
const { childPaths, nodeFolder } = require("../../service/lib/mfs-path");
const {
  Attr, getFileinfo, RedisStore, Mariadb, Offline, Cache, toArray, sysEnv, uniqueId
} = require('@drumee/server-essentials');

class __offline_media_import extends Offline {
  /**
   * 
   */
  initialize() {
    const argv = Minimist(process.argv.slice(2));
    let data;
    try {
      data = JSON.parse(argv._[0]);
    } catch (e) {
      console.error("Failed to parse arguments", e);
      exit(1);
    }
    this.yp = new Mariadb({ user: process.env.USER });
    this.data = data;
    this.pid = data.pid;
    this.recipient_id = data.recipient_id;
    this.source_list = data.source_list;
    this.socket_id = data.socket_id;
    this.uid = data.uid;
    this.transactionid = data.transactionid;
    this.nodes = [];

    let base = resolve(__dirname, "../../configs/configs");
    let file = resolve(base, `files-formats.json`);
    if (!existsSync(file)) {
      throw `Files formats description ${file} not found`;
    }

    let res = new RedisStore();
    res.init().then(() => {
      this.prepare()
        .then(() => {
          this.debug("Done! WIll stop later");
          //this.stop();
        })
        .catch((e) => {
          this.warn("Error raised:", e);
          exit(1);
        });
    });
  }

  /**
   * 
   */
  async prepare() {
    new Cache();
    await Cache.load();
    this.sender = await this.yp.await_proc("get_user", this.uid);
    this.service = "mfs.serverimport";
    let model = {
      phase: "prepare",
      progress: 0,
      transactionid: this.transactionid,
    };
    let options = {
      service: this.service,
      tag: this.service,
      message: "PREPARATION",
      transactionid: this.transactionid,
    };
    this._payload = this.payload(model, options);
    //await RedisStore.sendData(this._payload, this.socket_id);
    await this.build();
  }


  /**
   * 
   * @param {*} directory 
   * @param {*} parent_id 
   * @param {*} lvl 
   * @param {*} parent_path 
   * @param {*} home_dir 
   */
  async getFilesRecursively(directory, parent_id, lvl, parent_path, home_dir) {
    const filesInDirectory = readdirSync(directory);
    for (const file of filesInDirectory) {
      const absolute = join(directory, file);
      let node = {};
      node.id = uniqueId(8, 'hex');
      node.parent_id = parent_id;
      node.user_filename = parse(absolute).name;
      node.base = parse(absolute).base;
      node.filesize = statSync(absolute).size;
      node.extension = parse(absolute).ext.substring(1);
      let info = await getFileinfo(node.user_filename + "." + node.extension);
      node.category = info.category;

      node.mimetype = info.mimetype;
      node.lvl = lvl + 1;
      Object.assign(node, childPaths(
        parent_path,
        node.extension ? `${node.user_filename}.${node.extension}` : node.user_filename
      ));
      node.source = join(absolute, "");

      node.destination = join(home_dir, node.id);
      node.destination_file = join(
        home_dir,
        node.id,
        "/orig." + node.extension
      );

      if (statSync(absolute).isDirectory()) {
        node.filesize = 0;
        node.extension = "";
        node.category = "folder";
        node.mimetype = "";
        node.lvl = lvl + 1;
        Object.assign(node, childPaths(parent_path, node.user_filename));
        this.nodes.push(node);
        await this.getFilesRecursively(
          absolute,
          node.id,
          node.lvl,
          node.file_path,
          home_dir
        );
      } else {
        this.nodes.push(node);
      }
    }
  }

  /**
   *
   * @param {*} opt
   * @returns
   */
  async send(model, message) {
    if (!this.socket_id) {
      console.error("Error: No destination to send to");
      return;
    }
    this._payload.model = { ...this._payload.model, ...model };
    if (message) {
      this._payload.options.message = message;
    } else if (model.message) {
      this._payload.options.message = model.message;
    }
    //this.debug("AAA:91", this._payload, this.socket_id);
    await RedisStore.sendData(this._payload, this.socket_id);
  }

  /**
   * 
   */
  async build() {
    let source_list = toArray(this.source_list);
    let dest_attr = await this.yp.await_proc(
      "forward_proc",
      this.recipient_id,
      "mfs_access_node",
      `'${this.uid}', '${this.pid}'`
    );
    let { import_dir } = sysEnv();
    let folderPath = import_dir || global.myDrumee.exchangesArea.importFolders;

    for (let source of source_list) {
      let node = {};
      let absolute = join(folderPath, source);
      let unique_file = parse(absolute).name;
      unique_file = await this.yp.await_proc(
        "forward_proc",
        this.recipient_id,
        "mfs_unique_filename",
        `'${dest_attr.id}', '${unique_file}', '${dest_attr.ext}'`
      );
      node.user_filename = unique_file.user_filename;
      node.id = uniqueId(8, 'hex');
      node.parent_id = dest_attr.id;
      node.base = parse(absolute).base;
      node.filesize = statSync(absolute).size;
      node.extension = parse(absolute).ext.substring(1);
      let info = getFileinfo(node.user_filename + "." + node.extension);
      node.category = info.category;
      node.mimetype = info.mimetype;
      node.lvl = 0;
      const destFolder = nodeFolder(dest_attr);
      Object.assign(node, childPaths(
        destFolder,
        node.extension ? `${node.user_filename}.${node.extension}` : node.user_filename
      ));
      node.source = join(absolute, "");
      node.destination = join(dest_attr.home_dir, node.id);
      node.destination_file = join(
        dest_attr.home_dir,
        node.id,
        "/orig." + node.extension
      );

      if (statSync(absolute).isDirectory()) {
        node.filesize = 0;
        node.extension = "";
        node.category = "folder";
        node.mimetype = "";
        Object.assign(node, childPaths(destFolder, node.user_filename));
        node.source = "";
        node.destination = "";
        node.destination_file = "";
        this.nodes.push(node);
        await this.getFilesRecursively(
          absolute,
          node.id,
          node.lvl,
          node.file_path,
          dest_attr.home_dir
        );
      } else {
        this.nodes.push(node);
      }
    }

    let cnt = 0;
    let prorate = 80.0 / this.nodes.length;
    let progres = 0;

    for (var node of this.nodes) {
      cnt++;
      progres = cnt * prorate;

      if (node.category != "folder") {
        shell.mkdir("-p", node.destination);
        shell.exec(`/bin/cp -rf  "${node.source}"  "${node.destination_file}"`);

        if (node.category == Attr.document && node.extension != Attr.pdf) {
          let base = join(dest_attr.home_dir, node.id, "info.json");
          shell.exec(`/bin/touch  '${base}' `);
          Jsonfile.writeFileSync(base, "{}");
        }
      }
      await this.send({
        phase: "progres",
        message: "PROGRES",
        progress: progres,
        transactionid: this.transactionid,
      });
    }

    await this.yp.await_proc(
      "forward_proc",
      this.recipient_id,
      "mfs_import",
      `'${stringify(this.nodes)}', '${this.uid}'`
    );
    progres = 90;

    await this.send({
      phase: "progres",
      message: "PROGRES",
      progress: progres,
      transactionid: this.transactionid,
    });

    let recipients = await this.yp.await_proc(
      "entity_sockets",
      this.recipient_id
    );
    recipients = toArray(recipients);

    let keys = { pid: Attr.nid, vhost: "vhost" };
    let service = "media.new";

    for (var node of this.nodes) {
      if (node.lvl == 0) {
        let attr = await this.yp.await_proc(
          "forward_proc",
          this.recipient_id,
          "mfs_access_node",
          `'${this.uid}', '${node.id}'`
        );
        //await RedisStore.sendData(this.payload(keys, { service: "media.new" }), recipients);
        await RedisStore.sendData(
          this.payload(attr, { keys, service }),
          recipients
        );
      }
    }

    await RedisStore.sendData(
      this.payload({}, { service: "notification.resync" }),
      recipients
    );

    progres = 100;

    await this.send({
      phase: "completed",
      message: "COMPLETED",
      progress: progres,
      transactionid: this.transactionid,
    });

    exit(0);
  }
}

new __offline_media_import();
