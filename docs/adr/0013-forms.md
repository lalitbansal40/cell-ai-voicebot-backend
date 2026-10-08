# 0013 — Forms

- **Status:** accepted
- **Date:** 2026-10-08

## Context

The app has many forms (AI agent config, flow node editors, campaign wizard) that need validation consistent with the API.

## Options considered

1. **react-hook-form + zod resolver** — performant, schema shared with API.
2. **Formik + yup** — AutoChatix style, slower and duplicates validation.

## Decision

**react-hook-form** with **@hookform/resolvers/zod**.

## Consequences

- **Positive:** same zod schemas as backend (via OpenAPI/types).
- **Negative / trade-offs:** none significant.
- **Follow-ups:** none.
