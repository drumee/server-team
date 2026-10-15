// conference-join-online-status.test.js — the joiner's own join reply must not
// wait on the online-status fan-out (one Redis send per online contact socket,
// sequential): it sat between the 1:1 callee/caller and their join reply.
//
//   node --test test/conference-join-online-status.test.js
const assert = require('node:assert/strict');
const test = require('node:test');

global.myDrumee = { arch: 'pod', useEmail: 0, conference: { domain: 'x' } };
global.verbosity = 0;
global.debug = {};

const Conference = require('../service/conference');

function ctx({ pushNeverSettles = true } = {}) {
  const out = { data: null };
  return {
    out,
    uid: 'me00000000000001',
    hub: { get: () => null },
    input: { get: () => null, need: () => 'connect' },
    db: { await_proc: async () => ({}) },
    yp: { await_proc: async () => [] },
    warn: () => {},
    debug: () => {},
    pushUserOnlineStatus: () => (pushNeverSettles ? new Promise(() => {}) : Promise.resolve()),
    output: { data: (d) => { out.data = d; } },
  };
}

test('join reply goes out even while the online-status push is still running', async () => {
  const c = ctx();
  const done = Conference.prototype.sendRoomInfo.call(c, {
    // A role that takes no notify branch: only the tail is exercised.
    user: { role: 'observer', uid: 'someone-else', permission: 7 },
    room_id: 'r1',
    socket_id: 's1',
    metadata: { type: 'connect' },
    attendees: [],
  });
  const timedOut = Symbol('timeout');
  const r = await Promise.race([done, new Promise((res) => setTimeout(() => res(timedOut), 200))]);
  assert.notEqual(r, timedOut, 'sendRoomInfo waited on pushUserOnlineStatus');
  assert.equal(c.out.data.permission, 7);
});

test('a failing online-status push does not fail the join', async () => {
  const c = ctx();
  c.pushUserOnlineStatus = () => Promise.reject(new Error('redis down'));
  await Conference.prototype.sendRoomInfo.call(c, {
    user: { role: 'observer', uid: 'someone-else', permission: 7 },
    room_id: 'r1', socket_id: 's1', metadata: { type: 'connect' }, attendees: [],
  });
  assert.equal(c.out.data.permission, 7);
});
