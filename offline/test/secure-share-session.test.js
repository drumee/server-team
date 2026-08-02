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

// The behavioural tests exercise the real capability guard, which pulls in the
// private @drumee/server-essentials package. Loading it is OPTIONAL: a stock CI
// runner without `npm install` (no node_modules) can still run the source-invariant
// canaries below (they use only `fs`). When the module can't load we SKIP the
// behavioural tests rather than fail — so CI never goes red for a missing dependency,
// while the structural guards are still enforced everywhere.
let guard = null;
try {
  guard = require('../../service/lib/secure-share-write-guard');
} catch (e) {
  console.log(`  ~ behavioural tests SKIPPED (capability guard deps not installed: ${e.code || e.message})`);
}

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

// Behavioural tests need the capability guard module (private dep). Run only when it
// loaded (see `guard` above); skipped cleanly on a bare CI runner.
const behavioural = [
  // ---------------------------------------------------------------------------
  // BEHAVIOURAL — capability enforcement (server-side, independent of the session)
  // ---------------------------------------------------------------------------
  ['no token → null (not a secure-share request; caller uses normal ACL)', async () => {
    assert.strictEqual(await guard.secureShareCapVerdict(mockYp(), '', 'e@x.io', ['can_edit']), null);
    assert.strictEqual(await guard.secureShareCapPrivilege(mockYp(), '', 'e@x.io'), null);
  }],

  ['non-secure / legacy token → null (passthrough)', async () => {
    assert.strictEqual(
      await guard.secureShareCapVerdict(mockYp({ info: { failed: 1 } }), TOKEN, 'e@x.io', ['can_edit']),
      null
    );
  }],

  ['revoked share → false (deny)', async () => {
    const yp = mockYp({ info: share([], { validity: 'TICKET_REVOKED' }) });
    assert.strictEqual(await guard.secureShareCapVerdict(yp, TOKEN, 'e@x.io', ['can_edit']), false);
  }],

  ['VIEW-ONLY recipient CANNOT write (upload/mkdir) → false', async () => {
    const yp = mockYp({ info: share([]) });
    assert.strictEqual(await guard.secureShareWriteVerdict(yp, TOKEN, 'e@x.io'), false);
    assert.strictEqual(await guard.secureShareCapVerdict(yp, TOKEN, 'e@x.io', ['can_edit']), false);
  }],

  ['VIEW-ONLY recipient CANNOT download → false', async () => {
    const yp = mockYp({ info: share([]) });
    assert.strictEqual(await guard.secureShareCapVerdict(yp, TOKEN, 'e@x.io', ['can_download', 'can_edit']), false);
  }],

  ['can_download recipient CAN download → true', async () => {
    const yp = mockYp({ info: share(['can_download']) });
    assert.strictEqual(await guard.secureShareCapVerdict(yp, TOKEN, 'e@x.io', ['can_download', 'can_edit']), true);
  }],

  ['can_download recipient still CANNOT write (needs can_edit) → false', async () => {
    const yp = mockYp({ info: share(['can_download']) });
    assert.strictEqual(await guard.secureShareWriteVerdict(yp, TOKEN, 'e@x.io'), false);
  }],

  ['can_edit recipient CAN write → true', async () => {
    const yp = mockYp({ info: share(['can_edit']) });
    assert.strictEqual(await guard.secureShareWriteVerdict(yp, TOKEN, 'e@x.io'), true);
  }],

  ['view-only base + APPROVED can_edit grant → write allowed (grant union)', async () => {
    const yp = mockYp({ info: share([]), grants: [{ granted_level: 'can_edit' }] });
    assert.strictEqual(await guard.secureShareWriteVerdict(yp, TOKEN, 'e@x.io'), true);
  }],

  ['grant is keyed by email: anonymous (no email) does NOT inherit it → false', async () => {
    const yp = mockYp({ info: share([]), grants: [{ granted_level: 'can_edit' }] });
    assert.strictEqual(await guard.secureShareWriteVerdict(yp, TOKEN, ''), false);
  }],

  ['capPrivilege: view-only = 3 (read/view only)', async () => {
    assert.strictEqual(await guard.secureShareCapPrivilege(mockYp({ info: share([]) }), TOKEN, ''), 0b0000011);
  }],

  ['capPrivilege: download = 7', async () => {
    assert.strictEqual(await guard.secureShareCapPrivilege(mockYp({ info: share(['can_download']) }), TOKEN, ''), 0b0000111);
  }],

  ['capPrivilege: edit = 15', async () => {
    assert.strictEqual(await guard.secureShareCapPrivilege(mockYp({ info: share(['can_edit']) }), TOKEN, ''), 0b0001111);
  }],

];

