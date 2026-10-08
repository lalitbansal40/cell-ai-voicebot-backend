# 0028 — Local dev ports

- **Status:** accepted
- **Date:** 2026-10-08

## Context

AutoChatix runs locally on 5005 (API) / 3000 (web); a local MongoDB/Redis may already use 27017/6379. Running both projects at once must not clash.

## Options considered

1. **Dedicated ports**.
2. **Default ports** — clashes.

## Decision

API **5100**, web **3100** (preview 3101), MongoDB **27018**, Redis **6380** — all bound to `127.0.0.1` locally.

## Consequences

- **Positive:** both projects run side by side.
- **Negative / trade-offs:** non-default ports to remember (documented in READMEs).
- **Follow-ups:** none.
