# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Drumee Team Server is a Node.js backend for the Drumee collaborative platform. It exposes two HTTP servers and is designed to run inside the Drumee Docker environment with MariaDB, Redis, and a shared filesystem.

- **Push server** (`index.js`, port 23000): Serves web pages and manages WebSocket connections for real-time messaging.
- **Service server** (`service.js`, port 24000): REST-style API server that dispatches requests to service workers via ACL routing.

## Setup

```bash
# Install Drumee Docker first:
# https://github.com/drumee/documentation/wiki/Developer-Corner

npm install
npm run setup         # writes devel env config to ./devel/
npm run dev           # starts the development server via drumee-server-devel
```

Configuration is loaded from `/etc/drumee/conf.d/drumee.json` (global) and optionally `/etc/drumee/conf.d/<endpoint_name>/myDrumee.json` (per-endpoint). `configs.js` handles this along with arg parsing for `--restPort` (default 24000) and `--pushPort` (default 23000).

## Tests

```bash
npm run test:db       # MariaDB connectivity
npm run test:acl      # ACL resolution
npm run test:redis    # Redis connectivity
npm run test:cache    # Cache layer
npm run test:modules  # Module loading
```

Tests live in `test/`. There is no test runner framework; each is a standalone Node script.

## Architecture

### Request lifecycle (REST)

1. `service.js` creates an HTTP server and wraps each request in `Session` (from `@drumee/server-core`).
2. `router/rest/index.js` (`Acl` class) reads the `service` parameter (e.g. `drumate.get_profile`) from the request.
3. ACL splits `module.method`, looks up the module definition from `acl/<module>.json`, resolves the worker path (`service/private/<module>.js` or `service/<module>.js` for public), checks permission, then calls the matching method.
4. Workers extend `Entity` from `@drumee/server-core` and write responses via `this.output.data(...)`.

### ACL JSON format (`acl/*.json`)

Each file defines:
- `services`: map of service names → `{ scope, permission: { src }, method?, log?, doc?, params?, returns? }`.
- `modules`: `{ private: "service/private/<name>", public: "service/<name>" }` — paths relative to the repo root (`.js` appended automatically).

**Permission `src` values** (bitwise, cumulative — higher levels satisfy lower requirements):

| Value | Name | Meaning |
|---|---|---|
| `anonymous` | 1 | No authentication required |
| `read` | 2 | Authenticated, read access |
| `write` | 4 | Authenticated, write access |
| `admin` | 8 | Hub/org administrator |
| `owner` | 16 | Resource owner (highest) |

**Scope values:** `hub` (active workspace context required), `domain` (org-level auth), `public` (minimal checks).

**Other fields:**
- `method` — maps the service key to a different JS method name on the worker class.
- `log: true` — records the call to the services audit log.
- `permission.fast_check` — additional contextual check (e.g. `"user_permission"` for file/folder ops).
- `doc`, `params`, `returns`, `errors` — documentation only; no runtime effect.

Rules: no duplicate keys, no curly braces in `doc` strings, error codes must match implementation exactly.

To add a new service: add an entry to the relevant `acl/<module>.json`, then implement the method in the corresponding worker class.

### WebSocket (Push server)

`router/push/index.js` holds `__websocket_router` (singleton). It manages socket connections in a `Map`, binds sockets to sessions via MariaDB stored procs (`socket_bind`, `socket_free`, etc.), and routes downstream events from Redis pub/sub to the correct socket.

### Offline workers (`offline/`)

Long-running background processes launched separately (not via `npm run dev`):

- `offline/drumate/backup.js` — exports user data as ZIP (files, workspace, chat, activity); spawned as a child process by the `drumate.backup` service; sends progress via Redis.
- `offline/workers/` — `indexWorker.js` (search indexing), `trashWorker.js`, `expiryWorker.js`.
- `offline/factory/` — maintains the drumate/hub MariaDB schema pool (pre-creates DB schemas up to a watermark).
- `offline/drumate.js` — entry point that starts the factory loop.

### Client / page rendering (`client/`)

`client/page.js` handles browser requests: UA detection, page hash versioning, and rendering HTML shells for the SPA. It uses `@drumee/server-core`'s `RuntimeEnv`.

### Key dependencies

| Package | Role |
|---|---|
| `@drumee/server-core` | `Session`, `Input`, `Output`, `Entity`, `MfsTools`, `Data` |
| `@drumee/server-essentials` | `sysEnv`, `Cache`, `RedisStore`, `Mariadb`, `Offline`, `Events`, `Constants`, `Attr` |
| `@drumee/schemas-utils` | MariaDB schema helpers |
| `mariadb` / `mysql` | Database access (via `Mariadb` wrapper from essentials) |
| `ioredis` / `redis` | Redis pub/sub and session store |
| `bull` | Job queues for offline tasks |
| `websocket` | WebSocket server (ws protocol: `service` or `ping`) |

### Globals set at startup

| Global | Set by |
|---|---|
| `global.websocketRouter` | `router/push/index.js` after Redis init |
| `global.Cache` | `index.js` after `DrumeeCache.load()` |
| `global.myDrumee` | `configs.js` after loading JSON config |
| `global.verbosity` | `configs.js` / `router/push/index.js` (0–5) |
| `global.myQuota` | `configs.js` |

### Signal handling

`SIGHUP` triggers a hot reload: `configs.load(1)` re-reads the JSON config and optionally reloads plugins/cache without restarting the process.

## Schemas repository (`../schemas`)

The companion repo at `/home/somanos/github/schemas` owns all SQL definitions. **Do not write raw SQL in service code** — all DB operations go through stored procedures defined there.

