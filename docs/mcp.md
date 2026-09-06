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

Agent sessions are stored as separate mode-`0600` files under `~/.raise/sessions/`. Set `RAISE_STATE_DIR` to put that private directory elsewhere. Do not commit it or paste its contents into a prompt.

Claim retries use one atomic mode-`0600` pending record per claim in the same directory. Each record maps the Raise server and a hash of the claim token to a random exchange UUID; the claim secret itself is never written. Concurrent MCP processes converge on the same record. A restarted process reuses that UUID if a claim response was lost. Retryable network, rate-limit, and server failures retain it; terminal claim errors remove it. Records expire after seven days.

Replies and updates use a separate pending-mutation record containing only server and request identifiers, digests, the original version, a random idempotency key, and its creation time. The adapter reuses that key and version after a retry or process restart. It never writes the entry body, image bytes, image path, or bearer token into this record.

`raise_open` also saves a mode-`0600` pending-open record, keyed by a digest of the normalized tool input, as soon as the server returns the created request. If the subsequent claim response is lost, calling `raise_open` again with the same arguments resumes that request after a process restart instead of creating another one. Pending-open records contain the private capability links, so protect the entire state directory. They are removed only after the scoped session is saved and expire after seven days. A cleanup failure is reported in the tool result rather than hidden.

This recovery begins after the create response has reached the adapter. The create endpoint itself is not idempotent in this alpha, so a connection loss before that response arrives cannot be recovered locally with certainty.

## Tools

- `raise_open` starts a request from the agent and returns the human’s one-time link. It can attach screenshots from explicit absolute paths.
- `raise_claim` accepts the full link a human pasted into the agent chat.
- `raise_read` reads the current request and its turn state, then returns the cursor used by later waits.
- `raise_reply` sends the response or result currently expected from the agent, including screenshots when needed.
- `raise_screenshot` retrieves one authenticated, agent-sized screenshot by attachment ID.
- `raise_update` adds a side note without advancing the request.
- `raise_wait` makes one bounded change request for at most 30 seconds. Pass the cursor returned by the latest `raise_read`, mutation, or `raise_wait` result.

`raise_wait` uses the cursor as its read position; `version` remains the token for mutation conflicts. When the server returns a delta, the tool includes only newer entries. A cursor-based timeout returns `changed: false` with the same cursor and an empty delta.

Calling `raise_wait` without a cursor remains compatible: the adapter performs one initial read to get one. The `afterVersion` input is also accepted for older callers, but it is deprecated and cannot be combined with `cursor`. New clients should store and pass the cursor directly so the wait needs only one HTTP request.

`raise_open` also returns the plain request URL. The human should first use `humanUrl`; after claiming it, that browser can revisit the plain URL until the request expires.

For a human-created request, paste the complete agent link into the agent chat and call `raise_claim`. v0.1 deliberately has no server-wide agent inbox or discovery credential.

The adapter uses the public HTTP protocol. It does not reach into Valkey, image storage, or any cloud-specific service.
