// Person @-mentions are stored inline as "[@Full Name](user:<uid>)" — the
// marker the task editor, the meeting description and chat all write (ui-team
// window/tasks/mention-markers.js, window/folder/meeting-markers.js). File
// mentions use "(mention:HUB:NID)" and are deliberately NOT matched here: they
// name a file, not a person to notify.
const USER_MENTION_RE = /\[@[^\]]*\]\(user:([^)\s]+)\)/g;
const UID_RE = /^[0-9a-zA-Z_-]{1,64}$/;
// A description is user input. Bounded so a pasted wall of markers cannot fan
// out into an unbounded number of notification writes.
const MAX_MENTIONS = 50;

/**
 * Unique person uids mentioned in `text`, in order of first appearance.
 * Anything that does not look like an id is dropped.
 */
function mentionedUserIds(text) {
  const out = [];
  if (typeof text !== "string" || !text) return out;
  USER_MENTION_RE.lastIndex = 0;
  let m;
  while ((m = USER_MENTION_RE.exec(text)) && out.length < MAX_MENTIONS) {
    const uid = m[1];
    if (UID_RE.test(uid) && !out.includes(uid)) out.push(uid);
  }
  return out;
}

/**
 * The uids mentioned in `next` that were not already mentioned in `prev` —
 * an edit notifies only the people it newly mentions.
 */
function newlyMentionedUserIds(prev, next) {
  const before = new Set(mentionedUserIds(prev));
  return mentionedUserIds(next).filter((uid) => !before.has(uid));
}

module.exports = { mentionedUserIds, newlyMentionedUserIds, MAX_MENTIONS };
