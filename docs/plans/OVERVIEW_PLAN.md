> ⚠️ **ARCHIVED (v1)** — superseded by [BUILD_PLAN.md](BUILD_PLAN.md) (v2, SIP based).

# Cell AI Voicebot — Overview Plan

**Version:** 1.0 (draft) · **Date:** 29 Sep 2026 · **Stack:** MERN + TypeScript

Ye document poore project ka high-level plan hai. Har phase ko baad mein detail karke tasks mein todenge. Abhi ka goal hai: **kya banana hai, kis order mein banana hai, aur kaunse decisions pehle lene hain** — ye sab ek jagah clear ho.

---

## 1. Project kya hai (simple words mein)

Ek **multi-tenant AI Voice Calling platform** — jaise AutoChatix WhatsApp ke liye hai, waise hi ye **phone calls** ke liye.

Koi bhi business client (jaise finance / loan company) hamare platform pe aata hai aur:

1. **Apne customers ki list upload karta hai** — naam, phone number, aur har customer ke apne dynamic variables (loan amount, due days, EMI date, etc.)
2. **Ek call flow banata hai** — automation builder mein nodes jod ke (bolo, key press lo, API call karo, AI se baat karao, call kaato)
3. **Campaign chalata hai** — ek customer ko ya 100/1000 customers ko ek saath call jaati hai
4. **Har call ka poora record milta hai** — recording, transcript, customer ne kya bola / kya press kiya, result kya raha
5. **Wallet se paisa katta hai** — call minutes + AI usage ke hisaab se

### Example: Loan Recovery (pehla use-case)

> Morning mein client 100 customers ki list upload karta hai aur campaign start karta hai.
>
> Bot bolta hai: *"Namaste Lalit Bansal ji, aapka ₹5,500 ka loan 120 din se pending hai. Agar aapne payment kar diya hai to 1 dabaiye, baat karne ke liye 2 dabaiye."*
>
> - **1 press** → API node client ke system mein check karta hai ki payment sach mein hua ya nahi → uske hisaab se aage ka message → call end node
> - **2 press / customer bolta hai "haan maine pay kar diya"** → AI agent node: *"Theek hai, hum check kar lete hain"* → function call se payment check → result ke hisaab se jawab
> - Customer Hindi mein bole to Hindi, English mein bole to English — aur usi tone/emotion ke saath

### Teen tarah ki calls support karni hain

| Type | Kya hota hai |
|---|---|
| **Outbound – Single** | Ek number pe call (test ya API se trigger) |
| **Outbound – Bulk Campaign** | List upload karke sabko call, schedule + retry ke saath |
| **Inbound** | Customer khud call kare → bot poochhe "Hum aapki kaise madad kar sakte hain?" → automation ya trained AI jawab de |

### Do "levels" ki calling

| Level | Kya hai | Kab possible |
|---|---|---|
| **Level 1 – IVR / DTMF bot** | Pehle se likha message (TTS ya audio) bolta hai, customer key press karta hai, uske hisaab se action | NotifyNow jaisi broadcast APIs se jaldi ho sakta hai |
| **Level 2 – Live AI Voice Agent** | Customer normal baat karta hai, AI real-time sunta, samajhta, function call karta aur jawab deta hai — language + emotion ke saath | Iske liye **real-time audio streaming** wala telephony provider chahiye (neeche Phase 0 dekho) |

---

## 2. Sabse important technical decision (Phase 0 mein clear karna hai)

### 2.1 Telephony provider

NotifyNow ki jo APIs abhi hamare paas hain:

| API | Kaam |
|---|---|
| `POST /api/voice/test` | Ek number pe TTS test call (phone, message, language) |
| `POST /api/voice/send-campaign` (JSON) | Ek message ko TTS mein bol ke contacts ki list ko call, DTMF on/off, webhook_url, retries |
| `POST /api/voice/send-campaign` (multipart) | Apni audio file (mp3) ke saath campaign |
| `/api/webhooks/voice/call-status` | Call status webhook |

**Isse kya ho sakta hai:** Level 1 — ek message bolna, ek key press capture karna, status webhook lena.

