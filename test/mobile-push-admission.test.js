const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ADMISSION_TIMEOUT_MS,
  admit,
  callRingEvent,
  normalizeEvent,
  stableEventId,
} = require('../service/lib/mobile-push');

const base = {
  type: 'channel.post',
  actor_id: 'actor-1',
  hub_id: 'hub-1',
  key_id: 'message-1',
  occurred_at: 123,
};

test('normalizes only opaque allowlisted event fields', () => {
  const event = normalizeEvent({...base, message: 'private body'});
  assert.equal(event.type, 'channel.post');
  assert.equal(event.message, undefined);
  assert.equal(event.event_id, stableEventId(base));
  assert.throws(() => normalizeEvent({...base, type: 'unknown.event'}));
});

test('keeps reminder phases in separate deterministic event identities', () => {
  const reminder = {
    type: 'room.reminder',
    actor_id: 'actor-1',
    hub_id: 'hub-1',
    key_id: 'meeting-1',
    occurred_at: 123,
  };
  assert.notEqual(
    stableEventId({...reminder, event_phase: 'upcoming'}),
    stableEventId({...reminder, event_phase: 'start'}),
  );
});

test('a ringing call names its room and lasts as long as the app rings it', () => {
  const now = 1_800_000_000_000;
  const event = normalizeEvent(callRingEvent({
    callerUid: 'caller-1', hubId: 'caller-1', guestId: 'callee-1', roomId: '5f2c9a0e1b7d4c63', now,
  }));
  assert.equal(event.type, 'conference.invite');
  assert.equal(event.hub_id, 'caller-1');
  assert.equal(event.room_id, '5f2c9a0e1b7d4c63');
  assert.deepEqual(event.recipient_uids, ['callee-1']);
  assert.equal(event.expires_at, String(now / 1000 + 60));
  assert.throws(() => normalizeEvent({...event, room_id: 'room with spaces'}));
});

test('an offline dial queues one push per minute and opens no person as a workspace', () => {
  const now = 1_800_000_000_000;
  const dial = at => callRingEvent({callerUid: 'caller-1', hubId: 'caller-1', guestId: 'callee-1', now: at});
  const first = normalizeEvent(dial(now));
  assert.equal(first.hub_id, '');
  assert.equal(first.room_id, '');
  assert.equal(first.expires_at, String(now / 1000 + 45));
  // The caller re-invites every 3 s; those retries share the push.
  assert.equal(dial(now + 3000).event_id, first.event_id);

  const workspace = callRingEvent({callerUid: 'caller-1', hubId: 'hub-1', guestId: 'callee-1', now});
  assert.equal(workspace.hub_id, 'hub-1');
});

test('deduplicates and caps explicit recipients', () => {
  const recipient_uids = Array.from({length: 120}, (_, index) => `user-${index}`);
  recipient_uids.push('user-1');
  const event = normalizeEvent({...base, recipient_uids});
  assert.equal(event.recipient_uids.length, 100);
  assert.equal(new Set(event.recipient_uids).size, 100);
});

test('isolates queue failure from the producer', async () => {
  const result = await admit(base, async () => {
    throw new Error('redis unavailable');
  });
  assert.equal(result.accepted, false);
});

test('isolates invalid admission data from the producer', async () => {
  const result = await admit({...base, key_id: 'contains private spaces'});
  assert.deepEqual(result, {accepted: false, event_id: null});
});

test('bounds a slow queue admission', async () => {
  const started = Date.now();
  const result = await admit(base, () => new Promise(() => undefined));
  const elapsed = Date.now() - started;
  assert.equal(result.accepted, false);
  assert.ok(elapsed >= ADMISSION_TIMEOUT_MS - 20);
  assert.ok(elapsed <= 250);
});
