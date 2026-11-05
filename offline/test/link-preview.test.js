#!/usr/bin/env node
//
// link-preview.test.js — short External link (/s/<token>) and the Open Graph
// card a link-preview crawler gets (service/lib/link-preview.js), plus the two
// call sites that must keep using it (secure_share.js links, page.js head).
//
//   node --test offline/test/link-preview.test.js
//
// Zero-dependency: @drumee/server-essentials is stubbed and yp is a fake.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === '@drumee/server-essentials') {
    return { toArray: (v) => (v == null ? [] : (Array.isArray(v) ? v : [v])) };
  }
  return realLoad.call(this, request, ...rest);
};
const LP = require('../../service/lib/link-preview');
Module._load = realLoad;

const TOKEN = 'lUIljceM1Z2uDJ0NBl1mw';
const HUB = 'ad43ec7aad43ec80';
const NID = 'add21922add2192d';

function fakeYp({ info, node, rows, failInfo = false } = {}) {
  const calls = [];
  return {
    calls,
    async await_proc(name, ...args) {
      calls.push({ name, args });
      if (name === 'secure_share_info') {
        if (failInfo) throw new Error('boom');
        return info;
      }
      if (name === 'forward_proc' && args[1] === 'mfs_show_node_by') {
        if (rows instanceof Error) throw rows;
        return rows;
      }
      if (name === 'forward_proc') return node;
      throw new Error(`unexpected proc ${name}`);
    },
  };
}

const OK = {
  hub_id: HUB, node_id: NID, db_name: '8_x', validity: 'TICKET_OK',
  require_password: 0, require_email: 0, is_locked: 0,
  recipient_email: null, domain_restriction: null,
  sender: 'Lexis Tran ', title: 'Marketing',
};

// ── link format ──────────────────────────────────────────────────────────────

test('short link is 10 characters shorter than the historic hash link', () => {
  const base = 'https://share.app.drumee.com/-/';
  const short = LP.shortShareLink(base, TOKEN);
  assert.strictEqual(short, `https://share.app.drumee.com/-/s/${TOKEN}`);
  assert.strictEqual(`${base}#/dmz/share/${TOKEN}`.length - short.length, 10);
  assert.strictEqual(LP.shortShareLink('https://share.drumee.org/-/preview/', TOKEN),
    `https://share.drumee.org/-/preview/s/${TOKEN}`);
  assert.strictEqual(LP.shortShareLink('https://h/-', TOKEN), `https://h/-/s/${TOKEN}`);
});

test('a token the page server would not recognise keeps the historic form', () => {
  assert.strictEqual(LP.shortShareLink('https://h/-/', 'a b'), 'https://h/-/#/dmz/share/a b');
  assert.strictEqual(LP.shortShareLink('https://h/-/', 'short'), 'https://h/-/#/dmz/share/short');
});

test('page server reads the token only from <endpoint>/s/<token>', () => {
  assert.strictEqual(LP.shortShareToken(`/-/s/${TOKEN}`, '/-/'), TOKEN);
  assert.strictEqual(LP.shortShareToken(`/-/s/${TOKEN}/`, '/-/'), TOKEN);
  assert.strictEqual(LP.shortShareToken(`/-/preview/s/${TOKEN}`, '/-/preview/'), TOKEN);
  assert.strictEqual(LP.shortShareToken(`/-/preview/s/${TOKEN}`, '/-/'), null, 'other endpoint');
  assert.strictEqual(LP.shortShareToken('/-/', '/-/'), null);
  assert.strictEqual(LP.shortShareToken(`/-/x/s/${TOKEN}`, '/-/'), null);
  assert.strictEqual(LP.shortShareToken('/-/s/<script>', '/-/'), null);
  assert.strictEqual(LP.shortShareToken(`/-/s/${TOKEN}/extra`, '/-/'), null);
  assert.strictEqual(LP.shortShareToken(undefined, '/-/'), null);
});

