/**
 * Multi-org (B2B Org Structure, Figma 900:150849 / 900:150993): which
 * organisation a request acts in.
 *
 * A person's PRIMARY organisation is still their single yp.privilege row and
 * drumate.domain_id. They may also belong to further organisations
 * (yp.org_membership), or hold workspaces in one as a guest. When they open
 * one of those organisations' addresses, the request should act there: the
 * org dropdown, the departments, the Admin Console and every domain-scoped
 * ACL check all read `user.domain_id()`.
 *
 * THE HOST, NOT THE REQUEST'S HUB. Most calls carry hub_id = the person's
 * own home hub, which sits in their primary organisation; the organisation
 * being worked in is the one whose ADDRESS the browser is on. So the host is
 * resolved through yp.vhost (cached: an address rarely changes owner).
 *
 * So, once per request and BEFORE the ACL runs (service.js), when the host's
 * organisation differs from the person's own:
 *   - a membership row  -> act in the host organisation with that privilege;
 *   - workspaces there  -> act in it as a guest (privilege 0: the org view's
 *                          inventory and every admin service stay closed);
 *   - neither           -> nothing changes (and the browser is sent home, as
 *                          today, because get_env still reports the primary
 *                          organisation).
 * The person's own organisation and every request on it cost nothing: the
 * lookup only happens on a cross-organisation host.
 *
 * domain_permission / domain_privilege read org_membership as a fallback, so
 * the privilege used by the ACL matches what is set here.
 *
 * FAIL-CLOSED to today's behaviour: any error leaves the request exactly as
 * it was (primary organisation).
 */
const CACHE_TTL = 30 * 1000;
const HOST_TTL = 5 * 60 * 1000;
const cache = new Map();
const hosts = new Map();
const HOST_RE = /^[a-z0-9.-]+$/i;
const DB_RE = /^[0-9a-zA-Z_]+$/;

const rows = (v) => (Array.isArray(v) ? v : v ? [v] : []);

function cached(key) {
  const hit = cache.get(key);
  if (hit && hit.t > Date.now() - CACHE_TTL) return hit;
  if (hit) cache.delete(key);
  return null;
}

function remember(key, value) {
  if (cache.size > 5000) cache.clear();
  cache.set(key, { t: Date.now(), value });
}

/**
 * The organisation (domain id) an address belongs to, 0 when none.
 */
async function hostDomain(yp, host) {
  host = String(host || "").toLowerCase().split(":")[0];
  if (!host || !HOST_RE.test(host)) return 0;
  const hit = hosts.get(host);
  if (hit && hit.t > Date.now() - HOST_TTL) return hit.dom;
  const row = rows(await yp.await_query(
    "SELECT dom_id FROM vhost WHERE fqdn = ? LIMIT 1", host,
  ))[0];
  const dom = ~~(row && row.dom_id);
  if (hosts.size > 5000) hosts.clear();
  hosts.set(host, { t: Date.now(), dom });
  return dom;
}

/** Drop a person's cached standing (after a membership change). */
function forget(uid, domain_id) {
  if (domain_id == null) {
    for (const k of cache.keys()) if (k.startsWith(`${uid}:`)) cache.delete(k);
    return;
  }
  cache.delete(`${uid}:${domain_id}`);
}

/**
 * The person's standing in an organisation that is not their primary one:
 * {privilege, role: 'member'|'guest'} or null.
 */
async function standing(yp, user, domain_id) {
  const uid = user.get("id");
  const key = `${uid}:${domain_id}`;
  const hit = cached(key);
  if (hit) return hit.value;

  let value = null;
  const m = rows(await yp.await_proc("org_membership_get", uid, domain_id))[0];
  if (m && m.privilege) {
    value = { privilege: ~~m.privilege, role: "member" };
  } else {
    const db = user.get("db_name");
    if (db && DB_RE.test(db)) {
      const g = rows(await yp.await_query(
        `SELECT 1 AS yes FROM \`${db}\`.media m INNER JOIN yp.entity e ON e.id = m.id ` +
        "WHERE m.category = 'hub' AND m.extension <> 'dmz' AND e.dom_id = ? LIMIT 1",
        domain_id,
      ))[0];
      if (g) value = { privilege: 0, role: "guest" };
    }
  }
  remember(key, value);
  return value;
}

/**
 * @param {Session} session
 */
async function apply(session) {
  try {
    const user = session.user;
    if (!user || !user.get("signed_in")) return;
    const own = ~~(user.get("domain_id") || user.get("dom_id"));
    const host = session.input && session.input.host && session.input.host();
    const hostDom = await hostDomain(session.yp, host);
    if (hostDom <= 1 || hostDom === own) return;
    const s = await standing(session.yp, user, hostDom);
    if (!s) return;
    user.set({
      home_domain_id: own,
      domain_id: hostDom,
      active_org: { domain_id: hostDom, privilege: s.privilege, role: s.role, home_domain_id: own },
    });
  } catch (e) {
    console.warn("[active-org] lookup failed, request stays in the primary org:", e && e.message);
  }
}

/** Forget cached addresses (after an organisation changes its address). */
function forgetHosts() {
  hosts.clear();
}

module.exports = { apply, standing, forget, hostDomain, forgetHosts };
