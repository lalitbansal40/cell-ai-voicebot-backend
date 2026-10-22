# P9 RUN — WhatsApp Connect: Meta App + Embedded Signup (T9.1 → T9.12) — Autonomous Run Prompt

> **HOW TO RUN — 3 batches, one at a time (same as Phases 3–8). Har batch ke baad report padho, phir agla paste karo.**
>
> **Batch 1 (foundation: models + catalogue, Meta Graph client + fake Meta + signatures, Embedded Signup connect service, webhook pipeline):**
> `cell-ai-voicebot-backend/docs/prompts/PHASE_9_PROMPT.md padho aur STEP 0 + BATCH 1 (P9-SETUP se P9-B1-DONE tak) SAARE tasks step by step autonomously implement karo. Bich me koi question mat poochho, permission mat maango — saare decisions is prompt + PHASE_9_PLAN.md me pre-made hain. Har task ke baad verify (har command alag) + commit (tag [P9-T9.x]). Koi push / merge NAHI. Ant me P9-B1-DONE checkpoint + final report (Hinglish).`
>
> **Batch 2 (health job + Meta callbacks + superadmin tools + simulator, API + OpenAPI + seed + dev script, hardening + ADR + Meta setup guide):**
> `cell-ai-voicebot-backend/docs/prompts/PHASE_9_PROMPT.md padho aur BATCH 2 (T9.5 se P9-B2-DONE tak) SAARE tasks step by step autonomously implement karo. Bich me koi question mat poochho, permission mat maango. Har task ke baad verify + commit (tag [P9-T9.x]). Koi push / merge NAHI. Ant me P9-B2-DONE checkpoint + final report.`
>
> **Batch 3 (frontend foundation + Numbers page + entry points + E2E + sign-off):**
> `cell-ai-voicebot-backend/docs/prompts/PHASE_9_PROMPT.md padho aur BATCH 3 (T9.8 se P9-B3-DONE tak) SAARE tasks step by step autonomously implement karo. Bich me koi question mat poochho, permission mat maango. Har task ke baad verify + commit (tag [P9-T9.x]). Koi push / merge NAHI. Ant me P9-B3-DONE checkpoint + Phase 9 sign-off + final report.`
>
> **Claude Code "accept edits" mode me chalao.** Working directory: `/Users/lalitbansal/Documents/cell-ai-voicebot`. **Docker Desktop chalu hona chahiye** (`open -a Docker`). **Mac charger par aur lid khuli** — lambi test runs `caffeinate -dims` ke saath (machine sleep hone par tests 100–900 s atakte dikhte hain — ye code ka bug nahi, rerun karo).

---

## 0. CONTEXT (verified facts — dobara derive mat karna)

**Phase 8 done, signed off and merged by the project lead:** `main` = Phase 8 tip in both repos — backend `2ea231a [P8-B3-DONE]`, frontend `869b7fb [P8-T8.14]`. (`feature/phase-8-campaigns` points at the same commits.) **No Phase 9 branch exists yet** — STEP 0 creates `feature/phase-9-whatsapp-connect` in the **backend** from `main`; the **frontend** branch is created at T9.8 (`git switch -c feature/phase-9-whatsapp-connect main`). **Never commit to `main`.**

**Untracked files on backend `main` right now** (written by the planning session, not committed): `docs/plans/BUILD_PLAN_V2.md`, `docs/phases/PHASE_9_PLAN.md`, `docs/phases/PHASE_9_TASKS.md`, `docs/prompts/PHASE_9_PROMPT.md` (this file). STEP 0 commits them on the new branch — read them, don't rewrite them.

**Numbers at start:** backend **2203 tests**, gate **95 / 85 / 95 / 95** (`vitest.config.mts`; measured 97.09 / 89.32 / 96.76 / 98.13); frontend **737 tests + 61 Playwright tests**, gate **95 / 90 / 90 / 95** (`vite.config.ts`; measured 95.96 / **90.78** / 93.34 / 96.69). Frontend branches are **0.78 above the gate** → **every new frontend file needs branch-complete tests from the start** (every `if`, `??`, ternary, optional chain, early return, error branch). Catalogues with docs-sync tests: error codes **47**, audit actions **83**, notification types **11**; migrations `0001` … `0009`; queues `system`, `email`, `maintenance`, `contacts`, `billing`, `ai`, `campaigns`.

**Pehle padho (har batch se pehle):** [PHASE_9_PLAN.md](../phases/PHASE_9_PLAN.md) (**source of truth — scope §0, locked decisions §1a–§1q, tasks §3, open-question defaults §7 incl. the 22 Oct owner answers**), [BUILD_PLAN_V2.md](../plans/BUILD_PLAN_V2.md) §3 (WhatsApp decisions), [src/README.md](../../src/README.md), [ADR 0005](../adr/0005-queue-and-background-jobs.md), [ADR 0032](../adr/0032-wallet-billing-payments.md) (webhook + provider pattern), [ADR 0033](../adr/0033-ai-agents-knowledge-tools.md) (secret-box), [PHASE_8_SIGNOFF.md](../phases/PHASE_8_SIGNOFF.md) §5 (deviations + lessons), conventions [api.md](../conventions/api.md), [security.md](../conventions/security.md), [secrets.md](../conventions/secrets.md), [data-model.md](../conventions/data-model.md) (§2.6 Integrations — add the new collections there), [websocket.md](../conventions/websocket.md), [error-codes.md](../conventions/error-codes.md), [audit.md](../conventions/audit.md), [definition-of-done.md](../conventions/definition-of-done.md).

