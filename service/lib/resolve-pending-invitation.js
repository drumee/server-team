/**
 * @license
 * Copyright 2026 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3.
 * https://www.gnu.org/licenses/agpl-3.0.html
 */

const { RedisStore, utils } = require("@drumee/server-essentials");
const { isEmpty } = require("lodash");

// toArray from server-essentials, NOT lodash — lodash's turns an object into
// its values array, which mangles a single-row proc result (a list proc with
// exactly one row answers with the object itself). Same reason hub.js:52 and
// notify-member-joined.js pick it up from here.
const { toArray } = utils;
const { notifyMemberJoined } = require("./notify-member-joined");

/**
 * REDEEM EVERY WORKSPACE INVITATION HELD FOR AN EMAIL ADDRESS.
 *
 * `yp.pending_invitation` is where an invitation waits when membership could
 * not be granted at the time it was sent. Redeeming it is what actually joins
 * the person to the workspace: `add_member` writes the hub's permission row AND
 * calls `<invitee_db>.join_hub`, which is what puts the workspace under their
 * home root. Until that runs the invitee has NOTHING — `desk.home` lists their
 * home's children, and the workspace is not among them, so it is invisible on
 * their desk and stays invisible across reloads.
 *
 * WHY THIS IS A SHARED MODULE. Two byte-for-byte copies of this used to live in
 * `signup.js` and `butler.js` — the two account-creation paths — and BOTH were
 * only ever reachable at account creation. That left the case this module now
 * also serves: an invitation addressed to somebody who ALREADY has an account.
 * Nothing redeemed those, so they sat in the table forever. See the login hook
 * in `yp.js` and `scripts/redeem-orphan-invitations.js`.
 *
 * NEVER THROWS PER HUB. One unreachable workspace must not cost the caller the
 * others, and no caller (a sign-up, a login) may fail because of this — every
 * failure is warned and swallowed. Rows that could not be redeemed are LEFT IN
 * PLACE so a later attempt retries them; rows that are redeemed, expired, or
 * point at a workspace that no longer exists are cleared.
 *
 * @param {Object} svc    calling service instance — needs `yp`, `warn`, and
 *                        `payload` when `notify` is on
 * @param {String} email  the invited address
 * @param {Object} [opt]
 * @param {String} [opt.uid]     the invitee's drumate id when the caller already
 *                               holds it (a login does) — saves a lookup
 * @param {String} [opt.source]  what triggered this, for the audit line
 * @param {Boolean} [opt.notify] push over the socket + tell hub members
 *                               (default true; off for offline scripts)
 * @returns {Promise<Object>} { redeemed, failed, alreadyMember, hubs }
 */
