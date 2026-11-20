# SAC RUN — Superadmin full access + WhatsApp calling (Meta direct, schedule, AI incoming) — Autonomous Run Prompt

> **HOW TO RUN (ise paste karo):**
> `cell-ai-voicebot-backend/docs/prompts/SUPERADMIN_WA_CALLING_PROMPT.md poora padho aur SAC-T0 se SAC-T13 tak SAARE tasks step by step autonomously implement karo. Bich me question ya permission mat maango — decisions is prompt me locked hain (§3); koi routine choice ho to existing conventions se lo aur report me likho. Har task ke baad sirf us task ke relevant tests + lint/typecheck, phir commit (tag [SAC-Tn]). Full suites sirf SAC-T13 me ek-ek baar. Koi push / merge / deploy / client sync NAHI. Real Meta / Pinnacle / real phone call tabhi jab owner chat me explicitly bole. Ant me [SAC-DONE] commit + short Hinglish report.`
>
> Working directory: `/Users/lalitbansal/Documents/cell-ai-voicebot` (backend + frontend repos andar).

---

## 0. Context (verified facts — dobara derive mat karna)

- **Plan:** [SUPERADMIN_AND_WA_CALLING_PLAN.md](../plans/SUPERADMIN_AND_WA_CALLING_PLAN.md) (20 Nov 2026). Ye prompt us plan ka execution hai; plan aur prompt me farak ho to **prompt jeetega**.
- **AutoChatix reference (sirf UX/wording, code copy NAHI):** `~/Documents/Autochatix/whatsapp-ai-calling-audit-2026-11-11/execution-plan.md` §2 (Incoming settings, Outgoing "Call myself / Call with AI / Schedule"), Phase 6 + Phase 9 (preflight at execution, exact-once dispatch, AI callback rules).
- **Repos / refs (deployed release `release-20261120-204231c`):**
  - backend `main` = `204231c` (Pinnacle getwebhook list fix). Working tree me sirf untracked `docs/plans/SUPERADMIN_AND_WA_CALLING_PLAN.md` + ye prompt.
  - frontend: deployed code = `1737103` on branch `feat/embedded-signup-solution-id` (frontend `main` = `71c7c11` peeche hai). **Is branch se** naya branch banana.
- **Login-as / impersonation (Phase 2 + 19):**
  - `src/modules/auth/login-as.ts` — `startLoginAs(req, account, { mode: 'view'|'act', kind: 'superadmin'|'reseller', action })`; owner ka token, session `imp_<random>`, `IMPERSONATION_TTL = '30m'` (`auth.constants.ts:13`; file comment "1 h" galat hai), no refresh, nested → 409, audit dono accounts me.
  - `src/modules/auth/session.ts` — claims `imp` (impersonatorId), `imm` (mode), `imk` (kind); `buildSessionBody(..., { impersonatorId, expiresAt, mode, kind, returnTo })`.
  - `src/modules/admin/admin.routes.ts:258` — `POST /admin/accounts/:id/impersonate { mode }` → `admin.service.ts impersonate()`.
  - `src/shared/middlewares/require-permission.ts`:
    - `blockWhenImpersonating()` — `view` me block, `act` allowed (51 route uses; biggest: whatsapp-calling 8, whatsapp-admin 6, inbox 4, calls 4).
    - `blockSensitiveWhenImpersonating()` — har login-as me block (18 uses): `auth.routes.ts` (change-password, logout-all, sessions), `mfa.routes.ts:97`, `api-keys.routes.ts:52,62`, `team.routes.ts:85` (ownership), `privacy.routes.ts:44,84,85`, `wallet.routes.ts:45`, `topups.routes.ts:54,79,91`, `billing.routes.ts:35`, `webhooks/endpoints.routes.ts:35,118`, `resellers.routes.ts` (router-level).
    - `requirePlatformAdmin()` — impersonating → 403 (isko mat chhedna).
  - Inline checks: `whatsapp-calling/dial-guard.ts:67` (`if (input.impersonating) return no('AUTH_FORBIDDEN','impersonating')`), `whatsapp-calling/calls.service.ts:627`, `inbox/inbox.routes.ts:252` (read mark), `auth/mfa.service.ts:31`, `auth/login.service.ts:155`, contact-exports / record-exports routes, `contacts/bulk.service.ts:244`.
  - Tests: `tests/security/login-as-matrix.test.ts`, `phase16-sensitive.test.ts`, `phase15-routes.test.ts` / `phase16-routes.test.ts` snapshots, `money-writes.test.ts`, `tenant-scope.test.ts`.
  - Frontend: `pages/admin/AdminAccountDetailPage.tsx:210,252` (`adminApi.impersonate(id, mode)`), `services/api/admin.ts:128`, `features/auth/store.ts` (`impersonation`, saved admin session), `features/auth/session.ts:46,92` (stop), `layout/Banners.tsx`, `layout/Header.tsx`, `layout/Sidebar.tsx`, `app/providers.tsx`, aur ~35 feature files jo `impersonating` se UI chhupaate hain (`grep -rln impersonat src | grep -v test`).
- **WhatsApp calling (Phase 12 / 18B):**
  - `modules/whatsapp-calling/calls.service.ts` — `createWhatsAppCalls(deps)`: `startOutbound` (587), `onWebhook` (527), `startInbound` (1174), `ringTeam` (997), `acceptInbound` (1071), `rejectInbound` (986), `transferToTeam` (1059), `refuseBusy` (1103), `onEnded` (353) → `bubble` (264) + `performSettlement` (301).
  - `dial-guard.ts` `assertDial` (number → account → customer + TRAI window → limits → program → Meta permission), `routing.ts` (`withinCallHours`, `selectRingTargets`), `team-then-ai.ts`, `program.ts`, `permissions.service.ts`, `readiness.ts` (10 checks), `settings.service.ts`, `jobs.ts`, `runtime.ts`, `bus.ts`.
  - Channel model `db/models/whatsapp-channel.model.ts`: `INBOUND_ROUTES = ['team','ai','ai_then_team','team_then_ai']` (117), `WaCallingInbound { route, aiProgram {kind:'flow'|'agent', id}, ringTimeoutSec, ringUserIds }`, `WaCalling { status, callHours, callbackPermission, inbound, lastCallsWebhookAt, … }`, `defaultCalling()`.
  - Routes `calling.routes.ts`: `GET/PATCH /whatsapp/channels/:id/calling`, `/calling/readiness`, `/calling/sync`, `/calling/quote`, `/whatsapp/call-permissions[/bulk|/request]`, `POST /whatsapp/calls`, answer/hold/transfer, `/calls/:id/media-ticket`, `PATCH /users/me/call-availability`.
  - Frontend: `features/whatsapp-calling/live/CallButton.tsx` (menu: "Call yourself" / "Call with AI"; "Request permission"; "Requested · waiting"; "Can't call"), `CallWithAiDialog.tsx`, `ProgramPicker.tsx`, `controller.ts placeCall()`, `IncomingPopup.tsx`, `CallBar.tsx`, `store.ts`; settings `features/whatsapp-calling/settings/{CallingSection,CallingReadiness,CallHoursEditor,form}.tsx`; `features/settings/CallsTab.tsx`; `features/calls/*`, `pages/calls/CallsPage.tsx`.
