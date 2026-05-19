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
const { Attr, Constants } = require("@drumee/server-essentials");
const {
  PID,
  RECIPIENT_ID,
} = Constants;

const { Mfs } = require("@drumee/server-core");

const { isString } = require("lodash");
const { resolve } = require("path");
const SPAWN_OPT = { detached: true, stdio: ["ignore", "ignore", "ignore"] };
const Spawn = require("child_process").spawn;


class mfs extends Mfs {
  // ========================
  // initialize
  // ========================
  constructor(...args) {
    super(...args);
    this.server_export = this.server_export.bind(this);
    this.server_import = this.server_import.bind(this);
  }

  // ========================
  //
  // ========================
  async server_import() {
    const self = this;
    async function f() {
      let socket_id = self.input.need(Attr.socket_id);
      let source_list = self.input.get("source_list") || ["/data/sample-1/"];
      let transactionid = self.input.need("transactionid");
      let pid = self.input.use(PID);
      if (pid == null) {
        pid = "0";
      }
      let recipient_id = self.input.use(RECIPIENT_ID) || self.hub.get(Attr.id);
      let args = {
        pid,
        recipient_id,
        source_list,
        uid: self.uid,
        socket_id,
        transactionid,
      };
      let cmd = resolve(
        process.env.server_home,
        "offline",
        "media",
        "serverimport.js"
      );
      console.log(`gopi cmd=${JSON.stringify(args)}`);
      let child = Spawn(cmd, [JSON.stringify(args)], SPAWN_OPT);
      child.unref();
      return args;
    }
    f()
      .then(function (r) {
        self.output.data(r);
      })
      .catch(self.fallback);
  }
  async server_export() {
    const self = this;
    async function f() {
      let res = "fopi";
      let socket_id = self.input.need(Attr.socket_id);
      let dest_path = self.input.need("destination");
      let transactionid = self.input.need("transactionid");
      self.heap.nodes = self.heap.nodes || self.source_nodes(); //JSON.parse(this.src.args);
      self.heap.srcgrantlst = [];
      let granted = [];
      let node;
      for (var hub of self.heap.nodes) {
        if (isString(hub.nid)) {
          node = { nid: hub.nid, hub_id: hub.hub_id };
          granted.push(node);
        } else {
          for (let id of hub.nid) {
            node = { nid: id, hub_id: hub.hub_id };
            granted.push(node);
          }
        }
      }

      let args = {
        granted,
        dest_path,
        uid: self.uid,
        socket_id,
        transactionid,
      };
      let cmd = resolve(
        process.env.server_home,
        "offline",
        "media",
        "serverexport.js"
      );
      console.log(`gopi cmd=${JSON.stringify(args)}`);
      let child = Spawn(cmd, [JSON.stringify(args)], SPAWN_OPT);
      child.unref();
      return args;
    }
    f()
      .then(function (r) {
        self.output.data(r);
      })
      .catch(self.fallback);
  }

  /**
   * Get comprehensive node/folder information
   * 
   * Input:
   * - hub_id
   * - nid
   * 
   * Output:
   * - file_count: Total files (recursive)
   * - members: Array of users with permission
   * - total_size: Total bytes used
   * - ctime: Creation timestamp (upload_time)
   * - mtime: Most recent modification timestamp (publish_time)
   */
  async node_summary() {
    const hubId = this.input.need(Attr.hub_id);
    const nid = this.input.need(Attr.nid);
    
    this.debug(`[MFS] Getting node info for hub: ${hubId}, nid: ${nid}`);
    
    const result = await this.yp.await_proc(
      'forward_proc',
      hubId,
      'mfs_node_summary',
      `'${hubId}', '${nid}'`
    );
    
    const { toArray } = require('@drumee/server-essentials').utils;
    const data = toArray(result)[0];
    
    if (data) {
      if (typeof data.members === 'string') {
        try {
          data.members = JSON.parse(data.members);
        } catch (e) {
          this.warn('[MFS] Failed to parse members JSON:', e.message);
          data.members = [];
        }
      }
      
      this.output.data(data);
    } else {
      this.output.data({
        status: 'error',
        message: 'Node not found'
      });
    }
  }
}

module.exports = mfs;
