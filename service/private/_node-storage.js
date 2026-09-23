/**
 * @license
 * Copyright 2024 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3
 */

const { MfsTools } = require("@drumee/server-core");
const { cp } = require("fs/promises");

const { check_base, get_base, check_safety } = MfsTools;

/**
 * Copy a node's storage folder and resolve only once the bytes are on disk.
 *
 * `MfsTools.copy_node(src, dest, 1)` hands the copy to a detached
 * `mfs-copy-node.sh` and returns at once. A caller that then deletes the
 * source in the same request — channel.post purges the staging copy right
 * after copying it into the sbox — races that script: the in-process rm wins,
 * `cp -rf src/*` finds nothing, and the sbox node ends up as an empty folder
 * that the committed message already references (no vignette, `file/orig`
 * 404). Awaiting the copy here makes the later purge safe.
 *
 * `dereference` matters: while the desk-side staging copy is still running,
 * the staging path is a symlink to the original that the script drops at the
 * end. Copying the link itself would leave the sbox pointing at a path the
 * purge deletes moments later; following it copies the real files.
 *
 * @param {{nid: string, mfs_root: string}} src
 * @param {{nid: string, mfs_root: string}} dest
 * @returns {Promise<boolean>} true when the folder was copied
 */
async function copyNodeStorage(src, dest) {
  const from = check_base(src);
  if (!from) return false;
  const to = get_base(dest);
  if (!to) return false;
  check_safety(to);
  await cp(from, to, { recursive: true, dereference: true });
  return true;
}

module.exports = { copyNodeStorage };
