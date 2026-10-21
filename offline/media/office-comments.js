/**
 * @license
 * Copyright 2024 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.gnu.org/licenses/agpl-3.0.html
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

/**
 * office-comments
 *
 * Reads the comments stored INSIDE an OOXML document, so a save can tell which
 * comments are new and the file's owner can be told "<A> commented on <file>"
 * (service/lib/file-owner-notify.js). The document editor keeps comments in
 * the file itself and reports none of them to Drumee: diffing the comments of
 * the stored original against those of the bytes being saved is the only
 * place they can be seen.
 *
 *   docx  word/comments.xml            <w:comment w:author w:date> + <w:t>
 *         word/people.xml              author -> presenceInfo userId
 *   xlsx  xl/threadedComments/*.xml    <threadedComment id personId dT>
 *         xl/persons/person.xml        personId -> displayName, userId
 *         xl/comments*.xml             legacy notes: <comment ref authorId>
 *   pptx  ppt/comments/modernComment*  <p188:cm id authorId created>
 *         ppt/authors.xml              authorId -> name, userId
 *         ppt/comments/comment*.xml    legacy: <p:cm authorId dt idx>
 *         ppt/commentAuthors.xml       authorId -> name
 *
 *   udoc  Casual Docs: {tabs:[{id, docx: <base64 .docx>}]}. Read like a docx
 *         per tab, keyed by ordinal (date order). An anchor-only file (saved
 *         before the integration wrote word/comments.xml) counts each
 *         w:commentReference as a comment with no author and no text.
 *   usheet Casual Sheets (Univer snapshot): resources[name =
 *         SHEET_UNIVER_THREAD_COMMENT_PLUGIN].data, a JSON string of
 *         { <sheet id>: [ { id, personId, dT, text: { dataStream },
 *         children: [replies] } ] }. personId is the author's DISPLAY NAME.
 *
 * A comment's `key` identifies it across saves: its own id where the format
 * keeps a stable one (threaded / modern comments), else author + date + text
 * (a docx w:id is renumbered on every save). Read-only, never throws: a file
 * that cannot be read answers null, which is not the same as "no comments" --
 * comparing against it would announce every existing comment as new.
 */

const { readFile, stat } = require('fs').promises;
const JSZip = require('jszip');

// Reading a document's comments means loading the whole zip; past this size
// the comparison is skipped rather than holding two copies in memory on the
// save path.
const MAX_BYTES = 40 * 1024 * 1024;
const WORD_EXT = new Set(['docx', 'docm', 'dotx', 'dotm']);
const SHEET_EXT = new Set(['xlsx', 'xlsm', 'xltx', 'xltm']);
const SLIDE_EXT = new Set(['pptx', 'pptm', 'potx', 'potm', 'ppsx']);

