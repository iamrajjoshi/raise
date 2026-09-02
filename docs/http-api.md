# HTTP protocol

The browser and coding agents use the same JSON endpoints. A human usually follows a claim URL in the browser. An agent can exchange the claim for a bearer token.

## Claim an agent link

A claim URL looks like this:

```text
http://localhost:8787/r/r_public_id#token=cap_capability.secret
```

URL fragments are not sent to the server. Extract the `token` value locally, then exchange it once:

```bash
curl http://localhost:8787/api/claims \
  --request POST \
  --header 'content-type: application/json' \
  --data '{"token":"cap_…","mode":"token","expectedRole":"agent","exchangeId":"7b32c27a-6f2d-4fd2-9be4-6fded48ce104"}'
```

The response contains a bearer token and expiry. Store the token outside command history and logs. Agent adapters should send `expectedRole: "agent"`; a mismatched role is rejected before the one-time claim is consumed.

`exchangeId` is an optional, client-held retry secret. Generate it independently with a cryptographically secure random source and persist it before the first claim request. Never derive it from the claim URL or token, and keep it out of logs. If the response is lost, resend the same `exchangeId` with the same `mode`; the server stores only its SHA-256 digest and returns the same scoped session. A different ID or a switch between `cookie` and `token` mode is rejected. This prevents a consumed browser claim from being replayed to reveal its bearer token.

Upgrading from a version that stored plaintext exchange IDs invalidates those legacy replay mappings because they were not bound to a trustworthy delivery mode. An already-issued session token or cookie continues to work until its normal expiry, but its consumed claim cannot be replayed after the upgrade.

## Discover requests from the agent inbox

Set the optional `RAISE_INBOX_TOKEN` environment variable on the server to enable the single-default-project agent inbox. It must contain at least 32 characters. Generate a dedicated random value, keep it out of logs and command history, and send it only as a bearer token. Leaving it unset disables both inbox endpoints.

```bash
curl 'http://localhost:8787/api/inbox?limit=50' \
  --header "authorization: Bearer $RAISE_INBOX_TOKEN"
```

The response is `{ "items": [...] }`. It contains only open requests whose expiry is still in the future. Requests waiting on the agent come first; within each turn group, the most recently updated request comes first. `limit` defaults to 50 and accepts values from 1 through 100.

Each item includes `raiseId`, `title`, `origin`, `waitingOn`, `pendingAction`, `version`, `createdAt`, `updatedAt`, and `expiresAt`. The service credential is accepted only by `/api/inbox` routes; request session tokens and browser cookies cannot list the inbox.

## Open an inbox request as the agent

Mint a normal request-scoped agent session after selecting an inbox item:

```bash
curl http://localhost:8787/api/inbox/r_public_id/session \
  --request POST \
  --header "authorization: Bearer $RAISE_INBOX_TOKEN"
```

The `ClaimResponse` always has `role: "agent"` and includes the bearer `token` plus its `expiresAt`. Use that token on the existing request endpoints. The server rejects missing inbox configuration, bad service credentials, unknown requests, and expired requests; this endpoint never mints a human session.

## Read a request

```bash
curl http://localhost:8787/api/raises/r_public_id \
  --header 'authorization: Bearer ses_…'
```

The response says which role is viewing, who must act, the pending action kind, the current version, permissions, and ordered entries.

## Post an agent result

```bash
curl http://localhost:8787/api/raises/r_public_id/entries \
  --request POST \
  --header 'authorization: Bearer ses_…' \
  --header 'content-type: application/json' \
  --data '{
    "kind":"result",
    "body":"Fixed the overflow and checked the mobile layout.",
    "attachments":[],
    "expectedVersion":1
  }'
```

Use the version returned by the latest read. A stale mutation returns `409 state_conflict`.

There is no four-screenshot product limit. Attachments in one request or entry may total up to 15 MiB after base64 decoding. A 32-item ceiling rejects implausibly large arrays before image processing; ordinary use should hit the byte budget first. Larger uploads should use smaller copies for now.

## Open a request from an agent

`POST /api/raises` accepts an optional `title`. When a client omits it, the server uses the first content line of `prompt`, up to 180 characters, then falls back to a URL or screenshot name. The web scratchpad always derives its title. A request needs text, a URL, or at least one screenshot, so a screenshot-only request is valid. To open a request from an agent, set `origin` to `agent`; the response contains an owner claim URL for the agent and a target claim URL for the human. Exchange the owner claim locally and send only the human URL to the collaborator.

The MCP adapter maps `raise_open`, `raise_claim`, `raise_inbox`, `raise_read`, `raise_reply`, `raise_screenshot`, `raise_wait`, and `raise_update` to these endpoints. It keeps its session credentials locally and never reaches into the server’s database or blob storage.
