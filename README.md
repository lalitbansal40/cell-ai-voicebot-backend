# Cell AI Voicebot — Backend

Multi-tenant AI voice calling platform API (Node.js + Express + TypeScript + MongoDB).

## Status

**Phase 2 — Auth, Accounts, RBAC + App Shell: complete** ([sign-off](docs/phases/PHASE_2_SIGNOFF.md)); Phase 1 [sign-off](docs/phases/PHASE_1_SIGNOFF.md). Next: Phase 3 (contacts). Tasks: [docs/phases/PHASE_2_TASKS.md](docs/phases/PHASE_2_TASKS.md) · Changes: [CHANGELOG.md](CHANGELOG.md).

## Prerequisites

- **Node.js 24 LTS** (`.nvmrc` = `24`; `engine-strict=true` blocks other versions)
- **npm ≥ 10**
- **Docker Desktop** (for local MongoDB + Redis + Mailpit)

Full setup notes: [docs/setup/prerequisites.md](docs/setup/prerequisites.md).

## Getting started

```bash
npm ci            # install exact dependencies from the lockfile
npm run dev       # run src/index.ts with tsx in watch mode
```

### Run locally (fresh machine)

1. Clone **both** repos side by side (the frontend generates its API types from `../cell-ai-voicebot-backend/openapi/openapi.json`):
   ```bash
   git clone <backend-repo-url> cell-ai-voicebot-backend
   git clone <frontend-repo-url> cell-ai-voicebot-frontend
   ```
2. Backend (Node 24, Docker Desktop running):
   ```bash
   cd cell-ai-voicebot-backend
   npm ci
   cp .env.example .env        # local defaults work as-is; for Mailpit set SMTP_HOST=127.0.0.1 SMTP_PORT=1025
   npm run infra:up            # MongoDB 27018 + Redis 6380 + Mailpit 1025/8025
   npm run db:migrate          # apply migrations (baseline)
   npm run dev                 # http://localhost:5100
   ```
   Check: <http://localhost:5100/health>, <http://localhost:5100/ready>, Swagger UI <http://localhost:5100/api/docs>, Mailpit <http://localhost:8025> (`npm run email:test -- you@example.com`).
3. Frontend:
   ```bash
   cd ../cell-ai-voicebot-frontend
   npm ci
   cp .env.example .env.local
   npm run dev                 # http://localhost:3100 (proxies /api and /ws to :5100)
   ```
4. Tests: `npm test` in each repo (backend needs `npm run infra:up` first). Stop infra with `npm run infra:down`.

| Port  | What                               |
| ----- | ---------------------------------- |
| 5100  | Backend API + `/ws/events`         |
| 3100  | Frontend dev server (3101 preview) |
| 27018 | MongoDB (replica set `rs0`)        |
| 6380  | Redis                              |
| 1025  | Mailpit SMTP                       |
| 8025  | Mailpit web UI                     |

All bound to `127.0.0.1` ([ADR 0028](docs/adr/0028-local-dev-ports.md)).

## Running the API

```bash
cp .env.example .env     # first time; adjust values (never commit .env)
npm run dev              # tsx watch, loads .env → http://localhost:5100
curl -s localhost:5100/api/v1/system/info
```

- Env is validated at startup (`src/config/env.ts`); an invalid env prints the offending variable **names** and exits.
- `Ctrl-C` / `SIGTERM` → graceful shutdown: http → ws → queues → email → redis → mongo (15 s hard timeout).
- Production build: `npm run build && npm start`.
- Health: `GET /health` (process alive) · `GET /ready` (MongoDB + Redis reachable; **503** when a dependency is down or the server is shutting down) — use `/ready` for load-balancer checks.
- **MongoDB and Redis are required**: start them with `npm run infra:up` first (the API exits with a clear message if either is unreachable).

## Authentication & accounts (Phase 2)

