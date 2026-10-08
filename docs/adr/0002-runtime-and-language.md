# 0002 — Runtime & language

- **Status:** accepted
- **Date:** 2026-10-08

## Context

The original plan said Node 20, but Node 20 reached end-of-life in April 2026. The dev machine already runs Node v24.19.0. We want a supported LTS for the life of the project and strict typing for a billing-heavy codebase.

## Options considered

1. **Node 24 LTS + TypeScript strict** — supported LTS (maintenance until 2028), modern APIs.
2. **Node 22 LTS** — also supported but shorter remaining life.
3. **Node 20** — EOL, no security fixes.

## Decision

**Node 24 LTS** with **TypeScript in strict mode** (plus `noUncheckedIndexedAccess`, `noImplicitOverride`, `noUnusedLocals`, etc.). `.nvmrc` = `24`, `engines.node` = `>=24 <25`, `engine-strict=true`. Backend HTTP framework: Express 5 (added in Phase 1).

## Consequences

- **Positive:** long support window; strict types catch money/tenant bugs early.
- **Negative / trade-offs:** strict flags mean more explicit code.
- **Follow-ups:** CI uses Node 24 (T0.14).
