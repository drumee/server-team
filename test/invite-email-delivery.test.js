const assert = require('node:assert/strict');
const test = require('node:test');
const {resolve} = require('node:path');

// hub.js reads global.myDrumee at require time. Pinned here rather than read
// from /etc so the test asserts the same thing on every box: useEmail off is
// exactly the condition that made getMTA() decline a transport.
global.myDrumee = {arch: 'pod', useEmail: 0};
global.verbosity = 0;
global.debug = {};

const HubPrivate = require('../service/private/hub');
const {NO_MTA} = require('../service/lib/mail-result');

const TPL = 'workspace-invite-member';

// _sendInviteEmail touches nothing on `this` but the email exception handler.
function stubWorker() {
  const routed = [];
  return {
    routed,
    exception: {email: (e) => routed.push(e)},
    _sendInviteEmail: HubPrivate.prototype._sendInviteEmail,
  };
}

function inviteData() {
  return {
    inviter_name: 'Temp Test',
    workspace_name: 'Marketing',
    link: 'https://drumee.test/welcome?hub=1',
    workspace_external: false,
    preview_items: [{icon: 'i.png', name: 'plan.pdf', date: 'today', restricted: true}],
    recent_messages: [{text: 'hello', initials: 'TT'}],
  };
}

test('an invite whose mail never reaches an MTA is reported, not swallowed', async () => {
  const worker = stubWorker();
  await assert.rejects(
    () => worker._sendInviteEmail(TPL, 'invitee@example.com', 'You are added', inviteData()),
    (e) => {
      // The invite loop turns this throw into results[].status "failed", which
      // is what the permission panel alerts on. Before the fix the same call
      // resolved and the panel said "Invitation sent successfully".
      assert.match(e.message, /invitee@example\.com/);
      assert.match(e.message, new RegExp(NO_MTA.replace(/[()]/g, '\\$&')));
      return true;
    },
  );
});

test('the failure is about delivery, not about rendering the template', () => {
  // Proves the real 22KB template still renders with the exact payload
  // _sendInviteEmail is handed, so a throw can only mean delivery.
  const {readFileSync} = require('node:fs');
  const {template} = require('lodash');
  const path = resolve(
    __dirname, '..', 'service', 'private', 'templates', 'butler', `${TPL}.html`,
  );
  const html = template(String(readFileSync(path)).trim())(inviteData());
  assert.ok(html.length > 1000, `rendered only ${html.length} bytes`);
  assert.match(html, /Marketing/);
  assert.match(html, /Temp Test/);
  assert.match(html, /drumee\.test\/welcome/);
});

test('an external workspace renders the shared copy, an internal one does not', () => {
  const {readFileSync} = require('node:fs');
  const {template} = require('lodash');
  const path = resolve(
    __dirname, '..', 'service', 'private', 'templates', 'butler', `${TPL}.html`,
  );
  const render = template(String(readFileSync(path)).trim());
  assert.match(render({...inviteData(), workspace_external: true}), /shared Marketing with you/);
  assert.match(render({...inviteData(), workspace_external: false}), /added you to Marketing/);
  // A missing flag must not expose filenames — the template defaults to internal.
  const noFlag = inviteData();
  delete noFlag.workspace_external;
  assert.match(render(noFlag), /added you to Marketing/);
});
