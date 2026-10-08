# P1 · BATCH 3 RUN — Email, API docs, frontend foundation, e2e + Phase 1 sign-off (T1.13 → T1.16) — Autonomous Run Prompt

> **HOW TO RUN (ise paste karo):**
> `cell-ai-voicebot-backend/docs/prompts/PHASE_1_BATCH_3_PROMPT.md padho aur T1.13 se P1-B3-DONE tak SAARE tasks step by step autonomously implement karo. Bich me koi question mat poochho, permission mat maango — saare decisions is prompt me pre-made hain. Har task ke baad verify + commit (tag [P1-T1.x]). Koi push / merge NAHI. Ant me P1-B3-DONE checkpoint + Phase 1 sign-off + final report.`
>
> **Claude Code "accept edits" mode me chalao.** Working directory: `/Users/lalitbansal/Documents/cell-ai-voicebot`. **Docker Desktop chalu hona chahiye** (`open -a Docker`).

---

## 0. CONTEXT (verified facts — dobara derive mat karna)

**Batch 1 + 2 done** on backend branch **`feature/phase-1-foundation`** (last commit `bd295e2 [P1-B2-DONE]`, **248 tests**, 29 files). Frontend repo (`cell-ai-voicebot-frontend`) is on **`main` = `feature/phase-0-setup` = `d956bbf`** — **no Phase 1 work yet**.

**Pehle padho:** [`docs/phases/PHASE_1_PLAN.md`](../phases/PHASE_1_PLAN.md) (T1.13–T1.16 + changelog notes), [`src/README.md`](../../src/README.md) (pipeline, startup/shutdown order), conventions [`api.md`](../conventions/api.md), [`websocket.md`](../conventions/websocket.md) (§2–§7, §10), [`error-codes.md`](../conventions/error-codes.md), [`data.md`](../conventions/data.md), [`code-style.md`](../conventions/code-style.md), [`secrets.md`](../conventions/secrets.md), ADRs 0012 (frontend state), 0023, 0028 (ports), 0029 (OpenAPI types). Frontend: `src/README.md`, `README.md`.

