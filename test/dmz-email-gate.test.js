/**
 * Cover for the email gate on a plain dmz link (a meeting's guest link):
 * "Require email to view" and "Restrict access to specific emails or domains",
 * set by room.public_link (yp dmz_set_email_gate) and enforced by dmz.info,
 * dmz.login and the *_by_token endpoints (_shareByToken).
 * Run: node test/dmz-email-gate.test.js
 */
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const { RedisStore } = require("@drumee/server-essentials");

// An in-memory Redis for the per-session gate markers.
const store = new Map();
RedisStore.getClient = () => ({
  get: async (k) => (store.has(k) ? store.get(k) : null),
  set: async (k, v) => { store.set(k, v); },
});

// dmz.js has a heavy require graph; slice the methods out and run them against
// a stub `this` (same technique as dmz-meeting-files.test.js).
const SRC = fs.readFileSync(path.join(__dirname, "../service/dmz.js"), "utf8");
function slice(sig) {
  const start = SRC.indexOf(`\n  ${sig} {`);
  if (start < 0) throw new Error(`${sig} not found`);
  const end = SRC.indexOf("\n  }\n", start);
  return SRC.slice(start, end + 4).trim()
    .replace(/^async\s+([A-Za-z_]\w*)\s*\(/, "async function $1(")
    .replace(/^([A-Za-z_]\w*)\s*\(/, "function $1(");
}
function sliceFn(name) {
  const start = SRC.indexOf(`\nfunction ${name}(`);
  const end = SRC.indexOf("\n}\n", start);
  return SRC.slice(start, end + 2).trim();
}
const toArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
// Same String helper the server installs.
if (!String.prototype.isEmail) {
  // eslint-disable-next-line no-extend-native
  String.prototype.isEmail = function () { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this); };
}
const _emailMatchesAllowed = new Function(`${sliceFn("_isDeniedEmail")}\n${sliceFn("_emailMatchesAllowed")}\nreturn _emailMatchesAllowed;`)();
const methods = {};
for (const sig of ["_shareEmailKey(token)", "async _markShareEmailOk(token)", "async _isShareEmailOk(token)",
  "_sharePasswordKey(token)", "async _isSharePasswordOk(token)"]) {
  methods[sig.replace(/^async /, "").replace(/\(.*/, "")] = new Function("RedisStore", `return ${slice(sig)}`)(RedisStore);
}
const info = new Function("Attr", "Cache", "isEmpty", `return ${slice("async info()")}`)(
  { token: "token" }, { getSysConf: () => "guest" }, (v) => v == null || (typeof v === "object" && !Object.keys(v).length));
const shareByToken = new Function("toArray", `return ${slice("async _shareByToken(token, tag)")}`)(toArray);
const login = new Function(
  "Attr", "Cache", "toArray", "sqlString", "isMeetingNode", "retryAfter", "recordFailure", "RedisStore",
  "ID_NOBODY", "_emailMatchesAllowed", "isEmpty",
  `return ${slice("async login()")}`,
)({ token: "token", password: "password", email: "email", cookie: "cookie" }, { getSysConf: () => "guest" },
  toArray, (v) => `'${v}'`, () => true, async () => 0, async () => {},
  { sendData: async () => {} }, "nobody", _emailMatchesAllowed, (v) => v == null);

const TOKEN = "tok";
const row = (extra = {}) => ({
  hub_id: "h", nid: "n", node_id: "n", uid: "guest", sender_id: "owner",
  validity: "TICKET_OK", require_password: 0, require_email: 1,
  allowed_emails: JSON.stringify(["a@b.com", "@drumee.com"]), ...extra,
});
function make({ legacy, sid = "s1", input = {}, user = {} }) {
  const out = {};
  const self = {
    ...methods,
    uid: "guest",
    input: {
      need: () => TOKEN,
      get: (k) => (k === "cookie" ? {} : input[k]),
      use: () => undefined,
      sid: () => sid,
    },
    user: { toJSON: () => ({ ...user }) },
    hub: { get: () => "private" },
    session: { dmz_login: async () => ({ is_verified: 1 }) },
    yp: { await_proc: async (name) => {
      if (name === "secure_share_info") return [];
      if (name === "dmz_info_next") return { ...legacy };
      if (name === "forward_proc") return [];
      return [];
    } },
    db: { await_proc: async () => [] },
    output: { data: (d) => { out.data = d; } },
    payload: (d) => d,
    warn: () => {},
  };
  self._markSharePasswordOk = async () => {};
  return { self, out };
}

(async () => {
  {
    // info: a gated plain link says REQUIRED_EMAIL, and never shows its list.
    const t = make({ legacy: row() });
    await info.call(t.self);
    assert.strictEqual(t.out.data.status, "REQUIRED_EMAIL");
    assert.ok(!("allowed_emails" in t.out.data), "the allow-list never leaves the server");
  }
  {
    // login: no email yet → the gate, without the list.
    const t = make({ legacy: row() });
    await login.call(t.self);
    assert.strictEqual(t.out.data.status, "REQUIRED_EMAIL");
    assert.ok(!("allowed_emails" in t.out.data));
  }
  {
    // login: an address not on the list, and a malformed one, are refused.
    for (const email of ["x@other.com", "not-an-email"]) {
      const t = make({ legacy: row(), input: { email } });
      await login.call(t.self);
      assert.deepStrictEqual(t.out.data, { status: "EMAIL_MISMATCH", require_email: 1 }, email);
    }
  }
  {
    // login: an allowed domain passes, the session is marked, and the guest is
    // bound as the link's own guest (never the owner).
    const t = make({ legacy: row(), input: { email: "Someone@Drumee.com" } });
    await login.call(t.self);
    assert.strictEqual(t.out.data.validity, "TICKET_OK");
    assert.strictEqual(t.out.data.guest_id, "guest");
    assert.ok(!("allowed_emails" in t.out.data));
    assert.ok(store.has(`ss:emailok:${TOKEN}:s1`), "the session passed the gate");
    // …so info and the files endpoint let that session through, not another.
    const again = make({ legacy: row() });
    await info.call(again.self);
    assert.notStrictEqual(again.out.data.status, "REQUIRED_EMAIL");
    const files = await shareByToken.call(make({ legacy: row() }).self, TOKEN, "t");
    assert.ok(files.info && !files.status, "meeting files open for the session that passed");
    assert.ok(!("allowed_emails" in files.info));
    const other = await shareByToken.call(make({ legacy: row(), sid: "s2" }).self, TOKEN, "t");
    assert.strictEqual(other.status, "REQUIRED_EMAIL");
  }
  {
    // "Require email to view" with no list accepts any real address.
    const t = make({ legacy: row({ allowed_emails: null }), sid: "s3", input: { email: "anyone@x.io" } });
    await login.call(t.self);
    assert.strictEqual(t.out.data.validity, "TICKET_OK");
  }
  {
    // The email gate comes before the password one.
    const t = make({ legacy: row({ require_password: 1 }), sid: "s4" });
    await login.call(t.self);
    assert.strictEqual(t.out.data.status, "REQUIRED_EMAIL");
  }
  {
    // The link's owner previewing it is not asked.
    const t = make({ legacy: row(), sid: "s5", user: { id: "owner" } });
    await login.call(t.self);
    assert.strictEqual(t.out.data.validity, "TICKET_OK");
  }
  {
    // An ungated link is untouched.
    const t = make({ legacy: row({ require_email: 0, allowed_emails: null }), sid: "s6" });
    await login.call(t.self);
    assert.strictEqual(t.out.data.validity, "TICKET_OK");
    const i = make({ legacy: row({ require_email: 0, allowed_emails: null }), sid: "s6" });
    await info.call(i.self);
    assert.strictEqual(i.out.data.status, undefined);
  }
  console.log("dmz-email-gate: ok");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
