# 0004 — Database

- **Status:** accepted
- **Date:** 2026-10-08

## Context

The data is document-shaped (contacts with flexible variables, flows as graphs, call transcripts). Wallet operations (hold → capture → release + ledger rows) need multi-document atomicity. AutoChatix already uses MongoDB.

## Options considered

1. **MongoDB 8.x + Mongoose (replica set)** — flexible schema, team familiarity, transactions on replica sets.
2. **PostgreSQL** — strong transactions/relations, but a different stack from AutoChatix and less natural for flexible variables.

## Decision

**MongoDB 8.2 + Mongoose**, always run as a **replica set** (single-node `rs0` locally via Docker on port 27018) so multi-document transactions work. Production hosting decided in Phase 12 (client DB type still unknown).

**Why 8.2 and not 8.0:** MongoDB 8.0.x refuses to start on Linux kernels ≥ 6.19 (TCMalloc / rseq incompatibility, [SERVER-121912](https://jira.mongodb.org/browse/SERVER-121912)). The Docker Desktop VM on the dev machine runs kernel 7.0 and `mongo:8.0` (8.0.32) exits on startup; `mongo:8.2` (8.2.12) starts fine. Newer cloud/Ubuntu kernels will hit the same problem, so 8.2 is used everywhere (Docker image `mongo:8.2`, tests `8.2.12`).

## Consequences

- **Positive:** flexible schemas; transactions available for billing.
- **Negative / trade-offs:** replica-set setup is slightly more complex locally.
- **Follow-ups:** production MongoDB must also be ≥ 8.2 (or a kernel < 6.19); T0.8 includes a transaction smoke test; Phase 12 decides prod DB location.
