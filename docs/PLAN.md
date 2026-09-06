# Raise delivery plan

Status: active

Resume point: start `S07-abuse`; finish the R2 lifecycle and hosted smoke proof in `S08-deploy`

Baseline commit: `198f40824c8ffb32f3e34cf8bf33d94de4b55928`

Last updated: 2026-09-05

## Current state

The baseline private alpha already proves both creation directions, manual role links, multi-turn review, optimistic version checks, sanitized WebP screenshots, a browser scratchpad, the HTTP API, and the MCP loop. At the start of this plan, `pnpm check` passed 71 tests across 13 files.

That baseline wasn't safe to run as the proposed public service: state records and local WebP files contained readable content, expired data wasn't deleted, mutation retries weren't generally idempotent, and no public-host rate limits existed.

The working tree completes `S01-boundaries`, `S02-crypto`, `S03-redis`, `S05-cursors`, and `S06-scope-cut`, plus the application work in `S04-blobs`. HTTP handlers call a `RaiseService`; storage receives capability digests, wrapped keys, encrypted fields, and opaque blob references rather than bearer secrets or readable user content. New screenshots are sanitized in memory and encrypted before the blob adapter sees them. The former server-wide inbox is gone, while the browser's device-local list remains.

The Valkey adapter stores encrypted state in four colocated keys, uses atomic Lua transitions and Redis server time, and applies the two-hour idle, six-hour hard, and 15-minute accepted deadlines. Append idempotency works end to end in the browser and MCP adapter, including restart-safe retry records that contain no request content or bearer token. Compose and CI run a real Valkey service. `VALKEY_URL` is required, Valkey is the sole state implementation, and caller-selected expiry has been removed.

Initial reads now return a snapshot and opaque Stream cursor. The browser and MCP adapter reuse that cursor for delta reads and bounded long polls, merge deltas without duplicate entries, and replace local state when the server returns a recovery snapshot. One in-process waiter handles local wake-ups; it adds no Pub/Sub dependency, and clients retry from their cursor after a restart.

The blob runtime now selects encrypted local files or a private S3-compatible bucket. Local mode runs an age sweep at startup and every 30 minutes. The S3 adapter supports private put, bounded get, delete, and standard AWS SDK credentials; Cloudflare R2 uses the same adapter. Raise stores one encrypted sanitized WebP per attachment and derives the smaller MCP response in memory after an authorized read. A second stored preview would double blob writes and lifecycle work without evidence that the saved resize is worth it.

The current working tree passes `pnpm check`: formatting, lint, strict TypeScript, all builds, and 267 tests across 31 files. The cursor slice covers protocol validation, store recovery, waiter cleanup, HTTP wake and timeout behavior, browser merging and retries, plus an MCP multi-turn loop that reads deltas by cursor. Docker isn't available on this development host, so container and real-provider smoke tests remain `S08-deploy` work.

## Technical foundation

### Runtime and repository

- Node.js 24 or newer, TypeScript, pnpm workspace.
- React and Vite for the browser; Fastify for HTTP; Sharp for image sanitation.
- One modular application image plus the existing stdio MCP adapter.
- Shared request and response schemas stay in `packages/protocol`.

### Target storage

```text
browser or MCP
      |
      v
one Raise application instance
      |-- RaiseStore --> managed Redis or self-hosted Valkey
      |                  meta hash + encrypted event stream + capabilities + idempotency
      |
      `-- BlobStore ----> private S3-compatible storage or encrypted local files
