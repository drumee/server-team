// channel.attachment_location — "Show in folder" on a chat attachment card.
//
//   node --test test/channel-attachment-location.test.js
//
// The card is the message's sandbox copy (/__chat__/<message_id>/…). The
// service answers with the workspace file it stands for: the promoted folder
// file, the node itself when it is not a sandbox copy, else the live file in
// this hub with the same content hash. Never a file the caller cannot read.
const assert = require("node:assert/strict");
const test = require("node:test");

global.myDrumee = { arch: "pod", useEmail: 0 };
global.verbosity = 0;
global.debug = {};

const ChannelPrivate = require("../service/private/channel");
const { sourceQuery, isChatSandbox, md5Of } = require("../service/lib/attachment-source");

const READ = 0b0000010;

function node(nid, extra = {}) {
  return { nid, status: "active", privilege: 63, ...extra };
}

/**
 * @param {Object} local   nid -> mfs_access_node row in the chat hub
 * @param {Object} remote  nid -> mfs_access_node row in the attachment's hub
 * @param {Array}  hits    rows the md5 query returns
 */
function ctx(input, { local = {}, remote = {}, hits = [] } = {}) {
  const seen = { queries: [] };
  return {
    seen,
    uid: "me00000000000001",
    input: { use: (k, d) => (input[k] == null ? d : input[k]) },
    db: {
      await_proc: async (name, uid, nid) => {
        assert.equal(name, "mfs_access_node");
        return local[nid] || {};
      },
      await_query: async (sql, ...args) => {
        seen.queries.push({ sql, args });
        return hits;
      },
    },
    yp: {
      await_proc: async (name, hub, proc, args) => {
        assert.equal(name, "forward_proc");
        assert.equal(proc, "mfs_access_node");
        const nid = /'([^']+)'\s*$/.exec(args)[1];
        return remote[nid] || {};
      },
    },
    output: { data: (d) => (seen.data = d) },
  };
}

const run = (c) => ChannelPrivate.prototype.attachment_location.call(c);

const copy = node("copy", {
  ownpath: "/__chat__/msg1/plan.docx",
  filename: "plan",
  extension: "docx",
  filesize: 120,
  metadata: '{"md5Hash":"abc"}',
});

test("folder_nid wins when the caller can read it", async () => {
  const c = ctx(
    { folder_nid: "F", attachment_nid: "copy", attachment_hub_id: "H" },
    { local: { F: node("F", { pid: "dir" }) }, remote: { copy } },
  );
  await run(c);
  assert.equal(c.seen.data.nid, "F");
  assert.equal(c.seen.queries.length, 0);
});

test("a copy outside the chat sandbox is its own location", async () => {
  const real = node("real", { ownpath: "/Docs/plan.docx" });
  const c = ctx(
    { attachment_nid: "real", attachment_hub_id: "H" },
    { remote: { real } },
  );
  await run(c);
  assert.equal(c.seen.data.nid, "real");
});

test("sandbox copy → the hub file with the same hash, same name first", async () => {
  const c = ctx(
    { attachment_nid: "copy", attachment_hub_id: "H", scope_nid: "scope" },
    { remote: { copy }, hits: [{ id: "src" }], local: { src: node("src") } },
  );
  await run(c);
  assert.equal(c.seen.data.nid, "src");
  const q = c.seen.queries[0];
  assert.match(q.sql, /JSON_VALUE\(metadata, '\$\.md5Hash'\) = \?/);
  assert.deepEqual(q.args, ["abc", "plan", "docx", "scope"]);
});

test("no match → NOT_FOUND", async () => {
  const c = ctx(
    { attachment_nid: "copy", attachment_hub_id: "H" },
    { remote: { copy }, hits: [] },
  );
  await run(c);
  assert.deepEqual(c.seen.data, { status: "NOT_FOUND" });
});

test("a match the caller cannot read → NOT_FOUND", async () => {
  const c = ctx(
    { attachment_nid: "copy", attachment_hub_id: "H" },
    {
      remote: { copy },
      hits: [{ id: "src" }],
      local: { src: node("src", { privilege: 1 }) },
    },
  );
  await run(c);
  assert.deepEqual(c.seen.data, { status: "NOT_FOUND" });
});

test("an unreadable card is never used to probe the hub", async () => {
  const c = ctx(
    { attachment_nid: "copy", attachment_hub_id: "H" },
    { remote: { copy: { ...copy, privilege: 0 } }, hits: [{ id: "src" }] },
  );
  await run(c);
  assert.deepEqual(c.seen.data, { status: "NOT_FOUND" });
  assert.equal(c.seen.queries.length, 0);
});

test("unreadable folder_nid falls through to the hash lookup", async () => {
  const c = ctx(
    { folder_nid: "F", attachment_nid: "copy", attachment_hub_id: "H" },
    {
      local: { F: node("F", { status: "deleted" }), src: node("src") },
      remote: { copy },
      hits: [{ id: "src" }],
    },
  );
  await run(c);
  assert.equal(c.seen.data.nid, "src");
});

test("helpers: sandbox test, md5 from either shape, name+size fallback", () => {
  assert.equal(isChatSandbox("/__chat__/m/a.txt"), true);
  assert.equal(isChatSandbox("/Docs/__chat__/a.txt"), false);
  assert.equal(md5Of({ md5Hash: "x" }), "x");
  assert.equal(md5Of({ metadata: { md5Hash: "y" } }), "y");
  assert.equal(md5Of({ metadata: "not json" }), null);
  const q = sourceQuery({ filename: "a", filesize: 5 }, "s");
  assert.match(q.sql, /user_filename = \? AND filesize = \?/);
  assert.deepEqual(q.args, ["a", 5, "a", "", "s"]);
  assert.equal(sourceQuery({ filename: "a" }, "s"), null);
  assert.equal(READ & 63, READ);
});
