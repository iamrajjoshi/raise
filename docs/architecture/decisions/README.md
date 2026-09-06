# Architecture decisions

This directory records choices that would cost real time or risk to reverse. Cheap implementation details belong in `docs/PLAN.md` or normal change history.

## Lifecycle

Use `proposed` while a decision still needs owner review and `accepted` once the owner agrees to its cost and constraints. Don't rewrite an accepted record to reverse its meaning; add a new ADR, mark the old one `superseded`, and link both records.

Name new records `<NNNN>-<slug>.md` with a zero-padded sequence. Keep each ADR focused on one decision and link its product requirements and validation instead of copying entire plans into it.

## Index

| ADR                                                       | Status   | Decision                                                                | Supersedes                |
| --------------------------------------------------------- | -------- | ----------------------------------------------------------------------- | ------------------------- |
| [0001](0001-use-ephemeral-redis-and-object-storage.md)    | accepted | Keep Raise ephemeral with Redis/Valkey state and object blobs           | Durable SQL roadmap       |
| [0002](0002-wrap-content-keys-with-capabilities.md)       | accepted | Encrypt each request with a content key wrapped for its capabilities    | Provider-only encryption  |
| [0003](0003-use-logical-expiry-and-storage-lifecycles.md) | accepted | End access through Redis TTL and remove blobs through storage lifecycle | Scheduled cleanup service |
