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
 * The path columns of `media`, in the exact shape the SQL side writes them
 * (parent_path() / filepath()): `file_path` is absolute ("/", "/a/b.pdf") and
 * `parent_path` is the parent's location WITH a trailing slash ("/", "/a/").
 *
 * Workers that bulk-insert through mfs_import build these in JS, and
 * path.join is the wrong tool for it: join("", "") is ".", and it never adds
 * the leading or trailing slash. Rows written that way are invisible to every
 * exact `file_path = ?` lookup and to node_id_from_path, which sends uploads
 * into such a folder to the hub root instead.
 */
const { posix } = require("path");

/**
 * Normalise a folder location to "/" or "/a/b". Also repairs the relative
 * form older imports stored ("." or "a/b"), which is always relative to the
 * hub root.
 */
function folderPath(p) {
  const parts = String(p == null ? "" : p)
    .split("/")
    .filter((s) => s !== "" && s !== ".");
  return `/${parts.join("/")}`;
}

/**
 * Path columns of an entry named `leaf` inside the folder at `dir`.
 */
function childPaths(dir, leaf) {
  const base = folderPath(dir);
  return {
    parent_path: base === "/" ? "/" : `${base}/`,
    file_path: posix.join(base, leaf),
  };
}

/**
 * Location of the destination node returned by mfs_access_node. `ownpath` is
 * its raw file_path; older callers only had parent_path + filename.
 */
function nodeFolder(node) {
  if (!node) return "/";
  if (node.ownpath != null && node.ownpath !== "") return folderPath(node.ownpath);
  return folderPath(posix.join(node.parent_path || "", node.filename || ""));
}

module.exports = { folderPath, childPaths, nodeFolder };
