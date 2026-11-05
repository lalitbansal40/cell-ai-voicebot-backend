# Cell24x7 Voice API — voice broadcast campaigns (plan)

5 Nov 2026 · Source: `Cell24x7_Voice_API.pdf` (owner) · Status: **implemented locally (VAPI-T1…T9); live check pending**

## 0. Provider kya karta hai (aur kya nahi)

| Fact (PDF)                                                                                               | Hamare liye matlab                                                                                          |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| HTTPS API `https://voice.truebeeps.com/api/v1/voice/partner`, `Authorization: Bearer <token>`            | Server-only secret, platform-level ek token (sab customer accounts isi se jayenge)                          |
| `POST /submit` multipart: `broadcast_name`, `caller_id`, numbers (`textbox` / `csv_file`), audio / IVR   | Ek submit = provider ka ek "campaign" (`request_id`). Hum apne campaign ko chhote **batches** mein bhejenge |
| Audio: mp3/wav/ogg/m4a, ≤ 120 s, ≤ 10 MB → `audio_file_id` reuse; ya `ivr_id` (saved IVR, `runnable`)    | **AI agent / flow live nahi chal sakta.** Sirf recorded audio ya Cell24x7 dashboard ka IVR                  |
| Numbers: 10-digit Indian mobile, dedupe, CSV ≤ 2,00,000                                                  | `+91XXXXXXXXXX` → 10 digits; landline / non-India skip with reason                                          |
| `retries` 0–3, `retry_interval` 5/10/30/60/180/300 min                                                   | Provider khud redial karta hai; hum apna retry nahi chalayenge                                              |
| Credits **submit par hi kat-te hain**: 1 credit / started 15 s audio / number                            | Wallet charge bhi submit par (per number × pulses); answered ho ya na ho                                    |
| `GET /report`, `GET /details` (page, limit ≤ 100, status filter), webhook `voice.status.update`          | Webhook = fast path, `/details` polling = source of truth                                                   |
| Status: `PP1`, `CALLING`/`Submitted`, `ANSWERED`, `NO ANSWER`, `BUSY`, `FAILED`, `STOP`                  | Hamare campaign-contact statuses par map                                                                    |
| Errors 400 / 401 / 402 (credits kam) / 404; fail = no charge                                             | Error codes map; 402 = platform ke Cell24x7 credits khatam → superadmin alert                               |
| Gateway: **4 calls at a time** (Dinstar GSM SIM lines)                                                   | Bada campaign ghanton chalega — UI mein ETA dikhana zaroori                                                 |
| **Stop/cancel API nahi hai**; webhook par **signature nahi hai**; submit ka **idempotency key nahi hai** | Stop sirf next batch rokta hai; webhook secret URL + polling verify; double-submit se bachne ka state flow  |

## 1. Product decision (campaigns mein hi, naya section nahi)

Campaigns section same rahega (Phase 19 ke 3 tabs: **SIP / Normal call**, **WhatsApp call**, **WhatsApp bulk message**).

- **New campaign** button → pehle 3 bade type cards (AutoChatix `CampaignWizard` jaisa type picker), phir us type ka wizard.
- **SIP / Normal call** wizard ke pehle step mein "Call kaise jayegi":
  - **AI flow / agent** — existing Asterisk SIP line (sirf jab account `voiceLine = sip`).
  - **Recorded voice / IVR (Cell24x7)** — naya; sirf jab superadmin ne account par Voice API on kiya ho.
  - Sirf ek option available ho to wahi preselect, chooser hide.
- **WhatsApp bulk message** select kiya → sirf **approved template** jayega (existing `whatsappCampaigns` engine already template-only). Wizard mein flow/agent/audio ka koi option nahi; copy saaf: "Is campaign se sirf approved WhatsApp templates jaate hain."
- **WhatsApp call** → as-is (published flow / active agent).

## 2. Architecture

```
Wizard (voice_api) ──► POST /campaigns (line: 'voice_api')
start ──► snapshot audience (existing) ──► eligibility (10-digit mobile, DND, opt-out, dedupe)
      ──► audio upload once (cache audio_file_id) ──► batch loop (job):
            charge wallet (idempotent per batch) → POST /submit (csv_file) → save request_id
            next batch only when previous batch is mostly done (stop works between batches)
results ◄── webhook /api/v1/webhooks/voice-api/:secret (fast, enqueue only)
        ◄── poll GET /details every 2 min per open batch (truth; fixes lost webhooks)
        ──► campaignContacts status + campaign stats + WS progress ──► completed
```

