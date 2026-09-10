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

/**
 * Extract an uploaded archive into the workspace it already lives in.
 *
 * Runs detached, spawned by media.unzip, for the reason the whole feature
 * exists: a zip in Drumee is almost always a zipped FOLDER, so the work is
 * "decompress a few hundred MB and then create a few thousand media rows",
 * which is nobody's idea of a request/response cycle.
 *
 * The node-creation half deliberately mirrors offline/media/serverimport.js —
 * same node shape, same `mfs_import` bulk insert, same `media.new` push — so
 * files that arrive by unzip are indistinguishable from files that arrive by
 * any other import, and there is one shape to maintain rather than two.
 *
 * SAFETY IS SPLIT ACROSS TWO PLACES ON PURPOSE. media.unzip refuses hostile
 * archives BEFORE spawning us (traversal paths, encryption, entry-count and
 * size ceilings, quota) because that is where a user can be told why. What is
 * left here is what only the extracted bytes can tell us, and it is enforced
 * by construction: we walk the staging directory with lstat and import only
 * regular files and directories, so a symlink restored out of an archive is
 * skipped rather than followed, and anything 7z somehow wrote outside the
 * staging directory is simply never seen.
 */

const Minimist = require("minimist");
const Jsonfile = require("jsonfile");
const { exit } = require("process");
const { join, parse } = require("path");
const {
  copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync,
  renameSync, rmSync,
} = require("fs");
const {
  Attr, Cache, Mariadb, Offline, RedisStore, getFileinfo, sysEnv, toArray,
  uniqueId,
} = require("@drumee/server-essentials");

const { extract, MAX_FILENAME, MAX_FILE_PATH } = require("../../service/lib/archive");

const FOLDER = "folder";
/** Folders are booked at the same nominal size serverimport books them at. */
const FOLDER_SIZE = 1024;

class __offline_media_unzip extends Offline {
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
    this.uid = data.uid;
    this.nid = data.nid;
    this.pid = data.pid;
    this.recipient_id = data.recipient_id;
    this.socket_id = data.socket_id;
    this.transactionid = data.transactionid;
    this.service = "media.unzip";
    this.nodes = [];
    this.staging = null;

