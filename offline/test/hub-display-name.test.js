#!/usr/bin/env node
//
// hub-display-name.test.js
//
// A workspace has two names on its hub record and only one of them is a name:
//
//   yp.hub.name      the display name a member set and sees. mfs_home returns it.
//   yp.hub.hubname   the hex id. yp.get_hub selects
//                    `IF(_exists, h.hubname, _org_name) AS name`, so a session's
//                    hub entity AND a get_hub row BOTH answer the hex id to
//                    `name` and to `hubname`.
//
// hub.invite read mfs_home. hub.add_contributors and hub.invite_with_roles read
// the hub record, so they mailed "<inviter> added you to team 218881d8218881dc"
// and add_contributors stored that hex id as the workspace name on the invitee's
// notification -- where the bell feed's resolver rightly refuses to render it,
// leaving the invitation with no workspace name at all (real stage rows 727-729).
//
//   node offline/test/hub-display-name.test.js
//
// The resolver is required for real. Each of the three call sites has its own
// `hubname` expression SLICED OUT of service/private/hub.js and evaluated against
// stubs, so this tests the shipped call sites rather than a retyped copy of them.
//
// Exit code 0 = all pass, 1 = any failure.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HUB_FILE = path.join(__dirname, '..', '..', 'service', 'private', 'hub.js');
const src = fs.readFileSync(HUB_FILE, 'utf8');
const MD5_BEFORE = crypto.createHash('md5').update(src).digest('hex');

const { resolveHubDisplayName } = require('../../service/lib/hub-display-name');

let passed = 0;
let failed = 0;
const failures = [];
function check(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) { passed++; return true; }
  failed++;
  failures.push(`${label}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`);
  return false;
}

const HEX = '218881d8218881dc';

// ---------------------------------------------------------------------------
// 1. The resolver itself.
// ---------------------------------------------------------------------------
{
  check('A1 the display name wins',
    resolveHubDisplayName({ name: 'Marketing' }, HEX, HEX, HEX), 'Marketing');
  check('A2 no mfs_home row falls through to the fallbacks',
    resolveHubDisplayName(null, '', HEX), HEX);
  check('A3 an mfs_home row without a name falls through too',
    resolveHubDisplayName({ chat_upload_id: 'x' }, HEX), HEX);
  check('A4 a NULL display name falls through',
    resolveHubDisplayName({ name: null }, HEX), HEX);
  check('A5 an empty display name is not a name',
    resolveHubDisplayName({ name: '' }, HEX), HEX);
  check('A6 fallbacks are tried in order', resolveHubDisplayName(null, null, '', 'b', 'c'), 'b');
  check('A7 nothing at all yields null, never undefined',
    resolveHubDisplayName(null), null);
  check('A8 nothing at all with empty fallbacks yields null',
    resolveHubDisplayName(undefined, null, '', 0), null);
  // The whole point: a hex id must never outrank a real name.
  check('A9 the hex id never beats the display name',
    resolveHubDisplayName({ name: 'Marketing' }, HEX), 'Marketing');
}

// ---------------------------------------------------------------------------
// 2. The three call sites, sliced out of hub.js and executed.
//
// Each site's `const hubname = resolveHubDisplayName( ... );` is extracted by
// paren-matching and evaluated with stubs, so what runs here is the expression
// that ships.
// ---------------------------------------------------------------------------
function sliceHubnameExpr(methodMarker, what) {
  const mStart = src.indexOf(methodMarker);
  if (mStart < 0) {
    console.error(`FATAL: ${what} not found in ${HUB_FILE} — fix this slicer`);
    process.exit(1);
  }
  const at = src.indexOf('const hubname = resolveHubDisplayName(', mStart);
  if (at < 0) {
    console.error(`FATAL: ${what} does not resolve its name through the shared`
      + ' resolver — that is the bug this file exists to prevent');
    process.exit(1);
  }
  let depth = 0;
  let end = -1;
  for (let i = src.indexOf('(', at); i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) { console.error(`FATAL: unbalanced parens slicing ${what}`); process.exit(1); }
  return { expr: src.slice(at, end) + ';', at, mStart };
}

// `mfs_home` MUST be read before the name, or the const is in its temporal dead
// zone and the invitation throws. Checked per site, not assumed.
function mfsHomeComesFirst(methodMarker, nameAt) {
  const mStart = src.indexOf(methodMarker);
  const fetch = src.indexOf('mfs_home = await', mStart);
  return fetch > 0 && fetch < nameAt;
}

