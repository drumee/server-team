# Get referral code in Account Settings → Profile

**Date:** 2026-07-06
**Repos:** `server-team` (backend service), `ui-team` (Account Settings UI)
**Status:** Approved design — pending spec review

## Goal

Let a signed-in user see and copy their own referral code and referral link
from **Account Settings → Profile**, without opening the Reward Hub.

## Background

- The referral code lives in the live per-hub reward DB (`reward_hub_conf.db_name`,
  e.g. `c_67c9b37e67c9b37f`), table `user_referral_code` (PK `user_id`,
  `referral_code` UNIQUE), created/read by the proc `reward_get_referral_code(uid)`
  (idempotent: returns the existing code or generates a unique 6-char one).
- The referral link is `<homepath>#/welcome/signup?ref=<code>`. Signups via this
  link get `profile.$.ref = <code>`, which the analytics dashboard attributes.
- The existing reward-hub-ui builds the displayed link with a **hardcoded**
  `app.drumee.org` domain (it ignores the server's `referral_url`). This feature
  uses `input.homepath()` server-side so the link carries the correct per-tenant
  domain.

## Non-goals (YAGNI)

- No referral **stats** (clicks/signups) in this surface.
- No new Settings tab (section lives inside the existing Profile tab).
- No changes to reward-hub-server / reward-hub-ui.

## Backend — `server-team`

**New authenticated service `drumate.get_referral_code`** in
`service/private/drumate.js`:

```js
async get_referral_code() {
  let rewardDb;
  try { rewardDb = JSON.parse(Cache.getSysConf('reward_hub_conf') || '{}').db_name; } catch (e) {}
  if (!rewardDb) return this.output.data({ error: 'reward_not_configured' });
  const rows = toArray(await this.yp.await_proc(`${rewardDb}.reward_get_referral_code`, this.uid));
  const code = (rows[0] || {}).referral_code;
  if (!code) return this.output.data({ error: 'referral_unavailable' });
  const referral_url = `${this.input.homepath()}#/welcome/signup?ref=${encodeURIComponent(code)}`;
  this.output.data({ referral_code: code, referral_url });
}
```

- `this.uid` = the authenticated user (the referrer/owner).
- Calls the reward proc by qualified name against the live reward DB; reuses its
  idempotent get-or-create behavior (no code duplication).
- Requires `Cache` and `toArray` from `@drumee/server-essentials` (add to imports
  if not already present in the file).

**ACL** — add to `acl/drumate.json`:

```json
"get_referral_code": {
  "doc": "Get or create the signed-in user's referral code and link.",
  "scope": "hub",
  "permission": { "src": "owner" }
}
```

## Frontend — `ui-team`

1. **Service map** — add under `drumate` in `src/drumee/lex/services.json`:
   `"get_referral_code": "drumate.get_referral_code"`.

2. **`builtins/widget/settings/account/index.js`**
   - On Profile load, fetch `SERVICE.drumate.get_referral_code`
     (`{ service, hub_id: Visitor.id }`).
   - On success: `this.mset({ referral_code, referral_url })` and re-render the
     Profile tab so the section shows the values.
   - Copy buttons use the established desk pattern: `copyToClipboard` from
     `@drumee/ui-essentials`, invoked from the widget's `declareHandlers` switch
     (e.g. `case 'copy-referral-code': copyToClipboard(this.mget('referral_code'))`,
     `case 'copy-referral-link': copyToClipboard(this.mget('referral_url'))`), as
     done in `sharebox-setting`.

3. **`builtins/widget/settings/account/skeleton/profile.js`**
   - Add a `referral(ui)` section appended to `settings_body(ui)` after `form(ui)`.
   - Two rows: **Referral code** (`ui.mget("referral_code")`) and
     **Referral link** (`ui.mget("referral_url")`), each with a copy button.
   - Fallback text "Loading…" until the values arrive; if the fetch returned
     `{error}`, render a muted "Referral not available yet" line instead of the rows.

4. **Styles / locale**
   - Add referral-section styles to `builtins/widget/settings/account/skin/index.scss`.
   - Add a LOCALE label (e.g. `REFERRAL` / "Invite & earn") — or reuse a literal if
     no locale key is warranted.

## Data flow

```
Profile tab render
  → account/index.js fetch SERVICE.drumate.get_referral_code {hub_id}
  → server: JSON.parse(reward_hub_conf).db_name
           → CALL <rewardDb>.reward_get_referral_code(this.uid)   (get-or-create)
           → { referral_code, referral_url:`${homepath}#/welcome/signup?ref=<code>` }
  → mset(model) → profile.js renders code + link rows with copy buttons
```

## Error handling

- Reward hub not configured (`reward_hub_conf` missing / no `db_name`) → server
  returns `{ error: 'reward_not_configured' }`.
- Proc returns no code → `{ error: 'referral_unavailable' }`.
- UI: on any `error` (or missing `referral_code`), render the muted
  "Referral not available yet" line — never crash, never show a broken link.
- Copy: `copyToClipboard(value)`; guarded to no-op when the value is empty.

## Testing / verification

- Server: call `drumate.get_referral_code` as an authenticated user; assert it
  returns `{ referral_code, referral_url }`, that the code appears in the live
  reward DB's `user_referral_code`, and that a second call returns the **same**
  code (idempotent).
- Link correctness: `referral_url` uses the tenant homepath
  (`https://drumee.in/-/huan/#/welcome/signup?ref=<code>`), not `app.drumee.org`.
- UI: Profile tab shows the code + link; copy buttons copy the right values;
  error state renders gracefully when reward hub is unconfigured.
- Round-trip: signing up via the shown link sets `profile.$.ref` and the code
  resolves to this user's email in the analytics "Referred by" column.

## Files touched

**server-team**
- `service/private/drumate.js` — add `get_referral_code()` (+ imports if needed)
- `acl/drumate.json` — add ACL entry

**ui-team**
- `src/drumee/lex/services.json` — add service mapping
- `src/drumee/builtins/widget/settings/account/index.js` — fetch + model + re-render
- `src/drumee/builtins/widget/settings/account/skeleton/profile.js` — referral section
- `src/drumee/builtins/widget/settings/account/skin/index.scss` — styles
- locale file — referral label (if a key is added)
