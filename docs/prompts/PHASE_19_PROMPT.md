# P19 RUN — Open signup, reseller panel, bulk WhatsApp campaigns (T19.1 → T19.16) — One-Paste Autonomous Run Prompt

> **Resume update — 5 Nov 2026:** Use [PHASE_19_CONTINUATION_PROMPT.md](PHASE_19_CONTINUATION_PROMPT.md)
> for all remaining work and the owner's added requirements: three campaign types,
> WhatsApp sender caps of **18 / 75 messages per second**, incoming/outgoing WhatsApp AI,
> and number-aware templates/approval/call choices. It supersedes conflicting instructions
> below, including the old STEP 0, 80 msg/sec default and historical checkpoint rules.
> Preserve existing branches and uncommitted work; do not restart Phase 19.

> **HOW TO RUN — ek hi paste, poora phase. Beech mein kahin nahi rukna.**
>
> **Ek paste = STEP 0 → Batch 1 → Batch 2 (checkpoint) → Batch 3 → Batch 4 → sign-off.** Checkpoint (`P19-B2-DONE`) pe sirf commit + 2 line progress note, aur **usi turn mein agla task**.
>
> **Paste this (working directory `/Users/lalitbansal/Documents/cell-ai-voicebot`):**
>
> `cell-ai-voicebot-backend/docs/prompts/PHASE_19_PROMPT.md padho aur STEP 0 se P19-DONE tak POORA Phase 19 step by step autonomously implement karo. Kahin mat ruko — saare decisions is prompt + PHASE_19_PLAN.md me pre-made hain (§1). Har task ke baad sirf us task ke tests (§2 rule 5) + commit [P19-T19.x]. Full suite sirf checkpoint B2 aur sign-off pe EK baar. End me final report Hinglish me.`
>
> **Claude Code "auto / accept edits" mode me chalao.** **Docker Desktop chalu** (`cav-mongo`, `cav-redis`, `cav-mailpit`). **Mac charger par** — lambi runs `caffeinate -dims` ke saath, background mein. Doosre projects ke containers / processes **kabhi mat chhoona** (Supabase containers, AutoChatix ka `serve-frontend` on 5187). Hamare apne leftover e2e processes (port 5100 backend, 3100 / 3150 vite) sirf tab band karna jab `lsof -p <pid> -a -d cwd` hamari repo dikhaye.

---

## 0. CONTEXT (verified facts on 4 Nov 2026 — dobara derive mat karna)

**Branches:** `main` = backend **`c020e28`**, frontend **`471bfa0`** (Phase 18B done, pushed; client repo released `release-20261104-c020e28`). Backend branch **`feature/phase-19-reseller-campaigns`** already exists from `main` with the plan commit `10218f0` (`[P19-PLAN]`); this prompt is the next commit there. Frontend: create the same branch from `471bfa0`. **Never commit to `main`.**

**Numbers at start:** backend **3,918 tests (+1 skipped) / 374 files**; frontend **1,501 tests / 141 files**; **170 Playwright tests** (1 worker by design). Catalogue: error codes **108**, audit actions **174**, notifications **39**, permissions **45**, ledger types **10**, WS events **40**. Migrations `0001` … `0020`. Known load flakes (pass alone): frontend `templates-page`, `contact-detail`, `calls-pages`, `import-wizard`, `export-and-advanced`; backend `calls-wa/leg-media`, `calls/flow-call`.

**Pehle padho (STEP 0 and after every compaction):**

- [PHASE_19_PLAN.md](../phases/PHASE_19_PLAN.md) — **source of truth**: goal §0, what exists §1a, gaps G1–G7 §1b, decisions D1–D12 §2, data model §3, tasks §4, tests §5, risks §6.
- [BUILD_PLAN_V2.md](../plans/BUILD_PLAN_V2.md) Phase 20 (bulk campaigns — AutoChatix pattern + Phase 8 reliability).
- [PHASE_8_PLAN.md](../phases/PHASE_8_PLAN.md) (campaign engine: claims, restart safety, recurrence), [PHASE_11 sign-off](../phases/PHASE_11_SIGNOFF.md) (template send pricing), [PHASE_18B_SIGNOFF.md](../phases/PHASE_18B_SIGNOFF.md) (bulk permission run pattern).
- AutoChatix reference (read only, never copy secrets): `~/Documents/Autochatix/AutoChatix-backend/src/models/campaign.model.ts` (audience types, A/B, counters, `messaging_tier`), `campaignAttempt.model.ts`, its campaign service / worker.
- Conventions: [secrets.md](../conventions/secrets.md), [security.md](../conventions/security.md), [definition-of-done.md](../conventions/definition-of-done.md), [audit.md](../conventions/audit.md), [error-codes.md](../conventions/error-codes.md), [websocket.md](../conventions/websocket.md), [data-model.md](../conventions/data-model.md).

