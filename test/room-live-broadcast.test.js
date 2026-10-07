/**
 * Cover for room._broadcast — book / update / remove tell every socket on the
 * hub, so an open Meet calendar on another device (or another member's)
 * refetches instead of waiting for a reload.
 *
 *   1. every hub socket is told, the caller's own included, when the request
 *      carries no socket_id (one person on phone + browser);
 *   2. only the originating socket is dropped when socket_id is sent;
 *   3. a failed push never fails the call — the meeting is already saved.
 *
 * Run: node test/room-live-broadcast.test.js
 */
const assert = require("assert");
const path = require("path");

const stub = (rel, exports) => {
  const p = require.resolve(path.join(__dirname, "..", rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
const sent = [];
let pushFails = false;
require.cache[require.resolve("@drumee/server-essentials")] = {
  exports: {
    Attr: { id: "id", nid: "nid", flag: "flag", title: "title", date: "date", message: "message",
      stime: "stime", etime: "etime", attendees: "attendees", profile: "profile", socket_id: "socket_id" },
    Privilege: {}, Cache: { getSysConf: () => null }, sysEnv: () => ({}),
    RedisStore: {
      sendData: async (payload, dest) => {
        if (pushFails) throw new Error("redis down");
        sent.push({ payload, dest });
      },
    },
    toArray: (v) => (Array.isArray(v) ? v : v == null ? [] : [v]),
  },
};
stub("service/room.js", class {});
stub("service/lib/member-capability.js", { memberCan: async () => true, CAN_WRITE: 2 });
const Room = require("../service/private/room");

const HUB = "hhhhhhhhhhhhhhhh", MEET = "aaaaaaaaaaaaaaaa", OWNER = "uuuuuuuuuuuuuuuu";
const SOCKETS = [
  { uid: OWNER, socket_id: "owner-phone" },
  { uid: OWNER, socket_id: "owner-browser" },
  { uid: "mmmmmmmmmmmmmmmm", socket_id: "member-browser" },
];

function make(input = {}) {
  const out = {};
  const self = Object.create(Room.prototype);
  Object.assign(self, {
    uid: OWNER,
    home_id: "rrrrrrrrrrrrrrrr",
    hub: { get: () => HUB },
    user: { get: (k) => (k === "profile" ? { lang: "en" } : "Org"), locale_message: () => ({ format: () => "" }) },
    input: {
      need: (k) => { if (input[k] == null) throw new Error(`missing ${k}`); return input[k]; },
      use: (k, d) => (input[k] == null ? d : input[k]),
      get: (k) => input[k],
      ua_language: () => "en",
    },
    parseJSON: (v) => (typeof v === "string" ? JSON.parse(v) : v),
    db: {
      await_proc: async (name) => {
        if (name === "mfs_create_node") return { id: MEET };
        if (name === "mfs_node_attr") {
          return { id: MEET, metadata: JSON.stringify({ content: JSON.stringify({ created_by: OWNER }) }) };
        }
        return {};
      },
    },
    yp: { await_proc: async (name) => (name === "entity_sockets" ? SOCKETS : []) },
    payload: (data, options) => ({ ...options, data }),
    exception: { user: (code) => { out.error = code; }, forbiden: () => { out.error = "FORBIDDEN"; } },
    output: { data: (d) => { out.data = d; } },
    debug: () => {},
    warn: () => {},
    _index_meeting: async () => {},
    _unindex_meeting: async () => {},
    _meeting_folder_name: async () => "",
  });
  return { self, out };
}

const socketsOf = (push) => push.dest.map((d) => d.socket_id).sort();

(async () => {
  // book, no socket_id: every hub socket hears it, the caller's other device included
  {
    sent.length = 0;
    const { self, out } = make({ title: "Standup", stime: 100, etime: 200 });
    await self.book();
    assert.strictEqual(out.data.id, MEET);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].payload.service, "room.book");
    assert.deepStrictEqual(sent[0].payload.data, { nid: MEET, hub_id: HUB });
    assert.deepStrictEqual(socketsOf(sent[0]), ["member-browser", "owner-browser", "owner-phone"]);
  }
  // update with socket_id: only the socket that made the call is skipped
  {
    sent.length = 0;
    const { self } = make({ nid: MEET, flag: "all", title: "Moved", attendees: [], socket_id: "owner-phone" });
    await self.update();
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].payload.service, "room.update");
    assert.deepStrictEqual(socketsOf(sent[0]), ["member-browser", "owner-browser"]);
  }
  // remove
  {
    sent.length = 0;
    const { self, out } = make({ nid: MEET });
    await self.remove();
    assert.deepStrictEqual(out.data, { nid: MEET });
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].payload.service, "room.remove");
    assert.deepStrictEqual(sent[0].payload.data, { nid: MEET, hub_id: HUB });
  }
  // a failed push does not fail the booking
  {
    pushFails = true;
    const { self, out } = make({ title: "Standup", stime: 100, etime: 200 });
    await self.book();
    pushFails = false;
    assert.strictEqual(out.data.id, MEET);
    assert.strictEqual(out.error, undefined);
  }
  console.log("room-live-broadcast: ok");
})().catch((e) => { console.error(e); process.exit(1); });
