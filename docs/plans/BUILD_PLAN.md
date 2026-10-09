# Cell AI Voicebot — Phase-wise Build Plan (v2)

**Version:** 2.0 · **Date:** 8 Oct 2026 · **Stack:** MERN + TypeScript · **Telephony:** SIP (client ne enable kiya hai)

Ye plan `OVERVIEW_PLAN.md` (v1) ki jagah leta hai. v1 NotifyNow ki broadcast API maan ke likha tha. Ab client ne **SIP + apna server** diya hai, isliye architecture badla hai. Har phase ko aage tasks mein todenge ya seedha phase-wise kaam karenge.

**Har phase pe tag:**

| Tag            | Matlab                                                         |
| -------------- | -------------------------------------------------------------- |
| 🟢 **Abhi**    | Client ke jawab ke bina poora ban sakta hai                    |
| 🟡 **Partial** | Zyada tar ban sakta hai, kuch hissa client details pe ruka hai |
| 🔴 **Blocked** | Client details (SIP / DB / domain) ke bina shuru nahi ho sakta |

---

## 1. Product ek nazar mein

Multi-tenant **AI Voice Calling platform**. Client (jaise finance company):

1. Customers ki list upload kare (naam, phone, dynamic variables: amount, due days, …)
2. Call flow banaye (bolo → key press / bola hua suno → API check → AI baatcheet → call end)
3. Ek ya bulk mein call kare (campaign), ya inbound calls le
4. Har call ka poora record dekhe: recording, transcript, key press, AI function calls, outcome
5. Wallet se per-minute + AI ka charge kate

AI customer ki **language** (Hindi / English / Hinglish) aur **tone** ke hisaab se baat kare.

---

## 2. Final Architecture (SIP based)

```
 ┌──────────────────────── Frontend (React + TS) ─────────────────────────┐
 │ Auth · Contacts · AI Agents · Flow Builder · Campaigns · Call Logs     │
 │ Wallet · Analytics · Settings · Superadmin · Web Call Tester (mic)     │
 └──────────────┬──────────────────────────────┬──────────────────────────┘
                │ REST                         │ WebSocket (live status + web call audio)
 ┌──────────────▼──────────────────────────────▼──────────────────────────┐
 │                  Backend API (Node 24 + Express + TS)                  │
 │ Auth · Contacts · Wallet · Campaign Scheduler · Flow Engine            │
 │ AI Agent Runtime · Call Session Manager · Webhooks · Public API        │
 └───┬──────────┬───────────────┬─────────────────────────┬───────────────┘
     │          │               │                         │
  MongoDB   Redis + BullMQ   Telephony Adapter         Voice AI Adapter
  (data,    (call queue,     ├─ WebCall (browser mic)  ├─ OpenAI Realtime
   ledger)   retries,        ├─ SIP (Asterisk/FS)      └─ STT→LLM→TTS (option)
             concurrency)    └─ NotifyNow (optional)
                                  │
                       SIP Media Server (Asterisk / FreeSWITCH)
                       ⇄ client ka SIP trunk ⇄ customer ka phone
```

### Key decisions

| Cheez               | Decision                                                                           | Kyun                                                                              |
| ------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Telephony           | **Apna SIP media server** (Asterisk ARI ya FreeSWITCH — Phase 13 PoC mein final)   | Client ne SIP diya hai; live audio stream milega                                  |
| Provider layer      | **TelephonyProvider interface** — `WebCall`, `SIP`, `NotifyNow` implementations    | Bina SIP ke bhi poora system browser se test ho sake                              |
| **Web Call Tester** | Browser mic se "call" — same flow, same AI, same billing, same logs                | SIP aane tak 75% product isi se build + test hoga                                 |
| Voice AI            | **OpenAI Realtime** (speech-to-speech) pehle; STT→LLM→TTS adapter baad mein option | Sabse kam latency, Hindi/English switch + tone natural, function calling built-in |
| Audio               | Telephony G.711 (8kHz μ-law/A-law) ↔ AI format, resampling bridge mein             | SIP aur AI ke audio format alag hote hain                                         |
| Queue               | Redis + BullMQ                                                                     | Bulk calls ki concurrency, retry, rate limit, restart-safe                        |
| Money               | Micro-units (₹1 = 1,000,000), ledger, hold → capture/release, **atomic debit**     | AutoChatix pattern, uska AI-charge wala gap fix karke                             |
| Hosting             | Client ka EC2 (13.232.191.62), **doosri app se poori tarah alag**                  | Client ki condition                                                               |

