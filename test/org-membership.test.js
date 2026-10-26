// Organisation membership that follows workspace membership
// (service/lib/org-membership.js).
//
// THE REPORT (2026-10-25): a paid Team's owner invites people into their
// workspaces, the people accept, and every one of them stays on their own Free
// plan. The Admin Console still shows one member, and the seat each invitation
// had reserved is released the moment it is accepted -- on prod a 10-seat org
// had 22 people working in its workspaces, another had 251.
//
// Plan, storage and seats all key on drumate.domain_id, which only the owner
// path and the admin console's member_add ever set. These lock down the rule
// that now connects the two: accepting into an INTERNAL workspace of an
// organisation makes a personal Free account a member of it (seat + plan),
// everybody else stays a guest, and leaving the last internal workspace undoes
// exactly that move.
//
// Run: node --test test/org-membership.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const lib = require("../service/lib/org-membership");

const UID = "bbbb1111bbbb1112";
const HUB = "hhhh1111hhhh1112";
const QUOTA = { plan: "team", seat: 10, disk: 100 };

// What org_join_context answers for the plain case: an internal workspace of
// a Team org with seats to spare, a personal Free account with nothing of its
// own.
const BASE = {
  hub_type: "hub", hub_area: "private", hub_dom: 7, hub_status: "active", hub_owner_id: "owner",
  acc_domain_id: 1, acc_username: "bob", acc_category: null, acc_status: "active", acc_org_join: null,
  org_id: "org7", org_name: "Zert", org_owner_id: "owner",
  seat: 10, members: 3, own_plan: 0, username_taken: 0, prev_privilege: 1,
};

function fakeView(ctx, opt = {}) {
  const calls = [];
  const view = {
    yp: {
      await_proc: async (name, ...args) => {
        calls.push([name, ...args]);
        if (opt.throwOn && opt.throwOn === name) throw new Error("db down");
        switch (name) {
          case "org_join_context": return [ctx];
          case "org_member_join":
          case "org_member_leave": return [{ id: args[0] }];
          case "org_workspaces": return opt.orgHubs || [];
          case "forward_proc": return opt.myHubs || [];
          default: return {};
        }
      },
      await_func: async () => JSON.stringify(QUOTA),
    },
    notify_user: async (uid, data) => { calls.push(["notify", uid, data]); },
    warn: () => {},
  };
  return { view, calls };
}

const names = (calls) => calls.map((c) => c[0]);

test("accepting into an internal org workspace makes a Free account an org member", async () => {
  const { view, calls } = fakeView({ ...BASE });
  const r = await lib.joinOrgOnWorkspaceJoin(view, UID, HUB);
  assert.deepEqual(r, { joined: true, domain_id: 7, org_id: "org7" });
  // The move: domain 7, this workspace, the privilege tier to restore later.
  assert.deepEqual(calls.find((c) => c[0] === "org_member_join"), ["org_member_join", UID, 7, HUB, 1]);
  // The desk is told, with the fresh entitlement, so it can reload onto the plan.
  const n = calls.find((c) => c[0] === "notify");
  assert.equal(n[1], UID);
  assert.equal(n[2].service, "hub.org_joined");
  assert.equal(n[2].org_name, "Zert");
  assert.deepEqual(n[2].quota, QUOTA);
});

test("an External workspace only ever holds guests", async () => {
  const { view, calls } = fakeView({ ...BASE, hub_area: "share" });
  const r = await lib.joinOrgOnWorkspaceJoin(view, UID, HUB);
  assert.deepEqual(r, { joined: false, reason: "external_workspace" });
  assert.ok(!names(calls).includes("org_member_join"));
  assert.ok(!names(calls).includes("notify"));
});

test("a folder on somebody's home desk is not a workspace", async () => {
  const { view, calls } = fakeView({ ...BASE, hub_type: "drumate" });
  assert.equal((await lib.joinOrgOnWorkspaceJoin(view, UID, HUB)).reason, "external_workspace");
  assert.ok(!names(calls).includes("org_member_join"));
});

test("a personal workspace (domain 1) has no organisation to join", async () => {
  const { view, calls } = fakeView({ ...BASE, hub_dom: 1, org_id: null });
  assert.equal((await lib.joinOrgOnWorkspaceJoin(view, UID, HUB)).reason, "personal_workspace");
  assert.ok(!names(calls).includes("org_member_join"));
});

