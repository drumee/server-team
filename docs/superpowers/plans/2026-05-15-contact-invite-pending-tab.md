# Contact Invite — Pending Tab Visibility Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a received contact request show up in the recipient's Pending tab, both on live WebSocket update and on manual refresh.

**Architecture:** Two targeted edits to one file, `server-team/service/private/contact.js`. Fix 1 makes `invite_get` normalise a single-row stored-procedure result into an array. Fix 2 adds the missing `service` name to the WebSocket broadcast so the recipient's widget recognises the event. No schema, no frontend changes.

**Tech Stack:** Node.js service layer (`@drumee/server-core`, `@drumee/server-essentials`), MariaDB stored procedures, Redis-backed WebSocket fan-out. No test runner exists in this repo — verification is manual via the deployed drumee.in instance and Playwright.

**Spec:** `docs/superpowers/specs/2026-05-15-contact-invite-pending-tab-design.md`

---

## Background an implementer needs

- `service/private/contact.js` is a request handler class. Each public method
  (`invite`, `invite_get`, `invite_accept`, …) is one API endpoint.
- `this.db.await_proc(name, ...args)` calls a MariaDB stored procedure on the
  current user's database and returns its result. Because of the `get_rows()`
  helper in `@drumee/server-essentials/lib/addons/array.js`, a procedure that
  returns **exactly one row** yields a bare **object**; two or more rows yield
  an **array**. Callers must normalise this.
- `utils.toArray(value)` (already imported in `contact.js` as
  `const { toArray } = utils;`) is the project's normaliser: object → `[object]`,
  array → unchanged, empty/null/undefined → `[]`.
- `this.payload(data, opts)` builds a WebSocket message envelope. The optional
  `opts.service` sets the `service` field that the browser client switches on.
- `RedisStore.sendData(payload, sockets)` fans the payload out to the given
  sockets.
- `this.input.get(Attr.service)` returns the current request's service name —
  here, the string `"contact.invite"`.

There is no automated test suite. "Run the test" steps below are manual
verification on the deployed instance.

---

## Task 1: Fix `invite_get` single-row result handling

**Files:**
- Modify: `service/private/contact.js` (method `invite_get`, around line 1563-1565)

**Context:** `invite_get` calls `contact_notification_get`, which returns the
recipient's pending invitations. When the recipient has exactly one pending
invitation the result is a single object, and the current
`Array.isArray(rows) ? rows : []` guard throws it away, producing an empty
Pending tab. `toArray` handles object, array, and empty cases uniformly.

- [ ] **Step 1: Confirm the current code**

Open `service/private/contact.js` and locate `async invite_get()`. The first
two lines of the method body are currently:

```js
  async invite_get() {
    const rows = await this.db.await_proc('contact_notification_get');
    const list = Array.isArray(rows) ? rows : [];
```

- [ ] **Step 2: Confirm `toArray` is imported**

Near the top of the file (around line 26) there must be:

```js
const { toArray } = utils;
```

It is already present. If it is somehow missing, add it — `utils` is destructured
from `require("@drumee/server-essentials")` at the top of the file.

- [ ] **Step 3: Apply the fix**

Replace this line inside `invite_get`:

```js
    const list = Array.isArray(rows) ? rows : [];
```

with:

```js
    const list = toArray(rows);
```

Leave the rest of the method unchanged. The `if (list.length === 0)` early
return, the activity-id enrichment query, and the final
`this.output.list(enriched)` all continue to work — they only required `list`
to be a real array.

- [ ] **Step 4: Verify the file parses**

Run: `node --check service/private/contact.js`
Expected: no output, exit code 0 (syntax OK).

- [ ] **Step 5: Commit**

```bash
git add service/private/contact.js
git commit -m "fix(contact): wrap single-row invite_get result with toArray

contact_notification_get returns a bare object when the recipient has
exactly one pending invitation; the Array.isArray guard discarded it,
leaving the Pending tab empty. toArray normalises object/array/empty."
```

---

## Task 2: Add the service name to the contact-invite WebSocket broadcast

**Files:**
- Modify: `service/private/contact.js` (method `invite`, line 1293)

