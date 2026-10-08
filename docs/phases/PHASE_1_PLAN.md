# Phase 1 — Backend Foundation (Detailed Plan)

**Project:** Cell AI Voicebot · **Phase:** 1 of 15 · **Status:** ✅ Done (2026-10-08) — [sign-off](PHASE_1_SIGNOFF.md)
**Parent plan:** [../plans/BUILD_PLAN.md](../plans/BUILD_PLAN.md) · **Previous:** [PHASE_0_SIGNOFF.md](PHASE_0_SIGNOFF.md) · **Tracker:** [PHASE_1_TASKS.md](PHASE_1_TASKS.md)

---

## 0. Is phase ka goal

Phase 1 ke end tak backend ek **production-grade skeleton** ho:

1. Express 5 app + HTTP server + `/ws/events` WebSocket — graceful start/stop.
2. Env zod se validate, pino logs with request ID, ek jaisa error envelope + error codes.
3. MongoDB (replica set) + Redis + BullMQ connected, health/readiness checks.
4. Security basics (helmet, CORS allowlist, rate limit, body limits), idempotency middleware.
5. Storage (local/S3) aur email (SMTP) abstractions.
6. OpenAPI spec served + Swagger UI (dev); `GET /api/v1/system/info` live.
7. Frontend: API error normalisation + WebSocket client hook.
8. Supertest integration tests — CI green.

Phase 2 (auth, accounts, RBAC, app shell) isi foundation pe seedha shuru ho sake.

### Phase 1 mein kya NAHI hoga

| Kaam                                              | Kaunse phase mein                                          |
| ------------------------------------------------- | ---------------------------------------------------------- |
| Signup / login / JWT / users / roles              | Phase 2                                                    |
| `POST /api/v1/ws/tickets` endpoint (auth chahiye) | Phase 2 — Phase 1 me sirf ticket service + WS verification |
| Koi business module (contacts, wallet, flows…)    | Phase 3+                                                   |
| Voice runtime / telephony                         | Phase 7 / 13                                               |
| Deployment on client server                       | Phase 12                                                   |

### Conventions to follow (Phase 0 output)

[api.md](../conventions/api.md) · [error-codes.md](../conventions/error-codes.md) · [websocket.md](../conventions/websocket.md) · [data.md](../conventions/data.md) · [code-style.md](../conventions/code-style.md) · [secrets.md](../conventions/secrets.md) · ADRs [0002–0009](../adr/README.md), [0023](../adr/0023-file-storage.md), [0024](../adr/0024-api-versioning-and-style.md), [0027](../adr/0027-module-system.md), [0029](../adr/0029-shared-api-types-via-openapi.md)

---

## 1. Tasks ka overview

| #     | Task                                                                | Size | Depends on       |
| ----- | ------------------------------------------------------------------- | ---- | ---------------- |
| T1.1  | Env config (zod schema, fail-fast)                                  | S    | –                |
| T1.2  | Logger (pino) + request ID + PII redaction                          | S    | T1.1             |
| T1.3  | Errors: `AppError` family, `error-codes.ts`, envelope helpers       | S    | –                |
| T1.4  | Express 5 app + server bootstrap + graceful shutdown                | M    | T1.1–T1.3        |
| T1.5  | Validation middleware (zod) + typed handlers                        | S    | T1.3, T1.4       |
| T1.6  | Security middlewares (helmet, CORS, rate limit, body limits)        | S    | T1.4             |
| T1.7  | MongoDB connection, index sync, migrations runner                   | M    | T1.1, T1.2       |
| T1.8  | Redis + BullMQ bootstrap (queue factory, worker lifecycle)          | M    | T1.1, T1.2       |
| T1.9  | Health / readiness + `GET /api/v1/system/info`                      | S    | T1.4, T1.7, T1.8 |
| T1.10 | WebSocket server `/ws/events` (tickets, rooms, ping/pong, push API) | M    | T1.4, T1.8       |
| T1.11 | Idempotency middleware                                              | M    | T1.3, T1.7       |
| T1.12 | StorageProvider (local + S3)                                        | S    | T1.1             |
| T1.13 | Email service (SMTP)                                                | S    | T1.1, T1.2       |
| T1.14 | OpenAPI served at `/api/v1/openapi.json` + Swagger UI (dev)         | S    | T1.9             |
| T1.15 | Frontend: API error normalisation + WS client hook                  | M    | T1.9, T1.10      |
| T1.16 | Integration tests, docs, README, Phase 1 sign-off                   | M    | all              |

