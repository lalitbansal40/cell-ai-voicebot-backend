# Cell AI Voicebot — Backend

Multi-tenant AI voice calling platform API (Node.js + Express + TypeScript + MongoDB).

## Status

**Phase 8 — Campaigns & Call Scheduler: complete** ([sign-off](docs/phases/PHASE_8_SIGNOFF.md)); Phase 7 [sign-off](docs/phases/PHASE_7_SIGNOFF.md), Phase 6 [sign-off](docs/phases/PHASE_6_SIGNOFF.md), Phase 5 [sign-off](docs/phases/PHASE_5_SIGNOFF.md), Phase 4 [sign-off](docs/phases/PHASE_4_SIGNOFF.md), Phase 3 [sign-off](docs/phases/PHASE_3_SIGNOFF.md), Phase 2 [sign-off](docs/phases/PHASE_2_SIGNOFF.md), Phase 1 [sign-off](docs/phases/PHASE_1_SIGNOFF.md). Next: Phase 9 (call records, transcripts & analytics). Tasks: [docs/phases/PHASE_8_TASKS.md](docs/phases/PHASE_8_TASKS.md) · Changes: [CHANGELOG.md](CHANGELOG.md).

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
- Dev helpers: `npm run samples:contacts` (sample sheets), `npm run fixtures:knowledge` (knowledge test files in `tests/fixtures/knowledge/` — PDF, DOCX, Hindi, Windows-1252, scanned, prompt-injection; deterministic), `npm run bench:contacts [rows]` (50,000-row import + query timings; throw-away account). Last run: validate 0.6 s, import 4.6 s, list queries p95 ≤ 93 ms.

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

## AI agents & knowledge (Phase 5)

AI agents that talk in Hinglish / Hindi / English, call the client's APIs safely, answer from company documents and are tested in a text playground billed from the wallet — [ADR 0033](docs/adr/0033-ai-agents-knowledge-tools.md).

- **Agents** (`/api/v1/agents`, `agents.read` / `agents.write`; writes blocked while impersonating): 4 templates (loan recovery Hinglish, payment reminder, feedback survey, inbound support), persona / opening / closing lines, allowed contact variables, voice and language, tone rules, caps (daily / monthly, `stop` or `fallback`), guardrails (never-say list, disclosure line, recovery compliance), fallbacks, knowledge links, duplicate / activate. `POST /agents/:id/compile-preview` shows exactly what the AI is told.
- **Functions**: the client's APIs as tools — parameter list (validated), URL / header / JSON body templates (`{{args.x}}`, `{{contact.phone}}`…), secret headers sealed and write-only, SSRF-safe executor, Test button (20 / min / user). Built-in tools (end call, transfer, disposition, callback, promise to pay, SMS) are simulated in the playground. Rules: [docs/conventions/security.md](docs/conventions/security.md).
- **Knowledge** (`/api/v1/knowledge-bases`): PDF / DOCX / TXT / MD files and web pages → parsed, chunked, embedded in the background (`ai` queue, WS progress), searched in-process (cosine + keyword boost), "Try a question" search.
- **Playground** (`/api/v1/agents/:id/playground/sessions`): a contact's allowed values or manual values + an optional test phone (functions only), opening line as turn 1, messages with `clientTurnId` (replay-safe), outcomes, reset; 30 messages / min / user; one `ai_charge` per turn.
- **Providers**: `AI_PROVIDER=fake` (default without a key — deterministic rules, used by tests and E2E) or `openai` (required in production) — setup and live checklist: [docs/setup/openai.md](docs/setup/openai.md). Dev-only mock payment API `GET /api/v1/mock/payment-status?phone=` (even last digit = paid, odd = unpaid; `MOCK_APIS_ENABLED`, never in production).
- **Superadmin**: AI prices on rate cards, `/admin/ai/config`, AI counts in the month summary.
- **Dev**: `npm run db:seed` adds "Recovery Bot (Hinglish)" (active, knowledge linked), "Payment Reminder" (inactive), the "Demo Finance FAQ" knowledge base (3 samples from `docs/samples/knowledge/`) and mock payment answers for the demo contacts; `npm run samples:knowledge`, `npm run fixtures:knowledge`; `npm run bench:retrieval [chunksPerKb] [searches]` (last run: 6,000 chunks, warm p50 9.2 ms · p95 10.1 ms, cold 586 ms, cache 40 MB).

## Call flows (Phase 6)

Visual call flows (IVR menu + AI agent + API checks + actions) with drafts, immutable published versions and a text simulator — [ADR 0034](docs/adr/0034-call-flow-engine.md).

- **Flows** (`/api/v1/flows`, `flows.read` / `flows.write` / `flows.publish`; writes blocked while impersonating): 15 node types (start, speak, play audio, keypad menu / digits, listen + intents, AI agent, API request, condition, set variable, set disposition, transfer, SMS, WhatsApp, wait, hang up), draft saves with a `revision` (409 on a stale save), `validate` (23 issue codes), publish → v1, v2 … (immutable), restore, duplicate, archive, delete (30-day purge), export / import JSON (secrets never exported), 4 templates (Loan recovery, Payment reminder, Feedback survey, Inbound support), catalog, variables.
- **Engine** (`src/core/engine/`): `advance()` runs a flow from JSON state with one input and returns host actions; loop / visit / duration guards, error exits + a flow error handler, trace, node stats. The simulator uses it now, the Phase 7 voice runtime later.
- **Simulator** (`/api/v1/flows/:id/simulations`): draft / published / version, a contact or manual values + test phone, inputs (keys, words, silence, transfer result, hang up) idempotent by `clientInputId`, transcript + trace, AI turns billed (`flow_simulator`), node stats (`/flows/:id/stats`).
- **Audio** (`/api/v1/flow-audio`): WAV / MP3 prompts (5 MB, 120 s), signed playback URLs.
- **Builder UI** (frontend repo): flows list, template picker, visual builder with step settings, simulator panel, versions and stats — Playwright proves every Loan recovery branch (`e2e/flows-*.spec.ts`).
- **Dev**: `npm run db:seed` adds "Loan recovery" (published v1, AI node → "Recovery Bot (Hinglish)", greeting uses `emi_amount`), "Customer feedback" (draft) and the "Welcome tone" audio; dev mock APIs `/mock/loan-balance`, `/mock/http-status/:code`; `npm run fixtures:audio`; `npm run bench:flow [calls]` (last run: 149 nodes, `advance` p50 77 µs · p95 96 µs · p99 163 µs, validate 2.3 ms).

