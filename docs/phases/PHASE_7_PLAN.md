# Phase 7 — Voice Runtime + Web Call Tester (Detailed Plan)

**Source:** [BUILD_PLAN.md](../plans/BUILD_PLAN.md) → Phase 7 · **Builds on:** Phase 4 (wallet holds / settle), Phase 5 (agents, functions, built-ins, knowledge, `compileAgent`), Phase 6 (flow engine `advance()`, versions, audio library) · **Branch:** `feature/phase-7-voice` (both repos, from `main` = Phase 6 tip: backend `7a2a1e0`, frontend `87ce07b`) · **Tracker:** [PHASE_7_TASKS.md](PHASE_7_TASKS.md)

---

## 0. Is phase ka goal

Phase 7 ke end tak koi bhi user **browser se ek asli jaisi call** kar sake — mic se bole, bot awaaz mein jawab de — aur wahi call **Phase 6 ka flow** (ya sirf ek AI agent) chalaye. Ye product ka **core** hai: SIP (Phase 13) aane par sirf ek naya `TelephonyProvider` judega, baaki sab (session manager, audio bridge, voice AI, flow host, recording, transcript, billing) yahi rahega.

1. **`TelephonyProvider` interface** (ADR 0020) — `CallLeg` ke saath: audio in / out (20 ms frames), DTMF, hangup, transfer, status events. Implementation: **WebCall** (browser mic ⇄ `/ws/media` ⇄ backend). SIP Phase 13 mein isi interface par.
2. **Call Session Manager** — call lifecycle (`queued → ringing → in_progress → completed / failed / canceled`), live state Redis mein (registry + heartbeat), history Mongo mein (`calls`, `callEvents`, `transcriptTurns`), concurrency limits, graceful shutdown, crash reaper.
3. **Audio bridge** — PCM16 ⇄ G.711 μ-law, resample (8 / 16 / 24 kHz), 20 ms framing, pacing + backpressure (jitter buffer), energy VAD, stereo recorder, MP3 / WAV decode for `play_audio`.
4. **Voice AI adapter** (`VoiceAiProvider`, ADR 0021) — **OpenAI Realtime** (speech-to-speech, server VAD, function calling, transcripts, usage) + ek **deterministic fake** provider (OpenAI key abhi nahi hai — poora phase fake par chalega aur test hoga).
5. **TTS + STT** — `speak` nodes ke liye TTS (**cache** per text + voice + language), `gather_speech` ke liye streaming STT (Realtime transcription), DTMF detection (WebCall: keypad events).
6. **Flow ⇄ voice host** — Phase 6 `advance()` ko live audio par chalana: `say` → TTS, `play` → audio file, `listen_dtmf` / `listen_speech` → keypad / STT with timers, `ai_agent` → Realtime session, `pause` → real timer, `transfer` → simulated (WebCall), `hangup` → goodbye + end.
7. **Live AI agent** — Phase 5 agent `compileAgent(…, { channel: 'voice' })` se; custom functions **live** (secure executor), built-in tools **live mode** (end call, transfer, disposition, callback, promise, SMS queue), knowledge search tool, caps + wallet checks, language auto-switch, tone instructions.
8. **Turn-taking** — **barge-in** (customer beech mein bole to bot ruke, `audio.clear` + Realtime truncate), silence handling ("Hello? kya aap sun rahe hain?"), max turns / duration.
9. **Recording** — dono side ka audio (stereo: customer left, bot right) → storage, recording notice line (account setting, on by default), signed URL playback (`calls.listen`, audited), retention purge.
10. **Live transcript** — turn-by-turn save + WebSocket se UI par live (partials sirf media socket par, finals DB + `call.transcript` event).
11. **Cost metering** — call start par wallet **hold**, chalti call mein **extend**, end par **settle** (call minutes + AI minutes + TTS chars); paisa khatam → polite message + hangup; Realtime token usage metrics mein (cost model ke liye).
12. **Latency logging** — customer chup → bot ki pehli awaaz (per turn), call par p50 / p95 / max; target **~1 s** (live OpenAI par measure — key pending).
13. **Fallbacks** — AI down → fixed message / flow error exit / transfer; TTS fail → retry → error handler; media drop → call end + settle.
14. **UI** — **Web Call Tester** (flow / agent + contact / typed values choose karo, mic se baat, keypad, live transcript + events, latency, cost), **Calls** list + **call detail** (recording player, transcript, timeline, cost, outcome), flow builder / agent editor se "Test call".

**Done when (BUILD_PLAN):** Browser se **loan recovery call**: bot **naam + amount** bole, **1 press** ya **"maine pay kar diya"** bolne pe **API check** ho, **Hindi / English dono** mein sahi jawab, **recording + transcript + charge** save ho — **Playwright se proven** (Chromium fake mic + fake voice provider + mock payment API), plus barge-in, silence, wallet-empty aur roles scenarios.

### Phase 7 mein kya NAHI hoga

| Kaam                                                                                    | Kaunse phase mein                              |
| --------------------------------------------------------------------------------------- | ---------------------------------------------- |
| SIP trunk / Asterisk ARI provider, real phone numbers, RTP, answer detect               | Phase 13 (ADR 0022)                            |
| Real transfer to a human (WebCall par simulated: answered / no answer / failed buttons) | Phase 13                                       |
| Campaigns, scheduler, retries, calling-window enforcement, DND checks on dial           | Phase 8                                        |
| Post-call AI summary, sentiment, reports / dashboards, node funnel reports              | Phase 9                                        |
| SMS / WhatsApp actually bhejna, outbound webhooks (`call.ended`), API trigger           | Phase 10                                       |
| Inbound calls / number → flow mapping                                                   | Phase 14                                       |
| Per-account retention settings UI + delete-on-request                                   | Phase 11 (Phase 7: global default + purge job) |
| STT → LLM → TTS pipeline (cheaper alternative)                                          | Later (ADR 0021 option 2, interface ready)     |
| Live OpenAI quality / latency sign-off                                                  | Jab `OPENAI_API_KEY` aaye (§7 open questions)  |

### Conventions to follow

Same as earlier phases: [api.md](../conventions/api.md), [security.md](../conventions/security.md), [data.md](../conventions/data.md), [data-model.md](../conventions/data-model.md) (Call / CallEvent / TranscriptTurn already drafted — §2.x), [websocket.md](../conventions/websocket.md) (§8 `/ws/media` protocol already drafted), [audit.md](../conventions/audit.md), [error-codes.md](../conventions/error-codes.md), [secrets.md](../conventions/secrets.md), [definition-of-done.md](../conventions/definition-of-done.md). Money only via the billing engine (`holdForCall` / `extendHold` / `settleCall` / `chargeUsage`). Logs never carry audio, transcript text, phones, secrets or prompts. Tests make **no network calls** (OpenAI events replayed from recorded fixtures).

---

## 1. Locked decisions (pehle se tay — implementation me dobara debate nahi)

### 1a. Architecture (one process owns a call)

```
Browser (Web Call Tester)
  mic → AudioWorklet → PCM16 24 kHz 20 ms ─┐            ┌─ playback AudioWorklet ← PCM16 24 kHz
                                           ▼            │
                              /ws/media (ticket, JSON control + binary audio)
                                           │
                     WebCallProvider ── CallLeg (audio in / out, dtmf, hangup, status)
                                           │
                     CallSession (modules/calls/session.ts) ── Redis registry + heartbeat
                       ├── AudioBridge (core/voice/audio): framing, pacing, VAD, recorder
                       ├── VoiceHost (core/voice/flow-host.ts): advance() ⇄ outputs / inputs
                       │     ├── TtsProvider (+ cache)      ← say
                       │     ├── AudioLibrary decode        ← play
                       │     ├── SttSession                 ← listen_speech
                       │     └── AiVoiceSession (Realtime)  ← ai_agent node / agent-only call
                       ├── Billing: holdForCall → extendHold → settleCall
                       └── Persist: Call, CallEvent, TranscriptTurn, FlowRun (mode call), stats; WS notify
```

