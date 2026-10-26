#!/usr/bin/env node
//
// edit-save-signal.test.js — whether an editor save is NEWS
// (service/lib/edit-save-signal.js): a Casual Docs autosave that re-zips an
// unchanged .docx is not; one "has been updated" per editor per file per window.
//
//   node --test offline/test/edit-save-signal.test.js
//
// @drumee/server-essentials is stubbed (RedisStore only); fixtures are built
// with jszip, like normalize-docx-sections.test.

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const { join } = require('path');
const { writeFileSync, mkdtempSync } = require('fs');
const Module = require('module');
const JSZip = require('jszip');

let redis = null;
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === '@drumee/server-essentials') return { RedisStore: { getClient: () => redis } };
  return realLoad.call(this, request, ...rest);
};
const S = require('../../service/lib/edit-save-signal');
Module._load = realLoad;

const dir = mkdtempSync(join(os.tmpdir(), 'edit-save-signal-'));
let n = 0;

// A .docx as Casual exports it: the body, and docProps/core.xml stamped with
// the export time. `date` sets the zip entries' own timestamps.
async function docx(body, { exported = '2026-10-21T04:17:31Z', date = new Date('2026-10-21T04:17:31Z'), paraId = '28F5C6A4', tail = '' } = {}) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>', { date });
  zip.file('word/document.xml', `<w:document><w:body><w:p w14:paraId="${paraId}" w:rsidR="00A1"><w:r><w:t>${body}</w:t></w:r></w:p>${tail}<w:sectPr/></w:body></w:document>`, { date });
  zip.file('docProps/core.xml', `<cp:coreProperties><dcterms:modified>${exported}</dcterms:modified></cp:coreProperties>`, { date });
  return (await zip.generateAsync({ type: 'nodebuffer' })).toString('base64');
}

function udoc(json) {
  const path = join(dir, `f${n++}.udoc`);
  writeFileSync(path, JSON.stringify(json));
  return path;
}

test('a re-zipped, re-stamped but unchanged doc is the same content', async () => {
  const a = await docx('hi', { exported: '2026-10-21T04:17:31Z', date: new Date('2026-10-21T04:17:31Z') });
  const b = await docx('hi', { exported: '2026-10-21T04:17:32Z', date: new Date('2026-10-21T04:17:32Z') });
  assert.notStrictEqual(a, b, 'the bytes do differ, as on drumee.in');
  const tab = (docxB64) => ({ docx: docxB64, tabs: [{ id: 't1', name: 'Tab 1', docx: docxB64, primary: 1 }], active: 't1' });
  assert.strictEqual(await S.sameContent(udoc(tab(a)), udoc(tab(b)), 'udoc'), true);
  // switching the tab on screen is not an edit
  assert.strictEqual(await S.sameContent(udoc(tab(a)), udoc({ ...tab(b), active: 't2' }), 'udoc'), true);
});

test('fresh paragraph ids and the empty paragraph Casual appends on open are not an edit', async () => {
  const a = await docx('hi');
  const b = await docx('hi', { paraId: 'BB4A58A0', tail: '<w:p w14:paraId="C1"></w:p><w:p w14:paraId="C2"><w:pPr><w:jc w:val="left"/></w:pPr></w:p><w:p/>' });
  const one = (x) => ({ docx: x, tabs: [{ id: 't1', name: 'Tab 1', docx: x }], active: 't1' });
  assert.strictEqual(await S.sameContent(udoc(one(a)), udoc(one(b)), 'udoc'), true);
  // a paragraph that holds something is content
  const c = await docx('hi', { tail: '<w:p><w:r><w:t>more</w:t></w:r></w:p>' });
  assert.strictEqual(await S.sameContent(udoc(one(a)), udoc(one(c)), 'udoc'), false);
  const img = await docx('hi', { tail: '<w:p><w:r><w:drawing/></w:r></w:p>' });
  assert.strictEqual(await S.sameContent(udoc(one(a)), udoc(one(img)), 'udoc'), false);
});

test('renumbering a comment anchor (-1 -> 3) is no edit; adding one is', async () => {
  const anchor = (id) => `<w:p><w:commentRangeStart w:id="${id}"/><w:r><w:t>x</w:t></w:r><w:commentRangeEnd w:id="${id}"/><w:r><w:commentReference w:id="${id}"/></w:r></w:p>`;
  const one = (x) => ({ docx: x, tabs: [{ id: 't1', name: 'Tab 1', docx: x }], active: 't1' });
  const provisional = await docx('hi', { tail: anchor('-1') });
  const renumbered = await docx('hi', { tail: anchor('3') });
  const none = await docx('hi', { tail: '<w:p><w:r><w:t>x</w:t></w:r></w:p>' });
  assert.strictEqual(await S.sameContent(udoc(one(provisional)), udoc(one(renumbered)), 'udoc'), true);
  assert.strictEqual(await S.sameContent(udoc(one(none)), udoc(one(provisional)), 'udoc'), false);
});