- **Flow:** `POST /api/v1/auth/signup` (always 202) → 6-digit code by email → `POST /auth/verify-email` signs in. Then `login`, `refresh` (httpOnly `cav_rt` cookie, rotated on every use — reuse ends the session; a replay within 10 s whose successor is unused counts as a lost response, not reuse), `logout`, `logout-all`, `me`, `sessions`, `forgot-password` / `reset-password`, `change-password`. Details: [ADR 0009](docs/adr/0009-auth-tokens.md), [src/README.md](src/README.md#authentication).
- **Local quickstart:**
  ```bash
  npm run infra:up && npm run db:migrate
  npm run db:seed                       # Demo Finance + <role>@demo.local users + admin@platform.local
  npm run superadmin:create -- you@example.com "Your Name"   # optional, prompts for a password
  npm run dev
  ```
  Signup / reset emails land in **Mailpit** (<http://localhost:8025>) when `SMTP_HOST=127.0.0.1`, `SMTP_PORT=1025`.
- **Access token:** `Authorization: Bearer <jwt>` (15 min). Roles: owner, admin, manager, agent, viewer — permissions in `src/modules/rbac/permissions.ts` (`GET /api/v1/rbac/permissions`).
- **Limits:** every API request 1,200 / min per IP (flood guard; an office behind one NAT shares it); auth routes 30 / 15 min per IP and route (`/auth/refresh` 600 — it runs on every page load); 5 failed logins / 15 min per email → 429 with `Retry-After`; email codes 10 min, 5 tries, resend every 60 s (max 5 / hour).
- Passwords: argon2id, 10–128 characters, not your email / name, not a common password. Secrets (passwords, codes, tokens, cookies) never appear in logs or email subjects.

## Team, API keys, audit, superadmin (Phase 2)

- **Team** (`/api/v1/team`): invite by email (7-day single-use link, `team.invite` email), resend / revoke, change role, enable / disable (sessions end immediately), remove, ownership transfer (owner + password, to an active admin). Only the owner manages admins.
- **Account settings** (`/api/v1/account`): name, timezone, country, default language, calling window, recording / AI disclosure.
- **API keys** (`/api/v1/api-keys`): scoped keys for the public API, shown once, `X-API-Key`; `GET /api/v1/api-keys/whoami` to test a key.
- **Audit log** (`/api/v1/audit-logs`): every sensitive action, 365-day retention — catalogue in [audit.md](docs/conventions/audit.md).
- **Superadmin** (`/api/v1/admin`, platform admins from `npm run superadmin:create`): accounts list / detail, suspend (read-only) / enable, impersonate the owner for 30 minutes (audited, sensitive actions blocked).

## Contacts (Phase 3)

- **Custom fields** (`/api/v1/custom-fields`): typed variables per account — `text`, `number`, `date`, `currency`, `phone`; key `^[a-z][a-z0-9_]*$` (immutable, used as `{{key}}` in flows), max 50, required + default. Currency is sent in rupees and stored as integer micros; dates as `YYYY-MM-DD`.
- **Contacts** (`/api/v1/contacts`): one contact per phone (E.164, the account's country as default — `098765…`, `+91 98765-…`, `919876…` all work). Search `?q=` matches name, e-mail, external id or the phone in any format; filters `listId`, `tag` / `tagsAll`, `dnd`, `optedOut`, `segmentId`, `createdFrom/To`; `POST /contacts/search` takes a full filter (field conditions such as `days_past_due > 30`, `due_date overdue_by_days 30`). Duplicate phone / external id → `409` with `existingId`; a deleted contact is revived when its phone is added again (hard-deleted after 30 days).
- **Lists** (`/api/v1/contact-lists`, counts computed live) and **segments** (`/api/v1/segments`, saved filters with preview).
- **Do-not-call** (`/api/v1/dnd-entries`): add (`contacts.write`), remove only with **`dnd.manage`** (owner / admin, migration `0004`). `POST /contacts/:id/opt-out` also adds the number to the list; undo needs `dnd.manage`.
- Permissions: `contacts.read` (agents, viewers) to view, `contacts.write` (managers and up) to change. Phone numbers, names and variables never appear in logs.
- **Imports** (`/api/v1/contact-imports`, [ADR 0031](docs/adr/0031-contact-import-pipeline.md)): upload `.csv` / `.xlsx` (≤ 10 MB, ≤ 50,000 rows) → the server suggests a mapping (Hindi / English headers, field types) → `PUT …/mapping` → `POST …/validate` (dry run: totals, problem rows, downloadable error CSV) → `POST …/start` (background, batches of 500, resumes after a crash, cancellable). Template: `GET /contact-imports/template.csv`. Try it with [docs/samples](docs/samples/README.md). DND numbers can be uploaded the same way (`kind=dnd`).
  - Excel tip: format the phone column as **Text** — otherwise long numbers become `9.87654E+09` and the row is reported as "lost digits".
- **Bulk** (`POST /contacts/bulk`): tags, lists, delete, add to DND — ≤ 1,000 ids at once or a filter (≤ 100,000) in the background. A contact past 20 tags / 50 lists is skipped, never truncated.
- **Export** (`/api/v1/contact-exports`, `contacts.export`, never while impersonating): CSV with BOM, injection-safe cells, link valid 15 min, file deleted after 24 h. Opening in Excel: use _Data → From Text/CSV_ so phones stay as text.
- **Retention**: deleted contacts are erased after 30 days; uploaded sheets and error reports after 30 days; exports after 24 h (`maintenance` queue).
- Dev helpers: `npm run samples:contacts` (sample sheets), `npm run bench:contacts [rows]` (50,000-row import + query timings; throw-away account). Last run: validate 0.6 s, import 4.6 s, list queries p95 ≤ 93 ms.

## Wallet & billing (Phase 4)

Prepaid wallet per account, Razorpay top-ups with GST invoices, and a billing engine that Phase 7 (calls) and Phase 8 (campaigns) call — [ADR 0032](docs/adr/0032-wallet-billing-payments.md).

- **Money** is always integer **micros** (₹1 = 1,000,000) and percentages basis points; `src/core/billing/engine.ts` is the only code that changes wallets or ledger rows (one conditional update + an insert-only ledger row per transaction, idempotency key per operation).
- **Wallet** (`/api/v1/wallet`, `wallet.read`): balance, on hold, available (incl. credit limit), status `ok` / `low` / `exhausted`, this month's spend; settings (threshold, monthly call / AI budgets — `wallet.topup`); prices in force; campaign estimate; ledger (cursor pages, CSV export ≤ 366 days); daily usage in the account timezone. Live updates over WS (`wallet.updated`, `wallet.low_balance`, `wallet.exhausted`) and the bell (`/api/v1/notifications`).
- **Add money** (`POST /wallet/topups` with `Idempotency-Key`, ₹100 – ₹5,00,000, 10 / hour, billing profile required): order → Razorpay checkout → `POST …/verify` **or** the webhook (`POST /api/v1/webhooks/razorpay`, raw-body HMAC, event dedupe) credits the base amount once; GST is shown on top. Orders not paid in 24 h expire.
- **Fake provider** (`PAYMENT_PROVIDER=fake`, default outside production, refused in production): the checkout is skipped and `POST /wallet/topups/:id/fake-complete { "outcome": "paid" | "failed" }` drives the same webhook path — used by dev, tests and E2E. Real test mode: [docs/setup/razorpay.md](docs/setup/razorpay.md).
- **Invoices** (`/api/v1/invoices`): `CAV/<FY>/000001` (consecutive per Indian financial year), CGST + SGST or IGST by the buyer's state; the PDF is rendered by the `invoice.render` job and downloaded through a 15-minute signed link; the receipt email goes out after the first render. Billing profile: `/api/v1/billing/profile` (GSTIN checksum checked).
- **Superadmin** (`/api/v1/admin/…`, `platform.billing.manage`, never while impersonating): default / per-account rate cards with history, account wallet + ledger, credit limit, adjustments (reason, `Idempotency-Key`, audited on both accounts), **simulator** (`BILLING_SIMULATOR_ENABLED`, default off in production — a real hold, then settle or release), IST month summary, payments, payment events.
- **Background** (`billing` queue): stale holds released after 2 h (every 5 min), unpaid orders expired (hourly), wallet = Σ ledger reconcile (daily 21:00 UTC = 02:30 IST, superadmin notice on mismatch), notifications purged after 90 days (03:45 UTC), invoice PDFs.
- **Dev**: `npm run db:seed` adds a billing profile, ₹1,000 credit, three simulated calls and a fake top-up with an invoice to Demo Finance; `npm run bench:wallet [calls] [workers]` checks the engine under concurrency (last run: 1,000 × hold → settle on one wallet, 20 workers, 0 failures, wallet = Σ ledger; 170 calls/s sequential, ~69 calls/s under heavy single-wallet contention).

## Database (MongoDB)

- Connection: `src/db/mongo.ts` (Mongoose 9, `strictQuery`, `autoIndex` off in production, credentials never logged). Indexes are synced at startup in development/test; in production run `npm run db:sync-indexes` as a deploy step.
- Transactions: `withTransaction(async (session) => { … })` from `src/db/transaction.ts` (replica set required — local Docker and tests already run one). No external I/O inside.
- Plugins for models (`src/db/plugins/`): `basePlugin` (timestamps, `id` in JSON), `tenantPlugin` (`accountId`), `softDeletePlugin` (`deletedAt`, auto-filter, `{ withDeleted: true }` to include deleted).
- Migrations (`src/db/migrations/`):
  1. Add `NNNN-short-name.ts` exporting `{ name, up(db), down(db) }`.
  2. Register it in `src/db/migrations/index.ts` (ordered array).
  3. `npm run db:migrate` (apply pending) · `npm run db:migrate:status` · `npm run db:migrate:down` (revert last).
     A lock prevents two runners at once; backward-compatible changes first (data.md §10).

## Redis & background jobs

- Connections (`src/core/queues/redis.ts`): one shared **app** connection (rate limits, WS tickets, publish), separate connections per BullMQ queue/worker and for the pub/sub **subscriber**. URLs are logged as host:port only. All closed by the `redis` shutdown hook.
- Queues (`src/core/queues/queue-factory.ts`): `createQueue(name, deps)` / `createWorker(name, processor, deps)` with default job options (3 attempts, exponential backoff, auto-cleanup). Queue names live in `src/core/queues/names.ts`.
- `system` queue: heartbeat job every 5 minutes proves the wiring.
- `maintenance` queue: daily audit-log purge (entries older than 365 days, 03:00 UTC) — [audit.md](docs/conventions/audit.md).
- `WORKERS_ENABLED=false` runs the API without workers (Phase 12 may run workers in their own process).
- Shutdown closes workers gracefully (active jobs finish) within **5 s** (`QUEUE_CLOSE_TIMEOUT_MS`); BullMQ's `close()` can hang while Redis is reconnecting, so after the budget the shutdown logs a warning and continues — unfinished jobs are picked up again by BullMQ's stalled-job check.
- Rate limits use a **Redis store** (`rl:` keys) so every API instance shares the same counters.

## Realtime (WebSocket)

- `ws://localhost:5100/ws/events?ticket=<ticket>` — dashboard live events ([websocket.md](docs/conventions/websocket.md)).
- Tickets are single-use and valid 60 s: `POST /api/v1/ws/tickets` with the access token (30 / min per user). DEV shortcut for fake ids: `npm run ws:dev-ticket [accountId] [userId]`.
- Auth events: `session.revoked` (the server also closes that user's sockets with 4001), `user.updated`, `team.changed`, `account.updated`, `account.suspended`, `account.enabled` ([websocket.md §5](docs/conventions/websocket.md)).
- Server code pushes events with `getRealtime().pushToAccount(accountId, type, data)` / `pushToTopic('campaign:<id>', type, data)` — delivered across all API instances via Redis.

## File storage

- `STORAGE_DRIVER=local` (default): files under `STORAGE_LOCAL_PATH` (`./uploads`, gitignored), downloaded through signed links `GET /files/<key>?exp=…&sig=…` (15 min by default; signature derived from `ENCRYPTION_KEY`).
- `STORAGE_DRIVER=s3`: Amazon S3 (`S3_BUCKET`, `S3_REGION`, AWS credentials required) with presigned URLs.
- Code uses `createStorage(env)` → `put` / `get` / `delete` / `exists` / `signedUrl`; keys are `accounts/<accountId>/<area>/<id>.<ext>` ([ADR 0023](docs/adr/0023-file-storage.md)).

## Email

- Code sends through `getEmail()` (`src/core/email/`): `enqueue(template, to, vars, { dedupeKey? })` from request handlers (queued on the BullMQ `email` queue — the request never waits for SMTP), or `sendTemplate` / `send` for direct sends ([ADR 0030](docs/adr/0030-email-delivery.md)).
- Drivers (`EMAIL_DRIVER`): **`smtp`** (nodemailer, pooled) — default when `SMTP_HOST` is set; **`log`** — emails are only logged (masked recipient + subject). **Production requires `smtp`.**
- Local dev: `npm run infra:up` also starts **Mailpit** — set `SMTP_HOST=127.0.0.1`, `SMTP_PORT=1025` and open the inbox at <http://localhost:8025>. Try it: `npm run email:test -- you@example.com`.
- Templates (`src/core/email/templates/`): TS functions returning `{ subject, html, text }`; every value is HTML-escaped. Add one: new file → `EmailTemplateVars` + `TEMPLATES` in `templates/index.ts`.
- Queue: 5 attempts with exponential backoff (5 s → 40 s); SMTP **5xx** rejections are permanent (no retry); a `dedupeKey` blocks the same email for 24 h. Jobs are removed on success, failed ones kept 24 h.
- Logs never contain email bodies (OTPs, reset links) or SMTP credentials. SMTP is checked at startup without blocking it; `/ready` does not depend on email.

## Local infrastructure

MongoDB (single-node replica set `rs0`), Redis and Mailpit (dev SMTP inbox) run in Docker ([docker-compose.yml](docker-compose.yml)). Docker Desktop must be running.

```bash
npm run infra:up      # start + wait until healthy (first start also initiates the replica set)
npm run infra:ps      # status
npm run infra:logs    # follow logs
npm run infra:down    # stop (data volumes are kept)
npm run infra:reset   # ⚠️ stop AND delete volumes — wipes ALL local MongoDB + Redis data
```

| Service | Image                       | Host address                                    | Connection string                                                |
| ------- | --------------------------- | ----------------------------------------------- | ---------------------------------------------------------------- |
| MongoDB | `mongo:8.2`                 | `127.0.0.1:27018`                               | `mongodb://127.0.0.1:27018/cell_ai_voicebot?replicaSet=rs0`      |
| Redis   | `redis:7.4-alpine` (AOF on) | `127.0.0.1:6380`                                | `redis://127.0.0.1:6380`                                         |
| Mailpit | `axllent/mailpit:v1.31.4`   | `127.0.0.1:1025` (SMTP) · `127.0.0.1:8025` (UI) | `SMTP_HOST=127.0.0.1` `SMTP_PORT=1025` · <http://localhost:8025> |

- **MongoDB Compass:** connect with `mongodb://127.0.0.1:27018/?replicaSet=rs0`.
- If replica-set discovery from the host ever fails, append `&directConnection=true` to the URI.
- Ports are bound to `127.0.0.1` only and avoid the defaults (27017 / 6379) so other local databases don't clash ([ADR 0028](docs/adr/0028-local-dev-ports.md)).
- Why `mongo:8.2` and not 8.0: MongoDB 8.0 refuses to start on Linux kernels ≥ 6.19 (Docker Desktop's VM kernel) — see [ADR 0004](docs/adr/0004-database.md).

**Troubleshooting**

- `Cannot connect to the Docker daemon` → start Docker Desktop.
- Port already in use → `lsof -nP -iTCP:27018 -sTCP:LISTEN` (or `:6380`, `:1025`, `:8025`) to find the process.
- Mongo container unhealthy → `npm run infra:logs`; a stale volume from another setup can be wiped with `npm run infra:reset` (deletes data).

## Scripts

| Script                                        | What it does                                                                                                                                                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                                 | Run the app with `tsx` in watch mode                                                                                                                                                                                                              |
| `npm run build`                               | Compile `src/` to `dist/` (`tsconfig.build.json`)                                                                                                                                                                                                 |
| `npm start`                                   | Run the compiled app (`dist/index.js`)                                                                                                                                                                                                            |
| `npm run typecheck`                           | Type-check everything (src, tests, scripts) without emitting                                                                                                                                                                                      |
| `npm run clean`                               | Delete `dist/`                                                                                                                                                                                                                                    |
| `npm run lint`                                | ESLint (type-aware), fails on any warning                                                                                                                                                                                                         |
| `npm run lint:fix`                            | ESLint with auto-fix                                                                                                                                                                                                                              |
| `npm run format`                              | Prettier write                                                                                                                                                                                                                                    |
| `npm run format:check`                        | Prettier check                                                                                                                                                                                                                                    |
| `npm test`                                    | Run all tests once (Vitest)                                                                                                                                                                                                                       |
| `npm run test:watch`                          | Vitest watch mode                                                                                                                                                                                                                                 |
| `npm run test:coverage`                       | Tests + coverage report in `coverage/`                                                                                                                                                                                                            |
| `npm run gen:openapi`                         | Generate `openapi/openapi.json` from zod schemas                                                                                                                                                                                                  |
| `npm run openapi:check`                       | Regenerate and fail if `openapi/openapi.json` is stale                                                                                                                                                                                            |
| `npm run db:migrate`                          | Apply pending MongoDB migrations                                                                                                                                                                                                                  |
| `npm run db:migrate:status`                   | Show applied / pending migrations                                                                                                                                                                                                                 |
| `npm run db:migrate:down`                     | Revert the last applied migration                                                                                                                                                                                                                 |
| `npm run db:sync-indexes`                     | Build / update indexes of all models (production deploy step)                                                                                                                                                                                     |
| `npm run db:seed`                             | DEV ONLY — demo account "Demo Finance" with `<role>@demo.local` users, demo contacts and billing (₹1,000 credit, simulated calls, a fake top-up + invoice) + `admin@platform.local` superadmin (password `SEED_PASSWORD` or random, printed once) |
| `npm run superadmin:create -- <email> [name]` | Create / update a platform superadmin (hidden password prompt or `--password-stdin`; no HTTP route exists)                                                                                                                                        |
| `npm run ws:dev-ticket`                       | DEV ONLY — print a single-use `/ws/events` ticket URL for fake ids                                                                                                                                                                                |
| `npm run email:test -- <to>`                  | DEV ONLY — send the `system.test` email now with the configured driver (Mailpit locally)                                                                                                                                                          |
| `npm run bench:contacts [rows]`               | DEV ONLY — contact import + list query timings on a throw-away account                                                                                                                                                                            |
| `npm run bench:wallet [calls] [workers]`      | DEV ONLY — billing engine concurrency check (hold → settle, wallet = Σ ledger) on a throw-away account                                                                                                                                            |
| `npm run server:audit`                        | READ-ONLY audit of the client server over SSH (needs the key — see docs/client/server-audit.md)                                                                                                                                                   |
| `npm run infra:up`                            | Start MongoDB + Redis + Mailpit (Docker) and wait until healthy                                                                                                                                                                                   |
| `npm run infra:down`                          | Stop containers (keeps data)                                                                                                                                                                                                                      |
| `npm run infra:reset`                         | ⚠️ Stop containers and delete data volumes                                                                                                                                                                                                        |
| `npm run infra:logs`                          | Follow container logs                                                                                                                                                                                                                             |
| `npm run infra:ps`                            | Container status                                                                                                                                                                                                                                  |

## Folder structure

```
src/        application code (module-based — see src/README.md)
tests/      integration tests
scripts/    one-off scripts
poc/        proofs of concept (not part of the build)
docs/       plans, ADRs, conventions, prompts
```

Details: [src/README.md](src/README.md) · Decision: [ADR 0003](docs/adr/0003-backend-code-structure.md).

### Install scripts (npm 11)

npm 11 blocks dependency install scripts unless approved. Approvals live in `package.json` → `allowScripts`:

- `esbuild: true` — needed by `tsx` (downloads its native binary).
- `fsevents: false` — ships a prebuilt binary; the rebuild script is not needed.
- `unrs-resolver: true` — ensures the native binding used by the ESLint import resolver.
- `mongodb-memory-server: false` — skips the install-time MongoDB download; the binary downloads on first test run instead.
- `msgpackr-extract: false` — BullMQ's optional native msgpack add-on ships a prebuilt binary (`@msgpackr-extract/*`); the `node-gyp rebuild` script is not needed (msgpackr falls back to JS otherwise).
- `@scarf/scarf: false` — pulled in by `swagger-ui-dist`; its postinstall only sends install analytics.
- No install scripts for `jose` (pure JS) or `@node-rs/argon2` (prebuilt N-API binaries per platform).

No install scripts needed for `nodemailer` / `smtp-server` (pure JS). `smtp-server` has no bundled types and `@types/smtp-server` would pull in `@types/nodemailer` (clashes with nodemailer 10's own types), so tests use a minimal local declaration (`tests/@types/smtp-server.d.ts`).

Run `npm approve-scripts --allow-scripts-pending` after adding dependencies to review new ones.

## API contract (OpenAPI)

The API contract is generated from zod schemas ([ADR 0029](docs/adr/0029-shared-api-types-via-openapi.md)):

- Schemas live next to each module (`src/modules/<feature>/<feature>.schema.ts`) and register paths/components on `src/shared/openapi/registry.ts`. Import `z` from `src/shared/openapi/zod.ts`.
- `src/openapi.ts` imports every module schema and builds the OpenAPI 3.1 document.
- `npm run gen:openapi` writes **`openapi/openapi.json`** (committed, Prettier-formatted, deterministic).
- Regenerate after **every** schema change and commit the JSON in the same commit.
- `npm run openapi:check` regenerates and fails if the committed file is stale — CI runs it.
- The frontend generates its types from this file (`npm run gen:api` in the frontend repo).
- **Served:** `GET /api/v1/openapi.json` (always on, raw OpenAPI JSON with `servers = APP_URL`).
- **Swagger UI:** <http://localhost:5100/api/docs> (or <http://localhost:3100/api/docs> through the frontend dev proxy). On by default outside production; production needs `API_DOCS_ENABLED=true`. "Try it out" calls the same origin.

## Testing

- **Runner:** Vitest ([ADR 0019](docs/adr/0019-testing-stack.md)).
- **Run `npm run infra:up` before `npm test`** — queue, rate-limit and realtime tests use the real Redis on `127.0.0.1:6380` (MongoDB tests use an in-memory replica set). CI starts a Redis service container.
- **Unit tests** live next to the code: `src/**/*.test.ts`.
- **Integration / infra tests** live in `tests/` (e.g. `tests/infra/mongo-replset.test.ts` proves replica-set transactions).
- **MongoDB in tests:** `tests/setup/mongo.global.ts` starts **one** in-memory replica set for the whole run (Vitest `globalSetup`); each test file gets its own database via `startTestMongo()` (`tests/helpers/mongo.ts`). One shared replica set instead of one per file — parallel replica-set start-ups made transactions hang intermittently. The replica set: the MongoDB version is pinned in `package.json` → `config.mongodbMemoryServer.version` (`8.2.12`, same version line as the Docker image `mongo:8.2`). The first run downloads the binary (~100 MB) into the npm cache.
- **API tests:** Supertest against `createApp` (`tests/http/`).
- **Full-server e2e:** `tests/e2e/server.e2e.test.ts` boots `startServer({ port: 0, … })` with real Mongo (memory) + Redis + workers + realtime + email, then checks the graceful shutdown order.
- **Email:** `tests/email/` — in-process SMTP server (`smtp-server`), no Mailpit needed.
- **Docs sync:** `tests/config/env-docs.test.ts` fails when a variable in `env.ts` is missing from `.env.example` or the env table below; `error-codes.test.ts` keeps `ERROR_CODES` = `error-codes.md`.
- **Coverage gate:** `npm run test:coverage` enforces thresholds in `vitest.config.mts` (statements 95 · branches 85 · functions 95 · lines 95 — Phase 3 sign-off values rounded down). CI runs it.
- **Browser E2E:** Playwright lives in the frontend repo (`e2e/`, `npm run e2e`) and starts this backend with an isolated `cav_e2e` database and Redis db 5 — see the frontend README.

## Code quality

- ESLint (type-aware, `typescript-eslint` + `import-x`) + Prettier.
- Git hooks (Husky): `pre-commit` runs lint-staged (ESLint fix + Prettier on staged files); `commit-msg` runs commitlint (Conventional Commits).
- Commit format: `type(scope): message [TASK-TAG]`, e.g. `feat(contacts): add csv import [P3-T3.2]`.

## CI

<!-- CI badge: add after the first run — see docs/setup/github-settings.md -->

GitHub Actions (`.github/workflows/ci.yml`) on every pull request and on pushes to `main` / `dev`:

- **verify** — `npm ci`, lint, format check, typecheck, tests **with the coverage gate**, build (Node from `.nvmrc`), with a Redis service container.
- `verify` also runs `npm run openapi:check` and caches the MongoDB test binary.
- **secrets-scan** — gitleaks over the full git history (`.gitleaks.toml`).
- **audit** — `npm audit --audit-level=high` (informational, non-blocking).
- **commitlint** — checks every commit message in a PR.

Run the same checks locally: `npm run lint && npm run format:check && npm run typecheck && npm run test:coverage && npm run build && npm run openapi:check`.
Dependabot (`.github/dependabot.yml`) opens weekly grouped update PRs. Repo settings to apply by hand: [GitHub settings](docs/setup/github-settings.md).

## Environment variables

Copy `.env.example` → `.env` (gitignored). Every variable is validated at startup by [`src/config/env.ts`](src/config/env.ts) — the app refuses to start and lists the offending variable names (never values). Values live only in `.env`, server env and the password manager — never in git. Policy: [docs/conventions/secrets.md](docs/conventions/secrets.md).

| Variable                    | Required          | Phase   | Description                                                                                     |
| --------------------------- | ----------------- | ------- | ----------------------------------------------------------------------------------------------- |
| `NODE_ENV`                  | no                | 1       | `development` / `production` / `test`                                                           |
| `PORT`                      | no                | 1       | API port (default 5100)                                                                         |
| `APP_URL`                   | yes               | 1       | Public base URL of this API                                                                     |
| `FRONTEND_URL`              | yes               | 1       | Dashboard URL (links in emails, CORS)                                                           |
| `CORS_ORIGINS`              | yes               | 1       | Comma-separated allowed origins                                                                 |
| `LOG_LEVEL`                 | no                | 1       | pino log level                                                                                  |
| `TRUST_PROXY`               | no                | 1       | `false` / `true` / hop count / `loopback` — set behind nginx (Phase 12)                         |
| `API_DOCS_ENABLED`          | no                | 1       | Swagger UI at `/api/docs` — default on outside production, off in production                    |
| `MONGODB_URI`               | yes               | 1       | MongoDB connection string (replica set)                                                         |
| `REDIS_URL`                 | yes               | 1       | Redis connection string                                                                         |
| `WORKERS_ENABLED`           | no                | 1       | `true` (default) / `false` — run BullMQ workers in the API process                              |
| `JWT_ACCESS_SECRET`         | yes · secret      | 2       | Access token signing secret                                                                     |
| `JWT_REFRESH_SECRET`        | yes · secret      | 2       | Refresh token signing secret                                                                    |
| `JWT_ACCESS_TTL`            | no                | 2       | Access token lifetime (e.g. `15m`)                                                              |
| `JWT_REFRESH_TTL`           | no                | 2       | Refresh token lifetime (e.g. `30d`)                                                             |
| `ENCRYPTION_KEY`            | yes · secret      | 2       | 32-byte base64 key for PII encryption at rest                                                   |
| `AUTH_COOKIE_DOMAIN`        | no                | 2       | Refresh-cookie domain (e.g. `.example.com`); empty = host-only                                  |
| `SEED_PASSWORD`             | no (dev only)     | 2       | Password for `npm run db:seed` users; empty = random, printed once                              |
| `OPENAI_API_KEY`            | yes · secret      | 5/7     | OpenAI API key                                                                                  |
| `OPENAI_REALTIME_MODEL`     | yes               | 7       | Realtime model name (set after PoC T0.15)                                                       |
| `STORAGE_DRIVER`            | no                | 7/9     | `local` or `s3`                                                                                 |
| `STORAGE_LOCAL_PATH`        | no                | 7/9     | Folder for local uploads/recordings                                                             |
| `S3_BUCKET`                 | if s3             | 7/9     | S3 bucket name                                                                                  |
| `S3_REGION`                 | if s3             | 7/9     | S3 region                                                                                       |
| `AWS_ACCESS_KEY_ID`         | if s3 · secret    | 7/9     | AWS access key                                                                                  |
| `AWS_SECRET_ACCESS_KEY`     | if s3 · secret    | 7/9     | AWS secret key                                                                                  |
| `EMAIL_DRIVER`              | no                | 1       | `smtp` / `log` — default `smtp` when `SMTP_HOST` is set, else `log`; production requires `smtp` |
| `SMTP_HOST`                 | yes (production)  | 1       | SMTP server (local: Mailpit `127.0.0.1`)                                                        |
| `SMTP_PORT`                 | no                | 1       | SMTP port (default 587; local Mailpit 1025)                                                     |
| `SMTP_SECURE`               | no                | 1       | `true` = implicit TLS; empty = auto (`true` only for port 465)                                  |
| `SMTP_USER`                 | if auth           | 1       | SMTP username (set together with `SMTP_PASS`)                                                   |
| `SMTP_PASS`                 | if auth · secret  | 1       | SMTP password                                                                                   |
| `MAIL_FROM`                 | yes (production)  | 1       | Sender, e.g. `Cell AI Voicebot <no-reply@example.com>` (dev default `no-reply@localhost`)       |
| `RAZORPAY_KEY_ID`           | yes               | 4       | Razorpay key id                                                                                 |
| `RAZORPAY_KEY_SECRET`       | yes · secret      | 4       | Razorpay key secret                                                                             |
| `RAZORPAY_WEBHOOK_SECRET`   | yes · secret      | 4       | Razorpay webhook signing secret                                                                 |
| `PAYMENT_PROVIDER`          | no                | 4       | `fake` (default outside production) or `razorpay` (required in production)                      |
| `FAKE_PAYMENT_SECRET`       | no · secret       | 4       | Signing secret of the fake provider (dev / tests); must be unset in production                  |
| `BILLING_SELLER_NAME`       | prod              | 4       | Seller legal name on GST invoices                                                               |
| `BILLING_SELLER_ADDRESS`    | prod              | 4       | Seller address on invoices                                                                      |
| `BILLING_SELLER_GSTIN`      | prod              | 4       | Seller GSTIN (checksum + state validated)                                                       |
| `BILLING_SELLER_STATE_CODE` | prod              | 4       | Seller GST state code (default `08`) — CGST + SGST vs IGST                                      |
| `BILLING_SAC_CODE`          | no                | 4       | SAC on invoices (default `998319`)                                                              |
| `BILLING_INVOICE_PREFIX`    | no                | 4       | Invoice prefix, 1–3 capitals (default `CAV`)                                                    |
| `BILLING_SIMULATOR_ENABLED` | no                | 4       | Superadmin billing simulator (default on outside production, off in production)                 |
| `NOTIFYNOW_API_KEY`         | optional · secret | 13      | NotifyNow voice API key (optional fallback provider)                                            |
| `SIP_HOST`                  | yes (Phase 13)    | 13      | SIP trunk host                                                                                  |
| `SIP_PORT`                  | no                | 13      | SIP port                                                                                        |
| `SIP_TRANSPORT`             | no                | 13      | `udp` / `tcp` / `tls`                                                                           |
| `SIP_USERNAME`              | if auth           | 13      | SIP username                                                                                    |
| `SIP_PASSWORD`              | if auth · secret  | 13      | SIP password                                                                                    |
| `SIP_CALLER_ID`             | yes (Phase 13)    | 13      | Outbound caller ID / DID                                                                        |
| `CLIENT_SSH_KEY_PATH`       | no                | tooling | Path to the client server SSH key for `npm run server:audit` (path only)                        |

## Docs

All project docs (plans, ADRs, conventions) live in [`docs/`](docs/README.md).

## Conventions

- [Definition of Done](docs/conventions/definition-of-done.md)
- [Secrets policy](docs/conventions/secrets.md)
- [API conventions](docs/conventions/api.md) · [Error codes](docs/conventions/error-codes.md) · [WebSocket](docs/conventions/websocket.md) · [Data](docs/conventions/data.md) · [Code style](docs/conventions/code-style.md)
- [Architecture Decision Records](docs/adr/README.md)
