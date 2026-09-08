const assert = require('node:assert/strict');
const test = require('node:test');

const {
  activeHubMemberUids,
  eligibleRecipientUids,
  hubMemberPageArguments,
  MAX_RECIPIENTS,
  pagedHubMembers,
} = require('../service/lib/mobile-push-recipients');

test('uses a fixed database page size for hub recipient resolution', () => {
  assert.equal(hubMemberPageArguments(1), '1,45');
  assert.equal(hubMemberPageArguments(3.9), '3,45');
  assert.equal(hubMemberPageArguments(-1), '1,45');
});

test('broadcast channel events use the current hub membership only', () => {
  const recipients = eligibleRecipientUids({
    type: 'channel.post',
    actor_id: 'actor-1',
    hub_id: 'hub-1',
    recipient_uids: ['mentioned-1'],
  }, ['actor-1', 'member-1', 'member-2']);

  assert.deepEqual(recipients, ['member-1', 'member-2']);
});

test('targeted hub events intersect explicit recipients with current members', () => {
  const recipients = eligibleRecipientUids({
    type: 'task.assigned',
    actor_id: 'actor-1',
    hub_id: 'hub-1',
    recipient_uids: ['member-1', 'revoked-1'],
  }, ['actor-1', 'member-1', 'member-2']);

  assert.deepEqual(recipients, ['member-1']);
});

test('direct events keep explicit recipients, exclude the actor, and apply the cap', () => {
  const recipients = eligibleRecipientUids({
    type: 'chat.post',
    actor_id: 'actor-1',
    recipient_uids: [
      'actor-1',
      ...Array.from({length: MAX_RECIPIENTS + 5}, (_, index) => `user-${index}`),
    ],
  });

  assert.equal(recipients.length, MAX_RECIPIENTS);
  assert.equal(recipients.includes('actor-1'), false);
});

test('filters expired members and requires the current event capability', () => {
  const rows = [
    {id: 'view-only', privilege: 3, expiry: 0},
    {id: 'chat-member', privilege: 7, expiry: 0},
    {id: 'expired-chat', privilege: 7, expiry: 99},
  ];
  assert.deepEqual(
    activeHubMemberUids({type: 'channel.post'}, rows, 100),
    ['chat-member'],
  );
  assert.deepEqual(
    activeHubMemberUids({type: 'task.assigned'}, rows, 100),
    ['view-only', 'chat-member'],
  );
});

test('pages current hub membership up to the recipient cap', async () => {
  const pages = [];
  const members = await pagedHubMembers(async page => {
    pages.push(page);
    return Array.from({length: 45}, (_, index) => ({
      id: `member-${(page - 1) * 45 + index}`,
    }));
  });

  assert.deepEqual(pages, [1, 2, 3]);
  assert.equal(members.length, MAX_RECIPIENTS);
});
