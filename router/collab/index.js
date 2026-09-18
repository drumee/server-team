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

/**
 * Realtime collaboration transport for the BlockNote note (.dnote).
 *
 * Mounted on the SAME http server as the push protocol, under /ws/collab — a
 * path nginx already proxies to this app on every endpoint. `websocket` (the
 * push protocol) and `ws` (what Hocuspocus speaks) cannot both own the
 * server's `upgrade` event, so index.js takes the push library's own listener
 * off and dispatches by path instead.
 *
 * ACCESS MODEL — one rule, three outcomes:
 *
 *   privilege & 8 (write)  -> read/write, may edit the document live
 *   privilege & 2 (read)   -> connected READ-ONLY: receives every update, its
 *                             own updates are discarded by Hocuspocus
 *   neither                -> refused
 *
 * `privilege` is user_permission(uid, nid), which returns the member's
 * workspace-wide '*' grant for any non-hub node — so "may this user edit this
 * note" and "is this user a workspace member with edit or above" are the same
 * question, and view (3) / chat (7) members land in read-only by construction.
 *
 * CLIENT CONTRACT: the access key is ONE-TIME (socket_bind deletes it), so a
 * client that reconnects — and one will, every time this router drops it after
 * a privilege change — must fetch a fresh bootstrap.authn token for EVERY
 * attempt. Hand the provider a token callback, never a fixed string, or the
 * reconnect authenticates with a spent key and fails for good.
 *
 * NOT IMPLEMENTED HERE: persistence. Without onLoadDocument/onStoreDocument a
 * room lives in memory only and nothing is ever written to the .dnote file.
 * That is deliberate at this stage — a half-written persistence path is how
 * you destroy a file that has no version history.
 */

const { Server: Hocuspocus } = require("@hocuspocus/server");
const { WebSocketServer } = require("ws");
const { Logger, Cache, uniqueId } = require("@drumee/server-essentials");

/** Permission bits asked for (server-essentials lib/lex/permission.js) */
const READ = 2;
const WRITE = 8;

/**
 * The room name a client may ask for. It is NOT a free-form string: it must
 * name a (hub, node) pair, both of them ids, and access is then verified for
 * that pair. Two clients therefore share a room only if both proved access to
 * the same node.
 */
const ROOM = /^hub:([A-Za-z0-9]{1,16})\/note:([A-Za-z0-9]{1,16})$/;

/** Shape of the one-time access key issued by bootstrap.authn */
const OTAK = /^[A-Za-z0-9]{8,64}$/;

/** How often a live connection is re-checked against the database */
const REVALIDATE_TIMER = 60000;

/** Close code sent to a client whose access changed under it */
const ACCESS_CHANGED = 4403;

class __collab_router extends Logger {
  /**
   *
   * @param {*} opt
   */
  initialize(opt) {
    this.yp = opt.yp;
    this.endpointAddress = opt.endpointAddress;
    this.live = new Map();
    this.wss = new WebSocketServer({ noServer: true });
    this.hocuspocus = Hocuspocus.configure({
      name: this.endpointAddress,
      /** A socket that never authenticates is dropped, not held open */
      timeout: 15000,
      onAuthenticate: this.onAuthenticate.bind(this),
    });
    this.revalidateTimer = setInterval(
      this.revalidate.bind(this),
      REVALIDATE_TIMER
    );
  }

  /**
   * Entry point from the http server's upgrade dispatcher.
   *
   * Every connection carries an id of our own (`cid`), handed to Hocuspocus as
   * the default context so that onAuthenticate can find its way back to this
   * websocket — Hocuspocus's own socketId is not exposed at upgrade time, and
   * without the websocket there is no way to force-disconnect a revoked user.
   *
   * @param {*} request
   * @param {*} socket
   * @param {*} head
   */
  handleUpgrade(request, socket, head) {
    this.wss.handleUpgrade(request, socket, head, (client) => {
      const cid = uniqueId(22);
      const entry = { cid, client, bound: 0 };
      this.live.set(cid, entry);
      /**
       * The close event is the only teardown that covers every path — a
       * refused handshake, an idle timeout and a dropped network alike.
       */
      client.once("close", () => {
        this.live.delete(cid);
        if (entry.bound) this.release(cid);
      });
      this.hocuspocus.handleConnection(client, request, { cid });
    });
  }

  /**
   * Exchange the one-time access key for the user it was issued to. This is
   * the same handshake the push socket uses (bootstrap.authn -> otak ->
   * socket_bind), which is what keeps a cross-site page from opening a
   * collaboration socket on a logged-in browser's cookies.
   *
   * socket_bind registers the connection in yp.socket exactly like a push
   * socket, so whoever binds must release it with socket_free.
   *
   * @param {*} token
   * @param {*} cid
   * @returns {Promise<string|null>} uid, or null when the token buys nothing
   */
  async resolveUser(token, cid) {
    if (!token || !OTAK.test(token)) return null;
    const data = await this.yp.await_proc("socket_bind", {
      id: cid,
      sid: cid,
      token,
      endpoint: this.endpointAddress,
    });
    if (!data || data.failed || !data.uid) return null;
    /**
     * An unknown token does not fail: socket_bind falls back to the anonymous
     * user. Neither anonymous nor guest may hold a collaboration socket.
     */
    const anonymous = [
      Cache.getSysConf("nobody_id"),
      Cache.getSysConf("guest_id"),
    ];
    if (anonymous.includes(data.uid)) return null;
    return data.uid;
  }

