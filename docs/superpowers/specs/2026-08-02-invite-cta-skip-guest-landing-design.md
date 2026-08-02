# Workspace-invite CTA: skip the guest landing page

Date: 2026-08-02

## Problem

The workspace-invite email's CTA (`service/private/templates/butler/workspace-invite-member.html`)
links at an anonymous guest landing page. Opening the workspace one was invited to
therefore costs four hops:

1. click the email CTA → guest landing page (`signin_guest`)
2. click *Join Workspace* / *Sign Up Free* on that page → arms `drumee_guest_join`
3. sign in or sign up
4. click *Open Workspace* on a dialog the desk raises after Home settles

Steps 1–2 exist only to render a preview the email already shows, and step 4 asks
for a click the recipient has effectively already made twice.

An already-signed-in recipient gets a worse deal: `welcome.loadSignin()` short-circuits
on `Visitor.isOnline()` into `_redeemInviteThenEnter()`, which — with no `?invite=`
token on the link — just sets `location.hash = desk`. They never see the landing page
and land on a bare desk with nothing opened, because the welcome router stashes
`args.hub_id` while `_guestLandingLink` emits `hub=`.

## Goal

Clicking the email CTA takes the recipient to the sign-in form. Once they are
authenticated the desk offers the invited workspace — "Open Workspace" / "Cancel" —
and confirming puts them in it. No landing page, and no click spent leaving one.

## Design

### 1. The CTA becomes a plain welcome link

`_guestLandingLink(hubname, external, token, hub_id)` in `service/private/hub.js`
is replaced by `_inviteCtaLink(hub_id, hubname)`, which returns:

```
https://<main_domain><endpoint_path>/#/welcome/signin?hub_id=<hub_id>&name=<workspace>
```

`view=guest`, `scope` and `token` are dropped:

- `scope` only ever selected a landing-page layout.
- `token` authorised the landing page's `dmz.list_by_token` read. Nothing on the
  new path reads share content anonymously.
- `hub` becomes `hub_id`, which is the name the welcome router already reads.
- `name` stays, but for a different job: it was the landing page's header, and it is
  now display copy for the prompt's message ("…you were invited to: Alpha"). It is
  never an identity — `hub_id` alone selects the workspace and every service behind
  it authorises the caller's session. Both values are percent-encoded, so a
  workspace called `R&D = Q3` cannot forge extra query params.

Two things deliberately stay in `invite()`:

- `await this._ensurePublicShareToken()` is still called, now purely for its side
  effects — it creates the external room on first use and re-applies the area-based
  guest permission, which `copy_link` and the share panel depend on. Its return
  value is discarded.
- `workspace_external` still drives the email's body copy and whether the preview
  rows are redacted. That is unchanged; only the CTA target moves.

### 2. One lib owns the deep-link stash

The mechanism this rides on already exists: `welcome/index.js` stashes `?hub_id=`
into `sessionStorage.drumee_hubDeepLink`, and `desk/wm.onDomRefresh` consumes it by
calling `loadWorkspace({hub_id})`. It is sessionStorage-only, which does not survive
a recipient who signs up, closes the original tab, and finishes in the tab opened by
the verification link. (The signup flow usually saves them — `check-inbox` polls
`signup.check_verification` and redirects the *original* tab to sign-in — but only
while that tab is still open.)

A new `src/drumee/libs/hub-deep-link.js` in ui-team, alongside the existing
`libs/campaign.js`, owns the whole thing:

- `arm(hub_id, name)` writes **both** `sessionStorage.drumee_hubDeepLink` — kept a
  BARE hub_id string, its original shape, so a desk bundle from before this module
  still reads it — and `localStorage.drumee_hubDeepLink = {hub_id, name, ts}`. The
  name rides only on the localStorage copy, which has no older reader.
- `peek()` returns `{hub_id, name}` or null. Session decides *whether* an intent
  belongs to this tab; the localStorage copy supplies the name, and stands in
  wholesale when the session key is gone. A localStorage copy for a *different*
  hub never lends its name.