**Context:** After the recipient's contact row is created, `invite` broadcasts a
WebSocket notification to the recipient's sockets. The recipient's address-book
widget only refreshes its Pending list when the message's `service` field
equals `SERVICE.contact.invite`. The broadcast currently omits `service`, so the
widget ignores it and the Pending tab does not auto-refresh. The sibling
endpoint `invite_accept` already does this correctly at line 1532.

- [ ] **Step 1: Confirm the current code**

In `service/private/contact.js`, inside `async invite()`, locate this block
(around lines 1290-1294):

```js
        if ((after.status != before.status) && (after.status == 'invitation' || after.status == 'received' || after.status == 'informed')) {
          data = await this.yp.await_proc('forward_proc', drumate.id, 'contact_notification_by_entity', `'${this.uid}'`)
          let sockets = await this.yp.await_proc('user_sockets', drumate.id);
          await RedisStore.sendData(this.payload(data), sockets);
        }
```

- [ ] **Step 2: Apply the fix**

Replace the single line:

```js
          await RedisStore.sendData(this.payload(data), sockets);
```

with these two lines:

```js
          const service = this.input.get(Attr.service);
          await RedisStore.sendData(this.payload(data, { service }), sockets);
```

`Attr` is already imported at the top of the file
(`const { Attr, Constants, Messenger, utils, RedisStore, Cache, nullValue } = require("@drumee/server-essentials");`).
`this.input.get(Attr.service)` resolves to `"contact.invite"`.

- [ ] **Step 3: Verify the file parses**

Run: `node --check service/private/contact.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add service/private/contact.js
git commit -m "fix(contact): tag invite WS broadcast with service name

The recipient's address-book widget only refreshes its Pending list for
messages whose service is SERVICE.contact.invite. The broadcast omitted
the service field, so live updates were dropped. Mirrors invite_accept."
```

---

## Task 3: Deploy and verify end-to-end on drumee.in

**Files:** none — verification only.

**Context:** No automated tests exist. Verify both fixes against the running
`vudangnt` instance on drumee.in using two accounts:
- Sender: Snake MX — `vudangnt@gmail.com` / `Admin@123!!!`
- Receiver: Tran — `tranhoanghuan071003@gmail.com` / `Tranh0anghuan710`

The receiver must start with **zero** other pending (received) invitations so
the 1-row case from the bug is exercised. If Tran already has a received row
from prior testing, refuse/clear it first so the count is zero.

- [ ] **Step 1: Deploy the server change**

Deploy `service/private/contact.js` to the `vudangnt` runtime
(`/srv/drumee/runtime/server/vudangnt/service/private/contact.js`) using the
project's normal server deploy path, then restart the `vudangnt` service so the
new code loads. Confirm with the user before restarting the service.

- [ ] **Step 2: Verify Fix 1 — manual refresh path**

As Snake, open Contacts → Add contacts → invite `tranhoanghuan071003@gmail.com`.
Sign in as Tran in a separate browser context, open Contacts → Pending tab.

Expected: Snake's request appears in the Pending tab. (Before the fix, with
exactly one received invitation, it was absent.)

Optionally confirm via the API directly in the browser console as Tran:

```js
await (await fetch('/-/vudangnt/svc/contact.invite_get', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ hub_id: window.Visitor.id })
})).text()
```

Expected: `data` is a non-empty array containing one entry with
`status: "received"` and `email: "vudangnt@gmail.com"`.

- [ ] **Step 3: Verify Fix 2 — live update path**

Refuse/clear the request from Task 3 Step 2 so Tran is back to zero received
invitations. Keep Tran's Contacts panel open on the Pending tab. As Snake, send
the invite again.

Expected: Tran's Pending tab updates **without a manual refresh** — the new
request appears and the Pending count increments within a second or two.

- [ ] **Step 4: Verify the multi-row case still works**

With Tran's first request still pending, have a second account (or re-use any
other Drumee user) send Tran another invite. Confirm both appear in Tran's
Pending tab.

Expected: both requests listed — confirms `toArray` did not regress the
2+-row path.
