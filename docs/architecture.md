# Architecture

Raise is one deployable web service with a separate local adapter for agents:

```text
browser -----------+
                   v
local MCP adapter -> HTTP capability protocol
                          |
                     Fastify server
                       /       \
                  SQLite     local images
```

The React app is compiled to static files and served by the Fastify process. SQLite stores requests, ordered entries, pending actions, capabilities, and image metadata. Sanitized WebP files live in the data directory. A Docker deployment needs one container and one volume.

## Trust model

There are no accounts in v0.1. A one-time claim URL grants one role on one request. Claiming it creates an expiring session credential. An exact retry may replay that session with the same claim-scoped exchange ID, while a different exchange remains rejected. Only a SHA-256 digest of each secret is stored.

- Human and agent capabilities are separate.
- Only the role targeted by the pending action can answer it.
- Only a human role can accept a result or request changes.
- External URLs are stored and rendered as inert references. The server never fetches them.
- Images are decoded, rotated, re-encoded as WebP, and written without source metadata.

This identifies a capability holder, not a verified person. Accounts and project membership are later work.

## State model

One pending action is allowed per request. `waitingOn` is derived from that row when the API builds a view.

```text
human starts: prompt -> agent work -> human review -> resolved
agent starts: prompt -> human context -> agent work -> human review -> resolved
                                            ^              |
                                            |-- changes ---|
```

Each mutation checks the client's expected request version. A stale client gets `409 state_conflict` and reloads rather than overwriting a newer decision.

## Current shortcuts

This alpha has a narrow idempotency key for retrying one-time claim exchange, but not yet for general mutations. It also does not yet have server-sent events, backup commands, account identity, or formal database/blob port interfaces. Image file writes and their metadata row are not one atomic operation yet. These are explicit v0.1 completion items, not hidden production claims.

The browser polls while a request is open. The stdio MCP adapter uses the same client-neutral HTTP records and stores only its scoped agent sessions. It is not part of the core server and needs no database, blob-store, or Redis access.

## Cloud path

The current image runs unchanged on a VM, ECS task, Kubernetes pod, Cloud Run service with a mounted volume, or another Docker host. That is the first cloud option.

Managed storage comes after the closed loop is stable:

| Concern   | Local default   | AWS adapter        | GCP adapter                 |
| --------- | --------------- | ------------------ | --------------------------- |
| Records   | SQLite          | RDS Postgres       | Cloud SQL Postgres          |
| Images    | Local directory | S3                 | Cloud Storage               |
| Container | Docker Compose  | ECS/Fargate or EC2 | Cloud Run or Compute Engine |

The future configuration surface should be small:

```text
DATABASE_DRIVER=sqlite|postgres
DATABASE_URL=...
BLOB_DRIVER=local|s3|gcs
BLOB_BUCKET=...
```

The web app and agent-facing HTTP protocol must not branch on those values. Storage adapters belong behind the server boundary. Redis is not required for a single process and is not part of the current roadmap.

## Evaluated accelerators

- [Convex](https://www.convex.dev/open-source) provides realtime sync, functions, file storage, and an open-source backend. Its own self-hosting guide deploys a backend, dashboard, and frontend, with optional SQL and S3 services. That is useful later if realtime collaboration becomes the main constraint, but it is heavier than the v0.1 Fastify, SQLite, and local-file deployment.
- [Apify](https://apify.com/) provides hosted Actors, web data APIs, and an MCP integration. Raise does not need web scraping in v0.1. If visual context capture later opens a supplied URL, it should use a provider interface so a local browser worker, Crawlee, Apify, or another service can be selected without changing the request protocol.
