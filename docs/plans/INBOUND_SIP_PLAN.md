# Phase 20 — Incoming phone calls on the SIP line (plan)

6 Nov 2026 · Roadmap: [BUILD_PLAN_V2.md](BUILD_PLAN_V2.md) Phase 20 · Status: **implemented locally (P20-T1…T9); live check pending the client's DID**

Goal: koi customer hamare DID (phone number) par call kare → call sahi account tak pahunche →
AI flow / AI agent jawab de, ya team browser se uthaye, ya dono (AI → team). Business hours,
missed calls + callback list, billing, reports, webhooks — sab. Tests kam (sirf relevant), kaam fast.

---

## 0. Abhi code mein kya hai (reuse karenge)

| Already hai                                                                                                 | Kahan                                                          | Phase 20 mein use                                                           |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Asterisk + ARI, ek ARI app per process (`cav-api`, `cav-worker`)                                            | `src/core/telephony/sip/{ari-client,index,provider}.ts`        | Inbound ke liye API process ek aur app sunega                               |
| Trunk se aayi call `[cav-in]` context mein **abhi Hangup(21)** hoti hai                                     | `deploy/asterisk/conf/extensions.conf`                         | Isko `Stasis(...)` par bhejna                                               |
| Sirf trunk IPs se call accept (`SIP_TRUNK_IPS`)                                                             | `pjsip_identify.conf.template`                                 | As-is (security)                                                            |
| SIP leg: answer ke baad bridge + externalMedia (RTP), DTMF, transfer, media timeout, orphan cleanup         | `src/core/telephony/sip/leg.ts`                                | Inbound mode add (originate nahi, seedha answer)                            |
| Trunk channel limit + CPS Redis mein shared (`SipCapacity`)                                                 | `sip/capacity.ts`                                              | Inbound bhi wahi channel lease lega                                         |
| Flow / agent script runner, SIP human call via browser (`BridgeScript`, Phase 19 follow-up)                 | `src/modules/calls/call.service.ts`, `whatsapp-calling/bridge` | Inbound AI + team answer dono                                               |
| WhatsApp **incoming** calls: route `team / ai / ai→team`, team ring first-wins, call hours, missed + bell   | `src/modules/whatsapp-calling/{calls.service,routing}.ts`      | Same logic / UI pattern copy-reuse (`withinCallHours`, `selectRingTargets`) |
| `phoneNumbers` collection (superadmin pool, account ko assign, `purpose: outbound \| inbound`)              | `src/db/models/phone-number.model.ts`, admin page              | Number par inbound settings                                                 |
| `calls.direction: outbound \| inbound` already enum                                                         | `src/db/models/call.model.ts`                                  | Inbound SIP calls isi collection mein                                       |
| Rate card `callPerMinuteMicros`, `aiPerMinuteMicros`, `CallBilling`                                         | `rate-card.model.ts`, `calls/billing.ts`                       | Inbound minutes charge                                                      |
| Frontend: WhatsApp calling settings (`CallingSection`, call hours editor, `ProgramPicker`), live call panel | `features/whatsapp-calling/*`                                  | Phone number inbound settings same components se                            |

**Matlab:** naya engine nahi banana. Asterisk dialplan + leg ka inbound mode + routing service + settings UI.

---

## 1. Product decisions (plan ke hisaab se default — owner badal sakta hai)

1. **Number kis account ka:** superadmin DID ko account ko assign karta hai (existing admin page). `purpose` mein
   `both` add — ek number se outbound caller ID bhi aur inbound bhi.
2. **Routing (per number), WhatsApp jaisa hi:**
   - `ai` — published flow ya active AI agent uthata hai.
   - `team` — online + available team members ke browser mein ring; jo pehle uthaye (first-wins).
   - `ai_then_team` — AI pehle; flow/agent ka transfer step team ring karta hai (external number transfer bhi as-is chalega).
   - `team_then_ai` — team ring timeout tak koi na uthaye to AI le leta hai (missed se behtar).
3. **Greeting:** AI route mein flow/agent ka apna start message. Team route mein optional short greeting
   (TTS, e.g. "Aapki call jodi ja rahi hai, kripya pratiksha karein") phir ringback tone.
