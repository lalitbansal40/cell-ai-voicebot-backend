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

### Results

| Date       | Who                         | Result                                                                                                                                                                                                                                                                   |
| ---------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-10-09 | build run (Phase 5 Batch 2) | **Pending input (OpenAI key)** — `OPENAI_API_KEY` is empty in the local `.env`; the whole flow was verified with the fake provider instead (PHASE_5 B2 manual e2e). Run this checklist once a key is provided and record latency, cost per turn and language match here. |
