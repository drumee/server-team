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

Clicking the email CTA takes the recipient to the sign-in form, and the invited
workspace opens by itself once they are authenticated. No landing page, no prompt.

## Design

### 1. The CTA becomes a plain welcome link

`_guestLandingLink(hubname, external, token, hub_id)` in `service/private/hub.js`
is replaced by `_inviteCtaLink(hub_id)`, which returns:

```
https://<main_domain><endpoint_path>/#/welcome/signin?hub_id=<hub_id>
```

`view=guest`, `scope`, `name` and `token` are all dropped:

- `scope` only ever selected a landing-page layout.
- `name` was the landing page's header. `Wm.loadWorkspace()` resolves the real
  workspace name itself (`media.attributes` + `media.get_path`).
- `token` authorised the landing page's `dmz.list_by_token` read. Nothing on the
  new path reads share content anonymously.
- `hub` becomes `hub_id`, which is the name the welcome router already reads.

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

- `arm(hub_id)` writes **both** `sessionStorage.drumee_hubDeepLink` (unchanged
  shape, so any other reader keeps working) and
  `localStorage.drumee_hubDeepLink = {hub_id, ts}`.
- `consume()` reads session first, then the localStorage fallback, ignores an
  intent older than 7 days, and clears both keys.
- `has()` answers the same question without consuming.
- `clear()` drops both keys.

The 7-day guard mirrors `_maybeOfferInvitedWorkspace`: an intent that outlives the
session can also outlive the recipient's interest, and the invite itself stays in
the activity list either way.

Call sites:

| File | Change |
|------|--------|
| `modules/welcome/index.js` | `arm(args.hub_id)` in place of the bare `setItem` |
| `modules/desk/wm/index.js` | `consume()` on the fallback path; the `#/desk/wm/hub?hub_id=` hash form keeps priority |
| `modules/desk/index.js` | `_hasDeepLink()` uses `has()`, so desk-state restore does not race an armed intent |

The secure-share branch in `desk/wm.onDomRefresh` clears **both** keys instead of
one — a secure-share return must still win over a hub deep link.

### 3. Resulting flow

```
email CTA  →  #/welcome/signin?hub_id=42
                 |
    +------------+-----------------+--------------------+
    | anonymous  | no account      | already signed in  |
    v            v                 v
 sign-in      sign-up -> verify   welcome sees hub_id -> arm
    |            | (create_account resolves            |
    |            |  pending_invitation -> membership)   |
    +------------+-----------------+--------------------+
                                   v
                            desk boot -> consume()
                                   v
                     Wm.loadWorkspace({hub_id})   <- pane opens, no prompt
```

Membership is granted exactly as before, and nothing about it moves:

- existing account → `_grantMembership` at invite time, plus the `hub.invite_received`
  websocket push;
- no account → `_addInviteToken` + `yp_add_pending_invitation`, resolved by
  `signup.create_account` → `_resolve_pending_invitation`.

### 4. What is deliberately left alone

Every link already sitting in an inbox carries `?view=guest&scope=…&token=…&hub=…`
and must keep working end to end, so none of this is removed:

- the `signin_guest` widget, its skeletons and its sample/share/chat content;
- the `view=guest` branch in `signin_router.onDomRefresh`;
- `dmz.list_by_token` / `dmz.chat_by_token` (no consumer other than that widget);
- the desk's `drumee_guest_join` prompt — `_armJoinIntent`,
  `_maybeOfferInvitedWorkspace` and the `guest-join-open-workspace` handler.

Retiring any of it is a separate decision, taken once no old link can plausibly
still be clicked.

## Verification

Neither repo has a test runner (`package.json` scripts are dev/deploy only), so:

- a throwaway node harness asserting `_inviteCtaLink`'s output and the
  `hub-deep-link` age-guard / precedence rules — both pure, no DB, no DOM;
- a manual click-through on `local.drumee` for the anonymous and
  already-signed-in cases.

This box only serves `local.drumee`, so the link string and the storage logic can
be verified here but a real inbox → production workspace open cannot.

## Risks

- **A stale localStorage intent.** Bounded by the 7-day guard and by `consume()`
  clearing both keys on the first read.
- **Recipients on an old link get the old four-hop flow.** Accepted: it still
  works, and it drains as inboxes age.
- **No preview before signing in.** The email itself carries the preview rows and
  the recent-activity snippets, which is where a recipient actually sees them.
