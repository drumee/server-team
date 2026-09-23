# Debug report: chat attachment lands in workspace Files list; bubble card latency

Date: 2026-09-22 · Stage: `aaron` endpoint (ui-team `test` @ 6e8a0362, server-team `test` @ 7ffc5c8)

## Symptom (reported)

1. Workspace chat (internal + external): attach → From device → send. Message OK, but the
   file also shows in the workspace's Files list. Deleting it from Files does not break the
   file in the message. Expected: chat attachments never appear in the workspace Files list.
2. After send, the bubble shows the attachment card slowly, sometimes never until the chat
   is reloaded by switching workspace.

## Issue 1 — root cause: CONFIRMED (deliberate behaviour, now unwanted)

Chain, verified by code + live measurement:

- `ui-team/src/drumee/builtins/widget/chat/index.js`
  - `_getUploadDestination()` (~663): every attachment uploads into the hidden staging
    `/__chat__/__upload__/` (`home.chat_upload_id`). Correct.
  - `canPromoteDeviceAttachmentsToFolder()` (~703): returns true when `postNid` is set and the
    viewer has the write bit. `initialize` (~149) sets `postNid = nid` for **workspace scope
    too** (`isHubScopedChat(scope)`), while `scopedNid` stays empty.
  - `sendMessage` (~2497): when `getPostNid()` is set, `api.nid = postNid` and
    `api.folder_attachment = getPromotableDeviceAttachmentIds(list)` (device uploads only).
- `server-team/service/private/channel.js` `post()` (~1500–1560):
  `_classify_staged_attachment` splits staged nodes into `device` (listed in
  `folder_attachment`) vs `workspace`. Device nodes are **moved into the folder `nid`**
  (`_promote_staged_to_folder` → `mfs_move_all`), then every attachment is **copied** into the
  sbox `/__chat__/<message_id>/` (`move_attachemnt` with `copy_only`), staging leftovers of
  workspace copies are purged. Result: two nodes — one in Files (original), one in the
  message (sbox copy). Deleting the Files one leaves the message copy intact → matches report.

Commits that introduced it:

