# Referral code in Account Settings → Profile — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a signed-in user view and copy their referral code + link from Account Settings → Profile.

**Architecture:** A new authenticated `server-team` service (`drumate.get_referral_code`) reuses the reward-hub proc against the live reward DB and returns `{referral_code, referral_url}` with a per-tenant link. The `ui-team` Account Settings widget fetches it, stores it in the model, renders a referral section in the Profile skeleton, and copies values via `copyToClipboard`.

**Tech Stack:** Node (drumee `@drumee/server-core` Entity services + MariaDB procs), webpack UI (`@drumee/ui-core` LetcBox widgets, `@drumee/ui-essentials`).

## Global Constraints

- Reward DB name comes from `reward_hub_conf.db_name` (`Cache.getSysConf('reward_hub_conf')`) — **never hardcode** `C_reward`.
- Referral link = `${this.input.homepath()}#/welcome/signup?ref=<code>` (per-tenant homepath).
- Referral code proc `reward_get_referral_code(uid)` is idempotent (get-or-create); call it with the authenticated `this.uid`.
- One code per user (`user_referral_code.user_id` PK); code is 6 chars.
- Copy uses `copyToClipboard` from `@drumee/ui-essentials` (as in `sharebox-setting`).
- Deploy/verify against tenant `huan` on `drumee.in` (served at `https://drumee.in/-/huan/`); the reward DB there is what `reward_hub_conf.db_name` resolves to.

---

## File Structure

**server-team**
- `service/private/drumate.js` — add `get_referral_code()` method (+ import `Cache`, `toArray`).
- `acl/drumate.json` — add `get_referral_code` ACL entry.

**ui-team**
- `src/drumee/lex/services.json` — map `drumate.get_referral_code`.
- `src/drumee/builtins/widget/settings/account/index.js` — fetch + model + copy dispatch (+ import `copyToClipboard`).
- `src/drumee/builtins/widget/settings/account/skeleton/profile.js` — referral section.
- `src/drumee/builtins/widget/settings/account/skin/index.scss` — referral section styles.

---

## Task 1: Backend — `drumate.get_referral_code` service + ACL

**Files:**
- Modify: `server-team/service/private/drumate.js` (imports near line 22-24; add method in the class)
- Modify: `server-team/acl/drumate.json` (services block)

**Interfaces:**
- Produces: service `drumate.get_referral_code` (POST/GET, `scope: hub`, `permission: owner`) → `{ referral_code: string, referral_url: string }` on success, or `{ error: string }` on failure.

- [ ] **Step 1: Add imports**

In `service/private/drumate.js`, the destructure from `@drumee/server-essentials` currently reads:
```js
const {
  Messenger, DrumeeCache, RedisStore
} = require("@drumee/server-essentials")
```
Change it to add `Cache` and `toArray`:
```js
const {
  Messenger, DrumeeCache, RedisStore, Cache, toArray
} = require("@drumee/server-essentials")
```
(If `Cache`/`toArray` are already present in this or another require line, don't duplicate — just ensure both are in scope.)

- [ ] **Step 2: Add the `get_referral_code` method**

Add this method inside the `class` in `service/private/drumate.js` (near `update_profile`):
```js
  /**
   * Get or create the signed-in user's referral code + link.
   * Reads the live reward DB from reward_hub_conf, calls the reward-hub
   * proc (idempotent get-or-create), and builds a per-tenant referral link.
   */
  async get_referral_code() {
    let rewardDb = null;
    try {
      rewardDb = JSON.parse(Cache.getSysConf('reward_hub_conf') || '{}').db_name;
    } catch (e) {
      rewardDb = null;
    }
    if (!rewardDb) {
      return this.output.data({ error: 'reward_not_configured' });
    }
    let code = null;
    try {
      const rows = toArray(await this.yp.await_proc(`${rewardDb}.reward_get_referral_code`, this.uid));
      code = (rows[0] || {}).referral_code || null;
    } catch (e) {
      this.warn('[drumate.get_referral_code] proc failed', e && e.message);
      return this.output.data({ error: 'referral_unavailable' });
    }
    if (!code) {
      return this.output.data({ error: 'referral_unavailable' });
    }
    const referral_url = `${this.input.homepath()}#/welcome/signup?ref=${encodeURIComponent(code)}`;
    this.output.data({ referral_code: code, referral_url });
  }
