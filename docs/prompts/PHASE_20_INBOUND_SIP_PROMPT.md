# PHASE 20 RUN — Incoming phone calls on the SIP line — Autonomous Run Prompt

> **HOW TO RUN (ise paste karo):**
> `cell-ai-voicebot-backend/docs/prompts/PHASE_20_INBOUND_SIP_PROMPT.md poora padho aur P20-T1 se P20-T9 tak SAARE tasks step by step autonomously implement karo. Bich me question ya permission mat maango — decisions is prompt me locked hain; koi routine choice ho to existing conventions se lo aur report me likho. Har task ke baad sirf us task ke relevant tests + lint/typecheck, phir commit (tag [P20-Tn]). Full suites sirf P20-T9 me ek-ek baar. Koi push / merge / deploy / client sync NAHI. Real trunk / real DID call tabhi jab owner chat me explicitly bole. Ant me [P20-DONE] commit + short Hinglish report.`
>
> Working directory: `/Users/lalitbansal/Documents/cell-ai-voicebot` (backend + frontend repos andar).

---

## 0. Context (verified facts — dobara derive mat karna)

- **Plan:** [INBOUND_SIP_PLAN.md](../plans/INBOUND_SIP_PLAN.md). Roadmap: [BUILD_PLAN_V2.md](../plans/BUILD_PLAN_V2.md) Phase 20.
- **Repos:** `cell-ai-voicebot-backend` (`main` = `1145f41`), `cell-ai-voicebot-frontend` (`main` = `3f50256`). Dono pushed,
  client repo synced (`release-20261106-1145f41`). Purane lint-staged stashes mat chhoona.
- **SIP line (Phase 18, ADR 0050) — reuse, rebuild nahi:**
  - `src/core/telephony/sip/ari-client.ts` — `AriClient` (REST + ek WebSocket `app=<app>&subscribeAll=false`, reconnect).
    Methods: `originate`, `answer`, `hangup(channelId, reason)`, `sendDigits`, `externalMedia`, `createBridge`,
    `addToBridge`, `removeFromBridge`, `destroyBridge`, `getVar`, `listChannels`. Events typed: `StasisStart{channel,args}`,
    `StasisEnd`, `ChannelStateChange`, `ChannelDestroyed{cause,cause_txt}`, `ChannelHangupRequest`, `ChannelDtmfReceived`,
    `ChannelVarset`, `Dial{peer,dialstatus}`, `BridgeDestroyed`. `AriChannel{id,name,state,caller?{number},connected?,channelvars?}`.
  - `sip/index.ts` — `createSipLine(env, {logger, role:'api'|'worker', redis})`; app = `${ARI_APP}-${role}`.
  - `sip/provider.ts` — `SipTelephonyProvider`: `legs: Map<callId, SipCallLeg>`, `leases`, `startCall()` (lease +
    `capacity.dialToken()` + `RtpSession.open` + new leg), `route(event)` uses `callIdOfChannel(id)` (regex
    `^cav-([^-]+)(?:-(?:em|xfer))?$`), `hangUpOrphans()`, `reconcile()`, `endAll()`, `setLiveCheck()`.
    Errors `SipLineBusyError`, `SipNoMediaPortError`.
  - `sip/leg.ts` — `SipCallLeg`: ids `main=cav-<callId>`, `bridge=cav-<callId>-br`, `transfer=cav-<callId>-xfer`, media;
    `dial()` (originate), private `answered(channel,args)` (createBridge → externalMedia → addToBridge → status
    `answered`), media timeout, `transfer(target, timeoutSec)`, `hangup(cause)`, `lost()`, `onEnded`.
  - `sip/capacity.ts` (`SipCapacity` — Redis channel leases `SIP_MAX_CHANNELS`, CPS `SIP_MAX_CPS`), `port-pool.ts`,
    `rtp-session.ts`, `causes.ts`, `cdr.ts`, `guard.ts`, `jitter.ts`.
  - Env (`src/config/env.ts` ~L243–264): `TELEPHONY_PROVIDER dryrun|sip`, `ARI_URL/USER/PASSWORD/APP`,
    `SIP_TRUNK_ENDPOINT`, `SIP_CALLER_ID`, `SIP_CODEC`, `SIP_MAX_CHANNELS`, `SIP_MAX_CPS`, `SIP_RING_TIMEOUT_SEC`,
    `SIP_MEDIA_TIMEOUT_SEC`, `SIP_APP_RTP_PORTS`, `SIP_APP_RTP_ADVERTISE`, `SIP_ASTERISK_RTP_HOST`,
    `SIP_TRUNK_COST_PAISE_PER_MIN`, `SIP_SPEND_MINUTES_PER_HOUR`; production checks ~L514+.
  - `src/modules/calls/line.ts` `effectiveLine(account, env)` → `'sip'` only when `TELEPHONY_PROVIDER=sip` **and**
    `account.voiceLine === 'sip'`.
