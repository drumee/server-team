/**
 * Organisation membership that follows WORKSPACE membership.
 *
 * Drumee has two notions of "member" that were never connected:
 *
 *   workspace member  = a '*' permission row in the hub's own database, written
 *                       by add_member / permission_grant (hub.accept_invite,
 *                       signup's pending-invitation resolver, add_contributors,
 *                       invite_with_roles);
 *   organisation member = a yp.privilege row on the org domain plus
 *                       drumate.domain_id = that domain, written only by
 *                       org_provision (the owner) and adminpanel.member_add
 *                       (which creates a brand-new account inside the org).
 *
 * Plan, storage, feature gates and seats all read the SECOND (get_quota,
 * disk_limit, member_list_stats resolve on drumate.domain_id). So a person
 * invited into a paid team's workspace kept their own Free plan, never showed
 * in the Admin Console, and stopped counting as a seat the moment they
 * accepted (the invite reserves one; acceptance deletes the pending row and
 * writes no privilege row). Observed on prod 2026-10-25: a 10-seat Team org
 * with 1 member and 22 people working in its workspaces.
 *
 * Rule (the owner's, 2026-10-12): joining an INTERNAL workspace (area
 * 'private') of an organisation makes you a member of that organisation;
 * External workspaces only ever hold guests. Membership is granted only to a
 * personal account (domain 1) that has no entitlement of its own and is not
 * already in another organisation (yp.privilege is UNIQUE per uid, one org per
 * account), while the plan still has a seat free. Everybody else stays a guest,
 * exactly as before.
 *
 * The move is reversible: the account remembers it joined through a workspace
 * (profile.$.org_join, written by org_member_join) and goes back to its
 * personal domain when it leaves, or is removed from, the last internal
 * workspace of that organisation (org_member_leave). Admin-created accounts
 * carry no marker and are never moved.
 *
 * Every entry point is best-effort: a failure here must never undo or fail the
 * workspace grant that just happened. Both functions resolve to a result
 * object and never throw.
 */
const { RedisStore, toArray } = require("@drumee/server-essentials");

/** Pushed to the person's own sockets so the desk reloads with the new plan. */
const ORG_JOINED = "hub.org_joined";
const ORG_LEFT = "hub.org_left";

/** Seats at or above this are the unlimited tier (same sentinel as _seatBudget). */
const UNLIMITED_SEATS = 100000;

function firstRow(v) {
  return Array.isArray(v) ? v[0] : v;
}

function parseJson(v) {
  if (v == null) return null;
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch (e) {
    return null;
  }
}

function warn(view, ...args) {
  if (view && typeof view.warn === "function") view.warn(...args);
}

/**
 * Fresh entitlement for the push payload, so Visitor.respawn has the new plan
 * even before the reload. Best-effort.
 */
async function freshQuota(yp, uid) {
  try {
    const q = parseJson(await yp.await_func("get_quota", uid));
    return q && typeof q === "object" ? q : undefined;
  } catch (e) {
    return undefined;
  }
}

/**
 * Tell the person's open desks. notify_user is the Entity helper every
 * service worker has; the fallback covers callers that are not one.
 */
async function notify(view, uid, data) {
  try {
    if (typeof view.notify_user === "function") {
      await view.notify_user(uid, data);
      return;
    }
    const sockets = await view.yp.await_proc("user_sockets", uid);
    await RedisStore.sendData(view.payload(data), sockets);
  } catch (e) {
    warn(view, "[org-membership] notify failed", e && e.message);
  }
}

/**
 * Why a workspace grant does NOT make somebody an organisation member.
 * Returns null when it should.
 */
function joinRefusal(ctx) {
  if (!ctx) return "no_context";
  const hubDom = ~~ctx.hub_dom;
  if (hubDom <= 1) return "personal_workspace";
  if (ctx.hub_type !== "hub" || ctx.hub_area !== "private") return "external_workspace";
  if (ctx.hub_status && ctx.hub_status !== "active") return "workspace_inactive";
  if (ctx.acc_domain_id == null) return "no_account";
  if (~~ctx.acc_domain_id === hubDom) return "already_member";
  if (~~ctx.acc_domain_id > 1) return "other_organisation";
  if (ctx.acc_category === "system") return "system_account";
  if (ctx.acc_status && ctx.acc_status !== "active") return "account_inactive";
  if (~~ctx.own_plan) return "own_plan";
  if (!ctx.org_id) return "no_organisation";
  const seat = parseInt(ctx.seat, 10) || 0;
  const members = parseInt(ctx.members, 10) || 0;
  if (seat > 0 && seat < UNLIMITED_SEATS && members >= seat) return "seat_limit";
  if (~~ctx.username_taken) return "username_taken";
  return null;
}

