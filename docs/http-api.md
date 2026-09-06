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
  --data '{"raiseId":"r_public_id","token":"cap_…","mode":"token","expectedRole":"agent","exchangeId":"7b32c27a-6f2d-4fd2-9be4-6fded48ce104"}'
```

The request ID and token must come from the same claim URL. The response contains a bearer token and the latest time the client should retain it. Access can end earlier after inactivity or acceptance, and the server remains authoritative. Store the token outside command history and logs. Agent adapters should send `expectedRole: "agent"`; a mismatched request or role is rejected before the one-time claim is consumed.

`exchangeId` is an optional, client-held retry value. Generate it independently with a cryptographically secure random source and persist it before the first claim request. Never derive it from the claim URL or token, and keep it out of logs. If the response is lost, resend the same `exchangeId` with the same `mode`; the server derives the same session secret from the claim secret, exchange ID, and stored session ID. Storage keeps only digests, IDs, the delivery mode, and the wrapped content key. A different ID or a switch between `cookie` and `token` mode is rejected. Without an exchange ID, claiming remains one-shot and a lost response cannot be recovered through the claim link.

## Read a request

```bash
curl http://localhost:8787/api/raises/r_public_id \
  --header 'authorization: Bearer ses_…'
```

The first read returns the current state and the retained thread with `entriesMode: "snapshot"`. It also returns two different positions:

- `version` is the mutation-conflict token. Send it as `expectedVersion` with the next write.
- `cursor` is an opaque read position. Keep it for `/changes`; don't parse or construct it.

## Wait for changes

```bash
curl 'http://localhost:8787/api/raises/r_public_id/changes?cursor=1725552123456-0&wait=20' \
  --header 'authorization: Bearer ses_…'
```

`cursor` is required. `wait` is optional and accepts whole seconds from 0 through 30; zero asks the server to check once without waiting.

A `200` response includes current request state, a new cursor, and one of two entry modes. For `snapshot`, replace the locally cached entry list. For `delta`, merge the returned entries by entry ID so a retried response can't create duplicates. Save the returned cursor after applying either response.

A `204` response means no new entries appeared before the wait ended. Keep the same cursor and reconnect when another wait makes sense. If the server can no longer continue from a cursor, it returns a replacement snapshot instead of leaving the client with a gap.

The waiter lives inside the single Raise application process; it doesn't use Redis Pub/Sub. A server restart may end an open HTTP request, so clients retry with their last cursor. Valkey remains the source of accepted entries.

## Post an agent result

```bash
curl http://localhost:8787/api/raises/r_public_id/entries \
  --request POST \
  --header 'authorization: Bearer ses_…' \
  --header 'idempotency-key: 4c04716e-f0b3-4760-8fe6-6ff952526978' \
  --header 'content-type: application/json' \
  --data '{
    "kind":"result",
    "body":"Fixed the overflow and checked the mobile layout.",
    "attachments":[],
    "expectedVersion":1
  }'
```

Use the version returned by the latest read or change response. A stale mutation returns `409 state_conflict`. Generate a fresh `Idempotency-Key` for each intended mutation and retain it until the outcome is known. Repeating the same normalized request with the same key returns the original result without adding another entry or extending retention. Reusing the key for different content returns `409 idempotency_conflict`.

There is no four-screenshot product limit. Attachments in one request or entry may total up to 15 MiB after base64 decoding. A separate 32-item ceiling rejects implausibly large arrays before image processing. If an upload exceeds the byte budget, use smaller copies.

## Open a request from an agent

`POST /api/raises` accepts an optional `title`. When a client omits it, the server uses the first content line of `prompt`, up to 180 characters, then falls back to a URL or screenshot name. The web scratchpad always derives its title. A request needs text, a URL, or at least one screenshot, so a screenshot-only request is valid. To open a request from an agent, set `origin` to `agent`; the response contains an owner claim URL for the agent and a target claim URL for the human. Exchange the owner claim locally and send only the human URL to the collaborator.

The MCP adapter maps `raise_open`, `raise_claim`, `raise_read`, `raise_reply`, `raise_screenshot`, `raise_wait`, and `raise_update` to these endpoints. It keeps its session credentials locally and never reaches into the server’s database or blob storage. A human must send the agent its role-specific link; v0.1 has no server-wide discovery endpoint.
