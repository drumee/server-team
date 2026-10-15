const assert = require('node:assert/strict');
const test = require('node:test');

global.myDrumee = {arch: 'pod', useEmail: 0};
global.verbosity = 0;
global.debug = {};

const DrumatePrivate = require('../service/private/drumate');
const {_changeUsername} = DrumatePrivate.prototype;

const UID = 'aaaaaaaaaaaaaaaa';

// Stub `this`: the caller is `john` in domain 1. `taken` is the answer
// get_user_in_domain gives; `renameFails` makes drumate_change_username throw.
function worker({taken = null, renameFails = false} = {}) {
  const calls = [];
  return {
    calls,
    uid: UID,
    warn() {},
    yp: {
      async await_query() {
        return {username: 'john', domain_id: 1};
      },
      async await_proc(name, ...args) {
        calls.push([name, ...args]);
        if (name === 'get_user_in_domain') {
          return taken ? {id: taken, exists: 1} : {id: 'ffffffffffffffff', exists: 0};
        }
        if (name === 'drumate_change_username' && renameFails) {
          throw new Error('Duplicate entry');
        }
        return {};
      },
    },
  };
}

test('an unchanged username (any case) touches nothing', async () => {
  const w = worker();
  assert.equal(await _changeUsername.call(w, ' John '), null);
  assert.deepEqual(w.calls, []);
});

test('a free, valid username renames the column and vhost', async () => {
  const w = worker();
  assert.equal(await _changeUsername.call(w, 'john.doe'), null);
  assert.deepEqual(w.calls.at(-1), ['drumate_change_username', UID, 'john.doe']);
});

test('a username used by someone else is rejected before any write', async () => {
  const w = worker({taken: 'bbbbbbbbbbbbbbbb'});
  assert.deepEqual(await _changeUsername.call(w, 'jane'), {error: 'USERNAME_TAKEN'});
  assert.ok(!w.calls.some(([n]) => n === 'drumate_change_username'));
});

test('invalid usernames never reach the database', async () => {
  for (const bad of ['', 'a', 'john doe', '-john', 'john@x.com', 'x'.repeat(81)]) {
    const w = worker();
    assert.deepEqual(await _changeUsername.call(w, bad), {error: 'USERNAME_INVALID'}, bad);
    assert.deepEqual(w.calls, [], bad);
  }
});

test('losing a rename race reports the name as taken', async () => {
  const w = worker({renameFails: true});
  assert.deepEqual(await _changeUsername.call(w, 'jane'), {error: 'USERNAME_TAKEN'});
});
