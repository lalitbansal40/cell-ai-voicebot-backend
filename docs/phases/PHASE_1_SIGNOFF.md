# Phase 1 — Sign-off

**Date:** 2026-10-08 · **Branch:** `feature/phase-1-foundation` (both repos, not merged) · **Plan:** [PHASE_1_PLAN.md](PHASE_1_PLAN.md) · **Tracker:** [PHASE_1_TASKS.md](PHASE_1_TASKS.md)

**Verdict:** ✅ Phase 1 (Backend Foundation) complete — all 16 tasks done, no task blocked on client inputs. **Phase 2 can start.** Merging `feature/phase-1-foundation` → `dev` (both repos) is a project-lead decision after review.

Verification: see §6 (filled at the `[P1-B3-DONE]` checkpoint).

## 1. Tasks — "Done when" check

| Task                            | Status | Evidence (commit; fe = frontend repo)     | Notes                                                                                          |
| ------------------------------- | ------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| T1.1 Env config                 | ✅     | `9259095`                                 | zod schema, names-only errors, production rules                                                |
| T1.2 Logger + request ID        | ✅     | `173834b`                                 | pino + pino-http, redaction, phone/email masking                                               |
| T1.3 Errors                     | ✅     | `2196a35`, `00fdfc4`                      | `ERROR_CODES` test-synced with error-codes.md                                                  |
| T1.4 Express app + server       | ✅     | `56eafaa`                                 | `createApp`, ordered graceful shutdown, `GET /api/v1/system/info`                              |
| T1.5 Validation                 | ✅     | `160fe8a`                                 | `validate` / `handle`, shared schemas                                                          |
| T1.6 Security                   | ✅     | `395a4af`                                 | helmet, CORS allowlist, body limits, rate limits                                               |
| T1.7 MongoDB                    | ✅     | `6d221b8`                                 | mongoose 9, transactions, plugins, migrations + lock                                           |
| T1.8 Redis + BullMQ             | ✅     | `ea3664e`                                 | separate connections, queue factory, heartbeat, Redis rate-limit store, CI Redis               |
| T1.9 Health / readiness         | ✅     | `e8bb23e`                                 | `/health`, `/ready` (503 when down / shutting down)                                            |
| T1.10 WebSocket `/ws/events`    | ✅     | `ee9d8c1`                                 | single-use tickets, close codes, limits, Redis fan-out                                         |
| T1.11 Idempotency               | ✅     | `575067e`                                 | model + middleware (not mounted on routes until Phase 4/8)                                     |
| T1.12 StorageProvider           | ✅     | `8ea7d94`, `a8f1c7b`                      | local (signed URLs) + S3; shared test replica set                                              |
| T1.13 Email                     | ✅     | `c783961`                                 | smtp / log drivers, queued sending, Mailpit, ADR 0030                                          |
| T1.14 OpenAPI served + Swagger  | ✅     | `bddd764`                                 | `/api/v1/openapi.json` always on; `/api/docs` behind `API_DOCS_ENABLED`                        |
| T1.15 Frontend errors + WS hook | ✅     | `41454d5`, `9d7ac02` (fe), `c9c5313` (fe) | `ApiError`, query error policy, `RealtimeClient` + hooks, DEV `/dev/realtime`, API status card |
| T1.16 Integration tests + docs  | ✅     | `6938730`, `60dbcc9`, `94f9361` (fe)      | full-server e2e, gap tests, env-docs sync test, coverage gates, docs pass, this document       |

