// room.link_info and room.public_link's keep_password: the Personal
// Calendar's "Meeting Information" form shows an existing meeting's guest
// link and its gate (require email, allowed emails, password) and saves
// changes to that SAME link. dmz_grant_next reuses the token for the same
// hub/node/guest, so the URL survives; but it re-derives the password
// fingerprint from the call's pw, so keep_password restores the old one when
// no new password is given.
//
// Run: node --test test/room-link-info.test.js
const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("path");

const stub = (rel, exports) => {
  const p = require.resolve(path.join(__dirname, "..", rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
const PUBLIC = "360deefd360def00";
const HUB = "hhhhhhhhhhhhhhhh";
const MEET = "aaaaaaaaaaaaaaaa";
require.cache[require.resolve("@drumee/server-essentials")] = {
  exports: {
    Attr: { id: "id", nid: "nid", password: "password", days: "days", hours: "hours", permission: "permission" },
    Privilege: { write: 15, download: 7 },
    Cache: { getSysConf: (k) => (k === "public_id" ? PUBLIC : null), message: () => "" },
    sysEnv: () => ({}),
    toArray: (v) => (Array.isArray(v) ? v : v == null ? [] : [v]),
    RedisStore: { sendData: async () => {} },
  },
};
stub("service/room.js", class {});
stub("service/lib/member-capability.js", { memberCan: async () => true, CAN_WRITE: 2 });
const Room = require("../service/private/room");

function make({ input = {}, token = null } = {}) {
  const queries = [];
  const calls = [];
  const out = {};
  const self = Object.create(Room.prototype);
  Object.assign(self, {
    uid: "uuuuuuuuuuuuuuuu",
    hub: { get: () => HUB },
    input: {
      need: (k) => { if (input[k] == null) throw new Error(`missing ${k}`); return input[k]; },
      use: (k, d) => (input[k] == null ? d : input[k]),
      get: (k) => input[k],
    },
    parseJSON: (v) => (typeof v === "string" ? JSON.parse(v) : v),
    db: { await_proc: async (name, ...args) => { calls.push([name, ...args]); return {}; } },
    yp: {
      await_proc: async (name, ...args) => { calls.push([name, ...args]); return { token: "tok1" }; },
      await_query: async (sql, ...args) => {
        queries.push([sql, ...args]);
        if (/^SELECT/.test(sql)) return token ? [token] : [];
        return {};
      },
    },
    output: { data: (d) => { out.data = d; } },
    randomString: () => "r",
    debug: () => {},
    _getShareLink: (t) => `https://x/#/dmz/meeting/${t}`,
  });
  return { self, queries, calls, out };
}

test("link_info answers the meeting's link and gate, never the password", async () => {
  const { self, queries, out } = make({
    input: { nid: MEET },
    token: { id: "tok1", fingerprint: "fp", require_email: 1, allowed_emails: '["a@x.com","@y.org"]' },
  });
  await self.link_info();
  assert.deepEqual(out.data, {
    link: "https://x/#/dmz/meeting/tok1",
    require_email: 1,
    allowed_emails: ["a@x.com", "@y.org"],
    has_password: true,
  });
  // The meeting's own PUBLIC link, in this hub.
  assert.deepEqual(queries[0].slice(1), [HUB, MEET, PUBLIC]);
});

test("link_info with no link yet answers an empty gate", async () => {
  const { self, out } = make({ input: { nid: MEET } });
  await self.link_info();
  assert.deepEqual(out.data, { link: null, require_email: 0, allowed_emails: [], has_password: false });
});

test("public_link with keep_password and no new password restores the old fingerprint", async () => {
  const { self, queries } = make({
    input: { nid: MEET, keep_password: 1 },
    token: { id: "tok1", fingerprint: "oldfp", require_email: 0, allowed_emails: null },
  });
  await self.public_link();
  const restore = queries.find((q) => /^UPDATE dmz_token SET fingerprint/.test(q[0]));
  assert.ok(restore, "fingerprint restored");
  assert.deepEqual(restore.slice(1), ["oldfp", "tok1"]);
});

test("a new password wins over keep_password", async () => {
  const { self, queries } = make({
    input: { nid: MEET, keep_password: 1, password: "new" },
    token: { id: "tok1", fingerprint: "oldfp" },
  });
  await self.public_link();
  assert.ok(!queries.some((q) => /^UPDATE dmz_token SET fingerprint/.test(q[0])));
});

test("without keep_password, public_link behaves as before (no restore)", async () => {
  const { self, queries } = make({
    input: { nid: MEET },
    token: { id: "tok1", fingerprint: "oldfp" },
  });
  await self.public_link();
  assert.ok(!queries.some((q) => /^UPDATE dmz_token SET fingerprint/.test(q[0])));
});