    const res = new RedisStore();
    res.init().then(() => {
      this.run()
        .catch((e) => {
          this.warn("Unzip failed:", e);
          return this.fail("UNZIP_FAILED");
        })
        .finally(() => {
          this.cleanup();
          exit(0);
        });
    });
  }

  /**
   * Open a connection whose default schema IS the hub's, and run every
   * hub-scoped procedure on it.
   *
   * NOT yp.forward_proc, which is how serverimport reaches hub procedures.
   * forward_proc takes its arguments as ONE STRING and splices it into
   * `CONCAT("CALL ", db, ".", fn, "(", _arg, ")")` before PREPARE — the
   * argument list is SQL text, not parameters. Callers therefore build it as
   * `'${value}'`, which is safe only while values are ids we generated. This
   * worker's values are FILENAMES OUT OF AN UPLOADED ARCHIVE: one apostrophe
   * in a filename breaks the statement, and a filename is an attacker-chosen
   * string, so the break is an injection rather than a syntax error. Anyone
   * who can upload a zip can choose those names.
   *
   * A direct connection binds with `?` (Mariadb#_run builds `call fn(?, ?)`),
   * so names are values again. `mfs_access_node` behaves identically either
   * way: DATABASE() inside a routine is the routine's own schema, which is the
   * hub schema whether it is reached by `CALL hubdb.proc()` or by a connection
   * already defaulted to hubdb. Same pattern as offline/workers/expiryWorker.
   */
  async openHub() {
    const rows = await this.yp.await_run(
      "SELECT db_name FROM entity WHERE id = ?", [this.recipient_id]);
    const row = toArray(rows)[0];
    const db_name = row && row.db_name;
    if (!db_name) return null;
    this.hub = new Mariadb({ name: db_name });
    return this.hub;
  }

  /**
   * Run a hub procedure with real parameter binding.
   */
  async hubProc(name, ...args) {
    return this.hub.await_proc(name, ...args);
  }

  /**
   *
   */
  async send(model, message) {
    if (!this.socket_id) return;
    this._payload.model = { ...this._payload.model, ...model };
    if (message) this._payload.options.message = message;
    await RedisStore.sendData(this._payload, this.socket_id);
  }

  /**
   * Terminal failure. The client is holding a progress card, so it has to be
   * told; leaving it to time out is the behaviour this feature replaced.
   */
  async fail(reason) {
    this.warn(`unzip aborted: ${reason}`);
    if (!this._payload) return;
    await this.send({
      phase: "failed",
      error: reason,
      progress: 0,
      transactionid: this.transactionid,
    }, reason);
  }

  /**
   * The staging tree is ours alone and always disposable — on success its
   * files have been moved out, on failure it is a half-extracted archive.
   */
  cleanup() {
    if (!this.staging) return;
    try {
      rmSync(this.staging, { recursive: true, force: true });
    } catch (e) {
      this.warn("Failed to remove staging dir", this.staging, e);
    }
  }

  /**
   *
   */
  async run() {
    new Cache();
    await Cache.load();

    this._payload = this.payload(
      { phase: "prepare", progress: 0, transactionid: this.transactionid },
      {
        service: this.service,
        tag: this.service,
        message: "PREPARATION",
        transactionid: this.transactionid,
      },
    );

    if (!(await this.openHub())) return this.fail("NODE_NOT_FOUND");

    const archive = await this.hubProc("mfs_access_node", this.uid, this.nid);
    const dest = await this.hubProc("mfs_access_node", this.uid, this.pid);
    if (!archive || !archive.id || !dest || !dest.id) {
      return this.fail("NODE_NOT_FOUND");
    }

    const archivePath = join(
      archive.home_dir, archive.id, `orig.${archive.extension}`);
    if (!existsSync(archivePath)) {
      return this.fail("NODE_NOT_FOUND");
    }

    // Staging lives under the platform tmp dir, one directory per run, created
    // with mkdtemp so two unzips of the same archive cannot land on each other.
    const { tmp_dir } = sysEnv();
    mkdirSync(tmp_dir, { recursive: true });
    this.staging = mkdtempSync(join(tmp_dir, "unzip-"));

    await this.send({ phase: "extract", progress: 5 }, "PROGRES");
    const x = await extract(archivePath, this.staging);
    if (!x.ok) {
      this.warn(`7z exited ${x.code}: ${x.stderr}`);
      return this.fail("ARCHIVE_UNREADABLE");
    }

    const root = this.importRoot(this.staging);
    if (!root) return this.fail("ARCHIVE_EMPTY");

    // One archive in, exactly one folder out, named after the archive. The
    // name is uniquified against the destination the same way an upload's
    // would be, so unzipping twice gives "Report" and "Report(1)" rather than
    // an error or a silent merge into the first one.
    const baseName = this.safeName(archive.filename || "archive");
    const unique = await this.hubProc(
      "mfs_unique_filename", dest.id, baseName, "");
    const folderName = (unique && unique.user_filename) || baseName;

    const destParentPath = join(dest.parent_path || "", dest.filename || "");
    const rootNode = {
      id: uniqueId(8, "hex"),
      parent_id: dest.id,
      user_filename: folderName,
      extension: "",
      mimetype: "",
      category: FOLDER,
      filesize: FOLDER_SIZE,
      lvl: 0,
      parent_path: destParentPath,
      file_path: join(destParentPath, folderName),
      source: "",
      destination: "",
      destination_file: "",
    };
    this.nodes.push(rootNode);

    await this.send({ phase: "scan", progress: 10 }, "PROGRES");
    await this.walk(root, rootNode, dest.home_dir, 1);

    if (this.nodes.length <= 1) return this.fail("ARCHIVE_EMPTY");

    await this.materialize();
    await this.commit();
  }

  /**
   * Where in the staging tree the import should start.
   *
   * A zipped folder — the overwhelmingly common case here — extracts to a
   * single top-level directory, and importing the staging root itself would
   * produce "Report/Report/…". When the archive holds exactly one directory
   * and nothing else, that directory's CONTENTS are the import, which makes
   * the rule the user actually sees a simple one: unzipping always yields one
   * new folder named after the archive. Loose files at the top are imported
   * as they are.
   */
  importRoot(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return null;
    }
    if (!entries.length) return null;
    if (entries.length === 1 && entries[0].isDirectory()) {
      return join(dir, entries[0].name);
    }
    return dir;
  }

  /**
   * Trim a name to what `media`.`user_filename` can hold, and strip the path
   * separators an archive entry may carry into what must stay a single name.
   */
  safeName(name) {
    let s = String(name == null ? "" : name).replace(/[\/\\]/g, "-").trim();
    if (!s || s === "." || s === "..") s = "file";
    if (s.length > MAX_FILENAME) s = s.slice(0, MAX_FILENAME);
    return s;
  }

  /**
   * Make `name`.`ext` unique among the siblings already collected under
   * `parent`, appending (1), (2)… the way mfs_unique_filename does.
   *
   * THIS IS NOT BELT-AND-BRACES, it is required. `media` carries
   * UNIQUE KEY (parent_id, user_filename, extension) and UNIQUE KEY (file_path)
   * under a *_ci collation, so MySQL considers "README.md" and "readme.md"
   * THE SAME ROW while ext4 is perfectly happy to hold both — and an archive
   * built on Linux routinely does. Without this the two rows collide inside
   * mfs_import's insert loop, which aborts partway and leaves half a tree.
   * Truncation above can manufacture collisions too, which is why this runs
   * after it rather than before.
   */
  uniqueSibling(seen, parentId, name, ext) {
    // `/` is the separator because safeName() has already stripped it out of
    // every name, so no two different (name, ext) pairs can collide on it.
    const key = (n) => `${parentId}/${n.toLowerCase()}/${ext.toLowerCase()}`;
    if (!seen.has(key(name))) {
      seen.add(key(name));
      return name;
    }
    const room = MAX_FILENAME - 8;
    const stem = name.length > room ? name.slice(0, room) : name;
    for (let i = 1; i < 10000; i++) {
      const candidate = `${stem}(${i})`;
      if (!seen.has(key(candidate))) {
        seen.add(key(candidate));
        return candidate;
      }
    }
    const fallback = `${stem}-${uniqueId(4, "hex")}`;
    seen.add(key(fallback));
    return fallback;
  }

  /**
   * Depth-first walk of the extracted tree, collecting nodes.
   *
   * lstat, never stat: a symlink restored out of an archive must be SKIPPED,
   * not followed. Following one would copy whatever it aims at into the
   * workspace — the classic way an archive reads /etc out of a host — and
   * would also let a link loop walk forever. Sockets, fifos and devices fall
   * out of the same test.
   */
  async walk(dir, parent, homeDir, lvl) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      this.warn("Unreadable directory, skipped", dir, e);
      return;
    }
    const seen = new Set();

    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      let st;
      try {
        st = lstatSync(absolute);
      } catch (e) {
        continue;
      }
      const isDir = st.isDirectory();
      if (!isDir && !st.isFile()) {
        this.warn(`Skipping non-regular archive entry: ${entry.name}`);
        continue;
      }

      const parsed = parse(entry.name);
      let info = { category: null, mimetype: "", extension: "" };
      if (!isDir) {
        try {
          info = await getFileinfo(absolute, entry.name);
        } catch (e) {
          this.warn("Failed to identify file, importing as-is", absolute, e);
        }
      }

      const extension = isDir
        ? ""
        : String(info.extension || parsed.ext.replace(/^\./, "") || "").toLowerCase();
      let name = this.safeName(isDir ? entry.name : (info.filename || parsed.name));
      name = this.uniqueSibling(seen, parent.id, name, extension);

      const leaf = extension ? `${name}.${extension}` : name;
      const filePath = join(parent.file_path, leaf);
      if (filePath.length > MAX_FILE_PATH) {
        // Deeper than the column can record. Skipping the branch is the only
        // honest option: a truncated file_path would either collide with a
        // sibling or point somewhere that is not where the file is.
        this.warn(`Skipping over-long path (${filePath.length} chars): ${filePath}`);
        continue;
      }

      const node = {
        id: uniqueId(8, "hex"),
        parent_id: parent.id,
        user_filename: name,
        extension,
        mimetype: isDir ? "" : (info.mimetype || ""),
        category: isDir ? FOLDER : (info.category || "other"),
        filesize: isDir ? FOLDER_SIZE : st.size,
        lvl,
        parent_path: parent.file_path,
        file_path: filePath,
        source: isDir ? "" : absolute,
        destination: isDir ? "" : join(homeDir, ""),
        destination_file: "",
      };
      if (!isDir) {
        node.destination = join(homeDir, node.id);
        node.destination_file = join(homeDir, node.id, `orig.${extension}`);
      }
      this.nodes.push(node);

      if (isDir) {
        await this.walk(absolute, node, homeDir, lvl + 1);
      }
    }
  }

  /**
   * Put the bytes where the MFS expects them: <home_dir>/<node id>/orig.<ext>.
   *
   * Moved rather than copied where the filesystem allows it — staging is
   * disposable, and an archive of any size would otherwise be written to disk
   * twice. tmp_dir and the storage tree are not guaranteed to share a mount,
   * so EXDEV falls back to a copy.
   */
  async materialize() {
    const files = this.nodes.filter((n) => n.category !== FOLDER);
    const total = files.length || 1;
    let done = 0;
    let lastReported = 0;

    for (const node of files) {
      try {
        mkdirSync(node.destination, { recursive: true });
        try {
          renameSync(node.source, node.destination_file);
        } catch (e) {
          if (e && e.code === "EXDEV") {
            copyFileSync(node.source, node.destination_file);
          } else {
            throw e;
          }
        }
        // The office preview pipeline expects this sidecar next to non-pdf
        // documents; serverimport writes it for the same reason.
        if (node.category === Attr.document && node.extension !== Attr.pdf) {
          Jsonfile.writeFileSync(join(node.destination, "info.json"), {});
        }
      } catch (e) {
        this.warn("Failed to store extracted file", node.file_path, e);
        node.failed = 1;
      }
      done++;
      // 10% -> 85% across the copy. Throttled to whole percent: a 20k-entry
      // archive would otherwise put 20k messages on the socket.
      const progress = 10 + Math.floor((done / total) * 75);
      if (progress > lastReported) {
        lastReported = progress;
        await this.send({ phase: "progres", progress }, "PROGRES");
      }
    }

    // A file whose bytes never landed must not get a row: the tile would open
    // onto nothing. Its children, if it somehow had any, go with it.
    const failed = new Set(this.nodes.filter((n) => n.failed).map((n) => n.id));
    if (failed.size) {
      let changed = true;
      while (changed) {
        changed = false;
        for (const n of this.nodes) {
          if (!failed.has(n.id) && failed.has(n.parent_id)) {
            failed.add(n.id);
            changed = true;
          }
        }
      }
      this.nodes = this.nodes.filter((n) => !failed.has(n.id));
    }
  }

  /**
   * Write the rows, then tell every session on the hub that a folder appeared.
   */
  async commit() {
    await this.hubProc("mfs_import", this.nodes, this.uid);

    await this.send({ phase: "progres", progress: 90 }, "PROGRES");

    let recipients = await this.yp.await_proc("entity_sockets", this.recipient_id);
    recipients = toArray(recipients);

    const keys = { pid: Attr.nid, vhost: "vhost" };
    for (const node of this.nodes) {
      if (node.lvl !== 0) continue;
      const attr = await this.hubProc("mfs_access_node", this.uid, node.id);
      if (!attr) continue;
      await RedisStore.sendData(
        this.payload(attr, { keys, service: "media.new" }), recipients);
    }
    await RedisStore.sendData(
      this.payload({}, { service: "notification.resync" }), recipients);

    await this.send({
      phase: "completed",
      progress: 100,
      files: this.nodes.filter((n) => n.category !== FOLDER).length,
      folders: this.nodes.filter((n) => n.category === FOLDER).length,
      transactionid: this.transactionid,
    }, "COMPLETED");
  }
}

new __offline_media_unzip();
