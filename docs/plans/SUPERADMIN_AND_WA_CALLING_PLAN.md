# Superadmin full access + WhatsApp calling (Meta direct) — detailed plan

**Date:** 20 Nov 2026 · **Status:** plan only (koi code change nahi hua) · **Repos:** backend + frontend
**Reference:** AutoChatix audit `~/Documents/Autochatix/whatsapp-ai-calling-audit-2026-11-11/execution-plan.md` (target UX: "Call myself / Call with AI / Schedule", AI auto-answer switch)

---

## 0. Ek nazar mein — kya chahiye, kya pehle se hai, kya banana hai

| #   | Requirement                                                                                      | Abhi code mein                                                                                                                                                                                                          | Kya banana hai                                                                                            |
| --- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| R1  | Superadmin kisi bhi account mein jaakar **wo sab kar sake jo account owner/admin kar sakta hai** | Login-as `view` / `act` hai. `act` mein bhi 18 "sensitive" routes block (`blockSensitiveWhenImpersonating`), WhatsApp call dial-guard impersonation par mana karta hai (`dial-guard.ts:67`), token 30 min, refresh nahi | Naya mode **`full`** (sirf superadmin), sab unblock, har action audit mein superadmin ke naam se          |
| R2  | Inbox mein call option: **Call myself, AI call, AI schedule call**                               | `CallButton.tsx`: "Call yourself" + "Call with AI" + "Request permission" hai                                                                                                                                           | **"Schedule AI call"** (naya model + job + UI), scheduled list, cancel/reschedule                         |
| R3  | Incoming call setting: **AI ON → AI uthaye, OFF → team member uthaye**                           | `calling.inbound.route` = `team / ai / ai_then_team / team_then_ai` + `aiProgram` + ring timeout — number ke Calling section mein                                                                                       | Simple **"AI se incoming calls uthao" switch** (Settings + number page), fallback rules, validation       |
| R4  | Calls **Meta Graph direct API** se, AI ke saath                                                  | `provider: 'meta'` numbers already Graph direct (`/{phone_id}/calls`). `provider: 'pinnacle'` numbers Pinnacle voice wrapper se                                                                                         | Calls hamesha Graph direct; Pinnacle numbers ke liye "Meta direct" path (D2 decision)                     |
| R5  | Meta **direct webhook onboarding par automatic** set ho + **ek button**                          | Onboarding mein `subscribe` step (`POST /{waba}/subscribed_apps`) hai; `calls` field app dashboard mein manually; koi "fix webhook" button nahi                                                                         | Auto subscribe + verify (fields incl. `calls`), number card par **"Webhook check / Fix"** button + status |
| R6  | Calling **perfect** chale                                                                        | Phase 12 / 18B foundation + readiness checklist (10 checks)                                                                                                                                                             | Hardening list (§6), test matrix (§7), live checklist (§8)                                                |

---

## 1. Decisions — implementation se pehle aapka jawab chahiye

| ID     | Sawal                                                                                                                                                                                | Meri recommendation                                                                                                                                                                                                                                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1** | `full` mode mein kya **bilkul** sab allowed ho (account delete, owner ka password / MFA, ownership transfer, API keys, real payment top-up)?                                         | Sab allowed, lekin 5 "danger" actions (account delete, ownership transfer, owner password/MFA reset, account export, API key create) par **superadmin ka apna password + MFA dobara** maanga jaaye. Owner ke saved card se real payment nahi (Razorpay checkout owner ka hota hai) — superadmin ke liye "Admin adjustment" already hai |
| **D2** | Pinnacle (API-key) wale numbers par Meta direct calls kaise? Hamare app ke paas un WABA ka Meta token **nahi** hai — direct Graph tabhi chalega jab WABA hamare Meta app se bhi jude | **Multi-partner Embedded Signup** (hamara ES + Pinnacle Solution ID, commit `fb130b1` se ready): customer hamara ES karta hai → token hamare paas, credit line Pinnacle ki. Existing Pinnacle numbers par **"Switch to Meta direct"** button jo ES chalaye. Tab tak purane Pinnacle numbers Pinnacle path par chalte rahen             |
| **D3** | Superadmin `full` mode mein ho to incoming calls uske browser par bhi ring hon?                                                                                                      | **Nahi** (default). Superadmin sirf khud call kar sake / answer kar sake agar "Ring me too" toggle on kare                                                                                                                                                                                                                             |
| **D4** | Schedule AI call mein no-answer par retry?                                                                                                                                           | Haan, opt-in: max 2 retry, gap 15–120 min, sirf `no_answer / busy / failed` par                                                                                                                                                                                                                                                        |
| **D5** | AI switch ON ho aur AI available na ho (wallet kam, capacity full, program off) to?                                                                                                  | **Team ko ring karo**; koi online nahi → missed call + callback task + bell                                                                                                                                                                                                                                                            |
| **D6** | `full` session kitni der?                                                                                                                                                            | 4 ghante, "Extend" button (har extend audit), 15 min idle warning                                                                                                                                                                                                                                                                      |