4. **Business hours:** WhatsApp wala `CallHours` (timezone, weekly, holidays). Bahar → `afterHours.action`:
   `message` (TTS text bolke hangup), `ai` (AI le), `hangup`. Har case missed list mein jayega (sirf `ai` mein nahi).
5. **Contact match:** caller number E.164 (`+91…`) → account ka contact. Nahi mila → naya contact
   (`source.type: 'inbound_call'`). Number hidden/anonymous → contact nahi banega; call `anonymous` caller ke
   saath chalegi (AI ok), callback list mein "number hidden".
6. **Queue:** simple — ring ke dauran caller ringback / hold tone sunta hai, max `ringTimeoutSec` (default 30,
   max 120). Position announce, multiple queues, voicemail recording → **out of scope** (Phase 20 nahi).
7. **Missed calls + callback list:** missed = nobody answered / after hours / line full / wallet low / caller ne
   ring mein hi kaat diya. Calls page par "Missed" tab: Call back (existing Call now — flow / agent / Call yourself),
   Mark done. Bell notification `call.sip_missed` (WhatsApp ke `call.whatsapp_missed` jaisa).
8. **Billing:** inbound minute = `inboundCallPerMinuteMicros` (rate card naya field, default = `callPerMinuteMicros`)
   - AI minute (AI route mein). Answer se pehle wallet check: 1 minute ka paisa nahi → short message + hangup,
     kuch charge nahi, missed (`wallet_low`). Unanswered/missed = free.
9. **Spam guard:** ek caller number se max `SIP_INBOUND_PER_CALLER_PER_HOUR` (default 10) calls/number; usse zyada
   → busy (17). DID assigned + `active` + inbound on nahi → reject (21), kuch create nahi.
10. **Line limit:** inbound + outbound ek hi `SIP_MAX_CHANNELS` share karte hain. Full → busy, missed (`line_busy`).
    Campaigns inbound ke liye 1 channel reserve nahi karte (v1); owner chahe to `SIP_INBOUND_RESERVED_CHANNELS` (default 0).

---

## 2. Architecture

```
Caller ──PSTN──► Client trunk ──SIP INVITE (To/RURI = DID)──► Asterisk [cav-in]
   Set(CAV_DID=${EXTEN} | To header) → Stasis(<ARI_APP>-inbound, ${CAV_DID})
        │
        ▼  StasisStart (API process ka ARI socket: app=cav-api,cav-inbound)
SipTelephonyProvider.onIncoming(channel, did)
   1. Redis claim sip:in:<channelId> (NX, 5 min)          — do process ek call na le
   2. Inbound service: DID → phoneNumber → account; checks (assigned, active, inbound on,
      spam guard, line lease, wallet, hours) → fail = Hangup(cause) + missed call doc
   3. CallModel.create(direction inbound, provider sip, from caller, to DID)
   4. leg = SipCallLeg (inbound mode: answer → bridge + externalMedia)
   5. route:
        ai   → CallManager session (flow / agent script, same as outbound)
        team → ring browsers (realtime) → first answer → BridgeScript (browser ↔ RTP)
        ai_then_team / team_then_ai → combination
   6. end → billing capture, outcome, missed bell, webhook, reports
```

- Inbound channel id Asterisk ka hota hai (`cav-<callId>` nahi) → provider mein `inboundChannels: Map<channelId, callId>`
  rakhenge; `route()` pehle is map ko dekhe. Transfer leg `cav-<callId>-xfer` as-is.
- `hangUpOrphans`: inbound channels ke liye map + `CAV_CALL_ID` channel var (StasisStart ke baad `setVar`) se check.

---

## 3. Steps (order mein)

### I1 — Asterisk + ARI inbound wiring (backend + deploy) · S

