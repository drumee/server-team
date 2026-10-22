const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createMobilePushAuthorization,
} = require('../service/lib/mobile-push-authorization');

function databaseFixture({blocked = false, memberPrivilege = 7, nodePrivilege = 7} = {}) {
  const await_proc = async (name) => {
    if (name === 'drumate_exists') return [{id: 'user'}];
    if (name === 'forward_proc') return [{privilege: nodePrivilege}];
    return [];
  };
  const await_query = async sql => {
    if (sql.includes('contact_block')) return blocked ? [{blocked: 1}] : [];
    if (sql.includes('SELECT db_name')) return [{db_name: 'f_hub'}];
    return [{privilege: memberPrivilege}];
  };
  return {await_proc, await_query};
}

test('rejects a blocked direct-chat recipient', async () => {
  const authorization = createMobilePushAuthorization(databaseFixture({blocked: true}));
  assert.equal(await authorization.recipientAllowed({
    type: 'chat.post',
    actor_id: 'actor-1',
  }, 'user-1'), false);
});

test('authorizes a call by the callee, not by a hub, and still honours a block', async () => {
  // A 1:1 call's hub_id is the caller's uid: no hub database answers for it.
  const noHub = {...databaseFixture(), await_query: async sql =>
    (sql.includes('contact_block') || sql.includes('SELECT db_name') ? [] : [{privilege: 7}])};
  const call = {type: 'conference.invite', actor_id: 'caller-1', hub_id: 'caller-1'};
  assert.equal(await createMobilePushAuthorization(noHub).recipientAllowed(call, 'callee-1'), true);

  const blocked = createMobilePushAuthorization(databaseFixture({blocked: true}));
  assert.equal(await blocked.recipientAllowed(call, 'callee-1'), false);
});

test('requires current workspace and node capability', async () => {
  const allowed = createMobilePushAuthorization(databaseFixture());
  assert.equal(await allowed.recipientAllowed({
    type: 'channel.post',
    actor_id: 'actor-1',
    hub_id: 'hub-1',
    scope_nid: 'folder-1',
  }, 'user-1'), true);

  const revoked = createMobilePushAuthorization(databaseFixture({nodePrivilege: 3}));
  assert.equal(await revoked.recipientAllowed({
    type: 'channel.post',
    actor_id: 'actor-1',
    hub_id: 'hub-1',
    scope_nid: 'folder-1',
  }, 'user-1'), false);
});

test('retries instead of silently dropping when authorization lookup fails', async () => {
  const authorization = createMobilePushAuthorization({
    await_proc: async () => { throw new Error('offline'); },
    await_query: async () => { throw new Error('offline'); },
  });
  await assert.rejects(
    authorization.recipientAllowed({
      type: 'chat.post',
      actor_id: 'actor-1',
    }, 'user-1'),
    /offline/,
  );
});
