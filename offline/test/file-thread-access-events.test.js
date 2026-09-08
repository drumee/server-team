#!/usr/bin/env node

/**
 * Regression tests for the channel.file_thread_access_changed contract.
 *
 * Deletion and cross-workspace movement both revoke a viewer's access to a file
 * thread, and the browser handles both through the same event. The two emitters
 * had drifted: the move path left out the file name, the pre-move identity, and
 * the source-hub grid update that deletion has always sent.
 *
 * The delete-path assertions here are a guard, not a description: that path is
 * live and its payload must not shift while the move path is brought level
 * with it.
 *
 * Standalone runner (no test framework in this repo): `node <thisfile>`.
 */

const assert = require("assert");
const { readFileSync, existsSync } = require("fs");
const { join } = require("path");

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const MEDIA_SOURCE = readFileSync(
  join(__dirname, "..", "..", "service", "private", "media.js"),
  "utf8"
);

// ── harness ───────────────────────────────────────────────────────────────
// media.js reaches the database and Redis through instance members, so the
// methods under test are lifted onto a stub that records what was published
// instead of standing up MariaDB and Redis.
function loadMediaMethods() {
  const source = MEDIA_SOURCE;
  const methods = {};
  for (const name of [
    "_transitionDirectFileThreadAccess",
    "_reserveDirectFileThreadTrash",
    "_releaseDirectFileThreadTrash",
  ]) {
    const start = source.indexOf(`  async ${name}(`);
    assert.notStrictEqual(start, -1, `${name} not found in media.js`);
    // Methods are indented two spaces inside the class body, so the first
    // line that is exactly "  }" closes the method.
    const end = source.indexOf("\n  }\n", start);
    assert.notStrictEqual(end, -1, `${name} has no closing brace`);
    methods[name] = source.slice(start, end + 4).replace(/^\s*async\s+/, "async function ");
  }
  return methods;
}

// Mirrors the guards in file_thread_access_transition_direct.sql so a stub
// cannot certify a call the real procedure would reject. An earlier version of
// this file returned success unconditionally, which let a rejected reason pass
// every test while emitting nothing in production.
function transitionDirectProc({ reservations, mediaRows } = {}) {
  return (transition_id, lineage_id, actor_id, hub_id, file_nid, thread_id,
    target_state, reason) => {
    if (!["active", "unavailable"].includes(target_state)
      || !["direct_trash", "direct_restore"].includes(reason)) {
      return [{ failed: 1, transitioned: 0, status: "INVALID_DIRECT_TRANSITION" }];
    }
    // Each reason asserts the media-table state its file operation was
    // supposed to leave behind. Trash REMOVES the row (mfs_pre_trash_next
    // copies to trash_media, then deletes from media), restore puts it back.
    //
    // Modelled here because omitting it is what let a real defect ship: the
    // procedure demanded the row still be PRESENT after a trash, so every
    // direct_trash returned DURABLE_STATE_MISMATCH, no event was emitted, and
    // deleting a file silently stopped closing the threads discussing it —
    // while this suite stayed green throughout.
    if (mediaRows) {
      const present = mediaRows.has(`${hub_id}:${file_nid}`);
      if ((reason === "direct_trash" && present)
        || (reason === "direct_restore" && !present)) {
        return [{ failed: 0, transitioned: 0, status: "DURABLE_STATE_MISMATCH" }];
      }
    }
    // 'unavailable' requires the lineage to be reserved under this same
    // transition id — the reserve-then-transition protocol.
    if (target_state === "unavailable") {
      const held = reservations && reservations.get(`${hub_id}:${file_nid}`);
      if (held !== transition_id) {
        return [{ failed: 0, transitioned: 0, status: "RESERVATION_REQUIRED" }];
      }
    }
    return [{
      failed: 0,
      transitioned: 1,
      transition_id,
      lineage_id: lineage_id || "lineage-1",
      access_revision: 7,
    }];
  };
}

function reserveDirectProc(reservations) {
  return (transition_id, lineage_id, actor_id, hub_id, file_nid) => {
    reservations.set(`${hub_id}:${file_nid}`, transition_id);
    return [{ failed: 0, reserved: 1, status: "RESERVED", lineage_id: lineage_id || "lineage-1" }];
  };
}