- `consume()` is `peek()` + `clear()`, so a consumed intent cannot prompt twice.
- `has()` answers the same question without consuming.
- `clear()` drops both keys.

The 7-day guard mirrors `_maybeOfferInvitedWorkspace`: an intent that outlives the
session can also outlive the recipient's interest, and the invite itself stays in
the activity list either way.

Call sites:

| File | Change |
|------|--------|
| `modules/welcome/index.js` | `arm(args.hub_id, decoded name)` in place of the bare `setItem` |
| `modules/desk/wm/index.js` | boot path no longer opens an armed intent — only the explicit `#/desk/wm/hub?hub_id=` hash form still opens immediately |
| `modules/desk/index.js` | `_maybeOfferInvitedWorkspace` consumes it; `_hasDeepLink()` uses `has()`, so desk-state restore does not race the prompt |

The secure-share branch in `desk/wm.onDomRefresh` clears **both** keys instead of
one — a secure-share return must still win over a hub deep link.

### 3. The prompt, and where it lives

The desk asks before opening. `_maybeOfferInvitedWorkspace` already rendered exactly
this dialog for the guest-landing flow, so it takes the new intent as a second
source rather than growing a second modal:

```
You can now open the workspace you were invited to: Alpha

        [ Open Workspace ]   [ Cancel ]
```

Consumption belongs to the desk, NOT to `desk/wm.onDomRefresh`, because the prompt
must inherit `_afterHomeSettled` → `_waitForHomePopups()`: the reward flow and the
LAUNCH30 popup are full-screen and self-gating, and an earlier version of this
dialog appeared on top of them. The boot path cannot see either.

**Open Workspace** sets `#/desk/wm/open/?hub_id=…&nid=0&filetype=folder&pid=0`, the
same deep link the "<name> invited you to <workspace>" activity row uses. It launches
a normal popup `window_folder` with the full window chrome.

`Wm.loadWorkspace({hub_id})` — the headless workspace pane the sidebar opens — was
tried here and reverted. A headless folder topbar deliberately drops the zoom and
minimize controls (`folder/skeleton/topbar.js`: `headless ? "" : zoomMenu(ui)`,
because a pane already fills the desk area), so the window opened from this dialog
came up without its zoom control. Keeping the popup route also means this dialog and
the activity row behave identically, which is the point of reusing the route rather
than re-deriving it.

`nid=0` is required, not decorative — see the note under Verification.

**Cancel** is `_e.close` — the notice dismisses and the intent is already consumed,
so it does not come back.

#### The wait before it

The prompt is late by design, so the desk says so. `_showInvitedWorkspaceLoader`
raises a "Preparing your workspace…" notice (spinner + label, `mode: "hb"` so it has
the drumee/✕ header and no footer) at the TOP of the chain, before the reward flow —
the floor is ~2.4s (`SETTLE` 2000 + the 400ms settle) and unbounded while a
full-screen flow is up.

Raising it that early is only safe because of two things:

- It hides itself whenever `_homePopupsBusy()` is true. That predicate is extracted
  from `_waitForHomePopups`' local `busy()` so there is ONE definition, and the skin
  hides `[data-guest-join-loading="1"][data-busy="1"]`. Hidden, not unmounted —
  remounting on each toggle would flicker and lose its place in the windows pool.
- `dismiss_after` is a hard backstop. Every path that ends the wait calls
  `_hideInvitedWorkspaceLoader` (prompt raised, Wm never arrived, stale intent,
  popups never cleared, chain failed), but a footerless loader has no button to
  dismiss it, so it must not be able to outlive its reason to exist if a future path
  forgets.

It is a no-op unless a workspace is armed, which `_hasInvitedWorkspaceIntent` answers
WITHOUT consuming — the prompt still needs that intent.

### 4. Resulting flow

