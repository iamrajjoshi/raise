# MCP adapter

Raise includes a local MCP server for coding agents. It runs over stdio on the same machine as the agent and talks to any reachable Raise HTTP server. The Raise server itself can stay in Docker on a laptop, VM, ECS, Cloud Run, or another container host.

## Build and configure

```bash
pnpm install
pnpm build
```

Point your MCP client at the built entry file:

```json
{
  "mcpServers": {
    "raise": {
      "command": "node",
      "args": ["/absolute/path/to/raise/apps/mcp/dist/main.js"],
      "env": {
        "RAISE_BASE_URL": "http://localhost:8787"
      }
    }
  }
}
```

For a cloud deployment, set `RAISE_BASE_URL` to its HTTPS origin. The adapter rejects plaintext HTTP except for loopback addresses. No database or Redis connection is needed on the agent machine.

Agent sessions are stored as separate mode-`0600` files under `~/.raise/sessions/`. Set `RAISE_STATE_DIR` to put that private directory elsewhere. Do not commit it or paste its contents into a prompt. Claim exchanges use a deterministic, non-secret retry ID derived from the claim token, so a lost HTTP response can recover the same session even after the MCP process restarts without making the claim reusable for another exchange.

## Tools

- `raise_open` starts a request from the agent and returns the human’s one-time link. It can attach screenshots from explicit absolute paths.
- `raise_claim` accepts the full link a human pasted into the agent chat.
- `raise_read` reads the current request and its turn state.
- `raise_reply` sends the response or result currently expected from the agent, including screenshots when needed.
- `raise_screenshot` retrieves one authenticated, agent-sized screenshot by attachment ID.
- `raise_update` adds a side note without advancing the request.
- `raise_wait` polls for a version change for at most 30 seconds.

`raise_open` also returns the plain request URL. The human should first use `humanUrl`; after claiming it, that browser can revisit the plain URL until the request expires.

The adapter uses the public HTTP protocol. It does not reach into SQLite, image storage, or any cloud-specific service.