test("who stays a guest: already a member, in another org, own plan, system, inactive", async () => {
  const cases = [
    [{ acc_domain_id: 7 }, "already_member"],
    [{ acc_domain_id: 3 }, "other_organisation"],
    [{ own_plan: 1 }, "own_plan"],
    [{ acc_category: "system" }, "system_account"],
    [{ acc_status: "frozen" }, "account_inactive"],
    [{ hub_status: "archived" }, "workspace_inactive"],
    [{ username_taken: 1 }, "username_taken"],
    [{ acc_domain_id: null }, "no_account"],
    [{ org_id: null }, "no_organisation"],
  ];
  for (const [patch, reason] of cases) {
    const { view, calls } = fakeView({ ...BASE, ...patch });
    const r = await lib.joinOrgOnWorkspaceJoin(view, UID, HUB);
    assert.equal(r.joined, false, reason);
    assert.equal(r.reason, reason);
    assert.ok(!names(calls).includes("org_member_join"), reason);
  }
});

test("seats: a full plan refuses, unlimited and uncapped plans do not", async () => {
  let v = fakeView({ ...BASE, seat: 10, members: 10 });
  assert.equal((await lib.joinOrgOnWorkspaceJoin(v.view, UID, HUB)).reason, "seat_limit");
  assert.ok(!names(v.calls).includes("org_member_join"));
  // Free org: 3 seats, owner + 2 members -> the third accept is refused.
  v = fakeView({ ...BASE, seat: 3, members: 3 });
  assert.equal((await lib.joinOrgOnWorkspaceJoin(v.view, UID, HUB)).reason, "seat_limit");
  v = fakeView({ ...BASE, seat: 3, members: 2 });
  assert.equal((await lib.joinOrgOnWorkspaceJoin(v.view, UID, HUB)).joined, true);
  // Business: the unlimited sentinel.
  v = fakeView({ ...BASE, seat: 100000, members: 500 });
  assert.equal((await lib.joinOrgOnWorkspaceJoin(v.view, UID, HUB)).joined, true);
  // No seat figure at all = no cap (same reading as hub._seatBudget).
  v = fakeView({ ...BASE, seat: null, members: 500 });
  assert.equal((await lib.joinOrgOnWorkspaceJoin(v.view, UID, HUB)).joined, true);
});

test("a database failure never fails the workspace grant that just happened", async () => {
  const { view } = fakeView({ ...BASE }, { throwOn: "org_member_join" });
  assert.deepEqual(await lib.joinOrgOnWorkspaceJoin(view, UID, HUB), { joined: false, reason: "error" });
  const broken = fakeView({ ...BASE }, { throwOn: "org_join_context" });
  assert.deepEqual(await lib.joinOrgOnWorkspaceJoin(broken.view, UID, HUB), { joined: false, reason: "error" });
  assert.deepEqual(await lib.joinOrgOnWorkspaceJoin(null, UID, HUB), { joined: false, reason: "bad_call" });
});

const JOINED = {
  ...BASE,
  acc_domain_id: 7,
  acc_org_join: JSON.stringify({ source: "workspace", hub_id: HUB, domain_id: 7, prev_privilege: 3, since: 1 }),
};

test("leaving the last internal workspace of the org returns the account to personal", async () => {
  const { view, calls } = fakeView(JOINED, {
    orgHubs: [{ id: HUB, area: "private" }, { id: "other-ws", area: "share" }],
    myHubs: [{ id: HUB }, { id: "other-ws" }],
  });
  const r = await lib.leaveOrgOnWorkspaceLeave(view, UID, HUB);
  assert.deepEqual(r, { left: true, domain_id: 7 });
  // Back to domain 1 with the tier it had before the move.
  assert.deepEqual(calls.find((c) => c[0] === "org_member_leave"), ["org_member_leave", UID, 3]);
  const n = calls.find((c) => c[0] === "notify");
  assert.equal(n[2].service, "hub.org_left");
  assert.deepEqual(n[2].quota, QUOTA);
});

test("still in another internal workspace of the org: stays a member", async () => {
  const { view, calls } = fakeView(JOINED, {
    orgHubs: [{ id: HUB, area: "private" }, { id: "ws2", area: "private" }],
    myHubs: [{ id: "ws2" }],
  });
  assert.deepEqual(await lib.leaveOrgOnWorkspaceLeave(view, UID, HUB), { left: false, reason: "still_member" });
  assert.ok(!names(calls).includes("org_member_leave"));
});

test("another internal workspace exists but they are not in it: leaves", async () => {
  const { view, calls } = fakeView(JOINED, {
    orgHubs: [{ id: "ws2", area: "private" }],
    myHubs: [{ id: "their-own-personal-ws" }],
  });
  assert.equal((await lib.leaveOrgOnWorkspaceLeave(view, UID, HUB)).left, true);
  assert.ok(names(calls).includes("org_member_leave"));
});

