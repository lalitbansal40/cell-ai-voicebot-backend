# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Phase 5 · Batch 3 (T5.10–T5.15) — Phase 5 complete** — 2026-10-10
  - Frontend agents list, template picker, editor, functions, knowledge pages, playground and superadmin AI — see the frontend CHANGELOG.
  - Playwright: 6 AI tests (21 total, green twice); backend logs of the run free of secrets, messages, persona text and phones.
  - Fixed: empty tool arguments / variables were dropped by MongoDB and crashed the playground UI.
  - Sign-off: [PHASE_5_SIGNOFF.md](docs/phases/PHASE_5_SIGNOFF.md) (gap audit, numbers, deviations, TODOs by phase, pending inputs).
  - Backend tests: 1526.

- **Phase 5 · Batch 2 (T5.6–T5.9)** — 2026-10-09
  - Turn runtime: gates (agent off, wallet empty, spend caps), knowledge retrieval, tool loop with guarded custom functions and simulated built-ins, reply guardrails with one retry, fallbacks, one idempotent charge per turn, per-agent spend counters, redacted tool-call logs.
  - Playground API: sessions from a contact or manual values (+ test phone for functions only), opening line, messages with `clientTurnId` replay, outcomes, reset, 30 / min / user.
  - Superadmin: AI prices on rate cards, `/admin/ai/config`, AI counts in the month summary.
  - Seed (AI agents, "Demo Finance FAQ" knowledge base, mock payments), sample knowledge documents, `bench:retrieval`, ADR 0033, `docs/setup/openai.md`, API / data / security / compliance / cost docs.
  - Fixed: audit meta dropped token-count keys (AI price diffs); knowledge search was diluted by the previous reply.
  - Fixed: a Phase 3 retention test depended on the real clock and started failing on 2026-10-10.
  - Tests: 1475 → 1526.

- **Phase 5 · Batch 1 (T5.1–T5.5)** — 2026-10-09
  - Models (AI agents, knowledge bases / sources / chunks, playground sessions, tool calls, agent usage, dev mock payments), migration 0006, AI env (`AI_PROVIDER`, OpenAI base URL / models, private-host and mock-API switches with production refusals), `AI_LIMITS`, 4 error codes, 10 audit actions, 2 WS events, `ai` queue + worker, AES-256-GCM secret box, AI prices on rate cards and ledger token breakdowns.
  - AI providers: OpenAI REST client (retries, `Retry-After`, timeouts, error mapping) and a deterministic fake provider; token pricing; prepaid + per-agent daily / monthly spend caps in the account timezone.
  - `/agents`: CRUD, search, duplicate, activate / deactivate, 4 Hinglish templates, catalog, variables, compile preview (pure prompt compiler with safety / recovery rules) and usage.
  - Custom functions: sealed write-only secret headers, SSRF-safe executor (DNS checked first, pinned connect, port allow-list, redirects re-checked, 64 KB / time caps), templating, Test button with redacted tool-call log; built-in tools (simulated); dev-only `/mock/payment-status`. Docs: `docs/conventions/security.md`.
  - `/knowledge-bases`: files (PDF / DOCX / TXT / MD, magic-byte checked) and web pages, parsing, chunking, batched embeddings, in-memory vector search with LRU cache, ingest job with progress events and embedding charges, reindex, delete cascade, test search. Dependencies: `mammoth`, `html-to-text`, `unpdf` (now runtime).
  - Tests: 1176 → 1475.

- **Phase 4 · Batch 3 (T4.11–T4.15) — Phase 4 complete** — 2026-10-09
  - `GET /admin/billing/config` (simulator on / off, payment provider) for the superadmin UI.
  - Frontend wallet, Add money, transactions, usage, invoices, billing details, bell, banner and superadmin billing pages; 5 Playwright wallet scenarios (15 total, green twice) — see the frontend CHANGELOG.
  - Sign-off: [PHASE_4_SIGNOFF.md](docs/phases/PHASE_4_SIGNOFF.md) (gap audit, numbers, deviations, TODOs by phase, pending inputs).
  - Backend tests: 1176 (the config endpoint is covered inside the admin billing suite).

