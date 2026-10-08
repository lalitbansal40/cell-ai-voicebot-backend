# 0004 — Database

- **Status:** accepted
- **Date:** 2026-10-08

## Context

The data is document-shaped (contacts with flexible variables, flows as graphs, call transcripts). Wallet operations (hold → capture → release + ledger rows) need multi-document atomicity. AutoChatix already uses MongoDB.

## Options considered

1. **MongoDB 8 + Mongoose (replica set)** — flexible schema, team familiarity, transactions on replica sets.
2. **PostgreSQL** — strong transactions/relations, but a different stack from AutoChatix and less natural for flexible variables.

## Decision

**MongoDB 8.0 + Mongoose**, always run as a **replica set** (single-node `rs0` locally via Docker on port 27018) so multi-document transactions work. Production hosting decided in Phase 12 (client DB type still unknown).

## Consequences

- **Positive:** flexible schemas; transactions available for billing.
- **Negative / trade-offs:** replica-set setup is slightly more complex locally.
- **Follow-ups:** T0.8 includes a transaction smoke test; Phase 12 decides prod DB location.