function decode(s) {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#([0-9]+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

// Attributes of one start tag, by local name (namespace prefix dropped).
function attrs(tag) {
  const out = {};
  const re = /([A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(tag))) out[m[2]] = decode(m[4] != null ? m[4] : m[5]);
  return out;
}

// Every <prefix:name ...>...</prefix:name> (or self-closed) element.
function elements(xml, name) {
  const out = [];
  const re = new RegExp(`<(?:[\\w.-]+:)?${name}(\\s[^>]*?)?(/>|>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>)`, 'g');
  let m;
  while ((m = re.exec(xml))) out.push({ attrs: attrs(m[1] || ''), body: m[3] || '' });
  return out;
}

// The visible text of a fragment: its <w:t> / <a:t> / <t> runs, in order;
// formats that hold plain text in a <text> element (threaded comments, legacy
// slide comments) have no runs, so their markup is stripped instead.
function textOf(body) {
  const parts = [];
  const re = /<(?:[\w.-]+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?t>/g;
  let m;
  while ((m = re.exec(body))) parts.push(decode(m[1]));
  const text = parts.length ? parts.join('') : decode(String(body || '').replace(/<[^>]*>/g, ''));
  return text.replace(/\s+/g, ' ').trim();
}

async function part(zip, name) {
  const entry = zip.file(name);
  return entry ? entry.async('string') : '';
}

async function parts(zip, re) {
  const names = Object.keys(zip.files).filter((n) => re.test(n)).sort();
  return Promise.all(names.map((n) => zip.file(n).async('string')));
}

function comment(key, author, text, extra = {}) {
  return { key, author: author || '', text: text || '', userId: extra.userId || null, date: extra.date || null };
}

async function wordComments(zip) {
  const people = {};
  for (const p of elements(await part(zip, 'word/people.xml'), 'person')) {
    const info = elements(p.body, 'presenceInfo')[0];
    if (p.attrs.author && info && info.attrs.userId) people[p.attrs.author] = info.attrs.userId;
  }
  return elements(await part(zip, 'word/comments.xml'), 'comment').map((c) => {
    const author = c.attrs.author || '';
    const text = textOf(c.body);
    return comment(`${author}|${c.attrs.date || ''}|${text}`, author, text, {
      userId: people[author], date: c.attrs.date,
    });
  });
}

async function sheetComments(zip) {
  const out = [];
  const persons = {};
  for (const xml of await parts(zip, /^xl\/persons\/[^/]+\.xml$/)) {
    for (const p of elements(xml, 'person')) persons[p.attrs.id] = p.attrs;
  }
  const threaded = new Set();
  for (const xml of await parts(zip, /^xl\/threadedComments\/[^/]+\.xml$/)) {
    for (const c of elements(xml, 'threadedComment')) {
      const who = persons[c.attrs.personId] || {};
      const text = textOf(c.body);
      threaded.add(`${c.attrs.ref || ''}|${text}`);
      out.push(comment(`t:${c.attrs.id || `${c.attrs.ref}|${c.attrs.dT}|${text}`}`, who.displayName, text, {
        userId: who.userId, date: c.attrs.dT,
      }));
    }
  }
  for (const xml of await parts(zip, /^xl\/comments[^/]*\.xml$/)) {
    const authors = elements((elements(xml, 'authors')[0] || {}).body || '', 'author').map((a) => textOf(`<t>${a.body}</t>`));
    for (const c of elements(xml, 'comment')) {
      const author = authors[parseInt(c.attrs.authorId, 10)] || '';
      const text = textOf(c.body);
      // A threaded comment is also written as a legacy note for older
      // readers; count it once.
      if (threaded.size && [...threaded].some((t) => t.startsWith(`${c.attrs.ref || ''}|`))) continue;
      out.push(comment(`n:${author}|${c.attrs.ref || ''}|${text}`, author, text));
    }
  }
  return out;
}

async function slideComments(zip) {
  const out = [];
  const authors = {};
  for (const a of elements(await part(zip, 'ppt/authors.xml'), 'author')) authors[a.attrs.id] = a.attrs;
  for (const xml of await parts(zip, /^ppt\/comments\/modernComment[^/]*\.xml$/)) {
    for (const c of elements(xml, 'cm')) {
      const who = authors[c.attrs.authorId] || {};
      const text = textOf(c.body.replace(/<(?:[\w.-]+:)?replyLst[\s\S]*?<\/(?:[\w.-]+:)?replyLst>/g, ''));
      out.push(comment(`m:${c.attrs.id || `${c.attrs.created}|${text}`}`, who.name, text, {
        userId: who.userId, date: c.attrs.created,
      }));
      // Replies sit inside their comment, each with its own id.
      for (const r of elements(c.body, 'reply')) {
        const rw = authors[r.attrs.authorId] || {};
        const rt = textOf(r.body);
        out.push(comment(`m:${r.attrs.id || `${r.attrs.created}|${rt}`}`, rw.name, rt, {
          userId: rw.userId, date: r.attrs.created,
        }));
      }
    }
  }
  const legacy = {};
  for (const a of elements(await part(zip, 'ppt/commentAuthors.xml'), 'cmAuthor')) legacy[a.attrs.id] = a.attrs.name;
  for (const xml of await parts(zip, /^ppt\/comments\/comment[^/]*\.xml$/)) {
    for (const c of elements(xml, 'cm')) {
      const author = legacy[c.attrs.authorId] || '';
      const text = textOf(c.body);
      out.push(comment(`l:${author}|${c.attrs.dt || ''}|${text}`, author, text, { date: c.attrs.dt }));
    }
  }
  return out;
}

const UNIVER_COMMENTS = 'SHEET_UNIVER_THREAD_COMMENT_PLUGIN';

async function casualDocComments(json) {
  const out = [];
  const tabs = Array.isArray(json.tabs) && json.tabs.length
    ? json.tabs
    // a single-document file keeps it at the top level only
    : [{ id: '', docx: json.docx }];
  for (const t of tabs) {
    if (!t || !t.docx) continue;
    const zip = await JSZip.loadAsync(Buffer.from(String(t.docx), 'base64'));
    const tab = String(t.id || '');
    // Keyed by ORDINAL within the tab, oldest first, whichever way the
    // comments are stored: one more comment than before is one new comment
    // (the newest). The integration now writes word/comments.xml (author,
    // date, text); files saved before it carry only the anchors, whose ids
    // Casual renumbers between saves (-1 became 2 on drumee.in). The same
    // keys on both sides keep the first save that adds comments.xml to an
    // anchor-only file from announcing every old comment as new.
    let list;
    if (zip.file('word/comments.xml')) {
      list = (await wordComments(zip))
        .map((c, i) => ({ c, i }))
        .sort((a, b) => String(a.c.date || '').localeCompare(String(b.c.date || '')) || a.i - b.i)
        .map(({ c }) => c);
    } else {
      const body = await part(zip, 'word/document.xml');
      list = elements(body, 'commentReference').map(() => comment('', '', ''));
    }
    list.forEach((c, i) => out.push({ ...c, key: `a:${tab}:#${i + 1}` }));
  }
  return out;
}

function univerText(t) {
  return String((t && t.dataStream) || '').replace(/[\r\n]+$/, '').replace(/\s+/g, ' ').trim();
}

function casualSheetComments(json) {
  const out = [];
  const res = (Array.isArray(json.resources) ? json.resources : []).find((r) => r && r.name === UNIVER_COMMENTS);
  if (!res || !res.data) return out;
  const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  const add = (c) => {
    if (!c || !c.id) return;
    out.push(comment(`u:${c.id}`, String(c.personId || ''), univerText(c.text), { date: c.dT }));
    for (const r of Array.isArray(c.children) ? c.children : []) add(r);
  };
  for (const list of Object.values(data || {})) {
    for (const c of Array.isArray(list) ? list : []) add(c);
  }
  return out;
}

/**
 * The comments stored in the document at `file`.
 * @param {string} file path of the document
 * @param {string} ext its extension, which decides the format
 * @returns {Promise<Array<{key, author, text, userId, date}>|null>} [] for a
 *   readable document without comments; null when it cannot be read (missing,
 *   not a zip, too large) or is not an office document
 */
async function readComments(file, ext) {
  try {
    const e = String(ext || '').toLowerCase();
    const casual = e === 'udoc' || e === 'usheet';
    if (!casual && !WORD_EXT.has(e) && !SHEET_EXT.has(e) && !SLIDE_EXT.has(e)) return null;
    const st = await stat(file);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    if (casual) {
      const json = JSON.parse(await readFile(file, 'utf8'));
      return e === 'udoc' ? await casualDocComments(json) : casualSheetComments(json);
    }
    const zip = await JSZip.loadAsync(await readFile(file));
    if (WORD_EXT.has(e)) return await wordComments(zip);
    if (SHEET_EXT.has(e)) return await sheetComments(zip);
    return await slideComments(zip);
  } catch (err) {
    return null;
  }
}

/**
 * The comments of `after` that `before` did not have. A comment edited in
 * place reads as new (its text is part of its key where the format keeps no
 * id); a deleted one is simply absent. Either side unreadable (null): nothing
 * can be told apart, so nothing is new.
 */
function newComments(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after)) return [];
  const seen = new Map();
  for (const c of before || []) seen.set(c.key, (seen.get(c.key) || 0) + 1);
  const out = [];
  for (const c of after || []) {
    const n = seen.get(c.key) || 0;
    if (n > 0) seen.set(c.key, n - 1);
    else out.push(c);
  }
  return out;
}