1. `extensions.conf` `[cav-in]`:
   ```
   exten => _X.,1,Set(CAV_DID=${EXTEN})
    same => n,Stasis(${CAV_APP}-inbound,${CAV_DID},${CALLERID(num)})
    same => n,Hangup()
   exten => _+X.,1,Goto(cav-in,${EXTEN:1},1)
   exten => s,1,Set(CAV_DID=${PJSIP_HEADER(read,To)})   ; trunk DID ko RURI mein na bheje to
    same => n,Stasis(${CAV_APP}-inbound,${CAV_DID},${CALLERID(num)})
   ```
   `CAV_APP` already env se render hota hai (`render.sh` check). Lab (`deploy/asterisk/lab`) mein ek softphone/SIPp
   scenario jo `cav-in` mein call kare.
2. `ari-client.ts`: `app` ko list allow (`apps: string[]`, URL `app=cav-api,cav-inbound`); `setVar(channelId, name, value)`,
   `ring(channelId)` (POST `/channels/{id}/ring`), `continueInDialplan` nahi chahiye.
3. `sip/index.ts`: `role === 'api'` aur `SIP_INBOUND_ENABLED=true` par hi `-inbound` app subscribe. Worker kabhi nahi.
4. Env (`config/env.ts`, env inventory docs, `env.example` dono deploy folders): `SIP_INBOUND_ENABLED` (default `false`),
   `SIP_INBOUND_PER_CALLER_PER_HOUR` (10), `SIP_INBOUND_RESERVED_CHANNELS` (0), `SIP_INBOUND_RING_MAX_SEC` (120).

### I2 — Data model + migration · S

1. `phone-number.model.ts`:
   - `purpose` enum + `'both'`.
   - `inbound` subdoc:
     ```
     inbound: {
       enabled: boolean,                                // default false
       route: 'ai' | 'team' | 'ai_then_team' | 'team_then_ai',
       program: { kind: 'flow' | 'agent', id } | null,  // ai routes ke liye zaroori
       greeting: string,                                 // team route, ≤ 200 chars, '' = none
       ringUserIds: ObjectId[] | null,                   // null = sab eligible
       ringTimeoutSec: number,                           // 10..120, default 30
       callHours: CallHours,                             // whatsapp-channel.model se type + validator reuse
       afterHours: { action: 'message' | 'ai' | 'hangup', message: string },
       recordCalls: boolean,                             // existing recording settings follow
     }
     ```
   - Validation: route `ai*` → `program` required; `callHoursProblems` reuse.
2. `call.model.ts`: `sip?: { did, callerHidden, inboundOutcome?: 'answered_ai' | 'answered_team' | 'missed' }`,
   `missed?: { reason: 'no_answer' | 'after_hours' | 'line_busy' | 'wallet_low' | 'caller_hung_up' | 'spam',
callback: { status: 'open' | 'done', doneBy, doneAt } }`. Index `{ accountId, direction, 'missed.callback.status', createdAt }`.
3. `rate-card.model.ts`: `inboundCallPerMinuteMicros` (optional; missing = `callPerMinuteMicros`). Superadmin rate card UI field.
4. `contact.model.ts` source types + `'inbound_call'`.
5. Migration `0026-inbound-sip` (additive): phoneNumbers ko default `inbound` (enabled false), index. Rollback-safe.

### I3 — Inbound leg (core telephony) · M

1. `leg.ts`: option `inbound?: { channelId: string }`. Inbound mein `dial()` = `ari.answer(channelId)` → existing
   `answered()` path (bridge + externalMedia + media timer). `ring()` (180 Ringing) jab tak routing decide ho.
   `hangup(cause)` mein reject causes: `busy` (17), `rejected` (21), `unavailable` (34).
2. `provider.ts`:
   - `onIncoming(handler)` register; `route()` mein StasisStart jiska `args[0]` DID hai aur channel unknown → handler.
   - `acceptInbound({ callId, channelId })` → lease (`capacity.acquire`, CPS token nahi), RTP port, leg; map entry.
   - `rejectInbound(channelId, cause)`.
   - Reserved channels: outbound `lease()` `maxChannels - SIP_INBOUND_RESERVED_CHANNELS` tak hi.
3. Redis claim `sip:in:<channelId>` NX (multi-replica safe).

### I4 — Inbound call service (routing brain) · M

New `src/modules/calls/inbound/` (`inbound.service.ts`, `ring.ts`, `missed.ts`):

