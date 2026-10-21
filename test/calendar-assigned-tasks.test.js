// calendar.list: a workspace task is listed only when it is assigned to the
// caller (Lexis, 2026-10-20). Personal tasks are the caller's own and carry no
// assignee, so they are never filtered.
//
// Run: node --test test/calendar-assigned-tasks.test.js
const assert = require("node:assert/strict");
const test = require("node:test");

global.myDrumee = { arch: "pod", useEmail: 0 };
global.verbosity = 0;
global.debug = {};

const Calendar = require("../service/private/calendar");

const UID = "uuuu1111uuuu1112";
const OTHER = "oooo2222oooo2223";
const OWN_DB = "9_own";
const HUB = { id: "hub0team00000001", db_name: "db_team", name: "Team" };

function makeCalendar(workspaceTasks) {
  const calls = [];
  const seen = {};
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
        if (name === `${OWN_DB}.show_hubs`) return [HUB];
        // A personal task has no assignee at all.
        if (name === `${OWN_DB}.task_list_range`) {
          return [{ id: "task0personal001", title: "Mine", due_date: "2026-10-10", assignee_uids: null }];
        }
        if (name === "db_team.task_list_range") return workspaceTasks;
        if (name === "db_team.mfs_home") return { hub_id: HUB.id, home_id: "home_team" };
        if (name === "db_team.mfs_access_node") return { privilege: 15 };
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

const task = (id, assignee_uids) => ({ id, title: id, due_date: "2026-10-12", assignee_uids });
const ids = (rows) => rows.map((r) => r.id).sort();

test("only the workspace tasks assigned to the caller are listed", async () => {
  const { self, seen } = makeCalendar([
    task("t_mine", UID),
    task("t_shared", `${OTHER},${UID}`),
    task("t_other", OTHER),
    task("t_nobody", null),
  ]);
  await self.list();
  assert.equal(seen.error, undefined);
  assert.deepEqual(ids(seen.rows), ["t_mine", "t_shared", "task0personal001"]);
});

test("a uid that merely contains the caller's uid does not match", async () => {
  const { self, seen } = makeCalendar([task("t_prefix", `${UID}x`), task("t_suffix", `x${UID}`)]);
  await self.list();
  assert.deepEqual(ids(seen.rows), ["task0personal001"]);
});

test("personal tasks are listed although they carry no assignee", async () => {
  const { self, seen } = makeCalendar([]);
  await self.list();
  const personal = seen.rows.find((r) => r.scope === "personal");
  assert.ok(personal);
  assert.equal(personal.id, "task0personal001");
});

test("a workspace with none of the caller's tasks costs no privilege read", async () => {
  const { self, calls, seen } = makeCalendar([task("t_other", OTHER)]);
  await self.list();
  assert.equal(seen.error, undefined);
  assert.ok(!seen.rows.some((r) => r.hub_id === HUB.id));
  assert.ok(!calls.some((c) => c[0].startsWith("db_team.mfs_")));
});