test("who is never moved out: admin-created members, personal accounts, moved-since", async () => {
  const cases = [
    [{ ...BASE, acc_domain_id: 7, acc_org_join: null }, "not_workspace_member"],
    [{ ...BASE, acc_domain_id: 7, acc_org_join: JSON.stringify({ source: "admin" }) }, "not_workspace_member"],
    [{ ...BASE, acc_domain_id: 1 }, "personal_account"],
    [{ ...JOINED, acc_domain_id: 9 }, "moved_since"],
    [{ ...JOINED, acc_domain_id: null }, "no_account"],
  ];
  for (const [ctx, reason] of cases) {
    const { view, calls } = fakeView(ctx);
    const r = await lib.leaveOrgOnWorkspaceLeave(view, UID, HUB);
    assert.deepEqual(r, { left: false, reason }, reason);
    assert.ok(!names(calls).includes("org_member_leave"), reason);
  }
});

test("a database failure on leave is reported, not thrown", async () => {
  const { view } = fakeView(JOINED, { throwOn: "org_workspaces" });
  assert.deepEqual(await lib.leaveOrgOnWorkspaceLeave(view, UID, HUB), { left: false, reason: "error" });
});

// Every path that grants or drops workspace membership calls the hook. Read
// from the sources, so a refactor that drops one is caught here.
const src = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

test("every workspace-membership path is wired", () => {
  const hub = src("service/private/hub.js");
  // accept_invite: joined BEFORE the token is spent, and reported in the reply.
  const accept = hub.slice(hub.indexOf("async accept_invite()"), hub.indexOf("async _closeInvitation("));
  assert.ok(accept.indexOf("joinOrgOnWorkspaceJoin(this, this.uid, hub_id)") > 0);
  // The token is marked accepted twice in accept_invite: once in the
  // already-a-member early return, once after the real grant. The join sits
  // before the second one.
  assert.ok(accept.indexOf("joinOrgOnWorkspaceJoin(") < accept.lastIndexOf("'token_hub_invite_set_status', secret, 'accepted'"));
  assert.ok(accept.indexOf("joinOrgOnWorkspaceJoin(") > accept.indexOf("'token_hub_invite_set_status', secret, 'accepted'"));
  assert.match(accept, /joined_org: org && org\.joined \? 1 : 0/);
  // add_contributors (through _grantMembership) and invite_with_roles.
  const grant = hub.slice(hub.indexOf("async _grantMembership("), hub.indexOf("async _contactBookContext("));
  assert.ok(grant.indexOf("joinOrgOnWorkspaceJoin(this, uid, this.hub.get(Attr.id))") > 0);
  const roles = hub.slice(hub.indexOf("async invite_with_roles()"), hub.indexOf("async delete_hub()"));
  assert.ok(roles.indexOf("joinOrgOnWorkspaceJoin(this, uid, hub_id)") > 0);
  // Removal by an admin.
  const del = hub.slice(hub.indexOf("async delete_contributor()"), hub.indexOf("async set_member_privilege()"));
  assert.ok(del.indexOf("leaveOrgOnWorkspaceLeave(this, uid, hub_id)") > del.indexOf(".leave_hub`, hub_id)"));
  // Leaving on one's own.
  const desk = src("service/private/desk.js");
  const leave = desk.slice(desk.indexOf("async leave_hub()"), desk.indexOf("create_account()"));
  assert.ok(leave.indexOf("leaveOrgOnWorkspaceLeave(this, this.uid, hub_id)") > leave.indexOf("await_proc('leave_hub', hub_id)"));
  // Both signup resolvers.
  for (const f of ["service/butler.js", "service/signup.js"]) {
    const s = src(f);
    const r = s.slice(s.indexOf("async _resolve_pending_invitation("));
    assert.ok(r.indexOf("joinOrgOnWorkspaceJoin(this, newUser.id, hub_id)") > r.indexOf("permission_grant`"), f);
  }
});

test("the upload gate measures against the workspace owner's allowance", () => {
  const media = src("service/media.js");
  const gate = media.slice(media.indexOf("async chekcDiskLimit()"), media.indexOf("async before_store("));
  assert.match(gate, /const payer = \(this\.hub && this\.hub\.get && this\.hub\.get\(Attr\.owner_id\)\) \|\| this\.uid;/);
  assert.match(gate, /await_proc\("get_quota", payer\)/);
  assert.equal((gate.match(/await_proc\("disk_usage", payer\)/g) || []).length, 2);
  assert.ok(!/await_proc\("(get_quota|disk_usage)", this\.uid\)/.test(gate));
});