> **Locked in [SUPERADMIN_WA_CALLING_PROMPT.md](../prompts/SUPERADMIN_WA_CALLING_PROMPT.md) §3** (D1–D27; recommendations above taken as decisions).

---

## 2. Part A — Superadmin full access (R1)

### 2.1 Abhi kaise chalta hai (code)

- `modules/auth/login-as.ts` → `startLoginAs(req, account, { mode: 'view' | 'act', kind: 'superadmin' | 'reseller' })`: owner ka token, `imp_…` session, `IMPERSONATION_TTL = '30m'` (comment 1 h kehta hai — mismatch), refresh nahi, nested refused, dono accounts mein audit.
- `shared/middlewares/require-permission.ts`:
  - `blockWhenImpersonating()` — `view` mein block, `act` allowed (51 routes).
  - `blockSensitiveWhenImpersonating()` — **har** login-as mein block (18 routes): auth password/sessions/logout-all, MFA, API keys, team ownership, privacy export/delete/erase, wallet settings + top-ups, billing profile, webhook endpoints, resellers.
  - `requirePlatformAdmin()` — impersonating ho to forbidden (sahi hai, admin panel alag).
- Inline checks: `whatsapp-calling/dial-guard.ts:67` ("Impersonators may look, never call"), `calls.service.ts:627`, `inbox.routes.ts:252` (read receipt skip), contact export / record export hide, `mfa.service.ts`.
- Frontend: `AdminAccountDetailPage.tsx` mein "View" / "Act" buttons; ~40 files mein `impersonating` se buttons hide/disable (`features/*/permissions.ts`, `Banners.tsx`, `CallsTab`, `ApiKeysTab`, `SecurityTab`, `DataRightsSection`, `RecordExportButton`, `useExportJob`, `BillingProfileForm`, `WebhooksTab`…).

### 2.2 Target behaviour

- Admin → Accounts → account → **"Enter account (full access)"** button (sirf `platformRole: superadmin`, MFA verified).
- Session `mode: 'full'`: owner ki sari permissions + sensitive routes bhi. Banner (laal): "Superadmin full access · <account> · 3:42:10 left · Extend · Exit".
- Har write: audit mein `actor.impersonatorId = superadmin`, `meta.mode = 'full'`; account owner ko Audit log mein "Platform team ne kiya" dikhe.
- Danger list (D1) → "Confirm with your password" dialog (superadmin ka password + TOTP) → 5 min ka `stepUpUntil` claim.
- Reseller `act` waisa hi rahe (koi change nahi).

### 2.3 Backend tasks

1. **Session claim:** `LoginAsMode = 'view' | 'act' | 'full'`; `full` sirf `kind: 'superadmin'` ke liye allowed (reseller ko 403). `accessTokenFor` mein `imm: 'full'`. `IMPERSONATION_TTL_FULL = 4h`; `POST /auth/login-as/extend` (max 12 h total, audited).
2. **Middlewares:**
   - `blockWhenImpersonating` → `full` ko allow (abhi `act` jaisa).
   - `blockSensitiveWhenImpersonating` → `full` ko allow; danger routes par naya `requireStepUp()` (superadmin password/MFA, `POST /auth/login-as/step-up`).
   - Naya helper `impersonationMode(req)` taaki inline checks ek jagah se padhein.
