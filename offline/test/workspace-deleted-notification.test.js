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
 * "<Somebody> deleted your workspace '<name>'" — the notice hub.delete_hub
 * leaves for the OWNER (Duy, 2026-09-17, the follow-up to moving delete_hub
 * from owner to admin).
 *
 * Two halves, tested two ways, because they fail differently:
 *
 *   the WRITE   _notifyOwnerOfDeletion is run for real against a fake `this`,
 *               so the proc, the recipient and the snapshotted payload are the
 *               shipped ones. What matters here is that it is best-effort: a
 *               workspace must still delete when the notification cannot be
 *               written.
 *   the STAMP   stampWorkspaceDeleted is sliced out of activity.js and run over
 *               row shapes activity_get_feed_all really produces. What matters
 *               here is the category — without it the client renders the row as
 *               a contact request ("wants to connect"), which is the exact
 *               defect Lexis reported for workspace invitations on 2026-09-14.
 *
 * Dependency-free: no `npm install` on the CI runner (see
 * .github/workflows/test.yml), so nothing here may require a private package.
 */
const test = require("node:test");
const assert = require("node:assert");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const REPO_ROOT = join(__dirname, "..", "..");
const HUB = join(REPO_ROOT, "service", "private", "hub.js");
const ACTIVITY = join(REPO_ROOT, "service", "private", "activity.js");

// ── the stamp, sliced out of activity.js ────────────────────────────────────

