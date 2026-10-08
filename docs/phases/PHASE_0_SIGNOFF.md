# Phase 0 — Sign-off

**Date:** 2026-10-08 · **Branch:** `feature/phase-0-setup` (both repos, not merged) · **Plan:** [PHASE_0_PLAN.md](PHASE_0_PLAN.md) · **Tracker:** [PHASE_0_TASKS.md](PHASE_0_TASKS.md)

**Verdict:** ✅ Phase 0 complete for everything that can be done without external inputs. Two items are **⚠️ blocked on inputs** (OpenAI key → PoC live runs; client SSH key → server audit). **Phase 1 can start** — neither blocker affects it.

Verification on 2026-10-08: fresh clone of both repos → `npm ci`, lint, format check, typecheck, tests (backend 13, frontend 7), build, `openapi:check`, frontend `gen:api` against the cloned backend spec (no diff) — all ✅. PoC packages: voice-ai 28 tests, sip-lab app 5 tests ✅. gitleaks: no leaks in either repo's history.

## 1. Tasks — "Done when" check

| Task                   | Status     | Evidence (commit; fe = frontend repo)          | Notes                                                                              |
| ---------------------- | ---------- | ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| T0.1 Prerequisites     | ✅         | [prerequisites.md](../setup/prerequisites.md)  | Node 24.19, Docker 29.7, Compose 5.4; manual items listed for the project lead     |
| T0.2 Git hygiene       | ✅         | `e8e0377` (backend), `51ff79a` (fe) (frontend) | `main` / `dev` / `feature/phase-0-setup`; `.env` never committed                   |
| T0.3 Docs home         | ✅         | `3eaf6c2`                                      | Docs in backend `docs/`; templates, DoD, CHANGELOG                                 |
| T0.4 ADRs              | ✅         | `a2422b4` + updates                            | 29 ADRs (0001–0029); 0011, 0021 `proposed`, 0022, 0025 `deferred` (reasons inside) |
| T0.5 Backend scaffold  | ✅         | `c12291c`                                      | Node 24, TS 6 strict, module-based layout                                          |
| T0.6 Frontend scaffold | ✅         | `06772cb` (fe)                                 | Vite 8, React 19, MUI 9, Router 8, React Query                                     |
| T0.7 Code quality      | ✅         | `160618d`, `620c817` (fe), `e9a76f2`           | ESLint 9 type-aware, Prettier, Husky, lint-staged, commitlint                      |
| T0.8 Testing           | ✅         | `51df96d`, `d826fc8` (fe)                      | Vitest; replica-set transaction smoke test                                         |
| T0.9 Local infra       | ✅         | `96c8c36`                                      | MongoDB **8.2** replica set + Redis 7.4 (8.0 fails on kernel ≥ 6.19)               |
| T0.10 Env & secrets    | ✅         | `c1da7d4`, `492488f` (fe)                      | `.env.example` both repos, [secrets.md](../conventions/secrets.md)                 |
| T0.11 Conventions      | ✅         | `6bae4b7`, `5272285` (fe)                      | api, error-codes, websocket, data, code-style                                      |
| T0.12 Shared types     | ✅         | `2dce078`, `c7762aa` (fe)                      | zod → OpenAPI 3.1 → `openapi-typescript`; ADR 0029                                 |
| T0.13 Data model       | ✅         | `bd05f8c`                                      | [data-model.md](../conventions/data-model.md) — 3 Mermaid ERDs (rendered OK)       |
| T0.14 CI               | ✅ (local) | `4c03658`, `d956bbf` (fe)                      | actionlint clean, gitleaks clean; **runs on GitHub only after push**               |
| T0.15 Voice AI PoC     | ⚠️ partial | `1c60147`, `74b07b4`                           | Tooling + 28 tests done; **live runs pending — no OpenAI key** (spend $0)          |
| T0.16 SIP lab          | ✅         | `dcb390c`                                      | End-to-end pass: 142 RTP packets + DTMF; Asterisk recommended                      |
| T0.17 Cost model       | ✅ (draft) | `031000d`                                      | AI + telephony inputs are estimates until PoC / client answers                     |
| T0.18 Compliance       | ✅         | `cc49bc3`                                      | TRAI / RBI / DPDP notes, feature mapping, legal questions                          |
| T0.19 Server audit     | ⚠️ blocked | `3fa7295`                                      | Read-only tooling ready; **no SSH key on this machine**                            |
| T0.20 Sign-off         | ✅         | this document                                  | Phase 1 plan: [PHASE_1_PLAN.md](PHASE_1_PLAN.md)                                   |

