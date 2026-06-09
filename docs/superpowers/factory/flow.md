# Offline Factory (`offline/factory/`)

The factory is a long-running background daemon that **pre-provisions empty MariaDB
schemas** (and their MFS storage roots) so that creating a new workspace (`hub`) or a
new user (`drumate`) is instantaneous — the work of building a fresh database has
already been done in advance and is waiting in a pool.

It is **not** started by `npm run dev`. It is launched on its own — `offline/drumate.js`
is the entry point that constructs and `start()`s the factory.

```
offline/drumate.js        # entry point: new Factory({type:'drumate', schemas}).start()
offline/factory/index.js  # __drumee_factory (extends Offline) — the daemon loop
offline/factory/schema.js # __schema (extends Logger) — builds one entity at a time
```

## Why it exists

Provisioning a new entity is expensive: create a database, load the full schema
(routines, tables, triggers), create the on-disk MFS storage directory, `chown` it to
the system user, and create the VFS root node. Doing all of that synchronously while a
user waits for "create workspace" / "sign up" would be slow.

Instead, the factory keeps a **warm pool** of ready-made entities. Each pooled entity is
a fully built, empty `hub` or `drumate` database marked `area='pool'`. When a real
workspace or user is needed, the application simply *claims* a clean pool entity
(`pickupEntity`) and flips it into active use — no schema build on the hot path.

## The two entity types

| Type | Becomes | DB naming |
|---|---|---|
| `hub` | A workspace database | UUID-derived, no prefix |
| `drumate` | A per-user database | `9_` + UUID |

The factory maintains an independent pool for each type.

## Watermark (pool target size)

The factory tries to keep at least **`watermark`** clean entities of each type in the
pool. Defaults are `210` for both `hub` and `drumate`, overridable via the loaded config
(`configs.load()` → `watermark.hub` / `watermark.drumate`).

```js
this.watermark = {
  hub: watermark.hub || 210,
  drumate: watermark.drumate || 210,
};
```

The current pool depth is read from the `pool_free(type)` SQL function, which counts
rows in `yp.entity` where `area='pool'` and `type=_type`.

## Startup sequence (`initialize`)

1. Open a YP (yellow_page) MariaDB connection.
2. Load config, resolve the per-type watermarks.
3. `checkSanity()` — guard rails (see below).
4. Build the **SQL templates** for both types unless `--rebuild=no` was passed and the
   cached template files are already present (`scripts_clean()`).
5. Enter the infinite `run()` loop.

### `checkSanity()`

Refuses to run in unsafe conditions and `process.exit(1)`s otherwise:

- **Not on a replica** — bails if `SHOW SLAVE STATUS` reports `Slave_IO_Running`
  (the factory creates databases; it must run on the primary only).
- **Privileged user** — must run as `root` or the configured `system_user`.
- Clears any stale template / sentinel files in `/tmp/` for both types.

## Template build (`make_template`)

A "template" is a schema-only SQL dump used as the blueprint for every new entity of a
type.

1. Pick a reference entity: the first `active` entity of that `type` in domain `1`
   (`SELECT db_name, id FROM entity WHERE type=… AND status='active' AND dom_id=1 LIMIT 1`).
2. `mysqldump` it **schema only** (`--routines --quick --no-data --single-transaction
   --skip-comments`) to `/tmp/drumee-template-<type>.sql`.
3. `touch` a sentinel `/tmp/drumee-template-<type>.ok` to mark the dump complete.

`script_path(type, ext="sql")` resolves these `/tmp/` paths. The `.ok` sentinel is what
the run loop checks to confirm a usable template exists — if it is missing, the daemon
aborts ("Exit due to doubious template!").

## The run loop (`run`)

An infinite `while (1) await this.run()`. Each pass, for each type (`drumate`, `hub`):

1. `check_pool(type)` → returns the current count **only if** it is `>= watermark`,
   else `0` (meaning "pool needs topping up").
2. If the template `.ok` sentinel is gone → abort.
3. If the pool is **below** watermark → set the loop timer to 15 s and build one more
   entity via `make_schema(type)`.