function sliceFn(file, name) {
  const src = readFileSync(file, "utf8");
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found in ${file}`);
  const end = src.indexOf("\n}\n", start) + 3;
  assert.ok(end > start, `${name} has no end`);
  return new Function(`${src.slice(start, end)}\nreturn ${name};`)();
}

const stampWorkspaceDeleted = sliceFn(ACTIVITY, "stampWorkspaceDeleted");

// What activity_get_feed_all's contact branch really returns: category NULL,
// event_type 'contact', hub_id NULL. That shape IS the bug.
const rawFeedRow = (over = {}) => ({
  id: 41,
  uid: "adminuid",
  event: "workspace_deleted",
  event_type: "contact",
  category: null,
  hub_id: null,
  data: JSON.stringify({ hub_id: "hub123", hub_name: "Design team", deleted_by: "Ada" }),
  ...over,
});

test("a raw feed row is stamped so it cannot render as a contact request", () => {
  const rows = [rawFeedRow()];
  stampWorkspaceDeleted(rows);
  // The client resolves `category || event_type || type`. Unstamped this is
  // 'contact' -> "wants to connect".
  assert.equal(rows[0].category, "workspace_deleted");
  assert.equal(rows[0].author_id, "adminuid", "the card would show the viewer's own face");
});

test("the name is flattened OUT of the raw `data` JSON string", () => {
  // activity_get_feed_all hands `data` through as the stored JSON STRING, and
  // the renderer reads plain top-level fields. Without this the card says
  // "<somebody> deleted your workspace" and names no workspace — the one fact
  // the message exists to carry. Same treatment flattenTaskFields gives the
  // task events.
  const rows = [rawFeedRow()];
  assert.equal(typeof rows[0].data, "string", "fixture must use the stored shape");
  assert.equal(rows[0].hub_name, undefined);
  stampWorkspaceDeleted(rows);
  assert.equal(rows[0].hub_name, "Design team");
  assert.equal(rows[0].deleted_by, "Ada");
});

test("an already-parsed `data` object works too", () => {
  const rows = [rawFeedRow({ data: { hub_id: "h", hub_name: "Parsed", deleted_by: "Ada" } })];
  stampWorkspaceDeleted(rows);
  assert.equal(rows[0].hub_name, "Parsed");
});

test("unparseable `data` degrades instead of throwing", () => {
  const rows = [rawFeedRow({ data: "{not json" })];
  assert.doesNotThrow(() => stampWorkspaceDeleted(rows));
  assert.equal(rows[0].category, "workspace_deleted");
  assert.equal(rows[0].hub_name, undefined, "no name is better than a crashed feed");
});

test("NO hub_id is published — the row must have nowhere to navigate", () => {
  const rows = [rawFeedRow()];
  stampWorkspaceDeleted(rows);
  // The workspace is gone. Publishing an id would send the desk's opener after
  // a hub it cannot load; withholding it makes the row inert by construction.
  assert.equal(rows[0].hub_id, null);
});

test("the stamp is add-only and idempotent", () => {
  const pre = rawFeedRow({ category: "already", author_id: "someone" });
  const rows = [pre];
  stampWorkspaceDeleted(rows);
  assert.equal(rows[0].category, "already");
  assert.equal(rows[0].author_id, "someone");
  // Running twice changes nothing.
  const twice = [rawFeedRow()];
  stampWorkspaceDeleted(twice);
  const first = { ...twice[0] };
  stampWorkspaceDeleted(twice);
  assert.deepEqual(twice[0], first);
});

test("rows for other events are left alone", () => {
  const others = [
    rawFeedRow({ event: "hub_invite_received" }),
    rawFeedRow({ event: "task_assigned" }),
    { event: "media.remove", category: "mfs" },
    null,
  ];
  const before = JSON.stringify(others);
  stampWorkspaceDeleted(others);
  assert.equal(JSON.stringify(others), before);
});

test("it survives a non-array without throwing", () => {
  assert.doesNotThrow(() => stampWorkspaceDeleted(undefined));
  assert.doesNotThrow(() => stampWorkspaceDeleted(null));
});

test("the bucket is declared, not left to the default", () => {
  const src = readFileSync(ACTIVITY, "utf8");
  const table = src.slice(src.indexOf("const BUCKET_BY_CATEGORY"));
  assert.match(
    table.slice(0, table.indexOf("};")),
    /workspace_deleted:\s*BUCKET\.other/,
    "workspace_deleted must name its tab explicitly",
  );
});

// ── the write, run for real against a fake `this` ───────────────────────────

function grabMethod(file, name) {
  const src = readFileSync(file, "utf8");
  const start = src.indexOf(`  async ${name}(`);
  assert.ok(start > 0, `${name} not found in ${file}`);
  const end = src.indexOf("\n  }\n", start) + 4;
  assert.ok(end > start, `${name} has no end`);
  return new Function(`return ({ ${src.slice(start, end)} }).${name};`)();
}

const notifyOwner = grabMethod(HUB, "_notifyOwnerOfDeletion");

function ctx(over = {}) {
  const calls = [];
  const warns = [];
  return {
    calls,
    warns,
    uid: "adminuid",
    yp: { await_proc: async (...args) => { calls.push(args); return []; } },
    _actor_name: () => "Ada Lovelace",
    warn: (...a) => warns.push(a),
    ...over,
  };
}

test("the owner gets a row carrying a SNAPSHOT of the name", async () => {
  const c = ctx();
  await notifyOwner.call(c, { owner_id: "ownerid" }, "hub123", "Design team");
  assert.equal(c.calls.length, 1);
  const [proc, actor, target, event, payload] = c.calls[0];
  assert.equal(proc, "contact_log_activity");
  assert.equal(actor, "adminuid");
  assert.equal(target, "ownerid", "the notice must go to the OWNER");
  assert.equal(event, "workspace_deleted");
  // yp.hub loses its row moments later, so nothing can resolve the name
  // afterwards — it has to travel with the notification.
  assert.equal(payload.hub_name, "Design team");
  assert.equal(payload.hub_id, "hub123");
  assert.equal(payload.deleted_by, "Ada Lovelace");
});

test("an owner deleting their OWN workspace is not notified", async () => {
  const c = ctx();
  await notifyOwner.call(c, { owner_id: "adminuid" }, "hub123", "Mine");
  assert.equal(c.calls.length, 0, "would leave a phantom row for every self-delete");
});

test("a missing owner_id warns instead of writing a headless row", async () => {
  const c = ctx();
  await notifyOwner.call(c, {}, "hub123", "Orphan");
  assert.equal(c.calls.length, 0);
  assert.equal(c.warns.length, 1);
});

test("a failing write NEVER breaks the delete", async () => {
  const c = ctx({
    yp: { await_proc: async () => { throw new Error("yp is down"); } },
  });
  await assert.doesNotReject(
    () => notifyOwner.call(c, { owner_id: "ownerid" }, "hub123", "Design team"),
    "the workspace is going either way; a notification must not fail the request",
  );
  assert.equal(c.warns.length, 1);
});

// ── the call site ───────────────────────────────────────────────────────────

test("delete_hub notifies BEFORE it destroys anything", () => {
  const src = readFileSync(HUB, "utf8");
  const body = src.slice(src.indexOf("  async delete_hub()"));
  // The CALL, not the word: "entity_delete" also appears in the prose above
  // explaining why the name has to be read before it runs, and matching that
  // made this assertion fire on correct code.
  const notify = body.indexOf("await this._notifyOwnerOfDeletion(");
  const destroy = body.indexOf('this.yp.await_proc("entity_delete"');
  assert.ok(notify > 0, "delete_hub no longer notifies the owner");
  assert.ok(destroy > notify, "the owner would be notified after the hub row is gone");
});

test("the name is read from yp.hub.name, never from get_hub's hex `name`", () => {
  const src = readFileSync(HUB, "utf8");
  const body = src.slice(src.indexOf("  async delete_hub()"));
  const head = body.slice(0, body.indexOf("entity_sockets"));
  assert.match(head, /_workspaceDisplayName\(hub_id\)/);
  // get_hub returns `IF(_exists, h.hubname, _org_name) AS name`, and hubname is
  // the hex id — so `data.name` must not be what reaches the notification.
  assert.ok(
    !/const hub_name = data\.name/.test(head),
    "data.name is the hex id, not the workspace's display name",
  );
});
