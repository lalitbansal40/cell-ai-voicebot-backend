# PINNACLE RUN — Managed WhatsApp numbers over the Pinnacle API — Autonomous Run Prompt

> **HOW TO RUN (ise paste karo):**
> `docs/prompts/PINNACLE_PROVIDER_PROMPT.md padho aur PN-T0 se PN-DONE tak SAARE tasks step by step autonomously implement karo. Bich me koi question mat poochho, permission mat maango — saare decisions is prompt me pre-made hain. Har task ke baad verify + commit (tag [PN]). Koi push / merge NAHI. Ant me [PN-DONE] checkpoint + final report.`
>
> **Claude Code "accept edits" mode me chalao.** Working directories: `cell-ai-voicebot-backend` and `cell-ai-voicebot-frontend` (siblings under `~/Documents/cell-ai-voicebot`).

---

## 0. Context (verified facts — dobara derive mat karna)

### 0.1 Business flow (owner's words, made exact)

1. A customer is onboarded on **Pinnacle's side**: Pinnacle's panel (`wa1.cell24x7.com`, Cell 24x7 = Reseller, prepaid wallet) hosts the Embedded Signup. The WABA then appears under _Tech Provider → Tech Provider Customers_ (Techprovider `Cell24x7_Reseller`), with columns WABA id, Currency, Timezone id, Message template namespace, username and **Credit-line request** (NA / requested / approved).
2. The superadmin copies from that panel: **WABA id**, **phone number id** (_Whatsapp → Manage Accounts_) and the number's **API key** (_Admin → Manage API Keys_).
3. On our platform the superadmin opens a **new option, "Add managed number"**, fills those details and submits.
4. On submit we check the key with Pinnacle, read the WABA / number details through Pinnacle, and call Pinnacle **`setwebhook`** so Pinnacle sends that number's callbacks to **our** URL with **our secret header**.
5. From then on **every** API call for that number goes to **Pinnacle's API** instead of Meta's Graph API, including:
   - sending messages, read receipts and media;
   - templates and the business profile;
   - blocking contacts;
   - WhatsApp calling: AI, team, team → AI, and bulk / campaign.

   Every incoming event for that number arrives on our Pinnacle webhook and runs through the existing pipeline unchanged.

6. Meta's charges for these numbers go on **Pinnacle's credit line**: requested in the panel and billed to our Pinnacle wallet. We charge the customer from our own wallet exactly like any "platform pays Meta" number.
7. Numbers connected through our own Embedded Signup (Meta) keep working exactly as today.

### 0.2 Pinnacle API facts

Sources, all in `~/Downloads`:

- `PINNACLE_PARTNERS_API_DOCUMENTATION_VERSION 4.1 2026.pdf`
- Postman `Partners_API_V3_PostmanCollection`
- `WhatsApp Voice - API Documentation.pdf` and `WhatsApp Voice - Callback Documentation.pdf`
- `Pinnacle WhatsApp Solution Cloud Callback API V3 July2025.pdf`
- `WhatsApp Solution API Error Code_CloudAPI.pdf`
- `Credit-Line-Revocation-API-Guide.pdf`

**Base and auth**

- Base URL: `https://partnersv1.pinbot.ai/v3/`.
- Auth header: **`apikey: <WABA API key>`** (one key per WABA / number). It is **not** `Authorization: Bearer`.
- A few `/v3/business/…` endpoints take `access_token: <TSP token>` instead. We use none of them in this run.

**Paths that mirror Meta Graph** (same JSON bodies and responses as Graph v2x):

| Use                     | Method + path                                                                                                                                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Send message            | `POST {phone_number_id}/messages` (text / media / template / interactive / reaction / mark read `{status:"read", message_id}`)                                                                                   |
| Templates               | `GET {wabaid}/message_templates` (with `fields`, `limit`, `status`, paging) · `POST {wabaid}/message_templates` · `POST {msgtemplateid}` (edit) · `DELETE {wabaid}/message_templates?name=` and `?hsm_id=&name=` |
| Media upload            | `POST {phone_number_id}/media` (multipart)                                                                                                                                                                       |
| Media URL               | `GET {mediaid}?phone_number_id={id}`                                                                                                                                                                             |
| Media download          | `POST downloadMedia/{mediaid}?phone_number_id={id}` → bytes                                                                                                                                                      |
| Media delete            | `DELETE {mediaid}?phone_number_id={id}`                                                                                                                                                                          |
| Template example upload | `POST app/uploads?file_length=&file_type=` → `{id:"upload:…"}`, then `POST {uploadSessionId}` with bytes (`file_offset: 0`) → `{h}`                                                                              |
| WABA                    | `GET {wabaid}`                                                                                                                                                                                                   |
| Phone numbers           | `GET business/{waba_id}/phone_numbers` (+ `fields`)                                                                                                                                                              |
| Phone number            | `GET business/{phoneNumberId}`                                                                                                                                                                                   |
| Business profile        | `GET` / `POST business/{phone_number_id}/whatsapp_business_profile`                                                                                                                                              |
| Block / unblock         | `POST` / `DELETE {phone_number_id}/block_users` (verify; Graph-mirror)                                                                                                                                           |
| Register                | `POST {phone_number_id}/register` (Graph-mirror; normally already done by Pinnacle)                                                                                                                              |
| Calling settings        | `POST {phoneid}/settings` `{ calling: { status, call_icon_visibility, call_hours, callback_permission_status } }` · `GET {phoneid}/settings`                                                                     |
| Call permission         | `GET {phoneid}/call_permissions?user_wa_id=`                                                                                                                                                                     |
| Calls                   | `POST {phoneid}/calls` with `action: connect \| pre_accept \| accept \| reject \| terminate`, `call_id`, `session { sdp_type, sdp }`, `biz_opaque_callback_data`                                                 |

**Pinnacle-only endpoints**

| Use         | Method + path                                                                 | Response                                                                                                      |
| ----------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Key check   | `GET getuserdetails`                                                          | `{ code: 200, status: "SUCCESS", data: [{ whatsapp_business_account_id, wanumber, phone_number_id }] }`       |
| Set webhook | `POST {phone_number_id}/setwebhook` body `{ webhook_url, headers: { k: v } }` | `{ code: "200", status: "Success", message }`. Pinnacle relays **Meta's payload unchanged** plus our headers. |
| Get webhook | `GET {phone_number_id}/getwebhook`                                            | `{ webhook_url, headers }`                                                                                    |

**Errors are not Meta-shaped**

- Example: `{ "code": 100, "status": "failed", "message": "Insufficient Balance" }`.
- These can come with **HTTP 200**.
- Meta-shaped `{ error: { … } }` also passes through for Graph errors.

**Callbacks**

- Meta envelope `{ object: "whatsapp_business_account", entry[].changes[] }`, including `field: "calls"`.
- `calls` events carry `connect` with an SDP answer, and `terminate`, exactly as Meta sends them.
- Our parsers apply unchanged.

**Voice API host**

- The voice doc shows only a test load balancer: `http://Test-API-Load-Testing-NLB-…elb.ap-south-1.amazonaws.com/v3`.
- The production host is an env var (`PINNACLE_VOICE_BASE_URL`, default = `PINNACLE_BASE_URL`).

**Credit line**

- Request / approval / revoke all happen in Pinnacle's panel.
- Revoke works per business portfolio and cannot be undone.
- **We never call credit-line APIs in this run.**

### 0.3 Codebase facts (backend)

**Client**

- `src/core/meta/types.ts` defines the `MetaClient` interface, about 60 methods. Every channel method takes `token` plus Meta ids.
- Implementations:
  - `graph.client.ts`: `createGraphMetaClient(options: GraphMetaClientOptions)`. Options: `baseUrl`, `graphVersion`, `fetch`, `logger`, `timeoutMs`, `retries`, `mediaHosts`. Internals: `call`, `bearer(name, method, path, token, schema, opts)`, `callAction`. URL = `${baseUrl}/${graphVersion}/${path}`.
  - `fake.client.ts`: `createFakeMetaClient`.
- Factory: `src/core/meta/index.ts#createMetaClient(env, deps)` picks a client by `META_PROVIDER` (`fake | meta`). `metaAppSecret(env)` is there too.

**Context**

- `src/modules/whatsapp/context.ts#WhatsAppContext`: `{ env, meta, redis, key, now?, callsFastPath? }`. Helpers: `sealSecret`, `openSecret`, `toE164`, `phoneLast4`.
- Built in `src/server.ts:~300` (`meta: createMetaClient(env, { redis, logger })`).

