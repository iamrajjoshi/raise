# ADR-0002: Wrap content keys with role capabilities

- Status: accepted
- Date: 2026-09-05
- Deciders: Raj Joshi
- Related requirements: `SEC-001`, `SEC-002`, `SEC-003`, `SEC-004`
- Supersedes: provider-only encryption at rest in the original prototype

## Context

Raise will hold screenshots, pasted document text, URLs, and agent results. Redis and R2 encrypt their underlying media, but a provider credential or storage export could still expose plaintext application records if Raise sends plaintext to those services. Short retention reduces exposure time without protecting a live storage copy.

Manual role links already carry random capability secrets. They can also provide the material needed to protect a per-request content key without introducing an account system or one global decryption key.

## Decision drivers

- A Redis or R2 export must not contain readable user content.
- Human and agent permissions remain separate.
- Claim exchange and MCP restart must preserve access without keeping raw capability secrets in storage.
- Expiring Redis state should remove the server's stored path to decrypt lingering R2 ciphertext.
- Product copy must describe the real trust boundary.

## Options considered

### Provider-managed encryption only

This requires no application crypto, but Redis and R2 receive readable content. Anyone with broad provider access can read it.

### One application master key

Envelope encryption under one server secret protects raw storage media. A leaked master key exposes every live thread and weakens cryptographic expiry because the operator can keep decrypting old blobs if object mappings survive.

### Per-request content key wrapped for capabilities

Each request gets an independent data-encryption key. A wrapping key derived from each claim or session secret protects a copy of that data key. Storage keeps the capability digest and wrapped copy, while requests present the raw secret.

## Decision

Generate a random 256-bit content key for each request. Encrypt every user-supplied event field and sanitized image with AES-256-GCM, a fresh 96-bit nonce, and authenticated context containing the envelope version, request ID, record type, record ID, and field identity.

Derive a wrapping key from each raw capability secret with HKDF-SHA-256 and store a separately wrapped copy of the content key beside that capability's digest. During a successful one-time claim exchange, unwrap in memory, wrap a copy for the new session secret, and erase the consumed claim's wrap inside the same transaction. Exact retry uses the winning session record rather than retaining the claim's decrypting material. Never write plaintext temporary image files.

The server decrypts while answering an authorized request. Raise therefore promises application-level encryption at rest, not end-to-end encryption or protection from a malicious running server.

The former server-wide inbox token couldn't mint a decrypting session under this design because it held no per-Raise wrap. Raise removed that flow before implementing the encrypted runtime.

## Consequences

A storage-only compromise does not reveal content. Role boundaries bind directly to the stored decrypting material, and deleting every wrapped copy makes remaining blob ciphertext unusable through Raise.

Claim and retry logic becomes harder: wrong context, partial rewrap, nonce reuse, and error logging can break security or availability. The envelope format needs a version from its first stored byte, plus tamper and restart tests.

This design does not stop an authorized recipient from saving content, nor does it hide operational metadata such as random IDs, roles, state, timestamps, image dimensions, or byte counts.

## Validation

- Evidence: current 256-bit capability generation and one-time claim exchange; Node.js authenticated encryption and HKDF APIs.
- Pass condition: round-trip, wrong-key, wrong-context, tag, ciphertext, and nonce-tamper tests pass; raw state and blob inspection find neither unique plaintext sentinels nor WebP headers.
- Fallback if it fails: stop the hosted release and keep Raise local. Don't silently fall back to provider-only encryption.
- Permanent check: crypto unit tests plus an at-rest sentinel integration test.

## Revisit when

Reconsider if Raise adds account recovery, server-side indexing of message bodies, cross-thread search, or a true end-to-end mode. Each feature changes who must hold or derive the content key.

## Outcome

Implemented in `S02-crypto`. The closed-loop sentinel-at-rest test inspects Valkey state and local blob storage for plaintext sentinels and recognizable image bytes. Valkey retention is implemented; abuse controls and hosted deployment proof remain release work.