**One routine per file** — every `.sql` file contains exactly one stored procedure, function, table definition, or trigger.

### Database classes

| Class | Directory | Purpose |
|---|---|---|
| `yellow_page` / `yp` | `yellow_page/` | Central directory, auth, admin, contacts, OAuth |
| `hub` | `hub/` | Workspace DB — channels, files, sharing |
| `drumate` | `drumate/` | Per-user DB — chat, contacts, desk, media, stats |
| `common` | `common/` | MFS core procedures shared by hub and drumate |
| `mailserver` | `mailserver/` | Email server backend |
| `utils` | `utils/` | Shared utility functions/UDFs |
| `licence` | `licence/` | Licensing and entitlement |
| `costums` | `costums/` | Customer-specific overrides (multi-tenant) |

### Patching commands

```bash
# Apply a single SQL file
bin/patch-from-file <routine-file-path> <db_name|db_class>

# Apply all files in a manifest
bin/patch-from-manifest patches/

# Generate manifest from changed files between two commits
bin/make-manifest <git_hash1> <git_hash2>
```

The patching engine (`bin/patch.js`) connects via MariaDB Unix socket. For `hub`/`drumate`/`common` targets it discovers and patches all matching DB instances on the server; for `yellow_page`/`yp` it targets the single YP database.

### Directory layout (ignore `templates/`)

```
yellow_page/procedures/<feature>/   # admin, auth, contact, directory, domain, guest, mfs, ...
yellow_page/tables/                 # ~34 table definitions
hub/procedures/<feature>/           # channel, conference, media, share, ...
drumate/procedures/<feature>/       # chat, contact, desk, media, stats, ...
common/procedures/mfs/              # Core mfs_* procedures (used by hub and drumate)
common/procedures/mfs-trash/
patches/                            # Active manifest + migration SQL files
```

### SQL file conventions

```sql
DELIMITER $

-- =========================================================
-- procedure_name
-- =========================================================
DROP PROCEDURE IF EXISTS `procedure_name`$
CREATE PROCEDURE `procedure_name`(
  IN _param1 TYPE,
  IN _param2 TYPE
)
BEGIN
  -- body
END $

DELIMITER ;
```

- Always `DROP ... IF EXISTS` before `CREATE` (idempotent)
- Input parameters and internal variables prefixed with `_`

## Database conventions

**All DB operations must go through stored procedures — no raw SQL in service code.**

```js
// Result set (array of rows)
const rows = await this.yp.await_proc("proc_name", arg1, arg2);

// Scalar value
const val = await this.yp.await_func("func_name", arg1);
```

Pass objects/arrays directly — do not `JSON.stringify()` them manually.

**Database naming:**
- Hub DB: UUID-derived, no prefix (e.g. `ab12cd34ef56`)
- User DB: `9_` prefix + UUID (e.g. `9_ab12cd34ef56`)
- Yellow Pages (identity/global): fixed name `yp`

**Common stored procedures:**

| Procedure | Description |
|---|---|
| `socket_bind(args)` | Bind socket to session |
| `socket_free(socket_id)` | Release socket on disconnect |
| `socket_reset(endpoint)` | Reset all sockets for endpoint |
| `socket_refresh(endpoint, ids[])` | Keepalive ping for active sockets |
| `cookie_retrieve_user(sid)` | Get user from session cookie |
| `cookie_touch({socket_id, sid, uid})` | Update session timestamp |
| `drumate_exists(email)` | Check user by email (YP) |
| `get_db_name(hub_id)` | Get hub DB name (function) |
| `mfs_create_node` | Create file/folder node |
| `mfs_move` | Move nodes |
| `mfs_copy` | Copy nodes |
| `mfs_trash_media` | Send node to trash |
| `mfs_restore` | Restore from trash |
| `mfs_purge` | Permanently delete node |
| `mfs_manifest` | Export folder hierarchy |
| `mfs_access_node` | ACL-validated node access |
| `pageToLimits(page, OUT offset, OUT range)` | Convert page number to SQL LIMIT/OFFSET |
| `hub_get_members_by_type(uid, type, page)` | Paginated hub member list |
| `count_media(JSON)` | Count user's active files |
| `count_folders(JSON)` | Count user's active folders |
| `tag_add/get/remove/rename/reposition` | Tag CRUD (user DB) |

## MFS (Media File System)

Files are stored at `{mfs_dir}/{VFS_ROOT_NODE}/{node_id}/` on the host — this path is never exposed to clients. All access is through service endpoints that call stored procedures enforcing permission checks before any I/O.

**Node types:** `folder`, `file`, `hub` (special root folder for a workspace).

Each node has: `id` (UUID), `parent_id`, `owner_id`, `filename`, `user_filename`, `mimetype`, `category`, `filesize`, `extension`, `show`, `ctime`, `mtime`.

The `granted_node()` method on workers returns a node only after ACL validation — use it instead of manual permission checks. Deleted nodes go to `trash_media` table and are permanently removed by `offline/workers/expiryWorker.js`.

## Service endpoint URL pattern

```
https://<hostname>/-/svc/<module>.<method>
```

The `service` parameter in the request body (or `x-param-xia-data` header) identifies the target. Falls back to `page.index` if absent.

## LETC Engine (frontend context)

The frontend uses a JSON-tree rendering engine (LETC — Limitlessly Extensible Tree Components). The backend treats it as any other API consumer — no frontend-specific server code. Backend services return JSON; the LETC renderer on the client builds the DOM. Built on Backbone/Backbone.Marionette.