## Calls (Phase 7)

Live voice calls in the browser: the Phase 6 flows and Phase 5 agents talk and listen for real — [ADR 0035](docs/adr/0035-voice-runtime.md), [ADR 0020](docs/adr/0020-telephony-abstraction.md), [ADR 0021](docs/adr/0021-voice-ai-provider.md).

- **Web test calls** (`POST /api/v1/calls/web`, `calls.trigger` + `flows.read` / `agents.read`; 10 / min / user; not while impersonating): a flow (published by default, draft or a version) or an agent, with a contact or typed values + a test phone (only API steps / functions see it). The wallet hold is taken here; limits 3 live calls per account, 20 per server (429 `CALL_LIMIT_REACHED`, 503 `CALL_CAPACITY`). The browser joins `/ws/media?ticket=…` (PCM16 24 kHz, 20 ms frames) — [websocket.md §8](docs/conventions/websocket.md).
- **Runtime** (`src/core/voice/`, `src/modules/calls/`): recording notice → the flow (keys with type-ahead, speech, timers, transfer prompt, API steps, live AI steps) or the agent alone; barge-in, silence prompts, wallet extension every 5 s, max duration, polite ends, stereo 8 kHz recording, settle through the billing engine (web calls: no telephony charge).
- **Voice providers** (`VOICE_PROVIDER`, `VOICE_PIPELINE`): `fake` (deterministic tone TTS, typed words — dev, tests, E2E; costs nothing), `openai` Realtime (speech-to-speech) or `chat` (transcription → agent turn → TTS). Live OpenAI checklist: [docs/setup/openai.md](docs/setup/openai.md).
- **History** (`calls.read`): `GET /calls` (cursor pages; status / flow / agent / contact / test / dates / contact name), `/calls/active`, `/calls/:id` (outcome, metrics, cost), `/transcript`, `/events`; `/recording` (`calls.listen`, 5 min signed link, audited); `POST /calls/:id/hangup` from another tab (`calls.trigger`, audited).
- **Testing in the browser:** start the API and the frontend, open **Calls → Test call**, pick a flow or agent, allow the mic and **use headphones** (the bot hears its own voice through speakers). With the fake provider type the customer's words in "Type instead of speaking" (`VOICE_TEXT_INPUT_ENABLED`, never in production).
- **Dev**: `npm run dev:call [-- --agent]` runs one call through the API in-process (last run: Loan recovery paid branch — 26 s, ₹0.90, 793 KB recording); `npm run db:seed` adds two finished demo calls; `npm run bench:voice [calls] [seconds]` (last run, 20 calls × 120 s on a laptop: all completed, CPU 1.8 % per call, event-loop lag p99 15 ms / max 35 ms, late pacer ticks 4.0 %, 0 stalled frames, ≈ 6 MB RSS per call).
- **Retention**: calls, transcripts, events and recordings are purged after `CALL_RETENTION_DAYS` (default 180).

## Campaigns (Phase 8)

Call lists of contacts with a pinned flow version, inside a calling window, with retries and customer callbacks — [ADR 0036](docs/adr/0036-campaign-scheduler-dialer.md).

