#!/usr/bin/env node

// The owner's '*' row is written by change_owner and hub creation only.
//
// THE REPORT: a workspace owner was offered "Leave workspace" in the Access
// panel. yp.hub.owner_id still named them, but their permission row had lost
// the owner bit — re-inviting their address ran add_member, which REPLACEs the
// row (63 -> 7), and picking a role on their row ran permission_set (63 -> 31).
// The workspace was left with no owner at all.
//
// These lock what the fix rests on:
//
//   1. CAN_OWN is the owner bit (32), set on 63 and on no other role;
//   2. every member-management path asks _holdsOwner BEFORE its write.
//
// Dependency-free, like chat-upload-grant.test.js: member-capability.js
// requires nothing, and hub.js is read as text, so this runs on a stock runner.

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const { CAN_OWN, privilegeAllows } = require("../../service/lib/member-capability");

const HUB = readFileSync(join(__dirname, "../../service/private/hub.js"), "utf8");

/** The source of one method, from its declaration to the next one. */
function body(name) {
  const start = HUB.search(new RegExp(`\\n  (async )?${name}\\(`));
  assert.ok(start > 0, `${name} not found in hub.js`);
  const next = HUB.slice(start + 1).search(/\n  (async )?[A-Za-z_]+\([^)]*\) \{/);
  return next < 0 ? HUB.slice(start) : HUB.slice(start, start + 1 + next);
}

test("CAN_OWN is the owner bit and only the owner role carries it", () => {
  assert.equal(CAN_OWN, 32);
  assert.equal(privilegeAllows(63, CAN_OWN), true);
  for (const role of [31, 15, 7, 3, 0]) {
    assert.equal(privilegeAllows(role, CAN_OWN), false, `role ${role}`);
  }
});

test("each member write asks _holdsOwner before writing", () => {
  const cases = [
    ["_grantMembership", '"add_member"'],
    ["invite_with_roles", ".add_member`"],
    ["set_privilege", '"permission_set"'],
    ["set_member_privilege", '"permission_grant"'],
  ];
  for (const [method, write] of cases) {
    const src = body(method);
    const guard = src.indexOf("this._holdsOwner(");
    const call = src.indexOf(write);
    assert.ok(guard > 0, `${method}: no _holdsOwner guard`);
    assert.ok(call > 0, `${method}: write ${write} not found`);
    assert.ok(guard < call, `${method}: guard must come before ${write}`);
  }
});

test("_holdsOwner reads the owner bit off the '*' row (lib/hub-owner)", async () => {
  assert.match(body("_holdsOwner"), /holdsHubOwner\(/);
  const { hubWildcardPermission, holdsHubOwner } = require("../../service/lib/hub-owner");
  const yp = (perm) => ({ await_query: async () => [{ permission: perm }] });
  assert.equal(await holdsHubOwner(yp(63), "hub_db", "u"), true);
  for (const p of [31, 15, 7, 3, 0]) {
    assert.equal(await holdsHubOwner(yp(p), "hub_db", "u"), false, `perm ${p}`);
  }
  // An odd db name is never interpolated, and any failure reads as 0.
  let asked = false;
  const spy = { await_query: async () => { asked = true; return [{ permission: 63 }]; } };
  assert.equal(await hubWildcardPermission(spy, "x`; DROP", "u"), 0);
  assert.equal(asked, false);
  const broken = { await_query: async () => { throw new Error("down"); } };
  assert.equal(await hubWildcardPermission(broken, "hub_db", "u"), 0);
});

test("delete_contributor never removes the owner", () => {
  const src = body("delete_contributor");
  const guard = src.indexOf("this._holdsOwner(");
  const leave = src.indexOf(".leave_hub`");
  assert.ok(guard > 0 && leave > 0 && guard < leave);
  assert.match(src, /OWNER_CANNOT_BE_REMOVED/);
});

test("change_owner only hands over to an active member", () => {
  const src = body("change_owner");
  const check = src.indexOf("NEW_OWNER_MUST_BE_ACTIVE_MEMBER");
  const call = src.indexOf('"change_owner"');
  assert.ok(check > 0 && call > 0 && check < call);
  assert.match(src, /status === "active"/);
  assert.match(src, /_hubPermission\(/);
});

test("desk.leave_hub refuses the owner before anything is pushed", () => {
  const DESK = readFileSync(join(__dirname, "../../service/private/desk.js"), "utf8");
  const start = DESK.indexOf("\n  async leave_hub(");
  assert.ok(start > 0);
  const src = DESK.slice(start, DESK.indexOf("\n  }\n", start));
  const guard = src.indexOf("holdsHubOwner(");
  for (const effect of ["user_sockets", "changelog_write", "sendData", "'leave_hub'"]) {
    const at = src.indexOf(effect);
    assert.ok(at > 0, `${effect} not found`);
    assert.ok(guard > 0 && guard < at, `guard must come before ${effect}`);
  }
  assert.match(src, /OWNER_CANNOT_LEAVE/);
});
