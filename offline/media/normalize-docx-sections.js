#!/usr/bin/env node

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
 * normalize-docx-sections
 *
 * LibreOffice (soffice) renders our office-doc previews faithfully, which means
 * it CLIPS content that is wider than the page: a common authoring mistake is
 * placing landscape-width tables or full-bleed images inside a PORTRAIT section.
 * Word/WPS mask this, so authors do not notice; the soffice PDF preview cuts the
 * right-hand side off and can spill it onto extra pages.
 *
 * This module rewrites the .docx so any portrait section whose widest table or
 * inline image overflows the printable width is switched to landscape (and, if
 * the content is wider than even the landscape printable area, its left/right
 * margins are trimmed to make it fit). Only page geometry is touched; content is
 * untouched. Intended to run on a throwaway copy just before conversion — never
 * on the user's stored original.
 *
 * OOXML wordprocessing only (docx/docm/dotx/dotm). Other formats pass through.
 */

const { readFile, writeFile } = require('fs').promises;
const JSZip = require('jszip');

const EMU_PER_TWIP = 635;              // 914400 EMU/in ÷ 1440 twips/in
const MIN_SIDE_MARGIN = 360;           // 0.25in floor when trimming to fit
const FIT_PAD = 60;                    // small slack so content clears the edge

const WORDPROCESSING_EXT = new Set(['docx', 'docm', 'dotx', 'dotm']);

function isWordprocessing(nameOrExt) {
  const ext = String(nameOrExt || '').toLowerCase().split('.').pop();
  return WORDPROCESSING_EXT.has(ext);
}

const int = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };

/**
 * Minimal, self-contained XML tag walker (avoids pulling in an XML parser).
 * Emits open/close events in document order; self-closing tags fire both.
 * Safe for OOXML: element text and attribute values escape `<`/`>` as entities,
 * so `<[^>]+>` never splits inside a value. Comments are stripped first.
 */
function walkTags(xml, onOpen, onClose) {
  const clean = xml.replace(/<!--[\s\S]*?-->/g, '');
  const tagRe = /<[^>]+>/g;
  const attrRe = /([\w:.\-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = tagRe.exec(clean))) {
    const tag = m[0];
    const c1 = tag[1];
    if (c1 === '!' || c1 === '?') continue;             // declarations / PIs
    const nameMatch = /^<\/?\s*([A-Za-z_][\w:.\-]*)/.exec(tag);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    if (c1 === '/') { onClose(name); continue; }
    const attribs = {};
    let a;
    attrRe.lastIndex = 0;
    while ((a = attrRe.exec(tag))) attribs[a[1]] = a[2];
    onOpen(name, attribs);
    if (tag[tag.length - 2] === '/') onClose(name);     // self-closing
  }
}

/**
 * Parse word/document.xml into ordered sections, each with page geometry and the
 * widest table (twips) / image (EMU) it contains.
 *
 * OOXML orders a paragraph's <w:pPr> (which may carry the section-terminating
 * <w:sectPr>) BEFORE that paragraph's runs. So content that visually belongs to
 * a section can appear AFTER its own sectPr in the byte stream — character
 * position is not a safe way to bucket content. We instead walk the tag stream
 * (walkTags) with a nesting stack and attribute all content up to and including
 * the section-terminating paragraph to that section, matching Word's model.
 *
 * Only the OUTER table's grid contributes width (nested tables live inside a
 * cell and can never widen the page).
 */
function parseSections(xml) {
  const sections = [];
  let secMaxTw = 0, secMaxEmu = 0;     // accumulators for the currently-open section
  let tblDepth = 0;                    // 1 == outermost table
  let curGrid = null;                  // gridCol sum while inside an outer <w:tblGrid>
  let pendingGeom = null;              // geometry read from the current/last sectPr
  let sectParaDepth = -1;              // stack depth of the <w:p> that owns a paragraph sectPr
  let sectIsBodyLevel = false;
  const stack = [];

  const finalize = (geom) => {
    if (!geom || geom.w == null) return;
    const orient = geom.orient || (geom.w > geom.h ? 'landscape' : 'portrait');
    sections.push({
      index: sections.length,
      w: geom.w, h: geom.h, orient,
      left: geom.left || 0, right: geom.right || 0,
      contentTw: Math.max(secMaxTw, Math.round(secMaxEmu / EMU_PER_TWIP)),
    });
    secMaxTw = 0; secMaxEmu = 0;
  };

  walkTags(xml,
    function onOpen(name, attribs) {
      stack.push(name);
      if (name === 'w:tbl') tblDepth++;
      else if (name === 'w:tblGrid' && tblDepth === 1) curGrid = 0;
      else if (name === 'w:gridCol' && curGrid !== null) curGrid += int(attribs['w:w']);
      else if (name === 'wp:extent') secMaxEmu = Math.max(secMaxEmu, int(attribs['cx']));
      else if (name === 'w:sectPr') {
        pendingGeom = {};
        sectIsBodyLevel = stack[stack.length - 2] === 'w:body';
        sectParaDepth = sectIsBodyLevel ? -1 : stack.lastIndexOf('w:p');
      } else if (name === 'w:pgSz' && pendingGeom) {
        pendingGeom.w = int(attribs['w:w']); pendingGeom.h = int(attribs['w:h']);
        pendingGeom.orient = attribs['w:orient'] || null;
      } else if (name === 'w:pgMar' && pendingGeom) {
        pendingGeom.left = int(attribs['w:left']); pendingGeom.right = int(attribs['w:right']);
      }
    },
    function onClose(name) {
      if (name === 'w:tblGrid' && curGrid !== null) { secMaxTw = Math.max(secMaxTw, curGrid); curGrid = null; }
      else if (name === 'w:tbl') tblDepth--;
      else if (name === 'w:sectPr' && sectIsBodyLevel) { finalize(pendingGeom); pendingGeom = null; }
      else if (name === 'w:p' && pendingGeom && !sectIsBodyLevel && stack.length - 1 === sectParaDepth) {
        // the paragraph owning this sectPr just ended: everything up to and
        // including its trailing runs belongs to this section.
        finalize(pendingGeom); pendingGeom = null;
      }
      stack.pop();
    });
  return sections;
}

