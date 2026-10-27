# P14 RUN — Records, Transcripts & Analytics (T14.1 → T14.10) — One-Paste Autonomous Run Prompt

> **HOW TO RUN — ek hi paste, poora phase. Beech mein kahin nahi rukna.**
>
> Ye prompt Phase 3–13 se alag hai: wahan har batch ke baad owner agla batch paste karta tha. **Phase 14 mein ek paste = STEP 0 → Batch 1 → Batch 2 → Batch 3 → sign-off.** Checkpoint (`P14-B1-DONE`, `P14-B2-DONE`) pe sirf commit + chhota progress note likhna hai aur **usi turn mein agla task shuru karna hai** — owner ka wait nahi, "continue?" nahi, report ke baad ruk jaana nahi.
>
> **Paste this (working directory `/Users/lalitbansal/Documents/cell-ai-voicebot`):**
>
> `cell-ai-voicebot-backend/docs/prompts/PHASE_14_PROMPT.md padho aur STEP 0 se P14-B3-DONE tak POORA Phase 14 (teeno batches) step by step autonomously implement karo. Kahin bhi mat ruko: na batch ke baad, na checkpoint pe, na kisi question ke liye — saare decisions is prompt + PHASE_14_PLAN.md me pre-made hain (owner defaults §1). Har task ke baad verify (har command alag) + commit (tag [P14-T14.x]). Checkpoint pe commit karke turant agla task. Koi push / merge NAHI. Context compact ho jaye to §3 RESUME SAFETY se wahin se aage chalo. Sirf P14-B3-DONE ke baad final report (Hinglish) do.`
>
> **Claude Code "auto / accept edits" mode me chalao.** **Docker Desktop chalu** (`open -a Docker`). **Mac charger par, lid khuli** — lambi runs `caffeinate -dims` ke saath. Is machine par doosre project ke ~12 Supabase containers chalte hain (load 7–20): flaky / timeout aaye to pehle `uptime`, phir rerun; doosre containers **kabhi mat chhoona**.

---

## 0. CONTEXT (verified facts on 27 Oct 2026 — dobara derive mat karna)

**Branches:** `main` = backend `1d9f67e` (Phase 13 Batch 1 + Atlas staging), frontend `db6bb4e`. Backend branch **`feature/phase-14-records-analytics`** exists with `3bddef6 docs: add phase 14 detailed plan [P14-PLAN]`; the plan has one more uncommitted edit (transcription toggle) and this prompt is uncommitted. Frontend branch is created at the first frontend task: `git switch -c feature/phase-14-records-analytics main`. **Never commit to `main`.**

**Phase 13 is open in parallel** (server waits on the provider). Its remaining work is ops / docs on `feature/phase-13-staging-app-review`. If `main` moves during this run (`git fetch` shows new commits), **merge `main` into the Phase 14 branch at the next checkpoint** (`git merge --no-ff main`, resolve, full verify) — never rebase.

**Numbers at start:** backend **3198 tests / 299 files**, gate **95 / 85 / 95 / 95** (`vitest.config.mts`); frontend **1329 tests / 112 files + 151 Playwright tests / 48 files**, gate **95 / 90 / 90 / 95** (`vite.config.ts`). New frontend files need **branch-complete tests**. Catalogue counts (`tests/calls-wa/catalogue.test.ts`): error codes **83**, audit actions **127**, notification types **31**, `MESSAGE_TYPES` **17**. Migrations `0001` … `0014`. Queues `system`, `email`, `maintenance`, `contacts`, `billing`, `ai`, `campaigns`, `whatsapp`. Frontend nav `LIVE_PHASE = 11` (`src/layout/nav-config.ts`; items with `phase > LIVE_PHASE` are hidden — Reports is `phase: 14`).

**Pehle padho (STEP 0 and after every context compaction):**

- [PHASE_14_PLAN.md](../phases/PHASE_14_PLAN.md) — **source of truth**: goal + Done-when §0, reuse table §1a, metric glossary §1b, rollups §1c, insights §1d, UI §1e, exports §1f, email §1g, retention §1h, API §1i, tasks §3, owner questions §7.
- [BUILD_PLAN_V2.md](../plans/BUILD_PLAN_V2.md) Phase 14 section; [PHASE_12_SIGNOFF.md](../phases/PHASE_12_SIGNOFF.md) §5 deviations (human-transcription toggle stored, not wired).
- ADRs 0016 (money), 0030 (email), 0032 (wallet), 0033 (AI), 0035 (voice runtime), 0038 (inbox), 0041 (WhatsApp calling).
- Conventions: [api.md](../conventions/api.md), [security.md](../conventions/security.md), [data.md](../conventions/data.md), [data-model.md](../conventions/data-model.md), [error-codes.md](../conventions/error-codes.md), [audit.md](../conventions/audit.md), [websocket.md](../conventions/websocket.md), [definition-of-done.md](../conventions/definition-of-done.md); [src/README.md](../../src/README.md).

