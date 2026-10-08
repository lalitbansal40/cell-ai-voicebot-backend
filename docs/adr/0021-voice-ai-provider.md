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

## Consequences

- **Positive:** provider can be swapped.
- **Negative / trade-offs:** decision pending real measurements.
- **Follow-ups:** T0.15 PoC → accept or supersede.