- **Call ek hi Node process mein rehti hai** (media socket wahi). Redis key `call:live:<callId>` = `{ pid, host, startedAt, heartbeatAt }` (TTL 30 s, har 10 s refresh). Multi-instance routing (sticky media) Phase 13 / deployment mein — Phase 7 single API process (ADR 0025 Docker Compose).
- **State machine pure** (`modules/calls/lifecycle.ts`): allowed transitions table + tests; side effects session mein.
- **FlowRun** reuse: `mode: 'call'`, `callId` field add; engine state har output batch ke baad Redis (`call:state:<callId>`) + end par Mongo. Trace call mode mein **texts ke bina** (Phase 6 already redacts) → `CallEvent node_entered / node_exited`.

### 1b. Audio formats

| Where                          | Format                                                                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WebCall leg (browser ⇄ server) | PCM16 LE mono **24 kHz**, **20 ms = 960 bytes** per binary frame (websocket.md §8)                                                                       |
| SIP leg (Phase 13)             | G.711 μ-law 8 kHz, 20 ms = 160 bytes                                                                                                                     |
| Internal (`AudioFrame`)        | `{ pcm: Int16Array, rate: 8000 \| 16000 \| 24000 }` — no float pipeline                                                                                  |
| Realtime session               | Leg ke hisaab se: WebCall → `audio/pcm` 24 kHz; SIP → `audio/pcmu` (no resample either way)                                                              |
| TTS output                     | Provider PCM16 24 kHz → leg rate par resample (cache 24 kHz PCM)                                                                                         |
| STT input                      | Realtime transcription session, same format as the leg                                                                                                   |
| Recording                      | **WAV PCM16 stereo 8 kHz** (customer = left, bot = right), 32 KB/s (15 min ≈ 29 MB)                                                                      |
| `play_audio` files             | WAV (PCM16 / μ-law / A-law) native; **MP3 via a WASM decoder** (exact version pinned after license check; decoded once, cached as 24 kHz PCM in storage) |

- Resampler: linear-phase windowed-sinc (PoC `poc/voice-ai/src/audio.ts` se port + tests: 8↔16↔24 kHz, round-trip SNR ≥ 30 dB on a 1 kHz tone).
- μ-law encode / decode: ITU G.711 tables, bit-exact tests.
- Pacing: outbound audio server se **real time** mein jaata hai (20 ms tick), browser playback buffer ≤ **200 ms** ahead (backpressure: `ws.bufferedAmount` > 64 KB → pause). Barge-in par queue turant khaali.
- Inbound jitter: browser frames 20 ms ke batches; server sirf order + gap detect (missing → silence fill, counted in metrics).

### 1c. `TelephonyProvider` + `CallLeg` (ADR 0020)

```ts
interface TelephonyProvider {
  readonly name: 'webcall' | 'sip';
  startCall(req: StartCallRequest): Promise<CallLeg>; // webcall: waits for the browser socket
}
interface CallLeg {
  readonly rate: 8000 | 24000;
  onAudio(cb: (frame: Int16Array) => void): void;
  sendAudio(frame: Int16Array): void; // paced by the bridge
  clearAudio(): void; // barge-in flush (webcall: `audio.clear`)
  onDtmf(cb: (digit: string) => void): void;
  onStatus(cb: (s: LegStatus) => void): void; // ringing | answered | ended(cause)
  transfer(to: string): Promise<TransferResult>; // webcall: asks the tester (simulated)
  hangup(cause: HangupCause): Promise<void>;
}
```

- WebCall "ringing" = socket open + ticket valid; "answered" = first `call.ready` from the browser (mic granted). 15 s mein ready nahi → `failed (media_timeout)`.
- Hangup causes (mapped): `normal`, `customer_hangup`, `media_timeout`, `media_error`, `server_shutdown`, `limit`.

### 1d. `/ws/media` protocol (websocket.md §8 + additions)

- **Auth:** `POST /api/v1/calls/web` (Bearer, `calls.trigger`) creates the call (`queued`) and returns `{ callId, mediaTicket, wsUrl }`. Ticket: single use, **60 s**, bound to `{ accountId, userId, callId }`, stored hashed in Redis (same pattern as `/ws` tickets). Socket: `GET /ws/media?ticket=…` (upgrade on the same server, path check).
- **Control (JSON text, ≤ 16 KB):** client → `call.ready { sampleRate: 24000 }`, `call.dtmf { digit }`, `call.hangup {}`, `call.transfer_result { result }` (tester buttons), `call.say_text { text }` (**fake / test only**, §1f), `call.mute { muted }`. Server → `call.started { callId }`, `call.status { status }`, `call.transcript { seq, speaker, text, final }`, `call.event { type, data }`, `call.transfer { phoneLast4 }` (ask tester), `audio.clear {}`, `call.ended { reason, durationSec, costMicros }`, `error { code, message }`.
- **Binary:** exactly **960 bytes** (20 ms @ 24 kHz) in both directions; any other size → close `4008`. Inbound ≤ 60 frames/s (burst 100) else `4008`.
- Close codes: websocket.md §7 + `4011` call already connected, `4012` call ended.
- One socket per call; reconnect not supported in Phase 7 (socket drop → `customer_hangup` after 5 s grace).
- Ticket / socket refused while impersonating (calls cost money) — `403` / `4003`.

### 1e. Call model & lifecycle (data-model.md Call / CallEvent / TranscriptTurn)

- **Call** (data-model draft) + Phase 7 fields: `isTest: true` (all web calls), `source: { kind: 'flow' | 'agent', flowId?, flowVersionRef: 'draft' | number, agentId? }`, `startedBy` (user), `endReason`, `metrics { latency { p50Ms, p95Ms, maxMs, turns }, bargeIns, silencePrompts, framesIn, framesOut, gapsIn, realtime { inputAudioTokens, outputAudioTokens, inputTextTokens, outputTextTokens, cachedTokens } }`, `outcome` (same shape as `FlowRun.outcome` / Phase 5 outcome), `holdId`, `ledgerEntryId`, `recording`.
- **Status:** `queued` (created, waiting for socket) → `ringing` (socket open) → `in_progress` (ready) → `completed` | `failed` | `canceled` (hung up before ready). `busy` / `no_answer` reserved for SIP.
- **End reasons:** `hangup_node`, `agent_end_call`, `customer_hangup`, `transferred`, `max_duration`, `wallet_empty`, `ai_failed`, `engine_error`, `media_timeout`, `media_error`, `server_shutdown`, `canceled`, `limit`.
- **CallEvent** (immutable, `seq` per call): `status`, `node_entered`, `node_exited`, `dtmf`, `speech_started`, `barge_in`, `silence_prompt`, `ai_session_started`, `ai_function_call` (name + redacted args), `ai_function_result` (status, ms), `ai_outcome`, `tts` (chars, cached, ms), `latency` (ms), `wallet_extend`, `transfer`, `recording_saved`, `error` (code only). No texts.
- **TranscriptTurn** finals only: `{ seq, speaker: customer | bot, text, language?, startMs, endMs, interrupted, source: tts | ai | stt | dtmf }` (DTMF as `"[1]"`).
- TTL / retention: calls, events, transcripts, recordings **180 days** default (`CALL_RETENTION_DAYS`, open question §7) — daily `calls-purge` job (recordings first, then docs).

### 1f. Voice providers (core/voice)

