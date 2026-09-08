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
      // The pass itself is defensive, but this loop is the last line: if
      // anything at all escapes a pass (a transient yp error inside
      // check_pool, say), the pools stop being refilled and nothing anywhere
      // reports it — the daemon just goes quiet, which is how a create_hub
      // outage went eleven days without being noticed. Never let it end.
      while (1) {
        try {
          await this.run();
        } catch (e) {
          console.error("FACTORY PASS FAILED — retrying", e);
          await this.pause(15000);
        }
      }
    });
  }

  /**
   * One pass over both pools.
   *
   * `initialize` drives this in a `while (1)`, and that loop is the ONLY thing
   * that ever refills a pool — so a pass MUST settle. This used to be a
   * `new Promise(async ...)` whose executor awaited make_schema: a single
   * rejected build threw inside the executor, the promise was left
   * permanently unsettled, and the daemon sat "online" under pm2 with zero
   * restarts doing nothing at all while both pools drained. Nothing said so;
   * the last line in the log was the failed build.
   *
   * A failed build is now caught and backed off. The old executor also
   * resolved from INSIDE the loop (`setTimeout(resolve, ...)` on the first
   * type), so the caller started its next pass while this one was still
   * working on the second type; the pass is sequential now.
   */
  async run() {
    for (const type of ["drumate", "hub"]) {
      const ok = await this.check_pool(type);
      const file = this.script_path(type, "ok");
      if (!existsSync(file)) {
        this.error("Exit due to doubious template!");
        return;
      }
      if (!ok) {
        this.timer = 15000;
        LOG_CHANGED[type] = true;
        try {
          await this.make_schema(type);
          this.failures = 0;
        } catch (e) {
          this.failures = (this.failures || 0) + 1;
          console.error(
            `FAILED TO BUILD A ${type} SCHEMA (${this.failures} in a row)`, e
          );
          // Back off so a durable failure (a template that will not load, a
          // proc that refuses) stops spinning on entity_create/entity_delete,
          // but keep looping: what breaks a build is normally fixed under a
          // running factory, and a daemon that gives up is how the pools
          // emptied in the first place.
          await this.pause(Math.min(this.failures, 20) * 15000);
        }
      } else {
        if (LOG_CHANGED[type]) {
          console.log(`Watermark ${type}=${ok}, timer=${this.timer}`);
        }
        LOG_CHANGED[type] = false;
        if (this.timer < 60000) this.timer = this.timer + 1000;
      }
      await this.pause(this.timer);
    }
  }

  /**
   * @param {Number} ms
   * @returns {Promise<void>}
   */
  pause(ms) {
    return new Promise((done) => setTimeout(done, ms));
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
  async make_schema(type) {
    const s = new Schema({
      folders: [],
      type,
      script: this.script_path(type),
      lang: "en",
      verbose: 0,
      yp: this.yp,
    });
    let ok = false;
    try {
      ok = await s.create_entity();
    } catch (e) {
      await this.discard(s);
      throw e;
    }
    if (!ok) {
      // A build that stopped short left a database and a storage root behind
      // that `pool_free` counts and `pickupEntity` can never hand out.
      await this.discard(s);
      throw new Error(`INCOMPLETE ${type} ENTITY`);
    }
    s.destroy();
    console.log("Completed. Wait 5s before next round.");
    await this.pause(5000);
  }

  /**
   * Drop a half-built entity.
   *
   * `delete_entity` reports the rollback by throwing, which is not news here —
   * the caller already knows the build failed — and used to escape as an
   * unhandled rejection from the un-awaited `s.delete_entity()` calls in the
   * old callback pair.
   *
   * @param {Object} schema
   */
  async discard(schema) {
    try {
      await schema.delete_entity("Aborted");
    } catch (e) {
      console.error("ROLLED BACK A HALF-BUILT ENTITY:", e);
    }
    // `delete_entity` signals the rollback by throwing, so it never reaches a
    // destroy() of its own — and the entity's own connection was opened back
    // in create_vfs_root. Closing it here matters only now that a failed build
    // is RETRIED: under the old stall-forever behaviour one connection leaked
    // and the daemon stopped, where a retry loop would leak one per attempt
    // until the server refused new ones.
    try {
      schema.destroy();
    } catch (e) {
      /* already torn down by delete_entity's own empty-entity path */
    }
  }

  /**
   * Usable stock for one pool, or 0 when it sits below the watermark.
   *
   * `resolve(c)` used to sit on the healthy branch, but the only `resolve` in
   * scope was `require("path").resolve` destructured at the top of this very
   * method — and path.resolve() of a number throws ERR_INVALID_ARG_TYPE. The
   * one branch meaning "this pool is fine" therefore threw, which (with the
   * old non-settling `run`) stalled the daemon for good the first time a pool
   * reached its watermark.
   *
   * @param {String} type "drumate" | "hub"
   * @returns {Promise<Number>}
   */
  async check_pool(type) {
    const c = Number(await this.yp.await_func("pool_free", type));
    if (Number.isFinite(c) && c >= this.watermark[type]) {
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
