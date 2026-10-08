# Voice AI PoC — Results (T0.15)

**Status:** ⏳ **Live runs pending — `OPENAI_API_KEY` not set yet.** All tooling is built and unit-tested (`poc/voice-ai`, 28 tests). Fill the sections below by running the steps in [How to complete](#how-to-complete).

Tooling: [`poc/voice-ai/README.md`](../../poc/voice-ai/README.md) · Decision: [ADR 0021](../adr/0021-voice-ai-provider.md)

---

## 1. Verified facts (checked 2026-10-08)

Sources: [Realtime WebSocket guide](https://developers.openai.com/api/docs/guides/realtime-websocket) · [Realtime conversations guide](https://developers.openai.com/api/docs/guides/realtime-conversations) · [Client events](https://developers.openai.com/api/reference/resources/realtime/client-events) · [Server events](https://developers.openai.com/api/reference/resources/realtime/server-events) · [Pricing](https://developers.openai.com/api/docs/pricing)

| Item                       | Value                                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Endpoint                   | `wss://api.openai.com/v1/realtime?model=<model>`, header `Authorization: Bearer <key>`                                                                                                |
| GA models                  | `gpt-realtime-2.1`, `gpt-realtime-2.1-mini` (older `gpt-realtime-2`, `-1.5`, `gpt-realtime`, `-mini` priced the same)                                                                 |
| Audio formats              | `audio/pcm` 24 kHz (default) or 16 kHz · `audio/pcmu` 8 kHz (G.711 μ-law) · `audio/pcma` 8 kHz (G.711 A-law)                                                                          |
| Session config             | `session.update` → `session.type: "realtime"`, `audio.input.{format, turn_detection, transcription, noise_reduction}`, `audio.output.{format, voice}`, `tools`, `tool_choice`         |
| Turn detection             | `server_vad` (`threshold` 0.5, `prefix_padding_ms` 300, `silence_duration_ms` 500, `create_response`, `interrupt_response`, `idle_timeout_ms`) or `semantic_vad`                      |
| Voices                     | `alloy`, `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`, `verse`, `marin`, `cedar`                                                                                               |
| Input transcription models | `gpt-4o-mini-transcribe`, `gpt-4o-transcribe`, `whisper-1`, newer `gpt-transcribe`, … (optional `language`, ISO-639-1)                                                                |
| Barge-in                   | server VAD `interrupt_response` + client `conversation.item.truncate { item_id, content_index: 0, audio_end_ms }`                                                                     |
| Function calling           | server `response.function_call_arguments.done { call_id, name, arguments }` → client `conversation.item.create { type: "function_call_output", call_id, output }` + `response.create` |
| Usage                      | `response.done.response.usage` → `input_token_details { text_tokens, audio_tokens, cached_tokens, cached_tokens_details }`, `output_token_details { text_tokens, audio_tokens }`      |

### Prices (USD per 1M tokens)

| Model                   | Text in | Cached in | Text out | Audio in | Cached audio in | Audio out |
| ----------------------- | ------- | --------- | -------- | -------- | --------------- | --------- |
| `gpt-realtime-2.1`      | 4.00    | 0.40      | 24.00    | 32.00    | 0.40            | 64.00     |
| `gpt-realtime-2.1-mini` | 0.60    | 0.06      | 2.40     | 10.00    | 0.30            | 20.00     |

Other: `gpt-4o-mini-tts` $0.60 / 1M text-in tokens + $12 / 1M audio-out tokens · `tts-1` $15 / 1M chars · transcription per minute: `gpt-4o-mini-transcribe` $0.003, `gpt-4o-transcribe` / `whisper-1` $0.006.

### Rough cost estimate (⚠️ assumption — replace with measured numbers)

Assumes ~10 audio tokens/s for customer audio, ~20 audio tokens/s for bot audio, a 50/50 talk split, and conversation context re-billed as (mostly cached) input each turn. Real usage comes from `response.done.usage` in the runs.

| Model                   | Bot audio out / min of bot speech | Rough all-in per call minute       |
| ----------------------- | --------------------------------- | ---------------------------------- |
| `gpt-realtime-2.1-mini` | ≈ $0.024                          | ≈ $0.02–0.05 (≈ ₹2–5 at ₹96.83/$)  |
| `gpt-realtime-2.1`      | ≈ $0.077                          | ≈ $0.07–0.15 (≈ ₹7–15 at ₹96.83/$) |

The mini model is ~3× cheaper — the PoC runs **all** scenarios on mini and the key scenarios on the full model to decide whether the quality difference justifies the cost.

---

## 2. Setup used for the runs

| Item           | Value                                                                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Persona        | Loan recovery, polite, mirrors customer language & tone, AI disclosure, no threats ([`persona.ts`](../../poc/voice-ai/src/persona.ts)) |
| Variables      | Lalit Bansal · ₹5,500 · 120 days · Demo Finance · CUST-1042                                                                            |
| Tool           | `check_payment_status(customerId)` → mock `paid` / `not_paid` / `partial`                                                              |
| Customer voice | TTS `gpt-4o-mini-tts`, voice `ash`, tone instructions per turn                                                                         |
| VAD            | `server_vad`, threshold 0.5, padding 300 ms, silence 500 ms, `interrupt_response: true` (scenario 8: `idle_timeout_ms` 8000)           |
| Transcription  | `gpt-4o-mini-transcribe`                                                                                                               |
| Audio modes    | `pcm24k` (PCM16 24 kHz) and `g711_ulaw` (μ-law 8 kHz — phone line)                                                                     |
| Latency        | customer's last voiced frame → bot's first audio byte                                                                                  |
| Runs           | _pending_ — date, run ID, models, voices                                                                                               |
| Total spend    | _pending_ (cap `POC_MAX_USD`)                                                                                                          |

---

## 3. Metrics

<!-- METRICS:START -->

_Pending — generated by `npm run report -- --run <runId>` after the live runs._

<!-- METRICS:END -->

---

## 4. Human listening scorecard (fill in)

Listen to `poc/voice-ai/output/<runId>/<scenario>__<mode>__<model>__<voice>/conversation.wav` (start with scenarios 01, 03, 05, 06, 07, 10, 11, 14 in `g711_ulaw`). Score 1 (bad) – 5 (excellent).

| Scenario           | Mode      | Model | Clarity | Naturalness | Hindi pronunciation | Numbers / amounts | Tone fit | Notes |
| ------------------ | --------- | ----- | ------- | ----------- | ------------------- | ----------------- | -------- | ----- |
| 01 greeting        | g711_ulaw | mini  |         |             |                     |                   |          |       |
| 01 greeting        | g711_ulaw | full  |         |             |                     |                   |          |       |
| 03 language switch | g711_ulaw | mini  |         |             |                     |                   |          |       |
| 05 paid claim      | g711_ulaw | mini  |         |             |                     |                   |          |       |
| 06 angry customer  | g711_ulaw | mini  |         |             |                     |                   |          |       |
| 07 barge-in        | g711_ulaw | mini  |         |             |                     |                   |          |       |
| 10 numbers         | g711_ulaw | mini  |         |             |                     |                   |          |       |
| 11 names           | g711_ulaw | mini  |         |             |                     |                   |          |       |
| 14 long call       | g711_ulaw | mini  |         |             |                     |                   |          |       |

Voice comparison (scenario 01, `--voices marin,cedar,coral`): preferred voice → _pending_.

## 5. Fixed TTS check (`speak` nodes)

`npm run tts-check` → `output/tts-check/*.wav` (6 sentences × voices). Notes on Hindi amounts (₹12,75,000), dates, phone numbers, IVR prompt: _pending_. Cost per 1k chars: _pending_.

## 6. PCM 24 kHz vs G.711 (phone) quality

_Pending — compare latency, transcription accuracy and listening scores between modes._

## 7. Issues found

_Pending._

## 8. Go / No-go

| Threshold               | Target                                      |
| ----------------------- | ------------------------------------------- |
| Latency p50             | ≤ 1200 ms                                   |
| Latency p95             | ≤ 2000 ms                                   |
| Language match          | ≥ 90% of turns                              |
| Function-call scenarios | 100% pass                                   |
| Barge-in                | works                                       |
| Cost / min              | reported → priced in the cost model (T0.17) |

**Recommendation:** _pending live runs._ If thresholds pass → ADR 0021 `accepted` (model + audio mode). If not → keep `proposed`, try `semantic_vad` / prompt changes, then evaluate an STT → LLM → TTS pipeline (e.g. an Indian STT/TTS provider). Option B check: **not run** (no `SARVAM_API_KEY` or similar configured).

---

## How to complete

1. Add `OPENAI_API_KEY` to `cell-ai-voicebot-backend/.env` (never commit). Optional: `POC_MAX_USD` (default 10).
2. `cd poc/voice-ai && npm ci`
3. `npm run run -- --models gpt-realtime-2.1-mini --modes pcm24k,g711_ulaw --scenarios all`
4. `npm run run -- --resume <runId> --models gpt-realtime-2.1 --modes g711_ulaw --scenarios 01,03,05,07,14`
5. `npm run run -- --resume <runId> --scenarios 01 --modes g711_ulaw --voices marin,cedar,coral`
6. `npm run tts-check`
7. `npm run report -- --run <runId> --usd-inr <today's rate, e.g. 96.83>`
8. Listen and fill sections 4–7; optionally talk to it yourself with `npm run serve`.
9. Update [ADR 0021](../adr/0021-voice-ai-provider.md) and the [cost model](../cost/cost-model.md) with the measured numbers.