1. `handleIncoming(channel, did, callerNumber)`:
   - DID normalize (`+91` add, leading `0` hatao) → `PhoneNumberModel.findOne({ number, status: 'active', accountId != null,
purpose: { $in: ['inbound','both'] }, 'inbound.enabled': true })`. Nahi → reject 21 (koi doc nahi, sirf log + metric).
   - Account `voiceLine === 'sip'` + not suspended; nahi → reject 21.
   - Spam guard (Redis counter per account+caller per hour) → busy.
   - Hours (`withinCallHours`) → bahar: `afterHours` action.
   - Wallet (`CallBilling` existing hold — 1 min inbound + AI rate) → low: message + hangup, missed `wallet_low`.
   - Contact find/create (§1.5). DND / opt-out inbound par **lagu nahi** (customer khud call kar raha hai).
   - `CallModel.create({ direction: 'inbound', provider: 'sip', mode, from, to: did, contactId, source, sip })`.
2. Route:
   - **ai:** `CallManager` mein `startInboundCall(input)` — `startOutboundCall` ka session/script part reuse
     (refactor: common `runSession(call, leg)`); variables: contact fields + `call.callerNumber`, `call.dialedNumber`,
     `call.direction = 'inbound'` (flow conditions mein use ho sake).
   - **team:** answer → greeting (TTS) → ringback tone loop (`whatsapp/tones.ts` reuse) → `ring.ts`: eligible users
     (`calls.answer` permission — WhatsApp wala same), `selectRingTargets` (online via realtime presence, available) →
     realtime event `call.incoming` (sip) → browser accept `POST /api/v1/calls/:id/answer` (Redis first-wins claim) →
     `BridgeScript` + existing SIP human media ticket flow. Baaki browsers ko `call.ring_ended`.
   - Timeout → `team_then_ai` mein AI session, warna missed `no_answer` + message "Abhi koi uplabdh nahi, hum aapko call
     back karenge" + hangup.
   - **ai_then_team:** flow/agent transfer step ka target `team` (naya transfer target kind) → wahi ring.
3. End: `onEnded` → outcome, billing capture (inbound rate), `missed` set, bell `call.sip_missed` (ring list / owners),
   `call.completed` webhook (`direction` + `did` fields), realtime calls list update.
4. Caller ring mein hi kaat de → missed `caller_hung_up`.

### I5 — API (dashboard + public) · S

1. `PATCH /api/v1/phone-numbers/:id/inbound` (account owner/admin, permission `account.write` — existing dashboard
   phone-line route ke saath), `GET /api/v1/phone-numbers/mine` (account ke numbers + inbound settings + readiness:
   line connected, program published, koi ring user online).
2. Superadmin: assign / purpose `both` (existing admin routes mein enum).
3. Calls: `GET /calls?direction=inbound&missed=open`, `POST /calls/:id/answer`, `POST /calls/:id/decline`,
   `POST /calls/:id/callback-done`. Callback → existing `POST /calls` (no new route).
4. Public API (OpenAPI + `PUBLIC_DOCS` overlay + guide `calls.md`): calls list `direction` / `missed` filter,
   `GET /resources/phone-line` mein inbound numbers. Webhooks: `call.missed` naya event (sample + `webhooks.md`).
   `docs:audit` 0 problems rehna chahiye.
5. Error codes: `INBOUND_NOT_ENABLED`, `CALL_ALREADY_ANSWERED` (409), `PROGRAM_NOT_PUBLISHED` — `error-codes.ts` + docs.

### I6 — Frontend · M

1. **Settings → Phone numbers** (naya tab, ya existing PhoneLineCard ke neeche): number list; har number ka
   "Incoming calls" editor — on/off, route radio (4), `ProgramPicker` (flow/agent), greeting, ring users + timeout,
   call hours editor (`whatsapp-calling/call-hours` reuse), after-hours action, readiness chips.
2. **Incoming call popup:** WhatsApp live call panel pattern reuse — caller name/number, DID label, Answer / Decline,
   ringing sound; answer ke baad existing SIP human call panel (mute, hangup, DTMF).
