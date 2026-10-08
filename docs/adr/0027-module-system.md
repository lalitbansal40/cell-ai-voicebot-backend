# 0027 — Module system

- **Status:** accepted
- **Date:** 2026-10-08

## Context

Backend libraries (Mongoose, BullMQ) work smoothly with CommonJS; TypeScript recommends `NodeNext` resolution for Node projects. Vite is ESM-native.

## Options considered

1. **Backend CommonJS output with `module/moduleResolution: NodeNext`** — Node-accurate resolution, no `.js` extensions needed in CJS mode.
2. **Backend native ESM** — requires `.js` extensions in imports and ESM-compatible tooling everywhere.

## Decision

Backend: `"type": "commonjs"`, tsconfig `module` + `moduleResolution` = **`NodeNext`**, no path aliases, `tsx` for dev, `tsc` for build. Frontend: ESM (Vite) with `@/` alias.

## Consequences

- **Positive:** simple imports, broad library compatibility.
- **Negative / trade-offs:** ESM-only packages need dynamic `import()` in the backend.
- **Follow-ups:** none.