- **Phase 4 · Batch 2 (T4.6–T4.10)** — 2026-10-09
  - Payments: `PaymentProvider` interface, Razorpay REST client (timing-safe signatures, 10 s timeout) and a fake provider for dev / tests / E2E (refused in production).
  - Top-ups: `POST /wallet/topups` (Idempotency-Key, ₹100 – ₹5,00,000, 10 / hour, billing profile required, GST on top) → checkout → `verify` or `fake-complete`; list / detail; one transaction marks the order paid, credits the wallet and allocates the invoice number. Orders expire after 24 h.
  - Webhook `POST /webhooks/razorpay`: raw body, HMAC, event-id dedupe, credit / fail / unmatched / mismatch / refund outcomes, superadmin notices; never logs bodies or signatures.
  - GST invoices: `CAV/<FY>/000001` per Indian financial year (no gaps), CGST + SGST or IGST, PDF via pdfkit with bundled Noto Sans fonts (OFL) in the `invoice.render` job, receipt email after the first render, `/invoices` list / detail / 15-minute signed download.
  - Superadmin billing: default and per-account rate cards with history and diff audit, account wallet / ledger, credit limit, adjustments (Idempotency-Key, both-side audit, bell), billing simulator, IST month summary, payments and payment events.
  - Seed: Demo Finance billing profile, ₹1,000 opening credit, simulated calls (held / charged / released), a fake top-up with its invoice — idempotent. `npm run bench:wallet` (1,000 × hold → settle, 20 workers: 0 failures, wallet = Σ ledger).
  - Docs: ADR 0032, `docs/setup/razorpay.md`, README "Wallet & billing", API idempotency usage, GST notes and CA questions in compliance notes.
  - Tests: 1089 → 1176.

- **Phase 4 · Batch 1 (T4.1–T4.5)** — 2026-10-09
  - Models: wallets (one per account, created at signup / migration 0005), insert-only ledger (only `held → released`), rate cards (platform default + history), top-up orders, invoices, invoice counters, payment events, notifications; account billing profile. `shared/money.ts` (micros, bps, paise guard, Indian format, amount in words), GSTIN checksum, GST states.
  - Env: `PAYMENT_PROVIDER` (fake outside production), seller details, SAC, invoice prefix, simulator flag (+ production rules). Catalogue: 2 error codes, `platform.billing.manage`, `wallet.exhausted`, richer `wallet.updated`, 6 audit actions, `billing` queue.
  - Billing engine (the only writer of money): credit, hold / extend / settle / release for calls, prepaid AI / TTS charges, adjustments — conditional updates in transactions, idempotency keys, budgets, month spend in the account timezone, effects after commit. Rate cards + pure pricing (pulse, AI per second, TTS per 1k chars, commission bps, estimates).
  - APIs: `/wallet` (view, settings, rates, estimate, ledger + CSV export, usage), `/billing/profile`, `/billing/states`, `/notifications` (bell).
  - Alerts (low balance / exhausted: bell + email, once per 24 h), stale-hold reaper, daily reconciliation.
  - Fixed: a timing-flaky idempotency test.
  - Tests: 936 → 1089.

- **Phase 3 · Batch 3 (T3.13–T3.18) — Phase 3 complete** — 2026-10-09
  - `PUT /contact-imports/:id/mapping` with only a new `sheet` (empty `columns`) switches the xlsx sheet before mapping.
  - The xlsx sample has a second 2-row sheet ("Old loans") for the sheet picker; CSV / DND samples unchanged.
  - Playwright E2E (frontend repo) covers the sample import "Done when", XLSX, segments + bulk + export, DND roles and agent read-only.
  - Tests for cross-account isolation of export jobs / scopes.
  - Fixed: an import that revives a deleted contact kept wiping its opt-out date and call history; `/auth/refresh` now has its own limit (600 / 15 min per IP — it runs on every page load) instead of the 30 of the brute-forceable auth routes; the global per-IP limit is 1,200 / min (300 locked out an office behind one NAT).
  - Tests: 934 → 936. Phase 3 [sign-off](docs/phases/PHASE_3_SIGNOFF.md).

