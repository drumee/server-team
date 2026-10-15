/**
 * Cover for dmz.meeting_files and the password gate in front of it (dmz.login).
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
const { sqlString } = require("../service/lib/sql-literal");
const meeting_files = new Function("toArray", "attachmentsOf", "isMeetingNode", "Attr", "sqlString",
  `return ${slice("async meeting_files()")}`)(toArray, lib.attachmentsOf, lib.isMeetingNode, { token: "token" }, sqlString);

// The real share resolver, so the password gate is the one production runs.
const shareByToken = new Function("toArray", `return ${slice("async _shareByToken(token, tag)")}`)(toArray);

const MEET = "aaaaaaaaaaaaaaaa", F1 = "1111111111111111";
function make({ share, legacy, nodes = {}, viewerPriv = 0, marked = false }) {
  const out = {};
  const self = {
    uid: "vvvvvvvvvvvvvvvv",
    input: { need: () => "tok" },
    _shareByToken: legacy ? shareByToken : async () => share,
    _isSharePasswordOk: async () => marked,
    yp: { await_proc: async (name, _hub, proc, args) => {
      if (name === "secure_share_info") return [];
      if (name === "dmz_info_next") return legacy;
      // The session's own access to the node, in the token's hub.
      if (proc === "mfs_access_node") return [{ privilege: viewerPriv }];
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
  // A password-protected link lists nothing until this session gave the
  // password. Access to the node is not that: every session that opened some
  // other open link holds the shared public identity the node was granted to.
  {
    const t = make({ legacy: { hub_id: "h", nid: MEET, validity: "TICKET_OK", require_password: 1 },
      nodes: { [MEET]: meetingNode([F1]) }, viewerPriv: 15 });
    await t.run();
    assert.deepStrictEqual(t.out.data, { status: "REQUIRED_PASSWORD", items: [] });
  }
  // ...and once it did (dmz.login marked token + session), the files show.
  {
    const t = make({ legacy: { hub_id: "h", nid: MEET, validity: "TICKET_OK", require_password: 1 },
      nodes: { [MEET]: meetingNode([F1]), [F1]: { id: F1, filename: "a", ext: "pdf", filetype: "document", filesize: 9 } },
      marked: true });
    await t.run();
    assert.deepStrictEqual(t.out.data, { status: "TICKET_OK", hub_id: "h",
      items: [{ nid: F1, filename: "a", ext: "pdf", filetype: "document", filesize: 9 }] });
  }
  // A JSON column the driver already parsed reads the same as a string.
  {
    const node = { id: MEET, filetype: "schedule", metadata: { content: JSON.stringify({ attachments: [F1] }) } };
    const t = make({ share: { info: { hub_id: "h", nid: MEET } },
      nodes: { [MEET]: node, [F1]: { id: F1, filename: "a", ext: "pdf", filetype: "document", filesize: 9 } } });
    await t.run();
    assert.deepStrictEqual(t.out.data.items.map((i) => i.nid), [F1]);
  }

  // dmz.login, the gate itself.
  const login = new Function("Attr", "Cache", "isEmpty", "toArray", "sqlString", "isMeetingNode", "ID_NOBODY", "RedisStore",
    `return ${slice("async login()")}`)(
    { token: "token", password: "password", cookie: "cookie", area: "area" },
    { getSysConf: () => "gggggggggggggggg" },
    (v) => v == null || (typeof v === "object" && !Object.keys(v).length),
    toArray, sqlString, lib.isMeetingNode, "ffffffffffffffff", { sendData: async () => {} });
  function gate({ info, password, marked = false, node = {} }) {
    const calls = { touched: [], marked: 0 };
    const out = {};
    const self = {
      uid: "pppppppppppppppp", // a session holding the shared public identity
      input: { need: () => "tok", get: (k) => (k === "password" ? password : k === "cookie" ? {} : undefined),
        use: () => undefined, sid: () => "sid" },
      user: { toJSON: () => ({ id: "pppppppppppppppp" }) },
      hub: { get: () => "dmz" },
      session: { dmz_login: async (_t, pw) => (pw === "right" ? { is_verified: 1 } : { failed: 1, error: "INVALID_CREDENTIAL" }) },
      _isSharePasswordOk: async () => marked,
      _markSharePasswordOk: async () => { calls.marked++; },
      yp: { await_proc: async (name, _hub, proc) => {
        if (name === "secure_share_info") return [];
        if (name === "dmz_info_next") return { ...info };
        if (name === "cookie_touch") { calls.touched.push(_hub.uid); return []; }
        if (proc === "mfs_access_node") return [{ privilege: 15, ...node }];
        return [];
      } },
      db: { await_proc: async () => ({ privilege: 15, ...node }) },
      output: { data: (d) => { out.data = d; } },
      warn: () => {},
    };
    return { run: () => login.call(self), out, calls };
  }
  const LINK = { hub_id: "h", nid: MEET, uid: "pppppppppppppppp", validity: "TICKET_OK", require_password: 1 };
  {
    // Access to the node does not open the gate; a meeting's gate names it.
    const t = gate({ info: LINK, node: { filetype: "schedule", filename: "Weekly retro" } });
    await t.run();
    assert.strictEqual(t.out.data.status, "REQUIRED_PASSWORD");
    assert.strictEqual(t.out.data.filename, "Weekly retro");
    assert.deepStrictEqual(t.calls.touched, []);
  }
  {
    // Any other share keeps its name behind the password.
    const t = gate({ info: LINK, node: { filetype: "folder", filename: "Contracts" } });
    await t.run();
    assert.strictEqual(t.out.data.status, "REQUIRED_PASSWORD");
    assert.strictEqual(t.out.data.filename, undefined);
  }
  {
    // The right password marks this session; a wrong one does not.
    const right = gate({ info: LINK, password: "right" });
    await right.run();
    assert.strictEqual(right.out.data.is_verified, 1);
    assert.strictEqual(right.calls.marked, 1);
    const wrong = gate({ info: LINK, password: "nope" });
    await wrong.run();
    assert.strictEqual(wrong.calls.marked, 0);
  }
  {
    // A marked session goes through to the link.
    const t = gate({ info: LINK, marked: true });
    await t.run();
    assert.strictEqual(t.out.data.status, undefined);
    assert.strictEqual(t.out.data.validity, "TICKET_OK");
    assert.deepStrictEqual(t.calls.touched, ["pppppppppppppppp"]);
  }
  {
    // An expired protected link says so instead of asking for its password.
    const t = gate({ info: { ...LINK, validity: "TICKET_EXPIRED" } });
    await t.run();
    assert.strictEqual(t.out.data.status, undefined);
    assert.strictEqual(t.out.data.validity, "TICKET_EXPIRED");
    assert.deepStrictEqual(t.calls.touched, []);
  }
  console.log("dmz-meeting-files: ok");
})().catch((e) => { console.error(e); process.exit(1); });