3. **Calls page:** direction column/filter (Incoming / Outgoing), "Missed" tab with reason, Call back (CallMethodDialog
   reuse), Mark done; call detail mein DID + route.
4. Admin: Phone numbers page — purpose `both`, account ka inbound on/off column; rate card mein inbound rate.
5. Labels, `schema.gen.ts` (`npm run gen:api`), help text Hinglish/English jaisa baaki app.

### I7 — Reports + analytics · S

- Reports/analytics mein `direction` dimension (calls report, CSV export column `Direction`, `DID`, `Missed reason`).
- Dashboard card: aaj ki incoming / answered / missed.

### I8 — Dev simulator + tests (kam, sirf relevant) · S

1. Dry-run line par `POST /api/v1/dev/sip/inbound` (sirf non-production, dev-jobs jaisa) — fake incoming call, taaki
   UI bina Asterisk ke dekh sakein.
2. Tests (~8 total, ek baar chalane):
   - unit: DID normalize + number lookup reject cases (1 file).
   - unit: leg inbound mode (fake ARI) answer → bridge; reject causes.
   - integration: inbound AI route end-to-end on fake ARI (call doc, billing capture, webhook).
   - integration: team ring first-wins (2 users, ek ko 409) + timeout → missed + bell.
   - integration: after hours / wallet low / spam → reject + missed reason.
   - API: inbound settings PATCH validation + permission; callback-done.
   - frontend: inbound settings form (1), incoming popup answer (1).
   - phase15 route matrix snapshot update (naye routes) — existing test.
3. Lab check: `deploy/asterisk/lab` se softphone → `cav-in` → AI flow bolta hai (manual, evidence note).

### I9 — Docs, release, sign-off · S

- `docs/integrations/sip-inbound.md` (trunk se kya chahiye, DID format, causes), ADR `0051-inbound-sip.md`,
  `docs/conventions/api.md`, `DATA_MAP.md` (caller numbers = personal data, retention same as calls), CHANGELOGs,
  `release-phase-20.md` (migration 0026, env, Asterisk config redeploy, `SIP_INBOUND_ENABLED=true`), BUILD_PLAN_V2 status,
  `PHASE_20_SIGNOFF.md`.
- Lint / typecheck / build / `openapi:check` / `docs:audit` dono repos; full suites ek-ek baar (serial).

---

## 4. Client (Cell24x7) se chahiye — live ke liye 🔴

1. Kaunse **DID numbers** inbound ke liye, aur trunk unhe hamare Asterisk IP par route kare.
2. DID INVITE mein kahan aata hai — Request-URI ya `To` header (format `+91…` / `0…` / 10-digit).
3. Inbound calls ke liye trunk ke source IPs (`SIP_TRUNK_IPS` mein), codec (ulaw/alaw same).
4. Concurrent channel limit inbound + outbound total.
5. Inbound per-minute cost (rate card ke liye).
6. Live test: owner ke phone se DID par 1 call (AI route), 1 call (team route).

Server par: Asterisk config redeploy (dialplan), `SIP_INBOUND_ENABLED=true`, migration 0026.

---

## 5. Out of scope (Phase 20 mein nahi)

Voicemail recording, queue position announce / multiple queues, IVR menu builder (flows ke DTMF steps already hain),
WhatsApp inbound (Phase 12 mein done), call forwarding to mobile without flow, toll-free specific billing,
number purchase/porting.

---

## 6. Order + size

| #   | Task                   | Size | Depends |
| --- | ---------------------- | ---- | ------- |
| I1  | Asterisk + ARI wiring  | S    | —       |
| I2  | Model + migration      | S    | —       |
| I3  | Inbound leg + provider | M    | I1      |
| I4  | Routing service        | M    | I2, I3  |
| I5  | API + public docs      | S    | I4      |
| I6  | Frontend               | M    | I5      |
| I7  | Reports                | S    | I2      |
| I8  | Simulator + tests      | S    | I4–I6   |
| I9  | Docs + sign-off        | S    | all     |

Done when: lab mein softphone call → AI flow jawab de; team route mein browser ring + answer + baat; missed list +
callback; billing + webhook + report sahi; sab checks green. Live = client DID milne ke baad.