/**
 * Which session participant wrote comment `c`, or null when it cannot be told
 * for sure. A wrong name in a notification is worse than none, so a guess is
 * never made.
 *
 * The editor is opened with editorConfig.user = { id: <uid>, name: <fullname> }
 * and writes that user onto the comments it creates: the id where the format
 * keeps one (it may carry a per-connection suffix), always the name.
 *   1. the stored userId names a participant (exactly, or as its prefix);
 *   2. else the author name matches exactly one participant's name.
 * @param {Object} c a comment from readComments
 * @param {Array<{id: string, name: string}>} participants
 */
function attributeComment(c, participants) {
  const list = (participants || []).filter((p) => p && p.id);
  if (c && c.userId) {
    const uid = String(c.userId);
    const exact = list.find((p) => String(p.id) === uid);
    if (exact) return String(exact.id);
    const prefixed = list.filter((p) => uid.startsWith(String(p.id)) && /^\d*$/.test(uid.slice(String(p.id).length)));
    if (prefixed.length === 1) return String(prefixed[0].id);
  }
  const name = String((c && c.author) || '').trim().toLowerCase();
  if (!name) return null;
  const byName = [...new Set(list
    .filter((p) => String(p.name || '').trim().toLowerCase() === name)
    .map((p) => String(p.id)))];
  return byName.length === 1 ? byName[0] : null;
}

function isOfficeDocument(ext) {
  const e = String(ext || '').toLowerCase();
  return WORD_EXT.has(e) || SHEET_EXT.has(e) || SLIDE_EXT.has(e);
}

module.exports = { readComments, newComments, attributeComment, isOfficeDocument };