- **AI callback tool:** `src/core/ai/tools.ts:105,181,263` — `schedule_callback { date, time? }` → `outcome.callback { date, time|null }` (engine type `core/engine/types.ts:97`), agent setting `scheduleCallback { enabled, maxDaysAhead }` (`ai-agent.model.ts:117`). **Abhi WhatsApp call ke baad isse koi call schedule nahi hoti** — SAC-T9 me jodna hai.
- **Meta / provider routing:**
  - `modules/whatsapp/context.ts` — `isPinnacle(channel)`, `clientFor(ctx, channel)` (`meta` → `core/meta/graph.client.ts`, `pinnacle` → `core/meta/pinnacle.client.ts`; Pinnacle calls `PINNACLE_VOICE_BASE_URL` par).
  - Onboarding `whatsapp.service.ts` connect steps (`CONNECT_STEPS`): `phone → details → subscribe → billing → register/coexistence`; `subscribe` = `meta.subscribeApp(token, wabaId)` (`POST /{waba}/subscribed_apps`, line ~433), failure → `subscribe_failed`.
  - App-level webhook `POST /api/v1/webhooks/meta` (raw body, `X-Hub-Signature-256`), fields list `WEBHOOK_FIELDS` in `core/meta/schemas.ts` (incl. `calls`). `getAppSubscriptions` MetaClient method exists (graph + fake). Readiness reads `calls` field with app token (1 h cache).
  - Pinnacle managed numbers: `connectManaged`, `replaceManagedKey`, `resetManagedWebhook`, `setManagedCreditLine` (`whatsapp.service.ts`), webhook `/api/v1/webhooks/pinnacle/:channelId` + header `x-cell-webhook-secret`. Embedded signup Partner Solution ID: `modules/whatsapp/embedded-signup-config.ts` (platform setting `whatsappEmbeddedSignup`).
  - Fake Meta: `core/meta/fake.client.ts`, `fake-calling.ts` (knobs `00020`–`00030`), `core/telephony/whatsapp/fake-user.ts`; fake Pinnacle keys `pin_test_…` / `pin_bad_…` / `pin_low_…`.
- **Billing:** sirf `core/billing/engine.ts` wallet badalta hai — WA calls: `holdForWhatsAppCall`, `extendWhatsAppCallHold`, `settleWhatsAppCall`, `releaseWhatsAppCallHold`.
- **Migrations:** last = `src/db/migrations/0028-pinnacle-provider.ts` (registered in `migrations/index.ts`). Naye: `0029-login-as-full`, `0030-wa-webhook-status`, `0031-wa-scheduled-calls`, `0032-wa-incoming-default` (additive only).
- **Queues:** `core/queues/names.ts`; WhatsApp jobs `whatsapp` queue (`modules/whatsapp/jobs.ts`, `whatsapp-calling/jobs.ts`); worker `core/queues/workers/whatsapp.worker.ts`.
- **Contract:** zod schema → `npm run gen:openapi` + `gen:postman` (backend), frontend `npm run gen:api` (reads `../cell-ai-voicebot-backend/openapi/openapi.json`).

---

## 1. Goal

1. Superadmin kisi bhi account me **"Full access"** se jaakar wo **sab** kar sake jo us account ka owner kar sakta hai (calls bhi), sab audit ke saath.
2. Inbox / contact par **Call ▾ = Call myself · Call with AI · Schedule AI call**.
3. Settings me **"AI se incoming calls uthao"** switch: ON → AI uthaye, OFF → team.
4. Meta numbers ki calls aur webhooks **Meta Graph direct**; onboarding par webhook **automatic** + verify, number par **"Webhook check / Fix"** button; Pinnacle numbers ke liye **"Switch to Meta direct"**.
5. Calling hardening: timeline, latency metrics, uncertain states, health rules.

## 2. Scope

**In:** backend + frontend dono repos, migrations, OpenAPI/Postman, docs, tests, ADR.
**Out:** real Meta/Pinnacle changes, real calls, deploy, client repo sync, Asterisk/server config, TURN server install (sirf env + doc), reseller `act` behaviour (unchanged), SIP outbound behaviour (unchanged).

---

## 3. Locked decisions

