// The "someone's membership changed" broadcast behind every open permission
// matrix.
//
// THE REPORT: an admin changes a member's role (or removes them) and every
// OTHER admin with the matrix open keeps seeing the old row until they reopen
// the panel. hub.set_privilege and hub.delete_contributor only ever pushed to
// the member being changed, and the panels only refetch on hub.member_joined —
// so nothing reached the people looking at the list.
//
// notifyMembersChanged is the missing push. These lock what it sends, to whom,
// and that it can never fail the write it follows.
//
// Run: node --test test/notify-members-changed.test.js
const assert = require("node:assert/strict");
const test = require("node:test");

// Stub the two things the module reaches for before requiring it — the same
// shape revenue-live.test.js uses. toArray lives under `utils` here because
// that is where notify-member-joined.js reads it from.
const sent = [];
require.cache[require.resolve("@drumee/server-essentials")] = {
  exports: {
    RedisStore: {
      sendData: async (payload, dest) => {
        sent.push({ payload, dest });
      },
    },
    utils: {
      toArray: (v) => (Array.isArray(v) ? v : v == null ? [] : [v]),
    },
  },
};

const { notifyMembersChanged } = require("../service/lib/notify-member-joined");

const SOCKETS = [
  { socket_id: "s-admin-a", uid: "admin-a" },
  { socket_id: "s-admin-b", uid: "admin-b" },
];

function ctx({ rows = SOCKETS, fail = false } = {}) {
  const calls = [];
  const warnings = [];
  return {
    calls,
    warnings,
    yp: {
      await_proc: async (name, arg) => {
        calls.push([name, arg]);
        if (fail) throw new Error("db down");
        return rows;
      },
    },
    payload: (data, options) => ({ data, options }),
    warn: (...args) => warnings.push(args),
  };
}

test("sends ONE hub.members_changed push to every online member of the hub", async () => {
  sent.length = 0;
  const svc = ctx();
  await notifyMembersChanged(svc, "hub-1", {
    change: "privilege",
    users: ["u1", "u2"],
  });

  assert.deepEqual(svc.calls, [["entity_sockets", "hub-1"]],
    "the audience is the hub's sockets, not the changed member's own");
  assert.equal(sent.length, 1, "one push per request, not one per user");
  assert.equal(sent[0].payload.options.service, "hub.members_changed");
  assert.deepEqual(sent[0].payload.data, {
    hub_id: "hub-1",
    change: "privilege",
    users: ["u1", "u2"],
  });
  assert.deepEqual(sent[0].dest, SOCKETS);
});

test("a single user id is sent as a one-item list", async () => {
  sent.length = 0;
  await notifyMembersChanged(ctx(), "hub-1", { change: "removed", users: "u9" });
  assert.deepEqual(sent[0].payload.data.users, ["u9"]);
});

test("nobody online: nothing is sent", async () => {
  sent.length = 0;
  await notifyMembersChanged(ctx({ rows: [] }), "hub-1", {
    change: "removed",
    users: ["u1"],
  });
  assert.equal(sent.length, 0);
});

test("no hub id: does nothing at all", async () => {
  sent.length = 0;
  const svc = ctx();
  await notifyMembersChanged(svc, null, { change: "privilege", users: ["u1"] });
  assert.equal(svc.calls.length, 0);
  assert.equal(sent.length, 0);
});

test("never throws — the role change or removal has already committed", async () => {
  sent.length = 0;
  const svc = ctx({ fail: true });
  await assert.doesNotReject(
    notifyMembersChanged(svc, "hub-1", { change: "privilege", users: ["u1"] }),
  );
  assert.equal(sent.length, 0);
  assert.equal(svc.warnings.length, 1, "the failure is logged, not swallowed silently");
});