- **Phase 3 · Batch 2 (T3.7–T3.12)** — 2026-10-09
  - Contact imports: upload `.csv` / `.xlsx` (type + magic bytes, 10 MB, 50,000 rows, 100 columns, zip-bomb guard, Windows-1252 fallback, delimiter detection, sheet choice), suggested mapping (Hinglish headers, type guess), dry-run validation with problem rows + injection-safe error CSV, batched import (resume after crash, cancel, one per account, E11000 retry, stops on suspension), DND uploads, CSV template. ADR 0031.
  - Bulk actions (≤ 1,000 ids or a filter in the background) and CSV exports (scopes, columns, BOM, injection-safe, 24 h, blocked while impersonating).
  - Retention: deleted contacts / lists after 30 days, import files + error reports after 30 days, exports after 24 h.
  - `db:seed` demo contacts; sample sheets (`docs/samples`, `npm run samples:contacts`); `npm run bench:contacts`.
  - Fixed during the checkpoint: import totals after a crash; default list names in the account timezone.
  - Tests: 821 → 934.

- **Phase 3 · Batch 1 (T3.1–T3.6)** — 2026-10-09
  - Models: contacts, lists, custom fields, segments, DND entries, import / export jobs (+ indexes); migration `0004` adds `dnd.manage` (owner / admin); `CONTACT_LIMITS`; `IMPORT_FILE_INVALID`; `contacts` queue + worker; storage and job queue passed to the API router; 3 WS events (docs-sync test); 14 audit actions.
  - Normalisation library: phones (account country, Excel lost digits), Indian number grouping, currency as micros, dates (DD/MM default, Excel serials), Unicode tags — 100 % covered.
  - APIs: custom fields, contacts (CRUD, search any phone format, filters, sort with collation), contact tags, lists (live counts), segments (preview, broken-condition report), do-not-call + opt-out. Conflict errors carry `existingId`.
  - Fixed during the checkpoint: search by a number typed with a leading `0` / `00`; Hindi vowel signs in tags.
  - Tests: 540 → 821.

- **Phase 2 · Batch 3 (T2.13–T2.18)** — 2026-10-08
  - `PATCH /api/v1/auth/me` (profile name / phone) for the frontend Settings page.
  - Refresh rotation: a token rotated < 10 s ago whose successor is unused gets a fresh successor (lost response, e.g. reload mid-refresh) instead of revoking the session; any other replay is still reuse.
  - Timezone validation accepts current IANA names that ICU only knows as aliases (`Asia/Kolkata`), rejects raw offsets.
  - Coverage gate raised to 95 / 80 / 90 / 95 (Phase 2 values rounded down). Flaky email-queue test fixed.
  - Playwright E2E (frontend repo) runs this backend with an isolated `cav_e2e` database.
  - Tests: 520 → 540. Phase 2 [sign-off](docs/phases/PHASE_2_SIGNOFF.md).

