# 0010 — Frontend build tool

- **Status:** accepted
- **Date:** 2026-10-08

## Context

AutoChatix uses Create React App (`react-app-rewired`), which is deprecated and slow. The plan originally said React 18.

## Options considered

1. **Vite + React 19 + TypeScript** — fast dev server, maintained, current React.
2. **CRA** — deprecated.
3. **Next.js** — SSR not needed for an authenticated dashboard.

## Decision

**Vite (latest) + React 19 + TypeScript (strict)**, SPA with client-side routing. Dev server port 3100 with proxy to the API (5100).

## Consequences

- **Positive:** fast builds/HMR, modern stack.
- **Negative / trade-offs:** AutoChatix CRA-specific code needs adapting when reused.
- **Follow-ups:** none.
