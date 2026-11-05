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

test('public folder with entries: the card URL draws its name + entries (1200×630)', () => {
  const card = LP.cardText({ state: 'public', filename: 'abc', filetype: 'folder', items: ['cba', 'cbc'], more: false });
  assert.strictEqual(card.folderCard, true);
  const html = LP.ogTags(card, { imageBase: 'https://h/-/app/link-preview/', cardUrl: 'https://h/c' });
  assert.ok(html.includes('<meta property="og:image" content="https://h/c">'));
  assert.ok(html.includes('<meta property="og:image:width" content="1200">'));
  assert.ok(html.includes('<meta property="og:image:height" content="630">'));
  // no card URL (no token) → the build's image
  assert.ok(LP.ogTags(card, { imageBase: 'https://h/-/app/link-preview/' }).includes('public.png'));
  // secure / unavailable / no-state never get a folder card
  for (const p of [{ state: 'secure', items: ['x'] }, { state: 'unavailable', items: ['x'] }, null]) {
    assert.ok(!LP.cardText(p).folderCard);
  }
});

test('folder card SVG: list-view rows, escaped, cut, nothing when no entry', () => {
  const FC = require('../../service/lib/link-preview-folder-card');
  assert.strictEqual(FC.folderCardSvg({ title: 'abc', entries: [] }), null);
  assert.strictEqual(FC.folderCardSvg(null), null);
  const svg = FC.folderCardSvg({
    title: 'a<b>&"c"',
    entries: [
      { name: '</text><script>x</script>', ext: 'pdf', size: 1234 },
      { name: 'Photos', folder: true },
      { name: 'ok', ext: 'PNG', size: 98765432 },
      { name: 'b', ext: '', size: 0 },
      { name: 'fifth', ext: 'txt', size: 1 },
    ],
  });
  assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'));
  assert.ok(!svg.includes('<script>') && svg.includes('&lt;/text&gt;&lt;script&gt;'));
  assert.ok(svg.includes('a&lt;b&gt;&amp;&quot;c&quot;'));
  assert.ok(svg.includes('>Name</text>') && svg.includes('>Size</text>') && svg.includes('>Type</text>'));
  assert.ok(svg.includes('>1.23 kB</text>') && svg.includes('>98.77 MB</text>') && svg.includes('>png</text>'));
  assert.ok(svg.includes('>--</text>') && svg.includes('>folder</text>'), 'a folder: size --, type folder');
  assert.ok(!svg.includes('fifth'), `at most ${FC.ROWS} rows`);
  // fewer rows → a shorter card, still inside the image
  const one = FC.folderCardSvg({ title: 't', entries: [{ name: 'x', ext: 'a', size: 1 }] });
  const h = (v) => Number(/<rect x="61" y="(\d+)" width="1078" height="(\d+)"/.exec(v)[2]);
  assert.ok(h(one) < h(svg));
  // XML-forbidden characters and lone surrogates are dropped
  assert.strictEqual(FC.xml('a\u0001b\ud800c'), 'abc');
  assert.strictEqual(FC.fit('short', 10), 'short');
  assert.strictEqual(FC.fit('abcdefghijkl', 10), 'abcdefghij…');
  assert.strictEqual(FC.fit('日本語日本語', 6), '日本語…');
  assert.strictEqual(FC.fit('😀😀😀', 4), '😀😀…');
  assert.deepStrictEqual([0, 512, 1234, 1234567, 98765432, 5e9, 'x'].map(FC.humanSize),
    ['0 B', '512 B', '1.23 kB', '1.23 MB', '98.77 MB', '5 GB', '']);
});

