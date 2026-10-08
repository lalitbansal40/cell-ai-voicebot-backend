# 0012 — Frontend state

- **Status:** accepted
- **Date:** 2026-10-08

## Context

Most dashboard state is server data (contacts, calls, campaigns) that must stay fresh; only a little is pure UI state.

## Options considered

1. **React Query + Zustand** — server cache handled well; tiny store for UI state.
2. **Redux Toolkit** — powerful but heavy for this need.
3. **Context only** — re-render issues at scale.

## Decision

**@tanstack/react-query** for all server state; **Zustand** (or plain Context) only when real client-only shared state appears. No Redux.

## Consequences

- **Positive:** less boilerplate, good caching.
- **Negative / trade-offs:** none significant.
- **Follow-ups:** query key conventions in Phase 2.