| Interface                                             | OpenAI (real)                                                                                                                                                                                                                                                                          | Fake (deterministic, default without a key)                                                                                                                                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VoiceAiProvider.open()` → `AiVoiceSession`           | Realtime WS `wss://api.openai.com/v1/realtime?model=OPENAI_REALTIME_MODEL` (`gpt-realtime-2.1-mini` default), `session.update` (instructions, voice, `audio/pcm` or `pcmu`, `server_vad` 0.5 / 300 / 500 ms, `interrupt_response`, `input_audio_transcription`, tools), events → typed | Transcripts come from `call.say_text` (or empty for real mic audio); replies from the Phase 5 fake chat rules (same paid / unpaid / promise / transfer texts); audio = fake TTS; tool calls through the real executor |
| `TtsProvider.synthesize(text, voice, language, tone)` | `gpt-4o-mini-tts` → PCM16 24 kHz (instructions carry language + tone)                                                                                                                                                                                                                  | Tone 440 Hz at −20 dBFS, **60 ms per character** (cap 20 s) — deterministic length, non-empty recording                                                                                                               |
| `SttProvider.open(language)` → `SttSession`           | Realtime transcription session (`gpt-4o-mini-transcribe`, server VAD, `language` hint)                                                                                                                                                                                                 | Final transcript = next `call.say_text` text; energy VAD on mic audio still emits `speech_started` / `speech_stopped` (text "")                                                                                       |

- `VOICE_PROVIDER = fake | openai` (default follows `AI_PROVIDER`; **production requires openai**). `VOICE_TEXT_INPUT_ENABLED` (default `true` only outside production; **refused in production by env validation**) — allows `call.say_text`.
- OpenAI client: `ws` package (already a dependency), 10 s connect timeout, 1 reconnect attempt at session start only (never mid-call), API key only server-side, request-id logged. Event parsing with zod (unknown events ignored + counted).
- Tests: recorded Realtime event streams (JSON fixtures from the PoC event types) replayed into the parser / session — **no network**.
- Fake rules shared with Phase 5 (`core/ai/fake.provider.ts`), so E2E texts are the same as the playground / simulator (`FAKE` in e2e/agents.ts).

### 1g. Flow ⇄ voice host (`core/voice/flow-host.ts`)

| Engine output                            | Live behaviour                                                                                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `say { text, language, interruptible }`  | TTS (cache) → leg; transcript bot turn (`source: tts`); `interruptible` → customer speech stops playback (barge-in) and the speech goes to the next listener    |
| `play { audioId }`                       | Decoded audio (cache) → leg; missing file → engine already gives fallback text                                                                                  |
| `listen_dtmf { timeoutSec, … }`          | Keypad digits → `dtmf` inputs (menu: first digit; digits mode: collect until finish key / max / inter-digit 3 s); timer → `no_input` input                      |
| `listen_speech { language, timeoutSec }` | STT session; final transcript → `speech` input; timer from listen start (restarted on `speech_started`) → `no_input`                                            |
| `ai_reply` / waiting `kind: ai`          | **AiVoiceSession** owns the audio until it ends (§1h); then the host sends the new engine input `ai_session_end` (below)                                        |
| `pause { seconds }`                      | Real timer (silence frames to the leg) → `timer` input                                                                                                          |
| `transfer { phone }`                     | WebCall: `call.transfer` to the tester → `transfer_result` input from its buttons (60 s → `no_answer`); `connected` ends the call `transferred` (Phase 13 real) |
| `message_queued`                         | Stays in the outcome (Phase 10 sends)                                                                                                                           |
| `hangup { reason }`                      | Finish playback (max 10 s), then hang up the leg                                                                                                                |

- **Engine extension (small, tested):** new input `{ kind: 'ai_session_end', outcome, reason: 'outcome' \| 'no_response' \| 'max_turns' \| 'fallback' \| 'end_call', turns }` accepted while waiting `kind: 'ai'` → same exit mapping as the text path (`aiExitOf`). Text simulator unchanged.
- Order guarantee: outputs are played **in order**; the next input is accepted only after the outputs before the wait are queued (DTMF pressed during a prompt is kept — "type-ahead" — like real IVRs).
- Max duration: `min(flow.settings.maxDurationSec, agent.callBehaviour.maxCallDurationSec if AI)`; at the limit → engine `max_duration` path (polite end).
- Account start lines (before the engine starts): **recording notice** when `recordingEnabled` (account setting text, default "Yeh call quality ke liye record ki ja rahi hai."). The AI disclosure stays in the flow / agent texts (Phase 6 templates already have it).
- Engine state persisted to Redis after every input; FlowRun (mode `call`) written at the end with outcome, variables, trace; node stats `mode: 'call'`.

### 1h. Live AI voice session (`core/voice/ai-session.ts`)

- Used by the `ai_agent` node **and** by agent-only calls (`source.kind: 'agent'`).
- Instructions: `compileAgent(agent, { channel: 'voice', extraInstructions: step goal })` (Phase 5/6), allowed variables only, opening line spoken when `speakOpeningLine` / agent-only.
- **Tools:** custom functions (Phase 5 secure executor, `source: 'call'` in `agentToolCalls`), built-ins in **live mode** (`end_call` → finish reply then end, `transfer_to_human` → transfer action, `set_disposition`, `schedule_callback`, `save_promise_to_pay`, `send_sms_after_call` → outcome queue), **`search_knowledge(query)`** when the agent has knowledge bases (embedding charged via `chargeUsage`, kind `call`).
- Function-call loop: `response.function_call_arguments.done` → execute (timeout from the function, max 5 calls per turn) → `function_call_output` + `response.create`.
- **Turn-taking:** server VAD; `speech_started` while bot audio plays → `clearAudio()` + `conversation.item.truncate { audio_end_ms = ms actually played }` + bot turn `interrupted: true` (when `callBehaviour.bargeIn`; off → customer audio ignored while the bot speaks).
- **Silence:** no customer speech for `callBehaviour.silenceTimeoutSec` → bot asks "Hello? kya aap sun rahe hain?" (language-aware fixed text via `response.create` with instructions); after `endCallAfterSilenceRetries` → session ends `no_response`.
- **Limits:** step `maxTurns` (flow) / agent `maxCallDurationSec`; agent caps (`assertAgentBudget`) before open and every turn; wallet hold extension failure → `wallet_empty` path.
- **Language auto-switch:** `languageMode: auto` → instructions "reply in the customer's language (Hindi / English / Hinglish)"; detected language saved per transcript turn (from transcription `language` when present, else a cheap heuristic on Devanagari / Roman Hindi markers — same as the fake provider).
- **Tone:** persona tone rules from Phase 5 (`toneTriggers`) + voice from agent; TTS instructions mirror the tone for `say` nodes.
- Fallbacks: open fails / provider error mid-call → agent `fallback.aiFailed` text via TTS → session ends `fallback` (flow: AI error exit → error handler; agent-only: hang up `ai_failed`).

### 1i. Latency & metrics

- Per bot turn: **customer last speech frame** (VAD `speech_stopped` / DTMF time) → **first bot audio frame sent to the leg**. Recorded as `latency` CallEvent + `metrics.latency` (p50 / p95 / max). Logged as numbers only.
- Targets (ADR 0021 thresholds): **p50 ≤ 1.2 s, p95 ≤ 2 s** on OpenAI (measured when the key arrives); fake provider pipeline overhead **≤ 150 ms** (asserted in tests with fake timers + in `bench:voice`).
- `bench:voice` (refuses production): 20 concurrent fake calls × 2 min → CPU per call, event-loop lag p99, frames late %, memory per call.

### 1j. Recording

- When `account.settings.recordingEnabled` (default `true`): both directions written live to a stereo 8 kHz WAV temp file (`os.tmpdir()/cav-rec/<callId>.wav`, header patched at the end), uploaded to storage `accounts/<accountId>/recordings/<callId>.wav` after the call, temp file deleted.
- `recording { fileKey, durationSec, sizeBytes, format: 'wav' }` on the call; upload failure → retried by a queue job (3×), then `recording_failed` event.
- Playback: `GET /calls/:id/recording` → signed URL (5 min, `calls.listen`), audited `call.recording_accessed`; never while impersonating.
- No recording charge in Phase 7 (`recording_charge` ledger type stays unused — open question).

### 1k. Billing

