# VOICE API RUN — Cell24x7 recorded-voice / IVR campaigns — Autonomous Run Prompt

> **HOW TO RUN (ise paste karo):**
> `cell-ai-voicebot-backend/docs/prompts/VOICE_API_CELL24X7_PROMPT.md poora padho aur VAPI-T1 se VAPI-T9 tak SAARE tasks step by step autonomously implement karo. Bich me question ya permission mat maango — decisions is prompt me locked hain; koi routine choice ho to existing conventions se lo aur report me likho. Har task ke baad sirf us task ke relevant tests + lint/typecheck, phir commit (tag [VAPI-Tn]). Full suites sirf VAPI-T9 me ek-ek baar. Koi push / merge / deploy / client sync NAHI. Real Cell24x7 call/credit tabhi jab owner chat me explicitly bole. Ant me [VAPI-DONE] commit + short Hinglish report.`
>
> Working directory: `/Users/lalitbansal/Documents/cell-ai-voicebot` (backend + frontend repos andar).

---

## 0. Context (verified facts — dobara derive mat karna)

- **Plan:** [VOICE_API_CELL24X7_PLAN.md](../plans/VOICE_API_CELL24X7_PLAN.md). Provider doc: owner ki `~/Downloads/Cell24x7_Voice_API.pdf`
  (5 pages; facts neeche §1 me copied — PDF dobara padhna optional).
- **Repos:** `cell-ai-voicebot-backend`, `cell-ai-voicebot-frontend`. Dono `main` par clean, `origin/main` = backend `f3eb5da`,
  frontend `c030aa2` (Phase 19 + contact-calls fix merged). Do lint-staged stashes purane hain — mat chhoona.
- **Existing jo reuse karna hai (rebuild mat karna):**
  - Call campaign engine: `src/modules/campaigns/*` (model `db/models/campaign.model.ts` — `line: 'phone' | 'whatsapp'`,
    `flowId` nullable, `program`, `phoneLine`; contacts `campaign-contact.model.ts` — statuses `pending, queued, calling,
retry_wait, callback_wait, completed, failed, skipped, canceled`, results `answered, no_answer, busy, failed,
invalid_number`), `dispatcher.ts` (per-contact dial loop), `jobs.ts` (`campaigns` queue: `campaign.start/end/wake/run/
export`, cron `campaigns.sweep` every minute), `snapshot.ts`, `audience.ts`, `dial-guard.ts` (`loadContactFacts`:
    DND / opt-out / deleted), `window.ts` (`effectiveWindow`, TRAI 09:00–21:00), `estimate.ts`, `export.ts`,
    `progress.ts` (`publishProgress`), `notifications.ts`, `results.ts`, `whatsapp-line.ts`.
  - Wallet: `core/billing/engine.ts` = **wallet + ledger ka akela writer**. WhatsApp pattern to copy:
    `holdForWhatsApp` → `captureWhatsApp` → `releaseWhatsApp` (`raceSafe`, `run`, `findByKey`, `canSpend`,
    `moneyPipeline`, `insertRow`, `releaseRows`). Ledger catalogue `db/models/ledger-entry.model.ts`
    (`LEDGER_TYPES`, `LEDGER_USAGE_KINDS`, `LedgerBreakdown`). Rate card `db/models/rate-card.model.ts`
    (`RateCardValues`, `DEFAULT_RATE_CARD`) + `core/billing/rates.ts` (`effectiveRateCard`, 60 s cache, per-account override + history).
  - Audio library: `modules/flow-audio/*`, model `flow-audio.model.ts` (`format` wav/mp3, `durationMs`, ≤ 120 s, `fileKey`),
    storage `core/storage`.
  - Account: `account.model.ts` (`voiceLine: 'dryrun' | 'sip'`, `sipSettings`). Phone line API `GET /api/v1/phone-line`
    (`modules/phone-numbers/phone-numbers.service.ts` `accountPhoneLine`), frontend `services/api/phone-numbers.ts` (`PhoneLine`).
  - Catalogues (test-enforced): `shared/errors/error-codes.ts` ≡ `docs/conventions/error-codes.md`;
    `modules/audit/audit-actions.ts`; notification types; env schema `config/env.ts` + env inventory/README/`env.example`;
    `docs/security/RATE_LIMITS.md` (`npm run gen:rate-limits`); `docs/security/DATA_MAP.md`; privacy erase map; OpenAPI
    (`npm run gen:openapi`, `openapi:check`) → frontend `npm run gen:api`.
  - Public webhooks mount: `src/app.ts` (`/api/v1/webhooks/razorpay`, WhatsApp — raw body). Routers `src/routes.ts`.
  - Frontend campaigns: `pages/campaigns/CampaignsPage.tsx` (3 tabs from `CAMPAIGN_TYPES`), `CampaignWizardPage.tsx`,
    `CampaignDetailPage.tsx`, `features/campaigns/{CampaignTypeSelect.tsx, create-path.ts, wizard/*, detail/*, labels.ts}`,
    `features/calls/capabilities.ts` (`CampaignType`, `callMethods`), WhatsApp bulk `features/whatsapp-campaigns/*`,
    admin `features/admin/PhoneLineCard.tsx`, `pages/admin/AdminAccountDetailPage.tsx`, `AdminSystemPage.tsx`.
  - Migrations: last is `0024-whatsapp-call-campaigns.ts`; registry `src/db/migrations/index.ts`.
