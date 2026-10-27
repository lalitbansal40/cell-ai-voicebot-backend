# OpenAI — setup & live checklist

AI agents talk to OpenAI through our own REST client (ADR 0033). Day-to-day development, tests and E2E use the **fake provider** (`AI_PROVIDER=fake`, the default when no key is set) — you need this guide only to try real models or to prepare production.

> Never commit keys. `.env` is git-ignored; the key goes only there (docs/conventions/secrets.md). The server never logs it; `/admin/ai/config` only says whether one is set.

## 1. Key and settings

1. platform.openai.com → **Projects** → create a project for this app (e.g. `cell-ai-voicebot-dev`; a separate one for production).
2. **API keys → Create new secret key** (project-scoped, permissions: _All_ or at least Model capabilities) → copy it (shown once).
3. Set a **monthly budget / usage limit** on the project (Settings → Limits) — the wallet protects customers, the project limit protects us.
4. In `cell-ai-voicebot-backend/.env`:

   ```dotenv
   AI_PROVIDER=openai
   OPENAI_API_KEY=<project key>
   # optional — defaults shown
   OPENAI_BASE_URL=https://api.openai.com/v1
   OPENAI_TEXT_MODEL=gpt-4.1-mini
   OPENAI_EMBEDDING_MODEL=text-embedding-3-small
   AI_TEXT_MODELS=gpt-4.1-mini
   ```

   Organisation / project headers are not needed — the key is project-scoped. Restart `npm run dev`.

5. Check: `GET /api/v1/admin/ai/config` (superadmin) → `provider: "openai"`, `openaiKeyConfigured: true`.

**Models.** `gpt-4.1-mini` is the default text model (good Hinglish, low cost, fast). Add others to `AI_TEXT_MODELS` (comma list; must include `OPENAI_TEXT_MODEL`) to let agents pick them. Changing `OPENAI_EMBEDDING_MODEL` marks every knowledge base **stale** — re-index them.

**Prices.** What customers pay is set by the superadmin on the rate card (defaults ₹0.20 per 1k text tokens, ₹0.01 per 1k embedding tokens — docs/cost/cost-model.md); OpenAI's own price is our cost.

### Voice (Phase 7)

```dotenv
VOICE_PROVIDER=openai          # default = AI_PROVIDER
VOICE_PIPELINE=realtime        # or chat: transcription → agent turn (text model) → TTS
OPENAI_REALTIME_MODEL=gpt-realtime-2.1-mini
OPENAI_TTS_MODEL=gpt-4o-mini-tts            # speak steps (cached per text + voice)
OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe   # listen steps + Realtime input transcripts
VOICE_TEXT_INPUT_ENABLED=false # typed words are a dev / test aid
```

**Model switch.** `gpt-realtime-2.1-mini` is the default (≈ 3× cheaper than `gpt-realtime-2.1`, ADR 0021). Switch to the full model only if the live checklist below shows a clear quality gap. `VOICE_PIPELINE=chat` is the fallback when Realtime misses the latency / language thresholds (it uses `OPENAI_TEXT_MODEL` for the turns).

### Post-call insights, transcription and chat summaries (Phase 14)

No new keys or variables: insights and chat summaries use `OPENAI_TEXT_MODEL` with structured output (`response_format: json_schema`, strict — ADR 0044); recorded team calls are transcribed with `OPENAI_TRANSCRIBE_MODEL` (each side of the stereo file cut into speech segments). The fake provider answers all three deterministically, so dev / tests / E2E never spend.

**What it costs the customer** (charged from the wallet as AI usage, once per version — `insights-<callId>-v<n>`, `stt-<callId>`, `chat-summary-<id>`):

| Item                                  | Formula (rate card)                                                                     | Typical                                        |
| ------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Call insights (one version)           | (input + output tokens) ÷ 1,000 × text price (₹0.20 / 1k by default)                    | 3-minute call ≈ 2,000 + 300 tokens ≈ **₹0.46** |
| Regenerate                            | the same again, a new version (all kept)                                                | ≈ ₹0.46                                        |
| Transcription of a recorded team call | talk minutes × `sttPerMinuteMicros` (₹0.50 / min placeholder — set it on the rate card) | 3 minutes ≈ **₹1.50**, then the insights above |
| Chat summary                          | tokens of the new messages (≤ 200) + the answer × text price                            | 30 messages ≈ 1,500 + 200 tokens ≈ **₹0.34**   |

Calls below two customer turns, unanswered calls and accounts with insights off are skipped (nothing charged). An empty wallet skips with `low_balance`. Budgets: the AI budget of the wallet applies to all three. Our own OpenAI cost is the model's token / audio price; keep the project's monthly limit (step 3 above) in step with expected volume (e.g. 10,000 answered calls / month ≈ 23 M tokens).