**Size:** S = kuch ghante · M = ~1 din · L = 2–3 din.

---

## 2. Tasks — step by step

### T1.1 — Env config

**Kyun:** Galat/missing env pe app **start hi na ho** (secrets.md, ADR 0006).

**Steps:**

- [x] `src/config/env.ts`: zod schema for every var in `.env.example` (types, defaults only for non-secrets, URL/enum checks, `NODE_ENV` enum `development|test|production`).
- [x] Production rules: `JWT_*` / `ENCRYPTION_KEY` required + min length in production; `CORS_ORIGINS` required in production.
- [x] `loadEnv(source = process.env)` returns a frozen typed `Env`; errors list **names only** (never values).
- [x] Load `.env` via Node `--env-file-if-exists` in scripts (no `dotenv` dependency).
- [x] Unit tests: valid env, missing required, bad URL, production-only rules.

**Done when:** `npm run dev` with an empty `.env` fails with a clear list of missing vars; tests pass.

### T1.2 — Logger + request ID

**Steps:**

- [x] `src/shared/logger.ts`: pino (`LOG_LEVEL`), `pino-pretty` only in development, base fields `{ service, env, version }`.
- [x] Redaction paths: `req.headers.authorization`, `req.headers.cookie`, `*.password`, `*.token`, `*.apiKey`, `*.secret`; helper `maskPhone('+919876543210') → '+91******3210'`.
- [x] `requestId` middleware: accept valid incoming `X-Request-Id` (≤ 64 chars, safe chars) else generate (UUID v7 / ULID); set response header; `req.log` child logger with `requestId`.
- [x] HTTP access log (`pino-http`): method, path, status, duration — no bodies.
- [x] Tests: header echo, generation, phone masking, redaction.

**Done when:** every request log line carries `requestId`; no secrets in logs (test asserts).

### T1.3 — Errors

**Steps:**

- [x] `src/shared/errors/error-codes.ts`: `ERROR_CODES` const map `{ CODE: { status, message } }` = exactly [error-codes.md](../conventions/error-codes.md) (add a test that the doc table and the file match).
- [x] `AppError(code, message?, details?)` + subclasses (`ValidationError`, `NotFoundError`, `ConflictError`, `ForbiddenError`, `UnauthenticatedError`, `RateLimitedError`, `ProviderError`…).
- [x] Envelope helpers `ok(data, meta?)`, `created(data)`; error middleware → `{ success:false, error:{ code, message, details?, requestId } }`; unknown errors → 500 `INTERNAL_ERROR` (logged with stack, message hidden).
- [x] JSON parse errors → 400 `REQUEST_MALFORMED`; 404 fallback → `RESOURCE_NOT_FOUND`.
- [x] OpenAPI: `ErrorEnvelope` already registered — reuse.

**Done when:** tests cover each error class → status/code/envelope.

### T1.4 — Express app + server bootstrap

**Steps:**

- [x] Deps: `express@5`, `@types/express`.
- [x] `src/app.ts` → `createApp(deps)` (pure, testable): middleware order = requestId → logger → security (T1.6) → body parsers → routes (`/api/v1` router) → 404 → error handler.
- [x] `src/server.ts` → `startServer()`: load env → connect Mongo/Redis → create HTTP server → attach WS → listen on `PORT` (5100).
- [x] `src/index.ts` becomes the entry calling `startServer()` (keep `getAppInfo` export).
- [x] **Graceful shutdown** on `SIGTERM`/`SIGINT`: stop accepting connections → close WS (1001) → drain BullMQ workers → close Redis/Mongo → exit; hard timeout 15 s.
- [x] `unhandledRejection` / `uncaughtException` → log fatal + shutdown.
- [x] Scripts: `dev` (tsx watch + env file), `start` (node + env), keep `build`.

