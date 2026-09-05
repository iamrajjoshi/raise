# Raise product requirements

Status: approved direction, implementation in progress

Owner: Raj Joshi

Last updated: 2026-09-05

## Problem, evidence, and actors

People working with coding agents regularly lose the context needed to finish a task. Screenshots sit in chat, the affected URL sits elsewhere, and the agent's result arrives without a clean review step. Existing issue trackers ask for too much structure when the real need is closer to a temporary shared scratchpad.

Raise gives one person and one agent a short-lived thread. Either participant can start it, hand the other participant a role-specific link, exchange context over several turns, and close the loop with an explicit review decision.

The v0.1 actors are:

- A human using the Raise web app.
- A coding agent using the MCP adapter or HTTP API.
- A self-hoster or managed-service operator configuring storage and limits.

Possession of a role capability grants access. Raise doesn't claim to verify a person's identity.

## Goals and non-goals

### v0.1 goals

- Make a human-started and an agent-started exchange feel like the same product.
- Keep text, HTTP(S) references, pasted document text, screenshots, results, comments, and review decisions in one ordered thread.
- Make manual handoff links enough for a complete exchange; neither participant needs an account.
- End access automatically after a short idle period and encrypt all user-supplied content at the application layer.
- Ship one codebase that runs as a small managed service or through Docker Compose.

### Explicit non-goals

- No embeddable website widget, loader script, banner, corner tab, DOM picker, element selector, or public widget credential.
- No accounts, organizations, projects, memberships, permanent history, search, assignments, email, or general notification center.
- No Postgres, backup/restore system, job queue, scheduled cleanup service, Redis Pub/Sub, or multiple application replicas.
- No remote URL fetching, link previews, PDF or DOCX upload, OCR, arbitrary file storage, browser automation, or session replay.
- No upgrade or data-migration path for untagged development builds.

## Journeys

### A human asks an agent for work

1. The human opens the web scratchpad, pastes context, and optionally adds an HTTP(S) URL or screenshots.
2. Raise creates the thread and shows a role-specific agent link.
3. The agent claims that link, reads the thread, and posts a result.
4. The human accepts the result or asks for changes. A changes request returns the turn to the agent.

### An agent asks a human for context

1. The agent creates a request through MCP and receives a human link. On the managed service, its MCP adapter presents the configured create-only bearer credential.
2. The human opens the link, adds text or screenshots, and sends the response.
3. The agent continues in the same thread and returns its result for human review.

### Returning after a disconnect

The browser or MCP adapter keeps its role session locally and reloads the current state and ordered thread after a disconnect. Later reads reuse an opaque cursor to ask only for newer entries; when that cursor is unavailable, Raise sends a replacement snapshot. A server restart doesn't require resending old turns.

Counterexamples: Raise isn't a task board, support widget, document archive, chat room, or replacement for GitHub Issues and Linear.

## Requirements

### v0.1 behavior

- `V01-001`: A human or agent can create the same request type.
- `V01-002`: Creation returns separate role-scoped manual handoff links. No server-wide discovery credential exists.
- `V01-003`: A request supports an ordered, bounded exchange of prompts, replies, results, comments, and review decisions.
- `V01-004`: Each mutation checks the role, expected version, current pending action, and one winning state transition.
- `V01-005`: An agent can post a result; a human can accept it or ask for changes.
- `V01-006`: The first read returns the bounded thread as a snapshot. Later reads accept an opaque cursor and return newer entries plus current state, or a replacement snapshot when the cursor can't be continued.
- `V01-007`: Raise decodes PNG, JPEG, and WebP input, strips source metadata through re-encoding, encrypts the sanitized output, and attaches it to one entry.
- `V01-008`: Web and MCP clients use the same HTTP records and state rules.
- `V01-009`: A browser may remember requests it created or claimed in local browser storage. That list isn't a server inbox.
- `V01-010`: Limits use cumulative encoded bytes, decoded pixels, text bytes, and active-thread lifetime. The UI doesn't impose a small screenshot-count workflow.

### Security and privacy

- `SEC-001`: Capability secrets contain at least 128 bits of randomness, stay in URL fragments until exchange, reach storage only as digests, and remain scoped to one request and role.
- `SEC-002`: Each request has a random content key. Raise encrypts event content and blobs with authenticated encryption and wraps that content key separately for each valid claim or session.
- `SEC-003`: Raise describes this as application-level encryption at rest, not end-to-end encryption. The server decrypts content in memory while serving an authorized request.
- `SEC-004`: Private attachment responses require a live role session and use `Cache-Control: private, no-store`. R2 objects never receive public URLs or public ACLs.
- `SEC-005`: User-provided URLs must use HTTP or HTTPS. The server stores them as references and never fetches them.
- `SEC-006` (planned in `S07-abuse`): The managed profile requires a base64url-encoded random 256-bit `RAISE_AGENT_CREATE_TOKEN` for agent-originated creation. That bearer credential can only create a request; it grants no discovery, claim, read, mutation, or attachment access. Managed browser creation requires a valid Turnstile assertion. A self-hoster may explicitly allow unauthenticated agent creation.

### Retention

