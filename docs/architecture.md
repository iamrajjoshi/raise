# Raise architecture

Status: approved v0.1 shape; release hardening in progress

Delivery record: [PLAN.md](PLAN.md)

## System shape

Raise keeps one application boundary for humans and agents:

```text
human browser -----------+
                          |
local MCP adapter -> HTTP capability protocol
                          |
                          v
              one TypeScript application
               React + Fastify + Sharp
                    /             \
             RaiseStore          BlobStore
                 |                   |
         Redis or Valkey      private S3-compatible
                              storage or encrypted files
```

The React build ships inside the Fastify image. The MCP adapter stays a local stdio process that calls the same HTTP records; it has no Redis or object-store credentials. One active application instance is a v0.1 operating constraint.

## Product boundary

Each request is one temporary thread between a human role and an agent role. Either side may create it. A one-time role claim becomes an expiring session, and one pending action identifies whose turn it is.

```text
human start: prompt -> agent result -> human review -> resolved
agent start: prompt -> human context -> agent result -> human review -> resolved
                                                ^              |
                                                `-- changes ---'
```

Comments can leave the current turn unchanged. Every state mutation checks the participant's role and expected version. One winner advances the state; stale writers reload.

The embeddable website widget has been removed. Humans use the Raise web app and shared role links. v0.2 may add browser-to-MCP pairing for active-only discovery, but it won't add accounts or retained history.

## Store contracts

HTTP routes call application services rather than database or filesystem functions. The code defines two provider boundaries:

```ts
interface RaiseStore {
  createRaise(encryptedCommand: CreateRaiseCommand): Promise<void>;
  inspectClaim(command: ClaimInspectionCommand): Promise<ClaimInspection>;
  commitClaimExchange(command: CommitClaimExchangeCommand): Promise<ClaimExchangeResult>;
  getRaise(
    raiseId: string,
    sessionDigest: CapabilityProof,
    options?: RaiseReadOptions,
  ): Promise<AuthorizedEncryptedRaise>;
  preflightAppend(command: AppendPreflightCommand): Promise<AppendPreflightResult>;
  appendEntry(encryptedCommand: AppendEntryCommand): Promise<AppendResult>;
  getAttachment(...): Promise<AuthorizedEncryptedAttachment>;
  close(): Promise<void>;
}

