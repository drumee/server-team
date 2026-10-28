// calendar.list: a task row carries what the Personal Calendar's Day-view
// card draws — the subtask rollups and the attached files — straight from
// task_list_range. An instance whose procedure predates those columns still
// lists, with 0 / 0 / [].
//
// Run: node --test test/calendar-task-card-fields.test.js
const assert = require("node:assert/strict");
const test = require("node:test");

global.myDrumee = { arch: "pod", useEmail: 0 };
global.verbosity = 0;
global.debug = {};

const Calendar = require("../service/private/calendar");

const UID = "uuuu1111uuuu1112";
const OWN_DB = "9_own";

function makeCalendar(personalTasks) {
  const seen = {};
  const input = { from: "2026-10-01", to: "2026-10-31" };
  const self = Object.create(Calendar.prototype);
  Object.assign(self, {
    uid: UID,
    input: { need: (k) => input[k], use: (k, d) => (input[k] == null ? d : input[k]) },
    user: { toJSON: () => ({ db_name: OWN_DB }) },
    yp: {
      await_proc: async (name) => {
        if (name === "meeting_schedule_range") return [];
        if (name === `${OWN_DB}.show_hubs`) return [];
        if (name === `${OWN_DB}.task_list_range`) return personalTasks;
        throw new Error(`unexpected proc ${name}`);
      },
    },
    exception: { user: (code) => { seen.error = code; } },
    output: { list: (rows) => { seen.rows = rows; } },
    warn: () => {},
    parseJSON: (v) => v,
  });
  return { self, seen };
}

const base = { id: "t1", title: "T", due_date: "2026-10-12" };
const only = (seen) => {
  assert.equal(seen.error, undefined);
  const rows = seen.rows.filter((r) => r.kind === "task");
  assert.equal(rows.length, 1);
  return rows[0];
};

test("task rows carry subtask counts and files", async () => {
  const { self, seen } = makeCalendar([
    {
      ...base,
      subtask_total: "2",
      subtask_done: "1",
      linked_files:
        '[{"nid":"n1","filename":"spec","extension":"docx","category":"document"}]',
    },
  ]);
  await self.list();
  const row = only(seen);
  assert.equal(row.subtask_total, 2);
  assert.equal(row.subtask_done, 1);
  assert.deepEqual(row.linked_files, [{ nid: "n1", filename: "spec", extension: "docx" }]);
});

test("an unpatched SP row still lists", async () => {
  const { self, seen } = makeCalendar([{ ...base }]);
  await self.list();
  const row = only(seen);
  assert.equal(row.subtask_total, 0);
  assert.equal(row.subtask_done, 0);
  assert.deepEqual(row.linked_files, []);
});

test("files with no name are dropped", async () => {
  const { self, seen } = makeCalendar([
    {
      ...base,
      linked_files: [
        { nid: "n1", filename: "a", extension: "pdf" },
        { nid: "n2", filename: null, extension: null },
      ],
    },
  ]);
  await self.list();
  assert.deepEqual(only(seen).linked_files, [{ nid: "n1", filename: "a", extension: "pdf" }]);
});

test("malformed linked_files JSON reads as no files", async () => {
  const { self, seen } = makeCalendar([{ ...base, linked_files: "[{oops" }]);
  await self.list();
  assert.deepEqual(only(seen).linked_files, []);
});