3. **Inline checks hatao/badlo:**
   - `dial-guard.ts` → `impersonating` sirf `view` par block; `full` / `act` call kar sake (`act` ke liye D1 mein confirm).
   - `calls.service.ts`, inbox read receipts (`full` mein read mark ho — superadmin customer ki taraf se kaam kar raha hai), contact/record exports, `mfa.service.ts`.
4. **Attribution:** `call.model` mein `actedBy: { userId, impersonatorId }`; inbox message `sentBy` ke saath `impersonatorId`; campaign `createdBy` + `createdByImpersonator`; WA call media ticket impersonator ke naam (owner ke browser par nahi ring).
5. **Ring list (D3):** WA incoming + SIP inbound `selectRingTargets` mein impersonation sessions exclude, unless "Ring me too".
6. **Audit:** naye actions `auth.login_as_full_started / extended / step_up`; catalogue end mein add (position tests safe).
7. **Route-matrix test:** har dashboard route `full` session se → `AUTH_IMPERSONATION_BLOCKED` kabhi nahi (sirf step-up wale 428/403 `STEP_UP_REQUIRED`). Existing `view` / `act` tests same rahen.

### 2.4 Frontend tasks

1. Account detail page: teesra button "Full access" (confirm dialog: "Aap is account mein owner ki tarah kaam karenge; sab audit hoga").
2. `features/auth/store.ts` + `session.ts`: `impersonation.mode`; helper `useCanActAsOwner()` = not impersonating **ya** mode `full`.
3. ~40 files mein `impersonating` checks ko helper par switch (list §2.1). Har feature ka `permissions.ts` update.
4. Banner: countdown, Extend, Exit; idle warning.
5. Step-up dialog (global, error code `STEP_UP_REQUIRED` par khulta hai, retry original request).
6. Tests: har chhupa button `full` mein dikhe, `view` mein chhupa rahe.

---

## 3. Part B — Calls Meta Graph direct + auto webhook (R4, R5)

### 3.1 Abhi kaise chalta hai

- `clientFor(ctx, channel)` (`modules/whatsapp/context.ts`): `provider: 'meta'` → `graph.client.ts` (Bearer token), `'pinnacle'` → `pinnacle.client.ts` (calls `PINNACLE_VOICE_BASE_URL` par).
- Meta numbers ke events app-level webhook `POST /api/v1/webhooks/meta` par (App Dashboard mein callback + fields manually set). Onboarding ka `subscribe` step `POST /{waba}/subscribed_apps` karta hai (`whatsapp.service.ts:433`).
- Readiness (`/calling/readiness`) app ke `calls` field ko app token se padhta hai (1 h cache).

### 3.2 Target

- **Har call (incoming/outgoing, team/AI/scheduled) Graph direct:** `POST /{phone_number_id}/calls` (connect / pre_accept / accept / reject / terminate), events `calls` webhook se seedhe `/api/v1/webhooks/meta`.
- **Onboarding par automatic:**
  1. `POST /{waba}/subscribed_apps` (already).
  2. **Verify:** `GET /{waba}/subscribed_apps` mein hamara app hai; `GET /{app_id}/subscriptions` (app token) mein `whatsapp_business_account` object par `messages` **aur** `calls` (+ `WEBHOOK_FIELDS` ki list) — missing ho to `POST /{app_id}/subscriptions` se fields add (app-level, ek baar; idempotent).
  3. Calling settings: `POST /{phone_number_id}/settings` `calling.status=ENABLED` (sirf jab account ne calling chahi + readiness pass), phir read-back.
  4. Result channel par: `webhook: { status: ok|failed, fields: [...], checkedAt, error }`.
- **Button:** number card par **"Webhook check / Fix"** (aur superadmin account page par bhi): steps 1–3 dobara, har step ka result (✅/❌ + fix text). Daily health job bhi yahi check kare; fail par bell + healthwatch rule `wa-webhook-missing`.
- **Optional (agar ek WABA ko alag URL chahiye):** `subscribed_apps` ke saath `override_callback_uri` + `verify_token` — sirf tab jab platform app ka default URL nahi chahiye. Default: override **nahi** (ek hi `/webhooks/meta`).