| repo | commit | date | subject |
|---|---|---|---|
| server-team | 61de76e | 2026-06-05 | fix(channel): promote staged folder attachments on post |
| ui-team | 8551402b | 2026-06-05 | fix(chat): keep folder-chat attachments out of the folder until send |
| ui-team | **b04bbf66** | **2026-09-07** | fix(chat): promote workspace-chat uploads into the folder the post writes to (shipped in #560 → #564 PROD 2026-09-09) |

b04bbf66's stated goal: a device upload with no folder placement had no thread in the folder's
thread rail and "Show in folder" showed nothing. That trade-off is what the user now rejects.

Live evidence (temptest1, hub "External Workspace" 5688bc445688bc48, db 5_5688bd145688bd15):

| post variant | uploaded node after post | message node |
|---|---|---|
| `folder_attachment=[nid]` (what the UI sends) | moved to `/probe-promoted.png` (root Files) | `/__chat__/<mid>/probe-promoted.png` copy |
| no `folder_attachment` | **purged from staging** (not in media, not in trash) | `/__chat__/<mid>/probe-unpromoted.png` copy |

Browser flow (attach → From device → send in "Internal Workspace(1)", db 7_cafccfcacafccfcb)
produced the same pair: `/browser-probe.png` at root + sbox copy; card shows "Show in folder".

Conclusion: the server already implements the wanted behaviour for the no-`folder_attachment`
case. The fix is client-side: stop sending `folder_attachment` (and stop setting `postNid` for
promotion) — at minimum for workspace scope; the DMZ folder-scope (8551402b) needs the same
decision. Side effects to accept: no folder thread-rail entry / "Show in folder" for device
uploads (the b04bbf66 rationale), `tests/chat-upload-promotion.test.js` must be updated.
Server-side `_promote_staged_to_folder` can stay (dead when the client never asks).

## Issue 2 — root cause CONFIRMED (personal desk folder chat), fix in schemas #186

Update 2026-09-22 13:xx: Aaron's failing sends were on his **personal desk** (hub_id == uid,
folder `/Photos`), not on a team hub. Server log for that account: `channel.post` GRANTED →
TERMINATED but **no `chat.attachment` re-fetch afterwards**. API repro on temptest1's own hub:
response carried `_db_err` = "Column 'entity_id' cannot be null" and **no `message_id`**, while
the channel row WAS inserted. Cause: drumate variant of `channel_post_message`, non-hub branch,
bumps `time_channel` with `_entity_id` (P2P peer, only `chat.post` sends it); `channel.post` has
no peer → NULL into NOT NULL PK → EXIT HANDLER returns error JSON instead of the row → client
optimistic bubble never gets `message_id` → no card, until reload loads the stored row.
Explains both "gửi không được" and "bubble hiện nhưng không open được, refresh thì được".
Pre-existing (Aaron's 04:11 rows show the same shape), independent of today's ui change.

Fix: `drumate/procedures/channel/channel_post_message.sql` — skip the `time_channel` insert when
`_entity_id IS NULL`. Applied to temptest1's DB only (`c_2fb5e0422fb5e043`); after: full row,
`message_id`, `attachment=[{hub_id:<wicket>,nid}]`, `chat.attachment` 1 item privilege 63.
Pre-fix source: `/root/chat-perm-backup/channel_post_message-drumate-before-fix-20260922.sql`.
PR: https://github.com/drumee/schemas/pull/186 (base preview). Rolled out on Aaron's go
2026-09-22 13:23 to all **450/450** stage drumate DBs that carry the routine (joined through
`yp.entity type='drumate'`), 0 failures, verified by body scan. Bulk `mysql.proc` dump captured
0 rows (the `--where` subquery matched nothing) — rollback reference is the pre-fix source at
`/root/chat-perm-backup/channel_post_message-drumate-before-fix-20260922.sql`, which matched the
body read from temptest1's DB before the change. Post-deploy probe: full row + 1 attachment item.

Issue 1 fix: ui-team https://github.com/drumee/ui-team/pull/618 (base test), on stage `aaron`.

### Earlier team-hub measurement (kept for reference)

Client already has the re-fetch fix (#583, 2026-09-11, `chat-item/index.js _onDataChanged`:
list `restart()` when `message_id` arrives on the optimistic row). Deployed build includes it.

Measured on stage (probe hooks on XHR/fetch + MutationObserver, temptest1):

| step | 704 KB PNG (browser) | 12 MB PNG (API) |
|---|---|---|
| media.upload | 3.13 s | 5.83 s |
| channel.post | 0.42 s | 1.12 s |
| chat.attachment (re-fetch) | 0.88–0.94 s | 1.06 s |
| send click → card in bubble | **1.58 s** | n/a (server part is size-independent) |

Timeline of one send: first `chat.attachment` fires at +159 ms with `message_id` undefined
(expected, evaluated once at list construction), echo arrives +440 ms, `restart()` re-fetch
+625 ms → card at +1.58 s. Server times do not grow with file size (`mfs-copy-node.sh` `cp -rf`
on 12 MB is still ~1.1 s total).

Unverified hypothesis for the "never shows" case (PLAUSIBLE, not confirmed): `handleReceivedMsg`
matches the echo with `this.echoId == data.echoId`, and `this.echoId` is overwritten by the next
`sendMessage`. A second send before the first response makes the first response miss the
echo branch → appended as a new row while the optimistic row keeps no `message_id` → its card
never loads. Needs a two-quick-sends repro to confirm. Browser tab was reset by the tool when
loading an 11 MB file, so the large-file browser timing is missing.

## Cleanup

All probe nodes trashed via `media.trash` (3 in External Workspace, 1 in Internal Workspace(1)).
Probe messages remain in those two temptest chats. Browser session closed.

## Unresolved questions

- Should DMZ folder-scoped chat (8551402b) also stop promoting, or only workspace scope?
- Accept losing folder thread-rail / "Show in folder" for device uploads (b04bbf66 rationale)?
- Does the "never shows" case involve sending a second message before the first returns?

## Issue 3 — "From workspace" picker cannot reach files (reported 14:46) — root cause CONFIRMED, fixed

Symptom: attach → From workspace lists the rows, clicking a workspace pops "This file type is
not supported"; the flow never reaches a file.

Cause (by design of the original feature, not a regression): `_openDeskPicker` (ui-team
`widget/chat/index.js`, shipped in `3c88ae0b` 2026-05-17) fed ONE flat `media.show_node_by`
listing of the user's own home root and `_pickDeskFile` rejected every `hub`/`folder` row with
`Wm.alert(FILE_TYPE_NOT_SUPPORTED)`. The rows the user reads as "workspaces" (Photos,
Documents, …) are home-root folders; hub workspaces were in the same list. No drill-down
existed, so only a loose file at the home root was ever pickable. The console lines
`__window_manager: AAA:471 The method *undefined*` are the alert's Close click bubbling to
the window manager — a side effect of the alert, gone with it.

Fix (ui-team PR `fix/chat-workspace-picker-navigation` → test): the picker now opens on the
desk-sidebar rows (`desk.home type=all`, hub rows gated on area share|private|restricted|public
like `desk_workspace-list`), a hub/folder row pushes onto `_deskPickerTrail` and re-feeds the
list with `media.show_node_by {hub_id, nid}` (hub rows use `actual_home_id`, as
`Wm.loadWorkspace`), a Back control pops the trail, a file row runs the unchanged
copy-to-staging attach path. Rows are typed by class (`--hub`, `--folder`, `--file`).

Verified on stage (temptest1, chat in External Workspace 5688bc445688bc48):
root → 6 rows (1 personal folder, 3 hubs, 2 probe folders); hub row → Back + contents; folder
row → its file; file row → chip staged; send → bubble card 188 KB. API after send: original
still in the personal folder, External Workspace root unchanged (no Files-list leak).
Seeded probe files trashed afterwards.

Not covered: the `file/orig/<a>/<b>?keysel=regsid` 404s in the user's console — the two `<a>`
ids are not `yp.entity` rows; needs the message ids from the user's account to trace.

Follow-ups (same day): rows restyled like the @-mention rows (desk icon by area, file
extension, loading skeleton; PR #620 merged), then on Aaron's decision the picker was
re-anchored at the chat's OWN workspace only — team hub → hub home root, personal-desk chat →
its personal workspace folder (`getPostNid`), DMZ share → shared folder; hub rows dropped,
no Back above the root (commit on `test`, verified on stage with temptest1 for the personal
folder chat and the External Workspace chat).

## Issue 4 — From workspace: card without preview, Open → "A network error has occurred" (2026-09-23)

Report: upload an image to the workspace (renders and opens fine), attach it via From
workspace, send — the bubble shows the file name but no thumbnail, Open fails with the
generic network error. Aaron: 100% with a fresh upload; intermittent otherwise.

Evidence (stage, uid 97b24b3d97b24b42, requests land on the `main-service` cluster 93–96):

| UTC      | request                         | source → staged → sbox node                        | sbox folder on disk |
|----------|---------------------------------|----------------------------------------------------|---------------------|
| 09:41:34 | media.copy hub b975 (jpg, May)  | cc13319f → f6fe1df7 → f7fd5cb2                      | **empty**           |
| 09:41:52 | media.copy hub 9768 (jpg, May)  | a406fb26 → 01c6b6b0 → 02c6a2d3                      | **empty**           |
| 09:42:25 | media.copy personal (heic, 22/9)| 8992153c → 15798fa6 → cac5/16542d10                 | orig + vignette     |
| 09:42:40 | media.copy personal (svg, 22/9) | bb413f81 → 1e8fd8b2 → cac5/1fca379e                 | orig                |
| 09:43:08 | media.copy personal (1.png, fresh) | 2a055e82 → 2ee1d66f → cac5/2ff40dba              | **empty**           |
| 09:49:44 | media.copy personal (2.png, fresh) | 13fe4048 → 1b2509cf → cac5/1eaea68a              | orig + vignette (+preview/slide on open) |
| 09:50:31 | media.copy personal (mov, fresh)| 323cdd00 → 3715a9d6 → cac5/38ee451b                 | only `info.json` written on Open |

Every failing message row (`1_97b24c1397b24c14.channel.attachment`) points at a sbox node whose
storage folder is EMPTY: no `vignette.png` → card has no preview; no `orig.*` → Open fetches
`file/orig/<nid>/<hub>` → 404 → `LOCALE.ERROR_NETWORK`. The mov additionally raised
`Video FAILED TO RUN SERVICE video.master … null 'join'` (INVALID VIDEO INFO). Yesterday's
console 404 `file/orig/f8fe9787f8fe9789/cac552d4cac552db` is the same thing: message
f8fa969b (2026-09-22 05:53) → sbox node f8fe9787 whose folder has been empty since then.
Fresh upload is NOT the discriminator — two May-2026 workspace files failed the same way and
one fresh png succeeded. It is a race.

Root cause (server-team `service/private/channel.js`, both `post` and `file_thread_post`):

1. `move_attachemnt()` copies the staged node into the sbox with `copy_node(src, dest, 1)`
   — `detach=1` makes server-core spawn `/usr/share/drumee/bin/mfs-copy-node.sh` detached and
   return immediately (`ln -s src dest; mkdir dest.tpm; cp -rf src/* dest.tpm; rm -f dest;
   mv dest.tpm dest`). Nothing awaits the bytes.
2. A few ms later, still inside the same request (the whole post took 55 ms:
   09:43:10.073 → .128), `_purge_staged_copies(staged.workspace)` deletes the staging node:
   `mfs_attachment_remove` + synchronous `remove_node()` → `rm -rf <staged>`.
3. The in-process rm almost always beats bash start-up + `cp`, so `cp -rf src/*` finds no
   files, and `mv dest.tpm dest` leaves an empty sbox folder that the committed message
   already references.

Replayed on the stage box with the exact spawn order (script then rm) on scratch dirs:
20/20 destinations empty. Introduced by `111b831` (2026-05-19, detached copy to staging) +
`61de76e` (2026-06-05, purge staged copies after post); deployed on main (server 2.9.94).
The picker's first hop (`media.copy` → `after_transact` → `copy_node(…, 1)`) is the same
detached script but its source is never deleted, so it is not the failing step; direct chat
(`service/private/chat.js`) uses synchronous `copy_node`/`remove_node` and is unaffected.

Fix direction (not applied): make the sbox copy synchronous in `move_attachemnt`
(`copy_node(src, dest)` → `cpSync`, same as chat.js) or, if the detached script must stay,
purge the staging node only after the copy has landed (await the child / verify `orig.*`
exists in the sbox folder before `_purge_staged_copies`). Existing broken cards
(2ff40dba, 38ee451b, f8fe9787 in hub cac552d4) keep empty folders; their staging sources are
already purged, so they cannot be repaired from disk.

Fix applied (server-team `c484f8d` on `test`, 2026-09-23): new `service/private/_node-storage.js`
exports `copyNodeStorage(src, dest)` — an awaited `fs/promises.cp` (recursive, `dereference`
so a staging path that is still the desk copy's symlink is followed) built on MfsTools
`check_base`/`get_base`/`check_safety`; `channel.js move_attachemnt` uses it in place of both
`copy_node(src, dest, 1)` calls, so `_purge_staged_copies` only runs once the sbox bytes are
on disk. Desk copy (`private/media.js`), direct chat (`chat.js`) and the shell script are
untouched.

Verified on stage `aaron` (temptest1, personal folder c6157887c615788c, API replay of the UI
flow: fresh upload → 1.5 s → `media.copy` → 1.5 s → `channel.post`): 3/3 sbox folders hold
`orig.png` + `vignette.png`, `file/orig` and `file/vignette` answer 200 for all three, the
three staging copies are purged, no orphan folders. Awaited-copy replay of the spawn order on
the stage box: 0/20 empty (was 20/20). Test uploads and staging leftovers trashed; the six
probe messages in temptest1's personal folder chat could not be deleted —
`channel.delete` fails there with `PROCEDURE c_2fb5e0422fb5e043.channel_delete_hub_all does
not exist` (stage schema gap, pre-existing, not touched).

Still open: the `main` endpoint Aaron tests on runs the old code until `test` is deployed
there; cards already broken (`2ff40dba`, `38ee451b`, `f8fe9787` in hub cac552d4) stay empty.