- `RET-001`: Creation sets a six-hour hard deadline and an access deadline of the earlier of two hours after creation or the hard deadline.
- `RET-002`: A successful content mutation moves the idle deadline to two hours after that write without moving the hard deadline.
- `RET-003`: Reads, waits, claims, attachment downloads, rejected writes, and exact idempotent replays don't extend access.
- `RET-004`: Accepting a result shortens access to the earlier of its existing deadline or 15 minutes after acceptance.
- `RET-005`: All Redis keys for one request receive the same absolute expiration during the mutation that changes its state.
- `RET-006`: Every hosted object becomes eligible for R2 lifecycle deletion six hours after upload. Raise states plainly that physical removal happens asynchronously after access ends.
- `RET-007`: The existing application process removes expired local encrypted blobs at startup and on a low-frequency interval. Self-hosters may choose an S3-compatible lifecycle instead.

Cancellation isn't a required v0.1 action. If it is added, it must use the same 15-minute access window as acceptance.

### Reliability and operations

- `REL-001`: Event append, state and version change, pending-action transition, capability changes, idempotency result, and Redis deadlines commit through one atomic store operation. `S07-abuse` adds quota counters.
- `REL-002`: Raise writes encrypted blobs before publishing references to them. A failed metadata commit triggers best-effort blob deletion; provider lifecycle handles an orphan left by a crash.
- `REL-003`: Reusing an idempotency key with the same request returns the original result without adding another entry or extending idle life. Reusing it with different content fails.
- `OPS-001`: Application logic depends on `RaiseStore` and `BlobStore` contracts rather than Redis, R2, or filesystem calls.
- `OPS-002`: The self-hosted profile runs one Raise application container, one Valkey service with AOF persistence, and one encrypted local blob volume. Valkey's state volume is live persistence, not a backup.
- `OPS-003` (planned in `S08-deploy`): The hosted profile runs one Cloud Run Raise instance, managed Redis, and a private R2 bucket with the six-hour lifecycle rule.
- `OPS-004` (planned in `S07-abuse`): Redis-backed limits protect creation, claim exchange, mutation, wait, and attachment bandwidth before a public free tier opens.
- `OPS-005` (planned in `S08-deploy`): Health checks report process health separately from Redis and blob readiness without returning secrets.

### v0.2 only

- `V02-001`: A browser can pair with a local MCP installation through a short-lived exchange that doesn't require pasting a permanent secret into an agent transcript.
- `V02-002`: A paired agent can list only open, unexpired requests associated with that pairing and currently waiting on it.
- `V02-003`: Pairings support reconnect and revocation. Raise never treats a closed local agent as an always-on worker.
- `V02-004`: Pairing adds no accounts, projects, retained history, email delivery, or general notifications.

## Permissions, data, and failure policy

Role capabilities are bearer credentials. The human and agent receive different claims, which exchange once for expiring sessions. Only the role targeted by the pending action can answer it; only the human can accept a result or ask for changes. Comments may leave the turn unchanged.

Before the hosted private alpha opens, `S07-abuse` will add `RAISE_AGENT_CREATE_TOKEN` as a base64url-encoded random 256-bit secret. MCP will send it only as an authorization bearer on request creation; it will not list threads or replace a role claim. The same slice adds Turnstile for managed browser creation and Redis-backed rate limiting for both paths.

Redis stores current state, ordered encrypted event envelopes, capability digests, wrapped content keys, deadlines, and idempotency results. `S07-abuse` adds quota counters. R2 or the local blob adapter stores encrypted sanitized images under opaque object names. Operational metadata may expose random IDs, roles, lifecycle state, timestamps, dimensions, and byte counts. User text, URLs, filenames, decisions, and image bytes remain encrypted at rest.

If Redis is unavailable, authenticated reads and writes fail closed. A failed blob upload doesn't create or advance a request. If the state changes while a participant uploads images, the commit fails with a conflict and Raise removes the staged blobs.

## Quality and external constraints

- TypeScript remains the implementation language. React, Fastify, Sharp, and the existing MCP adapter stay unless a measured problem forces a change.
- The HTTP contract remains client-neutral and versioned before v1.
- One application instance is a release constraint, not a claim that multi-instance delivery already works.
- Docker Compose must work without an AWS, GCP, Cloudflare, or Upstash account.
- The managed profile may use cloud-specific deployment files, but product code cannot import a cloud provider directly.
- `pnpm check` must pass for every completed slice. Provider contract tests run against a real Valkey service.

## Success, stop, and rollout signals

The first private hosted alpha opens only after the web-to-MCP-to-web loop, conflicts, idempotent retries, encryption tamper cases, access expiry, restart recovery, orphan cleanup, and rate limits pass automated or staged tests.

The product earns v0.2 pairing when outside testers complete repeated reviewed loops but manual link delivery causes missed work. If people mainly use Raise as one-way screenshot transfer and rarely review results, keep it as a small exchange utility instead of adding inbox machinery.

## Assumptions, decisions, and open questions

Accepted decisions live in [the ADR index](architecture/decisions/README.md). Valkey is the only state store. [The delivery plan](PLAN.md) names the remaining release work.

Open questions don't block the preparation slice:

- Pick the managed Redis vendor after the Valkey store contract passes locally; Upstash is the current candidate.
- Set public free-tier quotas from measured alpha traffic rather than guessing a permanent allowance.
- Decide whether to reset the private package version from `0.2.0-alpha.2` before the first tagged release.
