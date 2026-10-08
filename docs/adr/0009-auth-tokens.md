# 0009 — Auth tokens

- **Status:** accepted
- **Date:** 2026-10-08

## Context

Dashboard users need secure sessions; storing long-lived JWTs in localStorage (AutoChatix style) is vulnerable to XSS token theft.

## Options considered

1. **Short access JWT + refresh token in httpOnly cookie** — XSS can't read the refresh token; rotation possible.
2. **Long-lived JWT in localStorage** — simple, but risky.
3. **Server sessions (cookie + store)** — simple revocation, but stateful.

## Decision

**Short-lived access token** (JWT, ~15 min) sent as `Authorization: Bearer`, plus a **refresh token** in an `httpOnly`, `Secure`, `SameSite` cookie, **rotated on every refresh with reuse detection** (reuse → revoke session family). Public API uses hashed API keys (`X-API-Key`).

## Consequences

- **Positive:** strong default security.
- **Negative / trade-offs:** refresh flow + CSRF considerations on the refresh endpoint.
- **Follow-ups:** implemented in Phase 2.
