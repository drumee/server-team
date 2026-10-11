/**
 * Who may put a workspace into a department -- B2B Org Structure.
 *
 * An org admin (domain privilege >= dom_admin) moves any workspace of the
 * organisation, in or out. Anyone else may file a workspace of their OWN,
 * while it sits in no department, into a department they can edit in: Edit
 * or Admin on at least one of its workspaces, whether their title gave it
 * there or it was given by hand. The same rule tells the topbar and the org
 * view where a member's "New workspace" lands inside the department.
 *
 * Pure helpers (testable without a database); organization.js runs them.
 */
const EDIT = 15;

/**
 * my_departments rows (the caller's own workspaces in departments, with
 * their privilege) → Set of the department ids the caller may add to.
 *
 * @param {Array} rows
 * @returns {Set<String>}
 */
function addableDepartments(rows) {
  const out = new Set();
  for (const r of Array.isArray(rows) ? rows : rows ? [rows] : []) {
    if (r && r.department_id && ~~r.privilege >= EDIT) out.add(String(r.department_id));
  }
  return out;
}

/**
 * May a caller who is NOT an org admin put this workspace into this
 * department? Only their own workspace, only while it is in no department,
 * only into a department they can edit in -- never out of one.
 *
 * @param {Object|null} hub {owner_id, department_id} from yp.hub
 * @param {String} uid the caller
 * @param {String} dept the target department id
 * @param {Set<String>} addable addableDepartments(...)
 * @returns {Boolean}
 */
function memberMayAssign(hub, uid, dept, addable) {
  if (!hub || !dept || !uid) return false;
  if (String(hub.owner_id) !== String(uid)) return false;
  if (hub.department_id) return false;
  return !!addable && addable.has(String(dept));
}

module.exports = { EDIT, addableDepartments, memberMayAssign };