```

Redis owns live state and exact access expiry. Each request uses an ordered Stream for encrypted entries plus small hashes for state and credentials. The application uses one atomic Lua operation for conditional mutations. Hosted blob storage holds only encrypted sanitized image objects; an R2 prefix lifecycle makes each object deletion-eligible six hours after upload.

The local profile runs `raise`, Valkey, and one blob volume through Docker Compose. The hosted profile runs one Cloud Run application instance with managed Redis and private R2. It adds no scheduler, worker, queue, Pub/Sub channel, Postgres database, or backup service. See [ADR 0001](architecture/decisions/0001-use-ephemeral-redis-and-object-storage.md).

### Security boundary

Each request receives a random 256-bit content key. AES-256-GCM encrypts event fields and image bytes with a fresh nonce and authenticated record context. Each role claim or session stores a separately wrapped copy of the content key; storage keeps only capability digests. The application can decrypt during an authorized request, so product copy must say application-level encryption at rest rather than end-to-end encryption. See [ADR 0002](architecture/decisions/0002-wrap-content-keys-with-capabilities.md).

### Retention boundary

Redis applies a two-hour write-idle deadline, a six-hour hard deadline, and a 15-minute post-acceptance deadline. The hard-lifetime budget starts before image processing and upload, so those steps can't move the Redis deadline past six hours. Reads never refresh deadlines. Redis expiry ends access exactly; R2 removes inaccessible ciphertext later through its six-hour age rule, while local storage uses a sweep inside the Raise process. See [ADR 0003](architecture/decisions/0003-use-logical-expiry-and-storage-lifecycles.md).

### Quality commands

```bash
pnpm check
pnpm exec vitest run apps/server
pnpm exec vitest run --coverage
pnpm audit --prod
pnpm readiness:check
```

Docker isn't installed on the current development host. Image build and `/readyz` smoke proof must run in CI or another Docker-enabled environment before `S08-deploy` can close.

## Work breakdown

Focused-day estimates assume one engineer and include tests. They are planning ranges, not release dates.

| Slice            | Outcome                                                                                                      | Estimate | Status                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------ | -------: | ---------------------------------- |
| `S00-records`    | One approved PRD, research record, architecture, ADR set, and delivery plan replace the old roadmap.         |        1 | Complete in working tree           |
| `S01-boundaries` | HTTP no longer depends on persistence details; a provider boundary prevents partial visible turns.           |      2–4 | Complete in working tree           |
| `S02-crypto`     | Application-owned authorization and key envelopes replace the temporary boundary before ciphertext persists. |      3–5 | Complete in working tree           |
| `S03-redis`      | Valkey stores ordered multi-turn state with atomic transitions, append idempotency, and exact TTLs.          |      4–6 | Complete in working tree           |
| `S04-blobs`      | Encrypted local and S3-compatible adapters share one blob contract and handle orphaned uploads.              |      3–5 | Core complete; deploy proof in S08 |
| `S05-cursors`    | Browser and MCP reload once, fetch deltas by cursor, and long-poll without Pub/Sub.                          |      2–3 | Complete in working tree           |
| `S06-scope-cut`  | Caller-selected expiry disappears and Valkey becomes the sole state implementation.                          |      1–2 | Complete in working tree           |
| `S07-abuse`      | Managed creation credentials, Redis quotas, image limits, and hosted Turnstile protect the free tier.        |      3–5 | Planned                            |
| `S08-deploy`     | Docker Compose and Cloud Run/R2 deployment profiles pass smoke tests.                                        |      2–4 | Planned                            |
| `S09-release`    | Failure, security, expiry, restart, browser, MCP, and operating checks support a private alpha.              |      2–4 | Planned                            |
| `S10-pairing`    | A later browser-to-MCP pairing adds active-only discovery without accounts.                                  |      5–8 | Deferred until v0.1 evidence       |

The original v0.1 path was roughly 22–38 focused engineering days. With S00 through S06 implemented, the remaining planned slices are S07, S08, and S09.

```text
done: S00 -> S01 -> S02 -> S03 -> S04 core -> S05 -> S06
                                                    |
next:                                               S07 -> S08 -> S09
                                                                  |
                                      usage supports pairing -> S10
