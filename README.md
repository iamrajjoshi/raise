# Raise

Raise is a self-hosted context and review channel for people and coding agents.

A person or agent creates a request and shares a role-specific link. The thread keeps text, page URLs, screenshots, agent results, and review decisions together. Requests expire after 24 hours by default.

The current `0.1.0-alpha.1` build supports the first working loop:

- Create requests from the web or API.
- Share a role-scoped secret link.
- Reply with text, a saved URL, or screenshots.
- Post an agent result.
- Accept the result or ask for changes.
- Store everything in SQLite and a local data directory.

## Run locally

Requirements: Node 24+ and pnpm 11.

```bash
pnpm install
pnpm dev
```

Open `http://localhost:5173`. The API runs on `http://localhost:8787`.

For one-process use:

```bash
pnpm build
pnpm start
```

Open `http://localhost:8787`.

## Agent access

Creating a request returns an access link for the other role. A coding agent can open its link in a browser or exchange the token for API access. See [HTTP protocol](docs/http-api.md).

## Project status

This is an early working slice. Short-lived capability links control access; there are no accounts yet. Do not expose the alpha to the public internet until the product plan's security checklist is complete.

- [Product and delivery plan](docs/product-plan.md)
- [Architecture](docs/architecture.md)
- [OpenAPI specification](openapi.yaml)
- [UI direction](docs/ui-direction.md)
- [Contributing](CONTRIBUTING.md)

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