**Done when:** `npm run dev` serves `GET /api/v1/system/info`; Ctrl-C shuts down cleanly (log shows each step).

### T1.5 — Validation middleware

**Steps:**

- [x] `validate({ body?, query?, params? })` with zod → 422 `VALIDATION_FAILED` + `details[{ path, message }]`.
- [x] Unknown query params rejected (api.md §8) — `strict()` schemas.
- [x] Typed handler helper so `req.body` etc. are inferred from schemas.
- [x] Shared schemas: `ObjectIdSchema`, `PaginationQuerySchema` (page/limit ≤ 100), `CursorQuerySchema`, `SortSchema(allowlist)`, `PhoneE164Schema` (libphonenumber-js, default IN), `MoneyMicrosSchema`.
- [x] Tests for each shared schema + middleware error shape.

### T1.6 — Security middlewares

**Steps:**

- [x] `helmet` (API defaults; CSP off for JSON API, on for Swagger route).
- [x] CORS allowlist from `CORS_ORIGINS` (credentials true for refresh cookie later); unknown origin → no CORS headers.
- [x] Body limits: JSON 1 MB, urlencoded 100 KB; uploads handled per-route later.
- [x] Rate limit (Redis store): global per IP (e.g. 300/min) + stricter helper for later auth routes; headers `RateLimit-*`, `Retry-After`; 429 `RATE_LIMITED`.
- [x] `trust proxy` configurable (behind nginx in prod).
- [x] Tests: CORS allowed/denied, oversized body → 413, rate limit → 429.

### T1.7 — MongoDB

**Steps:**

- [x] Deps: `mongoose`.
- [x] `src/db/mongo.ts`: connect with `MONGODB_URI`, `autoIndex` off in production, timeouts, connection events logged; `withTransaction(fn)` helper (ADR 0004).
- [x] Index sync: dev/test `syncIndexes()` at startup; prod via `npm run db:sync-indexes`.
- [x] Migrations runner: `src/db/migrations/NNNN-name.ts` (`up`/`down`), `migrations` collection, `npm run db:migrate` / `db:migrate:down`; first migration = no-op baseline.
- [x] Tenant helper: base schema plugin adding `accountId` index + soft-delete query helper (data.md).
- [x] Tests with mongodb-memory-server replica set: connect, transaction helper, migration runner idempotent.

### T1.8 — Redis + BullMQ

> **Update (Batch 1):** also plug the **Redis store into `createRateLimiter()`** (`src/shared/middlewares/rate-limit.ts`, MemoryStore until then) so rate limits are shared across API instances.

**Steps:**

- [x] Deps: `ioredis`, `bullmq`.
- [x] `src/core/queues/redis.ts`: shared connection factory (`maxRetriesPerRequest: null` for BullMQ), health ping.
- [x] `src/core/queues/queue-factory.ts`: `createQueue(name)`, `createWorker(name, processor, opts)` with standard retry/backoff + logging; registry for graceful shutdown.
- [x] Sample `system` queue + worker (no-op heartbeat) to prove the wiring.
- [x] Tests: use a real Redis (local Docker) when `REDIS_URL` reachable, else skip with a clear message — **or** add `redis-memory-server`; decide in task, document in README.

### T1.9 — Health, readiness, system info

> **Update (Batch 1):** `GET /api/v1/system/info` was implemented in **T1.4** as the first route; T1.9 now covers `/health` and `/ready` only.

**Steps:**

- [x] `GET /health` (liveness: process up, no deps) and `GET /ready` (Mongo ping + Redis ping; 503 + details when down).
- [x] `GET /api/v1/system/info` — implement the route documented in Phase 0 (`AppInfoSchema`, success envelope).
- [x] Tests (Supertest).

