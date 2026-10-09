#!/usr/bin/env node
// chat.upload_remove — a member removing their own pending chat attachment.
//
// Lexis, via Duy, 2026-10-09. The ACL asked for src:'write', so a member whose
// workspace role is Chat (privilege 7: view + download, no write bit) got a bare
// 403 on every remove. They CAN attach — the staging folder grants them write
// (chat-upload-grant.test.js) — so pressing x on a chip dropped it from the
// composer while the staged file stayed on the server, and the composer's
// closing cleanup failed the same way.
//
// The right is the CHAT tier, i.e. the download bit: the same bit the client's
// chat gates test (widget_chat._mayChatHere, the folder window's chat gate).
// NOT the `chat` name — that maps to 0b110, which overlaps read and so admits
// View. The method itself still deletes only a file in /__chat__/__upload__/
// that the caller owns (service/private/chat.js remove_attachment).
//
// What is pinned:
//   1. Chat / Edit / Admin / Owner may remove; View may not.
//   2. upload_remove still sits ABOVE `read`, so the secure-share read-only
//      ceiling and the over-limit clamp (router/rest/index.js mightMutate)
//      keep catching it.
//   3. remove_attachment keeps its staging-path, file-only and owner guards —
//      they are what make a chat-tier bar safe.
//
// Dependency-free by design (see .github/workflows/test.yml): the bits are
// declared locally; when @drumee/server-essentials IS installed the local copy
// is checked against the shipped table so drift is caught, not assumed away.
//
//   node --test offline/test/chat-upload-remove-permission.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const REPO_ROOT = join(__dirname, "..", "..");
const CHAT = JSON.parse(readFileSync(join(REPO_ROOT, "acl", "chat.json"), "utf8")).services;

// server-essentials lib/lex/permission.js — the single bits a service asks for.
const BIT = { read: 0b0000010, download: 0b0000100, write: 0b0001000 };

// The stored privilege WORDS a member can hold.
const ROLE = { view: 0b0000011, chat: 0b0000111, edit: 0b0001111, admin: 0b0011111, owner: 0b0111111 };

// Exactly what lib/acl.js check_source does with each row.
const granted = (privilege, asked) => !!(privilege & asked);

let permissionValue = null;
try {
  ({ permissionValue } = require("@drumee/server-essentials"));
} catch (e) {
  console.log(`  ~ shipped-table cross-check SKIPPED (server-essentials not installed: ${e.code || e.message})`);
}

test("the local bit values still match the shipped table", { skip: !permissionValue }, () => {
  for (const [name, value] of Object.entries(BIT)) {
    assert.equal(permissionValue(name), value, `permission bit \`${name}\` drifted`);
  }
});

test("the download bit is what Chat has and View lacks", () => {
  assert.equal(BIT.download, ROLE.chat & ~ROLE.view);
});

test("chat.upload_remove asks for the download bit", () => {
  const spec = CHAT.upload_remove;
  assert.equal(spec.permission.src, "download");
  assert.equal(spec.scope, "hub");
  assert.equal(spec.method, "remove_attachment");
});

test("Chat, Edit, Admin and Owner may remove; View may not", () => {
  const asked = BIT[CHAT.upload_remove.permission.src];
  assert.ok(asked, "upload_remove asks for a bit this test does not know");
  for (const [role, want] of Object.entries({
    view: false, chat: true, edit: true, admin: true, owner: true,
  })) {
    assert.equal(
      granted(ROLE[role], asked), want,
      `${role} (${ROLE[role]}) got the wrong answer against asked=${asked}`,
    );
  }
});

test("upload_remove still sits above `read`, so the read-only clamps still catch it", () => {
  assert.ok(BIT[CHAT.upload_remove.permission.src] > BIT.read);
});

test("remove_attachment still deletes only the caller's own staged file", () => {
  const src = readFileSync(join(REPO_ROOT, "service", "private", "chat.js"), "utf8");
  const start = src.indexOf("async remove_attachment()");
  assert.ok(start > 0, "remove_attachment not found");
  const body = src.slice(start, src.indexOf("\n  }\n", start));
  const remove = body.indexOf("mfs_attachment_remove");
  assert.ok(remove > 0, "remove_attachment no longer removes through mfs_attachment_remove");
  for (const [what, guard] of [
    ["staging path", body.indexOf('"/__chat__/__upload__/"')],
    ["folder/hub refusal", body.indexOf('file.ftype == "folder" || file.ftype == "hub"')],
    ["owner check", body.indexOf("`${owner.owner_id}` !== `${this.uid}`")],
  ]) {
    assert.ok(guard > 0, `remove_attachment lost its ${what} guard`);
    assert.ok(guard < remove, `the ${what} guard runs after the delete`);
  }
});
