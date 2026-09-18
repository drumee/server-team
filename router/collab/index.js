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
 * PERSISTENCE — read the next paragraph before changing any of it.
 *
 * This server NEVER writes the user's .dnote file. Saving a note is
 * media.save's job and nothing else's: that path snapshots a version, updates
 * filesize and yp.disk_usage, and writes the changelog row the activity feed
 * renders. A second implementation of the most destructive operation in the
 * product, living in a different process, would drift from it — and these
 * files have no version history to recover from once it does.
 *
 * What is persisted here is the Yjs state, and only that, as an OPAQUE blob in
 * the node's own storage directory (`<mfs_root>/<nid>/collab.ydoc`). The
 * server therefore parses no user content and writes no user file; it keeps a
 * room alive across a restart and across the last client leaving.
 *
 * Which leaves one question a collaborative editor has to answer explicitly:
 * WHO calls media.save, when every connected client holds the whole document?
 * All of them would race on one file. So the server elects exactly one
 * read-write connection as the SAVER and tells each connection its role over a
 * stateless message; a read-only connection is never the saver, and when the
 * saver leaves the next one is promoted. The client half of that contract is
 * not written yet — the editor is untouched — so today this elects and
 * announces, and nothing acts on it.
 */

const { Server: Hocuspocus } = require("@hocuspocus/server");
const { WebSocketServer } = require("ws");
const Y = require("yjs");
const { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } = require("fs");
const { resolve } = require("path");
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

/** The Yjs state of a room, beside the note it belongs to */
const STATE_FILE = "collab.ydoc";

/** Stateless message naming the one connection that may call media.save */
const ROLE_MESSAGE = "drumee.collab.role";

