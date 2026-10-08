/**
 * Department access — B2B Org Structure.
 *
 * A member of a department gets, on every workspace of that department, the
 * access their TITLE's rule says (organisation.metadata.$.access_rules:
 * {title, access, sharing}); no title, or no rule for it, means View. The
 * grant is an ordinary hub permission row (member_save_workspace_roles), so
 * every existing access check sees it unchanged; yp.department_grant remembers
 * which rows a department wrote and what the person had before, so the grant
 * can be taken back without touching access given by hand.
 *
 * Pure helpers here (testable without a database); the service runs them.
 */
const PRIVILEGE = { view: 3, chat: 7, edit: 15, admin: 31 };
const OWNER = 63;

const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);

/** organisation_get_access_rules' value → Map(title → {access, sharing}). */
function rulesByTitle(raw) {
  let v = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch (e) { v = []; }
  }
  const out = new Map();
  for (const r of asArray(v)) {
    if (r && r.title) out.set(String(r.title), { access: r.access, sharing: r.sharing });
  }
  return out;
}

/**
 * department_desired_grants rows + rules → Map("hub|uid" → {hub_id, uid,
 * hub_db, privilege}). A person in two departments sharing a workspace (not
 * possible today: a workspace has one department) keeps the higher grant.
 */
function desiredGrants(rows, rules) {
  const out = new Map();
  for (const r of asArray(rows)) {
    if (!r || !r.uid || !r.hub_id) continue;
    const rule = r.title ? rules.get(String(r.title)) : null;
    const privilege = PRIVILEGE[rule && rule.access] || PRIVILEGE.view;
    const key = `${r.hub_id}|${r.uid}`;
    const prev = out.get(key);
    if (!prev || prev.privilege < privilege) {
      out.set(key, { hub_id: String(r.hub_id), uid: String(r.uid), hub_db: r.hub_db, privilege });
    }
  }
  return out;
}

/**
 * What to do for ONE desired grant, given the person's current hub privilege
 * and the sidecar row (if the department already granted it).
 *
 * - never touch the owner;
 * - a department never lowers access it did not set: if the person's access
 *   is no longer what the department set (someone changed it by hand), only
 *   a RAISE is applied; if it still is, it follows the rule up or down;
 * - first grant records what they had before (prev) so it can be restored.
 *
 * @returns {{write: Number|null, save: Object|null}}
 */
function planGrant(desired, current, existing) {
  const cur = ~~current;
  if (cur >= OWNER) return { write: null, save: null };
  if (existing) {
    const prev = ~~existing.prev_privilege;
    const set = Math.max(~~existing.privilege, prev);
    const target = Math.max(desired.privilege, prev);
    const untouched = cur === set;
    return {
      write: (untouched && cur !== target) || cur < target ? target : null,
      save: ~~existing.privilege !== desired.privilege
        ? { privilege: desired.privilege, prev: ~~existing.prev_privilege }
        : null,
    };
  }
  if (cur >= desired.privilege) return { write: null, save: null };
  return { write: desired.privilege, save: { privilege: desired.privilege, prev: cur } };
}

/**
 * What to do for a grant the department NO LONGER gives.
 *
 * Restores what they had before only when the access is still what the
 * department set (max(granted, prev)) — someone changed it by hand since, and
 * that change wins. 'remove' when they had nothing before.
 *
 * @returns {'remove'|'restore'|'keep'}
 */
function planRevoke(existing, current) {
  const cur = ~~current;
  if (!cur || cur >= OWNER) return 'keep';
  const set = Math.max(~~existing.privilege, ~~existing.prev_privilege);
  if (cur !== set) return 'keep';
  return ~~existing.prev_privilege > 0 ? 'restore' : 'remove';
}

/** A reporting line that would make `uid` its own manager, directly or not. */
function makesCycle(lines, uid, manager) {
  if (!manager) return false;
  if (String(manager) === String(uid)) return true;
  const up = new Map(asArray(lines).map((l) => [String(l.uid), String(l.manager_uid)]));
  let cur = String(manager);
  for (let i = 0; i < 1000 && cur; i++) {
    if (cur === String(uid)) return true;
    cur = up.get(cur);
  }
  return false;
}

module.exports = {
  PRIVILEGE, OWNER, rulesByTitle, desiredGrants, planGrant, planRevoke, makesCycle,
};