---

## 3. Phases — summary

| #   | Phase                                 | Status            | Backend | UI    |
| --- | ------------------------------------- | ----------------- | ------- | ----- |
| 0   | Setup & Architecture Decisions        | 🟢 Abhi           | ✔       | ✔     |
| 1   | Backend Foundation                    | ✅ Done           | ✔       | –     |
| 2   | Auth, Accounts, RBAC + App Shell      | ✅ Done           | ✔       | ✔     |
| 3   | Contacts, Lists & Custom Fields       | ✅ Done           | ✔       | ✔     |
| 4   | Wallet & Billing                      | ✅ Done           | ✔       | ✔     |
| 5   | AI Agents & Knowledge Base            | 🟢 Abhi           | ✔       | ✔     |
| 6   | Call Flow Engine & Builder            | 🟢 Abhi           | ✔       | ✔     |
| 7   | Voice Runtime + Web Call Tester       | 🟢 Abhi           | ✔       | ✔     |
| 8   | Campaigns & Call Scheduler            | 🟢 Abhi (dry-run) | ✔       | ✔     |
| 9   | Call Records, Transcripts & Analytics | 🟢 Abhi           | ✔       | ✔     |
| 10  | Integrations, Public API & Webhooks   | 🟢 Abhi           | ✔       | ✔     |
| 11  | Security, Compliance & QA             | 🟡 Partial        | ✔       | ✔     |
| 12  | Server Setup & Deployment             | 🟡 Partial        | ✔       | ✔     |
| 13  | SIP Telephony Integration             | 🔴 Blocked        | ✔       | thoda |
| 14  | Inbound Calls                         | 🔴 Blocked        | ✔       | thoda |
| 15  | Pilot & Launch                        | 🔴 Blocked        | ✔       | ✔     |

**Client ke jawab ke bina:** Backend ~70%, UI ~90%, total ~75%.

---

## 4. Phases — detail

### Phase 0 — Setup & Architecture Decisions 🟢

- Repo structure final: `cell-ai-voicebot-backend`, `cell-ai-voicebot-frontend` (dono git repos ready hain)
- Backend folders: `config / models / routes / controllers / services / engine / providers / voice / queues / crons / utils`
- Frontend: React 19 + TS (Vite), MUI (latest), React Query, React Router, reactflow — AutoChatix ka Mantis UI base license confirm hone tak reuse nahi (ADR 0011)
- Code standards: ESLint, Prettier, strict TS, commit convention, branch strategy (`main` / `dev` / feature)
- Local dev: Docker Compose (MongoDB + Redis), `.env.example`, README
- API conventions: response format, error codes, pagination, validation (zod)
- Shared types ka tareeka (backend ke types frontend mein — OpenAPI ya shared package)
- OpenAI Realtime PoC script: Hindi / English / Hinglish, latency + cost per minute note karna
- Cost model draft: telephony + AI per minute + margin

**Done when:** Dono repo `npm run dev` se chalein, lint/typecheck pass, PoC numbers likhe hon.

---

### Phase 1 — Backend Foundation ✅

- Express app, env validation (fail-fast), structured logger (pino), request ID
- Global error handler, 404, validation middleware, async wrapper
- MongoDB connection + indexes, Redis connection, BullMQ setup
- WebSocket server: account-wise rooms (AutoChatix `pushToAccount` jaisa), auth token se connect
- Security basics: helmet, CORS allowlist, rate limit, body size limits
- Health / readiness endpoints, graceful shutdown (queue + calls drain)
- File storage abstraction (local disk ↔ S3) — recordings, uploads
- Email service (OTP, alerts, receipts)
- Test setup: Vitest/Jest + Supertest, test DB

