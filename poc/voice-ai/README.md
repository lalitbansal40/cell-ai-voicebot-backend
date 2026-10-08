# Voice AI PoC (Phase 0 · T0.15)

Measures how well **OpenAI Realtime** handles a Hindi / English / Hinglish **loan-recovery call**: language switching, tone, barge-in, silence, noise, numbers, function calling (`check_payment_status`), latency and **cost per minute** — in studio quality (PCM 24 kHz) and phone quality (G.711 μ-law 8 kHz).

Results: [`docs/poc/voice-ai-poc-results.md`](../../docs/poc/voice-ai-poc-results.md). Not part of the backend build (own `package.json`).

## Setup

```bash
cd poc/voice-ai
npm ci
```

Add the key to the **backend** `.env` (gitignored — never commit it):

```bash
OPENAI_API_KEY=sk-...
# optional
OPENAI_REALTIME_MODEL=gpt-realtime-2.1   # default
POC_MAX_USD=10                           # hard spend cap across all PoC runs
POC_PORT=5199                            # browser mode port
```

## 1. Automated scenario runner

Customer speech is generated with TTS (cached in `output/tts-cache/`) and streamed in **real time** (20 ms frames), so VAD, latency and barge-in behave like a live call.

```bash
# cheapest first: mini model, all scenarios, both audio modes
npm run run -- --models gpt-realtime-2.1-mini --modes pcm24k,g711_ulaw --scenarios all

# compare with the full model on the key scenarios
npm run run -- --models gpt-realtime-2.1 --modes g711_ulaw --scenarios 01,03,05,07,14

# voice comparison on the greeting
npm run run -- --scenarios 01 --modes g711_ulaw --voices marin,cedar,coral

# resume an interrupted run (completed scenarios are skipped — no double spend)
npm run run -- --resume <runId> ...
```

| Flag          | Default                  | Meaning                                          |
| ------------- | ------------------------ | ------------------------------------------------ |
| `--scenarios` | `all`                    | Comma list of ids/prefixes (`01,05,07`) or `all` |
| `--modes`     | `pcm24k,g711_ulaw`       | Audio formats                                    |
| `--models`    | `$OPENAI_REALTIME_MODEL` | `gpt-realtime-2.1`, `gpt-realtime-2.1-mini`      |
| `--voices`    | `marin`                  | Bot voice(s)                                     |
| `--resume`    | new timestamp            | Re-use a run folder                              |

Output per scenario (`output/<runId>/<scenario>__<mode>__<model>__<voice>/`): `conversation.wav` (both sides, timeline-aligned), `customer.wav`, `bot.wav`, `transcript.md`, `events.jsonl` (no audio payloads), `summary.json` (latencies, function calls, cost, auto-checks).

**Latency** = time from the customer's last non-silent audio frame to the bot's first audio byte (also recorded: from server VAD `speech_stopped`).

**Budget:** every run adds to `output/spend.json`; runs stop when the total would exceed `POC_MAX_USD`.

## 2. Report

```bash
npm run report -- --run <runId> --usd-inr 84
```

Rewrites the metrics section (between `METRICS` markers) of the results doc: per-scenario table, aggregates by model × mode, Go / No-go thresholds.

## 3. Browser mode (talk to it yourself)

```bash
npm run serve   # → http://localhost:5199
```

Choose mode / model / voice / mock payment state and variables, click **Start call**, and talk (use headphones). Shows live transcripts, tool calls, per-turn latency and running cost. Interrupt the bot to test barge-in.

## 4. Fixed TTS check (`speak` nodes)

```bash
npm run tts-check -- --voices marin,cedar,coral   # → output/tts-check/*.wav
```

Six Hindi / English / Hinglish sentences with amounts, dates and phone numbers.

## Scenarios

| #   | Scenario                               | Auto-checks                                     |
| --- | -------------------------------------- | ----------------------------------------------- |
| 01  | Hindi greeting + reminder              | name, amount, days, AI disclosure, no threats   |
| 02  | Customer replies in English            | reply in English, mentions loan                 |
| 03  | Language switch EN → HI → EN           | each reply matches the customer's language      |
| 04  | Hinglish "kal pay kar diya"            | tool called, says received                      |
| 05  | "Maine pay kar diya" (paid / not_paid) | tool called with customer ID, reply consistent  |
| 06  | Angry customer                         | apologises, no threats/abuse                    |
| 07  | Barge-in during greeting               | greeting cancelled, reply identifies caller     |
| 08  | 12 s silence                           | bot re-prompts ("kya aap sun rahe hain")        |
| 09  | Noise 5 dB SNR + 2 s noise-only        | no false turn, correct answer                   |
| 10  | Numbers / dates                        | repeats ₹2,750 and the 15th                     |
| 11  | Indian names (4 variants)              | name in greeting (listen for pronunciation)     |
| 12  | Off-topic + abusive                    | redirects, no abuse back                        |
| 13  | "Baad me call karo"                    | asks for a time                                 |
| 14  | Long call, 12 mixed turns              | language per turn, remembers outstanding amount |

Auto-checks are heuristics — the **human listening scorecard** in the results doc is the final judge.

## Development

```bash
npm run typecheck
npm test          # audio utils, μ-law, resampling, WAV, pricing, checks, report
```

Files: `src/audio.ts` (PCM/μ-law/resample/WAV), `src/realtime-client.ts` (Realtime WebSocket session), `src/persona.ts` (prompt + tool), `src/scenarios.ts`, `src/checks.ts`, `src/runner.ts`, `src/report.ts`, `src/server.ts` + `public/` (browser mode), `src/tts.ts`, `src/tts-check.ts`, `src/pricing.ts` (prices + source date), `src/events.ts` (verified event names), `src/budget.ts`.
