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

### Audit status (T0.19, 2026-10-08)

The read-only audit tooling is ready (`npm run server:audit`, [server-audit.md](../client/server-audit.md)) but **blocked — SSH key not available**. Initial recommendation, to confirm with the audit: **Docker Compose** (project `cell-ai-voicebot`) for API, MongoDB 8.2, Redis and Asterisk — fully isolated from the existing application; fall back to PM2 + system packages only if Docker is unavailable to us. Status stays `deferred`.

## Consequences

- **Positive:** decision based on real server state.
- **Negative / trade-offs:** none now.
- **Follow-ups:** T0.19, Phase 12.
