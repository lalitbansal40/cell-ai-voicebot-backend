# Phase 9 — WhatsApp Connect: Meta App + Embedded Signup (Detailed Plan)

**Source:** [BUILD_PLAN_V2.md](../plans/BUILD_PLAN_V2.md) → Phase 9 · **Builds on:** Phase 1 (queues, Redis, storage, maintenance jobs, error / audit catalogues), Phase 2 (accounts, RBAC + `syncSystemRoles()`, impersonation, superadmin, notifications), Phase 4 (raw-body webhook + HMAC pattern, fake provider pattern, `PAYMENT_PROVIDER=fake` style dev mode), Phase 5 (`secret-box` for secrets at rest), Phase 7–8 (realtime account events, notifications, maintenance jobs) · **Branch:** `feature/phase-9-whatsapp-connect` (both repos) — from `main` after Phase 8 is merged, else from the `feature/phase-8-campaigns` tip (project lead decides) · **Tracker:** [PHASE_9_TASKS.md](PHASE_9_TASKS.md) · **References (read only):** AutoChatix `channel.controller.ts` (Embedded Signup, WABA discovery, `subscribed_apps`, calling settings), `webhook.controller.ts`, `Channels.tsx` (Meta SDK + `WA_EMBEDDED_SIGNUP` listener), `META_APP_REVIEW.md`

---

## 0. Is phase ka goal

Phase 9 ke end tak ek account owner app ke andar se **"Connect WhatsApp"** dabaye, Meta ka **Embedded Signup** popup khule, wo apna Meta Business + WhatsApp Business Account (WABA) + phone number chune, aur hamare app me wo number **Connected** dikhe — quality, messaging limit, display name status ke saath — aur Meta ke **webhooks** (signed) hamare server pe aakar safely queue me process hon. Ye WhatsApp ke baaki saare phases (10 inbox, 11 templates + billing, 12 calling, 13 App Review, 20 bulk) ki neev hai.

**Meta developer app abhi nahi banayenge** (aapke kehne pe — 1–2 phase baad). Isliye poora phase ek **fake Meta provider** pe banega aur test hoga (jaise Phase 4 me Razorpay ki jagah fake payment provider tha): wahi service code, wahi webhook pipeline, sirf Graph API aur Meta popup simulate. Real Meta pe switch = `.env` me 5 values + `META_PROVIDER=meta` — koi code change nahi. Real setup ke steps [docs/setup/meta-whatsapp.md](../setup/meta-whatsapp.md) me abhi likh denge taaki baad me 1 ghante ka kaam ho.

1. **Meta app plumbing** — config (app id, app secret, Embedded Signup `config_id`, webhook verify token, Graph version), Graph API client (timeouts, retries, error mapping), fake provider, production rules.
2. **Embedded Signup** — frontend Meta JS SDK (`FB.login` with `config_id`, `response_type: 'code'`, session info listener) → backend code → **business token exchange** → WABA + phone **verify** (client ke bheje IDs pe bharosa nahi — `debug_token` granular scopes se) → fallback discovery (AutoChatix ka 3-step) → WABA ko app se **subscribe** → naya number **register** (2-step PIN) → channel saved.
3. **Two onboarding modes** — **Cloud API number** (default; calling Phase 12 me chalegi) aur **WhatsApp Business app number (coexistence)** (alag option, clear warning: "Calling won't work on this number").
4. **Channel model** — account ke kai numbers, status (connecting / connected / action needed / needs reconnect / restricted / disconnected), quality, messaging limit, name status, token **encrypted at rest**, kabhi API / logs me nahi.
5. **Webhook pipeline** — `GET /webhooks/meta` verify challenge, `POST /webhooks/meta` **`X-Hub-Signature-256`** check on raw body, event store (sealed payload, TTL), idempotency, queue `whatsapp`, worker, routing by `phone_number_id` / WABA → channel → account, failed / unknown events log. Phase 9 handlers: account / phone quality / name / capability updates. Messages, statuses, calls, template updates **store + count only** (Phase 10 / 11 / 12 consume).
6. **Health & sync** — daily job + "Sync now": token valid?, number details, WABA status; transitions pe notifications (needs reconnect, restricted, quality red).
7. **Disconnect / reconnect / retry setup** — partial failures (token mila par subscribe / register fail) pe channel `action_needed` + "Retry setup", token waste nahi.
8. **Meta app callbacks** — **deauthorize** + **data deletion** (`signed_request`, confirmation code, status page) — App Review ke liye zaroori, isliye abhi.
9. **Superadmin** — Meta config health (webhook URL copy, configured?, last webhook), har account ke numbers, force disconnect, **manual connect** (WABA id + phone id + system user token — App Review / Tech Provider se pehle apne test number ke liye).
10. **Dev tools** — fake signup dialog (Finish / Cancel / Error / coexistence / only-WABA outcomes), **webhook simulator** (non-production): signed sample events (quality change, name approved, restricted, inbound message) → asli pipeline se.
11. **Meta billing — two options per account** (decided 22 Oct 2026): **platform credit line** (default — hamari Solution Partner credit line WABA se attach, Meta hume bill kare, hum wallet se kaatein — Phase 11) ya **customer pays Meta** (customer apna card WhatsApp Manager me lagaye). Superadmin per account choose kare **connect se pehle** (Meta credit line ek baar attach hone ke baad WABA pe badal nahi sakti). Connect ke waqt platform mode me credit line attach step chalega.
12. **Coexistence fully** (decided 22 Oct 2026): WhatsApp Business app wale number pe customer **apne phone se** jo messages bheje (`smb_message_echoes`), purani chats (`history`, ~180 days tak) aur phone ke contacts (`smb_app_state_sync`) — teeno webhooks subscribe + store; connect ke baad contacts + history **sync request** Meta ko. Phase 10 inhe chat screen me dikhayega ("Sent from the WhatsApp Business app" label).
13. **UI** — WhatsApp menu → **Numbers** page: empty state + requirements, Connect wizard, number cards, detail drawer, rename, sync, retry, reconnect, disconnect, live updates.

**Done when:** Owner test mode me **Connect WhatsApp** se ek number connect kare → card pe **Connected** + quality + messaging limit + display name dikhe; signed webhook events (quality change, restriction, name approved) **live** card update karen + bell notification; token invalid → **Needs reconnect** → reconnect → Connected; disconnect; viewer / impersonator connect na kar sake — **Playwright se proven**; real Meta ke liye setup doc + env rules ready (real call sirf manual checklist, Phase 13 me).

### Phase 9 mein kya NAHI hoga

| Kaam                                                                                           | Kaunse phase mein                                                      |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Real Meta developer app banana, `config_id`, webhook URL Meta me daalna, Business verification | Phase 9 ke 1–2 phase baad (aapka decision) / Phase 13                  |
| Messages padhna / bhejna, chat screen, media, 24-hour window                                   | Phase 10 (Phase 9 sirf events store + count karta hai)                 |
| Templates create / sync / send, WhatsApp pricing, wallet charges, Meta rate card, markup       | Phase 11                                                               |
| Calling settings, call permission, calls                                                       | Phase 12 (Phase 9 sirf coexistence flag + eligibility data rakhta hai) |
| Public HTTPS deploy, privacy / terms pages, App Review submission                              | Phase 13                                                               |
| Business display name change request, profile (about, photo, website) edit                     | Phase 10 (profile) — open question §7                                  |
| Multiple Meta apps / per-WABA webhook override                                                 | Open question §7 (default: one app, app-level webhook)                 |
| Instagram / Messenger channels                                                                 | Scope me nahi                                                          |

### Conventions to follow

Same as earlier phases: [api.md](../conventions/api.md), [security.md](../conventions/security.md) (tokens = secrets), [secrets.md](../conventions/secrets.md), [data.md](../conventions/data.md), [data-model.md](../conventions/data-model.md) (§2.6 Integrations me naye collections), [websocket.md](../conventions/websocket.md), [audit.md](../conventions/audit.md), [error-codes.md](../conventions/error-codes.md), [definition-of-done.md](../conventions/definition-of-done.md), ADR 0005 (queues), Phase 4 webhook pattern (raw body only on that path, HMAC constant-time compare, event id idempotency). **Logs never carry** phones, WABA / phone ids together with names, tokens, codes, PINs, webhook payloads or message text. Tests make **no network calls** (real Graph client tested against a local `node:http` stub server like `tests/payments/providers.test.ts`). Meta code / tokens are never sent to the browser. AutoChatix code is **reference only** (patterns + bugs to avoid), not copied.

---

## 1. Locked decisions (pehle se tay — implementation me dobara debate nahi)

### 1a. Architecture

