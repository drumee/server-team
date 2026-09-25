# Enable the new-user cutoff for tutorial tours (production)

**Target:** https://app.drumee.com/-/#/desk (the `main` endpoint)
**Goal:** contextual tutorial tours (desk workspace tour; window migrate, chat,
meeting, task and share tours) are shown to accounts created **after** the
release only. Accounts that existed before it never see them.

How it works: the server reads `tours_new_user_since` (unix seconds) from
`myDrumee.json` and sends it to the browser in `yp.get_env`. The UI compares it
with the account's creation time (`entity.ctime`) and offers no tour when the
account is older. No database change is involved.

Explicit requests still work for everyone: `?tutorial=<id>` in the URL and
**Get help → Product Tour**.

---

## 0. State of production when this guide was written (2026-09-25)

| Check | Value |
|---|---|
| `contextual_tours` | `1` (tours are on) |
| `tours_new_user_since` in `yp.get_env` | **absent** — server code not deployed |
| UI bundle contains the check | **no** — UI code not deployed |

So the code must be deployed first (step 1). Adding the key alone does nothing.

---

## 1. Deploy the code

Both changes are on branch `feat/tours-new-users-only`:

| Repo | Commit | File |
|---|---|---|
| server-team | `efda7b8` | `service/lib/env.js` |
| ui-team | `f6bd2843` | `src/drumee/libs/tutorial-tours.js` |

Merge them through the normal `preview` → production release, and deploy
**server-team** and **ui-team** to the `main` endpoint.

Order does not matter: the server sends `0` while the key is missing, and `0`
means "no cutoff" — today's behaviour.

---

## 2. Pick the cutoff

Use the moment the release goes live. On the server, right after the deploy:

```bash
date +%s          # e.g. 1790306573
date -u -d @$(date +%s)   # human-readable, for the record
```

Every account created **before** this second is treated as old.
Do not pick an earlier date: recent sign-ups who have not seen the tours yet
would lose them.

---

## 3. Find the config file the `main` service reads

On production, as a user with sudo:

```bash
# The service process for the main endpoint
ps -eo pid,lstart,args | grep "server/main/service.js" | grep -v grep

# The config is loaded by loadSysEnv(); default path:
ls -l /etc/drumee/conf.d/myDrumee.json

# Check the main runtime does not use a chroot (a per-endpoint copy, like
# stage's conf.d/liam/myDrumee.json). No chroot argument = the default path.
grep -n "loadSysEnv" /srv/drumee/runtime/server/main/index.js /srv/drumee/runtime/server/main/configs.js
ls -d /etc/drumee/conf.d/*/
```

If a per-endpoint directory exists for `main`, edit that file instead.
Note: `/etc/drumee/conf.d/myDrumee.json` is usually **shared** by every endpoint
on the box. Adding the key is harmless for endpoints running older code — they
ignore it.

---

## 4. Add the key

```bash
F=/etc/drumee/conf.d/myDrumee.json
TS=1790306573            # <- the value from step 2

# Back up, keeping owner and mode
sudo cp -p "$F" "$F.bak-preToursCutoff"

# Add or replace the key without hand-editing the JSON
sudo python3 - "$F" "$TS" <<'EOF'
import json, sys
path, ts = sys.argv[1], int(sys.argv[2])
data = json.load(open(path))
data["tours_new_user_since"] = ts
open(path, "w").write(json.dumps(data, indent=2))
EOF

# Must print the key, and the file must still be valid JSON
python3 -m json.tool "$F" | grep -n "contextual_tours\|tours_new_user_since"
ls -l "$F"               # owner should still be www-data
```

The result should contain:

```json
  "contextual_tours": 1,
  "tours_new_user_since": 1790306573
```

---

## 5. Restart the service

`myDrumee.json` is read **only at startup**.

```bash
sudo drumee restart main/service
ps -eo pid,lstart,args | grep "server/main/service.js" | grep -v grep   # start time must be after step 4
```

---

## 6. Verify

From any machine, no login needed:

```bash
# 1. The server sends the cutoff
curl -s "https://app.drumee.com/-/service/yp.get_env" | python3 -c \
 "import json,sys; d=json.load(sys.stdin); d=d.get('data',d); p=d['platform']; print(p.get('contextual_tours'), p.get('tours_new_user_since'))"
# expected: 1 1790306573

# 2. The live UI bundle has the check
M=$(curl -s "https://app.drumee.com/-/" | grep -o 'main-[0-9a-f]*\.js' | head -1)
curl -s "https://app.drumee.com/-/app/$M" | grep -c tours_new_user_since
# expected: 1 or more
```

In the browser (use a private window — the browser keeps its own per-account
record of seen tours):

1. **Old account** (created before the cutoff): open a workspace, then Files,
   Chat, Meet, Tasks and Manage access. **No tour appears.**
2. Same account with `?tutorial=chat` in the URL: the chat tour **does** appear.
3. **New account** (sign up after the cutoff): tours appear as before.

Tabs that were open before the UI deploy keep the old code until a full reload.

---

## Rollback

```bash
F=/etc/drumee/conf.d/myDrumee.json
sudo cp -p "$F.bak-preToursCutoff" "$F"
sudo drumee restart main/service
```

To switch the cutoff off without restoring the file, set
`"tours_new_user_since": 0` and restart. `0` means every account is eligible.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `yp.get_env` shows no `tours_new_user_since` | Server code not deployed to `main` |
| `yp.get_env` shows `0` | Key missing from the file the service reads, or service not restarted |
| Old accounts still get tours | UI not deployed, or the tab was not reloaded |
| New accounts get no tours | Cutoff set in the future, or `contextual_tours` is `0` |

Stage reference: this was done on 2026-09-25 for `https://drumee.in/-/huan/`
with `tours_new_user_since = 1790306573` in the shared
`/etc/drumee/conf.d/myDrumee.json` (backup `myDrumee.json.bak-preToursCutoff`).