function makeStub({ procs = {}, funcs = {}, saga = {} } = {}) {
  const sent = [];
  const warnings = [];
  const stub = {
    uid: "actor-uid",
    sent,
    warnings,
    warn: (...args) => warnings.push(args.join(" ")),
    randomString: () => "randomid00000000",
    _fileMoveActor: () => ({ id: "actor-uid", fullname: "Actor Name" }),
    payload: (data, options) => ({ ...data, __service: options && options.service }),
    yp: {
      await_proc: async (name, ...args) => {
        const key = `${name}`.replace(/^[^.]*\./, "");
        const handler = procs[key] !== undefined ? procs[key] : procs[name];
        if (typeof handler === "function") return handler(...args);
        if (handler !== undefined) return handler;
        return [];
      },
      await_func: async (name, ...args) => {
        const handler = funcs[name];
        if (typeof handler === "function") return handler(...args);
        return handler !== undefined ? handler : null;
      },
    },
    saga,
  };
  return { stub, sent, warnings };
}

function runMethod(name, stub, args) {
  const methods = loadMediaMethods();
  const RedisStore = {
    sendData: async (payload, recipients) => {
      stub.sent.push({ payload, recipients });
    },
  };
  const firstRow = (data) => (Array.isArray(data) ? data[0] : data) || null;
  const toArray = (data) => (Array.isArray(data) ? data : (data ? [data] : []));
  const isEmpty = (v) => v == null || (Array.isArray(v) && !v.length);
  const Attr = { nid: "nid", hub_id: "hub_id" };

  const compile = (body) => {
    // eslint-disable-next-line no-new-func
    const factory = new Function(
      "RedisStore", "firstRow", "toArray", "isEmpty", "Attr",
      `return (${body});`
    );
    return factory(RedisStore, firstRow, toArray, isEmpty, Attr);
  };

  // Bind every extracted method onto the stub: these methods call each other
  // (subtree revocation drives the shared transition helper), and a missing
  // member would surface as a swallowed TypeError rather than a real result.
  for (const [methodName, body] of Object.entries(methods)) {
    stub[methodName] = compile(body).bind(stub);
  }
  return stub[name](...args);
}

const accessEvents = (sent) =>
  sent.filter((s) => s.payload.__service === "channel.file_thread_access_changed");

// ── delete path: must not drift ───────────────────────────────────────────

test("the delete path emits exactly the fields it always has", async () => {
  const reservations = new Map();
  const target = {
    hub_id: "hub-a",
    file_nid: "file-1",
    file_thread_id: "thread-1",
    filename: "Quarterly.pdf",
  };
  const { stub, sent } = makeStub({
    procs: {
      file_thread_access_transition_direct: transitionDirectProc({ reservations }),
      file_thread_access_reserve_direct: reserveDirectProc(reservations),
      entity_sockets: [{ socket_id: "s1", uid: "viewer" }],
    },
  });

  await runMethod("_reserveDirectFileThreadTrash", stub, [target]);
  await runMethod("_transitionDirectFileThreadAccess", stub, [
    target,
    "unavailable",
    "direct_trash",
  ]);

  const events = accessEvents(sent);
  assert.strictEqual(events.length, 1);
  const { payload } = events[0];
  // The emitter is shared with the move path, so the move-only keys are always
  // present in the object literal and left undefined here. What must not drift
  // is the set of fields that actually carry a value over the wire.
  const populated = Object.keys(payload)
    .filter((key) => payload[key] !== undefined)
    .sort();
  assert.deepStrictEqual(populated, [
    "__service", "access_revision", "actor", "file_nid", "file_thread_id",
    "filename", "hub_id", "lineage_id", "operation_id", "reason", "state",
  ]);
  assert.strictEqual(payload.state, "revoked");
  assert.strictEqual(payload.filename, "Quarterly.pdf");
  assert.strictEqual(payload.access_revision, 7);
  assert.strictEqual(payload.previous_file_nid, undefined,
    "delete path must not gain move-only fields");
  assert.strictEqual(payload.holder_hub_id, undefined,
    "nothing holds a deleted file");
});

test("a restore keeps the delete path's active state mapping", async () => {
  const { stub, sent } = makeStub({
    procs: {
      file_thread_access_transition_direct: transitionDirectProc({ reservations: new Map() }),
      entity_sockets: [{ socket_id: "s1" }],
    },
  });

  await runMethod("_transitionDirectFileThreadAccess", stub, [
    { hub_id: "hub-a", file_nid: "f", file_thread_id: "th", filename: "n" },
    "active",
    "direct_restore",
  ]);

  assert.strictEqual(accessEvents(sent)[0].payload.state, "restored");
});

test("a revoke without a reservation is refused, and emits nothing", async () => {
  // The stored procedure gates 'unavailable' on the lineage already being
  // reserved under the same transition id. Skipping the reservation is the
  // defect this suite previously hid behind an always-succeeding stub.
  const { stub, sent } = makeStub({
    procs: {
      file_thread_access_transition_direct: transitionDirectProc({ reservations: new Map() }),
      entity_sockets: [{ socket_id: "s1" }],
    },
  });

  const transition = await runMethod("_transitionDirectFileThreadAccess", stub, [
    { hub_id: "hub-a", file_nid: "f", file_thread_id: "th", filename: "n" },
    "unavailable",
    "direct_trash",
  ]);

  assert.strictEqual(Number(transition.transitioned), 0);
  assert.strictEqual(transition.status, "RESERVATION_REQUIRED");
  assert.strictEqual(accessEvents(sent).length, 0);
});

