# Drumee Team Server

The back-end of the Drumee workspace: identity, the meta filesystem, sharing,
chat, tasks and meetings.

- **Website:** [drumee.com](https://drumee.com) ·
  **Docs:** [docs.drumee.com](https://docs.drumee.com/introduction/)
- **Front-end counterpart:** [drumee/ui-team](https://github.com/drumee/ui-team)

> Looking to **run** Drumee rather than develop it? Use
> [docker-hosted](https://github.com/drumee/docker-hosted),
> [debian-hosted](https://github.com/drumee/debian-hosted) or
> [synology-hosted](https://github.com/drumee/synology-hosted).
> For a local development instance, use the
> [Starter Kit](https://github.com/drumee/starter-kit).

---

## What it is

A Node.js back-end that runs inside the Drumee environment alongside MariaDB,
Redis and the shared meta filesystem. It exposes two HTTP servers:

| Server | Entry point | Default port | Role |
|---|---|---|---|
| **Push** | `index.js` | `23000` | Serves the application loader and holds the client WebSocket for real-time messaging |
| **Service** | `service.js` | `24000` | REST-style API that dispatches requests to service workers through ACL routing |

Drumee renders entirely on the client, so this server never produces HTML for
the workspace UI — it serves the loader and answers the API.

## Requirements

Drumee's back-end expects the surrounding infrastructure (MariaDB, Redis,
nginx, the meta filesystem) to exist. The supported way to get that on a
developer machine is the [Starter Kit](https://github.com/drumee/starter-kit),
which brings it all up in Docker and clones this repository into
`drumee-os/server-team` for you.

## Development

```console
npm install
npm run setup     # writes the development environment config into ./devel/
npm run dev       # starts the development server
```

Configuration is read from `/etc/drumee/conf.d/drumee.json`, with optional
per-endpoint overrides in `/etc/drumee/conf.d/<endpoint>/myDrumee.json`.
`configs.js` handles loading and argument parsing, including `--restPort`
(default `24000`) and `--pushPort` (default `23000`).

```console
npm run deploy    # production build and deploy
```

## Layout

| Path | What it holds |
|---|---|
| `acl/` | Service declarations — which service exists and who may call it |
| `service/` | Service worker implementations |
| `router/` | Request routing |
| `client/` | Client-facing helpers |
| `offline/` | Background and offline workers |
| `configs.js` | Configuration loading and CLI argument parsing |
| `index.js` · `service.js` | The push server and the service server |

The ACL directory is the fastest way to understand what the back-end can do:
each entry is a callable service and the privilege required to reach it.

## Built on

| Package | Role |
|---|---|
| [`@drumee/server-core`](https://github.com/drumee/server-core) | Request lifecycle, sessions, ACL, meta filesystem, media conversion |
| [`@drumee/server-essentials`](https://github.com/drumee/server-essentials) | Database, cache, logging, mail and template primitives |
| [`@drumee/schemas-utils`](https://github.com/drumee/schemas-utils) | Schema helpers |

Database schema and stored procedures live in
[drumee/schemas](https://github.com/drumee/schemas).

## Contributing

See the org [CONTRIBUTING guide](https://github.com/drumee/.github/blob/main/CONTRIBUTING.md).
Questions: [Discussions](https://github.com/orgs/drumee/discussions).

## License

AGPL-3.0 — see [LICENSE](LICENSE).
