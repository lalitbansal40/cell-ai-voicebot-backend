# 0007 — Logging

- **Status:** accepted
- **Date:** 2026-10-08

## Context

We need structured logs to debug live calls and campaigns, with request correlation and without leaking PII (phone numbers, loan data).

## Options considered

1. **pino** — fast JSON logger, child loggers, redaction.
2. **winston** — flexible but slower.
3. **console** — no structure (AutoChatix approach).

## Decision

**pino** JSON logs with a request ID per request (and call ID per call), `redact` paths for PII (phones masked), `pino-pretty` only in local dev. `console.*` is discouraged by lint.

## Consequences

- **Positive:** searchable logs, low overhead, PII masking.
- **Negative / trade-offs:** JSON logs need a viewer locally (pino-pretty).
- **Follow-ups:** implemented in Phase 1.