interface BlobStore {
  put(input: BlobWrite): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  close(): Promise<void>;
}
```

`RaiseService` chooses each opaque blob key before calling `put`; the provider doesn't invent a second identifier. This keeps the attachment manifest, retry, and cleanup paths tied to one stable key without exposing a filesystem path or R2 handle.

`RaiseService` owns bearer-secret generation, digest calculation, content-key wrapping, encryption, and decryption. `RaiseStore` authenticates supplied digests and returns encrypted records plus the matching wrapped key; it never receives a raw capability secret or plaintext content. Valkey is the only state adapter.

A store adapter throws `StoreCommitOutcomeUnknownError` only when a create or append may have committed before the adapter lost the result. The service must not delete staged blobs in that case because accepted state may reference them. Any other commit error is a definite rejection under the contract and triggers best-effort blob deletion. An idempotent retry resolves an unknown result; lifecycle cleanup covers an object that remains unreferenced.

## Redis model

Each request uses four colocated keys. The `{id}` hash tag keeps them in one slot if the selected Redis service partitions data later.

```text
raise:{id}:meta          HASH    lifecycle, version, turn, deadlines
raise:{id}:entries       STREAM  ordered encrypted entries
raise:{id}:capabilities  HASH    capability digests and wrapped content keys
raise:{id}:idem          HASH    successful mutation retry results
```

Every visible state change appends one Stream event. An initial read returns current state plus the complete retained Stream as a snapshot. Later reads accept the opaque cursor from the prior response and return only entries after it. If that position is no longer available, the store returns a replacement snapshot. Both roles use the same log, so Raise doesn't need consumer groups.

One short Lua operation handles each mutation:

1. Return an existing idempotent result when the key and request digest match.
2. Authenticate the capability digest, expiry, request, and role.
3. Check the expected version, lifecycle, and pending action.
4. Append the encrypted event and update state, version, and any capability record.
5. Apply the same absolute expiration to every per-request key and save the retry result.

The application passes encrypted bytes and precomputed digests to the script. Lua doesn't decrypt content or run image work.

## Multi-turn reads and waiting

Each view includes a `cursor` and `entriesMode`. The browser and MCP adapter keep the cursor, ask `/changes` for entries after it, and apply responses according to the mode: `snapshot` replaces the cached list, while `delta` merges entries by ID. The numeric `version` has a separate job as the optimistic mutation-conflict token.

`/changes` can hold one request for up to 30 seconds through an in-process waiter. A successful local mutation wakes matching requests, which reauthenticate and reread Valkey from their cursor. Timeouts do the same authoritative read before returning `204`; registration includes a second read so a write cannot slip between the first read and the wait.

Raise doesn't need Redis Pub/Sub under the one-instance constraint. A process restart drops its in-memory waiters, and clients reconnect with their last cursor; Valkey remains the source of accepted entries. Lifting the one-instance constraint requires a new notification decision.

## Attachment commit flow

Image processing finishes before an event references a blob:

1. Decode the supplied PNG, JPEG, or WebP bytes with a decoded-pixel ceiling.
2. Rotate and re-encode through Sharp to remove source metadata.
3. Encrypt the one sanitized WebP with the request content key and upload it under a service-chosen opaque object name.
4. Commit the encrypted attachment descriptor inside the same RaiseStore mutation as the event, state transition, version, and deadlines.

If a blob write fails, no state mutation runs. Before encrypting an append, the service performs a non-mutating authorization read that checks the session, role, expected version, pending action, and expiry, then returns the wrapped content-key envelope. After encryption and upload, the atomic state commit performs those checks again. A conflict deletes staged blobs and leaves the earlier turn unchanged.

If a state commit reports an unknown outcome, Raise keeps the blobs because the event may already reference them. A process crash can leave an unreferenced object; the R2 prefix lifecycle or local file-age sweep removes it later.

Attachment reads authenticate the role session first, recover the opaque object reference from live Redis state, fetch private ciphertext, decrypt it in memory, and return `Cache-Control: private, no-store`. An MCP preview request resizes those authenticated bytes in memory. v0.1 stores no second preview object; add one only if measurements show repeated Sharp work is a real cost. No public or permanent object URL exists.

## Encryption model

Each request receives one random 256-bit content key. Every event envelope and blob variant gets a fresh AES-256-GCM nonce. Authenticated context binds the ciphertext to its envelope version, request ID, record type, record ID, author, and field so bytes can't move between records without failing authentication.

`RaiseService` generates claim and session bearer secrets. Storage receives a domain-separated SHA-256 digest for lookup plus a copy of the content key wrapped under an HKDF-derived wrapping key for that capability; it never receives a raw secret. Claim exchange unwraps the content key in memory, wraps a copy for the service-generated session secret, and erases the consumed claim's wrap in the same store transaction. When the client supplies an exchange ID, the service derives that session secret from the claim secret, exchange ID, and stored session capability ID. This allows an exact retry after a lost response or restart while storage keeps only digests, IDs, the delivery mode, and the winning session's wrapped key. Exchanges without an ID remain one-shot. The former global inbox had no per-request wrap, so Raise removed it before implementing this contract.

The application decrypts authorized reads. This protects storage copies, not a participant's device or a compromised running server. The exact promise is application-level encryption at rest, not end-to-end encryption. [ADR 0002](architecture/decisions/0002-wrap-content-keys-with-capabilities.md) owns this boundary.

## Expiration and deletion

The service starts the hard-lifetime budget before image processing or upload. Creation then asks Redis to calculate its deadlines from the unused part of that budget:

```text
hard deadline = Redis commit time + remaining part of the 6-hour budget
idle deadline = Redis write time + 2 hours
access expiry = min(idle deadline, hard deadline)
```

Acceptance shortens access to the earlier of the current deadline or 15 minutes from the decision. Reads, waits, claims, downloads, rejected writes, and exact retry replays don't refresh access. The mutation sets every per-request Redis key to the same absolute expiry.

Redis expiry removes the live authorization state, wrapped content keys, event log, and blob mappings. Since object age starts at upload and Redis receives a shortened lifetime after upload, a live reference can't outlast the object's six-hour lifecycle window. R2 handles physical byte removal through one rule on `ephemeral/v1/`, with `maxAge: 21600` seconds from each upload. Cloudflare describes deletion as typically occurring within 24 hours after lifecycle expiration and sometimes later; Raise never says physical deletion occurs at the Redis deadline.

Local files use the same six-hour object-age floor and an in-process sweep at startup and on a low-frequency interval. If Raise is offline, deletion resumes on its next start. No separate cleanup container or cloud scheduler exists.

## Deployment profiles

### Self-hosted

```text
docker compose up
  |-- raise   one application container
  |-- valkey  temporary state and capability wraps
  |     `-- AOF state volume for restart recovery
  `-- volume  encrypted blob bytes
