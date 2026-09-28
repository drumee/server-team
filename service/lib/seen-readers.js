/**
 * @license
 * Copyright 2024 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3.
 * https://www.gnu.org/licenses/agpl-3.0.html
 */

/**
 * Read receipts (`metadata._seen_`, a `{uid: ts}` map) only ever accumulate:
 * nothing removes a uid when that person leaves the hub, is removed, loses an
 * expired grant or deletes the account. The chat renders every key as a
 * "seen" avatar, so such a former reader kept showing in a workspace they are
 * no longer part of.
 *
 * Instead of rewriting history, the list services prune `_seen_` at read time
 * to the hub's current readers (`channel_reader_ids`). The stored row is left
 * untouched, so a returning member shows up again exactly where they read.
 */

/**
 * @param {object} db hub database handle (`this.db`)
 * @returns {Promise<Set<string>>} uids that can read this hub's chat now
 */
async function currentReaders(db) {
  const rows = await db.await_proc("channel_reader_ids");
  const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
  return new Set(list.map((r) => `${r.uid}`));
}

/**
 * Drop every `_seen_` key that is not a current reader. Keeps the metadata's
 * shape: a JSON string stays a string, an object is edited in place.
 * @param {object[]} messages rows from a channel list procedure — mutated
 * @param {Set<string>} readers from currentReaders()
 * @returns {object[]} the same `messages`
 */
function pruneSeen(messages, readers) {
  for (const message of messages || []) {
    if (!message || !message.metadata) continue;
    const isString = typeof message.metadata === "string";
    let md;
    try {
      md = isString ? JSON.parse(message.metadata) : message.metadata;
    } catch (e) {
      continue;
    }
    const seen = md && md._seen_;
    if (!seen || typeof seen !== "object") continue;
    let changed = false;
    for (const uid of Object.keys(seen)) {
      if (!readers.has(`${uid}`)) {
        delete seen[uid];
        changed = true;
      }
    }
    if (changed && isString) message.metadata = JSON.stringify(md);
  }
  return messages;
}

/**
 * Prune `messages` to the hub's current readers. Fails open: a hub whose
 * schema does not carry `channel_reader_ids` yet still lists its chat, with
 * `_seen_` as stored, rather than failing the whole list.
 * @param {object} ctx service handler (`this`: needs `db`, `warn`)
 * @param {object[]} messages mutated in place
 * @returns {Promise<object[]>} the same `messages`
 */
async function pruneToCurrentReaders(ctx, messages) {
  if (!messages || !messages.length) return messages;
  try {
    return pruneSeen(messages, await currentReaders(ctx.db));
  } catch (e) {
    if (ctx.warn) ctx.warn("[seen-readers] reader lookup failed", e && e.message);
    return messages;
  }
}

module.exports = { currentReaders, pruneSeen, pruneToCurrentReaders };
