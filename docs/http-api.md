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
  --data '{"token":"cap_…","mode":"token"}'
```

The response contains a bearer token. Store it outside command history and logs.

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

This alpha exposes the underlying protocol while the `raise_open`, `raise_read`, `raise_reply`, `raise_wait`, and `raise_update` MCP adapter is built.