```

Valkey uses `appendonly yes`, `appendfsync everysec`, and `maxmemory-policy noeviction`. Its state volume is live persistence, not a backup. An operator may set `BLOB_STORE=s3` and use an S3-compatible service instead of the local blob volume. Product behavior and the HTTP protocol don't branch by provider.

### Hosted

The following is the target hosted profile for the public release; its creation controls and readiness probes are not implemented yet.

```text
Cloudflare DNS and Turnstile
              |
              v
Cloud Run: Raise, min 0 / max 1
      |                 |
managed Redis       private R2 Standard bucket
                          `-- six-hour lifecycle rule
```

The target hosted profile has no attached disk, SQL database, queue, Pub/Sub channel, worker, cleanup endpoint, or Cloud Scheduler job. Secrets come from the host's secret manager. `S08-deploy` adds Redis and blob readiness checks; liveness stays process-only.

`S07-abuse` will require a valid Turnstile assertion for managed browser creation and `Authorization: Bearer <RAISE_AGENT_CREATE_TOKEN>` for agent-originated creation. That configured base64url-encoded random 256-bit credential will authorize creation only; it won't discover, claim, read, or mutate an existing thread. The release design may let self-hosters explicitly allow unauthenticated agent creation, while the managed profile will not.

AWS, GCP, another container host, or a local machine can run the same image. Portability comes from Redis protocol, the blob contract, and HTTP, not from pretending every provider has identical configuration.

### Runtime configuration

Every deployed server needs `VALKEY_URL`. `PUBLIC_BASE_URL` sets the origin in role links, and `PORT` defaults to `8787`.

Local blob mode is the default: `BLOB_STORE=local` writes application-encrypted objects beneath `DATA_DIR`. The Compose profile sets `DATA_DIR=/data` and mounts the `raise-blobs` volume; the application sweeps old objects itself.

Hosted blob mode sets `BLOB_STORE=s3` and requires `BLOB_S3_BUCKET`. `BLOB_S3_REGION` defaults to `auto`; `BLOB_S3_ENDPOINT` supplies the R2, MinIO, or other compatible endpoint, while AWS S3 can use the SDK default. `BLOB_S3_FORCE_PATH_STYLE=true` supports services that require path-style requests. `BLOB_S3_ACCESS_KEY_ID`, `BLOB_S3_SECRET_ACCESS_KEY`, and optional `BLOB_S3_SESSION_TOKEN` supply explicit credentials; leaving them unset preserves the AWS SDK workload-role and standard provider chain. `DATA_DIR` isn't used for blobs in this mode.

`MAX_IMAGE_BYTES` defaults to `15728640` and limits one decoded source image before Sharp processes it. There is no state-store selector, `DATABASE_URL`, cleanup-worker configuration, or queue configuration.

## Trust and failure rules

- Capability URLs carry secrets in fragments, which don't reach ordinary HTTP access logs. The browser exchanges and removes the fragment.
- Human and agent claims wrap the same request content key independently and grant different roles.
- The server stores supplied HTTP(S) URLs as encrypted references and never requests them.
- Redis failure returns an unavailable response and never falls back to unauthenticated object access.
- A missing, corrupt, or unauthenticated blob fails the attachment read without exposing provider details.
- The protocol's per-entry limits are active. `S07-abuse` adds per-IP or credential burst limits and cumulative per-request counters for text, sanitized bytes, decoded pixels, entries, and concurrent waits.
- `noeviction` protects active Valkey data. At the service memory ceiling, Raise rejects new creation instead of dropping a live thread.
- Logs redact capability tokens, cookies, wrapped keys, plaintext content, and provider secrets.

## Release gaps

- `VALKEY_URL` is required. Valkey is the sole state implementation.
- `/readyz` doesn't yet probe Redis or the selected blob adapter.
- The R2 lifecycle document is checked in; applying it, reading it back, and running a real S3-compatible provider smoke test remain deployment work.
- Public creation has no Turnstile or Redis-backed quotas.

## Decisions

- [ADR 0001: Use ephemeral Redis state and object blobs](architecture/decisions/0001-use-ephemeral-redis-and-object-storage.md)
- [ADR 0002: Wrap content keys with role capabilities](architecture/decisions/0002-wrap-content-keys-with-capabilities.md)
- [ADR 0003: Use logical expiry and storage lifecycles](architecture/decisions/0003-use-logical-expiry-and-storage-lifecycles.md)
