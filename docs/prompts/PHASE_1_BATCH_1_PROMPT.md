# P1 · BATCH 1 RUN — Backend Foundation core (T1.1 → T1.6) — Autonomous Run Prompt

> **HOW TO RUN (ise paste karo):**
> `cell-ai-voicebot-backend/docs/prompts/PHASE_1_BATCH_1_PROMPT.md padho aur T1.1 se P1-B1-DONE tak SAARE tasks step by step autonomously implement karo. Bich me koi question mat poochho, permission mat maango — saare decisions is prompt me pre-made hain. Har task ke baad verify + commit (tag [P1-T1.x]). Koi push / merge NAHI. Ant me P1-B1-DONE checkpoint + final report.`
>
> **Claude Code "accept edits" mode me chalao.** Working directory: `/Users/lalitbansal/Documents/cell-ai-voicebot`

---

## 0. CONTEXT (verified facts — dobara derive mat karna)

**Phase 0 complete** and merged: backend `main` = `origin/main` = `26c1c25 [P0-DONE]`; frontend `main` = `d956bbf`. `dev` branches are still at the initial commit (user handles them). No tags yet.

**This batch = backend only.** Branch: **`feature/phase-1-foundation`** (created from `main`; contains this prompt as commit `[P1-PROMPT]`). Frontend repo is **not touched** in this batch.

**Pehle padho (source of truth):**

- [`docs/phases/PHASE_1_PLAN.md`](../phases/PHASE_1_PLAN.md) — T1.1–T1.6 sections
- Conventions: [`api.md`](../conventions/api.md), [`error-codes.md`](../conventions/error-codes.md), [`code-style.md`](../conventions/code-style.md), [`data.md`](../conventions/data.md), [`secrets.md`](../conventions/secrets.md)
- ADRs: 0002 (runtime), 0003 (structure), 0006 (zod), 0007 (pino), 0015 (naming), 0016 (money), 0018 (phones), 0024 (API style), 0027 (module system), 0029 (OpenAPI)
- `src/README.md`, `README.md`, `.env.example`, `package.json`

**Current backend code (Phase 0):**

| Path                                                  | What exists                                                                                                                               |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                                        | `getAppInfo()` (exported) + hello `console.info` when run directly                                                                        |
| `src/openapi.ts`                                      | `buildOpenApiDocument()`; imports `./modules/system/system.schema`                                                                        |
| `src/shared/openapi/{zod,registry,common.schemas}.ts` | extended `z`, registry (bearer + apiKey schemes), `ErrorEnvelope`, `ErrorDetail`, `OffsetPageMeta`, `CursorPageMeta`, `successEnvelope()` |
| `src/modules/system/system.schema.ts`                 | `AppInfoSchema` + documented path `GET /api/v1/system/info` (**route not implemented yet**)                                               |
| `tests/infra/mongo-replset.test.ts`                   | replica-set transaction smoke test                                                                                                        |
| Empty folders (`.gitkeep`)                            | `src/config`, `src/shared/{errors,middlewares,utils,types}`, `src/core/*`, `src/modules/*`, `src/jobs`, `src/db`                          |

**Tooling (verified):** Node 24.19, npm 11 (install scripts need `allowScripts` approval — current: `esbuild ✓`, `unrs-resolver ✓`, `fsevents ✗`, `mongodb-memory-server ✗`), TypeScript **6.0.3 pinned**, ESLint **9 pinned**, Vitest 5, Prettier, Husky + lint-staged (`--no-warn-ignored`) + commitlint. Backend is **CommonJS** with `module/moduleResolution: NodeNext`, **no path aliases**, relative imports without extensions. `tsx` supports `--env-file-if-exists` (verified). Tests: `src/**/*.test.ts`, `tests/**/*.test.ts`.

**Package versions available (npm, verified 2026-10-08):** `express` 5.2.1 · `@types/express` 5.0.6 · `pino` 10.4 · `pino-http` 11.0 · `pino-pretty` 13.2 · `helmet` 8.3 · `cors` 2.8.6 · `@types/cors` 2.8.19 · `express-rate-limit` 8.7 (peer `express >=4.11`) · `libphonenumber-js` 1.13. `supertest` + `@types/supertest` already installed.

