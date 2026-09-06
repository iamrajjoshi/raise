# Raise research record

Last checked: 2026-09-05

This file keeps the evidence that changed product or architecture decisions. It doesn't claim that planned behavior already works; runtime proof belongs in [PLAN.md](PLAN.md).

## Questions and findings

### Does temporary Redis state fit multi-turn Raise threads?

Verdict: supported while Raise keeps a six-hour maximum life and no permanent history.

Redis Streams provide an append-only ordered log, generated entry IDs, range reads, cursor reads, and bounded trimming operations. Raise can keep one Stream per thread and use its IDs as client cursors. A separate small hash holds the current state so a caller doesn't need to replay the full log merely to learn whose turn it is. [Redis Streams](https://redis.io/docs/latest/develop/data-types/streams/)

Redis Lua scripts execute atomically and can combine conditions and writes across the per-Raise keys. That supports the existing expected-version state machine plus event append, counters, idempotency, and TTL changes in one operation. Scripts must stay short because they block other server work while running. [Redis scripting](https://redis.io/docs/latest/develop/interact/programmability/eval-intro/)

Serious alternative: Postgres would fit accounts, reporting, retained history, and cross-thread queries better. Those are explicit non-goals. Reopen the decision if they return.

### Do we need Redis Pub/Sub for live updates?

Verdict: unsupported for v0.1.

One application instance sees every accepted mutation and can wake its own bounded HTTP waiters. Clients reread the Stream from their last cursor after a wake, timeout, or reconnect. That makes the event Stream authoritative and the in-process signal disposable.

Upstash's HTTP API supports Streams but excludes blocking `XREAD` and `XREADGROUP`; keeping the wait inside the application avoids coupling the protocol to a long-lived Redis connection. A native Redis connection remains an option if measurement later favors it. [Upstash REST compatibility](https://upstash.com/docs/redis/features/restapi)

Pub/Sub becomes relevant only after Raise runs more than one application instance. Redis documents Pub/Sub delivery as at-most-once, so even then it could only wake clients; cursor replay would still carry accepted history. [Redis Pub/Sub](https://redis.io/docs/latest/develop/pubsub/)

### Can R2 remove blobs without a cleanup job?

Verdict: supported if the product separates exact access expiry from asynchronous physical deletion.

Cloudflare's current R2 lifecycle API accepts an object age in seconds. One bucket rule can make every object under `ephemeral/v1/` deletion-eligible at `maxAge: 21600`, six hours after that object's upload. Rules apply by prefix and a bucket accepts at most 1,000 rules, so Raise should use one shared rule rather than one rule per thread. [R2 lifecycle API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/lifecycle/methods/update/), [R2 lifecycle guide](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)

Cloudflare says objects are typically removed within 24 hours after lifecycle expiration and can take longer. R2 therefore can't enforce a two-hour idle or 15-minute post-acceptance physical deletion promise. Redis can end authorization at those exact deadlines; application encryption leaves the later R2 object as private ciphertext without a live mapping or wrapped content key.

Serious alternative: a scheduled cleanup endpoint could follow thread deadlines more closely and retry deletes. It adds a scheduler, deletion index, maintenance credential, and failure path. The owner chose lifecycle deletion unless a future requirement imposes a hard physical-deletion deadline.

### Should images live in Redis?

Verdict: no.

Images consume far more memory than thread state and would make the Redis bill and memory ceiling track screenshot traffic. R2 Standard has no minimum storage duration, while its Infrequent Access class has a 30-day minimum and doesn't fit short-lived objects. R2 also provides S3-compatible access, which maps to AWS S3 and local S3-compatible stores through one blob contract. [R2 pricing](https://developers.cloudflare.com/r2/pricing/), [R2 S3 API](https://developers.cloudflare.com/r2/api/s3/api/)

### Does provider encryption satisfy the product's security claim?

Verdict: no.

Provider-managed encryption protects underlying media but still gives Redis and R2 readable application values. A per-Raise content key, authenticated event and blob envelopes, and capability-derived wrapping protect a storage export without introducing accounts. The running application still decrypts authorized requests, so this is encryption at rest rather than end-to-end encryption.

Node's crypto runtime supplies AES-GCM, HKDF, secure random bytes, and constant-time comparison. At research time, the proposed implementation still needed tamper tests, versioned authenticated context, nonce safeguards, restart tests, and raw-storage sentinel inspection. Those proof tests are now recorded as complete in the delivery plan. [Node.js crypto](https://nodejs.org/api/crypto.html)

### What does the current code prove?

Baseline commit `198f40824c8ffb32f3e34cf8bf33d94de4b55928` passes `pnpm check`: 13 test files and 71 tests. It proves human-started and agent-started loops, role claim exchange, expected-version conflicts, review and changes, WebP sanitation, browser interaction, and MCP interaction.

The audit also found release blockers:

- Routes called one concrete synchronous state implementation; image code wrote filesystem paths directly.
- State mutations committed before attachment files and records finished, so a later failure could leave an incomplete visible turn.
- Stored fields and local WebP files were readable.
- Caller-selected expiry defaults to 24 hours; `ANONYMOUS_TTL_HOURS` isn't read; expiry doesn't delete rows or blobs.
- At the audited baseline, the server-wide agent inbox could mint an agent session without a per-Raise role secret. The working tree has since removed that path.
- Public creation has no Turnstile, Redis quotas, or Sharp concurrency ceiling.
- `/changes` polls immediately and general mutations have no idempotency key.

The first preparation slice addresses provider coupling and attachment commit ordering while keeping behavior stable. Encryption, Redis, and public hosting remain later proof gates.

## Conflicts resolved

The former product plan assumed accounts, projects, Postgres, backups, a durable inbox, jobs, and a website widget. The owner cut those features and approved a temporary Redis/R2 product instead. [PRD.md](PRD.md) now owns scope; the former plan is only a supersession note.

Early R2 command examples exposed lifecycle age as whole days, while the current Cloudflare lifecycle API describes `maxAge` in seconds. Deployment will configure and read back the rule through the API or Terraform rather than relying on a day-only Wrangler shortcut.

## Remaining unknowns

- Upstash is the managed Redis candidate, but a TLS provider canary must pass the Valkey store contract before selection.
- Docker and MinIO remain unavailable on this host. Local Valkey is available for the store contract; container and real S3-compatible provider proof still need CI or a Docker-enabled host.
- Public quotas need measured alpha traffic. `S07-abuse` should start with a conservative cap and make rejection visible without promising a permanent free allowance.
- R2 publishes typical lifecycle timing, not a hard deletion deadline. Security copy must retain that qualification.

## Recommendation carried into the plan

Keep the working UI, protocol, state machine, and MCP adapter. Insert `RaiseStore`, `BlobStore`, and application-service boundaries first; close the partial attachment-write bug in that same slice. Add real encryption before the Redis and R2 adapters, then make Valkey the sole state implementation.
