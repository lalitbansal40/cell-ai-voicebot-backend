# Cell AI Voicebot — Build Plan v2 (Voice + WhatsApp)

**Banaya:** 22 Oct 2026 · Phase 8 complete hone ke baad · Pichla plan: [BUILD_PLAN.md](BUILD_PLAN.md) (Phase 0–8 ka record wahi rahega)

Ye plan bache hue saare kaam ko **ek hi product** maan ke dobara order karta hai: purane bache phases (records, integrations, security, deploy, SIP, inbound, launch) **+** WhatsApp extension (Embedded Signup, chat screen, WhatsApp calling, call permission template, templates + billing, bulk campaigns, Meta App Review). WhatsApp ko alag "add-on project" nahi maana — wo usi account, contacts, wallet, AI agents, flows, voice runtime aur campaign engine pe chalega jo Phase 1–8 me bane hain.

---

## 0. Kya badla aur kyun

1. **Priority = Meta App Review.** App Review ke liye screencasts chahiye jisme hamara app khud WhatsApp number connect kare (Embedded Signup), template banaye, message bheje / receive kare aur call kare. Isliye WhatsApp ke wo hisse **sabse pehle** (Phase 9–12), phir staging deploy + App Review (Phase 13).
2. **Server deploy aage aa gaya.** Meta webhooks aur reviewer ko **public HTTPS URL** chahiye — isliye staging deploy App Review se pehle (Phase 13). Production deploy (client server) baad me rahega.
3. **Bulk campaign sabse last** (aapke kehne pe). Bulk WhatsApp template campaigns + bulk WhatsApp calling + reports AutoChatix ke pattern pe (Phase 20). Agar SIP / inbound client details ki wajah se ruke rahe, to Phase 20 unke parallel shuru ho sakta hai.
4. **Phase 7–8 ka reuse.** WhatsApp call bhi ek "phone line" hai: Phase 7 ke `TelephonyProvider` ke peeche ek naya **WhatsApp provider** — matlab AI agents / flows, recording, transcript, billing aur Phase 8 campaign engine bina dobara likhe WhatsApp calls pe chalenge.
5. **Reference code:** AutoChatix (Embedded Signup, webhooks, calling, templates, wallet holds, bulk campaigns) aur SaaS Universe (Meta rate card + markup rule, bulk engine). Code copy nahi hoga — pattern + seekhi hui galtiyan (WABA discovery fallback, coexistence number error 141000, hold capture on DELIVERED, service hold leak) hamare TypeScript / zod / tests ke standard me dobara likhe jayenge.

---

## 1. Ab tak (Phase 0–10) ✅

| #   | Phase                                                     | Status                                              |
| --- | --------------------------------------------------------- | --------------------------------------------------- |
| 0–2 | Setup, foundation, auth / RBAC                            | ✅ Done                                             |
| 3   | Contacts, lists, custom fields                            | ✅ Done                                             |
| 4   | Wallet & billing (holds, ledger)                          | ✅ Done                                             |
| 5   | AI agents & knowledge                                     | ✅ Done                                             |
| 6   | Call flow engine & builder                                | ✅ Done                                             |
| 7   | Voice runtime + web call tester                           | ✅ Done                                             |
| 8   | Campaigns & call scheduler                                | ✅ Done                                             |
| 9   | WhatsApp Connect (Embedded Signup, fake Meta until setup) | ✅ Done ([sign-off](../phases/PHASE_9_SIGNOFF.md))  |
| 10  | WhatsApp Inbox (every type both ways, fake Meta)          | ✅ Done ([sign-off](../phases/PHASE_10_SIGNOFF.md)) |

---

## 2. Naya phase order — summary