class __collab_router extends Logger {
  /**
   *
   * @param {*} opt
   */
  initialize(opt) {
    this.yp = opt.yp;
    this.endpointAddress = opt.endpointAddress;
    this.live = new Map();
    this.rooms = new Map();
    this.wss = new WebSocketServer({ noServer: true });
    this.hocuspocus = Hocuspocus.configure({
      name: this.endpointAddress,
      /** A socket that never authenticates is dropped, not held open */
      timeout: 15000,
      onAuthenticate: this.onAuthenticate.bind(this),
      onLoadDocument: this.onLoadDocument.bind(this),
      onStoreDocument: this.onStoreDocument.bind(this),
      connected: this.onConnected.bind(this),
      onDisconnect: this.onDisconnected.bind(this),
      afterUnloadDocument: this.onUnloadDocument.bind(this),
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
   * mfs_access_node resolved in the hub's own database. Its `privilege` is
   * user_permission(uid, nid); `mfs_root` is where the node's files live.
   *
   * hub_id and nid are matched against ROOM before they get here and uid comes
   * back from the database, so none of them can carry anything but
   * [A-Za-z0-9] into forward_proc's dynamic SQL.
   *
   * @param {*} hub_id
   * @param {*} nid
   * @param {*} uid
   * @returns {Promise<{privilege: number, mfs_root: string|null}>}
   */
  async accessNode(hub_id, nid, uid) {
    if (!/^[A-Za-z0-9]{1,16}$/.test(uid)) return { privilege: 0, mfs_root: null };
    try {
      const rows = await this.yp.await_proc(
        "forward_proc",
        hub_id,
        "mfs_access_node",
        `'${uid}','${nid}'`
      );
      const row = (Array.isArray(rows) ? rows[0] : rows) || {};
      return {
        privilege: parseInt(row.privilege, 10) || 0,
        mfs_root: row.mfs_root || null,
      };
    } catch (e) {
      this.warn("[collab] access check failed", e && e.message);
      return { privilege: 0, mfs_root: null };
    }
  }

  /**
   * user_permission alone, for the revalidation pass.
   *
   * @param {*} hub_id
   * @param {*} nid
   * @param {*} uid
   * @returns {Promise<number>}
   */
  async privilegeOf(hub_id, nid, uid) {
    const { privilege } = await this.accessNode(hub_id, nid, uid);
    return privilege;
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

    const { privilege, mfs_root } = await this.accessNode(hub_id, nid, uid);
    if (!(privilege & READ)) {
      this.debug(`[collab] refused ${uid} on ${nid}: privilege ${privilege}`);
      this.refuse(entry, "FORBIDDEN");
      throw new Error("FORBIDDEN");
    }
    /**
     * Where this room's Yjs state is kept. Taken from the database rather than
     * built from the room name, so a room can only ever reach the directory
     * the node it names actually owns.
     */
    if (!this.rooms.has(documentName)) {
      this.rooms.set(documentName, {
        hub_id,
        nid,
        dir: mfs_root ? resolve(mfs_root, nid) : null,
      });
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
   * The path this room's Yjs state is kept at, or null when the node did not
   * tell us where it lives.
   *
   * @param {*} documentName
   * @returns {string|null}
   */
  statePath(documentName) {
    const room = this.rooms.get(documentName);
    if (!room || !room.dir) return null;
    return resolve(room.dir, STATE_FILE);
  }

  /**
   * Bring a room back from the last state we wrote. An absent file is the
   * normal case for a note nobody has collaborated on yet: the room starts
   * empty and the elected saver seeds it from the .dnote it already loaded.
   *
   * A state file we cannot read is NOT fatal and is NOT deleted — the room
   * simply starts empty. Deleting it, or refusing the room over it, would turn
   * one bad read into lost work.
   *
   * @param {*} payload
   */
  async onLoadDocument(payload) {
    const { documentName, document } = payload;
    const path = this.statePath(documentName);
    if (!path || !existsSync(path)) return;
    try {
      const state = readFileSync(path);
      if (!state || !state.length) return;
      Y.applyUpdate(document, new Uint8Array(state));
      this.debug(`[collab] loaded ${state.length} bytes of state for ${documentName}`);
    } catch (e) {
      this.warn(`[collab] could not load state for ${documentName}`, e && e.message);
    }
  }

  /**
   * Keep the Yjs state beside the note. Written to a temporary file in the
   * same directory and renamed over the old one, so a crash mid-write leaves
   * the previous state intact rather than a truncated file.
   *
   * This writes ONLY our own state file. The note itself is media.save's to
   * write — see the note at the top of this file.
   *
   * @param {*} payload
   */
  async onStoreDocument(payload) {
    const { documentName, document } = payload;
    const path = this.statePath(documentName);
    if (!path) return;
    const tmp = `${path}.${uniqueId(8)}.tmp`;
    try {
      const room = this.rooms.get(documentName);
      if (!existsSync(room.dir)) mkdirSync(room.dir, { recursive: true });
      writeFileSync(tmp, Buffer.from(Y.encodeStateAsUpdate(document)));
      renameSync(tmp, path);
    } catch (e) {
      this.warn(`[collab] could not store state for ${documentName}`, e && e.message);
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch (err) {
        /** nothing further to try */
      }
    }
  }

  /**
   * Name exactly one connection as the saver, and tell every connection on the
   * document where it stands. Read-only connections are never eligible, and
   * the first eligible one wins so that the choice does not move while it is
   * still there.
   *
   * @param {*} documentName
   */
  elect(documentName) {
    const doc = this.hocuspocus.documents.get(documentName);
    if (!doc) return;
    const connections = doc.getConnections();
    const saver = connections.find((c) => !c.readOnly);
    const cid = saver && saver.context ? saver.context.cid : null;
    for (const connection of connections) {
      const mine = connection.context && connection.context.cid;
      try {
        connection.sendStateless(
          JSON.stringify({
            type: ROLE_MESSAGE,
            saver: Boolean(cid) && mine === cid,
            readOnly: Boolean(connection.readOnly),
          })
        );
      } catch (e) {
        this.warn("[collab] could not announce role", e && e.message);
      }
    }
    if (cid) this.debug(`[collab] ${documentName} saver is ${cid}`);
  }

  /**
   * @param {*} payload
   */
  async onConnected(payload) {
    this.elect(payload.documentName);
  }

  /**
   * The room is gone from memory; its state has already been written by
   * onStoreDocument. Drop what we remembered about it so a long-running
   * process does not accumulate one entry per note ever opened.
   *
   * @param {*} payload
   */
  async onUnloadDocument(payload) {
    this.rooms.delete(payload.documentName);
  }

  /**
   * Re-elect once the leaving connection is off the document, so the saver is
   * never a connection that has already gone.
   *
   * @param {*} payload
   */
  async onDisconnected(payload) {
    setImmediate(() => this.elect(payload.documentName));
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
