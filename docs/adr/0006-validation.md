# 0006 — Validation

- **Status:** accepted
- **Date:** 2026-10-08

## Context

Request bodies, query params, env vars and shared API types all need validation and a single source of truth.

## Options considered

1. **zod** — TS-first, infers types, can generate OpenAPI.
2. **joi / yup** — mature, but weaker TS inference.
3. **class-validator** — decorator-based, fits NestJS more than Express.

## Decision

**zod** (latest) for request validation, env validation (Phase 1) and shared schemas that generate OpenAPI → frontend types (T0.12). Frontend forms use zod via react-hook-form resolvers.

## Consequences

- **Positive:** one schema = runtime check + TS type + API docs.
- **Negative / trade-offs:** none significant.
- **Follow-ups:** env schema in Phase 1; OpenAPI generation and frontend types — [ADR 0029](0029-shared-api-types-via-openapi.md).
