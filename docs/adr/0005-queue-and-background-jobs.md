# 0005 — Queue & background jobs

- **Status:** accepted
- **Date:** 2026-10-08

## Context

Bulk campaigns need concurrency limits, retries with backoff, scheduling, rate limits and restart safety. AutoChatix used `node-cron` + DB polling, which struggled under load.

## Options considered

1. **Redis + BullMQ** — mature queue with delays, retries, concurrency, repeatable jobs.
2. **node-cron + Mongo polling** — no extra infra, but weak concurrency control.
3. **Agenda (Mongo-based)** — no Redis, but lower throughput.

## Decision

**Redis 7.4 + BullMQ** for call dispatch, retries, scheduled/recurring jobs. Redis also holds short-lived call session state. Locally: `redis:7.4-alpine` with AOF on port 6380.

## Consequences

- **Positive:** reliable, observable job processing.
- **Negative / trade-offs:** one more service to run and monitor.
- **Follow-ups:** queue design in Phase 8.
