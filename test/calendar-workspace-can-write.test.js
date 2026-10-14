// calendar.list: whether a workspace task row may be edited from the Calendar.
//
// can_write must follow the caller's role IN THE WORKSPACE, read from the
// workspace's own permission table (mfs_access_node on the hub root). The copy
// show_hubs reads lives in the caller's own database, and hub_add_member writes
// it as `privilege | 15` — so a member invited as view or chat, who never had
// their role changed, looks like an editor there. These lock the hub-side read,
// the view member who never changed role, and the fail-closed paths.
//
// Run: node --test test/calendar-workspace-can-write.test.js
const assert = require("node:assert/strict");
const test = require("node:test");

global.myDrumee = { arch: "pod", useEmail: 0 };
global.verbosity = 0;
global.debug = {};

const Calendar = require("../service/private/calendar");

const UID = "uuuu1111uuuu1112";
const OWN_DB = "9_own";

// Every hub as show_hubs reports it. `privilege` is the member-db copy: 15
// for anyone added through hub_add_member, whatever their real role.
const HUBS = {
  owner: { id: "hub0owner0000001", db_name: "db_owner", name: "Owned", privilege: 63, hubSide: 63 },
  edit: { id: "hub0edit00000001", db_name: "db_edit", name: "Edit", privilege: 15, hubSide: 15 },
  view: { id: "hub0view00000001", db_name: "db_view", name: "View", privilege: 15, hubSide: 3 },
  chat: { id: "hub0chat00000001", db_name: "db_chat", name: "Chat", privilege: 15, hubSide: 7 },
  broken: { id: "hub0broken000001", db_name: "db_broken", name: "Broken", privilege: 15, hubSide: "throw" },
  empty: { id: "hub0empty0000001", db_name: "db_empty", name: "Empty", privilege: 15, hubSide: 15, noTasks: true },
};
const homeOf = (db) => `home_${db}`;

function makeCalendar() {
  const calls = [];
  const seen = {};
  const byDb = {};
  for (const h of Object.values(HUBS)) byDb[h.db_name] = h;
  const input = { from: "2026-10-01", to: "2026-10-31" };
  const self = Object.create(Calendar.prototype);
  Object.assign(self, {
    uid: UID,
    input: { need: (k) => input[k], use: (k, d) => (input[k] == null ? d : input[k]) },
    user: { toJSON: () => ({ db_name: OWN_DB }) },
    yp: {
      await_proc: async (name, ...args) => {
        calls.push([name, ...args]);
        if (name === "meeting_schedule_range") return [];
        if (name === `${OWN_DB}.show_hubs`) {
          return Object.values(HUBS).map(({ id, db_name, name: n, privilege }) => ({ id, db_name, name: n, privilege }));
        }
        if (name === `${OWN_DB}.task_list_range`) return [{ id: "task0personal001", title: "Mine", due_date: "2026-10-10" }];
        const [db, proc] = name.split(".");
        const hub = byDb[db];
        if (!hub) throw new Error(`unexpected proc ${name}`);
        if (proc === "task_list_range") {
          return hub.noTasks ? [] : [{ id: `task_${db}`, title: hub.name, due_date: "2026-10-12" }];
        }
        if (proc === "mfs_home") return { hub_id: hub.id, home_id: homeOf(db) };
        if (proc === "mfs_access_node") {
          if (hub.hubSide === "throw") throw new Error("db down");
          // Only the caller's own row on the real root answers.
          if (args[0] !== UID || args[1] !== homeOf(db)) return null;
          return { id: args[1], privilege: hub.hubSide, permission: hub.hubSide };
        }
        throw new Error(`unexpected proc ${name}`);
      },
    },
    exception: { user: (code) => { seen.error = code; } },
    output: { list: (rows) => { seen.rows = rows; } },
    warn: () => {},
    parseJSON: (v) => v,
  });
  return { self, calls, seen };
}

const rowOf = (rows, hubKey) => rows.find((r) => r.hub_id === HUBS[hubKey].id);

test("a workspace task follows the caller's role in that workspace", async () => {
  const { self, seen } = makeCalendar();
  await self.list();
  assert.equal(seen.error, undefined);
  assert.equal(rowOf(seen.rows, "owner").can_write, 1);
  assert.equal(rowOf(seen.rows, "edit").can_write, 1);
  assert.equal(rowOf(seen.rows, "chat").can_write, 0);
  const personal = seen.rows.find((r) => r.scope === "personal");
  assert.equal(personal.can_write, 1);
});

test("a view member who never changed role reads 0, although show_hubs says 15", async () => {
  const { self, seen } = makeCalendar();
  await self.list();
  const row = rowOf(seen.rows, "view");
  assert.ok(row, "the view member's task is still listed");
  assert.equal(row.scope, "workspace");
  assert.equal(row.can_write, 0);
});

test("the privilege is read on the workspace root that mfs_home names, for the caller", async () => {
  const { self, calls } = makeCalendar();
  await self.list();
  const read = calls.find((c) => c[0] === "db_edit.mfs_access_node");
  assert.deepEqual(read, ["db_edit.mfs_access_node", UID, homeOf("db_edit")]);
});

test("a failed privilege read closes the edit but keeps the row", async () => {
  const { self, seen } = makeCalendar();
  await self.list();
  const row = rowOf(seen.rows, "broken");
  assert.ok(row, "the task is still listed");
  assert.equal(row.can_write, 0);
});

test("a workspace with no task in the window costs no privilege read", async () => {
  const { self, calls, seen } = makeCalendar();
  await self.list();
  assert.equal(rowOf(seen.rows, "empty"), undefined);
  assert.ok(!calls.some((c) => c[0].startsWith("db_empty.mfs_")));
});
