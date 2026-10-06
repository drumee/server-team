/**
 * Who holds what on a workspace's '*' row, read straight from that hub's DB.
 *
 * Shared by hub.js (member management) and desk.js (leave_hub), which both have
 * to tell the OWNER apart from everyone else before they write: only
 * change_owner may move ownership, and a path that strips or drops the owner's
 * row leaves the workspace with no owner at all.
 */
const { CAN_OWN, privilegeAllows } = require("./member-capability");

/**
 * Wildcard permission `uid` holds on the workspace whose DB is `db_name`,
 * 0 when none.
 *
 * db_name is interpolated rather than bound, so it is checked against the
 * identifier charset first. Any failure reads as 0.
 */
async function hubWildcardPermission(yp, db_name, uid) {
  try {
    if (!/^[A-Za-z0-9_]+$/.test(String(db_name || ""))) return 0;
    let row = await yp.await_query(
      `SELECT permission FROM \`${db_name}\`.permission
        WHERE resource_id='*' AND entity_id=? LIMIT 1`,
      uid
    );
    if (Array.isArray(row)) row = row[0];
    return ~~(row && row.permission);
  } catch (e) {
    return 0;
  }
}

/** Does `uid` hold the owner bit on that workspace's '*' row? */
async function holdsHubOwner(yp, db_name, uid) {
  return privilegeAllows(await hubWildcardPermission(yp, db_name, uid), CAN_OWN);
}

module.exports = { hubWildcardPermission, holdsHubOwner };