**Channel model** (`src/db/models/whatsapp-channel.model.ts`)

- Enums:
  - `WA_PROVIDERS = ['meta','fake']`
  - `WA_MODES = ['cloud_api','coexistence']`
  - `META_PAYERS = ['platform','customer']`
  - `REGISTRATION_STATUSES`
  - `CREDIT_LINE_STATUSES = ['not_needed','attached','failed']`
  - `SUBSCRIPTION_STATUSES = ['subscribed','failed']`
  - `CONNECT_STEPS = ['phone','details','subscribe','billing','register']`
  - `WA_CALLING_UNAVAILABLE_REASONS = ['coexistence','country','messaging_limit','not_cloud_api']`
  - `WA_CHANNEL_STATUSES`; `WA_ACTIVE_STATUSES` = all except disconnected (partial unique index on `phoneNumberId`).
- Fields: `tokenSealed` (select:false), `tokenType`, `tokenScopes`, `tokenExpiresAt`, `tokenCheckedAt`, `metaUserId`, `registration{status,pinSealed,error,at}`, `subscription{…}`, `metaPayer`, `creditLine{status,allocationConfigId,error,at}`, `status`, `statusReason{code,message,step}`, `webhook{lastEventAt,lastField}`, `history[]`, `calling{status,unavailableReason,…}`.

**Service** (`src/modules/whatsapp/whatsapp.service.ts`, `createWhatsAppService(ctx, hooks)`)

- `const { meta, redis } = ctx`
- Locks: `withLock`, `rateLimit`, `load(accountId,id,secrets)` (with `SECRET_FIELDS = '+tokenSealed +registration.pinSealed'`), `tokenOf`, `activeElsewhere`.
- `runSetup(channel, token, from, actor)` walks `CONNECT_STEPS`: `listPhoneNumbers`, `getWaba`, `getPhoneNumber`, `subscribeApp`, `setupBilling`, `registerPhone` / coexistence.
- `connect(input)`:
  - `exchangeCode` / `debugToken` → `listPhoneNumbers` (ES and `manual: true`).
  - `ConnectInput` has `manual?`, `accessToken?`, `sessionInfo{wabaId,phoneNumberId}`.
- `syncChannel(channel, actor)`: `debugToken` → resume setup or `getWaba` + `getPhoneNumber` → transition.
- `register` (PIN): `registerPhone`.
- `disconnect`: `unsubscribeApp` when no other channel is on the WABA.
- `retryCoexistenceSync`.

**Admin**

- `src/modules/whatsapp/whatsapp-admin.routes.ts` is mounted in `/api/v1/admin` behind `requirePlatformAdmin`; `need()` returns 503 `WHATSAPP_NOT_CONFIGURED`. Routes:
  - `GET /whatsapp/status`
  - `GET /whatsapp/events`
  - `POST /whatsapp/events/:id/replay`
  - `POST /whatsapp/channels/:id/disconnect`
  - `PATCH /accounts/:id/whatsapp-billing`
  - `POST /accounts/:id/whatsapp/manual-connect`. Service `manualConnect` (System User token) → `service.connect({ manual: true })`; schema `ManualConnectBody` in `whatsapp.schema.ts`; OpenAPI in `whatsapp.openapi.ts:~493`.

**Billing**

- `src/modules/whatsapp/billing-setup.ts#setupBilling` attaches **our own** credit line via Meta. We are a **Tech Provider without a credit line**, so it never applies to Pinnacle numbers.

**Webhooks**

- `webhooks.routes.ts`: `GET` / `POST /api/v1/webhooks/meta`.
- `webhooks.service.ts#receiveWebhook(ctx, jobs, raw, signature)`: verify `X-Hub-Signature-256` → parse `webhookEnvelopeSchema` → store `MetaWebhookEventModel` rows (idempotency `key = sha256(object|entry id|field|stable JSON)`, payload sealed) → `callsFastPath` → jobs.
- `webhook-processor.ts#routeEvent` routes by `phoneNumberId` / `wabaId`.
- The raw-body parser is mounted in `src/app.ts:~140` for `/api/v1/webhooks/meta` (`WHATSAPP_LIMITS.webhookMaxBytes`).
- Because the event key is a content hash, the **same event arriving from Meta and from Pinnacle is stored once**.

**Health**

- `src/modules/whatsapp/health.ts#runHealthPass` calls `service.syncChannel` for every active channel.
- `webhook-handlers.ts#resync` calls the same thing after events.

**Meta callbacks**

- `meta-callbacks.service.ts` (deauthorize / data-deletion) matches channels by `metaUserId`. Pinnacle channels have `metaUserId: null`, so they are untouched (keep it that way).

**Calling readiness**

- `src/modules/whatsapp-calling/readiness.ts`:
  - `callsWebhook()` uses `meta.getAppSubscriptions()`;
  - `appPermission()` uses `meta.debugToken(token)`.
- Both are Meta-app concepts that don't apply to Pinnacle numbers.

**Superadmin alert pattern**

- `src/modules/voice-api/status.ts#recordProviderError` uses a Redis `SET NX EX 3600` throttle plus `notifyPlatform({ type: 'voice_api.provider_error', … })`.
- Notification types live in `src/db/models/notification.model.ts#NOTIFICATION_TYPES`.

**Registries** (each has a catalogue test that counts entries):

- error codes: `src/shared/errors/error-codes.ts` + `docs/conventions/error-codes.md`;
- audit actions: `src/modules/audit/audit-actions.ts` + `docs/conventions/audit.md`;
- sealed fields: `src/shared/crypto/sealed-registry.ts` (a test fails when a `*Sealed` field is missing);
- WS events: `src/core/realtime/events.ts` + `docs/conventions/websocket.md`;
- notifications: `notification.model.ts`.
- `tests/calls-wa/catalogue.test.ts` holds the current totals (132 error codes, 205 audit actions, 42 WS events). Bump them.

**Migrations**

- Latest is `src/db/migrations/0027-call-modes.ts`; registered in `src/db/migrations/index.ts`.

**Every channel-bound Meta call site** (each must go through the per-channel client; verified by grep):

| File:line                                                                           | Call                                                                                       |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `inbox/send.job.ts:96`                                                              | `ix.wa.meta.uploadMedia`                                                                   |
| `inbox/send.job.ts:444`                                                             | `ix.wa.meta.sendMessage`                                                                   |
| `inbox/receipts.ts:121`, `:163`                                                     | `markRead`                                                                                 |
| `inbox/conversations.service.ts:567-568`                                            | `blockUsers` / `unblockUsers`                                                              |
| `inbox/media.service.ts:74`, `:78`                                                  | `getMediaUrl`, `downloadMedia`                                                             |
| `templates/example-media.service.ts:89`                                             | `uploadExample`                                                                            |
| `templates/template.service.ts:280`, `:424`, `:482`, `:672`                         | `createTemplate`, `editTemplate`, `deleteTemplate`, `listTemplates`                        |
| `whatsapp-calling/permissions.service.ts:159`                                       | `getCallPermissions`                                                                       |
| `whatsapp-calling/calls.service.ts:746`, `:854`, `:1074`, `:1195`, `:1280`, `:1392` | `terminateCall`, `startCall`, `acceptCall`, `rejectCall`, `terminateCall`, `preAcceptCall` |
| `whatsapp-calling/settings.service.ts:152`, `:299`                                  | `getPhoneSettings`, `updateCallingSettings`                                                |
| `whatsapp-calling/readiness.ts:265`, `:274`                                         | `getAppSubscriptions`, `debugToken` (branch, see PN-T7)                                    |
| `whatsapp/coexistence.ts:32`                                                        | `requestCoexistenceSync` (never for Pinnacle)                                              |
| `whatsapp/billing-setup.ts:71-75`                                                   | credit-line attach (never for Pinnacle)                                                    |
| `whatsapp/profile.service.ts:70`, `:85`, `:151`                                     | `getBusinessProfile`, `updateBusinessProfile`, `uploadProfilePhoto`                        |
| `whatsapp/whatsapp.service.ts:266-374`, `:478-502`, `:652`, `:694-715`, `:844`      | setup, connect, register, sync, disconnect (branch, see PN-T5 / PN-T8)                     |
| `whatsapp-billing/reconcile.ts:66`                                                  | `getPricingAnalytics` (skip for Pinnacle)                                                  |

WhatsApp campaigns send through the inbox send job, so they are covered by `send.job.ts`.

### 0.4 Codebase facts (frontend)

