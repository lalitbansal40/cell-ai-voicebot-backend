# 0023 — File storage

- **Status:** accepted
- **Date:** 2026-10-08

## Context

Call recordings, uploaded audio prompts, knowledge-base files and imports need storage that works locally and in production.

## Options considered

1. **`StorageProvider` interface (local disk / S3)**.
2. **S3 only** — needs cloud credentials for local dev.

## Decision

A **`StorageProvider`** interface with **local disk** (dev, `STORAGE_LOCAL_PATH`) and **S3** (prod) drivers, selected by `STORAGE_DRIVER`. Recordings served via signed URLs.

### Implementation (Phase 1, T1.12)

- `src/core/storage/`: `StorageProvider` interface, `LocalStorage`, `S3Storage` (`@aws-sdk/lib-storage` `Upload` for Buffers and streams, presigned GET URLs), `createStorage(env)`.
- Keys follow `accounts/<accountId>/<area>/<id>.<ext>`; `assertSafeKey` rejects traversal, absolute paths and odd characters.
- Local signed URLs: `/files/<key>?exp=<unix>&sig=<hmac>` — HMAC-SHA256 with a key derived from `ENCRYPTION_KEY` (development fallback key outside production), timing-safe verification, default lifetime 15 min. The `/files/*` route is mounted only for the local driver; S3 serves presigned URLs directly.
- Provider failures → `PROVIDER_ERROR` (502); missing objects → `RESOURCE_NOT_FOUND`.

## Consequences

- **Positive:** easy local dev, cloud-ready.
- **Negative / trade-offs:** two drivers to maintain.
- **Follow-ups:** Phase 1 interface, Phase 7/9 usage.