- **Asterisk (`deploy/asterisk/`):** `conf/extensions.conf` `[cav-in]` = **abhi `Hangup(21)`** (`_X.`, `_+X.`, `s`);
  `[cav-amd]` uses `${CAV_APP}`. `pjsip.conf.template` endpoint `[trunk]` `context=cav-in`.
  `pjsip_identify.conf.template` sirf `SIP_TRUNK_IPS` se accept. `render.sh`, `entrypoint.sh`, `lab/` (local lab).
- **Calls engine:** `src/modules/calls/call.service.ts` — `CallManager.startOutboundCall(input)` (~L366), human SIP via
  `humanSip: Map<callId,{bridge: BridgeScript, dial, dialed, timer}>` (~L186), `BridgeScript` from
  `whatsapp-calling/bridge`. Routes `calls.routes.ts`: `POST /calls`, `POST /calls/:id/media-ticket`, `POST /calls/:id/hold`,
  `POST /calls/web`, `GET /calls`, `GET /calls/active`, `GET /calls/:id`, `/:id/transcript`, `/:id/events`,
  `/:id/recording`, `POST /:id/hangup`. Billing `calls/billing.ts` (`CallBilling`, `chargeCallUsage`).
  `call.model.ts`: `CALL_DIRECTIONS = ['outbound','inbound']` already; WhatsApp subdoc has its own direction.
- **WhatsApp incoming (Phase 12/18B) — logic pattern copy/reuse:**
  - `whatsapp-calling/routing.ts`: `withinCallHours(hours, at)`, `selectRingTargets({eligible, online, available, ringUserIds})`.
  - `whatsapp-calling/calls.service.ts`: `startInbound` (~L1083: claim → contact find/create → `CallModel.create` with
    `direction:'inbound'` → leg → route), `ringTeam` (~L986, ring timeout, first-wins), `onEnded` (~L348, outcome
    `missed`, bell `call.whatsapp_missed`), `handleCommand`.
  - `whatsapp-calling/bus.ts`: `CallControlBus.claimInbound(id)`, `claimAnswer(callId, userId)`, broadcast to every node.
  - Routes: `POST /whatsapp/calls/:id/answer|decline` (`calls.answer`, `blockWhenImpersonating`),
    `/users/me/call-availability`, `/calls/:id/media-ticket`.
  - `whatsapp-channel.model.ts`: types `CallHours`, `WaCallingInbound{route, aiProgram, ringTimeoutSec, ringUserIds}`,
    `callHoursProblems()` validator, `WHATSAPP_CALL_LIMITS`.
- **Phone numbers:** `db/models/phone-number.model.ts` (`number` E.164 unique, `kind`, `accountId|null`,
  `purpose: 'outbound'|'inbound'`, `label`, `dltPrincipalEntityId`, `status active|disabled`). Module
  `modules/phone-numbers/*` (superadmin CRUD/assign + `GET /phone-line` `account.read`).
- **RBAC (`modules/rbac/permissions.ts`):** `account.read`, `account.update`, `calls.read`, `calls.trigger`,
  `calls.listen`, `calls.export`, `calls.answer` ("Answer incoming WhatsApp calls"), `whatsapp.calling.manage`.
  System roles snapshot test exists (`rbac/__snapshots__`).
- **Rate card:** `db/models/rate-card.model.ts` `RateCardValues` (`callPerMinuteMicros` default 1,000,000,
  `aiPerMinuteMicros`, …, `voiceApiPulseMicros`) + `core/billing/rates.ts` `effectiveRateCard`.
- **Webhooks:** `modules/webhooks/events.ts` (`call.started`, `call.completed`, `call.insights.ready`,
  `whatsapp.call.started|ended|missed`, campaign + whatsapp_campaign events…), `publish.ts`, `samples.ts`,
  `docs/api/webhooks.md` (events-wiring test needs exact samples).
- **Public docs (just shipped):** `modules/docs/public-docs.ts` (`PUBLIC_DOCS` overlay), `quality.ts` (audit),
  `npm run docs:audit` (must stay 0 problems), `npm run docs:smoke` (all examples), guides `docs/api/*.md` →
  `npm run gen:guides`, Postman `npm run gen:postman`, `openapi:check`.
