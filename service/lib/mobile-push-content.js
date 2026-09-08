/**
 * Notification text for a mobile push.
 *
 * The banner names who acted and which workspace they acted in, and nothing
 * else: no message body, no filename, no task title, no email address. Those
 * belong to the authenticated Activity feed, which stays the source of truth —
 * a push only says enough to be worth opening. Every string here reaches
 * Google and Apple infrastructure and shows on a locked screen, so widening
 * this module widens that exposure.
 *
 * A name that cannot be resolved is not an error. Push is advisory, so a
 * missing name degrades to the generic banner and the delivery still wakes the
 * client into the feed.
 */

const GENERIC_NOTIFICATION = {title: 'Drumee', body: 'You have new activity'};
const NAME_TTL_MS = 5 * 60 * 1000;
const NAME_CACHE_LIMIT = 5000;

/**
 * One entry per admitted event type. Each returns the body only; the title is
 * the acting identity, resolved by `composeNotification` below. `workspace` is
 * an empty string for events that carry no hub, so every phrasing has to read
 * correctly without it.
 */
const EVENT_BODY = {
  'chat.post': () => 'Sent you a message',
  'channel.post': workspace =>
    workspace ? `Posted in ${workspace}` : 'Posted a new message',
  'hub.invite_received': workspace =>
    workspace ? `Invited you to ${workspace}` : 'Invited you to a workspace',
  'task.assigned': workspace =>
    workspace ? `Assigned you a task in ${workspace}` : 'Assigned you a task',
  'task.mention': workspace =>
    workspace ? `Mentioned you in ${workspace}` : 'Mentioned you in a task',
  'room.reminder': (workspace, phase) =>
    phase === 'start' ? 'A meeting is starting' : 'A meeting starts soon',
};

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function text(value) {
  return String(value == null ? '' : value).trim();
}

/**
 * A reminder has no author worth naming — the meeting creator did not just do
 * something — so the workspace carries the title instead of a person.
 */
function isWorkspaceTitled(type) {
  return type === 'room.reminder';
}

function composeNotification({type, actorName, workspaceName, eventPhase} = {}) {
  const body = EVENT_BODY[type];
  const workspace = text(workspaceName);
  const identity = isWorkspaceTitled(type) ? workspace : text(actorName);
  if (!body || !identity) return GENERIC_NOTIFICATION;
  return {title: identity, body: body(workspace, text(eventPhase))};
}

function createMobilePushContent(yp) {
  const names = new Map();

  async function cachedName(key, load) {
    const now = Date.now();
    const hit = names.get(key);
    if (hit && hit.expires > now) return hit.value;
    const value = await load();
    // Names change rarely and a fan-out asks for the same two over and over,
    // so a flat map with a TTL is enough. Clearing wholesale when it grows
    // keeps the worker's memory bounded without an eviction policy to own.
    if (names.size >= NAME_CACHE_LIMIT) names.clear();
    names.set(key, {value, expires: now + NAME_TTL_MS});
    return value;
  }

  /**
   * `push_actor_name` composes the display name from the given and family name
   * alone, so the rule that an email address never reaches a push provider is
   * enforced at the database boundary. An account with neither name answers
   * with an empty string.
   */
  async function actorName(uid) {
    const row = asArray(await yp.await_proc('push_actor_name', uid))[0];
    return row ? text(row.display_name) : '';
  }

  /**
   * `push_workspace_name` reads the name members set and see, not
   * `entity.headline` — that optional title is normally unset. See the
   * procedure for why.
   */
  async function workspaceName(hubId) {
    const row = asArray(await yp.await_proc('push_workspace_name', hubId))[0];
    return row ? text(row.workspace_name) : '';
  }

  async function resolveNotification(event) {
    try {
      const [actor, workspace] = await Promise.all([
        event.actor_id
          ? cachedName(`actor:${event.actor_id}`, () => actorName(event.actor_id))
          : '',
        event.hub_id
          ? cachedName(`hub:${event.hub_id}`, () => workspaceName(event.hub_id))
          : '',
      ]);
      return composeNotification({
        type: event.type,
        actorName: actor,
        workspaceName: workspace,
        eventPhase: event.event_phase,
      });
    } catch (_) {
      return GENERIC_NOTIFICATION;
    }
  }

  return {resolveNotification};
}

module.exports = {
  EVENT_BODY,
  GENERIC_NOTIFICATION,
  composeNotification,
  createMobilePushContent,
};
