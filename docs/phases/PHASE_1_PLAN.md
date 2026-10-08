# Phase 1 — Backend Foundation (Detailed Plan)

**Project:** Cell AI Voicebot · **Phase:** 1 of 15 · **Status:** 🟢 Client ke jawab ke bina ho sakta hai
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

- [ ] `src/config/env.ts`: zod schema for every var in `.env.example` (types, defaults only for non-secrets, URL/enum checks, `NODE_ENV` enum `development|test|production`).
- [ ] Production rules: `JWT_*` / `ENCRYPTION_KEY` required + min length in production; `CORS_ORIGINS` required in production.
- [ ] `loadEnv(source = process.env)` returns a frozen typed `Env`; errors list **names only** (never values).
- [ ] Load `.env` via Node `--env-file-if-exists` in scripts (no `dotenv` dependency).
- [ ] Unit tests: valid env, missing required, bad URL, production-only rules.

**Done when:** `npm run dev` with an empty `.env` fails with a clear list of missing vars; tests pass.

### T1.2 — Logger + request ID

**Steps:**

- [ ] `src/shared/logger.ts`: pino (`LOG_LEVEL`), `pino-pretty` only in development, base fields `{ service, env, version }`.
- [ ] Redaction paths: `req.headers.authorization`, `req.headers.cookie`, `*.password`, `*.token`, `*.apiKey`, `*.secret`; helper `maskPhone('+919876543210') → '+91******3210'`.
- [ ] `requestId` middleware: accept valid incoming `X-Request-Id` (≤ 64 chars, safe chars) else generate (UUID v7 / ULID); set response header; `req.log` child logger with `requestId`.
- [ ] HTTP access log (`pino-http`): method, path, status, duration — no bodies.
- [ ] Tests: header echo, generation, phone masking, redaction.

**Done when:** every request log line carries `requestId`; no secrets in logs (test asserts).

### T1.3 — Errors

**Steps:**

- [ ] `src/shared/errors/error-codes.ts`: `ERROR_CODES` const map `{ CODE: { status, message } }` = exactly [error-codes.md](../conventions/error-codes.md) (add a test that the doc table and the file match).
- [ ] `AppError(code, message?, details?)` + subclasses (`ValidationError`, `NotFoundError`, `ConflictError`, `ForbiddenError`, `UnauthenticatedError`, `RateLimitedError`, `ProviderError`…).
- [ ] Envelope helpers `ok(data, meta?)`, `created(data)`; error middleware → `{ success:false, error:{ code, message, details?, requestId } }`; unknown errors → 500 `INTERNAL_ERROR` (logged with stack, message hidden).
- [ ] JSON parse errors → 400 `REQUEST_MALFORMED`; 404 fallback → `RESOURCE_NOT_FOUND`.
- [ ] OpenAPI: `ErrorEnvelope` already registered — reuse.

**Done when:** tests cover each error class → status/code/envelope.

### T1.4 — Express app + server bootstrap

**Steps:**

- [ ] Deps: `express@5`, `@types/express`.
- [ ] `src/app.ts` → `createApp(deps)` (pure, testable): middleware order = requestId → logger → security (T1.6) → body parsers → routes (`/api/v1` router) → 404 → error handler.
- [ ] `src/server.ts` → `startServer()`: load env → connect Mongo/Redis → create HTTP server → attach WS → listen on `PORT` (5100).
- [ ] `src/index.ts` becomes the entry calling `startServer()` (keep `getAppInfo` export).
- [ ] **Graceful shutdown** on `SIGTERM`/`SIGINT`: stop accepting connections → close WS (1001) → drain BullMQ workers → close Redis/Mongo → exit; hard timeout 15 s.
- [ ] `unhandledRejection` / `uncaughtException` → log fatal + shutdown.
- [ ] Scripts: `dev` (tsx watch + env file), `start` (node + env), keep `build`.

**Done when:** `npm run dev` serves `GET /api/v1/system/info`; Ctrl-C shuts down cleanly (log shows each step).

### T1.5 — Validation middleware

**Steps:**

