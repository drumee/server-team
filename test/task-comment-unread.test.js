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

test("comment_mark_read stamps for this.uid and does not broadcast", async () => {
  const { self, seen } = makeTask({ task_id: "A" }, [{ task_id: "A", read_ts: 1234 }]);
  await self.comment_mark_read();
  assert.deepEqual(seen.calls, [["task_comment_mark_read", "A", UID]]);
  assert.equal(seen.data.task_id, "A");
  assert.equal(seen.broadcasts.length, 0);
});

test("acl: both services are src read", () => {
  assert.equal(acl.services.comment_unread.permission.src, "read");
  assert.equal(acl.services.comment_unread.scope, "hub");
  assert.equal(acl.services.comment_mark_read.permission.src, "read");
  assert.equal(acl.services.comment_mark_read.scope, "hub");
});
