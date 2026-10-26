# 0025 — Deployment style

- **Status:** accepted for staging
- **Date:** 2026-10-26

## Context

Phase 13 uses a new staging server. The owner chose one machine for the frontend and backend. The client's existing production EC2 remains outside this phase.

## Decision

Use Docker Compose for API/worker/data services and host nginx for static files, TLS and proxying. Build immutable source archives on the target CPU, run backward-compatible migrations before restart, and retain the previous image/web release for rollback. [ADR 0042](0042-staging-topology-deploy.md) records networking, secrets, backup and deploy details.

## Consequences

Staging is reproducible and isolated from development. It still has a single failure domain, requiring tested encrypted off-server backups and monitoring. Phase 17 decides production deployment after the client's server audit; staging acceptance does not authorize changes to that host.
