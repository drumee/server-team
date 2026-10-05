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

test("_holdsOwner reads the owner bit off the '*' row", () => {
  const src = body("_holdsOwner");
  assert.match(src, /_hubPermission\(/);
  assert.match(src, /CAN_OWN/);
});
