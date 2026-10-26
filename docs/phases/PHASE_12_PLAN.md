# Phase 12 — WhatsApp Calling (Detailed Plan)

**Status:** Draft — 2026-10-24 · **Branch:** `feature/phase-12-whatsapp-calling` (both repos, from `main` = Phase 11 tip: backend `a2b9126 [P11-B3-DONE]`, frontend `4af4fe8 [P11-T11.12]`; the frontend branch is created at T12.9) · **Overview:** [BUILD_PLAN_V2.md](../plans/BUILD_PLAN_V2.md) · **Previous:** [PHASE_11_SIGNOFF.md](PHASE_11_SIGNOFF.md) · **Tracker:** [PHASE_12_TASKS.md](PHASE_12_TASKS.md)

---

## 0. Is phase ka goal

Phase 12 ke end tak:

- Account ke WhatsApp number pe **calling on / off** ho sake (call icon, call hours, callback permission), app se — Meta ka `settings` API.
- Agent chat se customer se **call permission** maange (window khula ho to interactive request, band ho to Phase 11 ka call permission template); customer ka jawab (allow temporary 7 din / permanent / decline) contact pe live dikhe.
- **Business-initiated call** (hum customer ko call karein) do tarah: **agent browser se** (insaan baat kare) aur **AI se** (Phase 6 flow ya Phase 5 agent server pe chale). Customer ke WhatsApp pe call ring kare.
- **User-initiated call** (customer hume call kare): number ki setting ke hisaab se **team ko ring** ho (kisi bhi page pe popup → Accept / Reject), ya **AI uthaye**, ya **AI pehle, phir agent ko transfer**.
- Har call ka **record** (Phase 7 ka Call model — recording, transcript, timeline, outcome), chat me **call bubble** ("Missed call", "Call · 2:14"), aur **charge**: business-initiated per 6-second pulse (Meta rate + markup) + AI cost; user-initiated free (sirf AI cost).
- Meta ke saare **limits / guards** dial se pehle enforce hon (permission, request limits, connected-call limits, unanswered streak, restrictions, call hours, DND, wallet).

Ye Meta App Review ke calling screencast ka base hai (Phase 13: calling on / off in our UI, a business-initiated call accepted on a phone, a user-initiated call received).