---

## 1. LOCKED DECISIONS

| Topic             | Decision                                                                                                                                                                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Env loading       | **No `dotenv`.** Scripts use Node/tsx `--env-file-if-exists=.env`. Code reads `process.env` only through `src/config/env.ts`.                                                                                                                                                       |
| Env validation    | zod v4 schema; `loadEnv(source)` → frozen typed object; `getEnv()` cached singleton; errors list **variable names + reason only, never values**.                                                                                                                                    |
| Request ID        | Incoming `X-Request-Id` accepted if it matches `^[A-Za-z0-9._:-]{1,64}$`, else `crypto.randomUUID()`. Always echoed in the response header.                                                                                                                                         |
| Logger            | `pino` + `pino-http`; `pino-pretty` transport **only** when `NODE_ENV=development` **and** stdout is a TTY. Test env defaults to level `silent`. Log the **path without query string** (query may hold PII). No request/response bodies.                                            |
| Errors            | `ERROR_CODES` const in `src/shared/errors/error-codes.ts` = exactly `docs/conventions/error-codes.md` (a test enforces it). `AppError` + subclasses. 5xx messages never exposed.                                                                                                    |
| Express 5         | Native async error forwarding (no wrapper libs). `req.query` is a **getter in Express 5** → validated data goes to **`req.valid`**, never reassign `req.query`/`req.body`.                                                                                                          |
| System info route | `GET /api/v1/system/info` is implemented in **T1.4** (moved earlier from T1.9 — it's the first route; update PHASE_1_PLAN). `/health` + `/ready` stay in T1.9.                                                                                                                      |
| Graceful shutdown | Lifecycle manager with ordered shutdown hooks + 15 s hard timeout. Mongo/Redis/WS register their hooks in later tasks (T1.7/T1.8/T1.10).                                                                                                                                            |
| Rate limit store  | `express-rate-limit` **MemoryStore now**, through a `createRateLimiter()` factory that accepts a `store` — **Redis store is plugged in T1.8** (note it in PHASE_1_PLAN). Headers `standardHeaders: 'draft-6'` (separate `RateLimit-Limit/Remaining/Reset`), `legacyHeaders: false`. |
| CORS              | Exact-match allowlist from `CORS_ORIGINS`; disallowed origin → request still processed but **no CORS headers** (browser blocks); `credentials: true`.                                                                                                                               |
| Body limits       | JSON **1 MB**, urlencoded **100 KB**. Uploads handled per route later.                                                                                                                                                                                                              |
| Trust proxy       | New env `TRUST_PROXY` (default `false`; accepts `true`/`false`/hop count/`loopback` etc.) → `app.set('trust proxy', …)`.                                                                                                                                                            |
| Ports             | API `PORT` default **5100** (ADR 0028).                                                                                                                                                                                                                                             |
| Exports / files   | Named exports only; kebab-case files with role suffix (code-style.md).                                                                                                                                                                                                              |

**Version rule:** latest stable (above); no `--force` / `--legacy-peer-deps`; after each install run `npm approve-scripts --allow-scripts-pending` and decide (approve only if needed; document in README "Install scripts" list).

---

## 2. RULES OF ENGAGEMENT

1. **No questions / no permission requests.** Ambiguity → safe, convention-consistent choice → report it.
2. **Git:** backend repo, branch `feature/phase-1-foundation` only. One commit per task: Conventional Commit + tag, e.g. `feat(config): add zod env schema [P1-T1.1]`. Hooks must pass (**no `--no-verify`**). **No push, no merge, no tag.**
3. **Verify after every task:** `npm run lint && npm run format:check && npm run typecheck && npm test && npm run build && npm run openapi:check`. Fix before committing.
4. **Tests are part of every task** (unit + Supertest where HTTP is involved). No task is done without them.
5. **No secrets** anywhere (code, docs, logs, test fixtures use obvious fakes like `test-secret-…`).
6. **Scope:** only T1.1–T1.6. No Mongo/Redis/BullMQ/WS/health/idempotency/storage/email code (T1.7+). No frontend changes.
7. **Every new env var** → `src/config/env.ts` + `.env.example` (comment + phase) + README env table (+ local `.env` with a safe dev value).
8. **OpenAPI:** if a route or response shape changes → update its zod schema/registration → `npm run gen:openapi` → commit `openapi/openapi.json` in the same commit.
9. **Docs:** keep `src/README.md`, `README.md`, conventions in sync with what you build.
10. **Do not touch** other repos, Docker containers, AutoChatix, or the client server.

---

## 3. RESUME SAFETY

- New session: `git -C cell-ai-voicebot-backend branch --show-current` (must be `feature/phase-1-foundation`; if not, `git checkout feature/phase-1-foundation`) + `git log --oneline -15`. Continue after the last `[P1-T1.x]` commit.
- Before continuing: `npm ci && npm run lint && npm run typecheck && npm test` must be green.

---

# ═══════════ TASKS ═══════════

## T1.1 — Env config (zod, fail-fast) → `feat(config): add zod env schema [P1-T1.1]`

**Files:** `src/config/env.ts`, `src/config/env.test.ts` (remove `src/config/.gitkeep`).

1. **Schema** (`EnvSchema`, zod v4, `z.coerce` for numbers):

   | Var                                                                                | Rule                                                                                                                                                       |
   | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `NODE_ENV`                                                                         | enum `development \| test \| production`, default `development`                                                                                            |
   | `PORT`                                                                             | int 1–65535, default `5100`                                                                                                                                |
   | `APP_URL`, `FRONTEND_URL`                                                          | URL; default `http://localhost:5100` / `http://localhost:3100` (non-production only)                                                                       |
   | `CORS_ORIGINS`                                                                     | comma list → `string[]` of URLs (trim, drop empties, strip trailing `/`); default `[FRONTEND_URL]` in non-production; **required non-empty in production** |
   | `LOG_LEVEL`                                                                        | enum `fatal \| error \| warn \| info \| debug \| trace \| silent`; default `debug` (development), `silent` (test), `info` (production)                     |
   | `TRUST_PROXY`                                                                      | **new** — `false` (default) / `true` / integer hop count / string like `loopback` → parsed to `boolean \| number \| string`                                |
   | `MONGODB_URI`                                                                      | string starting `mongodb://` or `mongodb+srv://`; required (T1.7 uses it) — default to the local Docker URI in development/test only                       |
   | `REDIS_URL`                                                                        | `redis://` / `rediss://`; same default rule as Mongo                                                                                                       |
   | `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`                                          | optional in dev/test; **production: required, ≥ 32 chars, not `change-me*`**                                                                               |
   | `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL`                                                | duration strings (`^\d+[smhd]$`), defaults `15m` / `30d`                                                                                                   |
   | `ENCRYPTION_KEY`                                                                   | optional dev/test; **production: required, base64 decoding to exactly 32 bytes**                                                                           |
   | `OPENAI_API_KEY`, `OPENAI_REALTIME_MODEL`                                          | optional (Phase 5/7)                                                                                                                                       |
   | `STORAGE_DRIVER`                                                                   | enum `local \| s3`, default `local`; `STORAGE_LOCAL_PATH` default `./uploads`                                                                              |
   | `S3_BUCKET`, `S3_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`             | **required when `STORAGE_DRIVER=s3`** (`superRefine`)                                                                                                      |
   | `SMTP_HOST`, `SMTP_PORT` (int, default 587), `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | optional (T1.13)                                                                                                                                           |
   | `RAZORPAY_*`, `NOTIFYNOW_API_KEY`, `SIP_*`                                         | optional, strings (later phases)                                                                                                                           |
   | `CLIENT_SSH_KEY_PATH`                                                              | optional (used by `server:audit` script only)                                                                                                              |

   Treat empty strings as "unset" (preprocess `'' → undefined`).

2. **API:** `export type Env = z.infer<typeof EnvSchema>`; `loadEnv(source: NodeJS.ProcessEnv = process.env): Readonly<Env>`; `getEnv()` (cached); `resetEnvForTests()`; `class EnvValidationError extends Error { issues: { variable: string; reason: string }[] }` — message like `Invalid environment: JWT_ACCESS_SECRET (required in production, min 32 chars), CORS_ORIGINS (required in production)` — **no values**.
3. **Scripts:** `"dev": "tsx watch --env-file-if-exists=.env src/index.ts"`, `"start": "node --env-file-if-exists=.env dist/index.js"` (update now; `src/index.ts` still prints info until T1.4).
4. **`.env.example`:** add `TRUST_PROXY=false` under App with comment (`# false | true | <hops> | loopback — set when behind nginx (Phase 12)`), and `CLIENT_SSH_KEY_PATH=` under a new "Tooling" group. Local `.env`: add `TRUST_PROXY=false`.
5. **Tests** (`env.test.ts`): valid dev defaults from an empty source; numbers coerced; CORS list parsing; empty string = unset; production missing secrets → `EnvValidationError` listing names; production `change-me` rejected; bad `ENCRYPTION_KEY` length; s3 driver without bucket fails; error message never contains a provided secret value (assert).
6. **Docs:** README env table (add `TRUST_PROXY`, `CLIENT_SSH_KEY_PATH`; mark validation source `src/config/env.ts`); `docs/conventions/secrets.md` → "Validation" section: "implemented in `src/config/env.ts` (Phase 1)".

**VERIFY:** tests green; `NODE_ENV=production node -e "require('./dist/config/env').loadEnv({NODE_ENV:'production'})"` (after build) throws with names only.

---

## T1.2 — Logger + request ID → `feat(logging): add pino logger and request id [P1-T1.2]`

**Deps:** `pino`, `pino-http`; dev: `pino-pretty`. Review `allowScripts` after install.

**Files:** `src/shared/logger.ts`, `src/shared/utils/mask.ts`, `src/shared/middlewares/request-id.ts`, `src/shared/middlewares/http-logger.ts`, `src/@types/express.d.ts`, tests next to each.

1. `createLogger(env)`: `pino({ level, base: { service: 'cell-ai-voicebot-backend', env: NODE_ENV, version }, timestamp: pino.stdTimeFunctions.isoTime, redact: { paths: [...], censor: '[REDACTED]' } })`. Redact paths at least: `req.headers.authorization`, `req.headers.cookie`, `req.headers["x-api-key"]`, `res.headers["set-cookie"]`, `*.password`, `*.passwordHash`, `*.token`, `*.accessToken`, `*.refreshToken`, `*.apiKey`, `*.secret`, `*.authorization`. Pretty transport only for development + TTY. Export a default app `logger` built from `getEnv()` **lazily** (`getLogger()`), so tests can create isolated loggers.
2. `mask.ts`: `maskPhone(e164)` → keep `+` + country code (1–3 digits detected via libphonenumber-js if installed in T1.5 — **in T1.2 use a simple rule: keep first 3 chars and last 4**, e.g. `+91******3210`), `maskEmail('lalit@x.com') → 'l***@x.com'`. Unit tests.
3. `request-id.ts`: validate incoming header (regex in §1) else `randomUUID()`; set `req.id`; set response header `X-Request-Id`.
4. `http-logger.ts`: `pino-http` with `genReqId: (req) => req.id`, `customLogLevel` (5xx/err → `error`, 4xx → `warn`, else `info`), serializers logging `method`, **path without query**, `statusCode`, `responseTime`; `autoLogging.ignore` for a configurable list (empty now; `/health`, `/ready` added in T1.9). Attaches `req.log` (child with `requestId`).
5. `src/@types/express.d.ts`: module augmentation for Express 5 `Request`: `id: string`, `log: Logger`, `valid?: { body?: unknown; query?: unknown; params?: unknown }`. Make sure `tsconfig.json` includes it (it's under `src`).
6. **Tests:** request-id (valid header echoed, invalid header replaced, missing → UUID), logger redaction (write to an in-memory destination stream and assert `[REDACTED]` + absence of the secret), level by status code, query string not logged.

---

## T1.3 — Errors → `feat(errors): add app errors, error codes and envelopes [P1-T1.3]`

**Files:** `src/shared/errors/{error-codes.ts, app-error.ts, index.ts}`, `src/shared/http/envelope.ts`, `src/shared/middlewares/{error-handler.ts, not-found.ts}`, tests.

1. `error-codes.ts`: `export const ERROR_CODES = { REQUEST_MALFORMED: { status: 400, message: '…' }, … } as const;` — **every** row of `docs/conventions/error-codes.md` with the same HTTP status; `export type ErrorCode = keyof typeof ERROR_CODES`.
2. `app-error.ts`: `class AppError extends Error { readonly code; readonly status; readonly details?; readonly expose }` built from `ERROR_CODES[code]` (custom message optional; `expose = status < 500`). Subclasses: `ValidationError` (`VALIDATION_FAILED`, details), `NotFoundError` (`RESOURCE_NOT_FOUND`), `ConflictError` (`CONFLICT_DUPLICATE` default, or `CONFLICT_INVALID_STATE`), `UnauthenticatedError`, `ForbiddenError`, `RateLimitedError`, `PayloadTooLargeError`, `ProviderError` (502/503 codes). `isAppError(err)` guard.
3. `envelope.ts`: `ok(res, data, meta?)` (200), `created(res, data)` (201), `noContent(res)` (204); exported types `SuccessEnvelope<T>`, `ErrorEnvelope` (matching OpenAPI `ErrorEnvelope`).
4. `error-handler.ts` (Express error middleware, 4 args): map
   - `AppError` → its status/code/message/details;
   - body-parser errors: `type === 'entity.parse.failed'` → 400 `REQUEST_MALFORMED`; `'entity.too.large'` → 413 `PAYLOAD_TOO_LARGE`; other `err.status` 4xx from parsers → `REQUEST_MALFORMED`;
   - anything else → 500 `INTERNAL_ERROR` with generic message.
     Always `{ success: false, error: { code, message, details?, requestId: req.id } }`. Logging: 5xx → `req.log.error({ err })` with stack; 4xx → `req.log.warn({ code })` without stack. If `res.headersSent` → delegate to `next(err)`.
5. `not-found.ts` → `NotFoundError('RESOURCE_NOT_FOUND', 'Route not found')`.
6. **Doc-sync test** (`error-codes.test.ts`): read `docs/conventions/error-codes.md`, parse table rows ``| `CODE` | 422 | … |``, assert the set of codes and statuses equals `ERROR_CODES` exactly (fails if either side drifts).
7. **Tests:** each subclass → status/code; error handler for AppError / parse error / too large / unknown (500 hides message) / headersSent; requestId present in body.

---

## T1.4 — Express 5 app + server bootstrap + graceful shutdown → `feat(server): add express app, server bootstrap and graceful shutdown [P1-T1.4]`

**Deps:** `express@^5`, dev `@types/express@^5`.

**Files:** `src/app.ts`, `src/server.ts`, `src/core/lifecycle.ts`, `src/routes.ts`, `src/modules/system/{system.controller.ts, system.routes.ts}`, `src/index.ts` (update), tests (`src/app.test.ts`, `src/core/lifecycle.test.ts`, `tests/http/system.test.ts`).

1. `createApp({ env, logger })` (pure, no listening, no I/O): `app.disable('x-powered-by')` → `requestId` → `httpLogger` → _(T1.6 security slot: helmet, cors, rate limit — leave a clearly marked place)_ → `express.json({ limit: '1mb' })` → `express.urlencoded({ extended: false, limit: '100kb' })` → `app.use('/api/v1', apiRouter)` → `notFound` → `errorHandler`. Return `app`.
2. `routes.ts`: `createApiRouter()` mounting module routers: `router.use('/system', systemRouter)`.
3. **System module:** `system.controller.ts` → `getSystemInfo(req, res)` → `ok(res, getAppInfo())`; `system.routes.ts` → `GET /info`. Response must match `AppInfoSchema` (test parses the body with it). OpenAPI path already registered — no spec change expected (`openapi:check` must stay green).
4. `lifecycle.ts`: `createLifecycle(logger)` → `{ onShutdown(name, fn, order = 100), shutdown(reason, exitCode = 0), installSignalHandlers() }`. Hooks run **sequentially by ascending order**, each awaited, errors logged and continue; overall **15 s hard timeout** → force `process.exit(1)`; idempotent (second call no-op). `installSignalHandlers()` handles `SIGTERM`, `SIGINT` (→ exit 0) and `unhandledRejection`, `uncaughtException` (→ log fatal, exit 1). Make `exit` injectable for tests.
5. `server.ts`: `startServer()` → `getEnv()` → `getLogger()` → `createApp` → `http.createServer(app)` → `listen(env.PORT)` → log `API listening on http://localhost:<port>` → register shutdown hook `http` (order 10): `server.close()` + `server.closeIdleConnections()`, after 5 s `server.closeAllConnections()` → `installSignalHandlers()`. Return `{ server, lifecycle }`. (Later tasks register `ws` 20, `queues` 30, `redis` 40, `mongo` 50.)
6. `index.ts`: keep `getAppInfo` export (tests use it); entry: `if (require.main === module) { startServer().catch((err) => { console.error(err); process.exit(1); }) }` — drop the hello `console.info`. EnvValidationError → print message only and exit 1.
7. **Tests:** Supertest on `createApp(testEnv, silentLogger)`: `GET /api/v1/system/info` → 200, `{ success: true, data }`, `AppInfoSchema.parse(data)` OK, `X-Request-Id` header present; unknown route → 404 envelope `RESOURCE_NOT_FOUND`; `x-powered-by` absent; malformed JSON → 400 `REQUEST_MALFORMED`. Lifecycle unit tests: ordering, error in one hook doesn't stop others, timeout path, idempotency.
8. **Manual verify (record in report):** `npm run dev` → `curl -s localhost:5100/api/v1/system/info` → envelope; `Ctrl-C` → logs show shutdown hook `http` then exit 0. Use a background process + `kill -INT`, and make sure nothing is left running on 5100.

---

## T1.5 — Validation middleware + shared schemas → `feat(validation): add zod request validation and shared schemas [P1-T1.5]`

**Deps:** `libphonenumber-js`.

**Files:** `src/shared/middlewares/validate.ts`, `src/shared/validation/schemas.ts`, `src/shared/validation/zod-errors.ts`, tests.

1. `zod-errors.ts`: `zodIssuesToDetails(issues)` → `[{ path: 'variables.amount', message }]` (path joined with `.`; root → `''`).
2. `validate.ts`:
   - `validate({ body?, query?, params? })` middleware: `safeParse` each part; collect all issues (prefix path with `body.` / `query.` / `params.`); fail → `throw new ValidationError(details)` (→ 422 `VALIDATION_FAILED`); success → `req.valid = { body, query, params }` (parsed/coerced values). **Never assign `req.query`** (Express 5 getter).
   - Typed helper: `handle(schemas, async ({ req, res, body, query, params }) => …)` returning a `RequestHandler[]` (`[validate(schemas), wrapped]`) where `body/query/params` are typed via `z.infer`. Document usage in `src/README.md`.
3. `schemas.ts` (use `z` from `src/shared/openapi/zod.ts` so they can be registered later):
   - `ObjectIdSchema` — 24 hex chars.
   - `PaginationQuerySchema` — `page` coerce int ≥ 1 default 1; `limit` coerce int 1–100 default 20 (101 → error).
   - `CursorQuerySchema` — `cursor` optional base64url string; `limit` 1–100 default 50.
   - `sortSchema(allowlist, defaultSort = '-createdAt')` — parses `-createdAt,name` → `[{ field, direction: 'asc' | 'desc' }]`; unknown field → issue; duplicates rejected.
   - `PhoneE164Schema` — accepts `98765 43210`, `+91 98765-43210`, `09876543210` → normalises to `+919876543210` (default region `IN`, `libphonenumber-js` `parsePhoneNumberFromString` + `isValid()`); invalid → `Invalid phone number`.
   - `MoneyMicrosSchema` — integer ≥ 0 and ≤ `Number.MAX_SAFE_INTEGER`.
   - `strictQuery(shape)` — `z.strictObject(shape)` so unknown query params fail (api.md §8).
4. Update `maskPhone` (T1.2) to use libphonenumber-js for country-code-aware masking (keep tests green, add cases for +1 / +44).
5. **Tests:** every schema (valid / invalid / defaults / coercion), middleware 422 envelope with prefixed paths, unknown query param rejected, `req.valid` populated, `req.query` untouched, typed `handle()` end-to-end via a tiny test router + Supertest.

---

## T1.6 — Security middlewares → `feat(security): add helmet, cors allowlist, body limits and rate limiting [P1-T1.6]`

**Deps:** `helmet`, `cors`, dev `@types/cors`, `express-rate-limit`.

**Files:** `src/shared/middlewares/{security.ts, cors.ts, rate-limit.ts}`, wire into `src/app.ts`, tests (`tests/http/security.test.ts` + unit).

1. `app.set('trust proxy', env.TRUST_PROXY)`.
2. **helmet** — API defaults; `contentSecurityPolicy: false` for the JSON API (Swagger route in T1.14 will set its own CSP); keep `noSniff`, `frameguard`, `hsts` (production only), `referrerPolicy: no-referrer`.
3. **CORS** (`cors.ts`): `origin(origin, cb)` → allow when `!origin` (server-to-server / curl) or `env.CORS_ORIGINS.includes(origin)`; otherwise `cb(null, false)` (no headers, no error). `credentials: true`, `methods: GET,POST,PATCH,PUT,DELETE,OPTIONS`, `allowedHeaders: Content-Type, Authorization, X-Request-Id, Idempotency-Key, X-API-Key`, `exposedHeaders: X-Request-Id, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After`, `maxAge: 600`. Preflight → 204.
4. **Body limits** already in T1.4 — make the limits named constants in `src/config/limits.ts` (`JSON_BODY_LIMIT = '1mb'`, `URLENCODED_BODY_LIMIT = '100kb'`) and use them.
5. **Rate limit** (`rate-limit.ts`): `createRateLimiter({ windowMs, limit, keyGenerator?, store?, skip? })` wrapping `express-rate-limit` with `standardHeaders: 'draft-6'`, `legacyHeaders: false`, and a `handler` that sets `Retry-After` and forwards `new RateLimitedError()` to the error handler (so the 429 body is our envelope). `globalRateLimiter` = 300 requests / minute / IP (constants in `limits.ts`), `skip` list for future health routes. Export `strictRateLimiter` preset (e.g. 10 / 15 min) for Phase 2 auth routes (not mounted yet). Add a code comment + PHASE_1_PLAN note: **Redis store plugs in at T1.8**.
6. **Order in `createApp`:** `requestId` → `httpLogger` → `helmet` → `cors` → `globalRateLimiter` → body parsers → routes → notFound → errorHandler.
7. **Tests:**
   - allowed origin → `Access-Control-Allow-Origin` = origin + `Access-Control-Allow-Credentials: true`; disallowed → header absent; preflight `OPTIONS` → 204 with allowed headers.
   - helmet headers (`x-content-type-options: nosniff`, `x-frame-options`), `x-powered-by` absent.
   - JSON body > 1 MB → **413** envelope `PAYLOAD_TOO_LARGE`; malformed JSON → 400 `REQUEST_MALFORMED`.
   - rate limit: app built with a tiny limit (e.g. 2/min) → 3rd request **429** envelope `RATE_LIMITED` + `Retry-After` + `RateLimit-*` headers.
   - `trust proxy` honoured (with `TRUST_PROXY=1`, `X-Forwarded-For` changes the rate-limit key).

---

## P1-B1-DONE — checkpoint → `docs: mark phase 1 batch 1 complete [P1-B1-DONE]`

1. Full verify: `npm ci && npm run lint && npm run format:check && npm run typecheck && npm test && npm run build && npm run openapi:check`.
2. Manual: `npm run dev` → `curl -si localhost:5100/api/v1/system/info` (200 + `X-Request-Id` + helmet headers) → `curl -si localhost:5100/nope` (404 envelope) → `kill -INT` → clean shutdown; port 5100 free afterwards.
3. Secret scan: `grep -rnE "sk-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----" --exclude-dir=node_modules --exclude-dir=.git .` → 0.
4. Docs:
   - `docs/phases/PHASE_1_TASKS.md` → T1.1–T1.6 `[x]`.
   - `docs/phases/PHASE_1_PLAN.md` → note under T1.4/T1.9: system info route moved to T1.4; under T1.6/T1.8: Redis rate-limit store plugs in at T1.8; changelog line at the end.
   - `src/README.md` → new files (`app.ts`, `server.ts`, `routes.ts`, `core/lifecycle.ts`, `config/env.ts`, `config/limits.ts`, `shared/*`), request pipeline order, how to write a route with `handle()`.
   - `README.md` → "Running the API" (`npm run infra:up` not needed yet; `npm run dev` → `http://localhost:5100/api/v1/system/info`), new deps in "Install scripts" if any, env table complete.
   - `CHANGELOG.md` → `[Unreleased]` → "Phase 1 · Batch 1 (T1.1–T1.6)".
5. Commit `[P1-B1-DONE]`. No push / merge.

---

## FINAL REPORT (chat me, Hinglish)

1. Summary per task (✅ / ⚠️ / ❌ + 1 line).
2. `git log --oneline` of this batch.
3. Installed versions (express, pino, pino-http, pino-pretty, helmet, cors, express-rate-limit, libphonenumber-js) + any `allowScripts` changes.
4. Deviations from this prompt / plan and why.
5. Verification results (each VERIFY + manual curl/shutdown output summary).
6. Test count before → after.
7. Open items for Batch 2 (T1.7–T1.11).

---

## MUST-NOT-MISS CHECKLIST

- [ ] Branch `feature/phase-1-foundation`; one commit per task with `[P1-T1.x]`; hooks pass; no push/merge/tag
- [ ] No `dotenv`; scripts use `--env-file-if-exists=.env`; all env access via `src/config/env.ts`
- [ ] Env errors show **names only**, never values (tested)
- [ ] Production rules: JWT secrets ≥ 32 chars & not `change-me`, `ENCRYPTION_KEY` = 32 bytes base64, `CORS_ORIGINS` required
- [ ] `TRUST_PROXY` + `CLIENT_SSH_KEY_PATH` added to env schema, `.env.example`, README table
- [ ] `X-Request-Id` validated/generated and echoed; every log line has `requestId`; query strings and bodies never logged; redaction tested
- [ ] `ERROR_CODES` ≡ `error-codes.md` (doc-sync test)
- [ ] 5xx never exposes internal messages; parse errors → 400, too large → 413
- [ ] Express 5: `req.valid` used, `req.query` never reassigned
- [ ] `GET /api/v1/system/info` returns the envelope and matches `AppInfoSchema`; `openapi:check` green
- [ ] Graceful shutdown: ordered hooks, 15 s hard timeout, signals + fatal handlers, port freed (verified manually)
- [ ] Shared schemas: ObjectId, pagination (max 100), cursor, sort allowlist, E.164 phone (IN default), money micros, strict query
- [ ] helmet, CORS allowlist (no headers for unknown origin), body limits constants, rate limiter factory (`draft-6` headers, envelope 429), `trust proxy`
- [ ] Redis rate-limit store deferred to T1.8 — documented
- [ ] Tests for every task; Supertest for HTTP behaviour
- [ ] `src/README.md`, `README.md`, PHASE_1_TASKS, PHASE_1_PLAN, CHANGELOG updated
- [ ] No frontend / Docker / client-server / AutoChatix changes
