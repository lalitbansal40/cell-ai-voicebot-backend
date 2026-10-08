# 0026 — Package manager

- **Status:** accepted
- **Date:** 2026-10-08

## Context

We need reproducible installs locally and in CI.

## Options considered

1. **npm** — ships with Node, used in AutoChatix.
2. **pnpm** — faster, stricter, extra tool.
3. **yarn** — no clear benefit here.

## Decision

**npm** with committed **`package-lock.json`**, `npm ci` in CI, and **`engine-strict=true`** in `.npmrc` so the wrong Node version fails fast.

## Consequences

- **Positive:** zero extra tooling.
- **Negative / trade-offs:** slower installs than pnpm.
- **Follow-ups:** none.
