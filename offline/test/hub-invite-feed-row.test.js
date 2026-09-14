#!/usr/bin/env node
//
// hub-invite-feed-row.test.js
//
// A workspace invitation must read "<inviter> invited you to <workspace>" in the
// chronological activity feed. It read "<inviter> wants to connect" instead
// (Lexis, 2026-09-14) because activity_get_feed_all -- the Unread-OFF feed, which
// is the panel's DEFAULT -- returns the invite as a bare yp.contact_activity row:
// `category` NULL, `event_type` 'contact', `event` 'hub_invite_received'. The
// client resolves a row's category as `category || event_type || type`, so the
// row took the contact-request branch of the renderer -- and its click ROUTER
// switches on the same value, which is why the recipients also reported that
// clicking the notification led nowhere.
//
//   node offline/test/hub-invite-feed-row.test.js
//
// This exercises the REAL _stampHubInvites: the method is sliced out of
// service/private/activity.js and evaluated, together with the REAL
// _optionalYpProc guard and the REAL resolveHubInviteName resolver required from
// service/lib/. Nothing here is a copy -- a copy would keep passing after the
// service changed underneath it.
//
// It ends with negative controls: each one mutates the sliced SOURCE STRING in
// memory (never the file) to reintroduce a specific mistake and asserts that a
// named case goes red. A test that cannot fail proves nothing.
//
// Exit code 0 = all pass, 1 = any failure.

const fs = require('fs');
const path = require('path');

const SERVICE_FILE = path.join(__dirname, '..', '..', 'service', 'private', 'activity.js');
const src = fs.readFileSync(SERVICE_FILE, 'utf8');
const { resolveHubInviteName } = require('../../service/lib/hub-invite-name');

// The working tree must be byte-identical before and after this run.
const MD5_BEFORE = require('crypto').createHash('md5').update(src).digest('hex');

let passed = 0;
let failed = 0;
const failures = [];

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { passed++; return true; }
  failed++;
  failures.push(`${label}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`);
  return false;
}

// ---------------------------------------------------------------------------
// Slice the real code out of the service module.
// ---------------------------------------------------------------------------
function sliceMethod(marker, what) {
  const start = src.indexOf(marker);
  if (start < 0) {
    console.error(`FATAL: could not find ${what} in ${SERVICE_FILE}`);
    console.error('The marker moved — fix this slicer, do not weaken the test.');
    process.exit(1);
  }
  // Brace-match from the method's OWN `{`, not from the marker start.
  let depth = 0;
  let end = -1;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) { console.error(`FATAL: unbalanced braces slicing ${what}`); process.exit(1); }
  return src.slice(start, end);
}

const STAMP_SRC = sliceMethod('\n  async _stampHubInvites(', '_stampHubInvites');
const GUARD_SRC = sliceMethod('\n  async _optionalYpProc(', '_optionalYpProc');

// Sanity-check that we sliced what we think we did. A silent mis-slice would
// make every case below pass against the wrong code.
for (const needed of ['hub_invite_received', 'resolveHubInviteName', '_optionalYpProc',
  'push_workspace_name', 'MAX_LOOKUPS']) {
  if (!STAMP_SRC.includes(needed)) {
    console.error(`FATAL: sliced _stampHubInvites is missing ${needed} — slicer is wrong`);
    process.exit(1);
  }
}
if (!GUARD_SRC.includes('MISSING_PROCS')) {
  console.error('FATAL: sliced _optionalYpProc does not consult MISSING_PROCS');
  process.exit(1);
}

// Faithful to lib/utils/index.js toArray() for the shapes fed below.
const toArray = (a) => {
  if (a == null) return [];
  if (Array.isArray(a)) return a;
  if (typeof a === 'object' && Object.keys(a).length === 0) return [];
  return [a];
};

// Build a stub `this` carrying the REAL method and the REAL guard.
// `names` maps hub_id -> workspace_name; a value of Error means the call throws,
// `undefined` means the routine is not deployed (await_proc answers undefined).
function harness({ names = {}, deployed = true, stampSrc = STAMP_SRC } = {}) {
  const calls = [];
  const impl = (new Function(
    'resolveHubInviteName',
    `return { ${stampSrc} };`,
  ))(resolveHubInviteName);
  const guard = (new Function(
    'toArray', 'MISSING_PROCS', 'PROC_RETRY_MS',
    `return { ${GUARD_SRC} };`,
    // A fresh Map per harness: MISSING_PROCS is process-wide in production, but
    // sharing it across cases would let one "not deployed" verdict silence the rest.
  ))(toArray, new Map(), 60 * 1000);

  const ctx = {
    calls,
    debug() { },
    warn() { },
    yp: {
      async await_proc(name, ...args) {
        calls.push([name, ...args]);
        if (!deployed) return undefined;
        if (name !== 'push_workspace_name') return undefined;
        const v = names[args[0]];
        if (v instanceof Error) throw v;
        if (v === undefined) return [];
        return [{ workspace_name: v }];
      },
    },
    _optionalYpProc: guard._optionalYpProc,
    _stampHubInvites: impl._stampHubInvites,
  };
  return ctx;
}

