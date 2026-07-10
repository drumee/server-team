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
 * Regression tests for the secure-share SESSION-SECURITY invariants introduced by
 * the 2026-07-10 hotfixes (Lexis prod issues #3 + #4):
 *
 *   #3  A secure-share open must NEVER rebind the recipient's main-domain `regsid`
 *       auth session to the share creator (account takeover on app.drumee.com).
 *   #4  A file-share recipient must operate as THEMSELVES (chat/downloads), and the
 *       DMZ listing must be token-scoped + hard-filtered to the shared file so it
 *       neither breaks viewing nor exposes sibling files.
 *
 * Two layers of coverage, both runnable with plain `node` (no DB / no framework):
 *   1. BEHAVIOURAL — exercises the real capability-enforcement code
 *      (service/lib/secure-share-write-guard.js) with a mocked `yp`, proving a
 *      view-only recipient can never write/download, etc.
 *   2. SOURCE INVARIANTS — asserts the structural guards remain in place in
 *      dmz.js / page.js / media.js, so a future refactor that silently drops one
 *      fails CI instead of re-opening the hole.
 *
 * Standalone runner (no test framework in this repo): `node <thisfile>`.
 * Exits 0 on success, 1 on first failure.
 */

const assert = require('assert');
const { readFileSync } = require('fs');
const { join } = require('path');

const {
  secureShareCapVerdict,
  secureShareCapPrivilege,
  secureShareWriteVerdict,
} = require('../../service/lib/secure-share-write-guard');

const REPO_ROOT = join(__dirname, '..', '..');
const src = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');

// A `yp` stub: returns the given secure_share_info row and access grants for the
// two stored procedures the guard calls; everything else resolves empty.
function mockYp({ info, grants = [] } = {}) {
  return {
    await_proc: async (proc) => {
      if (proc === 'secure_share_info') return info ? [info] : [];
      if (proc === 'secure_share_get_access_grant') return grants;
      return [];
    },
  };
}

// A valid TICKET_OK secure share with the given capability set (can_view is implicit).
const share = (capabilities, extra = {}) => ({
  failed: 0,
  creator_id: 'CREATOR_UID',
  validity: 'TICKET_OK',
  capabilities,
  permission_level: 'can_view',
  ...extra,
});

const TOKEN = 'test-token';

const tests = [
  // ---------------------------------------------------------------------------
  // BEHAVIOURAL — capability enforcement (server-side, independent of the session)
  // ---------------------------------------------------------------------------
  ['no token → null (not a secure-share request; caller uses normal ACL)', async () => {
    assert.strictEqual(await secureShareCapVerdict(mockYp(), '', 'e@x.io', ['can_edit']), null);
    assert.strictEqual(await secureShareCapPrivilege(mockYp(), '', 'e@x.io'), null);
  }],

  ['non-secure / legacy token → null (passthrough)', async () => {
    assert.strictEqual(
      await secureShareCapVerdict(mockYp({ info: { failed: 1 } }), TOKEN, 'e@x.io', ['can_edit']),
      null
    );
  }],

  ['revoked share → false (deny)', async () => {
    const yp = mockYp({ info: share([], { validity: 'TICKET_REVOKED' }) });
    assert.strictEqual(await secureShareCapVerdict(yp, TOKEN, 'e@x.io', ['can_edit']), false);
  }],

  ['VIEW-ONLY recipient CANNOT write (upload/mkdir) → false', async () => {
    const yp = mockYp({ info: share([]) });
    assert.strictEqual(await secureShareWriteVerdict(yp, TOKEN, 'e@x.io'), false);
    assert.strictEqual(await secureShareCapVerdict(yp, TOKEN, 'e@x.io', ['can_edit']), false);
  }],

  ['VIEW-ONLY recipient CANNOT download → false', async () => {
    const yp = mockYp({ info: share([]) });
    assert.strictEqual(await secureShareCapVerdict(yp, TOKEN, 'e@x.io', ['can_download', 'can_edit']), false);
  }],

  ['can_download recipient CAN download → true', async () => {
    const yp = mockYp({ info: share(['can_download']) });
    assert.strictEqual(await secureShareCapVerdict(yp, TOKEN, 'e@x.io', ['can_download', 'can_edit']), true);
  }],

  ['can_download recipient still CANNOT write (needs can_edit) → false', async () => {
    const yp = mockYp({ info: share(['can_download']) });
    assert.strictEqual(await secureShareWriteVerdict(yp, TOKEN, 'e@x.io'), false);
  }],

  ['can_edit recipient CAN write → true', async () => {
    const yp = mockYp({ info: share(['can_edit']) });
    assert.strictEqual(await secureShareWriteVerdict(yp, TOKEN, 'e@x.io'), true);
  }],

  ['view-only base + APPROVED can_edit grant → write allowed (grant union)', async () => {
    const yp = mockYp({ info: share([]), grants: [{ granted_level: 'can_edit' }] });
    assert.strictEqual(await secureShareWriteVerdict(yp, TOKEN, 'e@x.io'), true);
  }],

  ['grant is keyed by email: anonymous (no email) does NOT inherit it → false', async () => {
    const yp = mockYp({ info: share([]), grants: [{ granted_level: 'can_edit' }] });
    assert.strictEqual(await secureShareWriteVerdict(yp, TOKEN, ''), false);
  }],

  ['capPrivilege: view-only = 3 (read/view only)', async () => {
    assert.strictEqual(await secureShareCapPrivilege(mockYp({ info: share([]) }), TOKEN, ''), 0b0000011);
  }],

  ['capPrivilege: download = 7', async () => {
    assert.strictEqual(await secureShareCapPrivilege(mockYp({ info: share(['can_download']) }), TOKEN, ''), 0b0000111);
  }],

  ['capPrivilege: edit = 15', async () => {
    assert.strictEqual(await secureShareCapPrivilege(mockYp({ info: share(['can_edit']) }), TOKEN, ''), 0b0001111);
  }],

  // ---------------------------------------------------------------------------
  // SOURCE INVARIANTS — the structural guards must stay in place. If a refactor
  // removes one, these fail loudly instead of silently re-opening the takeover.
  // ---------------------------------------------------------------------------
  ['#3 dmz.js: main-auth-session guard is computed (_isAuthSession = sid === regsid)', async () => {
    const dmz = src('service/dmz.js');
    assert.ok(
      /_isAuthSession\s*=\s*!!\(\s*regsid\s*&&\s*_activeSid\s*===\s*regsid\s*\)/.test(dmz),
      'the regsid-hijack guard predicate is missing or changed shape'
    );
  }],

  ['#3 dmz.js: cookie_touch AND ceiling are both gated on !_isAuthSession', async () => {
    const dmz = src('service/dmz.js');
    const gated = (dmz.match(/bindUid\s*&&\s*!_isAuthSession/g) || []).length;
    assert.ok(gated >= 2, `expected both bind + ceiling blocks gated on !_isAuthSession, found ${gated}`);
  }],

  ['#3 dmz.js: legacy login() also guards the regsid rebind', async () => {
    const dmz = src('service/dmz.js');
    assert.ok(
      /regsid\s*&&\s*this\.input\.sid\(\)\s*===\s*regsid/.test(dmz),
      'legacy DMZ login() is missing the regsid guard'
    );
  }],

  ['#4 dmz.js: FILE shares are NOT excluded from the recipient rebind', async () => {
    const dmz = src('service/dmz.js');
    // Anchor precisely to the BINDING block — the one that issues the secure-share
    // node grant + rebinds bindUid. (An unrelated earlier block computes
    // ownShareGrant/hasStanding and is intentionally scoped to non-file shares; we
    // must not false-flag that one.) Walk back from the grant to its controlling
    // `if (isAuthenticated && user.id ...` and assert that condition does NOT exclude
    // file shares — re-adding `!info.file_nid` here is what re-opened chat-as-creator.
    // Anchor to the grant CALL's unique signature (not the earlier message-check
    // string that also reads 'Secure share access').
    const grantIdx = dmz.indexOf("'system', 'Secure share access'");
    assert.ok(grantIdx > 0, 'secure-share permission_grant call not found');
    const condIdx = dmz.lastIndexOf('if (isAuthenticated && user.id', grantIdx);
    assert.ok(condIdx > 0, 'binding-block condition not found above the grant');
    const cond = dmz.slice(condIdx, dmz.indexOf('{', condIdx) + 1);
    assert.ok(/info\.node_id/.test(cond), 'binding block should key on info.node_id');
    assert.ok(
      !/!info\.file_nid/.test(cond),
      'the secure-share grant/rebind block must NOT exclude file shares (reopens chat-as-creator)'
    );
  }],

  ['#4 media.js: listing is token-scoped + hard-filtered to the shared file', async () => {
    const media = src('service/media.js');
    assert.ok(/_secureShareListTarget\s*\(/.test(media), 'token listing helper missing');
    assert.ok(/ssTarget\s*&&\s*ssTarget\.file_nid/.test(media), 'token-authoritative file filter missing');
  }],

  ['neutral host: page.js isolates share.<main_domain> onto a host-scoped cookie', async () => {
    const page = src('client/page.js');
    assert.ok(/isNeutralShareHost/.test(page), 'neutral-host detection missing');
    assert.ok(/share\.\$\{main_domain\}/.test(page), 'neutral-host match string missing');
    // host = this.input.host() keeps the cookie scoped to the connect host (narrower
    // than the apex) — the property that makes it un-usable as the apex auth session.
    assert.ok(/host\s*=\s*this\.input\.host\(\)/.test(page), 'host-scoping of the isolated cookie missing');
  }],
];

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
