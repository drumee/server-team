const assert = require('node:assert/strict');
const test = require('node:test');

const {
  EXCERPT_LIMIT,
  GENERIC_NOTIFICATION,
  composeNotification,
  createMobilePushContent,
  excerptOf,
} = require('../service/lib/mobile-push-content');

function fakeYp(rows = {}) {
  const calls = [];
  return {
    calls,
    async await_proc(name, id, proc, args) {
      calls.push(id);
      if (name === 'push_actor_name') return rows.actor?.[id] ?? [];
      if (name === 'push_workspace_name') return rows.workspace?.[id] ?? [];
      if (name === 'forward_proc') return rows.message?.[`${proc}:${args}`] ?? [];
      throw new Error(`unexpected procedure: ${name}`);
    },
  };
}

test('titles with the actor, subtitles with the workspace, and bodies each admitted event', () => {
  const cases = [
    ['chat.post', '', undefined, 'Sent you a message'],
    ['channel.post', 'Marketing', 'To Marketing', 'Sent a message'],
    ['task.assigned', 'Marketing', 'To Marketing', 'Assigned you a task'],
    ['task.mention', 'Marketing', 'To Marketing', 'Mentioned you in a task'],
  ];
  for (const [type, workspaceName, subtitle, body] of cases) {
    assert.deepEqual(
      composeNotification({type, actorName: 'Temp Test', workspaceName}),
      subtitle ? {title: 'Temp Test', subtitle, body} : {title: 'Temp Test', body},
      type,
    );
  }
});

test('quotes the message as the body of a chat push', () => {
  assert.deepEqual(
    composeNotification({type: 'chat.post', actorName: 'Temp Test', excerpt: 'lunch at 12?'}),
    {title: 'Temp Test', body: 'lunch at 12?'},
  );
  assert.deepEqual(
    composeNotification({
      type: 'channel.post', actorName: 'Temp Test', workspaceName: 'Marketing', excerpt: 'draft is up',
    }),
    {title: 'Temp Test', subtitle: 'To Marketing', body: 'draft is up'},
  );
});

test('says an instant meeting was started, with the workspace on the subtitle', () => {
  assert.deepEqual(
    composeNotification({
      type: 'channel.post',
      actorName: 'Temp Test',
      workspaceName: 'Marketing',
      excerpt: 'Started an instant meeting',
    }),
    {title: 'Temp Test', subtitle: 'To Marketing', body: 'Started an instant meeting'},
  );
});

test('reads correctly when an event carries no workspace', () => {
  assert.deepEqual(
    composeNotification({type: 'channel.post', actorName: 'Temp Test'}),
    {title: 'Temp Test', body: 'Sent a message'},
  );
  assert.deepEqual(
    composeNotification({type: 'task.assigned', actorName: 'Temp Test'}),
    {title: 'Temp Test', body: 'Assigned you a task'},
  );
});

test('no longer composes a banner for a workspace invitation', () => {
  assert.deepEqual(
    composeNotification({type: 'hub.invite_received', actorName: 'Temp Test', workspaceName: 'Marketing'}),
    GENERIC_NOTIFICATION,
  );
});

test('turns stored message text into a bounded one-line excerpt', () => {
  assert.equal(excerptOf('[@Temp Test](user:abc123) can you <b>review</b> this?'), '@Temp Test can you review this?');
  assert.equal(excerptOf('  line one\n\n  line two  '), 'line one line two');
  // An instant meeting is a channel.post carrying a sentinel, not typed text.
  assert.equal(excerptOf('[[MEETING:start:{"room_id":"r1","filename":"Standup"}]]'), 'Started an instant meeting');
  assert.equal(excerptOf('[[MEETING:end:{"room_id":"r1"}]]'), 'Ended the meeting');
  assert.equal(excerptOf('', '[{"nid":"n1"}]'), 'Sent an attachment');
  assert.equal(excerptOf(null, []), '');
  const long = Array.from({length: 60}, (_, i) => `word${i}`).join(' ');
  const cut = excerptOf(long);
  assert.ok(cut.length <= EXCERPT_LIMIT + 1, cut);
  assert.ok(cut.endsWith('…'), cut);
  assert.ok(!cut.includes('word59'), cut);
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

test('resolves each name once across a fan-out and the message once per event', async () => {
  const yp = fakeYp({
    actor: {'actor-1': [{display_name: 'Temp Test'}]},
    workspace: {'hub-1': [{workspace_name: 'Marketing'}]},
    message: {"channel_get_message:'msg-1'": [{message: 'draft is up', attachment: null}]},
  });
  const {resolveNotification} = createMobilePushContent(yp);
  const event = {type: 'channel.post', actor_id: 'actor-1', hub_id: 'hub-1', key_id: 'msg-1'};
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(await resolveNotification(event), {
      title: 'Temp Test',
      subtitle: 'To Marketing',
      body: 'draft is up',
    });
  }
  // Names are cached across the fan-out; the message is read through the hub
  // (`forward_proc` is called with the hub id) on every delivery.
  assert.equal(yp.calls.filter(id => id === 'actor-1').length, 1);
  assert.equal(yp.calls.filter(id => id === 'hub-1').length, 1 + 5);
});

test('reads a direct message from the sender and falls back to the verb when it cannot', async () => {
  const yp = fakeYp({
    actor: {'actor-1': [{display_name: 'Temp Test'}]},
    message: {"p2p_get_message:'msg-2'": [{message: 'lunch at 12?', attachment: null}]},
  });
  const {resolveNotification} = createMobilePushContent(yp);
  assert.deepEqual(
    await resolveNotification({type: 'chat.post', actor_id: 'actor-1', key_id: 'msg-2'}),
    {title: 'Temp Test', body: 'lunch at 12?'},
  );
  assert.deepEqual(
    await resolveNotification({type: 'chat.post', actor_id: 'actor-1', key_id: 'gone'}),
    {title: 'Temp Test', body: 'Sent you a message'},
  );
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
