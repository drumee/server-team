const Crypto = require('crypto');

// What a phone is interrupted for (Aaron, 2026-09-08): a chat message, a
// meeting, and a mention — in chat, or in a task by @-mention or assignment.
// A workspace invitation is not on that list; it stays in the Activity feed
// and the invitation mail. A call ringing the user (`conference.invite`) is:
// the socket rings only an open app, so a backgrounded or closed one needs it.
const ALLOWED_EVENTS = new Set([
  'chat.post',
  'channel.post',
  'task.assigned',
  'task.mention',
  'room.reminder',
  'conference.invite',
]);
const ADMISSION_TIMEOUT_MS = 225;
// A call rings as long as the app rings an invite (drumee-mobile
// INCOMING_INVITE_MS). A callee with no socket is re-invited by the caller
// every 3 s for 45 s (ui-team window/connect, drumee-mobile OFFLINE_RING_MS).
const CALL_RING_SECONDS = 60;
const OFFLINE_DIAL_SECONDS = 45;
const ID = /^[0-9a-zA-Z_.:-]{1,128}$/;
const NODE_ID = /^[0-9a-zA-Z_-]{1,32}$/;

function stableEventId(event) {
  const source = [
    event.type,
    event.actor_id || '',
    event.hub_id || '',
    event.key_id || '',
    event.occurred_at || '',
    event.event_phase || '',
  ].join('|');
  return Crypto.createHash('sha256').update(source).digest('hex').slice(0, 40);
}

function normalizeEvent(input) {
  if (!input || !ALLOWED_EVENTS.has(input.type)) {
    throw new Error('mobile push event type is not allowed');
  }
  const occurredAt = String(input.occurred_at || Date.now());
  const event = {
    event_id: input.event_id || stableEventId({...input, occurred_at: occurredAt}),
    type: input.type,
    actor_id: input.actor_id || '',
    hub_id: input.hub_id || '',
    key_id: input.key_id || '',
    scope_nid: input.scope_nid || '',
    room_id: input.room_id || '',
    room_type: input.room_type || '',
    event_phase: input.event_phase || '',
    occurred_at: occurredAt,
    expires_at: String(input.expires_at || Math.floor(Date.now() / 1000) + 3600),
    queue_generation: String(input.queue_generation || 1),
    recipient_uids: [...new Set((input.recipient_uids || []).filter(Boolean))].slice(0, 100),
  };
  for (const key of [
    'event_id', 'type', 'actor_id', 'hub_id', 'key_id', 'scope_nid', 'room_id', 'room_type',
    'event_phase',
  ]) {
    if (event[key] && !ID.test(String(event[key]))) {
      throw new Error(`invalid mobile push ${key}`);
    }
  }
  if (event.scope_nid && !NODE_ID.test(String(event.scope_nid))) {
    throw new Error('invalid mobile push scope_nid');
  }
  return event;
}

/**
 * The push that rings a call's callee. With a room (the callee has a socket,
 * maybe in a backgrounded app) a tap rings that room; without one (no socket)
 * it only opens the app, and the caller's next re-invite rings it there. A 1:1
 * call's hub_id is the caller's own uid, which an offline tap must not open as
 * a workspace. The re-invites of one dial share an event id per minute, so
 * they queue one push, not fifteen.
 */
function callRingEvent({callerUid, hubId, guestId, roomId = '', roomType = '', now = Date.now()}) {
  const seconds = Math.floor(now / 1000);
  const direct = hubId === callerUid;
  const event = {
    type: 'conference.invite',
    actor_id: callerUid,
    hub_id: roomId || !direct ? hubId : '',
    room_id: roomId,
    room_type: roomType,
    recipient_uids: [guestId],
    expires_at: String(seconds + (roomId ? CALL_RING_SECONDS : OFFLINE_DIAL_SECONDS)),
  };
  event.event_id = stableEventId({
    ...event,
    key_id: roomId || guestId,
    occurred_at: String(Math.floor(seconds / 60)),
    event_phase: roomId ? 'ring' : 'dial',
  });
  return event;
}

async function admit(input, enqueue) {
  let event;
  try {
    event = normalizeEvent(input);
  } catch (_) {
    return {accepted: false, event_id: null};
  }
  const add = enqueue || (value => require('../../offline/queues/mobilePushQueue').addAdmission(value));
  let timer;
  try {
    const outcome = await Promise.race([
      Promise.resolve(add(event)).then(() => 'queued'),
      new Promise(resolve => {
        timer = setTimeout(() => resolve('timeout'), ADMISSION_TIMEOUT_MS);
      }),
    ]);
    return {accepted: outcome === 'queued', event_id: event.event_id};
  } catch (_) {
    return {accepted: false, event_id: event.event_id};
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = {
  ADMISSION_TIMEOUT_MS,
  ALLOWED_EVENTS,
  admit,
  callRingEvent,
  normalizeEvent,
  stableEventId,
};