const SITES = [
  {
    name: 'hub.invite',
    marker: '\n  async invite() {',
    // this.hub is an Entity; get(Attr.hubname) and get(Attr.name) both answer
    // the hex id in production, which is exactly what is stubbed here.
    run(expr, mfs_home) {
      const ctx = { hub: { get: () => HEX } };
      const Attr = { hubname: 'hubname', name: 'name', id: 'id' };
      return (new Function('Attr', 'resolveHubDisplayName', 'mfs_home', 'hubId', 'ctx',
        `${expr.replace(/this\.hub/g, 'ctx.hub')}
         return hubname;`))(Attr, resolveHubDisplayName, mfs_home, HEX, ctx);
    },
  },
  {
    name: 'hub.add_contributors',
    marker: '\n  async add_contributors() {',
    run(expr, mfs_home) {
      const ctx = { hub: { get: () => HEX } };
      const Attr = { hubname: 'hubname', name: 'name', id: 'id' };
      return (new Function('Attr', 'resolveHubDisplayName', 'mfs_home', 'ctx',
        `${expr.replace(/this\.hub/g, 'ctx.hub')}
         return hubname;`))(Attr, resolveHubDisplayName, mfs_home, ctx);
    },
  },
  {
    name: 'hub.invite_with_roles',
    marker: '\n  async invite_with_roles() {',
    run(expr, mfs_home) {
      // get_hub answers the hex id on BOTH name columns.
      const hubInfo = { hubname: HEX, name: HEX };
      return (new Function('resolveHubDisplayName', 'mfs_home', 'hubInfo', 'hub_id',
        `${expr}
         return hubname;`))(resolveHubDisplayName, mfs_home, hubInfo, HEX);
    },
  },
];

for (const site of SITES) {
  const { expr, at } = sliceHubnameExpr(site.marker, site.name);
  check(`B ${site.name} names a real workspace by its display name`,
    site.run(expr, { name: 'Marketing' }), 'Marketing');
  check(`C ${site.name} never mails the hex id when a display name exists`,
    site.run(expr, { name: 'Marketing' }) === HEX, false);
  check(`D ${site.name} still degrades to an id rather than to nothing`,
    site.run(expr, null), HEX);
  check(`E ${site.name} reads mfs_home BEFORE resolving the name`,
    mfsHomeComesFirst(site.marker, at), true);
}

// ---------------------------------------------------------------------------
// 3. Anti-drift: no invite path may grow its own copy of the chain again.
// ---------------------------------------------------------------------------
{
  const hubnameAssignments = src.match(/const hubname = [^\n]*/g) || [];
  check('F1 every `const hubname =` in hub.js goes through the resolver, first',
    hubnameAssignments.every(
      (l) => l.trim().startsWith('const hubname = resolveHubDisplayName(')), true);
  check('F2 and there are exactly the three invite sites', hubnameAssignments.length, 3);
  check('F3 hub.js requires the shared resolver',
    /require\(["']\.\.\/lib\/hub-display-name["']\)/.test(src), true);
  // The resolver is the only place allowed to know the fallback order.
  const lib = fs.readFileSync(
    path.join(__dirname, '..', '..', 'service', 'lib', 'hub-display-name.js'), 'utf8');
  check('F4 the resolver reads the display name first',
    /const live = mfsHome && mfsHome\.name;/.test(lib), true);
}

// ---------------------------------------------------------------------------
// 4. Negative controls: put each mistake back and prove a named case goes red.
// ---------------------------------------------------------------------------
{
  const controls = [
    ['NC1 the hub record outranks the display name (the original bug)',
      (mfsHome, ...fb) => {
        for (const v of fb) if (v) return v;
        return (mfsHome && mfsHome.name) || null;
      },
      (f) => f({ name: 'Marketing' }, HEX) === 'Marketing'],
    ['NC2 an empty display name counts as a name',
      (mfsHome, ...fb) => {
        if (mfsHome && mfsHome.name !== undefined) return mfsHome.name;
        for (const v of fb) if (v) return v;
        return null;
      },
      (f) => f({ name: '' }, HEX) === HEX],
    ['NC3 no fallback at all (an audit line with empty quotes)',
      (mfsHome) => (mfsHome && mfsHome.name) || null,
      (f) => f(null, HEX) === HEX],
  ];
  let caught = 0;
  for (const [label, broken, stillHolds] of controls) {
    if (stillHolds(broken)) {
      console.log(`  ✗ ${label} — NOT CAUGHT`);
      failed++; failures.push(label + ' — NOT CAUGHT');
    } else {
      caught++; console.log(`  ✓ ${label} — CAUGHT`);
    }
  }
  // And one that mutates the SOURCE: a site that grows its own chain again must
  // break F1, the invariant that is the whole reason the resolver was extracted.
  {
    const mutated = src.replace(
      'const hubname = resolveHubDisplayName(',
      'const hubname = (mfs_home && mfs_home.name) || (',
    );
    const lines = mutated.match(/const hubname = [^\n]*/g) || [];
    const stillClean = lines.length === 3
      && lines.every((l) => l.trim().startsWith('const hubname = resolveHubDisplayName('));
    if (mutated !== src && !stillClean) {
      caught++; console.log('  ✓ NC4 a site grows its own copy of the chain — CAUGHT');
    } else {
      console.log('  ✗ NC4 a site grows its own copy of the chain — NOT CAUGHT');
      failed++; failures.push('NC4 — NOT CAUGHT');
    }
  }
  console.log('');
  check('Z1 the working tree was never modified',
    crypto.createHash('md5').update(fs.readFileSync(HUB_FILE, 'utf8')).digest('hex'),
    MD5_BEFORE);
  console.log(`negative controls caught: ${caught}`);
}

for (const f of failures) console.log('  ✗ ' + f);
console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
