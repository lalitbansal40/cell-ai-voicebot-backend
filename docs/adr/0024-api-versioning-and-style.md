# 0024 — API versioning & style

- **Status:** accepted
- **Date:** 2026-10-08

## Context

The dashboard and a public client API need a consistent, versioned REST contract.

## Options considered

1. **REST `/api/v1` + response envelope**.
2. **GraphQL** — unnecessary complexity for this product.

## Decision

REST under **`/api/v1`**. Success: `{ success: true, data, meta? }`. Error: `{ success: false, error: { code, message, details? } }`. Full rules (pagination, idempotency keys, headers) in T0.11 conventions.

## Consequences

- **Positive:** predictable API for frontend and clients.
- **Negative / trade-offs:** none significant.
- **Follow-ups:** T0.11.