- **Memory rules:** full suites ek baar per phase; deploy sirf client repo flow se (yahan nahi).

## 1. Provider facts (Cell24x7 Voice API)

| Item                                                         | Fact                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Base URL                                                     | `https://voice.truebeeps.com/api/v1/voice/partner`                                                                                                                                                                                                                                                                                                     |
| Auth                                                         | `Authorization: Bearer <token>` — server only; regenerate = purana turant band                                                                                                                                                                                                                                                                         |
| `POST /submit`                                               | `multipart/form-data`: `broadcast_name` (req), `caller_id` (req, `9999999999` default), numbers: `textbox` (10-digit, newline) **ya** `csv_file` (header row, first column number, ≤ 2,00,000); audio: `audio_file` (mp3/wav/ogg/m4a, ≤ 120 s, ≤ 10 MB) **ya** `audio_file_id` **ya** `ivr_id`; `retries` 0–3; `retry_interval` 5/10/30/60/180/300 min |
| 201 response                                                 | `{ success, data: { request_id, campaign_name, contacts, credits_deducted, audio_file_id, ivr_enabled, status: "Pending for Verification" }, message }`                                                                                                                                                                                                |
| Credits                                                      | Submit par kat-te hain: 1 credit / started 15 s audio / number. Failed request = no charge, audio not kept                                                                                                                                                                                                                                             |
| `GET /report?request_id=`                                    | `[{ status, count }]`                                                                                                                                                                                                                                                                                                                                  |
| `GET /details?request_id=&page=&limit≤100[&status=&search=]` | per number: status, duration, retry count, `dtmf_pressed`                                                                                                                                                                                                                                                                                              |
| Statuses                                                     | `PP1` queued · `CALLING` / `Submitted` in progress · `ANSWERED` · `NO ANSWER` · `BUSY` · `FAILED` · `STOP`                                                                                                                                                                                                                                             |
| Webhook                                                      | `POST/GET/DELETE /webhook` (JSON `{url}`), ek URL per token. Payload `{ event: "voice.status.update", request_id, receiver, status, duration, ivr?: { digits_pressed, collected_input, disposition, final_node, webhook } }`. 200 within 10 s. **No signature**                                                                                        |
| Lists                                                        | `GET /audios` (id, name, duration_seconds, created_at), `GET /ivrs` (use `runnable: true`)                                                                                                                                                                                                                                                             |
| Errors                                                       | 400 invalid · 401 token · 402 credits kam · 404 audio/ivr not ours. Body `{ success:false, code, message, details }`                                                                                                                                                                                                                                   |
| Capacity                                                     | Dinstar GSM gateway, **4 calls at a time**                                                                                                                                                                                                                                                                                                             |
| Missing                                                      | **No stop/cancel API, no idempotency key, no webhook signature, no balance API**                                                                                                                                                                                                                                                                       |

## 2. Goal

SIP / Normal call campaign me ek naya mode **"Recorded voice / IVR (Cell24x7)"**: customer audio (library ya upload) ya
superadmin-assigned IVR choose kare, audience/schedule/estimate ke saath campaign chalaye; numbers safe batches me Cell24x7 ko
jaayen, wallet sahi charge ho, results webhook + polling se live aayein, detail/report/export/contact history me dikhein.
Campaigns ka "New campaign" 3 type cards se shuru ho; WhatsApp bulk me sirf approved templates jaayein.

## 3. Scope

**In scope:** VAPI-T1…T9 below (provider client + fake, env, model/migration, wallet engine functions, rate + superadmin
controls, campaign create/estimate/start/batch/pause/stop, webhook + polling results, call docs for history, frontend type cards

- wizard + detail + admin, catalogues/docs, minimal tests, final checks).

**Out of scope (mat karna):** TTS se audio banana, single "Call now" via Cell24x7, inbound calls (Phase 20), Asterisk SIP
changes, Cell24x7 webhook URL ko real provider par register karna (owner permission chahiye), push/merge/deploy/client sync,
AI agent / flow ko Cell24x7 par chalana (provider support nahi karta).