```
Browser (Numbers page)
  ├─ META_PROVIDER=meta : Meta JS SDK → FB.login({ config_id, response_type: 'code', extras }) ─┐
  │                        + window 'message' listener (WA_EMBEDDED_SIGNUP: waba_id, phone_number_id)│
  └─ META_PROVIDER=fake : "Test mode — simulated Meta signup" dialog → fake code + session info ────┤
                                                                                                    ▼
POST /api/v1/whatsapp/channels/embedded-signup { code, sessionInfo, mode }
  → whatsapp.service.connect():
      1 exchange code → business token          (MetaClient.exchangeCode)
      2 debug_token → scopes + granted WABA ids (MetaClient.debugToken)   → client IDs verified
      3 resolve WABA + phone (session info → granted ids → /{waba}/phone_numbers; fallback discovery)
      4 duplicate / reconnect check (phoneNumberId unique among active channels)
      5 WABA + phone details                    (MetaClient.getWaba / getPhoneNumber)
      6 subscribe app to WABA                   (MetaClient.subscribeApp)
      7 billing: platform credit line attach    (MetaClient.attachCreditLine)  | customer → payment check
      8 cloud_api: register number (PIN sealed) (MetaClient.registerPhone) | coexistence: request contacts + history sync
      9 save channel (token sealed) → audit → WS `whatsapp.channel.updated`
      partial failure after step 1 → channel saved as `action_needed` + reason → "Retry setup"

Meta ──► GET  /webhooks/meta   (hub.verify_token → hub.challenge)
Meta ──► POST /webhooks/meta   raw body → X-Hub-Signature-256 → split entries/changes
           → metaWebhookEvents (sealed payload, idempotency key, TTL 7 d) → 200 fast
           → queue `whatsapp` job `webhook.process:<eventId>` → worker → handler by `field`
                 account_update / phone_number_quality_update / phone_number_name_update /
                 business_capability_update → channel fields + status + notifications + WS
                 messages / calls / message_template_status_update / user_preferences / others
                       → stored `deferred` + counters (Phase 10 / 11 / 12 consume)

Repeatable job `whatsapp.health` (daily) + "Sync now" → debug_token + details → transitions
Meta app callbacks: POST /meta/deauthorize · POST /meta/data-deletion · GET /meta/data-deletion/:code
```

- `MetaClient` interface (`src/core/meta/types.ts`) — do implementations: `createGraphMetaClient` (real `fetch`, base URL configurable for tests) aur `createFakeMetaClient` (deterministic, in-process). Factory `createMetaClient(env)` — `META_PROVIDER` se.
- Module layout: `src/core/meta/` (client, fake, signature, errors, schemas), `src/modules/whatsapp/` (channels service / routes / schema, webhooks routes / service / handlers, jobs, health, admin, dev simulator, data deletion), models in `src/db/models/`.
- WhatsApp disabled (`WHATSAPP_ENABLED=false`) → saare `/whatsapp/*` routes `503 WHATSAPP_NOT_CONFIGURED`, webhook route 404, UI "WhatsApp is not set up on this server" — production deploy WhatsApp config ke bina bhi ho sake.

### 1b. Meta config & env

| Env                         | Default (dev / test)           | Production rule                                                                                                                      |
| --------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `WHATSAPP_ENABLED`          | `true`                         | optional; `false` → routes 503                                                                                                       |
| `META_PROVIDER`             | `fake`                         | must be `meta` when `WHATSAPP_ENABLED=true`                                                                                          |
| `META_APP_ID`               | — (fake ignores)               | required with `meta`, digits only                                                                                                    |
| `META_APP_SECRET`           | —                              | required with `meta`, ≥ 32 chars, not a placeholder                                                                                  |
| `META_ES_CONFIG_ID`         | —                              | required with `meta` (Facebook Login for Business configuration id)                                                                  |
| `META_WEBHOOK_VERIFY_TOKEN` | `dev-meta-verify-token` (fake) | required with `meta`, ≥ 24 chars, not a placeholder                                                                                  |
| `META_GRAPH_VERSION`        | `v23.0`                        | `^v\d+\.\d+$`; latest stable at setup time (AutoChatix uses `v23.0`)                                                                 |
| `META_GRAPH_BASE_URL`       | `https://graph.facebook.com`   | must stay the default in production (tests point it at a stub)                                                                       |
| `FAKE_META_APP_SECRET`      | `dev-fake-meta-app-secret`     | must not be set in production                                                                                                        |
| `META_CREDIT_LINE_ID`       | — (fake: `fake_ecl_1`)         | required with `meta` when an account uses `metaPayer: platform` (checked at attach time, not boot); digits only                      |
| `META_SYSTEM_USER_TOKEN`    | — (fake ignores)               | required with `meta` + credit line (System User of our business: `business_management`, Admin / Financial Editor role); never logged |
| `ENCRYPTION_KEY`            | dev key                        | already required in production (Phase 5) — seals tokens / PINs                                                                       |

- `.env.example` me **placeholders** (khaali values + comments) — real values setup ke din. AutoChatix ke credentials code / `.env.example` / docs me **nahi** copy honge (secrets rule); app id public hota hai par wo bhi setup ke din `.env` me hi.
- `GET /api/v1/whatsapp/config` (authenticated, any role): `{ enabled, provider: 'meta' | 'fake', appId?, configId?, graphVersion, sdkVersion }` — browser ko sirf public values (app id, config id). App secret / verify token kabhi nahi.

### 1c. Embedded Signup (frontend contract)

- Real mode: Meta JS SDK **lazy load** (`https://connect.facebook.net/en_US/sdk.js`, script id `facebook-jssdk`) sirf Connect dabane par, `FB.init({ appId, autoLogAppEvents: true, xfbml: true, version: graphVersion })`.
- `FB.login(callback, { config_id, response_type: 'code', override_default_response_type: true, extras: { setup: {}, featureType, sessionInfoVersion: 3 } })`:
  - **Cloud API mode** (default): `featureType` omitted (standard onboarding).
  - **Coexistence mode**: `featureType: 'whatsapp_business_app_onboarding'` (AutoChatix isi pe tha — isliye uske numbers pe calling `141000` deti thi).
- `window` `message` listener — **origin check** (`https://www.facebook.com` / `https://web.facebook.com`), JSON parse safe, `type === 'WA_EMBEDDED_SIGNUP'`:
  - `FINISH` → `{ waba_id, phone_number_id }`; `FINISH_ONLY_WABA` → WABA without number; coexistence finish event (name verified at setup — Meta docs); `ERROR` → `error_message`; cancel → `current_step` (UI: "Signup cancelled at <step>").
- `FB.login` callback se `authResponse.code` → **turant** backend ko (Meta code ~30 s me expire) — session info event code se pehle ya baad aa sakta hai, isliye UI dono ka 3 s tak wait kare, phir jo hai wo bheje (backend discovery fallback karega).
- Cancel / error → kuch save nahi, clear message; popup blocked → "Allow pop-ups for this site".
- Fake mode: **Test signup dialog** — business name, phone (+91…), display name, mode (Cloud API / WhatsApp Business app), outcome (Finish / Finish without number / Cancel at step / Error) → `{ code: 'fake.<base64url json>', sessionInfo }` — same backend route.

### 1d. Backend connect flow (exact)

1. Guard: `WHATSAPP_ENABLED`, permission `whatsapp.manage`, not impersonating, account active, `≤ maxChannelsPerAccount` active channels, body zod (`code` 1–2048 chars, `sessionInfo { wabaId?, phoneNumberId? }` numeric strings, `mode`), **rate limit** `rl:wa-connect:` 10 / hour / account.
2. **Exchange** `GET /oauth/access_token?client_id&client_secret&code` → `access_token` (never logged). Errors: expired / used code → `WHATSAPP_SIGNUP_FAILED` ("The Meta signup expired — try again"), others → `META_API_ERROR`.
3. **Verify scopes** `GET /debug_token?input_token=<token>&access_token=<app_id>|<app_secret>` → `is_valid`, `type`, `expires_at` (0 = never), `scopes`, `granular_scopes[].target_ids`. Required scopes: `whatsapp_business_management` (+ `whatsapp_business_messaging`). Granted WABA ids = target ids of `whatsapp_business_management`.
4. **Resolve WABA**: session `wabaId` ∈ granted ids → use; else exactly one granted id → use; else fallbacks (AutoChatix order): `/me/whatsapp_business_accounts`, `/me/businesses?fields=whatsapp_business_accounts` → must still be ∈ granted ids when granted ids exist. Not found → `WHATSAPP_SIGNUP_FAILED` ("No WhatsApp Business Account was shared").
5. **Resolve phone**: `GET /{waba}/phone_numbers?fields=id,display_phone_number,verified_name,…` → session `phoneNumberId` must be in the list; else exactly one number → use; none (`FINISH_ONLY_WABA`) → channel `action_needed` ("Add a phone number in WhatsApp Manager, then Sync").
6. **Duplicate / reconnect**: an active channel with this `phoneNumberId` in **another** account → `409 WHATSAPP_NUMBER_IN_USE` (token dropped, nothing saved); same account → **reconnect** (update token + details, keep id / history, audit `whatsapp.channel_reconnected`).
7. **Details**: WABA `GET /{waba}?fields=id,name,currency,timezone_id,message_template_namespace,account_review_status,business_verification_status,owner_business_info` and phone `GET /{phone}?fields=id,display_phone_number,verified_name,name_status,new_name_status,quality_rating,messaging_limit_tier,code_verification_status,platform_type,throughput,account_mode,status,is_official_business_account,is_on_biz_app`.
8. **Subscribe** `POST /{waba}/subscribed_apps` (idempotent at Meta).
9. **Billing setup** — account `whatsapp.metaPayer`:
   - `platform`: add our System User to the WABA (`POST /{waba}/assigned_users?user=<system user id>&tasks=['MANAGE']` with the business token — Meta prerequisite), then `POST /{META_CREDIT_LINE_ID}/whatsapp_credit_sharing_and_attach?waba_id=<waba>&waba_currency=<wabaCurrency>` with `META_SYSTEM_USER_TOKEN` → store `allocation_config_id`; optional check `GET /{allocation_config_id}?fields=receiving_credential`. Unsupported currency (not AUD / EUR / GBP / IDR / INR / USD), WABA already on another partner's credit line, or any Meta error → `action_needed` ("Couldn't attach the platform credit line: …") + Retry setup (superadmin may switch the account to `customer` first).
   - `customer`: skip; channel shows "Add a payment method in WhatsApp Manager" until the WABA reports a funding source (`primary_funding_id` present → `paymentMethodOk: true`, re-checked on sync).
