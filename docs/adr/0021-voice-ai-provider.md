# 0021 — Voice AI provider

- **Status:** proposed
- **Date:** 2026-10-08

## Context

The live AI agent must understand and reply in Hindi / English / Hinglish with the caller's tone and low latency, and call functions (e.g. payment check).

## Options considered

1. **OpenAI Realtime (speech-to-speech)** — lowest latency, native function calling, natural language switching; cost per minute higher.
2. **STT → LLM → TTS pipeline** (e.g. Indian STT/TTS + GPT) — cheaper, more control, higher latency and turn-taking work.

## Decision

Default to **OpenAI Realtime** behind a **`VoiceAiProvider`** interface so the pipeline option can be added later. Final decision after the Voice AI PoC (T0.15) measures quality, latency and cost.

### PoC status (T0.15, 2026-10-08)

- Tooling built: automated 14-scenario runner (both PCM 24 kHz and G.711 μ-law), browser test mode, TTS check, report generator — `poc/voice-ai`.
- Verified on official docs: GA models `gpt-realtime-2.1` and **`gpt-realtime-2.1-mini`** (≈ 3× cheaper: audio $10 / $20 vs $32 / $64 per 1M tokens in/out); native `audio/pcmu` (G.711 μ-law 8 kHz) input/output — the SIP audio can go to the model without resampling.
- **Live runs pending** — no OpenAI API key configured yet. Status stays `proposed` until [voice-ai-poc-results.md](../poc/voice-ai-poc-results.md) passes its Go / No-go thresholds (p50 ≤ 1.2 s, p95 ≤ 2 s, language match ≥ 90%, function calls 100%, barge-in works).

## Consequences

- **Positive:** provider can be swapped.
- **Negative / trade-offs:** decision pending real measurements.
- **Follow-ups:** T0.15 PoC → accept or supersede.
