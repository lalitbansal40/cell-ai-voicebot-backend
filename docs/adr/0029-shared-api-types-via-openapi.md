# 0029 — Shared API types via OpenAPI

- **Status:** accepted
- **Date:** 2026-10-08

## Context

Backend and frontend are separate repos ([ADR 0001](0001-repo-structure.md)). The frontend needs exact request/response types for every endpoint, and they must not drift from the backend. Backend validation already uses zod ([ADR 0006](0006-validation.md)).

## Options considered

1. **zod schemas → OpenAPI → generated frontend types** — one source of truth, also gives API docs (Swagger) and a contract the public-API clients can use.
2. **Shared npm package with types** — a third repo/package to version and publish.
3. **Copy types by hand** — drifts quickly; bugs only found at runtime.

## Decision

1. Backend schemas are written with **zod v4** and registered with **`@asteasolutions/zod-to-openapi`** (v9 — supports zod v4). `import { z } from 'src/shared/openapi/zod'` (extended with `.openapi()`).
2. `src/openapi.ts` builds an **OpenAPI 3.1** document; `npm run gen:openapi` writes **`openapi/openapi.json`**, committed and Prettier-formatted (deterministic). `npm run openapi:check` (CI) fails when the committed file is stale.
3. The frontend runs **`openapi-typescript`** (`npm run gen:api`) against the backend spec (default `../cell-ai-voicebot-backend/openapi/openapi.json`, overridable with `OPENAPI_SPEC`) and **commits** `src/services/api/schema.gen.ts`, so frontend CI does not need the backend repo.
4. `openapi-typescript` 7.x declares a peer dependency on `typescript ^5`, while the project uses TypeScript 6 ([ADR 0002](0002-runtime-and-language.md)). The frontend `package.json` uses an npm **`overrides`** entry (`"openapi-typescript": { "typescript": "$typescript" }`) so it runs on the project's TypeScript instead of forcing installs. The generator was verified to produce correct output on TypeScript 6; revisit when `openapi-typescript` declares TS 6 support.

## Consequences

- **Positive:** one source of truth; types, docs and validation cannot drift; public API gets a real spec.
- **Negative / trade-offs:** two-step workflow (backend `gen:openapi`, then frontend `gen:api`); generated files in git; the `overrides` workaround must be re-checked on upgrades.
- **Follow-ups:** serve `/api/v1/openapi.json` + Swagger UI in dev (Phase 1); add a frontend CI job that diffs `schema.gen.ts` against the published spec once the backend is deployed.