const HUB = 'aaaa1111aaaa1112';
const INVITER = 'bbbb2222bbbb2223';

// A row exactly as activity_get_feed_all's contact branch returns it.
function feedRow(over = {}) {
  const meta = Object.assign({
    hub_id: HUB,
    hub_name: 'Marketing',
    message: 'Lexis added you to team Marketing.',
    from_fullname: 'Lexis ',
    privilege: 3,
  }, over.meta || {});
  delete over.meta;
  return Object.assign({
    id: 705,
    timestamp: 1757308369,
    uid: INVITER,
    event: 'hub_invite_received',
    event_type: 'contact',
    data: JSON.stringify(meta),
    is_read: 0,
    firstname: 'Lexis',
    lastname: '',
    fullname: 'Lexis ',
    hub_id: null,
    hub_db_name: null,
    category: null,
    key_id: null,
    last_id: null,
    history_id: null,
  }, over);
}

// ---------------------------------------------------------------------------
// 1. The reported bug: the row must stop resolving to the contact category.
// ---------------------------------------------------------------------------
async function suite(stampSrc = STAMP_SRC, quiet = false) {
  const before = { passed, failed };
  const C = quiet
    ? (label, got, want) => {
      const ok = JSON.stringify(got) === JSON.stringify(want);
      if (ok) passed++; else { failed++; failures.push(`[NC] ${label}`); }
      return ok;
    }
    : check;

  // The client resolves the category as `category || event_type || type`.
  const clientCategory = (r) => r.category || r.event_type || r.type || null;

  {
    const h = harness({ names: { [HUB]: 'Marketing' }, stampSrc });
    const rows = [feedRow()];
    await h._stampHubInvites.call(h, rows);
    const r = rows[0];
    C('A1 category is stamped', r.category, 'hub_invite');
    C('A2 the client no longer resolves it as a contact request',
      clientCategory(r), 'hub_invite');
    // Load-bearing for the "clicking it led nowhere" half of the report: the
    // desk's notification opener refuses a row that carries no hub_id.
    C('A3 workspace id is surfaced for the click target', r.hub_id, HUB);
    C('A4 the inviter owns the avatar', r.author_id, INVITER);
    C('A5 the sentence gets the workspace name', r.hub_name, 'Marketing');
    C('A6 event_type is untouched (the delete filter matches on it)',
      r.event_type, 'contact');
    C('A7 the row id is untouched (dismiss + bookmark identity)', r.id, 705);
    C('A8 no internal resolver field leaks into the published row shape',
      'hub_live_name' in r, false);
  }

  // ---------------------------------------------------------------------------
  // 2. The name chain. hub.add_contributors / hub.invite_with_roles record
  //    yp.hub.hubname -- the hex id -- as the invite's hub_name, so the stored
  //    name is not a usable label and the LIVE name has to win.
  // ---------------------------------------------------------------------------
  {
    const h = harness({ names: { [HUB]: 'Marketing' }, stampSrc });
    const rows = [feedRow({ meta: { hub_name: HUB } })];
    await h._stampHubInvites.call(h, rows);
    C('B1 a hex id stored as the name is replaced by the live name',
      rows[0].hub_name, 'Marketing');
  }
  {
    // The live name WINS over a stale stored name (the workspace was renamed).
    const h = harness({ names: { [HUB]: 'Growth' }, stampSrc });
    const rows = [feedRow()];
    await h._stampHubInvites.call(h, rows);
    C('B2 a renamed workspace shows its current name', rows[0].hub_name, 'Growth');
  }
  {
    // Routine not applied on this deployment: degrade to the invite-time name.
    const h = harness({ deployed: false, stampSrc });
    const rows = [feedRow()];
    await h._stampHubInvites.call(h, rows);
    C('C1 an undeployed routine degrades to the stored name',
      rows[0].hub_name, 'Marketing');
    C('C2 and the category is still fixed', rows[0].category, 'hub_invite');
  }
  {
    // Deployed but the workspace is gone (deleted): no live name, stored name wins.
    const h = harness({ names: {}, stampSrc });
    const rows = [feedRow()];
    await h._stampHubInvites.call(h, rows);
    C('C3 a deleted workspace falls back to the stored name',
      rows[0].hub_name, 'Marketing');
  }
  {
    // Nothing resolves: render NO name rather than the hex id.
    const h = harness({ names: {}, stampSrc });
    const rows = [feedRow({ meta: { hub_name: HUB } })];
    await h._stampHubInvites.call(h, rows);
    C('D1 the hex id is never rendered as a workspace name',
      rows[0].hub_name, undefined);
    C('D2 the row is still an invitation', rows[0].category, 'hub_invite');
  }
  {
    const h = harness({ names: { [HUB]: '   Marketing  ' }, stampSrc });
    const rows = [feedRow({ meta: { hub_name: HUB } })];
    await h._stampHubInvites.call(h, rows);
    C('D3 the live name is trimmed', rows[0].hub_name, 'Marketing');
  }
  {
    const h = harness({ names: { [HUB]: '   ' }, stampSrc });
    const rows = [feedRow()];
    await h._stampHubInvites.call(h, rows);
    C('D4 a blank live name is not a name', rows[0].hub_name, 'Marketing');
  }

  // ---------------------------------------------------------------------------
  // 3. Row shapes the feed actually carries.
  // ---------------------------------------------------------------------------
  {
    // Some drivers hand back `data` already parsed.
    const h = harness({ names: { [HUB]: 'Marketing' }, stampSrc });
    const rows = [feedRow({ data: { hub_id: HUB, hub_name: 'Marketing' } })];
    await h._stampHubInvites.call(h, rows);
    C('E1 an object `data` works like a string one', rows[0].hub_name, 'Marketing');
    C('E2 and still yields the workspace id', rows[0].hub_id, HUB);
  }
  {
    const h = harness({ names: { [HUB]: 'Marketing' }, stampSrc });
    const rows = [feedRow({ data: '{not json' })];
    await h._stampHubInvites.call(h, rows);
    C('F1 malformed JSON does not throw, and the row is still an invitation',
      rows[0].category, 'hub_invite');
    C('F2 with no name rather than a wrong one', rows[0].hub_name, undefined);
    C('F3 and no workspace id invented', rows[0].hub_id, null);
  }
  {
    const h = harness({ names: { [HUB]: 'Marketing' }, stampSrc });
    const rows = [feedRow({ data: null })];
    await h._stampHubInvites.call(h, rows);
    C('F4 a null `data` does not throw', rows[0].category, 'hub_invite');
  }

  // ---------------------------------------------------------------------------
  // 4. ADD-ONLY. The Unread-ON path merges rollup rows that already carry all of
  //    this (mapHubInviteRow); they must pass through byte-identical.
  // ---------------------------------------------------------------------------
  {
    const rollup = {
      category: 'hub_invite', key_id: '705', hub_id: HUB, last_id: 705, cnt: 1,
      ctime: 1757308369, firstname: 'Lexis', lastname: '', surname: 'Lexis ',
      email: 'lexis@drumee.org', author_id: INVITER, hub_name: 'Marketing',
    };
    const snapshot = JSON.stringify(rollup);
    const h = harness({ names: { [HUB]: 'Renamed' }, stampSrc });
    await h._stampHubInvites.call(h, [rollup]);
    C('G1 a rollup invite row is untouched', JSON.stringify(rollup), snapshot);
    C('G2 and costs no lookup', h.calls.length, 0);
  }
  {
    // A row that somehow already carries the fields keeps its own values.
    const h = harness({ names: { [HUB]: 'Live' }, stampSrc });
    const rows = [feedRow({ hub_id: 'cccc3333cccc3334', author_id: 'dddd4444dddd4445' })];
    await h._stampHubInvites.call(h, rows);
    C('G3 an existing hub_id is not overwritten', rows[0].hub_id, 'cccc3333cccc3334');
    C('G4 an existing author_id is not overwritten', rows[0].author_id, 'dddd4444dddd4445');
  }

  // ---------------------------------------------------------------------------
  // 5. Every other row on the feed must come out exactly as it went in.
  // ---------------------------------------------------------------------------
  {
    const others = [
      // a contact invitation — this is the row whose copy the bug borrowed
      {
        id: 700, uid: INVITER, event: 'contact.invite', event_type: 'contact',
        category: null, hub_id: null, data: JSON.stringify({ msg: 'hi' }),
      },
      // a task assignment (same table, own renderer branch)
      {
        id: 701, uid: INVITER, event: 'task_assigned', event_type: 'contact',
        category: null, hub_id: null,
        data: JSON.stringify({ hub_id: HUB, title: 'Ship it' }),
      },
      // a scheduled-meeting notice
      {
        id: 702, uid: INVITER, event: 'meeting_notice', event_type: 'contact',
        category: null, hub_id: null,
        data: JSON.stringify({ hub_id: HUB, kind: 'invite', title: 'Standup' }),
      },
      // an ordinary file event
      {
        id: 703, uid: INVITER, event: 'media.new', event_type: 'mfs',
        category: null, hub_id: HUB, data: null,
      },
      // an mfs_get_activity_feed row: no category, no event_type at all
      { id: 704, uid: INVITER, event: 'media.share', hub_id: HUB },
      // the acceptance half of a contact handshake
      {
        id: 706, uid: INVITER, event: 'contact.accept_informed', event_type: 'contact',
        category: null, hub_id: null, data: null,
      },
    ];
    const snapshot = JSON.stringify(others);
    const h = harness({ names: { [HUB]: 'Marketing' }, stampSrc });
    await h._stampHubInvites.call(h, others);
    C('H1 no other feed row is touched', JSON.stringify(others), snapshot);
    C('H2 and no lookup is spent on them', h.calls.length, 0);
  }

  // ---------------------------------------------------------------------------
  // 6. Cost. One lookup per DISTINCT workspace, hard-capped.
  // ---------------------------------------------------------------------------
  {
    const A = 'aaaa0000aaaa0001';
    const B = 'bbbb0000bbbb0001';
    const rows = [
      feedRow({ id: 1, meta: { hub_id: A, hub_name: A } }),
      feedRow({ id: 2, meta: { hub_id: A, hub_name: A } }),
      feedRow({ id: 3, meta: { hub_id: B, hub_name: B } }),
      feedRow({ id: 4, meta: { hub_id: A, hub_name: A } }),
      feedRow({ id: 5, meta: { hub_id: B, hub_name: B } }),
    ];
    const h = harness({ names: { [A]: 'Alpha', [B]: 'Beta' }, stampSrc });
    await h._stampHubInvites.call(h, rows);
    C('I1 five rows over two workspaces cost two lookups', h.calls.length, 2);
    C('I2 every row still gets its own name',
      rows.map((r) => r.hub_name), ['Alpha', 'Alpha', 'Beta', 'Alpha', 'Beta']);
  }
  {
    const many = [];
    const names = {};
    for (let i = 0; i < 20; i++) {
      const id = `hub${String(i).padStart(13, '0')}`;
      names[id] = `WS${i}`;
      many.push(feedRow({ id: 100 + i, meta: { hub_id: id, hub_name: `stored${i}` } }));
    }
    const h = harness({ names, stampSrc });
    await h._stampHubInvites.call(h, many);
    C('I3 the lookup count is capped', h.calls.length <= 12, true);
    C('I4 every row is still an invitation',
      many.every((r) => r.category === 'hub_invite'), true);
    C('I5 rows past the cap fall back to the stored name rather than going blank',
      many.every((r) => typeof r.hub_name === 'string' && r.hub_name.length > 0), true);
  }

  // ---------------------------------------------------------------------------
  // 7. Failure never reaches the feed.
  // ---------------------------------------------------------------------------
  {
    const h = harness({ names: { [HUB]: new Error('ER_LOCK_WAIT_TIMEOUT') }, stampSrc });
    const rows = [feedRow()];
    let threw = null;
    try { await h._stampHubInvites.call(h, rows); } catch (e) { threw = e.message; }
    C('J1 a throwing lookup is swallowed', threw, null);
    C('J2 and the row degrades to the stored name', rows[0].hub_name, 'Marketing');
    C('J3 and is still an invitation', rows[0].category, 'hub_invite');
  }
  {
    const h = harness({ stampSrc });
    let threw = null;
    try {
      await h._stampHubInvites.call(h, []);
      await h._stampHubInvites.call(h, null);
      await h._stampHubInvites.call(h, [null, undefined]);
    } catch (e) { threw = e.message; }
    C('J4 empty / null / holey input does not throw', threw, null);
  }

  // ---------------------------------------------------------------------------
  // 8. Idempotence — the method runs once per feed today, but a second pass must
  //    change nothing (that is what makes it safe to move in the pipeline).
  // ---------------------------------------------------------------------------
  {
    const h = harness({ names: { [HUB]: 'Marketing' }, stampSrc });
    const rows = [feedRow()];
    await h._stampHubInvites.call(h, rows);
    const once = JSON.stringify(rows);
    await h._stampHubInvites.call(h, rows);
    C('K1 a second pass is a no-op', JSON.stringify(rows), once);
  }

  // ---------------------------------------------------------------------------
  // 9. Identity must not move. A saved ("bookmarked") notification is addressed
  //    by bookmarkKey(row), and stamping a category changes what that function
  //    reads. If the hash moved, every invitation a user had saved would come
  //    back unsaved. Run against the REAL exported function.
  // ---------------------------------------------------------------------------
  {
    const Activity = require('../../service/private/activity');
    const raw = feedRow();
    const preFix = Activity.bookmarkKey(raw);
    const h = harness({ names: { [HUB]: 'Marketing' }, stampSrc });
    await h._stampHubInvites.call(h, [raw]);
    const postFix = Activity.bookmarkKey(raw);
    const rollup = Activity.bookmarkKey({
      category: 'hub_invite', key_id: '705', hub_id: HUB,
    });
    C('M1 the saved-notification identity does not move', postFix, preFix);
    C('M2 and still matches the Unread-ON representation of the same invite',
      postFix, rollup);
    C('M3 (a real sha256, not two undefineds comparing equal)',
      typeof postFix === 'string' && postFix.length === 64, true);
  }

  // ---------------------------------------------------------------------------
  // 10. The tab must not move. bucketOf() reads `category` before `event_type`,
  //     so stamping one could have relocated every workspace invitation to a
  //     different Notification Center tab. Run against the REAL mapper, sliced
  //     out of the same module (the same block notification-bucket.test.js uses).
  // ---------------------------------------------------------------------------
  {
    const bStart = src.indexOf('\nconst BUCKET = {');
    const bEnd = src.indexOf('\nfunction validBucket(value) {');
    if (bStart < 0 || bEnd < 0 || bEnd < bStart) {
      console.error('FATAL: could not locate the bucket block — fix this slicer');
      process.exit(1);
    }
    const block = src.slice(bStart, bEnd);
    if (!block.includes('function bucketOf(row)')) {
      console.error('FATAL: sliced bucket block has no bucketOf — slicer is wrong');
      process.exit(1);
    }
    // Newline, not `;` — the block ends on a line comment, which would swallow it.
    const bucketOf = (new Function(`${block}\nreturn bucketOf;`))();

    const raw = feedRow();
    const preFix = bucketOf(raw);
    const h = harness({ names: { [HUB]: 'Marketing' }, stampSrc });
    await h._stampHubInvites.call(h, [raw]);
    C('N1 the invitation stays in the same tab', bucketOf(raw), preFix);
    C('N2 which is Other, the tab that owns member invites', preFix, 'other');
    // 'other' is also bucketOf's default, so N1/N2 could both pass against a
    // mapper that answered 'other' to everything. Prove it discriminates.
    C('N3 (the mapper is not a constant)',
      bucketOf({ event: 'media.new', event_type: 'mfs' }), 'files');
  }

  // ---------------------------------------------------------------------------
  // 11. Anti-drift invariants, asserted against the SOURCE.
  //
  // These cannot be reached by feeding rows in -- no producer emits a row that
  // would exercise them -- but each is a contract a later edit could break
  // silently, so they are checked statically rather than not at all.
  // ---------------------------------------------------------------------------
  {
    C('L1 the category stamp stays add-only (never clobbers a row that has one)',
      /if\s*\(!r\.category\)\s*r\.category\s*=\s*'hub_invite'/.test(stampSrc), true);
    C('L2 event_type is never rewritten (the delete filter matches on it)',
      /r\.event_type\s*=/.test(stampSrc), false);
    C('L3 the name comes only from the shared resolver, never an inline chain',
      (stampSrc.match(/r\.hub_name\s*=(?!=)/g) || []).length === 1
      && /r\.hub_name\s*=\s*name\s*;/.test(stampSrc), true);
    C('L4 get_feed actually calls it (otherwise the whole fix is dead code)',
      /await this\._stampHubInvites\(result\);/.test(src), true);
  }

  return { added: passed - before.passed + (failed - before.failed) };
}