| #   | Phase                                               | Kyun is jagah                            | Blocked on (client)                            | Size |
| --- | --------------------------------------------------- | ---------------------------------------- | ---------------------------------------------- | ---- |
| 9   | WhatsApp Connect — Meta app + Embedded Signup       | App Review ka pehla screencast           | Meta Business + developer app access           | M    |
| 10  | WhatsApp Inbox — chat screen (har type ka message)  | `whatsapp_business_messaging` video      | Test WhatsApp number                           | L    |
| 11  | Templates + WhatsApp billing (Meta price + markup)  | `whatsapp_business_management` video     | —                                              | M    |
| 12  | WhatsApp Calling — permission, agent + AI calls     | Calling video + core client promise      | Number fully on Cloud API                      | L    |
| 13  | Staging deploy + Meta App Review                    | Review ke liye HTTPS + reviewer login    | Domain / staging server, Business Verification | M    |
| 14  | Records, transcripts & analytics (voice + WhatsApp) | Pehle wala Phase 9, ab WhatsApp ke saath | —                                              | M    |
| 15  | Integrations, public API & webhooks                 | Pehle wala Phase 10                      | Payment API docs (mock tab tak)                | M    |
| 16  | Security, compliance & QA                           | Pehle wala Phase 11                      | —                                              | M    |
| 17  | Production deployment (client server)               | Pehle wala Phase 12                      | 🔴 DB details, domain, server access           | M    |
| 18  | SIP telephony                                       | Pehle wala Phase 13                      | 🔴 SIP trunk details                           | L    |
| 19  | Inbound phone calls                                 | Pehle wala Phase 14                      | 🔴 Inbound DID                                 | M    |
| 20  | Bulk WhatsApp campaigns + bulk WhatsApp calling     | Aapke kehne pe last                      | Messaging tier ≥ 2,000 (calling ke liye)       | L    |
| 21  | Pilot & launch                                      | Sab ke baad                              | Real flow, real data, live payment keys        | M    |

Size: S ≈ 3–5 din, M ≈ 1–2 hafte, L ≈ 2–3 hafte (ek developer, tests + E2E + docs ke saath — har phase Phase 1–8 jaise plan → prompt → batches → sign-off se chalega).

**App Review tak ka raasta:** 9 → 10 → 11 → 12 → 13 ≈ 7–9 hafte coding + Meta ka review time (kuch business days se kuch hafte, rejection pe resubmit).

---

## 3. WhatsApp ke bade decisions (pehle se tay — implementation me dobara debate nahi)

### 3a. Channel model

- **Channel** (`whatsapp`): account ka WABA + phone number. Ek account me kai numbers. Fields: `wabaId`, `phoneNumberId`, `displayPhoneNumber`, verified name, name status, quality rating, messaging limit tier, `isCoexistence` (WhatsApp Business app wala number), calling settings snapshot, status (`connected` / `disconnected` / `error`), webhook health.
- **Token:** Embedded Signup se mila business token **encrypted at rest** (Phase 5 `secret-box`), kabhi API response / logs me nahi.
- **Graph API version** ek jagah config me (`META_GRAPH_VERSION`), har call ek client (`meta.client.ts`) se — retries, rate-limit handling, error code → hamare error codes.

### 3b. Webhooks

- Ek endpoint `POST /webhooks/meta` (+ `GET` verify challenge), **`X-Hub-Signature-256` verify** (app secret), raw body.
- Turant 200 → event BullMQ queue me → worker process karega (Meta retry storms se bachav, idempotent by Meta message / call id).
- Routing: `phone_number_id` / WABA id → channel → account. Unknown → failed-webhook log (debug ke liye, PII ke bina).
- Fields subscribe: `messages` (incoming + statuses), `calls`, `message_template_status_update`, `account_update`, `phone_number_quality_update`, `phone_number_name_update`, settings updates.

### 3c. Contacts

- WhatsApp contact = Phase 3 ka hi contact (phone E.164 se match / auto-create), extra: WhatsApp profile name, last inbound time (24-hour window), opt-in / opt-out, call permission state.
- DND / opt-out list WhatsApp pe bhi lagegi (marketing templates block; "STOP" keyword → opt-out).

### 3d. Conversation window rules

- Customer ka last message 24 ghante ke andar → free-form messages (text, media, interactive) allowed.
- Window band → sirf **approved template**. UI me composer khud batayega ("Window band hai — template bhejo").

### 3e. Billing (Phase 4 engine pe)