| ID  | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Naya login-as mode **`full`**, sirf `kind: 'superadmin'` (reseller → 403 `AUTH_FORBIDDEN`). `full` me `blockWhenImpersonating` aur `blockSensitiveWhenImpersonating` dono pass.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| D2  | **Step-up** (superadmin ka apna password + TOTP agar MFA on) sirf in actions par: account delete (+ cancel delete), account export, ownership transfer, owner ka password change / MFA reset / logout-all, API key create / rotate. Step-up valid 5 min (`stepUpUntil` Redis key per session `imp_…`). Error `STEP_UP_REQUIRED` (HTTP 428).                                                                                                                                                                                                                                                                                                    |
| D3  | `full` session TTL **4 h**; `POST /auth/login-as/extend` +4 h, total max 12 h from start; har extend audit. `view` / `act` TTL 30 min (unchanged).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| D4  | Real money: `full` me Razorpay top-up order **allowed nahi** (`WALLET_TOPUP_IMPERSONATION` 403, message "Use Admin → Wallet → Adjust"); wallet settings / billing profile / webhooks endpoints **allowed**.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| D5  | Attribution: har write me actor = owner user + `impersonatorId` = superadmin. Naye fields: `calls.actedBy { userId, impersonatorId }`, `messages.impersonatorId`, `whatsappCampaigns.createdByImpersonator`, `campaigns.createdByImpersonator`, `whatsappScheduledCalls.impersonatorId`.                                                                                                                                                                                                                                                                                                                                                       |
| D6  | Ringing: impersonation sessions (har mode) WA incoming + SIP inbound ring list me **nahi**; superadmin `full` me banner par toggle **"Ring me too"** (session-scoped Redis flag) on kare to include.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| D7  | `full` me inbox read receipts **send hote hain** (customer ke behalf par kaam); `view` / `act` me abhi jaisa skip.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| D8  | Dial guard: `impersonating` sirf `mode === 'view'` par block. `act` (reseller) aur `full` call kar sakte hain.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D9  | Calls hamesha `clientFor(ctx, channel)` se; `provider: 'meta'` = Graph direct (koi change nahi). Pinnacle numbers Pinnacle path par jab tak **Switch to Meta direct** na ho.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D10 | Webhook auto setup: connect ke `subscribe` step ke baad naya `verify_webhook` step: (a) `GET /{waba}/subscribed_apps` me hamara `META_APP_ID`; (b) app subscriptions (app token `APP_ID                                                                                                                                                                                                                                                                                                                                                                                                                                                        | APP_SECRET`) `whatsapp_business_account`object par`WEBHOOK_FIELDS`sab (min`messages`, `calls`); missing fields → `POST /{app_id}/subscriptions`(object`whatsapp_business_account`, `callback_url = APP_URL/api/v1/webhooks/meta`, `verify_token = META_WEBHOOK_VERIFY_TOKEN`, `fields`= poori list). Fail = channel`webhook.status = 'failed'`+ reason, connect **block nahi** (status`action_needed`reason`webhook_missing`). `override_callback_uri` use **nahi** karna. |
| D11 | Button **"Webhook check / Fix"** (`whatsapp.manage`): verify → missing ho to fix → verify again; result steps list. Daily health (`syncChannel`) me verify only (fix nahi); fail → bell `whatsapp.webhook_missing` (owner + admins) + healthwatch rule `wa-webhook-missing`.                                                                                                                                                                                                                                                                                                                                                                   |
| D12 | **Switch to Meta direct** (Pinnacle channel par, owner/admin ya superadmin `full`): browser me hamara Embedded Signup (Partner Solution ID ke saath, platform payer) → `POST /whatsapp/channels/:id/switch-to-meta { code, wabaId, phoneNumberId }`. Server: WABA + phone id **same** hone chahiye (warna `WHATSAPP_SWITCH_MISMATCH` 422); same channel `_id` par `provider: 'meta'`, token seal, `subscribe` + `verify_webhook`, credit line `attached` (partner), Pinnacle `setWebhook(key, phone, '', {})` best-effort, `pinnacle.*` → `pinnacleArchived`, audit `whatsapp.channel_switched_to_meta`. Calling settings Meta se dobara sync. |
| D13 | Incoming switch mapping: ON + "AI pehle, phir team" → `ai_then_team`; ON + "Sirf AI" → `ai`; OFF → `team`; Advanced "Team pehle, phir AI" → `team_then_ai`. Naya route type **nahi**.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| D14 | Switch ON validation (PATCH par): program set + active/published, `WA_MEDIA_ENABLED`, production me `WA_MEDIA_PUBLIC_IP`, calling `status=enabled`, wallet available ≥ ek call ka hold. Field errors (`inbound.aiProgram`, `calling.status`, `wallet`).                                                                                                                                                                                                                                                                                                                                                                                        |
| D15 | Runtime fallback: AI route par AI start na ho sake (wallet / capacity / program off / provider error) → **team ring**; koi eligible online nahi → reject + missed call (`reason: ai_unavailable` ya `no_agent`) + callback task + bell `call.wa_missed` + webhook `call.missed`. Switch OFF sirf nayi calls par.                                                                                                                                                                                                                                                                                                                               |
| D16 | Account default: `account.settings.waIncoming { route, aiProgram, ringTimeoutSec }`; naya WA number isi se `calling.inbound` shuru kare; number-level override rahe. Settings → Calls me account default card; number page me same card (override).                                                                                                                                                                                                                                                                                                                                                                                            |
| D17 | Scheduled AI call: model `whatsappScheduledCall`; due time UTC + `timezone` (account tz); min 5 min aage, max 30 din; per contact max 3 open; per account max 500 open.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| D18 | Retry (opt-in): `retry.max` 0–2, `gapMin` 15–240, `on` ⊆ `['no_answer','busy','failed']`; har retry naya attempt same row par.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D19 | Dispatch: BullMQ delayed job `wa-scheduled-call` (`jobId = wsc:<id>:<attempt>`) **+** sweep every minute (`wa-scheduled-call-sweep`) for due rows; claim atomic `scheduled → dispatching` (`findOneAndUpdate` with `attempt` match); stale `dispatching` > 10 min → `scheduled`. Exactly-once: call create me `idempotencyKey = wsc:<id>:<attempt>`.                                                                                                                                                                                                                                                                                           |
| D20 | Preflight at due time = `assertDial` (same reasons) + program active + wallet hold. Window/hours ke bahar → next allowed start par **ek baar** auto-shift (`shiftedAt`), dobara bahar → `skipped (outside_window)`. Permission missing/expired → `skipped (no_permission)` (auto request **nahi**).                                                                                                                                                                                                                                                                                                                                            |
| D21 | AI callback: WA call (ai mode) end par `outcome.callback` ho aur agent ka `scheduleCallback.enabled` → `whatsappScheduledCall` (`origin: 'ai_callback'`, program = same, time null → 11:00 account tz) — preflight wahi. Inbox bubble "AI ne callback schedule kiya".                                                                                                                                                                                                                                                                                                                                                                          |
| D22 | Scheduled calls billing: create par sirf estimate (quote API reuse); hold due time par `holdForWhatsAppCall`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| D23 | Permissions: create/edit/cancel `calls.trigger` (+ `whatsapp.read`); list `calls.read`. Public API scope `calls:write` / `calls:read` me routes add (x-scope).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D24 | Events: WS `whatsapp_call.scheduled_updated` (account topic), webhooks `whatsapp_call.scheduled`, `whatsapp_call.scheduled_skipped`; bell `whatsapp.scheduled_call_failed` (creator).                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| D25 | Hardening metrics: `call.timeline[]` (webhook_in, sdp_answered, ice_connected, first_audio_out, first_ai_audio, ai_turn, hold, end) ms offsets; `call.metrics.firstAiAudioMs`, `aiReplyP95Ms`; healthwatch `wa-ai-latency-high` (p95 first AI audio > 2500 ms over 10 calls / 30 min). Meta `connect` timeout → call `status: 'uncertain'`, **no redial**, reconcile on next `calls` webhook ya 2 min baad terminate.                                                                                                                                                                                                                          |
| D26 | Env naye (sab optional, defaults safe): `WA_TURN_URLS` (comma, optional), `WA_TURN_USERNAME`, `WA_TURN_CREDENTIAL` (secret), `WA_SCHEDULED_CALLS_ENABLED` (default `true`), `LOGIN_AS_FULL_ENABLED` (default `true`).                                                                                                                                                                                                                                                                                                                                                                                                                          |
| D27 | Commit tag `[SAC-Tn]`, branch `feature/sac-superadmin-wa-calling` dono repos.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

---

