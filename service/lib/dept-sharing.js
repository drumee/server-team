/**
 * "Sharing outside dept. = Not allowed" — B2B Org Structure access rules.
 *
 * A person whose TITLE's rule says sharing: not_allowed may not share a
 * workspace that belongs to a department with anyone outside that
 * department:
 *   - RECIPIENT services (invite / add members / grant): every recipient must
 *     be a member of the workspace's department (yp.department_member);
 *   - LINK / EXTERNAL services (public links, external guests, outbound
 *     shares, transfer boxes): always outside the department — refused.
 *
 * Org owners and admins (domain admin bit) are never restricted, nor is any
 * workspace with no department, nor anyone without a title or whose title has
 * no rule. Called from the router's GRANTED hook, BEFORE the service runs; it
 * only looks anything up for the services listed here, so other traffic costs
 * nothing.
 *
 * FAIL-OPEN, like the router's other gates: a failed lookup lets the call
 * through and logs, rather than blocking every share on a DB hiccup.
 */
const RECIPIENT_SERVICES = new Set([
  "hub.invite",
  "hub.add_contributors",
  "hub.invite_with_roles",
  "permission.add_users",
  "permission.grant",
]);

const OUTSIDE_SERVICES = new Set([
  "hub.copy_link",
  "hub.add_external_member",
  "hub.update_external_members",
  "hub.update_external_room",
  "hub.update_external_settings",
  "sharebox.assign_permission",
  "sharebox.create_link",
  "sharebox.copy_link",
  "sharebox.create_public_box",
  "sharebox.create_inbound_link",
  "secure_share.create",
  "room.public_link",
  "transfer.create",
  "transfer.create_link",
  "transfer.send_link",
]);

const DENIED = "SHARING_OUTSIDE_DEPARTMENT_NOT_ALLOWED";

const asArray = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);
const UID_RE = /^[0-9a-f]{16}$/i;

function watched(service) {
  return RECIPIENT_SERVICES.has(service) || OUTSIDE_SERVICES.has(service);
}

/** The workspaces a call addresses: its hub_id, plus invite_with_roles' targets. */
function targetHubs(input) {
  const hubs = new Set();
  const h = input.get("hub_id");
  if (h) hubs.add(String(h));
  let assignments = input.get("assignments");
  if (typeof assignments === "string") {
    try { assignments = JSON.parse(assignments); } catch (e) { assignments = []; }
  }
  for (const a of asArray(assignments)) if (a && a.hub_id) hubs.add(String(a.hub_id));
  return [...hubs];
}

/** The people a recipient service names: emails and/or uids. */
function recipients(input) {
  const out = [];
  for (const key of ["invitees", "users"]) {
    let v = input.get(key);
    if (typeof v === "string") {
      try { v = JSON.parse(v); } catch (e) { /* a single value */ }
    }
    for (const r of asArray(v)) {
      if (typeof r === "string") out.push(r.trim().toLowerCase());
      else if (r && (r.email || r.id || r.uid)) out.push(String(r.email || r.id || r.uid).toLowerCase());
    }
  }
  return out.filter(Boolean);
}

const rows = (v) => (Array.isArray(v) ? v : v ? [v] : []);

/**
 * @param {Object} session the request session (yp, user, input)
 * @param {String} service "module.method"
 * @param {Number} adminLevel the router's ADMIN_LEVEL bit
 * @returns {Promise<String|null>} an error code to refuse with, or null
 */
async function check(session, service, adminLevel) {
  if (!watched(service)) return null;
  try {
    const yp = session.yp;
    const uid = session.user && session.user.get("id");
    if (!uid) return null;

    for (const hub_id of targetHubs(session.input)) {
      const hub = rows(await yp.await_query(
        "SELECT domain_id, department_id FROM hub WHERE id = ? LIMIT 1", hub_id,
      ))[0];
      if (!hub || !hub.department_id) continue;
      const dom = ~~hub.domain_id;

      if (await yp.await_func("domain_permission", uid, dom, adminLevel)) continue;

      const title = rows(await yp.await_query(
        "SELECT title FROM member_title WHERE domain_id = ? AND uid = ? LIMIT 1", dom, uid,
      ))[0];
      if (!title || !title.title) continue;

      const meta = rows(await yp.await_query(
        "SELECT IF(JSON_VALID(metadata), JSON_EXTRACT(metadata, '$.access_rules'), NULL) AS rules " +
        "FROM organisation WHERE domain_id = ? LIMIT 1", dom,
      ))[0];
      let rules = meta && meta.rules;
      if (typeof rules === "string") {
        try { rules = JSON.parse(rules); } catch (e) { rules = []; }
      }
      const rule = asArray(rules).find((r) => r && String(r.title) === String(title.title));
      if (!rule || rule.sharing !== "not_allowed") continue;

      if (OUTSIDE_SERVICES.has(service)) return DENIED;

      // Recipient services: everyone named must be in the department.
      const members = new Set(rows(await yp.await_query(
        "SELECT m.uid, d.email FROM department_member m LEFT JOIN drumate d ON d.id = m.uid " +
        "WHERE m.domain_id = ? AND m.department_id = ?", dom, hub.department_id,
      )).flatMap((m) => [String(m.uid).toLowerCase(), String(m.email || "").toLowerCase()]));
      const people = recipients(session.input);
      if (!people.length) continue;
      for (const p of people) {
        if (!members.has(p) && !(UID_RE.test(p) && members.has(p.toLowerCase()))) return DENIED;
      }
    }
    return null;
  } catch (e) {
    console.warn("[dept-sharing] check failed (fail-open):", e && e.message);
    return null;
  }
}

module.exports = { check, watched, targetHubs, recipients, DENIED, RECIPIENT_SERVICES, OUTSIDE_SERVICES };