1. **Calling settings** — per number: enable / disable, call icon visibility (+ country restriction), call hours (weekly + holidays, timezone), callback permission, voicemail **off** (open question §7 #9); synced with Meta (`GET / POST /{phone-number-id}/settings`, `account_settings_update` webhook); restrictions (low pickup / user feedback) shown.
2. **Call permissions** — per contact × business number: request (interactive or template), reply webhook (`call_permission_reply`), Meta's status API (`GET /{phone-number-id}/call_permissions`) as the source of truth before every dial, limits + counters, unanswered streak, expiry.
3. **Media core (`WhatsAppCallLeg`)** — server-side WebRTC with Meta (ICE full controlling, DTLS client, SRTP, Opus 48 kHz 20 ms, single SSRC, RFC 4733 DTMF), Opus ⇄ PCM16 at the runtime rate, pre-accept / accept / reject / terminate, keep-alive media; **PoC first** (T12.1).
4. **Call control routing** — Meta's `calls` webhooks reach the webhook worker, but the WebRTC peer lives in the process that runs the call → a Redis **call-control bus** (owner registry + pub / sub) so every event reaches the owning process within milliseconds; claim of new inbound calls by one media node.
5. **Outbound calls** — agent (browser) and AI (flow / agent) through the Phase 7 `CallManager` + `CallSession` with provider `whatsapp`; dial guard; ringing / accepted / rejected / no-answer statuses; max duration; wallet holds.
6. **Inbound calls** — routing per number (team / AI / AI → team), ring group of online agents (first to accept wins), call hours, reject / timeout, missed call → callback permission (Meta setting) + missed-call bubble + bell.
7. **Human (agent) calls** — new `AgentLeg` over the existing `/ws/media` socket (browser mic / speaker), bridged to the WhatsApp leg on the server (so recording, transcript events, billing and transfer all stay server-side); mute, hold, keypad, hang up.
8. **AI → agent transfer** — the Phase 7 transfer step / AI tool, re-targeted for WhatsApp: ring online agents, warm hand-off line, bridge, AI leaves.
9. **Billing** — WhatsApp **calling** rate card (per market × tier, INR, superadmin import like Phase 11), price per 6-second pulse + markup, holds + extension + settle (Meta's `duration` from the terminate webhook), AI cost as Phase 7; user-initiated calls free from Meta; permission request messages billed by Phase 11 (per message).
10. **Records + inbox** — Call model fields, call bubbles in the conversation, contact panel calling section (permission state, last calls, "Request permission" / "Call"), Calls list filter + badge, call detail (recording, transcript, Meta timeline).
11. **Realtime + notifications** — incoming call ring to the right users on any page, call state live, permission changes live, bells (missed call, permission granted / declined, calling restricted).
12. **Dev tools** — fake Meta calling: a **fake WhatsApp user** that runs a real WebRTC peer on loopback (plays a WAV, records what it hears, answers / rejects / ignores by number knobs), fake permissions + limits, simulator kinds, seed, `dev:calls-wa`.
13. **UI** — chat **Call** button (states), call bar (ringing, timer, mute, hold, keypad, hang up), incoming call popup (global), "Call with AI" dialog (flow / agent), number settings → Calling section, contact panel, Calls list + detail, superadmin calling rate card + margin.
14. **Ops** — public UDP reachability for media (ICE), port range, firewall, NAT notes, process placement (media nodes), health metrics; real-device checklist (setup guide §15).

**Done when:** Playwright on the fake Meta provider (whose fake user runs a real WebRTC peer) proves the whole flow.

- **Permission:** the agent sends a call permission request from the chat → the fake user allows (temporary) → the chat and contact panel show "Can call until <date>" live; a decline shows "Declined"; the 2nd request on the same day is refused with Meta's limit message.
- **Agent call:** the agent presses **Call** → the fake phone rings → answers → two-way audio (the fake user hears the agent's test tone; the agent hears the fake user's clip) → mute / keypad → hang up → Call record (duration, recording playable, cost = pulses × price + markup) + chat bubble "Call · 0:xx" + wallet line "WhatsApp call · India".
- **AI call:** "Call with AI" (Loan recovery flow) → the fake user presses 1 (RFC 4733 DTMF) → the flow branch runs → outcome Paid, transcript, AI cost + call cost.
- **Inbound:** the fake user calls the business → an online agent sees the ringing popup on another page → Accept → talk → end; an AI-routed number answers with the flow; AI → agent transfer works; nobody answers → missed call bubble + bell + callback permission granted (fake).
- **Guards:** no permission → Call disabled with the reason; wallet empty → refused; DND → refused; outside call hours → inbound goes to the "closed" path; 4 unanswered calls → permission revoked (fake) and shown; a restricted number shows the restriction.
- **Superadmin:** imports the calling rate card; the margin report includes calls.
- **Roles:** viewers see calls read-only; agents call and answer; impersonating superadmins cannot call or answer.

All of the above also proven by integration tests (loopback WebRTC between our leg and the fake user peer), the money-writes test and unit tests. The **real-device checklist** (a real test WABA number with calling enabled, a real phone: permission, BIC agent + AI, UIC, DTMF, latency measurement) is written now and runs in Phase 13 — or earlier on the Meta **calling sandbox** if the client's app gets it (Tech Partners only, §1d).

### Phase 12 mein kya NAHI hoga

| Kaam                                                                                           | Kaunse phase mein                                                                        |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| WhatsApp **video** calling / screen sharing (Meta: in development)                             | Later (when Meta ships it)                                                               |
| **SIP** signalling with Meta (`settings.calling.sip`) / Asterisk / contact-centre PBX          | Phase 18 (media server) — Phase 12 uses Graph API + webhooks signalling only             |
| Meta-side call **recording / transcription** (`recording` object, Meta announcement)           | Not used — we record ourselves from the server media (open question §7 #6)               |
| Meta **voicemail** setting                                                                     | Off (open question §7 #9); our own "missed call" handling instead                        |
| Bulk **WhatsApp call campaigns** (Phase 8 campaigns over WhatsApp calls)                       | Phase 20 (with tier pacing) — Phase 12 builds the provider so campaigns can use it later |
| PSTN on any leg (forbidden by Meta's terms) / transfer to a phone number                       | Never over WhatsApp; AI → agent transfer is **in-app** only                              |
| Call buttons in messages (`voice_call` interactive, template `VOICE_CALL` button) as a feature | Basic send support only (T12.6) — analytics on `cta_payload` / `deeplink_payload` later  |
| Real WABA + real phone manual check                                                            | Phase 13 (checklist written now)                                                         |
| Public API for calls / call webhooks to customers                                              | Phase 15                                                                                 |
| Coexistence numbers (WhatsApp Business app) — Meta: calling needs Cloud API only               | Never on those numbers; UI explains                                                      |

### Conventions to follow

Same as earlier phases: [api.md](../conventions/api.md), [security.md](../conventions/security.md), [secrets.md](../conventions/secrets.md), [data.md](../conventions/data.md), [data-model.md](../conventions/data-model.md) (new §2.10 WhatsApp calling), [websocket.md](../conventions/websocket.md), [audit.md](../conventions/audit.md), [error-codes.md](../conventions/error-codes.md), [definition-of-done.md](../conventions/definition-of-done.md), ADR 0016 (money), ADR 0020 (telephony), ADR 0021 (voice AI), ADR 0022 (SIP media server), ADR 0035 (voice runtime), ADR 0037–0039 (WhatsApp).

- **Money:** integer micros, INR, every wallet write through `src/core/billing/engine.ts` (money-writes test), idempotency key per call.
- **Customer data:** audio, transcripts, DTMF digits, phones, names, **SDP bodies (they contain IP addresses and ICE credentials)** → never in logs, audit meta, notifications, job data or events. SDP is kept only in memory for the call.
- **Determinism:** time through the injected `Clock`; tests use `FakeClock` where audio pacing is involved; the WebRTC loopback tests run on real UDP sockets on `127.0.0.1` (no network outside the machine).
- **Tests:** no external network; Graph against the local stub server; fake Meta in integration / E2E.
- **Meta facts:** re-checked 24 Oct 2026 (§1d); T12.2 builds fixtures from Meta's documented samples.

---

## 1. Locked decisions (proposed — final after the owner answers §7; implementation me dobara debate nahi)

### 1a. Architecture

```
                      ┌────────────── Meta Cloud API ──────────────┐
 Agent / AI request ─► POST /{phone}/calls (connect | pre_accept | accept | reject | terminate)
                      │                                             │
 Meta webhooks ──► POST /webhooks/meta (Phase 9: verify, store once, queue)
    field `calls` (connect + SDP, statuses RINGING / ACCEPTED / REJECTED, terminate)
    field `messages` (interactive call_permission_reply, errors 131026)
    field `account_settings_update` (calling settings changed)
    field `account_update` (calling violations / restrictions / calling tier)
         │
         ▼
 webhook worker ─► call-control bus (Redis):
         ├─ known call  → owner = call:wa:owner:<waCallId> → PUBLISH call:ctl:<node>   (ms)
         └─ new inbound → PUBLISH call:ctl:inbound → one media node claims (SET NX) → routing
         ▼
 media node (API process with the voice runtime, Phase 7):
   CallManager ─► CallSession (Phase 7) ─► leg = WhatsAppCallLeg (werift RTCPeerConnection)
        │                                     │  Opus 48 kHz ⇄ PCM16 24 kHz, RFC 4733 DTMF,
        │                                     │  RTCP keep-alive, pacer (barge-in)
        ├─ script: FlowHost (Phase 6 flow) │ AiVoiceController (Phase 5 agent)   ← AI calls
        └─ bridge: AgentLeg (/ws/media, agent's browser mic / speaker)           ← human calls
   recording (stereo WAV, Phase 7) · transcript events · billing (holds / settle) · Call record
         ▼
 WS events (account + topic) ─► UI: call bar, incoming popup, chat bubble, contact panel
```

- **One media architecture for every WhatsApp call:** the server terminates WebRTC with Meta. Human calls bridge the agent's browser through our existing `/ws/media` socket; the browser never talks to Meta directly. Reasons: recording, transcripts, DTMF, billing, transfer and AI hand-off all need the audio on the server; one code path to test; the agent's IP never reaches Meta. Trade-off: one extra hop (agent ⇄ server) — measured in the PoC (target < 150 ms added one-way).
- **Library:** `werift` (pure TypeScript WebRTC: ICE, DTLS, SRTP, RTP / RTCP) + an Opus codec. Candidates for the codec (decided in the PoC, ADR 0040): `@discordjs/opus` (native, fast), `opusscript` / a WASM Opus build (no native build). Resampling 48 ⇄ 24 kHz in our own PCM code (Phase 7 audio utilities). No `wrtc` / Chromium on the server.
- **Leg rate:** `WhatsAppCallLeg.rate = 24_000` (the runtime's web rate, so flows, the AI providers, recording and TTS caches work unchanged). `CallLeg.rate` type widened only if the PoC needs 48 kHz.
- **Plan B (if the PoC fails on media):** browser-relay (agent browser runs WebRTC with Meta, server relays SDP + gets a forked audio stream) for human calls only, AI calls wait for Phase 18 SIP — decision recorded in ADR 0040 with the PoC numbers.
- **Who pays Meta for calls:** same `metaPayer` as messages (Phase 9): platform credit line → the wallet is charged the Meta call price + markup; customer pays Meta → no Meta charge, only the optional platform fee per call minute (default ₹0, §7 #3). AI cost is always ours (wallet).

### 1b. PoC gate (T12.1 — first task, 2–3 days, the biggest risk)

The PoC runs **before** any other Phase 12 code is written beyond scaffolding:

1. `werift` peer as **ICE full + controlling**, DTLS **client**, ECDSA certificate, `rtcp-mux`, Opus `111/48000/2`, `ptime 20`, one SSRC, `telephone-event/8000`.
2. Loopback test: our peer ⇄ a second `werift` peer playing Meta's role (ICE-lite answer like Meta's sample SDP) → audio both ways, DTMF events, keep-alive during 30 s silence, clean close.
3. Opus encode / decode + 48 ⇄ 24 kHz resampling: CPU per call (target ≤ 3 % of one core per call on the laptop), memory per call (≤ 30 MB), frame timing jitter.
4. Latency budget: decode → runtime → encode added delay (target ≤ 40 ms), bridge to `/ws/media` (target ≤ 150 ms one-way on localhost + LAN).
5. **Real Meta check if any test number is available** (client's test WABA or the calling sandbox): one BIC to a real phone; else marked for Phase 13 and the fake keeps Meta's documented SDP shape.
6. Output: ADR 0040 (library choice, codec, numbers, plan B decision), a `scripts/poc-wa-call.ts` kept as a dev tool.

Exit criteria: two-way audio + DTMF + 30 s silence keep-alive green on loopback 20 / 20 runs; CPU / memory within targets; otherwise plan B.

### 1c. Data model

**`whatsappChannels.calling`** (Phase 9 model, new sub-document):

| Field                   | Type                                                                                                                                               | Notes                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `status`                | `disabled \| enabled \| unavailable`                                                                                                               | `unavailable` = coexistence number / country / messaging limit < 2,000 |
| `unavailableReason`     | `coexistence \| country \| messaging_limit \| not_cloud_api \| null`                                                                               | friendly text in UI                                                    |
| `callIconVisibility`    | `DEFAULT \| DISABLE_ALL`                                                                                                                           |                                                                        |
| `iconCountries`         | `string[]` (ISO-2)                                                                                                                                 | `[]` = no restriction                                                  |
| `callHours`             | `{ enabled, timezone, weekly: [{ day, open, close }], holidays: [{ date, start, end }] }`                                                          | max 2 entries / day, ≤ 20 holidays (Meta)                              |
| `callbackPermission`    | `boolean`                                                                                                                                          | Meta `callback_permission_status`                                      |
| `inbound`               | `{ route: 'team' \| 'ai' \| 'ai_then_team', aiProgram: { kind: 'flow' \| 'agent', id } \| null, ringTimeoutSec, ringUserIds: ObjectId[] \| null }` | ours, not Meta's; `null` ring list = all eligible online users         |
| `restrictions`          | `[{ type, reason, expiresAt }]`                                                                                                                    | from GET settings / `account_update`                                   |
| `syncedAt`, `lastError` | Date / string                                                                                                                                      |                                                                        |

**`whatsappCallPermissions`** (new collection) — one row per `accountId × channelId × contactId`:

| Field                          | Type                                                                            | Notes                                                       |
| ------------------------------ | ------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `status`                       | `none \| requested \| temporary \| permanent \| declined \| expired \| revoked` | ours; Meta's `no_permission / temporary / permanent` mapped |
| `expiresAt`                    | Date \| null                                                                    | temporary: approval + 7 days (Meta's timestamp wins)        |
| `source`                       | `request_reply \| callback \| profile \| unknown`                               | `response_source` / `context.id` (missed-call id)           |
| `lastRequest`                  | `{ messageId, kind: 'interactive' \| 'template', at, by }` \| null              |                                                             |
| `requests`                     | `{ day: [Date], week: [Date] }`                                                 | our counters (Meta's API is authoritative)                  |
| `unansweredStreak`             | number                                                                          | business-initiated calls not picked up in a row             |
| `connectedCallsLast24h`        | number (derived from calls)                                                     | Meta cap 100 / 24 h per number (pair)                       |
| `metaCheckedAt`, `metaActions` | Date, `[{ action, canPerform, limits[] }]`                                      | last `GET call_permissions` answer (cache 60 s)             |
| `history`                      | `[{ status, at, source }]` (≤ 30)                                               | timeline in the contact panel                               |

Indexes: unique `accountId + channelId + contactId`; `accountId + expiresAt` (expiry sweep).

**Call model** (Phase 7 `calls`) additions:

- `provider: 'whatsapp'` (enum + migration), `channel: 'phone' | 'web' | 'whatsapp'` if not derivable.
- `mode: 'ai' | 'human'` (`kind: flow | agent` stays for AI calls; human calls have `kind: null`, `agentUserId`).
- `whatsapp: { channelId, waCallId, direction: 'BUSINESS_INITIATED' | 'USER_INITIATED', conversationId, permissionId, timeline: [{ event, at }], metaStatus, metaDuration, metaStartTime, metaEndTime, metaErrors: [{ code }], ctaPayload, deeplinkPayload, ringUserIds, answeredBy, transferredTo }`.
- `billing.whatsapp: { payer, market, pulses, perMinuteMicros, metaCostMicros, markupMicros, platformFeeMicros, status }`.
- End reasons add: `rejected_by_customer`, `not_answered`, `meta_failed`, `permission_missing`, `calling_restricted`, `no_agent_available`, `outside_call_hours`.
- Index: unique `whatsapp.waCallId` (partial).

**Message** (Phase 10): new type `call` (system-like bubble): `call: { callId, direction, outcome: 'missed' | 'completed' | 'rejected' | 'failed' | 'no_answer', durationSec, mode }`; `interactive.type: 'call_permission_request' | 'call_permission_reply'` rendered (request bubble with state; reply bubble "Allowed for 7 days" / "Allowed always" / "Declined").

**Contact panel** (`InboxContactPanel.callPermission`, today `null`): `{ status, expiresAt, canCall, canRequest, nextRequestAt, reason }`.

**Account settings:** `settings.whatsappCalling: { recordCalls: boolean, recordingNotice: string, transcribeHumanCalls: boolean, maxCallMinutes: number }` (defaults §7).

**Users:** presence for ringing = Phase 2 WS presence + a new "Available for calls" toggle (`users.callAvailability: 'available' | 'busy' | 'offline'`, set from the header; auto `busy` while on a call).

**WhatsApp calling rate card:** new section on `whatsappRateCards` (`kind: 'messaging' | 'calling'`), calling markets carry `perMinuteMicros` + `tiers: [{ fromMinutes, perMinuteMicros }]`; platform settings `whatsappCalling: { markupBps, platformFeePerMinuteMicros, holdMinutes, holdExtendMinutes }`; account override `whatsappCallingBilling: { markupBps, fixedPerMinuteMicros, platformFeePerMinuteMicros }`.

**Migration 0013:** enums, indexes, channel `calling` defaults (`disabled`, `unavailable` for coexistence numbers), placeholder calling rate card (IN + OTHER, values to confirm §7 #2), platform settings defaults, roles sync (new permissions §1n), down migration.

### 1d. Meta facts (re-checked 24 Oct 2026, developers.facebook.com → WhatsApp → Calling)

| Topic                            | Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Call types                       | User-initiated (UIC) and business-initiated (BIC)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Availability                     | UIC wherever Cloud API is available; BIC everywhere **except US, Canada, Egypt, Vietnam, Nigeria** (the **business number's** country counts; the consumer can be anywhere). **India business numbers can place BIC.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Eligibility                      | Cloud API number (**not** the WhatsApp Business app → no coexistence), app subscribed to `calls`, `whatsapp_business_messaging`, **messaging limit ≥ 2,000** (not for sandbox / public test numbers), calling enabled in settings, valid payment method for BIC                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Signalling                       | Graph API + webhooks (default) or SIP (explicit enablement; then the Graph calling endpoints and calling webhooks are **off** — error 131055)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Media                            | WebRTC (ICE, DTLS, SRTP); Meta is **ICE-lite** → we are ICE-full + controlling, regular nomination, DTLS **client**, ECDH(SA) cert; Opus **48 kHz, 20 ms**, **single SSRC**; DTMF telephone-event **8 kHz**; G.711 (PCMA / PCMU) optional since 23 Mar 2026 (transcoding, not used)                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Media timers                     | No business media for ≈ 20 s at start → WhatsApp drops the call; ≈ 30 s without business media later → drop. Keep sending RTP / RTCP during silence and IVR waits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| BIC API                          | `POST /{phone-number-id}/calls { messaging_product, to, action: "connect", session: { sdp_type: "offer", sdp }, biz_opaque_callback_data? (≤ 512) }` → `{ calls: [{ id: "wacid…" }] }`; webhooks: `connect` (SDP **answer**), statuses `RINGING / ACCEPTED / REJECTED`, `terminate`                                                                                                                                                                                                                                                                                                                                                                                                                 |
| UIC API                          | webhook `connect` (SDP **offer**) → `pre_accept` (answer SDP, recommended) → `accept` (same SDP; mismatch fails the call) or `reject`; must answer within **≈ 30–60 s** else "Not answered" + terminate; send media only after the accept 200 OK                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Terminate                        | `POST …/calls { call_id, action: "terminate" }` — send it even if RTCP BYE is seen (billing accuracy); webhook `terminate`: `status COMPLETED / FAILED`, `start_time`, `end_time`, `duration` only if picked up, `errors[]`, `biz_opaque_callback_data`, `cta_payload`, `deeplink_payload`                                                                                                                                                                                                                                                                                                                                                                                                          |
| Duration / concurrency           | No call duration limit; concurrent calls per number: **1,000** enforced (docs also mention 5,000 — treat 1,000 as the limit); new-call initiation rate limit **10,000 / 24 h per number**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Permission request               | Interactive `call_permission_request` (only inside the customer service window; body text only) or a template with a `call_permission_request` component (outside the window) — **1 request / 24 h and 2 / 7 days per business-user pair**; reset by any connected call                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Permission                       | Temporary **7 days** (168 h) from approval, or **permanent**; also granted automatically when the user calls (callback setting) or from the business profile; no webhook when a temporary permission expires                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Calls after permission           | **100 connected calls / 24 h** per business-user pair (raised from 10 on 19 Dec 2025)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Unanswered                       | 2 consecutive unanswered BIC → WhatsApp asks the user to reconsider; **4 → permission revoked**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Status API                       | `GET /{phone-number-id}/call_permissions?user_wa_id=…` → `permission.status no_permission / temporary / permanent`, `expiration_time`, `actions[]` (`send_call_permission_request`, `start_call`: `can_perform_action`, `limits[]` with `time_period`, `max_allowed`, `current_usage`, `limit_expiration_time`); rate limit **100 / s** (613)                                                                                                                                                                                                                                                                                                                                                       |
| Reply webhook                    | `messages[].interactive.type = call_permission_reply` → `response accept / reject`, `is_permanent`, `expiration_timestamp`, `response_source user_action / automatic`; `context.id` = request message id or the missed-call id                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Settings                         | `POST /{phone-number-id}/settings { calling: { status, call_icon_visibility, call_icons.restrict_to_user_countries, call_hours { status, timezone_id, weekly_operating_hours[{ day_of_week, open_time "HHMM", close_time }], holiday_schedule[≤ 20] }, callback_permission_status, sip, audio, voicemail } }`; GET returns `restrictions.restrictions_list[]`; webhook `account_settings_update`                                                                                                                                                                                                                                                                                                    |
| Restrictions                     | low pickup rate (call button hidden), user feedback (7-day pause of BIC or UIC) via `account_update` `ACCOUNT_VIOLATION / ACCOUNT_RESTRICTION`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Pricing                          | **UIC free**; BIC charged by **6-second pulses** (partial pulse = full), per called number's country × monthly volume tier (minutes, calendar month, same accrual as messaging; a call crossing a tier is priced at the higher tier's lower rate); INR rate card exists (effective 1 Apr 2026, updates 1 Jul / 1 Oct 2026); permission request messages billed as messages; `account_update VOLUME_BASED_PRICING_TIER_UPDATE` for calling tiers                                                                                                                                                                                                                                                     |
| Recording / transcription (Meta) | Optional Meta-side features with a spoken announcement; currently free, pricing planned — **not used** (§1j)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Call buttons / deep links        | Interactive `voice_call` (display_text ≤ 20, `ttl_minutes` 1–43,200, `payload` ≤ 512); template `voice_call` button; `wa.me/call/<number>?biz_payload=` (not on desktop); payloads come back as `cta_payload` / `deeplink_payload`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Error codes                      | 138000 not enabled · 138001 receiver can't take calls · 138002 concurrency (1,000) · 138003 duplicate active call · 138004 connection error · 138005 initiation rate limit · 138006 no permission · 138007 connect timeout · 138009 permission request limit · 138012 24 h connected-call cap (next time in `error_data`) · 138013 BIC unavailable · 138014 low quality restriction · 138015 can't enable (messaging limit) · 138017 permanent permission exists · 138018 prerequisites (webhook / SIP) · 138019–138023 client / relay / media failures (terminate webhook) · 131009 · 131026 old client · 131030 test allowlist · 131044 payment method · 131055 SIP-enabled · 613 status API rate |
| Sandbox                          | Calling sandbox account (Tech Partners only): 25 permission requests / day, 100 / week, unanswered nudge 5 / revoke 10                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| App Review                       | `whatsapp_business_management` (show enabling / disabling Calling **features** in our UI, not only the icon) + `whatsapp_business_messaging` (a BIC accepted on a phone, or a UIC received)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Identity                         | `from_user_id` / `to_user_id` = business-scoped user ids (BSUID); `from` may be missing when the user has a username → contact match by BSUID too (Phase 10 stores `waId`; add `bsuid`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

T12.2 re-reads every page on the day it starts and records differences in the plan changelog.

### 1e. Permission lifecycle + dial guard

Request (agent clicks **Request call permission** in the chat or contact panel):

1. Channel calling `enabled`, not restricted for BIC, business number country allowed.
2. Contact not DND (Phase 3), not blocked (Phase 10), not opted out (Phase 10 STOP → no requests; open question §7 #5).
3. No `permanent` / valid `temporary` permission already (else "Already allowed").
4. Our counters + Meta's `actions.send_call_permission_request.can_perform_action` (status API, cached 60 s) → else "You can ask again on <date>" (Meta's `limit_expiration_time`).
5. Window open → interactive `call_permission_request` (body text from settings, editable, Hinglish default); window closed → the Phase 11 approved call permission template of that WABA (missing → "Create the call permission template first" link). Both go through the Phase 11 send pipeline (priced + held like any message).
6. Row → `requested`, `lastRequest`, counters; chat shows the request bubble with its state.

Reply (`call_permission_reply`): accept → `temporary` (`expiresAt = expiration_timestamp`) or `permanent`; reject → `declined`; `response_source: automatic` + `context.id` = missed-call id → `callback`. WS + bell to the requester; audit (no phone). Expiry sweep job marks `expired` (Meta sends no webhook).

**Dial guard** (every outbound call, agent or AI, in this order; first failure wins, each with an error code + plain text):

1. Feature flags: `WHATSAPP_ENABLED`, calling enabled on the number, number connected, not coexistence, BIC country allowed, no active BIC restriction.
2. Account active, not impersonating, permission `calls.trigger` (+ `calls.whatsapp` §1n).
3. Contact: exists, not deleted, not DND, not blocked; account calling window (Phase 8 `callingWindow`, TRAI 09:00–21:00 for AI calls; agent calls: owner decision §7 #7).
4. Permission: our row valid **and** Meta status API `start_call.can_perform_action` (fresh ≤ 60 s; on API error → refuse with "Couldn't check permission").
5. Limits: our connected-call count (100 / 24 h pair), no live call with this contact (Meta 138003), account `maxConcurrentCalls` (Phase 8), Meta number concurrency (1,000), initiation rate (10,000 / 24 h).
6. Wallet: hold for `holdMinutes` of call price + AI estimate (AI calls) — refused → `WALLET_INSUFFICIENT_BALANCE` / `WALLET_BUDGET_EXCEEDED`.
7. AI calls: program runnable (Phase 6 / 5 checks).

Unanswered streak: BIC ends without `ACCEPTED` → `unansweredStreak += 1`; at 2 → UI warning "The customer may stop calls"; at 4 → mark `revoked` (Meta revokes) + bell; any connected call → 0.

### 1f. Business-initiated call flow (agent or AI)

1. API `POST /api/v1/whatsapp/calls { channelId, contactId, mode: 'human' | 'ai', program? }` → dial guard → Call row `queued` (provider `whatsapp`, `whatsapp.direction BUSINESS_INITIATED`) → hold.
2. Media node creates the `WhatsAppCallLeg` (offer SDP: ICE full, our host + srflx candidates, DTLS fingerprint) → Graph `connect` with `biz_opaque_callback_data = <our callId>` → `waCallId` stored → owner registry `call:wa:owner:<waCallId> = <node>` (TTL, refreshed).
3. Webhook `connect` (answer SDP) → bus → leg applies the answer → ICE checks (we control) → DTLS (we are client) → SRTP up → leg starts sending comfort silence / ringback-free keep-alive frames (never > 20 s without media).
4. Status `RINGING` → Call `ringing` (UI ring tone in the agent's call bar). `REJECTED` → end `rejected_by_customer`. No `ACCEPTED` within `ringTimeoutSec` (default 45 s, §7 #8) → we `terminate` → `not_answered`, streak + 1.
5. `ACCEPTED` → Call `in_progress`, `answeredAt`; human: bridge `AgentLeg` ⇄ WhatsApp leg; AI: Phase 7 session starts (recording notice → script).
6. End: customer hangs up (webhook `terminate`) / agent hangs up / AI ends / max duration / wallet empty → we send `terminate` (always) → the leg closes → settle uses Meta's `duration` (terminate webhook; fallback our measured talk time if the webhook is late > 2 min, reconciled later) → Call final, chat bubble, WS, bell (missed), audit.

### 1g. User-initiated call flow + routing

1. Webhook `connect` (offer SDP, `direction USER_INITIATED`, `from`, `from_user_id`, `cta_payload` / `deeplink_payload`) → `PUBLISH call:ctl:inbound` → first media node with capacity `SET NX call:wa:claim:<waCallId>` → owner.
2. Match / create the contact (Phase 10 rules: phone or BSUID), conversation (Phase 10; a call does not open the 24-hour messaging window unless Meta says so — verified in T12.2), Call row `ringing` (direction inbound).
3. Pre-checks: account active / not suspended, number calling enabled, call hours (if Meta's `call_hours` let it through but our inbound route says closed → reject + bubble), wallet for AI routes (AI cost) → else reject with "We can't take calls right now" (no AI) and a missed-call bubble.
4. `pre_accept` at once with our answer SDP (media path warms up).
5. Route:
   - `team` → ring every eligible user (`calls.answer`, `callAvailability = available`, online WS, in the account, ring list if set) with the WS event `whatsapp.call.incoming` (popup on any page, ring sound, browser notification if allowed); first `POST /calls/:id/answer` wins (Redis `SET NX`), others get `whatsapp.call.taken`; the winner's browser opens `/ws/media` → `accept` (same SDP) → bridge.
   - `ai` → `accept` → Phase 7 session with the configured flow / agent.
   - `ai_then_team` → AI answers; its transfer step / tool rings the team (same ring logic) with a hold message; the first agent takes over; AI leaves the bridge.
6. Nobody answers within `ringTimeoutSec` (default 30 s, must stay < Meta's 30–60 s) → `reject` → `missed` bubble + bell to the ring list; Meta's callback setting may grant a temporary permission (reply webhook `source: automatic`).
7. End as §1f step 6 (UIC is free at Meta; only AI cost + optional platform fee §7 #3).

### 1h. Media details (`WhatsAppCallLeg`)

- Implements `CallLeg` (ADR 0020): `rate 24000`, `onAudio` (decoded Opus → 24 kHz frames), `play` (pacer → 24 kHz → 48 kHz → Opus → RTP, 20 ms), `clearAudio` (barge-in), `onDtmf` (RFC 4733 end events, de-duplicated by timestamp), `onStatus`, `hangup(cause)` (Graph terminate + close), `transfer` → in-app agent transfer (§1g), `notify` no-op.
- Jitter buffer 60 ms, PLC via Opus FEC (`useinbandfec=1`), packet-loss stats (RTCP RR) stored on the call.
- Keep-alive: send encoded silence (or Opus DTX-off frames) whenever the runtime is not speaking; RTCP SR every 5 s.
- First media: start sending within 1 s of DTLS completion (Meta drops at ≈ 20 s).
- Network: UDP host candidates on `WA_MEDIA_PUBLIC_IP` (env) + STUN srflx (`WA_STUN_URLS`, default Google STUN); port range `WA_MEDIA_PORT_MIN`–`MAX` (default 40000–40999, one port per call with `rtcp-mux` + bundle). No TURN needed (Meta has public IPs and is ICE-lite; we are controlling) — TURN env reserved.
- Secrets: DTLS keys generated per process at start; ICE ufrag / pwd per call; SDP never logged (only lengths / hashes in debug).
- Metrics: setup time (connect → media), RTT, loss, jitter, CPU per call → `GET /admin/system/calls` (superadmin) + logs (numbers only).

### 1i. Billing

- **Price per BIC:** market = called number (Phase 11 `marketFor`); Meta per-minute rate from the **calling** rate card in force at call start. Meta's volume tiers count the monthly minutes of the whole WABA / business, so the selling price uses the market's **base tier** (cheaper higher tiers become our margin, visible in the margin report, §7 #2) → per pulse = per-minute ÷ 10 → **selling price per pulse = (Meta per pulse) × (1 + markup) + platform fee per pulse**, rounded **up to the paisa per call total** (not per pulse).
- **Hold:** at dial = `holdMinutes` (default 5) × selling per-minute + AI estimate (AI calls, Phase 7 `holdEstimate`); extension every 5 s by the Phase 7 session (`holdExtendMinutes`) — wallet empty mid-call → polite end (AI) / warning + end after 30 s (human).
- **Settle:** `pulses = ceil(duration / 6)` with Meta's `duration` (seconds) from the terminate webhook; `metaCostMicros = pulses × Meta per pulse`; ledger `whatsapp_call_charge` (new type) + breakdown `{ waMarket, pulses, perMinuteMicros, metaCostMicros, markupMicros, platformFeeMicros, durationSec, waConversationId }` (Meta cost / markup / fee superadmin-only like Phase 11); AI usage settles as Phase 7 (`ai_charge`).
- **UIC:** Meta free → only AI cost (+ platform fee if configured).
- **Not picked up / rejected / failed BIC:** no `duration` → 0 pulses → hold released.
- **Customer pays Meta:** no Meta charge; platform fee only.
- **Reconciliation:** Phase 11 `pricing_analytics` job extended with calling analytics if Meta exposes them (T12.2 checks; else margin from list price).
- **Money-writes test** extended (call charges only through the engine).

### 1j. Recording, transcript, retention

- **Recording:** our server records every WhatsApp call (stereo WAV 8 kHz like Phase 7 — customer left, business right) when `settings.whatsappCalling.recordCalls` (default on, §7 #6). Before recording: the account's recording notice is played (AI calls: Phase 7 notice; human calls: a short TTS clip "Ye call record ho rahi hai…" played to both sides at answer). Retention = Phase 7 (`CALL_RETENTION_DAYS`).
- **Transcript:** AI calls as Phase 7 (STT + bot text). Human calls: off by default (STT cost, §7 #10); when on, both channels transcribed after the call (batch STT), billed as AI usage.
- **Meta's own recording / transcription:** not used (announcement in Meta's voice, 7-day retention, future pricing, duplicate cost).

### 1k. Webhooks consumed

| Field / event                                                 | Handling                                                                                 |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `calls` `connect` (BIC: answer SDP; UIC: offer SDP)           | bus → owner (BIC) / claim (UIC); processed **before** the normal queue order (fast path) |
| `calls` statuses `RINGING / ACCEPTED / REJECTED`              | Call status, timeline, UI                                                                |
| `calls` `terminate`                                           | end + settle (idempotent by `waCallId`), errors mapped (§1d), payloads stored            |
| `messages` interactive `call_permission_reply`                | permission row + reply bubble + WS + bell                                                |
| `messages` errors 131026 (old client) on a request            | request bubble failed "Customer's WhatsApp is too old"                                   |
| `account_settings_update` (new subscription)                  | channel `calling` refresh (GET settings)                                                 |
| `account_update` calling violations / restrictions            | channel restrictions + bell (owners / admins) + audit                                    |
| `account_update` `VOLUME_BASED_PRICING_TIER_UPDATE` (calling) | stored on the channel (Phase 11 field)                                                   |

Phase 9 deferred `calls` events stored before Phase 12 are **not** replayed (calls are real time) — marked `ignored_stale` by the backfill.

Ordering / idempotency: event key = `waCallId + event + status + timestamp`; a `terminate` before `connect` (fast hang-up) ends the call cleanly; duplicate `connect` → ignored.

### 1l. Realtime events (account level unless noted; never SDP, phones or digits)

- `whatsapp.call.incoming` → eligible users: `{ callId, conversationId, contactId, channelId, ringUntil }` — ids only, like the inbox events; the popup reads the contact name and number label through the API (`calls.read`).
- `whatsapp.call.taken` / `whatsapp.call.ended_ringing` → the other ringing users.
- `call.status` / `call.ended` (Phase 7 events) reused with `provider: 'whatsapp'`.
- `whatsapp.call_permission.updated` `{ contactId, channelId, status, expiresAt }`.
- `whatsapp.channel.updated` (Phase 9) carries `calling.status` / restrictions changes.
- Topic `call:<id>` (Phase 7) for the live call bar (mute state, hold, timer source).

### 1m. Security & privacy

- SDP / ICE credentials / DTLS fingerprints: memory only, never logged, never in job data or WS.
- Audio: only in the media node; recordings via signed links (Phase 7); agent media socket tickets bound to user + account + call (Phase 7).
- Inbound ring events carry ids; the popup reads the contact through the API with `inbox.read` / `calls.read`.
- Media ports: only the configured range; ICE only to Meta's candidates (we ignore any non-Meta candidate in the answer — allowlist by `META_MEDIA_IP_RANGES` optional env, else accept as given + log count).
- Impersonation: read only (no calls, no answering, no permission requests).
- Rate limits: `rl:wa-call:` 10 / min / user, `rl:wa-call-perm:` 20 / h / user.
- Compliance: recording notice; DND and opt-out honoured; TRAI calling window for AI calls; call permission language plain.

### 1n. Permissions & roles

| Permission                                                  | Owner | Admin | Manager | Agent | Viewer |
| ----------------------------------------------------------- | ----- | ----- | ------- | ----- | ------ |
| `calls.read` (existing)                                     | ✓     | ✓     | ✓       | ✓     | ✓      |
| `calls.trigger` (existing — place calls)                    | ✓     | ✓     | ✓       | ✓     | —      |
| `calls.answer` (new — answer inbound)                       | ✓     | ✓     | ✓       | ✓     | —      |
| `whatsapp.calling.manage` (new — calling settings, routing) | ✓     | ✓     | —       | —     | —      |
| `inbox.reply` (existing — send permission requests)         | ✓     | ✓     | ✓       | ✓     | —      |

### 1o. API surface (all `/api/v1`)

- `GET / PATCH /whatsapp/channels/:id/calling` — settings (Meta sync on PATCH; 409 when unavailable; 502 Meta errors mapped).
- `POST /whatsapp/channels/:id/calling/sync` — re-read Meta settings + restrictions.
- `GET /whatsapp/call-permissions?contactId=&channelId=` — row + fresh Meta status (`refresh=true`).
- `POST /whatsapp/call-permissions/request { channelId, contactId, body? }` — sends interactive / template.
- `POST /whatsapp/calls { channelId, contactId, mode, program? }` → `201 { call }` (dial guard errors 409 / 422 with codes).
- `POST /whatsapp/calls/:id/answer` (ringing inbound; first wins) · `POST /whatsapp/calls/:id/decline` (this user stops ringing) · `POST /calls/:id/hangup` (Phase 7, now cross-process via the bus) · `POST /whatsapp/calls/:id/hold { on }` · `POST /whatsapp/calls/:id/transfer { userId? }`.
- Media: `POST /calls/:id/media-ticket` (Phase 7) for the agent leg.
- `GET /calls?provider=whatsapp&direction=` (Phase 7 list filters), `GET /calls/:id` (+ `whatsapp` block, timeline).
- `PATCH /users/me/call-availability { status }`.
- Superadmin: `GET / POST /admin/whatsapp-rates?kind=calling` (+ import CSV), `PATCH /admin/whatsapp-billing` (calling fields), account override (calling), margin report rows `kind: 'call'`.
- Dev: `POST /dev/meta/webhooks` kinds (§1p), `POST /dev/meta/calls/user-call { channelId, from }` (fake user calls the business), `GET /dev/meta/calls` (what the fake heard: tone detected, DTMF sent, duration).
- Error codes (new): `WHATSAPP_CALLING_DISABLED`, `WHATSAPP_CALLING_UNAVAILABLE`, `WHATSAPP_CALLING_RESTRICTED`, `WHATSAPP_CALL_PERMISSION_MISSING`, `WHATSAPP_CALL_PERMISSION_LIMIT`, `WHATSAPP_CALL_PERMISSION_EXISTS`, `WHATSAPP_CALL_LIMIT_REACHED`, `WHATSAPP_CALL_ACTIVE`, `WHATSAPP_CALL_TAKEN`, `WHATSAPP_CALL_NOT_RINGING`, `WHATSAPP_CALL_FAILED`, `WHATSAPP_CALL_PERMISSION_TEMPLATE_MISSING`, `CALL_AGENT_UNAVAILABLE`.

### 1p. Fake Meta + simulator

- **Fake WhatsApp user** (`FakeWaUser`, dev / test only): a `werift` peer on `127.0.0.1` that plays Meta's role (ICE-lite answer / offer like Meta's samples), plays a WAV clip (`docs/samples/audio/customer-tone.wav`, generated by `npm run fixtures:audio`), detects tones / records what it hears (for "the customer heard the agent"), sends RFC 4733 DTMF on command, hangs up on command or after a knob time.
- **Fake Graph calling endpoints:** `connect` (→ `connect` webhook with answer SDP after 100 ms, statuses RINGING after 200 ms, ACCEPTED / REJECTED by knob), `pre_accept` / `accept` / `reject` / `terminate` (→ terminate webhook with `duration` = measured connected seconds), settings GET / POST (stored in Redis, `account_settings_update` webhook), `call_permissions` GET (from fake state + limits), permission request sends (→ reply webhook by knob).
- **Number knobs (customer number ending):** `00020` answers after 2 s · `00021` rejects · `00022` never answers (ring timeout) · `00023` allows permission temporary · `00024` allows permanent · `00025` declines permission · `00026` old client (131026) · `00027` hangs up after 5 s · `00028` presses 1 after the greeting · `00029` connection fails (138004) · `00030` no permission at Meta (138006) even if our row says yes.
- **Simulator kinds** (dev UI + E2E): `user_call` (the fake user calls the business), `user_hangup`, `user_dtmf`, `permission_reply_accept` / `_permanent` / `_reject`, `permission_expire`, `calling_restricted`, `calling_unrestricted`, `settings_changed`, `call_tier_update`, `run_permission_sweep`.
- Seed: Demo Finance number calling enabled, two contacts with permissions (temporary + permanent), three past calls (agent, AI, missed inbound) with recordings (tones).

### 1q. Frontend

- **Chat header Call button** (states from the contact panel): "Request permission" (no permission, can request) · "Requested · waiting" · "Call" (dropdown: Call yourself / Call with AI) · "Can't call" + reason tooltip (declined, limit until <date>, calling off, coexistence, restricted, DND).
- **Call bar** (sticky, any page while a call is live): contact name, state (Calling… / Ringing / 02:14), mute, hold, keypad (DTMF), hang up, recording dot, network quality; AI calls: "AI is talking" + Take over (Phase 7 barge-in for supervisors — §7 #11).
- **Incoming popup** (global): name / number label, number (channel), Accept / Decline, ring sound (respects a mute setting), browser notification (permission asked once), taken by someone else → closes with "Taken by <name>".
- **"Call with AI" dialog**: pick flow / agent (runnable only), shows estimated cost per minute (call + AI).
- **Contact panel**: Calling section (permission status + expiry + history, Request permission, Call, last 5 WhatsApp calls).
- **Chat bubbles**: permission request (state), reply, call bubbles (missed / completed / rejected with duration, link to the call).
- **WhatsApp → Numbers → number → Calling** (new tab / drawer section): enable / disable, call icon (+ countries), call hours editor (week grid + holidays + timezone), callback permission, inbound routing (team / AI / AI → team, program, ring timeout, ring list), recording notice, restrictions banner, "Unavailable on WhatsApp Business app numbers" / messaging-limit explanation.
- **Header**: availability toggle (Available / Busy / Offline for calls).
- **Calls list / detail** (Phase 7): WhatsApp filter + badge, direction, mode, answered by, Meta timeline, recording, transcript.
- **Wallet**: "WhatsApp call · India · 2:14" ledger lines, calling prices table; superadmin calling rate card + margin rows.
- Microphone: one permission prompt; device picker (Phase 7 tester component reused); echo cancellation on.

### 1r. Testing strategy

- **Unit:** permission state machine, dial guard order (every rule), pulse math + rounding, market lookup, settings validation (call hours rules = Meta's), error mapping, event ordering, ring "first wins".
- **Media (loopback, real UDP on 127.0.0.1):** our leg ⇄ `FakeWaUser` — audio both ways (tone detection), DTMF, 30 s silence keep-alive, barge-in (`clearAudio`), hangup both sides, packet loss injection (10 %) still intelligible (tone detector), 20 parallel calls CPU sanity.
- **Integration:** BIC agent / AI / rejected / not answered / failed; UIC team / AI / AI → team / missed / outside hours / wallet; permission request (interactive / template) + reply; restrictions; cross-process control via two `CallManager` instances on one Redis; billing (holds, settle with Meta duration, late terminate, money-writes).
- **Hardening:** 50 concurrent WhatsApp calls (loopback) with recording; 1,000 permission replies; webhook storm (10 events / call × 200 calls) in mixed order.
- **Frontend:** call button states, call bar, popup race (taken), settings editor (Meta's call hours rules), contact panel, bubbles, dialogs, permissions.
- **E2E (Playwright, fake Meta with the loopback user):** 4 specs (`calls-wa-done-when`, `calls-wa-inbound`, `calls-wa-guards-billing`, `calls-wa-roles-settings`), the whole suite twice, the 2nd with backend logs + grep (no SDP, `a=fingerprint`, `ice-pwd`, phones, names, digits).
- Chromium fake mic + fake speaker for the agent leg (Phase 7 setup).

### 1s. Ops / deployment notes (for Phase 13 / 17)

- Media node needs **public UDP** in `WA_MEDIA_PORT_MIN–MAX` (default 1,000 ports) and a public IP (`WA_MEDIA_PUBLIC_IP`); behind NAT: 1:1 NAT or port forwarding; firewall rules; no UDP → calls fail with 138004 / 138007.
- Calls are sticky to a process (in-memory peer). Rolling deploys drain media nodes (no new calls, wait ≤ max duration) — `SIGTERM` handling extends Phase 7 polite ends.
- Bandwidth ≈ 60 kbps per call (Opus + overhead) each way to Meta + the agent socket.
- Health: `/health` adds `media: { activeCalls, portsFree }`.

### 1t. Contract for later phases

- Phase 13: real-device checklist §15 (permission, BIC agent + AI, UIC, DTMF, measured latency, recording), App Review calling screencast.
- Phase 15: public API `POST /calls` with `provider: whatsapp`, call webhooks.
- Phase 18: SIP signalling + media server; `WhatsAppCallLeg` stays for Graph-signalled numbers.
- Phase 20: WhatsApp call campaigns reuse `POST /whatsapp/calls` + dial guard + limits.

---

## 2. Tasks ka overview

| #           | Task                                                                                                                                                         | Repo | Size | Depends      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ---- | ------------ |
| T12.1       | **PoC:** werift + Opus + resampling + loopback with a Meta-like peer, DTMF, keep-alive, numbers; ADR 0040; plan B decision                                   | BE   | M    | —            |
| T12.2       | Models, migration 0013, limits, env, catalogue (codes, audit, notifications, WS, permissions, jobs); Meta facts re-check                                     | BE   | M    | T12.1        |
| T12.3       | Meta core: Graph calling endpoints, settings, call permissions API, schemas + fixtures, error mapping; fake Meta calling + `FakeWaUser`                      | BE   | L    | T12.2        |
| T12.4       | `WhatsAppCallLeg` (media, codec, pacer, DTMF, keep-alive, metrics) + call-control bus (owner registry, pub / sub, inbound claim)                             | BE   | L    | T12.1, T12.3 |
| P12-B1-DONE | checkpoint                                                                                                                                                   |      |      |              |
| T12.5       | Calling settings + permissions service (request, reply, status API, counters, sweep, restrictions) + webhooks                                                | BE   | M    | T12.3        |
| T12.6       | Outbound calls: dial guard, CallManager provider `whatsapp`, agent leg bridge, AI calls, statuses, end / settle, call bubbles; call buttons send             | BE   | L    | T12.4, T12.5 |
| T12.7       | Inbound calls: claim, routing (team ring / AI / AI → team), answer race, missed calls, call hours, transfer                                                  | BE   | L    | T12.6        |
| T12.8       | Billing (calling rate card, pulses, holds, settle, margin), API + OpenAPI, simulator, seed, `dev:calls-wa`, hardening, ADR 0041, docs, real-device checklist | BE   | M    | T12.6, T12.7 |
| P12-B2-DONE | checkpoint                                                                                                                                                   |      |      |              |
| T12.9       | FE foundation + number Calling settings + contact panel + permission bubbles                                                                                 | FE   | M    | T12.8        |
| T12.10      | FE call experience: Call button, call bar, agent media, incoming popup, Call with AI, availability, call bubbles                                             | FE   | L    | T12.9        |
| T12.11      | FE Calls list / detail + wallet + superadmin calling rates + notifications + dashboard; Playwright E2E (4 specs, twice)                                      | FE   | L    | T12.10       |
| T12.12      | Gap audit, security / money checklist, docs, sign-off                                                                                                        | both | M    | all          |
| P12-B3-DONE | checkpoint                                                                                                                                                   |      |      |              |

---

## 3. Tasks — step by step

### T12.1 — PoC (first, gate for the rest)

- [ ] Add `werift` (exact version pinned) + the Opus codec candidate(s) behind a small `src/core/telephony/whatsapp/codec.ts` interface (encode / decode, 48 kHz mono, 20 ms).
- [ ] `scripts/poc-wa-call.ts`: two peers in one process — ours (ICE full controlling, DTLS client, ECDSA, `rtcp-mux`, Opus 111, telephone-event 126 / 8000, single SSRC) and a Meta-like ICE-lite peer built from Meta's sample SDP; exchange SDP in memory; send a 1 kHz tone one way and a 440 Hz tone the other; detect both; send DTMF 1-2-3; 30 s silence with keep-alive; terminate.
- [ ] Measure: setup time, CPU and memory per call (1, 10, 20 parallel), added latency per direction, jitter; resampling quality (tone frequency error < 1 %).
- [ ] Try a real Meta number if available (test WABA / sandbox) — else write the exact steps for Phase 13.
- [ ] ADR 0040 (WhatsApp call media): library, codec, numbers, keep-alive, NAT / ports, plan B condition; plan changelog entry with the measured numbers.
- [ ] Exit: 20 / 20 loopback runs green; targets in §1b met — else switch to plan B (re-plan T12.4 / T12.6 / T12.10 before continuing).

### T12.2 — Models, migration 0013, catalogue

- [ ] Re-check every Meta calling page (§1d) and note differences in the changelog.
- [ ] Models: channel `calling`, `whatsappCallPermissions`, Call additions, Message type `call` + interactive kinds, contact `whatsapp.bsuid`, user `callAvailability`, account `settings.whatsappCalling`, calling rate card kind + platform / account billing fields.
- [ ] Migration 0013 (enums, indexes, defaults, `unavailable` for coexistence numbers, placeholder calling rate card, roles sync, down).
- [ ] Limits `WHATSAPP_CALL_LIMITS` (Meta numbers §1d, ring timeouts, permission cache 60 s, hold minutes, keep-alive, ports) + env (`WA_MEDIA_PUBLIC_IP`, `WA_MEDIA_PORT_MIN/MAX`, `WA_STUN_URLS`, `WA_MEDIA_ENABLED`, `FAKE_META_CALL_DELAYS_MS`) with prod rules + docs.
- [ ] Catalogue: error codes (§1o), audit (`whatsapp.calling_settings_updated`, `whatsapp.call_permission_requested`, `.granted`, `.declined`, `.revoked`, `call.whatsapp_started`, `call.whatsapp_answered`, `call.whatsapp_transferred`, `channel.calling_restricted`), notifications (`call.whatsapp_missed`, `whatsapp.call_permission_granted`, `.declined`, `whatsapp.calling_restricted`, `wallet.whatsapp_call_low`), WS events (§1l), permissions (§1n), jobs (`whatsapp.call_permission_sweep` hourly, `whatsapp.calling_settings_sync` daily, `billing.whatsapp_call_reconcile` if analytics exist).
- [ ] Tests: models, migration up / down, catalogue counts, roles snapshot.

### T12.3 — Meta core

- [ ] Graph: `startCall`, `preAcceptCall`, `acceptCall`, `rejectCall`, `terminateCall`, `getPhoneSettings`, `updateCallingSettings`, `getCallPermissions`, send interactive `call_permission_request` / `voice_call`, template call permission send (Phase 11 payload builder).
- [ ] Schemas (zod) for `calls` (connect / statuses / terminate incl. `errors`, payloads, BSUIDs), `call_permission_reply`, `account_settings_update`, calling `account_update` events; fixtures from Meta's samples (+ README of sources).
- [ ] Error mapping (§1d codes → our codes + plain texts; scrubbed).
- [ ] Subscribe `account_settings_update` (WEBHOOK_FIELDS + setup guide); Phase 9 deferred `calls` → ignored by backfill.
- [ ] Fake Meta calling (§1p) + `FakeWaUser` (werift loopback) + knobs + settings / permissions state in Redis.
- [ ] Tests: stub-server tests per Graph call (paths, bodies, errors, retries, no SDP in logs), fake behaviour per knob, schemas.

### T12.4 — `WhatsAppCallLeg` + call-control bus

- [ ] Leg (§1h) implementing `CallLeg`; codec + resampler; pacer integration; DTMF; keep-alive; metrics; close paths (each `HangupCause`).
- [ ] Call-control bus: `call:wa:owner:<waCallId>` (TTL refresh by the owning process), `PUBLISH call:ctl:<node>` / `call:ctl:inbound`, claim (`SET NX` + capacity check), cross-process hangup for **all** calls (closes the Phase 7 "409 from another server" gap).
- [ ] Webhook fast path: `calls` events published to the bus by the webhook receiver right after storing (still stored + processed by the worker for the record); duplicate-safe.
- [ ] Tests: loopback media suite (§1r), bus routing with two processes (two `CallManager` instances), owner loss (process gone → call ended `server_shutdown`, Meta terminate sent by the survivor).

### P12-B1-DONE — checkpoint

- [ ] Full backend verify; `npm run dev:calls-wa -- --poc` (fake user call on loopback: tone both ways + DTMF) on the dev box; plan changelog.

### T12.5 — Calling settings + permissions

- [ ] Settings service: read / sync / update (Meta validation rules mirrored: HHMM, ≤ 2 per day, no overlaps, ≤ 20 holidays, future dates, timezone list), unavailable reasons (coexistence, country, messaging limit), restrictions; `account_settings_update` + calling `account_update` handlers; daily sync job.
- [ ] Permissions service: request (§1e — interactive vs template, counters, Meta status API), reply handler, expiry sweep, unanswered streak, status for the contact panel; bubbles; WS + bells + audit.
- [ ] Tests: every rule, both request kinds, all reply variants (temporary / permanent / reject / automatic callback), limits (ours + Meta's), sweep, restrictions.

### T12.6 — Outbound calls

- [ ] `POST /whatsapp/calls`: dial guard (§1e), Call row, hold, leg + Graph connect, statuses, ring timeout, `ACCEPTED` → human bridge (`AgentLeg` over `/ws/media`) or AI (Phase 7 session), end paths, terminate always, settle, bubbles, streak.
- [ ] `AgentLeg` + `BridgeScript` (two legs, recording both sides, mute / hold (music-on-hold clip), keypad → DTMF to the customer, agent hang up).
- [ ] Call buttons: send interactive `voice_call` / template `voice_call` button (Phase 11 builder already supports the button) — minimal UI hook in T12.10.
- [ ] Tests: §1r integration list (BIC agent / AI / rejected / no answer / failed / wallet / DND / no permission at Meta 138006), cross-process hangup.

### T12.7 — Inbound calls

- [ ] Claim, contact / conversation match (phone or BSUID), pre-checks, `pre_accept`, routing (team ring with first-wins answer, AI, AI → team transfer), ring timeout → reject + missed, call hours (ours + Meta's), callback permission handling.
- [ ] Ring targets: `calls.answer` + available + online (presence) + ring list; `whatsapp.call.incoming` / `.taken` / `.ended_ringing`.
- [ ] Transfer: AI tool / flow transfer step → ring team → hold clip → agent joins → AI leaves; failure → back to AI with "No one is free" line or end.
- [ ] Tests: every route, races (two agents answer at once; customer hangs up while ringing; webhook terminate before claim), outside hours, wallet empty on AI route.

### T12.8 — Billing, API, dev tools, hardening, docs

- [ ] Calling rate card (CSV import + diff + save, like Phase 11), selling price per pulse, holds + extension, settle from Meta duration, late terminate reconcile, customer-pays, margin rows, money-writes.
- [ ] Routes + OpenAPI (§1o), rate limits, impersonation read only, WhatsApp-off 503, calling-off 409.
- [ ] Simulator kinds + `/dev/meta/calls/*`; seed; `npm run dev:calls-wa` (enable calling → permission → agent-less AI call with the fake user → inbound call → missed call).
- [ ] Hardening (§1r) + numbers recorded.
- [ ] Docs: ADR 0041 (WhatsApp calling: permissions, routing, billing), data-model §2.10, api.md §14f, websocket.md events, security / compliance (recording notice, DND, TRAI window, permission language), setup guide §15 (calling enablement, messaging limit 2,000, `calls` + `account_settings_update` subscriptions, UDP ports / public IP, real-device checklist), README section, CHANGELOG.

### P12-B2-DONE — checkpoint

- [ ] Full verify; manual HTTP + media check on a local server with the fake user (permission → agent call with the browser tester page → AI call with DTMF → inbound team ring → missed → wallet lines exact); log grep (no SDP, fingerprints, ICE passwords, phones, names, digits).

### T12.9 — FE foundation + settings + contact panel

- [ ] `gen:api`; clients (calling settings, permissions, calls, availability, superadmin calling rates); WS event types; labels (permission states, call outcomes, errors per code, Meta restriction texts); permissions hooks (`useCanCall`, `useCanAnswer`, `useCanManageCalling`); fixtures.
- [ ] Number → **Calling** section (settings editor with Meta's rules, routing, restrictions, unavailable states).
- [ ] Contact panel Calling section + permission request / reply bubbles.
- [ ] Tests (clients, hooks, editor rules, panel states, bubbles).

### T12.10 — FE call experience

- [ ] Chat Call button (every state), Request permission dialog (body text preview, interactive vs template note, cost line from Phase 11 price preview), Call yourself / Call with AI (program picker + cost per minute).
- [ ] Global call bar + agent media (Phase 7 audio worklet + `/ws/media`, device picker, mute, hold, keypad, hang up, network quality), recording dot, AI-call view.
- [ ] Global incoming popup (ring sound, browser notification, Accept / Decline, taken), availability toggle in the header.
- [ ] Call bubbles in the chat (missed / completed / rejected / failed → link to the call).
- [ ] Tests (every state, races, audio permission denied, reconnect).

### T12.11 — FE calls / wallet / superadmin + E2E

- [ ] Calls list WhatsApp filter + badge, call detail (Meta timeline, answered by, transfer, recording, transcript), wallet call lines + calling prices, superadmin calling rate card + margin rows, notifications (icons / links), dashboard ("Today: N WhatsApp calls · M missed").
- [ ] Bundle check vs `main` (both measures; ≤ +3 KB as one stream; the call bar is lazy except the tiny ringing listener).
- [ ] Playwright (`FAKE_META_CALL_DELAYS_MS`, fake mic): 4 specs (done-when, inbound, guards + billing, roles + settings), whole suite twice, 2nd with backend logs + grep.

### T12.12 — Gap audit, docs, sign-off

- [ ] Requirement → test table (§0 + §1 + every §7 decision); security / money checklist; numbers (tests, coverage, media metrics from the PoC + hardening, bundle); READMEs, CHANGELOGs, BUILD_PLAN_V2 Phase 12 ✅, tracker; `PHASE_12_SIGNOFF.md` (TODOs for Phases 13 / 15 / 18 / 20; owner inputs; go / no-go for Phase 13).

### P12-B3-DONE — checkpoint

- [ ] Both repos full verify + actionlint + E2E twice after the last code commit; fresh clones (`npm ci`, no `.env`, all checks + tests + E2E once); gitleaks; money-writes; `npm audit` recorded; sign-off verification; `infra:down` (`cav-*` only); final Hinglish report.

---

## 4. Deliverables checklist

- [ ] PoC + ADR 0040 (media) with measured numbers; plan B decision.
- [ ] Calling settings (Meta sync, restrictions, unavailable reasons) + UI.
- [ ] Call permissions (request interactive / template, reply, Meta status API, limits, sweep, streak) + UI.
- [ ] `WhatsAppCallLeg` + call-control bus + cross-process hangup.
- [ ] Outbound agent + AI calls; inbound team / AI / AI → team; missed calls; transfer.
- [ ] Billing: calling rate card, pulses, holds, settle, margin, money-writes.
- [ ] Records: Call fields, chat bubbles, Calls list / detail, recordings, transcripts.
- [ ] Fake Meta calling with a real loopback WebRTC user; simulator; seed; `dev:calls-wa`.
- [ ] Playwright: 4 specs, twice, logs clean.
- [ ] Docs: ADR 0040 / 0041, data-model, api, websocket, security, compliance, setup guide §15 (+ real-device checklist), READMEs, CHANGELOGs, sign-off.

## 5. Risks

| Risk                                                                          | Mitigation                                                                                                   |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Server-side WebRTC with Meta doesn't interoperate (DTLS / ICE-lite quirks)    | PoC first (T12.1) with Meta's documented SDP; real number check as early as possible; plan B (browser relay) |
| Opus native module build issues on the server                                 | codec interface + WASM fallback; CI builds both                                                              |
| CPU per call too high for AI + codec + resampling                             | PoC numbers; limit concurrent calls per node (`WA_MEDIA_MAX_CALLS`); scale by nodes                          |
| No public UDP on the client's server / NAT                                    | ops notes §1s; Phase 13 checklist; TURN env reserved                                                         |
| Webhook latency (connect → SDP answer) breaks call setup                      | fast path to the bus before the queue; Meta allows 30–60 s; alerts on setup time                             |
| Meta limits / restrictions change (they changed 3 times in 2025)              | Meta's status API is the source of truth before every dial; limits as data; error codes mapped generically   |
| Low pickup → Meta hides the call button / restricts BIC                       | unanswered streak warnings, ring timeouts, restriction banners, no auto-redial                               |
| Calling not available for some numbers (coexistence, messaging limit < 2,000) | clear "unavailable" states with reasons; feature hidden where impossible                                     |
| Two agents answer the same call                                               | Redis `SET NX` first-wins + `whatsapp.call.taken`                                                            |
| Process restart drops live calls                                              | graceful drain on deploy; owner TTL; survivor sends terminate; calls marked `server_shutdown`                |
| Billing drift (our duration vs Meta's)                                        | settle on Meta's `duration`; reconcile late terminates; margin report                                        |
| Customer data leaks via SDP / logs                                            | SDP never logged (tests + E2E log grep for `a=fingerprint`, `ice-pwd`, `candidate`)                          |
| No real Meta calling test number before Phase 13                              | fake user with real WebRTC; sandbox if the client's app qualifies; real-device checklist                     |

## 6. Recommended order

T12.1 (PoC) **must pass first** → Batch 1 (T12.2–T12.4) → `P12-B1-DONE` → Batch 2 (T12.5–T12.8) → `P12-B2-DONE` → Batch 3 (T12.9–T12.12) → `P12-B3-DONE`. T12.5 (settings + permissions) can start in parallel with T12.4 after T12.3.

## 7. Decisions and open questions

**To be answered by the project lead (defaults proposed — work continues on the defaults unless changed):**

| #   | Question                                                                             | Default                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Markup on Meta's **call** price                                                      | **15 %** (same as messages), per-account override                                                                                                                                                                                    |
| 2   | Calling rate card source                                                             | Meta's INR **calling** rate card CSV imported by the superadmin; placeholder until then: **India ₹0.3885 / min** (third-party quote of Meta's INR list — owner to confirm the official file), OTHER = highest market; base tier only |
| 3   | Platform fee per call minute (both payers)                                           | **₹0**                                                                                                                                                                                                                               |
| 4   | Who can place WhatsApp calls / answer                                                | Owner / Admin / Manager / Agent (`calls.trigger` / `calls.answer`); viewers never                                                                                                                                                    |
| 5   | Send permission requests to opted-out (STOP) contacts?                               | **No** (they opted out of business messages)                                                                                                                                                                                         |
| 6   | Record WhatsApp calls (our server) + notice                                          | **Yes**, with the account's recording notice at the start (AI and human)                                                                                                                                                             |
| 7   | Calling window for **agent** calls (TRAI 09:00–21:00 applies to AI / campaign calls) | **Same window** for agent calls (safer); inbound unaffected                                                                                                                                                                          |
| 8   | Ring timeouts                                                                        | BIC **45 s**; UIC team ring **30 s** (below Meta's 30–60 s)                                                                                                                                                                          |
| 9   | Meta voicemail                                                                       | **Off**; missed-call bubble + bell + callback permission                                                                                                                                                                             |
| 10  | Transcribe **human** calls (STT cost)                                                | **Off** by default (per-account toggle)                                                                                                                                                                                              |
| 11  | Supervisor listen / take over on AI calls                                            | **Take over only** (Phase 7 barge-in style); live listen later                                                                                                                                                                       |
| 12  | Default inbound route for a newly enabled number                                     | **Team ring**, falling back to "missed" (no AI unless chosen)                                                                                                                                                                        |
| 13  | Call icon visibility when calling is enabled                                         | **Visible** (`DEFAULT`) with **no country restriction** (owner may restrict to India)                                                                                                                                                |
| 14  | Max WhatsApp call length                                                             | **30 min** human / AI program limit (hard cap 60 min, Phase 7)                                                                                                                                                                       |
| 15  | Default permission request text                                                      | _"Kya hum aapko WhatsApp par call kar sakte hain? Aapke loan / account ke baare mein baat karni hai."_ (editable per number)                                                                                                         |
| 16  | Plan B if the PoC fails                                                              | Browser relay for human calls; AI WhatsApp calls move to Phase 18 (SIP media server)                                                                                                                                                 |

**Client inputs still pending (from Phases 9–11):** Meta app (id, secret), Business verification, Solution Partner + **INR** credit line, System User token, a **test WABA number with calling enabled and messaging limit ≥ 2,000** (or the calling sandbox — Tech Partners only), a real Android / iPhone for the device checklist, the staging server with **public UDP ports** for media, Meta's official INR calling rate card.

---

## Changelog

- 2026-10-24: Plan written. Meta calling facts re-checked on developers.facebook.com (Calling overview, business-initiated, user-initiated, user call permissions, call settings, call buttons, reference, troubleshooting, pricing, sandbox, FAQ, integration patterns, App Review guidelines): BIC available for Indian business numbers (excluded: US, Canada, Egypt, Vietnam, Nigeria); permission requests 1 / 24 h, 2 / 7 days; temporary permission 7 days or permanent; 100 connected calls / 24 h per pair; 4 unanswered → revoked; UIC free; BIC in 6-second pulses by market × tier; Meta is ICE-lite (we are ICE-full controlling, DTLS client, Opus 48 kHz / 20 ms, single SSRC); ≈ 20 s / 30 s no-media drops; coexistence numbers can't call; messaging limit ≥ 2,000 needed. 16 owner questions with defaults (§7).
- 2026-10-24: Defaults in use for §7 #1–#16 (owner answers pending).
- 2026-10-24: Run prompt prepared — refinements locked:
  - module layout `core/telephony/whatsapp/*` + `modules/whatsapp-calling/*`;
  - leg rate 24 kHz;
  - call-control bus keys + webhook fast path + Phase 7 hangup routing;
  - deferred `calls` events ignored;
  - Meta's permission API before every dial / request (60 s cache);
  - ledger `whatsapp_call_charge` + four engine functions + pulse math + two holds for AI calls + reaper filters;
  - message type `call`, BSUID on contacts;
  - fake knobs `00020`–`00030`, 12 simulator kinds;
  - error codes +14 (adds `WHATSAPP_CALL_PERMISSION_CHECK_FAILED` to §1o), audit +9, notifications +5, WS +4, permissions +2.

  The prompt's §1 wins where this plan differs.

- 2026-10-24 (T12.1): **PoC passed** (ADR 0040, accepted). Loopback numbers: 20 / 20 sequential runs (tone both ways + DTMF `1 2 3`), setup median 141 ms (221 ms with 20 parallel), 30 s silence keep-alive 1,500 packets and still connected, 1 / 10 / 20 parallel calls all passed, CPU per call 1.9 % (10) / 1.1 % (20) of one core (5.0 % for a single call incl. fixed process cost), memory ≤ 5.7 MB per call, encode → network → decode 0.5–0.7 ms per direction, jitter ≤ 0.41 ms, added delay ≈ 23 ms. Deviations: Opus is `opusscript` (WASM) only, the native `@discordjs/opus` crashed / hung on Node 24 and is not a dependency; the Phase 7 `Resampler` is reused for 48 ⇄ 24 kHz instead of a new FIR (same tests: < 1 % frequency error, ± 1 dB, no clicks at joins); in BIC Meta answers `setup:active`, so Meta is the DTLS client there (we are the client in UIC); werift rewrites every outgoing payload type to Opus, so RFC 4733 packets go straight to the sender's DTLS transport; werift does not write `a=ptime`, `sdp.ts` adds `a=ptime:20`; `sdp.ts` (shape + log-safe summary) started in T12.1. No test number with calling, so the real-Meta check moves to Phase 13 with these steps: (1) a WABA number with messaging limit ≥ 2,000, not coexistence, calling enabled in call settings; (2) a test phone opts in through a permission request; (3) BIC from staging with `WA_MEDIA_PUBLIC_IP` set and UDP 40000–40999 open; (4) confirm two-way audio, DTMF from the phone keypad, 60 s of silence without a drop, terminate from both sides; (5) one UIC from the phone, answer as an agent; (6) note Meta's real SDP shape against `tests/fixtures/meta/calls-sdp-answer.txt`.
- 2026-10-24 (T12.2): Meta calling pages re-checked (Cloud API Calling overview, call settings, pricing): limits unchanged — permission requests 1 / day and 2 / week in production (sandbox 25 / 100), 2 unanswered → reminder, 4 → revoked, 100 business-initiated calls per user per day, messaging limit ≥ 2,000, BIC unavailable in US / CA / EG / VN / NG, a 7-day calling pause after high negative feedback (handled as a restriction). No literal changes. Deviations: platform settings `value` is now validated per key (`platformSettingProblems`, also on `updateOne(…, { runValidators })`) instead of one sub-schema; rate cards get `callingMarkets` beside `markets` (one list per `kind`, checked in a `pre('validate')` hook) and messaging reads filter `kind ≠ calling`; human calls store `source.kind = null`; `users.callAvailability` defaults to `available` (ringing still needs WS presence); `calling.permissionRequestBody` holds the editable request text (§7 #15); the `billing.whatsapp_call_reap_holds` job and the `whatsapp.*` calling jobs are named in `modules/whatsapp-calling/jobs.ts` now and wired to the workers when their processors land (T12.5 / T12.7) — the worker maps need a handler per name; `WA_STUN_URLS` accepts `off` and defaults to none under `NODE_ENV=test` (an empty value means "not set" in our env loader), so vitest needs no extra env; superadmin call price edits reuse the Phase 11 audit actions (`whatsapp.rate_card_saved`, `whatsapp.billing_settings_updated`, `account.whatsapp_billing_updated`) with `kind: 'calling'` in `meta` (the prompt fixes +9 audit actions); the permission key format test now allows `domain.area.action` so the locked literal `whatsapp.calling.manage` stays as written.
- 2026-10-24 (T12.3): Meta calling pages re-checked for field names (reference, user call permissions, call settings, call buttons, analytics). Findings applied: terminate `errors[]` sit at the value level; `connect` may name the customer by `recipient` (BSUID) instead of `to`; `GET call_permissions` takes `user_wa_id` or `recipient`; `permission.expiration_time` (the table says `expiration` — both read); settings restrictions under `restrictions.restrictions_list` (table: `restriction_list` — both read); holidays `start_time` / `end_time` (table: `open_time` / `close_time` — both read); the template call button is `sub_type: voice_call` **without an index** with `ttl_minutes` / `payload` parameters; `account_settings_update` fires only for status / icon visibility / callback / SIP changes; calling `account_update` types `RESTRICTED_BUSINESS_INITIATED_CALLING`, `RESTRICTED_USER_INITIATED_CALLING`, `RESTRICTED_USER_INITIATED_CALLING_CALL_BUTTON_HIDDEN`, `LOW_*_CALLING_QUALITY`, `USER_INITIATED_CALLS_LOW_PICKUP_RATE`. Meta exposes `call_analytics` (count / cost / average duration per day) → `getCallAnalytics` is added now and `billing.whatsapp_call_reconcile` will be created with the call billing (T12.7); its exact array syntax is copied from `pricing_analytics` and is re-checked against Meta in Phase 13. Deviations: fake calling lives in `core/meta/fake-calling.ts` (composed into `fake.client.ts`, which stays the only entry point); the settings method is `getPhoneSettings` (prompt name) and returns the calling block only; `scrubSecrets` now also removes SDP bodies and whole `a=candidate` / `a=fingerprint` / ICE credential lines (a test caught a candidate line leaking its IP); inbound messages read `from_user_id`, `from` stays required (BSUID-only senders are handled with the calls, T12.6); the fake ends a never-answered user call after 2 × `uicAnswerDeadlineSec`, counts unanswered business calls on our terminate while ringing, grants callback permission (`automatic`) on a user call when the number has it on, and rejects `accept` with an SDP other than the pre-accepted one (138007).
- 2026-10-24 (T12.4): `WhatsAppCallLeg` + call-control bus. Bug found and fixed in its own commit (`fix(calls)`): opusscript's JS wrapper corrupted audio once many codecs were alive (heap views cached before WASM memory growth, 16-bit views indexed with byte pointers) — `codec.ts` now drives the emscripten module directly (ADR 0040 updated, regression test `codec-heap.test.ts` fails on the old wrapper). Deviations: the keep-alive is drift-free (each 20 ms slot without audio gets a silent frame, catching up ≤ 3 after a late timer — a plain interval lost ~7 % of frames under load); werift sends the RTCP sender reports itself (`rtcpEverySec` is werift's own schedule, not ours); `rttMs` stays `null` (werift does not expose RR round trips to us); the jitter buffer is a 3-packet reorder buffer (`jitterBufferMs` 60) released on arrival, gaps ≤ 10 packets concealed with silence frames; a leg with no inbound media for 30 s after the answer ends `media_timeout` and terminates at Meta; `remoteEnded` (Meta's terminate) never terminates back; the stale Phase 9 events use status `ignored` with `error: ignored_stale` (no new event status); the owner-loss sweep and the inbound / call handlers on the bus are wired by the calls service (T12.6), which also owns the fast-path-vs-worker idempotency test on real transitions — here the fast path is tested for once-per-new-event delivery, redelivery and a failing publish; cross-process hangup works for every provider (`call:node:<callId>` key, 202 when forwarded, 409 when no process holds the call).
- 2026-10-24 (P12-B1-DONE): Batch 1 complete — T12.1 PoC passed, T12.2 models + migration 0013 + catalogue, T12.3 Meta core + fake calling, T12.4 leg + call-control bus (+ one `fix(calls)` for the Opus WASM heap bug). Backend 3074 tests, coverage 96.62 / 88.58 / 96.42 / 98.04. `npm run dev:calls-wa -- --poc` (first version, in-process: fake Meta + our leg on loopback, the calls webhooks are applied by the script until the calls service lands in T12.6): setup 283 ms, answered after 864 ms, customer heard the agent tone (−15 dBFS), business heard the customer tone, 1 key received, 4 s call, loss 2 % (the first packets before the reorder buffer filled and late packets it dropped), jitter 1.9 ms. Log grep of the run (`a=fingerprint`, `ice-pwd`, `ice-ufrag`, `a=candidate`, `v=0`, both phone numbers, `Bearer`, tokens) → 0 hits.
- 2026-10-25 (T12.5): calling settings + call permissions. Deviations: Meta's messaging tier `TIER_2K` (late 2025, replaces 1K) added to `WA_LIMIT_TIERS` and the fake's default numbers now report it (calling needs ≥ 2,000; with 1K every fake number was unavailable); the BIC country rule is not an `unavailableReason` (inbound calls still work) — the settings view says `businessCallsBlockedBy: 'country'` and permission requests / the dial guard refuse; calling `account_update` restrictions / warnings are handled by calling (stored on `calling.restrictions`, bell + e-mail to `whatsapp.calling.manage` holders, audit) and no longer restrict the whole number (Phase 9 did that for any `ACCOUNT_RESTRICTION`); a Meta GET replaces our calling restrictions (Meta is the truth); refused requests for DND / opted-out / blocked customers use the existing `CALL_NOT_ALLOWED` (422) with the reason in `details[0].message`; the API ring timeout is capped at `uicRingTimeoutSec` (30 s, must stay under Meta's 30–60 s); the request bubble state (`sent → answered / expired / failed`) is derived — the reply writes its answer on the request message (`interactive.callPermission`), "expired" = 7 days after sending without an answer; the "managers" of the revoked bell are the `templates.manage` holders (owners, admins, managers); the HTTP routes for settings / permissions come with the API in T12.8 (services + hooks + jobs are wired in the worker now: hourly sweep, daily settings sync, sync after a connect).
- 2026-10-25 (T12.6): business-initiated calls for agents and AI. Deviations: the pure pulse math + the four engine functions (`holdForWhatsAppCall`, `extendWhatsAppCallHold`, `settleWhatsAppCall`, `releaseWhatsAppCallHold`) landed now (T12.6 needs them; T12.8 keeps the reapers, rate-card admin, CSV import and margin rows); human and AI calls both run on the Phase 7 `CallSession` with the `WhatsAppCallLeg` (`answerTimeout` option added: ring `bicRingTimeoutSec` → `not_answered`), the agent's browser leg attaches through `CallManager.setWhatsAppAttach` (the media ticket comes back from the dial call); the call part settles on Meta's terminate `duration` — the owner keeps the call's bus ownership until then, else charges our measured time after `lateTerminateGraceSec` (note "Meta duration not received in time"); `call.status` / `call.ended` carry `provider`; the dial guard skips the Phase 8 per-contact caps (Meta's permission + limits govern WhatsApp calls) and checks the account calling window ∩ TRAI 09:00–21:00 for agent calls too (§7 #7); a Meta connect failure keeps a `failed` call row (`meta_failed` / `permission_missing` / `calling_restricted`) for history, releases the holds and returns the mapped error; Meta's "no permission" (knob `00030`) is refused by the guard's `GET call_permissions` before any hold; the human-call recording notice plays to the customer before the bridge opens (the agent hears the customer from then on); hold plays a fixed line (no hold music clip); the agent leaving ends the call `agent_end_call`; a bridge bug (the agent leaving during the recording notice was lost) was fixed before commit; the AI test uses a key-press program on the real WhatsApp media (the Loan recovery flow over WhatsApp runs in `npm run dev:calls-wa`, T12.8 — the flow itself is covered by Phase 7); template `VOICE_CALL` buttons send `payload: tpl_<templateId>` (→ `cta_payload` on the call); ledger breakdown stores `waPulses` / `waPerMinuteMicros`.
- 2026-10-25 (T12.7): user-initiated calls with team ring, AI and AI → team. Deviations: presence is new (`core/realtime/presence.ts`, a 90 s Redis lease per socket — there was no cross-instance online state before); ring events (`whatsapp.call.incoming` / `taken` / `ended_ringing`) go to each ring target only (user scope), not the whole account; agent actions (answer / decline / hold / transfer / media ticket) reach the media owner over the bus as a request / reply (`CallControlBus.command`, 10 s timeout → `CALL_NOT_ACTIVE`), so the HTTP request may land on any API node; one agent holds one WhatsApp call at a time (`claimAgent`, also for agent BIC calls — released on end and on a refused / failed dial); the answer race is two locks — the agent claim, then the first-wins `claimAnswer` on the ring; the accept to Meta waits for the winner's media socket (the customer hears nothing before the agent can hear them) and user-initiated legs send no RTP until `accept`; an unidentified caller (no phone, unknown BSUID) is rejected without creating a contact; refusals (account not active, calling off, user restriction → `calling_restricted`; Meta / our hours → `outside_call_hours`; AI route wallet → `wallet_empty`) still write the call row and a missed bubble; a `terminate` that arrives before any node claimed the call marks `call:wa:ended:<waCallId>` so the late `connect` starts nothing; the AI → team handoff keeps the same `CallSession` and recording (`HandoffScript` swaps the AI script for the bridge), the AI part settles with the seconds before the handoff; a transfer nobody takes resumes an agent program with the "Abhi koi team member free nahi hai…" line (a flow follows its transfer failure exit); the calling API routes (settings, permissions, calls start / answer / decline / hold / transfer, media ticket, `PATCH /users/me/call-availability`) landed now because answer / decline need them — T12.8 adds the rate-card / admin routes, simulator and docs; calls list filters `direction` / `mode` and the call view's `whatsapp` block.
- 2026-10-25 (T12.8): charges, admin, dev tools, hardening, docs. Deviations: the Phase 4 / Phase 11 reapers already filter their own ledger types, so there was no failing regression test to write first — guard tests prove both leave `whatsapp_call_charge` holds alone and the new `billing.whatsapp_call_reap_holds` (every 15 min, holds older than the longest call + grace + 30 min) releases them; late-terminate reconcile (`billing.whatsapp_call_reconcile`, hourly) stores Meta's late pulses beside ours (`billing.whatsapp.metaLatePulses`, `durationSource`) for the margin report and moves no money (the customer keeps the price of the talk time we measured); calling rate cards reuse the Phase 11 routes with `kind=calling` (body `{ kind, callingMarkets }`), call price settings live inside `PATCH /admin/whatsapp-billing { calling }` and the account override inside `PATCH /admin/accounts/:id/whatsapp-billing { calling }`; audit reuses `whatsapp.rate_card_saved` (meta `kind: calling`), `whatsapp.billing_settings_updated` (fields `calling.*`) and `account.whatsapp_billing_updated` (field `calling`); margin rows `kind: call` come from captured call charges (list cost, mismatches = calls charged on our time); `call_tier_update` simulates Meta's 2,000 messaging limit (a quality webhook), `calling_unrestricted` re-reads Meta's settings (Meta lifts calling pauses there, not by `account_update`); `npm run dev:calls-wa` without `--poc` runs the real server (`startServer`, random port) and drives it over HTTP, opening the dev account's calling window every day for the run and restoring it after; the hardening numbers are recorded with `HARDENING_TIMINGS` (no console output in tests). Hardening: 50 loopback calls with recording 1.39 s (setup 0.41 s, CPU 1.7 s, +90 MB RSS), 1,000 permission replies 0.54 s, 200 calls × 10 settle attempts 7.9 s (200 charges, no hold left), 3 nodes with a killed owner (orphans failed + terminated once, the rest live). `dev:calls-wa`: permission temporary, AI call 15 s → 3 pulses ₹0.14 with 1 key, inbound answered by an agent on the media socket, missed call → bubble + bell; log grep (SDP markers, phones, tokens, names, digits) → 0.
- 2026-10-25 (P12-B2-DONE): Batch 2 complete — T12.5 settings + permissions, T12.6 business-initiated calls, T12.7 user-initiated calls + routing, T12.8 charges / API / dev tools (+ `fix(calls)` missed-call bell with nobody online, `test(seed)` fake Meta prefix for the seed tests). Backend 3141 tests, coverage 96.08 / 87.55 / 95.77 / 97.66. Manual HTTP + media check on a locally started dev server + a second server process on the same Redis (scratchpad script, counts / statuses only): settings round trip (7-day call hours, route team, ring 15 s; agent PATCH 403); permission in window → interactive → temporary, outside → template, second request the same day → 429 `WHATSAPP_CALL_PERMISSION_LIMIT`, `00025` → declined; agent call with a 1 kHz browser tone → the fake customer heard it, the agent heard 65 frames, Meta 4 s → 1 pulse = ₹0.05 charged exactly; AI call (`00028`, Loan recovery flow) → key → call + AI holds both settled, none held; inbound team ring with two agents → 200 / 409 `WHATSAPP_CALL_TAKEN`, the winner heard the customer (168 frames), no call charge; inbound AI; AI → team transfer (supervisor) → same call `mode: human`, `transferredTo`, one recording; missed with nobody online → bubble `missed` + 4 bells; guards no permission / DND / call budget / outside window / restricted (simulator) / impersonation 403; `00022` × 4 not answered → revoked (streak 4); superadmin calling CSV import → IN ₹0.45 → ₹0.58 / min selling, restored; hangup sent to the other server → 202, call completed. Log grep of both runs (`v=0`, `a=candidate`, `a=fingerprint`, `ice-pwd`, `ice-ufrag`, phones, `Bearer`, names, media tickets, digits) → 0. Deviations: "wallet empty" was checked as the monthly call budget (no direct wallet edits outside the engine); the dev DB needed `npm run db:migrate` (0013 was pending).
- 2026-10-26 (T12.9–T12.11): frontend + E2E. Deviations: `WA_CALL_WINDOW_IGNORED` (fake Meta only, refused in production) lets E2E call at any hour — "outside the calling window" stays an integration test; the 4-unanswered E2E uses the rejecting knob `00021` (rejects count as not picked up, like Meta; the fake now counts them too); `PublicUser.callAvailability` in the session; rate card `kind` optional so messaging clients keep their contract; permission events refresh every open contact panel (panels are keyed by conversation); a dropped agent socket (close 1006) gets a 15 s reconnect grace with a fresh media ticket; `metrics.whatsapp` (setup, packets, loss, jitter, `rttMs: null`) saved at call end; the call bar polls the active call every 2 s; microphone picker during the call. Bugs fixed with regression tests: `provider` on every `call.status`, the permission reason, a permission WhatsApp no longer has shown as revoked, the fake's reject count, and the frontend call bar state fixes (fe `979e3b6`).
- 2026-10-26 (T12.12 / P12-B3-DONE): gap audit — one gap test (`d97b0cf`: account views show the selling price only). Backend 3162 tests (96.08 / 87.66 / 95.80 / 97.66), frontend 1304 (96.09 / 91.94 / 93.74 / 96.88), Playwright 148 green twice, logs clean, bundle +1.4 KB as one stream. [Sign-off](PHASE_12_SIGNOFF.md). Next: Phase 13 (Staging deploy + Meta App Review) with the real-device checklist.
