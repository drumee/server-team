/**
 * @license
 * Copyright 2026 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3.
 * https://www.gnu.org/licenses/agpl-3.0.html
 */

const { RedisStore, utils } = require("@drumee/server-essentials");
const { isEmpty } = require("lodash");

// toArray comes from server-essentials' utils, NOT lodash — lodash's toArray
// turns an object into its values array, which would silently mangle the
// entity_sockets row set. Mirrors hub.js:52 `const { toArray } = utils`.
const { toArray } = utils;

/**
 * Tell every online member of a hub that someone just joined, so any open
 * permission matrices (Folder settings) refetch instead of showing a member
 * list that is missing the person who was just invited/added.
 *
 * Callable from any service context — including anonymous-scope ones like
 * hub.accept_invite that have no this.hub / this.db — because hub_id is passed
 * in rather than read off the service.
 *
 * The joiner's own sockets are NOT excluded here: entity_sockets' `exclude`
 * arg splices JSON array items straight into `s.id NOT IN (...)`, and
 * user_sockets returns rows ({cookie,uid,socket_id}) rather than bare ids, so
 * passing them through would emit broken SQL. The receiving window drops its
 * own echo instead (folder/index.js _onMemberJoined guards data.uid === Visitor.id).
 *
 * Never throws: a failed notification must not fail the join itself — every
 * call site is reached only after add_member/permission_grant have committed.
 *
 * @param {object} svc      service instance (needs .yp, .payload, .warn)
 * @param {string} hub_id   hub the member joined
 * @param {string} uid      the joiner's drumate id (may be null/undefined for
 *                          admin-driven multi-adds where there is no single
 *                          joiner to echo)
 */
async function notifyMemberJoined(svc, hub_id, uid) {
  if (!svc || !hub_id) return;
  try {
    const dest = toArray(await svc.yp.await_proc("entity_sockets", hub_id));
    if (isEmpty(dest)) return;
    await RedisStore.sendData(
      svc.payload({ hub_id, uid }, { service: "hub.member_joined" }),
      dest
    );
  } catch (e) {
    if (svc.warn) {
      svc.warn("[notifyMemberJoined] failed for hub", hub_id, e && e.message);
    }
  }
}

/**
 * Tell every online member of a hub that EXISTING memberships changed — a role
 * was set (hub.set_privilege) or members were removed (hub.delete_contributor)
 * — so open permission matrices refetch.
 *
 * Both services already push to the member being changed, and only to them:
 * that drives the changed member's own windows. The matrices belong to
 * everybody ELSE looking at the list, and before this nothing reached them —
 * an admin kept seeing the old role, or the removed member, until they
 * reopened the panel.
 *
 * One push per request, sent after the per-member writes, so a refetch reads
 * committed rows. The acting admin receives it too and simply refetches what
 * they already drew — no echo guard, for the reason given on
 * notifyMemberJoined above.
 *
 * Never throws: every call site has already committed the change.
 *
 * @param {object} svc      service instance (needs .yp, .payload, .warn)
 * @param {string} hub_id   hub whose membership changed
 * @param {object} change
 * @param {string} change.change  "privilege" | "removed"
 * @param {string|string[]} change.users  the affected member ids
 */
async function notifyMembersChanged(svc, hub_id, { change, users } = {}) {
  if (!svc || !hub_id) return;
  try {
    const dest = toArray(await svc.yp.await_proc("entity_sockets", hub_id));
    if (isEmpty(dest)) return;
    await RedisStore.sendData(
      svc.payload(
        { hub_id, change, users: toArray(users) },
        { service: "hub.members_changed" }
      ),
      dest
    );
  } catch (e) {
    if (svc.warn) {
      svc.warn("[notifyMembersChanged] failed for hub", hub_id, e && e.message);
    }
  }
}

/**
 * Tell every online member of a hub that one of its INVITATIONS was answered
 * (accepted or declined), so an open Access panel re-reads its Pending
 * Invitations section.
 *
 * A decline changes no membership, so neither push above fires for it — the
 * admin's panel kept showing "Pending" until it was reopened. An accept that
 * grants also sends hub.member_joined; this one is still sent, because an
 * accept by somebody who already held the access grants nothing and would
 * otherwise leave the pending line behind too.
 *
 * The payload is the workspace id alone: who answered, and how, is read back
 * through hub.invitations, which is admin-gated — every member's socket gets
 * this push, and it must not carry anybody's email.
 *
 * Never throws: every call site has already recorded the answer.
 *
 * @param {object} svc      service instance (needs .yp, .payload, .warn)
 * @param {string} hub_id   hub whose invitation was answered
 */
async function notifyInvitationsChanged(svc, hub_id) {
  if (!svc || !hub_id) return;
  try {
    const dest = toArray(await svc.yp.await_proc("entity_sockets", hub_id));
    if (isEmpty(dest)) return;
    await RedisStore.sendData(
      svc.payload({ hub_id }, { service: "hub.invitations_changed" }),
      dest
    );
  } catch (e) {
    if (svc.warn) {
      svc.warn("[notifyInvitationsChanged] failed for hub", hub_id, e && e.message);
    }
  }
}

module.exports = { notifyMemberJoined, notifyMembersChanged, notifyInvitationsChanged };
