#!/usr/bin/env node

// Who may write to the chat staging folder, and with what value.
//
// THE REPORT: a member whose workspace role is Chat could not attach a file in
// chat. The upload answered 403 and the chat showed nothing at all -- no
// attachment chip, no error -- while the same account attached files normally
// in a workspace where it happened to be an admin.
//
// An attachment stages in the hidden folder '/__chat__/__upload__' before it
// becomes a message. A chat member has no write bit for the workspace, which is
// intended, so the membership paths give write on that one folder through a
// grant written with assign_via 'no_traversal'. Two things were wrong: the
// value granted was 4, which meant write before the permission bits were
// renumbered and means download now, and the grant went out regardless of role,
// so view-only members held it too.
//
// These lock the two properties the fix rests on, both of which can be undone
// by an edit that looks like a simplification:
//
//   1. the gate admits a role that may chat and refuses one that may not;
//   2. the granted value carries the write bit, and does not come from the
//      package, whose 1.3.6 release republished the pre-1.3.0 layout.
//
// Deliberately dependency-free: member-capability.js requires nothing, and the
// call sites are read as text, so this runs on a stock runner with no install.

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const {
  CAN_CHAT,
  CAN_WRITE,
  CAN_READ,
  CHAT_UPLOAD_GRANT,
  privilegeAllows,
} = require("../../service/lib/member-capability");

// The stored privilege for each role selector the UI offers.
const VIEW = 0b000011;
const CHAT = 0b000111;
const EDIT = 0b001111;
const ADMIN = 0b011111;
const OWNER = 0b111111;

test("the gate refuses a view-only member", () => {
  assert.equal(privilegeAllows(VIEW, CAN_CHAT), false,
    "a member who may only read must not be given write on the chat staging "
    + "folder; the grant used to go out regardless of role, so rows for "
    + "view-only members already exist in the wild");
});

test("the gate admits every role at or above chat", () => {
  for (const [name, privilege] of [
    ["chat", CHAT], ["edit", EDIT], ["admin", ADMIN], ["owner", OWNER],
  ]) {
    assert.equal(privilegeAllows(privilege, CAN_CHAT), true,
      `${name} may chat and must be able to attach a file`);
  }
});

// The trap the gate exists to avoid. `Constants.permission.chat` is 0b0000110 --
// read OR download -- so it OVERLAPS read, and a loose `privilege & chat` is
// truthy for a view-only member (3 & 6 = 2). privilegeAllows asks for every bit
// of the mask, so the overlap is not enough.
test("a multi-bit mask that overlaps read still refuses a view-only member", () => {
  const READ_OR_DOWNLOAD = 0b0000110;
  assert.notEqual(VIEW & READ_OR_DOWNLOAD, 0,
    "the premise: the loose form would admit a view-only member here");
  assert.equal(privilegeAllows(VIEW, READ_OR_DOWNLOAD), false,
    "privilegeAllows must require the whole mask, not a partial overlap");
});

test("the granted value carries the write bit", () => {
  assert.equal((CHAT_UPLOAD_GRANT & CAN_WRITE) === CAN_WRITE, true,
    "without the write bit the upload ACL refuses and the member gets the "
    + "same silent 403 this change exists to fix");
  assert.equal((CHAT_UPLOAD_GRANT & CAN_READ) === CAN_READ, true,
    "the member has to read the staging folder as well as write to it");
});

// server-essentials 1.3.6 republished the pre-1.3.0 layout: Privilege.WRITE
// resolves to 7 there and to 15 under the pinned 1.3.1. package.json asks for
// ^1.3.1, so reading the value from the package means a dependency bump nobody
// connects to chat silently removes the write bit again.
test("the granted value is not the value the republished package would give", () => {
  assert.notEqual(CHAT_UPLOAD_GRANT, 0b0000111,
    "0b0000111 is Privilege.WRITE under server-essentials 1.3.6 and carries "
    + "no write bit in this schema");
});

// The gate has to sit at the call site. A check one layer up is not the same
// invariant: three separate paths grant this row, and each has its own idea of
// where `privilege` comes from.
const HUB_SOURCE = readFileSync(
  join(__dirname, "..", "..", "service", "private", "hub.js"),
  "utf8"
);

test("every chat staging grant in hub.js is gated at the call site", () => {
  const lines = HUB_SOURCE.split("\n");
  const sites = [];
  lines.forEach((line, i) => {
    if (line.includes("chat_upload_id") && !line.trim().startsWith("*")) {
      sites.push(i);
    }
  });
  assert.ok(sites.length >= 3,
    `expected the three membership paths to grant this row, found ${sites.length}`);

  for (const i of sites) {
    const window = lines.slice(Math.max(0, i - 12), i + 2).join("\n");
    const isGrant = window.includes("permission_grant");
    if (!isGrant) continue;
    assert.ok(
      window.includes("CAN_CHAT") && window.includes("privilegeAllows"),
      `the permission_grant near line ${i + 1} writes the chat staging row `
      + "without a chat-bit check above it"
    );
    assert.ok(
      !/,\s*4\s*,/.test(window),
      `the permission_grant near line ${i + 1} still passes a bare 4, the `
      + "value that means download since the bits were renumbered"
    );
  }
});

test("a role change gives the row back and takes it away", () => {
  const start = HUB_SOURCE.indexOf("async set_privilege()");
  assert.notEqual(start, -1, "set_privilege not found in hub.js");
  const body = HUB_SOURCE.slice(start, start + 2000);
  assert.ok(body.includes("permission_grant"),
    "promoting a member to a chat role has to give them the staging row");
  assert.ok(body.includes("permission_revoke"),
    "demoting a member to view-only has to take the staging row back; "
    + "set_privilege only ever granted, so a demoted member kept uploading");
});
