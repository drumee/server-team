#!/usr/bin/env node
//
// hub-invite-status.test.js
//
// After a workspace invitation is answered, its notification must stop offering
// Accept and Decline. It did not (Duy, 2026-09-23): the answer only dismisses
// the row, the row keeps its token, and the client drew the buttons for any row
// with a token — so after Decline the row came back unchanged, Decline did
// nothing and Accept reported an invalid link.
//
// The feed now stamps `invite_status` from the token. This exercises:
//   1. the REAL hubInviteStatus (service/lib/hub-invite-status.js), and
//   2. the REAL _stampInviteStatus, sliced out of service/private/activity.js
//      and run against a stub yp.
//
// It ends with negative controls: each mutates the sliced SOURCE STRING in
// memory (never the file) to reintroduce a specific mistake and asserts that a
// named case goes red. A test that cannot fail proves nothing.
//
//   node offline/test/hub-invite-status.test.js
//
// Exit code 0 = all pass, 1 = any failure.

const fs = require('fs');
const path = require('path');

const SERVICE_FILE = path.join(__dirname, '..', '..', 'service', 'private', 'activity.js');
const src = fs.readFileSync(SERVICE_FILE, 'utf8');
const { hubInviteStatus } = require('../../service/lib/hub-invite-status');
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

const HUB = 'aaaa1111aaaa1112';
const OTHER_HUB = 'cccc3333cccc3334';
const NOW = 1_800_000_000;

function token(over = {}) {
  return Object.assign({
    secret: 'sec-1',
    method: `hub_invite:${HUB}`,
    status: 'active',
    expiry: NOW + 3600,
  }, over);
}

// ---------------------------------------------------------------------------
// 1. hubInviteStatus
// ---------------------------------------------------------------------------
check('S1 active, not expired -> pending', hubInviteStatus(token(), HUB, NOW), 'pending');
check('S2 active, expiry 0 (never) -> pending', hubInviteStatus(token({ expiry: 0 }), HUB, NOW), 'pending');
check('S3 active, expiry null -> pending', hubInviteStatus(token({ expiry: null }), HUB, NOW), 'pending');
check('S4 active, past expiry -> expired', hubInviteStatus(token({ expiry: NOW - 1 }), HUB, NOW), 'expired');
check('S5 active, exactly at expiry -> pending (accept_invite uses now > expiry)',
  hubInviteStatus(token({ expiry: NOW }), HUB, NOW), 'pending');
check('S6 declined -> declined', hubInviteStatus(token({ status: 'declined', expiry: 0 }), HUB, NOW), 'declined');
check('S7 accepted -> accepted', hubInviteStatus(token({ status: 'accepted' }), HUB, NOW), 'accepted');
check('S8 accepted, long expired -> still accepted', hubInviteStatus(token({ status: 'accepted', expiry: NOW - 999 }), HUB, NOW), 'accepted');
check('S9 no token row -> invalid', hubInviteStatus(null, HUB, NOW), 'invalid');
check('S10 empty row -> invalid', hubInviteStatus({}, HUB, NOW), 'invalid');
check('S11 not a hub_invite token -> invalid', hubInviteStatus(token({ method: 'signup' }), HUB, NOW), 'invalid');
check('S12 token for ANOTHER workspace -> invalid', hubInviteStatus(token(), OTHER_HUB, NOW), 'invalid');
check('S13 row without hub_id is not rejected on that alone', hubInviteStatus(token(), undefined, NOW), 'pending');
check('S14 unknown status -> invalid', hubInviteStatus(token({ status: 'revoked' }), HUB, NOW), 'invalid');
check('S15 expiry as a string (driver shape) still compares',
  hubInviteStatus(token({ expiry: String(NOW - 5) }), HUB, NOW), 'expired');

// ---------------------------------------------------------------------------
// 2. _stampInviteStatus, sliced from the service
// ---------------------------------------------------------------------------
function sliceMethod(marker, what) {
  const start = src.indexOf(marker);
  if (start < 0) {
    console.error(`FATAL: could not find ${what} in ${SERVICE_FILE}`);
    process.exit(1);
  }
  let depth = 0;
  let end = -1;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) { console.error(`FATAL: unbalanced braces slicing ${what}`); process.exit(1); }
  return src.slice(start, end);
}

