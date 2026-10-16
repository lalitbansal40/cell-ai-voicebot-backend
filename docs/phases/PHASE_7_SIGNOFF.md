# Phase 7 — Sign-off

**Date:** 2026-10-16 · **Branch:** `feature/phase-7-voice` (both repos, not merged) · **Plan:** [PHASE_7_PLAN.md](PHASE_7_PLAN.md) · **Tracker:** [PHASE_7_TASKS.md](PHASE_7_TASKS.md) · **ADR:** [0035](../adr/0035-voice-runtime.md)

**Verdict:** ✅ Phase 7 (voice runtime + web call tester) complete — all 15 tasks done. **"Done when"** (a loan recovery call from the browser: the bot says the name and amount, pressing 1 or saying "maine pay kar diya" checks the payment API, the right reply in Hindi / English, recording + transcript + charge saved — proven by Playwright) is proven by `e2e/calls-done-when.spec.ts` (frontend repo): the published Loan recovery flow greets "Paid Borrower" with ₹2,500.00 and the due date, key 1 calls the payment API and thanks the customer (Paid); the call detail shows the transcript, the cost, a signed WAV recording that plays and the ledger call charge (AI voice, no phone line). The unpaid contact goes to the AI, says "maine payment kar diya" (unpaid reply) and "kal tak de dunga" (promise for tomorrow, IST, outcome Promise to pay); an agent alone answers "I have paid" in English after the payment check. Everything runs on the deterministic fake voice (tones for speech, typed customer words) and the mock payment API until the client inputs in §8 arrive; the OpenAI Realtime / TTS / transcription path is tested with replayed event fixtures only. **Phase 8 can start.** Merging the branches is a project-lead decision after review.

## 1. Tasks — "Done when" check

| Task                                      | Status | Evidence (commit; fe = frontend repo)                                                     | Notes                                                                                                                                                             |
| ----------------------------------------- | ------ | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T7.1 Models, migration 0008, catalogue    | ✅     | `0f290a9`                                                                                 | Call, CallEvent, TranscriptTurn, TTS cache; FlowRun `callId`; `CALL_LIMITS`; env with production rules; error codes 41 → 44, audit 68 → 71, `call.*` WS events    |
| T7.2 Audio core                           | ✅     | `c168b0f`                                                                                 | PCM16, G.711, resampler, framer, pacer, VAD, stereo WAV recorder, WAV / MP3 decode (`mpg123-decoder` 1.0.3, MIT) + cache                                          |
| T7.3 Voice providers + fakes              | ✅     | `2d71df5`                                                                                 | OpenAI Realtime / TTS / transcription, chat-backed fake voice session, fake TTS / STT, TTS cache with single flight                                               |
| T7.4 Telephony + `/ws/media`              | ✅     | `20fd787`                                                                                 | `TelephonyProvider` / `CallLeg`, WebCall provider, single-use media tickets, protocol + limits + close codes, `call:<id>` topic check                             |
| T7.5 Call session manager                 | ✅     | `738c869`                                                                                 | lifecycle, Redis registry + limits, hold / extend / settle, recording, transcript / events, WS, shutdown, reaper, purge, `dev:call`                               |
| T7.6 Flow voice host                      | ✅     | `dc3e1b1`, fix `43dcc8c`                                                                  | every output type live, TTS cache, type-ahead keys, barge-in, timers, notice line, engine `ai_session_end`, call-mode runs / stats; max duration fixed separately |
| T7.7 Live AI voice session                | ✅     | `698b801`, fix `8377996`                                                                  | agents alone / as a flow step, live tools + built-ins, knowledge tool, truncate, silence, caps, wallet, language, fallbacks, latency                              |
| T7.8 Calls API                            | ✅     | `e688b95`                                                                                 | `/calls/web`, list, active, detail, transcript, events, recording (signed, audited), hangup; OpenAPI                                                              |
| T7.9 Seed, samples, ADR, bench, docs      | ✅     | `5a783f8`                                                                                 | demo calls, `customer-silence.wav`, ADR 0035, `bench:voice`, docs, live OpenAI checklist                                                                          |
| T7.10 FE foundation                       | ✅     | `e442c47` (fe)                                                                            | clients, query hooks, WS events, `LIVE_PHASE = 7`, routes, DSP + worklets, audio engine, media socket                                                             |
| T7.11 Web Call Tester                     | ✅     | `10da9b3` (fe), `44d3fec`                                                                 | setup + mic meter, states, timer, mute, keypad, transfer prompt, typed words, live transcript, latency, timeline, fake-voice badge, result, errors, leave guard   |
| T7.12 Calls list + detail                 | ✅     | `1596036` (fe)                                                                            | URL filters, cursor, live updates; summary, outcome, cost split, quality, timeline, transcript → seek, on-demand recording; viewers / impersonators no player     |
| T7.13 Entry points                        | ✅     | `14ae29d` (fe)                                                                            | builder / agent "Test call", Settings → Calls, ledger breakdown, dashboard Recent calls; bundle +6.9 KB (§5)                                                      |
| T7.14 Playwright E2E                      | ✅     | `722ec21` (fe); fixes `ec8439c`, `fbd2451`, `ae123b1`, `cc894d3`, `4b2e56d`, fe `8ecebd7` | 12 call tests (44 total, green twice); five bugs found and fixed                                                                                                  |
| T7.15 Gap audit, security, docs, sign-off | ✅     | `[P7-T7.15]` commits (both repos)                                                         | `/ws/media` fuzz test, log grep, docs, this file                                                                                                                  |