- **Migrations:** last `src/db/migrations/0025-voice-api.ts`; registry `src/db/migrations/index.ts`. Next = `0026`.
- **ADR:** last `docs/adr/0050-sip-shared-server.md`. Next = `0051`.
- **Frontend:** `features/whatsapp-calling/settings/{CallingSection.tsx, form.ts}`, `call-hours.ts`, `ProgramPicker.tsx`,
  `live/` (incoming call panel), `features/calls/{CallMethodDialog.tsx, capabilities.ts, queries.ts, labels.ts}`,
  `features/admin/PhoneLineCard.tsx`, `pages/admin/AdminPhoneNumbersPage.tsx`, `services/api/phone-numbers.ts`,
  `layout/nav-config.ts`, `app/routes.tsx`, `services/api/schema.gen.ts` (`npm run gen:api`).
- **Catalogues (test-enforced):** `shared/errors/error-codes.ts` ≡ `docs/conventions/error-codes.md`; audit actions
  `modules/audit/audit-actions.ts`; notification types; env inventory + `env.example` (deploy/production, deploy/staging);
  `docs/security/RATE_LIMITS.md` (`npm run gen:rate-limits`); `docs/security/DATA_MAP.md`; privacy erase map;
  `tests/security/phase15-routes.test.ts` route matrix snapshot (one scope per public route).
- **Memory rules:** full suites ek baar per phase, serial; deploy sirf client repo flow se (yahan nahi).

## 1. Goal

Customer hamare DID par call kare → call sahi account tak pahunche → number ki setting ke hisaab se AI flow / AI agent
jawab de, ya team browser me uthaye, ya combination. Business hours, missed calls + callback list, wallet billing,
reports, webhook, public API docs — sab. Bina real trunk ke lab/fake me poora chal kar dikhe.

## 2. Scope

**In scope:** P20-T1…T9 (Asterisk dialplan + ARI inbound app, model + migration, inbound leg, routing service, team ring +
answer, missed + callback, billing, API + public docs + webhook, frontend settings / popup / missed tab / admin, reports,
dev simulator, minimal tests, docs + sign-off).

**Out of scope (mat karna):** voicemail recording, queue position announce / multiple queues, separate IVR menu builder,
WhatsApp inbound changes (Phase 12 done), number purchase/porting, toll-free special billing, real trunk/DID config,
production `.env` edits, push/merge/deploy/client sync.

## 3. Locked decisions

