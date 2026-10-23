# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Phase 11 · Batch 1 (T11.1–T11.4) — WhatsApp templates + message charges foundation** — 2026-10-23
  - Models: templates, Meta rate cards, platform settings, daily Meta reconciliation; template / billing fields on messages, ledger, wallets, contacts, accounts and numbers; migration `0012-templates-billing` (placeholder INR card IN + OTHER, 15 % markup, 72-hour holds); env `FAKE_META_TEMPLATE_REVIEW_MS`; 10 error codes (69), 12 audit actions (118), 7 notification types (26), the `whatsapp.template.updated` WS event, `templates.read` / `templates.manage`.
  - Meta client: template list (paged) / create / edit / delete, header example upload, pricing analytics, the template message payload, template error mapping and webhook schemas (re-checked on Meta's references); the fake reviews templates (name knobs), reports PMP pricing and has number knobs `00010`–`00013`.
  - Template management with every Meta rule, edit windows and the 30-day name lock, sync, call permission template, variable sources, header examples; the four template webhooks and marketing preferences through worker hooks with a backfill, daily sync, sync after a connect; bells to template managers + the creator, e-mails for rejected / disabled.
  - Message charges: price per message (market × category, markup rounded up to the paisa, fixed prices, platform fee, customer-pays accounts), Meta CSV import + diff, hold → capture / release / late charge in the engine, a status hook (charged once Meta delivers), the 72-hour hold reaper and the daily Meta reconciliation; `npm run dev:templates`.
  - Fixed: the call-hold reaper released (and logged errors for) every held ledger row, WhatsApp holds included — now `call_charge` only; a sent-then-failed WhatsApp message was charged because `sent` already carries `billable: true` — charges now wait for `delivered` / `read`; a fake status test waited on the database instead of the queue (test-only).
  - Tests: 2712 → 2881.

- **Phase 10 · Batch 3 (T10.7–T10.12) — Phase 10 complete** — 2026-10-23
  - Frontend Inbox page, composer (every free-form type incl. browser voice notes), contact panel, Settings → Inbox, business profile editor, entry points — see the frontend CHANGELOG.
  - Fixed (found by the inbox E2E run): `POST /inbox/conversations/:id/messages` (also an idempotent resend) and `POST /inbox/messages/:id/retry` answered without the reply quote and sender name the live event carries (`2cae0a2`).
  - Playwright: 26 inbox tests (5 specs, 103 total, green twice); backend logs of the run free of customer texts, names, test numbers, file names, wamids, Meta media URLs, tokens, `Bearer`, `sk-` and the E2E passwords.
  - Sign-off: [PHASE_10_SIGNOFF.md](docs/phases/PHASE_10_SIGNOFF.md).
  - Tests: 2711 → 2712 (frontend 803 → 1048).

- **Phase 9 → Phase 10 · Batch 2 (T10.5–T10.6) — WhatsApp inbox API, dev tools, hardening** — 2026-10-23
  - `/api/v1/inbox`: conversations (filters, search with snippets, cursor), detail, messages (older pages / around a message), contact panel, send every type + notes (idempotent, `rl:inbox-send:`), uploads (`rl:inbox-upload:`), read / unread, typing, assign, close / reopen, block / unblock, start chat, media links, retries, summary, config; `/api/v1/account/inbox-settings`; business profile + photo; `conversation:<id>` topics with `inbox.read`; public contacts show their WhatsApp profile; OpenAPI for every path.
  - Simulator: 29 inbox kinds (44 in total) through the real pipeline, fake media route, fake sends view; seed: demo chats for "Demo Finance"; hardening tests (1,000 inbound, 200 parallel sends, download crash, 5,000-message history, 20,000-message retention, 10-minute remux) — the history import now inserts per thread in one batch.
  - ADR 0038; api.md §14d (and §14 now says webhooks come in Phase 15), security.md §11, compliance notes §10, setup guide §12 / §13 (real-number checklist).

- **Phase 9 → Phase 10 · Batch 1 (T10.1–T10.4) — WhatsApp inbox foundation** — 2026-10-23
  - Conversations, messages (every type, every field declared), composer uploads; contact WhatsApp profile, DND `whatsapp` source, account inbox settings (Hinglish / Hindi keywords, confirmations, read receipts on); migration `0011-inbox`; env `INBOX_RETENTION_DAYS` (90), `FAKE_META_STATUS_DELAYS_MS`; 5 error codes, 11 audit actions, 2 notification types, 5 WS events.
  - Meta client: send every type, read + typing, media upload / URL / allowlisted download, block, business profile; fake Meta with wamids, auto statuses, knobs, signed media.
  - Inbound pipeline (every type, contacts, conversations, media downloads, statuses, opt-out / opt-in, coexistence import, backfill of deferred events) and outbound (validation, window, idempotency, send job, retries, read receipts, typing, notes), browser voice notes (WebM → OGG / Opus remux), 90-day retention job; `npm run dev:inbox`.
  - Fixed: opt-out / opt-in keywords now apply in message order (a START processed before an earlier STOP left the customer opted out).

- **Phase 9 · Batch 3 (T9.8–T9.12) — Phase 9 complete** — 2026-10-22
  - Frontend WhatsApp → Numbers, connect wizard, superadmin tools, notifications, dashboard card, `/data-deletion` — see the frontend CHANGELOG.
  - Simulator kind `phone_number_added` (only-WABA numbers get their number through the pipeline).
  - Fixed: simulated account updates for a number without a display number sent `phone_number: ""` (schema failure; the effect never happened).
  - Playwright: 16 WhatsApp tests (4 specs, 77 total, green twice); backend logs of the run free of tokens, codes, PINs, test numbers, payload texts, `Bearer`, `sk-` and the E2E passwords.
  - Sign-off: [PHASE_9_SIGNOFF.md](docs/phases/PHASE_9_SIGNOFF.md).
  - Tests: 2203 → 2463 (frontend 737 → 803).

- **Phase 9 · Batch 2 (T9.5–T9.7) — WhatsApp health, Meta callbacks, admin, API, hardening** — 2026-10-22
  - Daily `whatsapp-health` job; Meta deauthorize + data deletion callbacks with a public status lookup; superadmin WhatsApp status / events + replay / billing mode / force disconnect / manual connect / account summary; dev webhook simulator (15 kinds through the real pipeline).
  - `/api/v1/whatsapp` API (config, numbers, Embedded Signup connect, rename, sync, retry setup, PIN, coexistence sync, disconnect) with roles, impersonation block, suspended read-only, 503 when off, `rl:wa-connect:`; OpenAPI for every WhatsApp / Meta / admin / dev path.
  - Seed: "Demo Finance" WhatsApp number via the fake signup + three events; `dev:whatsapp --account --event`.
  - Hardening: 1,000-event burst, worker restart, parallel same-code connect, migration down / up. ADR 0037, [Meta setup guide](docs/setup/meta-whatsapp.md), README WhatsApp section, compliance notes.
  - Fixed: a Phase 8 dispatcher test raced its own wake on a loaded machine (test-only).
  - Tests: 2203 → 2460.

- **Phase 9 · Batch 1 (T9.1–T9.4) — WhatsApp foundation** — 2026-10-22
  - Models `whatsappChannels`, `metaWebhookEvents`, `metaDeletionRequests` + account `whatsapp.metaPayer`; migration `0010-whatsapp`; env (`WHATSAPP_ENABLED`, `META_*`, `FAKE_META_APP_SECRET`) with production rules; `WHATSAPP_LIMITS`; 7 error codes, 12 audit actions, 6 notification types, 3 emails, `whatsapp.channel.updated`, permissions `whatsapp.read` / `whatsapp.manage`, queue `whatsapp`.
  - `src/core/meta`: Graph client (retries, scrubbed errors, no credentials in logs), deterministic fake Meta (Redis, error knobs), webhook / `signed_request` signatures, zod schemas, fixtures from Meta's samples.
  - Channel service: Embedded Signup connect (granted-WABA check, discovery, duplicate / reconnect, subscribe, platform credit line or customer-paid billing, registration PIN or coexistence syncs), retry setup, PIN, sync, rename, disconnect (never deregisters), statuses with history, WS, audit, notifications + emails.
  - Meta webhook pipeline: verify challenge, signed raw-body POST, sealed idempotent event store, `whatsapp` worker with routing, Phase 9 handlers, deferred fields API for Phases 10–12, retries, purge job.
  - `npm run dev:whatsapp` (fake Meta end to end on the dev DB, counts only).

- **Phase 8 · Batch 3 (T8.10–T8.15) — Phase 8 complete** — 2026-10-22
  - Frontend campaigns list, wizard, live dashboard, results + export, Call now and the campaign entry points — see the frontend CHANGELOG.
  - `GET /campaigns/summary` (dashboard card), `adminPausedCampaigns` on the admin account detail, result rows with `waitReason` (`window`, `daily_cap`, `weekly_cap`, `min_gap`), `AUTH_RATE_LIMIT_MAX` (public auth limit, default 30).
  - Fixed: the OpenAPI document lacked the campaign and top-up schemas; **found by Playwright:** the dry-run minimum gap between two calls was real time (a ×20 run's retries waited 30 real minutes); Call now calls never updated the contact's call facts; Call now on the simulated line could be busy or unanswered (it always answers now). The per-contact caps test now really reaches the dial guard.
  - Playwright: 17 campaign tests (5 specs, 61 total, green twice); backend logs of the run free of phones, names, customer phrases, template texts, `Bearer`, `sk-`, tokens and tickets.
  - Sign-off: [PHASE_8_SIGNOFF.md](docs/phases/PHASE_8_SIGNOFF.md) (gap audit, numbers, deviations, TODOs by phase, pending inputs).
  - Tests: 2197 → 2203 (frontend 666 → 737).

- **Phase 8 · Batch 2 (T8.6–T8.9)** — 2026-10-21
  - Recurring campaigns (daily / weekly in the campaign timezone): one run per occurrence (job scheduler + sweep safety net), skipped while the previous run is active, parent completes after `until`.
  - Notifications: campaign finished / paused / run skipped to the starter + owners + admins; `campaign.paused` email once per automatic pause.
  - Contact filters `lastDisposition` / `lastCalledAt`; contact JSON `lastDisposition`; Settings call caps + calling-window warning; superadmin account limits, emergency pause and admin resume.
  - Campaigns API (`/campaigns` CRUD, preview, estimate, start with Idempotency-Key, pause / resume / cancel, contacts, runs, export), `POST /calls` single call, results export (CSV / XLSX), `campaign:<id>` topic auth, OpenAPI.
  - Hardening tests (100-contact dry run with an overnight window gap, crash recovery, Redis flush, repeated jobs, two dispatchers, failure paths), `npm run bench:campaign`, sample `docs/samples/campaign-100.csv`, campaign seed, ADR 0036, docs.
  - Fixed: dry-run dials paced in virtual time; a contact whose call ended without counting is dialed again; a campaign whose flow can no longer run pauses (`flow_not_runnable`); a waiting campaign picks up a changed window; progress updates never crash the process.
  - Tests: 2132 → 2197.

- **Phase 8 · Batch 1 (T8.1–T8.5)** — 2026-10-20
  - Models: Campaign (mode, pinned flow version, audience, schedule, window, retry, follow-ups, pacing, dry-run settings, stats, history) and CampaignContact (audience snapshot), Call `campaignContactId` / `attempt` / `charged` / provider `dryrun`, busy / no-answer statuses, Contact `lastDisposition`, Account `limits` + `settings.callCaps`; migration 0009, `CAMPAIGN_LIMITS`, env (`TELEPHONY_PROVIDER`, `DRY_RUN_MAX_SPEED`, `CAMPAIGNS_ENABLED`), error codes 44 → 47, audit 71 → 83, `campaign.*` WS events, permission `campaigns.export`, notification types.
  - Calling-window math (`date-fns` 4.4.0 + `@date-fns/tz` 1.5.0, MIT), dial guard (DND, opt-out, per-contact caps, min gap, money, compliance bounds), atomic Redis dial slots (Lua) + rate buckets; web test calls use the slots.
  - Outbound call path (`startOutboundCall`) and the dry-run telephony provider: seeded outcomes, simulated customers per template, scaled clock, virtual billing (never charges).
  - Campaign service: CRUD with revisions, audience preview + resumable snapshot, cost estimate, start / schedule / pause / resume / cancel, flows in use by campaigns.
  - Scheduler + dispatcher + results: per-account dial loop (priority, round robin, window, money gate, slots, rate, claim, guard), result classification (retries into the window, callbacks, promise follow-ups), circuit breaker, auto-pause / auto-resume, sweep every minute, live progress; `npm run dev:campaign`.
  - Fixed: a high-priority campaign now fills the slots before a normal one; shutdown waits for dispatcher ticks and call results in flight; a cancel with hang-up also ends calls that were still being set up or dialed.
  - Tests: 2022 → 2132.

- **Phase 7 · Batch 3 (T7.10–T7.15) — Phase 7 complete** — 2026-10-16
  - Frontend web call tester, calls list and call detail, test call entry points, Settings → Calls, ledger call breakdown, dashboard recent calls — see the frontend CHANGELOG.
  - `POST /calls/web` returns which voice runs (`voice: 'openai' | 'fake'`).
  - Fixed (found by Playwright, each with a regression test): signed files were blocked for the dashboard by the same-origin CORP header and could not seek (now `Cross-Origin-Resource-Policy: cross-origin` + `Range` support); the media socket stayed open after the tester hung up; words said during the AI step's opening line were lost; the transcript notice now names the line a barge-in cut (`interrupted`). Frontend fix from the fresh-clone run: the tester result waits for the saved call.
  - Gap test: `/ws/media` fuzz (single-use tickets, control garbage, wrong frame sizes, oversized control).
  - Playwright: 12 call tests (44 total, green twice); backend logs of the run free of secret headers, `Bearer`, `sk-`, customer words, bot / template texts, names and phones.
  - Sign-off: [PHASE_7_SIGNOFF.md](docs/phases/PHASE_7_SIGNOFF.md) (gap audit, numbers, deviations, TODOs by phase, pending inputs).
  - Tests: 2015 → 2022 (frontend 614 → 666).

- **Phase 7 · Batch 2 (T7.6–T7.9)** — 2026-10-15
  - Flow voice host: published / draft flows run live on calls (say / play / listen / digits / transfer / hang up, TTS cache, type-ahead keys, barge-in, timers, recording notice, max duration), engine `ai_session_end` input, call-mode runs, traces and node stats.
  - Live AI voice sessions: agents alone or as a flow step, live tools and built-ins (`createToolRunner`), knowledge search tool, barge-in truncate, silence prompts, caps, wallet checks, language per turn, fallbacks, latency metrics.
  - Calls API: `/calls/web` (flow version / draft or agent, contact or typed values + test phone, media ticket), list (cursor, filters), active, detail, transcript, events, signed recording link (audited), hangup; OpenAPI.
  - Seed (demo flow + agent calls), `customer-silence.wav` fixture, ADR 0035, `bench:voice` (20 calls: 1.8 % CPU per call, lag p99 15 ms), docs, live OpenAI voice checklist.
  - Fixed: flow calls now end at the flow max duration; a polite end (wallet, shutdown) is kept when the script returns on stop.
  - Tests: 1953 → 2015.

- **Phase 7 · Batch 1 (T7.1–T7.5)** — 2026-10-13
  - Models (Call, CallEvent, TranscriptTurn, TTS cache), FlowRun `callId`, migration 0008, `CALL_LIMITS`, voice env vars with production rules, error codes 41 → 44, audit 68 → 71, `call.*` WS events, `telephony` flag in the call charge.
  - Audio core: PCM16, G.711 μ-law / A-law, resampler, framer, pacer, energy VAD, stereo WAV recorder, WAV / MP3 decode (`mpg123-decoder` 1.0.3, MIT) with a cache.
  - Voice providers: OpenAI Realtime / TTS / transcription behind interfaces, deterministic fakes (chat-backed voice session, fake TTS / STT), TTS cache with single flight.
  - Telephony interface + WebCall provider, `/ws/media` (single-use tickets, protocol, frame limits, close codes), `call:<id>` topic authorisation.
  - Call session manager: lifecycle, Redis registry and limits, wallet hold / extend / settle, recording, transcript and events, WS, graceful shutdown, reaper and retention purge; `npm run dev:call`.
  - Fixed: two simultaneous TTS requests for the same line both synthesised.
  - Tests: 1865 → 1953.

- **Phase 6 · Batch 3 (T6.10–T6.15) — Phase 6 complete** — 2026-10-12
  - Frontend flows list, template picker, import / export, versions, visual builder (all 15 step forms, flow settings / variables, problems, undo / redo, copy / paste, auto-layout, conflict handling), simulator panel, run details and stats overlay — see the frontend CHANGELOG.
  - Agent list rows carry the template key (template picker suggestions).
  - Gap test: another account's audio id in a graph is `audio_missing`, never named, and can't be simulated.
  - Playwright: 11 flow tests (32 total, green twice); backend logs of the run free of secret headers, customer texts and phones.
  - Sign-off: [PHASE_6_SIGNOFF.md](docs/phases/PHASE_6_SIGNOFF.md) (gap audit, numbers, deviations, TODOs by phase, pending inputs).
  - Tests: 1864 → 1865 (frontend 478 → 614).

- **Phase 6 · Batch 2 (T6.6–T6.9)** — 2026-10-12
  - Flow engine: `advance()` interpreter (JSON state, host actions, trace), one handler per node type, keypad menus / digits / speech with retries and keyword or AI intents, loop / visit / auto-step guards, max duration, error exits + flow error handler (hang up or transfer), call-mode trace redaction, node stats (`$inc`), seeded fuzz test.
  - Effects: API nodes through the SSRF guard (`sendGuardedRequest`, flat + server-only templates, sealed secrets), AI agent nodes via `runAgentTurn` (step goal as "Task in this step", `flow_simulator` billing, outcome → exit), AI intent classifier (`flow_intent` billing, fake-provider rule).
  - Simulator API: start from draft (snapshot) / published / version with a contact or manual values + test phone, idempotent inputs, auto timers, transcript, trace, cost; `/flows/:id/stats`. Every Loan recovery branch proven at API level.
  - Seed (published Loan recovery, draft feedback flow, welcome audio), ADR 0034, `bench:flow` (p95 96 µs per `advance`, validate 2.3 ms), README / security / compliance / API docs.
  - Tests: 1780 → 1864.

- **Phase 6 · Batch 1 (T6.1–T6.5)** — 2026-10-10
  - Models (flows with an embedded draft + revision, immutable flow versions, simulator / call runs with a 30-day TTL, node stats, flow audio), migration 0007, `FLOW_LIMITS`, 2 error codes (`FLOW_REVISION_CONFLICT`, `RESOURCE_IN_USE`), 11 audit actions, 2 WS events (`flow.updated`, `flow.published`), ledger kinds `flow_simulator` / `flow_intent`.
  - Flow engine core: strict graph schema with 15 node configs, named exits, palette catalogue, canonical checksum + diff summary, variables (contact / flow / system, coercion, display), conditions, Hinglish + Devanagari keyword intents, validator with 23 issue codes (silent loops via SCC). Phase 5 function templating moved to `core/templating` unchanged.
  - `/flows`: CRUD, revision-checked draft saves with sealed API secrets, validate, publish → immutable versions, restore, duplicate, archive, delete (30-day purge), export without secrets, hardened import with agent / audio remap, 4 templates (Loan recovery, Payment reminder, Feedback survey, Inbound support), catalog, variables.
  - Agents used by a flow can't be deleted (409 with the flows) or purged; agent usage lists them. Dev mock APIs: `/mock/loan-balance`, `/mock/http-status/:code`.
  - `/flow-audio`: WAV / MP3 upload with own header probes (5 MB, 120 s, 200 per account, 20 / h), signed playback URL, rename, in-use delete guard, file purge; `npm run fixtures:audio`.
  - Tests: 1526 → 1780.

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
