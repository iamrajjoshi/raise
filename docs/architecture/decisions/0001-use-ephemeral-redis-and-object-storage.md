# ADR-0001: Use ephemeral Redis state and object blobs

- Status: accepted
- Date: 2026-09-05
- Deciders: Raj Joshi
- Related requirements: `V01-003`, `V01-006`, `OPS-001`, `OPS-002`, `OPS-003`
- Supersedes: the durable SQL roadmap in the former `docs/product-plan.md`

## Context

Raise is a temporary human-agent exchange, not a lasting workspace. Every thread has a six-hour maximum life and moves through manual role links; v0.1 has no server-wide inbox or discovery credential. The product doesn't promise search, reporting, backups, projects, or permanent history. The hosted service should stay cheap at low traffic while the self-hosted edition remains easy to run.

At the time of this decision, the private alpha stored relational rows and images on an attached volume. That worked locally but bound a hosted container to one disk. The former plan answered that problem with Postgres, jobs, and backup machinery whose durable data model no longer matched the product.

## Decision drivers

- Exact automatic expiry for every live thread.
- Ordered multi-turn replay and conditional state changes.
- No attached application disk in the hosted profile.
- A small self-hosted setup using common open-source services.
- No permanent query or reporting model.

## Options considered

### Embedded relational state and local files

This is the smallest local setup and matches the working alpha. Hosted restarts and moves require a persistent volume tied to one compute provider, while file/database atomicity and cleanup stay in application code.

### Postgres and object storage

Postgres fits accounts, projects, permanent inbox state, reporting, and long retention. Raise has cut those features. It would still need scheduled row cleanup, and its connection and migration work would buy little for a six-hour thread.

### D1 and R2

An all-Cloudflare hosted edition could start cheaply, but it would require a separate Worker adapter from the Node/Docker runtime. D1 recovery retention also complicates short-erasure language unless content receives application encryption.

### Redis/Valkey and object storage

Redis expiry matches the live-data contract. Streams preserve ordered entries and cursor reads, Lua supports atomic conditional mutation, and Valkey supplies a BSD-licensed self-hosted implementation. Binary images remain outside Redis in R2 or local encrypted files.

## Decision

Store live request state in Redis for the hosted service and Valkey for self-hosting. Use one Stream per request for ordered encrypted events and small hashes for current state, capabilities, deadlines, and idempotency. Store encrypted images through a `BlobStore` backed by private R2 or local files. Add quota counters with the public-host controls in `S07-abuse`.

Keep one TypeScript application image and one active application instance through v0.1. Web and MCP clients share its HTTP protocol. No Redis Pub/Sub, consumer group, queue, Postgres adapter, or multi-replica coordination ships in this release.

The managed Redis vendor remains a deployment choice after the Valkey contract passes; Upstash is the current candidate.

## Consequences

TTL and active-only state become natural operations. The hosted application can restart without an attached volume. Self-hosting needs one extra Valkey service with an AOF state volume beside the Raise application container; that volume preserves live threads across restarts but isn't a backup.

Redis is a bad home for permanent history and cross-thread reporting. Adding accounts, long retention, search, audit exports, or several application replicas must reopen this decision rather than piling indexes and coordination onto the temporary model.

Object writes and Redis writes can't share one transaction. Raise must upload first, commit the object reference atomically with the event, delete known staged objects when the commit fails, and rely on object lifecycle for the crash gap.

## Validation

- Evidence: the working state machine and multi-turn tests at baseline commit `198f408`; [Redis Streams](https://redis.io/docs/latest/develop/data-types/streams/); [Redis atomic scripting](https://redis.io/docs/latest/develop/interact/programmability/eval-intro/); [Valkey introduction](https://valkey.io/topics/introduction/).
- Pass condition: Valkey passes the full `RaiseStore` contract against a real service; competing expected-version writes produce one winner; restart and cursor replay lose no accepted event.
- Fallback if it fails: use Postgres for state while keeping `BlobStore`, encryption, and the HTTP protocol unchanged.
- Permanent check: provider contract and competing-write suites in CI.

## Revisit when

Reconsider when Raise requires permanent history, account recovery, search, reporting, audit retention, or more than one application replica. Also reconsider if measured Redis command or memory cost exceeds a comparable managed SQL profile.

## Outcome

The provider boundary and Valkey adapter are implemented, and Valkey is the sole state implementation. A real managed-provider deployment smoke test remains in `S08-deploy`.