- [ ] `validate({ body?, query?, params? })` with zod → 422 `VALIDATION_FAILED` + `details[{ path, message }]`.
- [ ] Unknown query params rejected (api.md §8) — `strict()` schemas.
- [ ] Typed handler helper so `req.body` etc. are inferred from schemas.
- [ ] Shared schemas: `ObjectIdSchema`, `PaginationQuerySchema` (page/limit ≤ 100), `CursorQuerySchema`, `SortSchema(allowlist)`, `PhoneE164Schema` (libphonenumber-js, default IN), `MoneyMicrosSchema`.
- [ ] Tests for each shared schema + middleware error shape.

### T1.6 — Security middlewares

**Steps:**

- [ ] `helmet` (API defaults; CSP off for JSON API, on for Swagger route).
- [ ] CORS allowlist from `CORS_ORIGINS` (credentials true for refresh cookie later); unknown origin → no CORS headers.
- [ ] Body limits: JSON 1 MB, urlencoded 100 KB; uploads handled per-route later.
- [ ] Rate limit (Redis store): global per IP (e.g. 300/min) + stricter helper for later auth routes; headers `RateLimit-*`, `Retry-After`; 429 `RATE_LIMITED`.
- [ ] `trust proxy` configurable (behind nginx in prod).
- [ ] Tests: CORS allowed/denied, oversized body → 413, rate limit → 429.

### T1.7 — MongoDB

**Steps:**

- [ ] Deps: `mongoose`.
- [ ] `src/db/mongo.ts`: connect with `MONGODB_URI`, `autoIndex` off in production, timeouts, connection events logged; `withTransaction(fn)` helper (ADR 0004).
- [ ] Index sync: dev/test `syncIndexes()` at startup; prod via `npm run db:sync-indexes`.
- [ ] Migrations runner: `src/db/migrations/NNNN-name.ts` (`up`/`down`), `migrations` collection, `npm run db:migrate` / `db:migrate:down`; first migration = no-op baseline.
- [ ] Tenant helper: base schema plugin adding `accountId` index + soft-delete query helper (data.md).
- [ ] Tests with mongodb-memory-server replica set: connect, transaction helper, migration runner idempotent.

### T1.8 — Redis + BullMQ

**Steps:**

- [ ] Deps: `ioredis`, `bullmq`.
- [ ] `src/core/queues/redis.ts`: shared connection factory (`maxRetriesPerRequest: null` for BullMQ), health ping.
- [ ] `src/core/queues/queue-factory.ts`: `createQueue(name)`, `createWorker(name, processor, opts)` with standard retry/backoff + logging; registry for graceful shutdown.
- [ ] Sample `system` queue + worker (no-op heartbeat) to prove the wiring.
- [ ] Tests: use a real Redis (local Docker) when `REDIS_URL` reachable, else skip with a clear message — **or** add `redis-memory-server`; decide in task, document in README.

### T1.9 — Health, readiness, system info

**Steps:**

- [ ] `GET /health` (liveness: process up, no deps) and `GET /ready` (Mongo ping + Redis ping; 503 + details when down).
- [ ] `GET /api/v1/system/info` — implement the route documented in Phase 0 (`AppInfoSchema`, success envelope).
- [ ] Tests (Supertest).

### T1.10 — WebSocket `/ws/events`

**Steps:**

- [ ] `ws` server attached to the HTTP server (`noServer` + upgrade handler, path check).
- [ ] `WsTicketService` (Redis): `issue({ userId, accountId, channel })` → `wst_…` (60 s, single-use), `consume(ticket)`. HTTP endpoint comes in Phase 2.
- [ ] On connect: consume ticket → bind connection to `accountId` (+ `userId`) → reject with 4001 / 4010.
- [ ] Rooms: account room + topic subscriptions (`subscribe`/`unsubscribe` messages, topic ownership check hook).
- [ ] `pushToAccount(accountId, event)` / `pushToTopic(topic, event)` with the envelope `{ id, type, ts, data }`; **multi-instance ready** via Redis pub/sub fan-out.
- [ ] Ping/pong (25 s client, 60 s server idle close), limits (connections per user/account, message size, msg rate) per websocket.md.
- [ ] Graceful close (1001) on shutdown.
- [ ] Tests: connect with valid/expired/reused ticket, push received, topic isolation between accounts.