## 4. Rules of engagement

1. No questions — §3 follow; gap ho to safest consistent choice + report me likho.
2. Branch: backend `git switch -c feature/sac-superadmin-wa-calling` from `main` (`204231c`); frontend same naam from `feat/embedded-signup-solution-id` (`1737103`). Exists → switch + resume.
3. One commit per task per touched repo, Conventional Commit + `[SAC-Tn]`, hooks (lint-staged, commitlint) pass. Push / merge **nahi**.
4. Har query `accountId` scoped; superadmin `full` me bhi `accountId` session wala (owner ka) — kabhi body se nahi.
5. Har naya env → `config/env.ts` (+ production check) + `deploy/production/env.example` + `deploy/staging/env.example` + env inventory doc + README env table.
6. Har naya error code → `shared/errors/error-codes.ts` + `docs/conventions/error-codes.md` + frontend `services/api/errors.ts` labels.
7. Har naya audit action → `modules/audit/audit-actions.ts` **catalogue ke end me** + `docs/conventions/audit.md` + frontend `utils/audit-format.ts`.
8. Har naya WS event / webhook event / bell → `docs/conventions/websocket.md`, webhooks catalogue + samples (`tests/docs/public-spec-quality.test.ts` pass), `notification-types`.
9. Har task ke baad: changed files lint, typecheck, **sirf us task ke** tests. Long runs background me with real exit codes. Full suites sirf SAC-T13 me **ek-ek baar**.
10. Schema/contract change usi task me `gen:openapi` + `gen:postman` (backend) + `gen:api` (frontend).
11. Money sirf `core/billing/engine.ts` se. Fake providers se test; real Meta/Pinnacle/Razorpay call **nahi**. `.env` files kabhi read/print nahi.
12. Existing behaviour safe: reseller `act`, `view` mode, SIP outbound, Pinnacle messaging, Meta messaging — unke tests green rahen.
13. Code ko full test run ke dauraan edit mat karo.

## 5. Resume safety

`git branch --show-current` + `git log --oneline -25` dono repos; last `[SAC-Tn]` ke baad wale task se continue. Uncommitted changes preserve karo (stash/reset/checkout nahi).

---

## 6. Tasks

### SAC-T0 — Docs baseline (backend)

1. Branch banao (§4.2). `docs/plans/SUPERADMIN_AND_WA_CALLING_PLAN.md` + ye prompt commit karo.
2. Plan me "Decisions" table ke aage note: "Locked in SUPERADMIN_WA_CALLING_PROMPT.md §3".
   **Commit:** `docs(plans): add superadmin full access and WhatsApp calling plan [SAC-T0]`

### SAC-T1 — Login-as `full` mode: session, TTL, extend, step-up (backend)

1. `auth/login-as.ts`: `LoginAsMode = 'view' | 'act' | 'full'`; `full` + `kind !== 'superadmin'` → `ForbiddenError`; `LOGIN_AS_FULL_ENABLED=false` → `full` → 403 `AUTH_FORBIDDEN`. TTL: `full` → `IMPERSONATION_TTL_FULL = '4h'` (`auth.constants.ts`), baaki `'30m'`. File comment theek karo (30 min / 4 h).
2. Session claims: `imm: 'full'`; `imStart` (start time, extend limit ke liye). `auth-context` me `impersonationMode` type update; helper `shared/auth/impersonation.ts`: `impersonationOf(req) → { active, mode, impersonatorId, kind } `, `canActAsOwner(req)` (= !active || mode==='full' || mode==='act').
3. `POST /api/v1/auth/login-as/extend` (sirf `full`, current imp token): naya token +4 h, `now + 4h ≤ imStart + 12h` warna 409 `CONFLICT_INVALID_STATE` "Maximum 12 hours"; audit `auth.login_as_full_extended` dono accounts.
4. Step-up: `POST /api/v1/auth/login-as/step-up { password, code? }` — superadmin (impersonator) ka password argon2 verify + TOTP agar MFA on; success → Redis `stepup:<sessionId>` 5 min; 5 fails / 15 min → 429. Audit `auth.login_as_step_up` (+ failed). Middleware `requireStepUp()` (impersonation `full` me ho to Redis key check, warna pass) → 428 `STEP_UP_REQUIRED`.
5. `admin.routes.ts` impersonate schema: `mode: z.enum(['view','act','full']).default('view')`; superadmin ke liye MFA verified session zaruri (existing `MFA_ENFORCED_FOR_ADMINS` path reuse). Audit action `admin.account_impersonated` meta me `mode` (existing) — naya action `auth.login_as_full_started` add karo.
6. `/auth/me` body: `impersonation { mode, expiresAt, startedAt, maxUntil, ringMeToo }`.
7. Migration `0029-login-as-full` (no data change; audit catalogue/doc note only — agar zaroori na ho to migration skip karo aur report me likho; numbering phir bhi aage wale tasks me continuous rakhna).
8. Tests: `tests/security/login-as-matrix.test.ts` extend (full start by superadmin ✅, by reseller 403, flag off 403, TTL 4h, extend ok / >12h 409, nested 409), `tests/auth/step-up.test.ts` (password ok/wrong, TOTP, 5 fails 429, expiry 5 min).
   **Commit:** `feat(auth): superadmin full access login-as with extend and step-up [SAC-T1]`

### SAC-T2 — Full mode unblocks everything + attribution + ringing (backend)