## 4. Locked decisions

| #   | Topic                            | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Where                            | Existing call-campaign engine + `campaigns` collection; `line` enum gets `'voice_api'`. No new section, no new collection for campaigns                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| D2  | UI type                          | Campaigns tabs same 3 (SIP / Normal call · WhatsApp call · WhatsApp bulk message). "New campaign" = 3 cards dialog. SIP / Normal wizard Basics me "Call kaise jayegi": **AI flow / agent (SIP line)** — only if `phoneLine.line === 'sip'`; **Recorded voice / IVR (Cell24x7)** — only if `phoneLine.voiceApi.enabled`. Ek hi available → preselect + chooser hidden; koi nahi → card disabled with reason. URL me `?line=voice_api` (reload/deep link)                                                                                                                         |
| D3  | WhatsApp bulk                    | Sirf approved templates (existing engine). Verify copy/steps; flow/agent/audio UI wahan kabhi nahi                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| D4  | Program                          | `line: 'voice_api'` → `flowId: null`, `program: null`, `phoneLine` ignored. New `voiceApi.content`: `{ kind: 'audio', flowAudioId }` **or** `{ kind: 'ivr', ivrId }`                                                                                                                                                                                                                                                                                                                                                                                                            |
| D5  | Tenant safety of provider assets | Ek platform token = sab accounts ke audios/IVRs ek jagah. Customers ko provider `/audios` **kabhi** nahi dikhana. Audio sirf account ki apni flow-audio library se. IVR sirf superadmin ne us account ko assign kiye ho (`account.voiceApi.ivrIds`) — `GET /voice-api/ivrs` sirf woh, provider `/ivrs` se `runnable: true` filter ke saath                                                                                                                                                                                                                                      |
| D6  | Numbers                          | Contact E.164 `^\+91[6-9]\d{9}$` → last 10 digits. Baaki `skipped` reason `not_indian_mobile`. DND / opted-out / deleted / invalid → existing skip reasons. Duplicate phone ek hi baar (pehla contact)                                                                                                                                                                                                                                                                                                                                                                          |
| D7  | Batching                         | `VOICE_API_BATCH_SIZE` (default 200, min 1, max 5000) numbers per `/submit`, numbers `csv_file` se (header `number`). `broadcast_name = cav-<campaignId>-<batchNo>`. Next batch only when open batches me non-final < 20% of their count (ya koi open batch nahi)                                                                                                                                                                                                                                                                                                               |
| D8  | Calling window                   | Batch tabhi submit jab `now + batchEtaMs + retries × retryIntervalMin` ≤ effective window end (campaign window ∩ TRAI 09:00–21:00 account timezone). Warna wait (sweep next window me uthayega). Wizard: agar `retries × interval` window me fit na ho to error                                                                                                                                                                                                                                                                                                                 |
| D9  | ETA                              | `batchEtaSec = ceil(count / VOICE_API_LINES) × (audioSec + 30)`; campaign ETA same formula on eligible. UI "lagbhag"                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| D10 | Money                            | Rate card new field `voiceApiPulseMicros` (per started 15 s per number). Default **0 = not priced** → save allowed, estimate shows "not priced", start blocked `VOICE_API_NOT_PRICED`. IVR audioSec = `account.voiceApi.ivrEstimateSec` (superadmin, default 60)                                                                                                                                                                                                                                                                                                                |
| D11 | Wallet flow                      | Per batch: **hold** (`count × pulses × rate`, key `vapi-hold-<campaignId>-<batchNo>`, same spend rule as phone call holds) → submit → success: **capture** (key `vapi-capture-<campaignId>-<batchNo>`) → definite failure (400/401/402/404 response): **release**. Uncertain: hold stays held until superadmin resolves (D13). New ledger type `voice_broadcast_charge`, usage kind `voice_broadcast`, ref `{ type: 'campaign', id: campaignId }`, breakdown `{ kind, telephonyMicros, pulseSeconds: 15, billableSeconds, durationSec }` + new optional `vaNumbers`, `vaPulses` |
| D12 | Provider errors                  | 400 → `VOICE_API_REJECTED` (batch `failed`, release, campaign pause `provider_rejected`); 401 → `VOICE_API_AUTH` (pause all running voice_api campaigns platform-wide reason `provider_auth`, superadmin bell once/hour); 402 → `VOICE_API_NO_CREDITS` (same, reason `provider_credits`); 404 on `audio_file_id` → clear cached id, ek baar file ke saath retry; 404 on ivr → `VOICE_API_IVR_MISSING` pause; timeout/5xx/network → `VOICE_API_UNAVAILABLE` → batch `uncertain`, campaign pause `provider_uncertain`, **no automatic resubmit**                                  |
| D13 | Uncertain resolve                | Superadmin endpoint per batch: `submitted` (request id required → batch `open`, capture) ya `not_submitted` (release, contacts back to `pending`, batch `failed`). Audited                                                                                                                                                                                                                                                                                                                                                                                                      |
| D14 | Pause / Stop                     | New batches stop. Already-submitted numbers provider dial karta rahega (UI warning). Stop → unsubmitted contacts `canceled`. Resume → batch loop continues                                                                                                                                                                                                                                                                                                                                                                                                                      |
| D15 | Results                          | Webhook = fast path; poller every 2 min (`/details`, 100/page) = truth. Mapping: `PP1/CALLING/Submitted` → contact `calling` (non-final); `ANSWERED` → `completed` + result `answered`; `NO ANSWER` → `failed` + `no_answer`; `BUSY` → `failed` + `busy`; `FAILED` → `failed` + `failed`; `STOP` → `canceled`. Final repeat → only duration/dtmf/retryCount update; counters never double (status + `$inc` in one conditional update)                                                                                                                                           |
| D16 | Call docs                        | On final result, one `calls` doc: `provider: 'voice_api'`, `direction: 'outbound'`, `mode: 'ai'`→ use `null`-safe source `{ kind: null }`, `status` (completed / no_answer / busy / failed / canceled), `durationSec`, `campaignId`, `campaignContactId`, `contactId`, `to` E.164, `from: caller id`, `isTest: false`, `cost` = per-number share, unique on `(campaignContactId)` for voice_api. No recording/transcript. Insights skip reason `voice_api`. Analytics rollup must not crash on it                                                                               |
| D17 | Webhook route                    | `POST /api/v1/webhooks/voice-api/:secret` — public, JSON ≤ 16 KB, rate limit 600/min per IP, `timingSafeEqual` with `CELL24X7_WEBHOOK_SECRET` (mismatch → 404), zod body, **enqueue only** (`voice.result` job, jobId `vres-<requestId>-<receiver>-<status>`) → 200. Unknown request id → ignore. Receiver never logged unmasked                                                                                                                                                                                                                                                |
| D18 | Fake provider                    | `VOICE_API_PROVIDER=fake`: in-process/Redis fake. Result by last digit: 0–5 `ANSWERED` (duration = audioSec), 6–7 `NO ANSWER`, 8 `BUSY`, 9 `FAILED`; delay `VOICE_API_FAKE_DELAY_MS` (default 2000). Knobs: `failNext('400'                                                                                                                                                                                                                                                                                                                                                     | '401' | '402' | '404' | 'timeout')`. Delivers through the **real** webhook handler and `/details`. Refused in production |
| D19 | Permissions                      | No new permission. Customer: `campaigns.read` / `campaigns.write` / `campaigns.run` (same as phone campaigns). Login-as act mode same guards as phone campaigns; view mode read-only. Superadmin: `requirePlatformAdmin`                                                                                                                                                                                                                                                                                                                                                        |
| D20 | Secrets                          | Token sirf server env. Agent `.env` files kabhi read/print nahi karega; tests/fixtures/docs me real token nahi. Logs: no token, no full number (mask). `GET /admin/voice-api/status` → `tokenConfigured: boolean` only                                                                                                                                                                                                                                                                                                                                                          |
| D21 | Tests                            | Sirf §7 wali files + existing tests jo is change se toot-ein unka fix. Assertions/guards/thresholds weaken nahi                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## 5. Rules of engagement

