// What an invite reports when the notification email fails.
//
// THE REPORT: inviting test.owner1@drumee.com came back
//   "Email delivery to test.owner1@drumee.com failed:
//    the MTA rejected test.owner1@drumee.com"
// and nothing else. That address HAS a Drumee account, so invite() had already
// run _grantMembership and the person was a member of the workspace — the
// sentence described the one step that failed and said nothing about the step
// that succeeded. Read as "the invite did not go through", which sends the
// admin round the loop again for a membership that already exists.
//
// invite() is ordered grant-then-notify, so where the throw lands decides what
// is true afterwards. These lock the three readings apart.
const assert = require('node:assert/strict');
const test = require('node:test');

global.myDrumee = {arch: 'pod', useEmail: 0};
global.verbosity = 0;
global.debug = {};

const HubPrivate = require('../service/private/hub');
const reason = HubPrivate.prototype._inviteFailureReason;

const MTA = new Error(
  'Email delivery to test.owner1@drumee.com failed: '
  + 'the MTA rejected test.owner1@drumee.com');
const EMAIL = 'test.owner1@drumee.com';
const WS = 'Marketing';

test('a mail failure AFTER the grant says the membership stands', () => {
  const r = reason(EMAIL, WS, true, false, MTA);
  assert.match(r, /the MTA rejected test\.owner1@drumee\.com/,
    'the original failure is still reported');
  assert.match(r, /[Mm]embership was actually granted/,
    'the sentence must say the grant landed');
  assert.match(r, /HAS been added/);
  assert.match(r, /'Marketing'/, 'names the workspace they were added to');
  assert.match(r, /can open it now\.$/,
    'the sentence stops at the consequence — the advice that used to follow is '
    + 'implied by it, and only made the card taller');
});

test('a mail failure after only a pending row does not claim membership', () => {
  const r = reason('newcomer@example.com', WS, false, true, MTA);
  assert.doesNotMatch(r, /HAS been added/,
    'nothing was granted — a newcomer has no membership until they sign up');
  assert.match(r, /recorded and will be honoured/);
  assert.match(r, /signs up\.$/);
});

test('a failure before any write says plainly that nothing landed', () => {
  const r = reason(EMAIL, WS, false, false, new Error('add_member exploded'));
  assert.match(r, /add_member exploded/);
  assert.match(r, /Nothing was granted/);
  assert.doesNotMatch(r, /recorded and will be honoured/);
});

test('a thrown value with no message still produces a usable reason', () => {
  const r = reason(EMAIL, WS, true, false, undefined);
  assert.match(r, /unknown error/);
  assert.match(r, /[Mm]embership was actually granted/,
    'what landed is known independently of what threw');
});

test('an unnamed workspace does not render an empty quote', () => {
  const r = reason(EMAIL, '', true, false, MTA);
  assert.doesNotMatch(r, /''/);
  assert.match(r, /this workspace/);
});
