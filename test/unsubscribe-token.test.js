const assert = require('node:assert/strict');
const test = require('node:test');

const token = require('../service/lib/unsubscribe-token');

const SECRET = 'x'.repeat(48);
const BASE = 'https://drumee.test/-';

test.beforeEach(() => token._setSecretForTest(SECRET));
test.after(() => token._setSecretForTest(undefined));

test('a signature verifies for the address it was minted for', () => {
  const sig = token.sign('ann@example.com');
  assert.equal(typeof sig, 'string');
  assert.ok(sig.length >= 40);
  assert.equal(token.verify('ann@example.com', sig), true);
});

test('sign/verify are case- and whitespace-insensitive', () => {
  const sig = token.sign('John@Example.com');
  assert.equal(sig, token.sign('  john@example.com '));
  assert.equal(token.verify('JOHN@EXAMPLE.COM', sig), true);
});

test('verify rejects a signature for another address or a tampered one', () => {
  const sig = token.sign('ann@example.com');
  assert.equal(token.verify('bob@example.com', sig), false);
  assert.equal(token.verify('ann@example.com', sig.slice(0, -2)), false);
  assert.equal(token.verify('ann@example.com', sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A')), false);
  assert.equal(token.verify('ann@example.com', ''), false);
  assert.equal(token.verify('ann@example.com', undefined), false);
});

test('no secret: nothing is signed and nothing verifies', () => {
  token._setSecretForTest(null);
  assert.equal(token.sign('ann@example.com'), null);
  assert.equal(token.verify('ann@example.com', 'anything'), false);
  assert.equal(token.unsubscribeUrl('ann@example.com', BASE), null);
});

test('the URL targets callback.unsubscribe with the lowercased address', () => {
  const url = token.unsubscribeUrl('Ann+tag@Example.com', BASE);
  const u = new URL(url);
  assert.equal(`${u.origin}${u.pathname}`, 'https://drumee.test/-/svc/');
  assert.equal(u.searchParams.get('service'), 'callback.unsubscribe');
  assert.equal(u.searchParams.get('email'), 'ann+tag@example.com');
  assert.equal(token.verify('ann+tag@example.com', u.searchParams.get('sig')), true);
});
