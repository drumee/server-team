// media.rename on a WORKSPACE reaches every member when a hub admin does it.
//
// Each member's desk holds its own row for a workspace (media, category hub)
// and the desk lists that row's name. rename() only ever ran mfs_rename on the
// CALLER's desk and pushed to the CALLER's sockets, so every other member kept
// the old name — and the dest it would have pushed them was read from the
// caller's db anyway.
//
// A hub admin's rename now also calls yp.hub_rename_for_members, reads each
// member's node back from THEIR db, and pushes to the hub's sockets. Anyone
// below admin keeps the personal rename.
//
// Run: node --test test/hub-rename-members.test.js
const assert = require("node:assert/strict");
const test = require("node:test");

global.myDrumee = { arch: "pod", useEmail: 0 };
global.verbosity = 0;
global.debug = {};

const { RedisStore, Attr } = require("@drumee/server-essentials");
const MediaPrivate = require("../service/private/media");

const sent = [];
RedisStore.sendData = async (payload, dest) => {
  sent.push({ payload, dest });
};

const HUB_ID = "hub-1";
const CALLER = { uid: "u1", db: "db_u1" };
const MEMBER = { uid: "u2", db: "db_u2" };

function node(uid, filename) {
  return {
    nid: HUB_ID,
    id: HUB_ID,
    filename,
    filetype: Attr.hub,
    actual_hub_id: HUB_ID,
    actual_home_id: "home-1",
    permission: 63,
    owner: uid,
  };
}

function fakeService({ privilege }) {
  const calls = [];
  // Per-desk names, as the two databases would hold them.
  const names = { [CALLER.uid]: "Old", [MEMBER.uid]: "Old" };
  const svc = Object.create(MediaPrivate.prototype);
  Object.assign(svc, {
    calls,
    uid: CALLER.uid,
    __changelog: {},
    randomString: () => "tag",
    source_granted: () => ({ node: { ...node(CALLER.uid, "Old"), hub_id: CALLER.uid } }),
    input: { need: () => "New Name", get: () => undefined, use: () => undefined },
    exception: { user: (code) => calls.push(["exception", code]) },
    hub: { get: (k) => (k === Attr.id ? CALLER.uid : k === Attr.db_name ? CALLER.db : undefined) },
    changelog_write: async () => {},
    payload: (model) => ({ model }),
    output: { data: (d) => (svc.result = d) },
    warn: () => {},
    db: {
      // The CALLER's desk: whatever uid it is asked about, it answers its own row.
      await_proc: async (name, ...args) => {
        calls.push(["db", name, ...args]);
        if (name === "mfs_rename") names[CALLER.uid] = args[1];
        if (name === "mfs_access_node") return node(args[0], names[CALLER.uid]);
        return {};
      },
    },
    yp: {
      await_query: async (sql, id) => {
        calls.push(["yp.query", id]);
        return [{ db_name: "hub_db" }];
      },
      await_func: async (name, ...args) => {
        calls.push(["yp.func", name, ...args]);
        return privilege;
      },
      await_proc: async (name, ...args) => {
        calls.push(["yp", name, ...args]);
        if (name === "entity_sockets") {
          return args[0] === HUB_ID
            ? [{ socket_id: "s1", uid: CALLER.uid }, { socket_id: "s2", uid: MEMBER.uid }]
            : [{ socket_id: "s1", uid: CALLER.uid }];
        }
        if (name === "hub_rename_for_members") {
          names[MEMBER.uid] = args[1];
          return [
            { uid: CALLER.uid, db_name: CALLER.db, old_filename: "New Name", filename: "New Name", changed: 0 },
            { uid: MEMBER.uid, db_name: MEMBER.db, old_filename: "Old", filename: "New Name", changed: 1 },
          ];
        }
        if (name === `${MEMBER.db}.mfs_access_node`) return node(args[0], names[MEMBER.uid]);
        return {};
      },
    },
  });
  return svc;
}

test("hub admin: every member's row is renamed and every member is told", async () => {
  sent.length = 0;
  const svc = fakeService({ privilege: 63 });
  await svc.rename();

  assert.ok(svc.calls.some((c) => c[0] === "yp.func" && c[1] === "hub_db.user_permission" && c[2] === CALLER.uid));
  assert.ok(svc.calls.some((c) => c[1] === "hub_rename_for_members" && c[2] === HUB_ID && c[3] === "New Name"));

  const toMember = sent.find((s) => s.dest.socket_id === "s2");
  assert.ok(toMember, "the other member gets a push");
  assert.equal(toMember.payload.model.args.dest.filename, "New Name");
  assert.equal(toMember.payload.model.args.src.filename, "Old");
  assert.equal(toMember.payload.model.filetype, Attr.hub);
  // Read from the MEMBER's db, never the caller's.
  assert.ok(svc.calls.some((c) => c[1] === `${MEMBER.db}.mfs_access_node` && c[2] === MEMBER.uid));

  const toCaller = sent.find((s) => s.dest.socket_id === "s1");
  assert.equal(toCaller.payload.model.args.dest.filename, "New Name");
  assert.equal(svc.result.args.dest.filename, "New Name");
});

test("member below admin: personal rename only, nobody else touched", async () => {
  sent.length = 0;
  const svc = fakeService({ privilege: 3 });
  await svc.rename();

  assert.ok(!svc.calls.some((c) => c[1] === "hub_rename_for_members"));
  assert.deepEqual(sent.map((s) => s.dest.socket_id), ["s1"]);
  assert.equal(svc.result.args.dest.filename, "New Name");
});

test("not a hub: the shared path never runs", async () => {
  sent.length = 0;
  const svc = fakeService({ privilege: 63 });
  const granted = svc.source_granted;
  svc.source_granted = () => ({ node: { ...granted().node, filetype: Attr.folder } });
  await svc.rename();

  assert.ok(!svc.calls.some((c) => c[0] === "yp.func" || c[1] === "hub_rename_for_members"));
});

test("shared path throws: the caller's rename still answers, personal push only", async () => {
  sent.length = 0;
  const svc = fakeService({ privilege: 63 });
  const proc = svc.yp.await_proc;
  svc.yp.await_proc = async (name, ...args) => {
    if (name === "hub_rename_for_members") throw new Error("boom");
    return proc(name, ...args);
  };
  await svc.rename();

  assert.equal(svc.result.args.dest.filename, "New Name");
  assert.deepEqual(sent.map((s) => s.dest.socket_id), ["s1"]);
});
