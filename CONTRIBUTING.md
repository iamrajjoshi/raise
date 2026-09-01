# Contributing

Install Node 24 and pnpm 11, then run:

```bash
pnpm install
pnpm check
```

Keep changes focused. New product behavior should include a state-transition test and update the relevant documentation. Report security issues privately as described in `SECURITY.md`.

The `main` branch should require a pull request and a passing CI check. Do not merge capability, storage, or state-machine changes without review.
