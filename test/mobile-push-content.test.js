const assert = require('node:assert/strict');
const test = require('node:test');

const {
  GENERIC_NOTIFICATION,
  composeNotification,
  createMobilePushContent,
} = require('../service/lib/mobile-push-content');

function fakeYp(rows = {}) {
  const calls = [];
  return {
    calls,
    async await_proc(name, id) {
      calls.push(id);
      if (name === 'push_actor_name') return rows.actor?.[id] ?? [];
      if (name === 'push_workspace_name') return rows.workspace?.[id] ?? [];
      throw new Error(`unexpected procedure: ${name}`);
    },
  };
}

test('names the actor and the workspace for every admitted event type', () => {
  const cases = [
    ['chat.post', '', 'Sent you a message'],
    ['channel.post', 'Marketing', 'Posted in Marketing'],
    ['hub.invite_received', 'Marketing', 'Invited you to Marketing'],
    ['task.assigned', 'Marketing', 'Assigned you a task in Marketing'],
    ['task.mention', 'Marketing', 'Mentioned you in Marketing'],
  ];
  for (const [type, workspaceName, body] of cases) {
    assert.deepEqual(
      composeNotification({type, actorName: 'Temp Test', workspaceName}),
      {title: 'Temp Test', body},
      type,
    );
  }
});

test('reads correctly when an event carries no workspace', () => {
  assert.deepEqual(
    composeNotification({type: 'channel.post', actorName: 'Temp Test'}),
    {title: 'Temp Test', body: 'Posted a new message'},
  );
  assert.deepEqual(
    composeNotification({type: 'task.assigned', actorName: 'Temp Test'}),
    {title: 'Temp Test', body: 'Assigned you a task'},
  );
});

test('titles a reminder with its workspace and distinguishes the phase', () => {
  assert.deepEqual(
    composeNotification({
      type: 'room.reminder',
      actorName: 'Temp Test',
      workspaceName: 'Marketing',
      eventPhase: 'upcoming',
    }),
    {title: 'Marketing', body: 'A meeting starts soon'},
  );
  assert.deepEqual(
    composeNotification({
      type: 'room.reminder',
      workspaceName: 'Marketing',
      eventPhase: 'start',
    }),
    {title: 'Marketing', body: 'A meeting is starting'},
  );
  // No workspace leaves a reminder with nothing to name.
  assert.deepEqual(
    composeNotification({type: 'room.reminder', actorName: 'Temp Test'}),
    GENERIC_NOTIFICATION,
  );
});

test('degrades to the generic banner instead of guessing', () => {
  assert.deepEqual(composeNotification(), GENERIC_NOTIFICATION);
  assert.deepEqual(
    composeNotification({type: 'chat.post', actorName: '   '}),
    GENERIC_NOTIFICATION,
  );
  assert.deepEqual(
    composeNotification({type: 'account.deleted', actorName: 'Temp Test'}),
    GENERIC_NOTIFICATION,
  );
});

test('takes the display name the procedure composed', async () => {
  const yp = fakeYp({
    actor: {'actor-1': [{display_name: 'Temp Test'}]},
  });
  const {resolveNotification} = createMobilePushContent(yp);
  assert.deepEqual(
    await resolveNotification({type: 'chat.post', actor_id: 'actor-1'}),
    {title: 'Temp Test', body: 'Sent you a message'},
  );
});

test('withholds the banner identity when the account has no name', async () => {
  // `push_actor_name` answers with an empty string rather than the account
  // email that `drumate.fullname` would fall back to; an email address must
  // never reach a lock screen or FCM.
  const yp = fakeYp({
    actor: {'actor-1': [{display_name: ''}]},
  });
  const {resolveNotification} = createMobilePushContent(yp);
  const notification = await resolveNotification({type: 'chat.post', actor_id: 'actor-1'});
  assert.deepEqual(notification, GENERIC_NOTIFICATION);
  assert.equal(JSON.stringify(notification).includes('@'), false);
});

test('resolves each name once across a fan-out', async () => {
  const yp = fakeYp({
    actor: {'actor-1': [{display_name: 'Temp Test'}]},
    workspace: {'hub-1': [{workspace_name: 'Marketing'}]},
  });
  const {resolveNotification} = createMobilePushContent(yp);
  const event = {type: 'channel.post', actor_id: 'actor-1', hub_id: 'hub-1'};
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(await resolveNotification(event), {
      title: 'Temp Test',
      body: 'Posted in Marketing',
    });
  }
  assert.deepEqual(yp.calls, ['actor-1', 'hub-1']);
});

test('keeps delivering when a name lookup fails', async () => {
  const {resolveNotification} = createMobilePushContent({
    async await_proc() {
      throw new Error('yp is unavailable');
    },
  });
  assert.deepEqual(
    await resolveNotification({type: 'chat.post', actor_id: 'actor-1'}),
    GENERIC_NOTIFICATION,
  );
});
