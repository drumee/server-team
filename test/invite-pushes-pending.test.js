// hub.invite tells the workspace that its pending invitations changed.
//
// hub.invitations_changed used to go out only when an invitation was answered
// (accept / decline) or withdrawn (cancel_invite). Sending one changed the
// same list, the Access panel's Pending section and the admin console's
// Pending card, yet pushed nothing, so every other open view kept the old
// list until it was reopened. The push is sent once per call, before the
// reply, and only when at least one invitation was actually recorded.
//
// Run: node --test test/invite-pushes-pending.test.js
const assert = require("node:assert/strict");
const test = require("node:test");

global.myDrumee = { arch: "pod", useEmail: 0 };
global.verbosity = 0;
global.debug = {};

const { RedisStore, Attr } = require("@drumee/server-essentials");
const HubPrivate = require("../service/private/hub");

const events = [];
RedisStore.sendData = async (payload, dest) => {
  events.push({ kind: "push", payload, dest });
};

const HUB_ID = "hub-1";
const HUB_SOCKETS = [{ socket_id: "s-admin-a" }, { socket_id: "s-admin-b" }];
const HUB = {
  [Attr.id]: HUB_ID,
  [Attr.area]: "private",
  [Attr.db_name]: "hub_db",
  [Attr.name]: "Design team",
  [Attr.settings]: { default_privilege: 7 },
};

function fakeService({ invitees, failFor = [], budget = null }) {
  const svc = Object.create(HubPrivate.prototype);
  Object.assign(svc, {
    uid: "admin-a",
    input: {
      need: (k) => (k === "invitees" ? invitees : undefined),
      use: (k) => (k === Attr.privilege ? 15 : k === Attr.message ? "Join us" : undefined),
      app_language: () => "en",
    },
    user: { language: () => "en", get: () => "Admin A", domain_id: () => 86 },
    hub: { get: (k) => HUB[k] },
    db: { await_proc: async () => ({}) },
    yp: {
      await_proc: async (name) => {
        if (name === "user_sockets") return [{ socket_id: "s-admin-a" }];
        if (name === "entity_sockets") return HUB_SOCKETS;
        return [];
      },
    },
    payload: (model, options) => ({ model, options }),
    output: { data: (d) => events.push({ kind: "reply", data: d }) },
    warn: () => {},
    _seatBudget: async () => budget,
    _newcomers: async (_dom, list) => list,
    _workspacePreviewItems: async () => [],
    _recentMessages: async () => [],
    _ensurePublicShareToken: async () => {},
    _inviteCtaLink: () => "https://drumee.test/welcome",
    _contactBookContext: async () => ({}),
    _addInviteToken: async (email) => {
      if (failFor.includes(email)) throw new Error("token refused");
      return `tok-${email}`;
    },
    _trackInviteSent: async () => {},
    _notifyInvitee: async () => {},
    _rememberInvitee: async () => {},
    _sendInviteMailsLater: () => {},
    _inviteFailureReason: () => "failed",
  });
  return svc;
}

const pushes = () => events.filter((e) => e.kind === "push");

test("sending invitations tells the workspace once, before the reply", async () => {
  events.length = 0;
  await HubPrivate.prototype.invite.call(
    fakeService({ invitees: ["a@x.io", "b@x.io"] }),
  );
  const sent = pushes();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.options.service, "hub.invitations_changed");
  assert.deepEqual(sent[0].payload.model, { hub_id: HUB_ID });
  assert.deepEqual(sent[0].dest, HUB_SOCKETS);
  // entity_sockets is read through this.yp, which closes with the request.
  const order = events.map((e) => e.kind);
  assert.deepEqual(order, ["push", "reply"]);
  assert.equal(events[1].data.results.length, 2);
});

test("one recorded invitation among failures still tells the workspace", async () => {
  events.length = 0;
  await HubPrivate.prototype.invite.call(
    fakeService({ invitees: ["a@x.io", "b@x.io"], failFor: ["a@x.io"] }),
  );
  assert.equal(pushes().length, 1);
});

test("nothing is pushed when no invitation was recorded", async () => {
  events.length = 0;
  await HubPrivate.prototype.invite.call(
    fakeService({ invitees: ["a@x.io"], failFor: ["a@x.io"] }),
  );
  assert.equal(pushes().length, 0);
  assert.equal(events.at(-1).data.results[0].status, "failed");
});

test("a refused call (seat limit) pushes nothing", async () => {
  events.length = 0;
  await HubPrivate.prototype.invite.call(
    fakeService({ invitees: ["a@x.io", "b@x.io"], budget: { seat: 1, used: 1, free: 0 } }),
  );
  assert.equal(pushes().length, 0);
  assert.equal(events.at(-1).data.status, "SEAT_LIMIT_REACHED");
});