**Isse kya abhi clear nahi hai (NotifyNow se poochhna hai):**

1. Kya har contact ka **alag message** (dynamic variables) ek campaign mein ja sakta hai, ya har contact ke liye alag call karni padegi?
2. Key press ke baad kya hum **agla message bol sakte hain** (multi-step IVR), ya ek hi key capture hoti hai?
3. Kya **live audio stream** (WebSocket / SIP) milta hai? — AI se live baat karne ke liye ye **must** hai.
4. **Inbound calls** support hain? Number kaise milta hai?
5. **Call recording** URL milta hai?
6. **Call transfer** (insaan agent ko) possible hai?
7. Pricing — per minute / per pulse (15s/30s/60s), concurrency limit kitni hai?
8. Webhook payload ka exact format (status values, DTMF digit, duration, recording).

**Plan:** Code mein ek **Telephony Provider Adapter** layer banayenge (interface same, provider badal sakte hain). Level 1 NotifyNow se shuru karenge. Agar NotifyNow live streaming nahi deta, to Level 2 ke liye streaming wala provider jodna padega (jaise Exotel / Plivo / Twilio / Vobiz type — Phase 0 mein compare karenge).

### 2.2 AI voice pipeline (Level 2 ke liye)

| Option | Kaise | Fayda | Nuksaan |
|---|---|---|---|
| **A. Speech-to-Speech** (jaise OpenAI Realtime) | Audio seedha model mein, audio seedha bahar | Sabse kam latency, language + emotion natural, function calling built-in | Mehenga per minute, voice choice limited |
| **B. STT → LLM → TTS** (jaise Deepgram/Sarvam → GPT → ElevenLabs/Sarvam) | 3 alag steps | Sasta, Indian languages ke liye better options, har part badal sakte hain | Latency zyada, barge-in/turn-taking khud handle karna padega |

**Recommendation:** Dono ko Phase 0 mein ek chhote PoC se test karenge (Hindi + English + Hinglish, phone quality audio pe). AI layer bhi **provider-agnostic** rakhenge taaki baad mein badal sakein.

---

## 3. High-level Architecture

```
┌─────────────────── Frontend (React + TS) ────────────────────┐
│ Contacts · Campaigns · Flow Builder · AI Agents              │
│ Call Logs (audio + transcript) · Wallet · Settings · Admin   │
└──────────────────────────────────────────────────────────────┘
          │ REST API                  │ Dashboard WebSocket
          ▼                           ▼ (live status)
┌─────────────── Backend (Node + Express + TS) ────────────────┐
│ Auth/Accounts · Contacts · Campaign Scheduler · Wallet       │
│ Call Flow Engine · AI Agent Runtime · Webhooks · Public API  │
└──────────────────────────────────────────────────────────────┘
     │              │                │                 │
  MongoDB      Redis + Queue    Telephony Adapter    AI Adapter
  (data +      (call dispatch,  (NotifyNow /         (Realtime or
   ledger)      retries,         streaming            STT+LLM+TTS)
                concurrency)     provider)
                                     │
                     Media Stream Server (WebSocket)
                     caller audio  ⇄  AI (live)
```

**Main building blocks:**

- **Call Flow Engine** — AutoChatix jaisa graph engine (nodes + edges), bas har "session" ek **call** hai, contact nahi.
- **Campaign Scheduler + Queue** — kaunsi call kab jayegi, kitni ek saath (concurrency), retry kab.
- **Telephony Adapter** — provider ka kaam (call lagana, webhook samajhna, audio stream).
- **AI Agent Runtime** — live call mein AI se baat, function calls, cost metering.
- **Wallet** — AutoChatix ka pattern (micro-units, ledger, hold → capture/release).

---

## 4. Phases (overview)

> Har phase ke end mein kuch **chalne layak** cheez honi chahiye. Phase 0–5 ke baad ek **usable IVR product (Level 1)** ready hoga. Phase 6–8 ke baad **full AI voicebot (Level 2)**.

---

### Phase 0 — Discovery, Decisions & PoC

