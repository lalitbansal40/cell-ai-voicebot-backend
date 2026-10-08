# Prerequisites & Machine Setup

## Verified dev machine (2026-10-08, task T0.1)

| Tool | Version | Status |
| --- | --- | --- |
| macOS | 26.6.2 (Apple Silicon, arm64) | ✅ |
| Node.js | v24.19.0 | ✅ (project requires Node 24 LTS) |
| npm | 11.17.0 | ✅ |
| Docker | 29.7.2 | ✅ (Docker Desktop must be running) |
| Docker Compose | v5.4.0 | ✅ |
| git | 2.54.0 | ✅ |
| nvm / fnm | not installed | optional |
| Homebrew | not installed | optional |
| GitHub CLI (`gh`) | not installed | optional |
| Remote access | `git ls-remote origin` works for both repos | ✅ |

## Required tools

| Tool | Why | Install |
| --- | --- | --- |
| **Node.js 24 LTS** | Runtime for backend + frontend tooling | <https://nodejs.org> installer, or a version manager (`nvm install 24`, `fnm install 24`). Repos contain `.nvmrc` = `24` and `engine-strict=true` |
| **npm ≥ 10** | Package manager (lockfiles are committed) | Ships with Node |
| **Docker Desktop** | Local MongoDB (replica set) + Redis via `docker compose` | <https://www.docker.com/products/docker-desktop> — keep it running while developing |
| **git** | Version control | Xcode Command Line Tools / git-scm.com |

## Recommended tools

- **VS Code** with extensions (also listed in each repo's `.vscode/extensions.json`): ESLint, Prettier, EditorConfig, DotENV, Docker, MongoDB for VS Code.
- **MongoDB Compass** — browse the local DB: `mongodb://127.0.0.1:27018/?replicaSet=rs0`.
- **RedisInsight** (optional) — `redis://127.0.0.1:6380`.
- `curl`, `jq`.

## Manual items (owner: project lead)

- [ ] **OpenAI API key** with Realtime model access, billing enabled, and a usage budget cap (e.g. $20 for the PoC).
- [ ] **Password manager** chosen (Bitwarden / 1Password / …) — all secrets live there.
- [ ] **Client SSH key file** stored in the password manager and in `~/.ssh/` with `chmod 400`. Never in a repo.
- [ ] VS Code extensions installed.
- [ ] MongoDB Compass installed.
- [ ] GitHub branch protection on `main` (after CI is added in T0.14).
- [ ] Push the local branches (`main`, `dev`, `feature/phase-0-setup`) for both repos.

## Risks noted during setup

- The client's production database type is **unknown** (password shared, but not the engine). If it is not MongoDB, we run our own MongoDB for production (decided in Phase 12).
- Docker Desktop must be started manually on this machine before `npm run infra:up`.
