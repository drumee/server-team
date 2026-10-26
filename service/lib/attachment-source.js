/**
 * Find the workspace file a chat attachment was made from.
 *
 * A message never holds the file you attached. channel.post puts a copy in
 * the message's own sandbox folder (`/__chat__/<message_id>/`), and a file
 * picked "From workspace" was already a copy before that (staged under
 * `/__chat__/__upload__/`), so nothing on the attachment names its source.
 * Only a device upload promoted into a folder is tagged (`folder_nid`).
 *
 * What a copy does keep is the source's metadata, md5Hash included
 * (mfs_copy_all copies the column as is). So the source is the live,
 * non-chat file in the hub with the same content. Content alone is not
 * enough: uploading the same file twice gives "x(1)" and "x(2)", one hash.
 * The copy carries its source's NAME (it was copied under it), so the same
 * name and extension rank first; the conversation's folder only breaks a tie
 * between same-named files — ranked first, it handed "x(2)", still in the
 * chat's folder, to a click on "x(1)" after "x(1)" moved to a sub-folder.
 * Then the most recent. Without a hash (older nodes), same name AND same
 * size stands in for it.
 */

const CHAT_SANDBOX = /^\/__chat__\//;

function isChatSandbox(ownpath) {
  return CHAT_SANDBOX.test(`${ownpath || ""}`);
}

function md5Of(node) {
  if (!node) return null;
  if (node.md5Hash) return `${node.md5Hash}`;
  let md = node.metadata;
  if (typeof md === "string") {
    try {
      md = JSON.parse(md);
    } catch (e) {
      md = null;
    }
  }
  return md && md.md5Hash ? `${md.md5Hash}` : null;
}

/**
 * The lookup for `copy` (an mfs_access_node row), or null when there is
 * nothing to match on.
 * @param {Object} copy
 * @param {String} [scope_nid] the folder the conversation is scoped to
 * @returns {{sql: String, args: Array}|null}
 */
function sourceQuery(copy, scope_nid) {
  if (!copy) return null;
  const filename = `${copy.filename || copy.user_filename || ""}`;
  const extension = `${copy.extension || copy.ext || ""}`;
  const md5 = md5Of(copy);
  const size = Number(copy.filesize);
  let match;
  let matchArgs;
  if (md5) {
    match = "JSON_VALUE(metadata, '$.md5Hash') = ?";
    matchArgs = [md5];
  } else if (filename && Number.isFinite(size) && size > 0) {
    match = "user_filename = ? AND filesize = ?";
    matchArgs = [filename, size];
  } else {
    return null;
  }
  const sql =
    "SELECT id FROM media" +
    " WHERE status = 'active'" +
    " AND category NOT IN ('folder', 'hub', 'root')" +
    " AND file_path NOT LIKE '/\\_\\_chat\\_\\_/%'" +
    ` AND ${match}` +
    " ORDER BY (user_filename = ?) DESC, (extension = ?) DESC," +
    " (parent_id = ?) DESC, upload_time DESC" +
    " LIMIT 1";
  return {
    sql,
    args: [...matchArgs, filename, extension, `${scope_nid || ""}`],
  };
}

module.exports = { isChatSandbox, md5Of, sourceQuery };
