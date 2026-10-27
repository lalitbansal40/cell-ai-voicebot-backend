# Phase 14 — Records, Transcripts & Analytics (voice + WhatsApp) (Detailed Plan)

**Status:** Draft — 2026-10-27 · **Branch:** `feature/phase-14-records-analytics` (both repos, from `main` = backend `1d9f67e`, frontend `db6bb4e`; the frontend branch is created at the first frontend task) · **Overview:** [BUILD_PLAN_V2.md](../plans/BUILD_PLAN_V2.md) §4 Phase 14 · **Previous:** [PHASE_13_PLAN.md](PHASE_13_PLAN.md)

> **Phase 13 is still open** — its server work (T13.5 onwards) waits on the provider (SSH access, OS, DNS). Phase 14 is code-only and runs meanwhile. Rule: a Phase 13 code fix lands on `main` first (own `fix(...)` commit), then `main` is **merged** into `feature/phase-14-records-analytics` (no rebase of a pushed branch). Phase 14's staging check (T14.10 step 6) runs only once staging is live.

---

## 0. Is phase ka goal

Phase 14 ke end tak:

- Har **call** (phone dry-run / web test / WhatsApp — AI aur human dono) ka **record** poora dikhe: transcript, recording, AI **summary**, **disposition**, **sentiment**, **key info** (promise date / amount, callback time, dispute reason …), cost, timeline.
- Har **WhatsApp chat** ka on-demand / on-close **summary**.
- **Reports** page (abhi menu mein `phase: 14` se chhupa hai): Overview, Calls, WhatsApp messages, Templates, Campaigns (compare), Flows & agents (per-node funnel), Team — filters (date range in account timezone, channel / number, campaign, flow, agent, team member), charts, tables.
- **Dashboard** pe KPI tiles (aaj vs kal, 7 din trend).
- **Exports:** calls, messages (bina text ke) aur report tables — CSV / XLSX, existing export-job pipeline se.
- **Scheduled email reports** (daily / weekly / monthly, per user opt-in).
- **Retention settings** per account (recordings, call records + transcripts, inbox messages + media) + auto-delete jobs per account; aggregated numbers (rollups, no personal data) purge ke baad bhi rahen.

**Done when:**

- Har answered AI call aur har recorded human call ke detail page pe summary + disposition + sentiment + key info dikhe (ya clear reason: "too short", "low balance", "turned off"); chat detail pe summary button chale.
- Dashboard / reports ke **numbers raw data se match** karen: ek automated test har metric ko raw collections se dobara gin ke compare kare (seeded + random data, 3 timezones, day boundaries), aur nightly reconcile job staging pe 0 differences report kare.
- Reports 100k calls + 500k messages wale account pe < 1.5 s (p95, local Mongo) load hon.
- Exports aur scheduled emails kaam karen; email mein koi phone number / naam / message text / transcript nahi.
- Retention settings badalne pe auto-delete job usi hisaab se purane recordings / records hataye, rollups bache rahen, audit log bane.
- Poora verify (lint, types, unit + integration, coverage gates) + Playwright suite do baar green (fake providers).

### Phase 14 mein kya NAHI hoga