### T1.11 — Idempotency middleware

**Steps:**

- [ ] `IdempotencyKey` model (data-model.md; TTL 24 h; unique `{ accountId, key }`).
- [ ] Middleware for marked routes: missing key → 422 (when required); in-progress → 409 `IDEMPOTENCY_IN_PROGRESS`; same body → replay stored status/body; different body → 422 `IDEMPOTENCY_KEY_REUSED`; failures (5xx) are not stored.
- [ ] Scope = `accountId` from auth context (Phase 1: injectable resolver; tests use a fake context).
- [ ] Tests for all branches incl. concurrent duplicate requests.

### T1.12 — StorageProvider

**Steps:**

- [ ] Interface `put(key, stream|buffer, { contentType })`, `get`, `delete`, `exists`, `signedUrl(key, ttl)`.
- [ ] `LocalStorage` (`STORAGE_LOCAL_PATH`, path traversal protection, signed URLs via HMAC + a dev download route) and `S3Storage` (`@aws-sdk/client-s3` + presigner).
- [ ] Key conventions: `accounts/<accountId>/<area>/<id>.<ext>`.
- [ ] Tests: local driver fully; S3 driver with mocked client.

### T1.13 — Email service

**Steps:**

- [ ] `nodemailer` SMTP transport from env; `sendEmail({ to, subject, html, text })`; templates folder (simple TS template functions).
- [ ] Dev: if SMTP not configured → log email (masked) instead of sending; test transport in tests.
- [ ] Used in Phase 2 (verification/reset) and alerts later.

### T1.14 — OpenAPI served + Swagger UI

**Steps:**

- [ ] `GET /api/v1/openapi.json` → `buildOpenApiDocument()`.
- [ ] Swagger UI at `/api/docs` only when `NODE_ENV !== 'production'` (or behind a flag).
- [ ] Every new route in Phase 1 registers its schema → `npm run gen:openapi` → commit spec → frontend `npm run gen:api`.

### T1.15 — Frontend: API errors + WS hook

**Steps:**

- [ ] `ApiError` class from the error envelope; axios response interceptor normalises errors (network, timeout, envelope) → `ApiError { code, message, details, requestId, status }`.
- [ ] React Query defaults: no retry on 4xx; global error toast (notistack) for unexpected errors.
- [ ] `useWsEvents()` hook (feature-ready): connect with a ticket provider function (stub until Phase 2), reconnect backoff + jitter, ping, `subscribe(topic)`, typed event union from websocket.md.
- [ ] System info widget on HomePage using `getSystemInfo()` (proves end-to-end API + proxy).
- [ ] Tests (RTL + mocked axios / mock WebSocket).

### T1.16 — Integration tests, docs, sign-off

**Steps:**

- [ ] Supertest suite boots `createApp` with mongodb-memory-server + Redis; covers system info, health/ready, errors, validation, CORS, rate limit, idempotency, WS.
- [ ] CI: add Redis service container to the backend `verify` job if tests need it.
- [ ] README: run locally (`infra:up` + `dev`), env table, scripts (`db:*`), architecture overview of `src/`.
- [ ] Update conventions if anything changed; CHANGELOG; `PHASE_1_TASKS.md`; Phase 1 sign-off note.

---

## 3. Deliverables checklist

- [ ] Env schema + fail-fast startup
- [ ] pino logging with request IDs + redaction
- [ ] Error codes file = doc; envelope everywhere
- [ ] Express 5 app + graceful shutdown
- [ ] Validation + shared schemas
- [ ] helmet, CORS allowlist, body limits, rate limits
- [ ] MongoDB + transactions helper + index sync + migrations
- [ ] Redis + BullMQ factory + sample worker
- [ ] `/health`, `/ready`, `GET /api/v1/system/info`
- [ ] `/ws/events` with tickets, rooms, push API, Redis fan-out
- [ ] Idempotency middleware
- [ ] StorageProvider (local + S3), email service
- [ ] `/api/v1/openapi.json` + Swagger UI (dev)
- [ ] Frontend `ApiError` + WS hook + system-info widget
- [ ] Integration tests green in CI; READMEs + CHANGELOG updated

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
