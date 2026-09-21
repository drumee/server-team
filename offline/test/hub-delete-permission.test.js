#!/usr/bin/env node

/**
 * @license
 * Copyright 2024 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.gnu.org/licenses/agpl-3.0.html
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

/**
 * `hub.delete_hub` asks for ADMIN, and the blast radius that decision rests on.
 *
 * Lexis, via Duy, 2026-09-17. The owner bar this service used to carry was never
 * a real boundary: `hub.change_owner` and `hub.set_privilege` are themselves
 * `src: admin` and neither clamps what it writes, so any workspace admin could
 * already take ownership in a single call and then delete. Requiring owner only
 * added a step, while leaving the client offering a Delete row that answered
 * 403 (ui-team gates that row on the admin bit).
 *
 * What is pinned here is not the constant — it is the two properties that made
 * widening it safe, either of which a later edit could quietly take away:
 *
 *   1. Edit / Chat / View are still refused. That is the whole point of the
 *      report this came from.
 *   2. `delete_hub` still sits ABOVE `read`, which is what keeps the DMZ /
 *      secure-share read-only ceiling and the over-limit clamp catching it
 *      (router/rest/index.js `mightMutate`). Owner and admin both clear that
 *      bar; anything at or below `read` would not.
 *
 * DEPENDENCY-FREE BY DESIGN. The CI job that runs this deliberately does not
 * `npm install` (see .github/workflows/test.yml), so the private
 * @drumee/server-essentials package is usually absent on the runner. The bit
 * values are therefore declared locally and every assertion works from them;
 * when the package IS present we additionally check the local copy still
 * matches the shipped table, so drift is caught rather than assumed away. Same
 * arrangement as secure-share-session.test.js.
 */
const test = require("node:test");
const assert = require("node:assert");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const REPO_ROOT = join(__dirname, "..", "..");
const ACL = (name) =>
  JSON.parse(readFileSync(join(REPO_ROOT, "acl", `${name}.json`), "utf8")).services;

// server-essentials lib/lex/permission.js — the single BITS a service asks for.
const BIT = { read: 0b0000010, write: 0b0001000, admin: 0b0010000, owner: 0b0100000 };

// The stored privilege WORDS a member can hold — hub.set_privilege writes these
// and user_permission() hands them back.
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

test("hub.delete_hub asks for the admin bit", () => {
  const spec = ACL("hub").delete_hub;
  assert.equal(spec.permission.src, "admin");
  assert.equal(spec.scope, "hub");
});

test("Admin and Owner may delete; Edit, Chat and View may not", () => {
  const asked = BIT[ACL("hub").delete_hub.permission.src];
  assert.ok(asked, "delete_hub asks for a bit this test does not know");
  for (const [role, want] of Object.entries({
    view: false, chat: false, edit: false, admin: true, owner: true,
  })) {
    assert.equal(
      granted(ROLE[role], asked), want,
      `${role} (${ROLE[role]}) got the wrong answer against asked=${asked}`,
    );
  }
});

test("delete_hub still sits above `read`, so the read-only clamps still catch it", () => {
  // router/rest/index.js: mightMutate = permission.src > READ_LEVEL. A
  // secure-share recipient carries a read-only session ceiling and an
  // over-limit domain is clamped to reads; both rely on this comparison, NOT on
  // a service name, so widening owner -> admin must not cross that line.
  const src = BIT[ACL("hub").delete_hub.permission.src];
  assert.ok(src > BIT.read, "delete_hub would escape the read-only clamps");
});

test("the other workspace-destroying services are deliberately NOT aligned", () => {
  // merge_workspace empties a whole workspace and copy_workspace duplicates
  // one; both still ask owner. They were left alone on purpose — moving them is
  // a decision of its own, not a tidy-up. See their `doc` in acl/media.json.
  const media = ACL("media");
  assert.equal(media.merge_workspace.permission.src, "owner");
  assert.equal(media.copy_workspace.permission.src, "owner");
});

test("a personal workspace can never come through delete_hub", () => {
  // service/private/hub.js refuses anything whose entity type is not `hub`, so
  // a personal workspace (a folder in the caller's own home, whose hub_id is
  // the caller's drumate) meets WRONG_ENTITY_TYPE rather than this permission.
  const src = readFileSync(join(REPO_ROOT, "service", "private", "hub.js"), "utf8");
  const body = src.slice(src.indexOf("async delete_hub()"));
  const guard = body.indexOf("WRONG_ENTITY_TYPE");
  const destroy = body.indexOf("entity_delete");
  assert.ok(guard > 0, "delete_hub lost its entity-type guard");
  assert.ok(destroy > guard, "entity_delete is reachable before the type guard");
});
