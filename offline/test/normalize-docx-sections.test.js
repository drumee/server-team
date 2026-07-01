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
 * Tests for normalize-docx-sections: rewrites portrait sections whose content
 * (tables / inline images) is wider than the printable area into landscape,
 * so the server-side soffice -> PDF preview stops clipping wide content.
 *
 * Standalone runner (no test framework in this repo): `node <thisfile>`.
 * Exits 0 on success, 1 on first failure.
 */

const assert = require('assert');
const os = require('os');
const { join } = require('path');
const { writeFileSync, readFileSync, mkdtempSync } = require('fs');
const JSZip = require('jszip');

const { normalizeWideSections } = require('../media/normalize-docx-sections');

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

// ---- synthetic docx builders -----------------------------------------------

// A table whose grid columns sum to `widthTw` twips.
function tableXml(widthTw) {
  return `<w:tbl><w:tblGrid><w:gridCol w:w="${widthTw}"/></w:tblGrid>` +
    `<w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`;
}

// An inline image (as a standalone paragraph) whose extent cx is `cxEmu` EMUs.
function imageXml(cxEmu) {
  return `<w:p>${imageRun(cxEmu)}</w:p>`;
}

// Just the run carrying an inline image — for placing trailing content inside a
// section-terminating paragraph (after its pPr/sectPr, like real Word output).
function imageRun(cxEmu) {
  return `<w:r><w:drawing><wp:inline><wp:extent cx="${cxEmu}" cy="1000000"/>` +
    `<a:graphic/></wp:inline></w:drawing></w:r>`;
}

// A table nested one level deep inside a cell of an outer table.
function nestedTableXml(outerTw, innerTw) {
  return `<w:tbl><w:tblGrid><w:gridCol w:w="${outerTw}"/></w:tblGrid>` +
    `<w:tr><w:tc>${tableXml(innerTw)}</w:tc></w:tr></w:tbl>`;
}

function sectPr({ w, h, orient, left = 1440, right = 1440 }) {
  return `<w:sectPr><w:pgSz w:w="${w}" w:h="${h}" w:orient="${orient}"/>` +
    `<w:pgMar w:top="1440" w:right="${right}" w:bottom="1440" w:left="${left}"/></w:sectPr>`;
}

