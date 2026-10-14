// hub.get_members_by_type with names:"profile" answers each member's own
// profile name instead of the viewer's contact-book copy of it (meeting
// roster). Without the flag nothing changes.
//
// Run: node --test test/members-profile-names.test.js
const assert = require("node:assert/strict");
const test = require("node:test");

global.myDrumee = { arch: "pod", useEmail: 0 };
global.verbosity = 0;
global.debug = {};

const { Attr } = require("@drumee/server-essentials");
const HubPrivate = require("../service/private/hub");

// What hub_get_members_by_type answers to a viewer whose contact book still
// holds the names from before m1 renamed themselves.
const ROWS = [
  { id: "m1", email: "a@x.io", firstname: "Old", lastname: "Name", fullname: "Old Name", surname: "Old Name" },
  { id: "m2", email: "b@x.io", firstname: "Bob", lastname: "Ray", fullname: "Bob Ray", surname: "Bob Ray" },
  { id: "m3", email: "c@x.io", firstname: "Keep", lastname: "Me", fullname: "Keep Me", surname: "Keep Me" },
];
const PROFILES = [
  { id: "m1", firstname: "New", lastname: "Name" },
  { id: "m2", firstname: "Bob", lastname: null },
  { id: "m3", firstname: null, lastname: "" }, // no profile name → row kept
];

function fakeService({ names, queryThrows = false } = {}) {
  const queries = [];
  const svc = Object.create(HubPrivate.prototype);
  Object.assign(svc, {
    queries,
    uid: "viewer",
    input: {
      need: (k) => (k === Attr.type ? "all" : undefined),
      use: (k, d) => (k === "names" ? names : d),
    },
    hub: { get: (k) => (k === Attr.area ? "private" : undefined) },
    db: { await_proc: async () => ROWS.map((r) => ({ ...r })) },
    yp: {
      await_query: async (sql, ...args) => {
        queries.push([sql, args]);
        if (queryThrows) throw new Error("boom");
        return PROFILES.filter((p) => args.includes(p.id));
      },
      await_proc: async () => [],
    },
    syslog: () => {},
    output: { list: (rows) => (svc.result = rows) },
  });
  return svc;
}

test("names:profile → live profile names, one query for the page", async () => {
  const svc = fakeService({ names: "profile" });
  await svc.get_members_by_type();
  assert.equal(svc.queries.length, 1);
  assert.match(svc.queries[0][0], /FROM yp\.drumate WHERE id IN \(\?,\?,\?\)/);
  assert.deepEqual(svc.queries[0][1], ["m1", "m2", "m3"]);
  const [m1, m2, m3] = svc.result;
  assert.equal(m1.fullname, "New Name");
  assert.equal(m1.surname, "New Name");
  assert.equal(m1.firstname, "New");
  assert.equal(m2.fullname, "Bob");
  assert.equal(m2.lastname, null, "a blank part is null, never ''");
  assert.equal(m3.fullname, "Keep Me", "no profile name → contact name kept");
  assert.equal(m1.email, "a@x.io", "other fields untouched");
});

test("without the flag the contact-book names are returned as before", async () => {
  const svc = fakeService({});
  await svc.get_members_by_type();
  assert.equal(svc.queries.length, 0);
  assert.equal(svc.result[0].fullname, "Old Name");
});

test("lookup failure → rows returned unchanged", async () => {
  const svc = fakeService({ names: "profile", queryThrows: true });
  await svc.get_members_by_type();
  assert.equal(svc.result[0].fullname, "Old Name");
});