10. **Register** (Cloud API mode, phone `status` not connected / registration needed): random **6-digit PIN** (crypto), `POST /{phone}/register { messaging_product: 'whatsapp', pin }`, PIN sealed. Coexistence mode: skip registration (Meta manages it) and instead request the **coexistence sync**: `POST /{phone}/smb_app_data { messaging_product: 'whatsapp', sync_type: 'smb_app_state_sync' }` (contacts) then `{ sync_type: 'history' }` (past chats). Meta allows this only shortly after onboarding — the exact window and field names are re-checked against Meta's coexistence docs at setup. Failures → `coexistence.*Sync: 'failed'` + "Retry sync" (the channel stays `connected`). `133005` / pin mismatch → `action_needed` ("Two-step verification PIN is already set on this number — enter it to finish"; UI asks PIN → `POST /:id/register { pin }`).
11. **Save**: channel (§1e) `connected` (or `action_needed` with `statusReason`), `connectedBy`, `connectedAt`, `metaUserId` (from debug token `user_id`, for deauthorize), audit `whatsapp.channel_connected` (meta: channel id, mode, last 4 of number, WABA id), WS `whatsapp.channel.updated`, response = channel view (no token / PIN).

- Steps 5–10 failure after a valid token → save `action_needed` with sealed token + `statusReason { step, code, message }` → `POST /:id/retry-setup` reruns 5–10 (finished steps are skipped). Concurrency: unique partial index + Redis lock `wa-connect:<phoneNumberId>` (two tabs / double click).

### 1e. Data model (new collections — data-model.md §2.6)

**WhatsAppChannel** (`whatsappChannels`, `tenantPlugin`):

| Field                                                                           | Type                                                                                                                                      | Notes                                                                                         |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| label                                                                           | string ≤ 60                                                                                                                               | default verified name; user-editable                                                          |
| provider                                                                        | `meta \| fake`                                                                                                                            | fake channels refused when `META_PROVIDER=meta`                                               |
| mode                                                                            | `cloud_api \| coexistence`                                                                                                                |                                                                                               |
| wabaId, wabaName, businessId, businessName                                      | string                                                                                                                                    |                                                                                               |
| wabaCurrency, wabaTimezoneId, templateNamespace                                 | string                                                                                                                                    | Phase 11 uses                                                                                 |
| wabaReviewStatus, businessVerificationStatus                                    | string                                                                                                                                    | raw Meta enums                                                                                |
| phoneNumberId                                                                   | string                                                                                                                                    | **unique among non-disconnected** (partial index)                                             |
| phoneE164, displayPhoneNumber                                                   | string                                                                                                                                    | E.164 normalised + Meta display                                                               |
| verifiedName, nameStatus, newNameStatus                                         | string                                                                                                                                    | `APPROVED`, `PENDING_REVIEW`, `DECLINED`, `EXPIRED`, …                                        |
| qualityRating                                                                   | `GREEN \| YELLOW \| RED \| UNKNOWN`                                                                                                       |                                                                                               |
| messagingLimitTier                                                              | `TIER_50 \| TIER_250 \| TIER_1K \| TIER_10K \| TIER_100K \| TIER_UNLIMITED \| null`                                                       | Phase 12 / 20 eligibility (≥ 2,000)                                                           |
| throughputLevel, accountMode, platformType, codeVerificationStatus, phoneStatus | string                                                                                                                                    | raw                                                                                           |
| isOfficialBusinessAccount, isOnBizApp                                           | boolean                                                                                                                                   | `isOnBizApp` → calling not available                                                          |
| tokenSealed                                                                     | string                                                                                                                                    | secret-box; **select: false**                                                                 |
| tokenType, tokenScopes, tokenExpiresAt, tokenCheckedAt, metaUserId              | string, string[], Date \| null, Date, string                                                                                              | `metaUserId` for deauthorize                                                                  |
| registration                                                                    | `{ status: not_needed \| pending \| registered \| failed, pinSealed (select: false), error, at }`                                         |                                                                                               |
| subscription                                                                    | `{ status: subscribed \| failed, error, at }`                                                                                             |                                                                                               |
| status                                                                          | `connecting \| connected \| action_needed \| needs_reconnect \| restricted \| disconnected`                                               |                                                                                               |
| statusReason                                                                    | `{ code, message, step? } \| null`                                                                                                        | human text, no PII                                                                            |
| restriction                                                                     | `{ type, until? } \| null`                                                                                                                | from `account_update`                                                                         |
| webhook                                                                         | `{ lastEventAt, lastField }`                                                                                                              | health                                                                                        |
| metaPayer                                                                       | `customer \| platform`                                                                                                                    | copied from the account setting at connect; immutable per WABA once a credit line is attached |
| creditLine                                                                      | `{ status: not_needed \| attached \| failed, allocationConfigId, error, at }`                                                             | platform mode                                                                                 |
| paymentMethodOk                                                                 | boolean \| null                                                                                                                           | customer mode (WABA `primary_funding_id`)                                                     |
| coexistence                                                                     | `{ contactsSync, historySync, historyProgress, echoesAt }` — sync statuses `not_requested \| requested \| received \| declined \| failed` | coexistence mode only                                                                         |
| connectedBy, connectedAt, syncedAt, disconnectedBy, disconnectedAt              | ObjectId / Date                                                                                                                           |                                                                                               |
| history                                                                         | `[{ status, reason, at, by }]` (last 50)                                                                                                  | drawer timeline                                                                               |

Indexes: `{ phoneNumberId: 1 }` unique partial `{ status: { $ne: 'disconnected' } }`, `{ accountId: 1, status: 1 }`, `{ wabaId: 1 }`, `{ metaUserId: 1 }`.

**Account addition:** `whatsapp: { metaPayer: 'platform' | 'customer' }` (default `platform`), set by superadmin (`PATCH /admin/accounts/:id/whatsapp-billing`), read-only for the account; changing it never changes channels already connected.

**MetaWebhookEvent** (`metaWebhookEvents`, not tenant-required — `accountId` nullable until routed):

| Field                   | Type                                                     | Notes                                                                 |
| ----------------------- | -------------------------------------------------------- | --------------------------------------------------------------------- |
| key                     | string                                                   | **unique** — sha256(object + entry id + field + stable JSON of value) |
| field                   | string                                                   | `messages`, `calls`, `account_update`, …                              |
| wabaId, phoneNumberId   | string \| null                                           |                                                                       |
| accountId, channelId    | ObjectId \| null                                         | after routing                                                         |
| payloadSealed           | string                                                   | secret-box of the change `value` (PII inside) — **select: false**     |
| status                  | `received \| processed \| deferred \| ignored \| failed` | `deferred` = later phase consumes                                     |
| attempts, error         | number, string                                           | error text without PII                                                |
| receivedAt, processedAt | Date                                                     |                                                                       |
| expiresAt               | Date                                                     | **TTL** 7 days (`deferred` kept until consumed or 30 days)            |

Indexes: `{ key: 1 }` unique, `{ status: 1, receivedAt: 1 }`, `{ channelId: 1, field: 1, receivedAt: -1 }`, `{ expiresAt: 1 }` TTL.

**MetaDeletionRequest** (`metaDeletionRequests`): `confirmationCode` (unique, random), `metaUserId`, `status` (`received` / `completed`), `channelsAffected`, `receivedAt`, `completedAt`. TTL 365 days.

### 1f. Webhook pipeline (exact)