async function resolvePendingInvitations(svc, email, opt = {}) {
  const { source = "signup", notify = true } = opt;
  const out = { redeemed: 0, failed: 0, alreadyMember: 0, hubs: [] };
  if (!svc || !svc.yp || isEmpty(email)) return out;

  const warn = (...a) => svc.warn && svc.warn("[pending-invitation]", ...a);

  // The lookup FIRST, and it is the whole cost on the common path: almost every
  // caller has no pending row, and this returns empty without touching anything
  // else. That is what makes it cheap enough to run on every login.
  let rows;
  try {
    rows = toArray(await svc.yp.await_proc("pending_invitation_get_by_email", email));
  } catch (e) {
    warn("lookup failed for", email, e && e.message);
    return out;
  }
  if (isEmpty(rows)) return out;

  let uid = opt.uid || null;
  if (!uid) {
    try {
      let user = await svc.yp.await_proc("drumate_exists", email);
      if (Array.isArray(user)) user = user[0];
      uid = user && user.id;
    } catch (e) {
      warn("drumate_exists failed for", email, e && e.message);
      return out;
    }
  }
  // No account yet — the invitation is not orphaned, it is simply still
  // waiting. Leave every row where it is: account creation redeems them.
  if (!uid) return out;

  const { writeAudit } = require("../private/_audit");
  const now = Math.floor(Date.now() / 1000);
  // Rows we are done with, redeemed or not — see the delete at the bottom.
  let unresolved = 0;

  for (const row of rows) {
    const hub_id = row && row.hub_id;
    if (!hub_id) continue;
    try {
      // ⚠️ UNITS. `pending_invitation.expiry_time` holds an ABSOLUTE unix
      // timestamp (yp_add_pending_invitation converts the caller's hours with
      // TIMESTAMPADD before storing), while `add_member` and `permission_grant`
      // both take HOURS FROM NOW and do that same conversion themselves.
      // Handing the stored value straight to them — which both old copies of
      // this code did — asks for a grant expiring in ~1.8 billion hours. It
      // errs open so nothing was ever reported, but it is not what the inviter
      // set, and it is why this converts back.
      const stored = ~~row.expiry_time;
      if (stored && stored <= now) {
        // Expired before it was ever redeemed. Nothing to grant; the row is
        // cleared with the rest so it stops being retried.
        continue;
      }
      const hours = stored ? Math.max(1, Math.ceil((stored - now) / 3600)) : 0;

      const db_name = await svc.yp.await_func("get_db_name", hub_id);
      if (!db_name) {
        // The workspace is gone. Stale row, not a failure — clearing it is the
        // repair, and keeping it would mean retrying a dead hub on every login.
        warn("no db_name for hub", hub_id, "— dropping stale invitation");
        continue;
      }

      // 🚨 DO NOT WALK OVER A MEMBERSHIP THAT ALREADY WORKS.
      //
      // A pending row is deleted only when it is redeemed, so a STALE one can
      // sit beside a membership that was later granted properly through
      // `hub.invite` — and this runs on every login. Re-granting from the stale
      // row would write ITS privilege over the live one (an admin re-invited at
      // 15 would be demoted back to the 4 the old invitation carried), and
      // `add_member` also re-runs `join_hub`, whose REPLACE re-derives the
      // home-root row's filename through `unique_filename` and resets its rank
      // — renaming and reshuffling a workspace the user has had for months.
      //
      // So: already in, and the workspace already sitting under their home root
      // → nothing to repair, just clear the row. `state` is read rather than
      // assumed because "has permission" and "can see it" are two different
      // writes inside add_member, and a half-applied one is exactly what this
      // module exists to finish.
      const state = await _membership(svc, db_name, hub_id, uid, warn);
      if (state.permission > 0 && state.visible) {
        out.alreadyMember++;
        continue;
      }
      // Never downgrade on the repair path either: a live grant that is higher
      // than the invitation's wins.
      const permission = Math.max(~~row.permission, state.permission);

      const r = await svc.yp.await_proc(
        `${db_name}.add_member`, uid, permission, hours
      );
      // add_member answers with a db_name-carrying row only when it actually
      // wrote the membership; anything else means it bailed (an unknown member,
      // or the hub inviting itself) and permission_grant below would create a
      // grant with no membership behind it.
      if (!r || !r.db_name) {
        warn("add_member wrote nothing for", uid, "on hub", hub_id);
        unresolved++;
        out.failed++;
        continue;
      }

      await svc.yp.await_proc(
        `${db_name}.permission_grant`,
        "*", uid, hours, permission, "system",
        `Resolved from pending_invitation (${source})`
      );

      // Chat upload, the same grant `hub._grantMembership` makes. Neither old
      // copy of this code made it, so a member who arrived through a pending
      // invitation could not attach a file in the workspace chat.
      try {
        const mfs_home = await svc.yp.await_proc(`${db_name}.mfs_home`);
        if (mfs_home && mfs_home.chat_upload_id) {
          await svc.yp.await_proc(
            `${db_name}.permission_grant`,
            mfs_home.chat_upload_id, uid, 0, 4,
            "no_traversal", "chat upload permission"
          );
        }
      } catch (e) {
        warn("chat upload grant failed for hub", hub_id, e && e.message);
      }

      await writeAudit(svc, {
        db: db_name,
        uid,
        action: "invite_accepted",
        category: "member",
        notify_to: "admin",
        entity_id: hub_id,
        log: `Invite accepted — ${email} joined the workspace (${source})`,
      });

      // The notification row the invitee reads in the bell. Written by
      // `_grantMembership` on the immediate-grant path and by nothing at all on
      // this one, so a redeemed invitation used to arrive with no trace: the
      // workspace simply appeared.
      //
      // AUTHORED BY THE WORKSPACE OWNER, not by whoever sent the invitation:
      // `pending_invitation` stores only (hub_id, email, permission, expiry),
      // so the inviter is not recoverable here. The owner is the truthful
      // stand-in — the row must name SOMEBODY, and naming the invitee (the only
      // id in hand) would render as "you invited yourself". Skipped rather than
      // faked when even the owner cannot be read.
      try {
        // A plain read, not `get_hub`: that proc is keyed by vhost and takes a
        // visitor as its second argument, so it answers nothing useful here.
        let info = typeof svc.yp.await_query !== "function" ? null : await svc.yp.await_query(
          "SELECT owner_id, name FROM hub WHERE id=?", hub_id
        );
        if (Array.isArray(info)) info = info[0];
        const author = info && info.owner_id;
        if (author) {
          await svc.yp.await_proc(
            "contact_log_activity", author, uid, "hub_invite_received",
            {
              hub_id,
              hub_name: (info && info.name) || null,
              permission,
            }
          );
        }
      } catch (e) {
        warn("activity log failed for hub", hub_id, e && e.message);
      }

      out.redeemed++;
      out.hubs.push(hub_id);

      if (notify) await _push(svc, db_name, hub_id, uid, warn);
    } catch (err) {
      unresolved++;
      out.failed++;
      warn("failed for hub", hub_id, err && err.message);
    }
  }

  if (!out.redeemed) {
    // Nothing was granted, which is not the same as nothing being resolved: the
    // rows may all have been expired, stale, or already honoured. Those are
    // finished with. A FAILURE is not — and there is no per-row delete, so the
    // blanket one is only safe when no row still wants retrying.
    if (!unresolved) await _clear(svc, email, warn);
    return out;
  }

  // Viral loop: one acceptance stamps every row still open for the address, so
  // it runs once rather than per hub — and BEFORE the delete below, which
  // erases the only other evidence the invitations existed. Never throws: an
  // uncounted acceptance beats a join that reports failure.
  try {
    await svc.yp.await_proc("invite_track_accept", email, uid);
  } catch (e) {
    warn("invite tracking failed for", email, e && e.message);
  }

  // The rollup counts live permission rows, so it is refreshed after the grants
  // — the crawl and these writers have to agree.
  for (const hub_id of out.hubs) {
    try {
      await svc.yp.await_proc("workspace_members_set", hub_id);
    } catch (e) {
      warn("member tracking failed for", hub_id, e && e.message);
    }
  }

  if (!unresolved) await _clear(svc, email, warn);
  return out;
}

