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

// ==================================================================== *
//   Hard-delete a drumate: settle its workspaces, then purge the account.
//
//   Used by drumate.delete_account (self-service). private/role.js still
//   carries its own inline copy of the workspace loop in member_delete and
//   member_disconnect -- those two differ in their final call (drumate_delete
//   vs drumate_vanish) and are admin flows that cannot be exercised on stage,
//   so they are deliberately left alone here and should migrate onto this
//   helper separately, with the admin path actually tested. What must never
//   diverge -- WHICH rows a delete removes -- lives in the drumate_delete
//   procedure that every hard-delete caller already shares.
// ==================================================================== *

const { toArray, sysEnv } = require("@drumee/server-essentials");
const { MfsTools } = require("@drumee/server-core");
const { remove_dir } = MfsTools;
const { isEmpty } = require("lodash");
const { sqlString } = require("./sql-literal");

const { mfs_dir } = sysEnv();

/**
 * remove_dir() performs a recursive delete, and its check_safety() only tests
 * for a lock file -- it does not validate the path at all. An empty string
 * normalises to "." and would recursively delete the process's working
 * directory. Every home_dir in production is a well-formed path under mfs_dir,
 * but this code is now reachable from a user-initiated request, where a
 * double-submitted delete resolves no entity row and yields a NULL home_dir.
 * Refuse anything not demonstrably inside the media root.
 *
 * @param {*} home_dir  candidate directory, from an entity row
 * @returns {number} 1 when the directory was removed, 0 when it was refused
 */
function purge_dir(home_dir) {
  if (typeof home_dir !== "string") return 0;
  const dir = home_dir.trim();
  if (!dir || !dir.startsWith(`${mfs_dir}/`)) return 0;
  remove_dir(dir);
  return 1;
}

/**
 * Settle one workspace the departing account owns.
 *
 * Hand it to somebody still in it -- another owner first, then an admin, then
 * any remaining member. Only a workspace with nobody left is deleted. Deleting
 * your own account must not take a shared workspace, and everybody else's files
 * in it, with you.
 *
 * @param {*} svc  the calling service worker (supplies .yp)
 * @param {*} hub  a row carrying at least {id, home_dir}
 * @param {string} uid  the departing account, never a handover candidate
 * @returns {string} "handed_over" or "deleted"
 */
async function settle_hub(svc, hub, uid) {
  // hub_get_members_by_type's first argument does NOT filter the result set --
  // it is used only to locate the CALLER's drumate database for a contact-name
  // lookup. The member list itself is every entity holding a '*' permission on
  // the workspace, which includes the departing account. Handing the workspace
  // to whatever came back first would therefore hand it straight back to the
  // account being deleted, leaving the hub, its database and its files orphaned
  // behind a dangling owner_id. So exclude the departing account here, in code,
  // rather than relying on the procedure to do it.
  const candidates = async (type) => {
    const rows = toArray(await svc.yp.await_proc(
      "forward_proc", hub.id, "hub_get_members_by_type", `${sqlString(uid)},${sqlString(type)},1`
    )) || [];
    return rows.filter((r) => r && r.id && r.id != uid);
  };

  let huber = await candidates("owner");
  if (isEmpty(huber)) huber = await candidates("admin");
  if (isEmpty(huber)) huber = await candidates("all");

  if (!isEmpty(huber)) {
    await svc.yp.await_proc(
      "forward_proc", hub.id, "permission_grant",
      `'*',${sqlString(huber[0].id)},0,63,'system',0`
    );
    return "handed_over";
  }

  await svc.yp.await_proc("entity_delete", hub.id);
  purge_dir(hub.home_dir);
  return "deleted";
}

/**
 * Settle every workspace the account belongs to, then delete the account.
 *
 * Workspaces are handled BEFORE the account row goes, because the handover
 * needs the membership rows to still be readable.
 *
 * Two passes, because neither source is complete on its own:
 *   - show_hubs runs inside the account's OWN database and lists what it holds
 *     a huber row for. That is the only way to find workspaces owned by OTHER
 *     people that this account must leave.
 *   - hub_all reads yp.hub directly and is authoritative for ownership. A dmz
 *     sharebox is never registered in the owner's own database, so show_hubs
 *     does not report it and it used to survive its owner entirely: hub row,
 *     entity row, its database and its files all left behind on every delete.
 *
 * @param {*} svc  the calling service worker (supplies .yp)
 * @param {string} uid  the account to delete
 * @returns {*} the drumate_delete result row: {id, ident, type, db_name, home_dir}
 */
async function purge_account(svc, uid) {
  const settled = new Set();

  let hubs = await svc.yp.await_proc("forward_proc", uid, "show_hubs", "");
  hubs = toArray(hubs) || [];

  for (let hub of hubs) {
    await svc.yp.await_proc("forward_proc", uid, "leave_hub", `${sqlString(hub.id)}`);
    if (hub.owner_id != uid) continue;
    await settle_hub(svc, hub, uid);
    settled.add(hub.id);
  }

  // A handover leaves hub.owner_id pointing at the departing account, so a
  // handed-over workspace still shows up here; the Set keeps it from being
  // settled twice.
  let owned = await svc.yp.await_proc("hub_all", uid);
  owned = toArray(owned) || [];
  for (let hub of owned) {
    if (settled.has(hub.id)) continue;
    await settle_hub(svc, hub, uid);
    settled.add(hub.id);
  }

  const user = await svc.yp.await_proc("drumate_delete", uid);
  purge_dir(user && user.home_dir);
  return user;
}

module.exports = { purge_account, purge_dir };
