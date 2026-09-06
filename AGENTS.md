# Working in Raise

Raise is a small, self-hosted exchange for people and coding agents. Preserve its single application container, small Compose setup, and symmetric human/agent state model.

## Before changing code

- Read `docs/PRD.md` for product behavior and explicit cuts.
- Read `docs/research.md` when changing a researched provider claim or revisiting an accepted tradeoff.
- Read `docs/architecture.md` for the target design and current release gaps.
- Read `docs/PLAN.md` for the active slice, acceptance checks, and resume point.
- Check `docs/architecture/decisions/` before changing storage, encryption, retention, or deployment boundaries.
- Keep secret capability tokens out of logs, test snapshots, and committed fixtures.
- Do not fetch or render remote URLs supplied in a request.
- Do not add a website widget, accounts, projects, Postgres, Pub/Sub, a queue, a cleanup service, or multiple application replicas without an approved requirement and architecture decision.
- Never add a plaintext implementation behind an encryption interface. Valkey is the only state store. Local blob storage remains a supported self-hosted option because it stores application-encrypted bytes.
- Keep routes and clients behind `RaiseStore` and `BlobStore`; provider-specific code belongs in adapters or runtime composition.

## Current storage rule

The server requires Valkey and has no alternate state-store fallback. Retention is server-owned, and records and blobs are application-encrypted before they reach a storage provider. Unreleased builds carry no data-compatibility promise. Preserve working paths while completing one slice at a time, and don't update public copy ahead of tested runtime behavior.

## Checks

Run `pnpm check` before opening a pull request. Run `pnpm readiness` when changing repository setup or contributor tooling.