- **Phase 2 · Batch 2 (T2.7–T2.12)** — 2026-10-08
  - Account settings API (`/api/v1/account`) with validated timezone, country, language and calling window; merged nested settings.
  - Team: invites (email link, resend, revoke, accept + sign in, invite info), role changes, enable / disable, removal, ownership transfer — owner / self / admin rules, immediate token invalidation.
  - API keys: scoped, `cav_live_` / `cav_test_`, SHA-256 stored, shown once, max 20, `whoami`.
  - Audit log API (cursor, filters, actor names), typed 27-action catalogue = `docs/conventions/audit.md`, daily purge (`maintenance` queue), refresh-reuse audited.
  - Superadmin: accounts list / detail, suspend / enable, 30-minute impersonation (no refresh cookie, sensitive actions blocked), both-side audit.
  - `POST /api/v1/ws/tickets` + auth events (`session.revoked` closes the user's sockets, `user.updated`, `team.changed`, `account.updated`, `account.suspended`, `account.enabled`).
  - Tests: 456 → 520.

- **Phase 2 · Batch 1 (T2.1–T2.6)** — 2026-10-08
  - Tenancy & auth models (accounts, users, roles, refresh tokens, auth codes, API keys, immutable audit log), permission catalogue + 5 system roles, migrations 0002 (platform account) / 0003 (sync roles), `npm run db:seed`, `npm run superadmin:create`.
  - argon2id passwords + policy (1,000 common passwords), HS256 access JWT (`jose`), rotating refresh cookie with reuse detection, email OTP + reset tokens, 7 new auth error codes, `Retry-After` support, stronger log redaction.
  - `authenticate` / permission guards / `apiKeyAuth` / Origin check / tenant helpers + a security test that modules never read `accountId` from the request.
  - Signup + email OTP, login (per-email lockout), refresh, logout, logout-all, me, sessions, forgot / reset / change password; realtime `pushToUser`.
  - Fixes from the checkpoint: no OTP in email subjects (subjects are logged); gitleaks allowlist for the common-password list.
  - Tests: 310 → 456.

- **Phase 1 · Batch 3 (T1.13–T1.16) — Phase 1 complete** — 2026-10-08
  - Email: `EMAIL_DRIVER` (smtp | log; production requires smtp), `SMTP_SECURE`, pooled nodemailer SMTP provider, log provider (masked, never the body), escaped TS templates with text parts, BullMQ `email` queue (5 attempts, SMTP 5xx not retried, 24 h dedupe), shutdown hook `email` (35), Mailpit in docker-compose (1025 / 8025), `npm run email:test`, ADR 0030.
  - API docs: `GET /api/v1/openapi.json` (always on, `servers = APP_URL`, ETag), Swagger UI at `/api/docs` behind `API_DOCS_ENABLED` (off in production by default) with a strict route-level CSP; app version read from package.json (correct under `node dist`); `@scarf/scarf` install script denied.
  - Conventions: client-only error codes, frontend WS client notes (websocket.md §11); CORS exposes `Idempotent-Replayed`.
  - `startServer(options)` injectable; full-server e2e test (requests, WS, email, ordered shutdown); WS per-account limit + max-topics tests; env-docs sync test; coverage gate (90/80/90/90) in CI.
  - Docs: fresh-machine run guide + ports table, Phase 1 sign-off ([PHASE_1_SIGNOFF.md](docs/phases/PHASE_1_SIGNOFF.md)).
  - Fix (found in the checkpoint): `closeAllQueues` bounded to 5 s — after a Redis restart BullMQ `worker.close()` could hang and the shutdown never reached the email / redis / mongo hooks.
  - Tests: 248 → 310.

- **Phase 1 · Batch 2 (T1.7–T1.12)** — 2026-10-08
  - MongoDB: mongoose 9 connection (strictQuery, autoIndex off in production, redacted URI logs), `withTransaction`, index sync in dev/test, `db:sync-indexes`, plugins (base `id` JSON, tenant `accountId`, soft delete incl. aggregate + `withDeleted`), migrations runner with lock + baseline (`db:migrate`, `db:migrate:down`, `db:migrate:status`).
  - Redis + BullMQ: separate app / queue / subscriber connections, queue + worker factory with default job options and graceful close, `system` heartbeat worker, `WORKERS_ENABLED`, Redis-backed rate-limit store shared across instances; CI Redis service.
  - `GET /health` (liveness) and `GET /ready` (Mongo + Redis, 503 when down or shutting down) at the root; OpenAPI regenerated.
  - WebSocket `/ws/events`: single-use Redis tickets (`GETDEL`), close codes 4001/4003/4008/4009/4010, limits, heartbeat, topic subscribe, Redis `ws:fanout` across instances; `npm run ws:dev-ticket`.
  - Idempotency-Key middleware + model (24 h TTL, 422/409, `Idempotent-Replayed`, 5xx not stored) — not mounted on routes yet.
  - Storage: `StorageProvider` with local (HMAC-signed `/files/*key` URLs) and S3 (multipart upload, presigned URLs) drivers.
  - Graceful shutdown order http → ws → queues → redis → mongo; tests share one in-memory replica set.
  - Tests: 139 → 248.

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