4. If the pool is **full** → ramp the timer up by 1 s each idle pass (capped at 60 s) to
   back off polling, and log the watermark once when transitioning to the satisfied
   state.

So the daemon polls aggressively (15 s) while it has provisioning to do, and idles ever
more lazily (up to 60 s) once the pool is full.

## Building one entity (`make_schema` → `schema.js`)

`make_schema(type)` wraps a single `__schema` instance and runs `create_entity()`. The
`__schema` class does the actual provisioning:

`create_entity()`:
1. `entity_create(type)` (YP proc) — inserts a new `entity` row with
   `area='pool'`, `status='frozen'`, and **creates the database** (`CREATE DATABASE`).
2. `load_sql()` — pipes the `/tmp` template dump into the new database
   (`<DB_CLI> <db_name> < <script>`), populating routines/tables/triggers.
3. `create_vfs_root()`:
   - Opens a connection to the new database.
   - `mkdir -p <home_dir>/__storage__` on disk.
   - `chown -R system_user:system_group` the home dir.
   - `create_media_root()` → calls `mfs_create_node` to make the root node, then sets
     `entity.home_id` to it.
4. Marks the entity reusable: `settings.pool_state = "clean"`.

On any failure, `delete_entity(reason)` rolls everything back: `entity_delete` removes
the row, `check_safety()` validates the path, and the `home_dir` is `rm -rf`'d. The
error propagates so the run loop can retry on the next pass.

## How pooled entities get consumed

The factory only *produces*. Consumption happens elsewhere via `pickupEntity(type)`,
which picks a random pool entity whose `settings.$.pool_state = 'clean'`, returning its
`id` and `db_name`. Claiming an entity moves it out of `area='pool'`, dropping the
`pool_free` count and eventually triggering the factory to build a replacement.

## Key SQL touchpoints

| Routine | Where | Role |
|---|---|---|
| `pool_free(type)` (func) | `yellow_page/procedures/admin/pool_free.sql` | Count clean+pool entities of a type |
| `entity_create(type)` | `yellow_page/procedures/entity/create.sql` | Insert entity row + `CREATE DATABASE` |
| `entity_delete(id)` | `yellow_page/procedures/entity/delete.sql` | Roll back a half-built entity |
| `pickupEntity(type, …)` | `yellow_page/procedures/utils/pickupEntity.sql` | Claim a clean pool entity |
| `mfs_create_node` | `common/procedures/mfs/` | Create the entity's MFS root node |

## ⚠️ Restart after schema patches

**When new patches are applied to `drumate`- or `hub`-related schemas, the factory must
be restarted so it builds a fresh template dump.**

The template is dumped **once at startup** from a reference active entity and cached in
`/tmp/drumee-template-<type>.sql`. The run loop reuses that cached dump for every entity
it provisions and **never re-reads the schema** while running. So any routine, table, or
trigger change patched into the `hub`/`drumate`/`common` databases will **not** reach
newly pooled entities until the factory is restarted (and not with `--rebuild=no`, which
keeps the stale cached dump). Until then, the pool keeps handing out entities built from
the **old** schema.

After applying such patches:

1. Patch the reference/active schemas as usual (`bin/patch-from-manifest`, etc.).
2. Restart the factory so `make_template()` re-dumps the current schema.
3. Optionally drain the pool entities built from the old template — they were created
   before the patch and will not contain the new definitions.

## Operational notes

- **Run on the primary only** — never on a replica (enforced by `checkSanity`).
- **Run privileged** — as `root` or `system_user` (needed for `chown` of MFS dirs).
- **`--rebuild=no`** — skip rebuilding templates at startup if cached `/tmp` dumps and
  their `.ok` sentinels already exist (`scripts_clean()`).
- Templates live in `/tmp/drumee-template-<type>.{sql,ok}` and are cleared on each sane
  startup, so a fresh dump is taken from the current schema unless rebuild is suppressed.
- Tune pool size with `watermark.hub` / `watermark.drumate` in config; default 210 each.

