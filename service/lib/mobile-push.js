const Crypto = require('crypto');

const ALLOWED_EVENTS = new Set([
  'chat.post',
  'channel.post',
  'hub.invite_received',
  'task.assigned',
  'task.mention',
  'room.reminder',
]);
const ADMISSION_TIMEOUT_MS = 225;
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
    event_phase: input.event_phase || '',
    occurred_at: occurredAt,
    expires_at: String(input.expires_at || Math.floor(Date.now() / 1000) + 3600),
    queue_generation: String(input.queue_generation || 1),
    recipient_uids: [...new Set((input.recipient_uids || []).filter(Boolean))].slice(0, 100),
  };
  for (const key of [
    'event_id', 'type', 'actor_id', 'hub_id', 'key_id', 'scope_nid', 'event_phase',
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

module.exports = {ADMISSION_TIMEOUT_MS, ALLOWED_EVENTS, admit, normalizeEvent, stableEventId};
