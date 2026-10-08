# 0025 — Deployment style

- **Status:** deferred
- **Date:** 2026-10-08

## Context

Production runs on the client's EC2 server alongside another application that must not be disturbed. What is already installed there is unknown.

## Options considered

1. **Docker Compose** — isolated, reproducible.
2. **PM2 + system services** — simpler if Docker isn't available.

## Decision

**Deferred** to Phase 12, after the read-only server audit (T0.19).

## Consequences

- **Positive:** decision based on real server state.
- **Negative / trade-offs:** none now.
- **Follow-ups:** T0.19, Phase 12.
