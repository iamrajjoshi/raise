# ADR-0003: Use logical expiry and storage lifecycles

- Status: accepted
- Date: 2026-09-05
- Deciders: Raj Joshi
- Related requirements: `RET-001` through `RET-007`, `REL-002`, `OPS-003`
- Supersedes: an authenticated scheduled cleanup endpoint

## Context

Raise needs exact short-lived access without adding a queue or cleanup service. Redis can expire the state, capability wraps, and object mappings at an absolute millisecond deadline. R2 object lifecycle works from object age and removes bytes asynchronously, so it can't match a thread's changing idle or post-acceptance deadline.

The user accepts delayed physical removal when access ends exactly and the remaining object is private ciphertext without a live mapping or wrapped content key.

## Decision drivers

- Two-hour idle access, six-hour maximum life, and 15 minutes after acceptance.
- Reads and retries must not keep a request alive.
- No Cloud Scheduler, cleanup endpoint, queue, or worker in v0.1.
- Orphaned uploads must eventually disappear after a process crash.
- Retention copy must not overstate provider behavior.

## Options considered

### Scheduled application cleanup

A scheduler can follow each thread deadline more closely and retry failed deletes. It adds another deployed resource, an authenticated maintenance endpoint, deletion indexing, retry state, and operating checks.

### Redis keyspace notifications

Expiration notifications aren't a durable deletion queue. A disconnected consumer can miss them, and Redis may emit expiry later than the logical deadline.

### Redis TTL plus R2 lifecycle

Redis handles authorization and logical access. One bucket-prefix rule removes every encrypted object by age, including uploads that never reached a Redis commit.

## Decision

Apply one effective absolute deadline to every per-request Redis key during the atomic mutation:

```text
min(last successful content write + 2 hours, created at + 6 hours)
```

Accepting a result shortens that deadline to the earlier of its existing value or 15 minutes after acceptance. Reads, waits, attachment downloads, claim exchange, rejected mutations, and exact idempotent replays leave it unchanged.

Configure one R2 lifecycle rule for the `ephemeral/v1/` prefix through the Cloudflare lifecycle API with `maxAge: 21600`. That makes each object eligible for deletion six hours after its own upload. Cloudflare says objects are typically removed within 24 hours after lifecycle expiration and may take longer. Raise must separate exact access expiry from asynchronous physical deletion in its security copy.

Local encrypted blobs use file age and a sweep inside the existing Raise process at startup and on a low-frequency interval. Valkey uses AOF persistence for restart recovery; this isn't a backup or retained history. If the process stays offline, blob deletion waits until its next start. An S3-compatible self-hosted store may use its own lifecycle rule instead.

## Consequences

The hosted topology loses its scheduler, cleanup endpoint, deletion queue, and maintenance credential. The same R2 rule catches objects left by a crash between upload and Redis commit.

Encrypted bytes can remain billable and physically present for roughly another 30 hours after upload under typical lifecycle timing, sometimes longer. Raise can't promise a hard physical deletion deadline. If the Redis provider keeps recovery copies, provider retention may outlast the live key; application encryption still limits plaintext exposure.

An object uploaded late in a request remains available through the thread's six-hour hard deadline because its own six-hour object age starts later. It may then linger as inaccessible ciphertext until lifecycle deletion finishes.

## Validation

- Evidence: [Cloudflare R2 lifecycle API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/lifecycle/methods/update/) defines age in seconds; [R2 lifecycle behavior](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) documents typical deletion timing and its lack of a hard deadline; Redis `PEXPIREAT` sets absolute millisecond expiry.
- Pass condition: TTL tests prove the exact access rules for all per-request keys; deployment verification reads back the six-hour R2 rule; an orphan object under the prefix has the expected lifecycle header or rule match.
- Fallback if it fails: restore a small authenticated cleanup service only if product requirements demand a tighter physical deletion target.
- Permanent check: deterministic clock tests for Redis and lifecycle-configuration verification during deployment.

## Revisit when

Reconsider if policy or customers require a hard physical deletion deadline, if R2 changes lifecycle behavior, or if measured orphan storage becomes costly.

## Outcome

Valkey enforces logical expiry, local blob storage runs its in-process age sweep, and the exact R2 lifecycle document is checked in. Applying and reading back the R2 rule remains in `S08-deploy`.