test('folder rows: the desk icon of each file, its own colours; thumbnail path only for pictures / videos', async () => {
  const I = require('../../service/lib/link-preview-file-icons');
  const cases = [
    [{ filetype: 'document', ext: 'PDF' }, 'documents_pdf'],
    [{ filetype: 'document', ext: 'docx' }, 'documents_word'],
    [{ filetype: 'document', ext: 'xlsx' }, 'documents_excel'],
    [{ filetype: 'document', ext: 'pptx' }, 'documents_powerpoint'],
    [{ filetype: 'document', ext: 'json', metadata: '{"dataType":"sheet.univer"}' }, 'documents_usheet'],
    [{ filetype: 'document', ext: 'udoc' }, 'documents_udoc'],
    [{ filetype: 'video', mimetype: 'audio/mpeg' }, 'music'],
    [{ filetype: 'audio' }, 'music'],
    [{ filetype: 'document', ext: 'txt' }, 'documents_different'],
    [{ filetype: 'other', ext: 'zip' }, 'documents_different'],
    [{ filetype: 'document', ext: 'json', metadata: '{bad' }, 'json'],
  ];
  for (const [row, icon] of cases) assert.strictEqual(I.iconFor(row), icon, JSON.stringify(row));
  for (const name of Object.keys(I.ICONS)) {
    const svg = I.iconSvg(name, 1, 2, 36);
    assert.ok(svg.startsWith('<svg x="1" y="2" width="36" height="36"') && svg.endsWith('</svg>'), name);
  }
  // Ids are unique across icons (gradients never collide in one image).
  const ids = Object.values(I.ICONS).flatMap((i) => [...i.body.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
  assert.strictEqual(new Set(ids).size, ids.length);

  const rows = [
    { nid: 'aa11', filename: 'pic', ext: 'png', filetype: 'image', filesize: 10 },
    { nid: 'bb22', filename: 'clip', ext: 'mp4', filetype: 'video', filesize: 10 },
    { nid: '../x', filename: 'evil', ext: 'png', filetype: 'image', filesize: 10 },
    { nid: 'cc33', filename: 'doc', ext: 'pdf', filetype: 'document', filesize: 10 },
  ];
  const yp = fakeYp({ info: [OK], node: [{ id: NID, filename: 'abc', filetype: 'folder', mfs_root: '/data/mfs/x' }], rows });
  const p = await LP.sharePreview(yp, TOKEN, { guestId: 'g1', entries: true });
  assert.strictEqual(p.entries[0].thumb, '/data/mfs/x/aa11/vignette.png');
  assert.strictEqual(p.entries[1].thumb, '/data/mfs/x/bb22/vignette.png');
  assert.strictEqual(p.entries[1].video, true);
  assert.strictEqual(p.entries[2].thumb, undefined, 'unsafe id → no path');
  assert.strictEqual(p.entries[3].thumb, undefined, 'documents keep their icon');

  // In the SVG: the thumbnail only as a PNG data URI, never a path.
  const FC = require('../../service/lib/link-preview-folder-card');
  const svg = FC.folderCardSvg({ title: 't', entries: [
    { name: 'a', ext: 'png', size: 1, icon: 'documents_different', thumbData: 'data:image/png;base64,AAAA' },
    { name: 'b', ext: 'png', size: 1, icon: 'documents_different', thumbData: '/etc/passwd' },
  ] });
  assert.ok(svg.includes('href="data:image/png;base64,AAAA"'));
  assert.ok(!svg.includes('/etc/passwd'));
});

test('public single file without a content card: itself as a one-row list image', async () => {
  const node = { id: NID, filename: 'Untitled document', ext: 'udoc', filetype: 'text', filesize: 2048,
    metadata: '{"dataType":"doc.casual"}', mfs_root: '/data/mfs/x/' };
  // chat card facts unchanged: no rows, no flag
  const plain = await LP.sharePreview(fakeYp({ info: [OK], node: [node] }), TOKEN, { guestId: 'g1' });
  assert.deepStrictEqual(plain, { state: 'public', sender: 'Lexis Tran', filetype: 'text', filename: 'Untitled document' });
  // the preview image: the file as its only row, with the desk icon
  const p = await LP.sharePreview(fakeYp({ info: [OK], node: [node] }), TOKEN, { guestId: 'g1', entries: true });
  assert.deepStrictEqual(p.entries, [{ name: 'Untitled document', ext: 'udoc', size: 2048, folder: false, icon: 'documents_udoc' }]);
  assert.strictEqual(p.single, true);
  const card = LP.cardText(plain);
  assert.strictEqual(card.card, false);
  assert.strictEqual(card.folderCard, true);
  const html = LP.ogTags(card, { imageBase: 'https://h/-/app/link-preview/', cardUrl: 'https://h/c' });
  assert.ok(html.includes('<meta property="og:image" content="https://h/c">'));
  assert.ok(html.includes('<meta property="og:image:width" content="1200">'));
  // a file with its own content card keeps it; an unknown node keeps the build image
  assert.strictEqual(LP.cardText({ state: 'public', filetype: 'document', card: true }).folderCard, false);
  assert.strictEqual(LP.cardText({ state: 'public', filename: 'x' }).folderCard, false);
  // the SVG: the file's own icon by the title, not the pink folder
  const FC = require('../../service/lib/link-preview-folder-card');
  const svg = FC.folderCardSvg({ title: 'Untitled document', entries: p.entries, single: true });
  const folderSvg = FC.folderCardSvg({ title: 'Untitled document', entries: p.entries });
  assert.strictEqual(svg.split('<svg').length, folderSvg.split('<svg').length + 1, 'one more desk icon');
  assert.ok(!svg.includes('scale(0.44)') && folderSvg.includes('scale(0.44)'), 'no folder glyph');
});

test('folder rows (entries) only when asked — never in the chat card facts', async () => {
  const rows = [
    { filename: 'Q4', ext: 'pdf', filetype: 'document', filesize: 1234 },
    { filename: 'Photos', ext: '', filetype: 'folder', filesize: 0 },
  ];
  const mk = () => fakeYp({ info: [OK], node: [{ id: NID, filename: 'abc', filetype: 'folder' }], rows });
  const plain = await LP.sharePreview(mk(), TOKEN, { guestId: 'g1' });
  assert.strictEqual(plain.entries, undefined);
  const withRows = await LP.sharePreview(mk(), TOKEN, { guestId: 'g1', entries: true });
  assert.deepStrictEqual(withRows.entries, [
    { name: 'Q4', ext: 'pdf', size: 1234, folder: false, icon: 'documents_pdf' },
    { name: 'Photos', ext: '', size: 0, folder: true },
  ]);
  assert.deepStrictEqual(withRows.items, ['Q4.pdf', 'Photos']);
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

// ── Internal link of an external workspace (?ext=1) ──────────────────────────

test('external-workspace Internal link: pink card, nothing else changes', () => {
  assert.strictEqual(LP.cardText({ external: true }).image, 'secure');
  assert.strictEqual(LP.cardText({ external: true }).title, 'Drumee');
  assert.strictEqual(LP.cardText(null).image, 'neutral');
  // a share token always wins over the marker
  assert.strictEqual(LP.cardText({ state: 'unavailable', external: true }).image, 'neutral');
  assert.ok(LP.isExternalMark('1'));
  for (const v of [undefined, '', '0', 'true', '1 ', ['1']]) assert.ok(!LP.isExternalMark(v), String(v));
});

test('the marker is stripped from the address before the app boots, and only it', () => {
  const html = LP.stripMarkScript();
  const js = html.replace(/^<script>/, '').replace(/<\/script>$/, '');
  for (const [search, want] of [
    ['?ext=1', ''],
    ['?r=4&ext=1', '?r=4'],
    ['?ext=1&lang=fr', '?lang=fr'],
    ['?ext=10', '?ext=10'],
  ]) {
    let got;
    const location = { search, pathname: '/-/', hash: '#/desk/wm/o/1/ad43/folder' };
    const history = { state: null, replaceState: (s, t, u) => { got = u; } };
    new Function('location', 'history', js)(location, history);
    assert.strictEqual(got, `/-/${want}#/desk/wm/o/1/ad43/folder`, search);
  }
  const src = fs.readFileSync(path.join(__dirname, '../../client/page.js'), 'utf8');
  assert.match(src, /const external = !token && LP\.isExternalMark\(this\.input\.get\(LP\.EXTERNAL_MARK\.key\)\);/);
  assert.match(src, /else if \(external\) head = `\$\{LP\.stripMarkScript\(\)\}/);
});