### 3.3 Pinnacle numbers (D2)

1. Naya flow **"Switch to Meta direct"** (managed number card par): owner ya superadmin hamara Embedded Signup chalata hai, Pinnacle Solution ID ke saath (platform payer) → same WABA / phone par token hamare paas aata hai.
2. Backend: existing channel ko `provider: 'meta'` mein convert (naya channel nahi — history, inbox, campaigns same `_id` par): token seal, `subscribe` + verify, credit line `attached` (Pinnacle ki), `pinnacle.*` fields archive, Pinnacle `setwebhook` khaali (double events band).
3. Jab tak switch nahi hota: Pinnacle number par calls Pinnacle path par (abhi jaisa) aur UI mein "Calls via partner" badge.
4. **Risk:** agar WABA dono apps (Pinnacle + hamara) par subscribed ho to dono ko `calls` events jaayenge — Pinnacle ko is number par calls auto-handle **nahi** karni chahiye. Pinnacle se confirm karna hai (open question Q1).

### 3.4 Tasks

- `graph.client.ts`: `getSubscribedApps(token, wabaId)`, `getAppSubscriptions(appToken)` (hai — reuse), `setAppSubscriptionFields(appToken, fields)`.
- `whatsapp.service.ts`: `verifyWebhook(channel)` + `fixWebhook(channel)`; connect flow ke `subscribe` step ke baad verify; `syncChannel` mein shamil.
- Routes: `GET /whatsapp/channels/:id/webhook`, `POST /whatsapp/channels/:id/webhook/fix` (`whatsapp.manage`), admin twin route.
- Model: `whatsappChannel.webhook` (migration additive).
- Switch flow: `POST /whatsapp/channels/:id/switch-to-meta` (ES code + Pinnacle channel id), fake Meta knobs, tests.
- Frontend: number card status chip + button + steps drawer; switch wizard.

---

## 4. Part C — Inbox call options (R2)

### 4.1 UI (AutoChatix wording)

Conversation header + contact panel ka **Call ▾** menu:

1. **Call myself** — browser mic (abhi "Call yourself").
2. **Call with AI** — flow ya AI agent chuno (abhi hai).
3. **Schedule AI call** — naya:
   - Date + time (account timezone, default "+1 hour"), quick picks (30 min, 2 h, kal 11:00).
   - Program (flow / agent) picker, purpose note (AI ke context mein jaata hai: `{{call.purpose}}`).
   - Retry (D4): off / 1 / 2, gap.
   - Warnings: permission expire ho rahi hai due time se pehle, TRAI window (09:00–21:00) ke bahar, call hours ke bahar, wallet kam.

- Permission nahi hai → menu mein "Request permission" (abhi jaisa) aur Schedule bhi disabled with reason.
- Contact panel mein **"Scheduled calls"** list (upcoming / done), har row par Cancel / Reschedule / Open call.
- Calls page par naya tab **Scheduled** (filters: status, program, date, created by).
- Inbox chat mein timeline bubble: "AI call scheduled for 21 Nov 11:00 by Rahul" → "AI call done · 2:14 · Promise to pay".

### 4.2 Backend — scheduled AI calls