1. No questions — D1–D21 follow; gap ho to safest consistent choice + report.
2. Branch: dono repos me `git switch -c feature/voice-api-cell24x7` from current `main` (exists → switch + resume).
3. One commit per task per touched repo, Conventional Commit + `[VAPI-Tn]`, hooks pass hone chahiye. No push / merge.
4. Har query `accountId` scoped (webhook/poller internal lookups by `requestId` bhi campaign ke `accountId` ke saath update).
5. Har new env var → `config/env.ts` + `.env.example`/`deploy/*/env.example` + env inventory doc.
6. Har task ke baad: changed files ka lint, typecheck, us task ke tests. Long runs background me with real exit codes.
7. Fake provider hi tests/dev me. Real Cell24x7 call ya credit spend sirf owner ke explicit chat instruction par.
8. Catalogue / schema change usi task me docs + generated contract ke saath.

## 6. Resume safety

`git branch --show-current` + `git log --oneline -20` dono repos; last `[VAPI-Tn]` ke baad wale task se continue.
Uncommitted changes preserve karo (stash/reset nahi).

## 7. Tasks

### VAPI-T1 — Env + provider client + fake (backend)

1. `config/env.ts`: `VOICE_API_PROVIDER` (`off|fake|cell24x7`, default `off`; production me `fake` refuse),
   `CELL24X7_VOICE_BASE_URL` (default PDF URL, https only), `CELL24X7_VOICE_API_TOKEN` (required when `cell24x7`),
   `CELL24X7_VOICE_CALLER_ID` (default `9999999999`, digits 10), `CELL24X7_WEBHOOK_SECRET` (≥ 32 chars, required when not `off`),
   `VOICE_API_BATCH_SIZE` (200), `VOICE_API_LINES` (4), `VOICE_API_POLL_SEC` (120), `VOICE_API_FAKE_DELAY_MS` (2000).
   `PUBLIC_API_URL`/existing base URL var reuse for webhook URL (check which env var app uses for public links).