1. `require-permission.ts`: `blockWhenImpersonating` → `full` allowed; `blockSensitiveWhenImpersonating` → `full` allowed, `view`/`act` unchanged. Danger routes (D2) par `requireStepUp()` add: `privacy.routes.ts` export/delete/cancel-delete, `team.routes.ts` ownership transfer, `auth.routes.ts` change-password / logout-all / sessions revoke, `mfa.routes.ts` reset/disable, `api-keys.routes.ts` create/rotate.
2. Top-up (D4): `topups.routes.ts` create/verify → `full` me 403 `WALLET_TOPUP_IMPERSONATION` (naya code). Fake-complete dev route unchanged.
3. Inline checks via helper: `dial-guard.ts:67` → sirf `mode==='view'` block (D8) — `assertDial` input `impersonating` ko `impersonationMode: 'view'|'act'|'full'|null` se replace; `calls.service.ts:627`; `inbox.routes.ts:252` → `full` me read mark (D7); `mfa.service.ts:31` superadmin own MFA unchanged; contact-exports / record-exports routes → `full` allowed; `contacts/bulk.service.ts` impersonatorId pass-through same.
4. Attribution (D5): models me additive fields (`call.model.ts actedBy`, `message.model.ts impersonatorId`, `campaign.model.ts` / `whatsapp-campaign.model.ts createdByImpersonator`); services jahan actor se write hota hai wahan set karo (inbox send, WA call start/answer, campaign create/start, template submit). Audit already `actor.impersonatorId` leta hai — check karo har naye path me pass ho.
5. Ringing (D6): `calls.service.ts targetsFor` + `routing.selectRingTargets` caller me eligible users se impersonation sessions hatao — presence/availability store me session ka `impersonatorId` record karo (`PATCH /users/me/call-availability` + WS presence); `ringMeToo` Redis flag (`ringme:<sessionId>`), route `PUT /auth/login-as/ring-me-too { on }` (sirf `full`). SIP inbound ring list (`modules/calls/inbound/*`) me same filter.
6. Audit catalogue end me: `auth.login_as_full_started`, `auth.login_as_full_extended`, `auth.login_as_step_up`, `auth.login_as_step_up_failed`.
7. Tests: naya `tests/security/full-access-matrix.test.ts` — app ke **har** `/api/v1` dashboard route (route list `phase16-routes` snapshot se) `full` session se call: kabhi `AUTH_IMPERSONATION_BLOCKED` nahi; D2 routes bina step-up 428, step-up ke baad pass; top-up 403; `view`/`act` purana matrix same. `tests/calls-wa/full-access-dial.test.ts` (full dial ok + `actedBy`, view dial 403). `tests/calls-wa/ring-impersonation.test.ts` (ring list excludes, ringMeToo includes). Snapshots update (weaken nahi).
   **Commit:** `feat(auth): let superadmin full access act as the owner everywhere [SAC-T2]`

### SAC-T3 — Full access UI (frontend)

1. `pages/admin/AdminAccountDetailPage.tsx`: "View" / "Act" ke saath **"Full access"** button (primary, laal outline) → confirm dialog: "Aap is account me owner ki tarah kaam karenge. Har action audit hoga. 4 ghante, extend kar sakte hain." → `adminApi.impersonate(id, 'full')`.
2. `features/auth/store.ts` / `session.ts`: `impersonation.mode`; hooks `useImpersonation()` + `useCanActAsOwner()` (`features/auth/hooks.ts`).
3. Har `impersonating`-based hide/disable (`grep -rln impersonat src | grep -v test`) ko review karo: owner-action wale → `useCanActAsOwner()`; top-up (Add money) → `full` me disabled + tooltip "Use Admin → Wallet → Adjust"; read-only banners → `view` only. Files incl.: `features/*/permissions.ts` (inbox, templates, campaigns, whatsapp, whatsapp-calling, whatsapp-campaigns, resellers), `settings/{ApiKeysTab,SecurityTab,DataRightsSection,CallsTab,InboxSettingsTab,NotificationsTab}.tsx`, `contacts/BulkActionsBar.tsx`, `contact-exports/useExportJob.ts`, `reports/RecordExportButton.tsx`, `integrations/*Tab.tsx`, `billing/BillingProfileForm.tsx`, `flows/builder/FlowBuilder.tsx`, `insights/*`, `agents/queries.ts`, `wallet/queries.ts`, `calls/queries.ts`, `inbox/chat/ConversationActions.tsx`, `layout/{Sidebar,Header}.tsx`.
4. `layout/Banners.tsx`: `full` banner (error color): "Superadmin full access · {account} · {hh:mm:ss} left · Extend · Ring me too ☐ · Exit"; 15 min pehle warning snackbar; expiry par auto-exit (existing stop flow).
5. Global **StepUpDialog** (`features/auth/StepUpDialog.tsx`): API client (`services/api/client.ts`) `STEP_UP_REQUIRED` par dialog → `POST /auth/login-as/step-up` → original request retry once; cancel → original error.
6. `utils/audit-format.ts`: naye actions + "Platform team (superadmin) ne kiya" label jab `impersonatorId`.
7. `npm run gen:api`.
8. Tests: `src/features/auth/full-access.test.tsx` (button → confirm → mode full; banner countdown/extend; ring toggle), `src/features/auth/step-up.test.tsx` (428 → dialog → retry), ek-do existing permission tests update (`full` me buttons dikhte, `view` me hidden).
   **Commit:** `feat(admin): superadmin full access with banner and step-up [SAC-T3]`

### SAC-T4 — Meta webhook auto verify + fix (backend)

1. `core/meta/types.ts` + `graph.client.ts` + `fake.client.ts`: `getSubscribedApps(token, wabaId) → { appId, name? }[]` (`GET /{waba}/subscribed_apps`), `getAppSubscriptions()` (existing — confirm shape: object + fields), `setAppSubscription({ object, callbackUrl, verifyToken, fields })` (`POST /{app_id}/subscriptions` with app access token). Pinnacle client: `PINNACLE_UNSUPPORTED` me add.
2. Fake: knobs — phone `00031` → `subscribed_apps` hamara app missing; `00032` → app subscription `calls` field missing (fix ke baad present); `00033` → fix fails.
3. Model `whatsapp-channel.model.ts`: `webhook { status: 'ok'|'failed'|'unknown', missingFields: string[], appSubscribed: boolean|null, checkedAt, fixedAt, error }` default `unknown`. Migration `0030-wa-webhook-status` (default set, index none).
4. `whatsapp.service.ts`: `verifyWebhook(channel)` (D10 a+b, returns steps), `fixWebhook(channel, actor)` (subscribeApp agar app missing; `setAppSubscription` agar fields missing; phir verify). Connect flow: `CONNECT_STEPS` me `subscribe` ke baad `verify_webhook` (meta-only; Pinnacle skip); fail → `webhook.status='failed'`, channel `action_needed` reason `webhook_missing` (connect complete, sends allowed) — status reason copy: "WhatsApp events (messages / calls) is app tak nahi aa rahe — Webhook check / Fix dabao".
5. `syncChannel` (daily health + Sync button): verify only; status `ok → failed` transition par bell `whatsapp.webhook_missing` + healthwatch rule `wa-webhook-missing` (`deploy/*/scripts/healthwatch.sh` + `GET /admin/system` card field).
6. Readiness (`whatsapp-calling/readiness.ts`): `calls` webhook check `channel.webhook` se padho (cache reuse), fix text me button ka naam.
7. Routes (`whatsapp.routes.ts`): `GET /whatsapp/channels/:id/webhook` (`whatsapp.read`), `POST /whatsapp/channels/:id/webhook/fix` (`whatsapp.manage`, `blockWhenImpersonating`, rate limit 6 / 10 min per channel); admin twin `POST /admin/whatsapp/channels/:id/webhook/fix` (`requirePlatformAdmin`). Audit `whatsapp.webhook_fixed` / `whatsapp.webhook_fix_failed`. OpenAPI + public spec quality (agar public scope me nahi to internal).
8. Tests: `tests/whatsapp/webhook-verify.test.ts` — connect with `00031` → auto subscribe fixed; `00032` → fields added; `00033` → `action_needed webhook_missing`, sends still work; fix route ok/fail/rate limit/other account 404/viewer 403; health transition bell once; Pinnacle channel → skip.
   **Commit:** `feat(whatsapp): verify and fix the Meta webhook on onboarding and on demand [SAC-T4]`