- `app.ts`: `raw({ type: 'application/json', limit: WHATSAPP_LIMITS.webhookMaxBytes })` **only** on `/api/v1/webhooks/meta` (before `json()`), like Razorpay.
- `GET /webhooks/meta`: `hub.mode === 'subscribe'` and `hub.verify_token` constant-time equal → `200 text/plain hub.challenge`; else `403`. Fake mode uses the dev verify token.
- `POST /webhooks/meta`: signature header `X-Hub-Signature-256: sha256=<hex>` = HMAC-SHA256(app secret, raw bytes); missing / bad → `401` (counter in metrics log, never the body). Body must be `object === 'whatsapp_business_account'` (others → 200 ignored).
- For each `entry[].changes[]` → idempotency key → insert event (duplicate key → skip) → enqueue `webhook.process` (job id = event id). Response `200` after the inserts (target < 300 ms). Mongo / Redis down → `503` (Meta retries — up to 7 days).
- Worker: open payload → route (`value.metadata.phone_number_id` → channel; else entry id = WABA id → channels of that WABA) → unknown → `ignored` (+ superadmin count) → handler by `field` → `processed` / `deferred` / `failed` (retry 5× exponential; then `failed`, superadmin list + "Replay").
- Every routed event updates `channel.webhook.lastEventAt / lastField` (throttled to once / minute per channel).
- **Phase 9 handlers:**
  - `account_update` — `event`: `ACCOUNT_RESTRICTION` / `DISABLED_UPDATE` / `ACCOUNT_VIOLATION` / `BANNED` → `restricted` + reason + notification; `VERIFIED_ACCOUNT` / `ACCOUNT_UPDATE` → re-sync details; partner removed / app unsubscribed → `needs_reconnect`.
  - `phone_number_quality_update` — `event` (`UPGRADE` / `DOWNGRADE` / `FLAGGED` / `UNFLAGGED`), `current_limit` → `messagingLimitTier`, quality re-fetch; to `RED` / `FLAGGED` → notification.
  - `phone_number_name_update` — `decision` (`APPROVED` / `REJECTED` / `DEFERRED`), `requested_verified_name` → `nameStatus`, `verifiedName` (on approve), notification.
  - `business_capability_update` — limits snapshot (`max_daily_conversation_per_phone`, `max_phone_numbers_per_business`) on the channel.
  - **Coexistence:** `smb_message_echoes` (messages the business sent from its own phone) → `deferred` for Phase 10 + `coexistence.echoesAt`; `history` (progress chunks / decline) → `deferred` + `coexistence.historySync` (`received` on the final chunk, `declined` when the business refused) + `historyProgress`; `smb_app_state_sync` (contacts) → `deferred` + `coexistence.contactsSync: 'received'`. Deferred coexistence events kept **30 days** (Phase 10 imports them).
  - Fields to subscribe in the Meta app (setup doc): `messages`, `calls`, `account_update`, `phone_number_quality_update`, `phone_number_name_update`, `business_capability_update`, `message_template_status_update`, `message_template_quality_update`, `template_category_update`, `user_preferences`, `security`, `history`, `smb_app_state_sync`, `smb_message_echoes`.
  - `messages` (incoming + `statuses`), `calls`, `message_template_status_update`, `message_template_quality_update`, `template_category_update`, `user_preferences`, `security`, unknown fields → `deferred` (stored for Phase 10 / 11 / 12; per-channel counters `events24h`).
- Payload schemas: zod for the envelope + each Phase 9 field (with **fixtures copied from Meta's documented sample payloads**, numbers / names replaced by test values); unknown extra keys allowed (Meta adds fields).

### 1g. Health, sync, statuses

| Status            | Meaning                                                       | Set by                                              | UI action                      |
| ----------------- | ------------------------------------------------------------- | --------------------------------------------------- | ------------------------------ |
| `connecting`      | Signup in progress (short-lived)                              | connect step 1–9                                    | spinner                        |
| `connected`       | Token valid, subscribed, registered                           | connect / sync                                      | —                              |
| `action_needed`   | A setup step failed / number missing / PIN needed             | connect / retry / sync                              | Retry setup / Enter PIN / Sync |
| `needs_reconnect` | Token invalid / expired / revoked (Graph `190`), deauthorized | Graph error `190`, health job, deauthorize callback | Reconnect (signup again)       |
| `restricted`      | Meta restricted / banned / disabled the account / number      | `account_update`, sync                              | link to WhatsApp Manager       |
| `disconnected`    | User / superadmin disconnected                                | disconnect                                          | Connect again                  |

- Repeatable job `whatsapp.health` daily (03:30 account timezone not needed — UTC 22:00): every non-disconnected channel → `debug_token` + phone + WABA details; status transitions → `history`, WS, audit (system actor), notifications to owners / admins (`whatsapp.channel_needs_reconnect`, `whatsapp.channel_restricted`, `whatsapp.quality_low`, `whatsapp.name_approved` / `whatsapp.name_rejected`).
- "Sync now" (`POST /:id/sync`, 1 / minute per channel) — same as one health pass.
- Any Graph call returning `190` (or `OAuthException` with subcode 460 / 463 / 467) for a channel → `needs_reconnect` immediately.

### 1h. Disconnect / reconnect / manual connect

- **Disconnect** (`POST /:id/disconnect`, `whatsapp.manage`, confirm): `DELETE /{waba}/subscribed_apps` only if no other active channel of **any** account uses that WABA (else skip), clear `tokenSealed` + `pinSealed`, status `disconnected`, audit, WS. **Never deregister** the number (customer's WhatsApp keeps working). History / later messages kept.
- **Reconnect** = signup again; the same `phoneNumberId` in the same account updates the old record.
- **Superadmin force disconnect** (`POST /admin/whatsapp/channels/:id/disconnect`, reason required) — audit on both sides, notification to account owners.
- **Manual connect** (superadmin only, `POST /admin/accounts/:id/whatsapp/manual-connect { wabaId, phoneNumberId, accessToken }`): for the platform's own test number before Tech Provider / App Review (token = a System User token from the app owner's business). Same steps 3–10 (`debug_token` must show access to that WABA). Hidden in the UI behind superadmin; audit `whatsapp.channel_connected` with `manual: true`.
  | PATCH | `/admin/accounts/:id/whatsapp-billing` | superadmin | `{ metaPayer }` — numbers connected from now on |
  | POST | `/whatsapp/channels/:id/coexistence-sync` | `whatsapp.manage` | retry contacts / history sync (coexistence) |

### 1i. Meta app callbacks (App Review prerequisites)

- `POST /api/v1/meta/deauthorize` and `POST /api/v1/meta/data-deletion` — `application/x-www-form-urlencoded` body `signed_request = <base64url sig>.<base64url payload>`; verify HMAC-SHA256(app secret, payload part) constant-time, `algorithm === 'HMAC-SHA256'`, `issued_at` within 1 day.
- Deauthorize: channels with `metaUserId === user_id` → `needs_reconnect` (reason "Access removed in Facebook"), audit system actor.
- Data deletion: create `MetaDeletionRequest` (random confirmation code), clear tokens / PINs of that user's channels and mark them `needs_reconnect`, keep business records (account data is the customer's, deleted via account deletion — Phase 16), respond `{ url: "<FRONTEND_URL>/data-deletion?code=<code>", confirmation_code: <code> }`.
- `GET /api/v1/meta/data-deletion/:code` (public) → `{ status, receivedAt, completedAt }`; frontend public page `/data-deletion` shows it + instructions text (what we store from Meta and how it is removed).

### 1j. Fake Meta provider (dev / test / E2E)

- Codes: `fake.<base64url({ businessName, phone, displayName, mode, outcome })>` — single use (Redis set `fake-meta:used:<sha256>`, TTL 10 min), age-free.
- Deterministic ids: WABA `fake_waba_<hash>`, phone id `fake_phone_<hash>`, business id `fake_biz_<hash>` (hash of business + phone), so reconnect finds the same number.
- `debugToken` fake: valid unless the token was **revoked** by the simulator; scopes both WhatsApp permissions; granted WABA = its WABA.
- Phone details: quality `GREEN`, tier `TIER_1K`, name `APPROVED` (or `PENDING_REVIEW` when display name contains "pending"), `isOnBizApp` = coexistence mode, `status` `PENDING` until registered.
- Error knobs (for tests / E2E): phone `+91 90000 00001` → register fails `133005` (PIN needed), `+91 90000 00002` → subscribe fails (Graph 500), outcome `error` → exchange fails.
- Fake billing: credit-line attach returns `fake_alloc_<hash>`; business name containing "foreign" → WABA currency `XYZ` → unsupported-currency error; containing "other partner" → already-attached error; customer mode → `primary_funding_id` absent until the simulator kind `payment_method_added`.
- Fake coexistence sync: accepted; the simulator then emits `smb_app_state_sync` (3 contacts) and `history` (2 chunks, last final); kind `history_declined` emits a decline.
- **Webhook simulator** (`POST /api/v1/dev/meta/webhooks`, non-production + `MOCK_APIS_ENABLED`, `whatsapp.manage` on own channels / superadmin any): kinds `quality_downgrade`, `quality_upgrade`, `flagged`, `name_approved`, `name_rejected`, `restricted`, `unrestricted`, `token_revoked`, `inbound_text` (sample message, stored deferred), `status_delivered`, `echo_text` (coexistence: sent from the business phone), `history_chunk`, `history_declined`, `contacts_sync`, `payment_method_added` — builds Meta-shaped payloads, **signs with the app secret** and calls the same pipeline (no shortcut).

