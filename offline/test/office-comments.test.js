#!/usr/bin/env node
//
// office-comments.test.js — reading the comments stored inside docx / xlsx /
// pptx (offline/media/office-comments.js), which is how a document save finds
// the comments that are new since the stored original.
//
//   node --test offline/test/office-comments.test.js
//
// Fixtures are built in a temp dir with jszip, as normalize-docx-sections.test
// does.

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const { join } = require('path');
const { writeFileSync, mkdtempSync } = require('fs');
const JSZip = require('jszip');
const { readComments, newComments, attributeComment } = require('../media/office-comments');

const dir = mkdtempSync(join(os.tmpdir(), 'office-comments-'));
let n = 0;
async function file(ext, entries) {
  const zip = new JSZip();
  for (const [name, xml] of Object.entries(entries)) zip.file(name, xml);
  const path = join(dir, `f${n++}.${ext}`);
  writeFileSync(path, await zip.generateAsync({ type: 'nodebuffer' }));
  return path;
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"';
const docxComments = (list) => `<?xml version="1.0"?><w:comments ${W}>${list.map((c, i) => (
  `<w:comment w:id="${i}" w:author="${c.author}" w:date="${c.date}" w:initials="X"><w:p><w:r><w:t>${c.text}</w:t></w:r></w:p></w:comment>`
)).join('')}</w:comments>`;

test('docx: author, text, date and the userId from people.xml', async () => {
  const f = await file('docx', {
    'word/comments.xml': docxComments([{ author: 'Ann Lee', date: '2026-10-20T09:00:00Z', text: 'Fix &amp; check' }]),
    'word/people.xml': `<w15:people ${W}><w15:person w15:author="Ann Lee"><w15:presenceInfo w15:providerId="Teamlab" w15:userId="abc123"/></w15:person></w15:people>`,
  });
  const [c, ...rest] = await readComments(f, 'docx');
  assert.strictEqual(rest.length, 0);
  assert.strictEqual(c.author, 'Ann Lee');
  assert.strictEqual(c.text, 'Fix & check');
  assert.strictEqual(c.userId, 'abc123');
  assert.strictEqual(c.date, '2026-10-20T09:00:00Z');
});

test('docx: a comment survives renumbering; only the added one is new', async () => {
  const a = { author: 'Ann', date: '2026-10-20T09:00:00Z', text: 'first' };
  const b = { author: 'Bob', date: '2026-10-20T10:00:00Z', text: 'second' };
  const before = await readComments(await file('docx', { 'word/comments.xml': docxComments([a]) }), 'docx');
  // w:id is reassigned on save: `a` moves from id 0 to id 1.
  const after = await readComments(await file('docx', { 'word/comments.xml': docxComments([b, a]) }), 'docx');
  const added = newComments(before, after);
  assert.deepStrictEqual(added.map((c) => c.text), ['second']);
  assert.deepStrictEqual(newComments(after, after), []);
});

test('xlsx: threaded comments with persons, legacy copy not double counted', async () => {
  const f = await file('xlsx', {
    'xl/persons/person.xml': '<personList><person displayName="Ann" id="{P1}" userId="u1" providerId="Teamlab"/></personList>',
    'xl/threadedComments/threadedComment1.xml': '<ThreadedComments><threadedComment ref="A1" dT="2026-10-20T09:00:00" personId="{P1}" id="{C1}"><text>Looks off</text></threadedComment></ThreadedComments>',
    'xl/comments1.xml': '<comments><authors><author>tc={C1}</author></authors><commentList><comment ref="A1" authorId="0"><text><t>Looks off</t></text></comment></commentList></comments>',
  });
  const list = await readComments(f, 'xlsx');
  assert.strictEqual(list.length, 1);
  assert.deepStrictEqual([list[0].author, list[0].text, list[0].userId], ['Ann', 'Looks off', 'u1']);
});

test('xlsx: legacy notes', async () => {
  const f = await file('xlsx', {
    'xl/comments1.xml': '<comments><authors><author>Ann</author><author>Bob</author></authors><commentList><comment ref="B2" authorId="1"><text><r><t>Note </t></r><r><t>here</t></r></text></comment></commentList></comments>',
  });
  const [c] = await readComments(f, 'xlsx');
  assert.deepStrictEqual([c.author, c.text], ['Bob', 'Note here']);
});

test('pptx: modern comments and replies, legacy comments', async () => {
  const modern = await file('pptx', {
    'ppt/authors.xml': '<p188:authorLst xmlns:p188="x"><p188:author id="{A1}" name="Ann" initials="A" userId="u1" providerId="Teamlab"/></p188:authorLst>',
    'ppt/comments/modernComment_100_1.xml': '<p188:cmLst xmlns:p188="x" xmlns:a="y"><p188:cm id="{M1}" authorId="{A1}" created="2026-10-20T09:00:00"><p188:replyLst><p188:reply id="{R1}" authorId="{A1}" created="2026-10-20T09:05:00"><p188:txBody><a:p><a:r><a:t>reply</a:t></a:r></a:p></p188:txBody></p188:reply></p188:replyLst><p188:txBody><a:p><a:r><a:t>top</a:t></a:r></a:p></p188:txBody></p188:cm></p188:cmLst>',
  });
  const list = await readComments(modern, 'pptx');
  assert.deepStrictEqual(list.map((c) => c.text).sort(), ['reply', 'top']);
  assert.ok(list.every((c) => c.author === 'Ann' && c.userId === 'u1'));

  const legacy = await file('pptx', {
    'ppt/commentAuthors.xml': '<p:cmAuthorLst xmlns:p="x"><p:cmAuthor id="0" name="Bob" initials="B" lastIdx="1" clrIdx="0"/></p:cmAuthorLst>',
    'ppt/comments/comment1.xml': '<p:cmLst xmlns:p="x"><p:cm authorId="0" dt="2026-10-20T09:00:00" idx="1"><p:pos x="0" y="0"/><p:text>legacy</p:text></p:cm></p:cmLst>',
  });
  const [c] = await readComments(legacy, 'pptx');
  assert.deepStrictEqual([c.author, c.text], ['Bob', 'legacy']);
});

test('unreadable is null, never "no comments", and never throws', async () => {
  assert.strictEqual(await readComments(join(dir, 'missing.docx'), 'docx'), null);
  const notZip = join(dir, 'bad.docx');
  writeFileSync(notZip, 'not a zip');
  assert.strictEqual(await readComments(notZip, 'docx'), null);
  assert.strictEqual(await readComments(notZip, 'pdf'), null);
  // a readable document without comments is an empty list
  assert.deepStrictEqual(await readComments(await file('docx', { 'word/document.xml': '<w:document/>' }), 'docx'), []);
});

test('newComments: an unreadable side announces nothing', () => {
  const after = [{ key: 'a' }, { key: 'b' }];
  assert.deepStrictEqual(newComments(null, after), []);
  assert.deepStrictEqual(newComments(after, null), []);
  assert.deepStrictEqual(newComments([], after).map((c) => c.key), ['a', 'b']);
});

test('attributeComment: by stored userId, else by a unique name, else nobody', () => {
  const people = [{ id: 'u1', name: 'Ann Lee' }, { id: 'u2', name: 'Bob' }, { id: 'u3', name: 'Bob' }];
  assert.strictEqual(attributeComment({ userId: 'u2', author: 'whoever' }, people), 'u2');
  // per-connection suffix
  assert.strictEqual(attributeComment({ userId: 'u12', author: '' }, [{ id: 'u1', name: 'Ann' }]), 'u1');
  assert.strictEqual(attributeComment({ author: ' ann lee ' }, people), 'u1');
  // two participants named Bob: no guess
  assert.strictEqual(attributeComment({ author: 'Bob' }, people), null);
  // a userId that is no participant falls back to the name
  assert.strictEqual(attributeComment({ userId: 'zz', author: 'Ann Lee' }, people), 'u1');
  assert.strictEqual(attributeComment({ author: 'Stranger' }, people), null);
  assert.strictEqual(attributeComment({ author: '' }, people), null);
});