### SAC-T5 — Webhook status + Fix button (frontend)

1. Number card (`features/whatsapp/*` channel card + detail): chip "Webhook ✅ / ❌ / ?" + `checkedAt`; ❌ par missing fields list.
2. Button **"Webhook check / Fix"** → `POST …/webhook/fix` → drawer with steps (App subscribed · Fields: messages, calls, … · Result) ✅/❌ + error text; success snackbar.
3. Admin account page WhatsApp card (`features/admin/WhatsAppCard.tsx`) me same chip + admin fix button.
4. Calling readiness item `calls webhook` ka fix link isi button ko khole.
5. `gen:api`; test `src/features/whatsapp/webhook-fix.test.tsx` (chip states, fix success/fail, drawer steps).
   **Commit:** `feat(whatsapp): webhook status and fix button on numbers [SAC-T5]`

### SAC-T6 — Incoming calls: AI on/off switch, validation, fallback, account default (backend)

1. Account settings (`account.model.ts` / `account.schema.ts`): `settings.waIncoming { route, aiProgram, ringTimeoutSec }` default `{ route: 'team', aiProgram: null, ringTimeoutSec: WHATSAPP_CALL_LIMITS.uicRingTimeoutSec }`; migration `0032-wa-incoming-default` (set default). `PATCH /account` field + validation (same as D14 minus channel checks).
2. Naya WA channel (`connect` / `connectManaged` / switch) → `calling.inbound` = account default copy.
3. `PATCH /whatsapp/channels/:id/calling` validation (D14) — `settings.service.ts`: route `ai|ai_then_team|team_then_ai` → program required + `program.ts` active check; media env; calling enabled; wallet available ≥ `quote` of 1 min AI call. Errors path-wise (`inbound.aiProgram`, `calling.status`, `media`, `wallet`).
4. Fallback (D15) `calls.service.ts startInbound`: AI script start fail ya wallet hold fail ya capacity full → `ringTeam`; `ringTeam` targets empty → `rejectInbound` + missed (`ai_unavailable` / `no_agent`) + callback task (existing missed-call callback model reuse — WA missed calls agar alag model nahi hai to `calls.missed` fields reuse, SIP Phase 20 jaisa) + bell `call.wa_missed` + webhook `call.missed` (`channel: 'whatsapp'`).
5. "Stop live AI calls" admin action: `POST /whatsapp/channels/:id/calling/stop-ai-calls` (`whatsapp.manage`) → live AI calls terminate politely (closing line) via bus; audit.
6. Same switch mapping SIP numbers ke liye no backend change (routes same) — sirf doc.
7. Tests: `tests/calls-wa/incoming-switch.test.ts` — PATCH validation errors; route `ai` → AI answers (fake user); `ai_then_team` + wallet low → team ring; no agent → missed + bell + webhook; `team` → ring; new channel inherits account default; stop-ai-calls.
   **Commit:** `feat(whatsapp-calling): AI answers incoming calls switch with fallbacks [SAC-T6]`

### SAC-T7 — Incoming switch UI (frontend)

1. Component `features/whatsapp-calling/settings/IncomingAnswerCard.tsx`:
   - Switch **"AI se incoming calls uthao"** + helper "ON hone par chuna hua AI incoming WhatsApp calls uthayega. AI ki baat-cheet wallet se charge hogi."
   - ON: `ProgramPicker` (required), radio "AI pehle, phir team (AI na mile to)" / "Sirf AI".
   - OFF: "Team uthayegi" · ring list (Sab online team / Chune hue log multi-select) · ring time slider (`ringTimeoutSec`).
   - Advanced (collapse): "Team pehle, phir AI" (+ seconds), call hours link, after-hours behaviour (existing).
   - Status line: "Abhi: AI uthayega (Recovery Bot)" / "Abhi: team (3 online)".
   - Server field errors inline; readiness fail ho to switch disabled + reason.
2. Use: `CallingSection.tsx` (per number, "Account default use karo" checkbox) + `features/settings/CallsTab.tsx` (account default card).
3. Live: Calling section me "Stop live AI calls" (confirm).
4. `gen:api`; test `src/features/whatsapp-calling/incoming-switch.test.tsx` (mapping → PATCH body, program required error, default vs override, status line).
   **Commit:** `feat(whatsapp-calling): incoming AI switch in settings and number page [SAC-T7]`

### SAC-T8 — Scheduled AI calls: model, API, dispatch (backend)

1. Model `db/models/whatsapp-scheduled-call.model.ts` (tenant + base plugins): `accountId, channelId, contactId, conversationId|null, program {kind,id}, purpose (≤ 500), dueAt, timezone, status: 'scheduled'|'dispatching'|'calling'|'done'|'skipped'|'failed'|'cancelled', skipReason, origin: 'manual'|'ai_callback'|'api', attempt (0..), retry { max, gapMin, on[] }, attempts[] { at, callId|null, result, reason }, shiftedAt|null, createdBy, impersonatorId|null, cancelledBy|null, cancelledAt|null, claimedAt|null, idempotencyKey`. Indexes `{status:1,dueAt:1}`, `{accountId:1,contactId:1,status:1}`, unique `{accountId:1,idempotencyKey:1}` sparse. Migration `0031-wa-scheduled-calls` (collection + indexes). Erase map (`privacy/erase-map.ts`) + retention + account export me add.
2. Service `modules/whatsapp-calling/scheduled.service.ts`: `create` (D17 limits, permission status warning flags `{ permissionExpiresBeforeDue, outsideWindow, outsideCallHours, lowWallet }` response me), `list` (filters status/contact/channel/program/date, cursor), `update` (sirf `scheduled`: dueAt/program/purpose/retry), `cancel`.
3. Routes (`calling.routes.ts` ya naya `scheduled.routes.ts`): `POST /whatsapp/scheduled-calls` (Idempotency-Key, `calls.trigger`), `GET /whatsapp/scheduled-calls`, `GET /:id`, `PATCH /:id`, `POST /:id/cancel`. `WA_SCHEDULED_CALLS_ENABLED=false` → 503 `FEATURE_DISABLED`. API key scopes (D23). Rate limit 30 / min / user.
4. Jobs (`whatsapp-calling/jobs.ts`): `enqueueScheduled(id, attempt, delayMs)` (jobId D19), repeatable `wa-scheduled-call-sweep` every 60 s (due rows `dueAt ≤ now` + stale claims). Worker handler `dispatchScheduled(id, attempt)`:
   - Claim (D19) → preflight (D20) via `assertDial` + program + wallet (hold through `startOutbound` existing path) → `startOutbound({ mode: 'ai', program, origin: 'scheduled', scheduledCallId, idempotencyKey })` → status `calling`.
   - Call end hook (`onEnded`): `scheduledCallId` ho to result map (`answered → done`, `no_answer/busy/failed → retry ya failed`); retry → `attempt+1`, `dueAt = now + gapMin`, enqueue.
   - Skip reasons: `no_permission`, `dnd`, `opted_out`, `outside_window`, `channel_down`, `calling_disabled`, `program_inactive`, `wallet`, `capacity` (capacity → 5 min baad requeue, max 3 baar, phir `failed`), `contact_deleted`.
