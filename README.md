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

| Script                  | What it does                                                 |
| ----------------------- | ------------------------------------------------------------ |
| `npm run dev`           | Run the app with `tsx` in watch mode                         |
| `npm run build`         | Compile `src/` to `dist/` (`tsconfig.build.json`)            |
| `npm start`             | Run the compiled app (`dist/index.js`)                       |
| `npm run typecheck`     | Type-check everything (src, tests, scripts) without emitting |
| `npm run clean`         | Delete `dist/`                                               |
| `npm run lint`          | ESLint (type-aware), fails on any warning                    |
| `npm run lint:fix`      | ESLint with auto-fix                                         |
| `npm run format`        | Prettier write                                               |
| `npm run format:check`  | Prettier check                                               |
| `npm test`              | Run all tests once (Vitest)                                  |
| `npm run test:watch`    | Vitest watch mode                                            |
| `npm run test:coverage` | Tests + coverage report in `coverage/`                       |
| `npm run infra:up`      | Start MongoDB + Redis (Docker) and wait until healthy        |
| `npm run infra:down`    | Stop containers (keeps data)                                 |
| `npm run infra:reset`   | ⚠️ Stop containers and delete data volumes                   |
| `npm run infra:logs`    | Follow container logs                                        |
| `npm run infra:ps`      | Container status                                             |

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

## Environment variables

_To be filled (T0.10)._

## Docs

All project docs (plans, ADRs, conventions) live in [`docs/`](docs/README.md).

## Conventions

- [Definition of Done](docs/conventions/definition-of-done.md)
- [Architecture Decision Records](docs/adr/README.md)