| #   | Topic            | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Kill switch      | New env `SIP_INBOUND_ENABLED` (bool, default `false`). False → API process `-inbound` app subscribe nahi karta; Asterisk call ko Stasis app nahi milti → Asterisk khud fail (caller ko unavailable). Feature UI me "Incoming calls off on this server" chip                                                                                                                                                                                                                                                                                                                                                                                                                              |
| D2  | ARI app          | Dialplan `Stasis(${CAV_APP}-inbound,<did>,<callerNum>)`. Sirf `role==='api'` process `AriClient` ko apps list `[<ARI_APP>-api, <ARI_APP>-inbound]` deta hai (WebSocket `app=a,b`). Worker kabhi nahi. Har StasisStart par Redis claim `sip:in:<channelId>` NX EX 300 — claim fail → ignore (dusra node le raha)                                                                                                                                                                                                                                                                                                                                                                          |
| D3  | Dialplan         | `[cav-in]`: `_X.` → `Set(CAV_DID=${EXTEN})` → `Stasis(${CAV_APP}-inbound,${CAV_DID},${CALLERID(num)})` → `Hangup()`; `_+X.` → `Goto(cav-in,${EXTEN:1},1)`; `s` → `Set(CAV_DID=${CUT(CUT(PJSIP_HEADER(read,To),@,1),:,2)})` → same Stasis. `render.sh` me `CAV_APP` already substitute hota hai (verify; nahi to add). `[cav-amd]` untouched                                                                                                                                                                                                                                                                                                                                              |
| D4  | DID normalize    | Digits only; `0` prefix hata ke; 10 digits → `+91`; `91` + 10 → `+`; already `+…` keep. Fn `normalizeDid(raw, defaultCc='91')` in `modules/calls/inbound/numbers.ts`. Same fn caller number ke liye; empty / `anonymous` / `restricted` / non-digit → `callerHidden: true`                                                                                                                                                                                                                                                                                                                                                                                                               |
| D5  | Number lookup    | `PhoneNumberModel.findOne({ number, status:'active', accountId:{$ne:null}, purpose:{$in:['inbound','both']}, 'inbound.enabled': true })`. Account must exist, not suspended/deleted, `effectiveLine(account, env) === 'sip'`. Fail → reject cause `21` (call rejected); **no call doc**, sirf log (masked) + metric counter `sip_inbound_rejected_total{reason}`                                                                                                                                                                                                                                                                                                                         |
| D6  | Purpose          | `PHONE_NUMBER_PURPOSES = ['outbound','inbound','both']`. Outbound caller-ID choice (existing) `outbound` + `both` accept kare — existing filters verify karke update                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D7  | Inbound settings | `phoneNumbers.inbound` subdoc (defaults): `enabled:false`, `route:'ai'`, `program:null` (`{kind:'flow'\|'agent', id}`), `greeting:''` (≤200), `ringUserIds:null`, `ringTimeoutSec:30` (10…`SIP_INBOUND_RING_MAX_SEC`), `callHours` (= WhatsApp `CallHours`, default disabled, `Asia/Kolkata`), `afterHours:{action:'message', message:'Abhi hamara office band hai. Kripya office time me call karein.'}` (`message`≤200; action `message\|ai\|hangup`), `updatedBy`, `updatedAt`. Validation: `route` `ai`/`ai_then_team`/`team_then_ai` → `program` required + published flow / active agent of same account; `afterHours.action==='ai'` → program required; `callHoursProblems` reuse |
| D8  | Routes           | `ai` · `team` · `ai_then_team` (AI; flow/agent ka transfer step target `team` → ring) · `team_then_ai` (ring; timeout / no one online → AI). Team route me koi ring target hi nahi → `team`: missed `no_agents` + message; `team_then_ai`: seedha AI                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D9  | Order of checks  | claim → number/account (D5) → spam guard (D10) → line lease (D11) → hours (D12) → wallet (D13) → contact (D14) → call doc → answer → route. Pehla fail jahan call doc ban chuka (D10 ke baad) → missed reason set                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| D10 | Spam guard       | Redis `sip:in:rate:<accountId>:<caller>` INCR EX 3600; > `SIP_INBOUND_PER_CALLER_PER_HOUR` (default 10, 1…100) → reject `17` busy, call doc banta hai `missed.reason='spam'` (callback list me **nahi** — `callback.status='done'` auto). Hidden caller → guard skip                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D11 | Line limit       | Same `SipCapacity` lease (`<callId>`), **no** CPS token. Lease fail → reject `17`, missed `line_busy`. `SIP_INBOUND_RESERVED_CHANNELS` (default 0, ≥0, < `SIP_MAX_CHANNELS`): outbound `lease()` caps at `max - reserved`; inbound full max use kare                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D12 | Hours            | `withinCallHours(inbound.callHours, now)`. Bahar: `message` → answer, TTS message, hangup, missed `after_hours`; `hangup` → reject `21` (no answer, no charge), missed `after_hours`; `ai` → AI program chalao (no missed)                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| D13 | Wallet           | Answer se **pehle**: rate = `inboundCallPerMinuteMicros ?? callPerMinuteMicros` (+ `aiPerMinuteMicros` if AI). Existing phone-call hold/charge path (`CallBilling`) with 1 min min-spend rule. Fail → answer, fixed TTS "Seva abhi uplabdh nahi hai", hangup, **no charge**, missed `wallet_low`, account owners ko bell `wallet.low` existing type if present else `call.sip_missed`. Minutes billed only answered segment (ringing/greeting-before-team-answer counted from Asterisk answer — same as outbound "answered" time)                                                                                                                                                        |
| D14 | Contact          | Caller E.164 → `ContactModel.findOne({accountId, phoneE164, deletedAt:null})`; nahi → create `{accountId, phoneE164, name:'', source:{type:'inbound_call', callId}}` (add `'inbound_call'` to contact source enum). Hidden → `contactId: null` (make `contactId` optional for `direction:'inbound' && provider:'sip'` if schema requires; check every consumer — list/detail/export/analytics/insights — null-safe). DND / opt-out **apply nahi** (customer khud call kar raha)                                                                                                                                                                                                          |
| D15 | Call doc         | `CallModel.create({accountId, provider:'sip', direction:'inbound', mode:'ai'\|'human', from:<caller E.164 \| 'anonymous'>, to:<DID>, contactId, source, isTest:false, timestamps:{queuedAt}, sip:{did, phoneNumberId, route, callerHidden, channelId}, missed:null})`. `source` = program (ai) or `{kind:'human'}` like outbound human                                                                                                                                                                                                                                                                                                                                                   |
| D16 | Leg inbound mode | `SipCallLeg` option `inbound:{channelId}`: `ids.main = channelId` (Asterisk id), `dial()` = `ari.answer(main)` then existing `answered()` path (bridge + externalMedia + media timer) — originate never. Before answer `ari.ring(main)` (POST `/channels/{id}/ring`). Reject = `ari.hangup(main, 'busy'\|'normal'\|'unallocated'...)` map cause 17→`busy`, 21→`normal` w/ reason `rejected` (ARI reason list check), 34→`congestion`. After answer `setVar(main,'CAV_CALL_ID',callId)` (orphan check)                                                                                                                                                                                    |
| D17 | Provider routing | `SipTelephonyProvider`: `inboundChannels: Map<asteriskChannelId, callId>`; `route()` first checks this map, then `callIdOfChannel`. `onIncoming(handler)`; StasisStart where `channel.id` unknown AND `args.length >= 1` AND not matching `cav-` → handler(channel, did=args[0], caller=args[1] ?? channel.caller?.number). `acceptInbound({callId, channel})` → lease + RTP + leg; `rejectInbound(channelId, cause)`. `hangUpOrphans`: also channels whose `CAV_CALL_ID` var points to a non-live call; channels in `-inbound` app with no var older than 60 s → hangup                                                                                                                 |
| D18 | AI route         | `CallManager.startInboundCall({accountId, callId, leg, program, contactId, variables})` — refactor `startOutboundCall` ka session/script part into shared private `runSession()`; outbound behaviour **bit-for-bit same** (existing tests green). Variables: contact fields + `call.callerNumber`, `call.dialedNumber`, `call.direction='inbound'`, `call.numberLabel`. Recording: account's existing recording setting                                                                                                                                                                                                                                                                  |
| D19 | Team ring        | Eligible = account users with `calls.answer` (update description → "Answer incoming calls"), active, not impersonation. `selectRingTargets` with presence/availability (existing `/users/me/call-availability` + realtime online). Realtime event to each target: `call.incoming` `{callId, kind:'sip', from, contactName, did, numberLabel, ringUntil}`; end: `call.ring_ended {callId, answeredBy?}`. Caller meanwhile: greeting TTS (if set) → ringback tone loop (`core/telephony/whatsapp/tones.ts` reuse, 8 kHz)                                                                                                                                                                   |
| D20 | Answer           | `POST /api/v1/calls/:id/answer` and `/decline` (`calls.answer`, `blockWhenImpersonating`, idempotent). First-wins via `CallControlBus.claimAnswer(callId, userId)` (reuse; generalise if WhatsApp-specific) → loser 409 `CALL_ALREADY_ANSWERED`. Winner → `agentUserId` set, mode `human`, `BridgeScript` + existing SIP human media path (`POST /calls/:id/media-ticket`); stop tone. Sab decline / timeout → D8 fallback                                                                                                                                                                                                                                                               |
| D21 | Missed           | `missed: {reason: 'no_answer'\|'no_agents'\|'after_hours'\|'line_busy'\|'wallet_low'\|'caller_hung_up'\|'spam', callback:{status:'open'\|'done', doneBy, doneAt}}`; `status` of call = existing `no_answer`-like terminal (`missed` outcome as WhatsApp uses). Caller hangs up during ring/greeting → `caller_hung_up`. Bell type `call.sip_missed` (title "Missed call", body caller + number label) to ring targets, else account owners/admins. Webhook `call.missed`                                                                                                                                                                                                                 |
| D22 | Callback         | `POST /calls/:id/callback-done` (`calls.trigger`), idempotent, audited `call.callback_done`. "Call back" button = existing `POST /calls` (no new route). New outbound call to same contact auto-closes open missed callbacks of that contact within 24 h                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D23 | Webhooks         | New event `call.missed` (data: `callId, from, did, numberLabel, reason, contactId, at`). `call.started` / `call.completed` data + `direction`, `did` (null for outbound). Samples + `docs/api/webhooks.md` exact                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| D24 | API + scopes     | Dashboard: `GET /phone-numbers/mine` (`account.read`), `PATCH /phone-numbers/:id/inbound` (`account.update`, `blockWhenImpersonating`, audit `phone_number.inbound_updated`, own account only, 404 otherwise). Public API: `GET /api/v1/calls` gains `direction` + `missed=open\|all` filters (existing scope `calls:read`); `GET /resources/phone-line` adds `inboundNumbers[] {number,label,enabled,route}`. Answer/decline/callback-done/settings = dashboard-only (not public). `PUBLIC_DOCS` overlay + `docs:audit` 0 problems                                                                                                                                                      |
| D25 | Errors           | New codes: `INBOUND_PROGRAM_REQUIRED` (422), `INBOUND_PROGRAM_NOT_READY` (422 — flow unpublished / agent inactive), `CALL_ALREADY_ANSWERED` (409), `CALL_NOT_RINGING` (409). `error-codes.ts` + docs + `PUBLIC_ERRORS` only if public                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| D26 | Rate card        | `inboundCallPerMinuteMicros?: number` (optional; missing = `callPerMinuteMicros`); superadmin rate card UI + per-account override path same as other fields; ledger breakdown `direction:'inbound'`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| D27 | Simulator        | Non-production only: `POST /api/v1/dev/sip/inbound {did, from}` (superadmin or `NODE_ENV!=='production'` dev guard as `dev-jobs.routes.ts`) → runs the **same** `handleIncoming` with a fake leg on dryrun line (no Asterisk) so UI ring/answer/missed can be seen locally                                                                                                                                                                                                                                                                                                                                                                                                               |
| D28 | Privacy          | Caller numbers = personal data: `DATA_MAP.md` row, privacy erase map covers `calls.from` for inbound + `missed`, retention same as calls. Logs mask numbers (`maskPhone` existing helper)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| D29 | Permissions      | No new permission. `calls.answer` description generalised. Login-as view mode read-only; act mode cannot answer (`blockWhenImpersonating`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| D30 | Tests            | Sirf §6 wali files + existing tests jo is change se toot-ein unka fix. Assertions/guards/thresholds weaken nahi                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## 4. Rules of engagement

1. No questions — D1–D30 follow; gap ho to safest consistent choice + report me likho.
2. Branch: dono repos `git switch -c feature/phase-20-inbound-sip` from current `main` (exists → switch + resume).
3. One commit per task per touched repo, Conventional Commit + `[P20-Tn]`, hooks pass. No push / merge.
4. Har query `accountId` scoped (lookup by DID ke baad bhi har write `accountId` ke saath).
5. Har new env var → `config/env.ts` (+ production check if needed) + `deploy/production/env.example` +
   `deploy/staging/env.example` + env inventory doc.
6. Har task ke baad: changed files lint, typecheck, us task ke tests. Long runs background me with real exit codes.
7. Outbound SIP behaviour unchanged — existing SIP tests (`tests/**/sip*`, `src/core/telephony/sip/*.test.ts`) must stay green.
8. Catalogue / schema change usi task me docs + generated contract (`gen:openapi`, `gen:postman`, frontend `gen:api`).
9. `.env` files kabhi read/print nahi. Real trunk / DID / Asterisk production change nahi.

## 5. Resume safety

`git branch --show-current` + `git log --oneline -20` dono repos; last `[P20-Tn]` ke baad wale task se continue.
Uncommitted changes preserve karo (stash/reset nahi).

## 6. Tasks

### P20-T1 — Asterisk dialplan + ARI inbound app + env (backend)

1. `deploy/asterisk/conf/extensions.conf` `[cav-in]` per D3 (comment: Phase 20, ADR 0051). Verify `render.sh` substitutes
   `CAV_APP`; `lab/` me ek inbound scenario (SIPp XML ya softphone note) jo `cav-in` me DID `+911600000001` dial kare.
2. `ari-client.ts`: config `app` → `apps: string[]` (back-compat: `app` string still accepted), WS URL `app=<joined>`;
   add `ring(channelId)`, `setVar(channelId, variable, value)`; add `args` already typed. Unit test updates only if broken.
3. `sip/index.ts`: `SipLine` gets `inboundApp: string | null`; role `api` + `SIP_INBOUND_ENABLED` → apps include `-inbound`.
4. Env (D1, D10, D11): `SIP_INBOUND_ENABLED`, `SIP_INBOUND_PER_CALLER_PER_HOUR`, `SIP_INBOUND_RESERVED_CHANNELS`
   (refine `< SIP_MAX_CHANNELS`), `SIP_INBOUND_RING_MAX_SEC` (default 120, 10…300). Inventory + examples.
   **Commit:** `feat(sip): route trunk calls to an inbound ARI app [P20-T1]`

### P20-T2 — Data model + migration

1. `phone-number.model.ts`: purpose `both` (D6), `inbound` subdoc + validators (D7). Export `PhoneNumberInbound`, `defaultInbound()`.
2. `call.model.ts`: `sip?` subdoc (D15), `missed?` (D21), `contactId` optional rule (D14), index
   `{accountId:1, direction:1, 'missed.callback.status':1, createdAt:-1}`.
3. `contact.model.ts` source type `inbound_call`. `rate-card.model.ts` `inboundCallPerMinuteMicros` (D26) + `isMicros`.
4. Migration `0026-inbound-sip.ts` (registry): `phoneNumbers` without `inbound` → `$set` default; create call index.
   Idempotent, additive, `down` removes index only.
5. Outbound caller-ID selection accepts `both` (grep `purpose: 'outbound'` usages).
   **Commit:** `feat(calls): add inbound number settings and missed call fields [P20-T2]`

### P20-T3 — Inbound leg + provider

1. `leg.ts` inbound mode (D16). Keep outbound code path identical.
2. `provider.ts` (D11, D17): `inboundChannels`, `onIncoming`, `acceptInbound`, `rejectInbound`, reserved-channel cap for
   outbound `lease`, orphan handling; `endAll` covers inbound legs.
3. `causes.ts`: inbound reject reasons map.
   **Commit:** `feat(sip): answer and reject incoming trunk calls [P20-T3]`

### P20-T4 — Inbound service: checks, contact, AI route, billing, missed

1. `src/modules/calls/inbound/numbers.ts` (D4), `inbound.service.ts` `handleIncoming` (D2 claim, D5, D9–D15), `missed.ts`
   (D21 set + bell + webhook), wire in `server.ts`/`calls/index.ts` only for api role with SIP line + `SIP_INBOUND_ENABLED`.
2. `CallManager.startInboundCall` + shared `runSession` (D18). Billing inbound rate (D13, D26) through existing
   `CallBilling` / `chargeCallUsage` with `direction`.
3. After-hours / wallet-low TTS messages via existing TTS path used by flows (cache audio per text+voice).
4. `call.started` / `call.completed` gain `direction`, `did` (D23); `call.missed` event + sample + `webhooks.md`.
   **Commit:** `feat(calls): route incoming phone calls to flows and agents [P20-T4]`

### P20-T5 — Team ring, answer, fallbacks

1. `inbound/ring.ts`: targets (D19), realtime `call.incoming` / `call.ring_ended`, greeting + ringback loop, timeout
   → D8 fallback (`team_then_ai` → AI session on same leg; else missed `no_answer`/`no_agents` + message + hangup).
2. Routes `POST /calls/:id/answer`, `/decline` (D20) in `calls.routes.ts` + schema/OpenAPI (dashboard tags). Bus claim reuse.
3. `ai_then_team`: flow transfer node + agent transfer tool accept target `team` → `ring.ts`; external number transfer unchanged.
4. Caller hang-up during ring → `caller_hung_up`, stop ring everywhere.
   **Commit:** `feat(calls): ring the team for incoming phone calls [P20-T5]`

### P20-T6 — API, settings, callback, public docs

1. `GET /phone-numbers/mine`, `PATCH /phone-numbers/:id/inbound` (D24) with readiness `{lineConnected, inboundEnabledOnServer,
programReady, ringTargetsOnline}`; audit action; superadmin admin routes accept `both`.
2. `POST /calls/:id/callback-done` (D22) + auto-close on new outbound call. `GET /calls` filters `direction`, `missed`.
3. Public: `PUBLIC_DOCS` entries/descriptions for changed public routes, `/resources/phone-line` `inboundNumbers`,
   guide `docs/api/calls.md` "Incoming calls" section + `webhooks.md`; `gen:guides`, `gen:openapi`, `gen:postman`,
   `docs:audit` 0 problems; phase15 matrix snapshot `-u` after review.
4. Error codes (D25) + docs; `RATE_LIMITS.md` regen if new limiter; `calls.answer` description.
   **Commit:** `feat(api): manage incoming numbers and missed calls [P20-T6]`

### P20-T7 — Frontend

1. `services/api/phone-numbers.ts` + `npm run gen:api`. **Settings → Phone numbers** tab (nav + route; visible with
   `account.read`, edit with `account.update`): number list (label, number, purpose, enabled chip, readiness chips);
   "Incoming calls" drawer/form — enable switch, route radio ×4 with Hinglish help, `ProgramPicker` (flow/agent),
   greeting, ring users multi-select + timeout, call hours editor (reuse `whatsapp-calling/call-hours`), after-hours
   action + message. zod form like `whatsapp-calling/settings/form.ts`.
2. **Incoming call popup** (global, like WhatsApp live panel): `call.incoming` kind `sip` → caller, contact link,
   number label, countdown, Answer / Decline, ring sound; answer → existing SIP human call panel; `call.ring_ended` closes.
3. **Calls page:** Direction filter + column (Incoming/Outgoing icon), **Missed** tab (reason label, Call back →
   `CallMethodDialog` prefilled, Mark done), call detail shows DID/number label/route.
4. Admin: phone numbers purpose `both` + inbound column; rate card `Inbound call / min`; `PhoneLineCard` inbound count.
5. Labels in `features/calls/labels.ts`; notification type label `call.sip_missed`; webhook event label `call.missed`.
   **Commit:** `feat(calls): incoming phone call settings, popup and missed list [P20-T7]`

### P20-T8 — Reports, simulator, docs

1. Reports/analytics: `direction` dimension/filter in calls report + CSV export columns `Direction`, `Dialed number`,
   `Missed reason`; dashboard tiles today incoming / answered / missed. Analytics rollups null-contact safe.
2. Simulator route (D27) + frontend dev-only button? **No UI button** — README how-to only.
3. Docs: ADR `0051-inbound-sip.md`, `docs/integrations/sip-inbound.md` (trunk requirements, DID formats, causes,
   checklist from plan §4), `docs/conventions/api.md`, `DATA_MAP.md` + erase map (D28), `docs/ops/release-phase-20.md`
   (migration 0026, env, Asterisk config redeploy order: app first then dialplan, `SIP_INBOUND_ENABLED=true`, rollback =
   flag false + dialplan revert), CHANGELOGs both repos, READMEs, plan status, BUILD_PLAN_V2 Phase 20 🟡.
   **Commit:** `docs(calls): document incoming phone calls [P20-T8]`

### P20-T9 — Final checks + sign-off

1. Backend: `lint`, `typecheck`, `build`, `openapi:check`, `docs:audit`, `docs:smoke`, full `test` **once** (serial;
   Mongo crash → rerun only failed files). Frontend: `lint`, `typecheck`, `build`, `test` **once**.
   Pre-existing known failures (also on `main`): `tests/whatsapp-campaigns/campaigns.test.ts` recurrence,
   frontend `inbox-page.test.tsx` "Retry a failed send" — note, don't hide.
2. Real failures fix → affected files rerun. Code ko full run ke dauraan edit mat karo.
3. `docs/phases/PHASE_20_SIGNOFF.md`: tasks ✅/⚠️, numbers + log paths, migration/env, deviations, live checks.
4. Live check list (NOT run without owner): client DID routed to Asterisk; trunk IPs; DID position (RURI/To);
   `SIP_INBOUND_ENABLED=true`; owner's phone → DID → AI route speaks; team route browser rings + talk; after-hours
   message; missed shows + callback; wallet charged once; `call.missed` webhook.
   **Commit:** `docs(calls): record incoming phone calls sign-off [P20-DONE]`

## 7. Tests (sirf yeh — kam aur relevant)

| File                                                    | Covers                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| backend `src/modules/calls/inbound/numbers.test.ts`     | `normalizeDid` formats (`+91…`, `91…`, `0…`, 10-digit, To-header URI), hidden/anonymous caller                                                                                                                                                                                                                                                 |
| backend `src/core/telephony/sip/inbound-leg.test.ts`    | fake ARI: StasisStart unknown channel → handler with did/caller; accept → ring, answer, bridge + externalMedia; reject causes 17/21; claim lost → ignored; inbound channel events routed via map; reserved channels cap outbound                                                                                                               |
| backend `tests/calls/inbound-sip.test.ts`               | end-to-end on fake ARI + dryrun voice: unknown/disabled DID → reject, no doc; AI route → call doc (direction, did, contact created), flow runs, billing inbound rate captured once, `call.completed` webhook with direction; after hours `message` → missed `after_hours`; wallet low → no charge, missed; spam 11th call busy; line full busy |
| backend `tests/calls/inbound-ring.test.ts`              | team route: 2 users ringed, first answer wins, second 409 `CALL_ALREADY_ANSWERED`, `call.ring_ended`; timeout → missed `no_answer` + bell + `call.missed`; `team_then_ai` timeout → AI; caller hangs up → `caller_hung_up`; callback-done + auto-close                                                                                         |
| backend `tests/phone-numbers/inbound-settings.test.ts`  | PATCH validation (program required/not ready, call hours), `account.update` vs read-only 403, other account 404, impersonation blocked, audit row                                                                                                                                                                                              |
| frontend `src/features/settings/phone-numbers.test.tsx` | form: route → program required, hours editor, save body                                                                                                                                                                                                                                                                                        |
| frontend `src/features/calls/incoming-sip.test.tsx`     | `call.incoming` → popup → Answer posts; `ring_ended` closes; Missed tab Call back / Mark done                                                                                                                                                                                                                                                  |
| existing                                                | `tests/security/phase15-routes.test.ts` snapshot, rbac snapshot, events-wiring, public docs tests — update, not weaken                                                                                                                                                                                                                         |

## 8. Final report (short Hinglish)

1. Har task ✅ / ⚠️ / ❌ + 1 line. 2. Commits (`git log --oneline` dono repos). 3. Test/build actual numbers + pre-existing
   failures. 4. Deviations from D1–D30. 5. Live-blocked items (client DID, trunk, owner test call). 6. Push/deploy: "nahi kiya".
