# P1 · BATCH 2 RUN — Data, queues, realtime, idempotency, storage (T1.7 → T1.12) — Autonomous Run Prompt

> **HOW TO RUN (ise paste karo):**
> `cell-ai-voicebot-backend/docs/prompts/PHASE_1_BATCH_2_PROMPT.md padho aur T1.7 se P1-B2-DONE tak SAARE tasks step by step autonomously implement karo. Bich me koi question mat poochho, permission mat maango — saare decisions is prompt me pre-made hain. Har task ke baad verify + commit (tag [P1-T1.x]). Koi push / merge NAHI. Ant me P1-B2-DONE checkpoint + final report.`
>
> **Claude Code "accept edits" mode me chalao.** Working directory: `/Users/lalitbansal/Documents/cell-ai-voicebot`. **Docker Desktop chalu hona chahiye** (`open -a Docker`).

---

## 0. CONTEXT (verified facts — dobara derive mat karna)

**Batch 1 done** on backend branch **`feature/phase-1-foundation`** (last commit `[P1-B1-DONE]`, 139 tests). Frontend repo is **not touched** in this batch.

**Pehle padho:** [`docs/phases/PHASE_1_PLAN.md`](../phases/PHASE_1_PLAN.md) (T1.7–T1.12 + Batch 1 update notes), [`src/README.md`](../../src/README.md) (pipeline + how to write a route), conventions [`api.md`](../conventions/api.md), [`websocket.md`](../conventions/websocket.md), [`data.md`](../conventions/data.md), [`data-model.md`](../conventions/data-model.md) (IdempotencyKey), [`error-codes.md`](../conventions/error-codes.md), [`code-style.md`](../conventions/code-style.md), ADRs 0004 (Mongo 8.2 replica set), 0005 (Redis + BullMQ), 0008 (ws), 0023 (storage), 0028 (ports).