```

- [ ] **Step 3: Add the ACL entry**

In `acl/drumate.json`, inside the `"services": { ... }` object, add:
```json
    "get_referral_code": {
      "doc": "Get or create the signed-in user's referral code and link.",
      "scope": "hub",
      "permission": { "src": "owner" }
    },
```
(Place it next to `update_profile`; ensure valid JSON — trailing commas only where the format allows.)

- [ ] **Step 4: Syntax-check both files**

Run:
```bash
cd /home/drumee/server-team
node --check service/private/drumate.js && echo JS_OK
node -e "JSON.parse(require('fs').readFileSync('acl/drumate.json','utf8')); console.log('JSON_OK')"
```
Expected: `JS_OK` and `JSON_OK`.

- [ ] **Step 5: Deploy to huan and restart**

The deployed copy lives under the endpoint runtime. Deploy the two files and restart the service:
```bash
DS=/srv/drumee/runtime/server/... # server-team deploy path for the huan endpoint
```
Determine the deployed server-team path for huan first:
```bash
ssh huan@drumee.in "sudo pm2 describe huan/service | grep -iE 'cwd|script path' "
```
Then copy the two edited files to that deployed tree (mirror the repo-relative paths `service/private/drumate.js` and `acl/drumate.json`) via `sudo tee`, and restart:
```bash
ssh huan@drumee.in "sudo drumee start huan/service && echo RESTARTED"
```

- [ ] **Step 6: Verify the code lands in the LIVE reward DB via the proc path**

Confirm the live reward DB and that the proc get-or-creates for a real user (use a known uid, e.g. h0anghu7n = `1fe9136a1fe9137f`):
```bash
ssh huan@drumee.in "LIVE=\$(sudo mysql yp -N -e \"CALL get_sys_conf()\" | awk -F'\t' '/reward_hub_conf/{print \$2}' | sed -E 's/.*\"db_name\": *\"([^\"]+)\".*/\1/'); echo LIVE=\$LIVE; sudo mysql \$LIVE -e \"CALL reward_get_referral_code('1fe9136a1fe9137f')\""
```
Expected: prints `LIVE=c_...` and a `referral_code | status` row (`existing` or `generated`). A second run returns the **same** code (`existing`).

- [ ] **Step 7: Commit**

```bash
cd /home/drumee/server-team
git checkout -b feat/referral-code-account-settings 2>/dev/null || git checkout feat/referral-code-account-settings
git add service/private/drumate.js acl/drumate.json
git commit -m "feat(drumate): add get_referral_code service (reward code + per-tenant link)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Frontend — service mapping + fetch/copy wiring

**Files:**
- Modify: `ui-team/src/drumee/lex/services.json` (`drumate` block)
- Modify: `ui-team/src/drumee/builtins/widget/settings/account/index.js`

