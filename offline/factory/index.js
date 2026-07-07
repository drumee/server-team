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
const Schema = require("./schema");
const { rm, exec } = require("shelljs");
const { existsSync } = require("fs");
const { argv } = require("process");
const { userInfo } = require('os');

const { Mariadb, Offline, sysEnv, Constants } = require("@drumee/server-essentials");
const { system_user } = sysEnv();
const LOG_CHANGED = {};
const { load } = require("../../configs")
class __drumee_factory extends Offline {
  /**
   * 
   */
  initialize() {
    this.yp = new Mariadb();
    this.timer = 5000;
    const { watermark } = load() || {}
    this.watermark = {
      hub: watermark?.hub || 210,
      drumate: watermark?.drumate || 210,
    };
    this.info = this.checkSanity().then(async () => {
      if (argv.rebuild === "no" && this.scripts_clean()) {
        console.log("Skip buillding new templates");
      } else {
        await this.make_template("hub");
        await this.make_template("drumate");
      }
      while (1) {
        await this.run();
      }
    });
  }

  /**
   *
   * @param {*} cb
   */
  run(cb) {
    return new Promise(async (resolve, reject) => {
      for (var type of ["drumate", "hub"]) {
        let ok = await this.check_pool(type);
        let file = this.script_path(type, "ok");
        if (!existsSync(file)) {
          this.error("Exit due to doubious template!");
          return;
        }
        if (!ok) {
          this.timer = 15000;
          LOG_CHANGED[type] = true;
          await this.make_schema(type);
        } else {
          if (LOG_CHANGED[type]) {
            console.log(`Watermark ${type}=${ok}, timer=${this.timer}`);
          }
          LOG_CHANGED[type] = false;
          if (this.timer < 60000) this.timer = this.timer + 1000;
        }
        setTimeout(resolve, this.timer);
      }
    });
  }

  /**
   *
   */
  async checkSanity() {
    console.log(`STARTING SCHEMAS FACTORY... `);
    let s = await this.yp.await_query(`SHOW SLAVE STATUS`);
    if (s && s.Slave_IO_Running) {
      this.error("This daemon must not run on replica server");
      return;
    }
    const { username } = userInfo();
    console.log(`STARTING SCHEMAS FACTORY... USER=${username}`);
    if (![system_user, "root"].includes(username)) {
      this.error(`Must be run with root privilege or ${system_user}`);
      return;
    }

    for (var type of ["drumate", "hub"]) {
      console.log(`Cleaning existing template ${this.script_path(type)}`);
      let s = rm("-f", this.script_path(type, "ok"));
      s = rm("-f", this.script_path(type));
      if (s.code !== 0) {
        this.error(s);
      }
    }
  }
  /**
   *
   * @param {*} e
   */
  error(e) {
    console.error(`_________________________________________\n`);
    console.error(e);
    console.error("______________________________________\n");
    process.exit(1);
  }

  /**
   * Reports whether the cached template scripts already exist on disk, so the
   * factory can skip rebuilding them (used by the `--rebuild=no` startup path).
   *
   * Called two ways:
   *  - With a `type` (and optional `ext`): checks a single file's existence and
   *    returns the boolean. This is the recursion base case.
   *  - With no arguments: fans out to verify all four expected files are present
   *    — the `.sql` dump and its `.ok` sentinel for both `drumate` and `hub`.
   *
   * @param {string} [type] - entity type ("drumate" | "hub"); omit to check all
   * @param {string} [ext] - file extension passed to script_path (defaults to "sql")
   * @returns {boolean} true when the requested template(s) exist
   */
  scripts_clean(type, ext) {
    if (type) {
      return existsSync(this.script_path(type, ext));
    }
    let a = this.scripts_clean("drumate") && this.scripts_clean("hub");
    let b =
      this.scripts_clean("drumate", "ok") && this.scripts_clean("hub", "ok");
    return a && b;
  }

  /**
   *
   * @param {*} type
   */
  script_path(type, ext = "sql") {
    const { resolve } = require("path");
    return resolve("/tmp/", `drumee-template-${type}.${ext}`);
  }

  /**
   *
   * @param {*} type
   */
  async make_template(type) {
    let script = this.script_path(type);
    let sql = `SELECT db_name, id FROM entity WHERE type='${type}' AND status='active' AND dom_id=1 limit 1`;
    let row = await this.yp.await_query(sql);
    if (!row || row.id == null) {
      this.error(`COULD NOT SELECT TEMPLATE ${type} FROM ENTITY TABLE`);
      return null;
    }

    console.log(`Building ${type} template FROM ${row.db_name} (${row.id})`);
    const opt =
      "--routines --quick --no-data --single-transaction --skip-comments";
    const { username } = userInfo();
    const dump = `${Constants.DB_DUMP} -u ${username} ${opt} ${row.db_name} > ${script}`;
    console.log(`DUMPING FRESH TEMPLATE : ${dump}`);
    let res = exec(dump, { silent: true });
    if (res == null || res.code !== 0) {
      console.error(`FAILED TO RUN **${dump}**`, res.stderr);
      process.exit(1);
    }
    exec(`touch ${this.script_path(type, "ok")}`, { silent: true });
    return script;
  }

  /**
   *
   * @param {*} type
   */
  make_schema(type) {
    let yp = this.yp;
    return new Promise((resolve, reject) => {
      const s = new Schema({
        folders: [],
        type,
        script: this.script_path(type),
        lang: "en",
        verbose: 0,
        yp,
      });
      let failed = function (e) {
        console.error(e);
        s.delete_entity();
        reject(e);
      };
      let check = function (ok) {
        if (!ok) {
          s.delete_entity();
          reject("Aborted");
          return;
        }
        s.destroy();
        console.log("Completed. Wait 5s before next round.");
        setTimeout(resolve, 5000);
      };
      try {
        s.create_entity().then(check).catch(failed);
      } catch (e) {
        failed(e);
      }
    });
  }

  /**
   *
   * @param {*} type
   */
  async check_pool(type) {
    const { resolve } = require("path");
    let c = await this.yp.await_func("pool_free", type);
    if (c >= this.watermark[type]) {
      resolve(c);
      return c;
    }
    return 0;
  }
}

try {
  new __drumee_factory();
} catch (e) {
  let msg = "Failed to Drumee Factory" + e.toString();
  console.error(msg, e);
  process.exit(1);
}
// ==========================================
// _____________________________________

module.exports = __drumee_factory;