Batch checkpoints: `2b062b3` `[P1-B1-DONE]`, `bd295e2` `[P1-B2-DONE]`, `[P1-B3-DONE]` (the commit that adds this document's §6). Run prompts: [Batch 1](../prompts/PHASE_1_BATCH_1_PROMPT.md) · [Batch 2](../prompts/PHASE_1_BATCH_2_PROMPT.md) · [Batch 3](../prompts/PHASE_1_BATCH_3_PROMPT.md).

## 2. Deliverables checklist (PHASE_1_PLAN §3)

| Deliverable                                                | Status                                              |
| ---------------------------------------------------------- | --------------------------------------------------- |
| Env schema + fail-fast startup                             | ✅                                                  |
| pino logging with request IDs + redaction                  | ✅                                                  |
| Error codes file = doc; envelope everywhere                | ✅                                                  |
| Express 5 app + graceful shutdown                          | ✅                                                  |
| Validation + shared schemas                                | ✅                                                  |
| helmet, CORS allowlist, body limits, rate limits           | ✅                                                  |
| MongoDB + transactions helper + index sync + migrations    | ✅                                                  |
| Redis + BullMQ factory + sample worker                     | ✅                                                  |
| `/health`, `/ready`, `GET /api/v1/system/info`             | ✅                                                  |
| `/ws/events` with tickets, rooms, push API, Redis fan-out  | ✅                                                  |
| Idempotency middleware                                     | ✅                                                  |
| StorageProvider (local + S3), email service                | ✅                                                  |
| `/api/v1/openapi.json` + Swagger UI (dev)                  | ✅                                                  |
| Frontend `ApiError` + WS hook + system-info widget         | ✅                                                  |
| Integration tests green in CI; READMEs + CHANGELOG updated | ✅ locally — CI runs on GitHub after the first push |

## 3. Requirement → test mapping (gap audit)

| Requirement                                                                                                                                     | Test file(s)                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Env validation, production rules, email / docs flags                                                                                            | `src/config/env.test.ts`, `tests/config/env-docs.test.ts` (docs sync)                              |
| Logging, request id, redaction, masking                                                                                                         | `src/shared/logger.test.ts`, `tests/http/request-logging.test.ts`, `src/shared/utils/mask.test.ts` |
| Error envelope, 404 / 500 / malformed JSON / 413                                                                                                | `tests/http/errors.test.ts`, `tests/http/system.test.ts`, `src/shared/errors/*.test.ts`            |
| Validation 422 details, strict query, params                                                                                                    | `tests/http/validation.test.ts`, `src/shared/validation/schemas.test.ts`                           |
| CORS (allowed / unknown / preflight / no Origin / exposed headers)                                                                              | `tests/http/security.test.ts`                                                                      |
| Rate limit 429 + headers + trust proxy + health exempt; Redis store                                                                             | `tests/http/security.test.ts`, `tests/http/rate-limit-redis.test.ts`                               |
| System info, health, ready (503 down / hanging / shutting down)                                                                                 | `tests/http/system.test.ts`, `tests/http/health.test.ts`, `tests/e2e/server.e2e.test.ts`           |
| Mongo connect / ping / transactions / plugins / migrations                                                                                      | `src/db/*.test.ts`, `src/db/plugins/plugins.test.ts`, `tests/infra/mongo-replset.test.ts`          |
| Redis connections, queues, retries, graceful close, heartbeat                                                                                   | `tests/queues/*.test.ts`                                                                           |
| WS tickets + close codes 4001 / 4003 / 4008 / 4009 (user + account) / 4010 / 1009 / 1001, topics (incl. max topics), fan-out across 2 instances | `tests/realtime/ws.test.ts`, `src/core/realtime/topics.test.ts`, e2e                               |
| Idempotency replay / 409 / 422 / 5xx not stored / scope / indexes                                                                               | `tests/http/idempotency.test.ts`                                                                   |
| Storage keys, signing, local, `/files/*`, S3 (mocked)                                                                                           | `tests/storage/storage.test.ts`                                                                    |
| Email templates, log / smtp providers, permanent vs retryable, queue, dedupe                                                                    | `tests/email/*.test.ts`, e2e                                                                       |
| OpenAPI served, Swagger UI + CSP, flags                                                                                                         | `tests/http/docs.test.ts`, `src/openapi.test.ts`                                                   |
| Full server start → requests → WS → email → ordered shutdown                                                                                    | `tests/e2e/server.e2e.test.ts`                                                                     |
| Frontend `ApiError`, interceptor, retry / toast policy                                                                                          | fe `src/services/api/*.test.ts`, `src/app/query-client.test.ts`, `src/app/providers.test.tsx`      |
| Frontend realtime client + hooks                                                                                                                | fe `src/services/realtime/ws-client.test.ts`, `hooks.test.tsx`                                     |
| Frontend pages (home card, DEV route, app)                                                                                                      | fe `src/features/system/SystemInfoCard.test.tsx`, `src/pages/**/*.test.tsx`, `src/App.test.tsx`    |

Gaps found in the audit and closed in T1.16: WS **per-account** connection limit (4009) and **max topics per connection**.

## 4. Numbers

| Metric                                      | Backend                               | Frontend                  |
| ------------------------------------------- | ------------------------------------- | ------------------------- |
| Tests (start of Phase 1 → now)              | 13 → 310 (Batch 1: 139, Batch 2: 248) | 7 → 85                    |
| Coverage (stmts / branches / funcs / lines) | 92.9 / 82.9 / 90.4 / 94.6             | 90.9 / 86.9 / 84.0 / 94.1 |
| Coverage gate (CI)                          | 90 / 80 / 90 / 90                     | 90 / 85 / 80 / 90         |

**Key versions:** Node 24.19, TypeScript 6.0.3, Express 5.2.1, mongoose 9.11.1 (MongoDB 8.2), ioredis 6.0.0, BullMQ 6.3.11, ws 8.22.0, zod 4.6.5, pino 10.4.0, helmet 8.3.0, express-rate-limit 8.7.1 + rate-limit-redis 6.0.1, nodemailer 10.0.16, swagger-ui-dist 5.33.1, zod-to-openapi 9.1.0, AWS SDK v3 3.1147, Vitest 5.0.3; frontend React 19, MUI 9, React Router 8, React Query 5.104, axios 1.20.

**`allowScripts`:** backend `esbuild: true`, `fsevents: false`, `unrs-resolver: true`, `mongodb-memory-server: false`, `msgpackr-extract: false` (Batch 2), `@scarf/scarf: false` (Batch 3 — analytics only). Frontend unchanged (`unrs-resolver: true`, `fsevents: false`).

## 5. Deviations from the plan (all batches)

| Where      | Deviation                                                                                                              | Why                                                                                                                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1.4       | `GET /api/v1/system/info` built in T1.4 (plan: T1.9)                                                                   | First real route to prove the pipeline                                                                                                                                                                          |
| T1.6       | Redis rate-limit store moved to T1.8                                                                                   | Needs the Redis connection                                                                                                                                                                                      |
| T1.10      | Client messages buffered until the ticket is verified; TCP liveness (pong) separate from app idle (4008)               | Real bug found: early `ping`/`subscribe` were lost                                                                                                                                                              |
| T1.12      | Tests share **one** in-memory replica set (Vitest `globalSetup`)                                                       | Parallel replica sets made transactions hang intermittently                                                                                                                                                     |
| T1.13      | Email `dedupeKey` uses BullMQ **deduplication** (24 h) instead of the job id                                           | BullMQ ids can't contain `:`; completed jobs are removed so id-dedupe would not hold                                                                                                                            |
| T1.13      | No `@types/smtp-server` / `@types/nodemailer`; minimal local `.d.ts` for `smtp-server` (tests only)                    | nodemailer 10 ships its own types; `@types/smtp-server` drags in `@types/nodemailer`                                                                                                                            |
| T1.14      | `swagger-ui-dist` instead of `swagger-ui-express`; `getAppInfo().version` read from package.json                       | Strict CSP without inline scripts; version was undefined under `node dist`                                                                                                                                      |
| T1.15      | `RealtimeClient` resets backoff / auth-failure count when the server **answers** (first pong/event), not on `open`     | The server accepts the socket before rejecting a bad ticket with 4001                                                                                                                                           |
| T1.16      | `startServer(options)` gained `env`, `logger`, `port`, `installSignalHandlers`, `queuePrefix`, `emailProvider`, `exit` | Full-server e2e test; production call (`startServer()`) unchanged                                                                                                                                               |
| P1-B3-DONE | `closeAllQueues` bounded to 5 s (warns and continues)                                                                  | **Real bug found in the checkpoint:** after a Redis restart BullMQ `worker.close()` hung → 15 s hard timeout → `exit 1`, so the email / redis / mongo hooks never ran. Reproduced, fixed, regression test added |

## 6. Verification (P1-B3-DONE)

Checked on 2026-10-08 (`npm run infra:up`):

| Check                                                                                                                                                                           | Result                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Backend `npm ci`, lint, format:check, typecheck, `test:coverage` (310 tests, gate met), build, `openapi:check`, actionlint                                                      | ✅                                                                                     |
| Frontend `npm ci`, lint, format:check, typecheck, `test:coverage` (85 tests, gate met), build, actionlint; DEV page absent from `dist/`                                         | ✅                                                                                     |
| Fresh clone of both repos → `npm ci` + full checks (no `.env`), frontend `gen:api` against the cloned backend spec → no diff                                                    | ✅                                                                                     |
| `/health`, `/ready` 200; `/api/v1/openapi.json` 200; `/api/docs` 200 with the strict CSP; API through the Vite proxy (`:3100`)                                                  | ✅                                                                                     |
| `npm run email:test` + a queued email through the running worker → both in Mailpit                                                                                              | ✅                                                                                     |
| `db:migrate:status` → `0001-baseline` applied                                                                                                                                   | ✅                                                                                     |
| Frontend `RealtimeClient` through the Vite proxy (`ws://localhost:3100/ws/events`) receives a Redis-published event; a bad ticket stops after 3 × 4001 (`unauthorized`)         | ✅ (Node script — no browser on this machine)                                          |
| Redis stopped → `/ready` 503 → started → 200                                                                                                                                    | ✅                                                                                     |
| `kill -INT` → hooks http → ws → queues → email → redis → mongo, `shutdown: complete`, exit 0, port 5100 free (also right after a Redis restart, after the `closeAllQueues` fix) | ✅                                                                                     |
| Secret scan (grep) + gitleaks over both histories                                                                                                                               | ✅ no findings                                                                         |
| Browser check of the home page card and `/dev/realtime` UI                                                                                                                      | ⚠️ not done (no browser here) — covered by RTL tests and the proxy / Node checks above |

## 7. Remaining TODOs (by phase)

| Phase | Where                                 | What                                                                                       |
| ----- | ------------------------------------- | ------------------------------------------------------------------------------------------ |
| 2     | fe `src/services/api/client.ts`       | Attach access token; refresh on 401 and retry once                                         |
| 2     | fe `src/app/providers.tsx`            | Pass the ticket provider (`POST /api/v1/ws/tickets`) to `RealtimeProvider`                 |
| 2     | backend                               | `POST /api/v1/ws/tickets` endpoint (service exists: `WsTicketService`)                     |
| 2     | backend `src/core/email/templates/`   | `auth.verify_email`, `auth.reset_password`, `team.invite` templates                        |
| 4 / 8 | backend                               | Mount the idempotency middleware on money / campaign routes                                |
| 7 / 8 | backend `src/core/realtime/topics.ts` | `TODO(P7/P8)`: topic ownership check against the account                                   |
| 2+    | frontend build                        | Main chunk ~655 kB (Vite warns > 500 kB) — route-level code splitting when real pages land |

## 8. Client inputs still pending

- **OpenAI API key** — voice AI PoC live runs (Phase 0 T0.15), Phases 5/7.
- **Client server SSH key** — read-only server audit (T0.19), Phase 12.
- **SIP trunk details** — Phase 13.
- **SMTP provider + sender domain (SPF / DKIM / DMARC)** — production email (`EMAIL_DRIVER=smtp` is mandatory in production). Dev uses Mailpit.

## 9. Go / no-go for Phase 2

✅ **Go.** Auth, accounts, RBAC and the app shell build directly on: env + errors + validation, Mongo plugins (tenant / soft delete) + transactions, idempotency, email templates + queue, WS tickets (`WsTicketService`), the frontend `ApiError` / React Query policy and `RealtimeProvider` (needs only the ticket provider).