2. `src/core/voice-api/types.ts`: `VoiceApiClient { provider; submit(input); report(requestId); details(requestId, page); ivrs(); setWebhook(url); getWebhook() }`,
   `VoiceApiError { code: VoiceApiErrorCode; status; retryable: false; uncertain: boolean }` (message never includes token/body).
3. `cell24x7.client.ts`: native `fetch`, `FormData` + `Blob` (csv `number\n<10 digits>…`), audio as Blob with filename + mime from format,
   timeout 15 s (`AbortSignal.timeout`), zod for every response, error mapping per D12, provider `message` trimmed to 200 chars and no digits run ≥ 8 (mask).
4. `fake.client.ts` per D18 (Redis keys with TTL 2 days, prefix-able for tests). `index.ts` `createVoiceApiClient(env, deps)`; `off` → `null`.
5. Error codes add (code + HTTP + doc rows): `VOICE_API_NOT_ENABLED` 403, `VOICE_API_NOT_PRICED` 409, `VOICE_API_REJECTED` 502,
   `VOICE_API_AUTH` 502, `VOICE_API_NO_CREDITS` 502, `VOICE_API_IVR_MISSING` 409, `VOICE_API_AUDIO_INVALID` 422, `VOICE_API_UNAVAILABLE` 503.
6. `server.ts`: client create; pass to app (routes) and campaigns worker.

**VERIFY:** typecheck, lint changed, `cell24x7.client.test.ts` (§8), error-codes catalogue test.
**Commit:** `feat(voice-api): add the Cell24x7 voice client and fake [VAPI-T1]`

### VAPI-T2 — Data model, ledger, rate card, migration

1. `campaign.model.ts`: `line` enum `['phone','whatsapp','voice_api']`; `voiceApi` (Mixed with typed interface):
   `content`, `audioSec`, `retries`, `retryIntervalMin`, `nextBatchNo`, `batches[] { no, state: 'holding'|'submitting'|'open'|'done'|'uncertain'|'failed', requestId, count, holdId, amountMicros, submittedAt, doneAt, lastPolledAt, error }`, `pausedReason`.
2. `campaign-contact.model.ts`: `voiceApi { batchNo, requestId, receiver10, providerStatus, durationSec, dtmf, ivrDisposition, retryCount, finalAt }`; index `{ 'voiceApi.requestId': 1, 'voiceApi.receiver10': 1 }` partial on `voiceApi.requestId` exists.
3. `flow-audio.model.ts`: `providerFiles: { cell24x7?: { audioFileId: number; uploadedAt: Date } }` default `{}`.
4. `account.model.ts`: `voiceApi: { enabled: false, ivrIds: number[], ivrEstimateSec: 60 }` (Mixed + defaults like `sipSettings`).
5. `call.model.ts`: `CALL_PROVIDERS` + `'voice_api'`; partial unique index `{ campaignContactId: 1 }` where `provider: 'voice_api'`.
6. Ledger: `LEDGER_TYPES` + `voice_broadcast_charge`; `LEDGER_USAGE_KINDS` + `voice_broadcast`; breakdown `vaNumbers`, `vaPulses`.
   Wallet UI ledger labels (frontend `ledger-format`) — T7 me.
7. Rate card: `voiceApiPulseMicros` in `RateCardValues`, default 0, schema validation same as other rates, admin rate-card API/OpenAPI/diff/history include it.
8. Engine (`core/billing/engine.ts`): `holdForVoiceApi`, `captureVoiceApi`, `releaseVoiceApi` copying WhatsApp pattern (D11), spend rule = phone call hold rule; `loadVoiceApiHold` type guard.
9. Migration `0025-voice-api.ts`: create indexes (campaignContacts, calls partial unique), set `voiceApi` default on accounts missing it; down drops indexes. Registry + down-chain test + `docs/security/DATA_MAP.md` (new fields; `receiver10` = personal data) + privacy erase map (contact erase clears `voiceApi.receiver10` on its campaign contacts).

