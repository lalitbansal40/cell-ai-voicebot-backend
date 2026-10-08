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

## Consequences

- **Positive:** easy local dev, cloud-ready.
- **Negative / trade-offs:** two drivers to maintain.
- **Follow-ups:** Phase 1 interface, Phase 7/9 usage.