- **Meta rate card** table: market (country) × category (marketing, utility, authentication, authentication international, service) × effective dates; calling per-minute rates by market + volume tier. Superadmin CSV import / edit; purani rates band (never reprice in place).
- **Who pays Meta — per account (superadmin, decided 22 Oct 2026):** **platform credit line** (default — Meta bills us, we charge the wallet: Meta rate + markup) or **customer pays Meta** directly (WhatsApp Manager payment method — wallet then charges only our platform fee / markup and AI costs, never Meta's price twice).
- **Selling price = Meta rate × (1 + markup %)**, rounded up — markup ka global default (e.g. 15 %) superadmin set kare; **per account override** (markup % ya kisi category ka fixed custom price). Ledger me Meta cost, markup / commission aur total alag dikhenge.
- **Templates:** send pe **hold** → `DELIVERED` / `READ` pe **capture** → `FAILED` pe **release** (Meta delivered pe charge karta hai; AutoChatix wala "service hold leak" bug avoid: har held message settle hoga, chahe type kuch bhi ho). Free-window service messages Meta ke current rule ke hisaab se (config se, free tier ke saath).
- **WhatsApp calls:** sirf **business-initiated** calls chargeable; per minute, **6-second pulses** (round up) × market rate + markup; Phase 7 jaisa hold → extend → settle. AI wale calls me AI cost alag line. User-initiated calls me Meta charge nahi (AI / agent cost lagega to wo).
- **Call permission request** messages bhi per-message charge (Meta ke rule se).
- Superadmin: rate cards, global markup, per account markup / custom rates, margin report.

### 3f. Calling architecture

- **Signaling:** Graph API (`POST /{phone_number_id}/calls`: connect / pre_accept / accept / reject / terminate) + `calls` webhooks.
- **Media — do raaste:**
  1. **Human agent (browser):** dashboard ka WebRTC peer seedha Meta se (AutoChatix jaisa) — SDP offer / answer relay hamara server karega, ICE / TURN config server se.
  2. **AI bot (server):** naya `WhatsAppCallProvider` (Phase 7 `TelephonyProvider` ke peeche) — server-side WebRTC (`werift`, pure TypeScript, ICE + DTLS-SRTP), **Opus ↔ PCM16** decode / encode → Phase 7 ki voice session (flow ya agent), recording, transcript, barge-in sab same.
  - Baad me (Phase 18 ke media server ke saath) Meta ka **SIP option** bhi khula rahega — tab WhatsApp calls SIP se bhi aa sakti hain.
- **Business-initiated calls ke rules (Meta, production):** pehle customer se **call permission** chahiye; permission request 1 / din aur 2 / hafta per customer; 2 lagataar unanswered calls pe customer ko reminder, 4 pe permission revoke; number ka messaging limit ≥ 2,000 hona chahiye; WhatsApp Business app (coexistence) numbers pe calling nahi; kuch countries (US, Canada, Egypt, Vietnam, Nigeria ke business numbers) pe calling available nahi. Ye sab **dial guard** me check hoga (Phase 8 jaisa) — exact numbers implementation ke waqt Meta docs se dobara verify (Meta ne 2025 me limits badle the).

---

## 4. Phases — detail

### Phase 9 — WhatsApp Connect: Meta app + Embedded Signup (M) ✅

**Goal:** Customer apne account se "Connect WhatsApp" dabaye, Meta ka Embedded Signup popup khule, WABA + number connect ho, aur hamare paas messages / calls ke webhooks aane lagen.

Backend:

- Meta app config: app id / secret, Embedded Signup `config_id`, webhook verify token, Graph version (env, production rules ke saath).
- `POST /whatsapp/channels/embedded-signup`: code → business token exchange; WABA + phone discovery (session info se, fallback: `debug_token` granular scopes → businesses) — AutoChatix ke 3-step fallback se seekh ke.
- WABA ko app se subscribe (`subscribed_apps`), naye number ko **register** (2-step PIN), webhook override check.
- Number details sync: display name + name status, quality rating, messaging limit, coexistence flag, calling settings; daily sync job + `account_update` / quality webhooks.
- Webhook endpoint + signature + queue + idempotency + failed-webhook log (3b).
- Disconnect / reconnect, multiple numbers per account, channel permissions (`whatsapp.read`, `whatsapp.manage` — RBAC me naye permissions, roles sync).
- Audit: channel connected / disconnected / token refreshed.

Frontend:

- **Settings → WhatsApp** (ya "Channels"): Connect WhatsApp button (Meta JS SDK + `config_id`), connected numbers ki cards (name, number, quality, limit, status), disconnect, sync now.
- Onboarding checklist (Business verification, display name approval, payment method on WABA) — reviewer ko bhi samajh aaye.

Dev setup: local webhooks ke liye tunnel (Cloudflare Tunnel / ngrok) — sirf dev; test number Meta ka public test number ya client ka spare number.

**Screenshot / video:** Connect → Meta consent screen → number connected card.

**Done when:** Test number Embedded Signup se connect ho, uske test messages ke webhooks signature verify hokar queue me process hon, Playwright (Meta popup mock ke saath) + backend tests green.

---

### Phase 10 — WhatsApp Inbox: chat screen (L) ✅

**Goal:** Ek chat screen jisme har type ka WhatsApp message aaye aur jaye — agent / manager yahin se reply kare.

Backend:

- Models: Conversation (account, channel, contact, last message, unread, assigned user, window expiry) aur Message (direction, type, content, media ref, context / reply-to, status timeline: sent → delivered → read / failed + error, Meta message id, cost link).
- **Incoming types:** text, image, video, audio + voice note, document, sticker, location, contacts card, interactive replies (button / list), reactions, replies (context), unsupported / errors — sab store + dikhana.
- **Outgoing types:** text (link preview), image / video / audio / document (upload → Meta media id), sticker, location, contacts, interactive buttons / list, reaction, reply-to, **template** (Phase 11 se), read receipt + typing indicator.
- Media: Meta se download → hamari storage (Phase 1) → signed short links; size / type limits.
- 24-hour window logic (3d), statuses webhook → message status + wallet settle (Phase 11).
- Realtime: naya message / status WS events (Phase 3 realtime pe), unread counts.
- Assignment (manual), conversation status open / closed, search, filters (unread, assigned to me, channel).
- Opt-out keywords (STOP / UNSUBSCRIBE) → contact opt-out + DND.
- **Coexistence numbers** (WhatsApp Business app): messages the business sends from its own phone (`smb_message_echoes`) show in the chat as "Sent from the WhatsApp Business app"; imported history (~180 days) and phone contacts (stored by Phase 9) become conversations / contacts.

Frontend:

- **Inbox page:** left — conversation list (search, filters, unread), middle — chat (bubbles har type ke liye, media preview / player, status ticks, reply, reactions, window banner, composer with attachments / emoji / templates / interactive builder), right — contact panel (Phase 3 contact, tags, lists, call permission state, recent calls).
- Contact page pe "Open chat"; Notifications bell me naye message.

**Screenshot / video:** App se message → phone ke WhatsApp me aaya; phone se reply → inbox me live aaya; media dono taraf.

**Done when:** Har supported type dono direction me chale (mock Meta server se E2E + real test number pe manual check), window rule aur statuses sahi.

---

### Phase 11 — Templates + WhatsApp billing (M) ✅

**Goal:** Templates app se bano / submit / approve status track ho; har WhatsApp charge wallet se Meta price + markup pe kate.

Templates (backend + UI):

- Template manager: list (status, category, language, quality), **create** — header (text / image / video / document), body with variables (+ samples), footer, buttons (quick reply, URL, phone, copy code, **voice call**, **call permission request**); preview jaisa phone me dikhega; submit to Meta; `message_template_status_update` webhook → status (approved / rejected + reason / paused); sync from Meta; delete; media header upload (resumable upload).
- **Call permission template** ready-made: "Kya hum aapko WhatsApp pe call kar sakte hain?" + permission button (Phase 12 use karega).
- Template send: variables → contact fields mapping (Phase 3 custom fields), inbox se aur API se.

Billing:

- Meta rate card models + superadmin import / edit (3e), global markup, per account markup / custom price, holds on send, capture on delivered / read, release on failed, service window rules, ledger lines ("WhatsApp template · Utility · India"), wallet low-balance block (wallet empty → send refuse with clear error).
- Cost preview before send ("Ye message ₹0.13 ka hai").
- Superadmin margin report (Meta cost vs billed).

**Screenshot / video:** Template create → submitted → approved (synced) — `whatsapp_business_management` ka screencast.

**Done when:** Template banke approve ho (test WABA pe), template send ka charge exact (hold → capture), failed pe release, markup override sahi — money-writes test ke saath.

---

### Phase 12 — WhatsApp Calling (L)

**Goal:** Chat screen se **call button**, customer se **call permission** lena, agent browser se aur **AI voicebot** server se WhatsApp calls kare / uthaye, aur har call ka record + charge.

Pehla kaam — **PoC (2–3 din, sabse bada risk):** server-side WebRTC (`werift`) se Meta ke saath ek business-initiated call connect karke Opus audio aana-jaana; latency note. Fail ho to plan B: browser-relay ya SIP option (Phase 18 media server) — decision ADR me.

Backend:

- Calling settings per number: enable / disable, call icon visibility, call hours, callback permission (Meta `settings` API), coexistence / eligibility errors friendly message.
- **Call permission:** interactive `call_permission_request` (window khula ho to) ya permission template (window band ho to); reply webhook → contact pe permission (granted / denied / expired, temporary / permanent, expiry); Meta limits (1 / din, 2 / hafta requests; unanswered streak) dial guard me.
- **Calls API:** outbound (agent ya AI), inbound handling (ring agents / AI answers / AI → agent transfer — number ki setting), accept / reject / terminate, SDP relay for browser, ICE / TURN servers config.
- **`WhatsAppCallProvider`** (3f): Phase 7 call session manager se jud ke AI flows / agents, recording, transcript, events, barge-in, max duration.
- Call records: Phase 7 ka hi Call model (provider `whatsapp`, direction, permission ref, Meta call id, pulses), chat timeline me call bubble ("Missed call", "Call 2:14").
- Billing: business-initiated per minute (6-second pulses) + markup, AI cost alag; user-initiated free (sirf AI cost).
- Webhooks: `calls` (connect / terminate / status), idempotent.

Frontend:

- Chat me **Call** button (permission state ke hisaab se: "Request permission" / "Call" / "Permission expired"), call bar (ringing, timer, mute, hang up, keypad), incoming call popup (accept / reject) kisi bhi page pe.
- "Call with AI" option — flow / agent choose karke AI se call.
- Number settings me calling section; contact panel me permission state; Calls list me WhatsApp filter + badge; call detail (recording, transcript — Phase 7 jaisa).

**Screenshot / video:** Permission request → phone pe "Allow" → chat se call → phone pe WhatsApp call ring → baat (AI / agent) → call record.

**Done when:** Test number pe permission → outbound agent call + AI call + inbound call teeno chalein, records + charges sahi; dial guard Meta limits enforce kare; E2E (mock Meta) + real-device manual checklist.

---

### Phase 13 — Staging deploy + Meta App Review (M)

**Goal:** App public HTTPS pe chale, Meta app "Live" ho, aur App Review submit hokar approve ho.

Deploy (staging):

- Staging server (hamara ya client ka — domain / subdomain chahiye), Docker / PM2, nginx + Let's Encrypt, MongoDB + Redis, backups, logs, uptime alert (Phase 17 ka chhota version).
- Meta app: webhook URL, privacy policy, terms, **data deletion callback** (endpoint + instructions page), app icon, category, business verification, **Tech Provider** setup (doosre businesses ke WABA onboard karne ke liye).
- Reviewer ke liye demo account (test login, connected test number, sample contacts, approved templates, AI agent + flow).

App Review pack (AutoChatix ke `META_APP_REVIEW.md` jaisa, rejection reasons se seekh ke):

| Permission                                               | Kyun                                                     | Screencast                                                                    |
| -------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `whatsapp_business_management`                           | Number connect, templates create / sync, number settings | Embedded Signup + template create → approved                                  |
| `whatsapp_business_messaging`                            | Messages bhejna / receive karna, calling                 | Inbox se send → phone me receive; phone reply → inbox; call permission + call |
| `business_management` (agar Embedded Signup flow maange) | Business portfolio select                                | Signup ka business select step                                                |

- Har video: English UI, captions, Meta consent screen visible, **native WhatsApp app me result**, ek continuous recording.
- Use-case text + reviewer instructions (step by step, test credentials).
- Submit → follow-up → rejection aaye to fix + resubmit (Meta ka time hamare control me nahi).

**Done when:** Permissions **Advanced Access** me approved, client ka real number Embedded Signup se connect ho sake.

---

### Phase 14 — Records, transcripts & analytics (voice + WhatsApp) (M)

(Pehle wala Phase 9, ab WhatsApp ke saath.)

- Calls (phone + WhatsApp) aur conversations ke reports: calls / din, answer rate, avg duration, outcomes, spend; messages sent / delivered / read / replied, template performance, response time.
- **Post-call AI:** summary, disposition auto-tag, sentiment, key info (promise date / amount) — voice aur WhatsApp calls dono pe; chat summary bhi.
- Campaign comparison (Phase 8 voice campaigns), flow / agent performance, per-node funnel (call mode).
- Dashboards + scheduled email reports + CSV / XLSX export.
- Recording / media retention settings + auto-delete job.

**Done when:** Har call / chat ka summary + outcome dikhe, dashboard numbers raw data se match karen.

---

### Phase 15 — Integrations, public API & webhooks (M)

(Pehle wala Phase 10.)

- Public REST API (API keys — Phase 2): call trigger (phone / WhatsApp), WhatsApp message / template send, campaign create / status, contacts push, call / message result fetch.
- Outbound webhooks (signed, retry, delivery logs): `call.started`, `call.completed`, `campaign.completed`, `whatsapp.message.received`, `whatsapp.message.status`, `whatsapp.call.*`.
- **Call ke baad WhatsApp** (ab apne channel se, AutoChatix ki zaroorat nahi): payment link / promise reminder template — flow step "Send WhatsApp" + outcome rules.
- Google Sheet / CRM sync, API docs page + webhook test tool, client payment API ka mock.

**Done when:** Bahar se API se call / message trigger ho aur result webhook se wapas aaye.

---

### Phase 16 — Security, compliance & QA (M)

(Pehle wala Phase 11, WhatsApp ke saath.)

- PII encryption (phone, loan data, Meta tokens), key rotation, secrets only in env.
- Webhook signatures (Meta + hamare), rate limits, brute force, input validation audit.
- Compliance: calling hours (TRAI / RBI), DND, disclosure, opt-out (voice + WhatsApp keywords), WhatsApp messaging policy (opt-in record, marketing opt-out), Meta data deletion.
- Data export / delete per account, audit review.
- Load tests: inbox webhooks burst, campaign sends, WS, voice sessions; pen-test checklist.

---

### Phase 17 — Production deployment (client server) (M) 🔴

(Pehle wala Phase 12.) Read-only server audit → isolated deploy (alag user / ports / PM2 namespace / Docker network / nginx block — doosri app ko touch nahi), production DB, domain + SSL, CI/CD, backups, monitoring + alerts, staging → production migration of WhatsApp channels.

Client se chahiye: 🔴 DB details, domain / subdomain, server access.

---

### Phase 18 — SIP telephony (L) 🔴

(Pehle wala Phase 13.) Media server (Asterisk ARI / FreeSWITCH) isolated, SIP trunk, NAT, codecs, SIP provider (Phase 7 interface pe), DTMF, transfer, AMD, concurrency, real calls, load test. **Bonus:** wahi media server Meta ke **WhatsApp SIP** option ke liye bhi use ho sakta hai.

Client se chahiye: 🔴 SIP host / port / auth, DID / caller ID (1600-series), codecs, RTP range, concurrent limit.

---

### Phase 19 — Inbound phone calls (M) 🔴

(Pehle wala Phase 14.) DID → flow / agent mapping, greeting, contact match, business hours, missed calls + callback list, human transfer / queue, Phone numbers page. (WhatsApp inbound calls Phase 12 me already.)

Client se chahiye: 🔴 inbound DID.

---

### Phase 20 — Bulk WhatsApp campaigns + bulk WhatsApp calling (L) — last

**AutoChatix ke pattern pe** (campaign model, audience filters, A/B, tier pacing, stats, fail reasons) + hamare Phase 8 engine ki reliability (claims, restart safety, idempotency).

Bulk template campaigns:

- Audience: lists, segments, tags, CSV / phone list, **exclude recent** (same template last N days), opt-out / DND skip.
- Template + variables → contact fields, header media, **A/B variants** (split %, winner by reply / read), schedule / send now / recurring.
- **Cost preview + wallet check** (Meta price + markup × recipients by market), per-message holds.
- Pacing by **messaging tier** + Meta throughput, pause / resume / stop, restart safe.
- Live stats: sent, delivered, read, replied, failed (Meta error code wise), clicks (URL buttons); retry failed; export.
- **Reports:** campaign report (funnel, cost, replies), template comparison, per-day trend.

Bulk WhatsApp calling (client promise "Bulk calling"):

- Phase 8 campaign engine + WhatsApp line: audience me sirf **call permission wale** contacts (ya pehle permission template campaign → jo "Allow" karen unhe call campaign me auto-add).
- AI flow / agent, calling window, retries, Meta limits (unanswered streak → permission revoke se bachao), per-minute billing, live dashboard + results export (Phase 8 jaisa).

**Done when:** 1,000-contact template campaign (mock Meta) aur 100-contact WhatsApp call campaign (dry-run line pe) complete hon, stats + charges + reports sahi.

---

### Phase 21 — Pilot & launch (M)

- Client ka real loan recovery flow + real data (chhota batch, jaise 20 customers) — phone + WhatsApp dono.
- Script / AI prompt / language tuning, billing rates + markup final, Razorpay live keys.
- User guide, onboarding (Embedded Signup walkthrough), templates library, support process.
- 2 hafte production monitoring + bug fix cycle → full rollout.

---

## 5. Meta App Review — checklist (Phase 13 me use hoga)

- [ ] Client ka Meta Business **Verified**; app Business portfolio me
- [ ] App **Live** mode; privacy policy, terms, data deletion callback URL live
- [ ] App icon (1024 × 1024), category, contact email
- [ ] Embedded Signup configuration (`config_id`) me sirf zaroori permissions
- [ ] Tech Provider onboarding complete
- [ ] Demo account: test login, connected number, approved templates, AI agent + flow, sample contacts
- [ ] Doosra phone (WhatsApp) — receive / reply / call dikhane ke liye
- [ ] Har permission ka use-case text + screencast (English UI, captions, consent screen, native WhatsApp proof)
- [ ] Reviewer instructions step by step
- [ ] Submit ke baad har din status check; rejection → reason ke hisaab se fix → resubmit

---

## 6. Client se kya chahiye → kaunsa phase khulta hai

| Input                                                                    | Phase  |
| ------------------------------------------------------------------------ | ------ |
| Meta Business account (verified) + developer app access / admin role     | 9, 13  |
| Test WhatsApp number (Cloud API pe, WhatsApp Business app pe **nahi**)   | 9–12   |
| Messaging limit ≥ 2,000 (business-initiated calling ke liye, production) | 12, 20 |
| Staging domain / subdomain (HTTPS)                                       | 13     |
| Markup % aur rate card decision (Meta price + kitna)                     | 11     |
| Template texts (payment reminder, call permission, promise reminder)     | 11, 12 |
| Production DB, domain, server access                                     | 17     |
| SIP trunk details, 1600-series caller ID, inbound DID                    | 18, 19 |
| Payment API docs, OpenAI key + ZDR, DLT / SMS, SMTP + domain             | 15, 21 |

---

## 7. Risks

| Risk                                                      | Mitigation                                                                                                  |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Server-side WebRTC ke saath Meta calls (AI bot) na jude   | Phase 12 ka pehla kaam PoC; plan B browser relay ya SIP option; ADR me decision                             |
| App Review rejection (galat use-case text / screencast)   | AutoChatix ke 3 rejections se seekhe rules: sahi permission text, native app proof, single continuous video |
| Number coexistence (WhatsApp Business app) → calling nahi | Connect ke waqt detect + clear message; client ko Cloud-only number                                         |
| Meta limits / pricing badalte rehte hain                  | Limits + rates config / rate card me, code me hardcode nahi; release se pehle Meta docs dobara check        |
| Webhook spikes (bulk campaigns ke statuses)               | Queue + idempotency + batch writes; load test Phase 16                                                      |
| Wallet leaks (holds settle na hon)                        | Har held message settle (type chahe kuch bhi), sweep job, money-writes test                                 |
| Client inputs late (domain, Business verification)        | Dev tunnel + Meta test number se Phase 9–12 bina rukke; sirf Phase 13 inputs pe ruke                        |

---

## Changelog

- 2026-10-22: v2 banaya — Phase 8 complete hone ke baad bache phases + WhatsApp extension (Embedded Signup, inbox, templates + billing, calling + permission, App Review, bulk campaigns) ek order me; App Review ke liye WhatsApp pehle, bulk campaigns last.
- 2026-10-22: Owner decisions — Meta billing both ways per account (platform credit line default / customer pays), coexistence numbers fully supported (echoes, history, contacts), connect owner / admin only. Phase 9 detailed plan: [PHASE_9_PLAN.md](../phases/PHASE_9_PLAN.md).
- 2026-10-22: **Phase 9 done** ([sign-off](../phases/PHASE_9_SIGNOFF.md)) — built and tested on the fake Meta provider; the real Meta app is an env-only switch ([setup guide](../setup/meta-whatsapp.md)). **Next: Phase 10 (WhatsApp Inbox).**
- 2026-10-23: Phase 10 detailed plan + run prompt written ([plan](../phases/PHASE_10_PLAN.md)) — owner answers 23 Oct 2026: 90-day message retention, no message text in notifications, Hinglish / Hindi opt-out keywords, STOP confirmation on, read receipts on, browser voice notes in Phase 10.
- 2026-10-23: **Phase 10 done** ([sign-off](../phases/PHASE_10_SIGNOFF.md)) — every free-form WhatsApp type both ways (incl. browser voice notes), 24-hour window, statuses, opt-out keywords, 90-day retention and coexistence, proven by Playwright on the fake Meta provider; the real-number checklist runs in Phase 13. **Next: Phase 11 (Templates + WhatsApp billing).**
- 2026-10-23: Phase 11 detailed plan written ([plan](../phases/PHASE_11_PLAN.md)) — Meta facts re-checked: per-message pricing on delivery, 1,000 free service messages / number / month, from 1 Oct 2026 service beyond the free tier and utility inside the window are charged, India INR billing (deadline 31 Dec 2026); billing follows Meta's `pricing.billable`; 14 owner questions with defaults (§7).
- 2026-10-24: **Phase 11 done** ([sign-off](../phases/PHASE_11_SIGNOFF.md)) — templates built, reviewed, edited, synced and sent outside the window from the app; every WhatsApp message held at send and charged only when Meta bills it (rate card + markup, INR), superadmin rate card / margin / reconciliation; proven by Playwright on the fake Meta provider; the real-WABA checklist runs in Phase 13. **Next: Phase 12 (WhatsApp Calling).**
- 2026-10-24: Phase 12 detailed plan written ([plan](../phases/PHASE_12_PLAN.md)) — Meta calling facts re-checked: business-initiated calls allowed for Indian business numbers, permission requests 1 / 24 h and 2 / 7 days, temporary permission 7 days or permanent, 100 connected calls / 24 h per pair, 4 unanswered → revoked, user-initiated calls free, business-initiated billed in 6-second pulses; server-side WebRTC (`werift`) PoC first, browser relay as plan B; 16 owner questions with defaults (§7).