  /**
   * user_permission(uid, nid), resolved in the hub's own database.
   *
   * hub_id and nid are matched against ROOM before they get here and uid comes
   * back from the database, so none of them can carry anything but
   * [A-Za-z0-9] into forward_proc's dynamic SQL.
   *
   * @param {*} hub_id
   * @param {*} nid
   * @param {*} uid
   * @returns {Promise<number>}
   */
  async privilegeOf(hub_id, nid, uid) {
    if (!/^[A-Za-z0-9]{1,16}$/.test(uid)) return 0;
    try {
      const rows = await this.yp.await_proc(
        "forward_proc",
        hub_id,
        "mfs_access_node",
        `'${uid}','${nid}'`
      );
      const row = Array.isArray(rows) ? rows[0] : rows;
      return parseInt((row || {}).privilege, 10) || 0;
    } catch (e) {
      this.warn("[collab] access check failed", e && e.message);
      return 0;
    }
  }

  /**
   * Hocuspocus calls this once per document, with the token the client sent in
   * its first message. Throwing refuses the document; setting
   * connection.readOnly lets the client watch a document it may not write.
   *
   * @param {*} payload
   */
  async onAuthenticate(payload) {
    const { documentName, token, connection, context } = payload;
    const cid = (context || {}).cid;
    const entry = this.live.get(cid);
    if (!entry) throw new Error("UNKNOWN_CONNECTION");

    const room = ROOM.exec(documentName || "");
    if (!room) {
      this.warn("[collab] refused malformed room", documentName);
      this.refuse(entry, "INVALID_ROOM");
      throw new Error("INVALID_ROOM");
    }
    const [, hub_id, nid] = room;

    const uid = await this.resolveUser(token, cid);
    if (!uid) {
      this.debug("[collab] refused: token buys no user");
      this.refuse(entry, "UNAUTHORIZED");
      throw new Error("UNAUTHORIZED");
    }
    entry.bound = 1;

    const privilege = await this.privilegeOf(hub_id, nid, uid);
    if (!(privilege & READ)) {
      this.debug(`[collab] refused ${uid} on ${nid}: privilege ${privilege}`);
      this.refuse(entry, "FORBIDDEN");
      throw new Error("FORBIDDEN");
    }

    connection.readOnly = !(privilege & WRITE);
    Object.assign(entry, {
      uid,
      hub_id,
      nid,
      privilege,
      readOnly: connection.readOnly,
    });
    this.debug(
      `[collab] ${uid} joined ${hub_id}/${nid} privilege=${privilege} readOnly=${connection.readOnly}`
    );
    return { uid, hub_id, nid, privilege };
  }

  /**
   * Let the refusal reach the client, then take the socket away rather than
   * leaving a rejected connection sitting there until it times out.
   *
   * @param {*} entry
   * @param {*} reason
   */
  refuse(entry, reason) {
    setTimeout(() => {
      try {
        entry.client.close(ACCESS_CHANGED, reason);
      } catch (e) {
        this.warn("[collab] failed to close refused socket", e && e.message);
      }
    }, 100);
  }

  /**
   * Undo socket_bind. Best effort: a failure here must not break the close.
   *
   * @param {*} cid
   */
  async release(cid) {
    try {
      await this.yp.call_proc("socket_free", cid);
    } catch (e) {
      this.warn("[collab] socket_free failed", e && e.message);
    }
  }

  /**
   * A socket authenticates ONCE. Revoking somebody's access, or demoting them
   * from edit to view, leaves them holding a connection they should no longer
   * have — so every live connection is re-checked on a timer and dropped as
   * soon as its privilege changes at all. The client reconnects and is
   * re-evaluated, which is also how a promotion (view -> edit) takes effect.
   */
  async revalidate() {
    for (const [cid, entry] of this.live) {
      if (!entry.uid) continue;
      const privilege = await this.privilegeOf(
        entry.hub_id,
        entry.nid,
        entry.uid
      );
      const readOnly = !(privilege & WRITE);
      if (privilege & READ && readOnly === entry.readOnly) continue;
      this.notice(
        `[collab] dropping ${entry.uid} on ${entry.nid}: privilege ${entry.privilege} -> ${privilege}`
      );
      try {
        entry.client.close(ACCESS_CHANGED, "ACCESS_CHANGED");
      } catch (e) {
        this.warn("[collab] failed to close revoked socket", e && e.message);
      }
    }
  }
}

const __singleton = function (opt) {
  return {
    Collab: new __collab_router(opt),
  };
};

module.exports = __singleton;
