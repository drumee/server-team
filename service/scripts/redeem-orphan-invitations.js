/**
 * @license
 * Copyright 2026 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3.
 * https://www.gnu.org/licenses/agpl-3.0.html
 */

/**
 * REPAIR WORKSPACE INVITATIONS THAT WERE NEVER GRANTED.
 *
 * An orphaned invitation is a `yp.pending_invitation` row whose address ALREADY
 * BELONGS TO A DRUMEE ACCOUNT. Those rows are only ever redeemed at account
 * creation, so for an existing account nothing redeemed them: no `add_member`,
 * therefore no `join_hub`, therefore no workspace under the invitee's home root
 * and nothing for `desk.home` to return. The workspace is invisible on their
 * desk and stays invisible across reloads.
 *
 * `hub.add_contributors` / `hub.invite_with_roles` no longer create such rows
 * (they grant to any existing account, whatever domain it is in), and
 * `yp.login` redeems leftovers on the invitee's next sign-in. This script is
 * the immediate, complete pass — it does not wait for people to log in.
 *
 * SAFE TO RE-RUN, and safe next to memberships that already work. Every row is
 * checked before anything is written: somebody already holding the membership
 * AND already carrying the workspace under their home root is left untouched
 * (their stale invitation is simply cleared), and a repair never lowers a
 * privilege that was raised since the invitation was sent. Rows that fail are
 * kept for the next run.
 *
 * DRY RUN BY DEFAULT — it prints what it would do and writes nothing.
 *
 * Usage:
 *   node service/scripts/redeem-orphan-invitations.js            # report only
 *   node service/scripts/redeem-orphan-invitations.js --apply    # do it
 *   node service/scripts/redeem-orphan-invitations.js --apply --email=a@b.c
 */

const { Mariadb } = require("@drumee/server-essentials");
const { resolvePendingInvitations } = require("../lib/resolve-pending-invitation");

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const ONE = (argv.find((a) => a.startsWith("--email=")) || "").split("=")[1] || null;

/**
 * The shape `resolvePendingInvitations` needs. No `payload`, so it skips the
 * websocket push — this runs outside any request and the recipients are
 * overwhelmingly offline; their next desk load reads `desk.home` fresh anyway.
 */
function shim(yp) {
  return {
    yp,
    warn: (...a) => console.warn("  !", ...a),
    debug: () => {},
  };
}

async function main() {
  const stamp = new Date().toISOString();
  console.log(`[${stamp}] orphaned workspace invitations — ${APPLY ? "APPLY" : "DRY RUN"}`);

  const yp = new Mariadb({ name: "yp" });
  try {
    // Orphaned = the address already has an account. `drumate.email` and
    // `pending_invitation.email` are both utf8mb4_general_ci, so the join is
    // case-insensitive, which is what the redeemer's own lookup does too.
    const sql = `
      SELECT p.email, d.id AS uid, COUNT(*) AS pending, MIN(p.created_at) AS oldest
      FROM pending_invitation p
      INNER JOIN drumate d ON d.email = p.email
      ${ONE ? "WHERE p.email = ?" : ""}
      GROUP BY p.email, d.id
      ORDER BY oldest ASC
    `;
    const rows = (ONE ? await yp.await_query(sql, ONE) : await yp.await_query(sql)) || [];
    // A one-row result comes back as the object itself, and a no-row one can
    // come back as `{}` — filter on a field every real row has rather than on
    // length, or an empty answer reads as one account with `undefined` rows.
    const list = (Array.isArray(rows) ? rows : [rows]).filter((r) => r && r.email);

    if (!list.length) {
      console.log("Nothing to repair.");
      await yp.end();
      return;
    }

    console.log(`${list.length} account(s) holding un-granted invitations:\n`);
    let redeemed = 0;
    let failed = 0;
    // Rows whose workspace the person is already in — a stale invitation left
    // behind by a later, successful invite. Cleared, never re-granted.
    let skipped = 0;

    for (const row of list) {
      const age = row.oldest
        ? `${Math.floor((Date.now() / 1000 - row.oldest) / 86400)}d`
        : "?";
      console.log(`  ${row.email}  (${row.pending} invitation(s), oldest ${age})`);
      if (!APPLY) continue;

      const res = await resolvePendingInvitations(shim(yp), row.email, {
        uid: row.uid,
        source: "repair-script",
        notify: false,
      });
      redeemed += res.redeemed;
      failed += res.failed;
      skipped += res.alreadyMember;
      console.log(
        `    → redeemed ${res.redeemed}, already a member ${res.alreadyMember}`
        + `, failed ${res.failed}`
      );
    }

    console.log("");
    if (!APPLY) {
      console.log("Dry run — nothing written. Re-run with --apply.");
    } else {
      console.log(
        `Done: ${redeemed} membership(s) granted, ${skipped} already in place`
        + `, ${failed} failure(s).`
      );
      if (failed) console.log("Failed rows were LEFT IN PLACE — re-run to retry them.");
    }
    await yp.end();
  } catch (e) {
    console.error("FAILED:", e && e.message);
    try { await yp.end(); } catch (_) {}
    process.exitCode = 1;
  }
}

main();
