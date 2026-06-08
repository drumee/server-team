# Anonymous public hub link in invite emails

**Date:** 2026-06-07
**Status:** Approved (pending implementation)
**Repos:** `server-team` (code change), `ui-team` (verify only), `schemas` (no change)

## Problem

The three hub-invite emails embed CTA links that force a sign-in wall for the
recipient:

- `hub-invite-added` (Branch B, existing drumate) → `…#/desk/wm/hub/?hub_id=<id>`
- `hub-invite-signup` (Branch C, new user)       → `…#/welcome/signup?invite=<token>`
- `hub-invite-link`  (Branch A, share-link)       → `…#/welcome/signup?invite=<token>`

`#/desk/*` is a private module: the front-end auth gate
(`router/index.js` `loadModule()` → `access == private` + `!Visitor.isOnline()`
→ `module_welcome`) swaps the workspace for the sign-in form. The signup/link
emails require account creation/sign-in to proceed. Three prior fixes
(`f3604e2`, `df25cc7`, `f8bf510`) only re-tuned the private `/desk` path segment
and never removed the login requirement.

## Goal

Recipients of all three invite emails open the hub with **no login** — as an
anonymous visitor — by pointing every email at the hub's existing public
external-room share link instead of a private route.

Permission, by workspace area (reuses the `workspace_restricted` flag already
computed in `hub.js`, `!(area === "share" || area === "dmz")`):

- **Restricted workspace → view-only** (browse/read).
- **Shared workspace → view + download.**

No anonymous chat/upload/edit: those require the private `desk` UI and a real
identity, which is outside the `dmz` viewer's capability. "Full collaborate"
anonymously is explicitly out of scope and accepted as a ceiling.

## Approach (chosen: A — one shared hub link)

Reuse Drumee's hub-level public DMZ share ("external room"), which already
serves anonymous visitors end-to-end:

```
Email CTA  →  https://<hubhost>/?keysel=<hub_id>/#/dmz/share/<token>
           →  dmz module (access: public — no auth gate)
           →  dmz.login(token)           [acl/dmz.json: src "anonymous"]
           →  media.show_node_by(nid)     [src "anonymous"]  → browse/read
```

One shared token per hub; the same link goes in all three emails.

Rejected alternatives:
- **B — per-recipient public token:** finer revoke/tracking, but more code,
  duplicates external-room logic, and the per-recipient identity is cosmetic
  for an anonymous link.
- **C — email-restricted `secure_share`:** prompts for the recipient's email
  (no account needed). Rejected: requirement is "no identity attached."

## Server change — `service/private/hub.js` (only code change)

1. **New helper `_ensurePublicShareLink(workspace_restricted)`:**
   - Read `dmz_settings`; if empty, call existing `_update_external_room()` to
     lazily create the hub's external room (same pattern as
     `get_external_room_attr()`).
   - Set share permission via `dmz_update_settings(...)`: view-only when
     `workspace_restricted`, view + download when shared.
   - Return `_getShareLink(token)` — already targets the hub's own host via
     `homepath(this.hub.get(Attr.hostname))`, which also fixes the cross-host
     breakage of the old Branch-B link.

2. **`invite()`:** compute `const link = await this._ensurePublicShareLink(workspace_restricted)`
   **once** before the invitee loop, then pass that same `link` into all three
   `_sendInviteEmail(...)` calls (Branches A, B, C).

## What stays the same

Branch side-effects are kept — only the email `link` value changes:
- Branch B still grants membership to existing drumates (+ WS notify).
- Branch C still records the pending invitation.

The old `token_hub_invite_add` / `?invite=` join tokens become unused by these
emails. Left in place (harmless; `accept_invite` may be reachable elsewhere);
optional later cleanup, not part of this change.

## Front-end

No change expected. `#/dmz/share/<token>` is already routed by the public `dmz`
module → `dmz_sharebox` → `dmz.login` → `media.show_node_by`. Verify during
implementation that the sharebox browses a hub-root node (not just a single
file) for an external-room token.

## Permissions

Granted to entity `*` via `assign_via='link'` (the pattern `copy_link()` uses).
Exact bitmask constants (view vs view+download) resolved in the implementation
plan by reading `lex/privilege.js` / `lex/permission.js`.

## Security notes (accepted by product owner)

- The link is **forwardable**: anyone it reaches can browse the hub. One shared
  token per hub; revoking it (existing external-room controls) affects all
  recipients.
- Restricted workspaces become **read-exposed to anyone with the URL**. This is
  the intended, explicitly chosen behavior.

## Testing

- `invite()` returns the `dmz/share` link for all three branches; permission set
  to view vs view+download per `workspace_restricted`.
- Manual: open link logged-out → hub browses, no sign-in form; restricted = no
  download/upload controls; shared = download works.
- No DB schema changes (reuses existing procs) → no patching required.

## Extension — shared-workspace / external-room share (added)

The same area-based permission rule is applied to the manual workspace-sharing
paths so they stay consistent with invite links. A single helper is the source
of truth:

- `_publicSharePermission()` — returns `Privilege.VIEW` for a restricted
  workspace, `Privilege.DOWNLOAD` for a shared one (area `share`/`dmz`).

Applied in:
- `_ensurePublicShareLink()` (invite links) — uses the helper.
- `_update_external_room()` — guest grant permission now always area-derived
  (replaces the old `Privilege.WRITE` default + cap); `update_external_room()`
  no longer forwards a manual permission.
- `copy_link()` — replaces `settings.permission || 1`.
- `update_external_members()` / `add_external_member()` — replace
  `settings.permission || 1`.
- `update_external_settings()` — guest permission is now area-driven, **not the
  manual permission picker** (password and expiry remain user-controlled).

Behavior note: the external-room "permission" picker no longer governs the
anonymous/guest permission — area does. Flagged for product confirmation; revert
`update_external_settings()`/`update_external_room()` to honor manual input if a
per-share override is wanted.

## Out of scope

- Anonymous chat/upload/edit.
- Per-recipient tokens / individual revocation.
- Removing the now-unused account-based invite tokens.