- Existing **call campaign engine** (`campaigns` collection) reuse: `line: 'phone' | 'whatsapp' | 'voice_api'`.
  Per-contact dial loop (`dispatcher.ts`) `voice_api` campaigns ko **skip** karega; inka apna batch job hoga.
- Audience, schedule, calling window, list/detail pages, CSV export, permissions (`campaigns.*`) reuse.
- Provider client `core/voice-api/` mein, fake provider ke saath (repo ka pattern: Meta/SIP/payment fakes).

## 3. Steps (in order)

### V1 — Setup, secret, provider client (backend)

1. Env (`config/env.ts` zod + `docs` env inventory + `env.example`):
   - `VOICE_API_PROVIDER = off | fake | cell24x7` (default `off`; tests/dev `fake`).
   - `CELL24X7_VOICE_BASE_URL` (default PDF wala), `CELL24X7_VOICE_API_TOKEN` (secret, logs mein kabhi nahi),
     `CELL24X7_VOICE_CALLER_ID` (default `9999999999`), `CELL24X7_WEBHOOK_SECRET` (random 32+ chars),
     `VOICE_API_BATCH_SIZE` (default 200), `VOICE_API_LINES` (default 4, sirf ETA ke liye).
   - Token sirf server `.env` mein. Repo/docs/test fixtures mein kabhi nahi.
2. `core/voice-api/types.ts` — `VoiceApiClient` interface: `submit`, `report`, `details`, `audios`, `ivrs`,
   `uploadAudio` (submit ke saath hi hota hai — dekho V4), `setWebhook`, `getWebhook`.
3. `core/voice-api/cell24x7.client.ts` — `fetch` + `FormData`/`Blob` (multipart), 15 s timeout, numbers ko
   `csv_file` (header `number`) se bhejna; response zod se check; errors map:
   400 → `VOICE_API_REJECTED` (message safe), 401 → `VOICE_API_AUTH` (superadmin bell), 402 → `VOICE_API_NO_CREDITS`
   (campaign pause + superadmin bell), 404 → `VOICE_API_AUDIO_MISSING` (cached id clear karke re-upload), 5xx/network →
   `VOICE_API_UNAVAILABLE` (**no automatic resubmit** — V4.5 dekho).
   Naye error codes `error-codes.ts` + `docs/conventions/error-codes.md` dono mein (test-enforced).
4. `core/voice-api/fake.client.ts` — Redis/in-memory fake: submit → request_id, numbers ko seeded results
   (answered / no answer / busy / failed) thodi der baad; apne hi webhook receiver ko POST karta hai (jaise fake Meta).
5. `server.ts` mein client wire; `VOICE_API_PROVIDER=off` par feature hidden.

### V2 — Data model + migration

1. `campaign.model.ts`: `line` enum mein `'voice_api'`; naya `voiceApi` subdoc:
   ```
   voiceApi: {
     content: { kind: 'audio', flowAudioId } | { kind: 'ivr', ivrId: number, ivrName },
     audioSec: number,            // pulses = ceil(audioSec / 15); IVR ke liye superadmin-set estimate
     retries: 0..3, retryIntervalMin: 5|10|30|60|180|300,
     batches: [{ no, requestId|null, state: 'charging'|'submitting'|'open'|'done'|'uncertain'|'failed',
                 count, chargedMicros, submittedAt, doneAt }]
   }
   ```
2. `campaign-contact.model.ts`: `voiceApi: { batchNo, requestId, receiver10, providerStatus, durationSec, dtmf, retryCount }`.
   Index `{ 'voiceApi.requestId': 1, 'voiceApi.receiver10': 1 }` (webhook lookup).
3. `flow-audio.model.ts`: `providerFiles.cell24x7: { audioFileId, uploadedAt } | null` (audio ek baar upload, reuse).
4. `account.model.ts`: `voiceApiEnabled: boolean` (default false, superadmin-only).
5. `call.model.ts`: `CALL_PROVIDERS` mein `'voice_api'` (V5 contact history ke liye).
6. Migration `0025-voice-api-campaigns.ts` (sirf index + defaults; additive), registry + DATA_MAP update.