**What Batch 1 built (use it, don't rebuild):**

| File                                     | Provides                                                                                                                                                                                                                      |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config/env.ts`                      | `loadEnv` / `getEnv` / `resetEnvForTests`, `Env` (incl. `MONGODB_URI`, `REDIS_URL` with local defaults, `STORAGE_*`, `ENCRYPTION_KEY`, `APP_URL`, `TRUST_PROXY`)                                                              |
| `src/config/limits.ts`                   | body limits, `GLOBAL_RATE_LIMIT`, `STRICT_RATE_LIMIT`, `UNLIMITED_PATHS = ['/health', '/ready']`                                                                                                                              |
| `src/app.ts`                             | `createApp({ env, logger, rateLimit? })` — pipeline: requestId → httpLogger → helmet → cors → globalRateLimiter → body parsers → `/api/v1` → notFound → errorHandler                                                          |
| `src/server.ts`                          | `startServer()` — env → logger → lifecycle → app → `http.createServer` → listen → hook `http` (order 10) → signal handlers                                                                                                    |
| `src/core/lifecycle.ts`                  | `createLifecycle(logger, { exit, timeoutMs })` → `onShutdown(name, fn, order)`, `shutdown()`, `installSignalHandlers()`. **Reserved orders: http 10, ws 20, queues 30, redis 40, mongo 50**                                   |
| `src/shared/errors/*`                    | `AppError`, `ValidationError`, `NotFoundError`, `ConflictError`, `ForbiddenError`, `RateLimitedError`, `ProviderError`, `ERROR_CODES`                                                                                         |
| `src/shared/http/envelope.ts`            | `ok`, `created`, `noContent`                                                                                                                                                                                                  |
| `src/shared/middlewares/*`               | `requestId` + `getRequestId`, `httpLogger`, `securityHeaders`, `corsMiddleware`, `createRateLimiter` / `globalRateLimiter` (**MemoryStore — Redis store is part of T1.8**), `validate` / `handle`, `notFound`, `errorHandler` |
| `src/shared/validation/schemas.ts`       | `ObjectIdSchema`, pagination, cursor, `sortSchema`, `PhoneE164Schema`, `MoneyMicrosSchema`, `strictQuery`                                                                                                                     |
| `src/shared/logger.ts`                   | `createLogger(env, destination?)`, `getLogger()`                                                                                                                                                                              |
| `src/shared/openapi/*`, `src/openapi.ts` | registry, extended `z`, `ErrorEnvelope`, `successEnvelope()`; `npm run gen:openapi` / `openapi:check`                                                                                                                         |
| `tests/helpers/test-app.ts`              | `testEnv()`, `buildTestApp(envOverrides, { rateLimit })`                                                                                                                                                                      |
| `tests/infra/mongo-replset.test.ts`      | mongodb-memory-server replica set (MongoDB **8.2.12** pinned in `package.json → config.mongodbMemoryServer`)                                                                                                                  |
| `docker-compose.yml`                     | `mongo:8.2` replset on `127.0.0.1:27018`, `redis:7.4-alpine` on `127.0.0.1:6380`; `npm run infra:up / infra:down`                                                                                                             |

**Verified on 2026-10-08:**

| Package                                                                       | Version         | Note                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mongoose`                                                                    | 9.11.1          | bundles `mongodb` ~7.7 (same major as our test driver)                                                                                                                                                                  |
| `ioredis`                                                                     | 6.0.0           |                                                                                                                                                                                                                         |
| `bullmq`                                                                      | 6.3.11          | backends pluggable; `ioredis` is an **optional peer**. **Smoke-tested** with ioredis 6 + local Redis: `new Queue(name, { connection: new IORedis(url, { maxRetriesPerRequest: null }) })` + `Worker` processed a job ✅ |
| `rate-limit-redis`                                                            | 6.0.1           | peer `express-rate-limit >=8.6` ✅; ioredis usage: `sendCommand: (command, ...args) => client.call(command, ...args)`                                                                                                   |
| `ws` / `@types/ws`                                                            | 8.22.0 / 8.18.2 | optional peers `bufferutil`, `utf-8-validate` — **do not install**                                                                                                                                                      |
| `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@aws-sdk/lib-storage` | 3.11xx          |                                                                                                                                                                                                                         |

Machine: Docker 29.7 running; other containers (Supabase stack) must never be touched — only `npm run infra:*` (project `cell-ai-voicebot`).

---

## 1. LOCKED DECISIONS

| Topic              | Decision                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Redis in tests** | **Real Redis** — local Docker (`npm run infra:up`, `127.0.0.1:6380`) and a **Redis service container in CI**. `ioredis-mock` / `redis-memory-server` are **not** used (BullMQ needs real Lua scripting). Tests use a **unique key prefix per test file** and clean up. If Redis is unreachable the helper fails with: `Redis not reachable at <url> — run "npm run infra:up"`.                             |
| **Mongo in tests** | mongodb-memory-server replica set (as today) — no Docker needed for Mongo tests.                                                                                                                                                                                                                                                                                                                           |
| Mongoose           | v9, `autoIndex: true` except production; `strictQuery: true`; `toJSON` → `id` string, no `_id` / `__v`. Indexes synced at startup in dev/test; production via `npm run db:sync-indexes`.                                                                                                                                                                                                                   |
| Transactions       | `withTransaction(fn)` helper using `session.withTransaction()` (driver retries transient errors). No external I/O inside.                                                                                                                                                                                                                                                                                  |
| Migrations         | Own tiny runner; explicit registry array `src/db/migrations/index.ts` (no fs globbing — keeps esbuild/tsc builds simple); `migrations` collection + `migrationLocks` lock doc.                                                                                                                                                                                                                             |
| Redis connections  | One shared **app** connection (rate limit, tickets, publish), **separate** connections for BullMQ queues/workers and for the pub/sub **subscriber** (Redis rule: a subscriber connection can't run other commands). All created via `createRedis(name)` and closed in shutdown hook `redis` (40).                                                                                                          |
| Workers            | New env **`WORKERS_ENABLED`** (boolean, default `true`) — lets Phase 12 run workers in a separate process. Sample `system` queue + heartbeat worker proves the wiring.                                                                                                                                                                                                                                     |
| Rate-limit store   | `rate-limit-redis` **RedisStore** (prefix `rl:`) passed from `startServer()` into `createApp({ rateLimitStore })`; tests keep MemoryStore unless testing the store.                                                                                                                                                                                                                                        |
| Health             | `GET /health` (liveness) and `GET /ready` (Mongo + Redis ping, 2 s timeout each) at the **root** (not `/api/v1`), success/error envelopes, not rate-limited/not access-logged (`UNLIMITED_PATHS`). `/ready` returns **503 while shutting down** (lifecycle flag).                                                                                                                                          |
| WebSocket          | `ws` with `noServer` + HTTP `upgrade` handler, path **`/ws/events`** only (other upgrade paths → socket destroyed). Auth = **single-use ticket** (`wst_…`, Redis, 60 s, consumed with `GETDEL`). Invalid / reused ticket → accept then close **4001**; expired → **4010** (see §T1.10). Ticket issuing HTTP endpoint comes in **Phase 2** — Phase 1 has `WsTicketService.issue()` + a dev-only script.     |
| WS fan-out         | `pushToAccount` / `pushToTopic` **publish to Redis channel `ws:fanout`**; every API instance subscribes and delivers to its local sockets — multi-instance ready from day one.                                                                                                                                                                                                                             |
| WS topic auth      | `subscribe` accepts only `call:<objectId>` and `campaign:<objectId>`; ownership check is a pluggable `authorizeTopic(ctx, topic)` hook (Phase 1 default: format check only — **real DB ownership check in Phase 7/8**, documented TODO).                                                                                                                                                                   |
| Idempotency        | Mongo model per data-model.md (TTL 24 h, unique `{accountId, key}`); middleware **not mounted on any route yet** (used from Phase 4/8). Scope resolver injectable (Phase 2 provides `accountId` from auth). Response replay header **`Idempotent-Replayed: true`**. 5xx / thrown errors are **not stored** (record deleted → client may retry).                                                            |
| Storage            | `StorageProvider` interface; `LocalStorage` (signed URLs `GET /files/<key>?exp=&sig=` HMAC-SHA256) and `S3Storage` (`lib-storage` `Upload` for streams, presigner for URLs). Signing key: HMAC derived from `ENCRYPTION_KEY`; **dev/test fallback** constant only when `NODE_ENV !== 'production'` (production already requires `ENCRYPTION_KEY`). `/files/*` route mounted **only for the local driver**. |
| Shutdown orders    | http 10 → ws 20 → queues 30 → redis 40 → mongo 50 (already reserved).                                                                                                                                                                                                                                                                                                                                      |
| Frontend           | **Not touched.** OpenAPI changes (health/ready) are regenerated in the backend; frontend `gen:api` happens in Batch 3 (T1.15).                                                                                                                                                                                                                                                                             |

**Version rule:** latest stable (above); no `--force` / `--legacy-peer-deps`; after each install `npm approve-scripts --allow-scripts-pending` and decide (approve only if the package truly needs it; record in README "Install scripts").

---

## 2. RULES OF ENGAGEMENT

1. **No questions / no permission requests.** Safe, convention-consistent choice → report it.
2. **Git:** backend, branch `feature/phase-1-foundation`. One commit per task: Conventional Commit + `[P1-T1.x]`. Hooks must pass (no `--no-verify`). **No push / merge / tag.**
3. **Verify after every task — run each command separately and read its output** (Batch 1 lesson: never hide a step behind `>/dev/null &&`):
   `npm run lint` · `npm run format:check` · `npx tsc --noEmit` · `npm test` · `npm run build` · `npm run openapi:check`. Infra must be up for tests (`npm run infra:up`).
4. **Tests are part of every task** (unit + integration). Use real Mongo (memory server) and real Redis (Docker) as decided.
5. **No secrets**; test fixtures use obvious fakes. Never log full URIs with credentials (log host/db only).
6. **Scope:** only T1.7–T1.12. No auth, no business modules, no email (T1.13), no Swagger UI (T1.14), no frontend.
7. **Every new env var** → `src/config/env.ts` (+ tests) + `.env.example` (comment + phase) + README env table + local `.env`.
8. **OpenAPI:** new/changed HTTP routes → register schemas → `npm run gen:openapi` → commit `openapi/openapi.json` in the same commit.
9. **Docs** stay in sync (`src/README.md` table + pipeline + startup order, `README.md`, conventions if a rule changes).
10. **Docker:** only `npm run infra:*`; never stop/remove other containers or volumes.

---

## 3. RESUME SAFETY

- `git -C cell-ai-voicebot-backend branch --show-current` → must be `feature/phase-1-foundation`; `git log --oneline -15`; continue after the last `[P1-T1.x]`.
- `npm run infra:up` → `npm ci` → `npm run lint` → `npx tsc --noEmit` → `npm test` must be green before continuing.

---

# ═══════════ TASKS ═══════════

## T1.7 — MongoDB → `feat(db): add mongoose connection, transactions, plugins and migrations [P1-T1.7]`

**Deps:** `mongoose`.

**Files:** `src/db/mongo.ts`, `src/db/transaction.ts`, `src/db/plugins/{base.ts, tenant.ts, soft-delete.ts}`, `src/db/migrations/{index.ts, 0001-baseline.ts}`, `src/db/migrate.ts`, `scripts/db-migrate.ts`, `scripts/db-sync-indexes.ts`, `tests/helpers/mongo.ts`, tests. Remove `src/db/.gitkeep`.

1. **`mongo.ts`**
   - `connectMongo(env, logger): Promise<typeof mongoose>` → `mongoose.set('strictQuery', true)`; `mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000, maxPoolSize: 20, autoIndex: env.NODE_ENV !== 'production' })`.
   - Log `connected` / `disconnected` / `reconnected` / `error` with **`redactMongoUri(uri)`** (host + db only — credentials removed). Export `redactMongoUri` (unit-tested).
   - `disconnectMongo()`, `pingMongo(timeoutMs = 2000): Promise<boolean>` (`db.admin().command({ ping: 1 })` raced against a timeout).
   - `syncAllIndexes(logger)` → `mongoose.syncIndexes()` with a log line per model (no models yet → logs "0 models").
2. **`transaction.ts`** — `withTransaction<T>(fn: (session) => Promise<T>): Promise<T>` → `startSession()` → `session.withTransaction(fn)` → always `endSession()`; returns fn's value.
3. **Plugins** (used from Phase 2; tested now on throwaway test models):
   - `base.ts` — `basePlugin(schema)`: `timestamps: true` behaviour via `schema.set('timestamps', true)`; `toJSON`/`toObject` transform → `id` string, delete `_id`, `__v`.
   - `tenant.ts` — `tenantPlugin(schema)`: adds `accountId: { type: ObjectId, required: true, index: true }`; helper type `TenantDoc`.
   - `soft-delete.ts` — `softDeletePlugin(schema)`: `deletedAt: { type: Date, default: null, index: true }`; pre-hooks on `find`, `findOne`, `countDocuments`, `findOneAndUpdate`, `updateMany`, `aggregate` (prepend `$match`) add `deletedAt: null` **unless** the query option `withDeleted: true` is set; instance method `softDelete()`; static `restore(id)`.
4. **Migrations**
   - `migrations/index.ts`: `export const MIGRATIONS: Migration[] = [baseline]` where `Migration = { name: string; up(db): Promise<void>; down(db): Promise<void> }`.
   - `0001-baseline.ts`: no-op `up` / `down` (marks the start).
   - `migrate.ts`: `migrateUp(db, migrations, logger)`, `migrateDown(db, migrations, logger)` (last applied only), `migrationStatus(db, migrations)`. Applied list in collection **`migrations`** `{ name (unique), appliedAt }`. **Lock**: insert `{ _id: 'lock', at }` into `migrationLocks` (duplicate key → throw `"Migrations already running"`), always removed in `finally`; stale lock older than 10 min may be taken over (log warn).
   - `scripts/db-migrate.ts` (`up` | `down` | `status` argument) and `scripts/db-sync-indexes.ts`. npm scripts: `"db:migrate": "tsx --env-file-if-exists=.env scripts/db-migrate.ts up"`, `"db:migrate:down": "… down"`, `"db:migrate:status": "… status"`, `"db:sync-indexes": "tsx --env-file-if-exists=.env scripts/db-sync-indexes.ts"`.
5. **`server.ts`** — before listen: `await connectMongo()`; if not production `await syncAllIndexes()`; register shutdown hook **`mongo` (50)** → `disconnectMongo()`. Startup failure (Mongo unreachable) → log + exit 1 (clear message: "MongoDB not reachable — run npm run infra:up").
6. **`tests/helpers/mongo.ts`** — `startTestMongo()` (MongoMemoryReplSet count 1) + `connectTestMongo()` / `stopTestMongo()`; reuse in later tasks.
7. **Tests:** `redactMongoUri` (with/without credentials, `+srv`); connect + ping true; ping false after disconnect; `withTransaction` commit + rollback (throw inside → no writes); plugins: tenant index exists (`listIndexes`), soft-delete hides deleted docs, `withDeleted` shows them, `aggregate` filtered, `toJSON` shape (`id`, no `_id`/`__v`); migrations: up applies baseline once, second up is a no-op, status lists applied/pending, down removes last, concurrent lock rejects, stale lock taken over.
8. **Docs:** README "Database" section (connect, `db:*` scripts, migrations how-to: add file + register in `index.ts`), `src/README.md` (`db/` row), startup order.

---

## T1.8 — Redis + BullMQ (+ Redis rate-limit store) → `feat(queues): add redis connections, bullmq factory and redis rate-limit store [P1-T1.8]`

**Deps:** `ioredis`, `bullmq`, `rate-limit-redis`.

**Files:** `src/core/queues/{redis.ts, queue-factory.ts, names.ts}`, `src/core/queues/workers/system.worker.ts`, `src/shared/middlewares/rate-limit.ts` (store wiring), `src/app.ts`, `src/server.ts`, `src/config/env.ts` (`WORKERS_ENABLED`), `tests/helpers/redis.ts`, tests. Remove `src/core/queues/.gitkeep`.

1. **Env:** `WORKERS_ENABLED` — boolean from `'true'|'false'` (default `true`); add to `.env.example` (`# run BullMQ workers in this process (Phase 12 may split them)`), README table, local `.env`; tests in `env.test.ts`.
2. **`redis.ts`**
   - `createRedis(url, name, logger)` → `new IORedis(url, { maxRetriesPerRequest: null, enableReadyCheck: true, connectionName: \`cav:${name}\` })`; log `ready`/`error`/`end`with`redactRedisUrl(url)` (host:port only).
   - Registry of created connections; `getAppRedis()` (shared app connection, lazy) and `createSubscriber()`; `pingRedis(client, timeoutMs = 2000)`; `closeAllRedis()` → `quit()` each (fallback `disconnect()` after 2 s).
3. **`queue-factory.ts`**
   - `QUEUE_DEFAULT_JOB_OPTIONS = { attempts: 3, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: { age: 86_400, count: 1000 }, removeOnFail: { age: 604_800 } }`.
   - `createQueue(name, { prefix? })` and `createWorker(name, processor, { concurrency = 5, prefix? })` — each with its **own** Redis connection from `createRedis`; worker events `failed` → `logger.warn({ jobId, name, attemptsMade, err })`, `error` → `logger.error`; registry; `closeAllQueues()` closes workers first (graceful: lets active jobs finish), then queues.
   - `prefix` defaults to `cav` (BullMQ key prefix) — tests pass a unique prefix.
4. **`names.ts`** — `export const QUEUES = { system: 'system' } as const;`.
5. **`system.worker.ts`** — processor for job `heartbeat` → returns `{ ok: true, at: ISO }`; `startSystemWorker()`; enqueue a heartbeat on startup (dev/test visibility) and as a repeatable job every 5 minutes (`upsertJobScheduler` if available in BullMQ 6, else `repeat`) — keep it cheap.
6. **Rate-limit store** — `createRedisRateLimitStore(client)` → `new RedisStore({ sendCommand: (command: string, ...args: string[]) => client.call(command, ...args) as never, prefix: 'rl:' })`. `createApp` gets an optional `rateLimitStore` dep passed into `globalRateLimiter({ store })`. Remove the `TODO(P1)` comment from Batch 1.
7. **`server.ts` startup order:** Mongo (T1.7) → `getAppRedis()` + `pingRedis` (fail fast: "Redis not reachable — run npm run infra:up") → rate-limit store → `createApp({ env, logger, rateLimitStore })` → listen → if `WORKERS_ENABLED` start workers. Shutdown hooks: **`queues` (30)** → `closeAllQueues()`, **`redis` (40)** → `closeAllRedis()`.
8. **`tests/helpers/redis.ts`** — `requireRedis()` (pings `REDIS_URL` from `testEnv()`; on failure throws the "run npm run infra:up" message), `uniquePrefix(name)` (`test:<name>:<random>`), `flushPrefix(client, prefix)` via `SCAN` + `DEL` (never `FLUSHALL`).
9. **CI** — `.github/workflows/ci.yml` `verify` job: add `services: redis: image: redis:7.4-alpine, ports: ['6380:6379'], options: --health-cmd "redis-cli ping" --health-interval 5s --health-timeout 3s --health-retries 10`; set job env `REDIS_URL: redis://127.0.0.1:6380`. Validate with actionlint (Docker: `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest -color=false`).
10. **Tests:** `redactRedisUrl`; `pingRedis` true / false (closed client); queue → worker completes a job; failing processor retried `attempts` times with backoff then `failed`; `closeAllQueues` waits for an active job; heartbeat worker result shape; **Redis rate-limit store shared across two `createApp` instances** (limit 2 → third request on the _other_ app → 429); `WORKERS_ENABLED` env parsing.
11. **Docs:** README — "Tests need Redis: `npm run infra:up` first"; Redis/queues section; Install scripts list if anything new; `src/README.md` (`core/queues/` row, startup/shutdown order).

---

## T1.9 — Health & readiness → `feat(health): add health and readiness endpoints [P1-T1.9]`

**Files:** `src/modules/health/{health.controller.ts, health.routes.ts, health.schema.ts}`, `src/core/lifecycle.ts` (expose `isShuttingDown()`), `src/app.ts`, `src/openapi.ts`, tests.

1. `createApp` gets optional `readiness` dep: `{ checks: Record<string, () => Promise<boolean>>, isShuttingDown: () => boolean }` (server passes `mongo: () => pingMongo()`, `redis: () => pingRedis(getAppRedis())`); tests pass fakes.
2. Mount **before** `/api/v1`, at root: `GET /health` → 200 `ok(res, { status: 'ok', uptimeSec })` (no dependency calls). `GET /ready` → run all checks in parallel (each 2 s timeout) → all true and not shutting down → 200 `ok(res, { status: 'ready', checks: { mongo: 'up', redis: 'up' } })`; otherwise **503** error envelope `PROVIDER_UNAVAILABLE` with `details: [{ path: 'mongo', message: 'down' }, …]` (or `{ path: 'server', message: 'shutting down' }`).
3. Both paths are in `UNLIMITED_PATHS` (no rate limit, no access log) — verify.
4. `lifecycle.isShuttingDown()` → true as soon as `shutdown()` starts.
5. **OpenAPI:** register `HealthSchema`, `ReadinessSchema` and both paths (tag `System`, 503 → `ErrorEnvelope`) → `npm run gen:openapi` → commit spec.
6. **Tests:** health 200; ready 200 with both up; one check false → 503 + details; check that hangs → treated as down after timeout; shutting down → 503; not rate-limited (limit 1, call `/ready` 3×); not access-logged.

---

## T1.10 — WebSocket `/ws/events` → `feat(realtime): add websocket events server with tickets and redis fan-out [P1-T1.10]`

**Deps:** `ws`, dev `@types/ws`.

**Files:** `src/core/realtime/{ws-tickets.ts, ws-server.ts, fanout.ts, events.ts, topics.ts}`, `scripts/ws-dev-ticket.ts`, `src/server.ts`, tests (`tests/realtime/*.test.ts`).

1. **`events.ts`** — `WsEventEnvelope<T>` `{ id: string; type: string; ts: string; data: T }` (`id` = `evt_` + UUID); TypeScript union of the event catalogue in websocket.md (types only; emitted by later phases).
2. **`ws-tickets.ts`** — `WsTicketService(redis)`: `issue({ userId, accountId, channel: 'events' | 'media' })` → `wst_<base64url 32 random bytes>`; `SET wst:<ticket> <json> EX 60 NX`; `consume(ticket)` → `GETDEL` → parsed payload or `undefined`. Expired vs unknown are indistinguishable in Redis → store `exp` inside the JSON and also keep a short-lived "seen" marker? **Decision:** keep it simple — unknown/used/expired all → close **4001**, except a ticket whose embedded `exp` is in the past (clock skew window) → **4010**. Document in websocket.md if behaviour differs from the table.
3. **`topics.ts`** — `parseTopic('campaign:<objectId>')` → `{ kind, id }` (kinds `call`, `campaign`); `authorizeTopic` default (format-only) with `// TODO(P7/P8): verify the call/campaign belongs to ctx.accountId`.
4. **`ws-server.ts`** — `createWsServer({ server, redis, subscriber, logger, limits })`:
   - `new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })`; `server.on('upgrade')`: path must be `/ws/events` else `socket.destroy()`; complete upgrade, then authenticate the ticket from `?ticket=` (close 4001/4010 on failure).
   - Client registry: `Map<accountId, Set<Client>>`, `Client = { ws, accountId, userId, topics: Set<string>, lastSeen }`.
   - Limits (websocket.md §9): **5 per user, 50 per account** → close **4009**; client message rate > 20/s → close **4008**; payload > 64 KB → `ws` closes with 1009.
   - Messages: `ping` → `{ type: 'pong' }`; `subscribe` / `unsubscribe` `{ topics: string[] }` (validated with zod; max 20 topics per connection; unauthorised topics ignored + logged); invalid JSON → ignored + warn (no disconnect).
   - Heartbeat: every 30 s check `lastSeen`; > 60 s → close **4008** `idle timeout`; also use `ws.ping()` / `pong` to detect dead TCP.
   - API: `pushToAccount(accountId, type, data)` and `pushToTopic(topic, type, data)` → **publish** `{ target: { accountId } | { topic }, event }` to Redis channel `ws:fanout`; the subscriber handler delivers locally (`fanout.ts`). `connectionCount()` for tests/metrics.
   - `close()` → close all clients with **1001** `server shutting down`, close wss, unsubscribe.
5. **`server.ts`** — create after `listen`; shutdown hook **`ws` (20)**. Export the realtime instance for later modules (`getRealtime()` or dependency object).
6. **`scripts/ws-dev-ticket.ts`** (dev only — refuses when `NODE_ENV=production`): issues a ticket for fake ids and prints a ready-to-use `wscat` / browser URL. npm script `"ws:dev-ticket": "tsx --env-file-if-exists=.env scripts/ws-dev-ticket.ts"`.
7. **Tests** (real HTTP server on port 0 + `ws` client + real Redis with unique prefix): valid ticket connects + receives `pushToAccount` event (envelope shape); reused ticket → 4001; unknown ticket → 4001; expired (`exp` past) → 4010; wrong path → connection refused; account isolation; topic subscribe/unsubscribe; unauthorised topic ignored; ping/pong; per-user limit → 4009; oversized message → 1009; **two server instances sharing Redis** — push on A delivered to client on B; `close()` → clients get 1001.
8. **Docs:** websocket.md — note Phase 1 implementation details (ticket store, close-code mapping, fan-out channel); `src/README.md` (`core/realtime/`), README (`ws:dev-ticket`).

---

## T1.11 — Idempotency middleware → `feat(idempotency): add idempotency-key middleware [P1-T1.11]`

**Files:** `src/db/models/idempotency-key.model.ts`, `src/shared/middlewares/idempotency.ts`, `src/shared/utils/stable-json.ts`, tests.

1. **Model** (data-model.md): `accountId` (ObjectId, required), `key` (string ≤ 255), `method`, `path`, `requestHash`, `status` (`in_progress | completed`), `responseStatus`, `responseBody` (Mixed), `expiresAt` (Date, **TTL index** `expireAfterSeconds: 0`), timestamps; unique `{ accountId: 1, key: 1 }`. Uses `basePlugin` (not soft delete).
2. **`stable-json.ts`** — deterministic JSON (sorted keys, recursive) for hashing; `sha256(method + ' ' + path + ' ' + stableJson(body))`.
3. **`idempotency({ required = true, scope, ttlMs = 24 h })`**:
   - Header `Idempotency-Key`: missing → required ? 422 `VALIDATION_FAILED` (`details: [{ path: 'headers.idempotency-key', message: 'Required' }]`) : `next()`. Invalid (not `^[A-Za-z0-9_.:-]{1,255}$`) → 422.
   - `scope(req)` → accountId string (Phase 2: from auth). Undefined → `next(new AppError('INTERNAL_ERROR', 'Idempotency scope missing'))` (programming error).
   - Insert `{ status: 'in_progress', … }` → on duplicate key load existing: hash differs → **422 `IDEMPOTENCY_KEY_REUSED`**; `in_progress` → **409 `IDEMPOTENCY_IN_PROGRESS`**; `completed` → replay `responseStatus` + `responseBody` with header **`Idempotent-Replayed: true`**.
   - Capture the response: wrap `res.json` to store the body; on `res` `finish`: status < 500 → mark `completed` with status + body; status ≥ 500 → **delete** the record. If the handler throws (error handler sends 4xx/5xx) the same rule applies (4xx stored, 5xx deleted).
4. **Tests** (memory-server Mongo + tiny test router + Supertest): first call runs handler + stores; same key + same body → replayed, handler **not** called again, header set; same key + different body → 422; concurrent in-flight → 409 (slow handler + parallel request); 5xx → record deleted → retry runs handler; 4xx stored + replayed; missing key (required) → 422; optional mode passes through; different accounts may reuse the same key; TTL index exists on `expiresAt`; `stableJson` key-order independence.
5. **Docs:** api.md §10 — note implementation + `Idempotent-Replayed` header; `src/README.md`.

---

## T1.12 — StorageProvider (local + S3) → `feat(storage): add local and s3 storage providers with signed urls [P1-T1.12]`

**Deps:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@aws-sdk/lib-storage`.

**Files:** `src/core/storage/{storage.types.ts, keys.ts, local.storage.ts, s3.storage.ts, signing.ts, index.ts}`, `src/modules/files/{files.controller.ts, files.routes.ts}`, `src/config/limits.ts` (`SIGNED_URL_TTL_SEC = 900`), `src/app.ts` (mount `/files` for local), tests. Remove `src/core/*` `.gitkeep` only where folders get files.

1. **Interface** `StorageProvider { put(key, body: Buffer | Readable, opts: { contentType: string }): Promise<{ key: string; size: number }>; get(key): Promise<Readable>; delete(key): Promise<void>; exists(key): Promise<boolean>; signedUrl(key, opts?: { expiresInSec?: number }): Promise<string> }`.
2. **`keys.ts`** — `storageKey({ accountId, area, id, ext })` → `accounts/<accountId>/<area>/<id>.<ext>`; `assertSafeKey(key)` rejects empty, absolute, `..`, backslashes, chars outside `[A-Za-z0-9/_.-]`, > 512 chars.
3. **`signing.ts`** — `signingKey(env)` = HMAC-SHA256(`ENCRYPTION_KEY` bytes, `'storage-url-v1'`); non-production without `ENCRYPTION_KEY` → fixed dev key + one warn log; `signPath(key, exp)` / `verifySignature(key, exp, sig)` (timing-safe compare).
4. **`local.storage.ts`** — root = `path.resolve(env.STORAGE_LOCAL_PATH)`; resolved file path must stay inside root (double check after `path.resolve`); `put` via `stream/promises.pipeline` + `mkdir -p`; `get` → `createReadStream` (missing → `NotFoundError`); `signedUrl` → `${APP_URL}/files/${encodeURI(key)}?exp=<unix>&sig=<hex>`.
5. **`s3.storage.ts`** — `S3Client({ region, credentials })`; `put` → `new Upload({ client, params: { Bucket, Key, Body, ContentType } }).done()` (works for Buffer and streams); `get` → `GetObjectCommand` body stream (`NoSuchKey` → `NotFoundError`); `delete` → `DeleteObjectCommand`; `exists` → `HeadObjectCommand` (404 → false); `signedUrl` → `getSignedUrl(client, GetObjectCommand, { expiresIn })`. Provider errors → `ProviderError`.
6. **`index.ts`** — `createStorage(env, logger)` picks the driver.
7. **Files route** (local driver only): `GET /files/*key` (Express 5 wildcard syntax `/*key`) → verify `exp` (not past) + `sig` → stream with `Content-Type` from extension map (`wav`, `mp3`, `csv`, `xlsx`, `pdf`, `json`, `txt`, else `application/octet-stream`) and `Cache-Control: private, max-age=<remaining>`; bad/missing sig → **403 `AUTH_FORBIDDEN`**; expired → 403; missing file → 404. Mounted at root in `createApp` when `env.STORAGE_DRIVER === 'local'` (dependency `storage` passed in).
8. **`.gitignore`** already ignores `uploads/` — verify; tests use a temp dir under the OS temp folder.
9. **Tests:** keys (valid/invalid); signing (valid, tampered, expired, timing-safe); local put/get/exists/delete with Buffer and stream, traversal attempts rejected (`../x`, `/abs`, `a/../../b`); files route end-to-end (signed URL works, tampered → 403, expired → 403, missing → 404, content-type); S3 provider with `vi.spyOn(S3Client.prototype, 'send')` (put/get/delete/exists/404 mapping) and `getSignedUrl` returns a URL containing the key; `createStorage` picks driver.
10. **Docs:** ADR 0023 → add "Implementation (Phase 1)" note; README Storage section; `src/README.md`.

---

## P1-B2-DONE — checkpoint → `docs: mark phase 1 batch 2 complete [P1-B2-DONE]`

1. `npm run infra:up` → full verify (each separately): `npm ci`, `npm run lint`, `npm run format:check`, `npx tsc --noEmit`, `npm test`, `npm run build`, `npm run openapi:check`; actionlint on `ci.yml`.
2. **Manual end-to-end:** `npm run dev` →
   - `curl -s localhost:5100/health` and `/ready` (200, both up);
   - `npm run ws:dev-ticket` → connect with a small Node `ws` client script (in the scratchpad, not committed) → receive a `pushToAccount` test event (temporary dev trigger allowed only in the scratch script via Redis publish);
   - `npm run db:migrate:status` shows `0001-baseline` applied after `npm run db:migrate`;
   - stop infra Redis (`docker compose stop redis`) → `/ready` returns 503 → `docker compose start redis` → 200 again;
   - `kill -INT` → logs show hooks in order **http → ws → queues → redis → mongo**; port 5100 free.
3. Secret scan: `grep -rnE "sk-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----" --exclude-dir=node_modules --exclude-dir=.git .` → 0.
4. Docs: `PHASE_1_TASKS.md` T1.7–T1.12 `[x]`; `PHASE_1_PLAN.md` changelog line (+ note: T1.12 done in Batch 2, Batch 3 = T1.13–T1.16); `src/README.md` (tables, startup order, shutdown order); `README.md` (infra required, db/ws scripts, env table); `CHANGELOG.md` Phase 1 · Batch 2 entry; any convention doc changed.
5. Commit `[P1-B2-DONE]`. `npm run infra:down` at the end. No push / merge.

---

## FINAL REPORT (chat, Hinglish)

1. Summary per task (✅ / ⚠️ / ❌ + 1 line). 2. `git log --oneline` of this batch. 3. Installed versions + `allowScripts` changes. 4. Deviations + why. 5. Verification results (each command + manual checks incl. shutdown order). 6. Tests before → after. 7. Open items for Batch 3 (T1.13–T1.16), incl. frontend `gen:api` for the new health paths.

---

## MUST-NOT-MISS CHECKLIST

- [ ] Branch `feature/phase-1-foundation`; one commit per task `[P1-T1.x]`; hooks pass; no push/merge/tag
- [ ] Each verify command run **separately**, outputs read (no hidden failures)
- [ ] Mongo: strictQuery, autoIndex off in prod, URI redacted in logs, `withTransaction`, `syncAllIndexes` (dev/test), `db:*` scripts, migrations runner + lock + baseline
- [ ] Plugins: base (`id`, no `_id`/`__v`), tenant (`accountId` index), soft delete (incl. aggregate, `withDeleted`)
- [ ] Redis: separate connections (app / BullMQ / subscriber), URL redacted, `closeAllRedis`
- [ ] BullMQ: default job options, worker logging, graceful close, `system` heartbeat, `WORKERS_ENABLED`
- [ ] Rate limit uses **RedisStore** in the server (shared across instances, tested); Batch 1 TODO removed
- [ ] CI `verify` job has a Redis service + `REDIS_URL`; actionlint clean
- [ ] `/health` + `/ready` at root; 503 on dependency down or shutting down; not rate-limited/logged; OpenAPI regenerated
- [ ] WS: `/ws/events` only, single-use tickets (`GETDEL`), close codes 4001 / 4010 / 4009 / 4008 / 1009 / 1001, limits, heartbeat, topic format + TODO ownership, Redis fan-out tested across 2 instances
- [ ] Idempotency: model + TTL + unique index, 422 / 409 / replay header, 5xx not stored, scope injectable, not mounted on real routes
- [ ] Storage: interface, safe keys, local + S3, signed URLs (timing-safe), `/files/*key` only for local, provider errors mapped
- [ ] Shutdown order http 10 → ws 20 → queues 30 → redis 40 → mongo 50 (verified manually)
- [ ] New env `WORKERS_ENABLED` everywhere (schema, tests, `.env.example`, README, `.env`)
- [ ] Docs: src/README, README, websocket.md, api.md, ADR 0023, PHASE_1_PLAN/TASKS, CHANGELOG
- [ ] Only `cell-ai-voicebot` Docker project touched; infra stopped at the end; frontend untouched