**VERIFY:** migration registry tests, ledger/rate-card/engine existing tests + one new engine case inside the campaign integration test (T5) — no separate file.
**Commit:** `feat(voice-api): store voice campaigns, holds and the pulse rate [VAPI-T2]`

### VAPI-T3 — Superadmin controls + status

1. `PATCH /api/v1/admin/accounts/:id/voice-api` body `{ enabled?, ivrIds?, ivrEstimateSec? (15–120) }` — platform admin, `blockWhenImpersonating`, audit `account.voice_api_changed` (catalogue + doc).
2. `GET /api/v1/admin/voice-api/status` → `{ provider, tokenConfigured, webhook: { expectedUrl, registeredUrl|null, matches }, lastWebhookAt, lastError: { code, at }|null, openUncertainBatches }` (`lastWebhookAt`/`lastError` in platform settings or Redis).
3. `POST /api/v1/admin/voice-api/webhook` → `setWebhook(expectedUrl)` (audited `voice_api.webhook_registered`). `GET /api/v1/admin/voice-api/ivrs` → provider list (platform admin only).
4. `POST /api/v1/admin/campaigns/:id/voice-batches/:no/resolve` body `{ outcome: 'submitted', requestId } | { outcome: 'not_submitted' }` per D13, audited `voice_api.batch_resolved`.
5. Notifications (catalogue): `voice_api.provider_error` (superadmins, once/hour per code), `campaign.voice_paused` (account `campaigns.run` users, reason text).
6. `GET /api/v1/phone-line` response + OpenAPI: `voiceApi: { enabled: boolean; ivrs: { id, name }[] }` (enabled = env provider not off **and** account flag). New `GET /api/v1/voice-api/ivrs` (`campaigns.write`) = same assigned list with `runnable` re-check.

**VERIFY:** typecheck, audit/notification catalogue tests, OpenAPI regen.
**Commit:** `feat(voice-api): let superadmins enable, price and watch voice campaigns [VAPI-T3]`

### VAPI-T4 — Campaign create, validate, estimate

1. `campaigns.schema.ts`: discriminate on `line`. `voice_api` body: `voiceApi: { content, retries (0–3, default 0), retryIntervalMin (enum, default 30) }`; reject `flowId/program/phoneLine` values; audience/schedule/window as phone campaigns. OpenAPI + examples.
2. Service validation (save **and** start): account `voiceApi.enabled` (else `VOICE_API_NOT_ENABLED`), env provider not off; audio belongs to account, not deleted, `durationMs ≤ 120000`, format wav/mp3, size ≤ 10 MB (`VOICE_API_AUDIO_INVALID`); IVR in `account.voiceApi.ivrIds` and runnable (`VOICE_API_IVR_MISSING`); D8 retries fit window. Store `audioSec = ceil(durationMs/1000)` (IVR → `ivrEstimateSec`).
3. `modules/campaigns/voice-api/eligibility.ts` (pure) per D6 using existing contact facts.
4. Estimate (`estimate.ts` branch): `{ eligible, skipped: {reason: count}, pulsesPerNumber, perNumberMicros, totalMicros, walletShortfallMicros, notPriced, etaSec }` — no recipient rows written, audience cap/exclusions respected.
5. List/detail/JSON (`campaign-json.ts`): `line: 'voice_api'`, content label (audio name / IVR name), retries, batches summary, `pausedReason`. List filter by line works. Duplicate/clone keeps voice content.
6. `dispatcher.ts` + any phone-only paths (`allowedCallContacts`, `pinnedProblems`, slots, caller id): **skip `voice_api`** explicitly (`line: { $in: ['phone','whatsapp'] }` or `$ne`), verify sweep/wake don't dial them.

**VERIFY:** typecheck; existing campaigns schema/service tests still pass (run affected files).
**Commit:** `feat(campaigns): create and estimate recorded-voice campaigns [VAPI-T4]`

### VAPI-T5 — Start, batch loop, pause/stop/resume

