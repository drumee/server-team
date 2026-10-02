/**
 * Cover for room.link_files and the attachment-preserving edits to
 * room.update / public_link / remove.
 * Run: node test/room-link-files.test.js
 */
const assert = require("assert");
const path = require("path");

const stub = (rel, exports) => {
  const p = require.resolve(path.join(__dirname, "..", rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
const PUBLIC = "360deefd360def00";
require.cache[require.resolve("@drumee/server-essentials")] = {
  exports: {
    Attr: { id: "id", nid: "nid", flag: "flag", password: "password", days: "days", hours: "hours",
      permission: "permission", title: "title", date: "date", message: "message", stime: "stime",
      etime: "etime", attendees: "attendees", profile: "profile" },
    Privilege: { write: 15, download: 7 },
    Cache: { getSysConf: (k) => (k === "public_id" ? PUBLIC : null), message: () => "" },
    sysEnv: () => ({}), RedisStore: {}, toArray: (v) => (Array.isArray(v) ? v : v == null ? [] : [v]),
  },
};
stub("service/room.js", class {});
stub("service/lib/member-capability.js", { memberCan: async () => true, CAN_WRITE: 2 });
const Room = require("../service/private/room");

const MEET = "aaaaaaaaaaaaaaaa", F1 = "1111111111111111", F2 = "2222222222222222", OWNER = "uuuuuuuuuuuuuuuu";

function make({ input = {}, nodes = {}, publicPriv = 0, uid = OWNER } = {}) {
  const calls = [];
  const out = {};
  const self = Object.create(Room.prototype);
  Object.assign(self, {
    uid,
    hub: { get: () => "hhhhhhhhhhhhhhhh" },
    user: { get: () => "Org", locale_message: () => ({ format: () => "" }) },
    input: {
      need: (k) => { if (input[k] == null) throw new Error(`missing ${k}`); return input[k]; },
      use: (k, d) => (input[k] == null ? d : input[k]),
      get: (k) => input[k],
    },
    parseJSON: (v) => (typeof v === "string" ? JSON.parse(v) : v),
    db: {
      await_proc: async (name, ...args) => {
        calls.push([name, ...args]);
        if (name === "mfs_node_attr") return nodes[args[0]] || {};
        if (name === "mfs_access_node") return { privilege: publicPriv };
        return {};
      },
    },
    yp: { await_proc: async (name, ...args) => { calls.push([name, ...args]); return { token: "t" }; } },
    exception: { user: (code) => { out.error = code; } },
    output: { data: (d) => { out.data = d; } },
    randomString: () => "r",
    debug: () => {},
    _index_meeting: async () => {},
    _unindex_meeting: async () => {},
    _meeting_folder_name: async () => "",
    _getShareLink: () => "link",
  });
  return { self, calls, out };
}

const meetingNode = (content) => ({
  id: MEET, filetype: "schedule",
  metadata: JSON.stringify({ content: JSON.stringify(content), room_status: "booked" }),
});
const fileNode = (id) => ({ id, filetype: "document", filename: "f" });

(async () => {
  // link_files appends, writes metadata, no grant without a public link
  {
    const { self, calls, out } = make({
      input: { nid: MEET, file_nids: [F1, F2] },
      nodes: { [MEET]: meetingNode({ title: "M", created_by: OWNER }), [F1]: fileNode(F1), [F2]: fileNode(F2) },
    });
    await self.link_files();
    assert.deepStrictEqual(out.data, { nid: MEET, attachments: [F1, F2], overflow: [] });
    const set = calls.find((c) => c[0] === "mfs_set_metadata");
    assert.deepStrictEqual(set[2].content.attachments, [F1, F2]);
    assert.strictEqual(set[2].content.title, "M");
    assert.ok(!calls.some((c) => c[0] === "permission_grant"));
  }
  // link_files mirrors an existing public grant onto the new files only
  {
    const { self, calls } = make({
      input: { nid: MEET, file_nids: [F1, F2] }, publicPriv: 15,
      nodes: { [MEET]: meetingNode({ created_by: OWNER, attachments: [F1] }), [F1]: fileNode(F1), [F2]: fileNode(F2) },
    });
    await self.link_files();
    const grants = calls.filter((c) => c[0] === "permission_grant");
    assert.deepStrictEqual(grants.map((g) => g.slice(1)), [[F2, PUBLIC, 0, 7, "link", ""]]);
  }
  // link_files: not the owner / not a meeting / a folder nid
  {
    const a = make({ input: { nid: MEET, file_nids: [F1] }, uid: "someoneelse00000",
      nodes: { [MEET]: meetingNode({ created_by: OWNER }) } });
    await a.self.link_files();
    assert.strictEqual(a.out.error, "NOT_MEETING_OWNER");
    const b = make({ input: { nid: F1, file_nids: [F2] }, nodes: { [F1]: fileNode(F1) } });
    await b.self.link_files();
    assert.strictEqual(b.out.error, "MEETING_NOT_FOUND");
    const c = make({ input: { nid: MEET, file_nids: [F1] },
      nodes: { [MEET]: meetingNode({ created_by: OWNER }), [F1]: { id: F1, filetype: "folder" } } });
    await c.self.link_files();
    assert.deepStrictEqual(c.out.data.attachments, []);
  }
  // update keeps attachments (Review Focus 1)
  {
    const { self, calls, out } = make({
      input: { nid: MEET, flag: "all", title: "New", message: "", attendees: [] },
      nodes: { [MEET]: meetingNode({ title: "Old", created_by: OWNER, attachments: [F1] }) },
    });
    await self.update();
    const set = calls.find((c) => c[0] === "mfs_set_metadata");
    assert.deepStrictEqual(set[2].content.attachments, [F1]);
    assert.deepStrictEqual(out.data.attachments, [F1]);
  }
  // public_link grants every attachment with the link's expiry
  {
    const { self, calls } = make({
      input: { nid: MEET, hours: 2 },
      nodes: { [MEET]: meetingNode({ created_by: OWNER, attachments: [F1, F2] }) },
    });
    await self.public_link();
    const grants = calls.filter((c) => c[0] === "permission_grant").map((g) => g.slice(1));
    assert.deepStrictEqual(grants, [
      [MEET, PUBLIC, 2, 15, "link", ""],
      [F1, PUBLIC, 2, 7, "link", ""],
      [F2, PUBLIC, 2, 7, "link", ""],
    ]);
  }
  // remove revokes the link identity's grant on each attachment
  {
    const { self, calls } = make({
      input: { nid: MEET },
      nodes: { [MEET]: meetingNode({ created_by: OWNER, attachments: [F1] }) },
    });
    await self.remove();
    const revokes = calls.filter((c) => c[0] === "permission_revoke").map((c) => c.slice(1));
    assert.deepStrictEqual(revokes, [[F1, PUBLIC], [MEET, "meeting"]]);
  }
  console.log("room-link-files: ok");
})().catch((e) => { console.error(e); process.exit(1); });
