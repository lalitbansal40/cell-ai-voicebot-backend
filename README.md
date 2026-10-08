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
- **MongoDB in tests:** `mongodb-memory-server` starts a real replica set; the MongoDB version is pinned in `package.json` → `config.mongodbMemoryServer.version` (`8.0.32`, same major as Docker). The first run downloads the binary (~100 MB) into the npm cache.
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