- Superadmin account page: `src/pages/admin/AdminAccountDetailPage.tsx` renders `src/features/admin/WhatsAppCard.tsx` (≈260 lines; numbers list, force disconnect, **`ManualConnectDialog`** using `adminWhatsappApi.manualConnect` from `src/services/api/admin-whatsapp.ts`). Texts: `src/features/admin/whatsapp-texts.ts`.
- Customer side: `src/features/whatsapp/numbers/` (`ChannelCard.tsx`, `ChannelDrawer.tsx`, `ChannelDialogs.tsx`, `NumbersPanel.tsx`, `texts.ts`), status colours / labels `src/features/whatsapp/labels.ts`.
- API types are generated: `npm run gen:api`. Tests: vitest + RTL, fixtures in `src/test/whatsapp.ts`.

## 1. Goal

A superadmin can add a WhatsApp number that lives at Pinnacle (a **managed number**) by pasting its WABA id, phone number id and API key. We:

1. verify the key;
2. fill the number's details;
3. point Pinnacle's callbacks at our webhook with a per-number secret header.

From then on every outgoing API call for that number uses Pinnacle's API, and every incoming event arrives through our Pinnacle webhook. This covers messages, templates, media, profile, inbox, campaigns and WhatsApp AI / team calling. The customer sees no difference. Meta-connected numbers are unchanged. Everything is tested without real network calls.

## 2. Scope

**In scope:**

- provider `pinnacle`;
- Pinnacle client;
- fake Pinnacle;
- per-channel client routing;
- Pinnacle webhook;
- "Add managed number" with replace key, reset webhook and credit-line state (backend + superadmin UI);
- billing state;
- balance errors;
- calling over Pinnacle;
- calling readiness;
- health / sync;
- customer-facing badge and texts;
- docs, OpenAPI, Postman, tests, sign-off.

**Out of scope (do NOT do):**

- Embedded Signup or onboarding at Pinnacle; Pinnacle's own panel.
- Pinnacle credit-line request / revoke APIs.
- Coexistence numbers over Pinnacle (always `cloud_api`).
- Moving existing Meta channels to Pinnacle.
- MM Lite, payments, QR codes, template library, analytics endpoints.
- Any real request to Pinnacle, real message, call or spend. Tests use stubs; the live checks (§9) need the owner's OK.

## 3. Locked decisions