**What exists (use it, don't rebuild) — exact entry points:**

| Area              | Use                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signup            | `modules/auth/auth.routes.ts` `POST /auth/signup` (`limiter`, `SignupBody`: `businessName, name, email, password, phone?, timezone?`) → `auth.service.ts` `signup()` (creates pending owner, `sendVerificationCode`, anti-enumeration "account exists" mail); `verify-email`, `verify-email/resend`; `login.service.ts` refuses `!emailVerifiedAt` (`AUTH_EMAIL_NOT_VERIFIED`, line ~70 and refresh ~113)                                          |
| Sessions          | `modules/auth/session.ts` `buildSessionBody`, `accessTokenFor(user, jti, { impersonatorId, ttl })`; refresh cookie in `refresh.service.ts`                                                                                                                                                                                                                                                                                                         |
| Superadmin        | `modules/admin/admin.service.ts` `createAccount` (`CreateAccountBody`: `businessName, ownerName, ownerEmail, ownerPassword, ownerPhone?, timezone?`, duplicate → `CONFLICT_DUPLICATE`), `impersonate(req, id)` (owner must be active + verified, token `imp_…`, `IMPERSONATION_TTL`, `auditBothSides('admin.impersonation_started')`), `POST /admin/impersonation/stop` (not behind platform admin), `SetOwnerPasswordBody`; `findCustomerAccount` |
| Guards            | `shared/middlewares/require-permission.ts` `requirePermission`, `requirePlatformAdmin`, `blockWhenImpersonating` (`AUTH_IMPERSONATION_BLOCKED`, used in 31 route files)                                                                                                                                                                                                                                                                            |
| RBAC              | `modules/rbac/permissions.ts` `PERMISSION_INFO` (45), `system-roles.ts` `SYSTEM_ROLES` (owner / admin / manager / agent / viewer), snapshot test in `rbac/__snapshots__`                                                                                                                                                                                                                                                                           |
| Accounts          | `db/models/account.model.ts` (`name, slug, status: active / suspended / deleted, ownerId, isPlatform, timezone, billing, apiLimits, voiceLine, sipSettings, settings.*`)                                                                                                                                                                                                                                                                           |
| Platform settings | `db/models/platform-settings.model.ts` (one row per key; keys e.g. `whatsappCalling`; validators per key; code defaults)                                                                                                                                                                                                                                                                                                                           |
| Wallet            | `core/billing/engine.ts` `credit(...)`, holds / settle; `wallet-lock.ts` `withWalletLock(accountId, fn)` (Redis lock key `wallet:lock:<id>`); `topup-credit.ts`; `db/models/ledger-entry.model.ts` `LEDGER_TYPES` (10); `modules/wallet/*` (routes, top-ups via Razorpay, usage) ; low-balance bells `core/billing/alerts.ts`                                                                                                                      |
| Voice campaigns   | `modules/campaigns/*`: `audience.ts`, `snapshot.ts`, `dispatcher.ts` (line `provider: live ? 'sip' : 'dryrun'` ~361), `slots.ts`, `window.ts`, `recurrence.ts`, `runs.ts`, `results.ts`, `export.ts`, `sweep.ts`, `estimate.ts`; model `campaign.model.ts` (flowId required, audience listIds / segmentId / filter / contactIds)                                                                                                                   |
| Templates         | `modules/templates/*` (statuses, `purpose`, variables with sources), `whatsapp-billing/price-preview.service.ts` `pricePreview(accountId, { channelId, contactId \| phone, templateId \| category })`                                                                                                                                                                                                                                              |
| Template send     | `modules/inbox/outbound.service.ts` `sendMessage(ix, actor, conversationId, { type: 'template', templateId, variables?, clientId })` (priced + held, idempotent by `clientId`), `upsertConversation`; statuses webhook → message status                                                                                                                                                                                                            |
| Audience          | `modules/contacts/contacts.service.ts` `segmentQuery`, `filter/compile.ts` `compileContactFilter`, `context.ts` `loadContactContext`; `privacy/suppression.ts` `suppressedPhones`; contact `dnd`, `optedOutAt`, `whatsapp.blocked`, `whatsapp.marketing.stopped`, `waCallPermission`                                                                                                                                                               |
| Bulk pattern      | `whatsapp-calling/bulk-permissions.ts` (target resolve ≤ cap, skip reasons, cursor resume, stable `clientId` UUID, progress, bell)                                                                                                                                                                                                                                                                                                                 |
| WhatsApp calls    | `whatsapp-calling/calls.service.ts` `startOutbound`, `dial-guard.ts` `checkDial`                                                                                                                                                                                                                                                                                                                                                                   |
| Channel           | `whatsapp-channel.model.ts` `messagingLimitTier` (`WA_LIMIT_TIERS`: `TIER_50`, `TIER_250`, `TIER_1K`, `TIER_2K`, `TIER_10K`, `TIER_100K`, `TIER_UNLIMITED`), `qualityRating`                                                                                                                                                                                                                                                                       |
| Frontend          | `pages/auth/SignupPage.tsx`, `VerifyEmailPage.tsx`, `LoginPage.tsx`; `pages/admin/AdminAccountsPage.tsx`, `AdminAccountDetailPage.tsx`; `pages/campaigns/CampaignsPage.tsx`, `CampaignWizardPage.tsx`, `CampaignDetailPage.tsx`; `features/campaigns/*`; `app/routes.tsx`; `layout/nav-config.ts`; impersonation banner (search `impersonation` in `layout/`); `features/contacts/BulkActionsBar.tsx`                                              |
| Release           | `scripts/sync-client-repo.sh` (no client sync unless the owner asks)                                                                                                                                                                                                                                                                                                                                                                               |

**Bugs to avoid:** a reseller reading another reseller's customer (every `/reseller/*` query scoped by `parentAccountId`); a login-as token that can change the owner's password / MFA / API keys / delete the account / top up; nested login-as; a credit transfer that moves money on one side only (one transaction, both locks, fixed order); double charge on a retried transfer (Idempotency-Key); signup that leaks whether an e-mail exists **and** sends mail (now: no mail, clear 409 — accepted trade-off, rate limited); campaign double sends after a crash (claims + stable `clientId`); a campaign that ignores the messaging tier; counting replies with a per-recipient query; marketing templates to contacts who stopped marketing; phone numbers / passwords / tokens in logs or audit (last 4 only).

---

## 1. LOCKED DECISIONS (exact literals)

**Owner defaults D1–D12 (plan §2) are in force** (the owner did not change them before this run). Record "Defaults D1–D12 in use" in the plan changelog at STEP 0.

**Accounts (T19.1):** `accounts.kind`: `'platform' | 'reseller' | 'business'` (default `'business'`, index `{ kind: 1 }`); `accounts.parentAccountId: ObjectId | null` (index `{ parentAccountId: 1, createdAt: -1 }`, only on `business`); `accounts.reseller: { status: 'active' | 'pending_approval', customersCanTopUp: boolean (false), approvedAt: Date | null, approvedBy: ObjectId | null, brand: null } | null` (only on `reseller`). One level only: a reseller's `parentAccountId` is always null; a business's parent must be `kind: 'reseller'`. Migration **`0021-accounts-resellers`**: `kind` backfill (`isPlatform` → `platform`, else `business`), `parentAccountId: null`, users `status: 'active'` with `emailVerifiedAt: null` → `emailVerifiedAt = createdAt` (D8), platform setting `signup` default row.

**Platform setting `signup`:** `{ open: boolean (true), resellerSignup: 'open' | 'approval' | 'closed' ('open') }`. Public `GET /auth/signup-options` → `{ open, resellerSignup }` (no auth, cached 60 s).

**Signup (T19.2):** `POST /auth/signup` body `{ accountType: 'business' | 'reseller', businessName, name, email, phone?, password, timezone?, acceptTerms: true, website?: '' }` (`website` = honeypot: non-empty → 422 without detail, logged as `signup_honeypot`) → **201 session** (same body as `POST /auth/login` + refresh cookie). Owner `emailVerifiedAt = now`. Errors: platform closed → **`SIGNUP_CLOSED`** (403, "Signups are closed. Contact us to get an account."); reseller closed → `SIGNUP_CLOSED` with `details: [{ path: 'accountType' }]`; duplicate e-mail → **`AUTH_EMAIL_TAKEN`** (409, "An account with this e-mail already exists. Log in instead."). Limiter **`signup-ip`** 5 / h per IP (plus the existing auth limiter). Reseller with `resellerSignup: 'approval'` → `reseller.status: 'pending_approval'` (can log in, can't create customers → **`RESELLER_NOT_APPROVED`** 403). Login no longer checks `emailVerifiedAt` (login + refresh). `POST /auth/verify-email` and `/verify-email/resend` → **`AUTH_ROUTE_GONE`** (410, "This link is no longer used. Log in with your e-mail and password."). Password reset by e-mail stays unchanged (not signup); superadmin / reseller can set an owner's password.

**Login as (T19.3):** token claims gain `impersonatorKind: 'superadmin' | 'reseller'`, `impersonationMode: 'view' | 'act'`, `returnTo: '/admin/accounts/<id>' | '/reseller/customers/<id>'`. `POST /admin/accounts/:id/impersonate` body `{ mode: 'view' | 'act' }` (default `view` = today), now also for `kind: 'reseller'` accounts. `POST /reseller/customers/:id/login-as` → `mode: 'act'` only, only children, reseller `active`, permission `reseller.manage`, limiter **`login-as`** 30 / h per user. TTL unchanged (`IMPERSONATION_TTL`), no refresh, nested → `CONFLICT_INVALID_STATE` ("Stop the current login-as first."). `blockWhenImpersonating()` blocks only `view` sessions (today's behaviour for view); new **`blockSensitiveWhenImpersonating()`** blocks every login-as session (both modes) with `AUTH_IMPERSONATION_BLOCKED` on: own password / MFA / sessions / logout-all, API keys (create / rotate / revoke), owner role change / owner removal, account delete / export / erase-all, wallet top-up / refund / payment settings, billing profile, platform-level routes. Each of the 31 route files classified once: sensitive → `blockSensitiveWhenImpersonating()`; ordinary write → `blockWhenImpersonating()` (view blocked, act allowed). Table in `docs/conventions/security.md` §Login as. Audit: `reseller.login_as_started` / `reseller.login_as_stopped` on both sides; superadmin keeps `admin.impersonation_started` / `_stopped` (+ `mode` in meta). Stop: existing `POST /admin/impersonation/stop` works for both kinds.

**Superadmin (T19.4):** `CreateAccountBody` + `kind: 'business' | 'reseller'` (default business) + `parentAccountId?` (business only, must be a reseller); `PATCH /admin/accounts/:id/reseller` `{ parentAccountId: string | null }` (move a business; audit `account.reseller_changed` meta `{ from, to }`); `POST /admin/accounts/:id/approve-reseller` (audit `reseller.approved`, bell `reseller.approved` to the reseller's owners / admins); `GET / PUT /admin/settings/signup` (audit `platform.signup_settings_updated`). Account list query `kind`, `parentAccountId`; list rows gain `kind`, `parent: { id, name } | null`, `customers` (resellers).

**Reseller API (T19.5):** router `/reseller` (authenticate, account `kind: 'reseller'` else 404, permissions below):

| Route                                              | Permission                   | Notes                                                                                                                                                                                       |
| -------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /reseller/summary`                            | `reseller.read`              | T19.7, cached 5 min in Redis `reseller:summary:<id>`                                                                                                                                        |
| `GET /reseller/customers?q&status&page&limit`      | `reseller.read`              | rows: `id, name, status, owner { name, email }, wallet { availableMicros }, spend30dMicros, lastActiveAt, createdAt`; one aggregate, no N+1                                                 |
| `POST /reseller/customers`                         | `reseller.manage` + approved | body `{ businessName, ownerName, ownerEmail, ownerPhone?, ownerPassword, timezone?, startingCreditMicros? }`; limiter **`reseller-customer-create`** 50 / day per reseller; Idempotency-Key |
| `GET /reseller/customers/:id`                      | `reseller.read`              | detail + last 20 transfers                                                                                                                                                                  |
| `PATCH /reseller/customers/:id`                    | `reseller.manage`            | `{ name?, status?: 'active' \| 'suspended' }`                                                                                                                                               |
| `POST /reseller/customers/:id/owner-password`      | `reseller.manage`            | `{ password }` (policy), owner's sessions end                                                                                                                                               |
| `POST /reseller/customers/:id/login-as`            | `reseller.manage`            | T19.3                                                                                                                                                                                       |
| `POST /reseller/customers/:id/credit`              | `reseller.manage`            | `{ amountMicros (1 … 10,000,000,000), note? (≤ 200) }`, Idempotency-Key, limiter **`reseller-credit`** 60 / h                                                                               |
| `POST /reseller/customers/:id/credit/reclaim`      | `reseller.manage`            | same body, ≤ customer's available                                                                                                                                                           |
| `GET /reseller/statement?from&to&format=json\|csv` | `reseller.read`              | transfers in / out                                                                                                                                                                          |
| `GET / PATCH /reseller/settings`                   | read / manage                | `{ customersCanTopUp }`                                                                                                                                                                     |

A customer not under this reseller → **404** `RESOURCE_NOT_FOUND` (never 403).

**Credit (T19.6):** ledger types **+2 → 12**: `credit_transfer_out` (reseller, negative), `credit_transfer_in` (customer, positive), both `meta.transferId` (same UUID), `meta.counterpartyAccountId`; reclaim = the same pair reversed. Both in **one Mongo transaction** inside `withWalletLock` of both accounts, locks taken in ascending account-id order. Refuses: reseller short → `WALLET_INSUFFICIENT_BALANCE`; customer suspended → `CONFLICT_INVALID_STATE`. Customer top-up refused when parent `customersCanTopUp: false` → **`TOPUP_NOT_ALLOWED`** (403, "Your provider adds credit to this account. Contact them to add more."). Bells: customer owners / admins `wallet.credit_received`; reseller owners / admins `wallet.customer_low_balance` when a customer crosses its low-balance alert.

**Reseller permissions (T19.5):** **+4 → 49:** `reseller.read`, `reseller.manage`, `whatsapp.campaigns.read`, `whatsapp.campaigns.write`. System roles: owner all; admin `reseller.read`, `reseller.manage`, both campaign perms; manager `reseller.read`, both campaign perms; agent + viewer `whatsapp.campaigns.read`. (Reseller perms only mean something on reseller accounts; the router checks `kind`.)

**WhatsApp campaigns (T19.9–T19.14):**

- Models: **`whatsappCampaigns`** (fields plan §3; `status`: `draft` | `scheduled` | `running` | `waiting_for_limit` | `paused` | `completed` | `stopped` | `failed`; `pauseReason`: `user` | `wallet_empty` | `template_paused` | `quality_red` | `channel_down` | null; `variants: [{ key: 'A'|'B'|'C', templateId, splitPct }]` (1–3, sum 100), `abWinner: { metric: 'read' \| 'reply', afterHours: 1–72, decidedAt, winner } | null`; `variables: Record<key, { kind: 'field' | 'contact.name' | 'contact.phone' | 'static', value }>`; `audience: { listIds, segmentId, tags: { values, mode }, contactIds, csvUploadId }`; `excludeRecentDays: 0–90`; `schedule: { kind: 'now' | 'at' | 'recurring', at, recurrence }`; counters `total, skipped{reason}, queued, sent, delivered, read, replied, failed{metaCode}`; `cost: { estimateMicros, chargedMicros }`). Indexes `{ accountId: 1, createdAt: -1 }`, `{ status: 1, 'schedule.at': 1 }`.
- **`whatsappCampaignRecipients`**: `campaignId, accountId, contactId, variant, status: 'pending' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped'`, `skipReason`, `messageId`, `errorCode`, `claimedAt`, `sentAt`, `repliedAt`, `attempts`; unique `{ campaignId: 1, contactId: 1 }`, `{ campaignId: 1, status: 1 }`, `{ messageId: 1 }` (partial, string). Erase: deleted with the contact (erase map `delete`). DATA_MAP rows for both.
- Skip reasons (fixed): `dnd`, `opted_out`, `suppressed`, `no_whatsapp`, `marketing_stopped`, `sent_recently`, `missing_variable`, `invalid_phone`, `stopped`, `limit_reached`, `already_allowed`, `declined_recently`, `meta_limit` (last three: consent variants only).
- Migration **`0022-whatsapp-campaigns`**: both collections + indexes; Phase 8 `campaigns.line: 'phone'` + `channelId: null` backfill.
- Routes (`/whatsapp-campaigns`, `whatsapp.campaigns.read` / `.write`, writes `blockWhenImpersonating()`): `GET /`, `POST /` (draft; limiter **`wa-campaign-create`** 30 / h), `GET /:id`, `PATCH /:id` (draft / scheduled only → else **`WA_CAMPAIGN_NOT_EDITABLE`** 409), `DELETE /:id` (draft only), `POST /:id/estimate`, `POST /:id/start` (Idempotency-Key), `POST /:id/pause`, `/resume`, `/stop`, `/retry-failed`, `GET /:id/recipients?status&page`, `GET /:id/export` (CSV; phone masked unless `contacts.export`), `GET /:id/report`. Empty audience after skips → **`WA_CAMPAIGN_AUDIENCE_EMPTY`** (422). Template not approved / not on the number → `VALIDATION_FAILED` path `variants.N.templateId`.
- **Any approved template** of the number can be a campaign variant — MARKETING, UTILITY, AUTHENTICATION-free, and **`purpose: 'call_permission'` (consent)**. A consent variant sends through `permissions.request(actor, { channelId, contactId, forceTemplate: true, templateId, variables, clientId })` (Phase 18B) so Meta's limits, the permission row (`requested`) and `contacts.waCallPermission` stay right; its skip reasons add `already_allowed`, `declined_recently`, `meta_limit` (same meanings as the bulk permission run). Every send (any purpose) is priced, held and charged from the wallet by the existing template send path; `wallet_empty` auto-pauses.
- Estimate: `{ recipients, skipped: Record<reason, n>, byMarket: [{ market, count, priceMicros }], totalMicros, walletAvailableMicros, enough }` (prices from the existing pricing, per category of each variant).
- Jobs (queue `whatsapp`): **`whatsapp-campaign.dispatch`** (job id `wa-campaign-<id>`, batches of 100 claimed `pending → sending`), **`whatsapp-campaign.sweep`** every 5 min (scheduled starts, stale `sending` > 10 min → `pending`, `waiting_for_limit` → resume when the window opens, A/B winner decisions). Per recipient `clientId` = UUID v5-style from `wac:<campaignId>:<contactId>` (same helper style as `bulkClientId`).
- Pacing: tier → unique recipients per rolling 24 h: `TIER_50` 50, `TIER_250` 250, `TIER_1K` 1,000, `TIER_2K` 2,000, `TIER_10K` 10,000, `TIER_100K` 100,000, `TIER_UNLIMITED` ∞ — minus business-initiated conversations the number already opened in the last 24 h. **Owner amendment (5 Nov):** per-number shared throughput cap **18 msg/sec** for Business App/coexistence, **75 msg/sec** for confirmed regular WhatsApp Cloud API; `WA_CAMPAIGN_MPS`, if retained, may only lower that cap. Follow the continuation prompt §1b for classification, atomic pacing, retries and multi-worker behavior. Cap env **`WA_CAMPAIGN_MAX_RECIPIENTS`** remains default 100,000.
- Auto pause: wallet empty, template `PAUSED` / `DISABLED`, quality `RED`, channel not connected → `paused` + `pauseReason` + bell.
- Replies: an inbound message from a recipient within **72 h** of `sentAt` sets `repliedAt` once (lookup by `{ accountId, contactId }` on recipients of running / completed campaigns of the last 3 days — indexed, one query per inbound).
- Realtime **`whatsapp_campaign.progress`** (account level, throttled 1 / s per campaign) `{ campaignId, status, counters }` — WS events **+1 → 41**.

**WhatsApp call campaigns (T19.15):** Phase 8 `campaigns.line: 'phone' | 'whatsapp'` (default `phone`), `campaigns.channelId` (required when `whatsapp`); dispatcher: `line === 'whatsapp'` → `startOutbound({ channelId, contactId, mode: 'ai', program: flow })`; audience skip `no_call_permission` (not `waCallPermission: 'allowed'` for that number, checked again before each dial); a contact unanswered twice in the campaign → skipped `unanswered_limit`. Optional `askPermissionFirst: { templateId }` → creates a bulk permission run (T18B.4) for the not-yet-allowed contacts; allowed replies within the campaign window join automatically (permission service hook → campaign recipient add, idempotent).

**Catalogue (append; update count tests in the same commit as the code):**

- Error codes **+7 → 115:** `SIGNUP_CLOSED` (403), `AUTH_EMAIL_TAKEN` (409), `AUTH_ROUTE_GONE` (410), `RESELLER_NOT_APPROVED` (403), `TOPUP_NOT_ALLOWED` (403), `WA_CAMPAIGN_NOT_EDITABLE` (409), `WA_CAMPAIGN_AUDIENCE_EMPTY` (422).
- Audit actions **+20 → 194:** `account.signed_up`, `account.reseller_changed`, `platform.signup_settings_updated`, `reseller.approved`, `reseller.customer_created`, `reseller.customer_suspended`, `reseller.customer_enabled`, `reseller.customer_password_reset`, `reseller.credit_transferred`, `reseller.credit_reclaimed`, `reseller.login_as_started`, `reseller.login_as_stopped`, `reseller.settings_updated`, `whatsapp_campaign.created`, `whatsapp_campaign.started`, `whatsapp_campaign.paused`, `whatsapp_campaign.resumed`, `whatsapp_campaign.stopped`, `whatsapp_campaign.completed`, `whatsapp_campaign.retried` (meta: ids, counts, amounts in micros, kinds — never phones / passwords).
- Notifications **+6 → 45:** `account.reseller_signed_up` (superadmins), `reseller.approved` (reseller owners / admins), `wallet.credit_received` (customer owners / admins), `wallet.customer_low_balance` (reseller owners / admins), `whatsapp_campaign.completed` (creator), `whatsapp_campaign.paused` (creator + owners / admins, with reason).
- Permissions **+4 → 49**, ledger types **+2 → 12**, WS events **+1 → 41**, migrations **0021**, **0022**.
- Limiters (inventory `docs/api/rate-limits.md`): `signup-ip`, `login-as`, `reseller-customer-create`, `reseller-credit`, `wa-campaign-create`.

**Frontend routes:** `/signup` (type cards), `/reseller` (dashboard), `/reseller/customers`, `/reseller/customers/:id`, `/reseller/statement`, `/reseller/settings`, `/campaigns?line=whatsapp` (tab), `/campaigns/whatsapp/new`, `/campaigns/whatsapp/:id`; `/verify-email` → redirect `/login`. Nav: **Reseller** group only when `session.account.kind === 'reseller'`; **Campaigns** gains the WhatsApp tab when the account has a connected number.

**Done when:** (1) a business and a reseller sign up with no e-mail and land logged in; (2) superadmin creates a reseller + a business, logs in as each (view and act), sensitive actions refused; (3) a reseller creates a customer, gives ₹500 credit, logs in as it, comes back, takes back ₹100 — ledgers sum to 0; another reseller gets 404 on that customer; (4) a 1,000-recipient WhatsApp campaign on fake Meta finishes with correct counters, charges and skips, a kill mid-run sends nobody twice, pause / resume / stop work, tier pacing waits; (5) a 100-contact WhatsApp call campaign on the dry-run line completes with only allowed contacts dialled; (6) all catalogue counts, docs, OpenAPI updated; suites green per §2.

---

## 2. RULES OF ENGAGEMENT

1. **NEVER STOP, NEVER WAIT, NEVER ASK.** Checkpoints are commits, not pauses. Only a 2-line progress note at the checkpoint, same turn.
2. **Blocked? Unblock yourself:** plan default → safest convention-consistent choice → deviation note in the plan changelog. Missing outside input → skip only that sub-step, open item, continue.
3. **Safety:**
   - No real Meta calls / sends from code or tests (fake Meta only). No real Razorpay (mock).
   - Never print / log / commit tokens, secrets, passwords, phone numbers (last 4 only), names or message texts. Never read `~/Downloads/*.env*`.
   - Never connect to `45.114.245.71` or `13.232.191.62`; live site: public GET / HEAD only.
   - Mac Docker: only `cav-*` containers and one-off `docker run --rm`. Never touch other projects' processes.
   - Never weaken a security check to make something pass (the auto-mode classifier refuses it — rightly); fix the flagged code instead.
4. **Git:** branch `feature/phase-19-reseller-campaigns` in both repos; never on `main`; one commit per task per repo; hooks must pass (no `--no-verify`, no `--force`); **no push / merge / client sync** unless the owner asks. Footer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; lines ≤ 100; message in a scratchpad file + `git commit -F`; tag `[P19-T19.x]`. **Commit only after the task's checks passed** — `if <checks>; then git commit …; fi`, never chained with `;`.
5. **Test policy (owner rule, binding — fast):**
   - While writing: only the changed files' tests (`npx vitest run <files>`). New test files per task as listed in each task.
   - Before each commit: backend `npm run lint` · `npm run typecheck` · the task's tests; routes / schemas changed → `npm run gen:openapi` + stage + `npm run openapi:check`; frontend `npm run lint` (or eslint on changed paths) · `npm run typecheck` · changed tests; `npm run gen:api` after backend schema changes.
   - **Checkpoint B2** (after T19.8): backend `npx vitest run --maxWorkers=2` **once**; frontend `npx vitest run` **once**; both builds. Real exit codes to a file (`code=$?` right after the command).
   - **Sign-off (P19-DONE):** backend `npx vitest run --coverage --coverage.reportOnFailure --maxWorkers=2` **once**; frontend `npx vitest run --coverage --coverage.reportOnFailure` **once** (coverage in the same single run — no extra plain run); builds; `openapi:check`; Playwright: **new specs + affected specs only** (auth, admin, reseller, contacts, campaigns, templates, wallet) once with `E2E_BACKEND_LOGS=1` + log grep; the full 170+ only if auth / session / layout changed in a way those can't show — decision written in the sign-off.
   - **Flake:** a failure in a known flake file (or a 15 s timeout under load) → re-run **only that file** once; passes → record as flake; fails again → real failure. Never re-run a whole suite.
   - Full runs in the background with `caffeinate -dims`; **no code edits while a full run is going**; never two full runs at once.
   - Before a full run: `docker ps` shows `cav-mongo` and `cav-redis` up; `uptime` load < 8 (else wait for it — other projects' containers), never kill other projects' work.
6. **Coverage gates stay green; never lower thresholds or raise timeouts; no dynamic `import()` in backend tests.** New code ≥ 95 % lines.
7. **No external network in tests** (fake Meta, mock payments, stub servers).
8. **Docs + catalogue counts in the same commit** as the code.
9. **Real bugs:** failing regression test first → `fix(<area>)` commit → plan changelog.
10. **Progress note** at the checkpoint: "P19-B2-DONE ✅ — <n> backend / <m> frontend tests; next: T19.9" — nothing more.

---

## 3. RESUME SAFETY

1. `git branch --show-current` → `feature/phase-19-reseller-campaigns` in both; `git log --oneline -15`.
2. Last `[P19-…]` tag = position; tracker ticks must agree.
3. Uncommitted work → read `git diff`, finish that task, run its tests, commit.
4. A full run may still be going (check background tasks / output file) — never two at once.
5. Infra up → lint + typecheck → last task's tests → continue with the next task.

---

## STEP 0 — P19-SETUP

1. Backend: on `feature/phase-19-reseller-campaigns` (has `[P19-PLAN]`); `git status` shows only this prompt. Frontend: `git switch -c feature/phase-19-reseller-campaigns` from `471bfa0`.
2. `git fetch origin` both; if `origin/main` moved, merge `main` in, lint + typecheck.
3. Write `docs/phases/PHASE_19_TASKS.md` (tracker, 16 rows, batch column B1 = T19.1–T19.4, B2 = T19.5–T19.8, B3 = T19.9–T19.14, B4 = T19.15–T19.16).
4. Plan status → **Locked**; changelog: "Run prompt prepared — defaults D1–D12 in use; literals locked: errors +7 → 115, audit +20 → 194, notifications +6 → 45, permissions +4 → 49, ledger +2 → 12, WS +1 → 41, migrations 0021 / 0022."
5. BUILD_PLAN_V2: Phase 19 line becomes "Open signup, resellers, bulk WhatsApp campaigns (this phase)", inbound phone calls → Phase 20 (one-line note; no other roadmap edits).
6. Commit → `docs(plans): lock phase 19 plan and add run prompt [P19-PLAN]`.
7. `npm run infra:up`; lint + typecheck both. **No full test run here.** Continue into T19.1.

---

# ═══════════ BATCH 1 — Accounts, signup, login as (T19.1 → T19.4) ═══════════

## T19.1 — Account kinds and parent → `feat(accounts): add account kinds and reseller parent [P19-T19.1]` (backend)

1. `account.model.ts` fields per §1 (+ types `AccountKind`, `ResellerInfo`); `isReseller`, `isChildOf(account, resellerId)` helpers in `modules/account/kinds.ts`.
2. Migration `0021-accounts-resellers` per §1, registered in `migrations/index.ts`; the phase 2 down-chain test (`tests/db/phase2-migrations.test.ts`) gets one more `migrateDown` line (lesson from 18B); 0020 test "is the last one" moves to 0022 at T19.9.
3. Session / `GET /auth/me` / account JSON gain `account.kind`, `account.parent: { id, name } | null`, `account.reseller` (own account only).
4. Platform setting key `signup` with validator + code default.
5. Tests: `tests/accounts/kinds.test.ts` (migration idempotent + backfill + unverified → verified + previous release reads accounts; helpers; me payload). Docs: `data-model.md` Phase 19 section, `DATA_MAP.md` (no new personal data; note fields).

## T19.2 — Signup without e-mail → `feat(auth): sign up without e-mail as a business or reseller [P19-T19.2]` (both)

1. Backend per §1: new `SignupBody`, `signup()` rewritten (no mail; creates account `kind` + roles + owner + wallet like today's verified path; returns the login session through the same code as `login`), `GET /auth/signup-options`, honeypot, limiter `signup-ip`, `SIGNUP_CLOSED`, `AUTH_EMAIL_TAKEN`, `AUTH_ROUTE_GONE` for the verify routes, login + refresh without `emailVerifiedAt`; audit `account.signed_up` (meta `kind`); bell `account.reseller_signed_up` to superadmins; reseller `pending_approval` when the setting says `approval`.
2. Remove the now-dead mail calls from signup (`auth.verify_email`, `auth.account_exists` templates stay in the catalogue only if still used elsewhere — else delete them and their tests in the same commit).
3. OpenAPI for both routes; error-codes doc rows; `docs/conventions/security.md` + `api.md` sections "Signup" rewritten.
4. Frontend: `SignupPage.tsx` — step 1 type cards (Business: "Use the platform for your own business" / Reseller: "Create and manage accounts for your customers"), step 2 form (business name, your name, e-mail, phone (optional), password + strength + show, timezone default from the browser, terms checkbox), hidden honeypot input (`tabIndex -1`, `aria-hidden`, off-screen), errors per code (`AUTH_EMAIL_TAKEN` → link to login), success → store session → `/` (business) or `/reseller` (reseller); hide the reseller card when `resellerSignup: 'closed'`, show "Signups are closed" when `open: false`; `/verify-email` route → `<Navigate to="/login" />`; delete `VerifyEmailPage.tsx` + its tests; login page link "Create an account".
5. Tests: backend `tests/auth/signup-open.test.ts` (business / reseller / closed / reseller closed / approval / duplicate / honeypot / limiter / weak password / logged in + refresh works / old unverified user logs in / verify routes 410); frontend `auth-pages.test.tsx` signup cases (types, closed states, errors, redirect).

## T19.3 — Log in as v2 → `feat(auth): log in as an account to act, with sensitive actions blocked [P19-T19.3]` (both)

1. Claims + `accessTokenFor` options per §1; `impersonate(req, id, { mode, kind })` generalised (shared by admin and reseller), owner must be active (verification no longer required).
2. `blockSensitiveWhenImpersonating()` + classification of the 31 route files (keep a table in `security.md`); test `tests/security/login-as-matrix.test.ts` table-driven: each sensitive route → 403 in `act` and `view`; a sample of ordinary writes → 403 in `view`, OK in `act`; nested → 409; reseller → only children (others 404); TTL + no refresh.
3. Reseller route `POST /reseller/customers/:id/login-as` lands in T19.5 but its service function + tests here.
4. Audit per §1 both sides; existing `admin.impersonation_*` meta gains `mode`.
5. Frontend: banner shows "Viewing as" / "Logged in as" + account name + **Back** (`returnTo`), view mode keeps the read-only hints; act mode hides only sensitive buttons (the backend refuses anyway); admin account page: buttons "View as" and "Log in as".
6. Tests: frontend banner both modes + back; admin page buttons per mode.

## T19.4 — Superadmin resellers and users → `feat(admin): create resellers and move customers between them [P19-T19.4]` (both)

1. Backend per §1: `createAccount` `kind` + `parentAccountId`, `PATCH /admin/accounts/:id/reseller`, `POST /admin/accounts/:id/approve-reseller`, `GET / PUT /admin/settings/signup`, list filters + row fields; suspending a reseller doesn't suspend customers (D7) — add "Suspend all customers" action `POST /admin/accounts/:id/suspend-customers` (confirm, audit each `account.suspended` existing action).
2. Frontend admin: create dialog type select (Business / Reseller) + optional reseller picker for business; accounts list filter chips (All / Resellers / Businesses / Under reseller X), columns kind + parent + customers; account detail: "Reseller" card (approve, customers count, link "Customers" filtered), "Move to reseller" dialog; platform settings page card "Signup" (open switch, reseller signup select).
3. Tests: backend `tests/admin/resellers.test.ts` (create both kinds, parent must be reseller, move + audit, approve + bell, settings validate + audit, suspend-customers); frontend admin tests for dialog, filters, settings card.

---

# ═══════════ BATCH 2 — Reseller panel + credit (T19.5 → T19.8) ═══════════

## T19.5 — Reseller API → `feat(resellers): manage customers from the reseller panel [P19-T19.5]` (backend)

1. `modules/resellers/` (`resellers.routes.ts`, `.schema.ts`, `.service.ts`, `.openapi.ts`) per the §1 table; router mounted in `routes.ts`; OpenAPI import.
2. Customer create = `createAccount` core (kind business, parent = reseller) + optional starting credit (T19.6 transfer) in one flow; owner gets no e-mail (password set by the reseller; the UI shows it once).
3. Permissions +4 per §1 (`PERMISSION_INFO`, `SYSTEM_ROLES`, rbac snapshot updated); `RESELLER_NOT_APPROVED` on creates / credit when pending.
4. Audit per §1; tenant rule: `resellers.service` is the only code that queries accounts by `parentAccountId`.
5. Tests: `tests/resellers/customers.test.ts` (CRUD, ownership 404 from another reseller, business account → 404 on `/reseller/*`, pending → 403, limiter, password policy, list aggregate shape without N+1 — assert query count ≤ 3 with a mongoose debug spy).

## T19.6 — Credit transfer → `feat(billing): move credit between a reseller and its customers [P19-T19.6]` (backend)

1. `core/billing/transfer.ts` `transferCredit({ fromId, toId, amountMicros, transferId, actor, note })` per §1 (transaction + both locks in id order + ledger pair + wallet balance updates + realtime `wallet.updated` both + bells); reclaim uses the same function reversed with the available-balance check.
2. Routes `credit`, `credit/reclaim`, `statement` (JSON + CSV) in the reseller router; Idempotency-Key.
3. Top-up guard in `modules/wallet/topups.service.ts` (`TOPUP_NOT_ALLOWED`); low-balance alert fan-out to the reseller (`wallet.customer_low_balance`).
4. Ledger types +2; reconcile check (`core/billing/reconcile.ts`) treats each transfer pair as a zero-sum unit.
5. Tests: `tests/billing/credit-transfer.test.ts` (happy, insufficient, suspended customer, idempotent retry returns the same transfer, concurrent transfers from one reseller never overdraw — 10 parallel, reclaim ≤ available, ledger sum 0, top-up refused / allowed by setting, low-balance bell to reseller).

## T19.7 — Reseller dashboard numbers → `feat(resellers): show the reseller dashboard numbers [P19-T19.7]` (backend)

`GET /reseller/summary` → `{ customers: { active, suspended, total }, creditGivenThisMonthMicros, customersSpend30d: { calls, whatsapp, ai, totalMicros }, lowBalanceCustomers: [{ id, name, availableMicros }] (≤ 10) }`, one aggregate pipeline over ledger by `accountId ∈ children`, cached 5 min (busted on transfer / customer create). Test `tests/resellers/summary.test.ts`.

## T19.8 — Reseller panel → `feat(resellers): add the reseller panel [P19-T19.8]` (frontend)

1. `services/api/resellers.ts`, `features/resellers/` (`keys.ts`, `queries.ts`, `permissions.ts` `useIsReseller` / `useCanManageReseller`), pages `pages/reseller/ResellerDashboardPage.tsx`, `ResellerCustomersPage.tsx`, `ResellerCustomerPage.tsx`, `ResellerStatementPage.tsx`, `ResellerSettingsPage.tsx` (all lazy).
2. Customers table (search, status filter, wallet, spend 30 d, last active) + **Add customer** dialog (fields, password with generate + copy, starting credit), customer page (wallet card with Add credit / Take back dialogs — amount in ₹, confirm; usage; transfers; Suspend / Enable; Reset password; **Log in as**), statement (date range, CSV download), settings (customers can top up switch with explanation).
3. Nav group **Reseller** (dashboard, customers, statement, settings) only for reseller accounts; pending-approval banner on every reseller page; customers of a reseller see "Credit is added by <reseller name>" instead of the top-up button when not allowed.
4. Tests: `features/resellers/reseller.test.tsx` (nav visibility, list, create dialog validation + success, credit dialogs + errors, login-as flow + banner back, pending banner, customer top-up hidden).

## P19-B2-DONE — checkpoint

Backend full suite **once** (no coverage), frontend **once**, both builds, exit codes in a file. Real failures → fix + that file again; flakes → that file once. Tracker ticks T19.1–T19.8; plan changelog with numbers; progress note; **continue to T19.9**.

---

# ═══════════ BATCH 3 — Bulk WhatsApp campaigns (T19.9 → T19.14) ═══════════

## T19.9 — Campaign model + audience → `feat(campaigns): add whatsapp campaign model and audience [P19-T19.9]` (backend)

1. Models + migration `0022` per §1 (+ migration test; move "last one" assertion); DATA_MAP + erase map (`whatsappCampaigns` keep — ids / counters; `whatsappCampaignRecipients` delete with the contact); tenant check.
2. `modules/whatsapp-campaigns/audience.ts`: resolve lists / segment / tags / contactIds / CSV (`csvUploadId` → existing contact import parse → upsert contacts source `import`), cap `WA_CAMPAIGN_MAX_RECIPIENTS`, snapshot recipients in batches of 1,000 (`insertMany` ordered:false, unique index absorbs duplicates); skip rules per §1 in this order: `invalid_phone`, `suppressed`, `dnd`, `opted_out`, `no_whatsapp`, `marketing_stopped` (MARKETING variants only), `sent_recently` (same template to that contact within `excludeRecentDays`, one aggregate on messages), `missing_variable` (required variable has no value for that contact); variant assignment by split % (deterministic by contact id hash).
3. Tests: `tests/whatsapp-campaigns/audience.test.ts` (each source, each skip reason, cap, dedupe, split deterministic).

## T19.10 — Estimate + wallet → `feat(campaigns): estimate whatsapp campaign cost and check the wallet [P19-T19.10]` (backend)

`estimate.ts` per §1 (markets from recipients' phones, price per variant category via the existing pricing service — no new price math), `start` refuses `WALLET_INSUFFICIENT_BALANCE` with `details: [{ path: 'shortfallMicros', message: <n> }]`, `WA_CAMPAIGN_AUDIENCE_EMPTY`. Tests `tests/whatsapp-campaigns/estimate.test.ts`.

## T19.11 — Sender → `feat(campaigns): send whatsapp campaigns with tier pacing [P19-T19.11]` (backend)

1. `dispatch.ts` job per §1: claim batch → per recipient `upsertConversation` + `sendMessage` (template, variables resolved from the mapping, `clientId` stable) → recipient `sent` + `messageId`; Meta / send errors → `failed` + code (retryable ones retried up to 2 times inside the job with backoff); counters `$inc`; progress event.
2. Pacing per §1 (`pacing.ts`: pure `allowedNow({ tier, sentLast24h, mps })`), `waiting_for_limit` + `nextBatchAt`; sweep job resumes.
3. Pause / resume / stop / auto-pause per §1 (checked between batches and before each send); restart safety (sweep resets stale claims); recurrence via Phase 8 `recurrence.ts` (a new run = a new campaign row cloned, `parentCampaignId`).
4. Audit per §1, bells `whatsapp_campaign.completed` / `.paused`.
5. Tests: `tests/whatsapp-campaigns/dispatch.test.ts` (happy 200 on fake Meta; kill mid-batch → re-run → no duplicate `clientId` sends; pause / resume / stop; wallet empty → paused; template paused → paused; tier 250 with 600 recipients → 250 then `waiting_for_limit`; retryable failure retried, permanent one failed with code), `pacing.test.ts`.

## T19.12 — Stats, replies, retry, export, report → `feat(campaigns): track whatsapp campaign results [P19-T19.12]` (backend)

1. Status webhook hook: message status → recipient status (only forward moves) + counters; failed → `failed[metaCode]`.
2. Inbound hook: reply within 72 h → `repliedAt` + `replied` counter (once).
3. `retry-failed` (retryable codes only, audit `whatsapp_campaign.retried` meta count), `recipients` list, CSV export (masked phones unless `contacts.export`), report `{ funnel, cost, byErrorCode, perDay, variants: [{ key, sent, read, replied }], winner }`; A/B winner decision in the sweep (after `afterHours`, highest metric; ties → A); remaining `pending` recipients switch to the winner.
4. Tests: `tests/whatsapp-campaigns/results.test.ts` (status chain, out-of-order statuses, reply once, retry, export masking, report numbers, A/B winner).

## T19.13 — Wizard + dashboard → `feat(campaigns): add the whatsapp campaign wizard and dashboard [P19-T19.13]` (frontend)

1. `services/api/whatsapp-campaigns.ts`, `features/whatsapp-campaigns/` (keys, queries with progress over WS + 5 s poll fallback, labels for statuses / skip reasons / pause reasons / Meta codes).
2. Campaigns page tabs **Phone** / **WhatsApp** (`?line=`); WhatsApp list (name, number, status chip, progress, sent / delivered / read / replied, cost, created).
3. Wizard `/campaigns/whatsapp/new` (lazy): Number → Template(s) (approved only, preview, optional A/B with split + winner metric) → Variables (per variable: contact name / phone / field / static, preview with a sample contact) + header media → Audience (lists / segment / tags / CSV upload / preselected contacts from `?contactIds` / `?listId` / `?segmentId`) + exclude recent days → Schedule (now / at / recurring) → **Cost & wallet** (estimate table by market, skipped by reason, wallet bar; not enough → "Add credit" / reseller note) → Review & Start (Idempotency-Key).
4. Campaign page `/campaigns/whatsapp/:id`: live counters + funnel, pace line ("Next batch at 14:30 — your number can message 1,000 people a day"), pause reason alert, buttons pause / resume / stop / retry failed, recipients table (status filter), export, report tab (funnel, cost, errors, per-day chart, variants).
5. Entry points: Contacts bulk bar / list rows / segment rows → "Send WhatsApp campaign" (opens the wizard with the audience).
6. Tests: `features/whatsapp-campaigns/wizard.test.tsx` (each step validation, estimate states, start), `campaign-page.test.tsx` (live updates, actions, pause reasons, report), entry points.

## T19.14 — Roles, limits, catalogue → `feat(campaigns): roles, limits and catalogue for whatsapp campaigns [P19-T19.14]` (both)

Route permissions per §1 (agent / viewer read-only UI), limiter `wa-campaign-create`, `docs/api/rate-limits.md`, catalogue counts (errors 115, audit 194, notifications 45, permissions 49, ledger 12, WS 41) all asserted in `tests/calls-wa/catalogue.test.ts` (or a new `tests/catalogue/phase19.test.ts` when cleaner), `websocket.md` row, OpenAPI. Frontend: buttons hidden per permission; tests per role.

---

# ═══════════ BATCH 4 — Call campaigns, finish (T19.15 → T19.16) ═══════════

## T19.15 — WhatsApp call campaigns → `feat(campaigns): run call campaigns over whatsapp [P19-T19.15]` (both)

1. Backend per §1: `campaigns.line` + `channelId` (schema, validation: flow published, number calling enabled + readiness not blocked), dispatcher branch, skip `no_call_permission` / `unanswered_limit`, `askPermissionFirst` → bulk permission run + permission-granted hook adds the contact (idempotent), results as Phase 8.
2. Frontend: wizard line picker (Phone / WhatsApp + number), audience note "Only customers who allowed WhatsApp calls are called", optional "Ask for permission first" (approved permission template picker from T18B.5), detail page shows the line.
3. Tests: `tests/campaigns/whatsapp-line.test.ts` (allowed-only, re-check before dial, unanswered limit, ask-first chain, 100 contacts dry-run complete), frontend wizard line tests.

## T19.16 — E2E, perf, docs, sign-off → `docs: add phase 19 sign-off [P19-T19.16]` (both)

1. Playwright new specs (`e2e/`): `signup-open.spec.ts` (business + reseller), `reseller-panel.spec.ts` (create customer, credit, log in as, back, take back), `admin-resellers.spec.ts` (create reseller, view as + log in as, sensitive refused), `whatsapp-campaign.spec.ts` (50 contacts fake Meta: start → pause → resume → completed stats), `whatsapp-call-campaign.spec.ts` (5 contacts dry-run). Update specs that used the e-mail code signup / verify page.
2. Perf: `npm run perf:wa-campaign` (new `scripts/perf-wa-campaign.ts`: 1,000 recipients on fake Meta, time to complete, kill + resume → 0 duplicate `clientId`), result in `docs/ops/capacity.md`.
3. Docs: `security.md` + `api.md` (signup without e-mail, login as v2), new `docs/conventions/resellers.md` (model, permissions, credit, login as, what resellers can / can't see), `api.md` WhatsApp campaigns section, `data-model.md`, `audit.md`, `error-codes.md`, notifications list, `websocket.md`, `DATA_MAP.md`, `docs/api/rate-limits.md` inventory, `security.md` login-as table, both CHANGELOGs, both `src/README.md`, BUILD_PLAN_V2 line ("Phase 19 … Next: Phase 20 inbound phone calls"), `releases.md` pending entry (migrations 0021 / 0022, env `WA_CAMPAIGN_MPS`, `WA_CAMPAIGN_MAX_RECIPIENTS`).
4. Gap audit G1–G7 → commits; `PHASE_19_SIGNOFF.md`: verdict, task table, Done-when table, numbers before → after, test runs (honest: flakes, what didn't run), deviations, open items (white-label, commission engine, click tracking, password reset without e-mail if the owner wants it).

## P19-DONE — sign-off run → `docs: mark phase 19 complete [P19-DONE]` (both)

1. One background script, `caffeinate -dims`, real exit codes: backend coverage (report on failure), backend build, `openapi:check`, frontend coverage (report on failure), frontend build, Playwright (new + affected specs, §2 rule 5) with `E2E_BACKEND_LOGS=1` → grep the clean log for `cav_(live|test)_[0-9A-Za-z]{32}`, `whsec_`, `v1=[0-9a-f]{64}`, `\+91[0-9]{10}`, `Bearer [A-Za-z0-9._-]{20,}`, `"password"`, `otpauth`, `\$enc`, `mongodb(\+srv)?://[^ ]*@`, `AKIA[0-9A-Z]{16}`, `Basic [A-Za-z0-9+/=]{16,}`, `EAA[A-Za-z0-9]{20,}`, `rzp[_]live_` → all 0.
2. `npm audit --omit=dev` both; secret scan of `git diff main...HEAD` both (patterns above + `(ARI|SIP)_PASSWORD=` with a literal value, `ownerPassword":"` with a value); `git status` clean; `git log --oneline main..HEAD` in the report.
3. Fill the numbers in the sign-off (a flake is a flake; a run with timeouts is not "green").
4. Final report (Hinglish).

---

## 4. FINAL CHECKLIST

- [ ] Plan locked + tracker + prompt committed `[P19-PLAN]`; BUILD_PLAN_V2 reorder line
- [ ] Account kinds + parent + migration 0021 (unverified → verified); `signup` platform setting
- [ ] Signup without e-mail (business / reseller), signup options, honeypot, limiter, closed states, 410 verify routes; login without verification
- [ ] Login as v2: view / act, reseller → children only, sensitive block on both, nested refused, 31 route files classified, banner + back
- [ ] Superadmin: create reseller / business, parent, move, approve, signup settings, suspend customers
- [ ] Reseller API + permissions +4; ownership 404s; limits
- [ ] Credit transfer + reclaim + statement; ledger +2; top-up guard; low-balance fan-out; reconcile zero-sum
- [ ] Reseller dashboard numbers + panel pages + nav + pending banner
- [ ] WhatsApp campaigns: models + migration 0022, audience + skips, estimate + wallet, sender + pacing + claims + auto-pause, stats + replies + retry + export + report + A/B, wizard + dashboard + entry points, roles
- [ ] WhatsApp call campaigns (allowed only, unanswered limit, ask-first chain)
- [ ] Catalogue: errors 115, audit 194, notifications 45, permissions 49, ledger 12, WS 41 — count tests; DATA_MAP + erase map + tenant rules; OpenAPI; rate-limit inventory
- [ ] E2E new specs, perf 1,000-recipient campaign, docs, CHANGELOGs, READMEs, sign-off, tracker
- [ ] Each suite once at B2 + once at sign-off (with coverage); targeted Playwright; log grep 0; `npm audit` 0; secret scan clean; `git status` clean
- [ ] No push / merge / client sync unless the owner asks

## 5. FINAL REPORT (Hinglish, short)

1. Ek line: signup, reseller panel, login as, bulk WhatsApp + call campaigns ab kis haal mein.
2. Done-when table (1)–(6) pass / fail.
3. Numbers: tests before → after, coverage, Playwright (kya chala, kya nahi).
4. Bugs found + fixed; flakes (honest).
5. Open items (white-label, commission, click tracking, password reset without e-mail, live Meta campaign on the owner's number).
6. Commits list; kuch push nahi hua (unless asked).