### 1k. Limits (`WHATSAPP_LIMITS`)

| Limit                          | Value                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `maxChannelsPerAccount`        | 10 (non-disconnected)                                                        |
| `labelMax`                     | 60                                                                           |
| `webhookMaxBytes`              | 3 MB                                                                         |
| `webhookEventTtlDays`          | 7 (deferred: 30)                                                             |
| `webhookProcessAttempts`       | 5 (exponential, base 30 s)                                                   |
| `graphTimeoutMs`               | 10,000                                                                       |
| `graphRetries`                 | 3 (5xx, rate limit 4 / 17 / 32 / 613 / 80007, network) with backoff + jitter |
| `connectPerHourPerAccount`     | 10                                                                           |
| `syncPerMinutePerChannel`      | 1                                                                            |
| `sessionInfoWaitMs` (frontend) | 3,000                                                                        |
| `historyMax`                   | 50 entries per channel                                                       |
| `deletionStatusTtlDays`        | 365                                                                          |

### 1l. Security & privacy

- Tokens / PINs sealed (secret-box, `ENCRYPTION_KEY`), `select: false`, never in API responses, WS, audit meta, logs, errors (Graph error text scrubbed of `access_token=`).
- App secret only in env; signatures constant-time; webhook raw body only on that path; body size limit.
- Session info IDs from the browser are **hints** — always verified against the token's granted WABA ids.
- One phone number → one active channel platform-wide (partial unique index).
- Webhook payloads sealed at rest, 7-day TTL, never logged; superadmin "Replay failed event" shows only metadata.
- Tenant isolation: every channel route scoped by `accountId`; webhook routing never trusts payload account data.
- Impersonating superadmin: read only (no connect / disconnect / sync).
- Graph calls never use the user's own Facebook token (none stored); only the business token / app token.

### 1m. Permissions & roles

| Permission              | Owner / Admin | Manager | Agent | Viewer |
| ----------------------- | ------------- | ------- | ----- | ------ |
| `whatsapp.read` (new)   | ✓             | ✓       | ✓     | ✓      |
| `whatsapp.manage` (new) | ✓             | —       | —     | —      |

- New permissions → migration calls `syncSystemRoles()`. Phase 10 adds `inbox.*`.

### 1n. API surface (all `/api/v1`)

| Method | Path                                          | Auth / permission         | Notes                                                                                |
| ------ | --------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------ |
| GET    | `/whatsapp/config`                            | any signed-in user        | public config (§1b)                                                                  |
| GET    | `/whatsapp/channels`                          | `whatsapp.read`           | list (no token), counts                                                              |
| GET    | `/whatsapp/channels/:id`                      | `whatsapp.read`           | detail + history + webhook health                                                    |
| POST   | `/whatsapp/channels/embedded-signup`          | `whatsapp.manage`         | §1d; rate limited                                                                    |
| PATCH  | `/whatsapp/channels/:id`                      | `whatsapp.manage`         | `{ label }`                                                                          |
| POST   | `/whatsapp/channels/:id/sync`                 | `whatsapp.manage`         | §1g                                                                                  |
| POST   | `/whatsapp/channels/:id/retry-setup`          | `whatsapp.manage`         | reruns steps 5–9                                                                     |
| POST   | `/whatsapp/channels/:id/register`             | `whatsapp.manage`         | `{ pin }` (6 digits) when Meta needs the existing PIN                                |
| POST   | `/whatsapp/channels/:id/disconnect`           | `whatsapp.manage`         | §1h                                                                                  |
| GET    | `/webhooks/meta`                              | public (verify token)     | §1f                                                                                  |
| POST   | `/webhooks/meta`                              | public (signature)        | §1f                                                                                  |
| POST   | `/meta/deauthorize`, `/meta/data-deletion`    | public (`signed_request`) | §1i                                                                                  |
| GET    | `/meta/data-deletion/:code`                   | public                    | status                                                                               |
| GET    | `/admin/whatsapp/status`                      | superadmin                | provider, configured flags, webhook URL, last event, counts by status, failed events |
| GET    | `/admin/whatsapp/events?status=failed`        | superadmin                | metadata only                                                                        |
| POST   | `/admin/whatsapp/events/:id/replay`           | superadmin                | re-enqueue                                                                           |
| GET    | `/admin/accounts/:id` (+ `whatsappChannels`)  | superadmin                | summary                                                                              |
| POST   | `/admin/whatsapp/channels/:id/disconnect`     | superadmin                | `{ reason }`                                                                         |
| POST   | `/admin/accounts/:id/whatsapp/manual-connect` | superadmin                | §1h                                                                                  |
| POST   | `/dev/meta/webhooks`                          | non-production only       | simulator §1j                                                                        |

- **Error codes (new):** `WHATSAPP_NOT_CONFIGURED` (503), `WHATSAPP_SIGNUP_FAILED` (422, details: step), `WHATSAPP_NUMBER_IN_USE` (409), `WHATSAPP_CHANNEL_LIMIT` (409), `WHATSAPP_CHANNEL_NOT_READY` (409 — action needed / needs reconnect / disconnected for actions that need a working channel), `META_API_ERROR` (502, details: Meta code / subcode / trace id — no token), `META_SIGNATURE_INVALID` (401). Count 47 → 54.
- **Audit (new):** `whatsapp.billing_mode_changed` (superadmin, both sides), `whatsapp.credit_line_attached`, `whatsapp.channel_connected`, `whatsapp.channel_reconnected`, `whatsapp.channel_setup_failed`, `whatsapp.channel_renamed`, `whatsapp.channel_disconnected`, `whatsapp.channel_status_changed` (system), `whatsapp.channel_registered`, `meta.deauthorized`, `meta.data_deletion_requested`, `whatsapp.event_replayed` (superadmin). Meta: channel id, mode, last 4 digits, WABA id, status, reason code — never tokens / PINs / names of customers.
- **WS (new):** `whatsapp.channel.updated` `{ channelId, status, qualityRating, messagingLimitTier, nameStatus }` to the account.
- **Notifications (new types):** `whatsapp.channel_needs_reconnect`, `whatsapp.channel_restricted`, `whatsapp.quality_low`, `whatsapp.name_approved`, `whatsapp.name_rejected`, `whatsapp.channel_disconnected_by_admin` (to owners + admins; emails for needs-reconnect, restricted, admin disconnect).

### 1o. Frontend