**Done when:** `/health` OK, WS connect ho, ek sample protected route test se pass.

---

### Phase 2 — Auth, Accounts, RBAC + App Shell ✅

**Backend**

- Signup / login (JWT access + refresh), forgot / reset password, email verify (OTP)
- Account (tenant) → Users; roles: owner / admin / manager / agent / viewer; permission map
- Team invite, user enable/disable
- Superadmin: accounts list, enable/suspend, rates set karna (→ Phase 4, placeholder tab), impersonate (audit ke saath)
- API keys (hashed), audit log (kisne kya kiya)
- Account settings: timezone, default language, calling window default, business name

**Frontend**

- Login, signup, forgot/reset password, OTP screens
- Main layout: sidebar, header, theme (light/dark), responsive
- Permission-gated routes + menu, 403/404 pages
- WebSocket context (reconnect + ping), toast/snackbar, confirm dialog
- Dashboard skeleton, Team page, Settings page, Superadmin pages

**Done when:** Naya account bane, team member invite ho, roles se menu badle. ✅ Playwright `e2e/team-rbac.spec.ts` (frontend) — [sign-off](../phases/PHASE_2_SIGNOFF.md).

---

### Phase 3 — Contacts, Lists & Custom Fields ✅

- Contact model: naam, phone (E.164, India default), email, tags, **custom variables** (flexible key-value)
- Custom field definitions: type (text / number / date / currency / phone), required, default
- CSV / Excel import: upload → column mapping → preview → validation report (invalid / duplicate / missing) → import (background job)
- Lists (ek upload = ek list), segments (filter se), tags
- DND / do-not-call list per account (manual + upload), opt-out
- Contacts UI: table, search, filter, bulk actions (tag, delete, add to list), contact detail (variables + call history)
- Export contacts

**Done when:** 100 customers ki sheet import ho, har contact ke variables dikhen, galat rows ki report mile. ✅ Playwright `e2e/contacts-import.spec.ts` (frontend) — [sign-off](../phases/PHASE_3_SIGNOFF.md).

---

### Phase 4 — Wallet & Billing ✅

- `Wallet` + `WalletLedger` (AutoChatix pattern), micro-units
- Ledger types: `CALL_MINUTES`, `AI_USAGE`, `TTS/STT`, `RECORDING_STORAGE` (optional), `TOPUP`, `ADJUSTMENT`, `SUBSCRIPTION`
- Rate card per account: per minute / per pulse (15s/30s/60s), AI per minute, commission % — superadmin set kare
- **Hold → Capture → Release:** campaign start pe estimate hold, call end pe actual capture, baaki release
- **Atomic debit** (balance check + debit ek hi query) — har jagah
- Live call mein balance khatam → AI politely call close kare; campaign auto-pause
- Razorpay top-up (GST ke saath), webhook se credit, invoice PDF, email receipt
- Low balance alert (email + in-app), superadmin manual credit/adjustment
- UI: balance, on-hold, ledger table (filters), usage breakdown chart, add money, invoices

**Done when:** Test top-up se balance badhe, dummy call charge ledger mein sahi dikhe, hold/release sahi chale. ✅ Playwright `e2e/wallet-topup.spec.ts` + `e2e/wallet-charges.spec.ts` (frontend) — [sign-off](../phases/PHASE_4_SIGNOFF.md). Hold per call (not per campaign) — ADR 0032.

---

### Phase 5 — AI Agents & Knowledge Base 🟢

- AI Agent config (AutoChatix `AiConfig` jaisa, voice ke liye):
  - System prompt / persona, opening line, closing line
  - Voice (male/female/style), language mode: auto-detect / fixed (Hindi, English, Hinglish)
  - Tone rules: gussa → calm, confused → simple, polite recovery language
  - Max call duration, silence timeout, interruption (barge-in) on/off
  - Temperature, spend caps (daily/monthly)