// ---------------------------------------------------------------------------
// Negative controls. Each reintroduces one specific mistake into the sliced
// SOURCE and asserts the suite goes red. A control that stays green means the
// case it targets is not really testing that line.
// ---------------------------------------------------------------------------
async function negativeControls() {
  const controls = [
    ['NC1 category is never stamped',
      (s) => s.replace("if (!r.category) r.category = 'hub_invite';", '')],
    ['NC2 category is stamped unconditionally (breaks the add-only contract)',
      (s) => s.replace("if (!r.category) r.category = 'hub_invite';", "r.category = 'hub_invite';")],
    ['NC2b the name is built inline instead of through the shared resolver',
      (s) => s.replace('if (name) r.hub_name = name;',
        "r.hub_name = live || (meta.hub_name !== meta.hub_id ? meta.hub_name : null);")],
    ['NC3 the workspace id is not surfaced',
      (s) => s.replace('if (r.hub_id == null && meta.hub_id != null) r.hub_id = meta.hub_id;', '')],
    ['NC4 the inviter is not surfaced',
      (s) => s.replace('if (r.author_id == null && r.uid != null) r.author_id = r.uid;', '')],
    ['NC5 the event guard is dropped (every contact row becomes an invite)',
      (s) => s.replace("if (!r || r.event !== 'hub_invite_received') continue;", 'if (!r) continue;')],
    ['NC6 the live name never reaches the resolver (stored name wins)',
      (s) => s.replace('live ? Object.assign({}, r, { hub_live_name: live }) : r,', 'r,')],
    ['NC7 the lookup cap is removed',
      (s) => s.replace('&& wanted.size < MAX_LOOKUPS', '')],
    ['NC8 lookups are not deduped per workspace',
      (s) => s.replace('const wanted = new Set();', 'const wanted = [];')
        .replace('wanted.add(meta.hub_id);', 'wanted.push(meta.hub_id);')
        .replace('wanted.size < MAX_LOOKUPS', 'wanted.length < MAX_LOOKUPS')
        .replace('if (!targets.length) return;', 'if (!targets.length) return;')],
  ];

  let caught = 0;

  // L4 is asserted against the whole file rather than the sliced method, so it
  // gets its own control: strip the call out of a COPY of the file and prove the
  // invariant notices.
  {
    const stripped = src.replace(/\n\s*await this\._stampHubInvites\(result\);/, '');
    const noticed = stripped !== src && !/await this\._stampHubInvites\(result\);/.test(stripped);
    if (noticed) { caught++; console.log('  ✓ NC9 get_feed no longer calls it — CAUGHT'); }
    else {
      console.log('  ✗ NC9 get_feed no longer calls it — NOT CAUGHT');
      failed++; failures.push('NC9 — NOT CAUGHT');
    }
  }

  for (const [label, mutate] of controls) {
    const mutated = mutate(STAMP_SRC);
    if (mutated === STAMP_SRC) {
      console.log(`  ✗ ${label} — MUTATION DID NOT APPLY (the slicer or the code moved)`);
      failed++;
      failures.push(`${label}: mutation did not apply`);
      continue;
    }
    const before = { passed, failed };
    let broke = false;
    try {
      await suite(mutated, true);
      broke = failed > before.failed;
    } catch (e) {
      broke = true; // a crash is a failure too
    }
    // Roll the counters back: a negative control's own result is not a test result.
    passed = before.passed;
    failed = before.failed;
    // Drop the messages the quiet suite pushed: a control's own red is expected.
    while (failures.length && failures[failures.length - 1].startsWith('[NC]')) failures.pop();
    if (broke) { caught++; console.log(`  ✓ ${label} — CAUGHT`); }
    else { console.log(`  ✗ ${label} — NOT CAUGHT`); failed++; failures.push(label + ' — NOT CAUGHT'); }
  }
  return caught;
}

(async () => {
  console.log('hub-invite feed row — "invited you to <workspace>", not "wants to connect"\n');
  await suite();
  console.log('\nnegative controls (each must break the suite):');
  const caught = await negativeControls();

  const after = require('crypto').createHash('md5')
    .update(fs.readFileSync(SERVICE_FILE, 'utf8')).digest('hex');
  check('Z1 the working tree was never modified', after, MD5_BEFORE);

  console.log('');
  for (const f of failures) console.log('  ✗ ' + f);
  console.log(`\n${passed} passed, ${failed} failed, ${caught} negative controls caught.`);
  process.exit(failed ? 1 : 0);
})();