5. Events (D24): WS on every status change, webhooks, bell on `failed`/`skipped` to creator.
6. Inbox bubble: conversation me system bubble types `call_scheduled`, `call_schedule_skipped`, `call_schedule_cancelled` (existing call bubble pattern `calls.service.ts bubble`).
7. Tests: `tests/calls-wa/scheduled-calls.test.ts` — create limits/validation/idempotency; due → dispatch exactly once with 2 workers + sweep racing; preflight skip reasons; outside window → shift once; retry on no_answer then done; cancel before due (job ignored); stale claim recovery; other account 404; viewer 403; feature flag 503; API key scope.
   **Commit:** `feat(whatsapp-calling): schedule AI calls with preflight, retries and exact-once dispatch [SAC-T8]`

### SAC-T9 — AI callback → scheduled call (backend)

1. WA call (ai mode) `onEnded`: program agent ho (ya flow ka AI node) aur `outcome.callback` + agent `scheduleCallback.enabled` → `scheduled.service.create({ origin: 'ai_callback', dueAt: date+time (null → 11:00) in account tz, program: same, purpose: "Customer ne callback maanga" })`; limits/preflight wahi; create fail → call event note + bell, crash nahi.
2. Agent prompt (`core/ai/tools.ts` description) me line: "Time aur din customer se confirm karke hi tool call karo; tool success ke baad hi bolo ki call schedule ho gayi."
3. SIP / web calls ke liye kuch nahi (scope bahar) — report me likho.
4. Tests: `tests/calls-wa/ai-callback.test.ts` (fake AI rule callback → scheduled row; disabled → none; out of range → none).
   **Commit:** `feat(whatsapp-calling): turn AI callback requests into scheduled calls [SAC-T9]`

### SAC-T10 — Schedule AI call UI (frontend)

1. `features/whatsapp-calling/live/CallButton.tsx` menu teen items: **Call myself** ("Is browser se baat karo"), **Call with AI** ("Flow ya AI agent baat karega"), **Schedule AI call** ("Baad me AI call karega"). Labels me "Call yourself" → "Call myself" (tests update). Permission nahi → Schedule disabled + reason.
2. `ScheduleAiCallDialog.tsx` (react-hook-form + zod): date+time (account tz, default +1 h, quick picks: 30 min, 2 ghante, Kal 11:00), `ProgramPicker`, purpose, retry (Off / 1 / 2 + gap), warnings from create response (permission expire, window, call hours, wallet) — warning ke saath "Phir bhi schedule karo" confirm; estimate (quote API).
3. Contact panel (`features/inbox/panel/ContactPanel.tsx` + `whatsapp-calling/panel/ContactCallingCard.tsx`): "Scheduled calls" list (upcoming top), row: time, program, status chip, Reschedule / Cancel / Open call.
4. Calls page (`pages/calls/CallsPage.tsx`): naya tab **Scheduled** (filters status/program/date/created by, URL params), table + actions.
5. Inbox chat bubbles (`features/inbox/chat/MessageCards.tsx` / `whatsapp-calling/bubbles.tsx`): scheduled / skipped (reason label) / cancelled / AI callback.
6. WS `whatsapp_call.scheduled_updated` → query invalidate. `labels.ts` me skip reasons Hinglish.
7. `gen:api`; tests `src/features/whatsapp-calling/schedule-call.test.tsx` (menu 3 items, dialog validation, warnings confirm, POST body, list cancel/reschedule, bubble render), `entry-points.test.tsx` update.
   **Commit:** `feat(whatsapp-calling): schedule AI calls from inbox and contacts [SAC-T10]`

### SAC-T11 — Switch Pinnacle number to Meta direct (backend + frontend)

1. Backend `whatsapp.service.ts switchToMeta(channelId, { code, wabaId, phoneNumberId }, actor)` (D12): exchange code (existing ES path), check same WABA + phone, transaction-safe update same `_id`, run `subscribe` + `verify_webhook`, credit line `attached`, Pinnacle webhook clear best-effort (fail → warning, not error), archive `pinnacle.*`, calling settings sync job, `resetManagedNumbersCache()`, audit, bell owner. Route `POST /whatsapp/channels/:id/switch-to-meta` (`whatsapp.manage`; superadmin full allowed). Errors: `WHATSAPP_SWITCH_MISMATCH`, `WHATSAPP_SWITCH_NOT_MANAGED`. Fake ES codes `fake.` support.
2. Inbox / campaigns / scheduled calls / templates same channel id par chalte rahen — test se prove.
3. Frontend: managed number card par **"Switch to Meta direct"** (explain dialog: "Calls aur messages seedhe Meta se; billing Pinnacle credit line se hi") → existing Embedded Signup launcher (Partner Solution ID) → POST → success: provider badge "Meta direct". Pinnacle number par calling section me badge "Calls via partner".
4. Tests: backend `tests/whatsapp/switch-to-meta.test.ts` (ok, mismatch 422, already meta 409, Pinnacle clear fail = warning, inbox send after switch goes Graph, calls `clientFor` meta); frontend `src/features/whatsapp/switch-to-meta.test.tsx`.
   **Commit (dono repos):** `feat(whatsapp): switch a managed number to Meta direct [SAC-T11]`

### SAC-T12 — Calling hardening (backend + small frontend)

