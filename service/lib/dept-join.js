/**
 * An invitation into a DEPARTMENT's workspace joins the department too --
 * B2B Org Structure (Figma 900:150257): "Invite members to department and
 * workspace in organization", by email as by the public join link.
 *
 * Called once the invitee holds the workspace (hub.accept_invite). When the
 * workspace belongs to a department, the invitee becomes a member of that
 * department and, unless they are already in the organisation, of the
 * organisation as a secondary one (org_membership -- their own account and
 * primary organisation are untouched). The workspace access the invitation
 * gave is kept as it is; the department's title rules apply from then on
 * (organization._reconcile, which never lowers access it did not set).
 *
 * Never throws: joining the workspace already succeeded and must not be
 * reported as a failure because the department step did not.
 */
const { Remit } = require("@drumee/server-essentials");
const ActiveOrg = require("./active-org");

const rows = (v) => (Array.isArray(v) ? v : v ? [v] : []);

async function joinDepartmentOf(yp, hubId, uid, byId) {
  try {
    if (!hubId || !uid) return false;
    const h = rows(await yp.await_query(
      "SELECT domain_id, department_id FROM hub WHERE id = ? LIMIT 1", hubId,
    ))[0];
    if (!h || !h.department_id) return false;
    const dom = ~~h.domain_id;
    if (dom <= 1) return false;
    const primary = rows(await yp.await_query(
      "SELECT 1 AS yes FROM privilege WHERE uid = ? AND domain_id = ? LIMIT 1", uid, dom,
    ))[0];
    if (!primary) {
      const m = rows(await yp.await_proc("org_membership_get", uid, dom))[0];
      if (!m) await yp.await_proc("org_membership_set", dom, uid, Remit.dom_member, byId || null);
    }
    await yp.await_proc("department_member_add", dom, String(h.department_id), uid, byId || uid);
    ActiveOrg.forget(uid, dom);
    return true;
  } catch (e) {
    console.warn("[dept-join] department join skipped:", e && e.message);
    return false;
  }
}

module.exports = { joinDepartmentOf };