test('rewrite script restores the historic address, query before the hash', () => {
  const s = LP.rewriteScript('/-/preview/', TOKEN);
  assert.match(s, /^<script>/);
  assert.ok(s.includes('"/-/preview/"+location.search+"#/dmz/share/' + TOKEN + '"'));
  assert.ok(s.includes('history.replaceState'));
  assert.strictEqual(LP.rewriteScript('/-/', '"><x'), '');
  // Runs: simulated browser globals.
  let replaced = null;
  const history = { state: { a: 1 }, replaceState: (st, t, u) => { replaced = { st, u }; } };
  const location = { search: '?x=1', replace: () => assert.fail('should not reload') };
  new Function('history', 'location', s.replace(/^<script>|<\/script>$/g, ''))(history, location);
  assert.deepStrictEqual(replaced, { st: { a: 1 }, u: `/-/preview/?x=1#/dmz/share/${TOKEN}` });
});

// ── what a preview may reveal ────────────────────────────────────────────────

test('public share: file name + sender', async () => {
  const yp = fakeYp({ info: [OK], node: [{ filename: 'Q4 report.pdf', filetype: 'document' }] });
  const p = await LP.sharePreview(yp, TOKEN);
  assert.deepStrictEqual(p, { state: 'public', sender: 'Lexis Tran', filetype: 'document', filename: 'Q4 report.pdf', card: true });
  assert.strictEqual(yp.calls[1].args[0], HUB);
  assert.strictEqual(yp.calls[1].args[2], `'${NID}'`);
  const card = LP.cardText(p);
  assert.strictEqual(card.title, 'Q4 report.pdf');
  assert.strictEqual(card.description, 'File shared by Lexis Tran via Drumee');
  assert.strictEqual(card.image, 'public');
});

test('public file: its own content card is the preview image', async () => {
  for (const filetype of ['image', 'video', 'document']) {
    const yp = fakeYp({ info: [OK], node: [{ id: NID, filename: 'a', filetype }] });
    assert.strictEqual((await LP.sharePreview(yp, TOKEN)).card, true, filetype);
    assert.strictEqual((await LP.shareCardNode(fakeYp({ info: [OK], node: [{ id: NID, filetype }] }), TOKEN)).id, NID);
  }
  for (const filetype of ['folder', 'root', 'hub', 'other', 'audio']) {
    const yp = fakeYp({ info: [OK], node: [{ filename: 'a', filetype }] });
    assert.strictEqual((await LP.sharePreview(yp, TOKEN)).card, undefined, filetype);
    assert.strictEqual(await LP.shareCardNode(fakeYp({ info: [OK], node: [{ filetype }] }), TOKEN), null, filetype);
  }
  const card = LP.cardText({ state: 'public', filename: 'a', filetype: 'image', card: true });
  const html = LP.ogTags(card, { imageBase: 'https://h/-/app/link-preview/', cardUrl: 'https://h/-/svc/link_preview.card?token=x' });
  assert.ok(html.includes('<meta property="og:image" content="https://h/-/svc/link_preview.card?token=x">'));
  assert.ok(html.includes('<meta property="og:image:width" content="460">'));
  assert.ok(!html.includes('public.png'));
  // no card → the build's image, even when a card URL is offered
  const folder = LP.ogTags(LP.cardText({ state: 'public', filetype: 'folder' }), { imageBase: 'https://h/-/app/link-preview/', cardUrl: 'https://h/c' });
  assert.ok(folder.includes('public.png') && !folder.includes('https://h/c'));
});

test('content card never for a secure / unavailable / bad token', async () => {
  for (const yp of [
    fakeYp({ info: [{ ...OK, require_password: 1 }], node: [{ id: NID, filetype: 'image' }] }),
    fakeYp({ info: [{ ...OK, recipient_email: 'a@b.c' }], node: [{ id: NID, filetype: 'image' }] }),
    fakeYp({ info: [{ ...OK, validity: 'TICKET_EXPIRED' }], node: [{ id: NID, filetype: 'image' }] }),
    fakeYp({ failInfo: true }),
  ]) {
    assert.strictEqual(await LP.shareCardNode(yp, TOKEN), null);
    assert.ok(!yp.calls.some((c) => c.name === 'forward_proc'), 'workspace never read');
  }
  assert.strictEqual(await LP.shareCardNode(fakeYp({ info: [OK] }), '../x'), null);
});