- **Concepts:** a campaign pins a published flow version (with the `campaign` trigger), snapshots its audience at start (lists / segment / filter / picked contacts; DND, opt-outs, invalid or duplicate phones and missing values are skipped), and dials inside the account window ∩ its own window (live calls also held to TRAI 09–21 / RBI 08–19). Per-contact caps (calls per day / week, minimum gap) count across all campaigns and single calls. Results: final dispositions, promise follow-ups, customer callbacks at their time, retries up to `maxAttempts` after `intervalMinutes`. Statuses: draft → scheduled / running ⇄ paused → completed / canceled / failed; automatic pauses for an empty wallet, the budget, 10 technical failures in a row, a flow that can no longer run, a suspended account or the platform team (emails once per pause); recurring campaigns (daily / weekly) create one run per occurrence.
- **Dry run vs live:** until phone lines exist (Phase 13, `TELEPHONY_PROVIDER=sip`) every campaign is a **dry run**: the same dispatcher, sessions, flow host and results on a simulated line — seeded outcomes (answered / no answer / busy / failed / invalid number), simulated customers per template, virtual time (×1–×50, production ≤ ×20; it also divides retry and follow-up delays, dial rates and the minimum gap between two calls to one contact) and virtual money (priced like a phone call, never charged). Customer callbacks keep their real time.
- **API** (`campaigns.read` / `write` / `run` / `export`): `/api/v1/campaigns` CRUD with revisions, `audience/preview`, `/:id/estimate`, `/:id/start` (Idempotency-Key), `unschedule`, `pause`, `resume`, `cancel { hangUpLive }`, `/:id/contacts`, `/:id/runs`, `/:id/export` (CSV / XLSX, full phones only with `contacts.export`); `GET /campaigns/summary` (dashboard card: running / scheduled / paused + today's campaign calls), result rows with `waitReason` (`window`, `daily_cap`, `weekly_cap`, `min_gap`); `POST /calls` calls one contact now through the same guard (Idempotency-Key) on a simulated line that always answers, and updates the contact's `lastCalledAt` / `callCount` / `lastDisposition` like campaign calls. Superadmin: `PATCH /admin/accounts/:id/limits`, `POST /admin/accounts/:id/campaigns/pause`, `POST /admin/accounts/:id/campaigns/:campaignId/resume` (the account detail lists `adminPausedCampaigns`); Settings: `callCaps`. Live updates: `campaign.status` (account) and `campaign.progress` (topic `campaign:<id>`).
- **Try a dry run:** `npm run db:seed` adds "October recovery (dry run)" (30 contacts, done except customer callbacks), a draft, a paused daily campaign and the segment "Promise due today"; `npm run dev:campaign [-- --contacts 30 --speed 20]` runs one more in-process; [docs/samples/campaign-100.csv](docs/samples/campaign-100.csv) is a clean 100-contact list to import.
- **Dev**: `npm run dev:campaign` (last run: 30 contacts at ×20 — 64 s, 17 completed / 3 failed / 10 waiting for retries or callbacks, virtual cost ₹40.05); `npm run bench:campaign -- 300 50 20` (last run on a laptop: completed in 103 s, 430 calls, 4.2 dials / s, dispatcher tick p95 1.1 s, event-loop lag p99 34 ms, 57.9 Mongo operations per call, RSS 319 → peak 347 MB). The 1,000-contact default was cut short by the laptop sleeping (≈ 7 dials / s while awake). Customer callbacks are at real times, so the bench turns them off.
- **Env:** `TELEPHONY_PROVIDER` (`dryrun`), `DRY_RUN_MAX_SPEED` (50; production 20), `CAMPAIGNS_ENABLED` (stop dispatching for maintenance) — see the table below.

## WhatsApp (Phase 9)

Connect WhatsApp Business numbers through Meta's Embedded Signup and receive their Meta events — [ADR 0037](docs/adr/0037-whatsapp-channels-meta.md).

- **Concepts:** a **channel** is one connected number (WABA + phone number id) of an account; one active channel per number platform-wide. Modes: **Cloud API** (recommended; the number is registered with a sealed 6-digit PIN) and **WhatsApp Business app** (coexistence: the business keeps using the app; contacts + chat history syncs are requested and messages sent from the phone arrive as echoes — calling won't work there). Statuses: connecting → connected / action needed (a setup step failed — Retry setup / Enter PIN / Sync) / needs reconnect (token gone) / restricted (by Meta) / disconnected. **Meta billing** per account (superadmin, before connecting): `platform` — our Solution Partner credit line is attached; `customer` — the customer's own payment method in WhatsApp Manager.
- **Fake vs real Meta:** `META_PROVIDER=fake` (default outside production) simulates Meta end to end: the Test signup dialog builds `fake.` codes, ids are deterministic, knobs: a phone ending `00001` needs the existing PIN `123456`, `00002` fails subscribe, a business name with "foreign" has an unsupported currency, "other partner" is on another partner's credit line, outcome "only WABA" has no number yet. Real Meta: [docs/setup/meta-whatsapp.md](docs/setup/meta-whatsapp.md) — an env-only switch.
- **API:** `/api/v1/whatsapp` (`whatsapp.read` / `whatsapp.manage`; 503 when `WHATSAPP_ENABLED=false`), Meta-facing `/api/v1/webhooks/meta` (signed, raw body ≤ 3 MB), `/api/v1/meta/deauthorize`, `/api/v1/meta/data-deletion[/:code]`, superadmin `/api/v1/admin/whatsapp/*` + account billing / manual connect — [api.md §14c](docs/conventions/api.md). Live updates: `whatsapp.channel.updated`. Notifications (+ emails for needs reconnect / restricted / admin disconnect) go to owners and admins once per change.
- **Webhooks:** every change is stored once (sealed, 7 days; 30 for fields Phase 10 imports), queued on `whatsapp` and processed by the worker; Phase 9 handles account updates, quality, display name, capabilities and coexistence syncs; other fields stay **deferred** for Phases 10–12. A daily health job (22:00 UTC) re-checks every number.
- **Simulator** (dev, `MOCK_APIS_ENABLED`): `POST /api/v1/dev/meta/webhooks { channelId, kind }` with kinds `quality_downgrade`, `quality_upgrade`, `flagged`, `name_approved`, `name_rejected`, `restricted`, `unrestricted`, `token_revoked`, `inbound_text`, `status_delivered`, `echo_text`, `history_chunk`, `history_declined`, `contacts_sync`, `payment_method_added`, `phone_number_added` — signed and received by the real pipeline.
- **Try it:** `npm run db:seed` connects "Demo Finance" (`+91 90000 12345`, fake Meta) with three events; `npm run dev:whatsapp [-- --account <slug>] [--event <kind>]` connects a Cloud API + a Business app number and posts events through a local app (counts only).
- **Hardening:** 1,000 signed events in 10 parallel deliveries stored once, processed and resent without new rows in ≈ 2.3 s on a laptop; a worker stopped mid-batch and restarted loses nothing and repeats nothing.
- **Env:** `WHATSAPP_ENABLED`, `META_PROVIDER`, `META_APP_ID`, `META_APP_SECRET`, `META_ES_CONFIG_ID`, `META_WEBHOOK_VERIFY_TOKEN`, `META_GRAPH_VERSION`, `META_GRAPH_BASE_URL`, `META_CREDIT_LINE_ID`, `META_SYSTEM_USER_TOKEN`, `FAKE_META_APP_SECRET` — see the table below.

## WhatsApp inbox (Phase 10)

Chat with customers on the connected numbers — every message type both ways, live — [ADR 0038](docs/adr/0038-whatsapp-inbox.md).

- **Concepts:** a **conversation** is one number × one customer (open / closed, assignee, unread, 24-hour window); **messages** cover text, photo, video, audio, voice note, document, sticker, location, contact cards, buttons / lists / link buttons and their replies, reactions, reply quotes, forwarded / ad referrals, orders, forms, system lines, unsupported types and internal **notes** (never sent). Free-form replies need the **24-hour window** (409 `WHATSAPP_WINDOW_CLOSED` otherwise; templates go out with the window closed — Phase 11). Contacts are matched by number or created; a name a person gave is kept.
- **Pipeline:** Meta `messages` / echoes / history / phone-contact events go through the Phase 9 webhook store and worker; media is downloaded at once (Meta keeps it 7 days) from Meta hosts only; statuses only move forward; sends are jobs (`message.send`, restart safe, order per conversation, retries, Meta errors → reason on the bubble). Opt-out keywords (English + Hinglish + Hindi, whole message) set the contact's opt-out + a WhatsApp DND entry and send one confirmation. Messages + media older than `INBOX_RETENTION_DAYS` (90) are deleted daily.
- **Voice notes:** recorded in the browser; WebM / Opus is remuxed to mono OGG / Opus on the server (no ffmpeg, no re-encode), OGG passes through, M4A goes out as an audio file.
- **API:** `/api/v1/inbox` (`inbox.read` / `inbox.reply` / `inbox.assign`), `/api/v1/account/inbox-settings`, `/api/v1/whatsapp/channels/:id/profile[/photo]` — [api.md §14d](docs/conventions/api.md). Live updates: `inbox.conversation.updated`, `inbox.summary.updated` (account, no text) and `inbox.message.created` / `.updated` / `inbox.typing` on `conversation:<id>`. Bell: "New WhatsApp message" with the contact name only.
- **Fake Meta:** sends get `wamid.FAKE…`; statuses sent → delivered → read arrive after `FAKE_META_STATUS_DELAYS_MS` (default `500,1500,3000` in development, off in tests) through the real receiver. Customer number endings: `00005` block refused, `00006` throughput error twice then delivered, `00007` window closed at Meta, `00008` never read, `00009` undeliverable.
- **Simulator:** `POST /api/v1/dev/meta/webhooks { channelId, kind, from?, text?, conversationId?, days? }` — 29 inbox kinds (`inbound_text`, `inbound_image`, `inbound_video`, `inbound_audio`, `inbound_voice`, `inbound_document`, `inbound_sticker`, `inbound_location`, `inbound_contacts`, `inbound_button_reply`, `inbound_list_reply`, `inbound_template_button`, `inbound_reaction`, `inbound_reply`, `inbound_forwarded`, `inbound_ad_referral`, `inbound_order`, `inbound_nfm_reply`, `inbound_unsupported`, `inbound_number_changed`, `inbound_deleted`, `inbound_stop`, `inbound_start`, `inbound_stop_hinglish`, `inbound_stop_hindi`, `status_failed`, `window_expired`, `age_messages`, `run_retention`) besides the Phase 9 kinds (44 in total); `GET /api/v1/dev/meta/sent?channelId` shows what the fake received (no texts).
- **Try it:** `npm run db:seed` adds demo chats on "Demo Finance"'s number (a read reply, a media chat, a closed chat, a Business app echo, a STOP); `npm run dev:inbox [-- --account <slug>]` runs ten customer messages, six replies (incl. a browser voice note), statuses and retention on the dev DB (counts only).
- **Hardening (laptop):** 1,000 customer messages in 10 parallel deliveries ≈ 3 s (once each, exact unread, one bell per conversation); 200 parallel sends ≈ 0.8 s (one Meta call each, order kept); a 5,000-message history chunk ≈ 1.8 s; retention of 20,000 messages ≈ 0.35 s; a 10-minute recording remuxes in a few ms.
- **Env:** `INBOX_RETENTION_DAYS`, `FAKE_META_STATUS_DELAYS_MS` — see the table below.

## WhatsApp templates + charges (Phase 11)

Write to customers outside the 24-hour window with Meta-approved templates, and charge every WhatsApp message to the wallet — [ADR 0039](docs/adr/0039-whatsapp-templates-billing.md).

- **Templates:** created in the app (draft → submit) or synced from Meta; every Meta rule checked before submit; edits within Meta's windows; Meta deletion keeps our row (`DELETED`) and locks the name 30 days; the status, quality, category and components webhooks keep rows live (bells to managers + the creator, e-mail for rejected / disabled). Variables remember a source per key (contact name / phone / email, a custom field, a fixed text, ask). The **call permission template** is one click (utility, one per number × language) for Phase 12.
- **Sending:** approved / flagged templates go out with the window closed; marketing never reaches opted-out, DND or "stopped marketing" contacts and at most once per contact per 24 h; utility / authentication stop only at DND.
- **Charges:** price = Meta's INR rate for the recipient's market × category + 15 % markup rounded up to the paisa (or the account's fixed price) + the platform fee (0); customer-pays numbers pay the fee only. The price is **held at send**, **captured when Meta reports the message billable on delivery**, released when it is free or fails; holds without a status go back after 72 h, and a later billable status charges once (late). Service replies are held too and mostly released (Meta's free tier). An empty wallet or the monthly WhatsApp budget refuses the send.
- **Superadmin:** Meta's INR rate card CSV import (preview + diff), global markup / fee / hold age, per-account override, margin and Meta reconciliation reports (daily `pricing_analytics`).
- **API:** `/api/v1/whatsapp/templates` (`templates.read` / `templates.manage`), template sends on `/api/v1/inbox`, `/api/v1/whatsapp/price-preview`, wallet WhatsApp prices / budget / usage, `/api/v1/admin/whatsapp-*` — [api.md §14e](docs/conventions/api.md). Live: `whatsapp.template.updated` (no texts).
- **Fake Meta:** templates review after `FAKE_META_TEMPLATE_REVIEW_MS` (default 3 s in development, off in tests); name knobs `instant`, `_reject`, `_recategorize`, `_pause`, `_slow`; statuses carry PMP pricing (templates billable, service free); customer number endings `00010` billable service, `00011` free entry point, `00012` / `00013` template refused 131049 / 131050.
- **Simulator:** 14 more kinds (58 in total): `template_approved`, `template_rejected`, `template_paused`, `template_disabled`, `template_quality_red`, `template_category_changed`, `template_components_changed` (`templateId`), `user_stopped_marketing`, `user_resumed_marketing` (`from`), `pricing_tier_update`, `run_template_sync`, `run_hold_reaper`, `run_whatsapp_reconcile`, `late_billable_status` (`messageId`); `GET /api/v1/dev/meta/templates?channelId`.
- **Try it:** `npm run db:seed` adds "Demo Finance" templates (EMI reminder, offer, call permission pending, one rejected) and one charged template send; `npm run dev:templates [-- --account <slug>]` creates + approves a template on a fake number, sends it, one service reply and one undeliverable template, and prints the charges captured / released and the wallet before / after (numbers only).
- **Hardening (laptop):** 500 template sends (25 at a time) on a wallet that runs out ≈ 1.9 s (exactly 250 held, 250 refused, no overspend); 10,000 billable statuses ≈ 33 s (captured once each); a 1,000-template sync (10 pages) ≈ 7.1 s; a 250-market CSV in a few ms; the reaper over 5,000 stale holds ≈ 0.1 s.
- **Ledger:** account views show the selling price, category and market of a WhatsApp charge and its chat (`breakdown.waConversationId`); Meta's cost, the markup and the fee only in superadmin views.
- **E2E** (frontend repo): `templates-done-when`, `templates-billing`, `templates-marketing-rules`, `templates-roles-entry` (backend started with `FAKE_META_TEMPLATE_REVIEW_MS=1000`); the fake's `_reject` template is approved after an edit. Sign-off: [PHASE_11_SIGNOFF.md](docs/phases/PHASE_11_SIGNOFF.md).
- **Env:** `FAKE_META_TEMPLATE_REVIEW_MS` — see the table below.

## WhatsApp calling (Phase 12 — in progress)

Voice calls on WhatsApp numbers: WebRTC media in our own process (`werift`, Opus via WASM), the Phase 7 call leg / AI pipeline on top — [ADR 0040](docs/adr/0040-whatsapp-call-media.md).

- **Batch 1 (done):** models + migration `0013-whatsapp-calling`, Meta calling client + fake Meta calling (knobs `00020`–`00030`), `WhatsAppCallLeg`, the call-control bus (hangups reach the server running any call: `POST /api/v1/calls/:id/hangup` → 202 when forwarded).
- **Batch 2 (done):** call settings + call permissions (Meta's answer before every call and request), business-initiated calls by an agent (browser) or an AI program (dial guard: number → account → customer + TRAI window → limits → program → Meta permission), user-initiated calls (claimed by one server, contact by phone then BSUID, call hours, routes team / AI / AI → team, first-wins answer, decline, missed calls with a bell), AI → team handoff on the same call and recording, per-socket presence; billing in 6-second pulses on Meta's duration (calling rate card, markup / fixed price / fee, holds + extensions, late-terminate fallback + reconcile, stale-hold reaper), superadmin calling rates, wallet per-minute prices, margin rows; API §14f, simulator 12 calling kinds, ADR 0041.
- **Try it:** `npm run db:seed` enables calling on the Demo Finance number (2 permissions, 3 past calls with tone recordings and charges); `npm run dev:calls-wa` runs the real server and drives it over HTTP (enable calling → permission request → AI call with a key press → inbound team ring answered on the media socket → missed call → wallet lines; numbers only); `npm run dev:calls-wa -- --poc` (the Batch 1 loopback call); `npm run poc:wa-call` (media PoC numbers); `POST /api/v1/dev/meta/calls/user-call`, `GET /api/v1/dev/meta/calls?channelId=…`.
- **Env:** `WA_MEDIA_ENABLED`, `WA_MEDIA_PUBLIC_IP`, `WA_MEDIA_PORT_MIN` / `WA_MEDIA_PORT_MAX`, `WA_STUN_URLS`, `WA_MEDIA_MAX_CALLS`, `FAKE_META_CALL_DELAYS_MS`, `WA_CALL_WINDOW_IGNORED` — see the table below.

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

| Script                                                        | What it does                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                                                 | Run the app with `tsx` in watch mode                                                                                                                                                                                                                                                                                                                                                                                        |
| `npm run build`                                               | Compile `src/` to `dist/` (`tsconfig.build.json`)                                                                                                                                                                                                                                                                                                                                                                           |
| `npm start`                                                   | Run the compiled app (`dist/index.js`)                                                                                                                                                                                                                                                                                                                                                                                      |
| `npm run typecheck`                                           | Type-check everything (src, tests, scripts) without emitting                                                                                                                                                                                                                                                                                                                                                                |
| `npm run clean`                                               | Delete `dist/`                                                                                                                                                                                                                                                                                                                                                                                                              |
| `npm run lint`                                                | ESLint (type-aware), fails on any warning                                                                                                                                                                                                                                                                                                                                                                                   |
| `npm run lint:fix`                                            | ESLint with auto-fix                                                                                                                                                                                                                                                                                                                                                                                                        |
| `npm run format`                                              | Prettier write                                                                                                                                                                                                                                                                                                                                                                                                              |
| `npm run format:check`                                        | Prettier check                                                                                                                                                                                                                                                                                                                                                                                                              |
| `npm test`                                                    | Run all tests once (Vitest)                                                                                                                                                                                                                                                                                                                                                                                                 |
| `npm run test:watch`                                          | Vitest watch mode                                                                                                                                                                                                                                                                                                                                                                                                           |
| `npm run test:coverage`                                       | Tests + coverage report in `coverage/`                                                                                                                                                                                                                                                                                                                                                                                      |
| `npm run gen:openapi`                                         | Generate `openapi/openapi.json` from zod schemas                                                                                                                                                                                                                                                                                                                                                                            |
| `npm run openapi:check`                                       | Regenerate and fail if `openapi/openapi.json` is stale                                                                                                                                                                                                                                                                                                                                                                      |
| `npm run db:migrate`                                          | Apply pending MongoDB migrations                                                                                                                                                                                                                                                                                                                                                                                            |
| `npm run db:migrate:status`                                   | Show applied / pending migrations                                                                                                                                                                                                                                                                                                                                                                                           |
| `npm run db:migrate:down`                                     | Revert the last applied migration                                                                                                                                                                                                                                                                                                                                                                                           |
| `npm run db:sync-indexes`                                     | Build / update indexes of all models (production deploy step)                                                                                                                                                                                                                                                                                                                                                               |
| `npm run db:seed`                                             | DEV ONLY — demo account "Demo Finance" with `<role>@demo.local` users, demo contacts, billing (₹1,000 credit, simulated calls, a fake top-up + invoice) and AI (2 agents, the "Demo Finance FAQ" knowledge base, mock payment answers), flows (Loan recovery, Customer feedback), two finished demo calls (fake voice, real runtime) + `admin@platform.local` superadmin (password `SEED_PASSWORD` or random, printed once) |
| `npm run superadmin:create -- <email> [name]`                 | Create / update a platform superadmin (hidden password prompt or `--password-stdin`; no HTTP route exists)                                                                                                                                                                                                                                                                                                                  |
| `npm run ws:dev-ticket`                                       | DEV ONLY — print a single-use `/ws/events` ticket URL for fake ids                                                                                                                                                                                                                                                                                                                                                          |
| `npm run email:test -- <to>`                                  | DEV ONLY — send the `system.test` email now with the configured driver (Mailpit locally)                                                                                                                                                                                                                                                                                                                                    |
| `npm run bench:contacts [rows]`                               | DEV ONLY — contact import + list query timings on a throw-away account                                                                                                                                                                                                                                                                                                                                                      |
| `npm run bench:wallet [calls] [workers]`                      | DEV ONLY — billing engine concurrency check (hold → settle, wallet = Σ ledger) on a throw-away account                                                                                                                                                                                                                                                                                                                      |
| `npm run dev:call [-- --agent]`                               | DEV ONLY — one web call through the Calls API in-process: first published flow (press 1) or first active agent (typed words); prints ids and numbers only                                                                                                                                                                                                                                                                   |
| `npm run dev:campaign [-- --contacts 30 --speed 20]`          | DEV ONLY — one dry-run campaign through the campaign service + an in-process dispatcher on the dev DB (demo list of N contacts, all-day window); prints counts only, refuses production                                                                                                                                                                                                                                     |
| `npm run dev:whatsapp [-- --account <slug>] [--event <kind>]` | DEV ONLY — fake Meta end to end on the dev DB: connects a Cloud API and a WhatsApp Business app number through the channel service, POSTs 5 signed webhook events to a local app, runs the `whatsapp` worker until idle; prints counts only, refuses production and `META_PROVIDER=meta`                                                                                                                                    |
| `npm run bench:voice [calls] [seconds]`                       | DEV ONLY — N concurrent web calls in real time (fake TTS): CPU per call, event-loop lag p99, late pacer ticks, RSS per call; throw-away accounts                                                                                                                                                                                                                                                                            |
| `npm run bench:campaign [contacts] [speed] [concurrency]`     | DEV ONLY — one dry-run campaign (default 1,000 contacts × ×50 × 20 at once) with the real dispatcher in-process: dispatcher tick p50 / p95, dials / s, event-loop lag, Mongo ops per call, RSS, completion time; throw-away account, refuses production                                                                                                                                                                     |
| `npm run bench:retrieval [chunksPerKb] [searches]`            | DEV ONLY — knowledge search timings (3 bases, cold vs warm, p50 / p95 / p99, cache size) on a throw-away account                                                                                                                                                                                                                                                                                                            |
| `npm run samples:knowledge`                                   | Write the sample knowledge documents to `docs/samples/knowledge/`                                                                                                                                                                                                                                                                                                                                                           |
| `npm run fixtures:audio`                                      | Write the WAV / MP3 test fixtures to `tests/fixtures/audio/`, `docs/samples/audio/welcome.wav` and `customer-silence.wav` (the fake mic of the call E2E)                                                                                                                                                                                                                                                                    |
| `npm run fixtures:knowledge`                                  | Write the knowledge test fixtures to `tests/fixtures/knowledge/`                                                                                                                                                                                                                                                                                                                                                            |
| `npm run server:audit`                                        | READ-ONLY audit of the client server over SSH (needs the key — see docs/client/server-audit.md)                                                                                                                                                                                                                                                                                                                             |
| `npm run infra:up`                                            | Start MongoDB + Redis + Mailpit (Docker) and wait until healthy                                                                                                                                                                                                                                                                                                                                                             |
| `npm run infra:down`                                          | Stop containers (keeps data)                                                                                                                                                                                                                                                                                                                                                                                                |
| `npm run infra:reset`                                         | ⚠️ Stop containers and delete data volumes                                                                                                                                                                                                                                                                                                                                                                                  |
| `npm run infra:logs`                                          | Follow container logs                                                                                                                                                                                                                                                                                                                                                                                                       |
| `npm run infra:ps`                                            | Container status                                                                                                                                                                                                                                                                                                                                                                                                            |

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

No install scripts for the Phase 5 knowledge parsers `mammoth`, `html-to-text` and `unpdf` (pure JS / bundled pdf.js; `unpdf` moved from dev to runtime dependencies). `npm audit` reports a moderate `sprintf-js` advisory through `mammoth` → `argparse`: `argparse` is only used by mammoth's command-line tool (`bin/mammoth`), never by the library calls we make (`convertToHtml`); CI audits at `high`.

No install scripts for the Phase 7 MP3 decoder `mpg123-decoder` 1.0.3 (MIT, pure WebAssembly — decodes `play_audio` MP3 files once; its dependencies `@wasm-audio-decoders/common` (MIT), `@eshaz/web-worker` (Apache-2.0) and `simple-yenc` (MIT) have no install scripts either). It is an ES module loaded through Node's `require(esm)`.

No install scripts for the Phase 8 date libraries `date-fns` 4.4.0 and `@date-fns/tz` 1.5.0 (both MIT, pure JS, no dependencies) — calling windows, schedules and recurring runs in the account timezone (ADR 0017).

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

| Variable                           | Required          | Phase   | Description                                                                                                                                                                                                        |
| ---------------------------------- | ----------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`                         | no                | 1       | `development` / `production` / `test`                                                                                                                                                                              |
| `PORT`                             | no                | 1       | API port (default 5100)                                                                                                                                                                                            |
| `AUTH_RATE_LIMIT_MAX`              | no                | 1       | Public auth routes: requests per 15 min per IP and route (default 30; refresh has its own limit)                                                                                                                   |
| `APP_URL`                          | yes               | 1       | Public base URL of this API                                                                                                                                                                                        |
| `FRONTEND_URL`                     | yes               | 1       | Dashboard URL (links in emails, CORS)                                                                                                                                                                              |
| `CORS_ORIGINS`                     | yes               | 1       | Comma-separated allowed origins                                                                                                                                                                                    |
| `LOG_LEVEL`                        | no                | 1       | pino log level                                                                                                                                                                                                     |
| `TRUST_PROXY`                      | no                | 1       | `false` / `true` / hop count / `loopback` — set behind nginx (Phase 12)                                                                                                                                            |
| `API_DOCS_ENABLED`                 | no                | 1       | Swagger UI at `/api/docs` — default on outside production, off in production                                                                                                                                       |
| `MONGODB_URI`                      | yes               | 1       | MongoDB connection string (replica set)                                                                                                                                                                            |
| `REDIS_URL`                        | yes               | 1       | Redis connection string                                                                                                                                                                                            |
| `WORKERS_ENABLED`                  | no                | 1       | `true` (default) / `false` — run BullMQ workers in the API process                                                                                                                                                 |
| `JWT_ACCESS_SECRET`                | yes · secret      | 2       | Access token signing secret                                                                                                                                                                                        |
| `JWT_REFRESH_SECRET`               | yes · secret      | 2       | Refresh token signing secret                                                                                                                                                                                       |
| `JWT_ACCESS_TTL`                   | no                | 2       | Access token lifetime (e.g. `15m`)                                                                                                                                                                                 |
| `JWT_REFRESH_TTL`                  | no                | 2       | Refresh token lifetime (e.g. `30d`)                                                                                                                                                                                |
| `ENCRYPTION_KEY`                   | yes · secret      | 2       | 32-byte base64 key for PII encryption at rest                                                                                                                                                                      |
| `AUTH_COOKIE_DOMAIN`               | no                | 2       | Refresh-cookie domain (e.g. `.example.com`); empty = host-only                                                                                                                                                     |
| `SEED_PASSWORD`                    | no (dev only)     | 2       | Password for `npm run db:seed` users; empty = random, printed once                                                                                                                                                 |
| `OPENAI_API_KEY`                   | yes · secret      | 5/7     | OpenAI API key (required in production; with it `AI_PROVIDER` defaults to `openai`)                                                                                                                                |
| `OPENAI_REALTIME_MODEL`            | no                | 7       | Realtime voice model (default `gpt-realtime-2.1-mini`)                                                                                                                                                             |
| `AI_PROVIDER`                      | no                | 5       | `fake` (deterministic test AI) or `openai`; production requires `openai`                                                                                                                                           |
| `OPENAI_BASE_URL`                  | no                | 5       | OpenAI API base URL (default `https://api.openai.com/v1`; tests use a local stub)                                                                                                                                  |
| `OPENAI_TEXT_MODEL`                | no                | 5       | Default agent text model (default `gpt-4.1-mini`)                                                                                                                                                                  |
| `OPENAI_EMBEDDING_MODEL`           | no                | 5       | Knowledge-base embedding model (default `text-embedding-3-small`)                                                                                                                                                  |
| `AI_TEXT_MODELS`                   | no                | 5       | Comma list of text models agents may pick (must include `OPENAI_TEXT_MODEL`)                                                                                                                                       |
| `AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS` | no                | 5       | Agent functions / URL sources may reach private hosts (default on outside production, off in production)                                                                                                           |
| `MOCK_APIS_ENABLED`                | no (dev only)     | 5       | Mock client APIs (`/api/v1/mock/*`); default on outside production, must be off in production                                                                                                                      |
| `VOICE_PROVIDER`                   | no                | 7       | `fake` (deterministic voice) or `openai`; default = `AI_PROVIDER`; production requires `openai`                                                                                                                    |
| `VOICE_PIPELINE`                   | no                | 7       | `realtime` (speech-to-speech, default) or `chat` (STT → chat model → TTS)                                                                                                                                          |
| `VOICE_TEXT_INPUT_ENABLED`         | no (dev only)     | 7       | Typed customer text on web calls (default on outside production, must be off in production)                                                                                                                        |
| `OPENAI_TTS_MODEL`                 | no                | 7       | Text-to-speech model for speak steps (default `gpt-4o-mini-tts`)                                                                                                                                                   |
| `OPENAI_TRANSCRIBE_MODEL`          | no                | 7       | Speech-to-text model for listen steps (default `gpt-4o-mini-transcribe`)                                                                                                                                           |
| `CALL_RETENTION_DAYS`              | no                | 7       | Days calls, transcripts, events and recordings are kept (default 180)                                                                                                                                              |
| `CALL_RECORDING_TMP_DIR`           | no                | 7       | Folder for recordings being written during a call (default `<os tmp>/cav-rec`)                                                                                                                                     |
| `TELEPHONY_PROVIDER`               | no                | 8       | Phone line for campaigns / single calls: `dryrun` (simulated, default); `sip` arrives in Phase 13                                                                                                                  |
| `DRY_RUN_MAX_SPEED`                | no                | 8       | Fastest dry-run speed (virtual time ×N; default 50, production 20 and at most 20)                                                                                                                                  |
| `CAMPAIGNS_ENABLED`                | no                | 8       | `false` stops campaign dispatching (maintenance); default `true`                                                                                                                                                   |
| `WHATSAPP_ENABLED`                 | no                | 9       | WhatsApp channels on / off; default on outside production, in production on when `META_APP_ID` is set                                                                                                              |
| `META_PROVIDER`                    | no                | 9       | `fake` (simulated Meta, dev / tests / E2E) or `meta`; production must be `meta`                                                                                                                                    |
| `META_APP_ID`                      | with `meta`       | 9       | Meta app id                                                                                                                                                                                                        |
| `META_APP_SECRET`                  | with `meta`       | 9       | Meta app secret (≥ 32 chars) — webhook signatures, `signed_request`                                                                                                                                                |
| `META_ES_CONFIG_ID`                | with `meta`       | 9       | Embedded Signup configuration id (Facebook Login for Business)                                                                                                                                                     |
| `META_WEBHOOK_VERIFY_TOKEN`        | with `meta`       | 9       | Webhook verify token (≥ 24 chars); dev default with the fake provider                                                                                                                                              |
| `META_GRAPH_VERSION`               | no                | 9       | Graph API version (default `v23.0`)                                                                                                                                                                                |
| `META_GRAPH_BASE_URL`              | no                | 9       | Graph API host (default; tests only point it at a stub)                                                                                                                                                            |
| `META_CREDIT_LINE_ID`              | platform billing  | 9       | Our Solution Partner credit line id (platform pays Meta)                                                                                                                                                           |
| `META_SYSTEM_USER_TOKEN`           | platform billing  | 9       | System User token of our business (credit line sharing)                                                                                                                                                            |
| `FAKE_META_APP_SECRET`             | no                | 9       | DEV / TEST ONLY — secret of the fake Meta provider; never in production                                                                                                                                            |
| `INBOX_RETENTION_DAYS`             | no                | 10      | Days WhatsApp messages and their media are kept (default 90; `0` = forever, else ≥ 30)                                                                                                                             |
| `FAKE_META_STATUS_DELAYS_MS`       | no                | 10      | DEV / E2E ONLY — fake Meta sent / delivered / read delays in ms (`off` disables); never in production                                                                                                              |
| `FAKE_META_TEMPLATE_REVIEW_MS`     | no                | 11      | DEV / E2E ONLY — fake Meta template review delay in ms (default 3000; `off` disables); never in production                                                                                                         |
| `WA_MEDIA_ENABLED`                 | no                | 12      | WhatsApp call media in this process (default: on when WhatsApp is on)                                                                                                                                              |
| `WA_MEDIA_PUBLIC_IP`               | with `meta`       | 12      | Public IPv4 of the server (1:1 NAT) for call media candidates                                                                                                                                                      |
| `WA_MEDIA_PORT_MIN`                | no                | 12      | First UDP port for call media (default 40000)                                                                                                                                                                      |
| `WA_MEDIA_PORT_MAX`                | no                | 12      | Last UDP port for call media (default 40999; ≥ 100 ports)                                                                                                                                                          |
| `WA_STUN_URLS`                     | no                | 12      | `stun:host:port` list or `off` (default Google STUN; none in tests)                                                                                                                                                |
| `WA_MEDIA_MAX_CALLS`               | no                | 12      | WhatsApp calls with media per process (default 50)                                                                                                                                                                 |
| `FAKE_META_CALL_DELAYS_MS`         | no                | 12      | DEV / E2E ONLY — fake Meta connect / ringing / accepted delays in ms (`off` = immediate); never in production                                                                                                      |
| `WA_CALL_WINDOW_IGNORED`           | no                | 12      | DEV / E2E ONLY — `true` lets WhatsApp calls to the fake Meta phone skip the calling window (TRAI 09:00–21:00 + the account window) so night-time test runs work; ignored with the real Meta, refused in production |
| `STORAGE_DRIVER`                   | no                | 7/9     | `local` or `s3`                                                                                                                                                                                                    |
| `STORAGE_LOCAL_PATH`               | no                | 7/9     | Folder for local uploads/recordings                                                                                                                                                                                |
| `S3_BUCKET`                        | if s3             | 7/9     | S3 bucket name                                                                                                                                                                                                     |
| `S3_REGION`                        | if s3             | 7/9     | S3 region                                                                                                                                                                                                          |
| `AWS_ACCESS_KEY_ID`                | if s3 · secret    | 7/9     | AWS access key                                                                                                                                                                                                     |
| `AWS_SECRET_ACCESS_KEY`            | if s3 · secret    | 7/9     | AWS secret key                                                                                                                                                                                                     |
| `EMAIL_DRIVER`                     | no                | 1       | `smtp` / `log` — default `smtp` when `SMTP_HOST` is set, else `log`; production requires `smtp`                                                                                                                    |
| `SMTP_HOST`                        | yes (production)  | 1       | SMTP server (local: Mailpit `127.0.0.1`)                                                                                                                                                                           |
| `SMTP_PORT`                        | no                | 1       | SMTP port (default 587; local Mailpit 1025)                                                                                                                                                                        |
| `SMTP_SECURE`                      | no                | 1       | `true` = implicit TLS; empty = auto (`true` only for port 465)                                                                                                                                                     |
| `SMTP_USER`                        | if auth           | 1       | SMTP username (set together with `SMTP_PASS`)                                                                                                                                                                      |
| `SMTP_PASS`                        | if auth · secret  | 1       | SMTP password                                                                                                                                                                                                      |
| `MAIL_FROM`                        | yes (production)  | 1       | Sender, e.g. `Cell AI Voicebot <no-reply@example.com>` (dev default `no-reply@localhost`)                                                                                                                          |
| `RAZORPAY_KEY_ID`                  | yes               | 4       | Razorpay key id                                                                                                                                                                                                    |
| `RAZORPAY_KEY_SECRET`              | yes · secret      | 4       | Razorpay key secret                                                                                                                                                                                                |
| `RAZORPAY_WEBHOOK_SECRET`          | yes · secret      | 4       | Razorpay webhook signing secret                                                                                                                                                                                    |
| `PAYMENT_PROVIDER`                 | no                | 4       | `fake` (default outside production) or `razorpay` (required in production)                                                                                                                                         |
| `FAKE_PAYMENT_SECRET`              | no · secret       | 4       | Signing secret of the fake provider (dev / tests); must be unset in production                                                                                                                                     |
| `BILLING_SELLER_NAME`              | prod              | 4       | Seller legal name on GST invoices                                                                                                                                                                                  |
| `BILLING_SELLER_ADDRESS`           | prod              | 4       | Seller address on invoices                                                                                                                                                                                         |
| `BILLING_SELLER_GSTIN`             | prod              | 4       | Seller GSTIN (checksum + state validated)                                                                                                                                                                          |
| `BILLING_SELLER_STATE_CODE`        | prod              | 4       | Seller GST state code (default `08`) — CGST + SGST vs IGST                                                                                                                                                         |
| `BILLING_SAC_CODE`                 | no                | 4       | SAC on invoices (default `998319`)                                                                                                                                                                                 |
| `BILLING_INVOICE_PREFIX`           | no                | 4       | Invoice prefix, 1–3 capitals (default `CAV`)                                                                                                                                                                       |
| `BILLING_SIMULATOR_ENABLED`        | no                | 4       | Superadmin billing simulator (default on outside production, off in production)                                                                                                                                    |
| `NOTIFYNOW_API_KEY`                | optional · secret | 13      | NotifyNow voice API key (optional fallback provider)                                                                                                                                                               |
| `SIP_HOST`                         | yes (Phase 13)    | 13      | SIP trunk host                                                                                                                                                                                                     |
| `SIP_PORT`                         | no                | 13      | SIP port                                                                                                                                                                                                           |
| `SIP_TRANSPORT`                    | no                | 13      | `udp` / `tcp` / `tls`                                                                                                                                                                                              |
| `SIP_USERNAME`                     | if auth           | 13      | SIP username                                                                                                                                                                                                       |
| `SIP_PASSWORD`                     | if auth · secret  | 13      | SIP password                                                                                                                                                                                                       |
| `SIP_CALLER_ID`                    | yes (Phase 13)    | 13      | Outbound caller ID / DID                                                                                                                                                                                           |
| `CLIENT_SSH_KEY_PATH`              | no                | tooling | Path to the client server SSH key for `npm run server:audit` (path only)                                                                                                                                           |

## Docs

All project docs (plans, ADRs, conventions) live in [`docs/`](docs/README.md).

## Conventions

- [Definition of Done](docs/conventions/definition-of-done.md)
- [Secrets policy](docs/conventions/secrets.md)
- [API conventions](docs/conventions/api.md) · [Error codes](docs/conventions/error-codes.md) · [WebSocket](docs/conventions/websocket.md) · [Data](docs/conventions/data.md) · [Code style](docs/conventions/code-style.md)
- [Architecture Decision Records](docs/adr/README.md)
