# Raise

Raise is a temporary context and review channel for people and coding agents.

A person or agent opens a scratchpad, drops in text, an HTTP(S) reference, or screenshots, and gives the other participant a role-specific link. The same thread carries questions, results, requests for changes, and the final acceptance. No form, project setup, or account is required.

## Current private alpha

The working alpha supports:

- Human-started and agent-started requests.
- Pasted text and screenshots, plus imported plain-text or Markdown content.
- Separate one-time human and agent claims.
- Ordered replies, agent results, comments, acceptance, and requests for changes.
- A device-local browser list for reopening requests.
- One HTTP contract shared by the browser and MCP adapter.
- Cursor-based delta reads and bounded waits without Redis Pub/Sub.
- Application-encrypted content stored in Valkey, with encrypted screenshots in local files or a private S3-compatible bucket.

New requests encrypt user content before it reaches state or blob storage. Valkey enforces a two-hour write-idle deadline, a six-hour hard limit, and a 15-minute deadline after acceptance. Clients read the thread once, then reuse an opaque cursor for deltas or a long poll of up to 30 seconds. Public-host abuse controls haven't landed, so treat this build as local/private only.

## Run the current alpha locally

The shortest path is Docker Compose:

```bash
docker compose up --build
```

Open `http://localhost:8787`. Compose starts the Raise application and Valkey; application-encrypted screenshots use the `raise-blobs` volume.

For source development, install Node.js 24 or newer and pnpm 11, start Valkey on port 6379, then run:

```bash
pnpm install
pnpm dev
```

Open `http://localhost:5173`. The API runs on `http://localhost:8787`. Set `VALKEY_URL` when Valkey is not at `redis://127.0.0.1:6379`.

## Storage configuration

`VALKEY_URL` is the only required server variable. The runtime accepts `redis://` and `rediss://` URLs, so the same application works with the Compose Valkey service or a managed Redis-compatible service.

| Variable                    | Default                   | Use                                                                |
| --------------------------- | ------------------------- | ------------------------------------------------------------------ |
| `VALKEY_URL`                | none                      | Required Redis or Valkey connection URL.                           |
| `BLOB_STORE`                | `local`                   | `local` or `s3`.                                                   |
| `DATA_DIR`                  | repository `data` folder  | Root for encrypted local blobs; ignored by the S3 adapter.         |
| `BLOB_S3_BUCKET`            | none                      | Required when `BLOB_STORE=s3`.                                     |
| `BLOB_S3_REGION`            | `auto`                    | Use `auto` for R2 or the bucket's AWS region for S3.               |
| `BLOB_S3_ENDPOINT`          | AWS SDK default           | Set the R2, MinIO, or other S3-compatible endpoint.                |
| `BLOB_S3_FORCE_PATH_STYLE`  | AWS SDK default (`false`) | Set `true` when the selected S3-compatible service requires it.    |
| `BLOB_S3_ACCESS_KEY_ID`     | none                      | Optional explicit credentials for Compose or compatible providers. |
| `BLOB_S3_SECRET_ACCESS_KEY` | none                      | Must be set with `BLOB_S3_ACCESS_KEY_ID`.                          |
| `BLOB_S3_SESSION_TOKEN`     | none                      | Optional token for temporary explicit credentials.                 |
| `PUBLIC_BASE_URL`           | `http://localhost:<port>` | Public origin used in role links. Use an HTTPS origin when hosted. |
| `PORT`                      | `8787`                    | HTTP port.                                                         |
| `MAX_IMAGE_BYTES`           | `15728640`                | Maximum decoded source bytes for one image before Sharp runs.      |

The S3 adapter uses `BLOB_S3_ACCESS_KEY_ID` and `BLOB_S3_SECRET_ACCESS_KEY` when both are set. Otherwise it leaves credentials to the normal AWS SDK chain, including standard AWS environment variables and workload roles. This keeps Compose credentials explicit without disabling managed cloud identity.

For a hosted instance, run the existing Docker image on one container service, set `BLOB_STORE=s3`, point `VALKEY_URL` at managed Redis, and use a private R2 or S3-compatible bucket. The application then needs no persistent disk. The checked-in [R2 lifecycle policy](deploy/cloudflare/r2-lifecycle.json) makes objects under `ephemeral/v1/` deletion-eligible after 21,600 seconds; Redis ends access first, while object deletion happens asynchronously.

The current release constraint is one active application instance. Cloud Run, ECS, a VM, or another Docker host can all run that shape. Applying and reading back the bucket lifecycle policy against a real provider, plus a Docker smoke test, remain release work.

## Agent access

Build the repository, configure an MCP client to run `apps/mcp/dist/main.js`, and point `RAISE_BASE_URL` at the Raise server. An agent can create a request for a human or claim a complete role link supplied by the human, then read, reply, attach screenshots, and wait for the next turn.

See [MCP usage](docs/mcp.md) and the lower-level [HTTP API](docs/http-api.md) for setup and protocol details.

## Approved v0.1 shape

```text
browser or MCP -> one Raise application instance
                       |-- Redis/Valkey: encrypted thread state and exact TTL
                       `-- private S3-compatible/local: encrypted screenshot bytes
```

The release scope has no website widget, accounts, projects, Postgres, permanent history, queue, Pub/Sub, scheduled cleanup process, or multiple application replicas. v0.2 may add browser-to-MCP pairing for active-only discovery after the manual-link release has real usage.

- [Product requirements](docs/PRD.md)
- [Research record](docs/research.md)
- [Delivery plan](docs/PLAN.md)
- [Architecture](docs/architecture.md)
- [Architecture decisions](docs/architecture/decisions/README.md)
- [OpenAPI specification](openapi.yaml)
- [UI direction](docs/ui-direction.md)
- [Contributing](CONTRIBUTING.md)

## Checks

```bash
pnpm check
```

This runs formatting, lint, strict TypeScript checks, every build, and the test suite.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