/**
 * After `uid` was granted membership of workspace `hubId`: make them a member
 * of the owning organisation when the rule above says so.
 *
 * @returns {Promise<{joined: boolean, reason?: string, domain_id?: number, org_id?: string}>}
 */
async function joinOrgOnWorkspaceJoin(view, uid, hubId) {
  if (!view || !view.yp || !uid || !hubId) return { joined: false, reason: "bad_call" };
  const yp = view.yp;
  try {
    const ctx = firstRow(await yp.await_proc("org_join_context", uid, hubId));
    const reason = joinRefusal(ctx);
    if (reason) return { joined: false, reason };
    const domain_id = ~~ctx.hub_dom;
    const prev = ctx.prev_privilege == null ? 1 : ~~ctx.prev_privilege;
    await yp.await_proc("org_member_join", uid, domain_id, hubId, prev);
    await notify(view, uid, {
      service: ORG_JOINED,
      domain_id,
      org_id: ctx.org_id,
      org_name: ctx.org_name,
      hub_id: hubId,
      quota: await freshQuota(yp, uid),
    });
    return { joined: true, domain_id, org_id: ctx.org_id };
  } catch (e) {
    warn(view, "[org-membership] join failed for", uid, e && e.message);
    return { joined: false, reason: "error" };
  }
}

/**
 * Does `uid` still hold membership of another internal workspace of this
 * organisation (other than `exceptHubId`)? Read from the person's own hub
 * list (their drumate DB, via forward_proc/show_hubs) against the org's
 * workspace list, both existing procedures.
 */
async function stillInOrgWorkspace(yp, uid, domainId, exceptHubId) {
  const orgHubs = toArray(await yp.await_proc("org_workspaces", domainId)).filter(
    (h) => h && h.area === "private" && String(h.id) !== String(exceptHubId)
  );
  if (!orgHubs.length) return false;
  const mine = new Set(
    toArray(await yp.await_proc("forward_proc", uid, "show_hubs", "")).map((h) => String(h && h.id))
  );
  return orgHubs.some((h) => mine.has(String(h.id)));
}

/**
 * After `uid` left, or was removed from, workspace `hubId`: if they had become
 * an organisation member through a workspace and this was the last internal
 * workspace of that organisation they were in, move them back to their
 * personal domain.
 *
 * @returns {Promise<{left: boolean, reason?: string, domain_id?: number}>}
 */
async function leaveOrgOnWorkspaceLeave(view, uid, hubId) {
  if (!view || !view.yp || !uid || !hubId) return { left: false, reason: "bad_call" };
  const yp = view.yp;
  try {
    const ctx = firstRow(await yp.await_proc("org_join_context", uid, hubId));
    if (!ctx || ctx.acc_domain_id == null) return { left: false, reason: "no_account" };
    const domain_id = ~~ctx.acc_domain_id;
    if (domain_id <= 1) return { left: false, reason: "personal_account" };
    const marker = parseJson(ctx.acc_org_join);
    if (!marker || marker.source !== "workspace") return { left: false, reason: "not_workspace_member" };
    if (~~marker.domain_id !== domain_id) return { left: false, reason: "moved_since" };
    if (await stillInOrgWorkspace(yp, uid, domain_id, hubId)) return { left: false, reason: "still_member" };
    const prev = marker.prev_privilege == null ? 1 : ~~marker.prev_privilege;
    await yp.await_proc("org_member_leave", uid, prev);
    await notify(view, uid, {
      service: ORG_LEFT,
      domain_id,
      hub_id: hubId,
      quota: await freshQuota(yp, uid),
    });
    return { left: true, domain_id };
  } catch (e) {
    warn(view, "[org-membership] leave failed for", uid, e && e.message);
    return { left: false, reason: "error" };
  }
}

module.exports = {
  ORG_JOINED,
  ORG_LEFT,
  UNLIMITED_SEATS,
  joinRefusal,
  joinOrgOnWorkspaceJoin,
  leaveOrgOnWorkspaceLeave,
  stillInOrgWorkspace,
};
