# 0014 — Flow builder library

- **Status:** accepted
- **Date:** 2026-10-08

## Context

The call flow builder needs a node/edge canvas with drag-drop, custom nodes and handles. AutoChatix uses `reactflow` v11.

## Options considered

1. **@xyflow/react (React Flow v12+)** — maintained successor, React 19 support.
2. **reactflow v11** — legacy package name.
3. **Custom canvas** — too much work.

## Decision

**@xyflow/react** (latest).

## Consequences

- **Positive:** maintained, familiar API.
- **Negative / trade-offs:** minor API differences from AutoChatix's v11 code.
- **Follow-ups:** Phase 6 — done: `@xyflow/react` 12 with `@dagrejs/dagre` for auto-layout; the builder route is lazy-loaded (own chunk). Engine side: [ADR 0034](0034-call-flow-engine.md).
