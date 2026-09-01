# Working in Raise

Raise is a small, self-hosted exchange for people and coding agents. Preserve its single-container local setup and the symmetric human/agent state model.

## Before changing code

- Read `docs/product-plan.md` for product boundaries.
- Read `docs/architecture.md` for the current shape and known shortcuts.
- Keep secret capability tokens out of logs, test snapshots, and committed fixtures.
- Do not fetch or render remote URLs supplied in a request.

## Checks

Run `pnpm check` before opening a pull request. Run `pnpm readiness` when changing repository setup or contributor tooling.