### T1.10 — WebSocket `/ws/events`

**Steps:**

- [x] `ws` server attached to the HTTP server (`noServer` + upgrade handler, path check).
- [x] `WsTicketService` (Redis): `issue({ userId, accountId, channel })` → `wst_…` (60 s, single-use), `consume(ticket)`. HTTP endpoint comes in Phase 2.
- [x] On connect: consume ticket → bind connection to `accountId` (+ `userId`) → reject with 4001 / 4010.
- [x] Rooms: account room + topic subscriptions (`subscribe`/`unsubscribe` messages, topic ownership check hook).
- [x] `pushToAccount(accountId, event)` / `pushToTopic(topic, event)` with the envelope `{ id, type, ts, data }`; **multi-instance ready** via Redis pub/sub fan-out.
- [x] Ping/pong (25 s client, 60 s server idle close), limits (connections per user/account, message size, msg rate) per websocket.md.
- [x] Graceful close (1001) on shutdown.
- [x] Tests: connect with valid/expired/reused ticket, push received, topic isolation between accounts.

### T1.11 — Idempotency middleware

**Steps:**

- [x] `IdempotencyKey` model (data-model.md; TTL 24 h; unique `{ accountId, key }`).
- [x] Middleware for marked routes: missing key → 422 (when required); in-progress → 409 `IDEMPOTENCY_IN_PROGRESS`; same body → replay stored status/body; different body → 422 `IDEMPOTENCY_KEY_REUSED`; failures (5xx) are not stored.
- [x] Scope = `accountId` from auth context (Phase 1: injectable resolver; tests use a fake context).
- [x] Tests for all branches incl. concurrent duplicate requests.

### T1.12 — StorageProvider

**Steps:**

- [x] Interface `put(key, stream|buffer, { contentType })`, `get`, `delete`, `exists`, `signedUrl(key, ttl)`.
- [x] `LocalStorage` (`STORAGE_LOCAL_PATH`, path traversal protection, signed URLs via HMAC + a dev download route) and `S3Storage` (`@aws-sdk/client-s3` + presigner).
- [x] Key conventions: `accounts/<accountId>/<area>/<id>.<ext>`.
- [x] Tests: local driver fully; S3 driver with mocked client.

### T1.13 — Email service

**Steps:**

- [x] `nodemailer` SMTP transport from env; `sendEmail({ to, subject, html, text })`; templates folder (simple TS template functions).
- [x] Dev: if SMTP not configured → log email (masked) instead of sending; test transport in tests.
- [x] Used in Phase 2 (verification/reset) and alerts later.

### T1.14 — OpenAPI served + Swagger UI

**Steps:**

- [x] `GET /api/v1/openapi.json` → `buildOpenApiDocument()`.
- [x] Swagger UI at `/api/docs` only when `NODE_ENV !== 'production'` (or behind a flag).
- [x] Every new route in Phase 1 registers its schema → `npm run gen:openapi` → commit spec → frontend `npm run gen:api`.

### T1.15 — Frontend: API errors + WS hook

**Steps:**

- [x] `ApiError` class from the error envelope; axios response interceptor normalises errors (network, timeout, envelope) → `ApiError { code, message, details, requestId, status }`.
- [x] React Query defaults: no retry on 4xx; global error toast (notistack) for unexpected errors.
- [x] `useWsEvents()` hook (feature-ready): connect with a ticket provider function (stub until Phase 2), reconnect backoff + jitter, ping, `subscribe(topic)`, typed event union from websocket.md.
- [x] System info widget on HomePage using `getSystemInfo()` (proves end-to-end API + proxy).
- [x] Tests (RTL + mocked axios / mock WebSocket).

### T1.16 — Integration tests, docs, sign-off

**Steps:**

- [x] Supertest suite boots `createApp` with mongodb-memory-server + Redis; covers system info, health/ready, errors, validation, CORS, rate limit, idempotency, WS.
- [x] CI: add Redis service container to the backend `verify` job if tests need it.
- [x] README: run locally (`infra:up` + `dev`), env table, scripts (`db:*`), architecture overview of `src/`.
- [x] Update conventions if anything changed; CHANGELOG; `PHASE_1_TASKS.md`; Phase 1 sign-off note.

