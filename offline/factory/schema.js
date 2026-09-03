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
  Attr, Constants, Mariadb, Logger, sysEnv
} = require("@drumee/server-essentials");
const { isEmpty } = require("lodash");
const { existsSync, mkdirSync, rmSync } = require("fs");
const { exec } = require("shelljs");
const { ID_NOBODY } = Constants;
const { check_safety } = require("@drumee/server-core").MfsTools;
const { resolve } = require("path");


class __schema extends Logger {
  constructor(...args) {
    super(...args);
    this.initialize = this.initialize.bind(this);
    this.create_media_root = this.create_media_root.bind(this);
    this.create_vfs_root = this.create_vfs_root.bind(this);
    this.publish_search_projection = this.publish_search_projection.bind(this);
    this.create_entity = this.create_entity.bind(this);
    this.delete_entity = this.delete_entity.bind(this);
    this.load_sql = this.load_sql.bind(this);
  }

  /**
   * 
   * @param {*} opt 
   */
  async initialize(opt) {
    this.yp = this.get("yp") || new Mariadb();
    this.schemas_dir = this.get("schemas");
    console.log(`CREATING ENTITY SCHEMAS `);
    if (isEmpty(this.get(Attr.type))) {
      throw "attribute type must bet set";
    }
  }

  /**
   * 
   * @param {*} opt 
   */
  destroy(opt) {
    if (this.db) this.db.end();
    super.destroy()
  }

  /**
   * 
   * @returns 
   */
  async create_media_root() {
    let args = {
      owner_id: ID_NOBODY,
      filename: "",
      pid: "0",
      category: "root",
      ext: "root",
      mimetype: "special",
      filesize: 0,
      showResults: 1
    };
    let results = { isOutput: 1 };
    let root = await this.db.await_proc("mfs_create_node", args, {}, results);
    let sql = `UPDATE entity SET home_id='${root.id}' WHERE db_name='${this.entity.db_name}'`;
    await this.yp.await_query(sql);
    return root;
  }

  /**
   * 
   * @returns 
   */
  async create_vfs_root() {
    const { system_user, system_group } = sysEnv();
    const { home_dir, db_name } = this.entity;
    console.log(
      `----- CREATING ROOT for ${system_user}:${system_group} at ${home_dir}-------------\n`
    );
    this.db = new Mariadb({ name: db_name, user: process.env.USER });

    try {
      let dir = resolve(home_dir, "__storage__");
      mkdirSync(dir, { recursive: true });
      let cmd = `chown -R ${system_user}:${system_group} ${home_dir}`;
      let res = exec(cmd, { silent: true });
      if (res == null || res.code !== 0) {
        console.log(`FAILED TO RUN **${cmd}**`, res.stderr);
        return false;
      }
    } catch (e) {
      console.error(`Failed to create mfs storage ${home_dir}`);
      return false;
    }
    let r = await this.create_media_root();
    if (isEmpty(r) || !existsSync(r.home_dir)) {
      return false;
    }
    return true;
  }

  /**
   * Build the synchronous file-name search projection before this database is
   * advertised as a clean pool entity. The template intentionally starts in
   * BUILDING generation 0; media-root creation is the first authoritative
   * write, so publication must happen after that write succeeds.
   *
   * RUN IT ON THE BARE CONNECTION, NOT THROUGH `await_proc`.
   *
   * `mfs_search_projection_rebuild` is a top-level maintenance call: it reads
   * `@@in_transaction` and signals SEARCH_PROJECTION_REBUILD_ACTIVE_TRANSACTION
   * when a caller transaction is already open. Every mariadb_stub helper
   * (`await_proc`, `await_query`, `await_func`) issues `c.beginTransaction()`
   * before its statement, and START TRANSACTION on its own already sets
   * `in_transaction` — so calling this proc through the stub tripped the guard
   * on EVERY build. No entity was marked `pool_state='clean'` after that, both
   * pools drained to nothing pickupEntity could hand out, and `desk.create_hub`
   * answered CREATION_FAILED with "Pool private is empty. Considerer runing
   * factory" for every new workspace.
   *
   * The COMMIT is not ceremony: the previous helper (mfs_create_node, through
   * create_media_root) opened its transaction on this same connection and its
   * `c.commit()` is fire-and-forget, so close the connection's transaction
   * explicitly before handing it to the guard.
   *
   * @returns {Promise<boolean>}
   */
  async publish_search_projection() {
    const c = await this.db.getConnection();
    await c.query("COMMIT");
    let projection = await c.query("CALL mfs_search_projection_rebuild()");
    // A CALL's single SELECT comes back inside the multi-resultset envelope
    // ([rows, OkPacket]), so unwrap to the first row whatever the depth. An
    // empty resultset lands on undefined and fails the checks below.
    while (Array.isArray(projection)) projection = projection[0];
    const generation = Number(projection && projection.generation);
    if (
      !projection ||
      projection.state !== "READY" ||
      !Number.isSafeInteger(generation) ||
      generation < 1
    ) {
      console.error("FAILED TO PUBLISH FILE-NAME SEARCH PROJECTION");
      return false;
    }
    return true;
  }

  // ========================
  // create_entity
  // ========================
  async create_entity() {
    const type = this.get(Attr.type);
    console.log(`CREATING ENTITY IDENT WITH TYPE =${type}`);
    if (!["hub", "drumate"].includes(type)) {
      console.error(`${type} IS NOT UNSUPPORTED. Please, use [drumate|hub]`);
      return;
    }
    this.entity = await this.yp.await_proc("entity_create", type);
    let res = false;
    if (isEmpty(this.entity)) {
      await this.delete_entity("FAILED CREATE ENTITY");
    } else {
      res = await this.load_sql();
      if (!res) return;
      res = await this.create_vfs_root();
      if (!res) return;
      res = await this.publish_search_projection();
      if (!res) return;
    }
    const { id, db_name, home_id } = this.entity;
    let sql = `UPDATE entity SET settings=JSON_SET(settings, "$.pool_state", "clean") WHERE id='${id}'`;
    await this.yp.await_query(sql);
    console.log(`DONE id=${id}, db_name=${db_name}`);
    return res;
  }

  // ========================
  //
  // ========================
  async delete_entity(reason) {
    const ident = this.get(Attr.ident);
    if (isEmpty(this.entity)) {
      console.error(`NOTHING TO DELETE`);
      return;
    }
    if (this.entity.id) {
      console.error(
        `DELETING ENTITY ID = ${this.entity.id} due to [${reason}]`
      );
      let node = await this.yp.await_proc("entity_delete", this.entity.id);
      check_safety(node.home_dir);
      console.log(`CLEANING UP ENTITY home_dir = ${node.home_dir}`);
      rmSync(node.home_dir, { recursive: true, force: true });
      throw `roll back on ${ident}`;
    }
    this.destroy()
  }
  //db.query options, copy_file

  // ========================
  // load_sql
  // Creates a database.
  // ========================
  async load_sql() {
    const { db_host } = this.entity;
    const { db_name } = this.entity;
    const type = this.get(Attr.type);

    const script =
      this.get("script") || resolve(__dirname, "template", `${type}.sql`);
    console.log(`Loading ${script} INTO ${db_name}...`);
    const cmd = `${Constants.DB_CLI} ${db_name} < ${script}`;

    //console.log(`${cmd}`);
    const res = exec(cmd, { silent: true });
    if (res == null || res.code !== 0) {
      console.error(`FAILED TO RUN **${cmd}**`, res.stderr);
      return false;
    }

    return true;
  }
}

module.exports = __schema;
