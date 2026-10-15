/**
 * Cover for the room an invite link's guest joins, and for a guest waiting in
 * it: the workspace's one meeting room, where the host is, not the meeting node.
 * Run: node test/conference-meeting-room.test.js
 */
const assert = require("assert");
const path = require("path");
const fs = require("fs");

// conference.js has a heavy require graph; slice the methods out and run them
// against a stub `this` (the technique of test/dmz-meeting-files.test.js).
const SRC = fs.readFileSync(path.join(__dirname, "../service/conference.js"), "utf8");
function slice(sig) {
  const start = SRC.indexOf(`\n  ${sig} {`);
  if (start < 0) throw new Error(`${sig} not found`);
  const end = SRC.indexOf("\n  }\n", start);
  return SRC.slice(start, end + 4).trim().replace(/^async\s+([A-Za-z_]\w*)\s*\(/, "async function $1(");
}
const toArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const { isMeetingNode } = require("../service/lib/meeting-attachments");
const { sqlString } = require("../service/lib/sql-literal");

const HUB = "hhhhhhhhhhhhhhhh", HOME = "0000000000000001", MEET = "aaaaaaaaaaaaaaaa", DIR = "bbbbbbbbbbbbbbbb";

const meetingRoom = new Function("toArray", "isMeetingNode", "sqlString",
  `return ${slice("async _meetingRoom(hub_id, room_id)")}`)(toArray, isMeetingNode, sqlString);

const ATTR = { meeting: "meeting", connect: "connect", id: "id", owner_id: "owner_id", type: "type", room_type: "room_type", dmz: "dmz" };
global.myDrumee = { conference: {} };

(async () => {
  {
    const nodes = {
      [MEET]: { nid: MEET, filetype: "schedule", actual_home_id: HOME, home_id: HOME },
      [DIR]: { nid: DIR, filetype: "folder", actual_home_id: HOME, home_id: HOME },
    };
    const self = { yp: { await_proc: async (_n, _hub, _proc, arg) => [nodes[String(arg).replace(/'/g, "")] || {}] } };
    // An invite link names the meeting: it becomes the workspace room, and
    // the meeting goes along as what admits the guest.
    assert.deepStrictEqual(await meetingRoom.call(self, HUB, MEET), { room_id: HOME, access_id: MEET });
    // Anything else is the room it was: the root itself, a folder, nothing.
    assert.deepStrictEqual(await meetingRoom.call(self, HUB, HOME), { room_id: HOME, access_id: null });
    assert.deepStrictEqual(await meetingRoom.call(self, HUB, DIR), { room_id: DIR, access_id: null });
    assert.deepStrictEqual(await meetingRoom.call(self, HUB, undefined), { room_id: undefined, access_id: null });
    const broken = { yp: { await_proc: async () => { throw new Error("no such hub"); } } };
    assert.deepStrictEqual(await meetingRoom.call(broken, HUB, MEET), { room_id: MEET, access_id: null });
  }

  // sendRoomInfo: who starts, who is told, who is announced.
  const sendRoomInfo = new Function("Attr", "toArray", "RedisStore", "claimStartAnnouncement", "onlyMembers",
    "workspaceMemberIds", "roomDeadline",
    `return ${slice("async sendRoomInfo(args)")}`);
  function room({ uid, user, attendees }) {
    const told = [];
    const announced = [];
    const out = {};
    const fn = sendRoomInfo(ATTR, toArray,
      { sendData: async (payload) => { announced.push(payload); } },
      async () => true, (sockets) => sockets, async () => [], async () => null);
    const self = {
      uid,
      input: { get: () => undefined, need: () => "meeting" },
      hub: { get: (k) => (k === "id" ? HUB : "owner") },
      db: { await_proc: async () => ({}) },
      yp: { await_proc: async () => [{ id: "member-socket" }] },
      inform: async ({ recipients, payload }, service) => { told.push({ service, to: toArray(recipients).map((r) => r.uid), payload }); },
      payload: (p, o) => ({ ...p, ...o }),
      hubDisplayName: () => "",
      pushUserOnlineStatus: async () => {},
      output: { data: (d) => { out.data = d; } },
      warn: () => {}, debug: () => {},
    };
    return {
      run: () => fn.call(self, { user, room_id: HOME, socket_id: "s1", metadata: { type: "meeting" }, attendees }),
      told, announced,
    };
  }
  const GUEST = "gggggggggggggggg", OWNER = "oooooooooooooooo";
  {
    // A guest who comes first waits: no conference.start, no "started a meeting".
    const r = room({ uid: GUEST, user: { uid: GUEST, role: "attendee", waiting: 1 }, attendees: [] });
    await r.run();
    assert.ok(!r.told.some((t) => t.service === "conference.start"));
    assert.strictEqual(r.announced.length, 0);
  }
  {
    // The host then comes: the waiting guest is told the meeting started, and
    // the workspace is told too: the guest does not count as already there.
    const guest = { uid: GUEST, role: "attendee", waiting: 1, firstname: "Guest" };
    const r = room({ uid: OWNER, user: { uid: OWNER, role: "host", waiting: 0, firstname: "Owner" }, attendees: [guest] });
    await r.run();
    const start = r.told.find((t) => t.service === "conference.start");
    assert.ok(start && start.to.includes(GUEST), "the waiting guest is told");
    assert.strictEqual(r.announced.length, 1, "the workspace is told the meeting started");
    assert.deepStrictEqual(r.announced[0].attendees.map((a) => a.uid), [OWNER]);
  }
  console.log("conference-meeting-room: ok");
})().catch((e) => { console.error(e); process.exit(1); });
