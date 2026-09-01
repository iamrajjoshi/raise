# API documentation

Raise v0.1 uses a small JSON protocol shared by the web app and coding agents.

The endpoint guide and command examples are in [HTTP protocol](../http-api.md). The machine-readable contract is in [openapi.yaml](../../openapi.yaml). Runtime request and response schemas live in `packages/protocol/src/index.ts` and are validated with Zod on every write.

The protocol package is authoritative if the prose or OpenAPI document differs from the runtime.
