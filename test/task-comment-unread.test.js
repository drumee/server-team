// task.comment_unread / task.comment_mark_read: per-user read marks behind the
// subtask unread-comment badge. Runs the REAL handlers against a stub `this`.
//
// Run: node --test test/task-comment-unread.test.js
const assert = require("node:assert/strict");
const test = require("node:test");

global.myDrumee = { arch: "pod", useEmail: 0 };
global.verbosity = 0;
global.debug = {};

const Task = require("../service/private/task");
const acl = require("../acl/task.json");

const UID = "uuuu1111uuuu1112";

function makeTask(input, procResult) {
  const seen = { calls: [], broadcasts: [] };
  const self = Object.create(Task.prototype);
  Object.assign(self, {
    uid: UID,
    input: {
      need: (k) => input[k],
      use: (k, d) => (input[k] == null ? d : input[k]),
      get: (k) => input[k],
    },
    db: {
      await_proc: async (...args) => {
        seen.calls.push(args);
        return procResult;
      },
    },
    exception: { user: (code) => { seen.error = code; } },
    output: {
      list: (rows) => { seen.rows = rows; },
      data: (data) => { seen.data = data; },
    },
    _broadcast: async (...args) => { seen.broadcasts.push(args); },
    warn: () => {},
  });
  return { self, seen };
}

test("comment_unread passes parent_id and this.uid", async () => {
  const { self, seen } = makeTask({ parent_id: "P1" }, [{ task_id: "A", unread: "2" }]);
  await self.comment_unread();
  assert.deepEqual(seen.calls, [["task_comment_unread_counts", "P1", UID]]);
  assert.deepEqual(seen.rows, [{ task_id: "A", unread: 2 }]);
});

test("comment_unread on a DB without the proc lists []", async () => {
  const { self, seen } = makeTask({ parent_id: "P1" }, []);
  await self.comment_unread();
  assert.deepEqual(seen.rows, []);
  assert.equal(seen.error, undefined);
});

test("comment_mark_read stamps for this.uid and does not broadcast to peers", async () => {
  const { self, seen } = makeTask({ task_id: "A" }, [{ task_id: "A", read_ts: 1234 }]);
  await self.comment_mark_read();
  assert.deepEqual(seen.calls, [["task_comment_mark_read", "A", UID]]);
  assert.equal(seen.data.task_id, "A");
  assert.equal(seen.broadcasts.length, 0);
});

// The caller's other tabs/devices clear the badge live: mark_read pushes to the
// CALLER's own sockets (minus the one that asked), never to peers.
const { RedisStore } = require("@drumee/server-essentials");

function withSockets(self, sockets) {
  const sent = [];
  self.hub = { get: () => "HUB1" };
  self.yp = { await_proc: async (name, hub) => (name === "entity_sockets" && hub === "HUB1" ? sockets : []) };
  self.payload = (data, options) => ({ model: data, options });
  const orig = RedisStore.sendData;
  RedisStore.sendData = async (payload, dest) => { sent.push({ payload, dest }); };
  return { sent, restore: () => { RedisStore.sendData = orig; } };
}

test("comment_mark_read pushes to the caller's other sockets only", async () => {
  const { self } = makeTask({ task_id: "A", socket_id: "mine-here" }, [{ task_id: "A", read_ts: 1234 }]);
  const { sent, restore } = withSockets(self, [
    { socket_id: "mine-here", uid: UID },
    { socket_id: "mine-other", uid: UID },
    { socket_id: "peer", uid: "pppp" },
  ]);
  try { await self.comment_mark_read(); } finally { restore(); }
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].dest.map((d) => d.socket_id), ["mine-other"]);
  assert.equal(sent[0].payload.options.service, "task.comment_mark_read");
  assert.equal(sent[0].payload.options.hub_id, "HUB1");
  assert.equal(sent[0].payload.model.task_id, "A");
});

test("comment_mark_read with no other own socket sends nothing", async () => {
  const { self } = makeTask({ task_id: "A", socket_id: "mine-here" }, [{ task_id: "A", read_ts: 1 }]);
  const { sent, restore } = withSockets(self, [
    { socket_id: "mine-here", uid: UID },
    { socket_id: "peer", uid: "pppp" },
  ]);
  try { await self.comment_mark_read(); } finally { restore(); }
  assert.equal(sent.length, 0);
});

test("acl: both services are src read", () => {
  assert.equal(acl.services.comment_unread.permission.src, "read");
  assert.equal(acl.services.comment_unread.scope, "hub");
  assert.equal(acl.services.comment_mark_read.permission.src, "read");
  assert.equal(acl.services.comment_mark_read.scope, "hub");
});