### V3 — Superadmin: enable + price

1. Admin account detail → **Phone line** card (`features/admin/PhoneLineCard.tsx`): "Voice broadcast (Cell24x7)" on/off.
   Audit `account.voice_api_changed` (catalogue mein add).
2. Rate card mein `voiceApiPulseMicros` (per 15 s per number) — default + per-account override, existing rate-card
   history/diff path se. Selling price hi dikhega customer ko.
3. Admin → System: Cell24x7 status — token configured ✓/✗ (value kabhi nahi), webhook registered URL match,
   last webhook time, last 401/402 error. Button **Register webhook** → `POST /webhook` with
   `https://<host>/api/v1/webhooks/voice-api/<secret>`.

### V4 — Campaign create / estimate / start (backend core)

1. Schema (`campaigns.schema.ts`): `line: 'voice_api'` par `flowId/program` null; `voiceApi.content` required;
   flow-audio account ka hona chahiye, duration ≤ 120 s, size ≤ 10 MB, format mp3/wav (library already WAV/MP3);
   IVR id `GET /ivrs` mein `runnable: true` ho (save + start dono par check).
   Account `voiceApiEnabled` false → 403 `VOICE_API_NOT_ENABLED`.
2. Eligibility (`voice-api/eligibility.ts`, pure): E.164 `+91[6-9]XXXXXXXXX` → 10 digits; baaki skip
   `not_indian_mobile`; DND / opt-out / deleted (existing `dial-guard` facts reuse); duplicates ek baar.
3. Estimate: eligible × `ceil(audioSec/15)` × `voiceApiPulseMicros` (+ skip counts, wallet shortfall, ETA =
   eligible × (audioSec + ~25 s ring) / lines). Wizard review aur start dono par.
4. Start: wallet balance check (poora estimate) → status `running` → batch job enqueue (`campaigns` queue,
   job id `vapi-batch-<campaignId>-<no>`). Calling window bahar → existing window logic se wait.
5. **Batch job** (heart of the feature):
   1. Lock `vapi:<campaignId>` (Redis, TTL). Campaign running nahi / window band → exit (sweep phir uthayega).
   2. Next `VOICE_API_BATCH_SIZE` pending contacts claim (`batchNo` set, status `queued`).
   3. Batch row `state: 'charging'` → `chargeUsage` idempotency key `vapi:<campaignId>:<no>` → `state: 'submitting'`.
   4. Audio id: cached `audioFileId` ho to wahi; nahi to submit ke saath `audio_file` bhejo aur response ka id save.
      404 aaye to cache clear karke ek baar file ke saath dobara.
   5. `POST /submit` (`broadcast_name = cav-<campaignId>-<no>` — manual reconcile ke liye), success →
      `requestId` save, `state: 'open'`, contacts `calling`.
   6. Failure: 400/401/402 (provider ne kuch nahi kaata) → wallet refund (same idempotency, `adjust`), batch `failed`,
      campaign pause with reason. **Timeout/5xx (unknown)** → batch `uncertain`, campaign pause, superadmin bell
      "check Cell24x7 dashboard for cav-…-n"; **auto resubmit nahi** (double call + double credit ka risk).
   7. Next batch tabhi jab open batches mein pending (`PP1`/`CALLING`) < 20% — taaki **Stop** next batch rok sake
      aur 4-line gateway par queue na lage.
6. Pause/Stop: naye batches band. UI clearly: "Already bheje gaye N numbers Cell24x7 dial karta rahega."
   Stop par jo contacts submit nahi hue → `canceled`, unka paisa kabhi kata hi nahi.

### V5 — Results: webhook + polling + reports

1. Route `POST /api/v1/webhooks/voice-api/:secret` (public, `app.ts` mein JSON parser ke saath, rate limit):
   secret timing-safe compare → body zod → **sirf enqueue** `vapi-result` job → 200 (10 s rule).
   Unknown `request_id` → ignore (log count only, number kabhi log nahi).
2. Result job: `(requestId, receiver10)` se campaign-contact; status map:
   `ANSWERED → answered`, `NO ANSWER → no_answer`, `BUSY → busy`, `FAILED → failed`, `STOP → canceled`,
   `PP1/CALLING/Submitted → calling` (non-final). Final status dobara aaye to sirf duration/dtmf update, counters
   double nahi (status + `$inc` ek update mein, Phase 19 jaisa). IVR `digits_pressed` / `disposition` save.
   Final par minimal `calls` doc (`provider: 'voice_api'`, duration, status, no recording/transcript) — contact page
   "Recent calls" aur reports mein dikhe.
