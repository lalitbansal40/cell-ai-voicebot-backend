# Cell AI Voicebot — Backend

Multi-tenant AI voice calling platform API (Node.js + Express + TypeScript + MongoDB).

## Status

Phase 0 — setup & architecture decisions. See [docs/phases/PHASE_0_TASKS.md](docs/phases/PHASE_0_TASKS.md).

## Prerequisites

- **Node.js 24 LTS** (`.nvmrc` = `24`; `engine-strict=true` blocks other versions)
- **npm ≥ 10**
- **Docker Desktop** (for local MongoDB + Redis)

Full setup notes: [docs/setup/prerequisites.md](docs/setup/prerequisites.md).

## Getting started

```bash
npm ci            # install exact dependencies from the lockfile
npm run dev       # run src/index.ts with tsx in watch mode
```

## Running the API

```bash
cp .env.example .env     # first time; adjust values (never commit .env)
npm run dev              # tsx watch, loads .env → http://localhost:5100
curl -s localhost:5100/api/v1/system/info
```

- Env is validated at startup (`src/config/env.ts`); an invalid env prints the offending variable **names** and exits.
- `Ctrl-C` / `SIGTERM` → graceful shutdown (ordered hooks, 15 s hard timeout).
- Production build: `npm run build && npm start`.
- **MongoDB is required**: start it with `npm run infra:up` first (the API exits with a clear message if it can't connect).

## Database (MongoDB)

- Connection: `src/db/mongo.ts` (Mongoose 9, `strictQuery`, `autoIndex` off in production, credentials never logged). Indexes are synced at startup in development/test; in production run `npm run db:sync-indexes` as a deploy step.
- Transactions: `withTransaction(async (session) => { … })` from `src/db/transaction.ts` (replica set required — local Docker and tests already run one). No external I/O inside.
- Plugins for models (`src/db/plugins/`): `basePlugin` (timestamps, `id` in JSON), `tenantPlugin` (`accountId`), `softDeletePlugin` (`deletedAt`, auto-filter, `{ withDeleted: true }` to include deleted).
- Migrations (`src/db/migrations/`):
  1. Add `NNNN-short-name.ts` exporting `{ name, up(db), down(db) }`.
  2. Register it in `src/db/migrations/index.ts` (ordered array).
  3. `npm run db:migrate` (apply pending) · `npm run db:migrate:status` · `npm run db:migrate:down` (revert last).
     A lock prevents two runners at once; backward-compatible changes first (data.md §10).

## Local infrastructure

MongoDB (single-node replica set `rs0`) and Redis run in Docker ([docker-compose.yml](docker-compose.yml)). Docker Desktop must be running.

```bash
npm run infra:up      # start + wait until healthy (first start also initiates the replica set)
npm run infra:ps      # status
npm run infra:logs    # follow logs
npm run infra:down    # stop (data volumes are kept)
npm run infra:reset   # ⚠️ stop AND delete volumes — wipes ALL local MongoDB + Redis data
```

| Service | Image                       | Host address      | Connection string                                           |
| ------- | --------------------------- | ----------------- | ----------------------------------------------------------- |
| MongoDB | `mongo:8.2`                 | `127.0.0.1:27018` | `mongodb://127.0.0.1:27018/cell_ai_voicebot?replicaSet=rs0` |
| Redis   | `redis:7.4-alpine` (AOF on) | `127.0.0.1:6380`  | `redis://127.0.0.1:6380`                                    |

- **MongoDB Compass:** connect with `mongodb://127.0.0.1:27018/?replicaSet=rs0`.
- If replica-set discovery from the host ever fails, append `&directConnection=true` to the URI.
- Ports are bound to `127.0.0.1` only and avoid the defaults (27017 / 6379) so other local databases don't clash ([ADR 0028](docs/adr/0028-local-dev-ports.md)).
- Why `mongo:8.2` and not 8.0: MongoDB 8.0 refuses to start on Linux kernels ≥ 6.19 (Docker Desktop's VM kernel) — see [ADR 0004](docs/adr/0004-database.md).

**Troubleshooting**

- `Cannot connect to the Docker daemon` → start Docker Desktop.
- Port already in use → `lsof -nP -iTCP:27018 -sTCP:LISTEN` (or `:6380`) to find the process.
- Mongo container unhealthy → `npm run infra:logs`; a stale volume from another setup can be wiped with `npm run infra:reset` (deletes data).

## Scripts

| Script                      | What it does                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| `npm run dev`               | Run the app with `tsx` in watch mode                                                            |
| `npm run build`             | Compile `src/` to `dist/` (`tsconfig.build.json`)                                               |
| `npm start`                 | Run the compiled app (`dist/index.js`)                                                          |
| `npm run typecheck`         | Type-check everything (src, tests, scripts) without emitting                                    |
| `npm run clean`             | Delete `dist/`                                                                                  |
| `npm run lint`              | ESLint (type-aware), fails on any warning                                                       |
| `npm run lint:fix`          | ESLint with auto-fix                                                                            |
| `npm run format`            | Prettier write                                                                                  |
| `npm run format:check`      | Prettier check                                                                                  |
| `npm test`                  | Run all tests once (Vitest)                                                                     |
| `npm run test:watch`        | Vitest watch mode                                                                               |
| `npm run test:coverage`     | Tests + coverage report in `coverage/`                                                          |
| `npm run gen:openapi`       | Generate `openapi/openapi.json` from zod schemas                                                |
| `npm run openapi:check`     | Regenerate and fail if `openapi/openapi.json` is stale                                          |
| `npm run db:migrate`        | Apply pending MongoDB migrations                                                                |
| `npm run db:migrate:status` | Show applied / pending migrations                                                               |
| `npm run db:migrate:down`   | Revert the last applied migration                                                               |
| `npm run db:sync-indexes`   | Build / update indexes of all models (production deploy step)                                   |
| `npm run server:audit`      | READ-ONLY audit of the client server over SSH (needs the key — see docs/client/server-audit.md) |
| `npm run infra:up`          | Start MongoDB + Redis (Docker) and wait until healthy                                           |
| `npm run infra:down`        | Stop containers (keeps data)                                                                    |
| `npm run infra:reset`       | ⚠️ Stop containers and delete data volumes                                                      |
| `npm run infra:logs`        | Follow container logs                                                                           |
| `npm run infra:ps`          | Container status                                                                                |

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

Run `npm approve-scripts --allow-scripts-pending` after adding dependencies to review new ones.

## API contract (OpenAPI)

The API contract is generated from zod schemas ([ADR 0029](docs/adr/0029-shared-api-types-via-openapi.md)):

- Schemas live next to each module (`src/modules/<feature>/<feature>.schema.ts`) and register paths/components on `src/shared/openapi/registry.ts`. Import `z` from `src/shared/openapi/zod.ts`.
- `src/openapi.ts` imports every module schema and builds the OpenAPI 3.1 document.
- `npm run gen:openapi` writes **`openapi/openapi.json`** (committed, Prettier-formatted, deterministic).
- Regenerate after **every** schema change and commit the JSON in the same commit.
- `npm run openapi:check` regenerates and fails if the committed file is stale — CI runs it.
- The frontend generates its types from this file (`npm run gen:api` in the frontend repo).

## Testing

- **Runner:** Vitest ([ADR 0019](docs/adr/0019-testing-stack.md)).
- **Unit tests** live next to the code: `src/**/*.test.ts`.
- **Integration / infra tests** live in `tests/` (e.g. `tests/infra/mongo-replset.test.ts` proves replica-set transactions).
- **MongoDB in tests:** `mongodb-memory-server` starts a real replica set; the MongoDB version is pinned in `package.json` → `config.mongodbMemoryServer.version` (`8.2.12`, same version line as the Docker image `mongo:8.2`). The first run downloads the binary (~100 MB) into the npm cache.
- **API tests:** Supertest (from Phase 1).
- **E2E:** Playwright, added after Phase 2.

## Code quality

- ESLint (type-aware, `typescript-eslint` + `import-x`) + Prettier.
- Git hooks (Husky): `pre-commit` runs lint-staged (ESLint fix + Prettier on staged files); `commit-msg` runs commitlint (Conventional Commits).
- Commit format: `type(scope): message [TASK-TAG]`, e.g. `feat(contacts): add csv import [P3-T3.2]`.

## CI

<!-- CI badge: add after the first run — see docs/setup/github-settings.md -->

GitHub Actions (`.github/workflows/ci.yml`) on every pull request and on pushes to `main` / `dev`:

- **verify** — `npm ci`, lint, format check, typecheck, tests, build (Node from `.nvmrc`).
- `verify` also runs `npm run openapi:check` and caches the MongoDB test binary.
- **secrets-scan** — gitleaks over the full git history (`.gitleaks.toml`).
- **audit** — `npm audit --audit-level=high` (informational, non-blocking).
- **commitlint** — checks every commit message in a PR.

Run the same checks locally: `npm run lint && npm run format:check && npm run typecheck && npm test && npm run build`.
Dependabot (`.github/dependabot.yml`) opens weekly grouped update PRs. Repo settings to apply by hand: [GitHub settings](docs/setup/github-settings.md).

## Environment variables

Copy `.env.example` → `.env` (gitignored). Every variable is validated at startup by [`src/config/env.ts`](src/config/env.ts) — the app refuses to start and lists the offending variable names (never values). Values live only in `.env`, server env and the password manager — never in git. Policy: [docs/conventions/secrets.md](docs/conventions/secrets.md).

| Variable                  | Required          | Phase   | Description                                                              |
| ------------------------- | ----------------- | ------- | ------------------------------------------------------------------------ |
| `NODE_ENV`                | no                | 1       | `development` / `production` / `test`                                    |
| `PORT`                    | no                | 1       | API port (default 5100)                                                  |
| `APP_URL`                 | yes               | 1       | Public base URL of this API                                              |
| `FRONTEND_URL`            | yes               | 1       | Dashboard URL (links in emails, CORS)                                    |
| `CORS_ORIGINS`            | yes               | 1       | Comma-separated allowed origins                                          |
| `LOG_LEVEL`               | no                | 1       | pino log level                                                           |
| `TRUST_PROXY`             | no                | 1       | `false` / `true` / hop count / `loopback` — set behind nginx (Phase 12)  |
| `MONGODB_URI`             | yes               | 1       | MongoDB connection string (replica set)                                  |
| `REDIS_URL`               | yes               | 1       | Redis connection string                                                  |
| `JWT_ACCESS_SECRET`       | yes · secret      | 2       | Access token signing secret                                              |
| `JWT_REFRESH_SECRET`      | yes · secret      | 2       | Refresh token signing secret                                             |
| `JWT_ACCESS_TTL`          | no                | 2       | Access token lifetime (e.g. `15m`)                                       |
| `JWT_REFRESH_TTL`         | no                | 2       | Refresh token lifetime (e.g. `30d`)                                      |
| `ENCRYPTION_KEY`          | yes · secret      | 2       | 32-byte base64 key for PII encryption at rest                            |
| `OPENAI_API_KEY`          | yes · secret      | 5/7     | OpenAI API key                                                           |
| `OPENAI_REALTIME_MODEL`   | yes               | 7       | Realtime model name (set after PoC T0.15)                                |
| `STORAGE_DRIVER`          | no                | 7/9     | `local` or `s3`                                                          |
| `STORAGE_LOCAL_PATH`      | no                | 7/9     | Folder for local uploads/recordings                                      |
| `S3_BUCKET`               | if s3             | 7/9     | S3 bucket name                                                           |
| `S3_REGION`               | if s3             | 7/9     | S3 region                                                                |
| `AWS_ACCESS_KEY_ID`       | if s3 · secret    | 7/9     | AWS access key                                                           |
| `AWS_SECRET_ACCESS_KEY`   | if s3 · secret    | 7/9     | AWS secret key                                                           |
| `SMTP_HOST`               | yes               | 1/2     | SMTP server                                                              |
| `SMTP_PORT`               | no                | 1/2     | SMTP port                                                                |
| `SMTP_USER`               | yes               | 1/2     | SMTP username                                                            |
| `SMTP_PASS`               | yes · secret      | 1/2     | SMTP password                                                            |
| `MAIL_FROM`               | yes               | 1/2     | Sender address                                                           |
| `RAZORPAY_KEY_ID`         | yes               | 4       | Razorpay key id                                                          |
| `RAZORPAY_KEY_SECRET`     | yes · secret      | 4       | Razorpay key secret                                                      |
| `RAZORPAY_WEBHOOK_SECRET` | yes · secret      | 4       | Razorpay webhook signing secret                                          |
| `NOTIFYNOW_API_KEY`       | optional · secret | 13      | NotifyNow voice API key (optional fallback provider)                     |
| `SIP_HOST`                | yes (Phase 13)    | 13      | SIP trunk host                                                           |
| `SIP_PORT`                | no                | 13      | SIP port                                                                 |
| `SIP_TRANSPORT`           | no                | 13      | `udp` / `tcp` / `tls`                                                    |
| `SIP_USERNAME`            | if auth           | 13      | SIP username                                                             |
| `SIP_PASSWORD`            | if auth · secret  | 13      | SIP password                                                             |
| `SIP_CALLER_ID`           | yes (Phase 13)    | 13      | Outbound caller ID / DID                                                 |
| `CLIENT_SSH_KEY_PATH`     | no                | tooling | Path to the client server SSH key for `npm run server:audit` (path only) |

## Docs

All project docs (plans, ADRs, conventions) live in [`docs/`](docs/README.md).

## Conventions

- [Definition of Done](docs/conventions/definition-of-done.md)
- [Secrets policy](docs/conventions/secrets.md)
- [API conventions](docs/conventions/api.md) · [Error codes](docs/conventions/error-codes.md) · [WebSocket](docs/conventions/websocket.md) · [Data](docs/conventions/data.md) · [Code style](docs/conventions/code-style.md)
- [Architecture Decision Records](docs/adr/README.md)
