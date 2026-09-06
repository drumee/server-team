/**
 * Which organisation is this request acting in?
 *
 * Until yp.privilege was widened from UNIQUE (uid) to UNIQUE (uid, domain_id)
 * the question had no content: you belonged to exactly one organisation, so
 * "the org that owns your identity" and "the org you are working in" were the
 * same number and `user.domain_id()` answered both. They are now different
 * questions, and roughly a hundred call sites ask the second one while being
 * handed the answer to the first.
 *
 * HOME IS STILL user.domain_id(), AND THAT DOES NOT CHANGE. This module adds a
 * second accessor rather than redefining the first, deliberately: every site
 * not yet migrated keeps today's behaviour by construction, so the migration
 * can stop anywhere without leaving a half-switched request. Redefining
 * domain_id() would flip ~99 sites at once, several of which are money or
 * membership decisions -- hub.js's `sameDomain` grants workspace membership
 * with no invitation, and it compares the actor's domain against an invitee's.
 *
 * EXPLICIT WINS, THEN THE HUB, THEN HOME -- the same precedence _initHub
 * already uses to pick a hub (an explicit hub_id beats the Host header, which
 * is only a fallback). The order matters and the obvious one is wrong: the org
 * panel calls organization.overview with hub_id = Visitor.id, the caller's own
 * personal hub, whose entity.dom_id is by definition their HOME. Consult the
 * hub first and the org panel is pinned to home forever and the switch can
 * never be expressed.
 *
 * THE EXPLICIT VALUE IS CLIENT-SUPPLIED, so it is admitted only after
 * domain_privilege confirms a membership -- that procedure is keyed on
 * (uid, domain_id) and answers privilege 0 for a non-member, which is exactly
 * the admission test wanted. A forged domain does not error; it falls through
 * to the next source, because a request naming an organisation you do not
 * belong to is indistinguishable from one naming none.
 *
 * THE HUB IS THE SECOND SOURCE and needs no such check: session.hub comes from
 * get_hub(hub_id) and the request's access to it has ALREADY been authorised
 * per-node by the ACL (mfs_access_node), so naming a hub you cannot reach gets
 * you refused before this code runs.
 *
 * NEITHER IS GOOD ENOUGH FOR MONEY. Membership is a low bar -- a plain member
 * of an org can name it here quite legitimately -- so the sites where a wrong
 * answer is worth something (seat budgets, upload metering) must NOT read this
 * resolver at all. They take the domain of the workspace being written to, via
 * hub.js's _hubDomainId, which is read straight out of entity.dom_id and is
 * not client-supplied in any form. This module answers "which org is the user
 * looking at", never "which org pays for this".
 *
 * Never throws. An acting domain that cannot be resolved is home, which is
 * what every request meant before this module existed.
 */

const { Attr } = require("@drumee/server-essentials");

// The header arrives as x-param-acting-domain and reaches input as a dashed
// key (server-core/lib/input.js strips the x-param- prefix). NOT `domain_id`:
// caller arguments spread over the client's defaultPayload, so a parameter by
// that name would start appearing on the 667 hub-scoped services that never
// asked for one, where absence currently means absence.
const HEADER_KEY = "acting-domain";

// Memoised per session rather than per call: a single request can ask several
// times (the router's clamp, then the worker) and this must not become two
// round trips, nor answer differently within one request.
const CACHE = new WeakMap();

/**
 * @param {Object} session
 * @returns {Promise<number>} a domain id the user demonstrably belongs to
 */
async function resolve(session) {
  if (!session || !session.user) return 0;
  if (CACHE.has(session)) return CACHE.get(session);

  const home = ~~session.user.domain_id();
  let acting = home;

  try {
    // 1. An explicit acting domain, admitted only on proof of membership.
    const asked = ~~session.input.get(HEADER_KEY);
    if (asked > 1 && (asked === home || (await _member(session, asked)))) {
      acting = asked;
    } else {
      // 2. The hub already authorised for this request. Only worth consulting
      //    when it belongs to somewhere other than home -- which for the
      //    caller's own personal hub it never does.
      const hub = session.hub;
      const fromHub = hub && ~~(hub.get(Attr.org_id) || hub.get(Attr.domain_id));
      if (fromHub > 1 && fromHub !== home && (await _member(session, fromHub))) {
        acting = fromHub;
      }
    }
  } catch (e) {
    // 3. Home. Deliberately silent about the reason: this runs on every
    //    request and a resolution failure is not an error the caller can act
    //    on -- it just means "no switch happened".
    acting = home;
  }

  CACHE.set(session, acting);
  return acting;
}

/**
 * Does this user hold a privilege row in that domain? domain_privilege is
 * keyed on (uid, domain_id) and declares its OUT vars DEFAULT 0, so a missing
 * row answers 0 rather than an empty set.
 */
async function _member(session, domainId) {
  const row = await session.yp.await_proc("domain_privilege", domainId, session.user.get(Attr.id));
  const r = Array.isArray(row) ? row[0] : row;
  return !!(r && ~~r.privilege > 0);
}

/**
 * The value resolve() stashed, for code that runs after the router has already
 * resolved it and must not pay for a second lookup. Falls back to home so a
 * caller reached outside the REST path (an offline worker, say) still gets a
 * usable answer instead of 0.
 */
function current(session) {
  if (!session || !session.user) return 0;
  const stashed = ~~session.user.get("acting_domain_id");
  return stashed > 0 ? stashed : ~~session.user.domain_id();
}

module.exports = { resolve, current, HEADER_KEY };