- **Knowledge base:** files (PDF/DOCX/TXT) + URLs → chunks → vector search; agent ko context
- **Functions / tools:**
  - Custom API functions (method, URL, headers, body template, result path) — jaise `check_payment_status`
  - Built-in tools: `end_call`, `transfer_to_human`, `set_disposition`, `schedule_callback`, `save_promise_to_pay`, `send_sms_after_call`
- Guardrails: galat vaade nahi, sensitive data nahi batana, recovery guidelines follow
- Fallback messages (AI fail / balance khatam / config off)
- **Text playground:** agent se chat karke test (function calls ke saath)
- UI: agents list, create/edit form (tabs: Basic, Voice & Language, Knowledge, Functions, Limits), playground

**Done when:** Agent bane, playground mein "maine pay kar diya" bolne pe mock API se check karke sahi jawab de.

---

### Phase 6 — Call Flow Engine & Builder 🟢

**Engine (backend)** — AutoChatix graph engine jaisa, par **call events** se chalega:

- Flow = nodes + edges (`condition` wali edges), versioning (draft / published)
- Per-call session: current node, variables (contact vars + collected data), history
- Nodes:
  - `start` (trigger: campaign / inbound / API / test)
  - `speak` (TTS text with `{{variables}}`, language) · `play_audio` (upload)
  - `gather_dtmf` (keys → edges, timeout, invalid, max retries, repeat prompt)
  - `gather_speech` (customer ka jawab text mein, variable mein save; optional intent match → edges)
  - `ai_agent` (Phase 5 agent; exit conditions → edges: resolved / transfer / paid / promise / no-answer)
  - `api_request` (client system call, response → variables, success/error edges)
  - `condition_router` (if/else on variables) · `set_variable` · `set_disposition`
  - `transfer_to_agent` · `send_sms` / `send_whatsapp` (post-call) · `wait` · `hangup`
- Safety: loop guard, har node ka error edge, per-node trace, node analytics
- **Text simulator:** call ko text mein chalao (speak = text, DTMF = buttons)

**Builder (frontend)** — reactflow:

- Drag-drop palette, node editors, edge conditions, variable picker (`{{name}}`, `{{amount}}`)
- Validation (dangling nodes, missing end, unconfigured node), auto-layout
- Save / publish / versions / duplicate, import/export JSON
- Ready templates: Loan recovery, Payment reminder, Feedback survey, Inbound support
- Simulator panel builder ke andar

**Done when:** Loan recovery flow builder mein bane aur simulator mein har branch (1 press, 2 press, AI path) chale.

---

### Phase 7 — Voice Runtime + Web Call Tester 🟢 (product ka core)

- **Call Session Manager:** call lifecycle (created → ringing → answered → in-progress → completed / failed / busy / no-answer), state Redis mein, events Mongo mein
- **TelephonyProvider interface:** `startCall`, `answer`, `hangup`, `playAudio`, `sendDtmf/onDtmf`, `onAudio`, `transfer`
- **WebCall provider:** browser mic ⇄ WebSocket ⇄ backend — real call jaisa (SIP ke bina poora test)
- **Audio bridge:** stream in/out, format convert (PCM16 ↔ G.711, resample), jitter buffer
- **Voice AI adapter (OpenAI Realtime):**
  - Live speech-to-speech, function calling, transcript events
  - Turn-taking + **barge-in** (customer beech mein bole to bot ruke), silence handling, "hello? kya aap sun rahe hain?"
  - **Language auto-switch** + **tone/emotion** (prompt + voice style)
- TTS for `speak` nodes (cache audio per text+voice), DTMF detection
- Flow Engine ⇄ Voice runtime integration (speak / gather / ai_agent nodes live audio pe)
- **Recording:** dono side ka audio mix → storage (S3/local), consent message option
- **Live transcript** turn-by-turn save + WS se UI pe live
- **Cost metering:** per call AI minutes/tokens + call minutes → wallet (Phase 4)
- Latency logging (customer chup → bot bole), target ~1 second
- Fallbacks: AI down → fixed message / DTMF menu / transfer
- UI: **Web Call Tester** page — contact + flow/agent choose karo, mic se baat karo, live transcript + events dikhen