- NotifyNow se upar wale 8 sawaalon ke jawab lena; test call + campaign + webhook khud chala ke dekhna (webhook.site pe payload capture)
- Streaming wale 2–3 telephony providers compare karna (streaming, inbound, recording, transfer, pricing, India numbers)
- AI pipeline PoC: Option A vs B — Hindi/English/Hinglish, latency, awaaz ki quality, cost per minute
- Per-minute **cost model** banana (telephony + AI + margin) → client ko kya rate denge
- Compliance check: TRAI/DND rules, RBI recovery guidelines (call timing, no harassment), recording consent, AI disclosure
- Final decisions document: provider, AI stack, hosting

**Output:** Decisions doc + working PoC scripts.

---

### Phase 1 — Project Foundation

- Backend repo setup: Node 20, Express, TypeScript, ESLint/Prettier, env validation, folder structure (routes / controllers / services / models / engine / providers)
- Frontend repo setup: React + TS, routing, UI kit (AutoChatix wala MUI/Mantis base reuse kar sakte hain), API client, React Query
- MongoDB connection, Redis setup, logging, error handling, health check
- **Auth & multi-tenancy:** signup/login (JWT), Account → Users, roles & permissions (owner / admin / agent / viewer)
- Superadmin basics (accounts dekhna, enable/disable)
- Dashboard WebSocket (live updates ke liye) — AutoChatix ke `pushToAccount` pattern jaisa

**Output:** Login karke khaali dashboard dikhe, dono repos clean run hon.

---

### Phase 2 — Contacts & Lists

- Contact model: naam, phone (E.164, India default), **custom variables** (key-value, flexible)
- CSV / Excel upload: column mapping screen (kaunsa column naam, kaunsa phone, baaki sab variables)
- Validation: galat number, duplicate, missing fields → error report
- Lists / segments (ek upload = ek list), tags
- Contact field definitions (variable ka type: text / number / date / currency)
- DND / do-not-call list per account
- Contacts UI: list, search, filter, edit, delete

**Output:** Client 100 customers ki sheet upload karke unke variables dekh sake.

---

### Phase 3 — Telephony Layer + Single Call (Level 1)

- **Telephony Provider Adapter** interface: `placeCall`, `placeCampaign`, `parseWebhook`, (baad mein) `streamAudio`, `transfer`, `hangup`
- NotifyNow adapter implement (test call, campaign, audio upload)
- Message template with variables: `"Namaste {{name}} ji, aapka ₹{{amount}} ka loan {{days}} din se pending hai"`
- Language select (Hindi / English / aur jo provider support kare)
- Webhook receiver: call status + DTMF → hamare `Call` record update
- **Call model:** status timeline (queued → ringing → answered → completed / failed / busy / no-answer), duration, DTMF input, recording URL, cost
- UI: "Test call" button + Call Logs list + call detail page
- Provider API key per account (encrypted) ya platform-level key

**Output:** Dashboard se ek number pe personalised call jaye, status + key press log mein dikhe.

---

### Phase 4 — Wallet & Billing

- AutoChatix wallet pattern reuse: `Wallet` + `WalletLedger`, micro-units (₹1 = 1,000,000), commission %
- Ledger types: `CALL_MINUTES`, `AI_USAGE`, `STT/TTS`, `TOPUP`, `SUBSCRIPTION`
- **Campaign start pe estimated amount HOLD** → call khatam hone pe actual CAPTURE → baaki RELEASE
- **Atomic debit** har jagah (balance check + debit ek hi query mein) — AutoChatix mein AI charge wala gap yahan repeat nahi karna
- Per-account rates: per minute / per pulse, AI per minute, commission (superadmin set kare)
- Razorpay top-up (GST ke saath), invoice, email receipt
- Low balance alert + **balance khatam → campaign auto-pause** (beech mein call na kate)
- Wallet UI: balance, hold, ledger, usage breakdown, add money

**Output:** Har call ka paisa sahi kate, client wallet recharge kar sake.

---

### Phase 5 — Bulk Campaigns

