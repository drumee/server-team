// hub.set_privilege and hub.delete_contributor tell the WHOLE hub.
//
// Before this, both pushed only to the member being changed: set_privilege
// sent { privilege, hub_id, area } to that member's sockets, and
// delete_contributor sent media.remove + hub.member_removed to the removed
// member's. Every other admin with the permission matrix open kept the old row
// until they reopened the panel.
//
// Each now ends with ONE hub.members_changed broadcast to the hub's sockets,
// after the per-member work, so the matrices refetch a committed state. The
// existing per-member pushes are unchanged — the changed member's own windows
// still rely on them.
//
// Run: node --test test/members-changed-push.test.js
const assert = require("node:assert/strict");
const test = require("node:test");

global.myDrumee = { arch: "pod", useEmail: 0 };
global.verbosity = 0;
global.debug = {};

const { RedisStore, Attr } = require("@drumee/server-essentials");
const HubPrivate = require("../service/private/hub");

// hub.js and notify-member-joined.js both destructure this same RedisStore
// object, so patching the method reaches every send without a Redis.
const sent = [];
RedisStore.sendData = async (payload, dest) => {
  sent.push({ payload, dest });
};

const HUB_SOCKETS = [{ socket_id: "s-admin-a" }, { socket_id: "s-admin-b" }];
const HUB = {
  [Attr.id]: "hub-1",
  [Attr.hub_id]: "hub-1",
  [Attr.area]: "private",
  [Attr.db_name]: "hub_db",
  [Attr.profile]: { name: "Design team" },
  [Attr.settings]: {},
};

function fakeService({ users, privilege }) {
  const procs = [];
  return {
    procs,
    uid: "admin-a",
    input: {
      need: (k) => (k === Attr.users ? users : undefined),
      use: (k) => (k === Attr.privilege ? privilege : undefined),
      get: () => undefined,
    },
    hub: { get: (k) => HUB[k] },
    db: {
      await_proc: async (name, ...args) => {
        procs.push(["db", name, ...args]);
        return name === "mfs_home" ? { chat_upload_id: "chat-up" } : {};
      },
    },
    yp: {
      await_proc: async (name, ...args) => {
        procs.push(["yp", name, ...args]);
        if (name === "user_sockets") return [{ socket_id: `s-${args[0]}` }];
        if (name === "entity_sockets") return HUB_SOCKETS;
        if (name === "get_entity") return { db_name: `db_${args[0]}` };
        return [];
      },
    },
    payload: (data, options) => ({ data, options }),
    output: { data: () => {}, list: () => {} },
    warn: () => {},
    granted_node: () => ({}),
    _actor_name: () => "Admin A",
    _unassign_tasks: async () => {},
    _broadcast_task_unassign: async () => {},
    _trackWorkspaceMembers: async () => {},
    _members_by_type: async () => [],
  };
}

const broadcasts = () =>
  sent.filter((s) => s.payload.options?.service === "hub.members_changed");

test("set_privilege broadcasts one hub.members_changed to the hub, last", async () => {
  sent.length = 0;
  const svc = fakeService({ users: ["u1", "u2"], privilege: 15 });
  await HubPrivate.prototype.set_privilege.call(svc);

  const b = broadcasts();
  assert.equal(b.length, 1, "one broadcast for the whole request");
  assert.deepEqual(b[0].payload.data, {
    hub_id: "hub-1",
    change: "privilege",
    users: ["u1", "u2"],
  });
  assert.deepEqual(b[0].dest, HUB_SOCKETS);
  assert.equal(sent.at(-1), b[0],
    "sent after every per-member write, so a refetch reads committed rows");

  // The changed members' own live-privilege pushes are still there.
  const own = sent.filter((s) => s !== b[0]);
  assert.deepEqual(own.map((s) => s.dest), [[{ socket_id: "s-u1" }], [{ socket_id: "s-u2" }]]);
  assert.ok(own.every((s) => s.payload.data.privilege === 15));
});

test("delete_contributor broadcasts one hub.members_changed for the removed members", async () => {
  sent.length = 0;
  // The acting admin in the list is skipped by delete_contributor itself and
  // must not be reported as removed.
  const svc = fakeService({ users: ["u1", "admin-a", "u2"] });
  await HubPrivate.prototype.delete_contributor.call(svc);

  const b = broadcasts();
  assert.equal(b.length, 1);
  assert.deepEqual(b[0].payload.data, {
    hub_id: "hub-1",
    change: "removed",
    users: ["u1", "u2"],
  });
  assert.deepEqual(b[0].dest, HUB_SOCKETS);

  // The removed members' own notices are unchanged.
  const removedNotices = sent.filter(
    (s) => s.payload.options?.service === "hub.member_removed",
  );
  assert.deepEqual(removedNotices.map((s) => s.dest), [[{ socket_id: "s-u1" }], [{ socket_id: "s-u2" }]]);
});

test("delete_contributor with only the admin themself broadcasts nothing", async () => {
  sent.length = 0;
  const svc = fakeService({ users: ["admin-a"] });
  await HubPrivate.prototype.delete_contributor.call(svc);
  assert.equal(broadcasts().length, 0, "no membership changed, so no matrix needs a refetch");
});