Batch checkpoints: `286efc2` `[P7-B1-DONE]`, `9929221` `[P7-B2-DONE]`, `[P7-B3-DONE]` (the commit that fills §6). Run prompt: [PHASE_7_PROMPT.md](../prompts/PHASE_7_PROMPT.md).

## 2. Deliverables checklist (PHASE_7_PLAN §4)

- [x] `TelephonyProvider` / `CallLeg` + WebCall provider over `/ws/media` (tickets, limits, topic authorisation).
- [x] Call session manager: lifecycle, registry, limits, billing hold / extend / settle, recording, transcript, events, WS, shutdown, reaper, purge.
- [x] Audio bridge: G.711, resampling, framing, pacing, VAD, stereo recorder, WAV / MP3 decode.
- [x] Voice providers: OpenAI Realtime / TTS / transcription + deterministic fakes; TTS cache.
- [x] Flow voice host running Phase 6 flows live (every output type, barge-in, type-ahead DTMF, timers) + engine `ai_session_end` input.
- [x] Live AI voice session (tools live, built-ins live, knowledge, caps, silence, barge-in, language, fallbacks, latency).
- [x] Calls API + OpenAPI; seed; samples; `bench:voice`.
- [x] UI: Web Call Tester, Calls list, call detail, entry points, Settings → Calls.
- [x] Playwright: Done when (keypad + voice), English, barge-in, silence, money & roles (mid-call `wallet_empty` in backend tests, §5).
- [x] Docs: ADR 0035 (+ 0020 accepted, 0021 stays proposed), data-model, conventions, setup (OpenAI live checklist), compliance, cost model, READMEs, CHANGELOGs, sign-off.

## 3. Requirement → test mapping (gap audit)

Backend tests live in `tests/calls/`, `tests/voice/`, `tests/db/` and next to the audio code (`src/core/voice/audio/*.test.ts`); frontend unit tests next to the code; Playwright specs in the frontend `e2e/`.

