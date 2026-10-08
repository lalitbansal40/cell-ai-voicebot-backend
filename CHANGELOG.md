# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Phase 1 · Batch 1 (T1.1–T1.6)** — 2026-10-08
  - Env config: zod schema for every variable, fail-fast startup, names-only errors, production rules (JWT ≥ 32 chars, 32-byte `ENCRYPTION_KEY`, explicit URLs/CORS); new `TRUST_PROXY`, `CLIENT_SSH_KEY_PATH`.
  - Logging: pino + pino-http, `X-Request-Id`, redaction, phone/email masking, no query strings/bodies in logs.
  - Errors: `ERROR_CODES` (test-synced with the doc), `AppError` family, success/error envelopes, error + 404 handlers.
  - Express 5 app (`createApp`), server bootstrap, ordered graceful shutdown with 15 s timeout, `GET /api/v1/system/info`.
  - Validation: `validate` / typed `handle()` (results on `req.valid`), shared schemas (ObjectId, pagination, cursor, sort allowlist, E.164 phone, money micros, strict query).
  - Security: helmet, CORS allowlist, body limits (JSON 1 MB / form 100 KB), rate limiting (draft-6 headers, 429 envelope), `trust proxy`.
  - Tests: 13 → 139.

- **Phase 0 · Batch 1 (T0.1–T0.10)** — 2026-10-08
  - Repo hygiene: `.gitignore`, `.gitattributes`, `.editorconfig`, PR template; branches `main` → `dev` → `feature/phase-0-setup` (both repos).
  - Docs home in `docs/` (plans, phases, prompts, ADRs, conventions, setup, client, PoC/cost/compliance placeholders); task tracker; task prompt template; Definition of Done.
  - 28 Architecture Decision Records (`docs/adr/`).
  - Backend scaffold: Node 24 + TypeScript 6 (strict, NodeNext/CommonJS), module-based folder structure, `tsx` dev runner.
  - Frontend scaffold (separate repo): Vite 8 + React 19 + MUI 9 + React Router 8 + React Query + notistack.
  - Tooling (both repos): ESLint 9 (type-aware) + Prettier + Husky + lint-staged + commitlint.
  - Tests: Vitest (backend unit + MongoDB replica-set transaction smoke test via mongodb-memory-server; frontend RTL page tests).
  - Local infra: Docker Compose with MongoDB 8.2 single-node replica set (27018) and Redis 7.4 (6380).
  - `.env.example` (both repos) and secrets policy.

- **Phase 0 · Batch 2 (T0.11–T0.14)** — 2026-10-08
  - Conventions: API (envelopes, pagination, idempotency, headers), error code catalogue, WebSocket (single-use tickets, event catalogue, media protocol), data (tenancy, soft delete, PII inventory), code style.
  - OpenAPI 3.1 generated from zod schemas (`npm run gen:openapi`, `openapi:check`); frontend types generated with `openapi-typescript` (`npm run gen:api`) — ADR 0029.
  - Core data model draft with Mermaid ERDs (`docs/conventions/data-model.md`).
  - GitHub Actions CI (verify, gitleaks secrets scan, npm audit, commitlint), Dependabot, `.gitleaks.toml`, GitHub settings guide.

- **Phase 0 · Batch 3 (T0.15–T0.17)** — 2026-10-08
  - Voice AI PoC tooling (`poc/voice-ai`): OpenAI Realtime client (verified GA API, PCM 24 kHz + G.711 μ-law), 14 automated scenarios with auto-checks, real-time TTS customer, latency/cost metering with `POC_MAX_USD` cap, browser test mode, TTS check, report generator, 28 unit tests. **Live runs pending — no OpenAI key; OpenAI spend so far: $0.**
  - Local SIP lab (`poc/sip-lab`): Asterisk 20 + ARI + ExternalMedia, SIPp caller — end-to-end pass (142 RTP packets, DTMF 5/7); Asterisk recommended for Phase 13 (ADR 0022 note).
  - Per-minute cost model draft (`docs/cost/cost-model.md`, `poc/cost-model/calc.mjs`) — AI and telephony inputs still estimates.

- **Phase 0 · Batch 4 (T0.18–T0.20)** — 2026-10-08
  - Compliance research notes (TRAI 140/1600 series, RBI recovery 08:00–19:00 drafts, DPDP Rules 2025 timeline, recording / AI disclosure) + client legal questions.
  - Read-only client server audit script (`npm run server:audit`) + template — **blocked: SSH key not available**.
  - Phase 0 sign-off (`docs/phases/PHASE_0_SIGNOFF.md`), build-plan decisions table, updated risk register, Phase 1 detailed plan.
- **Phase 0 complete** (release `v0.0.1` to be tagged after merge). Pending inputs: OpenAI key (PoC live runs), client SSH key (server audit), client answers (SIP, DB, domain, telephony rate).

### Changed

- Plan updates: Node 20 → 24 LTS (Node 20 EOL), MongoDB 8.0 → 8.2 (8.0 fails on Linux kernel ≥ 6.19), ports → 5100/3100/27018/6380, React 18 → 19, ESLint 10 → 9 (plugin peer compatibility), TypeScript 7 → 6.0 (typescript-eslint support); `openapi-typescript` runs on TS 6 via npm `overrides` (ADR 0029); lint-staged skips ESLint-ignored files (`--no-warn-ignored`).