1. **Model `whatsappScheduledCall`** (migration additive): `accountId, channelId, contactId, conversationId, program {kind,id}, purpose, dueAt (UTC), timezone, status: scheduled|dispatching|calling|done|skipped|failed|cancelled, skipReason, attempts, retry {max, gapMin, on[]}, callIds[], createdBy, impersonatorId, cancelledBy, idempotencyKey`. Indexes: `{status, dueAt}`, `{accountId, contactId, dueAt}`.
2. **API:** `POST /whatsapp/scheduled-calls` (`calls.trigger`, Idempotency-Key), `GET` (list, filters), `PATCH /:id` (reschedule/program/purpose — sirf `scheduled`), `POST /:id/cancel`. Public API scope `calls:write` bhi (optional).
3. **Dispatch:** BullMQ delayed job (`whatsapp` queue, `jobId = scheduled:<id>:<attempt>`) **+** har minute sweep (Redis down / restart safety). Claim atomic `scheduled → dispatching` (`findOneAndUpdate`), stale claim 10 min → wapas.
4. **Preflight at due time** (wahi `assertDial`): account active, channel connected + calling enabled, contact present, DND / opt-out, **permission valid abhi**, TRAI window + call hours, wallet hold, capacity / live call limits, program active. Fail → `skipped` + reason (window ke bahar ho to next window start par auto-shift, ek baar).
5. **Call:** `calls.service.startOutbound({ mode: 'ai', program, origin: 'scheduled', scheduledCallId })` → result par `done` ya retry schedule.
6. **AI agent tool "callback":** agent ka built-in callback tool (playground mein abhi simulated) → customer ka bataya time confirm karke `whatsappScheduledCall` banaye (AutoChatix Phase 9 rule: time + timezone confirm, permission check, phir hi AI bole "schedule ho gaya").
7. **Notifications / webhooks:** bell `call.scheduled_failed`, webhook events `whatsapp_call.scheduled`, `.skipped`; reports mein `origin: scheduled`.
8. **Billing:** normal WA call hold/settle (`holdForWhatsAppCall`), schedule banate waqt sirf estimate dikhana.

### 4.3 Frontend tasks

- `CallButton.tsx` menu mein teesra item; `ScheduleAiCallDialog.tsx` (react-hook-form + zod, `ProgramPicker` reuse).
- `features/whatsapp-calling/queries.ts`: scheduled calls queries + WS event `whatsapp_call.scheduled_updated`.
- Contact panel card, Calls → Scheduled tab, inbox bubble type.

---

## 5. Part D — Incoming call setting: AI ON/OFF (R3)

### 5.1 UI

**Settings → Calls → WhatsApp incoming calls** (aur har number ke Calling section mein same card):

- Switch: **"AI se incoming calls uthao"**
  - ON → "Kaun sa AI?" (flow / agent picker, required) · "AI pehle, phir team" ya "Sirf AI" · AI language/voice program se.
  - OFF → "Team uthayegi" · ring list (sab online team / chune hue log) · ring time.
- **Advanced** (collapse): `team_then_ai` (team pehle, X sec baad AI), call hours, after-hours: AI ya message, nobody-online fallback (D5).
- Status line: "Abhi: AI uthayega (Recovery Bot)" / "Abhi: team (3 online)".
- Help text: "AI ki baat-cheet wallet se charge hogi."

### 5.2 Backend

1. Mapping (koi naya route type nahi): switch ON + "AI pehle, phir team" → `ai_then_team`; "Sirf AI" → `ai`; OFF → `team`; advanced → `team_then_ai`.
2. Validation on save: program active + published, wallet available > 1 call ka hold, `WA_MEDIA_ENABLED` + public IP, calling status enabled. Fail → field-wise error.
3. **Runtime fallback (D5)** `whatsapp-calling/webhooks.ts` incoming path: AI unavailable (wallet, capacity, program) → team ring; koi online nahi → reject with reason + missed call + callback task + bell + webhook `call.missed`.
4. Switch OFF sirf **nayi** calls par; live AI calls chalti rahen (alag "Stop live AI calls" admin action).
5. Account-level default + number-level override: `account.settings.waIncomingDefault`; naya number isi se shuru.
6. SIP inbound (Phase 20) ke liye same switch reuse (phone-numbers inbound route same 4 values).

---

## 6. Part E — "Perfect" calling: hardening checklist

