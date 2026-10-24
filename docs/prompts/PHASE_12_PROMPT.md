# P12 RUN — WhatsApp Calling (T12.1 → T12.12) — Autonomous Run Prompt

> **HOW TO RUN — 3 batches, one at a time (same as Phases 3–11). Har batch ke baad report padho, phir agla paste karo.**
>
> **Batch 1 (PoC gate + foundation: WebRTC media PoC + ADR 0040, models + catalogue + migration 0013, Meta calling / settings / permissions API + fake Meta calling with a real loopback WebRTC user, `WhatsAppCallLeg` + call-control bus):**
> `cell-ai-voicebot-backend/docs/prompts/PHASE_12_PROMPT.md padho aur STEP 0 + BATCH 1 (P12-SETUP se P12-B1-DONE tak) SAARE tasks step by step autonomously implement karo. Bich me koi question mat poochho, permission mat maango — saare decisions is prompt + PHASE_12_PLAN.md me pre-made hain. T12.1 PoC fail ho to STOP karke report do (plan B ke liye). Har task ke baad verify (har command alag) + commit (tag [P12-T12.x]). Koi push / merge NAHI. Ant me P12-B1-DONE checkpoint + final report (Hinglish).`
>
> **Batch 2 (calling settings + call permissions, outbound agent + AI calls, inbound routing + team ring + AI → agent transfer, billing + API + OpenAPI + simulator + seed + dev script + hardening + ADR 0041 + docs + real-device checklist):**
> `cell-ai-voicebot-backend/docs/prompts/PHASE_12_PROMPT.md padho aur BATCH 2 (T12.5 se P12-B2-DONE tak) SAARE tasks step by step autonomously implement karo. Bich me koi question mat poochho, permission mat maango. Har task ke baad verify + commit (tag [P12-T12.x]). Koi push / merge NAHI. Ant me P12-B2-DONE checkpoint + final report.`
>
> **Batch 3 (frontend foundation + number Calling settings + contact panel + permission bubbles, call experience: Call button / call bar / agent media / incoming popup / Call with AI, Calls list + wallet + superadmin calling rates, E2E + sign-off):**
> `cell-ai-voicebot-backend/docs/prompts/PHASE_12_PROMPT.md padho aur BATCH 3 (T12.9 se P12-B3-DONE tak) SAARE tasks step by step autonomously implement karo. Bich me koi question mat poochho, permission mat maango. Har task ke baad verify + commit (tag [P12-T12.x]). Koi push / merge NAHI. Ant me P12-B3-DONE checkpoint + Phase 12 sign-off + final report.`
>
> **Claude Code "accept edits" mode me chalao.** Working directory: `/Users/lalitbansal/Documents/cell-ai-voicebot`. **Docker Desktop chalu hona chahiye** (`open -a Docker`). **Mac charger par aur lid khuli** — lambi test runs `caffeinate -dims` ke saath. Phase 11 lesson: is machine par doosre project ke ~12 Supabase containers bhi chalte hain (load average 7–20) → full-suite timeouts ya single flaky tests aayein to pehle `uptime` dekho, phir rerun karo; doosre containers **kabhi mat chhoona**.

---

## 0. CONTEXT (verified facts on 24 Oct 2026 — dobara derive mat karna)

**Phase 11 done, signed off and merged by the project lead:** `main` = Phase 11 tip in both repos — backend `a2b9126 [P11-B3-DONE]`, frontend `4af4fe8 [P11-T11.12]`. **The backend branch `feature/phase-12-whatsapp-calling` already exists** (created from `main` by the planning session) with commit `e785293 docs(plans): add phase 12 detailed plan [P12-PLAN]`; this prompt is **uncommitted** on that branch. The **frontend** branch is created at T12.9 (`git switch -c feature/phase-12-whatsapp-calling main`). **Never commit to `main`.**