| #   | Topic                 | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Provider value        | `WA_PROVIDERS = ['meta','fake','pinnacle']`. Set at connect, never changes on a channel. Meta channels keep `meta` / `fake` from `META_PROVIDER`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| D2  | Who adds              | **Superadmin only**, in admin → account → WhatsApp card. Blocked while impersonating, same as manual connect. Account owners never see or edit the key, secret or webhook.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| D3  | Names                 | Customer UI: "Managed number" badge, no partner name. Superadmin UI: "Add managed number (Pinnacle)".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| D4  | Client                | `createPinnacleClient(opts): PinnacleClient` where `PinnacleClient = MetaClient & PinnacleExtras`. Reuse the Graph client core: base `PINNACLE_BASE_URL`, version segment `v3`, auth header `apikey`, Pinnacle error mapper. Override methods whose path or shape differs. Methods that make no sense throw `MetaApiError` code `provider_unsupported`.                                                                                                                                                                                                                                                                                                              |
| D5  | Fake                  | `META_PROVIDER=fake` → `ctx.pinnacle = createFakePinnacleClient(ctx.meta, redis)`: the fake Meta client plus fake `getUserDetails` / `setWebhook` / `getWebhook`. Keys starting `pin_test_` are valid and see the fake identities (state in Redis under the fake prefix); `pin_bad_` → invalid key; `pin_low_` → every send fails with `provider_balance_low`.                                                                                                                                                                                                                                                                                                       |
| D6  | Token slot            | For Pinnacle channels `tokenSealed` holds the **API key** (same secret box, `select:false`). `tokenType = 'pinnacle_api_key'`, `tokenScopes = []`, `tokenExpiresAt = null`. All existing `token` parameters keep working unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| D7  | Routing               | `clientFor(ctx, channel)` in `context.ts` returns `ctx.pinnacle` when `channel.provider === 'pinnacle'` (throws `AppError('WA_PROVIDER_NOT_CONFIGURED')` 503 if `ctx.pinnacle` is missing), else `ctx.meta`. **Every** channel-bound call from §0.3 goes through it. Only `exchangeCode`, `debugToken` (Meta channels), `listOwnedWabas`, `listBusinessesWithWabas`, `getAppSubscriptions`, `getTokenOwner`, `assignSystemUser`, `attachCreditLine`, `getAllocation`, `requestCoexistenceSync` may stay on `ctx.meta`, and only on Meta-only code paths.                                                                                                             |
| D8  | Webhook URL           | `{APP_URL}/api/v1/webhooks/pinnacle/{channelId}`. Public, raw body, same size limit as the Meta route. `POST` auth: header **`x-cell-webhook-secret`** = per-channel 32-byte random (base64url), stored **sealed** (`pinnacle.webhookSecretSealed`), compared timing-safe. `GET` answers `200 ok` (panel ping, no secret needed, no data).                                                                                                                                                                                                                                                                                                                           |
| D9  | Ingest                | Split `receiveWebhook` into `verifyMetaSignature(ctx, raw, sig)` + `ingestEnvelope(ctx, jobs, envelope, source: 'meta' \| 'pinnacle', channelId?)`. Both routes use `ingestEnvelope`, so dedupe, sealing, `callsFastPath` and jobs stay shared. New event field `source` (default `'meta'`).                                                                                                                                                                                                                                                                                                                                                                         |
| D10 | Wrong sender          | Pinnacle route: every `changes[].value.metadata.phone_number_id` must equal the channel's, and `entry[].id` must equal the channel's `wabaId` when present; mismatched changes are dropped (metric `pinnacle_webhook_foreign_number`). Meta route: changes whose `phone_number_id` belongs to an active `pinnacle` channel are dropped (metric `meta_webhook_foreign_provider`). Dedupe covers the rest.                                                                                                                                                                                                                                                             |
| D11 | Billing               | Pinnacle channels: `metaPayer = 'platform'`, never call `setupBilling`. `CREDIT_LINE_STATUSES` += `partner_pending`, `partner_active`. The superadmin sets it (mirrors the panel's "Credit-line request").                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| D12 | Pending credit line   | While `partner_pending`: channel status `action_needed`, reason `partner_credit_line_pending` ("Billing for this number is being activated."). Sends and calls are blocked exactly like any `action_needed` channel. Setting `partner_active` moves it to `connected` (via `syncChannel`).                                                                                                                                                                                                                                                                                                                                                                           |
| D13 | Balance errors        | Pinnacle `status:"failed"` + message matching `/insufficient balance/i` (any HTTP status) → `MetaApiError` code `provider_balance_low`. Message / call fails with the normal failed state; reason text "The partner account balance is low — contact support." App error `WA_PROVIDER_BALANCE_LOW` (402) where an HTTP request surfaces it. Superadmin notification `whatsapp.provider_balance_low` (Redis `SET NX EX 3600` key `wa:pinnacle:balance-alert`). `channel.pinnacle.lastBalanceErrorAt = now`. Channel stays `connected`.                                                                                                                                |
| D14 | Other Pinnacle errors | HTTP 401/403, or message matching `/invalid.*(api ?key\|token)\|unauthori[sz]ed/i` → `MetaApiError` with `tokenInvalid: true`. The existing code then moves the channel to `needs_reconnect`; for Pinnacle the reason is `provider_key_invalid` (see D17). Any other `status:"failed"` → `MetaApiError` code `provider_error` with Pinnacle's message (≤300 chars). 429 / 5xx → retry like Graph (same backoff), then `provider_error`.                                                                                                                                                                                                                              |
| D15 | Calling               | Calls go to `PINNACLE_VOICE_BASE_URL` (default `PINNACLE_BASE_URL`) with the same bodies as Meta. Settings and permissions use the same paths. If a calling method returns 404 or `provider_unsupported`, set `calling.status = 'unavailable'` and `calling.unavailableReason = 'provider_unsupported'` (new enum value).                                                                                                                                                                                                                                                                                                                                            |
| D16 | Calling readiness     | For Pinnacle channels, `callsWebhook` = "this channel's Pinnacle webhook is set" (`pinnacle.webhookSetAt != null`) and `appPermission` = "key valid at last check" (`pinnacle.keyCheckedAt` and status not `needs_reconnect`). There are no Meta app subscription / `debugToken` checks for them.                                                                                                                                                                                                                                                                                                                                                                    |
| D17 | Health / sync         | `syncChannel` gets a Pinnacle branch instead of `debugToken`. Steps, in order: (1) `getUserDetails(key)`: invalid → `needs_reconnect` reason `provider_key_invalid` ("The partner API key was rejected — replace it."); (2) the number is missing from the key's list → `needs_reconnect` reason `provider_number_missing`; (3) `getWebhook`: URL ≠ ours or header missing → re-`setWebhook` once (audit `whatsapp.managed_webhook_reset`, actor system) and, if still wrong, `action_needed` reason `provider_webhook_mismatch`; (4) `getWaba` + `getPhoneNumber` → same patches and restriction logic as Meta; (5) the D12 credit-line rule. `keyCheckedAt = now`. |
| D18 | Setup steps           | Pinnacle channels don't use `runSetup`'s `phone` / `subscribe` / `billing` / `register` steps. `subscription.status = 'subscribed'` is set at connect (the webhook is set). `registration.status = 'not_needed'` when `phone.status === 'CONNECTED'`. Otherwise registration stays `pending` with reason `register_at_partner` ("Finish registering this number in the partner panel."), and the next sync re-checks. `retry-setup` on a Pinnacle channel = `syncChannel`. The PIN `register` endpoint answers 409 `CONFLICT_INVALID_STATE` for Pinnacle channels.                                                                                                   |
| D19 | Uniqueness            | Existing partial unique index on `phoneNumberId`: adding a managed number that is active anywhere → 409 `WA_CHANNEL_EXISTS` (reuse the existing in-use code / message from connect). Re-adding a **disconnected** Pinnacle channel's number creates a new channel (same as Meta re-connect behaviour).                                                                                                                                                                                                                                                                                                                                                               |
| D20 | Disconnect            | For a Pinnacle channel: best-effort `setWebhook(key, phoneNumberId, '', {})`, then clear `tokenSealed` + `pinnacle.webhookSecretSealed`, then the normal disconnect transition, history and audit. Never `unsubscribeApp`. Nothing is changed in Pinnacle's panel.                                                                                                                                                                                                                                                                                                                                                                                                   |
| D21 | Coexistence           | `mode` always `cloud_api`. The coexistence retry endpoint answers 409 for Pinnacle channels.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| D22 | Pricing reconcile     | `reconcile.ts` skips Pinnacle channels (metric `wa_reconcile_skipped_provider`). Wallet charging itself is unchanged: our rate card, platform-pays.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| D23 | Env                   | `PINNACLE_ENABLED` (bool, default `false`). `PINNACLE_BASE_URL` (url, default `https://partnersv1.pinbot.ai`). `PINNACLE_VOICE_BASE_URL` (url, optional). `PINNACLE_TIMEOUT_MS` (int, default 15000, 2000–60000). Production + enabled: both URLs must be `https`, and `APP_URL` must be `https`. `PINNACLE_ENABLED` requires `WHATSAPP_ENABLED`.                                                                                                                                                                                                                                                                                                                    |
| D24 | Logging               | Never log the key, the secret or the webhook headers. Logs may carry `provider:'pinnacle'`, `keyLast4`, path template (no ids beyond phone number id), status, Pinnacle `code`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| D25 | Feature off           | When `PINNACLE_ENABLED=false`: admin routes answer 503 `WA_PROVIDER_NOT_CONFIGURED`; webhook route not mounted (404); existing Pinnacle channels can't send (`clientFor` 503). The superadmin UI hides the button (`/admin/whatsapp/status` gains `pinnacle: { enabled }`).                                                                                                                                                                                                                                                                                                                                                                                          |

## 4. Rules of engagement

1. No questions. Pick the option consistent with §3 and record it under "Deviations" in the sign-off.
2. Branch `feature/pinnacle-provider` from `main` in **both** repos. One commit per task per repo; Conventional Commit + `[PN]`; never a capitalised subject (commitlint). No push, no merge.
3. Secrets (API keys, webhook secrets, tokens) never appear in code, fixtures (use `pin_test_…` placeholders), logs, docs, commits or the report. Never read or print `.env` files.
4. Every query is scoped by `accountId`, except superadmin routes that load by id and then use `channel.accountId`.
5. Every new env var goes into `.env.example`, the README env table and the `env.ts` schema + cross-checks + `env.test.ts`.
6. Every new error code, audit action, notification type, WS event or sealed field goes into its registry, its `docs/conventions/*.md` row and the catalogue counts.
7. Per task, run lint + typecheck + only the touched / new test files. **Each full suite runs once, at the end (PN-T11), serially.**
8. Don't touch other projects or processes on the machine.

## 5. Resume safety

Run `git -C <repo> branch --show-current` and `git -C <repo> log --oneline -20` in both repos, then continue after the last `[PN]` commit. Tasks are idempotent: re-running a migration or a registry addition must not duplicate anything.

## 6. Tasks

### PN-T0 — Branch + baseline

1. Both repos: `git checkout main && git pull --ff-only` (read-only fetch is fine), then `git checkout -b feature/pinnacle-provider`.
2. Backend: `npm run lint && npm run typecheck`. Frontend: same. Record the baseline in the sign-off draft (`docs/phases/PINNACLE_SIGNOFF.md`, created now with the task table empty).

**Commit (backend):** `docs(whatsapp): start pinnacle provider sign-off [PN]`

### PN-T1 — Model, enums, migration, env

**Backend steps:**

1. `whatsapp-channel.model.ts`:
   - `WA_PROVIDERS` add `'pinnacle'`.
   - `CREDIT_LINE_STATUSES` add `'partner_pending'`, `'partner_active'`.
   - `WA_CALLING_UNAVAILABLE_REASONS` add `'provider_unsupported'`.
   - New subdoc type + schema `pinnacle` (default `null`):
     ```ts
     pinnacle: {
       webhookSecretSealed?: string | null; // select:false
       webhookUrl: string | null;
       webhookSetAt: Date | null;
       keyLast4: string | null;
       keyCheckedAt: Date | null;
       lastBalanceErrorAt: Date | null;
       addedBy: Types.ObjectId | null;
     } | null
     ```
   - Index `{ provider: 1, status: 1 }`.
2. Add `'+pinnacle.webhookSecretSealed'` to `SECRET_FIELDS` in `whatsapp.service.ts`, and to every place that selects `+tokenSealed` for Pinnacle work (webhook route, health).
3. `sealed-registry.ts`: entry `whatsappChannels.pinnacle.webhookSecretSealed`.
4. Status reasons (where reason codes / texts are defined, `channel-status.ts` + `channel-json.ts`), with texts:
   - `partner_credit_line_pending`
   - `provider_key_invalid`
   - `provider_number_missing`
   - `provider_webhook_mismatch`
   - `register_at_partner`
5. `meta-webhook-event.model.ts`: `source: { type: String, enum: ['meta','pinnacle'], default: 'meta' }`.
6. Migration `src/db/migrations/0028-pinnacle-provider.ts` (+ register in `index.ts`):
   - `updateMany({ pinnacle: { $exists: false } }, { $set: { pinnacle: null } })`;
   - create the new index;
   - idempotent `up`; `down` unsets the field and drops the index.
7. `src/config/env.ts`: the D23 vars with zod, defaults and cross-checks. `.env.example`, README env table, `env.test.ts` cases (defaults; production http rejected; enabled without WhatsApp rejected).

**VERIFY:** model / sealed-registry / migration / env tests.
**Commit:** `feat(whatsapp): pinnacle provider fields, migration and env [PN]`

### PN-T2 — Pinnacle client (real) + fake

**Backend steps:**

1. **Graph client refactor (no behaviour change for Meta):** add options to `GraphMetaClientOptions`:
   - `auth?: 'bearer' | 'apikey'` (default `'bearer'`): `apikey` sends header `apikey: <token>`, no `Authorization`;
   - `mapError?: (status: number, json: unknown) => MetaApiError | null` (called first; `null` → the existing Meta mapping);
   - `isFailureBody?: (json: unknown) => boolean`: a 200 response counts as an error when true;
   - `provider?: 'meta' | 'pinnacle'` for log fields.

   Existing graph client tests must stay green without edits.

2. **`src/core/meta/pinnacle.client.ts`:**
   ```ts
   export interface PinnacleUserNumber { wabaId: string; phoneNumberId: string; displayPhoneNumber: string }
   export interface PinnacleWebhook { url: string; headers: Record<string, string> }
   export interface PinnacleExtras {
     readonly provider: 'pinnacle';
     getUserDetails(key: string): Promise<PinnacleUserNumber[]>;
     setWebhook(key: string, phoneNumberId: string, url: string, headers: Record<string, string>): Promise<void>;
     getWebhook(key: string, phoneNumberId: string): Promise<PinnacleWebhook | null>;
   }
   export type PinnacleClient = MetaClient & PinnacleExtras;
   export interface PinnacleClientOptions { baseUrl: string; voiceBaseUrl?: string; timeoutMs: number; fetch?: typeof fetch; logger?: Logger; sleep?; random?; retries?; retryBaseMs? }
   export const createPinnacleClient = (o: PinnacleClientOptions): PinnacleClient
   ```
   - Builds two Graph cores: `main` (baseUrl, `graphVersion: 'v3'`, `auth: 'apikey'`) and `voice` (voiceBaseUrl ?? baseUrl), both with the Pinnacle `mapError` / `isFailureBody`.
   - `mediaHosts` = the host of `baseUrl`, so media downloads are allowed.
3. **Method matrix:**

   | Method                                                                                                                                                                                                                                                                            | Pinnacle behaviour                                                                                                                                     |
   | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | `sendMessage`, `markRead`, `uploadMedia`, `listTemplates`, `createTemplate`, `editTemplate`, `deleteTemplate`, `getWaba`, `blockUsers`, `unblockUsers`, `registerPhone`, `getPhoneSettings`, `updateCallingSettings`, `getCallPermissions`                                        | delegate to `main` (same Graph paths / bodies)                                                                                                         |
   | `listPhoneNumbers`, `getPhoneNumber`, `getBusinessProfile`, `updateBusinessProfile`                                                                                                                                                                                               | `main`, with the `business/` path prefix as in §0.2                                                                                                    |
   | `startCall`, `preAcceptCall`, `acceptCall`, `rejectCall`, `terminateCall`                                                                                                                                                                                                         | `voice` core, `POST {phoneid}/calls` (same bodies)                                                                                                     |
   | `getMediaUrl(token, mediaId, phoneNumberId)`                                                                                                                                                                                                                                      | `GET {mediaId}?phone_number_id=`                                                                                                                       |
   | `downloadMedia(token, url, opts)`                                                                                                                                                                                                                                                 | if `url` is a Pinnacle media id / URL from `getMediaUrl`, use `POST downloadMedia/{mediaId}?phone_number_id=` (bytes, keep the size cap + mime checks) |
   | `uploadExample(token, file)`, `uploadProfilePhoto(token, bytes, mime)`                                                                                                                                                                                                            | `POST app/uploads?file_length&file_type` → `POST {sessionId}` with bytes, header `file_offset: 0` → handle `h`                                         |
   | `exchangeCode`, `debugToken`, `listOwnedWabas`, `listBusinessesWithWabas`, `subscribeApp`, `unsubscribeApp`, `getAppSubscriptions`, `getTokenOwner`, `assignSystemUser`, `attachCreditLine`, `getAllocation`, `requestCoexistenceSync`, `getPricingAnalytics`, `getCallAnalytics` | throw `MetaApiError({ code: 'provider_unsupported', message: '<method> is not available for managed numbers' })`                                       |
   | `getUserDetails`                                                                                                                                                                                                                                                                  | `GET getuserdetails` → map `data[]`; `status != SUCCESS` → error mapping                                                                               |
   | `setWebhook`                                                                                                                                                                                                                                                                      | `POST {phoneNumberId}/setwebhook` `{ webhook_url, headers }`; success when `status` ~ `/success/i`                                                     |
   | `getWebhook`                                                                                                                                                                                                                                                                      | `GET {phoneNumberId}/getwebhook` → `{ url, headers }` or `null` if empty                                                                               |

   Every Graph method in `MetaClient` must appear in this matrix. A unit test enumerates the client's keys against `MetaClient`'s keys, so no method can be silently missed.

4. **Error mapping (D13 / D14):**
   - helper `pinnacleError(status, json)` handling Meta-shaped `{error}` (existing parser), Pinnacle `{code,status:'failed',message}`, HTML or empty bodies;
   - add the new codes `provider_balance_low`, `provider_error`, `provider_unsupported` to the `MetaApiError` code union / `META_ERROR_CODES` and the app-error mapping (`metaApiError(err)`) → `WA_PROVIDER_BALANCE_LOW` (402), `WA_PROVIDER_ERROR` (502), `WA_PROVIDER_UNSUPPORTED` (422).
5. **`src/core/meta/fake-pinnacle.ts`:** `createFakePinnacleClient(fakeMeta, redis, prefix?)`, implementing D5:
   - `getUserDetails('pin_test_…')` returns the fake identities created through the fake Meta client's helper. Add a helper to seed one: `seedFakeManagedNumber({ wabaId, phoneNumberId, display })` used by tests and the dev simulator.
   - `setWebhook` / `getWebhook` are stored in Redis.
   - `pin_low_…` → `provider_balance_low` on `sendMessage` / `startCall`.
   - All other methods delegate to the fake Meta client, so status webhooks, template review and calls simulate the same way.
   - Fake events are delivered to the **Pinnacle** webhook path for Pinnacle channels; the fake's event emitter takes a `targetFor(phoneNumberId)` hook.
6. **`src/core/meta/index.ts`:** `createPinnacleFromEnv(env, deps, fakeMeta?)`: `null` when `!PINNACLE_ENABLED`; the fake when `META_PROVIDER === 'fake'`; else real.
7. **`context.ts`:**
   - `WhatsAppContext.pinnacle?: PinnacleClient | null`;
   - `clientFor(ctx, channel)` (D7);
   - `isPinnacle(channel)`.
8. **`server.ts`:** wire `pinnacle` into the WhatsApp context (worker and API process both).

**Tests (new `src/core/meta/pinnacle.client.test.ts`, stub `fetch`):**

- the key-coverage test (every `MetaClient` key handled);
- each delegated method hits `https://partnersv1.pinbot.ai/v3/<path>` with header `apikey` and no `Authorization`;
- `business/` paths;
- voice methods hit the voice base;
- media URL / download / upload two-step;
- errors: Meta-shaped, `{status:'failed','Insufficient Balance'}` with HTTP 200 → `provider_balance_low`, 401 → `tokenInvalid`, other failed → `provider_error`, 503 retried then error;
- unsupported methods throw;
- the key never appears in logged objects (spy logger);
- `fake-pinnacle.test.ts` for the D5 behaviours.

**Commit:** `feat(meta): pinnacle api client and fake [PN]`

### PN-T3 — Per-channel client routing (refactor)

**Backend steps:**

1. Replace every call site in the §0.3 table with `clientFor(ctx, channel)` (or the inbox / templates equivalent `clientFor(ix.wa, channel)` / `clientFor(tx.wa, channel)`). Where only ids are at hand, the channel is already loaded nearby. Use that; never add an extra DB read in a hot loop (the send job already has `channel`).
2. `whatsapp.service.ts`: replace `const { meta, redis } = ctx` usage on channel paths with `clientFor(ctx, ch)`. ES-only paths (`connect` with code, `resolveWaba`) keep `ctx.meta`.
3. `readiness.ts`: deps get `clientFor`; Pinnacle branch per D16.
4. `reconcile.ts`: skip `provider === 'pinnacle'` (D22).
5. `coexistence.ts`, `billing-setup.ts`: early return / guard for Pinnacle (they must never run for one).
6. **Guard test** `src/core/meta/routing.guard.test.ts`: scan `src/modules/**/*.ts` (not tests) for `\.meta\.(sendMessage|markRead|uploadMedia|getMediaUrl|downloadMedia|uploadExample|createTemplate|editTemplate|deleteTemplate|listTemplates|getWaba|listPhoneNumbers|getPhoneNumber|registerPhone|blockUsers|unblockUsers|getBusinessProfile|updateBusinessProfile|uploadProfilePhoto|getPhoneSettings|updateCallingSettings|getCallPermissions|startCall|preAcceptCall|acceptCall|rejectCall|terminateCall)\(` and also `\bmeta\.(…same…)\(` (destructured). Allow-list: the ES connect path lines in `whatsapp.service.ts`, marked `// meta-only: embedded signup`. The test fails on any new direct call.

**Tests:**

- existing inbox / templates / whatsapp / calling suites, run only those folders, stay green;
- new `tests/whatsapp/pinnacle-routing.test.ts`: a `pinnacle` channel's send, mark read, block, media download, template create / list, profile update, calling settings, permission lookup and start / accept / terminate call go to `ctx.pinnacle` (spy). A `meta` channel's go to `ctx.meta`.

**Commit:** `refactor(whatsapp): route graph calls per channel provider [PN]`

### PN-T4 — Pinnacle webhook

**Backend steps:**

1. **`webhooks.service.ts`:**
   - extract `verifyMetaSignature`;
   - `parseEnvelope(raw)` (JSON + `webhookEnvelopeSchema`);
   - `ingestEnvelope(ctx, jobs, envelope, { source, channel? })`. Keep the exact current metrics / returns for the Meta route.
   - In `ingestEnvelope`, apply D10 filtering:
     - Meta source: one query for the active Pinnacle channels among the envelope's phone ids.
     - Pinnacle source: compare with the bound channel.
   - Store `source` on events.
2. **`src/modules/whatsapp/pinnacle-webhooks.routes.ts`:** `createPinnacleWebhooksRouter({ ctx, jobs })`:
   - `GET /:channelId` → `200 text/plain ok`.
   - `POST /:channelId`:
     1. `ObjectId` check → 404 `NOT_FOUND`.
     2. Load channel `+pinnacle.webhookSecretSealed`; missing / not pinnacle / disconnected → 404.
     3. Secret header missing or wrong (timing-safe, equal-length buffers) → 403 `PINNACLE_WEBHOOK_FORBIDDEN` + metric `pinnacle_webhook_forbidden`.
     4. `parseEnvelope` (400 / validation like Meta).
     5. `ingestEnvelope(…, { source: 'pinnacle', channel })`.
     6. Reply `ok(res, receipt)` fast.
3. **`src/app.ts`:** mount the raw-body parser for `/api/v1/webhooks/pinnacle` (same limit) **before** the JSON parser. Mount the router at `/api/v1/webhooks/pinnacle` when `WHATSAPP_ENABLED && PINNACLE_ENABLED`, in `routes.ts` next to the Meta webhook router.
4. Rate limit: reuse the public webhook limiter used for the Meta route, keyed per `channelId`.
5. `channel.webhook.lastEventAt` / `lastField`: the existing processor updates them. Confirm it does for Pinnacle events (same code path).
6. OpenAPI: document both paths as public, under tag `webhooks` (no auth scheme; header param `x-cell-webhook-secret`).

**Tests (`tests/whatsapp/pinnacle-webhook.test.ts`):**

- good secret + `messages` → message in inbox;
- `statuses` → delivery receipt;
- `message_template_status_update` → template status;
- `calls` connect / terminate → call handling via the fast path;
- wrong / missing secret → 403, nothing stored;
- unknown / disconnected channel → 404;
- foreign `phone_number_id` change dropped, others kept;
- the same payload via the Meta route and the Pinnacle route → stored once (dedupe);
- a Meta-route event for a Pinnacle number → dropped with metric;
- body > limit → 413;
- GET → 200.

**Commit:** `feat(whatsapp): pinnacle webhook endpoint [PN]`

### PN-T5 — "Add managed number" (backend)

**Backend steps:**

1. **Schemas (`whatsapp.schema.ts`):**
   ```ts
   ManagedNumberBody = z.strictObject({
     label: z.string().trim().min(1).max(60),
     wabaId: MetaId,
     phoneNumberId: MetaId,
     apiKey: z.string().trim().min(8).max(512), // never echoed
     creditLine: z.enum(['partner_pending', 'partner_active']),
   });
   ManagedKeyBody = z.strictObject({ apiKey: same });
   ManagedCreditLineBody = z.strictObject({
     status: z.enum(['partner_pending', 'partner_active']),
   });
   ```
2. **Service `src/modules/whatsapp/managed-numbers.service.ts`** (uses `createWhatsAppService` internals through a new exported `connectManaged` in `whatsapp.service.ts`, to reuse `withLock`, `activeElsewhere`, `wabaPatch`, `phonePatch`, `transition`, `persist`, audits, `hooks.onConnected`):

   **`connectManaged({ accountId, actor, label, wabaId, phoneNumberId, apiKey, creditLine })`:**
   1. Guards:
      - `PINNACLE_ENABLED` and `ctx.pinnacle`, else 503 `WA_PROVIDER_NOT_CONFIGURED`;
      - account active (reuse `customerAccount` from manual connect);
      - `withLock(phoneNumberId)`.
   2. `ctx.pinnacle.getUserDetails(apiKey)`:
      - `tokenInvalid` → 422 `PINNACLE_KEY_INVALID`;
      - no entry with that `phone_number_id` + `wabaId` → 422 `PINNACLE_NUMBER_NOT_ON_KEY`.
   3. `activeElsewhere(phoneNumberId)` → 409 (D19).
   4. `getWaba(apiKey, wabaId)` + `getPhoneNumber(apiKey, phoneNumberId)` through `ctx.pinnacle`.
   5. Create the channel doc (status `connecting`) with:
      - `provider:'pinnacle'`, `mode:'cloud_api'`, `label`;
      - `wabaPatch` + `phonePatch` + `phoneE164`;
      - `tokenSealed: sealSecret(apiKey)`, `tokenType:'pinnacle_api_key'`, `tokenScopes:[]`, `tokenCheckedAt: now`;
      - `metaUserId:null`, `metaPayer:'platform'`;
      - `creditLine:{ status: creditLine, allocationConfigId:null, error:null, at:now }`;
      - `subscription:{ status:'subscribed', error:null, at:now }`;
      - `registration` per D18;
      - `pinnacle:{ webhookSecretSealed: seal(secret), webhookUrl: null, webhookSetAt: null, keyLast4, keyCheckedAt: now, lastBalanceErrorAt: null, addedBy: actor.userId }`;
      - `connectedBy`, `connectedAt`.
   6. `url = ${APP_URL}/api/v1/webhooks/pinnacle/${channel._id}`, then `setWebhook(apiKey, phoneNumberId, url, { 'x-cell-webhook-secret': secret })`, then `getWebhook` must return `url` and the header. Otherwise **roll back**: delete the channel doc, no audit, and return 502 `PINNACLE_WEBHOOK_NOT_SET` with Pinnacle's message.
   7. Calling: `getPhoneSettings` → the same mapping as the Meta sync (`calling.status`); on `provider_unsupported` / 404 → `unavailable` + `provider_unsupported`.
   8. Final status:
      - `partner_pending` → `action_needed` + `partner_credit_line_pending`;
      - registration pending → `action_needed` + `register_at_partner`;
      - restricted phone status → `restricted`;
      - else `connected`.

      Use `transition` (history entry, WS `whatsapp.channel`, notifications as for Meta connects).

   9. Audit `whatsapp.managed_number_added`. Metadata: `{ wabaId, phoneLast4, keyLast4, creditLine, byAdmin: true }`, never the key / secret / url secret. Call `hooks.onConnected(channel)` like other connects (inbox / calling defaults).
   10. Return `channelListItem(channel)`.

   **`replaceManagedKey(channelId, apiKey, actor)`:**
   - same key check;
   - reseal;
   - `keyLast4`;
   - re-`setWebhook` with the existing secret;
   - `syncChannel`;
   - audit `whatsapp.managed_key_replaced` (`keyLast4` old → new).

   **`resetManagedWebhook(channelId, actor)`:**
   - new secret;
   - `setWebhook` + `getWebhook` check;
   - save;
   - audit `whatsapp.managed_webhook_reset`.

   **`setManagedCreditLine(channelId, status, actor)`:**
   - update `creditLine`;
   - `syncChannel` (moves status per D12);
   - audit `whatsapp.credit_line_updated` `{ from, to }`.

   All three:
   - load by id (superadmin) → 404 if not found or `provider !== 'pinnacle'` (409 `CONFLICT_INVALID_STATE` if Meta);
   - disconnected → 409;
   - `withLock`.

3. **Routes (`whatsapp-admin.routes.ts`)**, all superadmin + `blockWhenImpersonating` (same as manual connect), each behind a `needPinnacle()` that gives 503 when off:
   - `POST /accounts/:id/whatsapp/managed-numbers` (body `ManagedNumberBody`) → 201;
   - `POST /whatsapp/channels/:id/managed/api-key` (`ManagedKeyBody`);
   - `POST /whatsapp/channels/:id/managed/webhook`;
   - `POST /whatsapp/channels/:id/managed/credit-line` (`ManagedCreditLineBody`).
4. **Existing endpoints on a Pinnacle channel:**
   - `sync` → Pinnacle branch;
   - `retry-setup` → `syncChannel`;
   - `register` (PIN) → 409;
   - `coexistence-sync` → 409;
   - `disconnect` / admin disconnect → D20.
5. **JSON:**
   - `channel-json.ts`: `channelListItem` gains `provider` (if not already exposed) and `managed: boolean`.
   - The superadmin channel view (`whatsapp-admin.service` list for account detail) gains `pinnacle: { keyLast4, webhookUrl, webhookSetAt, keyCheckedAt, lastBalanceErrorAt } | null`. Owners' views never include it.
   - `GET /admin/whatsapp/status` gains `pinnacle: { enabled: boolean, baseUrl: string, voiceBaseUrl: string }` (urls are not secret).
6. **Registries:**
   - error codes: `WA_PROVIDER_NOT_CONFIGURED` 503, `WA_PROVIDER_UNSUPPORTED` 422, `WA_PROVIDER_ERROR` 502, `WA_PROVIDER_BALANCE_LOW` 402, `PINNACLE_KEY_INVALID` 422, `PINNACLE_NUMBER_NOT_ON_KEY` 422, `PINNACLE_WEBHOOK_NOT_SET` 502, `PINNACLE_WEBHOOK_FORBIDDEN` 403;
   - audit: `whatsapp.managed_number_added`, `whatsapp.managed_key_replaced`, `whatsapp.managed_webhook_reset`, `whatsapp.credit_line_updated`;
   - `docs/conventions/error-codes.md`, `audit.md` rows; catalogue counts.
7. OpenAPI (`whatsapp.openapi.ts`, admin tag) for the 4 routes + status change; `gen:openapi`.

**Tests (`tests/whatsapp/managed-numbers.test.ts`, fake Pinnacle):**

- happy path `partner_active` → `connected`, webhook stored, key sealed (raw DB value ≠ key), audit without key, WS emitted;
- `partner_pending` → `action_needed partner_credit_line_pending`, and an inbox send is refused like any `action_needed` channel;
- `pin_bad_` → 422 `PINNACLE_KEY_INVALID`;
- wrong phone → 422 `PINNACLE_NUMBER_NOT_ON_KEY`;
- number active on another channel → 409;
- `setWebhook` failure / echo mismatch → 502 and **no channel left behind**;
- owner / admin / reseller → 403;
- impersonating superadmin → blocked;
- `PINNACLE_ENABLED=false` → 503;
- replace key (new last4, webhook re-set);
- reset webhook (secret changes; old secret now 403 on the webhook);
- credit line pending → active → `connected`;
- disconnect → webhook cleared, key wiped, status `disconnected`, history entry;
- register / coexistence → 409.

**Commit:** `feat(whatsapp): superadmin managed numbers over pinnacle [PN]`

### PN-T6 — Billing state & balance errors

**Backend steps:**

1. **`whatsapp.service.ts` status calculation:** the D12 rule. Never let `setupBilling` run for Pinnacle; guard in `runSetup` and in `billing-setup.ts`.
2. **Balance handling, new `src/modules/whatsapp/provider-alerts.ts#recordPinnacleBalanceLow(channel)`:**
   - set `pinnacle.lastBalanceErrorAt`;
   - `SET NX EX 3600 wa:pinnacle:balance-alert` → `notifyPlatform({ type: 'whatsapp.provider_balance_low', title: 'Partner WhatsApp balance is low', body: 'Messages and calls on managed numbers are failing — top up the partner wallet.' })`.

   Call it where a `provider_balance_low` `MetaApiError` is caught:
   - the inbox send job (message → failed, `error.code = 'provider_balance_low'`, reason text per D13; **no retries** for this code);
   - campaign sends (same job);
   - template create (surface `WA_PROVIDER_BALANCE_LOW`);
   - call start / accept (call ends failed with reason `provider_balance_low`; the wallet hold is released as for any failed start).

3. Add notification type `whatsapp.provider_balance_low` to `NOTIFICATION_TYPES` (superadmins), with its label in the notification texts.
4. The wallet is unchanged: Pinnacle channels are `metaPayer:'platform'`, so the existing platform rate card applies. Assert this in a test.

**Tests (`tests/whatsapp/pinnacle-billing.test.ts`):**

- `pin_low_` send → message failed with that reason, exactly one notification across 3 failures within the hour, `lastBalanceErrorAt` set;
- no retry scheduled;
- campaign send fails the same way without stopping other channels' contacts;
- call start → failed with the hold released;
- platform-pays charge applied on a successful Pinnacle send.

**Commit:** `feat(whatsapp): pinnacle credit line state and balance errors [PN]`

### PN-T7 — WhatsApp calling over Pinnacle

**Backend steps:**

1. Confirm through tests that all of `calls.service.ts` (outbound `startCall`, inbound `preAcceptCall` / `acceptCall`, `rejectCall`, both `terminateCall`s), `settings.service.ts`, `permissions.service.ts` and `bulk-permissions.ts` (permission request messages go via `sendMessage`) use `clientFor` (PN-T3). Nothing else in calling may branch on the provider, except readiness (D16) and D15.
2. `settings.service.ts`: on `provider_unsupported` / 404 from `updateCallingSettings` or `getPhoneSettings`, set `calling.status='unavailable'`, `unavailableReason='provider_unsupported'`, and answer 422 `WA_PROVIDER_UNSUPPORTED` to the user action.
3. `readiness.ts`: D16 branch and readiness item texts ("Partner webhook set", "Partner API key valid").
4. Team calling, team → AI, line-busy, bulk campaign calls: no code change expected. Prove it with tests on a Pinnacle channel.

**Tests (`tests/calls-wa/pinnacle-calls.test.ts`, fake Pinnacle, events delivered via the Pinnacle webhook):**

- inbound call → AI answers (`pre_accept` + `accept` on `ctx.pinnacle`) → terminate;
- inbound team-then-AI → nobody answers → AI;
- outbound AI call: `connect` offer → `connect` webhook with answer → media starts → terminate;
- team campaign `next` on a Pinnacle WhatsApp line;
- calling settings update → Pinnacle; unsupported → `unavailable provider_unsupported`;
- readiness for a Pinnacle channel shows webhook / key items, never calls `getAppSubscriptions` / `debugToken`;
- `pin_low_` on `startCall` → failed + alert.

**Commit:** `feat(whatsapp-calling): calls over pinnacle [PN]`

### PN-T8 — Health & sync

**Backend steps:**

1. `syncChannel`: the Pinnacle branch per D17. Use `clientFor`; `getUserDetails` / `getWebhook` / `setWebhook` via `ctx.pinnacle`. Rebuild the expected URL from `APP_URL` + channel id; the header must match the opened secret.
2. `health.ts`: select `+pinnacle.webhookSecretSealed` too. The rest is unchanged (it calls `syncChannel`).
3. `webhook-handlers.ts#resync`: same select.
4. Transition notifications reuse the existing ones (owner sees "needs attention" / "reconnect"); the reason texts come from PN-T1.

**Tests (`tests/whatsapp/pinnacle-health.test.ts`):**

- key now invalid → `needs_reconnect provider_key_invalid`;
- number removed from key → `provider_number_missing`;
- webhook changed at the partner → re-set once (audit actor system) → `connected`;
- re-set fails → `action_needed provider_webhook_mismatch`;
- recovered → `connected`;
- restricted phone status → `restricted`;
- credit line pending stays `action_needed`;
- the health pass handles a mix of Meta and Pinnacle channels; one failing channel doesn't stop the pass.

**Commit:** `feat(whatsapp): health and sync for pinnacle numbers [PN]`

### PN-T9 — Dev simulator & docs for operators (backend)

1. Dev simulator (`dev-simulator.routes.ts`, fake only): action "Seed a managed number" (calls `seedFakeManagedNumber`, returns a `pin_test_…` key) so the flow can be clicked through locally.
2. `docs/whatsapp/pinnacle.md` (new):
   - what a managed number is;
   - **runbook** "Add a managed number": panel screens → fields → our dialog → what to check;
   - credit line (panel request ↔ our toggle);
   - balance alerts;
   - replace key / reset webhook;
   - disconnect;
   - what is not supported;
   - troubleshooting table (reason codes → what to do);
   - open items (§8).
3. `docs/api/whatsapp.md` (or the existing admin API doc): the 4 admin routes + webhook. `docs/conventions/websocket.md` unchanged unless a WS event was added.
4. `gen:openapi`, `gen:postman`, `gen:guides` (if the guides list admin routes), `docs:audit` (0 problems), `openapi:check`.

**Commit:** `docs(whatsapp): pinnacle managed numbers runbook and api [PN]`

### PN-T10 — Frontend

**Frontend steps:**

1. `npm run gen:api` (backend OpenAPI from PN-T9).
2. **`src/services/api/admin-whatsapp.ts`:**
   - `addManagedNumber(accountId, body)`;
   - `replaceManagedKey(channelId, apiKey)`;
   - `resetManagedWebhook(channelId)`;
   - `setManagedCreditLine(channelId, status)`;
   - types `ManagedNumberInput`;
   - status type gains `pinnacle.enabled`.
3. **`src/features/admin/WhatsAppCard.tsx`:**
   - Button **"Add managed number (Pinnacle)"** next to "Manual connect", visible only when `status.pinnacle.enabled`.
   - **`ManagedNumberDialog`** (new file `src/features/admin/ManagedNumberDialog.tsx`):
     - Fields:
       - Label;
       - WABA ID (digits);
       - Phone number ID (digits);
       - API key (password field with show / hide, `autoComplete="off"`);
       - "Credit line at the partner": radio _Requested_ (→ `partner_pending`) / _Active_ (→ `partner_active`).
     - Helper text: "Copy these from the partner panel: Whatsapp → Manage Accounts (WABA ID, phone number ID) and Admin → Manage API Keys (API key)."
     - Client validation: required fields, digits only, key ≥ 8.
     - Submit shows "Checking the key and setting the webhook…".
     - Success: closes, toast "Managed number added", list refreshes (invalidate the account WhatsApp query).
     - Server errors mapped to friendly text:
       - `PINNACLE_KEY_INVALID`: "The API key was rejected by the partner."
       - `PINNACLE_NUMBER_NOT_ON_KEY`: "This API key doesn't include that phone number ID / WABA ID."
       - `PINNACLE_WEBHOOK_NOT_SET`: "The partner didn't accept our webhook — try again or contact the partner."
       - 409 in use: "This number is already connected on the platform."
       - `WA_PROVIDER_NOT_CONFIGURED`: "Managed numbers are turned off on this server."
     - The key field is cleared on close / error-free submit and never stored in state after submit.
   - **Per channel row when `provider === 'pinnacle'`:**
     - chip "Managed";
     - text "Key ••••{keyLast4} · Webhook set {relative time} · Last checked {relative}";
     - warning text if `lastBalanceErrorAt` is within 24 h ("Partner balance low — {time}").
   - **Actions:**
     - **Replace API key** (small dialog, password field);
     - **Reset webhook** (confirm);
     - **Credit line:** select Requested / Active (confirm when switching to Active: "Only switch to Active after the partner approved the credit line in their panel.").
   - Texts go in `src/features/admin/whatsapp-texts.ts`.
4. **Customer side:**
   - `ChannelCard.tsx` / `ChannelDrawer.tsx`: chip "Managed" when `managed`.
   - Hide **Register (PIN)**, **Coexistence sync** and **Reconnect via Facebook** actions for managed numbers. Show "Contact support" instead for `needs_reconnect` reasons `provider_*`.
   - `texts.ts` / `labels.ts`: owner-facing texts for the new reasons:
     - `partner_credit_line_pending`: "Billing for this number is being activated. We'll let you know when it's ready."
     - `provider_key_invalid` / `provider_number_missing` / `provider_webhook_mismatch`: "This number needs attention from support."
     - `register_at_partner`: "This number is being registered. It will be ready soon."
     - calling unavailable `provider_unsupported`: "WhatsApp calling isn't available on this number yet."
5. Error-code → message map: the new codes (`WA_PROVIDER_BALANCE_LOW`: "The WhatsApp partner balance is low — contact support."; `WA_PROVIDER_UNSUPPORTED`; `WA_PROVIDER_ERROR`).
6. Fixtures `src/test/whatsapp.ts`:
   - channel fields `provider`, `managed`, `pinnacle: null`;
   - admin status `pinnacle: { enabled: false, … }`;
   - update every fixture that builds these objects (grep `configId:` and `provider:` in `src/test` and test files).

**Tests:**

- `src/features/admin/managed-number.test.tsx`:
  - button hidden when disabled;
  - dialog validation;
  - submit happy path (API called with body; the key isn't rendered afterwards);
  - each server error message;
  - row shows "Managed", key last4, webhook time, balance warning;
  - replace key, reset webhook, credit-line switch (with confirm).
- `src/features/whatsapp/numbers/managed.test.tsx`: owner sees "Managed", no PIN / coexistence / Facebook-reconnect actions, the right reason texts.
- Run lint, typecheck, build and the touched test files.

**Commit (frontend):** `feat(admin): add managed whatsapp numbers [PN]`

### PN-T11 — Full checks & sign-off

1. Backend: `npm run lint`, `npm run typecheck`, `npm run build`, `npm run openapi:check`, `npm run docs:audit`, then **one** full test run, serial (`npm test -- --no-file-parallelism` or the repo's serial script). Fix anything caused by this run; list pre-existing failures as such (known: WhatsApp campaign recurrence, `tts-cache` purge).
2. Frontend: lint, typecheck, build, **one** full test run. If the machine is overloaded and unrelated files time out, record them and rerun only those.
3. `docs/phases/PINNACLE_SIGNOFF.md`:
   - task table (PN-T0…T11 ✅ / ⚠️ / ❌ + one line);
   - deviations from §3;
   - checks with numbers;
   - §8 open items;
   - §9 live checks still open.
4. Update `CHANGELOG.md` (both repos) if the repo keeps one.

**Commit (backend):** `docs(whatsapp): pinnacle provider sign-off [PN-DONE]`. **Commit (frontend)** if anything changed: `chore(admin): pinnacle sign-off fixes [PN-DONE]`.

## 7. Tests required (checklist — all must exist)

| Area                                                                              | File                                             |
| --------------------------------------------------------------------------------- | ------------------------------------------------ |
| Client paths, auth, errors, coverage of every `MetaClient` method, no key in logs | `src/core/meta/pinnacle.client.test.ts`          |
| Fake Pinnacle behaviours (`pin_test_`, `pin_bad_`, `pin_low_`, webhook store)     | `src/core/meta/fake-pinnacle.test.ts`            |
| No direct `ctx.meta` channel calls                                                | `src/core/meta/routing.guard.test.ts`            |
| Per-channel routing of every call site                                            | `tests/whatsapp/pinnacle-routing.test.ts`        |
| Webhook auth, ingest, filtering, dedupe, limits                                   | `tests/whatsapp/pinnacle-webhook.test.ts`        |
| Add / replace key / reset webhook / credit line / disconnect / guards             | `tests/whatsapp/managed-numbers.test.ts`         |
| Billing state, balance alert throttle, no retry, wallet                           | `tests/whatsapp/pinnacle-billing.test.ts`        |
| Calling inbound / outbound / team / settings / readiness                          | `tests/calls-wa/pinnacle-calls.test.ts`          |
| Health transitions                                                                | `tests/whatsapp/pinnacle-health.test.ts`         |
| Env, migration, sealed registry, catalogue counts                                 | existing test files updated                      |
| Admin UI                                                                          | `src/features/admin/managed-number.test.tsx`     |
| Owner UI                                                                          | `src/features/whatsapp/numbers/managed.test.tsx` |

## 8. Open items to confirm with Pinnacle (record in sign-off; code does not wait)

1. **Production host of the Voice API.** The doc shows only a test load balancer. Value for `PINNACLE_VOICE_BASE_URL`.
2. Are `calls` webhooks (connect with SDP answer, terminate) relayed by `setwebhook` unchanged and quickly (< 1 s)?
3. Is SDP passthrough supported for both business-initiated `connect` (offer) and user-initiated `pre_accept` / `accept` (answer)?
4. Exact paths for phone number / business profile (`/v3/business/{id}` vs `/v3/{id}`), block users and media delete. The client follows §0.2; adjust after confirmation.
5. Rate limits per key / number; recommended retry policy.
6. Does `setwebhook` override the panel's "Multiple Callback" setting, and is it allowed for numbers onboarded through their ES?
7. Callback source IPs (optional allow-list) and whether they can sign callbacks.
8. Pricing / conversation analytics for reconciliation (later phase).

## 9. Live checks (owner's explicit permission needed — not part of this run)

1. Add one real managed number with credit line Active. Send one template and one session message, receive a reply, and see delivered / read statuses arrive on our webhook.
2. One inbound WhatsApp call answered by AI, and one outbound AI call to the owner's own number.
3. Replace the key with a wrong one → health marks `provider_key_invalid`; restore → `connected`.
4. Change the webhook in Pinnacle's panel → the next health pass re-sets it.

## 10. Final report format (Hinglish, short)

1. Per task ✅ / ⚠️ / ❌ + one line.
2. Commits (`git log --oneline`), both repos.
3. Test numbers (backend / frontend), new vs pre-existing failures.
4. Deviations from §3.
5. Open items (§8) + live checks (§9) still pending.