3. Poller (`campaigns` queue repeat job, har 2 min): har `open` batch ke liye `GET /details` (pages of 100) →
   same result job logic. Sab final → batch `done`. Sab batches done + koi pending nahi → campaign `completed`,
   `campaign.completed` webhook/bell (existing).
4. Detail page data: batches table (request id, count, state, charged), status counts, per-number list (masked phone,
   status, duration, retry count, key pressed), cost. CSV export existing export job se (masked unless `contacts.export`).

### V6 — Frontend

1. `CampaignsPage` → **New campaign** = type cards (SIP / Normal call · WhatsApp call · WhatsApp bulk message),
   permissions/capability ke hisaab se disable + reason (`features/calls/capabilities.ts` extend:
   `voiceApi: phoneLine.voiceApiEnabled`). `/api/v1/phone-line` response mein `voiceApi: { enabled }` add.
2. SIP / Normal wizard (`features/campaigns/wizard`): Basics mein "Call kaise jayegi" (AI flow/agent vs Recorded voice/IVR).
   Voice choose kiya to **Voice step**: audio library se choose / naya upload (existing flow-audio upload, ≤ 120 s preview
   player) **ya** Cell24x7 IVR dropdown (`GET /voice-api/ivrs`); retries 0–3 + interval select.
   Retries step (hamara) aur caller-number/AMD fields voice mode mein hide.
3. Review: eligible / skipped (reasons), pulses, cost, wallet shortfall, ETA ("4 lines → lagbhag 3 ghante"),
   note "Call shuru hote hi paisa kat-ta hai, answer ho ya na ho".
4. Detail page: voice_api ke liye batches + status counts + per-number table + Pause/Stop (stop warning text).
   List mein type label "Normal call · Recorded voice".
5. WhatsApp bulk wizard: copy/guard check — sirf approved templates; koi flow/agent/audio UI nahi (already true, verify).
6. `npm run gen:api` (OpenAPI → types) after backend schema.

### V7 — Tests (kam, sirf relevant)

Backend (3 files):

- `core/voice-api/cell24x7.client.test.ts` — multipart fields, 10-digit conversion, 400/401/402/404/timeout mapping (fetch stub).
- `tests/campaigns/voice-api-campaign.test.ts` — fake provider: start → 2 batches → webhook + poll results → counters,
  charge ek baar per batch, stop ke baad naya batch nahi, unknown submit → `uncertain` + no resubmit.
- `voice-api webhook route` — galat secret 404, valid → job enqueue, duplicate result counters double nahi.

Frontend (1 file): wizard — voice mode choose → audio select → review estimate → POST body sahi; WhatsApp bulk mein
sirf template step.

Final: lint + typecheck + build dono repos, backend aur frontend suite **ek-ek baar**, OpenAPI check. Naya Playwright nahi
(zaroorat pade to ek smoke).

### V8 — Docs, live check, release

1. CHANGELOG/README, env inventory, error codes, audit catalogue, DATA_MAP, `docs/integrations/cell24x7-voice.md`
   (status map, batching, stop limitation, webhook security, credits).
2. Live check (**owner ki permission + owner ka apna number, 1 number**): token server env mein → Register webhook →
   10 s audio ka 1-number campaign → result webhook + `/details` dono se aaya, wallet charge sahi.
3. Release: migration 0025, env vars, client deploy flow (Cell24x7/cell-ai-voicebot repo → client team deploy).

## 4. Owner se confirm karna (defaults ke saath)

| Sawaal                                          | Default jo plan mein liya                                         |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| Customer ko charge kab?                         | Submit par, per number × 15 s pulse (provider jaisa)              |
| Selling price per 15 s pulse                    | Superadmin rate card mein set karega (koi hard-coded price nahi)  |
| Caller ID                                       | `9999999999` jab tak Cell24x7 koi caller ID na de                 |
| Text → voice (TTS se audio banana)              | Abhi nahi; baad mein add ho sakta hai (hamara TTS → WAV → upload) |
| Single "Call now" (ek contact ko recorded call) | Abhi nahi; campaign ka 1-number path baad mein reuse ho sakta hai |