const STAMP_SRC = sliceMethod('\n  async _stampInviteStatus(', '_stampInviteStatus');
for (const needed of ['token_get_next', 'hubInviteStatus', 'MAX_LOOKUPS', 'invite_status']) {
  if (!STAMP_SRC.includes(needed)) {
    console.error(`FATAL: sliced _stampInviteStatus is missing ${needed} — slicer is wrong`);
    process.exit(1);
  }
}
// And it must actually be called by get_feed, right after _stampHubInvites.
if (!/await this\._stampHubInvites\(result\);\s*\n\s*await this\._stampInviteStatus\(result\);/.test(src)) {
  console.error('FATAL: get_feed does not call _stampInviteStatus right after _stampHubInvites');
  process.exit(1);
}

const toArray = (a) => {
  if (a == null) return [];
  if (Array.isArray(a)) return a;
  if (typeof a === 'object' && Object.keys(a).length === 0) return [];
  return [a];
};

// `tokens` maps secret -> row | Error (throws) | undefined-marker (call failed)
const FAILED = Symbol('failed');
function harness(tokens = {}, stampSrc = STAMP_SRC) {
  const calls = [];
  const impl = (new Function('hubInviteStatus', 'toArray', `return { ${stampSrc} };`))(
    (row, hub, now) => hubInviteStatus(row, hub, now), toArray,
  );
  return {
    calls,
    debug() { },
    yp: {
      async await_proc(name, secret) {
        calls.push([name, secret]);
        const v = tokens[secret];
        if (v instanceof Error) throw v;
        if (v === FAILED) return undefined;
        if (v === undefined) return {};       // no such token: empty result
        return v;                              // single row comes back as an object
      },
    },
    _stampInviteStatus: impl._stampInviteStatus,
  };
}

function inviteRow(secret, over = {}) {
  return Object.assign({ category: 'hub_invite', hub_id: HUB, invite_token: secret }, over);
}

