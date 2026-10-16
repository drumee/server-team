const assert = require('node:assert/strict');
const test = require('node:test');

const { unsubscribeEmail, unsubscribePage } = require('../service/lib/unsubscribe');

// Records proc calls; answers email_exists / get_entity_settings from `db`.
function fakeYp(db) {
  const calls = [];
  return {
    calls,
    await_proc: async (name, ...args) => {
      calls.push([name, ...args]);
      if (name === 'email_exists') return db.account ? { id: db.account } : {};
      if (name === 'get_entity_settings') return { settings: db.settings };
      if (name === 'entity_update_settings') return {};
      throw new Error(`unexpected proc ${name}`);
    },
  };
}

test('turns email_notifications off for the account', async () => {
  const yp = fakeYp({ account: 'u1', settings: { email_notifications: 1 } });
  assert.deepEqual(await unsubscribeEmail(yp, 'ann@example.com'), { changed: true });
  const upd = yp.calls.find((c) => c[0] === 'entity_update_settings');
  assert.equal(upd[1], 'u1');
  assert.equal(JSON.parse(upd[2]).email_notifications, 0);
});

test('preserves every other setting (string or object storage)', async () => {
  for (const settings of [
    { email_notifications: '1', mfa: 1, lang: 'fr' },
    JSON.stringify({ email_notifications: 1, mfa: 1, lang: 'fr' }),
  ]) {
    const yp = fakeYp({ account: 'u1', settings });
    await unsubscribeEmail(yp, 'ann@example.com');
    const upd = yp.calls.find((c) => c[0] === 'entity_update_settings');
    assert.deepEqual(JSON.parse(upd[2]), { email_notifications: 0, mfa: 1, lang: 'fr' });
  }
});

test('already off: nothing is written', async () => {
  const yp = fakeYp({ account: 'u1', settings: { email_notifications: 0 } });
  assert.deepEqual(await unsubscribeEmail(yp, 'ann@example.com'), { changed: false, reason: 'already_off' });
  assert.ok(!yp.calls.some((c) => c[0] === 'entity_update_settings'));
});

test('no account: nothing is written', async () => {
  const yp = fakeYp({ account: null });
  assert.deepEqual(await unsubscribeEmail(yp, 'guest@example.com'), { changed: false, reason: 'no_account' });
  assert.equal(yp.calls.length, 1);
});

test('pages are complete HTML and say what happened', () => {
  assert.match(unsubscribePage('done'), /<html[\s\S]*no longer receive/i);
  assert.match(unsubscribePage('invalid'), /not valid/i);
  assert.match(unsubscribePage('error'), /try again/i);
  assert.match(unsubscribePage('anything-else'), /not valid/i);
});

test('invalid signature changes nothing', async () => {
  const token = require('../service/lib/unsubscribe-token');
  token._setSecretForTest('k'.repeat(40));
  try {
    assert.equal(token.verify('ann@example.com', token.sign('bob@example.com')), false);
  } finally {
    token._setSecretForTest(undefined);
  }
});