1. Start: existing start path → snapshot audience → eligibility marks skips → if `rate = 0` → `VOICE_API_NOT_PRICED`; available balance ≥ first batch cost else `WALLET_INSUFFICIENT_BALANCE` → `running` → enqueue `voice.batch` (`vapi-batch-<campaignId>`).
2. New jobs on `campaigns` queue (`jobs.ts` names + handlers + worker): `voice.batch`, `voice.poll` (repeat every `VOICE_API_POLL_SEC` while open batches), `voice.result`. `campaigns.sweep` also enqueues `voice.batch` for running voice campaigns whose window opened or next batch is due.
3. `voice.batch` (`modules/campaigns/voice-api/batch.ts`), under Redis lock `vapi:<campaignId>` (TTL 60 s):
   1. Campaign running? window/D8 ok? previous batches below D7 threshold? no `uncertain` batch? else exit.
   2. Claim next N `pending` contacts (atomic: `findOneAndUpdate` loop or `updateMany` by ids selected with `voiceApi.batchNo: null`) → `queued`, set `voiceApi.batchNo`, `receiver10`.
   3. Push batch `{ state: 'holding' }` → `holdForVoiceApi` (insufficient → contacts back `pending`, batch removed, campaign pause `wallet_empty` + bell) → `state: 'submitting'`.
   4. Audio: cached `providerFiles.cell24x7.audioFileId` → `audio_file_id`; none → read file from storage, send `audio_file`, save returned id. 404 with cached id → clear + one retry with file.
   5. `submit` → success: `requestId`, `state: 'open'`, contacts `calling` + `voiceApi.requestId`, `captureVoiceApi`, campaign stats + `publishProgress`, schedule `voice.poll`.
   6. Failure per D12 (release for definite failures; `uncertain` keeps hold) → pause with reason + bells.
   7. More pending + allowed → re-enqueue `voice.batch` with delay 30 s; none → wait for results.
4. Pause / Stop / Resume: existing endpoints; voice branch per D14 (Stop releases nothing already captured; unsubmitted → `canceled`; `uncertain` must be resolved before completion).
5. Restart safety: job ids stable; a batch found in `holding` with hold row → continue to submit only if `submittedAt` null **and** state `holding` (submit not attempted yet); found in `submitting` after crash → treat as `uncertain` (never resubmit).

**VERIFY:** `tests/campaigns/voice-api-campaign.test.ts` (§8) green.
**Commit:** `feat(campaigns): send recorded-voice campaigns in safe batches [VAPI-T5]`

### VAPI-T6 — Results: webhook, poller, call docs, completion

1. Route per D17 in `src/app.ts`/`routes.ts` (outside auth). Store `lastWebhookAt`.
2. `voice.result` handler (`voice-api/results.ts`): find contact by `(requestId, receiver10)` + campaign; D15 mapping in one conditional update (`voiceApi.providerStatus` not final OR same status) with stats `$inc` (`moveStats`); save duration, dtmf/IVR disposition (`outcome.ivr`), retryCount; on first final → create call doc (D16, idempotent via unique index) and set contact `lastCallId`/result like phone results; `publishProgress`; `call.created`/`call.ended` WS not required.
3. `voice.poll`: for each `open` batch of the campaign, page `/details` until done; feed each row into same handler; all rows final → batch `done`. Poll errors: 401/402 → D12; others → retry next tick (no state change).
4. Completion: no `pending/queued/calling` contacts, no `open/uncertain/holding/submitting` batch → `completed` (existing completion path → `campaign.completed` webhook + bell + summary).
5. Insights/analytics: insights sweep skips `provider: 'voice_api'` (reason `voice_api`); analytics `definitions.ts` handles provider without AI/telephony usage fields (no crash, counts as call by status).

**VERIFY:** `voice-api-webhook.test.ts` (§8) + campaign test end-to-end with fake delivering via webhook and poller.
**Commit:** `feat(campaigns): track Cell24x7 call results by webhook and polling [VAPI-T6]`

### VAPI-T7 — Frontend

1. `npm run gen:api` after backend OpenAPI. Types: `PhoneLine.voiceApi`, campaign `line: 'voice_api'`, `voiceApi` fields, estimate fields.
2. `features/calls/capabilities.ts`: `CampaignType` unchanged (3); add `phoneCallModes(phoneLine)` → `{ ai: boolean; voice: boolean; reasons }`.
3. `CampaignsPage`: **New campaign** opens a dialog with 3 cards (title, one-line description, disabled reason): "SIP / Normal call — AI agent ya recorded voice", "WhatsApp call — AI agent / flow WhatsApp par", "WhatsApp bulk message — sirf approved templates". Card → existing routes (`create-path.ts`; voice → `/campaigns/new?mode=voice` handled in wizard). Tabs/list: type column label "Normal call · Recorded voice" for `voice_api`; SIP tab lists `phone` + `voice_api`.
4. Wizard (`features/campaigns/wizard`): Basics "Call kaise jayegi" radio (D2). Voice mode steps: Basics → **Voice** (audio from library with player + duration chip, upload new via existing flow-audio upload, or IVR select from `GET /voice-api/ivrs`; retries 0–3 + interval select; caller-ID/AMD/our retries hidden) → Audience → Schedule → Review (eligible, skipped reasons, pulses/number, cost, wallet shortfall, not-priced block, ETA, text "Call shuru hote hi paisa kat-ta hai, answer ho ya na ho" and "Stop karne par sirf aage ke batch rukte hain"). Draft model (`draft.ts`) validation for these fields; switching mode clears incompatible fields. Saved campaign's mode fixed.
5. Detail (`CampaignDetailPage` + `features/campaigns/detail`): voice branch: content, retries, status counts (Answered / No answer / Busy / Failed / Calling / Pending / Canceled / Skipped), batches table (no, count, state, amount, submitted), per-number table (masked phone, status, duration, retries, key pressed), pause reason banner (provider/wallet/uncertain), Pause/Resume/Stop with D14 warning. Live updates via existing campaign progress events + poll fallback.
6. Admin: `PhoneLineCard` — Voice broadcast toggle, IVR multi-select (from admin ivrs), IVR estimate sec. Rate card editor — "Recorded voice per 15 s" field. `AdminSystemPage` — Cell24x7 card (status, Register webhook button, uncertain batches list with Resolve dialog → D13).
7. Wallet ledger labels: `voice_broadcast_charge` → "Recorded voice calls · <n> numbers".
8. WhatsApp bulk wizard: confirm template-only; adjust helper copy if any mentions flow/agent.