(async () => {
  const realNow = Date.now;
  Date.now = () => NOW * 1000;
  try {
    // T1 the Duy case: a declined invitation stops being answerable
    {
      const h = harness({ d: token({ secret: 'd', status: 'declined', expiry: 0 }) });
      const rows = [inviteRow('d')];
      await h._stampInviteStatus(rows);
      check('T1 declined row -> declined', rows[0].invite_status, 'declined');
    }
    // T2 each status reaches the row
    {
      const h = harness({
        p: token({ secret: 'p' }),
        a: token({ secret: 'a', status: 'accepted' }),
        e: token({ secret: 'e', expiry: NOW - 10 }),
      });
      const rows = [inviteRow('p'), inviteRow('a'), inviteRow('e'), inviteRow('gone')];
      await h._stampInviteStatus(rows);
      check('T2 statuses', rows.map((r) => r.invite_status), ['pending', 'accepted', 'expired', 'invalid']);
    }
    // T3 one lookup per DISTINCT token, both rows stamped (Unread-ON rollup + raw row)
    {
      const h = harness({ d: token({ secret: 'd', status: 'declined' }) });
      const rows = [inviteRow('d'), inviteRow('d')];
      await h._stampInviteStatus(rows);
      check('T3 one call for a repeated token', h.calls.length, 1);
      check('T3 both rows stamped', rows.map((r) => r.invite_status), ['declined', 'declined']);
    }
    // T4 rows that are not answerable invitations are untouched and cost nothing
    {
      const h = harness();
      const receipt = { category: 'hub_invite', hub_id: HUB };             // add_contributors receipt
      const file = { category: 'mfs', invite_token: 'x' };                  // wrong category
      const before = JSON.stringify([receipt, file]);
      await h._stampInviteStatus([receipt, file, null]);
      check('T4 no lookups', h.calls.length, 0);
      check('T4 rows byte-identical', JSON.stringify([receipt, file]), before);
    }
    // T5 a call that FAILED leaves the row without a status (client falls back)
    {
      const h = harness({ f: FAILED, t: new Error('boom') });
      const rows = [inviteRow('f'), inviteRow('t')];
      await h._stampInviteStatus(rows);
      check('T5 failed lookup -> no field', rows.map((r) => 'invite_status' in r), [false, false]);
    }
    // T6 add-only: an existing status is never overwritten
    {
      const h = harness({ d: token({ secret: 'd', status: 'declined' }) });
      const rows = [inviteRow('d', { invite_status: 'accepted' })];
      await h._stampInviteStatus(rows);
      check('T6 existing field kept', rows[0].invite_status, 'accepted');
      check('T6 no lookup', h.calls.length, 0);
    }
    // T7 the cap: beyond MAX_LOOKUPS distinct tokens, rows are left unstamped
    {
      const tokens = {};
      const rows = [];
      for (let i = 0; i < 25; i++) {
        tokens[`s${i}`] = token({ secret: `s${i}` });
        rows.push(inviteRow(`s${i}`));
      }
      const h = harness(tokens);
      await h._stampInviteStatus(rows);
      check('T7 capped at 20 calls', h.calls.length, 20);
      check('T7 first 20 stamped, rest untouched',
        rows.map((r) => 'invite_status' in r),
        Array.from({ length: 25 }, (_, i) => i < 20));
    }
    // T8 token of a different workspace than the row names -> invalid
    {
      const h = harness({ x: token({ secret: 'x', method: `hub_invite:${OTHER_HUB}` }) });
      const rows = [inviteRow('x')];
      await h._stampInviteStatus(rows);
      check('T8 mismatched workspace -> invalid', rows[0].invite_status, 'invalid');
    }
    // T9 empty / non-array input is a no-op
    {
      const h = harness();
      await h._stampInviteStatus([]);
      await h._stampInviteStatus(null);
      check('T9 no calls', h.calls.length, 0);
    }

    // -----------------------------------------------------------------------
    // Negative controls
    // -----------------------------------------------------------------------
    async function mustFail(label, from, to, run) {
      if (!STAMP_SRC.includes(from)) {
        failed++; failures.push(`NC ${label}: mutation anchor not found`); return;
      }
      const before = failed;
      const savedFailures = failures.length;
      await run(STAMP_SRC.replace(from, to));
      const wentRed = failed > before;
      failed = before; failures.length = savedFailures;
      if (wentRed) passed++;
      else { failed++; failures.push(`NC ${label}: mutation did NOT turn the case red`); }
    }

    await mustFail('treating a failed call as "no token"', 'if (res === undefined) continue;', '', async (s) => {
      const h = harness({ f: FAILED }, s);
      const rows = [inviteRow('f')];
      await h._stampInviteStatus(rows);
      check('NC1', 'invite_status' in rows[0], false);
    });
    await mustFail('overwriting an existing status', 'if (r.invite_status != null) continue;', '', async (s) => {
      const h = harness({ d: token({ secret: 'd', status: 'declined' }) }, s);
      const rows = [inviteRow('d', { invite_status: 'accepted' })];
      await h._stampInviteStatus(rows);
      check('NC2', rows[0].invite_status, 'accepted');
    });
    await mustFail('dropping the lookup cap', 'byToken.size < MAX_LOOKUPS', 'true', async (s) => {
      const tokens = {}; const rows = [];
      for (let i = 0; i < 25; i++) { tokens[`s${i}`] = token({ secret: `s${i}` }); rows.push(inviteRow(`s${i}`)); }
      const h = harness(tokens, s);
      await h._stampInviteStatus(rows);
      check('NC3', h.calls.length, 20);
    });
  } finally {
    Date.now = realNow;
  }

  const MD5_AFTER = require('crypto').createHash('md5')
    .update(fs.readFileSync(SERVICE_FILE, 'utf8')).digest('hex');
  check('service file untouched by the test', MD5_AFTER, MD5_BEFORE);

  console.log(`\nhub-invite-status: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\n' + failures.map((f) => '✗ ' + f).join('\n'));
    process.exit(1);
  }
})();