| Requirement (PHASE_7_PLAN)                                                                  | Tests                                                                                                                                                              |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| §1a one process owns a call; registry, heartbeat, per-account / per-process limits          | `session.test.ts`, `calls-api.test.ts` (429 / 503, hangup on another process → 409), E2E money-roles (4th live call refused)                                       |
| §1b audio formats: PCM16 24 kHz, G.711, 20 ms frames, 960-byte web frames                   | `pcm-g711.test.ts`, `resample-framer.test.ts`, `pacer-vad.test.ts`, `wav-mixer-decode.test.ts`, fe `dsp.test.ts`, `worklets.test.ts`                               |
| §1c `TelephonyProvider` / `CallLeg` (play, clear, hangup, notices)                          | `webcall-leg.test.ts`, `media-server.test.ts`                                                                                                                      |
| §1d `/ws/media` protocol, tickets, limits, close codes                                      | `media-tickets.test.ts`, `media-server.test.ts`, `media-fuzz.test.ts` (added in T7.15), fe `media-socket.test.ts`                                                  |
| §1e call model + lifecycle, events, transcript, end reasons                                 | `models.test.ts`, `units.test.ts`, `session.test.ts`, `phase7-migrations.test.ts`                                                                                  |
| §1f voice providers: OpenAI event parsing, fakes, TTS cache single flight                   | `providers.test.ts` (replayed fixtures, no network), `tts-cache.test.ts`                                                                                           |
| §1g flow host: every Loan recovery branch, keys during prompts, barge-in, timers, notice    | `flow-host.test.ts`, `flow-call.test.ts`, `nodes.test.ts` (`ai_session_end`), E2E done-when (keypad, wrong keys → callback)                                        |
| §1h live AI: tools, built-ins, knowledge, truncate, silence, caps, language, fallbacks      | `ai-session.test.ts`, `ai-call.test.ts`, `run-turn.test.ts`, `tools.test.ts`, E2E done-when (Hinglish promise, English reply, barge-in, AI silence)                |
| §1i latency + metrics, `bench:voice`                                                        | `ai-session.test.ts` (latency events), fe `tester.test.tsx` (latency chips), `bench:voice` (§4)                                                                    |
| §1j recording: stereo WAV, upload retry, signed + audited links, recording off              | `session.test.ts`, `calls-api.test.ts` (5 min link, audited, viewers 403), `storage.test.ts` (range reads), E2E done-when (WAV plays, duration > 5 s)              |
| §1k billing: hold / extend / settle, `wallet_empty` polite end, web calls without telephony | `session.test.ts`, `ai-call.test.ts`, `pricing.test.ts`, `admin-billing.test.ts`, `tests/security/money-writes.test.ts`, E2E (empty wallet refused, ledger charge) |
| §1l limits and failures (frame size, floods, max duration, reaper, shutdown)                | `media-server.test.ts`, `media-fuzz.test.ts`, `flow-call.test.ts` (max duration), `session.test.ts` (reaper, shutdown)                                             |
| §1m security & privacy: logs without texts / phones, text input off in production           | `env.test.ts` (production rules), `calls-api.test.ts` (test phone never returned), E2E log grep (§6)                                                               |
| §1n permissions: viewer read-only, agent can test, impersonator read-only, suspended        | `calls-api.test.ts`, `topic-auth.test.ts`, fe `calls-pages.test.tsx`, `calls-routes.test.tsx`, `entry-points.test.tsx`, E2E money-roles                            |
| §1o API surface + tenant isolation                                                          | `calls-api.test.ts` (another account → 404, never listed), `topic-auth.test.ts`, `tests/security/tenant-scope.test.ts`                                             |
| §1p frontend: tester, list, detail, entry points, Settings → Calls, ledger, dashboard       | fe `tester.test.tsx`, `parts.test.tsx`, `engine.test.ts`, `calls-pages.test.tsx`, `entry-points.test.tsx`, `settings-flows.test.tsx`, `ledger-call.test.tsx`       |
| Seed + demo calls                                                                           | `seed-calls.test.ts`                                                                                                                                               |

Gap found and closed in T7.15: `/ws/media` had no fuzz-style test — `media-fuzz.test.ts` now proves single-use tickets (reuse → 4001), random control garbage only gets `bad_message` errors while the socket stays open, any binary frame that is not exactly 960 bytes closes 4008, and an oversized control message closes 1009.

## 4. Numbers

|                                                     | Before (Phase 6)              | After                         |
| --------------------------------------------------- | ----------------------------- | ----------------------------- |
| Backend tests                                       | 1865                          | 2022                          |
| Frontend tests                                      | 614                           | 665                           |
| Playwright                                          | 32                            | 44 (green twice)              |
| Backend coverage (stmts / branches / funcs / lines) | 97.27 / 88.93 / 97.26 / 98.23 | 97.29 / 89.18 / 97.14 / 98.32 |
| Frontend coverage                                   | 95.62 / 90.28 / 93.25 / 96.52 | 95.92 / 90.68 / 93.36 / 96.72 |

Voice bench (`npm run bench:voice`, 20 web calls × 120 s, fake voice, laptop on battery): CPU 1.8 % per call, event-loop lag p99 15 ms / max 35 ms, late pacer ticks 4.0 %, 0 stalled frames, ≈ 6 MB RSS per call, 20 / 20 recordings.

Latency: only the fake voice was measured (its replies are rule-based and instant, so the numbers say nothing about production). Real reply latency needs the live OpenAI run (docs/setup/openai.md V1–V7).

Bundle (frontend, gzip of everything `index.html` loads, same script on both builds): `main` 439.0 KB → branch 445.9 KB (**+6.9 KB**). The tester (8.0 KB), detail (3.0 KB), list (2.5 KB) and the worklets (0.9 + 0.8 KB) are their own chunks.

