# Backend source layout

Module-based structure (see [ADR 0003](../docs/adr/0003-backend-code-structure.md)).

| Folder                                   | Purpose                                                                                                                                                  | Filled in    |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `index.ts`                               | Process entry: `startServer()`; re-exports `getAppInfo`                                                                                                  | Phase 1      |
| `server.ts`                              | `startServer()` — validates env, builds the app, listens on `PORT`, registers the `http` shutdown hook, installs signal handlers                         | Phase 1      |
| `app.ts`                                 | `createApp({ env, logger })` — pure Express app (no I/O); the request pipeline below                                                                     | Phase 1      |
| `routes.ts`                              | `createApiRouter()` — mounts every module router under `/api/v1`                                                                                         | Phase 1      |
| `openapi.ts`                             | Assembles the OpenAPI 3.1 document from all module schemas (`npm run gen:openapi`)                                                                       | Phase 0+     |
| `config/`                                | `env.ts` (zod env schema, fail-fast, names-only errors), `limits.ts` (body + rate limits)                                                                | Phase 1      |
| `shared/errors/`                         | `error-codes.ts` (≡ docs/conventions/error-codes.md, test-enforced), `AppError` + subclasses                                                             | Phase 1      |
| `shared/http/`                           | Envelope helpers `ok` / `created` / `noContent`                                                                                                          | Phase 1      |
| `shared/validation/`                     | Shared zod schemas (ObjectId, pagination, cursor, sort, E.164 phone, money micros, strict query) + zod → error details                                   | Phase 1      |
| `shared/logger.ts`, `shared/app-info.ts` | pino logger (redaction, pretty in dev TTY) · app metadata                                                                                                | Phase 1      |
| `core/lifecycle.ts`                      | Ordered graceful shutdown hooks (http 10, ws 20, queues 30, redis 40, mongo 50) + 15 s hard timeout + signal handlers                                    | Phase 1      |
| `shared/middlewares/`                    | `request-id`, `http-logger`, `security` (helmet), `cors`, `rate-limit`, `validate` (+ `handle()`), `not-found`, `error-handler`                          | Phase 1      |
| `shared/utils/`                          | `mask.ts` (phone/email masking for logs); more helpers later                                                                                             | Phase 1+     |
| `shared/types/`                          | Cross-module TypeScript types                                                                                                                            | Phase 1+     |
| `shared/openapi/`                        | OpenAPI registry, extended `z`, common envelope/pagination schemas (ADR 0029)                                                                            | Phase 0 / 1+ |
| `core/engine/`                           | Call flow engine (graph runtime)                                                                                                                         | Phase 6      |
| `core/voice/`                            | Call session manager, audio bridge, voice AI adapters                                                                                                    | Phase 7      |
| `core/telephony/`                        | `TelephonyProvider` interface + WebCall / SIP / NotifyNow providers                                                                                      | Phase 7, 13  |
| `core/queues/`                           | `redis.ts` (tracked connections, ping, close), `queue-factory.ts` (BullMQ queues/workers + defaults), `names.ts`, `workers/system.worker.ts` (heartbeat) | Phase 1 / 8  |
| `core/billing/`                          | Wallet core: hold / capture / release, atomic debits                                                                                                     | Phase 4      |
| `modules/auth/`                          | Signup, login, tokens, password reset                                                                                                                    | Phase 2      |
| `modules/accounts/`                      | Tenant accounts, settings                                                                                                                                | Phase 2      |
| `modules/users/`                         | Users, roles, team                                                                                                                                       | Phase 2      |
| `modules/contacts/`                      | Contacts, lists, custom fields, imports, DND                                                                                                             | Phase 3      |
| `modules/wallet/`                        | Wallet API, ledger, top-ups, invoices                                                                                                                    | Phase 4      |
| `modules/ai-agents/`                     | AI agent configs, knowledge base, functions                                                                                                              | Phase 5      |
| `modules/flows/`                         | Call flows + versions (builder API)                                                                                                                      | Phase 6      |
| `modules/campaigns/`                     | Campaigns, scheduling, results                                                                                                                           | Phase 8      |
| `modules/calls/`                         | Call records, transcripts, recordings                                                                                                                    | Phase 7, 9   |
| `modules/webhooks/`                      | Outbound webhooks + inbound provider webhooks                                                                                                            | Phase 10     |
| `modules/public-api/`                    | API-key authenticated public API                                                                                                                         | Phase 10     |
| `modules/system/`                        | `GET /api/v1/system/info` (controller + routes + schema)                                                                                                 | Phase 1      |
| `modules/health/`                        | `GET /health` (liveness) and `GET /ready` (Mongo + Redis ping, 503 when down or shutting down) at the root                                               | Phase 1      |
| `jobs/`                                  | Scheduled / cron jobs                                                                                                                                    | Phase 4+     |
| `db/`                                    | `mongo.ts` (connect, ping, index sync), `transaction.ts`, `plugins/` (base, tenant, soft delete), `migrate.ts` + `migrations/` registry                  | Phase 1      |

