# Code Style

Lint and Prettier enforce formatting and many rules automatically; this document covers what tools cannot.

Related: [ADR 0003 — Backend structure](../adr/0003-backend-code-structure.md) · [src/README.md](../../src/README.md) · [api.md](api.md) · [data.md](data.md) · [Definition of Done](definition-of-done.md)

---

## 1. Backend files & modules

- File names: **kebab-case** with a role suffix — `contact-import.service.ts`, `campaigns.routes.ts`, `call.model.ts`.
- Feature code lives in `src/modules/<feature>/`; shared runtime in `src/core/`; generic helpers in `src/shared/` ([src/README.md](../../src/README.md)).
- **Layering:** routes → controller → service → model.
  - routes: wiring only (middlewares + controller).
  - controller: parse/validate input, call the service, shape the response envelope.
  - service: **all** business logic; no `req`/`res` here.
  - model: schema, indexes, small instance helpers.
- **Named exports only.** Default exports only where a tool requires them (config files).

## 2. Frontend files

- Components: **PascalCase** files, one component per file — `ContactTable.tsx`.
- Hooks: `useSomething.ts`. Other files: kebab-case (`format-money.ts`).
- Feature folders `src/features/<feature>/` hold that feature's components, hooks and API calls.
- Pages are thin route-level compositions; lazy-loaded from Phase 2.
- Named exports only (except where React lazy-loading needs a default — wrap instead).

### React Query keys — factory per feature

```ts
export const contactKeys = {
  all: ['contacts'] as const,
  lists: () => [...contactKeys.all, 'list'] as const,
  list: (params: ContactListParams) => [...contactKeys.lists(), params] as const,
  detail: (id: string) => [...contactKeys.all, 'detail', id] as const,
};
```

## 3. Errors (backend)

- Throw `AppError` subclasses (`new NotFoundError('RESOURCE_NOT_FOUND', 'Contact not found')`) carrying an [error code](error-codes.md), HTTP status, user-safe message and optional details.
- **Never** throw strings or plain objects.
- Express 5 forwards rejected async handlers to the error middleware — no try/catch just to call `next(err)`.
- Unknown errors become `500 INTERNAL_ERROR`; the real error is logged with the `requestId`.

```ts
// ✅
if (!contact) throw new NotFoundError('RESOURCE_NOT_FOUND', 'Contact not found');
// ❌
if (!contact) throw 'not found';
```

## 4. Logging

- Use the pino logger (Phase 1) — `console.*` is lint-flagged.
- Use child loggers with context: `requestId`, `accountId`, `callId`, `campaignId`.
- Levels: `debug` (local only), `info` (lifecycle: call started/ended, campaign started), `warn` (recoverable problem), `error` (failed operation).
- **Never log** secrets, tokens, full phone numbers (mask), transcripts, contact variables or request bodies containing PII.

## 5. Async

- No floating promises (lint enforces).
- Intentional fire-and-forget: `void doThing().catch((err) => logger.warn({ err }, 'why it is safe to ignore'));` plus a comment explaining why.
- No external API calls inside DB transactions.

## 6. Validation & types

- Every route input (body, query, params) is validated with **zod**; types come from `z.infer<typeof Schema>` — no duplicate hand-written interfaces.
- API response types for the frontend come from OpenAPI generation ([ADR 0029](../adr/0029-shared-api-types-via-openapi.md)).
- `any` is a lint warning — use `unknown` + narrowing.

## 7. Comments

- Explain **why**, not what.
- TODO format: `// TODO(P<phase>): what and why` — e.g. `// TODO(P2): attach access token`.
- No commented-out code in commits.

## 8. Tests

- Unit tests next to code: `*.test.ts` / `*.test.tsx`; integration tests in `tests/`.
- Test names describe behaviour: `it('rejects a phone number without country code')`.
- Every bug fix ships with a regression test.
- Money, wallet, tenant scoping and the flow engine always get tests.

## 9. Imports

- Order is enforced by lint (builtin → external → internal → parent → sibling).
- Frontend uses the `@/` alias; backend uses relative imports (no aliases — [ADR 0027](../adr/0027-module-system.md)).
- Circular imports are a lint error — extract shared code instead.

## 10. Git

- Conventional Commits + task tag: `feat(contacts): add csv import [P3-T3.2]`.
- Small, focused commits and PRs; fill the PR template.
- Never commit `.env`, keys, generated build output or PoC output.
