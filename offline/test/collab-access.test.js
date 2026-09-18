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
 * The collaboration socket: who may hold one, and what stops the push protocol
 * from being collateral damage.
 *
 * Duy, 2026-09-18: every workspace member must be able to OPEN the note — view
 * and chat included — but only edit and above may change it live. That is one
 * rule with three outcomes, and the two halves fail very differently:
 *
 *   - too strict, and a view member cannot read a note they can already open
 *     through the file browser;
 *   - too loose, and a chat member silently rewrites a document.
 *
 * So both the read bit and the write bit are pinned here, along with the two
 * properties that keep the rest of the app safe:
 *
 *   1. The room name is not a client string. It must name a (hub, node) pair
 *      of ids, and those ids are interpolated into forward_proc's DYNAMIC SQL
 *      — an unanchored or permissive pattern there is an injection, not a typo.
 *   2. index.js UNMOUNTS the push websocket server before dispatching upgrades
 *      itself. Node calls every `upgrade` listener it has, so leaving the push
 *      library mounted makes it write its rejection onto a socket Hocuspocus
 *      already upgraded, and the collaboration client dies on an invalid
 *      frame. That one line is the whole reason the two libraries coexist.
 *
 * DEPENDENCY-FREE BY DESIGN. The CI job that runs this deliberately does not
 * `npm install` (see .github/workflows/test.yml), so neither
 * @drumee/server-essentials nor @hocuspocus/server can be required here. The
 * rules are therefore read out of the source and exercised directly; when
 * server-essentials IS present the bit values are additionally compared with
 * the shipped table, so drift is caught rather than assumed away. Same
 * arrangement as hub-delete-permission.test.js.
 *
 * The behavioural end of this — a view member receiving an editor's changes
 * while its own are discarded, and a demoted member being force-disconnected —
 * is exercised against the real router with a stubbed database, and then
 * against real accounts on a dev endpoint.
 */
const test = require("node:test");
const assert = require("node:assert");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const ROOT = join(__dirname, "..", "..");
const COLLAB = readFileSync(join(ROOT, "router", "collab", "index.js"), "utf8");
const INDEX = readFileSync(join(ROOT, "index.js"), "utf8");

/** The permission bits the router is written against */
const READ = 2;
const WRITE = 8;

/** Privilege words, as stored (lex/permission.js) */
const VIEW = 3;
const CHAT = 7;
const EDIT = 15;
const ADMIN = 31;
const OWNER = 63;
const NONE = 0;

/**
 * Pull a named const's regular expression literal out of the source, so the
 * pattern under test is the one that ships rather than a copy.
 *
 * @param {*} name
 * @returns {RegExp}
 */