Outside `src/`: `tests/` (integration tests), `scripts/` (one-off scripts), `poc/` (proofs of concept, not built).

## Module file convention

Each module in `modules/<feature>/` uses these files (as needed):

- `<feature>.routes.ts` — Express router, wires middlewares + controller
- `<feature>.controller.ts` — HTTP layer: parse request, call service, shape response
- `<feature>.service.ts` — business logic (the only place for it)
- `<feature>.model.ts` — Mongoose model
- `<feature>.schema.ts` — zod schemas (request validation, OpenAPI)
- `<feature>.types.ts` — module types
- `<feature>.test.ts` — unit tests next to the code

**Layering rule:** routes → controller → service → model. No business logic in routes or controllers.

## Startup & shutdown (`startServer`)

Startup: validate env → logger → connect **MongoDB** (fail fast) → sync indexes (non-production) → **Redis** app connection + ping (fail fast) → build app (Redis rate-limit store) → listen → start workers (`WORKERS_ENABLED`).

Shutdown hooks (ascending order, 15 s hard limit): **http 10** → ws 20 (T1.10) → **queues 30** → **redis 40** → **mongo 50**.

## Request pipeline (`createApp`)

Order matters — every request goes through:

1. `requestId` — accepts a safe `X-Request-Id` or generates a UUID; echoed in the response.
2. `httpLogger` — pino-http access log (method, path without query, status, time); `req.log` child logger with `requestId`. Health paths are not logged.
3. `securityHeaders` — helmet (no CSP for the JSON API, HSTS only in production).
4. `corsMiddleware` — exact-match `CORS_ORIGINS` allowlist; unknown origins get no CORS headers.
5. `globalRateLimiter` — 300 req/min per IP (`trust proxy` aware), `RateLimit-*` headers, 429 envelope; Redis store in the server (MemoryStore in unit tests).
6. Body parsers — JSON 1 MB, urlencoded 100 KB.
7. `/health`, `/ready` (root — load balancers), then `/api/v1` routers (`routes.ts`).
8. `notFound` → 404 `RESOURCE_NOT_FOUND`.
9. `errorHandler` → every error becomes the error envelope; 5xx messages are never exposed.

## Writing a route

```ts
import { created } from '../../shared/http/envelope';
import { handle } from '../../shared/middlewares/validate';
import { z } from '../../shared/openapi/zod';
import { PhoneE164Schema } from '../../shared/validation/schemas';

const CreateContactBody = z.object({ name: z.string().min(1), phone: PhoneE164Schema });

router.post(
  '/',
  ...handle({ body: CreateContactBody }, async ({ body, res }) => {
    created(res, await contactService.create(body)); // body is typed + normalised (phone → E.164)
  }),
);
```

- Validation failures → 422 `VALIDATION_FAILED` with `body.x` / `query.x` / `params.x` paths.
- Parsed input lives on `req.valid` — never reassign `req.query` (read-only in Express 5).
- Throw `AppError` subclasses (`NotFoundError`, `ConflictError`, …) — never strings.
- Register the route's schemas on the OpenAPI registry and run `npm run gen:openapi`.