- **Start:** `holdForCall({ ref: { type: 'call', id }, idempotencyKey: 'hold:<callId>' })` before `ringing`; fails → `422 WALLET_INSUFFICIENT_BALANCE` (call `failed`, no socket). Also the monthly call budget check (Phase 4 rules).
- **Running:** when the hold covers < 60 s more → `extendHold` (2 min); `{ ok: false }` → polite fixed line "Aapka balance khatam ho gaya hai, call yahin samaapt ki ja rahi hai." → hang up `wallet_empty`.
- **End:** `settleCall({ usage: { answered, durationSec, aiSeconds, ttsChars, telephony: provider !== 'webcall' } })` — idempotent `settle:<holdId>`; canceled before answer → `releaseHold`.
  - **Pricing change (small, tested):** `CallUsage.telephony` (default `true`); WebCall test calls bill **no telephony minutes** (we pay no carrier) — only AI + TTS + commission.
  - `aiSeconds` = wall time the AI voice session (Realtime) was open; `ttsChars` = characters of every `say` actually played (cached or not).
- Text-model charges inside calls (AI intents, knowledge embeddings) → `chargeUsage` kind **`call`** (`ref: { type: 'call', id }`), idempotent per input.
- Agent usage (`AgentUsage`) gets the call's AI micros at settle (agent caps see call spend).
- Reaper (Phase 4) already releases stale holds; the new **calls reaper** marks calls with a stale Redis heartbeat (> 60 s) as `failed (server_shutdown)` and settles with the last known usage.

### 1l. Failure handling & limits (`CALL_LIMITS`)

| Limit / rule                      | Value                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Concurrent web calls per account  | 3 (`429 CALL_LIMIT_REACHED`)                                                                                                         |
| Concurrent calls per process      | 20 (`503 CALL_CAPACITY`)                                                                                                             |
| Web call creation rate            | 10 / min per user (`rl:callweb:`)                                                                                                    |
| Ticket TTL / socket ready timeout | 60 s / 15 s                                                                                                                          |
| Socket drop grace                 | 5 s → `customer_hangup`                                                                                                              |
| Max call duration (hard)          | 3600 s (flow / agent limits are lower)                                                                                               |
| Inbound idle (no frames)          | 30 s → `media_timeout`                                                                                                               |
| TTS text / cache                  | 1000 chars per `say`; cache entries unused 30 days purged                                                                            |
| Function calls per AI turn        | 5                                                                                                                                    |
| Hangup playback wait              | 10 s                                                                                                                                 |
| Graceful shutdown                 | SIGTERM → every live call says the fixed "technical issue" line (≤ 5 s), hangs up `server_shutdown`, settles; then the server closes |

- Any exception inside a session → `engine_error` / `media_error` end, settle, `error` event (code only), never crashes the process (per-call error boundary + `unhandledRejection` guard tested).

### 1m. Security & privacy

- `call:<id>` WS topic subscription **checks the call belongs to the account** (closes the Phase 1 TODO in `core/realtime/topics.ts`), `calls.read`.
- Media ticket bound to user + call; one socket per call; frame size / rate limits; JSON control validated with zod; `call.say_text` refused unless `VOICE_TEXT_INPUT_ENABLED` (never in production).
- No audio, transcript text, prompts, phones or secrets in logs; OpenAI key only in the backend; tool args redacted as in Phase 5.
- Contact phone never sent to the browser or the model (only `phone_last4` when allowed); test calls go to the logged-in user, not the contact.
- Recordings: storage keys via `storageKey()`, signed URLs, audited access, purge.
- Impersonation: can read calls / transcripts, cannot start calls or play recordings (consistent with Phase 2–6 rules).

### 1n. Permissions & roles (already in RBAC)

| Permission      | Owner / Admin | Manager | Agent | Viewer |
| --------------- | ------------- | ------- | ----- | ------ |
| `calls.read`    | ✓             | ✓       | ✓     | ✓      |
| `calls.trigger` | ✓             | ✓       | ✓     | —      |
| `calls.listen`  | ✓             | ✓       | ✓     | —      |
| `calls.export`  | ✓             | ✓       | —     | —      |

- Starting a web call with a flow also needs `flows.read`; with an agent `agents.read`. Draft flows need **0 errors** (same rule as the simulator).

### 1o. API surface (all `/api/v1`, Bearer, tenant-scoped)

