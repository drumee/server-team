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
 * Where each node of a download goes INSIDE the zip.
 *
 * The archive used to be laid out by the stored `media.file_path`
 * (makeArchiveList: dest = dest_dir + filepath). That column is denormalised
 * and drifts, and every drift went straight into the user's zip. Measured on
 * stage 2026-10-09, selecting folders "rrr" and "888" (hub ff7469e5ff7469ea):
 *
 *   888                  folder    /888.                  → a "888." entry,
 *                                                            shown as a 2nd "888"
 *   888/999              folder    /888/999.
 *   888/FNSFMB412….docx  document  /test/888/FNSF….docx  → an unselected "test"
 *   888/Will do….txt     text      /888/Will do….txt
 *
 * — trailing dots from a folder path built as name + "." + empty extension,
 * and a child whose path was never rewritten when its folder moved out of
 * "test". So the layout is rebuilt here from what cannot drift: the tree
 * itself (nid → pid) and each node's own name and extension, rooted at the
 * selected item. Selecting "rrr" and "888" now yields exactly rrr/… and
 * 888/…, wherever they sit in their workspace.
 */
const { posix } = require("path");

const CONTAINER = /^(hub|folder|root)$/i;

/**
 * A node's entry name: its filename (markup, slashes and trailing dots or
 * spaces removed — Windows drops a trailing dot, which is how "888." surfaced
 * as a second "888"), plus ".ext" for a file.
 */
function entryName(row) {
  let name = String(row.filename == null ? "" : row.filename)
    .replace(/<[^>]*>/g, "")
    .replace(/[\\/]+/g, "-")
    .replace(/^\s+/, "")
    .replace(/[\s.]+$/, "");
  if (!name) name = String(row.nid || "untitled");
  const ext = String(row.ext == null ? "" : row.ext).trim().replace(/^\.+/, "");
  if (CONTAINER.test(row.filetype || "") || !ext || ext === "null") return name;
  return `${name}.${ext}`;
}

/**
 * `name`, or "name (2)", "name (3)"… so two selected items never share a
 * top-level entry (case-insensitive, as most file systems compare). The
 * suffix goes before a file's extension.
 */
function uniqueName(name, taken, isFile) {
  const dot = isFile ? name.lastIndexOf(".") : -1;
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let candidate = name;
  for (let i = 2; taken.has(candidate.toLowerCase()); i++) {
    candidate = `${base} (${i})${ext}`;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Rewrite `filepath` on one selected node's mfs_manifest rows (show_nodes:1
 * shape: nid, pid, filename, ext, filetype, home_id, filepath…) so it is the
 * entry's path inside the zip: "<selected item>/<sub/path>".
 *
 * @param {Array} rows mfs_manifest rows for ONE selected node
 * @param {String} rootNid the selected node's nid
 * @param {Set} taken top-level names already used by the other selected nodes
 * @param {String} [rootName] the selected node's name when the manifest does
 *   not list it — a workspace root (category 'root') is filtered out
 * @returns {Array} the rows, each a copy with its archive filepath
 */
function archiveTree(rows, rootNid, taken = new Set(), rootName) {
  if (!Array.isArray(rows)) return rows;
  const byId = new Map();
  for (const r of rows) {
    if (!r || r.nid == null) continue;
    byId.set(`${r.nid}`, r);
    // A workspace inside the selection: its own content hangs off its HOME
    // node, which the manifest does not list — the hub row stands for it.
    if (/^hub$/i.test(r.filetype || "") && r.home_id != null) {
      if (!byId.has(`${r.home_id}`)) byId.set(`${r.home_id}`, r);
    }
  }
  const root = byId.get(`${rootNid}`);
  const top = uniqueName(
    root ? entryName(root) : entryName({ filename: rootName, nid: rootNid, filetype: "folder" }),
    taken,
    !!root && !CONTAINER.test(root.filetype || ""),
  );

  const memo = new Map();
  const pathOf = (r, seen = new Set()) => {
    const key = `${r.nid}`;
    if (memo.has(key)) return memo.get(key);
    let p;
    if (r === root) {
      p = top;
    } else {
      const parentKey = r.pid == null ? null : `${r.pid}`;
      const parent = parentKey == null ? null : byId.get(parentKey);
      if (parent && parent !== r && !seen.has(key)) {
        seen.add(key);
        p = posix.join(pathOf(parent, seen), entryName(r));
      } else {
        // Parent not in this manifest (the selected root itself when the
        // manifest omits it, or an orphan): keep the node, inside its selection.
        p = posix.join(top, entryName(r));
      }
    }
    memo.set(key, p);
    return p;
  };

  return rows.map((r) => (r && r.nid != null ? { ...r, filepath: pathOf(r) } : r));
}

module.exports = { archiveTree, entryName, uniqueName };