**Done when:** Browser se loan recovery call: bot naam + amount bole, 1 press ya "maine pay kar diya" bolne pe API check ho, Hindi/English dono mein sahi jawab, recording + transcript + charge save ho.

---

### Phase 8 — Campaigns & Call Scheduler 🟢 (dry-run / web-call mode tak)

- Campaign wizard: list/segment → flow → caller number (SIP aane pe) → schedule → retries → review (**estimated cost**)
- Scheduler: start now / later / recurring (roz 10am), timezone
- **Queue (BullMQ):** concurrency limit (account + trunk level), rate limit, priority
- **Calling window** (jaise 9am–7pm) + DND skip + per-contact daily call limit
- Retry rules: busy / no-answer / failed → kitni baar, kitne gap pe
- Pause / resume / stop, server restart pe resume, wallet khatam → auto-pause
- Live dashboard: queued / ringing / in-progress / answered / failed / dispositions (WS live)
- Per-contact result + outcome (paid, promise-to-pay, wrong number, callback, not reachable)
- Export results (CSV/Excel)
- **Dry-run mode:** mock provider random outcomes ke saath — poora pipeline test bina real call ke
- Single call: contact page se "Call now"

**Done when:** 100 contacts ka dry-run campaign chale, retries + window + pause/resume + export sahi kaam karein.

---

### Phase 9 — Call Records, Transcripts & Analytics 🟢

- Call logs list: filters (date, campaign, flow, status, disposition, agent), search by phone
- Call detail: audio player (seek), chat-style transcript, timeline (nodes, DTMF, function calls + results), cost breakdown
- **Post-call AI:** summary, disposition auto-tag, sentiment (customer ka mood), key info extract (promise date, amount)
- Dashboard: calls/day, answer rate, avg duration, outcomes, spend, campaign comparison
- Reports: campaign report, flow/agent performance, scheduled email reports, export
- Recording retention policy + auto-delete job

**Done when:** Har test call ka audio + transcript + summary + outcome dikhe, dashboard numbers sahi hon.

---

### Phase 10 — Integrations, Public API & Webhooks 🟢

- Public REST API (API key): call trigger, campaign create/status, contacts push, call result fetch
- Outbound webhooks: `call.started`, `call.completed`, `dtmf.received`, `campaign.completed` — signed, retry ke saath, delivery logs
- Post-call SMS / WhatsApp (AutoChatix ya provider se) — payment link bhejna
- Google Sheet / CRM sync (results)
- API docs page (OpenAPI / Swagger) + webhook test tool
- Mock server for client's payment API (dev/testing)

**Done when:** Bahar se API call se ek call trigger ho aur result webhook se wapas aaye.

---

### Phase 11 — Security, Compliance & QA 🟡

- PII encryption (phone, loan data), secrets sirf env mein, key rotation
- Input validation har route pe, webhook signature verify, rate limits, brute-force protection
- Compliance settings: calling hours (TRAI + RBI recovery rules), DND, call start pe **automated/recorded disclosure**, opt-out
- Audit logs, data export/delete per account
- Tests: unit (engine, billing), integration (API), e2e (main flows) — billing aur engine ka coverage zaroor
- Load test: queue + WS + voice runtime (web-call simulated sessions se)
- 🟡 Real SIP load test aur trunk concurrency → Phase 13 ke baad

---

### Phase 12 — Server Setup & Deployment 🟡

**Abhi ho sakta hai:**

- Server ka **read-only audit**: running apps, ports, PM2/Docker, nginx, disk, RAM — kuch change nahi
- Isolated deploy plan: alag user/folder, alag ports, alag PM2 namespace / Docker network, alag nginx server block, **doosri app ko touch nahi**
- Dockerfiles / PM2 ecosystem, CI/CD (GitHub Actions → server), staging + production env
- Backups (Mongo dump schedule), log rotation, monitoring + alerts (uptime, errors, queue stuck, disk)

**Client details chahiye:**

