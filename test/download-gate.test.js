const assert = require('node:assert/strict');
const test = require('node:test');

const Gate = require('../service/lib/download-gate');

// The subset of node-redis the gate uses: get, and set with EX/NX.
function fakeRedis() {
  const m = new Map();
  return {
    m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async set(k, v, o = {}) {
      if (o.NX && m.has(k)) return null;
      m.set(k, v);
      return 'OK';
    },
  };
}
const noSleep = () => Promise.resolve();

test('gate ids and targets: the page token, and paths on this origin only', () => {
  assert.equal(Gate.validGate('a1B2c3D4-e5_f6'), true);
  assert.equal(Gate.validGate('short'), false);
  assert.equal(Gate.validGate('../../x/y/zzzz'), false);
  assert.equal(Gate.validTarget('/-/svc/media.zip?hub_id=h&nid=n&id=z'), true);
  assert.equal(Gate.validTarget('https://evil.example/x'), false);
  assert.equal(Gate.validTarget('//evil.example/x'), false);
  assert.equal(Gate.validTarget('/\\evil.example'), false);
  assert.equal(Gate.validTarget('-/svc/x'), false);
});

test('a parked request is released once the second item opens the gate', async () => {
  const r = fakeRedis();
  let polls = 0;
  const sleep = async () => {
    polls++;
    // The browser asks for the second item only after the user allows it.
    if (polls === 3) await Gate.mark(r, 'u1', 'gate1234', Gate.OPEN);
  };
  assert.equal(await Gate.hold(r, 'u1', 'gate1234', { sleep, wait_ms: 60000 }), 'open');
  assert.equal(polls, 3);
});

test('gates are per user: another session cannot open mine', async () => {
  const r = fakeRedis();
  await Gate.mark(r, 'u2', 'gate1234', Gate.OPEN);
  assert.equal(await Gate.state(r, 'u1', 'gate1234'), '');
});

test('an answer is final: cancel after open, or open after cancel, changes nothing', async () => {
  const r = fakeRedis();
  await Gate.mark(r, 'u1', 'gateAAAA', Gate.OPEN);
  assert.equal(await Gate.mark(r, 'u1', 'gateAAAA', Gate.CANCEL), 'open');
  await Gate.mark(r, 'u1', 'gateBBBB', Gate.CANCEL);
  assert.equal(await Gate.mark(r, 'u1', 'gateBBBB', Gate.OPEN), 'cancel');
  assert.equal(await Gate.hold(r, 'u1', 'gateBBBB', { sleep: noSleep }), 'cancel');
});

test('unanswered, the hold gives up before nginx would, and hops to itself', async () => {
  const r = fakeRedis();
  assert.equal(await Gate.hold(r, 'u1', 'gate1234', { sleep: noSleep, wait_ms: 0 }), '');
  assert.ok(Gate.HOLD_MS < 60000);
  assert.equal(
    Gate.nextHop('/-/svc/media.download_gate?gate=g&role=hold&to=%2Fx%3Fa%3D1'),
    '/-/svc/media.download_gate?gate=g&role=hold&to=%2Fx%3Fa%3D1&hop=1',
  );
  assert.match(Gate.nextHop('/s?gate=g&hop=4'), /hop=5$/);
  // The browser follows at most 20 redirects.
  assert.equal(Gate.nextHop(`/s?gate=g&hop=${Gate.MAX_HOPS}`), null);
  assert.ok(Gate.MAX_HOPS < 20);
});

test('a dropped request stops waiting', async () => {
  const r = fakeRedis();
  assert.equal(await Gate.hold(r, 'u1', 'gate1234', { sleep: noSleep, isGone: () => true }), 'cancel');
});