// Source-invariant canaries use only `fs` — zero dependencies, so they run in ANY
// runner (this is the guard that can't rot: a refactor dropping a guard fails here).
const invariants = [
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
    // node grant + rebinds bindUid. (An earlier block computes ownShareGrant/
    // hasStanding; it covers BOTH share kinds — see the standing canary below — so
    // walking back from the grant must not stop at it.) Walk back from the grant to
    // its controlling
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

  ['file share: recipient gets a NON-INHERITING parent grant so the listing gate passes', async () => {
    const dmz = src('service/dmz.js');
    // A logged-in NON-member rebound to self is granted only on the shared FILE, but
    // media.show_node_by lists the file's PARENT (info.nid) and its src=anonymous ACL
    // gate resolves user_permission on that parent BEFORE the body → 0 for a non-member
    // → 403 (the reported "public file share shows no video"). The fix grants the parent
    // a read-only, NON-INHERITING ('root') grant so the gate passes WITHOUT exposing
    // siblings (parent_permission CASEs assign_via='root' → 0 for children). Removing
    // this reopens the 403; changing 'root'→'system' would leak every sibling.
    const grantIdx = dmz.indexOf("'system', 'Secure share access'");
    assert.ok(grantIdx > 0, 'file-node grant call not found');
    // The parent-traversal grant sits just after the file grant, still inside the branch.
    const after = dmz.slice(grantIdx, grantIdx + 2000);
    assert.ok(
      /info\.file_nid\s*&&\s*info\.nid\s*&&\s*info\.nid\s*!==\s*info\.node_id/.test(after),
      'parent-traversal grant must be gated on a real FILE share (file_nid set, parent !== file)'
    );
    assert.ok(
      /info\.nid,\s*user\.id,\s*0,\s*\(grantTarget\s*&\s*0b0000011\),\s*'root',\s*'Secure share access'/.test(after),
      "parent-traversal grant must be READ-ONLY (grantTarget & 0b0000011) and NON-INHERITING (assign_via='root')"
    );
  }],

  ['standing check covers FILE shares and reads the node memberPriv was measured on', async () => {
    const dmz = src('service/dmz.js');
    // memberPriv comes from mfs_access_node(user.id, info.nid) — the shared node for a
    // folder share, the PARENT for a file share. The standing check must read the
    // direct grant on THAT SAME node, because the parent-traversal grant above leaves
    // a file-share recipient a PERSISTENT 'root' grant on the parent. Skipping file
    // shares here (or reading info.node_id instead of info.nid) makes every LATER file
    // share in the same folder look like a standing membership → the node grant is
    // never issued → user_permission on the file stays 0 → mfs_show_node_by's
    // `privilege > 0` filter drops it → BLANK share (Lexis/Tina prod, 2026-07-28).
    const standIdx = dmz.indexOf('let hasStanding = memberPriv > 0;');
    assert.ok(standIdx > 0, 'hasStanding computation not found');
    const cond = dmz.slice(standIdx, dmz.indexOf('{', standIdx) + 1);
    assert.ok(
      !/!info\.file_nid/.test(cond),
      'the standing check must NOT exclude file shares (re-blanks every later file share in a folder)'
    );
    const body = dmz.slice(standIdx, standIdx + 2200);
    assert.ok(
      /readDirectGrant\(info\.nid\)/.test(body),
      'standing must be read on info.nid — the node memberPriv was measured on'
    );
    assert.ok(
      /memberPriv > \(standingIsOwn \? rowPriv\(standing\) : 0\)/.test(body),
      "standing must discount the recipient's OWN secure-share grant on that node"
    );
  }],

  ['permission_get_direct is called (resource, entity) — swapping them makes it inert', async () => {
    const dmz = src('service/dmz.js');
    // SP signature is permission_get_direct(_rid /*resource_id*/, _eid /*entity_id*/).
    // Passing (user.id, node) silently matches NO row (resource_id is never a uid), so
    // ownShareGrant collapses to 0 and the whole grant-clobber protection turns into a
    // no-op. Verified against the prod DB: correct order returns the grant row, the
    // reversed order returns an empty set.
    const callIdx = dmz.indexOf("'permission_get_direct'");
    assert.ok(callIdx > 0, 'permission_get_direct call not found');
    const args = dmz.slice(callIdx, callIdx + 200);
    assert.ok(
      /'permission_get_direct',\s*`'\$\{resource_id\}','\$\{user\.id\}'`/.test(args),
      'permission_get_direct must receive (resource_id, user.id) in that order'
    );
    assert.ok(
      !/`'\$\{user\.id\}','\$\{info\./.test(args),
      'arguments are reversed — permission_get_direct would match nothing'
    );
  }],

  ['#4 media.js: listing is token-scoped + hard-filtered to the shared file', async () => {
    const media = src('service/media.js');
    assert.ok(/_secureShareListTarget\s*\(/.test(media), 'token listing helper missing');
    assert.ok(/ssTarget\s*&&\s*ssTarget\.file_nid/.test(media), 'token-authoritative file filter missing');
  }],

  ['media.js: file-share writes (make_dir/upload) are denied — only the shared file', async () => {
    const media = src('service/media.js');
    // Isolate the _secureShareWriteAllowed method body and assert it (a) still requires
    // can_edit and (b) additionally denies when the share resolves to a single file
    // (listTarget.file_nid). Removing this block reopens create/upload into the shared
    // file's parent (the creator's folder) — the Lexis file-share report.
    const mIdx = media.indexOf('_secureShareWriteAllowed()');
    assert.ok(mIdx > 0, '_secureShareWriteAllowed method not found');
    const body = media.slice(mIdx, mIdx + 400);
    assert.ok(/_secureShareCapAllowed\(\["can_edit"\]\)/.test(body), 'write guard must still require can_edit');
    assert.ok(/_secureShareListTarget\s*\(\s*\)/.test(body), 'write guard must resolve the share list target');
    assert.ok(
      /listTarget\s*&&\s*listTarget\.file_nid\)\s*return false/.test(body),
      'write guard must deny file shares (create/upload confined to the shared file)'
    );
  }],

  ['dmz.js: is_member is derived from hasStanding, never from raw memberPriv', async () => {
    const dmz = src('service/dmz.js');
    // is_member drives the recipient UI's "limited access / Request access" banner.
    // Deriving it from the raw memberPriv (the EFFECTIVE privilege) reports any
    // recipient holding their OWN prior 'Secure share access' grant as a workspace
    // member, which suppressed that banner permanently for them (prod 2026-07-29).
    // The authoritative notion is hasStanding, which discounts the recipient's own
    // grant. Assert the final assignment reads hasStanding and that it comes AFTER
    // hasStanding has been resolved, so a reorder can't silently restore the bug.
    assert.ok(
      /is_member\s*=\s*hasStanding\s*\?\s*1\s*:\s*0/.test(dmz),
      'is_member must be derived from hasStanding'
    );
    const standingIdx = dmz.indexOf('hasStanding = (memberPriv >');
    const assignIdx = dmz.search(/is_member\s*=\s*hasStanding/);
    assert.ok(standingIdx > 0, 'hasStanding resolution not found');
    assert.ok(
      assignIdx > standingIdx,
      'is_member must be assigned AFTER hasStanding is resolved'
    );
  }],

  ['neutral host: page.js isolates share.<main_domain> onto a host-scoped cookie', async () => {
    const page = src('client/page.js');
    assert.ok(/isNeutralShareHost/.test(page), 'neutral-host detection missing');
    assert.ok(/share\.\$\{main_domain\}/.test(page), 'neutral-host match string missing');
    // host = this.input.host() keeps the cookie scoped to the connect host (narrower
    // than the apex) — the property that makes it un-usable as the apex auth session.
    assert.ok(/host\s*=\s*this\.input\.host\(\)/.test(page), 'host-scoping of the isolated cookie missing');
  }],

  ['set_notify_on_open is creator-scoped and never takes an owner id from the client', async () => {
    const ss = src('service/private/secure_share.js');
    const idx = ss.indexOf('async set_notify_on_open()');
    assert.ok(idx > 0, 'set_notify_on_open method not found');
    const body = ss.slice(idx, idx + 1200);
    // The ONLY thing standing between this setter and "edit anyone's link" is that
    // the creator scope comes from the session (this.uid), never from the request.
    assert.ok(
      /await_proc\(\s*'secure_share_set_notify_on_open'\s*,\s*token\s*,\s*this\.uid\s*,/.test(body),
      'creator scope must be this.uid, passed as the 2nd arg of the SP'
    );
    assert.ok(
      !/creator_id/.test(body),
      'must never read a creator/owner id from the request'
    );
    // An unknown token and someone else's token must be indistinguishable, else the
    // endpoint becomes a probe for other people's tokens.
    assert.ok(
      /isEmpty\(row\)\)\s*\{?\s*\n?\s*return this\.output\.data\(\{\s*status:\s*'NOT_FOUND'/.test(body),
      'empty SP result must answer NOT_FOUND'
    );
    // Explicit setter: only a recognised truthy form may turn notifications ON.
    assert.ok(
      /raw === 1 \|\| raw === '1' \|\| raw === true\) \? 1 : 0/.test(body),
      'notify_on_open must be coerced strictly from an explicit value'
    );
    // Echo the STORED value so the panel can revert a toggle that did not persist.
    assert.ok(
      /notify_on_open:\s*Number\(row\.notify_on_open\)/.test(body),
      'response must echo the stored value, not the requested one'
    );
  }],

  ['secure_share_opened is a panel refresh, NOT a notification, so it is never gated', async () => {
    // Corrected invariant. This push has exactly one consumer: the sender's own
    // sharing panel, which refreshes its links list and access list on any
    // 'share.track_event'. The activity panel narrows that same service down to
    // 'secure_share_access_requested', so this event notifies nobody.
    //
    // Notification suppression belongs to the two feed procedures, which carry
    // `AND t.notify_on_open != 0` (secure_share_open_feed and
    // secure_share_list_open_notifications). Gating HERE as well meant turning
    // the toggle off also killed the live refresh, so the access list only
    // caught up on a reload -- the opposite of the requirement, which is no
    // notification but an access list that keeps updating normally.
    const dmz = src('service/dmz.js');
    const pushIdx = dmz.indexOf("event           : 'secure_share_opened'");
    assert.ok(pushIdx > 0, 'secure_share_opened push not found');

    // Isolate the guard that wraps the push and assert notify_on_open is not in it.
    const guardIdx = dmz.lastIndexOf('if (row.hub_id', pushIdx);
    assert.ok(guardIdx > 0, 'the push guard was not found');
    const guard = dmz.slice(guardIdx, pushIdx);
    assert.ok(
      !/notify_on_open/.test(guard),
      'the secure_share_opened push must NOT be gated on notify_on_open -- that kills the live access-list refresh'
    );

    // The access-event write must still happen before the push, and outside any gate.
    const logIdx = dmz.indexOf("'secure_share_log_access_event'");
    assert.ok(logIdx > 0, 'access-event log not found');
    assert.ok(logIdx < guardIdx, 'the access list must be recorded before the push guard');
  }],
];

// Behavioural tests only when their (private) dep loaded; canaries always.
const tests = (guard ? behavioural : []).concat(invariants);
const skipped = guard ? 0 : behavioural.length;

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
  const passed = tests.length - failed;
  console.log(`\n${passed}/${tests.length} passed${skipped ? ` (${skipped} behavioural skipped — deps not installed)` : ''}`);
  process.exit(failed ? 1 : 0);
})();