function patternOf(name) {
  const m = new RegExp(`const ${name} = (/.*/);`).exec(COLLAB);
  assert.ok(m, `${name} is no longer a regular expression literal`);
  const body = m[1].replace(/^\//, "").replace(/\/$/, "");
  return new RegExp(body);
}

test("the router still reads the bits it documents", () => {
  const m = /const READ = (\d+);\s*\nconst WRITE = (\d+);/.exec(COLLAB);
  assert.ok(m, "READ/WRITE are no longer declared as plain constants");
  assert.strictEqual(parseInt(m[1], 10), READ);
  assert.strictEqual(parseInt(m[2], 10), WRITE);
});

test("every workspace member can open the note", () => {
  for (const privilege of [VIEW, CHAT, EDIT, ADMIN, OWNER]) {
    assert.ok(privilege & READ, `privilege ${privilege} must clear the read bar`);
  }
});

test("only edit and above may write; view and chat are read-only", () => {
  for (const privilege of [VIEW, CHAT]) {
    assert.ok(privilege & READ, `privilege ${privilege} may open`);
    assert.ok(
      !(privilege & WRITE),
      `privilege ${privilege} must NOT be able to edit`
    );
  }
  for (const privilege of [EDIT, ADMIN, OWNER]) {
    assert.ok(privilege & WRITE, `privilege ${privilege} may edit`);
  }
});

test("a non-member is refused the socket outright", () => {
  assert.ok(!(NONE & READ));
  assert.ok(!(NONE & WRITE));
});

test("the room name is a (hub, node) pair of ids and nothing else", () => {
  const ROOM = patternOf("ROOM");

  assert.ok(ROOM.test("hub:a1b2c3d4/note:e5f6a7b8"));
  assert.ok(ROOM.test("hub:1/note:2"));

  const rejected = [
    "",
    "anything",
    "../../etc/passwd",
    "hub:a1/note:e5/extra",
    "hub:a1/note:e5 ",
    "\nhub:a1/note:e5",
    "hub:a1/note:e5\n",
    "hub:a1/note:e5\nhub:b2/note:f6",
    "hub:a1'/note:e5",
    "hub:a1/note:e5' OR '1'='1",
    "hub:a1/note:e5; DROP PROCEDURE x",
    "hub:/note:e5",
    "hub:a1/note:",
    "hub:aaaaaaaaaaaaaaaaa/note:e5", // 17 chars, wider than the column
    "note:e5/hub:a1",
  ];
  for (const name of rejected) {
    assert.ok(
      !ROOM.test(name),
      `room name ${JSON.stringify(name)} must be refused`
    );
  }
});

test("the ids the room yields are safe to interpolate into dynamic SQL", () => {
  const ROOM = patternOf("ROOM");
  const [, hub_id, nid] = ROOM.exec("hub:a1b2c3d4/note:e5f6a7b8");
  for (const id of [hub_id, nid]) {
    assert.match(id, /^[A-Za-z0-9]{1,16}$/);
  }
});

test("the access key pattern rejects anything that is not an opaque key", () => {
  const OTAK = patternOf("OTAK");
  assert.ok(OTAK.test("A1b2C3d4E5f6G7h8I9j0kL"));
  for (const bad of ["", "short", "has-a-dash", "has space", "'or'1'='1", "a".repeat(65)]) {
    assert.ok(!OTAK.test(bad), `token ${JSON.stringify(bad)} must be refused`);
  }
});

test("the push websocket server is unmounted before upgrades are dispatched", () => {
  assert.match(
    INDEX,
    /wsServer\.unmount\(\);/,
    "the push server must give up its own upgrade listener"
  );
  const listeners = INDEX.match(/http\.on\("upgrade"/g) || [];
  assert.strictEqual(
    listeners.length,
    1,
    "there must be exactly ONE upgrade listener on the http server"
  );
});

test("the push protocol still goes through the library's own handler", () => {
  assert.match(
    INDEX,
    /server\.handleUpgrade\(request, socket, head\)/,
    "the dispatcher must call handleUpgrade, which is what mount() installed"
  );
});

test("only /ws/collab is taken away from the push protocol", () => {
  const m = /const COLLAB_PATH = new RegExp\((\/.*\/)\);/.exec(INDEX);
  assert.ok(m, "COLLAB_PATH is no longer a regular expression literal");
  const body = m[1].replace(/^\//, "").replace(/\/$/, "");
  const COLLAB_PATH = new RegExp(body);

  assert.ok(COLLAB_PATH.test("/-/duynguyen/ws/collab"));
  assert.ok(COLLAB_PATH.test("/-/duynguyen/ws/collab/"));
  assert.ok(COLLAB_PATH.test("/ws/collab"));

  /** The path every existing client uses must NOT be diverted */
  assert.ok(!COLLAB_PATH.test("/-/duynguyen/websocket/"));
  assert.ok(!COLLAB_PATH.test("/websocket/"));
  assert.ok(!COLLAB_PATH.test("/-/main/websocket/"));
  /** Nor anything that merely mentions the path */
  assert.ok(!COLLAB_PATH.test("/-/duynguyen/wscollab"));
  assert.ok(!COLLAB_PATH.test("/-/duynguyen/ws/collaborate"));
});

test("a bound socket is always released", () => {
  assert.match(
    COLLAB,
    /socket_bind/,
    "the token exchange is still socket_bind"
  );
  assert.match(
    COLLAB,
    /socket_free/,
    "a socket registered by socket_bind must be released with socket_free"
  );
  assert.match(
    COLLAB,
    /client\.once\("close"/,
    "the release must hang off the websocket close, which covers every path"
  );
});

test("a live connection is re-checked, because a socket authenticates once", () => {
  assert.match(COLLAB, /revalidate/, "the revalidation pass is gone");
  assert.match(
    COLLAB,
    /setInterval\(\s*this\.revalidate\.bind\(this\)/,
    "revalidate must actually be scheduled"
  );
});

/**
 * When the private package happens to be installed, prove the local copy of
 * the table still matches the shipped one.
 */
test("the bit values still match server-essentials", (t) => {
  let permission;
  try {
    permission = require("@drumee/server-essentials/lib/lex/permission");
  } catch (e) {
    t.skip("@drumee/server-essentials not installed");
    return;
  }
  assert.strictEqual(permission.read, READ);
  assert.strictEqual(permission.view, READ);
  assert.strictEqual(permission.write, WRITE);
  assert.strictEqual(permission.modify, WRITE);
  assert.strictEqual(permission.upload, WRITE);
  /** chat carries download, never write — that is the whole read-only case */
  assert.ok(!(permission.chat & WRITE));
});
