/**
 * Notification text for a mobile push.
 *
 * A banner names who acted, which workspace they acted in, and — for a chat
 * message — what they said. The product decision of 2026-09-08 (Aaron):
 * a chat push reads
 *
 *     <sender>                         (title)
 *     To <workspace>                   (subtitle; absent for a direct message)
 *     <message excerpt>                (body)
 *
 * instead of "<sender> / Posted in <workspace>", so the banner is worth
 * opening. The excerpt is the only content that leaves the identity-and-
 * workspace envelope, and it is bounded (`EXCERPT_LIMIT`), stripped of markup,
 * and read at delivery time through a stored procedure — the queue and Redis
 * still carry identifiers only, and a message trashed before delivery is never
 * quoted. Filenames, task titles and email addresses still never enter a push.
 *
 * A name that cannot be resolved is not an error. Push is advisory, so a
 * missing name degrades to the generic banner and the delivery still wakes the
 * client into the feed.
 */

const GENERIC_NOTIFICATION = {title: 'Drumee', body: 'You have new activity'};
const NAME_TTL_MS = 5 * 60 * 1000;
const NAME_CACHE_LIMIT = 5000;
const EXCERPT_LIMIT = 140;

/**
 * An instant meeting is not a typed message: the meeting window posts a
 * `channel.post` whose body is the sentinel `[[MEETING:start|end:{json}]]`
 * (`ui-team` window/meeting `_postMeetingSystemMessage`; the same regex lives
 * in `service/private/channel.js` and the chat export). Quoting the raw markup
 * would be nonsense and dropping it would read "Sent a message", so the
 * sentinel gets its own sentence.
 */
const MEETING_SENTINEL = /^\[\[MEETING:(start|end):/i;
const MEETING_BODY = {
  start: 'Started an instant meeting',
  end: 'Ended the meeting',
};

/**
 * One entry per admitted event type. Each returns the body only; the title is
 * the acting identity and the subtitle the workspace, both resolved by
 * `composeNotification` below. A chat body is the message excerpt when there
 * is one and the plain verb when there is not (attachment-only message, or a
 * message that could not be read).
 */
const EVENT_BODY = {
  'chat.post': (_workspace, _phase, excerpt) => excerpt || 'Sent you a message',
  'channel.post': (_workspace, _phase, excerpt) => excerpt || 'Sent a message',
  'task.assigned': () => 'Assigned you a task',
  'task.mention': () => 'Mentioned you in a task',
  'room.reminder': (_workspace, phase) =>
    phase === 'start' ? 'A meeting is starting' : 'A meeting starts soon',
};

/** Event types whose subtitle names the workspace ("To Marketing"). */
const WORKSPACE_SUBTITLED = new Set(['channel.post', 'task.assigned', 'task.mention']);

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function text(value) {
  return String(value == null ? '' : value).trim();
}

/**
 * The stored message text, as a one-line quote. A meeting sentinel becomes its
 * own sentence; mentions are stored as `[@Name](user:<uid>)` and read back as
 * `@Name` (the web chat item does the same); HTML tags go; whitespace
 * collapses; the rest is cut at `EXCERPT_LIMIT` on a word boundary with an
 * ellipsis.
 */
function excerptOf(message, attachment) {
  let value = text(message);
  const meeting = value.match(MEETING_SENTINEL);
  if (meeting) return MEETING_BODY[meeting[1].toLowerCase()] || '';
  value = value
    .replace(/\[@(.+?)\]\((?:user|mention)[^)]*\)/g, '@$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!value) {
    const files = asArray(attachment && typeof attachment === 'string'
      ? safeJson(attachment)
      : attachment);
    return files.length ? 'Sent an attachment' : '';
  }
  if (value.length <= EXCERPT_LIMIT) return value;
  const cut = value.slice(0, EXCERPT_LIMIT);
  const atWord = cut.lastIndexOf(' ');
  return `${(atWord > EXCERPT_LIMIT / 2 ? cut.slice(0, atWord) : cut).trimEnd()}…`;
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch (_) {
    return value ? [value] : [];
  }
}

/**
 * A reminder has no author worth naming — the meeting creator did not just do
 * something — so the workspace carries the title instead of a person.
 */
function isWorkspaceTitled(type) {
  return type === 'room.reminder';
}

function composeNotification({type, actorName, workspaceName, eventPhase, excerpt} = {}) {
  const body = EVENT_BODY[type];
  const workspace = text(workspaceName);
  const identity = isWorkspaceTitled(type) ? workspace : text(actorName);
  if (!body || !identity) return GENERIC_NOTIFICATION;
  const notification = {title: identity, body: body(workspace, text(eventPhase), text(excerpt))};
  if (WORKSPACE_SUBTITLED.has(type) && workspace) notification.subtitle = `To ${workspace}`;
  return notification;
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

  /**
   * The message a chat event is about, read where it was written: a direct
   * message lives in the SENDER's database (`chat.js _distributeMessage` →
   * `p2p_post_message` through the actor), a workspace message in the hub's
   * (`channel_post_message`). `key_id` is the message id on both events. Not
   * cached — every event is a different message — and best-effort: a failed
   * read leaves the verb-only body.
   */
  async function messageExcerpt(event) {
    if (!event.key_id) return '';
    const [db, proc] = event.type === 'chat.post'
      ? [event.actor_id, 'p2p_get_message']
      : [event.hub_id, 'channel_get_message'];
    if (!db) return '';
    try {
      const row = asArray(await yp.await_proc('forward_proc', db, proc, `'${event.key_id}'`))[0];
      return row ? excerptOf(row.message, row.attachment) : '';
    } catch (_) {
      return '';
    }
  }

  async function resolveNotification(event) {
    try {
      const wantsExcerpt = event.type === 'chat.post' || event.type === 'channel.post';
      const [actor, workspace, excerpt] = await Promise.all([
        event.actor_id
          ? cachedName(`actor:${event.actor_id}`, () => actorName(event.actor_id))
          : '',
        event.hub_id
          ? cachedName(`hub:${event.hub_id}`, () => workspaceName(event.hub_id))
          : '',
        wantsExcerpt ? messageExcerpt(event) : '',
      ]);
      return composeNotification({
        type: event.type,
        actorName: actor,
        workspaceName: workspace,
        eventPhase: event.event_phase,
        excerpt,
      });
    } catch (_) {
      return GENERIC_NOTIFICATION;
    }
  }

  return {resolveNotification};
}

module.exports = {
  EVENT_BODY,
  EXCERPT_LIMIT,
  MEETING_BODY,
  GENERIC_NOTIFICATION,
  composeNotification,
  createMobilePushContent,
  excerptOf,
};
