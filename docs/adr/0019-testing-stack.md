# 0019 — Testing stack

- **Status:** accepted
- **Date:** 2026-10-08

## Context

We need fast unit tests, API integration tests against a real Mongo (with transactions), and UI component tests.

## Options considered

1. **Vitest everywhere** + Supertest + mongodb-memory-server + React Testing Library.
2. **Jest** — slower with TS/ESM, separate config from Vite.

## Decision

Backend: **Vitest** + **Supertest** + **mongodb-memory-server** (replica set). Frontend: **Vitest** + **React Testing Library** + **jsdom**. Coverage via **@vitest/coverage-v8**. E2E: **Playwright** later (after Phase 2).

## Consequences

- **Positive:** one runner, fast, Vite-native.
- **Negative / trade-offs:** first mongodb-memory-server run downloads a MongoDB binary.
- **Follow-ups:** CI in T0.14.