// The <w:sectPr>...</w:sectPr> blocks in document order (== section order).
function sectPrBlocks(xml) {
  const out = [];
  const re = /<w:sectPr\b[^>]*>[\s\S]*?<\/w:sectPr>|<w:sectPr\b[^>]*\/>/g;
  let m;
  while ((m = re.exec(xml))) out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  return out;
}

const printableTw = (pageW, left, right) => pageW - left - right;

function landscapePgSz(pgSzText, w, h) {
  const W = Math.max(w, h), H = Math.min(w, h);
  let out = pgSzText
    .replace(/w:w="\d+"/, `w:w="${W}"`)
    .replace(/w:h="\d+"/, `w:h="${H}"`);
  out = /w:orient="/.test(out)
    ? out.replace(/w:orient="\w+"/, 'w:orient="landscape"')
    : out.replace(/\/>$/, ' w:orient="landscape"/>');
  return out;
}

function trimmedPgMar(pgMarText, pageW, contentTw) {
  // symmetric side margins so printable >= content (+pad), floored at MIN_SIDE_MARGIN
  let side = Math.floor((pageW - contentTw - FIT_PAD) / 2);
  if (side < MIN_SIDE_MARGIN) side = MIN_SIDE_MARGIN;
  return pgMarText
    .replace(/w:left="\d+"/, `w:left="${side}"`)
    .replace(/w:right="\d+"/, `w:right="${side}"`);
}

/**
 * @returns {Promise<{changed:boolean, sections:number[]}>}
 *   `sections` = 1-based indices that were rewritten.
 */
async function normalizeWideSections(inputPath, outputPath) {
  const buf = await readFile(inputPath);
  const zip = await JSZip.loadAsync(buf);
  const entry = zip.file('word/document.xml');
  if (!entry) { // not a wordprocessing doc we understand
    if (outputPath !== inputPath) await writeFile(outputPath, buf);
    return { changed: false, sections: [] };
  }

  const xml = await entry.async('string');
  const sections = parseSections(xml);
  const blocks = sectPrBlocks(xml);

  // Detection (structural) tells us which sections overflow; editing rewrites the
  // matching sectPr block. Both lists are in document order, so they align 1:1.
  const edits = [];
  const fixed = [];
  for (const s of sections) {
    const block = blocks[s.index];
    if (!block) continue;
    if (s.orient === 'portrait' && s.contentTw > printableTw(s.w, s.left, s.right)) {
      const landW = Math.max(s.w, s.h);
      let text = block.text.replace(/<w:pgSz\b[^>]*\/>/, (t) => landscapePgSz(t, s.w, s.h));
      if (s.contentTw > printableTw(landW, s.left, s.right)) {
        text = text.replace(/<w:pgMar\b[^>]*\/>/, (t) => trimmedPgMar(t, landW, s.contentTw));
      }
      edits.push({ span: [block.start, block.end], text });
      fixed.push(s.index + 1);
    }
  }

  if (!edits.length) {
    if (outputPath !== inputPath) await writeFile(outputPath, buf);
    return { changed: false, sections: [] };
  }

  let out = xml;
  for (const e of edits.sort((a, b) => b.span[0] - a.span[0])) {
    out = out.slice(0, e.span[0]) + e.text + out.slice(e.span[1]);
  }

  zip.file('word/document.xml', out);
  const result = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await writeFile(outputPath, result);
  return { changed: true, sections: fixed };
}

module.exports = { normalizeWideSections, isWordprocessing };