/**
 * What the invitee already has in this workspace.
 *
 * TWO SEPARATE FACTS, because `add_member` writes them into two different
 * databases and a half-applied one is exactly what this module repairs:
 *
 *   permission — the membership row in the HUB's permission table
 *                (`resource_id = '*'`), which is what `user_permission` reads
 *                and what `mfs_show_node_by` filters `privilege > 0` on.
 *   visible    — the hub's row under the invitee's own home root, written by
 *                `join_hub`. Without it `desk.home` has nothing to list, so the
 *                workspace does not appear however good the permission is.
 *
 * Read directly rather than through `user_permission`: that function walks
 * parents and falls back to the anonymous grants, so it answers > 0 for a
 * public workspace nobody was ever added to. Here the question is strictly
 * "does this person hold a membership row".
 *
 * A read that fails answers "nothing" — which sends the caller down the grant
 * path. That is the safe direction: the same hub DB is about to be written
 * anyway, so a failure here surfaces there as a failure rather than as a
 * silently skipped repair.
 */
async function _membership(svc, db_name, hub_id, uid, warn) {
  const state = { permission: 0, visible: false };
  if (typeof svc.yp.await_query !== "function") return state;
  try {
    let row = await svc.yp.await_query(
      `SELECT permission FROM \`${db_name}\`.permission
        WHERE resource_id='*' AND entity_id=? LIMIT 1`, uid
    );
    if (Array.isArray(row)) row = row[0];
    state.permission = ~~(row && row.permission);
  } catch (e) {
    warn("membership read failed for hub", hub_id, e && e.message);
    return state;
  }
  if (!state.permission) return state;
  try {
    const own_db = await svc.yp.await_func("get_db_name", uid);
    if (!own_db) return state;
    let row = await svc.yp.await_query(
      `SELECT id FROM \`${own_db}\`.media WHERE id=? LIMIT 1`, hub_id
    );
    if (Array.isArray(row)) row = row[0];
    state.visible = !!(row && row.id);
  } catch (e) {
    warn("home-root read failed for hub", hub_id, e && e.message);
  }
  return state;
}

/**
 * Tell the invitee's own live session, then the workspace's other members.
 *
 * `hub.invite_received` is what the desk listens for — the sidebar restarts its
 * list on it and the topbar switcher resyncs (ui-team desk/index.js
 * `_onWorkspaceWsEvent`, desk/workspace-list `handleWsEvent`) — so an invitation
 * redeemed while the recipient is looking at the desk lands without a reload.
 */
async function _push(svc, db_name, hub_id, uid, warn) {
  try {
    if (typeof svc.payload !== "function") return;
    const hub = await svc.yp.await_proc(`${db_name}.mfs_access_node`, uid, hub_id);
    if (hub) {
      hub.ownpath = "/";
      hub.hub_id = hub.actual_hub_id;
      hub.db_name = hub.actual_db;
      const sockets = await svc.yp.await_proc("user_sockets", uid);
      await RedisStore.sendData(
        svc.payload(hub, { service: "hub.invite_received" }), sockets
      );
      await RedisStore.sendData(
        svc.payload(hub, { service: "hub.add_contributors" }), sockets
      );
    }
  } catch (e) {
    warn("ws notify failed for hub", hub_id, e && e.message);
  }
  // Any admin with the member matrix open refetches instead of showing a list
  // that is missing the person who just joined.
  await notifyMemberJoined(svc, hub_id, uid);
}

async function _clear(svc, email, warn) {
  try {
    await svc.yp.await_proc("pending_invitation_delete_by_email", email);
  } catch (e) {
    warn("cleanup failed for", email, e && e.message);
  }
}

module.exports = { resolvePendingInvitations };