test('public folder: first entry names, as the share page lists them', async () => {
  const rows = [
    { filename: 'Q4', ext: 'pdf', filetype: 'document' },
    { filename: '.hidden', ext: '', filetype: 'other' },
    { filename: 'Photos', ext: '', filetype: 'folder' },
    { filename: 'logo', ext: 'png', filetype: 'image' },
    { filename: 'notes', ext: 'txt', filetype: 'text' },
  ];
  const yp = fakeYp({ info: [OK], node: [{ id: NID, filename: 'abc', filetype: 'folder' }], rows });
  const p = await LP.sharePreview(yp, TOKEN, { guestId: 'g1' });
  assert.deepStrictEqual([p.items, p.more], [['Q4.pdf', 'Photos', 'logo.png'], true]);
  const list = yp.calls.find((c) => c.args[1] === 'mfs_show_node_by');
  assert.strictEqual(list.args[0], HUB);
  assert.ok(list.args[2].startsWith(`'${NID}', 'g1', '`));
  assert.strictEqual(LP.cardText(p).description, 'Folder shared by Lexis Tran via Drumee · Q4.pdf, Photos, logo.png, …');
  // no guest id, or the listing fails → plain folder card
  const p2 = await LP.sharePreview(fakeYp({ info: [OK], node: [{ id: NID, filename: 'abc', filetype: 'folder' }], rows }), TOKEN);
  assert.strictEqual(p2.items, undefined);
  const p3 = await LP.sharePreview(fakeYp({ info: [OK], node: [{ id: NID, filename: 'abc', filetype: 'folder' }], rows: new Error('x') }), TOKEN, { guestId: 'g1' });
  assert.deepStrictEqual(LP.cardText(p3).description, 'Folder shared by Lexis Tran via Drumee');
  // a file is never listed
  const yf = fakeYp({ info: [OK], node: [{ id: NID, filename: 'a', filetype: 'image' }], rows });
  await LP.sharePreview(yf, TOKEN, { guestId: 'g1' });
  assert.ok(!yf.calls.some((c) => c.args[1] === 'mfs_show_node_by'));
});

test('folder names in the description are escaped in the tags', async () => {
  const rows = [{ filename: '"><script>x</script>', ext: '', filetype: 'folder' }];
  const p = await LP.sharePreview(fakeYp({ info: [OK], node: [{ id: NID, filename: 'f', filetype: 'folder' }], rows }), TOKEN, { guestId: 'g' });
  const html = LP.ogTags(LP.cardText(p), {});
  assert.ok(!html.includes('<script>'));
});

test('imageDir: next to main.js, only for a plain absolute path', () => {
  assert.strictEqual(LP.imageDir({ 'main.js': '/-/app/main.abc.js' }), '/-/app/link-preview/');
  assert.strictEqual(LP.imageDir({ 'main.js': 'https://evil/x.js' }), null);
  assert.strictEqual(LP.imageDir({ 'main.js': '/-/a"b/m.js' }), null);
  assert.strictEqual(LP.imageDir(undefined), null);
});

test('public share of a workspace root is named by the workspace', async () => {
  const yp = fakeYp({ info: [OK], node: [{ filename: '', filetype: 'root' }] });
  const p = await LP.sharePreview(yp, TOKEN);
  assert.strictEqual(p.filename, 'Marketing');
  assert.strictEqual(LP.cardText(p).description, 'Folder shared by Lexis Tran via Drumee');
});

