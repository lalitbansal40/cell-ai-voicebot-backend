# P11 RUN — WhatsApp Templates + WhatsApp Billing (T11.1 → T11.12) — Autonomous Run Prompt

> **HOW TO RUN — 3 batches, one at a time (same as Phases 3–10). Har batch ke baad report padho, phir agla paste karo.**
>
> **Batch 1 (foundation: models + catalogue + migration 0012, Meta template / upload / pricing-analytics calls + fake review and pricing knobs, template service + 4 template webhooks + backfill + user preferences + call permission template, WhatsApp billing engine + rate card + markup + reaper):**
> `cell-ai-voicebot-backend/docs/prompts/PHASE_11_PROMPT.md padho aur STEP 0 + BATCH 1 (P11-SETUP se P11-B1-DONE tak) SAARE tasks step by step autonomously implement karo. Bich me koi question mat poochho, permission mat maango — saare decisions is prompt + PHASE_11_PLAN.md me pre-made hain. Har task ke baad verify (har command alag) + commit (tag [P11-T11.x]). Koi push / merge NAHI. Ant me P11-B1-DONE checkpoint + final report (Hinglish).`
>
> **Batch 2 (template send + service-reply billing + price preview, API + OpenAPI + superadmin rates / markup / margin / reconciliation, simulator kinds + seed + dev script, hardening + ADR 0039 + docs + real-WABA checklist):**
> `cell-ai-voicebot-backend/docs/prompts/PHASE_11_PROMPT.md padho aur BATCH 2 (T11.5 se P11-B2-DONE tak) SAARE tasks step by step autonomously implement karo. Bich me koi question mat poochho, permission mat maango. Har task ke baad verify + commit (tag [P11-T11.x]). Koi push / merge NAHI. Ant me P11-B2-DONE checkpoint + final report.`
>
> **Batch 3 (frontend foundation + Templates tab + builder + Send template + wallet / superadmin billing UI + E2E + sign-off):**
> `cell-ai-voicebot-backend/docs/prompts/PHASE_11_PROMPT.md padho aur BATCH 3 (T11.7 se P11-B3-DONE tak) SAARE tasks step by step autonomously implement karo. Bich me koi question mat poochho, permission mat maango. Har task ke baad verify + commit (tag [P11-T11.x]). Koi push / merge NAHI. Ant me P11-B3-DONE checkpoint + Phase 11 sign-off + final report.`
>
> **Claude Code "accept edits" mode me chalao.** Working directory: `/Users/lalitbansal/Documents/cell-ai-voicebot`. **Docker Desktop chalu hona chahiye** (`open -a Docker`). **Mac charger par aur lid khuli** — lambi test runs `caffeinate -dims` ke saath (machine sleep hone par tests 100–900 s atakte dikhte hain — ye code ka bug nahi, rerun karo).

---

## 0. CONTEXT (verified facts on 23 Oct 2026 — dobara derive mat karna)

**Phase 10 done, signed off and merged by the project lead:** `main` = Phase 10 tip in both repos — backend `ff81947 [P10-B3-DONE]`, frontend `08faa35 [P10-T10.12]`. **The backend branch `feature/phase-11-templates-billing` already exists** (created from `main` by the planning session) with commit `b7dfd37 docs(plans): add phase 11 detailed plan [P11-PLAN]`; the planning session then edited the plan (§7 answers locked + job names) and wrote this prompt — **uncommitted** on that branch. The **frontend** branch is created at T11.7 (`git switch -c feature/phase-11-templates-billing main`). **Never commit to `main`.**

**Numbers at start:** backend **2712 tests**, gate **95 / 85 / 95 / 95** (`vitest.config.mts`; measured 97.09 / 89.54 / 96.64 / 98.22); frontend **1048 tests + 103 Playwright tests**, gate **95 / 90 / 90 / 95** (`vite.config.ts`; measured 96.81 / 92.61 / 94.59 / 97.39). New frontend files still need **branch-complete tests** (Phase 10 rule kept: every `if`, `??`, ternary, optional chain, early return, error branch). Catalogues with docs-sync tests: error codes **59**, audit actions **106**, notification types **19**, `MESSAGE_TYPES` **15**; migrations `0001` … `0011`; queues `system`, `email`, `maintenance`, `contacts`, `billing`, `ai`, `campaigns`, `whatsapp`; simulator kinds **44** (16 Phase 9 + 28 new inbox kinds; the inbox list has 29 incl. `inbound_text`); topic kinds `call`, `campaign`, `conversation`; nav `LIVE_PHASE = 10`.

**Pehle padho (har batch se pehle):**

- [PHASE_11_PLAN.md](../phases/PHASE_11_PLAN.md) — **source of truth**: scope §0, locked decisions §1a–§1q, tasks §3, §7 all 14 answers locked on 23 Oct 2026.
- [BUILD_PLAN_V2.md](../plans/BUILD_PLAN_V2.md) — its Phase 11 section.
- [PHASE_10_SIGNOFF.md](../phases/PHASE_10_SIGNOFF.md) — §5 (deviations), §6 (bugs + lessons), §8 (Phase 11 TODOs).
- ADRs: [ADR 0016](../adr/README.md) (money in integer micros), [ADR 0037](../adr/0037-whatsapp-channels-meta.md), [ADR 0038](../adr/0038-whatsapp-inbox.md).
- [src/README.md](../../src/README.md).
- Conventions:
  - [api.md](../conventions/api.md) (§14d inbox exists — **add §14e templates + WhatsApp billing**);
  - [security.md](../conventions/security.md), [secrets.md](../conventions/secrets.md), [data.md](../conventions/data.md);
  - [data-model.md](../conventions/data-model.md) (§2.8 Inbox exists — **add §2.9**);
  - [websocket.md](../conventions/websocket.md), [error-codes.md](../conventions/error-codes.md), [audit.md](../conventions/audit.md), [definition-of-done.md](../conventions/definition-of-done.md).
- [docs/setup/meta-whatsapp.md](../setup/meta-whatsapp.md) (§1–§13; T11.6 adds §14 real-WABA checklist + template permissions + `META_APP_ID` + INR credit line).