```

## Slice: S00-records

- Requirements: all requirements and exclusions in `docs/PRD.md`.
- Starting state: `docs/product-plan.md` describes accounts, projects, Postgres, backups, jobs, and a website widget that the owner cut.
- In scope: PRD, research record, this plan, target architecture, accepted ADRs, a supersession note, and contributor pointers.
- Out of scope: runtime behavior changes presented as already shipped.
- Proof: links resolve; every PRD requirement maps to a slice; searches find no active roadmap promise for the widget, Postgres, scheduled cleanup, backups, or the global inbox.
- Status: complete in the current working tree; final repository checks remain part of the shared handoff gate.

## Slice: S01-boundaries

- Requirements: `OPS-001`, `REL-002`, `SEC-005`, and preservation of `V01-001` through `V01-008`.
- Starting state: Fastify constructs and calls `RaiseDatabase`; `images.ts` writes absolute paths and adds attachment rows after the request or turn transaction has committed.
- In scope:
  - Add async `RaiseStore` and `BlobStore` contracts.
  - Add a `RaiseService` that owns IDs, public link construction, image staging, commit ordering, and compensation.
  - Let `RaiseService` choose an opaque blob key before each `BlobStore.put`, so the manifest and cleanup path use the same provider-neutral identifier.
  - Keep local files as the initial `BlobStore` implementation.
  - Insert every attachment manifest inside the same store transaction as its entry, state transition, and version update.
  - Read attachment bytes through `BlobStore`; no route opens a stored filesystem path.
  - Restrict structured URL fields to HTTP(S) and mark private responses `Cache-Control: private, no-store`.
- Treat `StoreCommitOutcomeUnknownError` differently from a confirmed rejection. It means the store may have committed before the adapter lost the result, so the service must keep staged blobs. Every other commit error confirms that no reference became visible and triggers best-effort deletion.
- Out of scope: the crypto-ready authorization contract, encryption placeholders, Redis, R2 SDKs, new product behavior, and the final TTL policy.
- Success examples:
  - A two-image create where the second blob write fails deletes the first blob and never creates a request.
  - An attachment metadata error rolls back the entry, action, version, capabilities, and every attachment row.
  - A state conflict after blob staging leaves the prior turn untouched and removes staged blobs.
  - An unknown store outcome keeps staged blobs because the committed state may reference them; S03 idempotency supplies deterministic retry resolution.
  - Existing browser and MCP closed loops behave the same.
- Focused proof:

```bash
pnpm exec vitest run apps/server/src/blob-store.test.ts apps/server/src/raise-service.test.ts
pnpm exec vitest run apps/server
pnpm check
```

- Likely files: `apps/server/src/storage.ts`, `blob-store.ts`, `raise-service.ts`, `images.ts`, `app.ts`, and focused tests.
- Stop condition: if the contract requires provider-specific transactions or exposes raw filesystem/R2 handles, revise it before adding Redis.
- Status: complete in the current working tree.

## Slice: S02-crypto

- Requirements: `V01-002` and `SEC-001` through `SEC-004`.
- Dependency: S01's temporary provider boundary and atomic attachment manifests.
- In scope:
  - The server-wide discovery routes, credential, session minting, MCP tool, and public schemas have been removed. The device-local browser list remains.
  - Move claim and session secret generation, capability hashing, key derivation, content-key wrapping, and claim-to-session rewrapping into `RaiseService`. `RaiseStore` receives digests and versioned envelopes, never raw bearer secrets.
  - Erase a claim's content-key wrap in the same transaction that consumes it. Exact replay authenticates the old claim but recovers the winning session from non-secret retry metadata; it never returns the erased claim wrap.
  - Preserve exact claim-exchange retries without storing a raw session token: when the client supplies an exchange ID, derive the session secret from the claim secret, exchange ID, and stored session capability ID. Persist only the exchange digest, delivery mode, session ID, and session digest. A different exchange ID or delivery mode still fails.
  - Add a non-mutating store read that authorizes the role, expected version, pending action, and expiry, then returns the wrapped content-key envelope needed for in-memory image encryption.
  - After image encryption and blob upload, make the atomic store mutation reauthenticate and recheck the expected version, pending action, and expiry before publishing any blob reference. A changed request rejects the commit and cleans up staged blobs.
  - A versioned encryption-envelope format.
  - Random content-key generation and AES-256-GCM seal/open operations.
  - Authenticated context binding the schema version, request ID, record type, record ID, author, and field.
  - Encryption before `BlobStore.put` and decryption only after the store authorizes a session and returns its key envelope.
- Proof:
  - Round trips work; wrong keys, wrong context, altered tags, altered ciphertext, and altered nonces fail.
  - Ten thousand generated nonces contain no duplicate. This is a regression alarm, not a proof of randomness.
  - A sentinel body, URL, filename, and image leaves no readable sentinel or WebP header in raw persistence.
  - Raw Valkey state and blob storage contain neither the supplied plaintext sentinels nor recognizable image bytes.
  - Cross-role and cross-request capability attempts fail after restart.
- Stop condition: don't ship a plaintext implementation behind a fake `ContentProtector` abstraction.
- Status: complete in the current working tree. Unit and provider-contract tests cover encryption envelopes, capability parsing and derivation, exact claim replay, races, authorization, multi-turn state, and attachment access. The closed-loop persistence test finds no supplied sentinel or WebP signature in raw Valkey state or the blob directory. Final shared checks are recorded at handoff.

## Slice: S03-redis

- Requirements: `V01-003`, `V01-004`, `V01-006`, `RET-001` through `RET-005`, `REL-001`, and `REL-003`.
- Storage shape:

```text
raise:{id}:meta          current state, counters, idle and hard deadlines
raise:{id}:entries       ordered encrypted Redis Stream entries
raise:{id}:capabilities  role capability digests and wrapped content keys
raise:{id}:idem          mutation idempotency results
```

- One Lua mutation checks idempotency first, authenticates role and expected version, validates the transition, appends the event, updates state and counters, and applies one `PEXPIREAT` value to every per-request key.
- Initial reads return the bounded Stream; later reads return entries after the supplied Stream cursor.
- Proof runs the provider contract against a real Valkey service. Competing same-version writes produce one winner; replayed idempotency keys don't duplicate work or extend expiry. Reads, waits, downloads, rejected writes, and exact replays leave the deadline unchanged.
- Stop condition: if the chosen managed Redis lacks a required command or produces stale authorization reads, change provider or connection mode before release.
- Status: complete in the current working tree. `S05-cursors` owns client synchronization and bounded waiting on top of these cursor reads.

## Slice: S04-blobs

- Requirements: `V01-007`, `RET-006`, `RET-007`, `REL-002`, and `OPS-001` through `OPS-003`.
- The local and S3-compatible adapters store only application-encrypted bytes under opaque `ephemeral/v1/` names. The runtime selects them with `BLOB_STORE=local|s3`; R2, AWS S3, MinIO, and compatible private services use the S3 adapter.
- Raise stores one sanitized WebP. An authenticated `?preview=mcp` read decrypts it and resizes the response in memory; v0.1 won't store a duplicate preview unless measurements show that repeated resizing costs more than the extra writes and objects.
- Local mode creates private directories and files, sweeps objects older than six hours at startup, and repeats the sweep every 30 minutes inside the existing process. It has no cleanup worker or scheduler.
- The six-hour retention budget starts before image preparation. Redis receives only the time left after processing and upload, which keeps live state from outlasting the hosted object's six-hour age window.
- Confirmed store rejection deletes staged objects. An unknown commit outcome keeps them because accepted state may already reference them; local age cleanup or bucket lifecycle removes a true orphan later.
- S04 tests cover local aging, private file modes, the shared blob contract, bounded S3 reads, runtime provider selection, write failure, commit failure, retention-budget exhaustion, and lifecycle-policy drift.
- Status: application work is complete in the current working tree. The exact R2 lifecycle document is checked in and covered by a drift test. `S08-deploy` owns applying it, reading it back through the Cloudflare API, and a real private-bucket smoke test.

## Slice: S05-cursors

- Requirements: `V01-006`, `V01-008`, and the one-instance constraint.
- The HTTP contract requires an opaque cursor for change reads and accepts a wait of 0 through 30 seconds. A bounded in-process waiter wakes on local writes, then reauthenticates and rereads the Stream; clients reconnect from their last cursor after a timeout or restart.
- Browser and MCP clients use the same response contract. `snapshot` replaces cached entries; `delta` merges by entry ID. The cursor tracks reads, while the numeric version stays the mutation-conflict token.
- Proof covers local wake-up, clean timeout and waiter teardown, duplicate-free replay, stale-cursor snapshot recovery, and retry behavior. No Redis Pub/Sub or consumer group ships.
- Status: complete in the current working tree. Shared release checks remain part of `S09-release`.

## Slice: S06-scope-cut

- Requirements: `V01-009` and the remaining v0.1 storage and retention cuts.
- Caller-selected `expiresInHours` is removed; server policy owns every deadline.
- Keep Valkey as the sole state implementation after its provider contracts pass.
- Update HTTP, MCP, OpenAPI, README, and configuration docs in the same change.
- Status: complete in the current working tree. Valkey is the only state implementation and there is no compatibility path for untagged development data.

## Slice: S07-abuse

- Requirements: `V01-010`, `SEC-006`, and `OPS-004`.
- Add Redis-backed burst limits and aggregate per-request ceilings for accepted text bytes, sanitized blob bytes, decoded pixels, entries, and concurrent waits. Bound Sharp work inside the application.
- Hosted browser creation requires a valid Turnstile assertion. Hosted agent creation requires `Authorization: Bearer <RAISE_AGENT_CREATE_TOKEN>`, where the configured value is a base64url-encoded random 256-bit credential. It grants only request creation; it can't discover, claim, read, or mutate an existing thread.
- A self-hoster can explicitly set `RAISE_ALLOW_UNAUTHENTICATED_AGENT_CREATE=true`. The managed profile never enables that switch.
- Return `429` with `Retry-After`, reject new work before expensive image processing where possible, and add an operator creation kill switch.

## Slice: S08-deploy

- Requirements: `OPS-002`, `OPS-003`, and `OPS-005`.
- Compose: Raise + Valkey configured with `appendonly yes`, `appendfsync everysec`, `maxmemory-policy noeviction`, a small Valkey state volume, and an encrypted local blob volume. The state volume supports restart recovery; it isn't a backup. `BLOB_STORE=s3` switches the same image to private object storage.
- Hosted: run one instance of the same image, set `PUBLIC_BASE_URL`, connect `VALKEY_URL` to managed Redis, and set `BLOB_STORE=s3`, `BLOB_S3_BUCKET`, `BLOB_S3_REGION`, and any non-AWS `BLOB_S3_ENDPOINT`. Set the optional `BLOB_S3_ACCESS_KEY_ID`, `BLOB_S3_SECRET_ACCESS_KEY`, and `BLOB_S3_SESSION_TOKEN` for explicit credentials, or leave them unset for the AWS SDK workload-role and standard provider chain.
- The R2 profile uses region `auto`, its account endpoint, a private bucket, and a verified `ephemeral/v1/` lifecycle rule with `maxAge: 21600`. The hosted container needs no durable disk.
- Replace the current shallow `/readyz` response with Redis and blob configuration checks; `/healthz` remains process-only. Verify `SIGTERM` handling, startup failure, and redacted provider errors.
- No cleanup endpoint or Cloud Scheduler resource exists.

## Slice: S09-release

- Requirements: every v0.1 requirement.
- Run provider contracts, tamper cases, conflict and retry tests, expiry tests, attachment failure tests, browser-to-MCP-to-browser smoke, restart recovery, and deployment smoke.
- `pnpm check`, production dependency audit, coverage report, readiness scan, Docker build, and `/readyz` smoke must pass against the release candidate.
- Update public docs only with behavior proven by the release candidate.

## Requirement traceability

| Requirement group   | Owning slices                   |
| ------------------- | ------------------------------- |
| `V01-001`           | S01, S03, S09                   |
| `V01-002`           | S02, S09                        |
| `V01-003`–`V01-005` | S01, S03, S09                   |
| `V01-006`           | S03, S05, S09                   |
| `V01-007`           | S02, S04, S09                   |
| `V01-008`           | S01, S05, S09                   |
| `V01-009`           | S06, S09                        |
| `V01-010`           | S07, S09                        |
| `SEC-001`–`SEC-003` | S02, S09                        |
| `SEC-004`           | S01 (header complete), S02, S09 |
| `SEC-005`           | S01 (complete), S09             |
| `SEC-006`           | S07, S09                        |
| `RET-001`–`RET-007` | S03, S04, S06, S09              |
| `REL-001`–`REL-003` | S01, S03, S04, S09              |
| `OPS-001`–`OPS-005` | S01, S04, S07, S08, S09         |
| `V02-001`–`V02-004` | S10 only                        |

## Release cuts

Cut in this order if the schedule slips: hosted Turnstile polish, R2 deployment automation, then the managed alpha itself. Don't cut encryption, role checks, state conflicts, logical expiry, private attachment access, or failure compensation. The self-hosted Valkey/local profile remains the minimum shippable v0.1.
