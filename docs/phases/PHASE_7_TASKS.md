# Phase 7 — Task Tracker

Source plan: [PHASE_7_PLAN.md](PHASE_7_PLAN.md) — Batch 1 = T7.1–T7.5, Batch 2 = T7.6–T7.9, Batch 3 = T7.10–T7.15.

| Done | Task  | Title                                                                                                                                                       | Repo | Size |
| ---- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---- |
| [x]  | T7.1  | Models (Call, CallEvent, TranscriptTurn, TTS cache), FlowRun `callId`, migration 0008, `CALL_LIMITS`, env, error codes, audit, WS, pricing `telephony` flag | BE   | M    |
| [x]  | T7.2  | Audio core: PCM16 / G.711, resampler, framer, pacer, energy VAD, stereo WAV recorder, WAV / MP3 decode + cache                                              | BE   | M    |
| [x]  | T7.3  | Voice providers: OpenAI Realtime / TTS / transcription + deterministic fakes, TTS cache                                                                     | BE   | L    |
| [x]  | T7.4  | Telephony interface + WebCall provider, `/ws/media` (tickets, protocol, limits), `call:<id>` topic authorisation                                            | BE   | M    |
| [x]  | T7.5  | Call session manager: lifecycle, Redis registry, limits, billing hold / extend / settle, recording, persistence, WS, shutdown, reaper, purge                | BE   | L    |
| [x]  | T7.6  | Flow voice host: outputs → audio, DTMF / STT / timers, barge-in, engine `ai_session_end` input, call-mode trace + stats                                     | BE   | L    |
| [x]  | T7.7  | Live AI voice session: Realtime agent, live tools + built-ins, knowledge tool, barge-in truncate, silence, caps, language, fallbacks, latency               | BE   | L    |
| [x]  | T7.8  | Calls API (`/calls/web`, list, detail, transcript, events, recording, hangup, active) + OpenAPI                                                             | BE   | M    |
| [x]  | T7.9  | Seed, samples, ADR 0035, `bench:voice`, docs, live-OpenAI checklist                                                                                         | BE   | M    |
| [ ]  | T7.10 | FE foundation: clients, routes, `LIVE_PHASE = 7`, WS events, audio worklets, media socket client                                                            | FE   | M    |
| [ ]  | T7.11 | Web Call Tester page                                                                                                                                        | FE   | L    |
| [ ]  | T7.12 | Calls list + call detail (recording, transcript, timeline, cost, outcome)                                                                                   | FE   | M    |
| [ ]  | T7.13 | Entry points: builder / agent "Test call", Settings → Calls, ledger breakdown, dashboard recent calls                                                       | FE   | S    |
| [ ]  | T7.14 | Playwright E2E (fake mic + fake voice): Done when, English, barge-in, silence, money & roles                                                                | FE   | M    |
| [ ]  | T7.15 | Gap audit, security checklist, docs, Phase 7 sign-off                                                                                                       | both | M    |

**Done when:** Browser se loan recovery call — bot naam + amount bole, 1 press ya "maine pay kar diya" pe API check ho, Hindi / English dono mein sahi jawab, recording + transcript + charge save ho — Playwright se proven.