- 🔴 Database details (type, host, user, db name) → production DB connect
- 🔴 Domain / subdomain → nginx + SSL (Let's Encrypt) + webhooks ke HTTPS URL

**Done when:** App domain pe HTTPS se chale, doosri app bilkul unaffected.

---

### Phase 13 — SIP Telephony Integration 🔴

Client se chahiye: SIP host/port/transport, auth (user/pass ya IP whitelist), DID / caller ID, codecs, RTP range, concurrent limit, AWS security group access.

- Media server choose + install (Asterisk ARI ya FreeSWITCH) — isolated, doosri app se alag
- SIP trunk register / IP auth, NAT config (public IP 13.232.191.62), codecs (G.711)
- Security group: SIP 5060/5061, RTP UDP range — sirf trunk IP ke liye
- **SIP provider** implement (Phase 7 ke interface pe): outbound originate, answer detect, hangup causes map, DTMF (RFC 2833), audio stream → bridge
- Call transfer (SIP REFER / bridge) to human number
- Answering machine detection (agar possible)
- Concurrency limit enforce (trunk limit), failover / retry
- Real test calls: Hindi, English, Hinglish, network quality, latency tune
- SIP load test (trunk ki limit tak)

**Done when:** Real phone pe loan recovery call poori chale — same flow jo web-call pe chal raha tha.

---

### Phase 14 — Inbound Calls 🔴

Client se chahiye: inbound DID number.

- DID → account + flow/agent mapping
- Inbound greeting ("Hum aapki kaise madad kar sakte hain?") → flow ya AI
- Caller number se contact match, unke variables available
- Business hours: baahar → alag message / callback schedule
- Missed / abandoned call handling + callback list
- Human transfer + simple queue (agar trunk support kare)
- UI: Phone numbers page (number → flow mapping), inbound call logs

---

### Phase 15 — Pilot & Launch 🔴

- Client ka real loan recovery flow + real data (chhota batch pehle, jaise 20 customers)
- Script tuning, AI prompt tuning, language/tone feedback
- Billing rates final, wallet top-up live (Razorpay live keys)
- User guide / onboarding, flow templates, support process
- Production monitoring first 2 weeks, bug fix cycle
- Full rollout

---

## 5. Client details → kaunsa phase unblock hota hai

| Client se chahiye                            | Unblock                        |
| -------------------------------------------- | ------------------------------ |
| SIP host / port / transport / auth           | Phase 13                       |
| Caller ID + inbound DID numbers              | Phase 13, 14                   |
| Codecs, RTP range, concurrent limit          | Phase 13, 8 (real concurrency) |
| Server pe pehle se kya chal raha hai / ports | Phase 12, 13                   |
| Database details                             | Phase 12                       |
| Domain / subdomain                           | Phase 12 (SSL, webhooks)       |
| Payment check API docs (client ka system)    | Phase 15 (tab tak mock API)    |
| Real script + languages + calling hours      | Phase 15 (tab tak template)    |

---

## 6. Order of work (recommended)

```
Phase 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11
                                         ↓ (SIP details aate hi, parallel)
                                   12 → 13 → 14 → 15
```

- Phase 0–7 sabse pehle — **Phase 7 (Web Call Tester)** ke baad product demo-able ho jayega
- Client ke jawab aate hi Phase 12–13 parallel mein shuru, baaki phases rukte nahi
- Har phase ke end mein: demo + review + `main` mein merge

---

## 7. Kuch miss na ho — cross-cutting checklist

- [ ] Multi-tenancy: har query `account_id` se scoped
- [ ] Timezone (IST default) har schedule / window / report mein
- [ ] Money hamesha micro-units, UI pe ₹ format
- [ ] Har external call (AI, SIP, client API) pe timeout + retry + error log
- [ ] Secrets sirf `.env` / server env mein — git mein kabhi nahi (SSH key, DB password, API keys)
- [ ] Har background job idempotent (double charge / double call nahi)
- [ ] WS events ka ek fixed list + types
- [ ] Logs mein phone/PII mask
- [ ] Empty / loading / error states har UI page pe
- [ ] Mobile-friendly dashboard (at least read-only)
- [ ] `.env.example` + README har repo mein updated
- [ ] Har phase ke end mein demo + short changelog

---

## 8. Decisions after Phase 0 (2026-10-08)

| Area                   | Final decision                                                                                     | Reference               |
| ---------------------- | -------------------------------------------------------------------------------------------------- | ----------------------- |
| Runtime                | Node 24 LTS, TypeScript 6.0 (pinned — typescript-eslint support), ESLint 9 (pinned)                | ADR 0002, CHANGELOG     |
| Database               | MongoDB **8.2** replica set (8.0 fails on Linux kernel ≥ 6.19)                                     | ADR 0004                |
| Local ports            | API 5100 · web 3100 · Mongo 27018 · Redis 6380                                                     | ADR 0028                |
| Frontend               | Vite 8 + React 19 + MUI 9 + React Router 8 + React Query; **no Mantis copy** until licensed        | ADR 0010, 0011          |
| API contract           | zod → OpenAPI 3.1 (`openapi/openapi.json`) → generated frontend types                              | ADR 0029                |
| WebSocket auth         | Single-use 60 s tickets (no JWT in URLs)                                                           | websocket.md            |
| Voice AI               | OpenAI Realtime (`gpt-realtime-2.1` / **`-mini`**, native G.711 μ-law) — **pending PoC live runs** | ADR 0021, PoC results   |
| SIP media server       | **Asterisk (ARI + ExternalMedia)** recommended — proven in the local lab                           | ADR 0022, sip-lab-notes |
| Calling window default | 09:00–19:00 (TRAI 9–21 ∩ RBI recovery 8–19), hard block                                            | compliance-notes        |
| Deployment             | Docker Compose on the client EC2 (isolated) — pending server audit                                 | ADR 0025                |
| Phase 1                | Ready to start — [PHASE_1_PLAN.md](../phases/PHASE_1_PLAN.md)                                      |                         |
| Phase 2                | Complete — [PHASE_2_SIGNOFF.md](../phases/PHASE_2_SIGNOFF.md)                                      |                         |
| Phase 3                | Complete — [PHASE_3_SIGNOFF.md](../phases/PHASE_3_SIGNOFF.md)                                      |                         |
| Phase 4                | Complete — [PHASE_4_SIGNOFF.md](../phases/PHASE_4_SIGNOFF.md)                                      |                         |

---

## Changelog

- 2026-10-08: Node 24 LTS (Node 20 EOL), MongoDB 8.2 (8.0 fails on Linux kernel ≥ 6.19), Redis 7.4, local ports API 5100 / web 3100 / Mongo 27018 / Redis 6380, React 19 + latest MUI, Mantis template not reused until license confirmed — see [ADR index](../adr/README.md).
- 2026-10-08: Phase 0 complete — decisions table (§8): MongoDB 8.2, OpenAPI types, WS tickets, Asterisk recommendation, 09:00–19:00 calling window; voice AI and deployment pending inputs.
- 2026-10-08: Phase 2 complete (auth, accounts, RBAC, app shell, superadmin, Playwright E2E) — [PHASE_2_SIGNOFF.md](../phases/PHASE_2_SIGNOFF.md). Superadmin rates deferred to Phase 4 as planned.
- 2026-10-09: Phase 3 complete (contacts, lists, custom fields, imports / exports, DND, Playwright E2E) — [PHASE_3_SIGNOFF.md](../phases/PHASE_3_SIGNOFF.md). Phase 4 detailed plan — [PHASE_4_PLAN.md](../phases/PHASE_4_PLAN.md): per-call holds (not per campaign), insert-only ledger (settle = release hold + charge row), fake payment provider until Razorpay test keys.
- 2026-10-09: Phase 4 complete (wallet, billing engine, Razorpay + test payments, GST invoices, alerts, superadmin billing, Playwright E2E) — [PHASE_4_SIGNOFF.md](../phases/PHASE_4_SIGNOFF.md). Razorpay test mode pending keys. Next: Phase 5 (AI agents & knowledge base).