**What exists (use it, don't rebuild)** — plan §1a, plus these exact entry points:

| Area             | Use                                                                                                                                                                                                                                                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Calls            | `call.model.ts` (`disposition`, `outcome`, `timestamps.answeredAt/endedAt`, `durationSec`, `isTest`, `source`, `campaignId`, `whatsapp`, `recording`, `cost`); `session.ts` `CallSession` + `onEnded(summary)`; `calls.routes.ts` list (`ListCallsQuery`) / detail / transcript / events / recording; `maintenance.ts` `purgeCalls(storage, retentionDays)` |
| Transcripts      | `transcript-turn.model.ts` (`speaker customer/bot/agent`, `source tts/ai/stt/dtmf/audio/system`, `startMs/endMs`); stereo WAV `recording.ts` (customer left, bot / agent right)                                                                                                                                                                             |
| WhatsApp calling | `modules/whatsapp-calling/*`; account `settings.whatsappCalling.transcribeHumanCalls` (default `false`, stored, **unused**)                                                                                                                                                                                                                                 |
| Inbox            | `message.model.ts` (`origin`, `status` + history, `template`, `billing`, `sentBy`), `conversation.model.ts` (`assignedTo`, `lastInboundAt`, `closedAt`), `status.service.ts`, `retention.job.ts` (`INBOX_RETENTION_DAYS`)                                                                                                                                   |
| Stats today      | `flow-node-stats.model.ts`, `agent-usage.model.ts` (day `YYYY-MM-DD` in account TZ — copy that day helper), template counters in `whatsapp-template.model.ts`                                                                                                                                                                                               |
| Exports          | `export-job.model.ts` (`EXPORT_KINDS = ['contacts', 'campaign_results']`), `modules/contact-exports/*`, `modules/campaigns/export.ts` (`csv-stringify`, `write-excel-file/node`)                                                                                                                                                                            |
| AI + money       | `core/ai/types.ts` `AiProvider.chat(ChatRequest)` (no structured output yet), `openai.provider.ts`, `fake.provider.ts`, `pricing.ts`, `budget.ts`, `redact.ts`; `core/billing/engine.ts` `chargeUsage({ type: 'ai_charge', … })`; env `OPENAI_TEXT_MODEL`, `OPENAI_TRANSCRIBE_MODEL` (`gpt-4o-mini-transcribe`)                                             |
| Email            | `core/email/*` + `templates/*` (layout, escape, snapshot tests), Mailpit in dev                                                                                                                                                                                                                                                                             |
| RBAC             | `reports.read` (owner, admin, manager, viewer), `reports.export` (owner, admin, manager), `calls.export`, `calls.listen` — defined, unused                                                                                                                                                                                                                  |
| Frontend         | `@mui/x-charts` 9.15 (`features/wallet/UsageChart.tsx`), `pages/DashboardPage.tsx` (lazy cards), `features/calls/detail/*`, `features/inbox/*`, export dialog + jobs list (contacts), `renderWithProviders`, `fakeRealtime`                                                                                                                                 |
| E2E              | `e2e/helpers.ts`, `e2e/calls.ts`, `e2e/calls-wa.ts`, `e2e/inbox.ts` (`InboxApi`), `e2e/campaigns.ts`; `E2E_FRONTEND_PORT=3150`                                                                                                                                                                                                                              |

**Bugs to avoid** (typical analytics / AI mistakes): counting a call twice when Meta's late duration arrives; counting by UTC day instead of account day; averaging averages across days; percentages with zero denominators (show "—", never NaN / Infinity); including test calls by default; trusting template lifetime counters for date ranges; money from per-call cost fields instead of the ledger; logging summaries / transcripts / prompts; letting AI output override a flow / agent / user disposition; charging twice on a job retry; purging raw data and silently changing historical totals.

---

## 1. LOCKED DECISIONS (exact literals — the plan has the prose)

**Owner defaults (plan §7) are in force** — the owner chose "never wait". Record "Defaults in use for §7 #1–#16 (#1 = Phase 12 decision #10)" in the plan changelog at STEP 0. If a default turns out impossible, pick the closest safe option, write it as a deviation (plan changelog + final report) and continue.

**Module layout (backend):**

- `src/modules/analytics/` — `definitions.ts` (pure: `accountDay`, `callContribution`, `messageContribution`, `ledgerContribution`, metric keys), `writer.ts` (`applyContribution`), `rebuild.ts` (`rebuildRange`, `compareRange`), `jobs.ts` (enqueue helpers + job names), `reconcile.job.ts`.
- `src/modules/reports/` — `reports.schema.ts`, `filters.ts`, `cache.ts`, `overview.service.ts`, `calls.service.ts`, `whatsapp.service.ts`, `templates.service.ts`, `campaigns.service.ts`, `flows.service.ts`, `team.service.ts`, `reports.routes.ts`, `reports.openapi.ts`.
- `src/modules/insights/` — `insights.schema.ts` (zod output schema), `insights.service.ts`, `insights.job.ts`, `stt.job.ts`, `chat-summary.service.ts`, `dispositions.ts`, `insights.routes.ts`, `insights.openapi.ts`; prompts in `src/core/ai/prompts/insights.ts` + `chat-summary.ts` (versioned constants `INSIGHTS_PROMPT_VERSION = 1`).
- `src/modules/report-subscriptions/` — model service, routes, `scheduler.job.ts`, email template `src/core/email/templates/report.ts`.
- Retention: `src/modules/account/retention.service.ts` + routes in the account module; purge jobs extend `calls/maintenance.ts` and `inbox/retention.job.ts`.
- Ops: `src/ops/analytics-rebuild.ts` (`npm run analytics:rebuild`, added to the Dockerfile's ops script list and `check-image.sh`).

**Models / collections (all registered in `src/db/models/all.ts`):** `stats-daily.model.ts` → `stats_daily`; `call-insight.model.ts` → `call_insights`; `conversation-summary.model.ts` → `conversation_summaries`; `report-subscription.model.ts` → `report_subscriptions`.

**New fields:**

- Call: `dispositionSource: 'flow' | 'agent' | 'user' | 'ai' | null`; `insights: { status: 'pending' | 'done' | 'skipped' | 'failed'; reason: string | null; version: number; sentiment: 'positive' | 'neutral' | 'negative' | null; hasPromise: boolean; hasSummary: boolean } | null` (denormalized for list filters); `recording.deletedAt: Date | null`; `analytics: { v: number; counted: object } | null`.
- Message + ledger entry: `analytics: { v, counted } | null`.
- Account: `settings.insights: { enabled: true, chatSummaryOnClose: false }`; `settings.dispositions: { key, label, active }[]` (defaults below); `retention: { recordingsDays: number | null, callsDays: number | null, inboxDays: number | null }`; `retentionCap: { callsDays: number | null, inboxDays: number | null }` (superadmin).

**Default dispositions (keys stable, labels editable):** `promise_to_pay` "Promise to pay", `paid` "Paid", `callback` "Callback requested", `dispute` "Dispute", `not_interested` "Not interested", `wrong_number` "Wrong number", `language_barrier` "Language barrier", `other` "Other". Existing flow / agent disposition strings that aren't keys stay as they are (shown as free text; reports bucket them under their own value).

**Limits (`src/config/limits.ts`, exact):**

```ts
export const REPORT_LIMITS = {
  maxRangeDays: 366,
  cacheTtlSec: 60,
  tableMaxRows: 500,
  exportMaxRows: 200_000,
  rollupRetentionMonths: 25,
  reconcileDays: 3,
  subscriptionsPerUser: 5,
  slowReportMs: 1_500,
} as const;

export const INSIGHTS_LIMITS = {
  minCustomerTurns: 2,
  maxTranscriptChars: 24_000,
  summaryMaxChars: 600,
  maxOutputTokens: 800,
  retries: 1,
  chatMaxMessages: 200,
  sttChunkSec: 600,
  sttMaxFileBytes: 25 * 1024 * 1024,
} as const;

export const RETENTION_LIMITS = {
  callsMinDays: 7,
  inboxMinDays: 30,
  recordingsMinDays: 1,
} as const;
```

**Jobs (names / ids — ids never contain `:`):** queue `maintenance`: `analytics.apply` (id `analytics-<kind>-<id>-<n>`, delay 2 000 ms), `analytics.reconcile` (repeatable `30 2 * * *` UTC, id `analytics-reconcile`); queue `ai`: `insights.run` (id `insights-<callId>-v<version>`), `insights.stt` (id `stt-<callId>`), `insights.chat_summary` (id `chat-summary-<summaryId>`); queue `email`: `reports.send_due` (repeatable `5 * * * *`, id `reports-send-due` — sends subscriptions whose account-local hour = `hour` and period is due), `reports.send` (id `report-<subscriptionId>-<periodKey>`); queue `maintenance`: purge jobs become per-account loops inside the existing jobs (same names).

**Ledger idempotency keys:** `insights-<callId>-v<version>`, `stt-<callId>`, `chat-summary-<summaryId>` (type `ai_charge`, ref `{ type: 'call' | 'usage', id }`, usage kind per existing `LEDGER_USAGE_KINDS` — add `insights` / `stt` only if the enum requires a new kind, with the catalogue test updated).

**Routes (all under `/api/v1`, zod + OpenAPI + tenant scope):**

| Method + path                                                                                       | Permission                                                                 |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `GET /reports/overview` … `/calls` `/whatsapp` `/templates` `/campaigns` `/flows` `/agents` `/team` | `reports.read`                                                             |
| `GET /calls/:id/insights`                                                                           | `calls.read`                                                               |
| `POST /calls/:id/insights/regenerate`                                                               | `calls.listen`                                                             |
| `PATCH /calls/:id/disposition`                                                                      | `calls.trigger`                                                            |
| `GET` / `POST /inbox/conversations/:id/summary`                                                     | `inbox.read` / `inbox.reply`                                               |
| `GET` / `PUT /account/insights-settings`                                                            | `account.read` / `account.update`                                          |
| `GET` / `PUT /account/dispositions`                                                                 | `account.read` / `account.update`                                          |
| `GET` / `PUT /account/retention`                                                                    | `account.read` / `account.update`                                          |
| `PUT /admin/accounts/:id/retention-cap`                                                             | `platform.accounts.manage`                                                 |
| `GET` / `POST` / `PATCH` / `DELETE /report-subscriptions[/:id]` (own only)                          | `reports.read`                                                             |
| `GET /public/report-unsubscribe?token=` (no auth, rate-limited)                                     | —                                                                          |
| Export kinds `calls` / `messages` / `report` via the existing export routes                         | `calls.export` / `reports.export` (+ `contacts.export` for `includePhone`) |

**Error codes (+7 → 90):** `REPORT_RANGE_INVALID` 422, `INSIGHTS_NOT_AVAILABLE` 409, `INSIGHTS_DISABLED` 409, `DISPOSITION_UNKNOWN` 422, `RETENTION_OUT_OF_BOUNDS` 422, `REPORT_SUBSCRIPTION_LIMIT` 422, `CHAT_SUMMARY_EMPTY` 409.

**Audit actions (+10 → 137):** `call.disposition_updated`, `call.insights_regenerated`, `conversation.summary_created`, `account.insights_updated`, `account.dispositions_updated`, `account.retention_updated`, `account.retention_cap_updated`, `report_subscription.created`, `report_subscription.updated`, `report_subscription.deleted`. Details never contain summary text, transcript text or phone numbers.

**Notification types:** none new — reuse the existing export-ready notification (if it is kind-specific, extend it to the new kinds and update the count test). **Realtime events:** `call.insights` (call topic, `{ callId, status, version }`), `conversation.summary` (conversation topic, `{ conversationId, summaryId }`) — ids only.

**Insights output schema (zod, exact keys):** `{ summary: string ≤ 600, suggestedDisposition: <account key> | null, sentiment: { label: 'positive' | 'neutral' | 'negative', score: -1…1 }, keyInfo: { promiseDate: 'YYYY-MM-DD' | null, promiseAmountMicros: int ≥ 0 | null, callbackAt: ISO datetime | null, disputeReason: string ≤ 200 | null, wrongNumber: boolean, languagePreference: string ≤ 20 | null, notes: string ≤ 300 | null }, confidence: { disposition, promise, sentiment: 0…1 } }`. OpenAI request: `response_format: { type: 'json_schema', json_schema: { name: 'call_insights', strict: true, schema } }`, temperature 0.2 (tenths `2`), `maxOutputTokens: INSIGHTS_LIMITS.maxOutputTokens`. Amounts asked from the model in rupees, converted to micros in code (never trust the model with micros).

**Env:** **none new.** (Retention stays bounded by `CALL_RETENTION_DAYS` / `INBOX_RETENTION_DAYS` as platform maximums.) If one turns out necessary: `env.ts` + `.env.example` + README table + env-docs test, and a deviation note.

**Frontend:**

- `features/reports/*` (`ReportsPage`, `FilterBar` (URL state), `KpiTile`, `TrendChart`, `OutcomeChart`, `FunnelChart`, `SentimentChart`, `ReportTable`, `tabs/*`), route `/reports/:tab?` (default `overview`), lazy chunk.
- Reports visible: change Reports item to `phase: 11` (stays under `LIVE_PHASE`) **or** raise `LIVE_PHASE` to 14 only if no other hidden item has `phase` 12–14 — check `nav-config.ts` and the layout tests; Integrations (`phase: 15`) must stay hidden.
- Dashboard KPI row `features/reports/DashboardKpis.tsx` (needs `reports.read`).
- Call detail `features/calls/detail/InsightsCard.tsx`, `DispositionEditor.tsx`; calls list filters; inbox `features/inbox/summary/*`; settings pages `features/settings/InsightsSettings.tsx`, `DispositionsSettings.tsx`, `RetentionSettings.tsx`, `EmailReportsSettings.tsx`; public page `pages/ReportUnsubscribePage.tsx`.
- Bundle budget: reports chunk ≤ 120 KB gzip; main bundle growth ≤ 2 KB gzip (record in the checkpoint notes).

---

## 2. RULES OF ENGAGEMENT

1. **NEVER STOP, NEVER WAIT, NEVER ASK.** No questions, no permission requests, no "shall I continue?", no ending a turn with a plan instead of work. Checkpoints are **commits, not pauses**. The only output to the owner before the end is a 2–3 line progress note at each checkpoint, written **while continuing in the same turn**.
2. **Blocked? Unblock yourself.** Unclear spec → plan §1 / §7 default → safest convention-consistent choice → deviation note. A tool / infra problem (Docker down, port busy, flaky test) → fix it within the rules (`open -a Docker`, wait with a Monitor until-loop, rerun once, `uptime`) → if still blocked, **skip only that sub-step**, record it as an open item, continue with everything else, and retry it at the next checkpoint. Something that would need a secret, the real server, a push or a destructive action → don't do it, record it, continue.
3. **Git:** branch `feature/phase-14-records-analytics` in both repos; never on `main`; one commit per task per repo, one repo at a time; hooks must pass (no `--no-verify`, no `--force`); **no push / merge to main / tag**; footer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; message in a scratchpad file + `git commit -F`; no body line starts with `word:`.
4. **Verify after every code task — each command separately, read output + exit code; never chain `git commit` after checks.**
   - Backend: `npm run lint` · `npm run format:check` · `npm run typecheck` · targeted `npx vitest run <changed areas> --maxWorkers=2` · `npm run build` · `npm run openapi:check` (stage `openapi/openapi.json` first). Full `npm run test:coverage -- --maxWorkers=2` at the end of every backend task that touches shared code and at every checkpoint (background, `caffeinate -dims`, wait with a Monitor until-loop — never poll with sleeps).
   - Frontend: `npm run lint` · `npm run format:check` · `npm run typecheck` · `npx tsc -p tsconfig.e2e.json --noEmit` · targeted vitest · `npm run build`; full `npm run test:coverage -- --maxWorkers=2` per frontend task; `npm run e2e` (whole suite) at checkpoints B2 / B3 and after T14.9 — infra up, this project's dev servers stopped, `E2E_FRONTEND_PORT=3150`, run from the frontend folder.
   - Never run two heavy suites at the same time (coverage + Playwright).
5. **Coverage gates stay green; never lower thresholds; never raise test timeouts; no dynamic `import()` in backend tests.**
6. **Secrets / personal data:** never print, log or commit `.env` values, keys, prompts with transcript text, summaries, phone numbers, names or message texts. Tests assert logs (log-capture helper) contain none of them for the new jobs.
7. **No external network in tests.** OpenAI stays faked (fake provider + recorded fixture payloads under `tests/fixtures/openai/`). The real `OPENAI_API_KEY` in `~/.cav-staging/backend.env` is **not** used by this run.
8. **Docker on the Mac:** only `npm run infra:*` (`cav-*`) and one-off `docker run --rm` tools; never touch other containers / volumes. Mongo dev = `cav-mongo` port 27018 (`docker exec cav-mongo mongosh --port 27018`), dev DB `cell_ai_voicebot`, E2E DB `cav_e2e`. **Never connect to the Atlas staging cluster** in this run.
9. **Never kill other projects' processes** (port 3100 is another project; E2E uses 3150). A dev server of this project left running from an earlier session (backend 5100, Vite 3150) may be stopped before E2E and restarted afterwards.
10. **Docs in the same commit** as the code they describe (ADR, conventions, src/README rows, setup guide, METRICS.md).
11. **Real bugs in committed code:** reproduce → regression test proven failing first → separate `fix(<area>)` commit → plan changelog + final report.
12. **Catalogue / count tests** (error codes, audit actions, notification types, permissions snapshot, job names, limits) are updated in the same commit that adds the entries.
13. **Performance:** every new query used by reports is checked with `explain('executionStats')` in a test helper or the perf script — no `COLLSCAN` on `calls`, `messages`, `stats_daily`, `ledger_entries` for an account-scoped report.
14. **Progress notes** (at each checkpoint, then keep going): "P14-B1-DONE ✅ — <tests> backend tests, coverage <x>; next: T14.5" — nothing more.

---

## 3. RESUME SAFETY (after a context compaction or a restart)

1. `git -C cell-ai-voicebot-backend branch --show-current` → `feature/phase-14-records-analytics`; same for the frontend once it exists; `git log --oneline -20` in both.
2. The last `[P14-…]` tag tells the position; `docs/phases/PHASE_14_TASKS.md` ticks must agree (fix the tracker if a tick is missing).
3. Uncommitted work → `git status` + `git diff` → finish that task, verify, commit. Never discard work without reading it.
4. `npm run infra:up` → `npm run db:migrate` (dev) → backend lint + typecheck → targeted tests of the last task → continue with the **next** task. Don't redo committed tasks.
5. Then keep going to `P14-B3-DONE` — a resume is not a reason to stop or report early.

---

## STEP 0 — P14-SETUP (before T14.1)

1. Backend on `feature/phase-14-records-analytics`; `git status` shows only `docs/phases/PHASE_14_PLAN.md` (modified) and `docs/prompts/PHASE_14_PROMPT.md` (untracked). Anything else → read it; if it is someone's unrelated work, leave it unstaged and continue.
2. `git fetch origin` both repos; if `origin/main` moved past `1d9f67e` / `db6bb4e`, merge `main` into the Phase 14 branch (backend now; frontend when its branch is created).
3. Plan changelog line: "Run prompt prepared (one-paste autonomous run, no stops) — literals locked: modules, models, limits, jobs, routes, error codes (+7), audit actions (+10), insights schema; defaults in use for §7 #1–#16 (#1 = Phase 12 decision #10, off)."
4. Commit 1: plan → `docs(plans): lock phase 14 decisions [P14-PLAN]`. Commit 2: this prompt → `docs(prompts): add phase 14 run prompt [P14-PROMPT]`.
5. Baseline: `npm run infra:up`, `npm run db:migrate`, backend + frontend lint / typecheck green (record counts). **Then continue straight into T14.1.**

---

# ═══════════ BATCH 1 — Backend core (T14.1 → T14.4) ═══════════

## T14.1 — Metrics + rollups → `feat(analytics): add daily rollups with a recount check [P14-T14.1]`

1. `docs/analytics/METRICS.md` — plan §1b table + an example per metric + edge cases (canceled before dial, test calls, retries / attempts, WhatsApp late duration, failed-then-delivered, deleted messages, transferred calls, notes / reactions / history imports excluded, refunds).
2. `definitions.ts`: `accountDay(date, tz)` (reuse the flow-node-stats helper; one implementation), contributions → rows `{ day, channel, dims: { kind, id }, counters, hist }`. Counter keys (integers): voice / WhatsApp calls `attempted`, `answered`, `talkSec`, `durationHist` (buckets `[0,15,30,60,120,300,600,1800,∞)` s), `outcome.<key>`, `ptpCount`, `ptpMicros`, `sentiment.<label>`, `testCalls`; messages `sent`, `delivered`, `read`, `failed`, `replied`, `inbound`, `firstResponseHist` (buckets `[0,60,300,900,3600,14400,86400,∞)` s), `templateSent` …; money `spend.<ledgerType>` (micros, refunds negative). Dims written for each entity: `all`, plus `campaign`, `flow`, `agent`, `user` (answeredBy / sentBy), `template`, `number` (channelId) when present.
3. `stats-daily.model.ts`: unique `(accountId, day, channel, dims.kind, dims.id)`; index `(accountId, dims.kind, day)`; no TTL index (retention job removes days older than `rollupRetentionMonths`).
4. `writer.ts` `applyContribution(kind, id)`: load entity + stored `analytics`, compute next contribution, diff, `$inc` rollups + set `analytics` in one `withTransaction` (`src/db/transaction.ts`), optimistic `analytics.v` guard → retry ≤ 3. Idempotent: same input twice → no change.
5. Hooks → enqueue `analytics.apply`: `CallSession.onEnded`, WhatsApp call final + late Meta duration (`whatsapp-calling/billing.ts` / `calls.service.ts` settle path), inbox `status.service.ts` (each status advance) + outbound send + inbound receive, billing engine capture / refund / adjustment of the listed ledger types. Hooks never throw into the caller (enqueue errors logged without ids of people).
6. `rebuild.ts` + `src/ops/analytics-rebuild.ts` (`--account`, `--from`, `--to`, `--dry-run`): recount from raw for the range into memory, compare with `stats_daily`, write (unless dry-run), print counts only. `reconcile.job.ts`: last `reconcileDays` days, every account; differences → `logger.warn` (counts) + platform alert email (existing alert helper used by healthwatch / system mail) — test with the memory email provider.
7. Migration `0015-analytics`: indexes (verify with `explain` in a test: calls by `(accountId, timestamps.endedAt)`, messages by `(accountId, at)` already exist? add only what's missing), backfill every account in batches of 1 000 with a resumable cursor stored in the migration state; sets `analytics` on entities. Down = drop `stats_daily` + unset `analytics`.
8. Tests: unit per edge case; `tests/helpers/analytics.ts` random generator + `countFromRaw()`; property test — 3 timezones (Asia/Kolkata, UTC, America/New_York), timestamps at 23:59:59 / 00:00:00 local, random late events in random order → rollups == countFromRaw == rebuild; idempotency; migration up / down; purge of raw leaves rollups.

## T14.2 — Reports API → `feat(reports): add report endpoints for calls, whatsapp, campaigns and team [P14-T14.2]`

1. `filters.ts`: shared zod schema (`from`, `to` as `YYYY-MM-DD` account-local, `compare=true|false`, `channel`, `channelId`, `campaignId`, `flowId`, `agentId`, `userId`, `includeTest`), range ≤ `maxRangeDays`, `from ≤ to`, previous period = same length right before.
2. Response shape (plan §3 T14.2 #2) — one zod schema `ReportResponse` reused by every tab; ratios computed in the service from counters (never stored), `null` when the denominator is 0.
3. Services: overview (calls + WhatsApp + spend KPIs, two trends), calls (attempted / answered / rate / talk / outcomes / PTP / sentiment / by day / by number), whatsapp (sent → delivered → read → replied funnel, failed, inbound, first response median + p90 from histogram), templates (per template + language rows), campaigns (compare up to 10 selected or top 10 by attempted; cost per reached = spend ÷ answered contacts), flows (funnel from `flow_node_stats` for a chosen flow + version; flow rows), agents (AI agents rows from rollups + `agent_usage`), team (per user: calls answered, talk, chats replied, messages sent, first response).
4. `GET /calls` new filters: `disposition` (csv), `sentiment`, `hasPromise`, `hasSummary`, `answeredBy`, `channelId` — index check; OpenAPI.
5. `cache.ts`: Redis key `reports:<accountId>:<tab>:<sha1(filters)>` TTL `cacheTtlSec`; `ETag` = sha1 of the body; `If-None-Match` → 304. Slow responses (> `slowReportMs`) logged with tab + ms only.
6. Tests: every tab against seeded rollups (exact numbers), compare period, empty account, zero denominators, range errors, tenant isolation (A never sees B — every route), permissions (viewer 200, agent 403), cache hit / ETag 304, OpenAPI check.

## T14.3 — Post-call insights → `feat(insights): add post-call summary, disposition, sentiment and key info [P14-T14.3]`

1. `ChatRequest.responseFormat?: { type: 'json_schema'; name: string; schema: object }`; OpenAI provider maps it (fixture-based test of the request body, no network); invalid JSON / refusal → typed error. Fake provider: deterministic schema-valid output (summary from the first customer turn, `suggestedDisposition` from keywords like "kal", "pay", "galat number" → `promise_to_pay` / `wrong_number`, else `other`; sentiment from simple word lists) — documented in the fake.
2. `call-insight.model.ts` (`accountId`, `callId`, `version`, `status`, `reason`, `output` (schema above), `model`, `promptVersion`, `tokens`, `costMicros`, `ledgerEntryId`, timestamps; unique `(accountId, callId, version)`); call fields + account settings / dispositions; migration **`0016-insights`** (T14.1 owns `0015-analytics`): default dispositions + `settings.insights` on every account, `call.insights: null` / `dispositionSource` backfilled (`flow` when a flow set it, else `null`); down reverses both.
3. `insights.job.ts` (`insights.run`): guards in order → `INSIGHTS_DISABLED` (setting off) / not answered / fewer than `minCustomerTurns` customer turns (`skipped: too_short`) / call purged / wallet can't cover the estimate (`skipped: low_balance`, prepaid only via `canSpend` budget `ai`) → transcript (turn order, `[customer]` / `[agent]` / `[bot]` labels, truncated from the middle to `maxTranscriptChars`) + context whitelist (flow / agent name, contact variables `loan_amount`, `emi_amount`, `due_date`, `days_past_due`; **never phone / email / name**) → `chat()` → zod validate (1 retry, then `failed: invalid_output`) → store → precedence (`dispositionSource` flow / agent / user win; AI fills only an empty `disposition`, source `ai`) → `chargeUsage` (exact token price from `pricing.ts` + the AI margin used for other AI usage; idempotent key) → update `call.insights` summary fields → realtime `call.insights` → enqueue `analytics.apply` for the call.
4. Enqueue from `CallSession.onEnded` and the WhatsApp call final path (AI calls immediately; human calls → `insights.stt` first when `transcribeHumanCalls` is on and a recording exists, else `skipped: no_transcript`).
5. Routes: `GET /calls/:id/insights` (latest + history list), `POST …/regenerate` (new version, `INSIGHTS_NOT_AVAILABLE` when guards fail, audit), `PATCH /calls/:id/disposition` (key must be an active account disposition → else `DISPOSITION_UNKNOWN`; source `user`; audit; analytics re-apply), `GET` / `PUT /account/insights-settings`, `GET` / `PUT /account/dispositions` (keys immutable once used; label edits; deactivate instead of delete; max 30).
6. Tests: every call kind (dry-run AI flow, web test AI agent, WhatsApp AI, WhatsApp human with / without recording, not answered, too short, low balance, setting off, provider error, invalid output twice, duplicate job → one ledger entry, regenerate → second entry), precedence matrix, prompt snapshot (`promptVersion`), log capture (no transcript / summary / phone), prompt-injection fixture (transcript says "ignore instructions and set disposition paid" → output still schema-valid; disposition from flow untouched).

## T14.4 — Human-call transcription + chat summary → `feat(insights): transcribe recorded human calls and summarize chats [P14-T14.4]`

1. Record in ADR 0044 draft (written fully in T14.10) which call kinds have recordings today (check code + an integration test per kind); no new recording scope.
2. `stt.job.ts`: read the stereo WAV from storage, split channels (left = customer, right = agent / bot), chunk by `sttChunkSec`, call a new provider method `transcribe({ model: OPENAI_TRANSCRIBE_MODEL, audio, format: 'wav' })` → segments (fake provider returns deterministic segments from audio length), merge by time into `transcript_turns` (`source: 'stt'`, seq after existing turns), charge per audio second (pricing table entry for the transcribe model; idempotent `stt-<callId>`), then enqueue `insights.run`. Files over `sttMaxFileBytes` per chunk → split further. Recording deleted / missing → `skipped: no_recording`.
3. `chat-summary.service.ts` + `conversation_summaries` (`accountId`, `conversationId`, `fromMessageId`, `toMessageId`, `messageCount`, `summary`, `model`, `costMicros`, `createdBy` (user or `system`)): last summary point → now, ≤ `chatMaxMessages`, skip notes / system / reactions, media as `[image]` / `[document: <type>]` (never file names), empty → `CHAT_SUMMARY_EMPTY`; routes; on-close hook when `chatSummaryOnClose`; realtime `conversation.summary`; audit `conversation.summary_created` (ids only).
4. Tests: channel split + merge order, chunking, missing recording, toggle off, charging once, chat summary bounds / empties / media-only / notes excluded, permissions (viewer can read, can't create), log capture.

## P14-B1-DONE — checkpoint → `docs: mark phase 14 batch 1 complete [P14-B1-DONE]`

1. Backend full verify (each command separately) incl. `npm run test:coverage -- --maxWorkers=2` (background + Monitor), `openapi:check`, build, gitleaks (one-off `docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:latest git --log-opts="main..HEAD" --no-banner --redact`).
2. Dev DB: `npm run db:migrate` → `npm run db:seed` → `npm run analytics:rebuild -- --dry-run` → **0 differences** (record).
3. Tracker ticks T14.1–T14.4, plan changelog (deviations), CHANGELOG `Phase 14 · Batch 1`.
4. If `origin/main` moved → merge `main` now + full verify.
5. Commit, write the 2-line progress note, and **immediately start T14.5 (same turn).**

---

# ═══════════ BATCH 2 — UI + features (T14.5 → T14.8) ═══════════

## T14.5 — Call record + inbox UI → `feat(calls): show call insights, dispositions and chat summaries [P14-T14.5]`

Frontend branch first: `git switch -c feature/phase-14-records-analytics main` (frontend). Then:

1. API clients + query keys + types for insights, disposition, insights settings, dispositions, chat summary; realtime handlers `call.insights` / `conversation.summary` (invalidate queries).
2. `InsightsCard` on the call detail page: summary, disposition chip + "Set by flow / agent / you / AI", sentiment chip, key info rows (each with an "AI" badge + low-confidence hint < 0.6), states pending / skipped (reason in plain words: "Call too short", "Not enough balance", "Turned off in Settings", "No recording to transcribe") / failed (+ Regenerate), Regenerate dialog with "This uses AI credit" note, `DispositionEditor` (active dispositions only); transcript tab shows `stt` turns ("Transcribed from the recording"); recording "Deleted after N days" state.
3. Calls list: columns Outcome / Sentiment / Promise; filters disposition (multi), sentiment, has promise, has summary — URL state; `ContactCallsCard` shows the disposition chip.
4. Inbox: "Summarize" button (needs `inbox.reply`), summary drawer (latest + earlier summaries, time, "AI" badge), on-close summary shown in the conversation info panel.
5. Settings: AI card (insights on / off, chat summary on close, human-call transcription switch = the existing WhatsApp calling field), Dispositions editor (add, rename, deactivate, reorder).
6. Tests (RTL, branch-complete): every state above, permission hiding (agent / viewer), realtime refresh, a11y names; backend contract types from `openapi.json` if the project generates them (follow the existing pattern).

## T14.6 — Reports pages + Dashboard → `feat(reports): add reports pages and dashboard kpis [P14-T14.6]`

1. `ReportsPage` with tabs (Overview, Calls, WhatsApp, Templates, Campaigns, Flows & agents, Team), `FilterBar` (date presets Today / Yesterday / Last 7 / 30 / 90 days / This month / Last month / Custom ≤ 366 days, compare toggle, channel, WhatsApp number, campaign, flow, AI agent, team member, include test calls) — all in the URL; account timezone shown ("Times in Asia/Kolkata").
2. Components: `KpiTile` (value, delta arrow + %, previous value, tooltip = METRICS.md sentence, "—" for null), charts with `@mui/x-charts` + visible table fallback (`<details>` "Show as table"), `ReportTable` (sort, paginate client-side ≤ 500 rows), empty / loading (skeletons) / error (retry) states, "Updated a minute ago".
3. Drill-down: clicking a KPI / outcome / row navigates to Calls / Inbox / Campaign / Flow with matching filters.
4. Nav: make Reports visible (rule in §1 Frontend), route `/reports/:tab?`, lazy chunk; `DashboardKpis` row on the Dashboard (calls today, answer rate, PTPs today, messages sent, read %, spend today; vs yesterday) + "View reports" link — hidden without `reports.read`.
5. Tests: each tab renders the API fixture numbers, filter → query string → API params, compare on / off, presets in a non-IST timezone, drill-down URLs, permissions, bundle check (record chunk sizes).

## T14.7 — Exports + scheduled email reports (both repos)

Backend → `feat(reports): export calls, messages and reports, and email scheduled reports [P14-T14.7]`:

1. `EXPORT_KINDS` += `calls`, `messages`, `report`; job streams with a cursor, honours filters (same schemas as list / report routes), `includePhone` (needs `contacts.export`) and `includeSummary` (needs `calls.export`), max `exportMaxRows` (error row count in the job when exceeded), CSV + XLSX, file names `calls-<accountSlug>-<from>-<to>.<ext>` (no personal data).
2. `report_subscriptions` model (`accountId`, `userId`, `frequency`, `tabs`, `hour` 0–23, `active`, `lastSentPeriod`), own-only CRUD (max `subscriptionsPerUser`, `REPORT_SUBSCRIPTION_LIMIT`), `reports.send_due` + `reports.send` jobs (account timezone; daily = yesterday, weekly = last Mon–Sun on Monday, monthly = last month on the 1st; skip if the user is inactive or lost `reports.read`; idempotent per period), email template (KPI table, vs previous, "Open report" link with the filters, footer unsubscribe; snapshot test asserts no phone / name / text), signed unsubscribe token (HMAC with the existing token helper, 90 days) + `List-Unsubscribe` headers, public route rate-limited.
3. Tests: kinds × permissions, caps, file contents (no text column in messages), scheduling across timezones + month ends, idempotent sends (Mailpit / memory provider), unsubscribe (valid / expired / tampered).

Frontend → `feat(reports): add export buttons and email report settings [P14-T14.7]`:

4. Export buttons on the Calls list and every report tab (existing export dialog: format, include phone / summaries with permission-aware switches), export jobs list shows the new kinds; Settings → Notifications → Email reports (list, add, edit, pause, delete); `ReportUnsubscribePage` (public).
5. Tests: dialog options per permission, subscription form validation, unsubscribe page states.

## T14.8 — Retention (both repos)

Backend → `feat(account): let each account choose how long recordings and chats are kept [P14-T14.8]`:

1. `retention.service.ts`: get / put with bounds (`RETENTION_LIMITS` minimums, maximum = min(env default/max, `retentionCap`)), `recordingsDays ≤ callsDays`, `RETENTION_OUT_OF_BOUNDS`; audit (old → new numbers); superadmin `PUT /admin/accounts/:id/retention-cap` (audit).
2. Purge jobs per account: calls (records, events, transcripts, insights, flow runs) older than `callsDays`; recordings older than `recordingsDays` (delete file, keep the call, set `recording.deletedAt`); inbox messages + media + conversation summaries older than `inboxDays`; `stats_daily` older than `rollupRetentionMonths` (all accounts). Batched (1 000), resumable, counts-only logs. `null` settings = today's platform behaviour (test proves no change for existing accounts).
3. Tests: bounds, shortening takes effect on the next run, other accounts untouched, rollups untouched, recording-only deletion keeps the call + insights.

Frontend → `feat(settings): add the data retention page [P14-T14.8]`:

4. Settings → Data retention (owner / admin): three fields with "platform default (N days)" option, plain-language explanation, confirm dialog when shortening ("Recordings older than N days will be deleted tonight"), superadmin cap field in the admin account page; `src/content/legal/privacy.md` retention sentence (keeps `status: draft`).
5. Tests: validation, confirm flow, permissions, admin cap.

## P14-B2-DONE — checkpoint → `docs: mark phase 14 batch 2 complete [P14-B2-DONE]` (both repos)

1. Both repos full verify (each command separately, coverage both, builds, openapi:check), gitleaks both.
2. **Playwright whole suite twice** (existing 151 must stay green; new specs come in T14.9) — infra up, dev servers stopped, port 3150; second run with `E2E_BACKEND_LOGS=1` + log grep for phones / names / texts / summaries = 0.
3. Bundle numbers (reports chunk, main bundle delta), tracker ticks T14.5–T14.8, CHANGELOGs `Phase 14 · Batch 2`, plan changelog.
4. Merge `main` if it moved (+ verify).
5. Commit, 2-line progress note, **immediately start T14.9.**

---

# ═══════════ BATCH 3 — Quality, docs, sign-off (T14.9 → T14.10) ═══════════

## T14.9 — Seeds, E2E, perf, security → `test: add phase 14 seeds, e2e, performance and security checks [P14-T14.9]` (both repos)

1. Backend `scripts/seed-analytics.ts` (wired into `db:seed`, idempotent): 60 days of demo history for Demo Finance — calls of every kind with insights (fake provider), messages with status sequences, template sends, campaign runs, ledger entries — then `analytics:rebuild`; the `staging:demo` seed gets the same history marked `isTest` with summaries prefixed "Demo:" (no OpenAI calls) and its test updated.
2. Playwright specs (frontend `e2e/reports-*.spec.ts`, `e2e/insights.spec.ts`, helpers in `e2e/reports.ts`): reports tabs + filters + compare + drill-down; a dry-run AI call → insights appear live → change disposition → reports count moves; WhatsApp human call with transcription on → STT turns + insights; chat summary; export calls (download, columns, no phone without permission); retention page (shorten → confirm → purge job run via the test hook → recording deleted state); email report subscription → Mailpit receives it (no PII) → unsubscribe link works; viewer / agent permission views.
3. `scripts/perf-reports.ts` (`npm run perf:reports`, throwaway DB `cav_perf`, dropped at the end): 100 000 calls + 500 000 messages + ledger for one account across 400 days, backfill time, `analytics:rebuild` time, each report tab p50 / p95 over 20 runs (target p95 < 1 500 ms), `explain` = no COLLSCAN. Record numbers in the sign-off.
4. Security tests: tenant isolation for every new route (shared helper loop), permission matrix snapshot, unsubscribe token tampering, export file names, no PII in emails / logs / audit details, injection fixture, rate limit on the public unsubscribe route.
5. Both repos full verify + **Playwright whole suite twice** (with the new specs).

## T14.10 — Gap audit, docs, sign-off → `docs: add phase 14 sign-off and docs [P14-T14.10]` (both repos)

1. Gap audit: walk plan §0 Done-when + §4 checklist + this prompt §4; every gap → fix now (own commit) or an explicit open item with the reason.
2. Docs: `docs/analytics/METRICS.md` final; **ADR 0043** "Analytics rollups and recount"; **ADR 0044** "Post-call AI insights and transcription" (recording matrix, precedence, prompt versioning, costs); `docs/setup/openai.md` (cost per insight / per STT minute with the fake-free formula, budgets); runbook `docs/ops/staging.md` (`analytics:rebuild`, reconcile alert, retention changes); conventions (api.md report section, data-model.md new collections, error-codes.md, audit.md); `src/README.md` rows; both READMEs (scripts, features); both CHANGELOGs; BUILD_PLAN_V2 changelog ("Phase 14 done … Next: Phase 15").
3. `docs/phases/PHASE_14_SIGNOFF.md` (Phase 12 / 13 sign-off format): scope delivered, test counts + coverage (both), Playwright runs (2 × green, counts), perf numbers, reconcile result, bundle numbers, deviations (§5), bugs found + fixed (§6), open items + who owns them (§8: staging check of real OpenAI insights when Phase 13 staging is live; owner answers to §7 if they differ from defaults).
4. Staging: only if Phase 13 staging is live **and** this branch is deployable there without pushing (it isn't — no push in this run) → record "staging check pending Phase 13 + merge" as an open item. Do not connect to any server.
5. Tracker all ticked; plan changelog final line.

## P14-B3-DONE — checkpoint → `docs: mark phase 14 complete [P14-B3-DONE]` (both repos)

1. Final full verify both repos (each command separately), gitleaks both, `npm run e2e` once more (green), `git status` clean in both, `git log --oneline main..HEAD` listed.
2. **Final report (Hinglish, the only full report of the run):** what was built (per task, 1 line each), numbers (tests before → after, coverage, Playwright, perf, bundle), commits per repo (short sha + subject), deviations, bugs fixed, open items (incl. "push / merge to main is the owner's call"), and how to see it locally (`npm run dev` both → http://localhost:3150/reports; demo login via Forgot password + Mailpit).

---

## 4. FINAL CHECKLIST

**Step 0**

- [x] `[P14-PLAN]` lock (defaults + literals) and `[P14-PROMPT]`; baseline green

**Batch 1**

- [x] T14.1 METRICS.md, definitions, `stats_daily`, writer + hooks, rebuild CLI, reconcile job, migration 0015, property tests (3 timezones)
- [x] T14.2 7 report endpoints, filters, cache + ETag, call-list filters, OpenAPI, isolation + permission tests
- [x] T14.3 structured output (provider + fake), insights job + model + precedence + charging, routes, settings, dispositions, injection + log tests
- [x] T14.4 stereo STT pipeline, chat summary, tests
- [x] P14-B1-DONE (verify, rebuild = 0 differences) → continued without stopping

**Batch 2**

- [x] T14.5 insights card, disposition editor, list filters, inbox summary, settings
- [x] T14.6 reports pages (7 tabs), filter bar, charts + tables, drill-down, dashboard KPIs, nav visible
- [x] T14.7 exports (calls, messages, report), email subscriptions + scheduler + unsubscribe (both repos)
- [x] T14.8 retention settings + purge jobs + admin cap + privacy sentence (both repos)
- [x] P14-B2-DONE (verify both, Playwright twice + log grep, bundle) → continued without stopping

**Batch 3**

- [x] T14.9 seeds, Playwright specs, perf numbers, security tests, Playwright twice
- [x] T14.10 gap audit, METRICS.md, ADR 0043 / 0044, setup + runbook + conventions + READMEs + CHANGELOGs + BUILD_PLAN_V2, sign-off
- [x] P14-B3-DONE (final verify, clean trees, final Hinglish report)