**Numbers at start:** backend **2972 tests**, gate **95 / 85 / 95 / 95** (`vitest.config.mts`; measured 96.76 / 88.85 / 96.57 / 98.07); frontend **1215 tests + 125 Playwright tests**, gate **95 / 90 / 90 / 95** (`vite.config.ts`; measured 97.03 / 92.90 / 94.90 / 97.57). New frontend files need **branch-complete tests** (every `if`, `??`, ternary, optional chain, early return, error branch). Catalogues with docs-sync / count tests (`tests/templates/catalogue.test.ts` holds today's totals): error codes **69**, audit actions **118**, notification types **26**, `MESSAGE_TYPES` **16**, permissions as in `src/modules/rbac/permissions.ts` (+ roles snapshot); migrations `0001` … `0012`; queues `system`, `email`, `maintenance`, `contacts`, `billing`, `ai`, `campaigns`, `whatsapp`; simulator kinds **58** (16 Phase 9 + 28 inbox + 14 template / billing); topic kinds `call`, `campaign`, `conversation`; nav `LIVE_PHASE = 11`; Meta `WEBHOOK_FIELDS` already contains **`calls`** (Phase 9 stores it deferred, routing metadata only) — **`account_settings_update` is missing**.

**Pehle padho (har batch se pehle):**

- [PHASE_12_PLAN.md](../phases/PHASE_12_PLAN.md) — **source of truth**: scope §0, locked decisions §1a–§1t, Meta facts §1d (re-checked 24 Oct 2026), tasks §3, §7 owner questions (defaults).
- [BUILD_PLAN_V2.md](../plans/BUILD_PLAN_V2.md) — its Phase 12 section.
- [PHASE_11_SIGNOFF.md](../phases/PHASE_11_SIGNOFF.md) — §5 deviations, §6 bugs + lessons, §8 TODOs (Phase 12: send the call permission template, `call_permission_reply`, voice call buttons).
- ADRs: [0016](../adr/0016-money-representation.md) (money), [0020](../adr/0020-telephony-abstraction.md) (telephony), [0021](../adr/0021-voice-ai-provider.md), [0022](../adr/0022-sip-media-server.md), [0035](../adr/0035-voice-runtime.md) (voice runtime), [0037](../adr/0037-whatsapp-channels-meta.md), [0038](../adr/0038-whatsapp-inbox.md), [0039](../adr/0039-whatsapp-templates-billing.md).
- [src/README.md](../../src/README.md).
- Conventions: [api.md](../conventions/api.md) (**add §14f WhatsApp calling**), [security.md](../conventions/security.md), [secrets.md](../conventions/secrets.md), [data.md](../conventions/data.md), [data-model.md](../conventions/data-model.md) (**add §2.10**), [websocket.md](../conventions/websocket.md), [error-codes.md](../conventions/error-codes.md), [audit.md](../conventions/audit.md), [definition-of-done.md](../conventions/definition-of-done.md), [compliance-notes.md](../compliance/compliance-notes.md) (add a WhatsApp calling section).
- [docs/setup/meta-whatsapp.md](../setup/meta-whatsapp.md) (§1–§14; T12.8 adds **§15 WhatsApp calling** + real-device checklist).

**What exists (use it, don't rebuild):**

| Area                       | Provides                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Telephony (Phase 7)        | `src/core/telephony/types.ts` — `CallLeg` (`rate: 24_000 \| 8_000`, `onAudio`, `onDtmf`, `onText`, `onStatus`, `onOutgoing`, `play(pcm, onStart)` → `PlaybackResult`, `clearAudio()` (barge-in, returns ms played), `playing`, `transfer(phoneLast4, timeoutSec)` → `connected \| failed \| no_answer`, `notify(notice)`, `hangup(cause, notice?)`), `HangupCause`, `LegStatus`, `TelephonyProvider { name: 'webcall' \| 'sip'; startCall }`; `webcall.ts` `WebCallLeg` (PCM16 24 kHz 20 ms frames over `/ws/media`, `Pacer`, `Framer`, control messages `call.ready / call.dtmf / call.hangup / call.transfer_result / call.say_text / call.mute`); `media-server.ts` (`/ws/media` upgrade, media tickets, `attach(input, leg)`, `MEDIA_CLOSE`); `dryrun.ts` `DryRunLeg` / `DryRunProvider` (fake phone line for campaigns)                                                                                                                                                                                       |
| Voice runtime (Phase 7)    | `src/core/voice/*` — `clock.ts` (`Clock`, `FakeClock`, `systemClock`), `scaled-clock.ts`, `audio/` (`pacer`, `framer`, `pcm` `toBytes` / `fromBytes`, resampling helpers, WAV), `flow-host.ts` (`FlowHost`, end reason `transferred`), `ai-session.ts` (`AiVoiceController`; agent tool `transfer_to_human` → `io.leg.transfer(last4, CALL_LIMITS.transferAnswerSec)`), `providers/` (Realtime, chat pipeline, fake), `tts-cache.ts`, `latency.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Calls module (Phase 7 / 8) | `src/modules/calls/*` — `call.service.ts` `CallManager` (`createWebCall`, `keepLease`, `releaseLease`, `accountLimits`, `onCallEnded`), `session.ts` `CallSession` (answered → recording notice → script, idle / max duration, wallet hold extension every `CALL_LIMITS.holdCheckEverySec`, polite ends, settle), `registry.ts` `CallRegistry` (`call:live:<callId>` + per-account set, heartbeat, **one process owns a live call; cross-process hangup answers 409 today**), `scripts.ts` (`ScriptFactory`, `createScriptFactory`), `flow-script.ts`, `agent-script.ts`, `recording.ts` (`CallRecorder` stereo 8 kHz WAV, `uploadRecording`), `billing.ts` (`CallBilling` port: `holdEstimate`, extend, settle with `telephony: boolean`, `chargeCallUsage`), `media-tickets.ts` (`issueMediaTicket`), `lifecycle.ts` (`CALL_TRANSITIONS`, `canMove`, `finalStatus`, `endReasonFor`), `calls.routes.ts` (list / detail / hangup / recording link / media ticket), `topic-auth.ts`, `maintenance.ts`, `dry-run.ts` |
| Call model                 | `src/db/models/call.model.ts` — `CALL_DIRECTIONS outbound / inbound`, `CALL_PROVIDERS webcall / sip / notifynow / dryrun`, `CALL_STATUSES`, `LIVE_CALL_STATUSES`, `CALL_END_REASONS` (incl. `transferred`, `max_duration`, `wallet_empty`, `customer_hangup`), `kind: 'flow' \| 'agent'`, `providerCallId` (unique partial with `provider`), index `accountId + contactId + provider + createdAt`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Limits / account           | `CALL_LIMITS` (`frameMs 20`, `webSampleRate 24000`, `recordingSampleRate 8000`, `concurrentPerAccount 3`, `concurrentPerProcess 20`, `readyTimeoutSec 15`, `maxCallSecHard 3600`, `holdLowWaterSec 60`, `holdCheckEverySec 5`, `heartbeatSec 10`, `registryTtlSec 30`, `transferAnswerSec 60`, `recordingNoticeMaxChars 200`, `recordingUrlTtlSec 300`, …), account `limits.maxConcurrentCalls` (default 10), `settings.callingWindow` (`09:00–19:00`, Mon–Sat), `callCaps` (`perDay 3, perWeek 10, minGapMinutes 30`), recording notice / AI disclosure settings; TRAI window 09:00–21:00 in campaign limits                                                                                                                                                                                                                                                                                                                                                                                                      |
| Billing engine             | `src/core/billing/engine.ts` — `holdForCall`, `extendHold`, `settleCall`, `releaseHold` (`loadHold` only `call_charge`), `chargeUsage`, WhatsApp message functions (`holdForWhatsApp`, `captureWhatsApp`, `releaseWhatsApp`, `releaseWhatsAppMany`, `chargeWhatsAppLate`, `loadWhatsAppHold`), `canSpend` budgets `call` / `ai` / `whatsapp`, `moneyPipeline`; `reaper.ts` (call holds only), `whatsapp-reaper.ts`; `src/core/billing/whatsapp.ts` (`marketFor`, `metaRate`, `sellingPrice`, `ceilToPaise`, `parseMetaRateCsv`, `diffRateCards`, `KNOWN_MARKETS`); `src/modules/whatsapp-billing/*` (`pricing.service.ts` `priceMessage` / `holdMessageCharge`, `admin.service.ts` rates import / save / settings / account override / margin / reconciliation, `billing-hook.ts`, `reconcile.ts`, routes); ledger `whatsapp_charge` + `breakdown.waConversationId` (Phase 11 B3); `tests/security/money-writes.test.ts`; `tests/helpers/billing.ts` `expectWalletConsistent`                                      |
| Meta core                  | `src/core/meta/{types,graph.client,fake.client,errors,schemas,payloads,message-schemas,template-schemas,signature,index}.ts` — `MetaClient`, Graph retries + scrubbing, `createMetaClient(env, deps)`, fake state in Redis, knobs `FAKE_INBOX_KNOBS` (`00005`–`00009`), `FAKE_TEMPLATE_KNOBS` (`00010`–`00013`), `FAKE_TEMPLATE_NAME_KNOBS`; `buildTemplatePayload` (supports `call_permission_request` component + `VOICE_CALL` button); fixtures `tests/fixtures/meta/*.json` + README                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Webhook pipeline           | `webhooks.service.ts` (`receiveWebhook`, `eventKey`), `webhook-processor.ts`, `webhook-handlers.ts` (`WEBHOOK_HANDLERS`, `HandlerContext` hooks pattern: `inbox`, `templates`), `deferred-events.ts` (`listDeferred`, `markConsumed`); `account_update` handler (Phase 9) incl. the Phase 11 pricing-tier event                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Inbox (Phase 10 / 11)      | `src/modules/inbox/*` — `outbound.service.ts` `sendMessage` (interactive types, Phase 11 holds every non-note message, `chargeFor`), `outbound.schema.ts`, `send.job.ts`, `status.service.ts`, `conversations.service.ts` (`startConversation`, contact panel with **`callPermission: null` placeholder**), `inbox-json.ts`, `events.ts`, `contacts.ts` (match by `waId` / phone), `optout.service.ts`, `simulator.ts`; `src/modules/templates/*` (call permission template: `createCallPermissionTemplate`, purpose `call_permission`, `CALL_PERMISSION_BODY`; `send.service.ts` `loadSendableTemplate` / `prepareTemplateSend`)                                                                                                                                                                                                                                                                                                                                                                                  |
| WhatsApp channels          | `whatsapp-channel.model.ts` (`mode cloud_api / coexistence`, `status`, `metaPayer`, `messagingLimitTier`, `wabaId`, `phoneNumberId`, `pricingTier`), `whatsapp.service.ts` (`WhatsAppServiceHooks.onConnected`), `channel-json.ts`, `whatsapp-admin.service.ts` (`accountWhatsApp` detail incl. price override)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Realtime / RBAC / misc     | `src/core/realtime/events.ts` (`call.created`, `call.status`, `call.ended`, `call.transcript`, `call.dtmf` exist), topic auth for `call:<id>`, presence (`presence.changed`); `permissions.ts` (`calls.read`, `calls.trigger`, `calls.listen`, `calls.export`), `system-roles.ts` + snapshot + `syncSystemRoles()`; `createRateLimiter`; `env.ts` + env-docs test; `src/openapi.ts`; `scripts/db-seed.ts`, `seed-*.ts`, `dev-*.ts` patterns; `docs/samples/audio/welcome.wav` + `customer-silence.wav` written by `npm run fixtures:audio` (`scripts/make-audio-fixtures.ts`, `wavBuffer`)                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Frontend                   | `src/features/calls/audio/*` (`capture.worklet.ts`, `playback.worklet.ts`, `dsp.ts` `CALL_SAMPLE_RATE 24000` / `Resampler` / `Framer`, `engine.ts` `requestMicrophone` / `MIC_ERROR_TEXT` / `AudioPlatform`, `media-socket.ts`), `features/calls/tester/*` (`useWebCall`, `LiveCall`, `CallSetup`, `useCallTimer`), `features/calls/detail/RecordingPlayer.tsx`, `CallNowDialog`, `ContactCallsCard`, `RecentCallsCard`; `features/inbox/*` (ChatView header actions, `panel/` contact panel, `chat/MessageBubble.tsx`, `Composer.tsx`), `features/whatsapp/numbers/*` (`ChannelCard`, `ChannelDrawer`), `features/templates/*`, `features/whatsapp-billing/*`, `layout/Header.tsx`, `NotificationsBell`, fixtures `src/test/{calls,inbox,whatsapp,templates}.ts`, `fakeRealtime`, `renderWithProviders`, `mockViewport`                                                                                                                                                                                           |
| E2E                        | `e2e/helpers.ts`, `e2e/contacts.ts` (`inviteMember`), `e2e/whatsapp.ts`, `e2e/inbox.ts` (`InboxApi` with `get / post / patch / delete / postWithKey / fund / accountId / waitConversation / simulate / createContact / conversationOf / fakeSent`, `customerPhone(suffix)`, `connectNumber`, `openInbox`, `openConversation`, `bubble`, `expectTicks`), `e2e/templates.ts` (`TemplatesApi`, `superadminApi`, `adjustWallet`), `e2e/calls.ts` (Phase 7 call tester helpers), `playwright.config.ts` (Chromium fake mic `customer-silence.wav`, `FAKE_META_STATUS_DELAYS_MS`, `FAKE_META_TEMPLATE_REVIEW_MS: '1000'`), `E2E_FRONTEND_PORT=3150`                                                                                                                                                                                                                                                                                                                                                                      |

**Reference code:** AutoChatix (`/Users/lalitbansal/Documents/Autochatix`, **READ ONLY**, never copy credentials) has **no WhatsApp calling** — don't search it for Phase 12. Meta's docs (plan §1d) are the reference; the Asterisk / SIP guide is **not** used (SIP is Phase 18).

**Bugs to avoid** (typical WebRTC + calling mistakes):

- logging SDP / ICE candidates / DTLS fingerprints (they carry IPs and credentials);
- sending media before ICE + DTLS are ready, or **no media for 20 s** at the start (WhatsApp drops the call);
- going silent (no RTP / RTCP) during IVR waits → drop after ≈ 30 s;
- two SSRCs on the audio stream (Meta's relay overwrites SSRCs);
- answering a user call with a different SDP in `accept` than in `pre_accept` (the call fails);
- forgetting `terminate` when we hang up (billing accuracy);
- two agents answering the same call;
- timers not `unref()`'d / not cleared on shutdown (tests hang);
- dialing without re-checking Meta's permission (138006) or the request limits (138009).

---

## 1. LOCKED DECISIONS (exact literals — PHASE_12_PLAN §1 has the prose)

**Owner decisions:** plan §7 #1–#16. If the project lead has answered them by STEP 0, use the answers; otherwise **use the defaults** and record "defaults in use" in the plan changelog. Defaults:

1. Call markup **15 %** (`markupBps: 1500`), per-account override.
2. Calling rate card = Meta's INR **calling** CSV (superadmin import); placeholder **India `388_500` micros / min** (₹0.3885, third-party quote — "to confirm"), **OTHER `1_000_000` / min**, base tier only.
3. Platform fee per call minute **₹0** (both payers).
4. Place / answer: owner / admin / manager / agent (`calls.trigger` / `calls.answer`); viewers never; impersonators never.
5. **No** permission requests to STOP-opted-out contacts.
6. **Record** WhatsApp calls on our server with the account's recording notice (AI and human).
7. Agent calls use the **same calling window** as AI calls (`settings.callingWindow` ∩ TRAI 09:00–21:00); inbound unaffected.
8. Ring timeouts: BIC **45 s**, UIC team ring **30 s**.
9. Meta voicemail **off**.
10. Human-call transcripts **off** by default (account toggle `transcribeHumanCalls`).
11. Supervisors: **take over** AI calls only (no live listen in Phase 12).
12. New number default inbound route **`team`** (missed when nobody answers).
13. Call icon `DEFAULT`, **no country restriction**.
14. Max WhatsApp call **30 min** (`maxCallMinutes: 30`, hard cap 60 = `CALL_LIMITS.maxCallSecHard`).
15. Permission request body _"Kya hum aapko WhatsApp par call kar sakte hain? Aapke loan / account ke baare mein baat karni hai."_ (editable per number).
16. Plan B (PoC fails) = browser relay for human calls; AI WhatsApp calls → Phase 18. **The run stops at T12.1 and reports** — it does not switch to plan B on its own.

**Run-prompt refinements (locked now, recorded in the plan changelog at STEP 0):**

- **Module layout:**
  - `src/core/telephony/whatsapp/` — `codec.ts` (Opus interface + chosen implementation), `resample.ts` (48 ⇄ 24 kHz), `sdp.ts` (parse / build / validate, scrub helper that never returns the raw SDP for logs), `dtmf.ts` (RFC 4733 send / receive), `peer.ts` (werift `RTCPeerConnection` wrapper: ICE full controlling, DTLS client, ECDSA, `rtcp-mux`, bundle, one SSRC, port range), `leg.ts` (`WhatsAppCallLeg implements CallLeg`), `fake-user.ts` (`FakeWaUser`, dev / test only, imported only by the fake Meta client and tests).
  - `src/modules/whatsapp-calling/` — `settings.service.ts`, `permissions.service.ts`, `dial-guard.ts`, `calls.service.ts` (outbound / inbound orchestration), `routing.ts` (ring targets, first-wins), `bridge.ts` (`AgentLeg` + `BridgeScript`), `bus.ts` (call-control bus), `billing.ts` (call pricing + holds + settle), `webhooks.ts` (`createCallingHooks` for `HandlerContext`), `jobs.ts`, `calling.routes.ts`, `calling.schema.ts`, `calling.openapi.ts`, `simulator.ts`, `simulator-kinds.ts`, `json.ts` (views).
- **Leg rate `24_000`** (no `CallLeg` type change unless the PoC proves it necessary — then a deviation).
- **Call-control bus keys** (Redis, project prefix): `call:wa:owner:<waCallId>` → `<nodeId>` (TTL `WHATSAPP_CALL_LIMITS.ownerTtlSec`, refreshed every `heartbeatSec`); `call:wa:claim:<waCallId>` (`SET NX`, TTL 120 s); `call:wa:answer:<callId>` (first-wins `SET NX`, TTL 120 s); pub / sub channels `call:ctl:<nodeId>` and `call:ctl:inbound`; `nodeId = <hostname>:<pid>:<random>`. The same bus also routes **Phase 7 hangups** for every provider (closes the "409 from another server" gap) — `POST /calls/:id/hangup` publishes to the owner.
- **Webhook fast path:** `receiveWebhook` stores the event as today **and** for `field: 'calls'` publishes `{ eventId, waCallId, kind }` on the bus immediately (no queue wait); the worker still processes the stored event for the record (idempotent; the bus handler and the worker never both act on the same transition — state machine guards).
- **Phase 9 deferred `calls` events** (stored before Phase 12): marked consumed as `ignored_stale` by a one-off backfill at worker start — never replayed.
- **Permission source of truth:** Meta's `GET /{phone-number-id}/call_permissions` before every BIC and every request (cache `permissionCacheSec: 60` in Redis `call:wa:perm:<channelId>:<waId>`); our row is the UI state + history; on Meta API error → refuse (`WHATSAPP_CALL_PERMISSION_CHECK_FAILED`).
- **Billing:** new ledger type **`whatsapp_call_charge`**, ref type `call` (existing), usage kind `whatsapp_call`; engine functions **`holdForWhatsAppCall`**, **`extendWhatsAppCallHold`**, **`settleWhatsAppCall`**, **`releaseWhatsAppCallHold`** (own `loadWhatsAppCallHold`, root type `whatsapp_call_charge`; budget kind **`call`** — calls share the call budget); idempotency keys `wa-call-hold-<callId>`, `wa-call-extend-<callId>-<n>`, `wa-call-settle-<callId>`, `wa-call-release-<callId>`; AI usage of a WhatsApp AI call settles through the existing Phase 7 path (`holdForCall` / `settleCall` with `telephony: false`) — **two holds per AI call** (call price + AI), both settled at the end; the call-hold reaper (`call_charge`) and the WhatsApp message reaper must **ignore** `whatsapp_call_charge` (regression test); a new reaper step `billing.whatsapp_call_reap_holds` releases call holds older than `maxCallSecHard + 15 min` whose call is final.
- **Pulse math (pure, `src/core/billing/whatsapp-calls.ts`):** `pulses = ceil(durationSec / 6)`; `metaPerPulseMicros = ceilDiv(perMinuteMicros, 10)`; `sellingTotal = ceilToPaise(pulses × metaPerPulse × (10_000 + markupBps) / 10_000) + ceilToPaise(pulses × feePerPulse)`; fixed price override replaces `metaPerPulse × markup`; customer-pays → fee only. Tests with exact fixtures (0 s, 1 s, 6 s, 7 s, 56 s, 3,600 s).
- **Message type `call`** added to `MESSAGE_TYPES` (→ **17**); `interactive.type` values `call_permission_request` / `call_permission_reply` / `voice_call` parsed + rendered.
- **Contact identity:** contact `whatsapp.bsuid` (string, indexed per account) filled from `from_user_id` / `to_user_id`; match order phone → BSUID.
- **Fake Meta calling** lives in `fake.client.ts` (+ `core/telephony/whatsapp/fake-user.ts`); the fake user's WebRTC peer binds **only `127.0.0.1`**; timers `unref()`'d and cleared in `onShutdown('fake-meta-calls', …)`.

**Env (all in `env.ts` + `.env.example` + README table + tests):**

| Key                         | Type / default                                                                              | Production rule                        |
| --------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------- |
| `WA_MEDIA_ENABLED`          | bool, default `true` when `WHATSAPP_ENABLED`                                                | —                                      |
| `WA_MEDIA_PUBLIC_IP`        | IPv4, optional (dev: auto from the interface)                                               | **required** with `META_PROVIDER=meta` |
| `WA_MEDIA_PORT_MIN` / `MAX` | ints, default `40000` / `40999`, `MIN < MAX`, range ≥ 100                                   | —                                      |
| `WA_STUN_URLS`              | comma list of `stun:host:port`, default `stun:stun.l.google.com:19302`                      | —                                      |
| `WA_MEDIA_MAX_CALLS`        | int, default `50` (per process)                                                             | —                                      |
| `FAKE_META_CALL_DELAYS_MS`  | `"connect,ringing,accepted"` ints, default `100,200,800` (dev) / `off`→ immediate in vitest | must not be set                        |

**Limits (`WHATSAPP_CALL_LIMITS` in `src/config/limits.ts`, exact):**

```ts
export const WHATSAPP_CALL_LIMITS = {
  permissionRequestsPerDay: 1,
  permissionRequestsPerWeek: 2,
  temporaryPermissionDays: 7,
  connectedCallsPer24h: 100,
  unansweredNudge: 2,
  unansweredRevoke: 4,
  concurrentPerNumber: 1_000,
  initiationsPer24hPerNumber: 10_000,
  permissionCacheSec: 60,
  bicRingTimeoutSec: 45,
  uicRingTimeoutSec: 30,
  uicAnswerDeadlineSec: 30, // Meta: 30–60 s
  firstMediaWithinMs: 1_000, // Meta drops at ≈ 20 s
  keepAliveEveryMs: 20, // always send a frame (silence when idle)
  rtcpEverySec: 5,
  jitterBufferMs: 60,
  ownerTtlSec: 30,
  claimTtlSec: 120,
  pulseSec: 6,
  holdMinutes: 5,
  holdExtendMinutes: 5,
  lateTerminateGraceSec: 120,
  maxCallMinutesDefault: 30,
  requestBodyMax: 1_024,
  voiceCallButtonTextMax: 20,
  voiceCallTtlMinutesMax: 43_200,
  callHoursEntriesPerDayMax: 2,
  holidaysMax: 20,
  ringTargetsMax: 50,
  sdpMaxBytes: 16_384,
} as const;
```

**Error codes (+14 → 83; message texts exact; statuses):**

| Code                                        | HTTP | Message                                                                 |
| ------------------------------------------- | ---- | ----------------------------------------------------------------------- |
| `WHATSAPP_CALLING_DISABLED`                 | 409  | Calling is turned off for this WhatsApp number.                         |
| `WHATSAPP_CALLING_UNAVAILABLE`              | 409  | WhatsApp calling isn't available for this number.                       |
| `WHATSAPP_CALLING_RESTRICTED`               | 409  | WhatsApp has paused calling on this number for now.                     |
| `WHATSAPP_CALL_PERMISSION_MISSING`          | 409  | This customer hasn't allowed calls from this number yet.                |
| `WHATSAPP_CALL_PERMISSION_CHECK_FAILED`     | 502  | Couldn't check the customer's call permission with WhatsApp. Try again. |
| `WHATSAPP_CALL_PERMISSION_LIMIT`            | 429  | You can ask this customer for call permission again later.              |
| `WHATSAPP_CALL_PERMISSION_EXISTS`           | 409  | This customer already allows calls.                                     |
| `WHATSAPP_CALL_PERMISSION_TEMPLATE_MISSING` | 409  | Create and get the call permission template approved first.             |
| `WHATSAPP_CALL_LIMIT_REACHED`               | 429  | WhatsApp's call limit for this customer is reached. Try again later.    |
| `WHATSAPP_CALL_ACTIVE`                      | 409  | A call with this customer is already in progress.                       |
| `WHATSAPP_CALL_TAKEN`                       | 409  | Someone else already answered this call.                                |
| `WHATSAPP_CALL_NOT_RINGING`                 | 409  | This call isn't ringing any more.                                       |
| `WHATSAPP_CALL_FAILED`                      | 502  | WhatsApp couldn't connect the call.                                     |
| `CALL_AGENT_UNAVAILABLE`                    | 409  | No team member is available to take the call.                           |

Meta code mapping (`errors.ts` `mapCallError`, scrubbed): 138000 → `WHATSAPP_CALLING_DISABLED`; 138001 → `WHATSAPP_CALL_FAILED` (reason "The customer can't take WhatsApp calls"); 138002 / 138005 → `RATE_LIMITED` (retry-after when given); 138003 → `WHATSAPP_CALL_ACTIVE`; 138004 / 138007 / 138019–138023 → `WHATSAPP_CALL_FAILED` (reason per code); 138006 → `WHATSAPP_CALL_PERMISSION_MISSING`; 138009 → `WHATSAPP_CALL_PERMISSION_LIMIT`; 138012 → `WHATSAPP_CALL_LIMIT_REACHED` (next time from `error_data`); 138013 / 138015 / 138018 → `WHATSAPP_CALLING_UNAVAILABLE`; 138014 → `WHATSAPP_CALLING_RESTRICTED`; 138017 → `WHATSAPP_CALL_PERMISSION_EXISTS`; 131026 (permission request / voice_call to an old client) → message failed reason "Customer's WhatsApp is too old"; 131030 → `WHATSAPP_CALL_FAILED` ("Test number not on the allowed list"); 131044 → `WHATSAPP_CALL_FAILED` ("Payment method missing at Meta"); 131055 → `WHATSAPP_CALLING_UNAVAILABLE` ("SIP is enabled on this number"); 613 → retry once after 1 s, else `WHATSAPP_CALL_PERMISSION_CHECK_FAILED`.

**Audit actions (+9 → 127):** `whatsapp.calling_settings_updated`, `whatsapp.call_permission_requested`, `whatsapp.call_permission_granted`, `whatsapp.call_permission_declined`, `whatsapp.call_permission_revoked`, `call.whatsapp_started`, `call.whatsapp_answered`, `call.whatsapp_transferred`, `whatsapp.calling_restricted` (meta: ids, kinds, counts — never phones, names, SDP).

**Notification types (+5 → 31):** `call.whatsapp_missed` (ring list; link `/inbox/<conversationId>`), `whatsapp.call_permission_granted` (requester; link to the chat), `whatsapp.call_permission_declined` (requester), `whatsapp.calling_restricted` (owners / admins; email yes; link `/whatsapp/numbers`), `whatsapp.call_permission_revoked` (requester + managers; after 4 unanswered). Titles ≤ 120 chars, no customer data (the contact is named only by "a customer" / the number label).

**WS events (+4):** `whatsapp.call.incoming` `{ callId, conversationId, contactId, channelId, ringUntil }`, `whatsapp.call.taken` `{ callId, byUserId }`, `whatsapp.call.ended_ringing` `{ callId, reason }`, `whatsapp.call_permission.updated` `{ contactId, channelId, status, expiresAt }`; `call.status` / `call.ended` reused with `provider: 'whatsapp'`; `whatsapp.channel.updated` adds `calling` summary fields.

**Permissions (+2):** `calls.answer` (owner / admin / manager / agent), `whatsapp.calling.manage` (owner / admin). Roles snapshot updated; `syncSystemRoles()` in migration 0013.

**Jobs (`whatsapp` queue unless noted):** `whatsapp.call_permission_sweep` (hourly at :07 — expire temporary rows, unansweredStreak never reset by it), `whatsapp.calling_settings_sync` (daily 04:20 IST + after connect + on `account_settings_update`), `whatsapp.calls_backfill_ignore` (worker start, one-off), `billing.whatsapp_call_reap_holds` (`billing` queue, every 30 min), `billing.whatsapp_call_reconcile` only if Meta exposes call analytics (T12.3 checks; else not created — deviation note).

**Rate limiters:** `rl:wa-call:` 10 / min / user (`POST /whatsapp/calls`), `rl:wa-call-perm:` 20 / h / user, `rl:wa-calling-settings:` 10 / min / number.

**Fake Meta number knobs (`FAKE_CALL_KNOBS`, customer number ending):** `00020` answers after 2 s · `00021` rejects · `00022` never answers · `00023` permission reply accept (temporary) · `00024` accept permanent · `00025` decline · `00026` old client (131026) · `00027` answers then hangs up after 5 s · `00028` answers and presses `1` 3 s after media starts · `00029` connect fails 138004 · `00030` Meta says no permission (138006) whatever our row says. Other numbers: answer after `FAKE_META_CALL_DELAYS_MS`, stay until hung up; permission requests to other numbers get **no** reply (simulator kinds reply).

**Simulator kinds (+12 → 70):** `user_call`, `user_hangup`, `user_dtmf` (`digit`), `permission_reply_accept`, `permission_reply_permanent`, `permission_reply_reject`, `permission_expire`, `calling_restricted`, `calling_unrestricted`, `calling_settings_changed`, `call_tier_update`, `run_permission_sweep`. Permission per kind: `user_*` / `permission_*` → `inbox.reply`; `calling_*` / `call_tier_update` → `whatsapp.manage`; `run_*` → `whatsapp.manage`.

**API (`/api/v1`, OpenAPI tag `WhatsApp calling`):** exactly plan §1o. Detail views never include SDP, ICE data or phones of other users.

---

## 2. RULES OF ENGAGEMENT

1. **No questions / no permission requests.** Safe, convention-consistent choice → report as a deviation and add it to the plan changelog. **Exception: T12.1 PoC failure → stop and report.**
2. **Git:**
   - Branch `feature/phase-12-whatsapp-calling` in both repos. **Never commit on `main`.**
   - One commit per task per repo (Conventional Commit + tag), committed **sequentially, one repo at a time**.
   - Hooks must pass: **no `--no-verify`**, no `--force`. **No push / merge / tag.**
   - Footer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
   - Commit body: **no line may start with `word:`**. Write the message to a file and use `git commit -F`.
3. **Verify after every task — each command separately, read the output + exit code.** **Never chain `git commit` after checks with `;` or `&&`.**
   - Backend: `npm run lint` · `npm run format:check` · `npm run typecheck` · `npm run test:coverage -- --maxWorkers=2` · `npm run build` · `npm run openapi:check` (stage `openapi/openapi.json` first).
   - Frontend: `npm run lint` · `npm run format:check` · `npm run typecheck` · `npx tsc -p tsconfig.e2e.json --noEmit` · `npm run test:coverage -- --maxWorkers=2` · `npm run build`. From T12.11 on also `npm run e2e`: infra up, this project's dev servers stopped, `E2E_FRONTEND_PORT=3150`, **run Playwright from the frontend folder**.
   - Long runs in the background with `caffeinate -dims`; never poll them with sleeps.
4. **Coverage gates stay green.** Add tests; never lower thresholds; **never raise test timeouts** (testTimeout 30 s, hookTimeout 120 s) — use `FakeClock` / fake timers for ring timeouts, sweeps, holds; loopback media tests use **short** real clips (≤ 3 s of audio).
5. **Tests in every task:**
   - unit + integration (supertest + real Mongo replica set + Redis with a unique prefix);
   - **tenant isolation** for every `:id` route (another account's call / permission / channel → 404, never listed);
   - permission matrix per role (owner / admin / manager / agent / viewer + superadmin + impersonating superadmin);
   - suspended account (writes 403); `WHATSAPP_ENABLED=false` (503); calling disabled (409).
6. **Money hard rules:**
   - every call charge goes **only** through engine functions — the money-writes test lists `whatsapp_call_charge`;
   - integer micros; idempotency keys per call (§1);
   - settle with Meta's `duration` (fallback our measured connected time after `lateTerminateGraceSec`, flagged `durationSource: 'ours'`);
   - not answered / rejected / failed → **0 pulses**, hold released;
   - UIC → no Meta charge;
   - customer-pays → never Meta's price;
   - `expectWalletConsistent` after every billing scenario.
7. **Media / customer data rules:**
   - **SDP, ICE ufrag / pwd, candidates, DTLS fingerprints are never logged, stored, audited, put in job data, WS events or error messages** (lengths / counts only). A pino-capture test runs a full BIC + UIC with distinctive strings and greps for `a=fingerprint`, `ice-pwd`, `a=candidate`, the test phones and names → 0.
   - Audio only in memory + the recording file; DTMF digits never logged (Phase 7 rule).
   - Customer phones / names never in logs, audit, notifications, events (ids only).
8. **No network outside the machine in tests.** Graph client against the local stub server; the fake everywhere else; WebRTC loopback binds **`127.0.0.1` only**; STUN disabled in tests (host candidates only).
9. **Every new env var** → `env.ts` + `.env.example` (`KEY=`) + README env table + a rule test.
10. **OpenAPI:** every route registered and its schemas imported in `src/openapi.ts` → `gen:openapi` → commit `openapi/openapi.json` with the task; frontend `gen:api` at T12.9 and whenever the spec changes.
11. **Docs in the same commit:** src/README.md rows, data-model.md §2.10, websocket.md, audit.md, error-codes.md, api.md §14f, security.md, compliance notes as relevant.
12. **Docker:** only `npm run infra:*` (`cav-*`); gitleaks / actionlint via one-off `docker run --rm`; never touch other containers or volumes.
13. **Real bugs** found by tests / manual checks / E2E:
    - reproduce, then prove the regression test fails without the fix;
    - fix in a separate `fix(<area>): …` commit (except the locked reaper filter for `whatsapp_call_charge`, part of T12.8);
    - note it in the report and the plan changelog.
14. **Native / WASM dependencies:** pin exact versions; the Opus codec choice is made in T12.1 and recorded in ADR 0040; CI (`.github/workflows`) must build it — if a native module, add the build step and verify with actionlint; fresh-clone `npm ci` must work on macOS (dev) and Linux (CI).
15. **Frontend lessons (Phases 5–11):**
    - Fast-refresh rule: non-component exports in `.ts` files; no setState in effects for derived state; never two siblings with the same `key`; long toolbars wrap.
    - A view of server state listens to the WS event **and** polls while not final (call ringing states: poll `GET /calls/:id` every 2 s while `ringing` / `queued`).
    - Hooks that grab browser resources (mic, audio context, notifications, ring audio) are strict-mode safe: attempt tokens, release on cleanup (Phase 10 recorder bug).
    - Full reloads end an impersonation → E2E navigates client-side.
    - Dev-only UI also checks `fakeProvider`.
    - MUI: Select empty value needs `displayEmpty`; Tooltip around an icon with `titleAccess` needs `describeChild`; dialogs → `findByRole`; Switch role is `switch`.
    - E2E: wait for async webhook effects with `expect.poll`, never fixed sleeps (Phase 11 lesson: `waitConversation`).
16. **Never kill other projects' processes** (port 3100 belongs to another project).
17. **Mongoose 9 / zod v4:** `returnDocument: 'after'`, `updatePipeline: true`, `toObject({ transform: false })`, `z.looseObject` for Meta objects; no dynamic `import()` in backend tests.
18. **Timers / sockets:** every UDP socket, peer and timer is closed in `onShutdown` and in test teardown; a test helper asserts no open UDP handles after each media test file.

---

## 3. RESUME SAFETY

- Both repos: `git branch --show-current` → `feature/phase-12-whatsapp-calling` (the frontend from T12.9 on); `git log --oneline -25`; continue after the last `[P12-…]` commit.
- `npm run infra:up` → `npm ci` (both) → `npm run db:migrate` (dev DB) → lint → typecheck → `test:coverage` green before continuing.
- Batch 1 requires `[P12-PROMPT]`; Batch 2 requires `[P12-B1-DONE]`; Batch 3 requires `[P12-B2-DONE]`. If one is missing, stop and report.
- **T12.1 not passed** (no ADR 0040 with "PoC passed") → nothing after T12.1 starts.
- A half-done task (uncommitted files) → read `git status` / `git diff`, finish, verify, commit. Never discard work without reading it.

---

## STEP 0 — P12-SETUP (before T12.1)

1. Backend: `git branch --show-current` must be `feature/phase-12-whatsapp-calling`, last commit `[P12-PLAN]` (`e785293`). `git status` should show only `docs/prompts/PHASE_12_PROMPT.md` (untracked) and `docs/phases/PHASE_12_PLAN.md` (modified — small path fixes by the planning session: the fake user's tone clip); anything else → stop and report.
2. If the project lead's §7 answers exist (in the plan or the conversation), write them into plan §7 ("Answered by the project lead on <date>"); else add the changelog line "Defaults in use for §7 #1–#16 (owner answers pending)".
3. Plan changelog line "Run prompt prepared — refinements locked:
   - module layout `core/telephony/whatsapp/*` + `modules/whatsapp-calling/*`;
   - leg rate 24 kHz;
   - call-control bus keys + webhook fast path + Phase 7 hangup routing;
   - deferred `calls` events ignored;
   - Meta's permission API before every dial / request (60 s cache);
   - ledger `whatsapp_call_charge` + four engine functions + pulse math + two holds for AI calls + reaper filters;
   - message type `call`, BSUID on contacts;
   - fake knobs `00020`–`00030`, 12 simulator kinds;
   - error codes +14, audit +9, notifications +5, WS +4, permissions +2"

   (this prompt's §1 wins where the plan differs).

4. Commit 1: `docs/phases/PHASE_12_PLAN.md` (the planning-session fixes + steps 2–3) → `docs(plans): lock phase 12 decisions [P12-PLAN]` (run `npm run format:check` first).
5. Commit 2: `docs/prompts/PHASE_12_PROMPT.md` → `docs(prompts): add phase 12 run prompt [P12-PROMPT]`.

---

# ═══════════ BATCH 1 — PoC gate + calling foundation (T12.1 → T12.4) ═══════════

## T12.1 — PoC (gate) → `feat(calls): add the whatsapp call media proof of concept [P12-T12.1]`

1. **Dependencies:** add `werift` (exact pinned version, latest stable as of the run day ≥ 2 weeks old) and the Opus codec candidates; try in this order: `@discordjs/opus` (native) → `opusscript` (WASM / asm.js). Keep both behind `src/core/telephony/whatsapp/codec.ts` (`createOpusCodec({ sampleRate: 48000, channels: 1, frameMs: 20 })` → `{ encode(pcm48: Int16Array): Buffer; decode(packet: Buffer): Int16Array; destroy() }`).
2. **`resample.ts`:** 48 ⇄ 24 kHz (exact 2:1 with a small FIR low-pass), unit tests (tone 440 Hz / 1 kHz frequency error < 1 %, amplitude ± 1 dB, no clicks at frame joins).
3. **`peer.ts` (first version):** werift peer as ICE **full + controlling**, DTLS **client** (`setup:active` in our answer / `actpass` in our offer as Meta's samples), ECDSA P-256 certificate per process, `rtcp-mux`, `BUNDLE`, Opus PT 111 `48000/2` with `minptime=10;useinbandfec=1`, `ptime:20`, telephone-event PT 126 `8000`, **one SSRC**, UDP bound to `127.0.0.1` in tests / `0.0.0.0` + `WA_MEDIA_PUBLIC_IP` candidates in prod, port range.
4. **`scripts/poc-wa-call.ts`** (dev tool, `npm run poc:wa-call`): two peers in one process — ours and a **Meta-like ICE-lite peer** built from Meta's documented SDP shape (fixture `tests/fixtures/meta/calls-sdp-answer.txt` written from the reference page: `a=ice-lite`, `a=setup:active`, host candidate, Opus + telephone-event) — exchange SDP in memory; send a 1 kHz tone one way, 440 Hz the other; detect both (Goertzel); send DTMF `1`, `2`, `3`; 30 s of silence with keep-alive; terminate; print setup time, CPU %, RSS, added latency per direction, jitter.
5. **Measure** 1, 10 and 20 parallel calls (targets plan §1b: CPU ≤ 3 % of one core per call, ≤ 30 MB per call, added latency ≤ 40 ms, setup ≤ 500 ms on loopback).
6. **Real Meta (only if a test number with calling exists in `.env` — normally not):** never print tokens; otherwise write the exact steps into the plan changelog for Phase 13.
7. **ADR 0040 — WhatsApp call media:** context, options (werift + Opus native / WASM, browser relay, SIP media server), decision, measured numbers, keep-alive rules, NAT / ports, plan B condition, consequences. Status `accepted` only if the PoC passed.
8. **Tests (vitest, loopback, short):** tone both ways (2 s), DTMF 3 digits, 5 s silence keep-alive (fake clock where possible, real UDP), close → no open handles; codec round trip; resampler.
9. **Exit criteria:** 20 / 20 loopback runs of the tone + DTMF test green (a script loop, numbers in the report); CPU / memory / latency within targets. **Fail → do not commit code beyond the PoC; commit the ADR as `proposed` with the numbers and STOP with a report (plan B needs the project lead).**

## T12.2 — Models, migration 0013, limits, catalogue → `feat(calls): add whatsapp calling models with catalogue [P12-T12.2]`

1. **Re-check Meta's calling pages** (plan §1d list) — differences → plan changelog + adjust §1 literals (record as deviation).
2. **Models:**
   - `whatsapp-channel.model.ts` `calling` sub-document (plan §1c, validators: HHMM, ≤ 2 entries / day, no overlaps, ≤ 20 holidays, ISO-2 countries, ring targets ≤ 50);
   - `whatsapp-call-permission.model.ts` (plan §1c + indexes);
   - Call additions (`provider: 'whatsapp'`, `mode`, `agentUserId`, `whatsapp {…}`, `billing.whatsapp {…}`, end reasons, unique partial `whatsapp.waCallId`);
   - Message `type: 'call'` + `call {…}`; interactive kinds; contact `whatsapp.bsuid` (index `accountId + whatsapp.bsuid`, partial);
   - user `callAvailability`; account `settings.whatsappCalling` (defaults §1 #6 / #10 / #14 + notice text from the Phase 7 recording notice);
   - WhatsApp rate card `kind: 'messaging' | 'calling'` (existing rows default `messaging`), calling market fields; platform settings `whatsappCalling`; account `whatsappCallingBilling`;
   - ledger type `whatsapp_call_charge`, usage kind `whatsapp_call`.
3. **Migration `0013-whatsapp-calling.ts`:** enums / indexes; channel `calling` defaults (`disabled`; `unavailable` + reason `coexistence` for coexistence numbers); placeholder calling rate card (IN `388_500`, OTHER `1_000_000`, note "Placeholder — replace with Meta's INR calling rate card"); platform settings defaults; `syncSystemRoles()` (+2 permissions); down migration; tests up / down.
4. **Config:** `WHATSAPP_CALL_LIMITS` (exact §1), env (§1) + vitest env (`FAKE_META_CALL_DELAYS_MS=off`, `WA_STUN_URLS=` empty), prod rules.
5. **Catalogue:** error codes (+14 → 83), audit (+9 → 127), notification types (+5 → 31) with titles / links / email flags, WS events (+4) + `websocket.md`, permissions (+2) + roles snapshot, job names + schedules, `MESSAGE_TYPES` 17.
6. **Docs:** data-model §2.10, error-codes, audit, websocket, src/README rows.
7. **Tests:** `tests/calls-wa/catalogue.test.ts` (move today's totals from `tests/templates/catalogue.test.ts` the way Phase 11 moved Phase 10's), `tests/calls-wa/models.test.ts` (validators, indexes, tenant scope), `tests/db/phase12-migrations.test.ts`.

## T12.3 — Meta core → `feat(meta): add whatsapp calling, call settings and call permissions to the meta client [P12-T12.3]`

1. **Graph methods** (`MetaClient` + `graph.client.ts`, retries + scrubbing; SDP bodies passed through but **never** in logs / error data):
   - `startCall(token, phoneNumberId, { to, sdpOffer, bizOpaque })` → `{ waCallId }`;
   - `preAcceptCall`, `acceptCall` (`sdpAnswer`, `bizOpaque?`), `rejectCall`, `terminateCall`;
   - `getPhoneSettings(token, phoneNumberId)` (calling block + restrictions), `updateCallingSettings(token, phoneNumberId, calling)`;
   - `getCallPermissions(token, phoneNumberId, waId)` → `{ status, expiresAt, actions[] }`;
   - interactive `call_permission_request` + `voice_call` payload builders in `payloads.ts` (body text; `display_text`, `ttl_minutes`, `payload`); template `voice_call` button parameters in `buildTemplatePayload`.
2. **Error mapping** `mapCallError` (§1).
3. **Schemas** (`call-schemas.ts`): `calls` value (connect: `id`, `from`, `to`, `from_user_id`, `to_user_id`, `timestamp`, `direction`, `session { sdp_type, sdp }`, `cta_payload`, `deeplink_payload`, `contacts[]`; statuses: `type: 'call'`, `status RINGING / ACCEPTED / REJECTED`, `recipient_id`, `biz_opaque_callback_data`; terminate: `status COMPLETED / FAILED`, `start_time`, `end_time`, `duration`, `errors[]`, payloads); `interactive.call_permission_reply` (`response`, `is_permanent`, `expiration_timestamp`, `response_source`, `context.id`); `account_settings_update` (`phone_number_settings { phone_number_id, calling }` — tolerate upper / lower case keys); calling `account_update` events (`ACCOUNT_VIOLATION` / `ACCOUNT_RESTRICTION` with the calling types). **Re-check field names on the run day.**
4. **Fixtures** from Meta's documented samples: `calls-connect-bic.json`, `calls-connect-uic.json`, `calls-status-ringing.json`, `-accepted.json`, `-rejected.json`, `calls-terminate-completed.json`, `-failed.json`, `call-permission-reply-temporary.json`, `-permanent.json`, `-reject.json`, `-automatic.json`, `account-settings-update.json`, `account-update-calling-restriction.json`, `graph-call-permissions.json`, `graph-phone-settings.json`, SDP text fixtures (Meta-like answer / offer) + README rows with source pages.
5. **`WEBHOOK_FIELDS` + `account_settings_update`**; setup guide subscription list.
6. **Fake Meta calling** (`fake.client.ts`): Graph calling methods (state in Redis + in-memory peers), `FakeWaUser` (`core/telephony/whatsapp/fake-user.ts`: werift peer on 127.0.0.1, plays `docs/samples/audio/customer-tone.wav` (440 Hz, 3 s — **add it and `agent-tone.wav` (1 kHz, 30 s) to `scripts/make-audio-fixtures.ts` in this task** and commit the generated files), Goertzel tone detector + level meter for "heard", sends RFC 4733 digits, hangs up), knobs (§1), settings GET / POST + `account_settings_update` webhook, `call_permissions` GET from fake state + limits (1 / day, 2 / week, 100 connected / 24 h, 4 unanswered → revoke), permission request sends (→ reply webhook by knob), `user_call` (fake user offers → our connect webhook), terminate webhooks with `duration` measured from ACCEPTED, `GET /dev/meta/calls` data (`heardTone`, `heardLevel`, `dtmfSent`, `durationSec`).
7. **Tests:** stub-server test per Graph call (path, body, errors, retries, **no SDP in logs**), fake per knob, schemas per fixture, payload builders.

## T12.4 — `WhatsAppCallLeg` + call-control bus → `feat(calls): add the whatsapp call leg and call control bus [P12-T12.4]`

1. **Leg** (`leg.ts`, plan §1h): implements `CallLeg`; offer / answer creation via `peer.ts`; inbound RTP → jitter buffer → Opus decode → 48 → 24 kHz → `onAudio` frames; outbound `play` through the Phase 7 `Pacer` → 24 → 48 kHz → Opus → RTP (20 ms), **silence frames whenever idle** (`keepAliveEveryMs`), RTCP SR every `rtcpEverySec`; DTMF receive (RFC 4733 end bit, dedupe by timestamp) / send; `clearAudio` (barge-in); `onStatus` (ringing → answered → ended); `hangup(cause)` → Graph `terminate` (always, idempotent) → close peer; `transfer()` → in-app transfer callback (T12.7); `notify` no-op; metrics (setup ms, RTT, loss %, jitter ms) stored on the call at the end.
2. **Bus** (`modules/whatsapp-calling/bus.ts`): node id, owner registry with TTL refresh, publish / subscribe (dedicated Redis subscriber connection), inbound claim with capacity check (`WA_MEDIA_MAX_CALLS`, `CALL_LIMITS.concurrentPerProcess`), handler registry per `waCallId`; **cross-process hangup for every call provider** (`POST /calls/:id/hangup` → owner via `call:ctl:<node>`, 202 when forwarded; still 404 / 409 for unknown / final calls).
3. **Webhook fast path** in `receiveWebhook` for `field: 'calls'` (after storing; never blocks the 200 to Meta; failure to publish → logged with ids, the worker path still works).
4. **Deferred `calls` backfill** → `ignored_stale`.
5. **Owner loss:** a node that stops refreshing → after `ownerTtlSec` the call is marked `failed` / `server_shutdown` by the maintenance sweep and a surviving node sends Meta `terminate`.
6. **Tests:**
   - loopback media suite (`tests/calls-wa/leg-media.test.ts`): tone both ways, DTMF both ways, 5 s idle keep-alive (frames counted), barge-in (`clearAudio` stops outbound within one frame), hangup both sides, 10 % packet loss (tone still detected), 10 parallel legs, no open handles;
   - bus (`tests/calls-wa/bus.test.ts`): two `CallManager` instances on one Redis — events reach the owner, inbound claim exactly once with 3 nodes racing, cross-process hangup, owner loss sweep;
   - fast path + worker idempotency (the same `terminate` via both paths acts once).

## P12-B1-DONE — checkpoint → `docs: mark phase 12 batch 1 complete [P12-B1-DONE]`

1. Full backend verify (each command separately).
2. `npm run dev:calls-wa -- --poc` (new script, first version): dev server + fake Meta → fake user BIC on loopback: tone both ways + DTMF → printed numbers.
3. Log grep of that run (no `a=fingerprint`, `ice-pwd`, `a=candidate`, phones).
4. Plan changelog (Batch 1 done, PoC numbers, deviations) + CHANGELOG `Phase 12 · Batch 1` + tracker ticks.

---

# ═══════════ BATCH 2 — Settings, permissions, calls, billing, API (T12.5 → T12.8) ═══════════

## T12.5 — Calling settings + permissions → `feat(calls): add whatsapp calling settings and call permissions [P12-T12.5]`

1. **`settings.service.ts`:** `getCalling(channel)` (ours + Meta GET, merged), `updateCalling(channel, patch)` (validate exactly like Meta: `HHMM`, open < close, ≤ 2 per day, no overlaps, non-empty weekly when hours on, holidays ≤ 20, future dates, `YYYY-MM-DD`, known IANA timezone; status / icon / countries / callback / inbound route / ring list / ring timeout / AI program runnable) → Meta POST (only Meta's fields) → store → audit → WS `whatsapp.channel.updated`; unavailable reasons (coexistence, BIC country, messaging limit < 2,000 from `messagingLimitTier`, not connected); restrictions from GET + `account_update`; daily sync job; `account_settings_update` handler (refresh).
2. **`permissions.service.ts`:** `statusFor(channel, contact)` (row + Meta API with the 60 s cache); `request(actor, channel, contact, body?)` (plan §1e steps 1–6 in order; interactive in-window via Phase 10 `sendMessage` type `interactive` kind `call_permission_request`; template outside via Phase 11 template send with the WABA's approved `call_permission` template — missing → `WHATSAPP_CALL_PERMISSION_TEMPLATE_MISSING`); `onReply(event)` (accept temporary / permanent, reject, automatic callback via `context.id` = missed call id); `onCallOutcome(callId, answered)` (streak, revoke at 4, nudge warning at 2); sweep (expire); history ≤ 30; WS `whatsapp.call_permission.updated`; bells; audit.
3. **Inbox contact panel** `callPermission` (replaces `null`): `{ status, expiresAt, canCall, canRequest, nextRequestAt, reason }` (reason codes from the dial guard).
4. **Bubbles:** request bubble state (`sent → answered / expired / failed 131026`), reply bubble.
5. **Tests:** every settings rule (table-driven with Meta's rules), Meta sync both ways, unavailable reasons, restrictions; permission: both request kinds, counters (ours) vs Meta's `can_perform_action`, every reply variant, automatic callback, expiry sweep (fake clock), streak + revoke, opted-out / DND / blocked refusals, panel output, WS / bells / audit without phones.

## T12.6 — Outbound calls → `feat(calls): add business-initiated whatsapp calls for agents and ai [P12-T12.6]`

1. **`dial-guard.ts`** — plan §1e rules 1–7 in order; returns `{ ok } | { code, reason, nextAt? }`; used by the API, the contact panel and (later) campaigns.
2. **`calls.service.ts` outbound:** `startOutbound(actor, { channelId, contactId, mode, program })` → guard → Call row `queued` (`provider whatsapp`, `whatsapp.direction BUSINESS_INITIATED`, `bizOpaque = callId`) → holds (call price `holdMinutes`; AI calls + Phase 7 AI hold) → leg → Graph `connect` → owner registry → statuses (`RINGING` → `ringing`; `REJECTED` → `rejected_by_customer`; `ACCEPTED` → `in_progress`) → ring timeout `bicRingTimeoutSec` → `terminate` + `not_answered` → `ACCEPTED`:
   - **human:** wait for the agent's media socket (`AgentLeg`, `CALL_LIMITS.readyTimeoutSec`; the agent opened it when pressing Call) → `BridgeScript` (audio both ways through the server, recording both channels, mute, hold with a hold clip, keypad → RFC 4733 to the customer, agent hang up);
   - **AI:** Phase 7 `CallSession` with the flow / agent script (recording notice, DTMF from the leg, barge-in, transfer → T12.7).
   - End (any side / max duration `maxCallMinutes` / wallet empty: AI polite end, human 30 s warning then end) → `terminate` → settle (T12.8 math; T12.6 uses the engine functions with the placeholder card) → Call final → `call` message bubble in the conversation (start conversation if missing, Phase 10) → WS → bells (missed only for inbound) → audit → permission `onCallOutcome`.
3. **`bridge.ts`:** `AgentLeg` = a `WebCallLeg` attached through `/ws/media` with a ticket for `callId` + the agent's user; `BridgeScript` implements the Phase 7 `CallScript` shape (no AI), mixes nothing (straight pass-through) except the hold clip and the recording notice at the start.
4. **Call buttons:** `POST /whatsapp/messages/voice-call-button` is **not** a new route — `sendMessage` accepts `interactive.kind: 'voice_call'` (`displayText`, `ttlMinutes`, `payload`) and templates with a `VOICE_CALL` button get `ttl_minutes` / `payload` parameters; `cta_payload` / `deeplink_payload` stored on inbound calls.
5. **Tests:** agent BIC happy path (loopback audio both ways via the fake user + a test `AgentLeg` feeding a tone), AI BIC (Loan recovery flow, knob `00028` presses 1 → Paid), rejected (`00021`), no answer (`00022`, fake clock), hang up after 5 s (`00027`), connect failure (`00029`), Meta no permission (`00030` → 409 mapped, hold released), wallet empty, DND, opted out, outside the calling window, concurrency limits, duplicate active call, cross-process hangup, bubbles, permission streak.

## T12.7 — Inbound calls → `feat(calls): add user-initiated whatsapp calls with team ring and ai routing [P12-T12.7]`

1. **Claim** (bus) → contact / conversation (phone → BSUID → create) → Call row `ringing` (inbound) → pre-checks (account active, calling enabled, our inbound hours / Meta hours, AI route wallet) → refuse = `reject` + missed bubble.
2. **`pre_accept`** with our answer SDP immediately; the same SDP for `accept` (stored in memory on the leg; mismatch impossible by construction — test).
3. **Routing** (`routing.ts`):
   - `team` → ring targets (`calls.answer`, `callAvailability: available`, online, ring list, max 50) → `whatsapp.call.incoming` → `POST /whatsapp/calls/:id/answer` first-wins (`SET NX`) → others `whatsapp.call.taken` → the winner's media socket → `accept` → bridge; `POST /whatsapp/calls/:id/decline` removes that user (all declined → missed);
   - `ai` → `accept` → Phase 7 session;
   - `ai_then_team` → AI first; transfer (agent tool `transfer_to_human` / flow transfer step) → ring the team with a hold clip to the customer → first agent → bridge replaces the AI script → audit `call.whatsapp_transferred` → no agent within `uicRingTimeoutSec` → back to AI with the line "Abhi koi team member free nahi hai…" (or end, per the flow's transfer failure exit).
4. **Ring timeout** `uicRingTimeoutSec` (< Meta's 30–60 s) → `reject` → `missed` bubble + `call.whatsapp_missed` bell to the ring list.
5. **Callback permission** (Meta setting on) → reply webhook `response_source: automatic` handled by T12.5.
6. **Tests:** every route; races (two agents answer at once → one wins; customer hangs up while ringing; `terminate` before the claim; answer after timeout → `WHATSAPP_CALL_NOT_RINGING`); outside hours; wallet empty on the AI route; transfer success / failure; missed calls; BSUID-only caller (no phone); payloads stored.

## T12.8 — Billing, API, dev tools, hardening, docs → `feat(calls): add whatsapp call charges, api and dev tools [P12-T12.8]`

1. **Billing:** `src/core/billing/whatsapp-calls.ts` (pure pulse math, §1); engine functions (§1) + money-writes; holds at dial + extension (session tick) + settle with Meta's `duration` + late terminate (`lateTerminateGraceSec`, `durationSource`) + release; UIC no Meta charge; customer-pays fee only; AI usage via Phase 7; **reaper filters** (Phase 4 call reaper + Phase 11 message reaper ignore `whatsapp_call_charge`, regression tests proven failing first, **inside this commit**); `billing.whatsapp_call_reap_holds`; calling rate card import / save / history (CSV columns `Market, Currency, Per minute` + optional tier columns; tolerant headers; INR only), account override, platform settings, margin rows `kind: 'call'`; wallet `GET /wallet/rates` adds `whatsappCalling.markets[].perMinuteMicros` (selling); ledger lines + breakdown (Meta cost / markup / fee superadmin-only like Phase 11).
2. **Routes + OpenAPI** (plan §1o), rate limiters, impersonation read only, WhatsApp-off 503, calling-off 409, `PATCH /users/me/call-availability`.
3. **Simulator** (+12 kinds) + `POST /dev/meta/calls/user-call`, `GET /dev/meta/calls`; **seed** (Demo Finance: calling enabled on the demo number, 2 permissions, 3 past calls with tone recordings, ledger lines); **`npm run dev:calls-wa`** (enable calling → request permission (`00023`) → agent-less AI call with DTMF (`00028`) → inbound team ring (simulated answer) → missed call → prints wallet lines).
4. **Hardening** (`tests/calls-wa/hardening.test.ts`, numbers recorded): 50 concurrent loopback calls with recording (CPU / memory sampled), 1,000 permission replies, 200 calls × 10 webhooks in mixed order (each call ends once, settles once), 3 nodes on one Redis with random owner kills.
5. **Docs:** ADR 0041 (WhatsApp calling: permissions, routing, bus, billing, recording), data-model §2.10, api.md §14f, websocket.md, security (SDP never logged, media ports), `docs/compliance/compliance-notes.md` (recording notice, DND / opt-out, TRAI window, permission wording), setup guide §15 (enable calling, messaging limit ≥ 2,000, `calls` + `account_settings_update` subscriptions, public UDP `WA_MEDIA_PORT_MIN–MAX`, `WA_MEDIA_PUBLIC_IP`, firewall, the **real-device checklist**: permission request on a real phone, BIC agent + AI, UIC team + AI, DTMF, recording, measured latency, Meta duration vs our pulses), README section, CHANGELOG `Phase 12 · Batch 2`, src/README rows.

## P12-B2-DONE — checkpoint → `docs: mark phase 12 batch 2 complete [P12-B2-DONE]`

1. Full backend verify.
2. **Manual HTTP + media check on a locally started dev server** (scratchpad script, counts / statuses only):
   - enable calling on a fake number; settings round trip (call hours, routing);
   - permission request in window (`00023`) → temporary; template outside window; 2nd request same day → 429; `00025` decline;
   - agent BIC with a scripted `AgentLeg` (tone) → the fake user heard the tone, the agent heard the clip → hang up → pulses × price exact in the ledger;
   - AI BIC (`00028`) → DTMF branch → Paid → two settled holds (call + AI);
   - inbound team ring → answer race (2 users) → one wins; inbound AI; AI → team transfer; missed → bubble + bell;
   - guards: no permission, wallet empty, DND, outside window, restricted (simulator);
   - 4 unanswered (`00022` × 4) → revoked;
   - superadmin calling rate card import → price changes;
   - cross-process hangup (two server processes on one Redis).
3. Log grep for SDP markers / phones / names / digits → 0.
4. Plan changelog + CHANGELOG. Commit.

---

# ═══════════ BATCH 3 — Frontend, E2E, sign-off (T12.9 → T12.12) ═══════════

## T12.9 — FE foundation + settings + contact panel → `feat(calls): add whatsapp calling clients, settings and contact panel [P12-T12.9]`

1. Frontend branch from `main`; `npm run gen:api`.
2. **Clients:** `services/api/whatsapp-calling.ts` (settings get / patch / sync, permissions status / request, calls start / answer / decline / hold / transfer, availability), Phase 7 `calls.ts` additions (filters, detail `whatsapp` block), superadmin calling rates in `admin-whatsapp-billing.ts`.
3. **Types + fixtures** (`src/test/calls-wa.ts`): `fakeCallingSettings`, `fakeCallPermission(status)`, `fakeWaCall(state, mode, direction)`, `fakeIncoming`.
4. **`features/whatsapp-calling/`:** `keys`, `queries` (live `whatsapp.call_permission.updated`, `whatsapp.channel.updated`; polling while `requested`), `labels` (permission states, call outcomes, Meta restriction texts, errors per code, unavailable reasons), `permissions` (`useCanCall` = `calls.trigger` && !impersonating && active; `useCanAnswer` = `calls.answer` && …; `useCanManageCalling` = `whatsapp.calling.manage` && …), `call-hours.ts` (validator mirroring the backend — shared case file like Phase 11's `template-validate-cases.json`: `tests/fixtures/call-hours-cases.json` copied to `src/test/fixtures/`).
5. **Number → Calling** (in the Numbers drawer / a new tab inside the number view): enable switch with the confirm, call icon + countries, call hours editor (week grid, 2 slots / day, holidays, timezone search), callback permission, inbound route (team / AI / AI → team, program picker of runnable flows / agents, ring timeout, ring list), recording notice, restriction banner, unavailable explanations (coexistence, messaging limit, country).
6. **Contact panel Calling section** (permission status + expiry + history, Request permission, Call (states), last 5 WhatsApp calls) + chat bubbles for the permission request / reply.
7. **Tests:** clients (paths / bodies), hooks (live + polling stop), call-hours validator (shared cases), settings editor every rule, panel states, bubbles, permissions matrix, responsive.

## T12.10 — FE call experience → `feat(calls): add the whatsapp call bar, incoming calls and call buttons [P12-T12.10]`

1. **Chat header Call button** (plan §1q states) + **Request permission** dialog (body text editable, interactive vs template note, cost line from the Phase 11 price preview) + **Call** menu: _Call yourself_ / _Call with AI_ (program picker, estimated cost per minute = call + AI).
2. **Global call bar** (lazy; mounted in the app shell when a call is live): state, timer, mute, hold, keypad, hang up, recording dot, network quality; agent media through the Phase 7 audio engine (`requestMicrophone`, worklets, media socket, device picker); AI calls: "AI is talking" + **Take over** (supervisors, decision #11) using the transfer path.
3. **Global incoming popup** (a tiny always-loaded listener for `whatsapp.call.incoming`; the popup itself lazy): name / number label, Accept / Decline, ring sound (respects a mute toggle), browser notification (asked once, strict-mode safe), "Taken by <name>" → closes; Accept → mic → answer → call bar.
4. **Availability toggle** in the header (Available / Busy / Offline) + auto busy while on a call.
5. **Call bubbles** in the chat (missed / completed / rejected / failed with duration → link to the call).
6. **Tests:** every button state, dialogs (exact request bodies), call bar states (fake media socket + fake realtime), mic denied, reconnect, popup race (`taken`), decline, availability, bubbles (hostile names stay text), strict mode (no double mic / ring), responsive.

## T12.11 — FE calls / wallet / superadmin + E2E → `test(e2e): add whatsapp calling scenarios [P12-T12.11]` (+ `feat(calls): …` FE commit for the screens if they are large — then two commits: `feat(calls): add whatsapp calls to the calls pages, wallet and superadmin [P12-T12.11]` first, the E2E commit second)

1. **Screens:** Calls list WhatsApp filter + badge + direction / mode columns; call detail (Meta timeline, answered by, transfer, recording, transcript, cost breakdown selling-only); wallet ledger lines **WhatsApp call · India · 2:14** + calling prices table; superadmin calling rate card (import + diff + edit, like Phase 11 Rates) + margin rows `call`; notifications (5 icons / links); dashboard WhatsApp card line "Today: N WhatsApp calls · M missed".
2. **Bundle check vs `main`** (same method as Phase 10 / 11: per file and as one gzip stream; target ≤ +3 KB as one stream; record both).
3. **Playwright:**
   - `playwright.config.ts` backend env: `FAKE_META_CALL_DELAYS_MS: '100,200,500'`, `WA_MEDIA_PORT_MIN/MAX` in a free range (e.g. `41000`/`41199`), `WA_STUN_URLS: ''`; the existing `chromium` project keeps its fake mic (`customer-silence.wav`, the Phase 7 call specs need it) and gets `testIgnore: /calls-wa-.*\.spec\.ts/`; a **second project `chromium-wa-calls`** (`testMatch: /calls-wa-.*\.spec\.ts/`, same settings) uses `docs/samples/audio/agent-tone.wav` (1 kHz, added in T12.3) as the agent's fake mic so the fake user can detect the agent; `workers: 1` stays, projects run one after the other.
   - Helpers `e2e/calls-wa.ts`: `CallingApi` (extends the `InboxApi` session pattern: `enableCalling`, `permission`, `fakeCalls`, `userCall`, `setAvailability`), `openCallBar`, `answerIncoming`, `expectCallBubble`.
   - Specs (one account per spec, serial, unique phones via `customerPhone(suffix)`, every async effect via `expect.poll`):
     1. **`calls-wa-done-when.spec.ts`:** enable calling → Request permission (`00023`) → "Can call until …" live → Call yourself → the fake phone answers → the fake user heard the agent's tone (`GET /dev/meta/calls`) → mute / keypad → hang up → call bubble "Call · 0:0x" → Calls detail recording plays → wallet line "WhatsApp call · India" = pulses × price; Call with AI (Loan recovery, `00028`) → presses 1 → outcome Paid + AI cost.
     2. **`calls-wa-inbound.spec.ts`:** the fake user calls → an agent on another page sees the popup → Accept → talk → end; two agents ringing → one accepts → the other's popup says taken; AI route answers with the flow; AI → team transfer; nobody answers → missed bubble + bell; callback permission granted (automatic reply).
     3. **`calls-wa-guards-billing.spec.ts`:** declined permission (`00025`) → Call disabled with the reason; 2nd request same day → limit message; Meta no permission (`00030`) → refused with the text, nothing held; wallet empty → refused "Add money…"; DND → refused; outside the calling window (account setting) → refused; 4 unanswered (`00022`) → revoked + bell; superadmin calling rate card import → the price changes; margin rows include calls.
     4. **`calls-wa-roles-settings.spec.ts`:** viewer read only (no Call / Accept), agent calls and answers, impersonating superadmin read only, owner settings round trip (call hours editor rules, routing), coexistence number shows "unavailable", restricted number banner (simulator), another account never sees these calls (API 404).
   - **All earlier 125 tests stay green;** the whole suite **twice**, the 2nd with `E2E_BACKEND_LOGS=1` → log grep (`a=fingerprint`, `ice-pwd`, `a=candidate`, `sdp`, test phones in full / `+91` / digits, contact names, DTMF digit strings from the specs, `wacid.` ids are fine, tokens, `Bearer`, `sk-`, both E2E passwords, the E2E app secret / verify token) → 0 hits.

## T12.12 — Gap audit, security, docs, sign-off

Commits: backend `docs: add phase 12 sign-off and docs [P12-T12.12]` + frontend `docs: add phase 12 whatsapp calling to the readme and changelog [P12-T12.12]` (+ `test: add phase 12 gap tests …` only if tests are added).

1. **Requirement → test table:** plan §0 (14 items + Done when), §1, every task, every §7 decision; missing tests added.
2. **Security / money / media checklist:**
   - SDP / ICE / DTLS data never in logs / audit / events / job data / errors (tests + log grep);
   - customer phones / names / digits never logged; recordings via signed links; media tickets bound to user + account + call;
   - media ports limited to the range; UDP sockets closed (no open handles);
   - Meta cost / markup / fee superadmin-only (a test on every account-facing call / ledger response);
   - money only through the engine (money-writes); invariants after every billing test; idempotency keys;
   - impersonation read only; first-wins answer;
   - gitleaks both repos; `console.log` 0 in both; no network in tests.
3. **Numbers:** coverage re-measured (gates never lowered), bundle (both measures), PoC + hardening media numbers (CPU / memory / latency per call).
4. **Docs:** both READMEs (WhatsApp calling sections, E2E list), CHANGELOGs (`Phase 12 · Batch 1 / 2 / 3` backend; `Phase 12 · WhatsApp calling (T12.9–T12.12)` frontend), BUILD_PLAN_V2 Phase 12 ✅ + changelog + "Next: Phase 13 (Staging deploy + Meta App Review)", PHASE_12_TASKS all `[x]`, plan changelog.
5. **PHASE_12_SIGNOFF.md** (same structure as Phase 11): tasks + evidence, deliverables, requirement → test, numbers (tests before → after: backend 2972 → N, frontend 1215 → N, E2E 125 → N; coverage; media numbers; bundle), security / money / media checklist, deviations, bugs fixed, verification, TODOs by phase (Phase 13: real-device checklist §15 + calling screencast + public UDP on staging; Phase 15: public API calls; Phase 18: SIP signalling + media server; Phase 20: WhatsApp call campaigns), owner inputs pending (official INR calling rate card, a calling-enabled test number with messaging limit ≥ 2,000 or the calling sandbox, a real phone, staging with public UDP), go / no-go for Phase 13.

## P12-B3-DONE — checkpoint → `docs: mark phase 12 complete [P12-B3-DONE]`

1. `infra:up` → full verify of **both repos** (each command separately) + actionlint both (`docker run --rm -v "$PWD/<repo>":/repo --workdir /repo rhysd/actionlint:latest`) + `npm run e2e` (all tests) **twice** after the last code commit (2nd with `E2E_BACKEND_LOGS=1` + log grep).
2. Fresh clones of both repos side by side (scratchpad, branch `feature/phase-12-whatsapp-calling`) → `npm ci` (the Opus codec builds) → all checks **without `.env`** → `gen:api` no diff → tests → E2E once → delete the clones.
3. Secret scan (grep + gitleaks one-off image `zricethezav/gitleaks:latest detect --source /repo --config /repo/.gitleaks.toml --redact --no-banner`) both repos; money-writes test; `npm audit` both (record; Phase 11 recorded backend 7 / frontend 3 advisories — note new ones).
4. Fill the sign-off §Verification; commit (backend `docs: mark phase 12 complete [P12-B3-DONE]`; a frontend docs commit with the same tag only if its CHANGELOG changed); `infra:down` (only `cav-*` containers). No push / merge.
5. **Final report (Hinglish):**
   - per task ✅ / ⚠️ / ❌, `git log` of both repos, deviations, verification;
   - tests before → after + coverage + gates, PoC + hardening media numbers, bundle numbers, real bugs found + fixed, sign-off status;
   - what the owner must still provide (official INR calling rate card, calling-enabled test number / sandbox, real phone, staging with public UDP) and what the real-device check needs (Phase 13);
   - open items for Phases 13 / 15 / 18 / 20.

---

## 4. FINAL CHECKLIST

**Step 0**

- [ ] `[P12-PROMPT]` (+ `[P12-PLAN]` lock commit if §7 answered / refinements recorded) on `feature/phase-12-whatsapp-calling`

**Batch 1**

- [ ] T12.1 PoC: werift + Opus + resampler, loopback with a Meta-like ICE-lite peer, DTMF, keep-alive, 20 / 20 runs, CPU / memory / latency numbers, ADR 0040 (accepted) — or STOP with the report
- [ ] T12.2 models (channel calling, call permissions, Call / Message / contact / user / account / rate card / ledger fields), migration 0013, limits, env, codes (83), audit (127), notifications (31), WS (+4), permissions (+2), jobs, `MESSAGE_TYPES` 17
- [ ] T12.3 MetaClient calling / settings / permissions + payload builders + error mapping + schemas + fixtures + `account_settings_update`; fake Meta calling + `FakeWaUser` + knobs `00020`–`00030`
- [ ] T12.4 `WhatsAppCallLeg` (media, codec, pacer, DTMF, keep-alive, metrics) + call-control bus (owner, claim, fast path, cross-process hangup for all calls, owner loss) + deferred `calls` ignored
- [ ] P12-B1-DONE (verify, `dev:calls-wa --poc`, log grep, docs)

**Batch 2**

- [ ] T12.5 calling settings (Meta rules, sync, restrictions, unavailable reasons) + permissions (request interactive / template, reply, status API, counters, sweep, streak) + contact panel + bubbles
- [ ] T12.6 dial guard + outbound agent (bridge) and AI calls + statuses + ring timeout + end / settle + bubbles + call buttons
- [ ] T12.7 inbound claim + routing (team ring first-wins, AI, AI → team transfer) + missed calls + call hours + callback permission
- [ ] T12.8 billing (pulse math, engine functions, reaper filters, calling rate card, margin), API + OpenAPI, simulator (70), seed, `dev:calls-wa`, hardening, ADR 0041, docs, setup guide §15 + real-device checklist
- [ ] P12-B2-DONE (verify, manual HTTP + media check, log grep)

**Batch 3**

- [ ] T12.9 FE foundation (clients, hooks, labels, permissions, call-hours validator mirror), number Calling settings, contact panel, permission bubbles
- [ ] T12.10 Call button + permission dialog + Call with AI, global call bar + agent media, incoming popup, availability, call bubbles
- [ ] T12.11 Calls list / detail, wallet, superadmin calling rates, notifications, dashboard, bundle check; Playwright (4 specs, whole suite twice, log grep)
- [ ] T12.12 gap audit, security / money / media checklist, docs, sign-off
- [ ] P12-B3-DONE (fresh clones, gitleaks, actionlint, `infra:down`, final report)