**What exists (use it, don't rebuild):**

| Area                   | Provides                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Webhook + raw body     | `src/app.ts` mounts `raw({ type: 'application/json', limit })` for the Razorpay path **before** `json()`; `src/modules/payments/webhooks.routes.ts` / `.service.ts` (signature, event id idempotency, `payment-event.model.ts`) — copy the pattern for `/api/v1/webhooks/meta`                                                              |
| Provider pattern       | `src/core/payments/{types,index,fake.provider,razorpay.provider}.ts` — interface + fake + real + `create…Provider(env)` factory; `hmacHex`, `safeEqualHex` (constant time); real provider tested against a local `node:http` stub (`tests/payments/providers.test.ts`)                                                                      |
| Secrets at rest        | `src/core/ai/secret-box.ts` — `secretBoxKey(env)`, `seal(key, plain)`, `open(key, sealed)`, `secretHint`; uses `ENCRYPTION_KEY` (required in production)                                                                                                                                                                                    |
| Env                    | `src/config/env.ts` (schema + derived values + production `check()` rules + `env.test.ts`), `tests/config/env-docs.test.ts` (every key in `.env.example` uncommented as `KEY=` **and** in the README env table)                                                                                                                             |
| Limits                 | `src/config/limits.ts` (`AUTH_RATE_LIMIT`, `CAMPAIGN_LIMITS`, …)                                                                                                                                                                                                                                                                            |
| Queues / jobs          | `src/core/queues/{names,queue-factory}.ts` (`createQueue`, `createWorker`, `QUEUE_DEFAULT_JOB_OPTIONS`), workers in `src/core/queues/workers/*.worker.ts`, cron list `MAINTENANCE_SCHEDULES` in `maintenance.worker.ts`, worker start + `lifecycle.onShutdown(name, fn, order)` in `src/server.ts`                                          |
| Rate limits            | `src/shared/middlewares/rate-limit.ts` `createRateLimiter` (Redis store, key prefixes `rl:*`)                                                                                                                                                                                                                                               |
| Realtime               | `src/core/realtime/events.ts` (`WsEventMap`), `notify.ts` `notifyAccount(accountId, type, data)`; frontend `src/services/realtime/events.ts` mirrors the map                                                                                                                                                                                |
| Notifications / email  | `src/modules/notifications/notifications.service.ts` `notify(input)`, `usersWithPermission`, `superadmins`, `notifyPlatform`; `NOTIFICATION_TYPES` in `src/db/models/notification.model.ts`; email templates `src/core/email/templates/*` (`renderTemplate`, `EmailTemplateVars`)                                                           |
| Audit                  | `src/modules/audit/audit-actions.ts` `AUDIT_ACTIONS` + `auditRequest`, system actor, "both sides" helper used by admin actions                                                                                                                                                                                                              |
| RBAC                   | `src/modules/rbac/permissions.ts`, `system-roles.ts` (+ snapshot test), `roles.service.ts` `syncSystemRoles()` (called from migrations)                                                                                                                                                                                                     |
| Tenancy                | `src/db/plugins/tenant.ts` `tenantPlugin`, `tenantFilter(req)`, `toObjectId`; `tests/security/tenant-scope.test.ts` (models must declare `accountId` or be listed in `NOT_TENANT_SCOPED` with a reason)                                                                                                                                     |
| Mock APIs / dev routes | `src/routes.ts` mounts `/mock` when `env.MOCK_APIS_ENABLED` (false in production) — mount the dev Meta simulator the same way                                                                                                                                                                                                               |
| Superadmin             | `src/modules/admin/*` (account detail JSON, both-sides audit, force actions), frontend `src/pages/admin/AdminAccountDetailPage.tsx` (+ `LimitsCard` lazy pattern from Phase 8)                                                                                                                                                              |
| OpenAPI                | zod-to-openapi registry; **schemas must be imported in `src/openapi.ts`** (Phase 8 bug `9222044`); `npm run gen:openapi` + `openapi:check`; frontend `npm run gen:api`                                                                                                                                                                      |
| Seed / dev scripts     | `scripts/db-seed.ts` + `seed-*.ts` (idempotent), `scripts/dev-campaign.ts` (dev-only script pattern, refuses production, prints counts only)                                                                                                                                                                                                |
| Frontend               | nav `src/layout/nav-config.ts` (`LIVE_PHASE = 8`; **Reports `phase: 9` and Integrations `phase: 10` must be renumbered to 14 / 15**), lazy routes `src/app/routes.tsx`, test helpers `src/test/{auth,render,realtime}.ts*`, fake-provider UI precedent `src/features/wallet/AddMoneyDialog.tsx` ("Test payment" when `provider === 'fake'`) |
| E2E                    | `e2e/helpers.ts` (`signUpOwner`, `signIn`, `signInAsSuperadmin`, `openAdminAccount`), `e2e/contacts.ts` (`inviteMember`), `playwright.config.ts` backend env (add WhatsApp env there), `E2E_FRONTEND_PORT=3150`                                                                                                                             |

**Reference code (READ ONLY — never modify, never copy credentials):** `/Users/lalitbansal/Documents/Autochatix/AutoChatix-backend/src/controllers/channel.controller.ts` (`embeddedSignupChannel` 3-step WABA discovery, `subscribeWaba`, `registerWebhook`, `getCallingSettings`, error `141000`), `.../controllers/webhook.controller.ts` (routing, call events), `.../services/wallet.service.ts` (hold → capture on DELIVERED / READ, release on FAILED — for Phase 11), `/Users/lalitbansal/Documents/Autochatix/AutoChatix-frontend/src/pages/Channels.tsx` (Meta SDK loader, `WA_EMBEDDED_SIGNUP` listener, `FB.login` options), `.../AutoChatix-backend/META_APP_REVIEW.md` (rejection lessons). **Bugs to avoid:** AutoChatix used `featureType: 'whatsapp_business_app_onboarding'` for everyone (coexistence → calling impossible); trusted browser-sent WABA / phone ids; stored tokens in plain text; `console.log` of Meta responses.

---

## 1. LOCKED DECISIONS (exact literals — PHASE_9_PLAN §1 has the prose)

**Owner decisions (22 Oct 2026):** (1) Meta billing **both ways per account** — `platform` (default; our Solution Partner credit line is attached to the customer's WABA; Meta bills us; wallet charges come in Phase 11) or `customer` (customer's own payment method in WhatsApp Manager). Superadmin sets it per account **before** connecting (a credit line cannot be removed from a WABA once attached). (2) **Coexistence** (WhatsApp Business app) numbers fully supported: messages the business sends from its own phone (`smb_message_echoes`), chat history (`history`) and phone contacts (`smb_app_state_sync`) are subscribed, requested right after connect and **stored** (Phase 10 shows them in the chat). (3) Connect / disconnect / settings: **owner + admin only**. (4) **Meta developer app is NOT created in Phase 9** — everything runs on the fake Meta provider; the real switch is env-only, documented in `docs/setup/meta-whatsapp.md`.

**Env (all in `env.ts` + `.env.example` + README table + tests):**

| Key                         | Type / default                                  | Production rule (only when `WHATSAPP_ENABLED=true`)                    |
| --------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------- |
| `WHATSAPP_ENABLED`          | `true \| false`, default `true`                 | —                                                                      |
| `META_PROVIDER`             | `fake \| meta`, default `fake` (non-production) | must be `meta`                                                         |
| `META_APP_ID`               | digits                                          | required                                                               |
| `META_APP_SECRET`           | string                                          | required, ≥ 32 chars, not a placeholder (`change-me…`)                 |
| `META_ES_CONFIG_ID`         | digits                                          | required                                                               |
| `META_WEBHOOK_VERIFY_TOKEN` | string, dev default `dev-meta-verify-token`     | required, ≥ 24 chars, not a placeholder                                |
| `META_GRAPH_VERSION`        | `^v\d+\.\d+$`, default `v23.0`                  | —                                                                      |
| `META_GRAPH_BASE_URL`       | URL, default `https://graph.facebook.com`       | must equal the default                                                 |
| `META_CREDIT_LINE_ID`       | digits, optional (fake uses `fake_ecl_1`)       | checked when an attach runs (not at boot) → `action_needed` if missing |
| `META_SYSTEM_USER_TOKEN`    | string, optional                                | same as above; never logged                                            |
| `FAKE_META_APP_SECRET`      | string, dev default `dev-fake-meta-app-secret`  | must not be set                                                        |

`.env.example`: every key present as `KEY=` (placeholders / empty, with comments "set at Meta setup — docs/setup/meta-whatsapp.md"). **No AutoChatix values anywhere.** Playwright backend env: `WHATSAPP_ENABLED=true`, `META_PROVIDER=fake`.

**`WHATSAPP_LIMITS`** (`config/limits.ts`): `maxChannelsPerAccount: 10`, `labelMax: 60`, `webhookMaxBytes: 3 * 1024 * 1024`, `webhookEventTtlDays: 7`, `deferredEventTtlDays: 30`, `webhookProcessAttempts: 5` (exponential, base 30 s), `graphTimeoutMs: 10_000`, `graphRetries: 3`, `graphRetryBaseMs: 500`, `connectPerHourPerAccount: 10`, `syncPerMinutePerChannel: 1`, `historyMax: 50`, `deletionStatusTtlDays: 365`, `signedRequestMaxAgeSec: 86_400`, `fakeCodeTtlSec: 600`, `lastEventThrottleMs: 60_000`, `workerConcurrency: 10`, `connectLockTtlMs: 60_000`. Frontend: `SESSION_INFO_WAIT_MS = 3_000`, `META_SDK_TIMEOUT_MS = 15_000`.

**Collections (data-model.md §2.6):**

- **`whatsappChannels`** (`tenantPlugin`; model file `whatsapp-channel.model.ts`; const arrays exported: `WA_CHANNEL_STATUSES = ['connecting','connected','action_needed','needs_reconnect','restricted','disconnected']`, `WA_MODES = ['cloud_api','coexistence']`, `WA_QUALITY = ['GREEN','YELLOW','RED','UNKNOWN']`, `WA_LIMIT_TIERS = ['TIER_50','TIER_250','TIER_1K','TIER_10K','TIER_100K','TIER_UNLIMITED']`, `META_PAYERS = ['platform','customer']`, `SYNC_STATUSES = ['not_requested','requested','received','declined','failed']`). Fields exactly as PHASE_9_PLAN §1e (+ `creditLine`, `paymentMethodOk`, `coexistence`). `tokenSealed`, `registration.pinSealed` → `select: false`. Indexes: `{ phoneNumberId: 1 }` **unique partial** `{ status: { $in: [all except 'disconnected'] } }`, `{ accountId: 1, status: 1 }`, `{ wabaId: 1 }`, `{ metaUserId: 1 }`.
- **`metaWebhookEvents`** (not tenant-required; add to `NOT_TENANT_SCOPED` with reason "Meta webhooks — account set after routing"): `key` (unique), `field`, `object`, `wabaId`, `phoneNumberId`, `accountId?`, `channelId?`, `payloadSealed` (`select: false`), `status` (`received \| processed \| deferred \| ignored \| failed`), `attempts`, `error` (no PII), `receivedAt`, `processedAt`, `consumedAt?`, `expiresAt` (TTL index). Indexes: `{ key: 1 }` unique, `{ status: 1, receivedAt: 1 }`, `{ channelId: 1, field: 1, receivedAt: -1 }`, `{ field: 1, status: 1, receivedAt: 1 }` (deferred consumers), `{ expiresAt: 1 }` TTL `expireAfterSeconds: 0`.
- **`metaDeletionRequests`** (`NOT_TENANT_SCOPED`, reason "Meta user-level request"): `confirmationCode` (unique, 16 url-safe chars), `metaUserId`, `status` (`received \| completed`), `channelsAffected`, `receivedAt`, `completedAt`, `expiresAt` TTL.
- **Account addition:** `whatsapp: { metaPayer: 'platform' \| 'customer' }` (default `platform`, backfilled by the migration).

**Error codes (+7 → 54):** `WHATSAPP_NOT_CONFIGURED` 503 · `WHATSAPP_SIGNUP_FAILED` 422 (details `[{ path: 'step', message }]`) · `WHATSAPP_NUMBER_IN_USE` 409 · `WHATSAPP_CHANNEL_LIMIT` 409 · `WHATSAPP_CHANNEL_NOT_READY` 409 · `META_API_ERROR` 502 (details: Meta `code`, `subcode`, `fbtraceId` — never tokens / URLs with tokens) · `META_SIGNATURE_INVALID` 401.

**Audit actions (+12 → 95):** `whatsapp.channel_connected`, `whatsapp.channel_reconnected`, `whatsapp.channel_setup_failed`, `whatsapp.channel_registered`, `whatsapp.credit_line_attached`, `whatsapp.channel_renamed`, `whatsapp.channel_disconnected`, `whatsapp.channel_status_changed` (system actor), `whatsapp.billing_mode_changed` (superadmin, both sides), `whatsapp.event_replayed` (superadmin), `meta.deauthorized` (system), `meta.data_deletion_requested` (system). Meta: `channelId`, `mode`, `phoneLast4`, `wabaId`, `status`, `reasonCode`, `manual?`, `metaPayer?` — **never** tokens, PINs, codes, customer names / phones.

**Notification types (+6 → 17):** `whatsapp.channel_needs_reconnect` (+ email), `whatsapp.channel_restricted` (+ email), `whatsapp.quality_low`, `whatsapp.name_approved`, `whatsapp.name_rejected`, `whatsapp.channel_disconnected_by_admin` (+ email). Recipients: users with `whatsapp.manage` (owners + admins). Once per transition (not every health run).

**Permissions:** `whatsapp.read` (owner, admin, manager, agent, viewer), `whatsapp.manage` (owner, admin). Migration calls `syncSystemRoles()`.

**WS event:** `whatsapp.channel.updated` → `{ channelId: string; status: WaChannelStatus; qualityRating: string; messagingLimitTier: string | null; nameStatus: string | null }` to the account (backend `events.ts`, websocket.md §5, frontend `events.ts`).

**Queue + jobs:** queue `whatsapp` (add to `QUEUES`); job `webhook.process` (job id `wa-event-<eventId>`, attempts 5, exponential 30 s); repeatable `whatsapp-health` via `upsertJobScheduler` (`0 22 * * *` UTC, id `whatsapp-health`); `whatsapp-events-purge` added to `MAINTENANCE_SCHEDULES` (`40 5 * * *`, deletes expired / consumed events beyond TTL as a backup to the TTL index); job ids never contain `:` (BullMQ rule — Phase 8 used `-`). Worker `src/core/queues/workers/whatsapp.worker.ts`, started in `server.ts` when `WHATSAPP_ENABLED`, `onShutdown('whatsapp', …)` before queues close.

**Module layout:** `src/core/meta/` — `types.ts` (`MetaClient`, results, `MetaApiError`), `graph.client.ts`, `fake.client.ts`, `index.ts` (`createMetaClient(env, deps)`), `signature.ts`, `schemas.ts`, `errors.ts` (map Graph errors). `src/modules/whatsapp/` — `whatsapp.schema.ts`, `whatsapp.service.ts` (connect / retry / pin / sync / rename / disconnect / list / get), `channel-json.ts`, `channel-status.ts` (transitions + history + WS + notifications), `billing-setup.ts` (credit line / payment method), `coexistence.ts` (sync requests + event effects), `webhooks.routes.ts`, `webhooks.service.ts` (verify, store, enqueue), `webhook-handlers.ts` (Phase 9 handlers + `registerDeferredField` / `listDeferred` / `markConsumed` API for later phases), `health.ts`, `meta-callbacks.routes.ts` + `meta-callbacks.service.ts`, `whatsapp-admin.routes.ts` + service, `dev-simulator.routes.ts` + `simulator.ts`, `whatsapp.routes.ts`. Fixtures `tests/fixtures/meta/*.json`. Tests `tests/whatsapp/*.test.ts` + unit tests next to pure code.

**MetaClient methods (exact Graph calls, `{v}` = `META_GRAPH_VERSION`):**

| Method                                         | Call                                                                                                                                                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `exchangeCode(code)`                           | `GET /{v}/oauth/access_token?client_id&client_secret&code` → `{ accessToken, tokenType }`                                                                                                                                                        |
| `debugToken(token)`                            | `GET /{v}/debug_token?input_token=<token>&access_token=<appId>\|<appSecret>` → `{ isValid, type, userId, expiresAt, scopes, grantedWabaIds }`                                                                                                    |
| `listOwnedWabas(token)`                        | `GET /{v}/me/whatsapp_business_accounts?fields=id,name` (fallback)                                                                                                                                                                               |
| `listBusinessesWithWabas(token)`               | `GET /{v}/me/businesses?fields=id,name,owned_whatsapp_business_accounts{id,name}` (fallback)                                                                                                                                                     |
| `getWaba(token, wabaId)`                       | `GET /{v}/{waba}?fields=id,name,currency,timezone_id,message_template_namespace,account_review_status,business_verification_status,owner_business_info,primary_funding_id`                                                                       |
| `listPhoneNumbers(token, wabaId)`              | `GET /{v}/{waba}/phone_numbers?fields=id,display_phone_number,verified_name,status`                                                                                                                                                              |
| `getPhoneNumber(token, phoneId)`               | `GET /{v}/{phone}?fields=id,display_phone_number,verified_name,name_status,new_name_status,quality_rating,messaging_limit_tier,code_verification_status,platform_type,throughput,account_mode,status,is_official_business_account,is_on_biz_app` |
| `subscribeApp` / `unsubscribeApp`              | `POST` / `DELETE /{v}/{waba}/subscribed_apps`                                                                                                                                                                                                    |
| `getTokenOwner(token)`                         | `GET /{v}/me?fields=id` (System User id, cached in memory)                                                                                                                                                                                       |
| `assignSystemUser(token, wabaId, userId)`      | `POST /{v}/{waba}/assigned_users?user=<id>&tasks=['MANAGE']`                                                                                                                                                                                     |
| `attachCreditLine(wabaId, currency)`           | `POST /{v}/{META_CREDIT_LINE_ID}/whatsapp_credit_sharing_and_attach?waba_id&waba_currency` (System User token) → `{ allocationConfigId }`                                                                                                        |
| `getAllocation(allocationId)`                  | `GET /{v}/{allocation}?fields=receiving_credential` (optional verify)                                                                                                                                                                            |
| `registerPhone(token, phoneId, pin)`           | `POST /{v}/{phone}/register` `{ messaging_product: 'whatsapp', pin }`                                                                                                                                                                            |
| `requestCoexistenceSync(token, phoneId, kind)` | `POST /{v}/{phone}/smb_app_data` `{ messaging_product: 'whatsapp', sync_type: 'smb_app_state_sync' \| 'history' }`                                                                                                                               |

Auth: `Authorization: Bearer <token>` for everything except `oauth/access_token` and `debug_token` (query-string credentials Meta requires — those URLs are **never** logged or put into errors). Retry (3, backoff `500 ms × 2^n` + jitter) on network errors, HTTP 5xx, Graph codes `1`, `2`, `4`, `17`, `32`, `613`, `80007`; no retry on others. `190` (or `OAuthException` subcodes `460`, `463`, `467`) → `MetaApiError` with `tokenInvalid: true`. Error message scrubbed (`/access_token=[^&\s]+/g`, `/client_secret=[^&\s]+/g`, `/input_token=[^&\s]+/g` → `***`).

**Embedded Signup (frontend contract):** SDK `https://connect.facebook.net/en_US/sdk.js` (script id `facebook-jssdk`, lazy, once); `FB.init({ appId, autoLogAppEvents: true, xfbml: true, version: graphVersion })`; `FB.login(cb, { config_id, response_type: 'code', override_default_response_type: true, extras: { setup: {}, sessionInfoVersion: 3, ...(mode === 'coexistence' ? { featureType: 'whatsapp_business_app_onboarding' } : {}) } })`; `message` listener accepts origins `https://www.facebook.com` and `https://web.facebook.com` only, safe JSON parse, `type === 'WA_EMBEDDED_SIGNUP'`, events `FINISH` / `FINISH_ONLY_WABA` / `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` (treat any `FINISH*` as finish) → `{ waba_id, phone_number_id }`, `ERROR` → `error_message`, `CANCEL` (or any other) → `current_step`. Code → backend **immediately** (≤ `SESSION_INFO_WAIT_MS` wait for session info). Fake mode: **Test signup dialog** builds `code = 'fake.' + base64url(JSON.stringify({ businessName, phone, displayName, mode, outcome }))` + session info.

**Connect order (backend, exact — plan §1d):** guard → exchange → debug token (scopes `whatsapp_business_management` required, `whatsapp_business_messaging` required) → resolve WABA (session id ∈ granted ids → else single granted id → else fallbacks, still checked against granted ids when the list is non-empty) → resolve phone (session id ∈ WABA numbers → else the single number → none ⇒ `action_needed` "Add a phone number in WhatsApp Manager, then Sync") → duplicate check (other account active ⇒ `WHATSAPP_NUMBER_IN_USE`, nothing saved; same account ⇒ reconnect) → details → subscribe → **billing setup** (`platform`: `getTokenOwner(systemUserToken)` → `assignSystemUser` → `attachCreditLine` → optional `getAllocation`; `customer`: `paymentMethodOk = Boolean(waba.primary_funding_id)`) → **cloud_api**: register with a fresh 6-digit PIN if `phone.status` ≠ `CONNECTED` (`133005` ⇒ `action_needed` code `pin_required`) / **coexistence**: request `smb_app_state_sync` then `history` sync (failures ⇒ `coexistence.*Sync = 'failed'`, channel stays `connected`) → save → audit → WS. Any failure after a valid token ⇒ save `action_needed` with sealed token + `statusReason { step, code, message }`; `retry-setup` resumes from the failed step (finished steps skipped). Redis lock `wa-connect-<phoneNumberId>` + unique index for races.

**Webhook (exact):** `GET /api/v1/webhooks/meta` → `hub.mode === 'subscribe'` && constant-time `hub.verify_token` ⇒ `200 text/plain <hub.challenge>` else `403`. `POST` raw body ≤ 3 MB; header `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(appSecret, rawBody)>` (fake: `FAKE_META_APP_SECRET`) ⇒ bad / missing `401 META_SIGNATURE_INVALID`; `object !== 'whatsapp_business_account'` ⇒ `200` ignored; per `entry[].changes[]`: key = sha256(`object|entry.id|field|stableStringify(value)`) → insert-or-skip → enqueue → respond `200 { received: n }`; Mongo / Redis failure ⇒ `503`. Phase 9 handlers: `account_update`, `phone_number_quality_update`, `phone_number_name_update`, `business_capability_update` (+ coexistence effects of `smb_message_echoes`, `history`, `smb_app_state_sync`); everything else `deferred`. `whatsapp.WEBHOOK_FIELDS` const (setup doc + tests): `messages`, `calls`, `account_update`, `phone_number_quality_update`, `phone_number_name_update`, `business_capability_update`, `message_template_status_update`, `message_template_quality_update`, `template_category_update`, `user_preferences`, `security`, `history`, `smb_app_state_sync`, `smb_message_echoes`.

**Fake Meta (exact knobs):** single-use codes (Redis `fake-meta-used-<sha256>`, TTL 600 s); ids `fake_waba_<h>`, `fake_phone_<h>`, `fake_biz_<h>`, `fake_alloc_<h>` (h = first 12 hex of sha256(businessName|phone)); details: quality `GREEN`, tier `TIER_1K`, name `APPROVED` (`PENDING_REVIEW` if the display name contains "pending"), `is_on_biz_app = mode === 'coexistence'`, `status` `PENDING` until registered then `CONNECTED`, currency `INR` (`XYZ` if business name contains "foreign"), `primary_funding_id` absent until simulator `payment_method_added`; error knobs: phone ending `00001` ⇒ register `133005`, phone ending `00002` ⇒ subscribe Graph 500 (×4, so retries exhaust), business name containing "other partner" ⇒ credit line "already attached to another partner" error, outcome `error` ⇒ exchange fails, `only_waba` ⇒ WABA without numbers; token revocable by simulator `token_revoked` (then `debugToken.isValid = false` and calls throw `190`).

**Simulator** (`POST /api/v1/dev/meta/webhooks` `{ channelId, kind }` — mounted only when `!production && MOCK_APIS_ENABLED`; caller needs `whatsapp.manage` on that channel or superadmin): kinds `quality_downgrade`, `quality_upgrade`, `flagged`, `name_approved`, `name_rejected`, `restricted`, `unrestricted`, `token_revoked`, `inbound_text`, `status_delivered`, `echo_text`, `history_chunk`, `history_declined`, `contacts_sync`, `payment_method_added` → Meta-shaped payload (same shapes as the fixtures) **signed and POSTed to our own `/api/v1/webhooks/meta` handler in-process** (no shortcut around signature / store / queue).

**Frontend literals:** nav item `{ key: 'whatsapp', label: 'WhatsApp', path: '/whatsapp', icon: ChatOutlined, permission: 'whatsapp.read', phase: 9 }`, Reports `phase: 14`, Integrations `phase: 15`, `LIVE_PHASE = 9`. Routes `/whatsapp` → redirect `/whatsapp/numbers` (lazy chunk), public `/data-deletion`. Accessible names used by tests / E2E: button **Connect WhatsApp**, dialog **Connect WhatsApp**, radio **New or Cloud API number (recommended)** / **Number on the WhatsApp Business app**, dialog **Test signup (Meta is simulated)**, button **Finish signup**, region **WhatsApp number <label>** per card, chips **Connected** / **Action needed** / **Needs reconnect** / **Restricted** / **Disconnected**, buttons **Sync now**, **Retry setup**, **Enter PIN**, **Reconnect**, **Disconnect**, **Rename**, drawer **Number details**, menu **Send test event** (dev only).

---

## 2. RULES OF ENGAGEMENT

1. **No questions / no permission requests.** Safe, convention-consistent choice → report as a deviation and add it to the plan changelog.
2. **Git:** branch `feature/phase-9-whatsapp-connect` (both repos). One commit per task per repo (Conventional Commit + tag). Hooks must pass (**no `--no-verify`**, no `--force`). **No push / merge / tag**, never commit on `main`. Footer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Commits **sequentially, one repo at a time**. Commit body: **no line may start with `word:`** (commitlint reads it as a footer). Write the message to a file and use `git commit -F`.
3. **Verify after every task — each command separately, read output + exit code.** **Never chain `git commit` after checks with `;` or `&&`** (happened in Phase 7 and again in Phase 8).
   - Backend: `npm run lint` · `npm run format:check` · `npm run typecheck` · `npm run test:coverage -- --maxWorkers=2` · `npm run build` · `npm run openapi:check` (stage `openapi/openapi.json` first)
   - Frontend: `npm run lint` · `npm run format:check` · `npm run typecheck` · `npx tsc -p tsconfig.e2e.json --noEmit` · `npm run test:coverage -- --maxWorkers=2` · `npm run build` (+ `npm run e2e` from T9.11 on: infra up, this project's dev servers stopped, `E2E_FRONTEND_PORT=3150`)
   - Long runs in the background with `caffeinate -dims`; tests taking hundreds of seconds → machine slept, rerun.
4. **Coverage gates stay green** — add tests, never lower thresholds, never raise test timeouts (split or make deterministic instead).
5. **Tests in every task** — unit + integration (supertest + real Mongo replica set + Redis with a unique prefix), **tenant isolation for every route** (another account's channel id → 404, never listed), permission matrix per role (owner / admin / manager / agent / viewer + superadmin + impersonating superadmin), suspended account (writes 403), `WHATSAPP_ENABLED=false` (503).
6. **WhatsApp / Meta hard rules:**
   - **No network in tests.** The Graph client is tested against a local `node:http` stub; everything else uses the fake client. Never call `graph.facebook.com` from tests or scripts.
   - **Secrets never leave the server:** business tokens, System User token, app secret, verify token, PINs, signup codes → never in API responses, WS, audit meta, notifications, emails, logs, thrown error messages, OpenAPI examples. A test captures pino output for a full connect + 20 webhook events and asserts no token / code / PIN / phone / payload text appears.
   - **Browser ids are hints** — WABA / phone ids from the browser are always verified against `debug_token` granted ids.
   - **Constant-time compares** for signatures and the verify token; raw body only on the Meta webhook path.
   - **Never deregister** a customer's number; disconnect only unsubscribes (and only when no active channel uses that WABA).
   - **Webhook payloads** sealed at rest, TTL'd, never logged; only metadata in superadmin lists.
   - **Meta field names** come from Meta's documented sample payloads (fixtures); unknown extra keys are allowed (zod `.passthrough()` / `.loose()` on Meta objects), missing required keys → event `failed` with a schema error (no crash).
   - **AutoChatix is read-only reference** — no files modified there, no credentials copied.
7. **PII:** WhatsApp numbers appear in full only in the channel view (it's the business's own number); customers' numbers from webhooks never appear outside sealed payloads in Phase 9.
8. **Every new env var** → `env.ts` + `.env.example` (`KEY=`) + README env table + production rule test (env-docs test enforces the first three).
9. **OpenAPI:** every route registered and its schemas imported in `src/openapi.ts` → `gen:openapi` → commit `openapi/openapi.json` with the task; frontend `gen:api` at T9.8 and whenever the spec changes.
10. **Docs in the same commit** (src/README.md rows, data-model.md, websocket.md, audit.md, error-codes.md, api.md, security.md, secrets.md, compliance-notes.md as relevant).
11. **Docker:** only `npm run infra:*` (containers `cav-mongo` :27018, `cav-redis`, `cav-mailpit`); gitleaks / actionlint via one-off `docker run --rm`; never stop / remove other containers or volumes.
12. **Real bugs** found during manual checks / E2E → reproduce, prove the regression test fails without the fix, fix, separate `fix(...)` commit, note in the report and the plan changelog.
13. **Prettier may reformat files** (lint-staged) — re-read before scripted exact-string edits; markdown tables get re-padded (edit line-wise).
14. **Frontend lessons (Phases 5–8):** MUI `Switch` role `switch`; dialogs → `findByRole`; fast-refresh rule (non-component exports in `.ts` files); React compiler lint (no setState in effects for derived state); a page that shows a server result listens to the WS event **and** polls while not final (live updates can be off — Phase 8 `8e6d32e`); a page subtitle never nests block elements in a `<p>` (`PageHeader` is fixed); full page reloads end an impersonation (E2E navigates client-side); E2E helpers wait for the server response of a start action before typing (Phase 8 `869b7fb`).
15. **Never kill other projects' processes** (port 3100 belongs to another project); only kill this project's own `tsx src/index.ts` / scripts.

---

## 3. RESUME SAFETY

- Both repos: `git branch --show-current` → `feature/phase-9-whatsapp-connect` (frontend from T9.8); `git log --oneline -25`; continue after the last `[P9-…]` commit.
- `npm run infra:up` → `npm ci` (both) → `npm run db:migrate` (dev DB) → lint → typecheck → `test:coverage` green before continuing.
- Batch 2 requires `[P9-B1-DONE]`; Batch 3 requires `[P9-B2-DONE]` — if missing, stop and report.
- A half-done task (uncommitted files) → read `git status` / `git diff`, finish, verify, commit — never discard work without reading it.

---

## STEP 0 — P9-SETUP (before T9.1)

1. Backend: `git status` must show only the 4 untracked planning files listed in §0 (anything else → stop and report). `git switch -c feature/phase-9-whatsapp-connect main`.
2. Commit 1: `docs/plans/BUILD_PLAN_V2.md` + `docs/phases/PHASE_9_PLAN.md` + `docs/phases/PHASE_9_TASKS.md` → `docs(plans): add build plan v2 and phase 9 detailed plan [P9-PLAN]` (run `npm run format:check` first).
3. Commit 2: `docs/prompts/PHASE_9_PROMPT.md` → `docs(prompts): add phase 9 run prompt [P9-PROMPT]`.
4. Old `docs/plans/BUILD_PLAN.md`: add one line under its Phase 9 heading "Superseded — see BUILD_PLAN_V2.md (Phase 9 = WhatsApp Connect)" and in its changelog; include it in commit 1.

---

# ═══════════ BATCH 1 — WhatsApp foundation (T9.1 → T9.4) ═══════════

## T9.1 — Models, migration 0010, limits, catalogue → `feat(whatsapp): add whatsapp channel and meta webhook models with whatsapp catalogue [P9-T9.1]`

1. Models `whatsapp-channel.model.ts`, `meta-webhook-event.model.ts`, `meta-deletion-request.model.ts` (§1 Collections; const arrays exported from the model files as the single source for zod / OpenAPI); `Account.whatsapp.metaPayer` (default `platform`).
2. Migration **`0010-whatsapp`**: create collections + indexes (incl. the partial unique and TTL indexes), backfill `account.whatsapp.metaPayer = 'platform'` where missing, `syncSystemRoles()` (adds `whatsapp.read` / `whatsapp.manage`); `down` drops the three collections' indexes, unsets `whatsapp`, re-syncs roles without the permissions. Registry + up / down / up test (extend the migrations test like Phase 8).
3. `WHATSAPP_LIMITS` (§1) in `config/limits.ts`.
4. Env (§1 table) with defaults + production rules + `env.test.ts` rows (each rule: missing / placeholder / short / wrong provider / `WHATSAPP_ENABLED=false` skips the rules) + `.env.example` + README env table.
5. Error codes +7 (→ 54), audit actions +12 (→ 95) with meta shapes, `NOTIFICATION_TYPES` +6 (→ 17), email templates (`whatsapp.needs_reconnect`, `whatsapp.restricted`, `whatsapp.admin_disconnected` — plain, no phone numbers of customers, the business number as last 4), WS payload type, queue name `whatsapp` — docs-sync tests green.
6. Permissions + role lists + snapshot / matrix test; `tenant-scope.test.ts` `NOT_TENANT_SCOPED` entries with reasons.
7. Docs: data-model.md §2.6 (three collections + Account addition), error-codes.md, audit.md, websocket.md, rbac docs, src/README.md rows.
8. Tests: models (validation, defaults, `select: false` really hides `tokenSealed` / `pinSealed`, indexes exist incl. the partial unique — two active channels with the same `phoneNumberId` → duplicate key; one disconnected + one active → allowed; TTL index present), migration, env, catalogues, permissions.

## T9.2 — Meta core → `feat(meta): add meta graph client, fake meta provider and signatures [P9-T9.2]`

1. `src/core/meta/types.ts` — `MetaClient` (§1 table), result types, `MetaApiError` (`status`, `code`, `subcode`, `type`, `message` (scrubbed), `fbtraceId`, `retryable`, `tokenInvalid`).
2. `graph.client.ts` — `fetch` + `AbortSignal.timeout(graphTimeoutMs)`, Bearer auth, query-credential calls never logged, JSON guard (non-JSON → `META_API_ERROR`), retries (§1), error mapping (`errors.ts`), base URL + version from env, `deps.fetch` injectable.
3. `fake.client.ts` — every knob in §1 "Fake Meta"; state in Redis (used codes, revoked tokens, registered phones, funding flags) with a unique prefix per test; exported `createFakeMetaClient({ redis, prefix, appSecret })`.
4. `signature.ts` — `verifyWebhookSignature(rawBody: Buffer, header: string | undefined, secret: string): boolean` (`sha256=` prefix, hex, constant time, length mismatch false), `signWebhook(rawBody, secret)` (for the simulator / tests), `parseSignedRequest(value, secret, nowSec)` → `{ userId, issuedAt }` or throws (`bad_format`, `bad_signature`, `bad_algorithm`, `expired`), base64url decode.
5. `schemas.ts` — zod for: oauth token, debug token (incl. `granular_scopes[].target_ids`), WABA, phone list, phone, subscribed apps, credit-line attach, allocation, register, sync request, webhook envelope (`object`, `entry[].id`, `entry[].changes[].field`, `.value`), and values of `account_update`, `phone_number_quality_update`, `phone_number_name_update`, `business_capability_update`, `smb_message_echoes`, `history`, `smb_app_state_sync`, `messages` (envelope-level only: `metadata.phone_number_id`), `calls` (envelope-level only). Meta objects allow unknown keys.
6. Fixtures `tests/fixtures/meta/*.json` — one per Graph response + one per webhook field above, built from **Meta's documented sample payloads** with test values (`+91 90000 …`, `Test Business`); `tests/fixtures/meta/README.md` lists the source doc page per file.
7. `createMetaClient(env, { redis, logger, fetch? })` factory (fake vs graph).
8. Tests: graph client vs stub server (each method's path / method / query / body / auth, retries on 5xx + rate-limit codes with backoff — fake timers, no retry on 4xx, timeout, `190` → `tokenInvalid`, scrubbed messages: thrown error string never contains the token / app secret / code), fake determinism + every knob, signature + signed_request tables, every fixture parses.

## T9.3 — Channel service → `feat(whatsapp): add embedded signup connect, sync and disconnect [P9-T9.3]`

1. `whatsapp.schema.ts` — bodies: signup `{ code: string(1..2048), sessionInfo?: { wabaId?: /^\d+$|^fake_/, phoneNumberId?: same }, mode: 'cloud_api' | 'coexistence' }`, rename `{ label: 1..60 }`, pin `{ pin: /^\d{6}$/ }`; params; list query.
2. `whatsapp.service.ts` — `connect` (§1 "Connect order", Redis lock, partial-failure save, reconnect), `retrySetup` (resume from `statusReason.step`), `submitPin` (register with the given PIN, store sealed), `sync` (one health pass: debug token → details → status / payment method / coexistence statuses), `rename`, `disconnect` (§ plan 1h), `listChannels`, `getChannel` (+ events 24 h count via aggregation, history), internal `getChannelToken(channelId)` (opens the seal; throws `WHATSAPP_CHANNEL_NOT_READY` unless `connected` / `action_needed`).
3. `channel-status.ts` — `transition(channel, to, reason, actor)` (writes `history` ≤ 50, `whatsapp.channel.updated` WS, audit `whatsapp.channel_status_changed` for system actors, notifications per §1 types once per transition), `markNeedsReconnect` used by every Graph call that returns `tokenInvalid`.
4. `billing-setup.ts` — platform credit line (§1 order; missing `META_CREDIT_LINE_ID` / `META_SYSTEM_USER_TOKEN` in `meta` mode → `action_needed` "Platform credit line isn't configured on this server"), customer payment method flag; audit `whatsapp.credit_line_attached`.
5. `coexistence.ts` — `requestSyncs(channel)` (contacts then history; statuses `requested` / `failed`), `retrySync`.
6. `channel-json.ts` — list item + detail views (no secrets; `billing: { metaPayer, creditLine: { status }, paymentMethodOk }`, `coexistence` statuses, `webhook.lastEventAt`, `history`).
7. Tests (fake + stub cases): happy paths both modes; session info missing → discovery; session WABA not in granted ids → `WHATSAPP_SIGNUP_FAILED`; missing scope → refused; `FINISH_ONLY_WABA` → action needed → simulator adds number? (fake: call `sync` after the fake WABA gets a number via a test helper) → connected; duplicate in another account → 409 + nothing saved + token not stored; reconnect same account keeps id + history; PIN required → `submitPin` → connected; subscribe fails → action needed → `retrySetup` skips finished steps; credit line attached / unsupported currency / other partner / not configured; customer mode flag; coexistence sync requested / failed → retry; double connect race (two parallel calls → one channel); channel limit; disconnect (unsubscribe only when last user of the WABA; token + PIN cleared; never deregisters — assert the fake saw no deregister call); `tokenInvalid` anywhere → needs reconnect + notification; logs clean.

## T9.4 — Webhook pipeline → `feat(whatsapp): add meta webhook pipeline with channel event handlers [P9-T9.4]`

1. `app.ts`: raw parser for `/api/v1/webhooks/meta` (before `json()`), `WHATSAPP_LIMITS.webhookMaxBytes`; route 404 when `WHATSAPP_ENABLED=false`.
2. `webhooks.routes.ts` + `webhooks.service.ts` — GET verify, POST (§1 "Webhook"): signature (secret from the active provider), parse, split, key, insert-or-skip (sealed payload), enqueue, `200 { received }`, `503` on storage / queue failure, metrics log line `{ received, duplicates, ignored }` only.
3. `whatsapp.worker.ts` + `webhook-handlers.ts` — open payload, route (`metadata.phone_number_id` → channel; else `entry.id` = WABA → channels of that WABA), unknown → `ignored`, handler table:
   - `account_update`: restriction / ban / disable events → `restricted` (+ `restriction`), lifted → `connected` (after a sync), `PARTNER_REMOVED` / app unsubscribed → `needs_reconnect`, `VERIFIED_ACCOUNT` / others → `sync`.
   - `phone_number_quality_update`: `current_limit` → `messagingLimitTier`; quality re-fetched; to `RED` or `FLAGGED` → `whatsapp.quality_low`.
   - `phone_number_name_update`: `APPROVED` → `verifiedName` + `nameStatus`, `whatsapp.name_approved`; `REJECTED` → `whatsapp.name_rejected`; `DEFERRED` → status only.
   - `business_capability_update`: limits snapshot.
   - Coexistence effects + deferred: `smb_message_echoes` → `coexistence.echoesAt`; `history` → `historySync` / `historyProgress` (final chunk → `received`; decline → `declined`); `smb_app_state_sync` → `contactsSync: 'received'` — events stay `deferred` (TTL 30 days).
   - Everything else → `deferred`.
   - `registerDeferredField` / `listDeferred({ field, channelId?, limit, cursor })` / `markConsumed(eventIds)` exported for Phases 10–12 (tests use them).
4. Throttled `channel.webhook.lastEventAt` / `lastField` (once per `lastEventThrottleMs`); retries → `failed` after 5 attempts (error text without PII); `whatsapp-events-purge` maintenance job.
5. Tests: verify challenge (right / wrong token / wrong mode), signature table (valid, tampered byte, missing header, wrong prefix, other secret), > 3 MB → 413, non-WABA object → 200 ignored, same delivery twice → one event / one job, routing by phone id and by WABA id, unknown phone → ignored, each handler with its fixture (status + fields + WS + notification once), deferred storage + `listDeferred` + `markConsumed`, coexistence effects, worker retry → failed, Redis down → 503 (no event lost: retry after recovery stores once), purge job, logs clean.

## P9-B1-DONE — checkpoint → `docs: mark phase 9 batch 1 complete [P9-B1-DONE]`

1. `infra:up` → full backend verify (each command separately).
2. Manual: `scripts/dev-whatsapp.ts` (dev only, refuses production; `npm run dev:whatsapp`): picks / creates a demo account, connects a fake number through the **service layer** (Cloud API + one coexistence), signs and posts 5 webhook events through the **HTTP handler of a locally started app** (quality downgrade, name approved, echo, history chunk, inbound text), runs the worker until idle, prints counts only (channels by status, events by status / field). Run it on the dev DB; logs clean.
3. PHASE_9_TASKS T9.1–T9.4 `[x]`, plan changelog "Batch 1 done" + deviations; commit.

---

# ═══════════ BATCH 2 — Health, callbacks, admin, API, hardening, docs (T9.5 → T9.7) ═══════════

## T9.5 — Health, Meta callbacks, superadmin, simulator → `feat(whatsapp): add channel health job, meta data deletion callbacks and superadmin tools [P9-T9.5]`

1. `health.ts` — `whatsapp-health` scheduler (§1), per-channel pass = `sync`; transitions + notifications + emails once per transition; skips `disconnected`; per-account sequential, global concurrency 5.
2. `meta-callbacks.*` — `POST /api/v1/meta/deauthorize` and `POST /api/v1/meta/data-deletion` (`application/x-www-form-urlencoded`, `signed_request`, verified with the active app secret; stale / bad → 400 / 401), effects per plan §1i, audit (system), response `{ url: '<FRONTEND_URL>/data-deletion?code=<code>', confirmation_code }`; `GET /api/v1/meta/data-deletion/:code` → `{ status, receivedAt, completedAt }` (404 unknown).
3. Superadmin: `GET /admin/whatsapp/status` (`{ enabled, provider, configured: { appId, appSecret, configId, verifyToken, creditLine, systemUserToken }, webhookUrl: APP_URL + '/api/v1/webhooks/meta', lastEventAt, channelsByStatus, eventsByStatus24h }` — booleans only for secrets), `GET /admin/whatsapp/events?status=failed` (metadata), `POST /admin/whatsapp/events/:id/replay`, account detail `whatsappChannels` summary + `whatsappBilling`, `PATCH /admin/accounts/:id/whatsapp-billing` (audit both sides; affects future connects only), `POST /admin/whatsapp/channels/:id/disconnect { reason }` (notification + email to owners, audit both sides), `POST /admin/accounts/:id/whatsapp/manual-connect { wabaId, phoneNumberId, accessToken }` (same steps from "debug token"; refuses tokens without access to the WABA).
4. Simulator (§1 kinds) — `dev-simulator.routes.ts` + `simulator.ts`, mounted per §1; payload builders reuse the fixture shapes; `payment_method_added` flips the fake funding flag then emits `account_update`; `token_revoked` revokes the fake token then emits `account_update` (`PARTNER_REMOVED`-like) — the effect must come from the pipeline.
5. Tests: health transitions (connected → needs reconnect → reconnect; restricted → lifted; quality red notification once across 3 runs), deauthorize (channels of that Meta user → needs reconnect), data deletion (request stored, tokens cleared, status endpoint), bad / stale `signed_request`, superadmin routes × roles (403 for everyone else), replay, billing mode change (future connect uses it; existing channel unchanged), force disconnect, manual connect, simulator refused in production / without `MOCK_APIS_ENABLED`, simulator goes through signature (wrong secret config → 401 visible), logs clean.

## T9.6 — API, OpenAPI, seed, dev script → `feat(whatsapp): add whatsapp api, seed and dev script [P9-T9.6]`

1. Routes (plan §1n) — static paths before `/:id`; `requirePermission` per row; `blockWhenImpersonating()` on writes; suspended accounts → writes 403; `WHATSAPP_ENABLED=false` → every `/whatsapp/*` 503 `WHATSAPP_NOT_CONFIGURED`; rate limits `rl:wa-connect:` (10 / hour / account) and `rl:wa-sync:` (1 / min / channel); `GET /whatsapp/config` (any signed-in user; `{ enabled, provider, appId?, configId?, graphVersion }` — `appId` / `configId` only in `meta` mode).
2. OpenAPI: register every route + schema, **import the schemas in `src/openapi.ts`**, test in `tests/http/docs.test.ts` that the new paths exist; `gen:openapi`.
3. Seed (`scripts/seed-whatsapp.ts` wired into `db:seed`, idempotent): demo account "Demo Finance" gets a connected fake channel ("Demo Finance", `+91 90000 12345`, Cloud API, GREEN, TIER_1K) **through `connect()` with a fake code**, plus 3 simulated events (name approved, quality upgrade, inbound text deferred).
4. `npm run dev:whatsapp` from B1 extended with `--event <kind>` and `--account <slug>`.
5. Tests: route × role matrix, isolation (other account's channel → 404 on every `/:id` route, never listed), impersonator 403 on writes, suspended 403, disabled 503, rate limits, config endpoint per provider, OpenAPI doc test, seed idempotent.

## T9.7 — Hardening + docs → `test(whatsapp): add webhook burst and restart hardening with adr 0037 and meta setup guide [P9-T9.7]`

1. Hardening tests: 1,000 signed events in 10 concurrent POSTs (all stored once, all processed, duplicates resent → no new rows; record time), worker killed mid-batch → restarted → no loss / no double effects (notifications counted), two connects of the same code in parallel, migration down / up with data.
2. **ADR 0037 — WhatsApp channels & Meta integration** (accepted): MetaClient + fake, Embedded Signup verification, token storage, one number → one active channel, webhook pipeline + deferred fields + TTL, onboarding modes (coexistence + syncs), billing modes (credit line vs customer; irreversibility), manual connect, data deletion; docs/adr/README index.
3. **`docs/setup/meta-whatsapp.md`** — step by step for the real switch later: (1) Meta Business + Business verification; (2) create a Meta app (type Business) → add **WhatsApp** + **Facebook Login for Business**; (3) Embedded Signup configuration with permissions `whatsapp_business_management`, `whatsapp_business_messaging` (+ `business_management` if Meta asks) → `META_ES_CONFIG_ID`; (4) app domains + "Allowed domains for the JavaScript SDK" = frontend URL; (5) webhook callback `https://<api>/api/v1/webhooks/meta`, verify token = `META_WEBHOOK_VERIFY_TOKEN`, subscribe every field in `WEBHOOK_FIELDS`; (6) deauthorize + data deletion callback URLs; (7) app secret → `META_APP_SECRET`; (8) Solution Partner onboarding + credit line id → `META_CREDIT_LINE_ID`, System User (Admin / Financial Editor, `business_management`) token → `META_SYSTEM_USER_TOKEN`; (9) Tech Provider / partner access for onboarding other businesses; (10) dev tunnel (Cloudflare Tunnel) for local webhooks; (11) switch `META_PROVIDER=meta`, restart, smoke checklist (verify challenge OK in Meta dashboard, connect a test number, a real `account_update` / message event arrives and is stored, superadmin status page all green); (12) things to re-check against Meta docs on that day (Graph version, Embedded Signup event names, coexistence sync API + window, credit-sharing method — Meta is replacing it).
4. Docs: README (WhatsApp section: concepts, fake vs real, `dev:whatsapp`, env vars, simulator kinds), api.md (routes, public endpoints), security.md (Meta tokens sealed, signatures, browser ids verified), secrets.md (new secrets), compliance-notes.md (Meta data deletion + deauthorize), data-model.md updates, src/README.md rows; CHANGELOG "Phase 8 → Phase 9 · Batch 1 / 2".

## P9-B2-DONE — checkpoint → `docs: mark phase 9 batch 2 complete [P9-B2-DONE]`

1. Full backend verify (each command separately) + `openapi:check`.
2. Manual check on the dev server **through the HTTP API** (curl / small script, no UI yet): `GET /whatsapp/config` (fake), connect with a fake code (Cloud API) → channel connected; coexistence connect → sync statuses; `GET /webhooks/meta` challenge; unsigned POST → 401; simulator `quality_downgrade` → channel tier / quality changed + notification; `token_revoked` → needs reconnect; data deletion POST (signed with the fake secret) → status page; superadmin status shows the webhook URL; logs clean (grep tokens / codes / PINs / phones = 0).
3. PHASE_9_TASKS T9.5–T9.7 `[x]`, plan changelog "Batch 2 done" + deviations; commit.

---

# ═══════════ BATCH 3 — Frontend, E2E, sign-off (T9.8 → T9.12) ═══════════

## T9.8 — Frontend foundation → `feat(whatsapp): add whatsapp api clients, routes and meta signup loader [P9-T9.8]`

1. Frontend branch from `main`. `npm run gen:api`; clients `src/services/api/whatsapp.ts` (config, channels, signup, rename, sync, retry, pin, coexistence sync, disconnect, simulator), `admin-whatsapp.ts`, `meta-public.ts` (data deletion status); type aliases in `types.ts`; fixtures `src/test/whatsapp.ts` (`fakeChannel(overrides)`, `fakeWhatsAppConfig`).
2. `src/features/whatsapp/{keys,queries,labels}.ts` — hooks `useWhatsAppConfig`, `useChannels`, `useChannel(id)` (poll 5 s while `connecting` / `action_needed`), mutations with cache updates, `useCanManageWhatsApp` (`whatsapp.manage` && !impersonating && account active), labels / colors for statuses, quality, tiers ("1K / day"), modes, sync statuses, Meta error messages per code.
3. Realtime: `whatsapp.channel.updated` in `services/realtime/events.ts` → `setQueryData` on list + detail.
4. Nav (§1 literals) + `LIVE_PHASE = 9` + layout test updated (Reports / Integrations still hidden).
5. Routes: `/whatsapp` (lazy, `RequirePermission whatsapp.read`) → `/whatsapp/numbers`; public `/data-deletion`.
6. `meta-sdk.ts` (loader: once, timeout `META_SDK_TIMEOUT_MS`, typed `window.FB`), `useEmbeddedSignup()` (§1 contract: options per mode, listener with origin check, `SESSION_INFO_WAIT_MS`, outcomes `finished { code, sessionInfo }` / `cancelled { step }` / `error { message }` / `popup_blocked` / `sdk_failed`), `TestSignupDialog` (fake mode; fields + outcome select).
7. Tests: loader (fake `window.FB`, timeout, once), listener (each event, wrong origin ignored, non-JSON ignored), hook outcomes both modes (FB.login called with the exact options), test dialog produces the exact code format, queries / WS updates, labels.

## T9.9 — Numbers page → `feat(whatsapp): add whatsapp numbers page with connect wizard [P9-T9.9]`

1. `pages/whatsapp/WhatsAppPage.tsx` (tabs: **Numbers**; later phases add Templates / Calling), `features/whatsapp/numbers/*`:
   - Empty state (what connecting does, requirements, **Connect WhatsApp**); disabled-server state (`enabled: false` → "WhatsApp isn't set up on this server").
   - Connect wizard dialog: mode radios (§1 names; coexistence warning "Calling won't work on this number; messages you send from your phone will also appear here"), launch (real hook or Test signup dialog), progress steps, results (Connected / Action needed + reason + next action / Cancelled at <step> / Error + Meta message / Number already connected to another account / Popup blocked).
   - Number card (region per channel): label, number, verified name + name status, status chip, quality chip, limit, mode badge, billing line (platform credit line ✓ / "Add a payment method in WhatsApp Manager ↗" link `https://business.facebook.com/wa/manage/` until ok / credit line failed → reason), coexistence section (sync statuses + **Retry sync**), WABA name, connected by / at, last synced; actions by role + state: **Sync now**, **Rename**, **Retry setup**, **Enter PIN** (6-digit dialog), **Reconnect** (opens the wizard), **Disconnect** (confirm: "The number keeps working on WhatsApp; this app stops receiving its messages until you connect again").
   - **Number details** drawer: ids with copy, business verification + WABA review status, token checked at, webhook health (last event, field, events 24 h), history timeline, dev-only **Send test event** menu (`provider === 'fake'` and not production build) → simulator.
   - Live updates; read-only for non-managers / impersonators (actions hidden, tooltip "Only owners and admins can change WhatsApp numbers").
2. Tests: every state + action + role + error code; live update from a fake realtime event; polling stops when final; branch-complete.

## T9.10 — Entry points → `feat(whatsapp): add superadmin whatsapp tools, notifications and data deletion page [P9-T9.10]`

1. Superadmin account detail: **WhatsApp** card (lazy, like `LimitsCard`): numbers with status / quality, **Force disconnect** (reason required), **Manual connect** dialog (WABA id, phone number id, token — password field, never echoed back), **Meta billing** setting (Platform credit line / Customer pays Meta; confirm text from plan §1o).
2. Admin **WhatsApp status** page (`/admin/whatsapp`, `platformOnly`, nav item `admin-whatsapp`, `phase: 9`): provider, configured flags (✓ / ✗, never values), **Webhook URL** with copy, verify token set, last webhook received, channels by status, failed events table + **Replay**.
3. Notifications: icons / texts / links for the 6 new types (link → `/whatsapp/numbers`).
4. Dashboard card (lazy): no channel + `whatsapp.manage` → "Connect WhatsApp"; else "WhatsApp: N connected · M need attention" → link.
5. Public `/data-deletion` page (no login): what the app stores from Meta (business token, WABA / number ids and details, webhook events up to 30 days) and how to request deletion (remove the app in Facebook settings, or email support), status lookup by `?code=`.
6. Bundle check vs `main` (same script as Phase 8: gzip of everything `index.html` loads; WhatsApp page / admin card / dashboard card lazy) — record numbers; target ≤ +3 KB.
7. Tests.

## T9.11 — Playwright E2E → `test(e2e): add whatsapp connect scenarios [P9-T9.11]`

1. `playwright.config.ts` backend env: `WHATSAPP_ENABLED: 'true'`, `META_PROVIDER: 'fake'`, `MOCK_APIS_ENABLED` already true.
2. Helpers `e2e/whatsapp.ts`: `connectFakeNumber(page, { mode, businessName, phone, displayName, outcome })` (waits for the signup response before asserting), `simulateEvent(page, label, kind)` (via the card's **Send test event** menu or the API with the page's session), `numberCard(page, label)`, `setMetaBilling(admin, businessName, payer)`.
3. Specs (one account per spec, `test.describe.configure({ mode: 'serial' })`, short tests, unique phones per spec):
   1. **`whatsapp-connect.spec.ts` (Done when):** empty state → Connect → Cloud API → Finish → **Connected** card (number, verified name, GREEN, 1K / day, Cloud API, "platform credit line ✓") → drawer ids + history → Rename → `quality_downgrade` → YELLOW live + bell → `token_revoked` → **Needs reconnect** → Reconnect (same number) → Connected (same card, history kept) → Disconnect → Disconnected.
   2. **`whatsapp-outcomes.spec.ts`:** cancel at a step (nothing saved, message), error outcome, coexistence → warning + badge + sync statuses (contacts / history received after simulated events) + `echo_text` counted in the drawer, only-WABA → Action needed → Sync after the number exists → Connected, PIN-needed number (`…00001`) → Enter PIN → Connected, subscribe failure (`…00002`) → Action needed → Retry setup → still failing message (fake fails 4×) is shown clearly.
   3. **`whatsapp-roles-billing.spec.ts`:** viewer sees numbers read only, manager no Connect / Disconnect, second account connecting the same number → "already connected to another account", impersonating superadmin read only, superadmin sets the account to **Customer pays Meta** → next number shows "Add a payment method" → `payment_method_added` → ok, superadmin force disconnect → owner bell + Disconnected, Admin WhatsApp status page shows the webhook URL + flags.
   4. **`whatsapp-meta-endpoints.spec.ts`:** `GET /api/v1/webhooks/meta` challenge (right / wrong token) and unsigned / signed POST (Playwright `request`, signed with the dev fake secret from `e2e/env.ts`), data deletion request (signed_request built in the test) → `/data-deletion?code=` page shows "received".
4. All earlier **61** tests stay green; whole suite **twice** (2nd with `E2E_BACKEND_LOGS=1` → log grep: tokens (`fake_tok_`, `EAAG`), `code=`, `pin`, signup codes (`fake.`), test phones (full and `+91` forms), `Test Business` names, payload texts (`echo`, inbound sample text), `Bearer `, `sk-`, `accessToken`, `ticket=`, both E2E passwords → 0 hits).

## T9.12 — Gap audit, security, docs, sign-off → backend `docs: add phase 9 sign-off and docs [P9-T9.12]` + frontend `docs: add phase 9 whatsapp to the readme and changelog [P9-T9.12]` (+ `test: add phase 9 gap tests …` only if tests are added)

1. Requirement → test table for plan §0 / §1 / every task; missing tests added.
2. Security checklist: secrets never in API / WS / audit / notifications / emails / logs / errors (tests + log grep), signatures constant-time, raw body only on the webhook path, browser ids verified, one active channel per number, disconnect never deregisters, isolation, impersonation read only, payloads sealed + TTL, simulator absent in production, gitleaks both repos (allowlist only with a reason), `grep -rn "console.log" src` = 0 both, `grep -rn "sk-" src e2e` (frontend) = 0, no network in tests (grep for `graph.facebook.com` in tests = only the default-env assertion).
3. Coverage re-measured → gates raised to new values rounded down to 5 (never lowered); bundle numbers vs `main`; burst numbers.
4. Docs: both READMEs (WhatsApp section, E2E list), CHANGELOGs (`Phase 9 · Batch 1 / 2 / 3` backend; `Phase 9 · WhatsApp Connect (T9.8–T9.12)` frontend), BUILD_PLAN_V2 Phase 9 ✅ + changelog + "Next: Phase 10", PHASE_9_TASKS all `[x]`, plan ticked + changelog, **PHASE_9_SIGNOFF.md** (same structure as Phase 8: tasks + evidence commits, deliverables, requirement → test, numbers (tests before → after: backend 2203 → N, frontend 737 → N, E2E 61 → N; coverage; burst; bundle), deviations, bugs fixed, verification, TODOs by phase (Phase 10 inbox consumes `messages` / statuses / echoes / history / contacts deferred events + business profile; Phase 11 templates + billing per `metaPayer`; Phase 12 calling settings + `isOnBizApp` eligibility; Phase 13 real Meta app setup + App Review; Phase 16 account data deletion), client / owner inputs (Meta Business verification, Solution Partner onboarding + credit line, Embedded Signup config, test number, staging domain), go / no-go for Phase 10).

## P9-B3-DONE — checkpoint → `docs: mark phase 9 complete [P9-B3-DONE]`

1. `infra:up` → full verify **both repos** (each command separately) + actionlint both (`docker run --rm -v "$PWD/<repo>":/repo --workdir /repo rhysd/actionlint:latest`) + `npm run e2e` (all tests) **twice** after the last code commit (2nd with `E2E_BACKEND_LOGS=1` + log grep).
2. Fresh clone of both repos side by side (scratchpad, branch `feature/phase-9-whatsapp-connect`) → `npm ci` → all checks **without `.env`** → `gen:api` no diff → tests → E2E once → delete clones.
3. Secret scan (grep + gitleaks one-off image `zricethezav/gitleaks:latest detect --source /repo --config /repo/.gitleaks.toml --redact --no-banner`) both repos; money-writes test; `npm audit` both (record; the Phase 5 `mammoth` moderate findings are known).
4. Sign-off §Verification filled; commit (backend `docs: mark phase 9 complete [P9-B3-DONE]`; frontend docs commit with the same tag if its CHANGELOG changed); `infra:down` (only `cav-*` containers). No push / merge.
5. **Final report (Hinglish):** per task ✅ / ⚠️ / ❌, `git log` both repos, deviations, verification, tests before → after + coverage + gates, burst + bundle numbers, real bugs found + fixed, sign-off status, what is needed to switch to real Meta (setup doc checklist + owner inputs), open items for Phases 10 / 11 / 12 / 13.

---

## 4. FINAL CHECKLIST

**Step 0**

- [ ] Branch `feature/phase-9-whatsapp-connect` (backend) + `[P9-PLAN]` + `[P9-PROMPT]` commits

**Batch 1**

- [ ] T9.1 models (3) + account `whatsapp.metaPayer`, migration 0010, limits, env + production rules, codes (54), audit (95), notifications (17), WS, permissions, queue name
- [ ] T9.2 MetaClient (Graph + fake), signatures, schemas + Meta fixtures
- [ ] T9.3 connect (verify, discovery, subscribe, billing setup, register / coexistence sync), reconnect, retry, PIN, sync, rename, disconnect, statuses
- [ ] T9.4 webhook pipeline (verify, signature, store, queue, worker, routing, handlers, deferred API, coexistence effects, retries, purge)
- [ ] P9-B1-DONE (verify, `dev:whatsapp`, docs)

**Batch 2**

- [ ] T9.5 health job, deauthorize + data deletion, superadmin (status, events + replay, billing mode, force disconnect, manual connect), simulator
- [ ] T9.6 API + OpenAPI + rate limits, seed, dev script
- [ ] T9.7 hardening, ADR 0037, `docs/setup/meta-whatsapp.md`, docs
- [ ] P9-B2-DONE (verify, manual HTTP check)

**Batch 3**

- [ ] T9.8 FE foundation (clients, hooks, WS, nav renumber + `LIVE_PHASE = 9`, routes, Meta SDK loader + signup hook, Test signup dialog)
- [ ] T9.9 Numbers page (empty state, wizard, cards, drawer, actions, live updates, roles)
- [ ] T9.10 superadmin card + admin status page, notifications, dashboard card, `/data-deletion`, bundle check
- [ ] T9.11 Playwright (4 specs, whole suite twice, log grep)
- [ ] T9.12 gap audit, security, docs, sign-off
- [ ] P9-B3-DONE (fresh clones, gitleaks, actionlint, `infra:down`)