| Area             | Kaam                                                                                                                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Media            | `WA_MEDIA_PUBLIC_IP`, UDP 40000–40999 open, STUN reachable; **TURN fallback** (customer NAT strict ho to) evaluate; `werift` ICE timeout + retry; Opus 48k ↔ PCM 24k resample latency measure |
| Latency          | Targets: incoming ring → AI pehla shabd ≤ 1.5 s; customer chup → AI jawab ≤ 1.2 s (p95); barge-in ≤ 300 ms                                                                                    |
| Ownership        | Call ka media sirf ek process own kare (`CallControlBus`), owner crash → call clean terminate + settle; double accept race test                                                               |
| Webhook speed    | `calls` events fast-path (`callsFastPath`) — queue ke peeche nahi; p95 < 200 ms receive → handle                                                                                              |
| Uncertain states | Meta `connect` timeout → "uncertain", dobara dial nahi; reconcile by `terminate` webhook                                                                                                      |
| Billing          | Pulse/minute Meta insights se match (± 1 pulse); low wallet mid-call → warning tone + polite end; AI + Meta charge alag ledger rows                                                           |
| Permissions      | Permission expiry / revoke webhook turant; bulk ask limit (Meta 1/24h, 2/7d)                                                                                                                  |
| Observability    | Har call ka timeline (webhook in, SDP, ICE connected, first audio, AI turns, end cause); healthwatch `wa-call-setup-failing`, naya `wa-ai-latency-high`                                       |
| Superadmin       | `full` mode mein call attribution sahi, ringing D3                                                                                                                                            |

---

## 7. Test plan (har phase ek baar suite — `fewer-test-runs` rule)

- **Unit:** login-as modes matrix, step-up, dial-guard `full`, scheduled call state machine, preflight reasons, fallback routing, webhook verify parser (Graph answers).
- **Integration (fake Meta):** onboarding → subscribe + verify + fields fix; Fix button; switch-to-Meta conversion; scheduled call due → call → done/retry; incoming AI on/off/fallback; superadmin `full` har route.
- **E2E Playwright:** superadmin enters account → template bhejta, campaign start, inbox reply, call karta; inbox "Schedule AI call" → fake clock → bubble; settings switch ON → fake incoming → AI answers; OFF → team popup.
- **SIP/WA lab:** existing `test:sip`, fake WhatsApp user (`core/telephony/whatsapp/fake-user.ts`) se audio loop.

## 8. Live checklist (real number, owner ki permission se)

1. Number onboard (ES + Pinnacle solution) → card par "Webhook ✅ (messages, calls)".
2. Fix button: dashboard se `calls` field hata ke → button → wapas ✅.
3. Customer phone se WhatsApp call: AI switch ON → AI Hinglish mein bolta hai; OFF → team browser ring, dono taraf awaaz.
4. Inbox: Call myself, Call with AI, Schedule AI call (5 min baad) — teeno connect, recording + transcript + charge.
5. Superadmin `full`: dusre account mein jaakar same 4 steps; audit mein superadmin ka naam.
6. Wallet charge = Meta insights (± 1 pulse).

---

## 9. Execution order (phases + andaza)

| Phase | Kaam                                                                                 | Andaza         |
| ----- | ------------------------------------------------------------------------------------ | -------------- |
| P1    | Part A backend (modes, middlewares, inline checks, attribution, audit, route matrix) | 1.5 din        |
| P2    | Part A frontend (button, helper, ~40 files, banner, step-up)                         | 1.5 din        |
| P3    | Part B webhook verify/fix + auto onboarding + button                                 | 1 din          |
| P4    | Part D incoming switch (UI + validation + fallback)                                  | 1 din          |
| P5    | Part C scheduled AI calls (model, API, dispatch, preflight, UI, AI callback tool)    | 2.5 din        |
| P6    | Part B switch-to-Meta for Pinnacle numbers (D2)                                      | 1.5 din        |
| P7    | Hardening §6 + latency measure + tests §7                                            | 2 din          |
| P8    | Docs, OpenAPI, CHANGELOG, sync to client repo, live checklist §8                     | 0.5 din + live |

Har phase: lint, typecheck, build, `openapi:check`, suite ek baar, commit `type(scope): … [SA-Pn]`. Migrations additive (`0029-login-as-full`, `0030-wa-scheduled-calls`, `0031-wa-webhook-status`). Deploy: `scripts/sync-client-repo.sh`.

## 10. Open questions (bahar se confirm)

- **Q1 (Pinnacle):** Multi-partner WABA par Pinnacle `calls` events auto-handle to nahi karega? Switch ke baad `setwebhook` khaali karna theek hai?
- **Q2 (Meta):** Number messaging limit ≥ 2,000/day (calling ki shart) — is number ka tier?
- **Q3 (Server):** UDP 40000–40999 aur public IP production server par khule hain? (client team)
- **Q4:** D1–D6 ke jawab.
