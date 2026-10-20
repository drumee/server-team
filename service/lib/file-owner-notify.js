/**
 * "<actor> edited <file>" / "<actor> commented on <file>", addressed to the
 * file's OWNER (media.owner_id, i.e. whoever uploaded or created it).
 *
 * Shared by every place a file changes or gets a comment: media.save (editor
 * saves), media.replace (re-upload over a file), channel.file_thread_post (the
 * file's chat thread) and the marketplace office plugin (euroffice saves and
 * comments written inside docx/xlsx/pptx), which loads this module through
 * server_home exactly like offline/media/normalize-docx-sections.
 *
 * The row is a yp.contact_activity event: it survives the file, needs no
 * per-user table, and contact_log_activity coalesces it per (actor, owner,
 * file) while unread, so an editor autosaving every few seconds is ONE
 * notification, refreshed, not one per save.
 *
 * Best-effort by contract: a notification must never fail the save or the
 * comment that triggered it, so nothing here throws.
 */
const { RedisStore, toArray } = require("@drumee/server-essentials");
const { CAN_READ, privilegeAllows } = require("./member-capability");

const FILE_EDITED = "file_edited";
const FILE_COMMENTED = "file_commented";
const EVENTS = new Set([FILE_EDITED, FILE_COMMENTED]);
// Live refresh of the owner's notification panel and badge.
const PUSH_SERVICE = "activity.file_owner";
// The comment shown in the notification is an excerpt, not the comment.
const EXCERPT_MAX = 200;
const ID_RE = /^[0-9a-zA-Z_-]{1,32}$/;
// An anonymous visitor on a public link is not anybody the owner could be told
// about (same sentinel as service/private/secure_share.js).
const ANONYMOUS_UID = "ffffffffffffffff";
const DB_RE = /^[A-Za-z0-9_]+$/;
const CONTAINERS = new Set(["folder", "hub", "root"]);

// Chat mentions are stored as markdown links, "[@Ann](mention:<uid>)"; the
// excerpt keeps the readable part only.
const MENTION_RE = /\[([^\]]*)\]\(mention:[^)]*\)/g;

function excerpt(text) {
  const s = String(text || "").replace(MENTION_RE, "$1").replace(/\s+/g, " ").trim();
  if (s.length <= EXCERPT_MAX) return s;
  return `${s.slice(0, EXCERPT_MAX - 1)}…`;
}

// "/Reports/2026/" -> "2026"; the workspace root has none.
function folderNameOf(parent_path) {
  const parts = String(parent_path || "").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

/**
 * Owner of `nid` in the hub whose DB is `db_name`, or null.
 */
async function fileOwner(yp, db_name, nid) {
  if (!DB_RE.test(String(db_name || ""))) return null;
  let row = await yp.await_query(
    `SELECT owner_id FROM \`${db_name}\`.media WHERE id=? LIMIT 1`,
    nid
  );
  if (Array.isArray(row)) row = row[0];
  return (row && row.owner_id) ? String(row.owner_id) : null;
}

/**
 * Owner of the file `nid` of workspace `hub_id`, or null (unknown file,
 * malformed ids, any failure). Lets a caller skip expensive work when the only
 * people involved are the owner themselves.
 */
async function ownerOf(yp, hub_id, nid) {
  try {
    if (!ID_RE.test(String(hub_id || "")) || !ID_RE.test(String(nid || ""))) return null;
    return await fileOwner(yp, await yp.await_func("get_db_name", hub_id), String(nid));
  } catch (e) {
    return null;
  }
}

/**
 * @param {Object} svc a service (Entity) instance: yp, payload(), warn()
 * @param {Object} args
 *   event      'file_edited' | 'file_commented'
 *   hub_id     the workspace (or personal drive) holding the file
 *   nid        the file
 *   actor      uid of whoever edited / commented
 *   comment    (file_commented) the comment text, stored as an excerpt
 *   message_id (file_commented) the chat-thread message, when it is one
 *   source     where it came from: 'editor' | 'upload' | 'office' | 'thread'
 * @returns {Promise<boolean>} true when a notification was written
 */
async function notifyFileOwner(svc, args = {}) {
  const { event, actor, comment, message_id, source } = args;
  const hub_id = String(args.hub_id || "");
  const nid = String(args.nid || "");
  try {
    if (!EVENTS.has(event)) return false;
    if (!ID_RE.test(hub_id) || !ID_RE.test(nid) || !ID_RE.test(String(actor || ""))) return false;
    if (String(actor) === ANONYMOUS_UID) return false;
    const yp = svc.yp;
    const db_name = await yp.await_func("get_db_name", hub_id);
    const owner = await fileOwner(yp, db_name, nid);
    // Your own edits and comments are not news to you.
    if (!owner || owner === String(actor)) return false;

    // As the owner sees it: an owner who has since lost access to the file
    // (left the workspace, was removed) must not be told about it, nor learn
    // its name.
    const node = toArray(await yp.await_proc(`${db_name}.mfs_access_node`, owner, nid))[0];
    if (!node || String(node.status || "") !== "active") return false;
    if (CONTAINERS.has(String(node.filetype || ""))) return false;
    if (!privilegeAllows(node.privilege, CAN_READ)) return false;

    const data = {
      hub_id,
      nid,
      pid: node.parent_id || node.pid || null,
      filename: node.filename || "",
      ext: node.ext || node.extension || "",
      filetype: node.filetype || "",
      folder_name: folderNameOf(node.parent_path),
      source: source || null,
    };
    if (event === FILE_COMMENTED) {
      data.comment = excerpt(comment);
      if (message_id && ID_RE.test(String(message_id))) data.message_id = String(message_id);
    }
    await yp.await_proc("contact_log_activity", actor, owner, event, data);

    try {
      const sockets = await yp.await_proc("user_sockets", [owner]);
      if (sockets && toArray(sockets).length) {
        await RedisStore.sendData(
          svc.payload({ event, hub_id, nid }, { service: PUSH_SERVICE }),
          sockets
        );
      }
    } catch (e) {
      svc.warn("[file-owner-notify] push failed:", e && e.message);
    }
    return true;
  } catch (e) {
    svc.warn("[file-owner-notify] skipped:", event, hub_id, nid, e && e.message);
    return false;
  }
}

module.exports = {
  ownerOf,
  FILE_EDITED,
  FILE_COMMENTED,
  PUSH_SERVICE,
  notifyFileOwner,
  // exported for tests
  excerpt,
  folderNameOf,
};