| Kaam                                                                        | Kaunse phase mein                                     |
| --------------------------------------------------------------------------- | ----------------------------------------------------- |
| Public API for reports / call results, outgoing webhooks (`call.completed`) | Phase 15                                              |
| "Send WhatsApp after the call" flow step / outcome rules                    | Phase 15                                              |
| Google Sheet / CRM sync                                                     | Phase 15                                              |
| Security audit, load test at scale, DPDP DPA templates                      | Phase 16 (Phase 14 does its own perf test only)       |
| SIP / real phone calls (phone numbers stay `dryrun` / web)                  | Phase 18 — reports already count `provider` per call  |
| Inbound phone call reports (DIDs, queues, missed-call callbacks)            | Phase 19                                              |
| Bulk WhatsApp campaign reports                                              | Phase 20 (data model ready: `source` dimension)       |
| Live wallboard (real-time agent status)                                     | Later, only if the owner asks (§7 #15)                |
| Meta's own analytics APIs (template / pricing analytics)                    | Later (§7 #13) — Phase 14 counts from our own records |
| Speech analytics beyond the listed fields (talk ratio, keywords, QA scores) | Later (§7 #16)                                        |

### Conventions to follow

Same as earlier phases: [api.md](../conventions/api.md), [security.md](../conventions/security.md), [secrets.md](../conventions/secrets.md), [data.md](../conventions/data.md), [data-model.md](../conventions/data-model.md), [audit.md](../conventions/audit.md), [definition-of-done.md](../conventions/definition-of-done.md), ADR 0028 (ports), ADR 0030 (email), ADR 0032 (wallet / billing), ADR 0033 (AI), ADR 0035 (voice runtime), ADR 0038 (inbox), ADR 0041 (WhatsApp calling).

- **Personal data:** summaries, key info and chat summaries are customer data — tenant-scoped, covered by the same retention as the call / conversation, **never** in logs, emails, notifications, audit details, export file names or error messages. Logs keep the Phase 9–13 rules (no texts, numbers, names, SDP, tokens).
- **AI:** transcript text goes to the model as **data** (system prompt says so; output is schema-validated, nothing in it is executed or rendered as HTML). Every AI request is charged through the wallet (`chargeUsage`, idempotency key per call / version) and respects the account's AI budget.
- **Money:** report "spend" comes from the **ledger** (source of truth), never re-computed from per-call cost fields.
- **Time:** every "day" is the account's timezone day (`account.timezone`, `@date-fns/tz`), stored as `YYYY-MM-DD` like `flow-node-stats` / `agent-usage`.
- **Tests:** no external network; OpenAI stays faked (deterministic fake structured output); `--maxWorkers=2`; never raise test timeouts; a real bug in committed code → separate `fix(...)` commit with a regression test proven to fail first.
- **Git:** one commit per task per repo, `[P14-T14.x]` tag, footer `Co-Authored-By`, no push / merge without the owner's say-so.
- **Other projects:** never touched (Docker: only `cav-*` / our compose projects; port 3100 → use 3150 for E2E).

---

## 1. Locked decisions (proposed — final after the owner answers §7)

### 1a. What exists today (reuse, don't rebuild)

| Already built                                                                                                 | Where                                                            | Phase 14 uses it for                   |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------- |
| `calls` with status, endReason, durations, `disposition`, `outcome`, metrics, cost, recording, WhatsApp parts | `db/models/call.model.ts`                                        | calls reports, call record             |
| `transcript_turns` (customer / bot / agent; sources tts / ai / stt / dtmf)                                    | `db/models/transcript-turn.model.ts`                             | summaries, human-call transcripts      |
| Stereo WAV recording (customer left, bot / agent right)                                                       | `modules/calls/recording.ts`                                     | speaker-separated transcription        |
| Flow `set-disposition` node, AI-agent outcomes, campaign-contact `disposition`                                | `core/engine/nodes/*`, `campaign-contact.model.ts`               | disposition precedence (§1d)           |
| `flow_node_stats` (per node per day) and `agent_usage` (per agent per day)                                    | `db/models/*`                                                    | flow funnel, agent report              |
| Campaign results CSV / XLSX + `export_jobs` (`contacts`, `campaign_results`)                                  | `modules/campaigns/export.ts`, `modules/contact-exports/*`       | new export kinds                       |
| Messages with status history, origin, template ref, billing; conversations with assignment / window           | `message.model.ts`, `conversation.model.ts`                      | WhatsApp + team reports                |
| Template counters (`sent / delivered / read / failed`, lifetime) + quality                                    | `whatsapp-template.model.ts`                                     | shown, but reports count from messages |
| `chargeUsage` (AI / TTS outside a call), AI budget, `OPENAI_TEXT_MODEL`, `OPENAI_TRANSCRIBE_MODEL`            | `core/billing/engine.ts`, `core/ai/*`, `config/env.ts`           | post-call AI charging                  |
| Purge jobs: calls `CALL_RETENTION_DAYS` (180), inbox `INBOX_RETENTION_DAYS` (90) — platform-wide              | `modules/calls/maintenance.ts`, `modules/inbox/retention.job.ts` | per-account retention (§1h)            |
| Permissions `reports.read`, `reports.export`, `calls.export` (defined, **not used yet**)                      | `modules/rbac/permissions.ts`, `system-roles.ts`                 | report routes / exports                |
| `@mui/x-charts` (wallet usage chart, campaign progress)                                                       | frontend                                                         | all charts                             |
| Hidden "Reports" menu item (`/reports`, `phase: 14`, `reports.read`)                                          | `frontend/src/layout/nav-config.ts`                              | turned on                              |
| `CallSession.onEnded(summary)` hook                                                                           | `modules/calls/session.ts`                                       | queue post-call jobs                   |

### 1b. Metric definitions (one glossary — UI tooltips, docs and tests use these exact words)

`docs/analytics/METRICS.md` (new) holds the table; the code has one `metrics/definitions.ts` used by both the rollup writer and the "count from raw" test.

| Metric                    | Definition                                                                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Calls attempted           | Calls that left `queued` (excludes `canceled` before dialing). Test calls (`isTest`) excluded unless the "Include test calls" switch is on.   |
| Answered                  | `timestamps.answeredAt != null`                                                                                                               |
| Answer rate               | answered ÷ attempted                                                                                                                          |
| Talk time / Avg duration  | sum / mean of `durationSec` over answered calls (WhatsApp: Meta's duration when present — same field billing uses)                            |
| Outcome                   | final `disposition` (§1d); "No disposition" bucket when empty                                                                                 |
| Promise to pay (PTP)      | calls whose key info has `promiseDate`; PTP amount = sum of `promiseAmountMicros`                                                             |
| Spend                     | ledger debits − refunds by type (`call_charge`, `whatsapp_charge`, `whatsapp_call_charge`, `ai_charge`, `tts_charge`, `recording_charge`)     |
| Messages sent             | outbound business messages (`origin` agent / api / system-sent templates; not notes, reactions, history imports) that reached `sent` or later |
| Delivered / Read / Failed | highest status reached (status rank), per message                                                                                             |
| Replied                   | business-initiated message (template) followed by a customer inbound in the same conversation within 24 h                                     |
| First response time       | customer inbound (conversation waiting) → first team reply (agent / AI), per waiting period; median + p90; wall clock                         |
| Template performance      | per template + language: sent, delivered %, read %, replied %, failed % (from messages, so date filters work — not the lifetime counters)     |
| Campaign comparison       | per campaign / run: contacts, attempted, reached, answer rate, PTP count / amount, spend, cost per reached contact                            |
| Flow funnel               | per published version: node entries / exits from `flow_node_stats`                                                                            |
| Agent (AI) performance    | calls, answered, avg duration, dispositions, PTPs, AI spend                                                                                   |
| Team member performance   | calls answered, talk time, chats replied, messages sent, first response time                                                                  |

### 1c. Data foundation — daily rollups + recount

- **New collection `stats_daily`** (`db/models/stats-daily.model.ts`): `{ accountId, day: 'YYYY-MM-DD', channel: 'voice' | 'whatsapp', dims: { kind: 'all' | 'campaign' | 'flow' | 'agent' | 'user' | 'template' | 'number', id: ObjectId | null }, counters: {...}, hist: {...} }`, unique on `(accountId, day, channel, dims.kind, dims.id)`. Counters are integers only (micros for money, seconds for time); duration histograms in fixed buckets (for medians / p90 without raw data).
- **Writes:** an `analytics` job (queue `maintenance`, one job id per entity + version) runs when a call becomes final / a WhatsApp message reaches a new status / a ledger entry is captured. It computes that entity's **contribution** and stores it on the entity (`analytics: { v, day, counted: {...} }`), then applies the **difference** to `stats_daily` with `$inc` in a transaction → late webhooks (Meta duration, status after hours) and re-runs never double count.
- **Recount:** `npm run analytics:rebuild -- --account <id> --from --to` (and a nightly job for the last 3 days) recomputes rollups from raw and reports differences (counter + alert mail when ≠ 0). Migration `0015-analytics` backfills every account from raw (batched, resumable) and adds indexes.
- **Reads:** reports read rollups for totals / trends; drill-down tables (call list, message list) read raw with the existing paginated APIs. Rollups hold **no personal data** and are kept 25 months (§7 #9) even after raw purge.
- **Caching:** overview queries cached in Redis 60 s per (account, filter hash); a write to the account's rollups clears nothing (60 s staleness is fine and stated in the UI: "Updated a minute ago").

### 1d. Post-call AI (the "insights")

- **When:** after a call is final **and** answered **and** has ≥ 2 customer turns (else `skipped: too_short`). Voice AI calls and WhatsApp AI calls: right away from `transcript_turns`. **Human calls** (WhatsApp agent calls, web test with a person): first transcribe the stereo recording (`OPENAI_TRANSCRIBE_MODEL`, left = customer, right = agent) into `transcript_turns` (`source: 'stt'`), then insights (§7 #1).
- **Output (JSON schema, validated with zod, stored in `call_insights`, one doc per call + version):** `summary` (≤ 600 chars, §7 #2 language), `suggestedDisposition` (one key from the account's disposition list), `sentiment` (`positive | neutral | negative` + score −1…1), `keyInfo` (`promiseDate`, `promiseAmountMicros`, `callbackAt`, `disputeReason`, `wrongNumber`, `languagePreference`, `notes` — all optional, typed), `confidence` per field, `model`, `tokens`, `costMicros`, `status: done | skipped | failed`, `reason`.
- **Disposition precedence:** flow `set-disposition` / agent tool result / a person's manual choice **win**; AI's is stored as `suggestedDisposition` and only fills `call.disposition` when that is empty (`dispositionSource: 'flow' | 'agent' | 'user' | 'ai'`). A team member can change it on the call page (audit logged).
- **Provider change:** `ChatRequest` gets `responseFormat?: { type: 'json_schema'; name; schema }` (OpenAI structured outputs); the fake provider returns deterministic schema-valid output derived from the transcript (so tests check wiring, not AI quality).
- **Money:** priced with the existing text-model pricing + AI markup → `chargeUsage({ type: 'ai_charge', ref: { type: 'call', id }, idempotencyKey: 'insights:<callId>:v<version>' })`; STT the same with `'stt:<callId>'`. Prepaid balance only; not enough → `skipped: low_balance` (retry button later). Account switch **Settings → AI → Post-call insights** (on / off). Human-call transcription reuses the Phase 12 toggle `settings.whatsappCalling.transcribeHumanCalls` (stored since Phase 12, default **off** — Phase 12 owner decision #10; nothing reads it yet) — Phase 14 makes it start the STT pipeline and shows it in the same settings card.
- **Re-run:** "Regenerate" on the call page (permission per §7 #11, default `calls.listen`) → new version, charged again, old version kept for audit.
- **Chat summary:** "Summarize" button in the inbox conversation header + optional summary on close (setting) — last summary point → now, max 200 messages, no notes / system rows; stored in `conversation_summaries`; charged the same way.
- **Prompts** live in `core/ai/prompts/insights.ts` (versioned, snapshot-tested), English instructions, transcript in a delimited data block, PII never echoed into logs.

### 1e. Reports UI (frontend `features/reports/*`, route `/reports`)

- Tabs: **Overview** · **Calls** · **WhatsApp** · **Templates** · **Campaigns** · **Flows & agents** · **Team**. Each tab = KPI tiles + 1–2 charts + a table, all from one `GET /reports/<tab>` response.
- Filter bar (URL query params, shareable): date range (Today, Yesterday, 7 / 30 / 90 days, This / Last month, Custom ≤ 366 days), compare with previous period (on / off), channel (voice / WhatsApp), WhatsApp number, campaign, flow, AI agent, team member, include test calls.
- Charts: `@mui/x-charts` (line: calls / messages per day; stacked bar: outcomes; funnel-as-bar: sent → delivered → read → replied; donut: sentiment). Every chart has a table fallback + accessible labels; empty / loading / error states.
- Clicking a number opens the matching raw list (Calls page / Inbox) with the same filters (new list filters: disposition, sentiment, has PTP, has summary, answered by).
- **Dashboard:** KPI row (calls today, answer rate, PTPs today, messages sent, read %, spend today; vs yesterday) above the existing cards; respects permissions (no tile without `reports.read`).

### 1f. Exports

- New `EXPORT_KINDS`: `calls`, `messages`, `report` (the current tab's table). Same job / storage / signed download / expiry as contacts export.
- `calls` columns: date (account TZ), direction, channel, number label, contact name, phone (**only with `includePhone`** → needs `contacts.export`, like contacts), status, duration, disposition (+ source), sentiment, PTP date / amount, campaign, flow, agent, answered by, spend, summary (**only with `includeSummary`**, §7 #12).
- `messages`: metadata only (date, direction, type, status, template, conversation id, team member) — **never message text**.
- Permissions: `calls.export` for calls, `reports.export` for messages / report; max 200k rows per file; XLSX via `write-excel-file` (already used).

### 1g. Scheduled email reports

- `report_subscriptions`: `{ accountId, userId, frequency: daily | weekly | monthly, tabs: ['overview', …], hour: 9, active }` — user manages own in **Settings → Notifications → Email reports**; admins can't subscribe others (§7 #7).
- Repeatable job (queue `email`) at the account-timezone hour; checks the user is active and still has `reports.read` at send time; builds the email from rollups: KPI table + vs previous period + "Open report" link. **No** names, phones, texts, summaries.
- Unsubscribe link (signed token, one click, no login) + List-Unsubscribe header; bounces → existing email handling.

### 1h. Retention settings

- `account.retention`: `recordingsDays`, `callsDays` (records, events, transcripts, insights), `inboxDays` (messages + media + chat summaries), each `null` = platform default; bounded by the platform maximum (env stays the **upper** limit, superadmin can lower per account) and a minimum (7 days calls, 30 days inbox; recordings ≥ 1 day).
- `recordingsDays ≤ callsDays` (a recording can go earlier than its call record, never later).
- Purge jobs become per-account (batched, resumable, idempotent), log counts only; deleting a recording keeps the call row with `recording: { deletedAt }` so the UI says "Recording deleted after N days".
- UI: **Settings → Data retention** (owner / admin, `account.update`), shows what gets deleted and when, confirm dialog when shortening, audit log entry. Rollups untouched. Privacy Policy text (Phase 13 `privacy.md`) gets the per-account sentence.

### 1i. API shape

`/api/v1/reports/overview|calls|whatsapp|templates|campaigns|flows|agents|team` (GET, `reports.read`), `/api/v1/calls/:id/insights` (GET, `POST …/regenerate`), `PATCH /api/v1/calls/:id/disposition`, `/api/v1/inbox/conversations/:id/summary` (GET, POST), `/api/v1/report-subscriptions` (CRUD own), `/api/v1/account/retention` (GET / PUT). All zod-validated, OpenAPI-registered, tenant-scoped, rate-limited like other read APIs, `ETag` for report GETs.

---

## 2. Tasks ka overview

| #           | Task                                                                                                                                                     | Repo | Size | Depends      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---- | ------------ |
| T14.1       | Metrics glossary + `stats_daily` model + contribution writer + recount CLI + nightly reconcile + migration 0015 backfill + "count from raw" test harness | BE   | L    | —            |
| T14.2       | Reports API (7 tabs) + filters + caching + OpenAPI + new call-list filters                                                                               | BE   | L    | T14.1        |
| T14.3       | AI structured output (provider + fake) + post-call insights pipeline + charging + disposition precedence + regenerate + settings                         | BE   | L    | —            |
| T14.4       | Human-call transcription (stereo STT) + chat summary                                                                                                     | BE   | M    | T14.3        |
| P14-B1-DONE | checkpoint: backend verify + coverage; recount = rollups on seeded data; insights on fake provider for every call kind                                   |      |      |              |
| T14.5       | Call record + inbox UI: insights panel, disposition edit, sentiment / PTP chips, regenerate, chat summary, calls list filters                            | FE   | M    | T14.3, T14.4 |
| T14.6       | Reports pages (7 tabs) + filter bar + charts + drill-down + Dashboard KPI row; menu item on                                                              | FE   | L    | T14.2        |
| T14.7       | Exports (calls, messages, report) + scheduled email reports (both repos)                                                                                 | both | M    | T14.2        |
| T14.8       | Retention settings + per-account purge jobs + UI + privacy text                                                                                          | both | M    | T14.1        |
| P14-B2-DONE | checkpoint: whole verify both repos; Playwright green twice                                                                                              |      |      |              |
| T14.9       | Seeds + demo data, E2E specs, perf test (100k calls / 500k messages), numbers-match test across timezones, security checks (tenant, PII)                 | both | M    | all above    |
| T14.10      | Gap audit, docs (METRICS.md, ADR 0043 + 0044, setup guide openai.md costs, READMEs, CHANGELOGs, BUILD_PLAN_V2), staging check (if live), sign-off        | both | M    | all          |
| P14-B3-DONE | checkpoint                                                                                                                                               |      |      |              |

---

## 3. Tasks — step by step

### T14.1 — Metrics + rollups (backend)

1. Write `docs/analytics/METRICS.md` (§1b table + examples + edge cases: canceled before dial, test calls, retries, WhatsApp late duration, failed-then-delivered, deleted messages, transferred calls, merged contacts).
2. `src/modules/analytics/definitions.ts`: pure functions `callContribution(call, ledger)`, `messageContribution(message)`, `ledgerContribution(entry)` → `{ day, rows: [{ channel, dims, counters, hist }] }` using the account timezone. Unit tests per edge case.
3. `stats-daily.model.ts` (+ indexes `(accountId, day)`, `(accountId, dims.kind, dims.id, day)`), registered in `db/models/all.ts` (sync-indexes picks it up).
4. Writer `applyContribution(entity, next)` — loads stored `analytics.counted`, computes the difference, `$inc` in one transaction with the entity's `analytics` update; version field guards races (retry on conflict). Hooks: `CallSession.onEnded`, WhatsApp call final + Meta late duration, message status service, ledger capture / refund → enqueue `analytics:<kind>:<id>` (dedupe by job id, delay 2 s to batch bursts).
5. Recount: `src/ops/analytics-rebuild.ts` (`npm run analytics:rebuild`, also in the Docker image ops list) — streams raw by day, rebuilds into a temp key, compares, swaps; prints counts only. Nightly job (last 3 days, every account) → differences counter + alert mail to platform alerts when ≠ 0.
6. Migration `0015-analytics`: indexes for aggregations (`calls (accountId, timestamps.endedAt)`, `messages (accountId, direction, at)` if missing — check `explain()` first), backfill all accounts in batches (resumable cursor in the migration state), `analytics.counted` set on each entity.
7. Test harness `tests/helpers/analytics.ts`: random generator (calls of every kind / status, messages with status sequences, ledger entries, late events) + `countFromRaw()` — property-style test: for 3 timezones (Asia/Kolkata, UTC, America/New_York) and day-boundary timestamps, rollups == raw recount == rebuild.
8. Retention interplay: purging raw must **not** touch rollups — test.

### T14.2 — Reports API (backend)

1. `modules/reports/*`: `reports.schema.ts` (shared filter schema: `from`, `to` as account-local dates, `compare`, `channel`, `channelId`, `campaignId`, `flowId`, `agentId`, `userId`, `includeTest`; max 366 days), one service per tab, `reports.routes.ts` with `reports.read`.
2. Response shape per tab: `{ range, compareRange?, kpis: [{ key, value, previous?, unit }], series: [{ key, points: [{ day, value }] }], table: { columns, rows, nextCursor? }, updatedAt }`.
3. Overview + Calls + WhatsApp + Templates + Campaigns + Flows & agents (flow funnel from `flow_node_stats`, agent rows from rollups + `agent_usage`) + Team.
4. Calls list (`GET /calls`) new filters: `disposition`, `sentiment`, `hasPromise`, `hasSummary`, `answeredBy`, `channelId`; indexes checked with `explain()`; tests.
5. Redis cache 60 s (key = account + normalized filter hash), `ETag` / `304`; rate limit like other reads.
6. OpenAPI registration + docs page entries; tenant isolation tests (account A never sees B — every route); permission tests (viewer can read, agent can't).

### T14.3 — Post-call insights (backend)

1. `core/ai/types.ts`: `responseFormat` on `ChatRequest`; OpenAI provider sends `response_format: { type: 'json_schema', json_schema: { name, schema, strict: true } }`; refusal / invalid JSON → `failed: invalid_output` (one retry). Fake provider: deterministic output from transcript hash. Tests with recorded fixture payloads (no network).
2. `call-insights.model.ts` (+ indexes `(accountId, callId, version)` unique, `(accountId, createdAt)`), `call.dispositionSource`, account `dispositions` list (defaults §7 #3, editable in Settings → Calls; keys stable, labels editable) — migration adds defaults.
3. Job `insights:<callId>` on queue `ai`: guards (answered, ≥ 2 customer turns, setting on, not purged, balance) → build prompt (transcript turns, flow / agent name, contact variables whitelist: loan amount, due date — never phone) → chat → validate (zod) → store → set disposition per precedence → charge (`chargeUsage`, idempotent) → realtime event `call.insights` to the call topic → analytics contribution update (PTP, sentiment).
4. Settings: `account.settings.insights { enabled, chatSummaryOnClose }` + API + audit; human transcription = existing `settings.whatsappCalling.transcribeHumanCalls` (no new field, no migration for it).
5. `POST /calls/:id/insights/regenerate` (new version, charged), `PATCH /calls/:id/disposition` (audit, source `user`).
6. Tests: every call kind (voice AI dry-run, web test, WhatsApp AI, WhatsApp human with recording, too short, not answered, low balance, setting off, provider failure, duplicate job), money (ledger once per version), no transcript / summary text in logs (log-capture test).

### T14.4 — Human-call transcription + chat summary (backend)

1. Verify which call kinds record today (WhatsApp human calls through the bridge, web tests) — record the matrix in ADR 0044; fill gaps only if a recording exists for that kind already (no new recording scope in this phase unless §7 #1 says so).
2. `stt.job.ts`: split stereo WAV into two mono streams, transcribe each (`OPENAI_TRANSCRIBE_MODEL`, segments with timestamps), merge by time into `transcript_turns` (`speaker` customer / agent, `source: 'stt'`), charge by audio minutes, then enqueue insights. Files > 25 MB → chunk by 10 min.
3. Chat summary service + `conversation_summaries` model + routes + "on close" hook (setting); max 200 messages; skip notes / system / reactions; charged; tests incl. empty conversation and media-only messages ("[image]").

### P14-B1-DONE — checkpoint

Backend: lint, types, format, build, all tests (`--maxWorkers=2`), coverage ≥ current gates; `analytics:rebuild` on the seeded dev DB → 0 differences; insights produced for every call kind on the fake provider; log grep for phone / name / text = 0. Commit `docs: mark phase 14 batch 1 complete [P14-B1-DONE]`.

### T14.5 — Call record + inbox UI (frontend)

1. Call detail page: **Insights** card (summary, disposition chip + source, sentiment chip, key info rows with "AI" label + confidence hint, status / reason when skipped, Regenerate with cost note, disposition editor), transcript tab shows `stt` turns for human calls, recording "deleted after N days" state.
2. Calls list: columns disposition / sentiment / PTP; filters for them; saved in URL.
3. Inbox: "Summarize" in conversation header, summary drawer (time, model, regenerate), on-close summary visible in conversation info.
4. Settings → AI: insights switches; Settings → Calls: dispositions list editor.
5. Unit tests (RTL) for every state, a11y labels, permission hiding.

### T14.6 — Reports pages + Dashboard (frontend)

1. `features/reports/*`: filter bar (URL state), tab pages, KPI tile component (value, delta vs previous, tooltip with the METRICS.md definition), charts, tables with sorting + pagination, empty / loading / error states, drill-down links.
2. Turn on the menu item (remove `phase: 14` gate), route `/reports/:tab`, lazy-loaded chunk (bundle budget: reports chunk ≤ 120 KB gz; main bundle +≤ 2 KB).
3. Dashboard KPI row + "View reports" link.
4. Tests: RTL per tab with mocked API, timezone label, compare toggle, drill-down URL building.

### T14.7 — Exports + scheduled email reports (both)

1. Backend: export kinds `calls`, `messages`, `report` in the export job (stream with cursor, XLSX / CSV, phone / summary flags + permission checks), tests incl. 200k cap and permission denial.
2. Backend: `report_subscriptions` model + routes + repeatable scheduler (per account TZ hour) + email template (`core/email/templates/report.ts`, snapshot test, no PII) + signed unsubscribe route (public, rate-limited) + List-Unsubscribe header.
3. Frontend: Export buttons (calls list, each report tab) using the existing export dialog / jobs list; Settings → Notifications → Email reports form; unsubscribe result page.

### T14.8 — Retention (both)

1. Backend: `account.retention` + validation (bounds, recordings ≤ calls) + `PUT /account/retention` (`account.update`, audit) + superadmin per-account max; purge jobs per account (calls, recordings, insights, transcripts, inbox messages, media, chat summaries), batched + resumable, counts in logs; recording deletion keeps the call row.
2. Migration: none needed (null = default) — test that defaults equal today's behaviour.
3. Frontend: Settings → Data retention page with explanation + confirm when shortening; call detail "recording deleted" state; privacy.md sentence (still `status: draft` until the client's legal approval).
4. Tests: boundaries, shortening deletes on the next run, rollups untouched, other accounts untouched.

### P14-B2-DONE — checkpoint

Both repos: lint, types, format, build, unit + integration, coverage gates; Playwright suite green twice (port 3150); bundle report; log grep 0. Commit in both repos.

### T14.9 — Seeds, E2E, perf, security (both)

1. `db:seed` adds 60 days of demo history (calls of every kind with insights, messages with statuses, templates, campaigns) so reports look real locally. The staging demo seed (`staging:demo`) gets the same history marked `isTest` with demo-labelled insights (no OpenAI calls); real insights on staging come only from real calls (§7 #14).
2. Playwright: reports tabs + filters + drill-down, call insights + regenerate, disposition edit, chat summary, export download, retention settings, email subscription (Mailpit).
3. Perf script `scripts/perf-reports.ts`: generate 100k calls + 500k messages in a throwaway DB, time each report (p95 < 1.5 s) and the backfill / rebuild; record results in the sign-off.
4. Security: tenant isolation on every new route, permission matrix test, no PII in emails / logs / export file names, prompt-injection transcript fixture ("ignore previous instructions…") → output still schema-valid, nothing executed.

### T14.10 — Gap audit, docs, sign-off (both)

1. Gap audit against §0 Done-when and §4 checklist; every gap → fix or explicit "later" with the owner's OK.
2. Docs: `docs/analytics/METRICS.md`, ADR 0043 (analytics rollups + recount), ADR 0044 (post-call AI + transcription), `docs/setup/openai.md` (insights / STT costs per call, budgets), runbook (`analytics:rebuild`, reconcile alerts), READMEs, CHANGELOGs, BUILD_PLAN_V2 changelog.
3. Phase 13 merge check: `main` merged in; whole verify again.
4. Staging (only if Phase 13 staging is live): deploy, run `analytics:rebuild` dry-run on staging → 0 differences, one real AI call + one real WhatsApp human call → insights shown, OpenAI cost per call recorded.
5. `docs/phases/PHASE_14_SIGNOFF.md` (evidence: test counts, coverage, Playwright runs, perf numbers, screenshots list, costs) + tracker ticks. Commit `[P14-B3-DONE]`.

---

## 4. Deliverables checklist

- [ ] METRICS.md + definitions code + "count from raw" test (3 timezones)
- [ ] `stats_daily` rollups, contribution writer, recount CLI, nightly reconcile + alert, migration 0015
- [ ] Reports API (7 tabs) + call-list filters + caching + OpenAPI
- [ ] Structured AI output (provider + fake), post-call insights for every call kind, disposition precedence + manual edit, regenerate, settings
- [ ] Human-call transcription (stereo STT), chat summary
- [ ] Call record + inbox UI, Settings (AI, dispositions)
- [ ] Reports pages + Dashboard KPI row; menu item live
- [ ] Exports (calls, messages, report) with permission / phone / summary rules
- [ ] Scheduled email reports + unsubscribe
- [ ] Per-account retention + purge jobs + UI + privacy sentence
- [ ] Seeds, Playwright specs, perf results, security tests
- [ ] ADR 0043 + 0044, setup guide, runbook, READMEs, CHANGELOGs, BUILD_PLAN_V2, sign-off

---

## 5. Risks

| Risk                                                         | Mitigation                                                                                                  |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Numbers drift from raw (double counts, late webhooks, races) | Contribution-difference writer + stored `counted`, version guard, nightly recount + alert, property tests   |
| Timezone / day-boundary bugs                                 | One day function, tests in 3 timezones, account-TZ labels in UI                                             |
| AI invents key info (wrong promise date / amount)            | Schema + "AI" label + confidence, never overrides flow / agent / user values, editable, shown as suggestion |
| AI cost per call surprises the client                        | Off switch, prepaid only, cost shown per call + in reports, setup guide numbers, budget limits (existing)   |
| Prompt injection via customer speech / chat                  | Transcript as delimited data, structured output only, nothing executed, fixture test                        |
| Slow aggregations on Atlas M0 / big accounts                 | Rollups for totals, indexes checked with `explain()`, 366-day cap, cache, perf test                         |
| Retention deletes data users expected                        | Bounds, confirm dialog, audit, "deleted after N days" states, rollups kept                                  |
| PII leaks through emails / exports / logs                    | No-PII email template test, export flags + permissions, log-capture tests                                   |
| Phase 13 changes conflict                                    | `main` merged in at each checkpoint; Phase 13 fixes go to `main` first                                      |
| Backfill migration heavy on a large DB                       | Batched, resumable, runs before restart in deploy (migrate step), timing from perf test                     |

---

## 6. Recommended order

Batch 1 (backend core): T14.1 → T14.3 → T14.2 → T14.4 → **P14-B1-DONE**. Batch 2 (UI + features): T14.5 → T14.6 → T14.7 → T14.8 → **P14-B2-DONE**. Batch 3: T14.9 → T14.10 → **P14-B3-DONE**. T14.1 and T14.3 are independent (can swap if the owner wants insights first).

---

## 7. Decisions and open questions (owner — defaults apply if not answered)

| #   | Question                                                    | Default                                                                                                                                 |
| --- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Transcribe recorded **human** calls (costs STT per minute)? | Already decided in Phase 12 (#10): **off** by default, per-account toggle `transcribeHumanCalls`; Phase 14 wires it to the STT pipeline |
| 2   | Summary language                                            | English (key info typed fields); transcript stays as spoken                                                                             |
| 3   | Default disposition list                                    | Promise to pay, Paid, Callback requested, Dispute, Not interested, Wrong number, Language barrier, Other                                |
| 4   | Price of insights / STT                                     | Same as other AI usage: provider cost + the platform's AI margin, charged per call                                                      |
| 5   | Insights for test calls                                     | Yes (useful for demos), charged, excluded from reports unless "include test calls"                                                      |
| 6   | Chat summary trigger                                        | On demand + optional on close (off by default)                                                                                          |
| 7   | Who can subscribe to email reports                          | Each user for themself (needs `reports.read`); no admin-managed lists                                                                   |
| 8   | Retention defaults                                          | Unchanged: calls 180 days (recordings same), inbox 90 days; accounts may shorten, superadmin may cap                                    |
| 9   | How long rollups (no personal data) are kept                | 25 months                                                                                                                               |
| 10  | Agent role sees reports?                                    | No (only own calls list as today); manager / viewer / admin / owner yes                                                                 |
| 11  | Who can regenerate insights / edit disposition              | Regenerate: `calls.listen`; edit disposition: `calls.trigger` (agents can set outcome of their calls)                                   |
| 12  | Summaries in call exports                                   | Only with "Include summaries" + `calls.export`                                                                                          |
| 13  | Use Meta's template / pricing analytics APIs                | Not now — our own records (works with date filters, no extra permission)                                                                |
| 14  | Demo history on staging for App Review                      | Yes, marked `isTest`, fake insights text clearly labelled "Demo"                                                                        |
| 15  | Live wallboard                                              | Not in Phase 14                                                                                                                         |
| 16  | Extra speech analytics (talk ratio, keywords, QA score)     | Not in Phase 14                                                                                                                         |

---

## Changelog

- 2026-10-27: plan drafted while Phase 13's server work waits on the provider. Built on a code survey of `main` (`1d9f67e`): reuse list in §1a; Reports menu item and `reports.*` permissions already exist; retention is platform-wide today; no structured AI output yet.
- 2026-10-27 (STEP 0): run prompt prepared (one-paste autonomous run, no stops) — literals locked: modules, models, limits, jobs, routes, error codes (+7), audit actions (+10), insights schema; defaults in use for §7 #1–#16 (#1 = Phase 12 decision #10, human-call transcription off by default, existing `transcribeHumanCalls` toggle).
- 2026-10-27 (P14-B1-DONE): Batch 1 complete — T14.1 rollups (`statsDaily`) + recount (`analytics:rebuild`, nightly reconcile, migration 0015), T14.3 post-call insights (structured output, sweep, precedence, regenerate, dispositions, migration 0016), T14.2 reports API (8 tabs incl. `agents`, call-list record filters, Redis cache + ETag), T14.4 human-call transcription + chat summaries. Backend 3198 → 3275 tests, coverage 96.11 / 87.53 / 95.88 / 97.64; dev DB recount 0 differences. **Deviations:** (1) collections camelCase like the rest (`statsDaily`, `analyticsMarks`, `callInsights`, `conversationSummaries`); (2) rollups are written by an `updatedAt` sweep (`analytics-sweep` every minute + `analytics-reconcile` 02:30 UTC on the maintenance queue) with counted state in `analyticsMarks` — not per-service hooks / `analytics` fields on entities (ledger rows are insert-only; every write path is covered) — ADR 0043; (3) spend = captured debits of spend types; top-up refunds are not charge reversals, so nothing is subtracted; (4) insights start from a sweep too (`insights.sweep` on the AI queue, partial index `insights_due`), settings live in `settings.insights` / `settings.dispositions`, human transcription reuses `settings.whatsappCalling.transcribeHumanCalls`; (5) realtime event `inbox.conversation.summary` (inbox naming) instead of `conversation.summary`; (6) a new notification type `analytics.reconcile_mismatch` (32); (7) STT is priced by a new rate-card field `sttPerMinuteMicros` (₹0.50 / min placeholder) and cut into VAD speech segments (the transcribe model returns no timestamps) — limits `sttSegmentMaxSec` / `sttSegmentMinMs` / `sttMaxSegments` replace `sttChunkSec` / `sttMaxFileBytes`; (8) ledger usage kinds + `insights`, `stt`, `chat_summary`; (9) ADR 0042 was missing from the ADR index (added). **Fix:** the seeded promise call flaked under full-suite load (`fix(seed)`: 10 ms real time per fake step).

- 2026-10-27 (T14.7 implementation): record exports share the existing contacts queue and export-job pipeline; scheduled digests use the hourly `reports-email` maintenance job and the existing deduplicated email queue. Unsubscribe uses POST (including RFC 8058 form posts) with an explicit web-page click so link scanners cannot stop subscriptions. Download authorization re-checks full-phone permission; subscription slots enforce the five-item limit under concurrency; enqueue failures leave a period due for retry; exports reject impossible/reversed dates and fail explicitly when the row cap is exceeded. These queue / unsubscribe route choices follow existing application patterns instead of adding a second scheduler API. No new environment variables.
- 2026-10-27 (T14.8): per-account retention — `account.retention` / `account.retentionCap` (null = platform default), `GET / PUT /account/retention`, `PUT /admin/accounts/:id/retention-cap`, `RETENTION_OUT_OF_BOUNDS` (90 codes), audit `account.retention_updated` / `account.retention_cap_updated` (138 actions — one more than planned because T14.7 added `report.exported`). `calls-purge` and `inbox-retention` run per account first, then at the platform default, in batches of 1 000; a recording-only purge sets `recording.deletedAt` and keeps the call, transcript and insights. Rollup retention stays in `analytics-reconcile` (25 months). Backend 3 320 tests, coverage 96.18 / 87.68 / 95.92 / 97.69.
- 2026-10-27 (P14-B2-DONE): Batch 2 complete — T14.5 call / inbox insights UI, T14.6 reports pages + dashboard KPIs, T14.7 exports + report e-mails (with Codex hardening: delivery re-check, per-person slots, retryable enqueue), T14.8 per-account retention. Backend 3320 tests (96.18 / 87.68 / 95.92 / 97.69), frontend 1386 (96.21 / 92.12 / 93.82 / 96.96); Playwright 151 / 151 twice on port 3150 (32.0 / 29.1 min); backend log grep 0 (e-mails only masked or SMTP message ids). Full-suite runs use `--maxWorkers=2`: with the default worker count the shared in-memory MongoDB fell over twice under load. Observed in run 2 (not a failure, Phase 12 code): two `whatsapp call: settle failed` lines (hold already released without a charge — the engine answers 409 and nothing is charged twice). `gitleaks` is not installed on this machine; the branch diff was scanned for keys / URIs instead (0).
