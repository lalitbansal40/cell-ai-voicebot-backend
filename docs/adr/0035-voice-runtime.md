# 0035 — Voice runtime: call legs, sessions, flow host and live AI

- **Status:** accepted
- **Date:** 2026-10-15

## Context

Phase 7 turns the Phase 6 flow engine and the Phase 5 agents into real voice calls. The first leg is the browser ("web test call": mic and speaker over a WebSocket); SIP comes in Phase 13 and must reuse the same runtime. Calls cost money every second, run for minutes, touch customer data, and must be testable without a phone line, an OpenAI key or real time passing.

## Options considered

1. **Own runtime over a `CallLeg` interface** — one `CallSession` per call (lifecycle, timers on an injected `Clock`, recording, transcript / events, wallet hold extension, settle), a `CallScript` per program (Phase 6 flow host or an AI agent), and a live AI controller that sits above the voice provider. Chosen.
2. **A hosted voice-agent platform** (call orchestration as a service) — fast to start, but flows, billing, recordings and data stay outside our control; per-minute platform fees on top of AI cost; India data handling unclear.
3. **Let the provider drive the call** (OpenAI Realtime with all logic as tools) — fewer moving parts, but Phase 6 menus, API steps, timers and versions would not run as built, and every call would need the model even for a pure IVR.

## Decision

- **Legs:** `TelephonyProvider` / `CallLeg` (ADR 0020). `WebCallLeg` speaks PCM16 24 kHz in 20 ms frames (960 bytes) over `/ws/media` with a one-time media ticket bound to user + account + call; a pacer sends bot audio in real time and `clear()` stops it at once (barge-in). SIP will be μ-law 8 kHz on the same interface.
- **Session:** `CallSession` owns the call: answered → recording notice → script; idle socket, max duration (the program's limit, hard cap 1 h), wallet hold extension every 5 s, polite ends (wallet, shutdown) that keep their reason, stereo 8 kHz WAV recording (customer left / bot right) uploaded at the end, settle through the billing engine (`telephony: false` for web calls). Redis registry for live calls (per-account limit 3, per-process 20).
- **Flow host:** `FlowHost` runs a Phase 6 graph live: `say` / `play` become audio, waits become keys (menu, digits with `#`, pause or timeout, type-ahead), speech (STT), timers, a transfer prompt or a live AI step. The engine gets one new input, `ai_session_end`.
- **Live AI:** `AiVoiceController` runs one conversation for a flow step or an agent-only call. Providers (Realtime, chat pipeline, fake) only move audio, text and tool calls; the controller owns tools (shared runner with the text runtime, max 5 per reply), `search_knowledge`, outcome → step end, `end_call` / transfer, barge-in + truncate at the ms heard, silence prompts, caps and wallet, the agent's max duration and fallbacks.
- **Determinism:** everything time-based takes a `Clock`; tests use `FakeClock` + fake TTS / STT / voice; no network, no real sleeps.
- **Data:** events never carry texts, digits or phones; the test phone is stored hidden and never returned; recordings are read through a 5-minute signed link (audited).

## Consequences

- **Positive:** the same flows and agents run in the simulator, in the browser and later on SIP; the whole runtime is tested end to end on a fake clock (seconds of real time per call); provider swap stays behind interfaces.
- **Negative / trade-offs:** we maintain audio plumbing (framing, pacing, resampling, VAD, WAV) ourselves; one process owns a live call (a hangup from another server answers 409 until Phase 13 adds routing); live latency on OpenAI is still unmeasured (ADR 0021).
- **Follow-ups:** Phase 8 campaigns start calls through `CallManager`; Phase 13 SIP leg (ADR 0022) and cross-process hangup; live Realtime measurements close ADR 0021.