1. Timeline + metrics (D25): `call.model.ts` `timeline[]` (cap 200 rows) + `metrics.firstAiAudioMs`, `metrics.aiReplyP95Ms`; record points in `core/telephony/whatsapp/leg.ts`, `peer.ts`, `core/voice/ai-session.ts`, `calls.service.ts`. Call detail page (`features/calls/detail`) me "Timeline" collapsible.
2. Uncertain state (D25): `startOutbound` Meta `connect` timeout/5xx → `uncertain`, no retry; reconcile on webhook ya 2 min sweep → terminate + release hold.
3. TURN (D26): env parse; `peer.ts` ICE servers me STUN + TURN (credential masked in logs); readiness item "TURN configured" (info, non-blocking).
4. Low wallet mid-call: existing extend fail → closing line ("Aapka balance khatam ho raha hai, hum baad me call karenge") phir end — verify + test agar missing.
5. Healthwatch: `wa-ai-latency-high`, `wa-webhook-missing` (T4) — `deploy/production/scripts/healthwatch.sh` + `deploy/staging/...` + `GET /admin/system` fields.
6. Owner crash: `owner-sweep.ts` behaviour test (owner gone → terminate + settle once).
7. Tests: `tests/calls-wa/hardening.test.ts` (timeline order, uncertain no redial + reconcile, low wallet ending, owner crash single settle), `src/core/telephony/whatsapp/peer.test.ts` ICE servers.
   **Commit:** `feat(whatsapp-calling): call timeline, latency metrics and uncertain-state handling [SAC-T12]`

### SAC-T13 — Docs, contract, final checks, sign-off

1. Docs: ADR `docs/adr/0052-superadmin-full-access-and-wa-calling.md`; README sections (Superadmin full access, WhatsApp calling: schedule, incoming switch, webhook fix, switch to Meta); `docs/setup/meta-whatsapp.md` (§5 auto subscribe, Fix button, TURN); `docs/integrations/pinnacle.md` (switch to Meta); `docs/conventions/{error-codes,audit,websocket}.md`; env inventory; CHANGELOG `[Unreleased]` entries (date 2026-11-xx); public API guide for scheduled calls (`docs/api/`), `npm run gen:guides`.
2. Backend: `lint`, `typecheck`, `build`, `build:ops`, `openapi:check`, `docs:audit`, `docs:smoke`, full `test` **once** (Mongo crash → rerun sirf failed files). Frontend: `lint`, `typecheck`, `build`, `test` **once**, Playwright sirf naye specs (§7).
   Pre-existing known failures (main par bhi): backend `tests/whatsapp-campaigns/campaigns.test.ts` recurrence (clock), frontend `inbox-page.test.tsx` "Retry a failed send" — note karo, chhupao mat.
3. Real failures fix → affected files rerun.
4. `docs/phases/SAC_SIGNOFF.md`: tasks ✅/⚠️, test numbers + log paths, migrations 0029–0032, env, deviations, live checklist (§8).
   **Commit:** `docs(sac): record superadmin full access and WhatsApp calling sign-off [SAC-DONE]`

---

## 7. Tests (sirf yeh — kam aur relevant)

| File                                                                                                              | Covers                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| backend `tests/security/login-as-matrix.test.ts` (extend)                                                         | full start/reseller 403/flag off/TTL/extend/12 h/nested                                                                                  |
| backend `tests/auth/step-up.test.ts`                                                                              | password, TOTP, lockout, 5 min expiry                                                                                                    |
| backend `tests/security/full-access-matrix.test.ts`                                                               | har dashboard route full se: never IMPERSONATION_BLOCKED; D2 → 428 then ok; top-up 403; view/act unchanged                               |
| backend `tests/calls-wa/full-access-dial.test.ts`, `ring-impersonation.test.ts`                                   | dial full ok + actedBy, view 403; ring exclusion + ringMeToo                                                                             |
| backend `tests/whatsapp/webhook-verify.test.ts`                                                                   | auto subscribe / fields fix / failed → action_needed / fix route / health bell / Pinnacle skip                                           |
| backend `tests/calls-wa/incoming-switch.test.ts`                                                                  | validation, AI answers, fallbacks, missed + bell + webhook, default inherit, stop AI calls                                               |
| backend `tests/calls-wa/scheduled-calls.test.ts`                                                                  | limits, idempotency, exact-once (2 workers + sweep), skip reasons, shift, retry, cancel, stale claim, scopes                             |
| backend `tests/calls-wa/ai-callback.test.ts`                                                                      | outcome.callback → row; disabled/out of range → none                                                                                     |
| backend `tests/whatsapp/switch-to-meta.test.ts`                                                                   | switch ok/mismatch/already meta/Pinnacle clear warning/after-switch Graph                                                                |
| backend `tests/calls-wa/hardening.test.ts`, `src/core/telephony/whatsapp/peer.test.ts`                            | timeline, uncertain, low wallet, owner crash, ICE/TURN                                                                                   |
| frontend `src/features/auth/full-access.test.tsx`, `step-up.test.tsx`                                             | button/banner/extend/ring toggle; 428 dialog retry                                                                                       |
| frontend `src/features/whatsapp/webhook-fix.test.tsx`, `switch-to-meta.test.tsx`                                  | chip, fix drawer, switch flow                                                                                                            |
| frontend `src/features/whatsapp-calling/incoming-switch.test.tsx`, `schedule-call.test.tsx`                       | switch mapping/errors; menu 3 items, dialog, list, bubbles                                                                               |
| frontend Playwright `e2e/sac-full-access.spec.ts`, `e2e/sac-schedule-call.spec.ts`, `e2e/sac-incoming-ai.spec.ts` | superadmin full → inbox send + WA call; schedule (fake clock) → bubble; switch ON → fake incoming → AI, OFF → team popup                 |
| existing                                                                                                          | `phase15/16-routes` snapshots, rbac snapshot, `public-spec-quality`, events-wiring, audit catalogue position tests — update, weaken nahi |

## 8. Live checklist (NOT run without owner — sign-off me list karo)

1. Real Meta number onboard (ES + Partner Solution) → card "Webhook ✅ (messages, calls)".
2. App Dashboard se `calls` field hatao → Fix button → ✅ wapas.
3. Customer phone se WhatsApp call: switch ON → AI Hinglish me bole; OFF → team browser ring + dono taraf awaaz; koi online nahi → missed + bell.
4. Inbox: Call myself, Call with AI, Schedule AI call (5 min) — teeno connect; recording, transcript, charge.
5. Superadmin Full access: dusre account me same 4 steps; Audit log me "Platform team"; step-up on account export.
6. Pinnacle number → Switch to Meta direct → message + call Graph se; Pinnacle webhook khaali.
7. Wallet charge = Meta Insights call duration (± 1 pulse); `WA_MEDIA_PUBLIC_IP` + UDP 40000–40999 server par (client team).

## 9. Final report (short Hinglish)

1. Har task ✅ / ⚠️ / ❌ + 1 line. 2. Commits (`git log --oneline` dono repos). 3. Test/build actual numbers + pre-existing failures. 4. Deviations from D1–D27. 5. Live-blocked items (§8). 6. Push / deploy / client sync: "nahi kiya".