- **Menu:** new item **WhatsApp** (`/whatsapp`, icon `WhatsApp` outlined or `ChatOutlined`, `whatsapp.read`, `phase: 9`). Reports → `phase: 14`, Integrations → `phase: 15` (BUILD_PLAN_V2 numbering), `LIVE_PHASE = 9`.
- **WhatsApp page** (`/whatsapp` → `/whatsapp/numbers`, lazy chunk) with tabs — **Numbers** now (Templates in Phase 11, Calling in Phase 12):
  - **Empty state:** what connecting does, requirements checklist (Meta Business account, a phone number that can receive an SMS / voice code, not used on the WhatsApp app unless "WhatsApp Business app" mode, display name rules link), **Connect WhatsApp** button.
  - **Connect wizard** (dialog): 1) choose type — _New or Cloud API number (recommended — calling works)_ / _Number already on the WhatsApp Business app (coexistence — calling won't work)_; 2) Meta popup (real) or **Test signup** dialog (fake, banner "Test mode — Meta signup is simulated"); 3) progress (Exchanging… Checking access… Subscribing… Registering…); 4) result: Connected (number card preview) / Action needed (reason + next step) / Cancelled / Error (Meta message) / Number in use.
  - **Number cards / table:** label, number, verified name + name status chip, status chip, quality chip (green / yellow / red), messaging limit ("1K / day"), mode badge, WABA name, connected by / at, last synced; actions by role + state: Sync now, Rename, Retry setup, Enter PIN, Reconnect, Disconnect (confirm with consequences).
  - **Billing line on the card:** "Meta billed to: platform credit line ✓" or "Meta billed to: your WhatsApp Manager payment method — Add payment method ↗" (customer mode, until Meta reports one).
  - **Coexistence section:** "Messages from your phone appear in this app" + contacts sync / history sync status (requested / received / declined / failed + Retry sync).
  - **Detail drawer:** ids with copy (WABA id, phone number id, business id), business verification + WABA review status, token checked at, webhook health (last event, field, events 24 h), history timeline, dev-only **Send test event** menu (fake provider + non-production).
  - Live updates from `whatsapp.channel.updated`; impersonators / non-managers see read-only.
- **Superadmin:** account detail **WhatsApp numbers** card (status, quality, force disconnect with reason, manual connect dialog) + **Meta billing** setting (Platform credit line / Customer pays Meta; confirm: "Applies to numbers connected from now on — a credit line can't be removed from a WhatsApp account once attached"); **Admin → WhatsApp** page (or System card): provider + configured flags, **webhook URL to paste in Meta** (copy), verify token set ✓, last webhook received, events by status, failed events with Replay.
- **Notifications:** icons / texts / links for the new types; **dashboard** card "Connect WhatsApp" (owner / admin, no channel yet) or "WhatsApp: 2 numbers connected · 1 needs attention".
- **Public page** `/data-deletion` (no login): instructions + status by `?code=`.
- Meta SDK loader (`src/features/whatsapp/meta-sdk.ts`): loads once, typed `window.FB`, timeout 15 s → error "Couldn't load Meta's signup (blocked by an extension or network?)"; never loaded in fake mode or tests.
- Bundle: WhatsApp page lazy; main growth ≤ 3 KB gzip.

### 1p. Testing strategy

- **Unit (backend):** env rules (every row of §1b), signature (valid / tampered / missing prefix / wrong length / constant-time path), `signed_request` parse (valid, bad sig, bad algorithm, stale), idempotency key stability, zod schemas against Meta sample fixtures, Graph error mapping (190, 4 / 17 / 32 / 613 / 80007 retry, 100, 133005, timeouts), status transition table, fake provider determinism + single-use codes + error knobs.
- **Graph client:** against a local `node:http` stub (paths, query params, auth header / app token, retries with backoff, timeout, token never in thrown errors).
- **Integration:** connect happy path (cloud API + coexistence); platform credit line attached / unsupported currency / other partner → action needed → account switched to customer → retry; customer mode payment-method flag; coexistence sync requested → `smb_app_state_sync` + `history` events update the channel; history declined; echoes stored deferred; FINISH_ONLY_WABA → action needed → sync after adding number, session info missing → discovery fallback, session WABA not granted → refused, duplicate in another account → 409, reconnect same account, register PIN needed → `/register`, subscribe fail → action needed → retry setup, double connect race (unique index + lock), channel limit, roles, impersonator, suspended account, disabled WhatsApp → 503; webhook GET verify; POST bad signature 401; duplicate delivery once; unknown phone ignored; each Phase 9 handler; deferred fields stored; Redis down → 503; worker retry → failed → replay; health job transitions + notifications + emails; deauthorize / data deletion; superadmin routes; dev simulator refused in production; logs without tokens / phones / payloads (pino capture).
- **Hardening:** 1,000 webhook events burst (all stored once, processed, < N s), restart mid-processing (no loss, no duplicate effects), migration up / down.
- **Frontend unit:** config / clients, Meta SDK loader (fake `window.FB`), session-info listener (origin check, all events), connect wizard (both modes, every outcome), cards / drawer / actions by role + state, live updates, superadmin cards, data deletion page, nav renumbering.
- **E2E (Playwright, fake Meta):** owner connects (Cloud API) → Connected card + details; cancel + error outcomes; coexistence warning + badge; PIN-needed number → Enter PIN → Connected; simulated quality downgrade → card yellow / red live + bell; `token_revoked` → Needs reconnect → reconnect → Connected; rename; disconnect; second account same number → "already connected"; roles (viewer read only, manager no Connect, impersonator read only); superadmin sees numbers + force disconnect + status page webhook URL; `/data-deletion` page; webhook endpoint verify challenge + bad signature 401 (Playwright `request`).
- Coverage gates stay ≥ backend 95 / 85 / 95 / 95, frontend 95 / 90 / 90 / 95.

### 1q. Contract for later phases

| Function / data                                                                                                        | Used by                                                   |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `MetaClient` (+ fake) and `getChannelToken(channel)`                                                                   | Phase 10 send / media, Phase 11 templates, Phase 12 calls |
| `metaWebhookEvents` `deferred` (`messages`, statuses, `calls`, template fields, `user_preferences`) + handler registry | Phase 10 / 11 / 12 consumers                              |
| `whatsappChannels` (status, `messagingLimitTier`, `isOnBizApp`, `mode`, `metaPayer`)                                   | Phase 11 billing, Phase 12 eligibility, Phase 20 pacing   |
| Webhook simulator kinds                                                                                                | Phase 10–12 E2E                                           |
| Data deletion + deauthorize callbacks, Admin WhatsApp status page                                                      | Phase 13 App Review                                       |

---

## 2. Tasks ka overview

| #     | Task                                                                                                                                                                                               | Repo | Size | Depends on  |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---- | ----------- |
| T9.1  | Models (3), migration 0010, `WHATSAPP_LIMITS`, env + production rules, error codes, audit, WS, notifications, permissions + role sync                                                              | BE   | M    | —           |
| T9.2  | `src/core/meta`: `MetaClient` types, Graph client (timeouts, retries, errors), fake client, signatures (`X-Hub-Signature-256`, `signed_request`), zod schemas + Meta fixtures                      | BE   | M    | T9.1        |
| T9.3  | WhatsApp channel service: connect (§1d), reconnect, retry setup, register PIN, sync, rename, disconnect, statuses + history                                                                        | BE   | L    | T9.2        |
| T9.4  | Webhook pipeline: raw body route, verify, signature, event store, queue `whatsapp` + worker, routing, Phase 9 handlers, deferred fields, retries                                                   | BE   | L    | T9.2, T9.3  |
| T9.5  | Health job + notifications / emails, Meta callbacks (deauthorize, data deletion + status), superadmin endpoints (status, events + replay, force disconnect, manual connect), dev webhook simulator | BE   | M    | T9.3, T9.4  |
| T9.6  | API routes + OpenAPI + rate limits, seed (demo fake channel), `dev:whatsapp` script                                                                                                                | BE   | M    | T9.3–T9.5   |
| T9.7  | Hardening (burst, restart, races, logs), ADR 0037, `docs/setup/meta-whatsapp.md` (real Meta setup steps), docs                                                                                     | BE   | M    | T9.6        |
| T9.8  | FE foundation: `gen:api`, clients, hooks, WS event, nav (WhatsApp, renumber Reports / Integrations, `LIVE_PHASE = 9`), routes, Meta SDK loader + session listener, Test signup dialog              | FE   | M    | T9.6        |
| T9.9  | WhatsApp → Numbers page: empty state, connect wizard, cards, drawer, actions, live updates, roles                                                                                                  | FE   | L    | T9.8        |
| T9.10 | Entry points: superadmin numbers card + manual connect + force disconnect, Admin WhatsApp status page, notifications, dashboard card, `/data-deletion` page                                        | FE   | M    | T9.9        |
| T9.11 | Playwright E2E (§1p) — whole suite twice                                                                                                                                                           | FE   | M    | T9.9, T9.10 |
| T9.12 | Gap audit, security checklist, docs, Phase 9 sign-off                                                                                                                                              | both | M    | all         |

Batches: **Batch 1 = T9.1–T9.4** (`[P9-B1-DONE]`), **Batch 2 = T9.5–T9.7** (`[P9-B2-DONE]`), **Batch 3 = T9.8–T9.12** (`[P9-B3-DONE]`).

---

## 3. Tasks — step by step

### T9.1 — Models, migration 0010, limits, catalogue

- [x] `whatsapp-channel.model.ts` (§1e, `tenantPlugin`, `tokenSealed` / `registration.pinSealed` `select: false`, indexes incl. the partial unique on `phoneNumberId`), `meta-webhook-event.model.ts` (unique `key`, TTL), `meta-deletion-request.model.ts` (unique `confirmationCode`, TTL).
- [x] Migration **0010-whatsapp**: collections + indexes, `syncSystemRoles()` for `whatsapp.read` / `whatsapp.manage`; up / down + rollback test.
- [x] `WHATSAPP_LIMITS` (§1k) in `config/limits.ts`.
- [x] Env (§1b) with production rules + `env.test.ts` rows; `.env.example` placeholders + README env table rows (env-docs test).
- [x] Error codes (7 new, 47 → 54) + error-codes.md; audit actions (§1n) + meta shapes + audit.md; WS event `whatsapp.channel.updated` (backend `events.ts` + websocket.md); notification types (6) + email templates (needs reconnect, restricted, admin disconnect); permissions + role matrix + snapshot test; tenant-scope test exemption for `metaWebhookEvents` / `metaDeletionRequests` (documented reason).
- [x] Queue name `whatsapp` in `core/queues/names.ts`.
- [x] data-model.md §2.6 (three collections), rbac docs.

### T9.2 — Meta core

- [x] `src/core/meta/types.ts` — `MetaClient` (`exchangeCode`, `debugToken`, `listOwnedWabas`, `listBusinessesWithWabas`, `getWaba`, `listPhoneNumbers`, `getPhoneNumber`, `subscribeApp`, `unsubscribeApp`, `registerPhone`), result types, `MetaApiError` (status, code, subcode, type, message scrubbed, fbtraceId, retryable).
- [x] `graph.client.ts` — `fetch` with `AbortSignal.timeout`, `Authorization: Bearer` (never token in URL except Meta-mandated `debug_token input_token` / `oauth` — those URLs never logged), JSON parse guard, retries (§1k) with backoff + jitter, error mapping, base URL + version from env.
- [x] `fake.client.ts` (§1j) — deterministic ids, single-use codes, revocable tokens, error knobs, simulated details.
- [x] `signature.ts` — `verifyWebhookSignature(rawBody, header, secret)`, `parseSignedRequest(value, secret, now)`.
- [x] `schemas.ts` — zod for token / debug token / WABA / phone / phone list / webhook envelope + Phase 9 change values; fixtures in `tests/fixtures/meta/*.json` (from Meta docs samples, test values only).
- [x] `createMetaClient(env)` factory; `createFakeMetaClient` exported for tests.
- [x] Tests: stub-server client tests, fake determinism, signatures, schemas.

### T9.3 — WhatsApp channel service

- [x] `whatsapp.service.ts`: `connect` (§1d all 10 steps, Redis lock, partial-failure save), `retrySetup`, `submitPin`, `sync` (one health pass), `rename`, `disconnect` (§1h), `listChannels`, `getChannel` (view without secrets), `getChannelToken` (internal, opens seal), status transition helper (history ≤ 50, WS, audit for user actions, system actor for jobs).
- [x] `channel-json.ts` — list / detail views (no token, no PIN, last-4 only where a number appears in audit).
- [x] Graph `190` anywhere → `markNeedsReconnect(channel, reason)`.
- [x] Tests: every path in §1p "Integration" for the service (fake client + stub client cases).

### T9.4 — Webhook pipeline

- [x] `app.ts` raw parser for `/api/v1/webhooks/meta`; routes GET / POST (§1f).
- [x] Event store (key, sealed payload, insert-or-skip), enqueue `webhook.process` (job id `wa-event-<id>`), `whatsapp` worker (concurrency 10), routing, handlers (`account_update`, `phone_number_quality_update`, `phone_number_name_update`, `business_capability_update`), deferred registry (`registerDeferredField(field)` + `consumeDeferred(field, handler)` API for later phases), throttled `webhook.lastEventAt`.
- [x] Retries (5, exponential) → `failed`; maintenance purge of expired events (TTL backup); counters (events 24 h per channel) via aggregation.
- [x] 503 when Mongo / Redis unavailable; metrics log line (counts only).
- [x] Tests: verify challenge, signature cases, duplicates, unknown routing, each handler (fixtures), deferred storage, retry → failed → replay, Redis down, logs clean.

### T9.5 — Health, callbacks, superadmin, simulator

- [x] Repeatable `whatsapp.health` job + per-channel pass; notifications + emails on transitions (once per transition, not every run).
- [x] Deauthorize + data deletion callbacks + status (§1i).
- [x] Superadmin: status endpoint (webhook URL = `APP_URL/api/v1/webhooks/meta`), failed events list + replay, account detail `whatsappChannels` summary, force disconnect, manual connect.
- [x] Dev simulator `POST /dev/meta/webhooks` (§1j kinds) — mounted only when not production and `MOCK_APIS_ENABLED`, signs with the active app secret, goes through `POST /webhooks/meta` handler.
- [x] Tests for each.

### T9.6 — API, OpenAPI, seed, dev script

- [x] `whatsapp.routes.ts`, `meta-callbacks.routes.ts`, admin routes, rate limits (`rl:wa-connect:`, `rl:wa-sync:`), zod bodies / params, OpenAPI registration (+ schemas imported in `openapi.ts` — Phase 8 lesson), `openapi:check`.
- [x] Seed: demo account gets one fake channel "Demo Finance" (`+91 90000 12345`, connected, GREEN, `TIER_1K`) via the fake signup path (not hand-written docs), idempotent.
- [x] `npm run dev:whatsapp` (dev only): connects a fake number for an account and fires a few simulated events; prints counts only.
- [x] Tests: roles × routes, isolation (another account → 404), impersonator 403, suspended account, disabled WhatsApp 503, OpenAPI document contains the new paths.

### T9.7 — Hardening + docs

- [x] 1,000-event burst, restart mid-run, concurrent connect race, double delivery, migration down.
- [x] **ADR 0037** — WhatsApp channel architecture (MetaClient + fake, token storage, webhook pipeline + deferred fields, onboarding modes, one number → one active channel, manual connect).
- [x] **`docs/setup/meta-whatsapp.md`** — real setup checklist for later: create Meta app (Business type), add WhatsApp + Facebook Login for Business products, Embedded Signup configuration (permissions `whatsapp_business_management`, `whatsapp_business_messaging`, `business_management` if asked) → `config_id`, app domain + allowed JS SDK domains, webhook callback URL + verify token + fields to subscribe (§1f list), deauthorize + data deletion callback URLs, app secret → env, test number / test WABA, System User token for manual connect, dev tunnel (Cloudflare Tunnel) for local webhooks, Tech Provider onboarding, Business verification; how to switch `META_PROVIDER=meta`; smoke checklist (verify challenge, connect a test number, simulated events off, real event arrives).
- [x] README (WhatsApp section, env), security.md (Meta tokens, signatures), compliance-notes (Meta data deletion), CHANGELOG Phase 9 · Batch 1 / 2, `[P9-B2-DONE]` (full backend verify).

### T9.8 — FE foundation

- [ ] `npm run gen:api`; `whatsappApi` (config, channels, signup, actions), `adminWhatsappApi`, `metaPublicApi` (data deletion status); types aliases.
- [ ] Query keys / hooks (`useWhatsAppConfig`, `useChannels`, `useChannel`, mutations), WS `whatsapp.channel.updated` → cache updates.
- [ ] Nav: WhatsApp item (`phase: 9`), Reports `phase: 14`, Integrations `phase: 15`, `LIVE_PHASE = 9`; layout test updated.
- [ ] Routes: `/whatsapp` (lazy), `/whatsapp/numbers`, public `/data-deletion`.
- [ ] `meta-sdk.ts` loader + `useEmbeddedSignup()` hook (FB.login options per mode, session listener with origin check, 3 s wait, outcomes), `TestSignupDialog` (fake mode).
- [ ] Tests: loader with fake `window.FB`, listener events, hook outcomes, nav.

### T9.9 — Numbers page

- [ ] Empty state + requirements; Connect wizard (mode choice, popup / test dialog, progress, results, error texts per code); cards / table; detail drawer; rename; sync; retry setup; Enter PIN dialog (6 digits); reconnect; disconnect confirm; dev "Send test event" menu; roles + impersonation read-only; live updates.
- [ ] Tests for every state, action and role.

### T9.10 — Entry points

- [ ] Superadmin account detail WhatsApp card (force disconnect with reason, manual connect dialog), Admin WhatsApp status page (webhook URL copy, configured flags, failed events + replay), notifications icons / texts / links, dashboard WhatsApp card, `/data-deletion` page.
- [ ] Bundle check vs `main` (same script as Phase 8).
- [ ] Tests.

### T9.11 — Playwright E2E

- [ ] Helpers `e2e/whatsapp.ts` (`connectFakeNumber(page, opts)`, `simulateEvent(page, kind)`, `numberCard(page, label)`).
- [ ] Scenarios (one account per spec, serial, short tests):
  1. **`whatsapp-connect.spec.ts` (Done when):** empty state → Connect → Cloud API → test signup Finish → progress → **Connected** card (number, verified name, GREEN, 1K / day, Cloud API) → drawer ids + history → rename → simulated `quality_downgrade` → card YELLOW live + bell → `token_revoked` → Needs reconnect → Reconnect → Connected → Disconnect → Disconnected.
  2. **`whatsapp-outcomes.spec.ts`:** coexistence connect → "Messages from your phone appear in this app" + sync statuses → simulated `echo_text` counted in the drawer; platform credit line ✓ on the card; superadmin switches the account to customer → next number shows "Add a payment method" → `payment_method_added` → ok; cancel at a step (nothing saved, message), error outcome, coexistence → warning + badge, only-WABA → Action needed → (simulate number added) Sync → Connected, PIN-needed number → Enter PIN → Connected.
  3. **`whatsapp-roles.spec.ts`:** viewer sees numbers read only, manager no Connect / Disconnect, second account same number → "already connected to another account", impersonating superadmin read only, superadmin force disconnect → owner bell + Disconnected, Admin status page shows the webhook URL.
  4. **`whatsapp-meta-endpoints.spec.ts`:** `GET /webhooks/meta` challenge (right / wrong token), signed vs unsigned POST (200 / 401), data deletion status page.
- [ ] All earlier 61 tests stay green; whole suite **twice** (2nd with `E2E_BACKEND_LOGS=1` + log grep for tokens / codes / PINs / phones / payload text); `E2E_FRONTEND_PORT=3150`.

### T9.12 — Gap audit, security, docs, sign-off

- [ ] Requirement → test table for §0 / §1 / every task; missing tests added.
- [ ] Security checklist: tokens / PINs never in API / WS / logs / audit (grep + tests), signatures constant-time, raw body only on the webhook path, browser IDs verified, isolation, impersonation read only, webhook payloads sealed, gitleaks both repos, `console.log` 0.
- [ ] Coverage re-measured (gates never lowered), bundle numbers, burst numbers.
- [ ] Docs both repos (READMEs, CHANGELOGs), BUILD_PLAN_V2 Phase 9 ✅, PHASE_9_TASKS all `[x]`, this plan ticked + changelog, **PHASE_9_SIGNOFF.md**; `[P9-B3-DONE]` (full verify both repos, E2E twice, fresh clones without `.env`, actionlint, gitleaks, `infra:down`).

---

## 4. Deliverables checklist

- [ ] WhatsAppChannel / MetaWebhookEvent / MetaDeletionRequest models, migration 0010, limits, env + production rules, codes, audit, WS, notifications, permissions.
- [ ] `MetaClient` (Graph + fake), signatures, schemas + fixtures.
- [ ] Embedded Signup connect (both modes) with verification, discovery fallback, subscribe, register, partial-failure recovery, reconnect, PIN, sync, rename, disconnect.
- [ ] Webhook pipeline (verify, signature, store, queue, worker, routing, Phase 9 handlers, deferred fields, retries, replay).
- [ ] Health job + notifications / emails; deauthorize + data deletion callbacks + status page.
- [ ] Superadmin status / events / force disconnect / manual connect; dev webhook simulator; seed; `dev:whatsapp`.
- [ ] UI: WhatsApp → Numbers (empty state, connect wizard, cards, drawer, actions), superadmin pieces, notifications, dashboard card, `/data-deletion`.
- [ ] Playwright: connect (Done when), outcomes, roles, Meta endpoints.
- [ ] Docs: ADR 0037, setup guide for the real Meta app, data-model, security, compliance, READMEs, CHANGELOGs, sign-off.

## 5. Risks

| Risk                                                                            | Mitigation                                                                                                                                      |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Fake Meta differs from real Meta (field names, events, error codes)             | Schemas + fixtures from Meta's documented samples; unknown keys allowed; real smoke checklist in the setup doc; first real run in Phase 13 prep |
| Embedded Signup event names / extras change (Meta versions)                     | Event names + extras in one module; defensive parsing; backend discovery fallback when session info is missing                                  |
| Code expiry (~30 s) between popup and backend                                   | Send the code immediately; session info optional; clear "try again" message                                                                     |
| Client IDs spoofed from the browser                                             | Always verified against `debug_token` granted WABA ids                                                                                          |
| Coexistence numbers break calling later                                         | Explicit mode choice + warning + `isOnBizApp` flag; Phase 12 checks                                                                             |
| Credit line attach is irreversible; Meta is replacing its credit-sharing method | Billing mode set by superadmin before connect; attach isolated in one client method; setup doc re-checks Meta's current method                  |
| Coexistence sync window missed (Meta allows it shortly after onboarding)        | Sync requested right after connect; status visible + Retry sync; failure doesn't block the channel                                              |
| Webhook storms / Meta retries                                                   | Insert-or-skip idempotency, fast 200, queue, worker concurrency, burst test                                                                     |
| Token revoked silently                                                          | Daily health job + `190` detection on every call → Needs reconnect + email                                                                      |
| Deregistering a customer's number by mistake                                    | Disconnect never deregisters; only unsubscribes when no channel uses the WABA                                                                   |
| Who pays Meta (customer card vs platform credit line) affects Phase 11          | `metaPayer` stored now; decision before Phase 11 (§7)                                                                                           |

## 6. Recommended order

| Day   | Tasks |
| ----- | ----- |
| 1     | T9.1  |
| 2–3   | T9.2  |
| 4–5   | T9.3  |
| 6–7   | T9.4  |
| 8     | T9.5  |
| 9     | T9.6  |
| 10    | T9.7  |
| 11    | T9.8  |
| 12–13 | T9.9  |
| 14    | T9.10 |
| 15    | T9.11 |
| 16    | T9.12 |

_Estimate — run batch-wise with one detailed run prompt (Batch 1 = T9.1–T9.4, Batch 2 = T9.5–T9.7, Batch 3 = T9.8–T9.12)._

## 7. Open questions (defaults used until answered)

| #   | Question                                                                                  | Who                       | Default in Phase 9                                                                                 |
| --- | ----------------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | Who pays Meta?                                                                            | You — **answered 22 Oct** | **Both, per account** (superadmin): platform credit line (default) or customer pays Meta           |
| 2   | Tech Provider only, or Solution Partner?                                                  | You                       | Solution Partner path (credit line sharing) + customer-pays path; Meta partner onboarding at setup |
| 3   | Allow coexistence (WhatsApp Business app) numbers?                                        | You — **answered 22 Oct** | **Yes** — phone messages (echoes), history and contacts synced; calling unavailable                |
| 4   | Max numbers per account                                                                   | You                       | 10                                                                                                 |
| 5   | Who can connect / disconnect                                                              | You — **answered 22 Oct** | Owner / admin only                                                                                 |
| 6   | Separate Meta apps for staging and production, or one app + per-WABA webhook override?    | You                       | One app per environment (simplest); override not built                                             |
| 7   | Graph API version                                                                         | You                       | `v23.0` (bump at setup to the latest stable)                                                       |
| 8   | Keep stored webhook events how long (debug / replay)?                                     | You                       | 7 days (deferred 30)                                                                               |
| 9   | Business profile edit (about, photo, website) in Phase 9 or 10?                           | You                       | Phase 10                                                                                           |
| 10  | Is the "number in use in another account" rule ever overridden (agency managing clients)? | Client                    | No — one active channel per number                                                                 |

---

## Changelog

- 2026-10-22: Plan created after Phase 8 sign-off and BUILD_PLAN_V2 (WhatsApp first for Meta App Review). Real Meta developer app setup deferred by the project owner — the phase is built and tested on a fake Meta provider; `docs/setup/meta-whatsapp.md` makes the later switch an env-only change. Data deletion / deauthorize callbacks pulled into Phase 9 (Meta app plumbing) from Phase 13.
- 2026-10-22: Decisions from the project owner — (1) Meta billing **both ways** per account: platform credit line (default, Solution Partner `whatsapp_credit_sharing_and_attach`) or customer pays Meta; (2) **coexistence** numbers supported fully: echoes from the business phone, history and contacts sync (stored in Phase 9, shown in Phase 10); (3) connect / disconnect owner + admin only. §0, §1b, §1d, §1e, §1f, §1j, §1n, §1o, §1p, §5, §7 updated.
- 2026-10-22 (T9.1): `WHATSAPP_ENABLED` defaults to `true` outside production and to `Boolean(META_APP_ID)` in production (a production deploy without a Meta app keeps WhatsApp off instead of failing to boot). The baseline had **11** notification types (not 13) → **17** after Phase 9 (+6).
- 2026-10-22: **Batch 1 done** (T9.1–T9.4, `[P9-B1-DONE]`). Deviations: (1) `WHATSAPP_ENABLED` production default = `Boolean(META_APP_ID)` (above); (2) notification types 11 → 17 (the prompt's 13 → 19 counted wrong); (3) fake signup codes carry a random `nonce` (same business + phone twice → two valid codes, like Meta); (4) the webhook 503 uses `PROVIDER_UNAVAILABLE` (no new error code — the catalogue stays at 54); (5) `account_update` events without their own effect (`ACCOUNT_UPDATE`, `VERIFIED_ACCOUNT`, …) run a channel sync, so the simulator's `token_revoked` / `payment_method_added` kinds go through the real pipeline; (6) a billing retry re-reads the account's Meta payer until a credit line is attached (superadmin can switch a failing account to "customer pays Meta"); (7) the simulator payload builders (`simulator.ts`) were added with Batch 1 because `npm run dev:whatsapp` needs them — the simulator route stays in T9.5; (8) `ErrorDetail` gained `metaCode` / `metaSubcode` / `fbtraceId` for `META_API_ERROR`; (9) `setLogger()` test hook in `shared/logger.ts`.
- 2026-10-22: **Batch 2 done** (T9.5–T9.7, `[P9-B2-DONE]`). Manual check on the dev server through the HTTP API (config, Cloud API + coexistence connect, verify challenge, unsigned POST 401, simulated quality downgrade + flag → red / `TIER_250` + one notification per recipient, `token_revoked` → needs reconnect, data deletion + status, superadmin status with the webhook URL, owner 403) and logs free of tokens, codes, `Bearer`, payload texts and the numbers. Deviations: (1) the manual sync limit (1 / min / number) is a Redis key in the service (`wa-rl-sync-<id>`, also used by coexistence retries) instead of an `rl:wa-sync:` express limiter — same effect in every process; (2) `GET /whatsapp/config` also answers 503 when WhatsApp is off (every `/whatsapp/*` route does); (3) Meta callbacks answer `422` (the project's validation status) instead of `400` for stale / malformed `signed_request`; (4) a restriction taken from the phone status ends when Meta reports the number `CONNECTED` again, webhook restrictions last until their end date or a lifting event (found by the health tests before commit); (5) quality-red / name approved / rejected notifications moved into the sync, so a webhook plus its re-check notify once; (6) replay also accepts `ignored` events; (7) a Phase 8 dispatcher test raced its own wake on a loaded machine (also on `main`) — fixed test-only (`b57e192`).
