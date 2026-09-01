# Raise

Raise is a self-hosted context and review channel for people and coding agents.

A person or agent creates a request and shares a role-specific link. The thread keeps text, page URLs, screenshots, agent results, and review decisions together. Requests expire after 24 hours by default.

The current alpha supports the first working loop:

- Start a request from one scratchpad in the web app, or from the API.
- Paste text from a document, paste a screenshot, or drop a plain-text or Markdown file.
- Share a role-scoped secret link.
- Reply with text, links, or screenshots.
- Post an agent result.
- Accept the result or ask for changes.
- Store everything in SQLite and a local data directory.
- Use the same loop from an MCP-compatible coding agent.

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

Build the repo, configure your MCP client to run `apps/mcp/dist/main.js`, and point `RAISE_BASE_URL` at the local or hosted Raise server. The agent can open a request for a human, claim a full URL pasted by a human, reply, and wait for the next turn. See [MCP adapter](docs/mcp.md) or the lower-level [HTTP protocol](docs/http-api.md).

## Project status

This is an early working slice. Short-lived capability links control access; there are no accounts yet. Do not expose the alpha to the public internet until the product plan's security checklist is complete.

- [Product and delivery plan](docs/product-plan.md)
- [Architecture](docs/architecture.md)
- [OpenAPI specification](openapi.yaml)
- [UI direction](docs/ui-direction.md)
- [Contributing](CONTRIBUTING.md)

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