**VERIFY:** typecheck, lint changed, `voice-campaign-wizard.test.tsx` (§8) + rerun existing `features/campaigns/*` & `pages/campaigns/*` test files that changed.
**Commit:** `feat(campaigns): add recorded-voice campaigns and the campaign type picker [VAPI-T7]`

### VAPI-T8 — Docs + catalogues

`docs/integrations/cell24x7-voice.md` (facts §1, batching, status map, money flow, stop limitation, webhook security, uncertain resolution, ops steps:
set env → restart → Admin → Register webhook → enable account → set rate → assign IVRs). Update: both CHANGELOGs + READMEs (src READMEs too),
`docs/conventions/campaign-channels.md`, error-codes.md, audit doc, RATE_LIMITS (`gen:rate-limits`), env inventory, DATA_MAP, release notes
`docs/ops/release-voice-api.md` (migration 0025, env vars, rollback = provider `off`), `BUILD_PLAN_V2.md` changelog line, plan file status.
Token never in docs (placeholder `<CELL24X7_VOICE_API_TOKEN>`).
**Commit:** `docs(voice-api): document Cell24x7 voice campaigns [VAPI-T8]`

### VAPI-T9 — Final checks + sign-off

1. Backend: `npm run lint`, `typecheck`, `build`, `openapi:check`, `npm run test:coverage` **once** (thresholds same). Frontend: `lint`, `typecheck`, `build`, `test:coverage` **once**. Existing Playwright not required; agar koi existing spec is change se break ho to sirf woh spec.
2. Real failures fix → sirf affected files rerun. Code ko full run ke dauraan edit mat karo.
3. `docs/phases/VOICE_API_SIGNOFF.md`: tasks ✅/⚠️, actual numbers + log paths, migrations/env, open live checks.
4. Live check list (NOT run without owner): token in server env, Register webhook, enable owner's test account, rate set, 10 s audio → owner's own 1 number, result via webhook + `/details`, wallet hold→capture.
   **Commit:** `docs(voice-api): record voice campaign sign-off [VAPI-DONE]`

## 8. Tests (sirf yeh — kam aur relevant)

| File                                                                    | Covers                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| backend `src/core/voice-api/cell24x7.client.test.ts`                    | multipart fields (`broadcast_name`, `caller_id`, csv content, `audio_file_id` vs file vs `ivr_id`, retries), zod parse, 400/401/402/404/timeout → codes, no token in error message                                                                                                                                                                |
| backend `tests/campaigns/voice-api-campaign.test.ts`                    | create→estimate (skips, cost, not-priced block)→start→2 batches (D7 gating)→fake results→counters, call docs, hold captured once per batch, completion; stop between batches (no new submit, unsubmitted canceled); 402 → release + pause; timeout → `uncertain`, no resubmit, resolve `not_submitted` releases; dispatcher never dials voice_api |
| backend `tests/campaigns/voice-api-webhook.test.ts`                     | wrong secret 404, valid enqueues, duplicate/late final doesn't double counters, unknown request ignored, poller + webhook same row idempotent                                                                                                                                                                                                     |
| frontend `src/features/campaigns/wizard/voice-campaign-wizard.test.tsx` | type cards visibility by capability, voice mode → audio select → retries → review estimate → POST body; WhatsApp bulk path shows template steps only                                                                                                                                                                                              |

## 9. Final report (short Hinglish)

1. Har task ✅ / ⚠️ / ❌ + 1 line. 2. Commits (`git log --oneline` dono repos). 3. Test/build/coverage actual numbers + log paths.
2. Kya live-blocked hai (real Cell24x7 webhook register + 1-number call). 5. Push/deploy: "nahi kiya".