for (const [label, extra] of [
  ['password', { require_password: 1 }],
  ['email', { require_email: 1 }],
  ['single recipient', { recipient_email: 'a@b.c' }],
  ['domain', { domain_restriction: '@acme.com' }],
  ['locked', { is_locked: 1 }],
]) {
  test(`secure share (${label}): neutral card, no name, workspace DB never read`, async () => {
    const yp = fakeYp({ info: [{ ...OK, ...extra }] });
    const p = await LP.sharePreview(yp, TOKEN);
    assert.deepStrictEqual(p, { state: 'secure' });
    assert.strictEqual(yp.calls.length, 1);
    const card = LP.cardText(p);
    assert.ok(!JSON.stringify(card).includes('Lexis'));
    assert.ok(!JSON.stringify(card).includes('Marketing'));
    assert.strictEqual(card.image, 'secure');
  });
}

for (const [label, yp] of [
  ['revoked', () => fakeYp({ info: [{ ...OK, validity: 'TICKET_REVOKED' }] })],
  ['expired', () => fakeYp({ info: [{ ...OK, validity: 'TICKET_EXPIRED' }] })],
  ['unknown', () => fakeYp({ info: [{ failed: 1, validity: 'TICKET_INVALID' }] })],
  ['empty', () => fakeYp({ info: [] })],
  ['proc throws', () => fakeYp({ failInfo: true })],
]) {
  test(`${label}: link unavailable`, async () => {
    assert.deepStrictEqual(await LP.sharePreview(yp(), TOKEN), { state: 'unavailable' });
  });
}

test('bad token never reaches the DB', async () => {
  const yp = fakeYp({ info: [OK] });
  assert.deepStrictEqual(await LP.sharePreview(yp, "x'; DROP"), { state: 'unavailable' });
  assert.strictEqual(yp.calls.length, 0);
});

test('workspace DB unresolved: no forward_proc (a SQL error would stop the page)', async () => {
  const yp = fakeYp({ info: [{ ...OK, db_name: null }] });
  const p = await LP.sharePreview(yp, TOKEN);
  assert.strictEqual(p.state, 'public');
  assert.strictEqual(p.filename, 'Marketing');
  assert.strictEqual(yp.calls.length, 1);
});

test('no state (Internal links, sign-in page): neutral Drumee card', () => {
  const card = LP.cardText(null);
  assert.strictEqual(card.title, 'Drumee');
  assert.strictEqual(card.image, 'neutral');
});

// ── tags ─────────────────────────────────────────────────────────────────────

test('og tags are escaped (file names are user-chosen)', () => {
  const html = LP.ogTags(
    { title: '"><script>alert(1)</script>', description: "a'b&c", image: 'public' },
    { url: 'https://h/-/s/x', imageBase: 'https://h/-/app/link-preview/' }
  );
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('content="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"'));
  assert.ok(html.includes('content="a&#39;b&amp;c"'));
  assert.ok(html.includes('<meta property="og:image" content="https://h/-/app/link-preview/public.png">'));
  assert.ok(html.includes('content="summary_large_image"'));
  const noImg = LP.ogTags(LP.cardText(null), {});
  assert.ok(!noImg.includes('og:image'));
  assert.ok(noImg.includes('content="summary"'));
});

// ── call sites ───────────────────────────────────────────────────────────────

test('secure_share.js hands out the short link everywhere it builds one', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../service/private/secure_share.js'), 'utf8');
  assert.ok(!/#\/dmz\/share\//.test(src), 'no hand-built hash link left');
  assert.strictEqual((src.match(/shortShareLink\(/g) || []).length, 3);
});

test('page.js never lets a preview failure break the page', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../client/page.js'), 'utf8');
  assert.match(src, /try \{\s*data\.link_preview_head = await this\.linkPreviewHead\(data\);\s*\} catch/);
  const tpl = fs.readFileSync(path.join(__dirname, '../../client/templates/index.tpl'), 'utf8');
  assert.match(tpl, /typeof\(link_preview_head\) !== "undefined"/);
  // The rewrite must run before the bootstrap script loads any bundle.
  assert.ok(tpl.indexOf('link_preview_head %>') < tpl.indexOf("bootstrap.js.tpl"));
});
