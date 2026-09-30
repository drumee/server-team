/**
 * Direct-conversation export rows → the chat-export section shape, shared by
 * chat.p2p_export (JSON, inline) and offline/media/chat-export.js (PDF,
 * mode "p2p"). Mirrors that worker's normalizeRow / parseAttachments for
 * channel rows, so a DM export reads like a workspace one.
 */
const { toArray } = require("@drumee/server-essentials");

const PAGE_SIZE = 45; // p2p_export_messages' page

function parseAttachments(attachment) {
  if (!attachment) return [];
  try {
    const raw = typeof attachment === "string" ? JSON.parse(attachment) : attachment;
    return toArray(raw)
      .map((a) => {
        if (!a) return null;
        const nid = a.nid || (typeof a === "string" ? a : null);
        if (!nid) return null;
        // A DM attachment lives in its sender's wicket hub: always named on it.
        return { name: a.filename || nid, link: `/-/svc/media.orig?nid=${nid}&hub_id=${a.hub_id}` };
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function normalizeP2pRow(row) {
  const name = row.fullname || `${row.firstname || ""} ${row.lastname || ""}`.trim() || row.author_id;
  return {
    id: row.message_id,
    author: { id: row.author_id, name },
    time: row.ctime,
    text: row.message || "",
    attachments: parseAttachments(row.attachment),
    reply_to: row.thread_id || null,
  };
}

async function gatherP2pSection(db, peer_id, name, start, end) {
  const messages = [];
  for (let page = 1; ; page++) {
    const rows = toArray(await db.await_proc("p2p_export_messages", peer_id, start || null, end || null, page));
    for (const r of rows) messages.push(normalizeP2pRow(r));
    if (rows.length < PAGE_SIZE) break;
  }
  return { type: "direct_chat", name, messages };
}

module.exports = { normalizeP2pRow, gatherP2pSection, PAGE_SIZE };
