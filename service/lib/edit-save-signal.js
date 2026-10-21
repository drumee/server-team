/**
 * What an editor save SAYS, as opposed to what it writes.
 *
 * Editors autosave (Casual Docs while it is merely open, ~1/s in a "Live"
 * co-editing room), and every save used to be announced: one media.replace
 * changelog row — "<file> has been updated" for every member — one
 * file_version snapshot and one "<A> edited <file>" for the owner. Measured on
 * drumee.in 2026-10-21: 22 saves in 30 s from a user who only opened a doc.
 * The bytes are still written exactly as before; this module only decides
 * whether a save is NEWS.
 *
 *   contentFingerprint  a hash of what a reader would see, so a save that
 *                       changes nothing is recognised as such. A Casual Docs
 *                       .udoc re-zips its .docx on every export (zip entry
 *                       timestamps, docProps/core.xml), so its md5 differs on
 *                       every save even when word/document.xml does not.
 *   claimUpdatedNotice  at most one "has been updated" per editor per file per
 *                       UPDATED_NOTICE_WINDOW_SEC while they keep editing.
 *
 * Both fail open: any doubt means "announce it", i.e. the behaviour before.
 */
const { createHash } = require("crypto");
const { readFile, stat } = require("fs").promises;
const { RedisStore } = require("@drumee/server-essentials");

// One "has been updated" per (editor, file) per this many seconds.
const UPDATED_NOTICE_WINDOW_SEC = 10 * 60;
// Above this, no fingerprint: the save is treated as a change, as before.
const MAX_BYTES = 40 * 1024 * 1024;
const ID_RE = /^[0-9a-zA-Z_-]{1,32}$/;

let JSZip;
function zipLib() {
  if (JSZip === undefined) {
    try { JSZip = require("jszip"); } catch (e) { JSZip = null; }
  }
  return JSZip;
}

// The body parts (word/*.xml) as a reader sees them. Casual stamps fresh
// paragraph/text ids and revision ids on every export, renumbers comment
// anchors, and appends one empty
// paragraph each time the document is opened (measured on drumee.in
// 2026-10-21: 2 -> 3 -> 4 paragraphs over two opens, text unchanged). Neither
// is an edit anybody should be told about, so both are left out. The price:
// adding or removing nothing but blank lines is not announced either -- the
// bytes are still saved.
const VOLATILE_ATTR_RE = /\s(?:w14:paraId|w14:textId|w:rsid[A-Za-z]*)="[^"]*"/g;
// A new comment's anchors are saved with a provisional id (-1) and renumbered
// on a later save (-1 -> 3): the comment was already announced, the
// renumbering is no edit.
const COMMENT_ANCHOR_ID_RE = /(<w:comment(?:RangeStart|RangeEnd|Reference)\b[^>]*?)\sw:id="[^"]*"/g;
const EMPTY_PARAGRAPH_RE = /<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>(?:<w:pPr>(?:(?!<\/w:pPr>)[\s\S])*<\/w:pPr>)?<\/w:p>/g;
function readable(name, xml) {
  if (!/^word\/[^/]+\.xml$/i.test(name)) return xml;
  return xml.replace(VOLATILE_ATTR_RE, "").replace(COMMENT_ANCHOR_ID_RE, "$1").replace(EMPTY_PARAGRAPH_RE, "");
}

// Every part of a .docx except docProps/ (export time, app name), hashed by
// name and readable content -- never by the zip's own metadata.
async function docxDigest(b64, hash) {
  const zip = await zipLib().loadAsync(Buffer.from(String(b64 || ""), "base64"));
  const names = Object.keys(zip.files)
    .filter((n) => !zip.files[n].dir && !/^docProps\//i.test(n))
    .sort();
  for (const n of names) {
    hash.update(`${n}\0`);
    if (/\.xml$/i.test(n)) hash.update(readable(n, await zip.file(n).async("string")));
    else hash.update(await zip.file(n).async("nodebuffer"));
    hash.update("\0");
  }
}

/**
 * @param {string} file path of the saved content
 * @param {string} ext the node's extension
 * @returns {Promise<string|null>} null when this type has no fingerprint (its
 *   md5 already is one) or the file cannot be read
 */
async function contentFingerprint(file, ext) {
  try {
    if (String(ext || "").toLowerCase() !== "udoc" || !zipLib()) return null;
    const st = await stat(file);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    const doc = JSON.parse(await readFile(file, "utf8"));
    const hash = createHash("sha256");
    // The tabs, in order, with their names: renaming or reordering a tab is
    // an edit. `active` (the tab on screen) is not.
    const tabs = Array.isArray(doc.tabs) ? doc.tabs : [];
    for (const t of tabs) {
      hash.update(`tab\0${(t && t.id) || ""}\0${(t && t.name) || ""}\0`);
      if (t && t.docx) await docxDigest(t.docx, hash);
    }
    // A single-tab file keeps its document at the top level.
    if (doc.docx) {
      hash.update("docx\0");
      await docxDigest(doc.docx, hash);
    }
    return hash.digest("hex");
  } catch (e) {
    return null;
  }
}

/**
 * True when nothing a reader can see differs between the stored file and the
 * one about to replace it. Only ever true for types with a fingerprint, and
 * only when both sides could be read.
 */
async function sameContent(oldFile, newFile, ext) {
  const [before, after] = await Promise.all([
    contentFingerprint(oldFile, ext),
    contentFingerprint(newFile, ext),
  ]);
  return !!before && before === after;
}

/**
 * May this save of `nid` by `uid` write a "has been updated" changelog row?
 * The first one in a window wins; the editor's later saves in the same window
 * stay silent. No Redis, or any error: yes, as before.
 */
async function claimUpdatedNotice(hub_id, nid, uid) {
  try {
    if (![hub_id, nid, uid].every((v) => ID_RE.test(String(v || "")))) return true;
    const client = RedisStore.getClient();
    if (!client) return true;
    const won = await client.set(`mfs:updated-notice:${hub_id}:${nid}:${uid}`, "1", {
      NX: true,
      EX: UPDATED_NOTICE_WINDOW_SEC,
    });
    return won === "OK";
  } catch (e) {
    return true;
  }
}

module.exports = {
  UPDATED_NOTICE_WINDOW_SEC,
  contentFingerprint,
  sameContent,
  claimUpdatedNotice,
};