---

## 3. Deliverables checklist

- [x] Env schema + fail-fast startup
- [x] pino logging with request IDs + redaction
- [x] Error codes file = doc; envelope everywhere
- [x] Express 5 app + graceful shutdown
- [x] Validation + shared schemas
- [x] helmet, CORS allowlist, body limits, rate limits
- [x] MongoDB + transactions helper + index sync + migrations
- [x] Redis + BullMQ factory + sample worker
- [x] `/health`, `/ready`, `GET /api/v1/system/info`
- [x] `/ws/events` with tickets, rooms, push API, Redis fan-out
- [x] Idempotency middleware
- [x] StorageProvider (local + S3), email service
- [x] `/api/v1/openapi.json` + Swagger UI (dev)
- [x] Frontend `ApiError` + WS hook + system-info widget
- [x] Integration tests green in CI; READMEs + CHANGELOG updated

## 4. Risks

| Risk                                                          | Mitigation                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Express 5 + typings edge cases                                | Keep handlers thin; typed helper; pin versions                            |
| Redis needed in tests / CI                                    | Redis service container in CI; local `infra:up`; or `redis-memory-server` |
| WS fan-out across instances                                   | Redis pub/sub from day one (Phase 12 may run >1 API instance)             |
| Over-engineering the skeleton                                 | Only what Phases 2–8 need; no speculative features                        |
| npm 11 install scripts (`mongodb-memory-server`, native deps) | Review `allowScripts` on every dependency add                             |

## 5. Recommended order

| Day | Tasks               |
| --- | ------------------- |
| 1   | T1.1, T1.2, T1.3    |
| 2   | T1.4, T1.5, T1.6    |
| 3   | T1.7, T1.8, T1.9    |
| 4   | T1.10, T1.11        |
| 5   | T1.12, T1.13, T1.14 |
| 6   | T1.15, T1.16        |

_Estimate — adjust per review. Run task-wise with prompts built from [TASK_PROMPT_TEMPLATE.md](../prompts/TASK_PROMPT_TEMPLATE.md)._

---

## Changelog

- 2026-10-08: Batch 1 (T1.1–T1.6) done — system info route moved to T1.4; Redis rate-limit store moved to T1.8; `express` installed in T1.2 (types needed by middlewares); `getAppInfo` moved to `src/shared/app-info.ts` (avoids an import cycle).
- 2026-10-08: Batch 2 (T1.7–T1.12) done — T1.12 (storage) was completed in Batch 2 as planned; **Batch 3 = T1.13–T1.16**. WS server buffers client messages until the ticket is verified (prevents lost early messages); heartbeat liveness (`pong`) is tracked separately from app-level idle (4008). Tests now share **one** in-memory MongoDB replica set via Vitest `globalSetup` (one DB per test file) — parallel replica sets made transactions hang intermittently. Frontend `gen:api` for `/health` + `/ready` deferred to T1.15.
- 2026-10-08: Batch 3 (T1.13–T1.16) done — **Phase 1 complete** ([sign-off](PHASE_1_SIGNOFF.md)). Email: `EMAIL_DRIVER` (smtp | log, production requires smtp), queued sending, Mailpit for dev, ADR 0030; dedupe uses BullMQ deduplication (24 h) instead of job ids (BullMQ ids can't contain `:` and completed jobs are removed). API docs: spec always served, Swagger UI behind `API_DOCS_ENABLED`, built from `swagger-ui-dist` (not swagger-ui-express) with a strict CSP; `getAppInfo().version` now read from package.json (was undefined under `node dist`). Frontend: `ApiError`, query error policy, `RealtimeClient` + hooks (off until the Phase 2 ticket endpoint), DEV `/dev/realtime`, API status card. `startServer(options)` injectable for the full-server e2e test; coverage gates in both repos; env-docs sync test.
