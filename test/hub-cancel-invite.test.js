// hub.cancel_invite withdraws invitations from the Access panel.
//
// One call per address or per selection. Each address goes through
// token_hub_invite_cancel (tokens + pending row); an address that had
// something withdrawn gets its notification dismissed (when it has an account),
// and the workspace's open panels are told once. An
// address with nothing left to withdraw is reported, not treated as an error.
//
// Run: node --test test/hub-cancel-invite.test.js
const assert = require("node:assert/strict");
const test = require("node:test");

global.myDrumee = { arch: "pod", useEmail: 0 };
global.verbosity = 0;
global.debug = {};

const { RedisStore, Attr } = require("@drumee/server-essentials");
const HubPrivate = require("../service/private/hub");

const sent = [];
RedisStore.sendData = async (payload, dest) => {
  sent.push({ payload, dest });
};

const HUB_ID = "hub-1";

function fakeService({ emails, cancelled = {}, accounts = {}, throwsFor = [] }) {
  const calls = [];
  const svc = Object.create(HubPrivate.prototype);
  Object.assign(svc, {
    calls,
    uid: "admin-1",
    input: { need: (k) => (k === "emails" ? emails : undefined) },
    hub: { get: (k) => (k === Attr.id ? HUB_ID : k === Attr.db_name ? "hub_db" : undefined) },
    payload: (model, opt) => ({ model, opt }),
    output: { data: (d) => (svc.result = d) },
    warn: () => {},
    yp: {
      await_proc: async (name, ...args) => {
        calls.push([name, ...args]);
        if (name === "token_hub_invite_cancel") {
          if (throwsFor.includes(args[1])) throw new Error("boom");
          return [{ cancelled: cancelled[args[1]] || 0 }];
        }
        if (name === "drumate_exists") {
          return accounts[args[0]] ? [{ id: accounts[args[0]] }] : [];
        }
        if (name === "entity_sockets") return [{ socket_id: "s1" }];
        return [];
      },
    },
  });
  return svc;
}

const named = (calls, name) => calls.filter((c) => c[0] === name);

test("withdraws each address once, for this workspace only", async () => {
  sent.length = 0;
  const svc = fakeService({
    emails: ["a@x.io", " A@X.io ", "", "b@x.io"],
    cancelled: { "a@x.io": 2, "b@x.io": 1 },
    accounts: { "a@x.io": "uid-a" },
  });
  await svc.cancel_invite();
  assert.deepEqual(named(svc.calls, "token_hub_invite_cancel"), [
    ["token_hub_invite_cancel", HUB_ID, "a@x.io"],
    ["token_hub_invite_cancel", HUB_ID, "b@x.io"],
  ]);
  assert.deepEqual(svc.result, {
    results: [
      { email: "a@x.io", status: "cancelled" },
      { email: "b@x.io", status: "cancelled" },
    ],
  });
});

test("dismisses the invitee's notification only when they have an account", async () => {
  const svc = fakeService({
    emails: ["a@x.io", "b@x.io"],
    cancelled: { "a@x.io": 1, "b@x.io": 1 },
    accounts: { "a@x.io": "uid-a" },
  });
  await svc.cancel_invite();
  assert.deepEqual(named(svc.calls, "contact_activity_dismiss_hub_invite"), [
    ["contact_activity_dismiss_hub_invite", "uid-a", HUB_ID],
  ]);
});

test("wakes open panels once and writes no audit line (enum lacks it)", async () => {
  sent.length = 0;
  const svc = fakeService({
    emails: ["a@x.io", "b@x.io"],
    cancelled: { "a@x.io": 1, "b@x.io": 1 },
  });
  await svc.cancel_invite();
  assert.equal(svc.calls.filter((c) => /hub_add_action_log$/.test(c[0])).length, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.opt.service, "hub.invitations_changed");
  assert.deepEqual(sent[0].payload.model, { hub_id: HUB_ID });
  // Never the "you were invited" push.
  assert.ok(!sent.some((s) => s.payload.opt.service === "hub.invite_received"));
});

test("nothing left to withdraw: reported, no side effects, no push", async () => {
  sent.length = 0;
  const svc = fakeService({ emails: ["gone@x.io"], accounts: { "gone@x.io": "u" } });
  await svc.cancel_invite();
  assert.deepEqual(svc.result, { results: [{ email: "gone@x.io", status: "not_found" }] });
  assert.equal(named(svc.calls, "drumate_exists").length, 0);
  assert.equal(sent.length, 0);
});

test("one address failing does not stop the others", async () => {
  sent.length = 0;
  const svc = fakeService({
    emails: ["bad@x.io", "ok@x.io"],
    cancelled: { "ok@x.io": 1 },
    throwsFor: ["bad@x.io"],
  });
  await svc.cancel_invite();
  assert.deepEqual(svc.result, {
    results: [
      { email: "bad@x.io", status: "failed" },
      { email: "ok@x.io", status: "cancelled" },
    ],
  });
  assert.equal(sent.length, 1);
});
