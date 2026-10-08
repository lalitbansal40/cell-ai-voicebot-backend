# 0015 — Naming conventions

- **Status:** accepted
- **Date:** 2026-10-08

## Context

AutoChatix mixes snake_case (DB/API) and camelCase (code), causing mapping bugs.

## Options considered

1. **camelCase everywhere** (code, API JSON, Mongo fields).
2. **snake_case in API/DB, camelCase in code** — needs mapping layers.

## Decision

**camelCase** for code, API JSON and Mongo fields; Mongo collections **plural**; file names **kebab-case**; React component files **PascalCase**; env vars **UPPER_SNAKE_CASE**; error codes `DOMAIN_REASON`; WS events `domain.action`.

## Consequences

- **Positive:** no mapping layer.
- **Negative / trade-offs:** differs from AutoChatix data when integrating.
- **Follow-ups:** details in conventions docs (T0.11).