```
email CTA  →  #/welcome/signin?hub_id=42&name=Alpha
                 |
    +------------+-----------------+--------------------+
    | anonymous  | no account      | already signed in  |
    v            v                 v
 sign-in      sign-up -> verify   welcome sees hub_id -> arm
    |            | (create_account resolves            |
    |            |  pending_invitation -> membership)   |
    +------------+-----------------+--------------------+
                                   v
                    desk boot -> "Preparing your workspace…"
                                 (hidden while reward / LAUNCH30 is up)
                                   v
                        Home settles, popups clear
                                   v
                  "Open Workspace / Cancel"  -> consume()
                                   v
              #/desk/wm/open/?hub_id=42&nid=0&filetype=folder&pid=0
                                   v
                     popup window_folder on the hub root
```

Membership is granted exactly as before, and nothing about it moves:

- existing account → `_grantMembership` at invite time, plus the `hub.invite_received`
  websocket push;
- no account → `_addInviteToken` + `yp_add_pending_invitation`, resolved by
  `signup.create_account` → `_resolve_pending_invitation`.

### 5. What is deliberately left alone

Every link already sitting in an inbox carries `?view=guest&scope=…&token=…&hub=…`
and must keep working end to end, so none of this is removed:

- the `signin_guest` widget, its skeletons and its sample/share/chat content;
- the `view=guest` branch in `signin_router.onDomRefresh`;
- `dmz.list_by_token` / `dmz.chat_by_token` (no consumer other than that widget);
- the guest flow's `drumee_guest_join` key and `_armJoinIntent`, so an old link
  still arms and still gets its dialog.

`_maybeOfferInvitedWorkspace` and the `guest-join-open-workspace` handler are shared
rather than left alone: they now serve both intent sources. The handler's outcome is
unchanged — still the `#/desk/wm/open/` popup — so an old guest-landing link behaves
exactly as it did before.

Retiring the rest is a separate decision, taken once no old link can plausibly
still be clicked.

## Verification

Neither repo has a test runner (`package.json` scripts are dev/deploy only), so:

- a throwaway node harness asserting `_inviteCtaLink`'s output (including that a
  workspace name containing `&` or `=` cannot forge query params) and the
  `hub-deep-link` age-guard / precedence / name-pairing rules — all pure, no DB,
  no DOM;
- a harness that lifts the loader's four methods out of `desk/index.js` and runs the
  shipped bodies against a fake desk and Wm: intent detection stays read-only, the
  window is shaped right (`mode: "hb"`, no `actions`, `dismiss_after` set), and it
  hides — without unmounting — for each of the busy signals;
- the loader's two visual states rendered with a standalone `sass` compile of the
  info skin and a headless chromium screenshot, checking both that the card looks
  right and that `[data-busy="1"]` paints nothing at all;
- a manual click-through on `local.drumee` for the anonymous and
  already-signed-in cases.

This box only serves `local.drumee`, so the link string and the storage logic can
be verified here but a real inbox → production workspace open cannot.

Note on `nid`: a caller that knows only a `hub_id` must reach `media.attributes` with
`nid: 0`, the server's own hub-root value. Leaving it unset is not equivalent —
`fetchService` builds its GET query with `encodeURI(v)` per key, so an undefined nid
is sent as the literal string `"undefined"`, which `mfs_access_node` resolves to zero
rows. That is what `Wm._rootNid` exists for, and why the prompt's Open deep link
spells out `nid=0`.

## Risks

- **A stale localStorage intent.** Bounded by the 7-day guard and by `consume()`
  clearing both keys on the first read.
- **Recipients on an old link get the old four-hop flow.** Accepted: it still
  works, and it drains as inboxes age.
- **No preview before signing in.** The email itself carries the preview rows and
  the recent-activity snippets, which is where a recipient actually sees them.
- **The prompt can be missed.** It waits for Home to settle and for the reward /
  LAUNCH30 popups to clear, and gives up if `Wm` never appears within six seconds.
  The intent is consumed either way, so a missed prompt does not return. The invite
  stays in the activity list and the workspace stays in the sidebar, so nothing is
  lost — the recipient just opens it themselves.