## 2. Deliverables checklist (PHASE_0_PLAN §3)

| Deliverable                                                                     | Status                                                                                                                                                                 |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend repo: scaffold, scripts, strict tsconfig, folder structure, hello entry | ✅                                                                                                                                                                     |
| Frontend repo: Vite + React + TS + MUI + React Query, hello page                | ✅                                                                                                                                                                     |
| ESLint, Prettier, Husky, lint-staged, EditorConfig — both repos                 | ✅                                                                                                                                                                     |
| Vitest — both repos, sample tests pass                                          | ✅                                                                                                                                                                     |
| Docker Compose: Mongo (replica set) + Redis                                     | ✅                                                                                                                                                                     |
| `.env.example` both repos, secrets policy                                       | ✅                                                                                                                                                                     |
| CI green, branch protection, Dependabot                                         | ⚠️ CI + Dependabot configured and validated locally; green run + branch protection need **push + GitHub settings** ([github-settings.md](../setup/github-settings.md)) |
| README both repos (setup verified on fresh clone)                               | ✅                                                                                                                                                                     |
| ADRs                                                                            | ✅ 0001–0029                                                                                                                                                           |
| Conventions: API, WebSocket, data, code style, secrets                          | ✅ (+ error codes, data model)                                                                                                                                         |
| Data model ERD                                                                  | ✅                                                                                                                                                                     |
| Shared types proof                                                              | ✅                                                                                                                                                                     |
| Voice AI PoC results + recommendation                                           | ⚠️ tooling + verified facts + estimates; measured results pending key                                                                                                  |
| SIP lab notes                                                                   | ✅                                                                                                                                                                     |
| Cost model draft                                                                | ✅                                                                                                                                                                     |
| Compliance notes                                                                | ✅                                                                                                                                                                     |
| Server audit note                                                               | ⚠️ template + script; findings pending key                                                                                                                             |
| Task prompt template, Definition of Done, CHANGELOG                             | ✅                                                                                                                                                                     |

## 3. Open items (owner: project lead unless noted)

1. **Push** both repos (`git push -u origin main dev feature/phase-0-setup`), apply [GitHub settings](../setup/github-settings.md), check the first CI run, then merge `feature/phase-0-setup → dev → main` and tag **`v0.0.1`** (`git tag -a v0.0.1 -m "Phase 0 complete" && git push origin v0.0.1`).
2. **OpenAI API key** in backend `.env` → run the PoC ([results doc — How to complete](../poc/voice-ai-poc-results.md#how-to-complete)) → update ADR 0021 + cost model.
3. **Client SSH key** → `npm run server:audit` → fill [server-audit.md](../client/server-audit.md) → ADR 0025.
4. **Client answers**: SIP details, DID, codecs, DB, domain, telephony rate/pulse ([answers.md](../client/answers.md)) + compliance questions C1–C10.
5. **Mantis license** confirmation (ADR 0011).
6. **Rotate exposed secrets** before production ([secrets.md](../conventions/secrets.md#rotation)).
7. Note: local `main` in the backend repo contains one extra commit (`7b61133`, the batches 2–4 prompt) that is also on `feature/phase-0-setup`; merging the feature branch resolves it.
