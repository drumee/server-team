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
const { join } = require("path");

const { RedisStore, Mariadb, Offline, toArray, sysEnv } = require('@drumee/server-essentials');
const { sqlString } = require('../../service/lib/sql-literal');
class __offline_media_export extends Offline {
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
    this.granted = data.granted;
    this.dest_path = data.dest_path;
    this.socket_id = data.socket_id;
    this.uid = data.uid;
    this.transactionid = data.transactionid;
    //console.log(`  this.granted  =${(this.granted)}`);

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
    this.sender = await this.yp.await_proc("get_user", this.uid);
    this.service = "mfs.serverexport";
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
    await this.build();
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
    let res = [];
    let dest_full_path;
    res = await this.yp.await_proc(
      "forward_proc",
      this.uid,
      "mfs_export",
      `${sqlString(stringify(this.granted))}, ${sqlString(this.uid)}`
    );
    res = toArray(res);
    let { export_dir } = sysEnv();
    let folderPath = export_dir || global.myDrumee.exchangesArea.exportFolders;

    let cnt = 0;
    let prorate = 80.0 / (res.length * 2);
    let progres = 0;

    for (var resnode of res) {
      cnt++;
      progres = cnt * prorate;
      if (resnode.category == "folder") {
        dest_full_path = join(
          folderPath,
          this.dest_path,
          resnode.destination
        );
        shell.exec(`/bin/mkdir     '${dest_full_path}'`);
        //console.log(`full path=${dest_full_path}`);
      }

      await this.send({
        phase: "progres",
        message: "PROGRES",
        progress: progres,
        transactionid: this.transactionid,
      });
    }

    for (var resnode of res) {
      cnt++;
      progres = cnt * prorate;
      if (resnode.category != "folder") {
        dest_full_path = join(
          folderPath,
          this.dest_path,
          resnode.destination
        );
        shell.exec(`/bin/cp -rf "${resnode.source}"  "${dest_full_path}"`);
        //console.log(`gopi file=${dest_full_path}`);
      }
      await this.send({
        phase: "progres",
        message: "PROGRES",
        progress: progres,
        transactionid: this.transactionid,
      });
    }

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

new __offline_media_export();