- Campaign create wizard: list select → flow/message select → schedule → settings → review (estimated cost dikhe)
- **Call queue (Redis + BullMQ ya similar):** concurrency limit, rate limit, provider limits
- **Calling window:** sirf allowed time mein call (jaise 9am–7pm, client + compliance ke hisaab se), baaki next day
- Retry rules: busy / no answer / failed → kitni baar, kitne gap pe
- Pause / Resume / Stop, server restart pe campaign resume
- Live progress: total / queued / in-progress / answered / failed / DTMF breakdown (WebSocket se live)
- Per-contact result + outcome (disposition): paid, promise-to-pay, wrong number, callback, not reachable
- Results export (CSV/Excel)
- Recurring / scheduled campaigns (roz subah 10 baje)

**Output:** Loan recovery campaign 100 logon ko chale, results export ho — **Level 1 product ready**.

---

### Phase 6 — Call Flow Automation Engine + Builder

- **Engine:** AutoChatix ke graph model jaisa — nodes + edges, `condition` wali edges, per-call session state (variables, current node)
- **Voice nodes (pehla set):**
  - `start` (trigger: outbound campaign / inbound call / API)
  - `speak` (TTS text with `{{variables}}`) / `play_audio`
  - `gather_dtmf` (key press → alag edges, timeout, invalid input, repeat)
  - `gather_speech` (customer ka bola hua text variable mein save)
  - `api_request` (client ka system call karo, jaise payment check → response variable mein)
  - `condition_router` (if/else on variables)
  - `set_variable`, `set_disposition` (call ka outcome mark)
  - `ai_agent` (Phase 7 mein live hoga)
  - `transfer_to_agent` (insaan ko call forward)
  - `send_sms` / `send_whatsapp` (call ke baad follow-up — AutoChatix se jod sakte hain)
  - `hangup` (call end with last message)
- Safety: loop guard, har node ka error branch, per-node trace (AutoChatix jaisa)
- **Flow Builder UI** (reactflow): drag-drop, node editors, variables picker, versioning, templates (loan recovery, payment reminder, feedback)
- **Simulator / Test mode:** browser mein flow chala ke dekho bina real call ke
- Provider capability check: jo node provider support nahi karta, builder warning de

**Output:** Client khud apna call flow bana sake; Level 1 provider pe jitna possible ho utna chale.

---

### Phase 7 — Live AI Voice Agent (Level 2)

- Streaming provider integration (Phase 0 ka decision) — **Media Stream Server** (WebSocket), audio format convert (telephony 8kHz ↔ AI format)
- AI pipeline (Option A ya B), low latency target (~1 second ke andar jawab)
- **Turn-taking:** customer beech mein bole to bot ruk jaye (barge-in), chup rahe to reminder, lambi chuppi pe call end
- **Language auto-detect + switch:** Hindi / English / Hinglish — customer jaise bole waise jawab
- **Emotion / tone:** customer gusse mein ho to calm, polite; khush ho to friendly — voice style + prompt se
- **AI Agent config** (AutoChatix AiConfig jaisa): system prompt, voice, language, knowledge base (files/URLs), temperature, max call duration
- **Function calling:** client ke APIs (payment check, due amount fetch, promise-to-pay save), built-in tools (end_call, transfer_to_human, set_disposition, schedule_callback)
- `ai_agent` node: flow se AI mein jaana, aur AI se exit conditions → aage ke nodes
- Guardrails: AI galat vaade na kare, sensitive info na bataye, recovery calls mein polite language
- **Cost metering per call** (AI minutes/tokens) → wallet, balance khatam to graceful end
- Fallback: AI fail ho to fixed message / DTMF menu / transfer

**Output:** Customer bole "maine pay kar diya" → AI check karke sahi jawab de, apni language aur tone mein.

---

### Phase 8 — Inbound Calls

- Number(s) ko account + flow/AI agent se map karna
- Inbound greeting: "Hum aapki kaise madad kar sakte hain?" → automation ya AI
- Caller ko contact se match (number se), unke variables available
- Business hours: time ke baahar alag message / callback schedule
- Missed call / abandoned call handling
- Call transfer to human agent, queue (agar provider support kare)

