// Which contact statuses block a fresh invite.
//
// THE REPORT: on prod, a Drumee user had a pending invitation sitting in her
// Contacts panel. The panel would not let her answer it, so she added the same
// person through "+ Add contacts" instead. The two accounts came out connected
// on her side — status 'active' — without her ever pressing Accept.
//
// A pending incoming invite has two statuses, not one. contact_invite_post
// writes 'received' when the sender had no row in the recipient's address book
// and 'invitation' when they already did (a workspace invite auto-adds one).
// This guard only knew 'received', so an 'invitation' fell through into
// contact_invite, whose crossed-invite branch — _invitee_status 'informed' —
// sets our own row to 'active' outright.
//
// These lock both pending statuses to the same refusal, and keep the statuses
// that must still pass or report differently where they were.
const assert = require('node:assert/strict');
const test = require('node:test');

global.myDrumee = { arch: 'pod', useEmail: 0 };
global.verbosity = 0;
global.debug = {};

const ContactPrivate = require('../service/private/contact');

const EMAIL = 'peer@example.com';
const PEER_ID = 'aaaa1111aaaa1112';

// A `this` that satisfies invite() as far as the status guard and records
// whatever the guard hands to output.data().
function callInviteWith(contactRow) {
  const seen = {};
  const ctx = {
    input: {
      need: () => EMAIL,
      use: () => undefined,
      get: () => undefined, // no hub_id: contactDb falls back to this.db
    },
    yp: {
      await_proc: async (proc) => {
        if (proc === 'drumate_exists') return { id: PEER_ID, email: EMAIL, domain_id: 1 };
        return {};
      },
    },
    db: {
      await_proc: async (proc) => {
        if (proc === 'my_contact_exists') return contactRow;
        throw new Error('invite() went past the guard and called ' + proc);
      },
    },
    output: { data: (res) => { seen.res = res; return res; } },
    warn: () => {},
    randomString: () => 'tok',
    send_mail: async () => ({}),
    send_drumate_mail: async () => ({}),
  };
  return ContactPrivate.prototype.invite.call(ctx).then(() => seen.res);
}

test("a 'received' invite still blocks a fresh invite", async () => {
  const res = await callInviteWith({ id: 'c1', status: 'received' });
  assert.equal(res.status, 'INVITE_RECEIVED');
});

test("an 'invitation' blocks it too — the reported hole", async () => {
  const res = await callInviteWith({ id: 'c1', status: 'invitation' });
  assert.equal(res.status, 'INVITE_RECEIVED',
    "'invitation' is a pending incoming invite exactly like 'received'; letting "
    + 'it through connects both accounts with nobody pressing Accept');
});

test("'active' still reports ALREADY_IN_CONTACT, not INVITE_RECEIVED", async () => {
  const res = await callInviteWith({ id: 'c1', status: 'active' });
  assert.equal(res.status, 'ALREADY_IN_CONTACT');
});

test("'informed' still reports ALREADY_IN_CONTACT", async () => {
  const res = await callInviteWith({ id: 'c1', status: 'informed' });
  assert.equal(res.status, 'ALREADY_IN_CONTACT');
});

// invite() wraps the rest of its work in try/catch, so a status that clears
// the guard reports whatever that tail produces — never a blocking code.
const BLOCKING = ['INVITE_RECEIVED', 'ALREADY_IN_CONTACT'];

test("'sent' is not blocked — re-inviting is how you nudge a sent invite", async () => {
  const res = await callInviteWith({ id: 'c1', status: 'sent' });
  assert.ok(!BLOCKING.includes(res && res.status),
    "'sent' is our own outgoing invite, not one waiting on us; got " + (res && res.status));
});

test('no existing row is not blocked', async () => {
  const res = await callInviteWith({});
  assert.ok(!BLOCKING.includes(res && res.status),
    'a first-time invite must reach the send path; got ' + (res && res.status));
});