// sections: array of { pg:{w,h,orient,left,right}, body:"<xml>", last:bool }
// A non-last section closes with a paragraph carrying its sectPr;
// the last section carries a body-level sectPr.
function buildDocumentXml(sections) {
  let body = '';
  for (const s of sections) {
    body += s.body || '';
    if (s.last) {
      body += sectPr(s.pg);
    } else {
      // `trailing` goes AFTER pPr/sectPr but inside the same paragraph, exactly
      // like a run following a section break in real Word output.
      body += `<w:p><w:pPr>${sectPr(s.pg)}</w:pPr>${s.trailing || ''}</w:p>`;
    }
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="${W}" xmlns:wp="${WP}" xmlns:a="${A}" xmlns:r="${R}">` +
    `<w:body>${body}</w:body></w:document>`;
}

async function makeDocx(path, sections, extra = {}) {
  const zip = new JSZip();
  // a marker entry we assert survives the round-trip untouched
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('word/document.xml', buildDocumentXml(sections));
  if (extra.files) for (const [k, v] of Object.entries(extra.files)) zip.file(k, v);
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  writeFileSync(path, buf);
}

// Read back the pgSz per section (document order) from an output docx.
async function readSections(path) {
  const zip = await JSZip.loadAsync(readFileSync(path));
  const xml = await zip.file('word/document.xml').async('string');
  const out = [];
  const re = /<w:pgSz\b[^>]*\/>/g;
  const mre = /<w:pgMar\b[^>]*\/>/g;
  let m;
  const pgsz = [];
  while ((m = re.exec(xml))) pgsz.push(m[0]);
  const pgmar = [];
  while ((m = mre.exec(xml))) pgmar.push(m[0]);
  for (let i = 0; i < pgsz.length; i++) {
    const w = +(/w:w="(\d+)"/.exec(pgsz[i]) || [])[1];
    const h = +(/w:h="(\d+)"/.exec(pgsz[i]) || [])[1];
    const orient = (/w:orient="(\w+)"/.exec(pgsz[i]) || [])[1];
    const left = +(/w:left="(\d+)"/.exec(pgmar[i]) || [])[1];
    const right = +(/w:right="(\d+)"/.exec(pgmar[i]) || [])[1];
    out.push({ w, h, orient, left, right });
  }
  return { sections: out, zip };
}

// A4 portrait / landscape in twips
const P = { w: 11909, h: 16834, orient: 'portrait' };
const L = { w: 16834, h: 11909, orient: 'landscape' };

// ---- tests -----------------------------------------------------------------

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('portrait section with a table wider than portrait printable becomes landscape', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'nds-'));
  const src = join(dir, 'in.docx'), dst = join(dir, 'out.docx');
  // portrait printable = 11909-2880 = 9029tw; table 13000tw overflows portrait, fits landscape (13954tw)
  await makeDocx(src, [
    { pg: { ...P }, body: tableXml(13000) },
    { pg: { ...P }, body: tableXml(5000), last: true },
  ]);
  const res = await normalizeWideSections(src, dst);
  assert.strictEqual(res.changed, true, 'should report changed');
  const { sections } = await readSections(dst);
  assert.strictEqual(sections[0].orient, 'landscape', 'section 1 flipped to landscape');
  assert.ok(sections[0].w > sections[0].h, 'section 1 page is landscape (w>h)');
  assert.strictEqual(sections[1].orient, 'portrait', 'section 2 left portrait (fits)');
});

test('portrait section whose content fits is left unchanged (changed=false)', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'nds-'));
  const src = join(dir, 'in.docx'), dst = join(dir, 'out.docx');
  await makeDocx(src, [
    { pg: { ...P }, body: tableXml(4000) },
    { pg: { ...P }, body: tableXml(5000), last: true },
  ]);
  const res = await normalizeWideSections(src, dst);
  assert.strictEqual(res.changed, false, 'nothing to change');
  const { sections } = await readSections(dst);
  assert.strictEqual(sections[0].orient, 'portrait');
  assert.strictEqual(sections[1].orient, 'portrait');
});

test('inline image wider than portrait printable triggers a landscape flip', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'nds-'));
  const src = join(dir, 'in.docx'), dst = join(dir, 'out.docx');
  // portrait printable EMU = 9029*635 = 5,733,415; image 8,000,000 overflows, < landscape 8,860,790
  await makeDocx(src, [
    { pg: { ...P }, body: imageXml(8000000), last: true },
  ]);
  const res = await normalizeWideSections(src, dst);
  assert.strictEqual(res.changed, true);
  const { sections } = await readSections(dst);
  assert.strictEqual(sections[0].orient, 'landscape');
});

test('content wider than even landscape printable also gets its L/R margins trimmed', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'nds-'));
  const src = join(dir, 'in.docx'), dst = join(dir, 'out.docx');
  // table 15000tw > landscape printable 13954tw. After flip, margins must shrink so it fits.
  await makeDocx(src, [
    { pg: { ...P }, body: tableXml(15000), last: true },
  ]);
  const res = await normalizeWideSections(src, dst);
  assert.strictEqual(res.changed, true);
  const { sections } = await readSections(dst);
  const s = sections[0];
  assert.strictEqual(s.orient, 'landscape');
  const printable = s.w - s.left - s.right;
  assert.ok(printable >= 15000, `landscape printable ${printable}tw must fit 15000tw table`);
});

test('wide image in a run AFTER the sectPr (same paragraph) is attributed to THAT section', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'nds-'));
  const src = join(dir, 'in.docx'), dst = join(dir, 'out.docx');
  // Section 1 closes with a paragraph whose pPr holds the sectPr, then a wide
  // image run follows in the SAME paragraph. That image belongs to section 1.
  // Section 2 is narrow and must stay portrait.
  await makeDocx(src, [
    { pg: { ...P }, trailing: imageRun(8000000) },
    { pg: { ...P }, body: tableXml(4000), last: true },
  ]);
  const res = await normalizeWideSections(src, dst);
  const { sections } = await readSections(dst);
  assert.strictEqual(sections[0].orient, 'landscape', 'section 1 (owns the image) flips');
  assert.strictEqual(sections[1].orient, 'portrait', 'section 2 (narrow) must NOT flip');
  assert.deepStrictEqual(res.sections, [1], 'only section 1 rewritten');
});

test('a narrow outer table containing a nested table is not miscounted as overflow', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'nds-'));
  const src = join(dir, 'in.docx'), dst = join(dir, 'out.docx');
  // outer grid 4000tw (fits portrait). Naive regex slicing double-counts / mixes
  // the inner grid and can wrongly flag overflow.
  await makeDocx(src, [
    { pg: { ...P }, body: nestedTableXml(4000, 3000), last: true },
  ]);
  const res = await normalizeWideSections(src, dst);
  assert.strictEqual(res.changed, false, 'nested-table doc fits portrait, no flip');
  const { sections } = await readSections(dst);
  assert.strictEqual(sections[0].orient, 'portrait');
});

test('an already-landscape overflowing section is not flipped back to portrait', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'nds-'));
  const src = join(dir, 'in.docx'), dst = join(dir, 'out.docx');
  await makeDocx(src, [
    { pg: { ...L }, body: tableXml(5000), last: true },
  ]);
  const res = await normalizeWideSections(src, dst);
  assert.strictEqual(res.changed, false);
  const { sections } = await readSections(dst);
  assert.strictEqual(sections[0].orient, 'landscape');
});

test('non-document.xml zip entries survive the round-trip', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'nds-'));
  const src = join(dir, 'in.docx'), dst = join(dir, 'out.docx');
  await makeDocx(src, [{ pg: { ...P }, body: tableXml(13000), last: true }]);
  await normalizeWideSections(src, dst);
  const zip = await JSZip.loadAsync(readFileSync(dst));
  assert.ok(zip.file('[Content_Types].xml'), '[Content_Types].xml preserved');
  assert.strictEqual(await zip.file('[Content_Types].xml').async('string'), '<Types/>');
});

// ---- runner ----------------------------------------------------------------

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok  - ${name}`);
    } catch (e) {
      failed++;
      console.error(`  FAIL - ${name}`);
      console.error(`         ${e && e.message}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