test('comment parts re-exported with fresh random paraId / durableId are the same content', async () => {
  const parts = (pid, did) => ({
    'word/comments.xml': `<w:comments><w:comment w:id="1000001" w:author="Ann" w:date="2026-10-21T06:00:00Z"><w:p w14:paraId="${pid}"><w:r><w:t>c1</w:t></w:r></w:p></w:comment></w:comments>`,
    'word/commentsExtended.xml': `<w15:commentsEx><w15:commentEx w15:paraId="${pid}" w15:done="0"/></w15:commentsEx>`,
    'word/commentsIds.xml': `<w16cid:commentsIds><w16cid:commentId w16cid:paraId="${pid}" w16cid:durableId="${did}"/></w16cid:commentsIds>`,
    'word/commentsExtensible.xml': `<w16cex:commentsExtensible><w16cex:commentExtensible w16cex:durableId="${did}" w16cex:dateUtc="2026-10-21T06:00:00Z"/></w16cex:commentsExtensible>`,
  });
  const build = async (pid, did, text = 'c1') => {
    const zip = new JSZip();
    zip.file('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>hi</w:t></w:r></w:p></w:body></w:document>');
    for (const [k, v] of Object.entries(parts(pid, did))) zip.file(k, v.replace('>c1<', `>${text}<`));
    const b64 = (await zip.generateAsync({ type: 'nodebuffer' })).toString('base64');
    return udoc({ tabs: [{ id: 't1', name: 'Tab 1', docx: b64 }] });
  };
  assert.strictEqual(await S.sameContent(await build('EBE07CCA', '19B946F6'), await build('D2D5C47C', '7FDB5614'), 'udoc'), true);
  // the comment's text is content
  assert.strictEqual(await S.sameContent(await build('EBE07CCA', '19B946F6'), await build('D2D5C47C', '7FDB5614', 'c2'), 'udoc'), false);
});

test('a real edit, a renamed tab or a new tab is a change', async () => {
  const a = await docx('hi');
  const b = await docx('hi there');
  const one = (x, name = 'Tab 1') => ({ docx: x, tabs: [{ id: 't1', name, docx: x }], active: 't1' });
  assert.strictEqual(await S.sameContent(udoc(one(a)), udoc(one(b)), 'udoc'), false);
  assert.strictEqual(await S.sameContent(udoc(one(a)), udoc(one(a, 'Budget')), 'udoc'), false);
  const two = { docx: a, tabs: [{ id: 't1', name: 'Tab 1', docx: a }, { id: 't2', name: 'Tab 2', docx: a }], active: 't1' };
  assert.strictEqual(await S.sameContent(udoc(one(a)), udoc(two), 'udoc'), false);
});

test('anything else, or anything unreadable, is never "the same" (fail open)', async () => {
  const a = await docx('hi');
  const f = udoc({ docx: a, tabs: [] });
  assert.strictEqual(await S.contentFingerprint(f, 'txt'), null, 'other types keep the md5 rule');
  assert.strictEqual(await S.sameContent(f, f, 'usheet'), false);
  assert.strictEqual(await S.sameContent(join(dir, 'missing.udoc'), f, 'udoc'), false);
  const bad = join(dir, 'bad.udoc');
  writeFileSync(bad, 'not json');
  assert.strictEqual(await S.sameContent(bad, bad, 'udoc'), false);
});

test('one "has been updated" per editor per file per window', async () => {
  const keys = new Map();
  redis = {
    set: async (k, v, o) => {
      assert.deepStrictEqual(o, { NX: true, EX: S.UPDATED_NOTICE_WINDOW_SEC });
      if (keys.has(k)) return null;
      keys.set(k, v);
      return 'OK';
    },
  };
  const H = 'hub0000000000001', N = 'nid0000000000001', A = 'aaaa000000000001', B = 'bbbb000000000001';
  assert.strictEqual(await S.claimUpdatedNotice(H, N, A), true);
  assert.strictEqual(await S.claimUpdatedNotice(H, N, A), false, 'same editor, same file, inside the window');
  assert.strictEqual(await S.claimUpdatedNotice(H, N, B), true, 'another editor has their own');
  assert.strictEqual(await S.claimUpdatedNotice(H, 'nid0000000000002', A), true, 'another file has its own');
  assert.strictEqual(S.UPDATED_NOTICE_WINDOW_SEC, 600);
});

test('no Redis, a Redis error or a bad id: announce, as before', async () => {
  redis = null;
  assert.strictEqual(await S.claimUpdatedNotice('h', 'n', 'u'), true);
  redis = { set: async () => { throw new Error('down'); } };
  assert.strictEqual(await S.claimUpdatedNotice('hub0000000000001', 'nid0000000000001', 'aaaa000000000001'), true);
  redis = { set: async () => assert.fail('never asked') };
  assert.strictEqual(await S.claimUpdatedNotice("x' OR 1", 'n', 'u'), true);
});
