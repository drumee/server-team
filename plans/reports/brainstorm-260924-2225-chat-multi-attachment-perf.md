---
title: Chat multi-file attachments — performance and UX fix directions
date: 2026-09-24
status: proposed
related: plans/reports/debug-260922-1033-chat-attachment-folder-leak.md (Issue 4, Issue 5)
---

# Summary

Two measured defects on a 36-file post (stage, 2026-09-24): the bubble shows only 5 cards
(`chat.attachment` pages 5 at a time, the bubble list never asks for page 2) and the post
takes 5.85 s server-side (~160 ms/file, copy + purge of every staging node in-request). The
awaited copy shipped in `c484f8d` fixes the empty-folder race but makes heavy posts slower.
Recommendation: return the whole attachment list, MOVE staging nodes into the sbox instead of
copy + purge, batch the per-file DB work, and render the sender's cards optimistically.

# Contract

- **Outcome:** every attachment of a message is shown; sending N files (incl. a 800 MB video)
  returns in well under a second of server time apart from DB work; the sender sees cards
  immediately, not a skeleton for the duration of the post.
- **Constraints:** `chat.attachment` response shape stays an array of node rows (web
  chat-item, litechat, mobile `decodeAttachmentInfoRows` consume it); DB access through
  stored procedures only; staging nodes must never survive in `__chat__/__upload__`;
  attachments never land in the workspace Files list (2026-09-22 decision).
- **Non-goals:** repairing already-broken cards; changing upload itself; touching the desk
  copy (`private/media.js`) or the shell script.
- **Acceptance:** 36-file post → 36 cards; `channel.post` server time for 36 small files
  < 1 s and independent of file size (rename, not copy); 0 empty sbox folders over 20 posts;
  no `__chat__/__upload__` leftovers; mobile `test:live` chat contract still green.

# Options

## A. Attachment list: return everything vs. page from the client
1. **Server returns the full list** when `page` is not sent (keep paging only for an explicit
   `page`). One-line change in `chat.js attachment()`; `_getAttachmentsInfo` does one
   `mfs_access_node` per node — 36 forward_proc calls ≈ 36 × 2–3 ms, fine. Fails first if a
   message carries hundreds of files (nobody does; upload UI has no cap either). **Recommended.**
2. Client keeps requesting pages until `_e.eod`. Touches ui-core list behaviour or a custom
   loop in chat-item, still 8 round trips for 36 files, and mobile stays at 5. Rejected.

## B. Post cost: move vs. copy
1. **Move staging nodes into the sbox** (`mfs_move_all` + `move_node` = rename). The plan
   procedure already emits `'move'` rows for both same-DB (UPDATE parent_id) and cross-DB
   (create in dest + DELETE in source), so no purge step and no DB row left behind; the
   copy-then-purge race disappears with it. `_classify_staged_attachment` guarantees the
   nodes are staging copies, so the historical reason for `copy_only` (originals posted
   directly) no longer applies. Fails first on EXDEV (staging and sbox on different volumes):
   `mv()` falls back to `cpSync` + `rmSync`, still correct, just slower. **Recommended.**
2. Keep copy_only but stream it (`fs.cp` awaited — current state). Correct but O(size);
   844 MB in-request. Rejected as the end state.
3. Copy detached, purge later (delayed job). Adds a scheduler and a window where the sbox is
   empty. Rejected.

Also batch the per-file DB round trips inside the post: one `SELECT … WHERE id IN (?)` in
`_classify_staged_attachment` instead of N, and one `mfs_move_all` call for all nodes (already
the case). Expected: post time dominated by `channel_post_attachment`'s loop.

## C. Sender UX
1. **Optimistic cards from the composer's staged items**: the composer already holds
   `nid/hub_id/filetype/ext` (media_grid cards); feed them to the bubble list instead of
   firing `chat.attachment` before the post returns (today that call answers empty and the
   skeleton pulses for the whole post). Reconcile on the post reply: same-hub moves keep the
   nid (URLs stay valid); cross-DB moves return new nids → re-feed once. **Recommended.**
2. Keep the skeleton but suppress the premature fetch and show "Sending N files…" with the
   upload-progress window. Cheaper, still a wait. Fallback if C1 proves fragile.

# Recommendation and order

1. server `chat.js attachment()`: full list unless `page` given (A1).
2. server `channel.js move_attachemnt` + post/file_thread_post: `mfs_move_all` + `move_node`
   for staged nodes, drop `_purge_staged_copies` for them, batch the classify SELECT (B1).
   `_node-storage.js` stays only if a copy path remains; otherwise remove it.
3. ui-team chat-item/chat: optimistic cards + reconcile (C1).

Verify with the API replay used for Issue 4 (upload → copy → post) extended to 36 files and
one ≥ 500 MB file, plus the stage browser run.

# Unresolved
- Whether any client still relies on `channel.post` promoting device uploads into the folder
  (`folder_attachment`); web sends none, mobile type allows it — confirm before removing the
  promote branch (not required for this fix, the move keeps it working).