| Method | Path                    | Notes                                                                                                                                                   |
| ------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/calls/web`            | `{ flowId + version ('draft' \| 'published' \| n) \| agentId, contactId? \| variables?, testPhone? }` → `{ call, mediaTicket, wsUrl }`; hold taken here |
| GET    | `/calls`                | Filters: `status`, `flowId`, `agentId`, `contactId`, `isTest`, `from`, `to`, `q` (contact name); cursor pagination                                      |
| GET    | `/calls/:id`            | Call + outcome + metrics + cost                                                                                                                         |
| GET    | `/calls/:id/transcript` | Final turns                                                                                                                                             |
| GET    | `/calls/:id/events`     | Timeline                                                                                                                                                |
| GET    | `/calls/:id/recording`  | Signed URL (`calls.listen`), audited                                                                                                                    |
| POST   | `/calls/:id/hangup`     | Ends a live call from another tab (`calls.trigger`)                                                                                                     |
| GET    | `/calls/active`         | Live calls of the account (registry)                                                                                                                    |
| WS     | `/ws/media?ticket=`     | §1d                                                                                                                                                     |

- Error codes (+3 → 44): `CALL_LIMIT_REACHED` (429), `CALL_CAPACITY` (503), `CALL_NOT_ACTIVE` (409). Existing reused: `WALLET_INSUFFICIENT_BALANCE`, `AI_UNAVAILABLE`, `FLOW_INVALID`, `NOT_FOUND`.
- Audit actions (+3 → 71): `call.test_started`, `call.recording_accessed`, `call.hung_up_remotely`.
- WS events (websocket.md §5, already listed): `call.created`, `call.status`, `call.transcript`, `call.dtmf`, `call.ended`.
- Ledger usage kind `call` already exists (Phase 5 enum).

### 1p. Frontend

- **Audio:** `AudioWorklet` capture (mic → resample to 24 kHz PCM16 in the worklet → 960-byte frames) and playback (ring buffer, `audio.clear` flush, underrun = silence); `getUserMedia` with echo cancellation + noise suppression on; mic level meter; mute.
- **Web Call Tester** (`/calls/test`, `calls.trigger`): pick flow (+ version) or agent, contact (search) or typed values + test phone, **Start call** → mic permission → live transcript (partials greyed, finals solid, interrupted marked), keypad (DTMF), transfer prompt buttons, hang up, status chip + timer, latency per turn, events timeline, outcome, cost after end, fake-AI badge, "Type instead of speaking" box when the backend allows text input. Errors: mic denied, wallet empty, limits, socket drop.
- **Calls** (`/calls`, `calls.read`): table (time, source flow / agent, contact, status, end reason, duration, cost, test badge), filters in the URL, live updates (`call.status` / `call.ended`).
- **Call detail** (`/calls/:id`): summary, recording player (`calls.listen`), transcript with timestamps (click → seek), timeline, cost breakdown (AI / TTS / commission), outcome, metrics (latency, barge-ins), link to the flow version / agent.
- **Entry points:** "Test call" in the flow builder toolbar (saved draft or published) and the agent editor; Settings → Calls (recording on / off, recording notice text — owner / admin); ledger drawer shows call breakdown; `LIVE_PHASE = 7` (Calls in the menu).
- Lazy chunks: the tester (worklets) and call detail; main bundle growth target ≤ 5 KB gzip.

### 1q. Testing strategy

- **Unit (backend):** audio (resample SNR, μ-law tables, framing, VAD, WAV writer), provider event parsers (recorded fixtures), state machine, flow host with a fake leg + fake clock (every output type, barge-in, type-ahead DTMF, timers), AI session with fake provider (tools, silence, truncate), billing math (`telephony: false`), limits, reaper, shutdown.
- **Integration:** a Node test client opens `/ws/media`, streams synthetic PCM, sends DTMF / `call.say_text`, asserts transcript, events, Call doc, ledger rows, recording file (fake storage).
- **Frontend unit:** worklet logic as plain functions (resampler, framer, ring buffer) + JSDOM with a fake `MediaStream` / `WebSocket`.
- **E2E (Playwright, Chromium):** `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<backend docs/samples/audio/customer.wav>`; fake voice provider + `call.say_text` via the tester's text box; mock payment API.
- Coverage gates stay ≥ backend 95 / 85 / 95 / 95, frontend 95 / 90 / 90 / 95.

### 1r. Contract for later phases

| Function / data                                                                     | Used by                                                   |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `TelephonyProvider` / `CallLeg` (μ-law 8 kHz leg rate)                              | Phase 13 SIP (Asterisk ARI + ExternalMedia)               |
| `CallService.startCall({ provider, to, contactId, source, campaign? })` + lifecycle | Phase 8 campaigns (dialer), Phase 14 inbound              |
| `Call` / `CallEvent` / `TranscriptTurn` / `FlowRun (mode call)` / node stats `call` | Phase 9 reports, call detail, summaries                   |
| `call.ended` internal event (outcome, cost, disposition)                            | Phase 8 retries / callbacks, Phase 10 webhooks + messages |
| `VoiceAiProvider`, `TtsProvider`, `SttProvider`                                     | Live OpenAI (key), later STT → LLM → TTS pipeline         |
| Calling-window + DND checks hook (`assertDialAllowed`) — no-op for web test calls   | Phase 8                                                   |

---

## 2. Tasks ka overview

| #     | Task                                                                                                                                                            | Repo | Size | Depends on   |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---- | ------------ |
| T7.1  | Models (Call, CallEvent, TranscriptTurn, TtsCacheEntry), FlowRun `callId`, migration 0008, `CALL_LIMITS`, env, error codes, audit, WS, pricing `telephony` flag | BE   | M    | —            |
| T7.2  | Audio core: PCM16 / μ-law, resampler, framer, pacer, energy VAD, stereo WAV recorder, WAV / MP3 decode + cache                                                  | BE   | M    | —            |
| T7.3  | Voice providers: `VoiceAiProvider` / `TtsProvider` / `SttProvider` — OpenAI Realtime + TTS + transcription, fake providers, TTS cache                           | BE   | L    | T7.1, T7.2   |
| T7.4  | Telephony: `TelephonyProvider` / `CallLeg`, WebCall provider, `/ws/media` (tickets, protocol, limits), topic authorisation                                      | BE   | M    | T7.1, T7.2   |
| T7.5  | Call session manager: lifecycle, Redis registry, limits, billing hold / extend / settle, recording, persistence, WS, shutdown, reaper, purge                    | BE   | L    | T7.1–T7.4    |
| T7.6  | Flow voice host: outputs → audio, inputs (DTMF, STT, timers), barge-in for `say`, engine `ai_session_end` input, call-mode trace / stats                        | BE   | L    | T7.5         |
| T7.7  | Live AI voice session: Realtime agent (tools live, built-ins live, knowledge tool), barge-in truncate, silence, caps, language, fallbacks, latency              | BE   | L    | T7.5, T7.6   |
| T7.8  | Calls API (`/calls/web`, list, detail, transcript, events, recording, hangup, active) + OpenAPI                                                                 | BE   | M    | T7.5–T7.7    |
| T7.9  | Seed (sample calls), samples (`customer.wav`), ADR 0035 (+ 0020 / 0021 updates), `bench:voice`, docs, live-OpenAI checklist                                     | BE   | M    | T7.8         |
| T7.10 | FE foundation: clients, `gen:api`, routes, `LIVE_PHASE = 7`, WS events, audio worklets, media socket client                                                     | FE   | M    | T7.8         |
| T7.11 | Web Call Tester page                                                                                                                                            | FE   | L    | T7.10        |
| T7.12 | Calls list + call detail (recording, transcript, timeline, cost, outcome)                                                                                       | FE   | M    | T7.10        |
| T7.13 | Entry points: builder / agent "Test call", Settings → Calls, ledger breakdown, dashboard recent calls                                                           | FE   | S    | T7.11, T7.12 |
| T7.14 | Playwright E2E (fake mic + fake voice): Done when + barge-in, silence, wallet empty, agent-only, roles                                                          | FE   | M    | T7.11–T7.13  |
| T7.15 | Gap audit, security checklist, docs, Phase 7 sign-off                                                                                                           | both | M    | all          |

Batches: **Batch 1 = T7.1–T7.5** (`[P7-B1-DONE]`), **Batch 2 = T7.6–T7.9** (`[P7-B2-DONE]`), **Batch 3 = T7.10–T7.15** (`[P7-B3-DONE]`).

---

## 3. Tasks — step by step

### T7.1 — Models, migration 0008, limits, catalogue

- [x] `call.model.ts` (data-model Call + §1e Phase 7 fields), `call-event.model.ts` (immutable hooks like FlowVersion), `transcript-turn.model.ts`, `tts-cache.model.ts` (`{ key (sha256), voice, language, model, chars, fileKey, durationMs, hits, lastUsedAt }`); all `tenantPlugin` except the TTS cache (platform-wide, text hash only — listed in `NOT_TENANT_SCOPED` with the reason).
- [x] `FlowRun.callId` (sparse index); `RUN_MODES` already has `call`.
- [x] Migration **0008-calls**: indexes (data-model), `account.settings.recordingNotice` default; up / down + rollback test.
- [x] `CALL_LIMITS` (§1l) in `config/limits.ts`; env: `VOICE_PROVIDER`, `VOICE_TEXT_INPUT_ENABLED`, `OPENAI_TTS_MODEL` (`gpt-4o-mini-tts`), `OPENAI_TRANSCRIBE_MODEL` (`gpt-4o-mini-transcribe`), `OPENAI_REALTIME_MODEL` default `gpt-realtime-2.1-mini`, `CALL_RETENTION_DAYS` (180), `CALL_RECORDING_TMP_DIR`; production rules (openai only, text input off) + tests.
- [x] Error codes 41 → 44, audit 68 → 71 (meta shapes), WS event payload schemas, `CallUsage.telephony` in `callCharge` (+ tests, invoice lines unchanged for SIP).
- [x] data-model.md / error-codes.md / audit.md / websocket.md updated.

### T7.2 — Audio core (`core/voice/audio/`)

- [x] `pcm.ts` (Int16 helpers, dBFS, RMS), `mulaw.ts` / `alaw.ts` (G.711 tables), `resample.ts` (8 / 16 / 24 kHz, SNR test), `framer.ts` (exact 20 ms frames from any chunk sizes), `pacer.ts` (real-time sender with a fake clock, backpressure hook, `clear()`), `vad.ts` (energy VAD with hangover, speech_started / stopped), `wav.ts` (reader for PCM16 / μ-law / A-law, streaming stereo writer with header patch), `mixer.ts` (customer / bot → stereo 8 kHz).
- [x] MP3 decode: add a WASM MP3 decoder (exact version, licence MIT / LGPL-compatible checked, `allowScripts` unchanged) behind `decodeAudio(file) → PCM16 24 kHz`; decoded cache in storage `flow-audio-cache/<audioId>.pcm` (deleted with the audio).
- [x] Bench numbers (resample 1 s of audio, framer) in the test output (no perf asserts that flake).
- [x] 100 % branch tests for the pure audio code.

### T7.3 — Voice providers (`core/voice/providers/`)

- [x] Interfaces + typed events (`audio`, `transcript_partial` / `final`, `speech_started` / `stopped`, `function_call`, `response_done { usage }`, `error`), zod parsers for OpenAI Realtime server events (unknown → ignored + counted).
- [x] `openai.realtime.ts` (session open / update / sendAudio / truncate / function output / response.create / close, connect timeout, no mid-call reconnect), `openai.tts.ts` (REST, streaming PCM), `openai.stt.ts` (transcription session).
- [x] `fake.voice.ts` (§1f), `fake.tts.ts`, `fake.stt.ts` — deterministic; share Phase 5 fake rules.
- [x] `tts-cache.ts`: key = sha256(model + voice + language + tone + text), storage file + `TtsCacheEntry`, hit counter, single-flight per key (two calls saying the same line synthesize once), purge job (30 days unused).
- [x] Recorded fixture streams (`tests/fixtures/realtime/*.jsonl`) from the PoC event shapes; no network in tests (axios / ws mocked).
- [x] `providers.ts` picks fake / OpenAI by env; health / config in `/admin/ai/config` (voice provider, models, key set).

### T7.4 — Telephony + `/ws/media`

- [x] `core/telephony/types.ts` (§1c), `webcall.provider.ts` (+ `CallLeg` over a socket), hangup cause mapping.
- [x] Media tickets (`calls/media-tickets.ts`: create / consume, hashed in Redis, 60 s, bound to user + call + account).
- [x] `/ws/media` upgrade handler next to `/ws` (path routing in `ws-server.ts`), protocol §1d with zod, frame size / rate limits, close codes, one socket per call, drop grace, impersonation refused.
- [x] `defaultAuthorizeTopic` → real check for `call:<id>` (account owns the call) and `campaign:<id>` (not found until Phase 8) + tests.
- [x] Integration tests with a `ws` test client (synthetic audio, bad frames, ticket reuse, expiry, wrong account).

### T7.5 — Call session manager (`modules/calls/`)

- [x] `lifecycle.ts` pure transitions + end-reason rules; `session.ts` (per-call orchestrator, error boundary), `registry.ts` (Redis live keys + heartbeat + per-account / per-process counts), `call.service.ts` (`createWebCall`, `endCall`, `startCall` contract for Phase 8).
- [x] Billing: hold before `ringing`, extend timer, settle / release; `wallet_empty` polite end; `chargeUsage` kind `call` helper; AgentUsage update.
- [x] Recording pipeline (§1j) with the fake storage in tests; upload retry job; `recording_saved` / `recording_failed` events.
- [x] Persistence: CallEvent `seq` allocator (atomic), TranscriptTurn finals, Call status / timestamps / metrics; WS `call.created` / `status` / `transcript` / `dtmf` / `ended`.
- [x] Graceful shutdown hook in `core/lifecycle.ts`; `calls-reaper` (stale heartbeat) and `calls-purge` (retention) jobs in the queue scheduler.
- [x] Tests: lifecycle table, limits (429 / 503), hold failure → no call, extend failure → `wallet_empty`, settle idempotent, reaper, shutdown, purge, logs without texts.

**`[P7-B1-DONE]`** after T7.5 (full verify, manual: a Node script makes a fake call end to end on the dev server).

### T7.6 — Flow voice host (`core/voice/flow-host.ts`)

- [x] Output → audio mapping §1g with the TTS cache, audio decode cache, timers (fake clock in tests), type-ahead DTMF, digits collection, STT sessions per listen, transfer prompt to the tester.
- [x] Barge-in for interruptible `say` (VAD / STT `speech_started` → `clearAudio`, transcript `interrupted`, speech kept for the next listener); non-interruptible → customer audio ignored until playback ends.
- [x] Engine extension: `ai_session_end` input (+ engine / node tests, simulator untouched, fuzz test still green).
- [x] Recording notice line, max duration, hangup playback wait, engine state in Redis, FlowRun `mode: call` + `callId`, node stats `call`, trace → CallEvents (no texts).
- [x] Tests: every Loan recovery branch on a fake leg (press 1 paid / unpaid → AI, press 2, press 3, silence ×3, wrong keys ×3) with exact template texts in the transcript; DTMF during a prompt; a 500 API node; missing audio file fallback; MP3 + WAV play.

### T7.7 — Live AI voice session (`core/voice/ai-session.ts`)

- [x] Session open with `compileAgent(voice)` + step goal, tools (custom live, built-ins live — implement `mode: 'live'` in `core/ai/tools.ts`, knowledge search tool), opening line rules.
- [x] Function loop (max 5 per turn, timeouts), tool logs `source: 'call'`, outcomes → session end reasons → `ai_session_end` (flow) or call end (agent-only).
- [x] Barge-in truncate with played-ms tracking, silence prompts + retries, max turns / duration, `assertAgentBudget` + wallet checks, language detection per turn, tone, fallbacks (§1h).
- [x] Latency measurement (§1i) + metrics; Realtime usage tokens into `metrics.realtime`.
- [x] Tests with the fake provider and with replayed OpenAI fixtures: paid / unpaid / promise ("kal tak de dunga" → tomorrow IST) / transfer / end_call / knowledge / tool error / provider error mid-call / cap reached / wallet empty / barge-in / silence.

### T7.8 — Calls API

- [x] Routes §1o with schemas (`calls.schema.ts`), service, OpenAPI registration, rate limit `rl:callweb:`, audit, impersonation rules, suspended account → 403 for starts.
- [x] `POST /calls/web` validations: flow draft with errors → 422 `FLOW_INVALID`, foreign flow / agent / contact → 404, manual values rules from the simulator (reused), concurrency.
- [x] Tests: every route, roles (viewer read-only, agent can test, impersonator read-only), isolation (another account → 404, never listed), pagination, filters, recording URL audited + expires.

### T7.9 — Seed, samples, ADR, bench, docs (`[P7-B2-DONE]` after this)

- [x] `npm run fixtures:audio` adds `docs/samples/audio/customer.wav` (24 kHz speech-like noise bursts for the Chromium fake mic) — deterministic.
- [x] Seed: two finished demo calls (flow + agent-only) with transcript, events, recording (fake TTS audio), ledger rows — idempotent.
- [x] ADR **0035 — Voice runtime** (architecture §1a, audio formats, one-process ownership, billing, barge-in); ADR 0020 → accepted (interface built); ADR 0021 stays **proposed** until live runs (follow-up note).
- [x] `npm run bench:voice` (§1i) numbers in README + sign-off.
- [x] Docs: README (Calls section, env vars, how to test with the browser), security.md (media socket, recordings), compliance.md (recording notice, retention), api.md, `docs/setup/openai.md` (Realtime + TTS + transcription live checklist, ZDR), cost-model.md (per-minute numbers from `metrics.realtime` once live).
- [x] Manual check on the dev server with the browser (fake provider): every Loan recovery branch by voice / keypad, recording plays, ledger row, clean logs.

### T7.10 — Frontend foundation

- [x] `gen:api`; clients `calls.ts`; `features/calls/{keys,queries}.ts`; WS events (`call.*`); `LIVE_PHASE = 7`; routes `/calls`, `/calls/test`, `/calls/:id` (tester + detail lazy).
- [x] `src/features/calls/audio/`: capture worklet (downmix, resample to 24 kHz, 960-byte frames), playback worklet (ring buffer, clear, underrun count), `media-socket.ts` (ticket connect, control messages, binary frames, close codes → messages), mic permission helper; pure logic tested in Vitest.

### T7.11 — Web Call Tester

- [x] Setup panel (flow + version or agent, contact or typed values + test phone, mic check with level meter), Start → states (connecting / ringing / in call / ended), timer, mute, hang up, keypad, transfer prompt, "Type instead of speaking" (only when the server says text input is allowed), live transcript (partials / finals / interrupted), events timeline, latency chips, outcome + cost at the end, fake-AI badge, errors (mic denied, wallet, limits, socket drop), leave-page guard during a call.
- [x] Tests with a fake `MediaStream`, fake `AudioContext` / worklet port and a fake media socket.

### T7.12 — Calls list + call detail

- [x] List (filters in the URL, cursor pagination, live status / ended updates, test badge, empty state).
- [x] Detail (summary, recording player with `calls.listen` + signed URL refresh, transcript with timestamps → seek, timeline, cost breakdown, outcome, metrics, links to the flow version / agent / contact, hang up for live calls).
- [x] Tests incl. roles (viewer no player, impersonator no player).

### T7.13 — Entry points

- [x] Flow builder toolbar "Test call" (saved draft / published, disabled with unsaved changes), agent editor "Test call", Settings → Calls (recording on / off, notice text — owner / admin), ledger drawer call breakdown (AI / TTS / commission, "Web test call"), dashboard "Recent calls" card.
- [x] Bundle check (main chunk growth ≤ 5 KB gzip, tester / detail in their own chunks).

### T7.14 — Playwright E2E

- [x] Chromium launch args (fake mic file + fake UI), helpers `e2e/calls.ts` (`startWebCall`, `pressKey`, `sayText`, `expectBotLine`, `expectCustomerLine`, `hangUp`, `openCall`).
- [x] Scenarios (separate short tests):
  1. **Done when (keypad):** Loan recovery flow (published), paid contact → greeting with name + amount → press 1 → API check → thanks → ended; call detail has transcript, recording (plays, duration > 0), ledger **call charge** (AI + TTS, no telephony).
  2. **Done when (voice, Hinglish):** unpaid contact → press 1 → AI → "maine pay kar diya" → unpaid reply → "kal tak de dunga" → promise for tomorrow (IST) → ended, outcome Promise to pay.
  3. **English:** agent-only call, "I have already paid" → English paid reply (fake rules).
  4. **Barge-in:** text injected while the bot speaks → `audio.clear` seen, bot turn marked interrupted.
  5. **Silence / wrong keys:** callback branch; AI silence prompt.
  6. **Money & roles:** wallet too low → start refused; wallet runs out mid-call → polite end `wallet_empty`; viewer cannot start or play; impersonator read-only; 4th concurrent call refused.
- [x] All earlier 32 tests stay green; whole suite **twice**; `E2E_FRONTEND_PORT=3150` locally.

### T7.15 — Gap audit, security, docs, sign-off

- [x] Requirement → test table for §0 / §1 / every task; missing tests added.
- [x] Security checklist: media socket fuzz (bad frames, floods, ticket reuse, cross-account topics), `call.say_text` off in production config test, recordings signed + audited, logs grep in `E2E_BACKEND_LOGS=1` (no transcript texts, template texts, phones, secrets, `Bearer`, `sk-`), gitleaks both repos, isolation list.
- [x] Coverage re-measured (gates raised to new values rounded down to 5, never lowered), bundle numbers vs `main`.
- [x] Docs both repos (READMEs, CHANGELOGs), BUILD_PLAN Phase 7 ✅, PHASE_7_TASKS all `[x]`, this plan ticked + changelog, **PHASE_7_SIGNOFF.md**; `[P7-B3-DONE]` (full verify both repos, E2E twice, fresh clones without `.env`, actionlint, `infra:down`).

---

## 4. Deliverables checklist

- [x] `TelephonyProvider` / `CallLeg` + WebCall provider over `/ws/media` (tickets, limits, topic authorisation).
- [x] Call session manager: lifecycle, registry, limits, billing hold / extend / settle, recording, transcript, events, WS, shutdown, reaper, purge.
- [x] Audio bridge: G.711, resampling, framing, pacing, VAD, stereo recorder, WAV / MP3 decode.
- [x] Voice providers: OpenAI Realtime / TTS / transcription + deterministic fakes; TTS cache.
- [x] Flow voice host running Phase 6 flows live (every output type, barge-in, type-ahead DTMF, timers) + engine `ai_session_end` input.
- [x] Live AI voice session (tools live, built-ins live, knowledge, caps, silence, barge-in, language, fallbacks, latency).
- [x] Calls API + OpenAPI; seed; samples; `bench:voice`.
- [x] UI: Web Call Tester, Calls list, call detail, entry points, Settings → Calls.
- [x] Playwright: Done when (keypad + voice), English, barge-in, silence, money & roles.
- [x] Docs: ADR 0035 (+ 0020 / 0021 updates), data-model, conventions, setup (OpenAI live checklist), compliance, cost model, READMEs, CHANGELOGs, sign-off.

## 5. Risks

| Risk                                                          | Mitigation                                                                                                                    |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| No OpenAI key → voice quality / latency unproven              | Deterministic fake end to end; OpenAI path tested with replayed event fixtures; live checklist ready; ADR 0021 stays proposed |
| Event-loop blocking (audio math in JS) causes choppy audio    | Int16 math only, 20 ms pacing with lag metrics, `bench:voice` (20 calls), per-process call cap                                |
| Barge-in / echo: the bot hears itself through laptop speakers | Browser echo cancellation on; VAD threshold + hangover; bargeIn per agent; tester tip "use headphones"                        |
| Money leak on crashes (holds never settled)                   | Holds idempotent, Phase 4 hold reaper + calls reaper (stale heartbeat), settle idempotent, graceful shutdown                  |
| Recording PII                                                 | Notice line, signed URLs, `calls.listen`, audit, retention purge, no recording while impersonating                            |
| WebSocket abuse (floods, huge frames, ticket theft)           | Exact frame size, rate limits, single-use 60 s tickets bound to user + call, one socket per call, close codes                 |
| MP3 decoder dependency (size, licence, WASM)                  | Exact pin after licence check; decoded once and cached; WAV recommended in the UI                                             |
| Chromium fake mic differs from real mics                      | E2E proves wiring; manual browser check on the dev server each batch; real-mic smoke in the sign-off checklist                |
| Flaky timing tests                                            | Fake clock for pacer / timers / host; E2E waits on transcript lines and events, never on sleeps; no raised timeouts           |
| Low RAM on the dev machine                                    | `--maxWorkers=2`, wait for other projects' runs                                                                               |

## 6. Recommended order

| Day   | Tasks |
| ----- | ----- |
| 1     | T7.1  |
| 2     | T7.2  |
| 3–4   | T7.3  |
| 5     | T7.4  |
| 6–7   | T7.5  |
| 8–9   | T7.6  |
| 10–11 | T7.7  |
| 12    | T7.8  |
| 13    | T7.9  |
| 14    | T7.10 |
| 15–16 | T7.11 |
| 17    | T7.12 |
| 18    | T7.13 |
| 19    | T7.14 |
| 20    | T7.15 |

_Estimate — run batch-wise with one detailed run prompt (Batch 1 = T7.1–T7.5, Batch 2 = T7.6–T7.9, Batch 3 = T7.10–T7.15)._

## 7. Open questions (defaults used until answered)

| #   | Question                                                 | Who    | Default in Phase 7                                                                   |
| --- | -------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------ |
| 1   | OpenAI API key + budget; Zero Data Retention             | Client | Fake voice provider everywhere; live checklist ready                                 |
| 2   | Realtime model: `gpt-realtime-2.1-mini` vs full          | You    | Mini (≈ 3× cheaper); switch by env after the live PoC                                |
| 3   | Voice for the bot (and Hindi pronunciation check)        | Client | Agent setting (default `coral`)                                                      |
| 4   | Recording on by default + notice wording; retention days | Client | On, "Yeh call quality ke liye record ki ja rahi hai.", 180 days                      |
| 5   | Should web test calls cost the customer (AI + TTS)?      | You    | Yes (AI + TTS + commission, no telephony) — it is real AI usage                      |
| 6   | Recording storage price                                  | You    | Free in Phase 7                                                                      |
| 7   | Max concurrent test calls per account                    | You    | 3                                                                                    |
| 8   | Pre-recorded audio vs TTS for the main prompts           | Client | TTS (cached); `play_audio` available                                                 |
| 9   | MP3 support needed or WAV only                           | You    | MP3 via WASM decoder (pinned); if the licence check fails → WAV only + clear message |

---

## Changelog

- 2026-10-12: Plan created after Phase 6 sign-off (Phase 6 merged to `main`: backend `7a2a1e0`, frontend `87ce07b`).
- 2026-10-12: Run prompt [PHASE_7_PROMPT.md](../prompts/PHASE_7_PROMPT.md) added (one file, 3 batches). Precisions there: module layout, `/ws/media` upgrade routing next to `/ws/events`, the fake voice AI is a chat-backed session over `runAgentTurn` (new options `channel`, `billing: 'none'`, `builtInMode: 'live'`) — the same class is the "pipeline" option with OpenAI chat + TTS + STT (`VOICE_PIPELINE=chat`), controller / provider split, built-ins live mode effects, engine `ai_session_end` input shape, Call JSON, error codes 41 → 44, audit 68 → 71, WS payloads (`call.dtmf` without the digit), env vars, exact `CALL_LIMITS`, locked fixed lines, fake TTS / STT / VAD numbers, billing precision (`telephony: false`), registry keys, reaper / purge schedules, frontend routes + worklet loading, MP3 decoder candidate `mpg123-decoder` (licence check at T7.2).
- 2026-10-13: **Batch 1 done (T7.1–T7.5).** Deviations / precisions:
  - `CallLeg` paces audio itself: `play(pcm)` → `PlaybackResult`, `clearAudio()` (barge-in, returns played ms), `onOutgoing` (recording / latency) instead of a raw `sendAudio`.
  - The fake voice provider is the chat-backed session (`ChatVoiceSession`: STT → `runAgentTurn` → TTS) — the same class is the `VOICE_PIPELINE=chat` option; `runAgentTurn` gained `channel`, `billing: 'none'` and `builtInMode: 'live'`; built-ins now run in live mode (no `simulated` flag).
  - No 5 s drop grace: reconnects are not supported, so a closed media socket ends the call at once (`customer_hangup`).
  - Recording uploads retry inline (3 attempts) at the end of the call instead of a queue job; a recorder that opens after the call ended is removed.
  - Event / transcript sequence numbers are kept in memory by the owning session and written to `Call.seq` at the end (one process owns a call).
  - A refused wallet hold deletes the just-created call (no call record); calls nobody connects to are canceled after 75 s (ticket TTL + ready timeout) by the manager, and after 15 min by the reaper.
  - The per-account limit is check-then-register in Redis (two creates at the very same moment could pass 3 by one) — acceptable for test calls; Phase 8 dialing will use an atomic reservation.
  - MP3 decoding: `mpg123-decoder` 1.0.3 (MIT, WebAssembly, no install scripts; deps MIT / Apache-2.0), loaded through `require(esm)`.
  - Real bug found and fixed in T7.3: two simultaneous TTS requests for the same line both synthesised (single-flight registered too late).
  - Batch 1 manual check: `npm run dev:call` (in-process media server + real WebSocket client on the dev database): completed, 6 s, ₹0.24 (TTS + commission, no telephony), 178 KB stereo recording, 291 frames; the API route arrives in T7.8.
- 2026-10-15: **Batch 2 done (T7.6–T7.9).** Deviations / precisions:
  - Flow host: keys typed when a digits gather times out still count; a key or words arriving during an interruptible prompt cut it and skip the rest of that batch up to the next listener. The `hangup` engine input now carries why the call ended (`max_duration` / `engine_error`, else `customer_hangup`).
  - Max duration (§1g) is enforced by the session timer at `min(flow.settings.maxDurationSec or agent.maxCallDurationSec, 1 h)` (found missing after T7.6; separate fix commit); inside a flow AI step the controller also ends the call at the agent's limit.
  - The session gained `io.stream()` for replies whose audio arrives in pieces (Realtime deltas): whole 20 ms frames go out at once, barge-in and the bot line work like `say`.
  - Tool execution moved out of `runAgentTurn` into `createToolRunner` (shared by text turns and Realtime calls); `TurnResult.embeddingTokens` lets calls charge knowledge searches (`ai_charge`, kind `call`) while turns stay `billing: 'none'`.
  - Stopping a call now waits for the running AI step (outcome, language, AI seconds are kept); the AI node config is parsed with defaults like the engine does, and published versions get schema defaults (template graphs omit them).
  - Real bugs found and fixed with regression tests: a polite end (wallet, shutdown) was saved as `hangup_node` when the script returned on stop (fix commit); barge-in was missed while a finished reply was still playing; a silence prompt the provider never answered could hang the step.
  - Calls API: hangup from another tab works for calls on the same process (409 otherwise, until Phase 13 routing); `/calls` routes are mounted only where the voice runtime runs; the server builds the call manager before the app.
  - Seed / `dev:call`: the flow's payment check calls `APP_URL/api/v1/mock`, so both serve the mock API on that port while they run (all interfaces — `localhost` may resolve to `::1`). Demo calls always use the fake model (no spend).
  - `WebCallLeg.pacerStats` added for `bench:voice`. Last run (20 calls × 120 s, laptop on battery): CPU 1.8 % per call, event-loop lag p99 15 ms / max 35 ms, late pacer ticks 4.0 %, 0 stalled frames, ≈ 6 MB RSS per call, 20 / 20 recordings.
  - Manual check: there is no browser UI before Batch 3, so the Batch 2 check ran `npm run dev:call` through the real API and `/ws/media` with a WebSocket client: Loan recovery paid branch (26 s, ₹0.90, 793 KB recording) and agent-only (21 s, `agent_end_call`). The real-mic browser check moves to Batch 3 (T7.11 / T7.14).
  - Live OpenAI voice checklist written (docs/setup/openai.md V1–V7); not run — no key yet. ADR 0021 stays proposed.
  - Batch 2 verify: lint, typecheck, `openapi:check`, build — clean; 2,015 tests, coverage 97.29 / 89.14 / 97.13 / 98.32 (gate 95 / 85 / 95 / 95).
- 2026-10-16: **Batch 3 done (T7.10–T7.15) — Phase 7 complete**, see [PHASE_7_SIGNOFF.md](PHASE_7_SIGNOFF.md). Deviations / precisions:
  - `POST /calls/web` also returns `voice: 'openai' | 'fake'` so the tester shows the "Fake voice (test mode)" badge (backend `44d3fec`).
  - The transfer prompt in the tester is three buttons (connected / no answer / failed) sent back as `call.transfer_result`.
  - Bundle: main chunk 439.0 → 445.9 KB gzip (**+6.9 KB**, over the 5 KB target). The tester (8.0 KB), detail (3.0 KB), list (2.5 KB) and the two worklets (0.9 + 0.8 KB) are their own chunks; the extra is the clients, routes, Settings → Calls, the ledger breakdown and the dashboard card. Lazy-loading the dashboard card made the main chunk bigger (447.9 KB), so it stays eager.
  - The Chromium fake mic plays `docs/samples/audio/customer-silence.wav` (near silence) instead of a speech-like `customer.wav`: E2E customer words are typed ("Type instead of speaking", allowed outside production), so the VAD never fires on noise and runs stay deterministic. The mic → worklet → socket path is still exercised on every E2E call.
  - Money & roles E2E: the 4th call test creates the first 3 calls through the API, because headless Chromium freezes background tabs and their media sockets drop (which ends the calls). Wallet running out **mid-call** is proven by backend tests (`session.test.ts`, `ai-call.test.ts`: polite line, `wallet_empty`), not by E2E — draining a wallet during a real-time call is not deterministic in the browser.
  - Barge-in E2E checks the cut line marked "interrupted" and the "Customer interrupted the bot" event; `audio.clear` itself is covered by the media socket / tester unit tests.
  - The manual dev-server browser check is replaced by the Playwright runs (headless Chromium with the fake mic, the real worklets and `/ws/media`). A real-mic check by a person stays in the sign-off checklist.
  - Real bugs found by the E2E runs, each fixed in its own commit with a regression test: signed files were blocked for the dashboard by the same-origin CORP header and could not seek (backend `ec8439c`); the tester stuck at "Ending…" after a hang up because the socket was never closed (backend `fbd2451`); words said while the AI step's opening line played were lost (backend `ae123b1`); the tester marked the wrong transcript line as interrupted (backend `4b2e56d` + frontend `8ecebd7`); the tester result card could read the call before the backend saved it and stay on a skeleton (frontend `46e4ee0`, found by the fresh-clone run at B3-DONE). The flow max-duration test got a bound for the settle time (`cc894d3`).
  - T7.15 gap tests: `/ws/media` fuzz (`tests/calls/media-fuzz.test.ts`: single-use tickets, random control garbage only gets `bad_message` errors, any non-960-byte binary frame closes 4008, oversized control closes 1009).
