# Contact Invite — Pending Tab Visibility Fix

**Date:** 2026-05-15
**Status:** Approved (revised after DB-level diagnosis)
**Repos affected:** `server-team` only

## Problem

When User A sends a contact request to User B via "Add contacts", the request
does not appear in User B's Pending tab — not on a live update, and not even
after User B reopens the Contacts panel or clicks the Pending tab manually.

## Reproduction (verified live on drumee.in)

1. Signed in as Snake MX (`vudangnt@gmail.com`), sent a contact invite to
   `tranhoanghuan071003@gmail.com`. Server returned `status: "sent"` — success
   on the sender side.
2. Signed in as Tran (receiver), opened Contacts → Pending tab. The tab showed
   only invitations Tran had *sent*; Snake's incoming request was absent.
3. Called `contact.invite_get` directly (POST) → `data: []` (empty).
4. Called `activity.list` directly → **returned Snake's row** with
   `status: "received"`.

## Root cause

Two independent bugs, both in `server-team`.

### Bug 1 — `invite_get` discards a single-row result

The contact row IS created on the receiver's database. Verified directly:

```
SELECT … FROM `0_52d367d252d367d3`.contact WHERE entity = '181ffe62181ffe67';
-- sys_id 27, entity 181ffe62181ffe67, status 'received', dismissed_at … , ctime …
```

Calling the procedure directly also returns the row:

```
CALL `0_52d367d252d367d3`.contact_notification_get();
-- drumate_id 181ffe62181ffe67, email vudangnt@gmail.com, status received, …
```

So the `contact_notification_get` stored procedure is **correct**. The bug is
in the server endpoint that wraps it.

`invite_get` ([service/private/contact.js:1563](../../service/private/contact.js)):

```js
const rows = await this.db.await_proc('contact_notification_get');
const list = Array.isArray(rows) ? rows : [];
if (list.length === 0) { this.output.list(list); return; }
```

`await_proc` runs the call and post-processes the result with the `get_rows()`
`Array.prototype` helper in
`@drumee/server-essentials/lib/addons/array.js`. That helper **recursively
collapses single-element result sets**: when a procedure returns exactly one
row, `get_rows()` returns the bare **row object**, not a one-element array.

`invite_get` then does `Array.isArray(rows) ? rows : []`. Because `rows` is an
object, `Array.isArray` is false → `list = []` → the endpoint reports an empty
Pending tab.

- Receiver has **exactly 1** pending invitation → `rows` is an object → bug.
- Receiver has **2+** pending invitations → `rows` is an array → works.

This is why a receiver with a single incoming request sees nothing while one
with several sees them all. `activity.list` is unaffected because it normalises
its rollup result with `toArray(...)`; and `show_contact` is unaffected because
it passes the raw result straight to `this.output.list()`, which already wraps
non-arrays (`if (!isArray(data)) data = [data]`). `invite_get` is the only
contact endpoint that applies its own `Array.isArray` guard *before* reaching
`output.list()`.

### Bug 2 — WS broadcast to the receiver omits the service name

After the contact row is created, the server broadcasts a WebSocket
notification to the receiver's sockets at
[service/private/contact.js:1293](../../service/private/contact.js):

```js
await RedisStore.sendData(this.payload(data), sockets);
```

`this.payload(data)` is called with no `{ service }` option. The receiver's
address-book widget (`onWsMessage`) only refreshes the Pending list when the
incoming message's `service` equals `SERVICE.contact.invite`. Without an
explicit service name the message is ignored, so the Pending tab does not
auto-refresh. The correct pattern is already used elsewhere in the same file —
e.g. `invite_accept` at line 1532 passes
`{ service: this.input.get(Attr.service) }`.

## Fix

Both changes are in `server-team/service/private/contact.js`. No schema change.

### Fix 1 — `invite_get` (line ~1565)

Use the existing `toArray` helper instead of the `Array.isArray` guard:

```js
// before
const list = Array.isArray(rows) ? rows : [];

// after
const list = toArray(rows);
```

`toArray` is already imported at the top of the file
(`const { toArray } = utils;`). Its behaviour:
- single object → `[object]`
- array → unchanged
- empty / null / undefined → `[]`

This makes `invite_get` correct for the 1-row, N-row, and empty cases alike.

### Fix 2 — WS broadcast (line 1293)

Attach the request's service name to the broadcast payload:

```js
// before
await RedisStore.sendData(this.payload(data), sockets);

// after
const service = this.input.get(Attr.service);   // "contact.invite"
await RedisStore.sendData(this.payload(data, { service }), sockets);
```

`this.input.get(Attr.service)` resolves to `contact.invite`, which is exactly
the value the receiver's `onWsMessage` switch matches against
(`SERVICE.contact.invite`). This mirrors the existing pattern at
`contact.js:1532`.

## Data flow after the fix

1. Sender → `contact.invite` → server runs `contact_invite` → row inserted on
   the receiver's database with `status='received'`.
2. Server detects `after.status === 'received'`, broadcasts to the receiver's
   sockets **with `service: 'contact.invite'`**.
3. Receiver's address-book `onWsMessage` matches `SERVICE.contact.invite` →
   calls `_loadInvitations()` → `contact.invite_get` → `invite_get` now wraps
   the single-row result with `toArray` → Pending tab updates live.
4. If the WS is missed (cold cache, disconnected client), the receiver clicking
   the Pending tab also calls `_loadInvitations()` and now sees the row.

## Testing

Manual verification on drumee.in after deploy:

1. Sign in as Snake, send an invite to a receiver who has **zero** other
   pending invitations (this is the 1-row case that exposed the bug).
2. Sign in as the receiver in a separate browser context → open Contacts →
   Pending tab shows Snake's request.
3. Repeat with the receiver's Contacts panel already open during step 1 — the
   Pending count updates without a manual refresh (exercises Fix 2).

## Out of scope

- No frontend (`ui-team`) changes. The address-book widget already re-fetches
  on tab click, panel mount, and the `SERVICE.contact.invite` WS event.
- No schema (`schemas`) changes. `contact_notification_get.sql` is correct.
- The `get_rows()` single-row-collapsing behaviour in `@drumee/server-essentials`
  is the deeper cause and affects any caller that does not normalise its result.
  Auditing every such caller is out of scope here; `toArray` at the `invite_get`
  call site is the targeted fix. A broader audit can be a follow-up.
