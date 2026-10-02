/**
 * Cover for dmz.meeting_files.
 * Run: node test/dmz-meeting-files.test.js
 */
const assert = require("assert");
const path = require("path");
const fs = require("fs");

// dmz.js has a heavy require graph; slice the one method out and run it
// against a stub `this` (the ui-team tests/helpers/slice-method technique).
const SRC = fs.readFileSync(path.join(__dirname, "../service/dmz.js"), "utf8");
function slice(sig) {
  const start = SRC.indexOf(`\n  ${sig} {`);
  if (start < 0) throw new Error(`${sig} not found`);
  const end = SRC.indexOf("\n  }\n", start);
  return SRC.slice(start, end + 4).trim().replace(/^async\s+([A-Za-z_]\w*)\s*\(/, "async function $1(");
}
const lib = require("../service/lib/meeting-attachments");
const toArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const meeting_files = new Function("toArray", "attachmentsOf", "isMeetingNode", "Attr",
  `return ${slice("async meeting_files()")}`)(toArray, lib.attachmentsOf, lib.isMeetingNode, { token: "token" });

// The real share resolver, so the password gate is the one production runs.
const shareByToken = new Function("toArray", `return ${slice("async _shareByToken(token, tag)")}`)(toArray);

const MEET = "aaaaaaaaaaaaaaaa", F1 = "1111111111111111";
function make({ share, legacy, nodes = {}, viewerPriv = 0 }) {
  const out = {};
  const self = {
    uid: "vvvvvvvvvvvvvvvv",
    input: { need: () => "tok" },
    _shareByToken: legacy ? shareByToken : async () => share,
    yp: { await_proc: async (name, _hub, proc, args) => {
      if (name === "secure_share_info") return [];
      if (name === "dmz_info_next") return legacy;
      const id = String(args).replace(/'/g, "");
      return proc === "mfs_node_attr" ? [nodes[id] || {}] : [];
    } },
    db: { await_proc: async () => ({ privilege: viewerPriv }) },
    output: { data: (d) => { out.data = d; } },
    warn: () => {},
  };
  return { run: () => meeting_files.call(self), out };
}
const meetingNode = (attachments) => ({ id: MEET, filetype: "schedule",
  metadata: JSON.stringify({ content: JSON.stringify({ attachments }) }) });

(async () => {
  {
    const t = make({ share: { info: { hub_id: "h", nid: MEET } },
      nodes: { [MEET]: meetingNode([F1]), [F1]: { id: F1, filename: "a", ext: "pdf", filetype: "document", filesize: 9, owner_id: "secret" } } });
    await t.run();
    assert.deepStrictEqual(t.out.data, { status: "TICKET_OK", hub_id: "h",
      items: [{ nid: F1, filename: "a", ext: "pdf", filetype: "document", filesize: 9 }] });
  }
  {
    const t = make({ share: { status: "TICKET_INVALID" } });
    await t.run();
    assert.deepStrictEqual(t.out.data, { status: "TICKET_INVALID", items: [] });
  }
  {
    const t = make({ share: { info: { hub_id: "h", nid: F1 } }, nodes: { [F1]: { id: F1, filetype: "folder" } } });
    await t.run();
    assert.deepStrictEqual(t.out.data, { status: "NOT_A_MEETING", items: [] });
  }
  // Review Focus 4: password-protected link without access lists nothing
  {
    // viewerPriv 15: even a session holding the meeting grant gets nothing.
    const t = make({ legacy: { hub_id: "h", nid: MEET, validity: "TICKET_OK", require_password: 1 },
      nodes: { [MEET]: meetingNode([F1]) }, viewerPriv: 15 });
    await t.run();
    assert.deepStrictEqual(t.out.data, { status: "REQUIRED_PASSWORD", items: [] });
  }
  console.log("dmz-meeting-files: ok");
})().catch((e) => { console.error(e); process.exit(1); });
