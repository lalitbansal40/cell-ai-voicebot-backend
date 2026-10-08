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

| Script | What it does |
| --- | --- |
| `npm run dev` | Run the app with `tsx` in watch mode |
| `npm run build` | Compile `src/` to `dist/` (`tsconfig.build.json`) |
| `npm start` | Run the compiled app (`dist/index.js`) |
| `npm run typecheck` | Type-check everything (src, tests, scripts) without emitting |
| `npm run clean` | Delete `dist/` |

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

Run `npm approve-scripts --allow-scripts-pending` after adding dependencies to review new ones.

## Environment variables

_To be filled (T0.10)._

## Docs

All project docs (plans, ADRs, conventions) live in [`docs/`](docs/README.md).

## Conventions

- [Definition of Done](docs/conventions/definition-of-done.md)
- [Architecture Decision Records](docs/adr/README.md)
