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
- **Follow-ups:** ~~serve `/api/v1/openapi.json` + Swagger UI in dev (Phase 1)~~ done in T1.14 (see below); add a frontend CI job that diffs `schema.gen.ts` against the published spec once the backend is deployed.

## Update (Phase 1 · T1.14) — spec served + Swagger UI

- `GET /api/v1/openapi.json` serves the document built at runtime (`buildOpenApiDocument({ serverUrl: APP_URL })`), **always on** (the Phase 10 public API needs it; it holds no secrets). Raw OpenAPI JSON (not in the success envelope), `Cache-Control: no-cache` + ETag. The committed file keeps the local server URL; `info.version` comes from `package.json` via `getAppInfo()`.
- Swagger UI at **`/api/docs`**, enabled by `API_DOCS_ENABLED` (default: on outside production, off in production). Built from **`swagger-ui-dist`** with our own HTML + `init.js` and a strict route-level CSP (`script-src 'self'`, no inline scripts). The stock `index.html` / `swagger-initializer.js` (Petstore demo) are never served.
- **Why not `swagger-ui-express`:** last release 2024-05 and it injects an inline init script, which would need `'unsafe-inline'` in `script-src`.
- `swagger-ui-dist` depends on `@scarf/scarf`, whose postinstall sends install analytics — denied in `allowScripts` (`"@scarf/scarf": false`).