**Interfaces:**
- Consumes: `drumate.get_referral_code` from Task 1.
- Produces: model keys `referral_code`, `referral_url`, `referral_error` (read by Task 3's skeleton); `onUiEvent` cases `copy-referral-code` / `copy-referral-link`.

- [ ] **Step 1: Map the service**

In `src/drumee/lex/services.json`, inside the `"drumate": { ... }` object, add:
```json
    "get_referral_code": "drumate.get_referral_code",
```
Verify JSON:
```bash
cd /home/drumee/ui-team
node -e "JSON.parse(require('fs').readFileSync('src/drumee/lex/services.json','utf8')); console.log('JSON_OK')"
```
Expected: `JSON_OK`.

- [ ] **Step 2: Import `copyToClipboard`**

At the very top of `builtins/widget/settings/account/index.js` (before the class declaration on line 5), add:
```js
const { copyToClipboard } = require("@drumee/ui-essentials");
```

- [ ] **Step 3: Add the `loadReferral` method**

Add this method to the `settings_account` class (e.g. after `getApi()`):
```js
  /**
   * Fetch the user's referral code/link once, store on the model, and
   * re-render the Profile tab so the section fills in. POST (not GET) to
   * avoid the browser HTTP-caching stale fetchService GETs.
   */
  async loadReferral() {
    if (this._referralFetched) return;
    this._referralFetched = true;
    try {
      const data = await this.postService(SERVICE.drumate.get_referral_code, {
        hub_id: Visitor.id,
      });
      if (data && data.referral_code) {
        this.mset({ referral_code: data.referral_code, referral_url: data.referral_url || "" });
      } else {
        this.mset({ referral_error: 1 });
      }
    } catch (e) {
      this.warn("[account] get_referral_code failed", e);
      this.mset({ referral_error: 1 });
    }
    if (this._page === 0 && this.__content) {
      this.__content.feed(this.skeletons[0](this));
    }
  }
```

- [ ] **Step 4: Trigger the fetch on mount**

In `onDomRefresh()` (currently lines 73-77), add the `loadReferral()` call after the feed:
```js
  onDomRefresh() {
    this._page = 0;
    this._category = "*";
    this.feed(require("./skeleton").default(this));
    this.loadReferral();
  }
```

- [ ] **Step 5: Add copy dispatch cases**

In `onUiEvent(cmd, args)`, inside the `switch (service)` block, add these cases (e.g. right before `case "manage-seats":`):
```js
      case "copy-referral-code": {
        const v = this.mget("referral_code");
        if (v) copyToClipboard(v);
        return;
      }

      case "copy-referral-link": {
        const v = this.mget("referral_url");
        if (v) copyToClipboard(v);
        return;
      }
```

- [ ] **Step 6: Syntax-check**

Run:
```bash
cd /home/drumee/ui-team
node --check src/drumee/builtins/widget/settings/account/index.js && echo JS_OK
```
Expected: `JS_OK`.

- [ ] **Step 7: Commit**

```bash
cd /home/drumee/ui-team
git checkout -b feat/referral-code-account-settings 2>/dev/null || git checkout feat/referral-code-account-settings
git add src/drumee/lex/services.json src/drumee/builtins/widget/settings/account/index.js
git commit -m "feat(settings): fetch referral code + copy handlers in account widget

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Frontend — referral section in Profile + styles

**Files:**
- Modify: `ui-team/src/drumee/builtins/widget/settings/account/skeleton/profile.js`
- Modify: `ui-team/src/drumee/builtins/widget/settings/account/skin/index.scss`

**Interfaces:**
- Consumes: model keys `referral_code`, `referral_url`, `referral_error` and `onUiEvent` cases from Task 2.

- [ ] **Step 1: Add the `referral` section function**

In `skeleton/profile.js`, add this function above `settings_body`:
```js
/**
 * Referral section: shows the user's code + link, each with a copy button.
 * Reads values from the widget model (populated by account.loadReferral()).
 */
function referral(ui) {
  const fig = `${ui.fig.family}__referral`;
  const code = ui.mget("referral_code");
  const url = ui.mget("referral_url");
  const errored = ui.mget("referral_error");

  const row = (label, value, copyService) =>
    Skeletons.Box.Y({
      className: `${fig}-row`,
      kids: [
        Skeletons.Note({ className: `${fig}-label`, content: label }),
        Skeletons.Box.X({
          className: `${fig}-field`,
          kids: [
            Skeletons.Note({ className: `${fig}-value`, content: value || "Loading…", active: 0 }),
            value
              ? Skeletons.Box.X({
                  className: `${fig}-copy`,
                  service: copyService,
                  uiHandler: [ui],
                  kids: [Skeletons.Note({ className: `${fig}-copy-txt`, content: LOCALE.COPY || "Copy" })],
                })
              : null,
          ],
        }),
      ],
    });

  return Skeletons.Box.Y({
    className: `${fig}`,
    kids: [
      Skeletons.Note({ className: `${fig}-title`, content: "Invite & earn" }),
      errored
        ? Skeletons.Note({ className: `${fig}-muted`, content: "Referral not available yet" })
        : Skeletons.Box.Y({
            className: `${fig}-rows`,
            kids: [
              row("Referral code", code, "copy-referral-code"),
              row("Referral link", url, "copy-referral-link"),
            ],
          }),
    ],
  });
}
```

- [ ] **Step 2: Append the section to `settings_body`**

Change `settings_body` (currently returns `[user(ui), spacer, form(ui)]`) to:
```js
function settings_body(ui) {
  return [
    user(ui),
    Skeletons.Element({ className: `${ui.fig.family}__spacer` }),
    form(ui),
    Skeletons.Element({ className: `${ui.fig.family}__spacer` }),
    referral(ui),
  ];
}
```

- [ ] **Step 3: Add styles**

Append to `skin/index.scss` (use the widget's family prefix; match the file's existing selector style — the family is the same `&__…` root used by `__avatar`, `__spacer`, etc.):
```scss
  &__referral {
    display: flex;
    flex-direction: column;
    gap: 12px;

    &-title { font-weight: 600; }
    &-muted { opacity: 0.6; }
    &-rows { display: flex; flex-direction: column; gap: 10px; }
    &-row { display: flex; flex-direction: column; gap: 4px; }
    &-label { font-size: 12px; opacity: 0.7; }
    &-field {
      display: flex;
      align-items: center;
      gap: 8px;
      justify-content: space-between;
    }
    &-value {
      font-family: monospace;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    &-copy {
      cursor: pointer;
      padding: 4px 10px;
      border-radius: 6px;
      background: rgba(83, 74, 183, 0.1);
      white-space: nowrap;
    }
  }
```
(Nest it under the same root selector block that holds `&__avatar` / `&__spacer` in this file. If those live at the top level rather than nested, add `.<family>__referral { … }` as a top-level rule mirroring the existing pattern — inspect the file first and follow whatever nesting it already uses.)

- [ ] **Step 4: Build & deploy the UI (one-shot)**

ui-team uses the same tooling as analytics-ui. `drumee-ui-deploy devel` sources `.dev-tools.rc/devel.sh` (targets `drumee.in`, `BUILD_TARGET=app`, `UI_RUNTIME_PATH=/srv/drumee/runtime/ui/<user>/`), builds via webpack, and rsyncs to the endpoint. Run a one-shot build+deploy (webpack must be on PATH; `NO_WATCH=1` disables watch mode):
```bash
cd /home/drumee/ui-team
export PATH="$PWD/node_modules/.bin:$PATH"
rm -f /tmp/home-drumee-ui-team-drumee-ui-deploy.pid 2>/dev/null
NO_WATCH=1 drumee-ui-deploy devel 2>&1 | tail -20
```
Expected: `webpack … compiled successfully` and `Done!` (the sync step). This rebuilds and deploys the **whole desk app** for the endpoint — heavier than a plugin build; confirm no webpack errors.
> If `devel.sh` references an unset `$user`, set the endpoint first (e.g. `export user=huan`) or use the repo's normal `npm run dev` watch flow; confirm `UI_RUNTIME_PATH` resolves to `/srv/drumee/runtime/ui/huan/`.

- [ ] **Step 5: Verify end-to-end (manual)**

1. Load `https://drumee.in/-/huan/`, open **Account Settings → Profile** (hard-refresh once to bypass any cached bundle).
2. Confirm the **Invite & earn** section shows a **Referral code** and a **Referral link** whose domain is `drumee.in/-/huan/…` (not `app.drumee.org`).
3. Click each **Copy** button and paste elsewhere — verify the code / link copy correctly.
4. Confirm the link is `https://drumee.in/-/huan/#/welcome/signup?ref=<code>` and that `<code>` matches the row in the live reward DB (`user_referral_code`) for your uid.

- [ ] **Step 6: Commit**

```bash
cd /home/drumee/ui-team
git add src/drumee/builtins/widget/settings/account/skeleton/profile.js src/drumee/builtins/widget/settings/account/skin/index.scss
git commit -m "feat(settings): referral code + link section in account Profile

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Notes for the implementer

- **No unit-test harness** exists for these service/UI files in this codebase; verification is integration/manual (proc call, service deploy, UI load), as reflected in the steps.
- The reward proc runs against the **live** reward DB resolved at runtime — do not hardcode a DB name.
- If `copyToClipboard` isn't exported by the installed `@drumee/ui-essentials`, use the same copy mechanism `sharebox-setting/index.js` uses (import it the same way that file does).
- Server-team deploy path for `huan` is under `/srv/drumee/runtime/server/…`; confirm via `pm2 describe huan/service` before copying files.