**What exists (use it, don't rebuild):**

| File / thing                                    | Provides                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config/env.ts`                             | zod env. **Already has** `SMTP_HOST` (optional), `SMTP_PORT` (default 587), `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` — unused so far. Production checks via `check(name, msg, cond)` (~line 179)                                                                                                   |
| `src/server.ts`                                 | `startServer(): Promise<{ server, lifecycle }>` — uses `getEnv()` / `getLogger()`, Mongo → Redis → `createApp` → listen → workers (`WORKERS_ENABLED`) → realtime → hooks → `installSignalHandlers()`                                                                                            |
| `src/app.ts`                                    | `createApp({ env, logger, rateLimit?, rateLimitStore?, readiness?, storage? })`; root routes `/health`, `/ready`, `/files/*` (local), then `/api/v1`                                                                                                                                            |
| `src/routes.ts`                                 | `createApiRouter()` — `/system` only                                                                                                                                                                                                                                                            |
| `src/core/lifecycle.ts`                         | `onShutdown(name, fn, order)`; orders http 10 · ws 20 · queues 30 · redis 40 · mongo 50                                                                                                                                                                                                         |
| `src/core/queues/*`                             | `createRedis`, `getAppRedis(url, logger)`, `createSubscriber`, `pingRedis`, `closeAllRedis`; `createQueue(name, { redisUrl, logger, prefix? })`, `createWorker(...)`, `closeAllQueues`, `DEFAULT_QUEUE_PREFIX = 'cav'`, `QUEUE_DEFAULT_JOB_OPTIONS`; `QUEUES = { system }`; `startSystemWorker` |
| `src/core/realtime/*`                           | `createRealtime`, `setRealtime/getRealtime`, `WsTicketService(redis).issue({ userId, accountId, ... })`, `WS_EVENTS_PATH`, `WS_CLOSE`, `WsEventMap`, `createEnvelope`                                                                                                                           |
| `src/shared/utils/mask.ts`                      | `maskEmail`, `maskPhone`                                                                                                                                                                                                                                                                        |
| `src/shared/app-info.ts`                        | `getAppInfo()` (name, version from package.json, env …)                                                                                                                                                                                                                                         |
| `src/shared/middlewares/security.ts`            | helmet with **CSP off** (comment: "Swagger UI route (T1.14) sets its own CSP")                                                                                                                                                                                                                  |
| `src/shared/middlewares/cors.ts`                | `CORS_EXPOSED_HEADERS` (starts with `X-Request-Id`, `RateLimit-*` — verify the rest in T1.15)                                                                                                                                                                                                   |
| `src/openapi.ts`                                | `buildOpenApiDocument()` — **`servers` hardcoded localhost, `version` from `npm_package_version` (undefined under `node dist`) → fix in T1.14**                                                                                                                                                 |
| `openapi/openapi.json`                          | paths: `/health`, `/ready`, `/api/v1/system/info`; `ErrorEnvelope.error.code` is a plain `string` (not an enum)                                                                                                                                                                                 |
| `tests/helpers/*`                               | `testEnv(overrides)`, `buildTestApp`, `startTestMongo()` (shared replica set via `tests/setup/mongo.global.ts`), `requireRedis()`, `uniquePrefix(name)`, `flushPrefix(client, prefix)`                                                                                                          |
| `tests/http/*`                                  | errors, health, idempotency, rate-limit-redis, request-logging, security, system, validation                                                                                                                                                                                                    |
| `docker-compose.yml`                            | project `cell-ai-voicebot`: `cav-mongo` (27018), `cav-redis` (6380). Ports **1025 / 8025 are free** on this machine                                                                                                                                                                             |
| `.github/workflows/ci.yml` (backend)            | `verify` job (Redis service) runs `npm ci, lint, format:check, typecheck, npm test, build, openapi:check`                                                                                                                                                                                       |
| **Frontend** `src/services/api/client.ts`       | `apiClient = axios.create({ baseURL: VITE_API_URL ?? '/api/v1', timeout: 15_000, withCredentials: true })` + `TODO (Phase 1): ApiError` + two Phase 2 TODOs                                                                                                                                     |
| Frontend `src/services/api/{system,types}.ts`   | `getSystemInfo()`, `AppInfo`, `ApiErrorEnvelope`, `SuccessEnvelope<T>`                                                                                                                                                                                                                          |
| Frontend `src/app/{query-client,providers}.tsx` | `createQueryClient()` (retry 1, staleTime 30 s); providers: MUI theme, React Query, `SnackbarProvider maxSnack=3`, devtools in DEV                                                                                                                                                              |
| Frontend `src/test/render.tsx`                  | `renderWithProviders({ route, routes })` (no SnackbarProvider today)                                                                                                                                                                                                                            |
| Frontend `vite.config.ts`                       | port 3100, proxy `/api` → 5100, `/ws` → ws://5100 (`ws: true`); vitest jsdom                                                                                                                                                                                                                    |
| Frontend `.env.example`                         | `VITE_API_URL=/api/v1`, `VITE_WS_URL=ws://localhost:3100/ws`, `VITE_APP_NAME`                                                                                                                                                                                                                   |
| Frontend scripts                                | `dev, build (tsc -b && vite build), typecheck, lint, format:check, test, test:coverage, gen:api`. **No `CHANGELOG.md`** yet. CI runs `npm ci, lint, format:check, typecheck, test, build`                                                                                                       |

**Verified on 2026-10-08:**

| Package / image        | Version | Note                                                                                                             |
| ---------------------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| `nodemailer`           | 10.0.16 | **ships its own types** (`dist/cjs/nodemailer.d.ts`), engines node ≥ 20 → **do NOT install `@types/nodemailer`** |
| `smtp-server` (devDep) | 3.19.18 | in-process SMTP server for tests (depends on nodemailer 10.0.16)                                                 |
| `swagger-ui-dist`      | 5.33.1  | static Swagger UI assets                                                                                         |
| `swagger-ui-express`   | 5.0.1   | **NOT used** — last release 2024-05, injects inline init script (would need CSP `unsafe-inline` for scripts)     |
| `axllent/mailpit`      | v1.31.4 | local dev SMTP inbox (pin exact tag)                                                                             |

Machine: Docker running; **other containers (Supabase stack: ports 5432/5433/6543/8000…) must never be touched** — only `npm run infra:*` (project `cell-ai-voicebot`).

---

## 1. LOCKED DECISIONS

| Topic                      | Decision                                                                                                                                                                                                                                                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope                      | Only T1.13–T1.16 + P1-B3-DONE + Phase 1 sign-off. **No** auth, users, ticket endpoint, business modules.                                                                                                                                                                                                                                      |
| Branches                   | Backend: `feature/phase-1-foundation` (continue). Frontend: **create `feature/phase-1-foundation` from `main`** (`d956bbf`).                                                                                                                                                                                                                  |
| Email driver               | New env **`EMAIL_DRIVER`** = `smtp` \| `log`. Default: `smtp` if `SMTP_HOST` set, else `log`. **Production requires `smtp`** (fail fast).                                                                                                                                                                                                     |
| SMTP security              | New env **`SMTP_SECURE`** (boolean, optional) — unset → `SMTP_PORT === 465`. Production → `requireTLS: true` when not `secure`.                                                                                                                                                                                                               |
| Email sending              | Through BullMQ queue **`email`** (request never waits on SMTP). Job data = `{ template, to, vars }` only (no rendered HTML). `attempts: 5`, exponential backoff 5 s, `removeOnComplete: true`, `removeOnFail: { age: 86_400 }`. Permanent SMTP errors (5xx `responseCode`) → `UnrecoverableError` (no retry). Dedupe via `jobId = dedupeKey`. |
| Templates                  | Plain TS functions → `{ subject, html, text }`; **every interpolated value HTML-escaped**; shared layout; text part always present. Typed registry.                                                                                                                                                                                           |
| Email logging              | Masked recipient (`maskEmail`), subject, template key, messageId. **Body never logged** (Phase 2 bodies contain OTP / reset links).                                                                                                                                                                                                           |
| SMTP at startup            | `verify()` non-blocking → warn on failure. **`/ready` does NOT depend on email.**                                                                                                                                                                                                                                                             |
| Shutdown orders            | http 10 → ws 20 → queues 30 → **email 35 (new)** → redis 40 → mongo 50.                                                                                                                                                                                                                                                                       |
| Local SMTP                 | **Mailpit** in docker-compose (`cav-mailpit`, `127.0.0.1:1025` SMTP, `127.0.0.1:8025` UI). Tests use in-process `smtp-server` (no Mailpit in CI).                                                                                                                                                                                             |
| OpenAPI JSON               | `GET /api/v1/openapi.json` **always on** (incl. production — public API in Phase 10 needs the contract; it holds no secrets). `servers = [{ url: env.APP_URL }]`. Not itself listed in the spec.                                                                                                                                              |
| Swagger UI                 | `/api/docs`, gated by new env **`API_DOCS_ENABLED`** (default `true` outside production, `false` in production). Own HTML + own `init.js` + `swagger-ui-dist` static assets. **Route-level strict CSP, no inline scripts.**                                                                                                                   |
| Frontend errors            | Every failure → typed `ApiError` via axios response interceptor. Client-only codes `NETWORK_ERROR`, `TIMEOUT`, `REQUEST_CANCELED`, `UNKNOWN_ERROR` (documented in error-codes.md).                                                                                                                                                            |
| Retry policy (React Query) | Queries: no retry on 4xx; network / timeout / 5xx / unknown → up to **2** retries. Mutations: **0**.                                                                                                                                                                                                                                          |
| Global toast               | Only for unexpected errors (`status >= 500`, network, timeout, unknown). 4xx handled by the screen. `meta: { silent: true }` suppresses. `preventDuplicate`.                                                                                                                                                                                  |
| WS client                  | Framework-agnostic `RealtimeClient` + `RealtimeProvider` + hooks. **Ticket provider arrives in Phase 2** → provider mounted but **disabled** while `getTicket` is `null`. DEV-only page `/dev/realtime` for manual testing with `npm run ws:dev-ticket`.                                                                                      |
| WS URL                     | `VITE_WS_URL` = **base** (`ws://localhost:3100/ws`); client appends `/events?ticket=…`. Unset → derived from `window.location` (`ws:`/`wss:` + host + `/ws`).                                                                                                                                                                                 |
| Frontend test deps         | **No new test dependencies** — axios custom `adapter` for HTTP fakes, hand-written `FakeWebSocket`.                                                                                                                                                                                                                                           |
| E2E                        | `startServer(options)` becomes injectable (env, logger, signal handlers, queue prefix, `PORT=0`) — **production behaviour unchanged**.                                                                                                                                                                                                        |
| Coverage gate              | `vitest` thresholds = measured value **rounded down to the nearest 5** (backend; frontend too). CI runs `npm run test:coverage`.                                                                                                                                                                                                              |
| New ADR                    | **ADR 0030 — Email delivery** (SMTP via nodemailer, queued, Mailpit for dev).                                                                                                                                                                                                                                                                 |
| Version rule               | Exact versions above; no `--force` / `--legacy-peer-deps`; after each install `npm approve-scripts --allow-scripts-pending`, decide, record in README "Install scripts".                                                                                                                                                                      |

---

## 2. RULES OF ENGAGEMENT

1. **No questions / no permission requests.** Safe, convention-consistent choice → report it as a deviation.
2. **Git:** one commit per task per repo — Conventional Commit + `[P1-T1.x]` (T1.15 allows the commits listed there). Hooks must pass (**no `--no-verify`**). **No push / merge / tag.** Commit message footer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
3. **Verify after every task — each command separately, read its output** (never hide a step behind `>/dev/null &&`; never trust a background exit code without reading the output):
   - Backend: `npm run lint` · `npm run format:check` · `npm run typecheck` · `npm test` · `npm run build` · `npm run openapi:check`
   - Frontend: `npm run lint` · `npm run format:check` · `npm run typecheck` · `npm test` · `npm run build`
   - Use **`npm run typecheck`** (not `npx tsc` — npx was very slow on this machine). Infra must be up for backend tests (`npm run infra:up`).
4. **Tests are part of every task.** Real Mongo (memory server, shared replica set) + real Redis (Docker) as before.
5. **No secrets** — fixtures use obvious fakes (`smtp-user`, `smtp-pass`, `user@example.com`). Never log SMTP credentials, email bodies or full URIs.
6. **Every new env var** → `src/config/env.ts` (+ tests) + `.env.example` (comment + phase) + README env table + local `.env`.
7. **OpenAPI:** route changes → schemas → `npm run gen:openapi` → commit `openapi/openapi.json` in the same commit.
8. **Docs** stay in sync in the same commit (`src/README.md`, `README.md`, conventions, ADRs).
9. **Docker:** only `npm run infra:*` / `docker compose` **inside the backend repo** for project `cell-ai-voicebot`; never stop/remove other containers or volumes.
10. Frontend `VITE_*` vars are public — never put a secret there.

---

## 3. RESUME SAFETY

- Backend: `git branch --show-current` → `feature/phase-1-foundation`; `git log --oneline -15` → continue after the last `[P1-T1.x]`.
- Frontend: if `feature/phase-1-foundation` exists → check it out and continue; else create it from `main`.
- `npm run infra:up` → `npm ci` → lint → typecheck → `npm test` must be green (both repos) before continuing.

---

# ═══════════ TASKS ═══════════

## T1.13 — Email service → `feat(email): add smtp email service with templates and queue [P1-T1.13]`

**Deps:** `npm i nodemailer@10.0.16` · `npm i -D smtp-server@3.19.18` (+ `@types/smtp-server` **only if** `smtp-server` ships no types — check `npm view smtp-server types` first; if needed, install the latest `@types/smtp-server`). Then `npm approve-scripts --allow-scripts-pending` → decide → README.

**Files:** `src/core/email/{email.types.ts, smtp.provider.ts, log.provider.ts, memory.provider.ts, email.service.ts, index.ts}`, `src/core/email/templates/{escape.ts, layout.ts, system-test.ts, index.ts}`, `src/core/queues/workers/email.worker.ts`, `src/core/queues/names.ts`, `src/config/env.ts`, `src/server.ts`, `src/core/lifecycle.ts` (comment), `scripts/email-test.ts`, `docker-compose.yml`, tests, docs.

1. **Env** (`env.ts` + `env.test.ts`)
   - `EMAIL_DRIVER: z.enum(['smtp','log']).optional()` → resolved: explicit value, else `SMTP_HOST ? 'smtp' : 'log'`.
   - `SMTP_SECURE`: `'true'|'false'` → boolean, optional → resolved `SMTP_SECURE ?? SMTP_PORT === 465`.
   - Checks (same `check()` style, names-only errors):
     - driver `smtp` → `SMTP_HOST` required, `MAIL_FROM` required **in production** (dev default `Cell AI Voicebot <no-reply@localhost>`).
     - `SMTP_USER` and `SMTP_PASS`: both set or both empty → `"SMTP_USER and SMTP_PASS must be set together"`.
     - production → `EMAIL_DRIVER` must resolve to `smtp` → `"EMAIL_DRIVER=log is not allowed in production (set SMTP_HOST)"`.
   - Tests: defaults (no host → `log`; host → `smtp`), explicit `log` with host, secure auto for 465/587, explicit `SMTP_SECURE`, user/pass pairing, production rules, `MAIL_FROM` dev default.
   - `.env.example` (Email block): add `EMAIL_DRIVER=` (comment: `smtp | log — default: smtp when SMTP_HOST is set; production requires smtp`), `SMTP_SECURE=` (comment: `true for port 465; empty = auto`), comment that local dev uses Mailpit `127.0.0.1:1025`. README env table rows. Local `.env`: `SMTP_HOST=127.0.0.1`, `SMTP_PORT=1025` (no user/pass).
2. **Mailpit** — `docker-compose.yml`:
   ```yaml
   mailpit:
     image: axllent/mailpit:v1.31.4
     container_name: cav-mailpit
     ports: ['127.0.0.1:1025:1025', '127.0.0.1:8025:8025']
     restart: unless-stopped
     healthcheck: { test: ['CMD', '/mailpit', 'readyz'], interval: 5s, timeout: 5s, retries: 10 }
   ```
   (If `/mailpit readyz` is not available in the image, use `wget -qO- http://127.0.0.1:8025/readyz` — verify by running `npm run infra:up` and checking it turns healthy.) Comment header of the compose file updated. **ADR 0028** port table + README infra section: `1025` SMTP, `8025` Mailpit UI.
3. **`email.types.ts`**
   - `EmailAddress = string`; `EmailMessage { to: string; subject: string; html: string; text: string; replyTo?: string }`.
   - `EmailSendResult { messageId: string }`.
   - `EmailProvider { readonly driver: 'smtp' | 'log' | 'memory'; send(msg): Promise<EmailSendResult>; verify(): Promise<boolean>; close(): Promise<void> }`.
   - `EmailPermanentError extends ProviderError` (or flag `permanent: true`) — used by the worker to stop retries.
4. **`smtp.provider.ts`** — `SmtpEmailProvider.fromEnv(env, logger)`:
   - `nodemailer.createTransport({ host, port, secure, auth: user ? { user, pass } : undefined, pool: true, maxConnections: 3, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000, requireTLS: production && !secure })`.
   - `send` → `transporter.sendMail({ from: MAIL_FROM, to, subject, html, text, replyTo })` → `{ messageId }`; log `{ to: maskEmail(to), subject, messageId }` at info.
   - Errors → `responseCode >= 500 && < 600` → `EmailPermanentError`; everything else (ECONNREFUSED, timeouts, 4xx) → `ProviderError` (retryable). **Error messages / logs never include credentials or body.**
   - `verify()` → `transporter.verify()` → `true/false` (catch). `close()` → `transporter.close()`.
5. **`log.provider.ts`** — logs `{ to: maskEmail(to), subject }` + `'email: (log driver) not sent'`; returns `{ messageId: 'log-<random>' }`; `verify()` true. **Never logs html/text.**
6. **`memory.provider.ts`** — `sent: EmailMessage[]`, `clear()`, optional `failWith?: Error` for tests; driver `memory`. (Exported for tests and future dev tooling; not selectable via env.)
7. **Templates** (`templates/`)
   - `escape.ts`: `escapeHtml(value: string)` — `& < > " '` → entities.
   - `layout.ts`: `renderLayout({ title, bodyHtml, appName })` → full HTML (table-based, inline CSS, max-width 600, footer: `appName` + "You received this email because …"); `renderTextLayout(body, appName)`.
   - `system-test.ts`: vars `{ name: string }` → subject `Test email from Cell AI Voicebot`, html + text.
   - `index.ts`: `export interface EmailTemplateVars { 'system.test': { name: string } }`; `export type EmailTemplateKey = keyof EmailTemplateVars`; `renderTemplate<K>(key, vars) → { subject, html, text }`. Comment: Phase 2 adds `auth.verify_email`, `auth.reset_password`, `team.invite`; Phase 4 `wallet.receipt`, `wallet.low_balance`.
8. **`email.service.ts`** — `createEmailService({ provider, queue?, logger })`:
   - `send(message)`: zod-validate `to` (email), reject `subject` containing `\r` or `\n` (`ValidationError`), → `provider.send`.
   - `sendTemplate(key, to, vars)`: render → `send`.
   - `enqueue(key, to, vars, { dedupeKey? })`: validate `to` → `queue.add(key, { template: key, to, vars }, { jobId: dedupeKey, ...EMAIL_JOB_OPTIONS })`. Without a queue (tests / `WORKERS_ENABLED` irrelevant — queue always exists in server) → throw clear error.
   - `EMAIL_JOB_OPTIONS = { attempts: 5, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: true, removeOnFail: { age: 86_400 } }`.
9. **`index.ts`** — `createEmailProvider(env, logger)` (driver switch), `setEmail(service | undefined)`, `getEmail()` (throws `"Email service not initialised"` if unset) — same pattern as realtime.
10. **Queue + worker**
    - `names.ts`: `QUEUES = { system: 'system', email: 'email' }`.
    - `workers/email.worker.ts`: `processEmailJob(provider)(job)` → `renderTemplate(job.data.template, job.data.vars)` → `provider.send({ to, ... })`; `EmailPermanentError` → `throw new UnrecoverableError(message)` (bullmq). `startEmailWorker({ redisUrl, logger, provider, prefix? })` → `createWorker(QUEUES.email, …, { concurrency: 2 })`.
11. **`server.ts`** wiring (after Redis, before `createApp`):
    - `const emailProvider = createEmailProvider(env, logger)`; `void emailProvider.verify().then((ok) => ok ? logger.info('email: smtp ready') : logger.warn('email: smtp verify failed — emails will retry'))` (only for `smtp`).
    - `const emailQueue = createQueue(QUEUES.email, { redisUrl, logger })`; `setEmail(createEmailService({ provider: emailProvider, queue: emailQueue, logger }))`.
    - If `WORKERS_ENABLED` → `startEmailWorker(...)` next to `startSystemWorker`.
    - Hook **`email` (35)** → `emailProvider.close()` + `setEmail(undefined)`.
    - `lifecycle.ts` header comment + `src/README.md` startup/shutdown lines updated with `email 35`.
12. **Script** `scripts/email-test.ts` + npm `"email:test": "tsx --env-file-if-exists=.env scripts/email-test.ts"` → usage `npm run email:test -- you@example.com`; refuses when `NODE_ENV=production`; sends `system.test` **directly** (no queue) via the env provider; prints masked recipient + messageId; closes provider.
13. **Tests** (`tests/email/*.test.ts` + `src/config/env.test.ts`)
    - templates: `escapeHtml` all 5 chars; `renderTemplate('system.test', { name: '<script>x</script>' })` → html contains `&lt;script&gt;`, never `<script>x`; text part non-empty; subject correct.
    - log provider: capture pino destination → contains masked email, subject; **does not contain** html/text body or full address.
    - SMTP provider vs in-process `SMTPServer` (port 0, `authOptional`, `disabledCommands: ['STARTTLS']`, `onData` collects raw):
      - delivers: raw contains `Subject:`, `To:`, `From:` = MAIL_FROM;
      - auth case: server `onAuth` checks fake user/pass → delivered; wrong pass → error, message has no password;
      - server rejects recipient with 550 (`onRcptTo` callback error with `responseCode: 550`) → `EmailPermanentError`;
      - connection refused (closed port) → `ProviderError`, not permanent;
      - `verify()` true against server, false against closed port.
    - service: invalid `to` → `ValidationError`; subject with `\n` → `ValidationError`.
    - queue (real Redis, `uniquePrefix('email')`, `flushPrefix` in `afterAll`): enqueue → worker → memory provider received 1; same `dedupeKey` twice → 1 email; permanent error → `attemptsMade === 1`, job failed; transient error once then success (override `backoff` delay small via job options in test) → delivered; `closeAllQueues` in teardown.
14. **Docs**
    - README: **Email** section (drivers, Mailpit `http://localhost:8025`, `npm run email:test`, production rule, queue + retries, logs never contain bodies); scripts table row; Install scripts note.
    - `src/README.md`: `core/email/` row; `core/queues/` row mentions `email` queue.
    - `docs/conventions/data.md`: PII note — email job data (`to`, vars) lives in Redis until completion (removed on success, failed jobs kept 24 h).
    - **ADR 0030 `docs/adr/0030-email-delivery.md`** (Status accepted · Context · Decision · Consequences · Alternatives: transactional API like SES SDK/Resend → can be a provider later; direct send in request) + ADR README table row.
    - `docs/phases/PHASE_1_PLAN.md` T1.13 steps already listed — no change needed except changelog at checkpoint.
15. Verify (each command) → commit.

---

## T1.14 — OpenAPI served + Swagger UI → `feat(docs): serve openapi spec and swagger ui [P1-T1.14]`

**Deps:** `npm i swagger-ui-dist@5.33.1` (+ `@types/swagger-ui-dist` only if needed for `getAbsoluteFSPath` — check `npm view swagger-ui-dist types`; else declare a tiny module type in `src/@types/swagger-ui-dist.d.ts`). approve-scripts review.

**Files:** `src/openapi.ts`, `scripts/generate-openapi.ts`, `src/modules/docs/{docs.routes.ts, docs.page.ts, openapi.controller.ts}`, `src/routes.ts`, `src/app.ts`, `src/config/env.ts`, `src/shared/middlewares/security.ts` (comment + exported `docsCsp`), tests, docs.

1. **Env** `API_DOCS_ENABLED` (`'true'|'false'`, default `NODE_ENV !== 'production'`) + tests (dev default true, prod default false, prod explicit true) + `.env.example` + README + `.env`.
2. **`buildOpenApiDocument({ serverUrl = 'http://localhost:5100' } = {})`** — `servers: [{ url: serverUrl }]`; `info.version = getAppInfo().version`. `scripts/generate-openapi.ts` keeps the default (committed file stays identical → `openapi:check` green). Unit test: version equals package.json version without `npm_package_version` set.
3. **`GET /api/v1/openapi.json`** — `createOpenApiRouter(env)` mounted in `createApiRouter` (pass env; update signature + callers/tests). Document built **once** (lazy memo) with `serverUrl: env.APP_URL`; response = raw document (**not** wrapped in the success envelope — tools expect plain OpenAPI); `Cache-Control: no-cache`; Express ETag handles 304.
4. **Swagger UI** (`docs.routes.ts`, mounted in `createApp` **before** `/api/v1`, only when `env.API_DOCS_ENABLED`):
   - `docsCsp` (helmet `contentSecurityPolicy({ useDefaults: false, directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], fontSrc: ["'self'", 'data:'], objectSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"] } })`) applied to the docs router only.
   - `GET /api/docs` → `docs.page.ts` HTML: `<link rel="stylesheet" href="/api/docs/assets/swagger-ui.css">`, `<div id="swagger-ui">`, `<script src="/api/docs/assets/swagger-ui-bundle.js">`, `<script src="/api/docs/init.js">`. **No inline script / no inline event handlers.** `<title>Cell AI Voicebot API</title>`.
   - `GET /api/docs/init.js` (`application/javascript`) → `window.ui = SwaggerUIBundle({ url: '/api/v1/openapi.json', dom_id: '#swagger-ui', deepLinking: true, displayRequestDuration: true, tryItOutEnabled: true });`
   - `GET /api/docs/assets/*` → `express.static(swaggerUiDist.getAbsoluteFSPath(), { index: false, maxAge: '1d' })` but **block** `swagger-initializer.js` and `index.html` (404) — they load the Petstore demo.
   - `/api/docs` → also redirect `/api/docs/` to `/api/docs` (or serve same) — pick serving both.
5. `security.ts` comment updated ("docs router sets `docsCsp`"). API routes keep CSP off.
6. **Tests** (`tests/http/docs.test.ts`):
   - `/api/v1/openapi.json` 200, `openapi === '3.1.0'`, paths include `/health`, `/ready`, `/api/v1/system/info`; `servers[0].url === env.APP_URL`; `info.version` = package version; `Cache-Control: no-cache`; second request with `If-None-Match` → 304.
   - `/api/docs` 200 `text/html`; `content-security-policy` contains `script-src 'self'` and not `unsafe-inline` within script-src; HTML has no `<script>` with inline body (regex `<script>(?!\s*</script>)` absent / every script has `src`).
   - `/api/docs/assets/swagger-ui-bundle.js` 200 JS content-type; `/api/docs/assets/swagger-initializer.js` 404; `/api/docs/init.js` 200 contains `/api/v1/openapi.json`.
   - `API_DOCS_ENABLED=false` → `/api/docs` 404 envelope; openapi.json still 200.
   - Production env with defaults → docs 404; with `API_DOCS_ENABLED=true` → 200.
   - Regression: `/api/v1/system/info` response has **no** `content-security-policy` header.
7. **Docs:** README **API docs** section (`http://localhost:5100/api/docs`, also `http://localhost:3100/api/docs` via Vite proxy; spec URL; production flag); `api.md` note (spec endpoint, not enveloped); ADR 0029 note (spec served + `swagger-ui-dist` choice, why not swagger-ui-express); `src/README.md` (`modules/docs/` row + pipeline step).
8. `npm run gen:openapi` (should be unchanged; if changed, commit) → verify (each) → commit.

---

## T1.15 — Frontend: ApiError + query policy + realtime client + system info widget

### Backend part → `docs(conventions): add client-only error codes and ws client notes [P1-T1.15]`

1. `docs/conventions/error-codes.md`: new section **"Client-only codes (frontend, never sent by the server)"**: `NETWORK_ERROR` (no response), `TIMEOUT` (request timed out), `REQUEST_CANCELED` (aborted), `UNKNOWN_ERROR` (response without a valid envelope, e.g. proxy 502 HTML). Make sure the backend ERROR_CODES sync test ignores this section (adjust the parser if needed; test must still pass).
2. `src/shared/middlewares/cors.ts`: ensure `CORS_EXPOSED_HEADERS` contains `X-Request-Id`, `RateLimit-*`, **`Retry-After`**, **`Idempotent-Replayed`**; add missing + test in `tests/http/security.test.ts`.
3. `docs/conventions/websocket.md`: §11 **"Frontend client"** — states, ping 25 s, backoff + full jitter 1→30 s, close-code table (below), resubscribe, dedupe, refetch on reconnect, ticket provider from Phase 2.
4. Verify (each) → commit.

### Frontend part

0. `git checkout -b feature/phase-1-foundation main`; baseline `npm ci` → lint → format:check → typecheck → test → build green.

**Commit 1 → `chore(api): regenerate api types [P1-T1.15]`** — `npm run gen:api` (reads `../cell-ai-voicebot-backend/openapi/openapi.json`) → `schema.gen.ts` now has `/health`, `/ready`; fix any type fallout; verify; commit.

**Commit 2 → `feat(api): add ApiError, query error policy, realtime client and system info widget [P1-T1.15]`**

1. **`src/services/api/errors.ts`**
   - `type ApiErrorKind = 'http' | 'network' | 'timeout' | 'canceled' | 'unknown'`; `CLIENT_ERROR_CODES = { NETWORK_ERROR, TIMEOUT, REQUEST_CANCELED, UNKNOWN_ERROR } as const`.
   - `class ApiError extends Error { name = 'ApiError'; status: number /* 0 when no response */; code: string; details: { path: string; message: string }[]; requestId?: string; retryAfterSec?: number; kind: ApiErrorKind }`.
   - `toApiError(err: unknown): ApiError`:
     - already `ApiError` → return as is;
     - `axios.isCancel(err)` / `code === 'ERR_CANCELED'` → `REQUEST_CANCELED`, kind `canceled`;
     - `code === 'ECONNABORTED' || 'ETIMEDOUT'` → `TIMEOUT`;
     - axios error **with** `response`: body passes a small zod schema `{ success: false, error: { code: string, message: string, details?: [...], requestId?: string } }` → kind `http` with those fields; otherwise `UNKNOWN_ERROR`, kind `unknown`, generic message, keep `status`;
     - axios error **without** response → `NETWORK_ERROR`;
     - anything else → `UNKNOWN_ERROR`.
     - `requestId` fallback from `response.headers['x-request-id']`; `retryAfterSec` from `retry-after` (seconds) on 429.
   - `isApiError(e)`, `getErrorMessage(e)` (network → "Can't reach the server. Check your connection.", timeout → "The server took too long to respond.", canceled → "Request was canceled.", unknown → "Something went wrong. Please try again.", http → envelope message), `isUnexpected(e)` (`kind !== 'http' || status >= 500`).
   - `applyFieldErrors(setError, err)` → for each `details` item call `setError(path, { type: 'server', message })`; returns `true` if any applied (react-hook-form `UseFormSetError` type).
2. **`client.ts`** — `apiClient.interceptors.response.use((r) => r, (e) => Promise.reject(toApiError(e)))`; remove `TODO (Phase 1)`; keep Phase 2 TODOs. Add `unwrap = async <T>(p: Promise<AxiosResponse<SuccessEnvelope<T>>>) => (await p).data.data`. `system.ts` uses `unwrap`.
3. **`query-client.ts`** — `createQueryClient({ notify }: { notify?: (message: string, variant: 'error') => void } = {})`:
   - `shouldRetry(failureCount, error)` exported: `ApiError` with `kind === 'http' && status < 500` → false; `canceled` → false; else `failureCount < 2`.
   - queries `{ staleTime: 30_000, refetchOnWindowFocus: false, retry: shouldRetry }`, mutations `{ retry: 0 }`.
   - `queryCache: new QueryCache({ onError: (e, q) => report(e, q.meta) })`, `mutationCache: new MutationCache({ onError: (e, _v, _c, m) => report(e, m.meta) })`; `report` → skip if `meta?.silent`, skip if not `isUnexpected`, else `notify(\`${getErrorMessage(e)}${e.requestId ? \` (Ref: ${e.requestId.slice(0, 8)})\` : ''}\`, 'error')`.
   - Declare React Query `Register` meta type `{ silent?: boolean }` (`src/types/react-query.d.ts`).
   - `providers.tsx`: `createQueryClient({ notify: (m, v) => enqueueSnackbar(m, { variant: v }) })` (notistack `enqueueSnackbar` export); `SnackbarProvider preventDuplicate`.
4. **Realtime** — `src/services/realtime/`:
   - `events.ts`: `WsEventEnvelope<T>`, typed `WsEventMap` mirroring backend `src/core/realtime/events.ts` / websocket.md §5 (all 12 types), `WsEventType`, `WsClientMessage` (`ping`, `subscribe`, `unsubscribe`), `WsServerMessage` (`pong`, `error`?, envelopes). Header comment: **"Keep in sync with websocket.md §5 and backend src/core/realtime/events.ts."**
   - `url.ts`: `buildWsUrl(ticket, base = import.meta.env.VITE_WS_URL)` → `${base ?? derived}/events?ticket=${encodeURIComponent(ticket)}`; derived = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`.
   - `ws-client.ts` — `class RealtimeClient`:
     - ctor `{ getTicket: () => Promise<string>; url?: (ticket) => string; WebSocketImpl?: typeof WebSocket; random?: () => number; onReconnected?: () => void; logger?: Pick<Console, 'debug' | 'warn'> }`.
     - `status`: `'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'`; `onStatus(listener)`; `lastError?`.
     - `connect()` / `disconnect()` (disconnect → close 1000, no reconnect, clears timers).
     - On open: reset attempt counter + auth-failure counter, send `subscribe` with all active topics, start ping interval **25 000 ms** (`{ type: 'ping' }`); if this was a reconnect call `onReconnected`.
     - Backoff: `delay = random() * min(30_000, 1_000 * 2 ** attempt)` (full jitter), `attempt++`.
     - Close handling: `1000` → `closed` (no reconnect); `4003` → `closed` + `lastError='forbidden'`; `4001`/`4010` → new ticket + reconnect, **3 consecutive** → `closed` + `lastError='unauthorized'`; `4008`, `4009`, `1001`, `1006`, other → reconnect with backoff (`4009` uses max delay 30 s).
     - `getTicket()` rejects → `status = 'idle'`, `lastError = 'ticket_unavailable'`, **no retry loop**.
     - `subscribe(topic)` / `unsubscribe(topic)` reference-counted; only send on 0→1 / 1→0 while open; returns an unsubscribe fn.
     - `on(type, handler)` typed → returns off fn; `onAny(handler)` for the DEV page.
     - Dedupe by `id` (keep last 200 ids); ignore `pong`; unknown `type` → `logger.debug` (DEV) and still delivered to `onAny`; invalid JSON → ignore + debug.
     - `window` `online` → if `reconnecting`/`idle-after-failure`, reconnect immediately (reset delay); listener removed in `disconnect()`.
   - React (`src/services/realtime/RealtimeProvider.tsx`, `hooks.ts`):
     - `RealtimeProvider({ getTicket: (() => Promise<string>) | null, children })` — creates one client when `getTicket` non-null, `connect()` in effect, `disconnect()` in cleanup (StrictMode safe); `onReconnected` → `queryClient.invalidateQueries()`.
     - `useWsStatus()`, `useWsEvent(type, handler)` (handler via ref, stable subscription), `useWsTopic(topic | null)`.
     - Mounted in `providers.tsx` with `getTicket={null}` + comment `// Phase 2: ticket provider (POST /api/v1/ws/tickets)`.
5. **DEV page** `src/pages/dev/RealtimeDevPage.tsx` at `/dev/realtime`, route added **only when `import.meta.env.DEV`** (so it is tree-shaken from production): text field for a full `ws://…?ticket=` URL (from `npm run ws:dev-ticket`), Connect/Disconnect, status chip, subscribe topic field, event log (last 50, newest first). Uses `RealtimeClient` directly with a one-shot ticket provider (parses `ticket` from the pasted URL).
6. **System info widget** — `src/features/system/{api.ts (useSystemInfo, key ['system','info']), SystemInfoCard.tsx}`: loading → MUI `Skeleton`; success → name, version, environment (and anything else `AppInfo` has); error → `Alert` with `getErrorMessage`, `Ref: <requestId>` when present, **Retry** button (`refetch`). Query uses `meta: { silent: true }` (the card shows the error itself). `HomePage`: subtitle **"Phase 1 — foundation ready"** + `<SystemInfoCard />`.
7. **Env + docs (frontend)**
   - `.env.example`: `VITE_WS_URL` comment → "WebSocket **base** URL (client appends `/events`); empty = derived from the page origin".
   - `vite-env.d.ts`: `VITE_WS_URL?` and `VITE_API_URL?` optional (they have fallbacks).
   - `src/README.md`: `services/api/` (client + errors + generated types), `services/realtime/`, `features/system/`, `pages/dev/` (DEV only) rows; rules: "use `ApiError` / `getErrorMessage`, never read `axios` errors directly"; "`meta.silent` when the screen shows its own error".
   - `README.md`: Phase 1 notes (API errors, realtime, `/dev/realtime` how-to with backend `npm run ws:dev-ticket`), env table.
   - **New `CHANGELOG.md`** (Keep a Changelog): Phase 0 summary line + **Phase 1 (T1.15)** entry.
   - `test/render.tsx`: wrap with `SnackbarProvider` (and optional `queryClient` param) so components using notistack render.
8. **Tests** (no new deps)
   - `errors.test.ts`: every `toApiError` branch (envelope, no envelope 502 HTML, network, timeout ECONNABORTED + ETIMEDOUT, canceled, non-axios error, header requestId fallback, Retry-After), `getErrorMessage` per kind, `isUnexpected`, `applyFieldErrors` (applies + returns true; none → false).
   - `client.test.ts`: `apiClient` with a custom `adapter` → 422 envelope rejects with `ApiError` code `VALIDATION_FAILED`; adapter throwing network error → `NETWORK_ERROR`; `unwrap` returns `data`.
   - `query-client.test.ts`: `shouldRetry` table (400/401/404/422/429 false, 500/502/503 true until count 2, network true, canceled false); `notify` called for 500 & network, not for 404, not when `meta.silent`; mutation not retried.
   - `ws-client.test.ts` with `FakeWebSocket` (records sent frames, `serverOpen()`, `serverMessage(obj)`, `serverClose(code)`), `vi.useFakeTimers()`, deterministic `random`:
     - connects with URL containing the ticket; status transitions;
     - ping every 25 s; stops after close;
     - backoff delays 1 s, 2 s, 4 s … capped 30 s (random = 1) and jitter (random = 0.5);
     - 1000 → no reconnect; 4003 → closed + `forbidden`; 4001 ×3 → closed + `unauthorized`, new ticket requested each time; 4010 → new ticket; 4009 → 30 s; 1006 → reconnect; successful open resets attempts;
     - topics: refcount (2 subscribers → 1 frame; both unsubscribe → 1 unsubscribe frame); resubscribe after reconnect;
     - typed `on` delivery; dedupe same `id`; unknown type → `onAny` only; invalid JSON ignored;
     - `getTicket` reject → `idle` + `ticket_unavailable`, no timers pending;
     - `online` event triggers immediate reconnect; `disconnect()` removes listener + timers (`vi.getTimerCount() === 0`);
     - `onReconnected` called on 2nd open only.
   - `hooks.test.tsx`: provider with fake client factory — `useWsEvent` receives events, `useWsTopic` subscribes/unsubscribes on mount/unmount, `getTicket={null}` → no connection.
   - `SystemInfoCard.test.tsx`: `vi.mock('@/services/api/system')` → loading, success (version shown), error (message + Ref + Retry calls API again); `HomePage.test.tsx` updated text.
   - `routes.test.tsx`: `/dev/realtime` renders in test (DEV true).
9. **Frontend verify** (each): lint · format:check · typecheck · test · build. After build: `grep -r "RealtimeDevPage\|/dev/realtime" dist/` → **0 matches** (proves DEV page not shipped). `actionlint` on frontend `ci.yml` (Docker `rhysd/actionlint:latest`).
10. **Manual e2e** (backend `npm run dev` + frontend `npm run dev`, scratch scripts only in the scratchpad):
    - `http://localhost:3100` → SystemInfoCard shows version/env (through the Vite proxy); capture with `curl -s localhost:3100/api/v1/system/info`.
    - Stop backend → card shows error state (proxy error → `UNKNOWN_ERROR`/`NETWORK_ERROR` message) → start backend → Retry works.
    - `/dev/realtime` + `npm run ws:dev-ticket` URL (rewrite host to `localhost:3100` to go through the proxy) → `docker exec cav-redis redis-cli PUBLISH ws:fanout '{"target":{"accountId":"dev-account"},"event":{...}}'` → event appears (verify via the page if a browser is available; otherwise verify the same flow with a Node script using `RealtimeClient` logic against `ws://localhost:3100/ws/events` and record that the browser check was not possible).
    - Record results for the report.
11. Commit 2 (frontend).

---

## T1.16 — Integration tests, docs, sign-off → backend `test: add full-server e2e suite, coverage gates and phase 1 docs [P1-T1.16]` (+ frontend `chore: add coverage gate and docs [P1-T1.16]` if frontend changes)

1. **`startServer(options: StartServerOptions = {})`** — `{ env?: Env; logger?: Logger; installSignalHandlers?: boolean /* default true */; queuePrefix?: string /* default DEFAULT_QUEUE_PREFIX */ }`; returns `{ server, lifecycle, port }` (`port` from `server.address()` → supports `PORT=0`; allow `PORT` min 0 **only** via options — do not loosen the env schema; instead accept `options.port?: number`). Pass `queuePrefix` to every `createQueue/createWorker/startSystemWorker/startEmailWorker`. `src/index.ts` unchanged behaviour. Re-run the manual shutdown check at the checkpoint.
2. **`tests/e2e/server.e2e.test.ts`** — `startTestMongo()` + `requireRedis()` + `uniquePrefix('e2e')`; env = `testEnv({ MONGODB_URI, REDIS_URL, EMAIL_DRIVER: 'log', WORKERS_ENABLED: 'true' })`; `startServer({ env, logger: silent, installSignalHandlers: false, queuePrefix, port: 0 })`:
   - `GET /health` 200; `GET /ready` 200 `{ mongo: 'up', redis: 'up' }`; `GET /api/v1/system/info` 200 envelope; `GET /api/v1/openapi.json` 200; `GET /api/docs` 200; `GET /api/v1/nope` 404 envelope with `requestId` = `X-Request-Id` header.
   - WS: `new WsTicketService(redis).issue({ userId, accountId, channel: 'events' })` → connect `ws://127.0.0.1:<port>/ws/events?ticket=…` → `getRealtime().pushToAccount(accountId, createEnvelope('wallet.updated', {...}))` → message received; reused ticket → close 4001.
   - Email: swap in memory provider via an option or `setEmail` → `getEmail().enqueue('system.test', 'user@example.com', { name: 'E2E' })` → delivered (poll ≤ 5 s).
   - Shutdown: spy/record hook order (wrap `lifecycle.onShutdown` or read logger output) → `lifecycle.shutdown()` → order **http, ws, queues, email, redis, mongo**; then `GET /health` → connection refused; `flushPrefix`.
   - Make sure no singleton leaks into other files (each file runs in its own worker; still close everything).
3. **Gap audit** — write the mapping (in the sign-off doc) "requirement → test file": system info, health/ready (+503 down/shutting down), errors (404/500/envelope), validation (422 details), CORS (allowed/blocked/preflight, exposed headers), rate limit (429 + headers + Redis store across apps), idempotency (replay/409/422/5xx), WS (tickets, close codes 4001/4003/4008/4009/4010/1009/1001, fan-out across 2 instances), storage, email, docs. **Add a test for any gap.**
4. **`tests/config/env-docs.test.ts`** — parse the zod env shape keys (export the raw schema shape or key list from `env.ts`) → every key must appear in `.env.example` (as `KEY=`) **and** in README env table (`` | `KEY` ``). Fix any missing doc rows found.
5. **Coverage gates** — backend `npm run test:coverage` → note lines/branches/functions/statements → `vitest.config.mts` `coverage.thresholds` = each value rounded **down to nearest 5**; same for frontend (`vite.config.ts`). CI (both repos): replace `npm test` with `npm run test:coverage`. actionlint both.
6. **TODO audit** — `grep -rn "TODO(P1)\|TODO (Phase 1)\|TODO(Phase 1)" src tests scripts` (both repos) → **0**. List remaining `TODO(P…)` / `TODO (Phase …)` in the sign-off doc.
7. **Fresh-clone check** (scratchpad): `git clone <backend path> fresh-be && cd fresh-be && git checkout feature/phase-1-foundation && npm ci && npm test` (infra up) → green; frontend same with `npm ci && npm test && npm run build` (frontend fresh clone needs the backend sibling only for `gen:api`, which is not run). Delete the clones afterwards.
8. **Docs full pass**
   - Backend README: **"Run locally (fresh machine)"** — clone both repos side by side → `npm ci` → `cp .env.example .env` → `npm run infra:up` → `npm run db:migrate` → `npm run dev` → open `/api/docs` → frontend `npm ci && cp .env.example .env.local && npm run dev` → Mailpit `:8025`. Scripts table complete, env table complete (test enforces), ports table (5100, 3100, 27018, 6380, 1025, 8025).
   - Conventions: `api.md` (spec endpoint, docs), `websocket.md` (§11 frontend), `error-codes.md` (client codes), `data.md` (email PII), lifecycle order with `email 35` everywhere it is listed (`src/README.md`, `lifecycle.ts`, README).
   - `PHASE_1_PLAN.md`: §3 deliverables all `[x]`; changelog line (Batch 3 done + deviations); `PHASE_1_TASKS.md` T1.13–T1.16 `[x]`.
   - `docs/plans/BUILD_PLAN.md` phase table: Phase 1 status → `✅ Done` (keep column format).
   - CHANGELOG backend: **Phase 1 · Batch 3** entry (tests 248 → N); frontend CHANGELOG updated.
9. **`docs/phases/PHASE_1_SIGNOFF.md`** (same structure as `PHASE_0_SIGNOFF.md`): delivered summary per task T1.1–T1.16, deliverables checklist, test counts both repos + coverage numbers, final dependency versions + `allowScripts` (both repos), deviations (all batches), requirement → test mapping (step 3), remaining TODOs by phase, client inputs pending (**OpenAI key, client server SSH key, SIP details, SMTP provider + sender domain with SPF/DKIM**), go/no-go for Phase 2 (✅ go), merge note ("`feature/phase-1-foundation` → `dev` after review — user decision").
10. Verify (each, both repos) → commit(s).

---

## P1-B3-DONE — checkpoint → `docs: mark phase 1 complete [P1-B3-DONE]` (backend; frontend too if it has doc changes)

1. `npm run infra:up` → full verify **both repos**, each separately: backend `npm ci`, lint, format:check, typecheck, `test:coverage`, build, openapi:check; frontend `npm ci`, lint, format:check, typecheck, `test:coverage`, build; actionlint both `ci.yml`.
2. **Manual end-to-end** (backend `npm run dev`, frontend `npm run dev`):
   - `curl` `/health`, `/ready` (200), `/api/v1/openapi.json` (200), `/api/docs` (200 + CSP header);
   - `npm run email:test -- test@example.com` → visible in Mailpit (`curl -s localhost:8025/api/v1/messages` shows 1+ message with the subject);
   - `npm run db:migrate:status` → `0001-baseline` applied;
   - WS: ticket + Redis publish → event received (scratch client);
   - frontend: SystemInfoCard data via proxy; `/dev/realtime` flow (or Node fallback, as in T1.15);
   - `docker compose stop redis` → `/ready` 503 → `docker compose start redis` → 200;
   - `kill -INT` → hooks **http → ws → queues → email → redis → mongo**; port 5100 free; exit code 0.
3. Secret scan both repos: `grep -rnE "sk-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist .` → 0; `git ls-files | grep -E '(^|/)\.env(\.local)?$'` → none.
4. Commit `[P1-B3-DONE]`. `npm run infra:down` at the end. **No push / merge.**

---

## FINAL REPORT (chat, Hinglish)

1. Summary per task T1.13–T1.16 (✅ / ⚠️ / ❌ + 1 line). 2. `git log --oneline` of this batch — **both repos**. 3. Installed versions + `allowScripts` changes. 4. Deviations + why. 5. Verification results (each command, both repos) + manual checks incl. shutdown order and Mailpit. 6. Tests before → after (backend 248 → N, frontend before → after) + coverage numbers/thresholds. 7. Phase 1 sign-off status + open items for Phase 2 + client inputs pending (incl. SMTP).

---

## MUST-NOT-MISS CHECKLIST

- [ ] Backend branch `feature/phase-1-foundation`; frontend branch `feature/phase-1-foundation` from `main`; one commit per task (T1.15: backend docs + 2 frontend commits); hooks pass; no push/merge/tag
- [ ] Each verify command run **separately**, outputs read; `npm run typecheck` (not npx)
- [ ] Email env: `EMAIL_DRIVER`, `SMTP_SECURE`, pairing rule, production requires smtp, `MAIL_FROM` dev default — tests + `.env.example` + README + `.env`
- [ ] nodemailer 10.0.16 **without** `@types/nodemailer`; `smtp-server` devDep; allowScripts reviewed
- [ ] Mailpit `v1.31.4` (`cav-mailpit`, 1025/8025, healthy); ADR 0028 ports updated
- [ ] Providers smtp / log / memory; permanent (5xx) vs retryable errors; no credentials / bodies in logs
- [ ] Templates escaped + text part; typed registry
- [ ] `email` queue: options, `UnrecoverableError`, dedupe `jobId`, worker concurrency 2, `WORKERS_ENABLED`
- [ ] Startup verify non-blocking; `/ready` independent of email; shutdown hook `email` 35; order docs updated everywhere
- [ ] `npm run email:test` (refuses in production); ADR 0030 + ADR README row; data.md PII note
- [ ] `buildOpenApiDocument` version from `getAppInfo()`, `servers` = `APP_URL` when served; committed spec unchanged
- [ ] `/api/v1/openapi.json` always on, not enveloped, `no-cache` + ETag 304
- [ ] `/api/docs` (`API_DOCS_ENABLED`), own HTML + `init.js`, `swagger-ui-dist` assets, Petstore initializer blocked, strict route CSP, no inline scripts, API routes still CSP-off
- [ ] error-codes.md client-only codes (sync test still green); CORS exposes `Retry-After` + `Idempotent-Replayed`; websocket.md §11
- [ ] Frontend `gen:api` committed; `ApiError` + `toApiError` all branches; interceptor; `unwrap`; `applyFieldErrors`
- [ ] React Query: `shouldRetry`, mutations 0, global toast only for unexpected, `meta.silent`, `preventDuplicate`
- [ ] `RealtimeClient`: ping 25 s, full-jitter backoff ≤ 30 s, close-code table, 3 auth failures stop, ticket failure → idle, refcount topics, resubscribe, dedupe, `online`, `onReconnected` → invalidate queries; provider disabled (`getTicket=null`)
- [ ] DEV-only `/dev/realtime` not in production bundle (grep `dist/`)
- [ ] SystemInfoCard (loading / success / error + Ref + Retry); HomePage "Phase 1 — foundation ready"
- [ ] Frontend `.env.example`, `vite-env.d.ts`, `src/README.md`, `README.md`, **new `CHANGELOG.md`**, `render.tsx` with SnackbarProvider
- [ ] `startServer(options)` injectable, production behaviour unchanged; e2e suite incl. shutdown order with `email`
- [ ] Gap audit table + missing tests added; env-docs sync test; coverage thresholds (round down to 5) + CI `test:coverage` both repos; actionlint both
- [ ] TODO(P1) audit = 0; fresh-clone check both repos
- [ ] Docs full pass (README fresh-machine run, ports table, conventions, PHASE_1_PLAN/TASKS, BUILD_PLAN status, CHANGELOGs) + `PHASE_1_SIGNOFF.md`
- [ ] Checkpoint manual e2e incl. Mailpit + shutdown order **http → ws → queues → email → redis → mongo**; secret scan both repos; `infra:down`
