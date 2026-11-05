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

function fakeYp({ info, node, failInfo = false } = {}) {
  const calls = [];
  return {
    calls,
    async await_proc(name, ...args) {
      calls.push({ name, args });
      if (name === 'secure_share_info') {
        if (failInfo) throw new Error('boom');
        return info;
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
  assert.deepStrictEqual(p, { state: 'public', sender: 'Lexis Tran', filetype: 'document', filename: 'Q4 report.pdf' });
  assert.strictEqual(yp.calls[1].args[0], HUB);
  assert.strictEqual(yp.calls[1].args[2], `'${NID}'`);
  const card = LP.cardText(p);
  assert.strictEqual(card.title, 'Q4 report.pdf');
  assert.strictEqual(card.description, 'File shared by Lexis Tran via Drumee');
  assert.strictEqual(card.image, 'public');
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