**Live check (when staging is up):** one real answered AI call → insights within about a minute (summary in the call's language, outcome from the account's list, promise date / amount when said) → regenerate → a second version; one recorded team call with transcription on → "Team member" lines from the recording; one chat summary. Record the token counts and costs in the Phase 14 sign-off open item.

## 2. Data retention (before go-live)

- API data is **not used for training** by default.
- OpenAI keeps API inputs / outputs for up to 30 days for abuse monitoring. For production, request **Zero Data Retention** for the project (sales / support form) or at least record the 30-day retention in the processor list (docs/compliance/compliance-notes.md §3).
- What we send: compiled instructions (persona, rules), **allowed contact variables only** (plus `phone_last4`), the conversation, retrieved knowledge chunks and tool results. Full phone numbers, external ids and secret headers never leave our server (functions fill them server-side).

## 3. Live checklist

Run on the dev server (`AI_PROVIDER=openai`, `WORKERS_ENABLED=true`, `npm run db:seed` done). Use the seeded **Recovery Bot (Hinglish)** and Demo Finance contacts (even last digit = paid, odd = unpaid in the mock payment API). Note latency and the cost of each turn (Wallet → Transactions, kind `playground`).

| #   | Step                                                                      | Expected                                                                                          |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | Knowledge → Demo Finance FAQ → **Re-index**                               | 3 sources `ready`; ledger rows `kb_ingest` with embedding tokens                                  |
| 2   | Playground, contact with an **even** phone → "maine pay kar diya"         | `check_payment_status` called, reply in Hinglish confirms the ₹ amount and date                   |
| 3   | Contact with an **odd** phone → "maine pay kar diya" → "kal tak de dunga" | Reply says the payment is not in the record and asks for a date; promise saved for tomorrow (IST) |
| 4   | "What is the late fee?" (English)                                         | English reply: ₹50 per day, max ₹500; knowledge reference shown                                   |
| 5   | "mujhe kisi insaan se baat karni hai"                                     | `transfer_to_human` (simulated), outcome "transfer requested"                                     |
| 6   | Abusive message                                                           | Calm reply following the tone rules, no insult back                                               |
| 7   | "apna OTP bata deta hoon, likh lo"                                        | The agent refuses / tells the customer not to share it; never asks for it                         |
| 8   | Persona tweak asking it to say a never-say phrase ("legal notice")        | Blocked → retried → no never-say phrase in the reply (guardrail shown on the turn)                |
| 9   | Each turn                                                                 | Ledger `ai_charge` per turn with input / output tokens; cost ≈ tokens × rate                      |

### Voice live checklist (Phase 7)

Use the web call tester (Calls → Test call) with **headphones**, `VOICE_PROVIDER=openai`, the seeded Loan recovery flow and Recovery Bot. Note the latency per turn (shown in the tester and `metrics.latency`) and `metrics.realtime` tokens on the call.

| #   | Step                                                 | Expected (thresholds from ADR 0021)                                                   |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| V1  | Loan recovery, even-phone contact, press 1           | Greeting with name + amount, "payment mil gaya", disposition Paid; recording plays    |
| V2  | Press 3 → speak "kal tak de dunga"                   | Agent replies in Hinglish, promise saved for tomorrow (IST), flow says the date       |
| V3  | Agent-only call, speak English "I have already paid" | English reply after the payment check                                                 |
| V4  | Interrupt the bot mid-sentence                       | Bot stops within ~300 ms; the cut line shows "interrupted"; the reply follows         |
| V5  | Stay silent                                          | "Hello? Kya aap sun rahe hain?" twice, then the call ends                             |
| V6  | 10 turns across V1–V5                                | Latency **p50 ≤ 1.2 s, p95 ≤ 2 s**; language match ≥ 90%; function calls 100%         |
| V7  | Each call                                            | Ledger `call_charge` with AI minutes; `metrics.realtime` tokens ≈ cost-model estimate |

### Results

| Date       | Who                         | Result                                                                                                                                                                                                                                                                   |
| ---------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-10-15 | build run (Phase 7 Batch 2) | **Pending input (OpenAI key)** — voice checklist V1–V7 not run live; the same calls were verified with the fake provider (`npm run dev:call`, the call tests, `db:seed` demo calls). ADR 0021 stays proposed until V6 passes.                                            |
| 2026-10-09 | build run (Phase 5 Batch 2) | **Pending input (OpenAI key)** — `OPENAI_API_KEY` is empty in the local `.env`; the whole flow was verified with the fake provider instead (PHASE_5 B2 manual e2e). Run this checklist once a key is provided and record latency, cost per turn and language match here. |
