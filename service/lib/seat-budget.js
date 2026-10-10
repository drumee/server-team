/**
 * Seat budget of an organisation: the plan's member cap against the people
 * holding a seat (member_list_stats: primary members, secondary members from
 * org_membership, and live invitations).
 *
 * Returns null when there is no finite budget to enforce: personal domain,
 * no organisation, Free (0) or the unlimited sentinel. FAIL-OPEN like the
 * other seat guards: a failed lookup answers null.
 */
const first = (v) => (Array.isArray(v) ? v[0] : v);

async function seatBudget(yp, domainId) {
  try {
    const dom = ~~domainId;
    if (dom <= 1) return null;
    const org = first(await yp.await_proc("organisation_get", String(dom)));
    if (!org || !org.id) return null;
    const raw = await yp.await_func("get_quota", org.owner_id);
    const quota = typeof raw === "string" ? JSON.parse(raw || "{}") : raw || {};
    const seat = parseInt(quota && quota.seat, 10) || 0;
    if (seat <= 0 || seat >= 100000) return null;
    const stats = first(await yp.await_proc("member_list_stats", org.id));
    const members = parseInt(stats && stats.total_members, 10) || 0;
    const pending = parseInt(stats && stats.pending_invites, 10) || 0;
    return {
      seat, members, pending,
      used: members + pending,
      free: Math.max(0, seat - members - pending),
    };
  } catch (e) {
    console.warn("[seat-budget] lookup failed (fail-open):", e && e.message);
    return null;
  }
}

/**
 * Is there room for one more person in this organisation? Someone already
 * holding a live invitation reserved their seat, so only members count for
 * them (same rule as hub.join).
 */
async function hasRoomFor(yp, domainId, email) {
  const budget = await seatBudget(yp, domainId);
  if (!budget) return { ok: true, budget };
  let invited = false;
  if (email) {
    try {
      const rows = await yp.await_proc("pending_invites_by_domain", ~~domainId, "");
      const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
      const k = String(email).trim().toLowerCase();
      invited = list.some((r) => r && String(r.email || "").trim().toLowerCase() === k);
    } catch (e) { /* treat as not invited */ }
  }
  const ok = invited ? budget.members < budget.seat : budget.used < budget.seat;
  return { ok, budget };
}

module.exports = { seatBudget, hasRoomFor };