**Output:** Customer khud call kare to bot handle kare.

---

### Phase 9 — Call Records, Transcripts & Analytics

- Recording storage (S3), secure playback (signed URL)
- **Poori conversation ka record:** turn-by-turn transcript (kisne kya bola, kab), DTMF events, AI function calls + results
- AI post-call summary + outcome + sentiment (customer ka mood)
- Call detail page: audio player + chat-style transcript + timeline + cost
- Dashboard: calls/day, answer rate, avg duration, outcomes, cost, campaign comparison
- Reports: campaign report, agent/flow performance, scheduled email reports, export

**Output:** Client ko har call ka proof aur overall performance dikhe.

---

### Phase 10 — Integrations & Public API

- API keys per account
- Public API: single call trigger, campaign create, contacts push, call result fetch
- Outbound webhooks: `call.completed`, `campaign.completed`, `dtmf.received` → client ke system mein
- Post-call WhatsApp / SMS (AutoChatix integration)
- CRM / Google Sheet sync (results sheet mein)
- API docs page

**Output:** Client apne software se calls chala sake aur results le sake.

---

### Phase 11 — Compliance, Security & Hardening

- DND / opt-out enforcement, calling time windows (TRAI + RBI recovery rules), per-contact daily call limit
- Call ke start mein disclosure (automated / AI call, recording notice) — configurable
- PII encryption (phone, loan data), data retention + delete policy
- Rate limiting, input validation, webhook signature verify, audit logs
- Monitoring + alerts (provider down, AI down, queue stuck, wallet issues)
- Load testing: 1000+ concurrent campaign calls, media server scaling
- Backup & restore

---

### Phase 12 — Deployment, Pilot & Launch

- Hosting: API + media stream server (long-lived WebSocket — serverless nahi, EC2/VM), Redis, Mongo Atlas, S3
- CI/CD (GitHub Actions), staging + production, SSL, domains
- Pilot: pehla finance client, loan recovery flow, real feedback
- User docs / onboarding guide, flow templates
- Pricing plans + subscription

---

## 5. MVP kya hoga

| Milestone | Phases | Client kya kar payega |
|---|---|---|
| **MVP-1 (IVR bot)** | 0 → 5 | List upload, personalised TTS call, key press capture, bulk campaign, wallet, results |
| **MVP-2 (Flow builder)** | 6 | Khud ka multi-step call flow + API check |
| **MVP-3 (AI voicebot)** | 7 → 8 | Live AI baatcheet, language/emotion, function calls, inbound |
| **Full product** | 9 → 12 | Analytics, API, compliance, scale, launch |

---

## 6. AutoChatix se kya reuse karenge

| AutoChatix | Voicebot mein |
|---|---|
| Graph engine (`automationExecuter` / `nodeHandler`) | Call Flow Engine ka base pattern |
| `AiConfig` + `openai.service` (function calling, key pool, retries, cost calc) | AI Agent config + runtime |
| Agent tools (handoff, create_task…) | Voice agent built-in tools |
| Wallet + Ledger (micro-units, hold/capture/release) | Call + AI billing (atomic debit fix ke saath) |
| Campaign controller + crons (resume stuck campaigns) | Bulk calling campaigns (queue ke saath) |
| `pushToAccount` WebSocket | Live call/campaign status |
| Auth, roles, API keys, outbound webhooks, Razorpay | Same pattern |
| Frontend: Mantis MUI, reactflow builder, Wallet page | Same base |

---

## 7. Open Questions (aapse / client se)

1. NotifyNow ke 8 sawaal (section 2.1) — kaun poochhega, kab tak?
2. Pehla client ka exact use-case aur languages (sirf Hindi + English, ya regional bhi)?
3. Client ko kya rate denge (per minute), aur commission kitna?
4. Recording store karni hai to kitne din rakhni hai?
5. Human agent transfer chahiye pehle version mein?
6. AutoChatix ke saath ek hi login / wallet hoga, ya bilkul alag product?
7. Hosting: AutoChatix wala AWS account ya naya?

---

*Next step: Phase 0 ko detail karke tasks mein todna.*