**What exists (use it, don't rebuild):**

| Area                                                                             | Provides                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Billing engine                                                                   | `src/core/billing/engine.ts` — `credit`, `holdForCall` (budget `call`, may use the credit limit), `extendHold`, `settleCall`, `releaseHold` (`loadHold` **accepts only `type: 'call_charge'` roots**), `chargeUsage` (budget `ai`, prepaid only), `adjust`; internals `run` (transaction), `raceSafe` + `findByKey` + `replay` (idempotency by `idempotencyKey` per account), `moneyPipeline(month, { balance?, hold?, ai?, tts?, … })`, `canSpend(amount, { useCreditLimit, budget, month })`, `insufficient(…)`, `change(…)` + `finish` (wallet events). `pricing.ts` (`callCharge`, `holdEstimate`, `estimateCampaign`), `rates.ts` (`effectiveRateCard` + cache, `rateCardById`, `createRateCardVersion`, `rateCardHistory`), `wallets.ts`, `events.ts` (`walletStatus`, `crossings`, `emitWalletUpdated`, `publishWalletChange`), `alerts.ts` (low balance / exhausted bell + email), `jobs.ts` (`BILLING_JOB_NAMES`, `BILLING_SCHEDULES` UTC crons: `billing.reap_holds` `*/5`, `billing.reconcile` `0 21`, …), **`reaper.ts` `reapStaleHolds` — releases EVERY `held` ledger row older than `BILLING_LIMITS.staleHoldMs` (2 h) regardless of type** |
| Money helpers                                                                    | `src/shared/money.ts` — `MONEY_SCALE`, `PAISA_MICROS = 10_000`, `BPS_SCALE`, `assertMicros`, `isMicros`, `ceilDiv`, `roundDiv`, `mulBps`, `roundToPaise`, `rupeesToMicros`, `formatRupees`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Ledger / wallet models                                                           | `ledger-entry.model.ts` (`LEDGER_TYPES`, `LEDGER_STATUSES held/captured/released`, `LEDGER_REF_TYPES`, `LedgerBreakdown`, `LEDGER_USAGE_KINDS`, `idempotencyKey`, `holdId`, `rateCardId`), `wallet.model.ts` (`balanceMicros`, `holdMicros`, `creditLimitMicros`, `lowBalanceThresholdMicros`, `budgets { monthlyCallMicros, monthlyAiMicros }`, monthly spend `callMicros / aiMicros / ttsMicros`), `rate-card.model.ts` (calls / AI — **untouched**; WhatsApp prices get their own collection)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Wallet API                                                                       | `src/modules/wallet/*` — `GET /wallet`, `PATCH /wallet/settings` (`WalletSettingsBody`: `lowBalanceThresholdMicros`, `budgets.{monthlyCallMicros, monthlyAiMicros}`; permission **`wallet.topup`**, impersonation blocked), `GET /wallet/rates` (`RateCardViewSchema`), `POST /wallet/estimate`, ledger list / detail / export, usage series; permissions `wallet.read`, `wallet.topup`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Superadmin billing                                                               | `src/modules/admin/admin-billing.routes.ts` under `/api/v1/admin` — `/rate-cards/default` (+ history), `/accounts/:id/rate-cards`, `/accounts/:id/wallet`, `/accounts/:id/ledger`, `/accounts/:id/wallet/adjustments`, `/billing/config`, `/billing/summary`, `/payments`, `/payment-events` (permission `platform.billing.manage`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| WhatsApp admin                                                                   | `src/modules/whatsapp/whatsapp-admin.routes.ts` — `PATCH /admin/accounts/:id/whatsapp-billing` `{ metaPayer }` (`WhatsAppBillingBody`, `setWhatsAppBilling`); account `whatsapp.metaPayer` (`platform` default / `customer`); channel `metaPayer`, `creditLine`, `wabaCurrency`, `wabaId`, `messagingLimitTier`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Meta core                                                                        | `src/core/meta/{types,graph.client,fake.client,errors,schemas,payloads,message-schemas,signature,index}.ts` — `MetaClient`, `MetaApiError`, `mapSendError`, Graph retries + scrubbing, `createMetaClient(env, deps)`, fake state in Redis, `FAKE_INBOX_KNOBS` (`00005`–`00009`), `WEBHOOK_FIELDS` (template status / quality / category already subscribed; **`message_template_components_update` missing**), fixtures `tests/fixtures/meta/*.json` + README; Phase 10 resumable upload already used for the profile photo (`uploadProfilePhoto` → `POST /{v}/{META_APP_ID}/uploads` + `POST /{v}/<upload id>`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Webhook pipeline                                                                 | `webhooks.service.ts`, `webhook-processor.ts`, `webhook-handlers.ts` (`WEBHOOK_HANDLERS`, `LONG_LIVED_FIELDS`, `HandlerContext.inbox` hooks pattern, handlers get the event id), `deferred-events.ts` (`registerDeferredField`, `listDeferred`, `markConsumed`) — template fields + `user_preferences` are stored **deferred** today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Inbox (Phase 10)                                                                 | `src/modules/inbox/*` — `outbound.service.ts` (`sendMessage(ix, actor, conversationId, body)` → `{ message, created }`, idempotent by `clientId`, `isWindowOpen`, `retryMessage`, `buildContent`, `announce`), `outbound.schema.ts` (`SendMessageBody` union of 14 types), `send.job.ts` (`processSend`, order wait, `DelayedError`), `status.service.ts` (`applyStatuses`; **already stores `pricing` `{ billable, model, category, type, conversationId, conversationOrigin }`**, incl. on late duplicates), `conversations.service.ts` (`startConversation`, `messageViews`, `findMessage`), `inbox-json.ts` (`toMessageView`), `optout.service.ts`, `contacts.ts`, `hooks.ts` (`createInboxHooks`), `jobs.ts` (`INBOX_JOBS`, `recordingInboxJobs`), `simulator.ts` + `simulator-kinds.ts`, `events.ts` (`emitMessageCreated` / `emitMessageUpdated` / `emitConversation`)                                                                                                                                                                                                                                                                              |
| Contacts                                                                         | `contact.model.ts` (`consent`, `dnd`, `optedOutAt`, `variables`, `whatsapp {…}`), custom fields (`custom-field.model.ts`, typed `text / number / currency / date / phone`), `formatFieldValue`-like formatting exists only in the frontend → backend formatter is new (T11.5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Queues / realtime / notifications / audit / RBAC / env / limits / OpenAPI / seed | as Phase 10 prompt §0 (`whatsapp.worker.ts` routes inbox jobs; `MAINTENANCE_SCHEDULES`; `notifyAccount`; `NOTIFICATION_TYPES`; `AUDIT_ACTIONS`; `permissions.ts` + `system-roles.ts` + snapshot + `syncSystemRoles()`; `createRateLimiter`; `env.ts` + env-docs test; `INBOX_LIMITS`; `src/openapi.ts` imports; `scripts/db-seed.ts`, `seed-whatsapp.ts`, `seed-inbox.ts`, `dev-inbox.ts` patterns)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Frontend                                                                         | `src/features/whatsapp/*` (Numbers page, `WhatsAppPage` with `Tabs` — **one tab "Numbers"; add "Templates"**), `features/whatsapp/profile.ts`, `src/features/inbox/*` (composer `Templates` button disabled with `TEMPLATES_SOON_TEXT`, `WINDOW_CLOSED_TEXT`, `Composer.tsx` banners, `ChatView`, `MessageBubble`, `ContactChatButton`), `src/features/wallet/*` (`ledger-format.ts` labels, `TransactionsTab`, `UsageTab`, `WalletSettingsDialog`, `OverviewTab`), `src/features/admin-billing/*` (`RateCardDialog`, `AccountRatesTab`, `RateHistoryTable`), `src/pages/admin/*` (`AdminBillingPage`, `AdminAccountDetailPage`, `AdminWhatsAppPage`), fixtures `src/test/{whatsapp,inbox,…}.ts`, `src/test/viewport.ts`, `renderWithProviders`, `fakeRealtime`                                                                                                                                                                                                                                                                                                                                                                                            |
| E2E                                                                              | `e2e/helpers.ts`, `e2e/contacts.ts` (`inviteMember`), `e2e/whatsapp.ts`, **`e2e/inbox.ts`** (`InboxApi.signIn` API session with `simulate` / `createContact` / `conversationOf` / `fakeSent`, `customerPhone(suffix)` valid 10-digit numbers, `connectNumber`, `openInbox`, `openConversation`, `sendText`, `bubble`, `expectTicks`), `playwright.config.ts` (`FAKE_META_STATUS_DELAYS_MS: '200,500,800'`), `vite.config.ts` `optimizeDeps.entries` (lazy screens pre-bundled), `E2E_FRONTEND_PORT=3150`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

**Reference code (READ ONLY — never modify, never copy credentials):**

- AutoChatix backend `/Users/lalitbansal/Documents/Autochatix/AutoChatix-backend/src/` — template model / controller / wallet charge code (search `template`, `wallet`, `charge`).
- Frontend template builder screens.

**Bugs to avoid** (seen there):

- charging on send instead of delivery;
- service-message holds never released;
- templates cached forever without sync;
- variables substituted by string replace without escaping;
- template status overwritten by older webhooks;
- `console.log` of Meta payloads.

---

## 1. LOCKED DECISIONS (exact literals — PHASE_11_PLAN §1 has the prose)

**Owner decisions (23 Oct 2026, plan §7 #1–#14 — all defaults accepted):**

1. Markup **15 %** (`markupBps: 1500`) global, per-account override allowed.
2. **Service replies** charged at the service rate + markup **only when Meta reports billable**.
3. Empty wallet / budget reached → **templates and service replies refused** (internal notes still work).
4. Customer-pays accounts: platform fee **₹0** (no hold at all).
5. STOP-opted-out contacts: **utility / authentication allowed unless DND**; marketing always blocked.
6. Our cap **1 marketing template / contact / 24 h**.
7. `templates.manage` = owner / admin / manager; agents send.
8. **No authentication (OTP) template creation** (synced ones read-only).
9. Prices **rounded up to the next paisa**.
10. Rate card = Meta's **INR** CSV imported by superadmin; seed placeholders: marketing **₹0.8631** (`863_100` micros), utility / authentication / service **₹0.115** (`115_000` micros), markets `IN` (`91`) + `OTHER`.
11. Undelivered holds released after **72 h**; a later billable status charged directly (wallet may go negative).
12. Default template language **`en`**.
13. Marketing consent = **warning only**.
14. Call permission template: **UTILITY**, body _"Kya hum aapko WhatsApp par call kar sakte hain? Aapke loan / account ke baare mein baat karni hai."_ (editable before submit).

**Run-prompt refinements (locked now, recorded in the plan changelog at STEP 0):**

- **Existing call-hold reaper must ignore WhatsApp holds.** `reapStaleHolds` gets the filter `type: 'call_charge'` (today it releases every `held` row older than 2 h and `loadHold` would throw `Hold not found` for a WhatsApp root every 5 min). This is part of T11.4, with a regression test proven failing first, **inside T11.4's commit**: it is a latent bug in Phase 4 code that only matters once a second hold type exists.
- **Separate WhatsApp hold functions** in the engine — never reuse `holdForCall` / `releaseHold`:
  - `holdForWhatsApp`, `captureWhatsApp`, `releaseWhatsApp`, `chargeWhatsAppLate`;
  - their own `loadWhatsAppHold` (root `type: 'whatsapp_charge'`, `holdId: null`);
  - budget kind **`whatsapp`** (new `canSpend` budget + `moneyPipeline` key `whatsapp`).
- **Price fixed at send:**
  - `message.billing.priceMicros` is the hold amount and the capture amount;
  - a category mismatch (Meta billed another category) **still captures the held price** and records `billing.metaCategory` + `billing.categoryMismatch = true` for the margin report;
  - customers are never re-priced after send.
  - (Plan §1g wording "capture at the price of Meta's category" is replaced by this.)
- **Hold placement:**
  - the hold is taken **inside `sendMessage` after all non-money rules pass and before the message insert**, with the idempotency key `wa-hold-<clientId>`, so a duplicate `clientId` replays the same hold.
  - If the message insert fails, the hold is released immediately (`release reason: 'send_aborted'`).
  - The message stores `billing.holdId`.
- **Billing hook in statuses:**
  - `status.service.ts` `applyStatuses` calls `whatsappBilling.onStatus(message, status, pricing)` after the status update. It is idempotent per message:
    - capture key `wa-capture-<messageId>`;
    - release key `wa-release-<messageId>`;
    - late key `wa-late-<messageId>`.
  - The first decisive signal wins:
    - `pricing.billable === true` → capture;
    - `pricing.billable === false` → release;
    - `failed` without billable → release;
    - a later contradicting signal is ignored and logged once with ids only.
- **Reactions:** Meta documents reactions as free (they don't open or bill a conversation in PMP — re-check at T11.2). If the docs confirm it, reactions are **never held**; otherwise they are held like service. Record the finding in the plan changelog.
- **Template rows are never hard-deleted** — Meta delete → status `DELETED` (history + reports keep working).
- **Rendered template text** (`message.text` for `type: template`) is stored so search / preview / bubbles work. It is customer data like any message text.
- **Variable formatting** (backend `src/modules/templates/format.ts`):
  - currency micros → `₹12,500.10` (en-IN);
  - date-only `YYYY-MM-DD` → `05 Oct 2026`;
  - numbers en-IN;
  - phone → `+91 98765 43210`;
  - empty → missing.
  - Mirrors the frontend `formatFieldValue`, with a test comparing both outputs on shared cases (fixture JSON in the backend repo).
- **Module layout:** new `src/modules/templates/`; WhatsApp billing in `src/core/billing/whatsapp.ts` (pure price math) + engine functions in `engine.ts` + `src/modules/whatsapp-billing/` (routes / services for rates, settings, reports, reconciliation).

**Env (all in `env.ts` + `.env.example` + README table + tests):**

| Key                            | Type / default                                                        | Production rule                                        |
| ------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------ |
| `FAKE_META_TEMPLATE_REVIEW_MS` | `off` or int ms, default `3000` (dev) / `off` (vitest env)            | must not be set                                        |
| `META_APP_ID`                  | digits — **already exists** (Phase 9), used for the resumable uploads | already required with `META_PROVIDER=meta` (no change) |

**`TEMPLATE_LIMITS`** (`config/limits.ts`, exact):

```
nameMax: 512, namePattern: /^[a-z0-9_]+$/,
headerTextMax: 60, headerVariablesMax: 1, bodyMax: 1024, footerMax: 60,
buttonsMax: 10, quickRepliesMax: 10, urlButtonsMax: 2, phoneButtonsMax: 1,
copyCodeButtonsMax: 1, voiceCallButtonsMax: 1,
buttonTextMax: 25, urlMax: 2000, phoneMax: 20, copyCodeExampleMax: 20,
variablesMax: 20, variableValueMax: 1024,
templatesPerWabaUnverified: 250, templatesPerWabaVerified: 6000,
createsPerHourPerWaba: 100, createsPerHourPerUser: 20,
approvedEditsPer30Days: 10, approvedEditGapMs: 24 * 3600_000, deletedNameLockMs: 30 * 24 * 3600_000,
syncPageSize: 100, syncPerMinutePerWaba: 1,
statusHistoryMax: 30, marketingPerContactWindowMs: 24 * 3600_000,
headerExampleMaxBytes: { image: 5 * 1024 * 1024, video: 16 * 1024 * 1024, document: 100 * 1024 * 1024 }
```

**`WHATSAPP_BILLING_LIMITS`** (exact):

```
defaultMarkupBps: 1500, holdMaxAgeMs: 72 * 3600_000, reapBatch: 1000,
reconcileDays: 3, freeServiceTierPerNumber: 1000,
rateCardMarketsMax: 300, csvMaxBytes: 2 * 1024 * 1024
```

**Collections (data-model.md §2.9):**

- **`whatsappTemplates`** (`tenantPlugin`; file `whatsapp-template.model.ts`; consts):
  - `TEMPLATE_CATEGORIES = ['MARKETING','UTILITY','AUTHENTICATION']`;
  - `TEMPLATE_STATUSES = ['DRAFT','PENDING','APPROVED','REJECTED','PAUSED','DISABLED','IN_APPEAL','FLAGGED','PENDING_DELETION','DELETED','ARCHIVED','LIMIT_EXCEEDED']`;
  - `TEMPLATE_QUALITY = ['GREEN','YELLOW','RED','UNKNOWN']`, `PARAMETER_FORMATS = ['positional','named']`, `TEMPLATE_PURPOSES = ['general','call_permission']`;
  - `VARIABLE_SOURCES` — kinds `contact.name`, `contact.phone`, `contact.email`, `field`, `static`, `ask`.

  Fields exactly as plan §1b, plus:
  - `editable` (bool — false for unsupported components / authentication / carousel);
  - `deletedAt` (our soft marker when Meta deleted);
  - `lastEventAt` (event time of the newest applied webhook / sync, for ordering).

  Every sub-field is declared; `components` is stored as validated JSON (`Schema.Types.Mixed` allowed **only** for `components`, validated by zod before every write).

  Indexes:
  - `{ accountId: 1, wabaId: 1, name: 1, language: 1 }` unique partial `{ status: { $ne: 'DELETED' } }`;
  - `{ wabaId: 1, metaTemplateId: 1 }` unique partial `{ metaTemplateId: { $type: 'string' } }`;
  - `{ accountId: 1, status: 1, updatedAt: -1 }`;
  - `{ accountId: 1, purpose: 1 }`.

- **`whatsappRateCards`** (platform, no tenant; file `whatsapp-rate-card.model.ts`) — insert-only:
  - fields per plan §1b, `markets[].market` uppercase `[A-Z_]{2,40}`, `callingCodes` digits 1–4, micros ≥ 0;
  - index `{ effectiveFrom: -1 }`; validator: exactly one `OTHER` market, no calling code in two markets.
- **`platformSettings`** (platform, no tenant; file `platform-settings.model.ts`) — `{ key: 'whatsappBilling', value: { markupBps, platformFeeMicros, holdMaxAgeHours }, updatedBy, updatedAt }`, unique `key`; reads fall back to code defaults.
- **`whatsappBillingDaily`** (platform, file `whatsapp-billing-daily.model.ts`) — reconciliation rows:
  - `{ accountId, wabaId, day: 'YYYY-MM-DD', category, metaVolume, metaCostMicros, ourCaptured, ourBilledMicros, diffVolume, diffMicros, fetchedAt }`;
  - unique `{ wabaId, day, category }`.
- **Message:**
  - `MESSAGE_TYPES` + `'template'` (→ 16);
  - `template { templateId, name, language, category, parameters: { key, value }[] }`;
  - `billing { payer: 'platform' | 'customer', market, category, estimateMicros, priceMicros, metaCostMicros, holdId, status: 'none' | 'held' | 'captured' | 'released' | 'late_charged' | 'waived', billable, pricingType, metaCategory, categoryMismatch, at }`;
  - origin `api` added to `MESSAGE_ORIGINS` (internal API sends).
- **Ledger:**
  - `LEDGER_TYPES` + `'whatsapp_charge'`, `LEDGER_REF_TYPES` + `'whatsapp_message'`, `LEDGER_USAGE_KINDS` + `'whatsapp'`;
  - `LedgerBreakdown` + `waCategory`, `waMarket`, `metaCostMicros`, `markupMicros`, `platformFeeMicros`, `waPricingType`.
- **Wallet:** `budgets.monthlyWhatsappMicros` (default 0 = none), monthly spend `whatsappMicros`; `WalletSettingsBody.budgets.monthlyWhatsappMicros`.
- **Contact:** `whatsapp.marketing { stopped: boolean, at: Date | null, source: 'user_preferences' | 'error_131050' | 'manual' | null }`.
- **Account:**
  - `settings.templates { defaultLanguage: 'en' }`;
  - `whatsappBilling { markupBps: number | null, fixedPrices: { marketing?, utility?, authentication?, service? } | null, platformFeeMicros: number | null }`.
- **Channel:** `pricingTier { category, market, tier, at } [] ` (from `VOLUME_BASED_PRICING_TIER_UPDATE`, last 10).

**Error codes (+10 → 69):**

| Code                         | Status | Details                                                             |
| ---------------------------- | ------ | ------------------------------------------------------------------- |
| `TEMPLATE_NOT_FOUND`         | 404    |                                                                     |
| `TEMPLATE_NOT_APPROVED`      | 409    | `{ path: 'status', message }`                                       |
| `TEMPLATE_PAUSED`            | 409    | `pausedUntil`                                                       |
| `TEMPLATE_VARIABLES_MISSING` | 422    | one entry per variable **key**                                      |
| `TEMPLATE_PARAMS_INVALID`    | 422    |                                                                     |
| `TEMPLATE_EDIT_NOT_ALLOWED`  | 409    | reason `status` / `edit_limit` / `category_locked` / `not_editable` |
| `TEMPLATE_NAME_TAKEN`        | 409    | incl. a deleted name in its 30-day lock                             |
| `TEMPLATE_LIMIT_REACHED`     | 409    | per-WABA count or creation rate                                     |
| `TEMPLATE_MARKETING_BLOCKED` | 409    | reason `opted_out` / `dnd` / `stopped_marketing`                    |
| `WHATSAPP_FREQUENCY_LIMIT`   | 429    | `retryAfterSec`                                                     |

`WALLET_INSUFFICIENT_BALANCE` and `WALLET_BUDGET_EXCEEDED` are reused, with `details: [{ path: 'whatsapp', message }]`.

**Audit actions (+12 → 118):**

- `template.created`, `template.submitted`, `template.updated`, `template.deleted`, `template.synced` (system, counts);
- `template.status_changed` (system), `template.category_changed` (system);
- `template.variables_updated`;
- `whatsapp.rate_card_saved`, `whatsapp.billing_settings_updated`, `account.whatsapp_billing_updated`;
- `contact.whatsapp_marketing_changed` (system).

Meta in audit: template **name / language / category / status / reason code**, counts, changed field names — **never** body text, samples or variable values.

**Notification types (+7 → 26):**

| Type                          | Recipients                                          | Title / body                                          | Link                          |
| ----------------------------- | --------------------------------------------------- | ----------------------------------------------------- | ----------------------------- |
| `template.approved`           | owners + admins + managers + the template's creator | title "Template approved", body `<name> (<language>)` | `/whatsapp/templates?id=<id>` |
| `template.rejected`           | same                                                | body name + reason code text                          | same                          |
| `template.paused`             | same                                                |                                                       | same                          |
| `template.disabled`           | same                                                |                                                       | same                          |
| `template.category_changed`   | same                                                |                                                       | same                          |
| `template.quality_low`        | same                                                |                                                       | same                          |
| `wallet.whatsapp_late_charge` | owners + admins                                     | —                                                     | `/wallet`                     |

No emails except `template.rejected` and `template.disabled`, through the existing email templates pattern: subject "Your WhatsApp template was rejected / disabled", plain text with the name + reason, no customer data.

**Permissions:**

- `templates.read` → owner, admin, manager, agent, viewer;
- `templates.manage` → owner, admin, manager;
- migration calls `syncSystemRoles()`.

**WS events:**

- account level `whatsapp.template.updated` `{ templateId: string; status: TemplateStatus; quality: TemplateQuality | null; category: TemplateCategory }`;
- existing `wallet.updated` covers money.
- Backend `events.ts`, websocket.md §5, frontend `events.ts`.

**Jobs:**

- Queue `whatsapp`:
  - `template.sync` (id `template-sync-<channelId>`, attempts 3, exponential 5 s; data `{ channelId, reason: 'connect' | 'daily' | 'manual' | 'webhook' }`);
  - `templates.backfill` (id `templates-backfill`, singleton, resumable).
- Queue `billing` (`BILLING_JOB_NAMES` / `BILLING_SCHEDULES`):
  - `billing.whatsapp_reap_holds` pattern `'*/30 * * * *'`;
  - `billing.whatsapp_reconcile` pattern `'30 21 * * *'` (03:00 IST).
- Daily template sync schedule `'40 22 * * *'` UTC (04:10 IST) enqueues one `template.sync` per connected channel with a distinct WABA (maintenance worker or a whatsapp-queue scheduler — follow the `MAINTENANCE_SCHEDULES` pattern).

**New `MetaClient` methods** (`{v}` = `META_GRAPH_VERSION`; re-check every body on Meta's reference at T11.2 and note differences in the plan changelog):

| Method                                                                                                                 | Call                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listTemplates(token, wabaId, { after, limit })`                                                                       | `GET /{v}/{waba}/message_templates?fields=id,name,language,status,category,sub_category,parameter_format,components,quality_score,rejected_reason,message_send_ttl_seconds&limit=<n>&after=<cursor>` → `{ data[], paging: { cursors: { after }, next? } }` |
| `createTemplate(token, wabaId, body)`                                                                                  | `POST /{v}/{waba}/message_templates` `{ name, language, category, parameter_format, components, message_send_ttl_seconds? }` → `{ id, status, category }`                                                                                                  |
| `editTemplate(token, templateId, body)`                                                                                | `POST /{v}/{template-id}` `{ category?, components?, message_send_ttl_seconds? }` → `{ success }`                                                                                                                                                          |
| `deleteTemplate(token, wabaId, { name, hsmId? })`                                                                      | `DELETE /{v}/{waba}/message_templates?name=<name>[&hsm_id=<id>]` → `{ success }`                                                                                                                                                                           |
| `uploadExample(token, appId, { bytes, mimeType, fileName })`                                                           | resumable: `POST /{v}/{app-id}/uploads?file_name&file_length&file_type` → `{ id: 'upload:…' }`; `POST /{v}/<upload id>` `Authorization: OAuth <token>`, `file_offset: 0`, body bytes → `{ h }` (reuse the profile-photo implementation; generalise it)     |
| `getPricingAnalytics(token, wabaId, { start, end, granularity: 'DAILY', dimensions: ['PRICING_CATEGORY','COUNTRY'] })` | `GET /{v}/{waba}?fields=pricing_analytics.start(<unix>).end(<unix>).granularity(DAILY).dimensions([...])` → data points `{ start, end, country, pricing_category, pricing_type, volume, cost }`                                                            |

Template message payload (`payloads.ts` `buildTemplatePayload`):

```
{ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template',
  template: { name, language: { code }, components: [
    { type: 'header', parameters: [ { type: 'text', text } | { type: 'image'|'video'|'document', <kind>: { id } } | { type: 'location', location: { latitude, longitude, name, address } } ] },
    { type: 'body', parameters: [ { type: 'text', text, parameter_name? } … ] },
    { type: 'button', sub_type: 'url', index: '<n>', parameters: [ { type: 'text', text: <encoded suffix> } ] },
    { type: 'button', sub_type: 'copy_code', index: '<n>', parameters: [ { type: 'coupon_code', coupon_code } ] },
    { type: 'button', sub_type: 'quick_reply', index: '<n>', parameters: [ { type: 'payload', payload: 'qr_<templateId>_<n>' } ] } ] } }
```

Components without parameters are omitted.

**Meta error mapping** (`errors.ts` additions; reason texts shown in bubbles / dialogs):

| Code     | Behaviour                                             | Reason text                                                        |
| -------- | ----------------------------------------------------- | ------------------------------------------------------------------ |
| `132000` | no retry                                              | "Template variables don't match the template"                      |
| `132001` | no retry, triggers a sync                             | "Template not found for this language"                             |
| `132005` | no retry                                              | "Text too long after filling the variables"                        |
| `132007` | no retry                                              | "Template content violates WhatsApp policy"                        |
| `132012` | no retry                                              | "Variable format doesn't match the template"                       |
| `132015` | no retry, template → `PAUSED`                         | "Template is paused for low quality"                               |
| `132016` | no retry, template → `DISABLED`                       | "Template is disabled"                                             |
| `131049` | no retry                                              | "WhatsApp limited marketing messages to this customer — try later" |
| `131050` | no retry, contact `whatsapp.marketing.stopped = true` | "Customer stopped marketing messages"                              |

Template management errors:

- `2388023` (name exists) / `2388024` (name being deleted) → `TEMPLATE_NAME_TAKEN`;
- `2388042` (limit) → `TEMPLATE_LIMIT_REACHED`;
- `2388040` / `2388047` (invalid component / text) → 422 with Meta's scrubbed title;
- `80008` (rate) → 429.

Unknown codes → "Meta refused the template (code N)". Re-check the codes at T11.2 against Meta's error reference and record differences.

**Fake Meta additions (exact):**

Templates live in Redis hash `…templates-<wabaId>` (id `fake_tpl_<hex>`).

- `createTemplate` → `PENDING` (or `APPROVED` at once when the name contains `instant`).
- After `FAKE_META_TEMPLATE_REVIEW_MS`, a signed in-process `message_template_status_update` follows. Name knobs:
  - `_reject` → `REJECTED` reason `INVALID_FORMAT`;
  - `_recategorize` → approved + `template_category_update` UTILITY → MARKETING;
  - `_pause` → approved, then `PAUSED` 1 s later;
  - `_slow` → no review event.
- `editTemplate` → `PENDING` + review again; `deleteTemplate` removes it; `listTemplates` pages 100.
- `uploadExample` → `fake_handle_<hex>`.
- **Pricing on statuses** (fake auto statuses + simulator):
  - templates → `{ billable: true, pricing_model: 'PMP', category: <template category lower>, type: 'regular' }`;
  - service sends → `{ billable: false, …, category: 'service', type: 'free_customer_service' }`;
  - customer knobs (number ending):
    - `00010` → service billable `type: 'regular'`;
    - `00011` → everything `billable: false, type: 'free_entry_point'`;
    - `00012` → template send fails `131049`;
    - `00013` → template send fails `131050`;
    - the late-billable case is driven by the simulator kind `late_billable_status` (no number knob).
- `getPricingAnalytics` → aggregates the fake's recorded sends (rate = seed placeholder card).
- `failNext(op)` for every new op.

**Simulator** (`POST /api/v1/dev/meta/webhooks` body adds `templateId?`, `messageId?`):

- `template_approved`, `template_rejected`, `template_paused`, `template_disabled`, `template_quality_red`, `template_category_changed`, `template_components_changed`;
- `user_stopped_marketing`, `user_resumed_marketing` (`from`);
- `pricing_tier_update`;
- `run_template_sync`, `run_hold_reaper`, `run_whatsapp_reconcile`;
- `late_billable_status` (`messageId`).

→ **58 kinds** (44 + 14). Plus `GET /api/v1/dev/meta/templates?channelId` (the fake's templates: names, statuses, categories — no bodies).

**Frontend literals:**

- Routes:
  - `/whatsapp/templates` (tab "Templates" next to "Numbers", lazy chunk);
  - `/admin/whatsapp-billing` (superadmin, lazy: rate card + settings + reports tabs **Rates** / **Settings** / **Margin** / **Reconciliation**).
- Accessible names:
  - Templates list: region **Templates**, searchbox **Search templates**, buttons **Create template**, **Create call permission template**, **Sync now**, row **Template <name> (<language>)**;
  - Builder: dialog **Create template** / **Edit template**, combobox **Category** / **Language** / **Header**, textbox **Template name** / **Message** / **Footer** / **Header text**, buttons **Add variable**, **Add button**, **Save draft**, **Submit for review**, figure **Template preview**; status chips **Draft** / **In review** / **Approved** / **Rejected** / **Paused** / **Disabled**;
  - Send dialog: dialog **Send template**, combobox **Template**, per-variable textbox **Value for {{<key>}}** with combobox **Source for {{<key>}}**, text **This message costs ₹<x>**, button **Send template**;
  - Inbox: window-closed banner button **Send a template**, composer button **Templates** (now enabled); contact page button **Send template**;
  - Superadmin: buttons **Import rate card**, **Save rate card**, **Save settings**, region **WhatsApp billing** on the account page.
- Wallet ledger label **WhatsApp · <Category> · <Market label>**; Wallet → Prices table caption **WhatsApp prices**.

---

## 2. RULES OF ENGAGEMENT

1. **No questions / no permission requests.** Safe, convention-consistent choice → report as a deviation and add it to the plan changelog.
2. **Git:**
   - Branch `feature/phase-11-templates-billing` in both repos. **Never commit on `main`.**
   - One commit per task per repo (Conventional Commit + tag), committed **sequentially, one repo at a time**.
   - Hooks must pass: **no `--no-verify`**, no `--force`. **No push / merge / tag.**
   - Footer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
   - Commit body: **no line may start with `word:`**. Write the message to a file and use `git commit -F`.
3. **Verify after every task — each command separately, read the output + exit code.** **Never chain `git commit` after checks with `;` or `&&`.**
   - Backend: `npm run lint` · `npm run format:check` · `npm run typecheck` · `npm run test:coverage -- --maxWorkers=2` · `npm run build` · `npm run openapi:check` (stage `openapi/openapi.json` first).
   - Frontend: `npm run lint` · `npm run format:check` · `npm run typecheck` · `npx tsc -p tsconfig.e2e.json --noEmit` · `npm run test:coverage -- --maxWorkers=2` · `npm run build`. From T11.11 on also `npm run e2e`: infra up, this project's dev servers stopped, `E2E_FRONTEND_PORT=3150`, **run Playwright from the frontend folder**.
   - Long runs go in the background with `caffeinate -dims`.
4. **Coverage gates stay green.** Add tests; never lower thresholds; never raise test timeouts (use fake timers for review delays / reaper / pauses).
5. **Tests in every task:**
   - unit + integration (supertest + real Mongo replica set + Redis with a unique prefix);
   - **tenant isolation** for every `:id` route (another account's template / message → 404, never listed);
   - the permission matrix per role (owner / admin / manager / agent / viewer + superadmin + impersonating superadmin);
   - suspended account (writes 403);
   - `WHATSAPP_ENABLED=false` (503).
6. **Money hard rules:**
   - every WhatsApp wallet write goes **only** through engine functions — the money-writes test lists `whatsapp_charge`;
   - integer micros everywhere; idempotency keys per message (`wa-hold-<clientId>`, `wa-capture-<messageId>`, `wa-release-<messageId>`, `wa-late-<messageId>`);
   - never capture without a hold except the documented late path;
   - never charge a customer-pays account Meta's price;
   - every test checks the balance + hold invariants after each scenario (sum of held rows = `holdMicros`).
7. **Template / customer data rules:**
   - variable values, rendered texts, customer phones / names are customer data → never in logs, audit meta, notification bodies, error messages, job data (ids only);
   - template bodies / samples never logged;
   - a pino-capture test runs create → approve → send → capture with distinctive strings and asserts none of them appears.
8. **No network in tests.** Graph client against the local stub server; the fake everywhere else.
9. **Every new env var** → `env.ts` + `.env.example` (`KEY=`) + README env table + a rule test.
10. **OpenAPI:** every route registered and its schemas imported in `src/openapi.ts` → `gen:openapi` → commit `openapi/openapi.json` with the task; frontend `gen:api` at T11.7 and whenever the spec changes.
11. **Docs in the same commit:** src/README.md rows, data-model.md §2.9, websocket.md, audit.md, error-codes.md, api.md §14e, security.md, compliance-notes.md as relevant.
12. **Docker:** only `npm run infra:*` (`cav-*`); gitleaks / actionlint via one-off `docker run --rm`; never touch other containers or volumes.
13. **Real bugs** found by tests / manual checks / E2E:
    - reproduce, then prove the regression test fails without the fix;
    - fix in a separate `fix(<area>): …` commit (except the locked reaper filter, which is part of T11.4);
    - note it in the report and the plan changelog.
14. **Frontend lessons (Phases 5–10):**
    - **Rendering:**
      - Fast-refresh rule: non-component exports live in `.ts` files.
      - React compiler lint: no setState in effects for derived state.
      - Never two siblings with the same `key` (Phase 10: a duplicate key mounted a list twice).
      - Long toolbars wrap or move to their own row (Phase 10 narrow-chat bug).
    - **Server state:**
      - A view of server state listens to the WS event **and** polls while the state is not final.
      - Hooks that grab browser resources are strict-mode safe (Phase 10 recorder bug): attempt tokens, release on cleanup.
    - **Navigation:** full reloads end an impersonation, so E2E navigates client-side.
    - **Dev-only UI:** `import.meta.env.DEV` is true in Playwright, so dev-only UI also checks `fakeProvider`.
    - **Tests:**
      - MUI Select with an empty value needs `displayEmpty`.
      - MUI Tooltip around an icon with `titleAccess` needs `describeChild`.
      - Dialogs → `findByRole`.
15. **Never kill other projects' processes** (port 3100 belongs to another project).
16. **Mongoose 9:** use `returnDocument: 'after'`, `QueryFilter`, `updatePipeline: true` for pipeline updates, `toObject({ transform: false })`; zod v4 `z.looseObject` for Meta objects; no dynamic `import()` in backend tests.

---

## 3. RESUME SAFETY

- Both repos: `git branch --show-current` → `feature/phase-11-templates-billing` (the frontend from T11.7 on); `git log --oneline -25`; continue after the last `[P11-…]` commit.
- `npm run infra:up` → `npm ci` (both) → `npm run db:migrate` (dev DB) → lint → typecheck → `test:coverage` green before continuing.
- Batch 2 requires `[P11-B1-DONE]`; Batch 3 requires `[P11-B2-DONE]`. If one is missing, stop and report.
- A half-done task (uncommitted files) → read `git status` / `git diff`, finish, verify, commit. Never discard work without reading it.

---

## STEP 0 — P11-SETUP (before T11.1)

1. Backend: `git branch --show-current` must be `feature/phase-11-templates-billing`, last commit `[P11-PLAN]`. `git status` should show only `docs/phases/PHASE_11_PLAN.md` (modified) and `docs/prompts/PHASE_11_PROMPT.md` (untracked); anything else → stop and report.
2. `PHASE_11_PLAN.md` changelog line "Run prompt prepared — refinements locked:
   - the call-hold reaper limited to `call_charge`;
   - separate WhatsApp engine functions and the `whatsapp` budget;
   - the price fixed at send (category mismatch flagged, not re-priced);
   - the hold inside `sendMessage` keyed by clientId;
   - the billing hook in `applyStatuses`;
   - reactions per Meta docs;
   - no hard delete of templates;
   - the backend variable formatter mirrors the frontend;
   - module layout `modules/templates` + `core/billing/whatsapp.ts` + `modules/whatsapp-billing`;
   - fake knobs `00010`–`00013`"

   (this prompt's §1 wins where the plan differs).

3. Commit 1: `docs/phases/PHASE_11_PLAN.md` → `docs(plans): lock phase 11 decisions [P11-PLAN]` (run `npm run format:check` first).
4. Commit 2: `docs/prompts/PHASE_11_PROMPT.md` → `docs(prompts): add phase 11 run prompt [P11-PROMPT]`.

---

# ═══════════ BATCH 1 — Templates + billing foundation (T11.1 → T11.4) ═══════════

## T11.1 — Models, migration 0012, limits, catalogue → `feat(templates): add template and whatsapp billing models with catalogue [P11-T11.1]`

1. **Models** (§1 Collections):
   - `whatsapp-template.model.ts`, `whatsapp-rate-card.model.ts` (validators: one `OTHER`, unique markets, no shared calling code, micros ≥ 0), `platform-settings.model.ts`, `whatsapp-billing-daily.model.ts`;
   - message / ledger / wallet / contact / account / channel additions;
   - `MESSAGE_TYPES` (16) + `MESSAGE_ORIGINS` (+ `api`).
2. **Migration `0012-templates-billing.ts`:**
   - indexes;
   - `platformSettings` `whatsappBilling` default row (if missing);
   - the placeholder rate card (if none): `effectiveFrom` = migration time, `source: 'manual'`, note "Placeholder — replace with Meta's INR rate card";
   - `syncSystemRoles()`;
   - down migration drops the new collections / indexes and removes the 2 permissions;
   - tests for up / down.
3. **Config:**
   - `TEMPLATE_LIMITS`, `WHATSAPP_BILLING_LIMITS` (exact);
   - env `FAKE_META_TEMPLATE_REVIEW_MS` (+ vitest env `off`) and the `META_APP_ID` production rule.
4. **Catalogue:**
   - error codes (+10 → 69), audit (+12 → 118), notification types (+7 → 26) with titles / links / email flags, WS event, permissions (+2) + roles snapshot;
   - billing job names + schedules, whatsapp job names, daily template sync schedule;
   - simulator kinds list grown later (T11.6) — the T11.1 catalogue test counts only what T11.1 adds.
5. **Docs:** data-model §2.9 (collections + indexes), error-codes, audit, websocket, src/README rows.
6. **Tests:**
   - `tests/templates/catalogue.test.ts` (counts, roles matrix, limits values);
   - `tests/templates/models.test.ts` (validators, indexes, tenant scope);
   - `tests/db/phase11-migrations.test.ts`;
   - update the Phase 10 catalogue tests that assert exact totals (they move to the Phase 11 catalogue test like Phase 10 did).

## T11.2 — Meta core extension → `feat(meta): add template management, example upload and pricing analytics to the meta client [P11-T11.2]`

1. Graph methods (§1 table) with retries / scrubbing, paging helper, `uploadExample` generalised from the profile-photo code (profile photo now calls it).
2. `buildTemplatePayload` (positional + named, every component, percent-encoded URL suffix, omitted empty components) in `payloads.ts`.
3. Error mapping additions (§1) in `errors.ts`; re-check the codes on Meta's reference, record differences.
4. Schemas (`schemas.ts` / `template-schemas.ts`):
   - `message_template_status_update` (event, message_template_id, name, language, reason, other_info, …);
   - `message_template_quality_update`, `template_category_update` (incl. pending-change fields), `message_template_components_update`;
   - `user_preferences` (`value.user_preferences[{ wa_id, detail, category: 'marketing_messages', value: 'stop' | 'resume', timestamp }]` — re-check);
   - `account_update` `VOLUME_BASED_PRICING_TIER_UPDATE`;
   - the pricing object incl. `subtype`; the analytics answer.
5. `WEBHOOK_FIELDS` + `'message_template_components_update'`; the setup guide subscription list updated.
6. Fixtures from Meta's documented samples (`tests/fixtures/meta/templates-*.json`, `user-preferences-*.json`, `pricing-*.json`, `graph-templates-*.json`, `graph-pricing-analytics.json`) + README rows with source pages.
7. Fake (§1 Fake Meta additions) with timers `unref()`'d and cleared in `onShutdown('fake-meta-templates', …)`.
8. **Reactions billing finding** recorded (plan changelog + a constant `REACTIONS_BILLABLE` used by T11.5).
9. **Tests:**
   - stub-server tests per Graph call (path, query, body, paging, errors, retries, scrubbed logs);
   - the fake per knob;
   - schemas per fixture;
   - payload builder snapshot per component type + named format.

## T11.3 — Template service + webhooks → `feat(templates): add template management, webhooks and sync [P11-T11.3]`

1. `src/modules/templates/`:
   - `validate.ts` — every §1c rule + grouping + call permission constraints + location only utility / marketing + no auth creation; one error per field path.
   - `variables.ts` — extract from the header / body / URL buttons (positional + named); example checks.
   - `template.service.ts`:
     - create draft / submit / edit (status + edit-window rules via `editsLog`) / delete (scopes; the 30-day name lock stored on the deleted row);
     - sync (paged upsert by `metaTemplateId`, missing → `DELETED`, unsupported components → `editable: false`);
     - variable defaults;
     - the call permission template (one per WABA × language; a second → 409 `TEMPLATE_NAME_TAKEN` pointing to it);
     - usage counters.
   - `example-media.service.ts` — sniff (Phase 10 `sniff.ts`), size per §1, storage area `template-media`, Meta handle.
   - `template-json.ts` — views without bodies in list mode; full in detail.
2. **Webhook handlers** in `WEBHOOK_HANDLERS`:
   - the 4 template fields (ordered by event time via `lastEventAt`; the timeline capped at 30; unknown id → enqueue `template.sync`);
   - `user_preferences` → contact marketing flag (only existing contacts in that account by `whatsapp.waId` / phone; audit + WS `contacts.changed`);
   - `account_update` tier event → channel `pricingTier`.
   - The handlers are registered via the `HandlerContext` hooks pattern (as the inbox did), so scripts without them keep events deferred.
3. **Backfill:** `templates.backfill` consumes the Phase 9 deferred template + `user_preferences` events in event order at worker start (`listDeferred` / `markConsumed`).
4. **Jobs:**
   - `template.sync` (rate limited 1 / min / WABA via Redis key `tpl-sync-<wabaId>`);
   - the daily schedule;
   - the Phase 9 connect hook enqueues a sync after a successful connect.
5. **Notifications** (§1, the creator included, deduped), WS `whatsapp.template.updated`, audit.
6. **Tests** (`tests/templates/*`):
   - every validator rule (a table-driven test with Meta's limits);
   - service flows against the fake + Graph stub;
   - edit windows with fake timers;
   - delete scopes + the name lock;
   - sync paging + deletions + unsupported;
   - a webhook vs sync ordering race (an older event after a newer sync is ignored);
   - backfill order;
   - user preferences;
   - tier updates;
   - notifications without bodies;
   - logs without bodies.

## T11.4 — WhatsApp billing → `feat(billing): add whatsapp rate card, markup and message charges [P11-T11.4]`

1. **`src/core/billing/whatsapp.ts`** (pure):
   - `marketFor(phoneE164, card)` (calling code via libphonenumber, longest match, `OTHER`);
   - `metaRate(card, market, category)` (`authentication_international` when present);
   - `sellingPrice({ metaRate, markupBps, fixedPrice, platformFee, payer })` → `{ priceMicros, metaCostMicros, markupMicros, platformFeeMicros }` (round **up** to `PAISA_MICROS`; customer payer → `platformFee` only);
   - `parseMetaRateCsv(buffer)` (tolerant header names, INR only, ≤ 300 markets, duplicate / unknown columns → errors with row numbers) + `diffRateCards(a, b)`.
2. **`effectiveWhatsAppRateCard(at)`** (cache, invalidate on save), `whatsAppBillingSettings()` (platformSettings + defaults), `accountWhatsAppPricing(accountId)` (the account override).
3. **Engine** (`engine.ts`):
   - `holdForWhatsApp({ accountId, messageClientId, amountMicros, breakdown, ref })` (credit limit allowed, budget `whatsapp`, key `wa-hold-<clientId>`);
   - `captureWhatsApp({ accountId, holdId, messageId })` (moves held → captured, balance −, spend `whatsappMicros`, `balanceAfterMicros`, key `wa-capture-<messageId>`);
   - `releaseWhatsApp({ accountId, holdId, messageId, reason })`;
   - `chargeWhatsAppLate({ accountId, messageId, amountMicros, breakdown })` — direct captured debit, allowed below zero (`assertMicros(..., { allowNegative })` style path), wallet events + the `wallet.whatsapp_late_charge` bell when the balance becomes negative;
   - `loadWhatsAppHold`;
   - `canSpend` / `moneyPipeline` support the `whatsapp` budget / spend key.
4. **Locked reaper fix:**
   - `reapStaleHolds` filters `type: 'call_charge'`;
   - the regression test (a WhatsApp hold older than 2 h must stay held) is proven failing first, then the fix.
5. **`billing.whatsapp_reap_holds`:** WhatsApp holds older than `holdMaxAgeHours` → release `reason: 'no_delivery'`, message `billing.status = 'released'`.
6. **`src/modules/whatsapp-billing/billing-hook.ts`:** `onStatus(message, status, pricing)` per §1 (first decisive signal, idempotent, late path when the message is already released and a billable status arrives), registered into `status.service.ts` through the inbox context (no import cycle — the hooks pattern).
7. **Money-writes test** extended; engine invariant helper `expectWalletConsistent(accountId)`.
8. **Tests** (`tests/billing/whatsapp-*.test.ts`):
   - price math table (markups, fixed prices, the platform fee, customer payer, rounding edge cases `0.0001` → `0.01`);
   - market lookup;
   - CSV parse + diff (good / bad files);
   - hold → capture (exact micros, ledger line breakdown);
   - release on failed / billable false / free entry point / reaper;
   - late charge (negative + bell);
   - category mismatch flag (captured at the held price);
   - budget exceeded; credit limit; insufficient balance → refused before insert;
   - replays (same status twice, out-of-order delivered before sent, a capture after release → late path once);
   - 200 parallel holds on a small wallet (never past the allowed limit);
   - the call-hold reaper leaves WhatsApp holds alone.

## P11-B1-DONE — checkpoint → `docs: mark phase 11 batch 1 complete [P11-B1-DONE]`

1. Full backend verify (each command separately).
2. `scripts/dev-templates.ts` (`npm run dev:templates [-- --account <slug>]`, dev only, refuses production, counts only): on the dev DB with the fake, create a template → approve → send to a closed-window contact → capture; one service reply released; one `00009` template released; print counts + wallet before / after (numbers only).
3. Docs: plan changelog (Batch 1 done + deviations), CHANGELOG `Phase 11 · Batch 1`, data-model §2.9 complete, src/README rows. Commit.

---

# ═══════════ BATCH 2 — Send, API, dev tools, hardening, docs (T11.5 → T11.6) ═══════════

## T11.5 — Template send + service billing → `feat(templates): add template sends with variables and message charges [P11-T11.5]`

1. **`outbound.schema.ts`:** `TemplateBody` (`{ clientId, type: 'template', templateId, variables?: Record<string, string>, header?: { mediaToken } | { location: { latitude, longitude, name?, address? } }, replyToMessageId? }`) added to the union.
2. **`src/modules/templates/send.service.ts`:**
   - load the template (same WABA as the conversation's channel, status `APPROVED` / `FLAGGED`, not paused);
   - resolve variables per source (`format.ts` formatter; `ask` from the body; missing → `TEMPLATE_VARIABLES_MISSING` with keys only);
   - header media (the stored example re-uploaded to `/media` per send, or a Phase 10 upload `mediaToken`), location;
   - button params;
   - render the text (body with values, header text, footer) for `message.text`;
   - build the payload.
3. **Rules in `sendMessage`** (order per plan §1e):
   - window check **skipped** for templates;
   - marketing blocks (opted out / DND / `marketing.stopped`) → `TEMPLATE_MARKETING_BLOCKED`;
   - utility / authentication allowed unless DND;
   - frequency (1 marketing / contact / 24 h, query on messages `{ conversationId, type: 'template', 'template.category': 'MARKETING', at ≥ now−24h, status ≠ failed }`) → `WHATSAPP_FREQUENCY_LIMIT`;
   - then pricing + hold (§1), then insert, queue.
4. **Service replies:** every Phase 10 free-form type except notes (and reactions per the T11.2 finding) gets `billing` (category `service`) + a hold for platform payers. Auto-confirmations (opt-out / opt-in) are held too (`origin: system`; key by message id).
5. **Send job:**
   - template payload;
   - errors per §1 mapping;
   - `131050` → contact marketing stopped (+ audit + WS);
   - `132015` / `132016` → template status;
   - `132001` → enqueue sync;
   - failure → billing release (via the hook).
6. **Start with a template:** `POST /inbox/conversations/start` accepts an optional `template` (`TemplateBody` without `clientId` → one generated server-side, returned) → one request from the contact page.
7. **`POST /whatsapp/price-preview`:** `{ channelId, contactId? | phone?, templateId? | category? }` → `{ payer, market, marketLabel, category, priceMicros, currency: 'INR', note: 'billed_when_delivered' | 'free_tier_may_apply' | 'customer_pays_meta' }`.
8. **Template usage counters** updated from status changes (sent / delivered / read / failed) via the status hook.
9. **Tests:**
   - every component / variable source / header kind produces the exact Graph payload;
   - window bypass;
   - every rule + error code;
   - holds per path (refused sends hold nothing; idempotent resend holds once; retry holds again);
   - service replies held / released / captured per knob;
   - customer payer (no hold);
   - price preview per case;
   - start-with-template;
   - logs without values.

## T11.6 — API, dev tools, hardening, docs → `feat(templates): add template api, superadmin whatsapp billing and dev tools [P11-T11.6]`

1. **Routes (§1m of the plan + this prompt's literals)** with zod schemas, OpenAPI (`templates.openapi.ts`, `whatsapp-billing.openapi.ts`, imported in `src/openapi.ts`):
   - rate limiters `rl:templates:` (20 / h / user) and `rl:template-sync:`;
   - permissions; impersonation read-only; suspended 403; WhatsApp off 503;
   - **list views exclude bodies / samples** (detail includes them).
2. **Wallet:**
   - `GET /wallet/rates` adds `whatsapp: { payer, markets: [{ market, label, prices: { marketing, utility, authentication, service } }] }` (selling prices only);
   - `PATCH /wallet/settings` accepts `budgets.monthlyWhatsappMicros`;
   - ledger filter `type=whatsapp_charge`; usage series adds `whatsapp`.
3. **Superadmin:**
   - `GET /admin/whatsapp-rates`, `POST /admin/whatsapp-rates/import` (multipart CSV → `{ card, diff, errors }`), `POST /admin/whatsapp-rates` (save, `effectiveFrom` ≥ now − 1 min);
   - `GET` / `PATCH /admin/whatsapp-billing` (global settings);
   - `PATCH /admin/accounts/:id/whatsapp-billing` (extended: `metaPayer?`, `markupBps?`, `fixedPrices?`, `platformFeeMicros?`; at least one field);
   - `GET /admin/reports/whatsapp-margin?month=YYYY-MM&accountId?` (per account × category: messages captured, billed micros, Meta cost micros (analytics when present else list), margin micros, margin %, mismatches) + CSV export;
   - `GET /admin/reports/whatsapp-reconciliation?month`.
4. **`billing.whatsapp_reconcile` job:** for each platform-payer WABA, pull `pricing_analytics` for the last `reconcileDays` days → upsert `whatsappBillingDaily` with our captured counts / amounts → diff; a diff beyond 2 % or ₹10 → superadmin notification (existing platform notification pattern) with numbers only.
5. **Non-INR platform WABA warning:** the `/admin/whatsapp-billing` response lists platform-payer channels whose `wabaCurrency` ≠ `INR` (India INR deadline 31 Dec 2026).
6. **Simulator kinds (→ 58) + `GET /dev/meta/templates`;** `ALL_SIMULATOR_KINDS` + frontend list updated in T11.7.
7. **Seed (`scripts/seed-templates.ts`, wired into `db:seed`, idempotent) — Demo Finance:**
   - 4 templates (EMI reminder utility approved with 2 variables from contact fields; offer marketing approved; call permission pending; one rejected with a reason);
   - account markup override none (global 15 %);
   - one captured + one released WhatsApp charge on the seeded inbox chats.
8. **Hardening** (`tests/templates/hardening.test.ts`, times recorded):
   - 500 template sends across 50 contacts with a wallet that runs out mid-way (exact holds, no overspend, refused sends hold nothing);
   - 10,000 status webhooks with pricing (capture exactly once each, invariants hold);
   - a sync of 1,000 templates (10 pages);
   - a CSV with 250 markets;
   - the reaper over 5,000 stale holds.
9. **Docs:**
   - ADR 0039 (templates + WhatsApp billing: Meta source of truth, bill on `pricing.billable`, price fixed at send, late path, INR);
   - data-model §2.9, api.md §14e, websocket, audit, error-codes, security (customer data rules for variables), compliance-notes (marketing consent warning, opt-out / DND rules, India INR deadline);
   - setup guide (template permissions `whatsapp_business_management`, `META_APP_ID`, the new webhook field, credit line INR, **§14 real-WABA checklist**: create + approve a template on the test WABA, send outside the window, delivered charge vs `pricing_analytics`, rejection reason, pause / quality webhook, the call permission template approved);
   - README section; CHANGELOG `Phase 11 · Batch 2`; src/README rows.

## P11-B2-DONE — checkpoint → `docs: mark phase 11 batch 2 complete [P11-B2-DONE]`

1. Full backend verify.
2. **Manual HTTP check on a locally started dev server** (scratchpad script, counts / statuses only):
   - create (draft → submit → approved via the fake), a `_reject` knob → reason;
   - edit → pending → approved;
   - send outside the window → read → captured (exact ledger amount = price preview);
   - a service reply free → released, `00010` billable → captured;
   - `00009` failed → released;
   - empty wallet → 422 and nothing held; WhatsApp budget → 422;
   - customer-pays account → no hold;
   - rate card import + diff + save → the price preview changes; the account markup override changes the price;
   - the margin report has rows; `late_billable_status` → negative wallet + bell;
   - `user_stopped_marketing` → marketing refused, utility allowed.
3. Log grep for the variable values / phones / names used → 0.
4. Plan changelog + CHANGELOG. Commit.

---

# ═══════════ BATCH 3 — Frontend, E2E, sign-off (T11.7 → T11.12) ═══════════

## T11.7 — Frontend foundation → `feat(templates): add template clients, hooks and routes [P11-T11.7]`

1. Frontend branch from `main`; `npm run gen:api`.
2. **Clients:**
   - `services/api/templates.ts` (list / detail / create / edit / submit / delete / sync / media upload with progress / call permission / variables);
   - inbox send body `type: 'template'`; `whatsapp.ts` `pricePreview`;
   - wallet additions; `admin-whatsapp-billing.ts` (rates / import / save / settings / account override / reports).
3. **Types + fixtures** (`src/test/templates.ts`): `fakeTemplate(status, category, components)`, `fakeRateCard`, `fakePricePreview`, `fakeMarginRow`.
4. **`features/templates/`:**
   - `keys`, `queries` (live `whatsapp.template.updated` + polling while `PENDING`), `labels` (status / category / quality / error texts per code), `permissions` (`useCanManageTemplates` = `templates.manage` && !impersonating && account active);
   - `limits.ts` (copy of `TEMPLATE_LIMITS` + a test comparing it with the OpenAPI constants if exposed);
   - `validate.ts` (mirror of the backend validator, table-driven test shared cases);
   - `variables.ts` (extract / render with samples or values);
   - `preview.ts` (template → bubble model).
5. **Realtime event type; `SIMULATOR_KINDS` / `INBOX_SIMULATOR_KINDS` updated (58).**
6. **Routes:**
   - `/whatsapp/templates` (lazy; `WhatsAppPage` tabs Numbers / Templates driven by the URL);
   - `/admin/whatsapp-billing` (lazy, superadmin);
   - nav: superadmin item **WhatsApp billing** (`platformOnly`, `phase: 11`), `LIVE_PHASE = 11`.
7. **Tests:** clients (paths / bodies / progress / abort), hooks (live + polling stop), validators (every rule), variables / preview, permissions, routes / nav.

## T11.8 — Templates tab + builder → `feat(templates): add templates page and template builder [P11-T11.8]`

1. **Templates tab** (region **Templates**):
   - table / list: name, language, category chip, status chip (+ reason tooltip), quality dot, number / WABA, last used, usage counts;
   - filters (status, category, language, number), search, **Sync now**, **Create template**, **Create call permission template**;
   - empty / loading / error / WhatsApp-off / no-number states.
2. **Detail drawer:**
   - live preview, components, status history (time + source), rejection / pause reason with **Edit and resubmit**;
   - usage, variable defaults editor (source per variable);
   - delete (scope dialog: this language / all languages, 30-day name note);
   - read-only for unsupported / authentication / synced-from-Meta-only fields ("Edit in WhatsApp Manager").
3. **Builder** (dialog **Create template** / **Edit template**, lazy):
   - category (Meta's descriptions); name (auto slug, `^[a-z0-9_]+$` with live error); language (common list `en`, `en_US`, `en_GB`, `hi`, + search);
   - header none / text (60, 1 variable) / image / video / document (example upload with progress / cancel + size errors) / location (utility / marketing only);
   - body editor with **Add variable** (positional `{{n}}` or named `{{key}}` per the format toggle), required sample values, counter 1,024; footer 60;
   - buttons builder (quick reply, URL with the optional `{{1}}` suffix + example, phone, copy code + example, voice call) with grouping enforced (quick replies kept together, drag disabled — up / down buttons) and limits;
   - call permission toggle (`purpose`); TTL advanced;
   - figure **Template preview** (WhatsApp-like bubble with samples, buttons, "See all options" beyond 3);
   - inline errors from the validator + server field errors;
   - **Save draft** / **Submit for review**; the edit limits notice for approved templates.
4. **Create call permission template** → prefilled builder (purpose `call_permission`, UTILITY, the decided body, component) → submit.
5. **Tests:** every component + limit + grouping rule, preview (samples, named / positional, >3 buttons), media example upload (progress / cancel / errors), submit / draft / edit / resubmit / delete flows, live status change, read-only for agents / viewers / impersonators, unsupported templates read-only, responsive.

## T11.9 — Send template + inbox → `feat(templates): add send template dialog and inbox template entry points [P11-T11.9]`

1. **Dialog Send template** (lazy):
   - combobox **Template** (approved / flagged only, the same WABA as the conversation's number, search, category / language chips);
   - per variable: source combobox (Contact name / phone / email / custom fields / Fixed text / Type here) prefilled from defaults, value textbox, the resolved value shown;
   - header media (example or upload new) / location fields; live preview with real values;
   - **cost line** from `price-preview` ("This message costs ₹0.99 · Marketing · India" / "Billed by Meta to your WhatsApp account" / "Free when the customer is in a free entry window");
   - marketing-blocked notice (reason) and consent warning (decision #13); errors per code (frequency, wallet, budget, paused);
   - **Send template**.
2. **Entry points:**
   - composer **Templates** button (enabled; `TEMPLATES_SOON_TEXT` removed);
   - window-closed banner: new text "The 24-hour window is closed. Send a template to start the conversation again." + button **Send a template**;
   - contact page **Send template** (the number picker when > 1; uses start-with-template);
   - template bubbles (label "Template · <name>", rendered text, buttons shown);
   - failed reasons for template errors; composer cost hint for platform payers ("Replies may cost ₹0.13 after the free 1,000 each month").
3. **Tests:**
   - the exact request body per variable source / header kind;
   - preview values; cost line per payer / note;
   - blocks and errors;
   - window-closed path; contact page path (start-with-template); composer button;
   - template bubble rendering (hostile values stay text).

## T11.10 — Wallet, superadmin, entry points → `feat(billing): add whatsapp billing pages and wallet entries [P11-T11.10]`

1. **Wallet:**
   - ledger labels **WhatsApp · <Category> · <Market>** + a link to the chat;
   - ledger detail breakdown (price, Meta category, pricing type — selling price only);
   - Prices tab **WhatsApp prices** table; usage chart category WhatsApp;
   - settings dialog WhatsApp monthly budget; the low-balance banner mentions WhatsApp.
2. **Superadmin `/admin/whatsapp-billing`:**
   - **Rates**: current card, history, **Import rate card** (CSV upload → diff table: added / removed / changed markets with old → new per category, errors with row numbers) → effective date → **Save rate card**; edit a row manually.
   - **Settings**: markup %, platform fee, hold max age; the non-INR platform WABA warning list.
   - **Margin**: month / account filters, table + totals + CSV.
   - **Reconciliation**: per WABA × day × category, diffs highlighted.
   - Account detail page region **WhatsApp billing**: payer (Phase 9 control moved here), markup override, fixed prices per category, platform fee.
3. **Notifications** (7 types: icons / links).
4. **Dashboard:** the WhatsApp card adds "This month: ₹X on WhatsApp" (from wallet usage).
5. **Bundle check vs `main`** (same method as Phase 10: per file **and** as one gzip stream; target ≤ +3 KB as one stream; record both).
6. **Tests for each** (branch-complete).

## T11.11 — Playwright E2E → `test(e2e): add whatsapp template and billing scenarios [P11-T11.11]`

1. **`playwright.config.ts` backend env:**
   - `FAKE_META_TEMPLATE_REVIEW_MS: '1000'`; keep the status delays;
   - the superadmin E2E user already exists (`E2E_SUPERADMIN_*`);
   - the account wallet needs money → helper `addMoney(page, amount)` (Phase 4 test payment flow) or `adjust` via a superadmin API session.
2. **Helpers `e2e/templates.ts`:**
   - `TemplatesApi` (extends the `InboxApi` session pattern: `createTemplate`, `templateStatus`, `ledger`, `wallet`, `setAccountBilling` as superadmin);
   - `createTemplateUI(page, spec)`, `sendTemplateUI(page, name, values)`, `expectLedgerLine(page, text, amount)`.
3. **Specs** (one account per spec, `test.describe.configure({ mode: 'serial' })`, unique phones via `customerPhone(suffix)`):
   1. **`templates-done-when.spec.ts`:**
      - builder: header image example, body with 2 variables (contact name + custom field "EMI amount"), footer, quick reply + URL button with a suffix;
      - **Submit for review** → **In review** → **Approved** live + bell;
      - a contact with a closed window → **Send a template** → preview with real values + cost line;
      - send → ticks Read → Wallet ledger "WhatsApp · Utility · India" captured = the shown cost;
      - a `_reject` template → reason → **Edit and resubmit** → approved;
      - the fake confirms the template payload (`fakeSent` type `template`).
   2. **`templates-billing.spec.ts`:**
      - superadmin imports a rate card CSV (diff shown) + saves; account markup 20 % → the price preview changes;
      - `00009` template → Failed → hold released (ledger "Released");
      - a free service reply released; a `00010` billable reply captured;
      - empty wallet → send refused with "Add money…", nothing held;
      - WhatsApp budget reached → refused;
      - a customer-pays account → "Billed by Meta…", no ledger line;
      - margin report rows; `late_billable_status` → negative balance + bell.
   3. **`templates-marketing-rules.spec.ts`:**
      - marketing to a STOP contact refused (reason), utility allowed;
      - `user_stopped_marketing` → marketing refused;
      - `00013` → failed + contact flagged;
      - a second marketing template within 24 h → frequency refusal;
      - a `_pause` template → can't send (paused chip);
      - a `_recategorize` template → bell + Marketing chip.
   4. **`templates-roles-entry.spec.ts`:**
      - viewer / agent: templates read-only (no Create), the agent can send;
      - impersonating superadmin read-only;
      - **Create call permission template** → In review → Approved;
      - contact page **Send template** (start-with-template);
      - dashboard spend line; Wallet → Prices **WhatsApp prices**;
      - another account never sees these templates (API 404).
4. **All earlier 103 tests stay green;** the whole suite **twice**, the 2nd with `E2E_BACKEND_LOGS=1` → log grep (every variable value and rendered text used, test phones in full / `+91` / digits, contact names, template sample values, example file names, `fake_handle_`, `wamid.`, tokens, `Bearer`, `sk-`, both E2E passwords, the E2E app secret / verify token) → 0 hits.

## T11.12 — Gap audit, security, docs, sign-off

Commits: backend `docs: add phase 11 sign-off and docs [P11-T11.12]` + frontend `docs: add phase 11 templates and billing to the readme and changelog [P11-T11.12]` (+ `test: add phase 11 gap tests …` only if tests are added).

1. **Requirement → test table:** plan §0 (12 items + Done when), §1, every task, every §7 decision; missing tests added.
2. **Security / money checklist:**
   - customer data (variables, rendered text, phones, names) never in logs / audit / notifications / job data / account events (tests + log grep);
   - template bodies never logged;
   - example uploads sniffed; signed links;
   - superadmin-only rate card / margin (agents and owners never see Meta cost — a test on every account-facing response);
   - money only through the engine (money-writes); invariants after every billing test; idempotency keys;
   - impersonation read-only;
   - gitleaks both repos; `console.log` 0 in both; no network in tests.
3. **Numbers:** coverage re-measured (gates never lowered), bundle (both measures), hardening times.
4. **Docs:**
   - both READMEs (Templates + WhatsApp billing sections, E2E list);
   - CHANGELOGs (`Phase 11 · Batch 1 / 2 / 3` backend; `Phase 11 · Templates + WhatsApp billing (T11.7–T11.12)` frontend);
   - BUILD_PLAN_V2 Phase 11 ✅ + changelog + "Next: Phase 12 (WhatsApp Calling)";
   - PHASE_11_TASKS all `[x]`; plan ticked + changelog.
5. **PHASE_11_SIGNOFF.md** (same structure as Phase 10):
   - tasks + evidence commits, deliverables, requirement → test;
   - numbers (tests before → after: backend 2712 → N, frontend 1048 → N, E2E 103 → N; coverage; hardening; bundle);
   - security / money checklist, deviations, bugs fixed, verification;
   - TODOs by phase:
     - Phase 12: send the call permission template, `call_permission_reply`, voice call buttons;
     - Phase 13: real-WABA checklist §14 + `whatsapp_business_management` screencast + the INR credit line;
     - Phase 14: margin / spend reports in analytics;
     - Phase 15: public API template sends;
     - Phase 20: bulk template campaigns with tier pacing;
   - owner inputs still pending: the official Meta INR rate card file, the credit line + INR, Meta app / test WABA;
   - go / no-go for Phase 12.

## P11-B3-DONE — checkpoint → `docs: mark phase 11 complete [P11-B3-DONE]`

1. `infra:up` → full verify of **both repos** (each command separately) + actionlint both (`docker run --rm -v "$PWD/<repo>":/repo --workdir /repo rhysd/actionlint:latest`) + `npm run e2e` (all tests) **twice** after the last code commit (2nd with `E2E_BACKEND_LOGS=1` + log grep).
2. Fresh clones of both repos side by side (scratchpad, branch `feature/phase-11-templates-billing`) → `npm ci` → all checks **without `.env`** → `gen:api` no diff → tests → E2E once → delete the clones.
3. Secret scan (grep + gitleaks one-off image `zricethezav/gitleaks:latest detect --source /repo --config /repo/.gitleaks.toml --redact --no-banner`) both repos; money-writes test; `npm audit` both (record; the Phase 10 `ip-address` moderate advisory via `express-rate-limit` is known).
4. Fill the sign-off §Verification; commit (backend `docs: mark phase 11 complete [P11-B3-DONE]`; a frontend docs commit with the same tag if its CHANGELOG changed); `infra:down` (only `cav-*` containers). No push / merge.
5. **Final report (Hinglish):**
   - per task ✅ / ⚠️ / ❌, `git log` of both repos, deviations, verification;
   - tests before → after + coverage + gates, hardening + bundle numbers, real bugs found + fixed, sign-off status;
   - what the owner must still provide (the official INR rate card, the credit line in INR) and what is needed for the real-WABA check (Phase 13);
   - open items for Phases 12 / 13 / 14 / 15 / 20.

---

## 4. FINAL CHECKLIST

**Step 0**

- [ ] `[P11-PLAN]` (plan decisions locked) + `[P11-PROMPT]` commits on `feature/phase-11-templates-billing`

**Batch 1**

- [ ] T11.1 models (templates, rate cards, platform settings, billing daily) + message / ledger / wallet / contact / account / channel fields, migration 0012, limits, env, codes (69), audit (118), notifications (26), WS, permissions (2), jobs + schedules
- [ ] T11.2 MetaClient templates CRUD / paging / example upload / pricing analytics, template payloads, error mapping, fake review + pricing knobs, schemas + fixtures, `message_template_components_update` subscribed, reactions finding
- [ ] T11.3 template service (validate, variables, create / edit / submit / delete / sync, call permission template, example media), 4 template webhooks + backfill, `user_preferences`, tier updates, notifications + WS + audit
- [ ] T11.4 rate card + price math + CSV, markup settings + account override, engine hold / capture / release / late charge + `whatsapp` budget, call-hold reaper fix, WhatsApp reaper, status billing hook, money-writes
- [ ] P11-B1-DONE (verify, `dev:templates`, docs)

**Batch 2**

- [ ] T11.5 template sends (variables, header, buttons, rules, errors, rendered text), service-reply holds, start-with-template, price preview, usage counters
- [ ] T11.6 API + OpenAPI, wallet additions, superadmin rates / settings / account override / margin / reconciliation (+ job), INR warning, simulator kinds (58), seed, hardening, ADR 0039, docs, real-WABA checklist §14
- [ ] P11-B2-DONE (verify, manual HTTP check, log grep)

**Batch 3**

- [ ] T11.7 FE foundation (clients, hooks, validators mirror, variables / preview, WS, routes, superadmin nav, `LIVE_PHASE = 11`)
- [ ] T11.8 Templates tab, drawer, builder with preview, call permission template
- [ ] T11.9 Send template dialog, inbox / contact entry points, template bubbles, cost hint
- [ ] T11.10 wallet labels / prices / budget / usage, superadmin WhatsApp billing pages + account region, notifications, dashboard line, bundle check
- [ ] T11.11 Playwright (4 specs, whole suite twice, log grep)
- [ ] T11.12 gap audit, security / money checklist, docs, sign-off
- [ ] P11-B3-DONE (fresh clones, gitleaks, actionlint, `infra:down`, final report)