test("a reason the procedure does not whitelist is refused", async () => {
  const { stub, sent } = makeStub({
    procs: {
      file_thread_access_transition_direct: transitionDirectProc({ reservations: new Map() }),
      entity_sockets: [{ socket_id: "s1" }],
    },
  });

  const transition = await runMethod("_transitionDirectFileThreadAccess", stub, [
    { hub_id: "hub-a", file_nid: "f", file_thread_id: "th", filename: "n" },
    "unavailable",
    "workspace_move",
  ]);

  assert.strictEqual(Number(transition.transitioned), 0);
  assert.strictEqual(transition.status, "INVALID_DIRECT_TRANSITION");
  assert.strictEqual(accessEvents(sent).length, 0);
});

// ── workspace_move: deliberately not handled here ─────────────────────────

test("a workspace move does not attempt a direct thread revocation", () => {
  // Revoking a file thread inside a moved folder was implemented and reverted.
  // file_thread_access_transition_direct validates a trash-shaped durable state
  // (thread row present, media row gone), but mfs_move_all deletes both — its
  // own media DELETE plus file_thread via channel_migrate_moved_scope — so no
  // call ordering satisfies it, and the compensating release is blocked by the
  // mirror guard, stranding the lineage in 'moving' with no sweeper to reclaim
  // it. This guard fails if that approach is reintroduced without a contract
  // that survives both rows disappearing.
  const body = MEDIA_SOURCE.slice(
    MEDIA_SOURCE.indexOf("async workspace_move()"),
    MEDIA_SOURCE.indexOf("async relocate()")
  );
  assert.doesNotMatch(body, /_transitionDirectFileThreadAccess/,
    "workspace_move cannot use the direct access procedures — see the comment in it");
  assert.doesNotMatch(body, /channel_file_thread_list_subtree/);
});

// The regression this suite missed. Trashing a file removes its media row, so
// the transition runs with the row already gone; a procedure that demands the
// row still be there transitions nothing and the viewer is never told. Asserts
// the event reaches the wire under the state a real trash leaves behind.
test("a trashed file still announces the revoke once its media row is gone", async () => {
  const reservations = new Map();
  // Present while the reservation is taken, removed by the trash itself —
  // the same order as trash(): reserve, mfs_pre_trash_next, then transition.
  const mediaRows = new Set(["hub-a:file-1"]);
  const target = {
    hub_id: "hub-a",
    file_nid: "file-1",
    file_thread_id: "thread-1",
    filename: "Quarterly.pdf",
  };
  const { stub, sent } = makeStub({
    procs: {
      file_thread_access_transition_direct: transitionDirectProc({ reservations, mediaRows }),
      file_thread_access_reserve_direct: reserveDirectProc(reservations),
      entity_sockets: [{ socket_id: "s1", uid: "viewer" }],
    },
  });

  await runMethod("_reserveDirectFileThreadTrash", stub, [target]);
  mediaRows.delete("hub-a:file-1");
  await runMethod("_transitionDirectFileThreadAccess", stub, [
    target, "unavailable", "direct_trash",
  ]);

  const events = accessEvents(sent);
  assert.strictEqual(events.length, 1,
    "a trash whose file is gone must still emit the revoke");
  assert.strictEqual(events[0].payload.state, "revoked");
});

// The mirror, and the reason the predicate is an equality on state rather than
// a blanket "row may be missing": a file that never left must not have its
// thread revoked.
test("a trash whose file never left is refused and announces nothing", async () => {
  const reservations = new Map();
  const mediaRows = new Set(["hub-a:file-1"]);
  const target = {
    hub_id: "hub-a",
    file_nid: "file-1",
    file_thread_id: "thread-1",
    filename: "Quarterly.pdf",
  };
  const { stub, sent } = makeStub({
    procs: {
      file_thread_access_transition_direct: transitionDirectProc({ reservations, mediaRows }),
      file_thread_access_reserve_direct: reserveDirectProc(reservations),
      entity_sockets: [{ socket_id: "s1", uid: "viewer" }],
    },
  });

  await runMethod("_reserveDirectFileThreadTrash", stub, [target]);
  await runMethod("_transitionDirectFileThreadAccess", stub, [
    target, "unavailable", "direct_trash",
  ]);

  assert.strictEqual(accessEvents(sent).length, 0);
});


(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok  - ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`  FAIL - ${name}`);
      console.error(`         ${error && error.message}`);
    }
  }

  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