Coverage gates stay at backend 95 / 85 / 95 / 95 and frontend 95 / 90 / 90 / 95 — the new values rounded down to 5 equal the current gates (never lowered).

## 5. Deviations from the plan

All recorded in the [plan changelog](PHASE_7_PLAN.md#changelog) (batch 1, 2 and 3 entries). In short: `CallLeg` paces audio itself; the fake voice is the chat-backed session (also the `VOICE_PIPELINE=chat` option); no reconnect grace (a closed media socket ends the call); recording uploads retry inline; sequence numbers kept by the owning session; the per-account limit is check-then-register (Phase 8 will reserve atomically); max duration enforced by the session timer; tool execution moved to `createToolRunner`; hangup from another tab only on the same process (409 otherwise, until Phase 13); `POST /calls/web` returns `voice`; bundle growth **+6.9 KB** over the 5 KB target (lazy-loading the dashboard card made the main chunk bigger); the fake mic plays `customer-silence.wav` (customer words typed) instead of a speech-like `customer.wav`; the 4th-call E2E creates 3 calls through the API (headless Chromium freezes background tabs); mid-call `wallet_empty` proven by backend tests only; barge-in E2E checks the interrupted mark + event (`audio.clear` in unit tests); the manual browser check is replaced by Playwright with the fake mic — **a real-mic check by a person is still open**.

Real bugs found and fixed (each with a regression test): two TTS requests for the same line both synthesised (T7.3) · flow calls ignored the flow max duration (`43dcc8c`) · a polite end was saved as `hangup_node` when the script returned on stop (`8377996`) · barge-in missed while a finished reply still played and a silence prompt the provider never answered could hang the step (T7.7) · **found by Playwright:** signed files blocked for the dashboard by the same-origin CORP header and not seekable (`ec8439c`) · the tester stuck at "Ending…" after a hang up (`fbd2451`) · words said during the AI step's opening line were lost (`ae123b1`) · the wrong transcript line was marked interrupted (`4b2e56d` + fe `8ecebd7`).

## 6. Verification (P7-B3-DONE)

Filled by the `[P7-B3-DONE]` commit.

## 7. Remaining TODOs (by phase)

- **Phase 8 (campaigns & scheduler):** dial through `startCall` (the contract is in `core/telephony/types.ts`), atomic per-account reservations, calling window and DND checks before dialing, campaigns pin a `flowVersionId`, retries / callbacks / promise follow-ups from outcomes, `isFlowInUse` from campaigns, `campaign:<id>` topics.
- **Phase 9 (reports):** call reports and dashboards from Calls, outcomes, dispositions, per-node funnels (call mode), latency and cost per minute.
- **Phase 10 (integrations):** send the queued SMS (DLT) / WhatsApp messages and payment links; webhooks for call events.
- **Phase 11 (settings / compliance):** retention settings in the UI (today `CALL_RETENTION_DAYS`, 180), recording download policy.
- **Phase 13 (SIP + transfer):** SIP provider behind `TelephonyProvider` (8 kHz μ-law path already built), real transfers and queues, cross-process hangup routing, telephony charges.
- **Phase 14 (inbound):** inbound numbers → flows / agents.

## 8. Client / business inputs still pending

- OpenAI API key, budget and Zero Data Retention; then the live voice checklist (docs/setup/openai.md V1–V7) and ADR 0021 → accepted.
- Realtime model (`gpt-realtime-2.1-mini` default vs full) and the bot voice (default `coral`; Hindi pronunciation check).
- Recording on by default, notice wording ("Yeh call quality ke liye record ki ja rahi hai.") and retention days (180).
- SIP trunk / provider and caller ID; human transfer numbers / queues.
- Real IVR script and texts, the client's payment-status API, SMS DLT / WhatsApp templates.
- From earlier phases: SMTP + sending domain, server SSH key.

## 9. Go / no-go for Phase 8

**Go.** Calls run end to end in the browser on the fake voice: flows and agents live, recording, transcript, events and billing are saved, and the Calls API, list and detail are in place. Phase 8 only needs to call `startCall` from a scheduler; SIP (Phase 13) plugs in behind the same `TelephonyProvider`. Open items are the live OpenAI run, a real-mic check and the client inputs (§8), none of which block the campaign work.
