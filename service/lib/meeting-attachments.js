// The nid list a meeting (`schedule` node) keeps in metadata.content.attachments.
//
// Pure: no DB, no session. room.js and dmz.js both read through here, so the
// rule for what counts as a valid attachment id lives in one place — and
// because every nid is checked against NID_RE, callers may interpolate them
// into forward_proc argument strings (dmz.js does).
const NID_RE = /^[0-9a-f]{16}$/;
const MAX_ATTACHMENTS = 20;

function parse(v) {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch (e) {
    return v;
  }
}

function normalizeNids(input) {
  let v = parse(input);
  if (v == null) return [];
  if (!Array.isArray(v)) v = [v];
  const out = [];
  for (const n of v) {
    if (typeof n !== "string" || !NID_RE.test(n) || out.includes(n)) continue;
    out.push(n);
  }
  return out;
}

function attachmentsOf(content) {
  const c = parse(content);
  return normalizeNids(c && typeof c === "object" ? c.attachments : null);
}

function mergeAttachments(existing, incoming) {
  const list = normalizeNids(existing);
  const added = [];
  const overflow = [];
  for (const n of normalizeNids(incoming)) {
    if (list.includes(n)) continue;
    if (list.length >= MAX_ATTACHMENTS) {
      overflow.push(n);
      continue;
    }
    list.push(n);
    added.push(n);
  }
  return { list, added, overflow };
}

function isMeetingNode(node) {
  return !!(node && (node.filetype === "schedule" || node.category === "schedule"));
}

module.exports = { NID_RE, MAX_ATTACHMENTS, normalizeNids, attachmentsOf, mergeAttachments, isMeetingNode };
