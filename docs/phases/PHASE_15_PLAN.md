# Phase 15 — Integrations, Public API & Webhooks (Detailed Plan)

**Status:** Draft — 2026-10-29 · **Branch:** `feature/phase-15-integrations` (both repos, from `main` = backend `acf5d8b`, frontend `a6c9533`; the frontend branch is created at the first frontend task) · **Overview:** [BUILD_PLAN_V2.md](../plans/BUILD_PLAN_V2.md) §4 Phase 15 · **Previous:** [PHASE_14_PLAN.md](PHASE_14_PLAN.md) · [sign-off](PHASE_14_SIGNOFF.md)

> **Live context:** the app now runs for the client at `https://wa.notifynow.in` (brand **NotifyNow**, NotifyNow Private Limited) on the client's own server and database; Meta App Review is being prepared in parallel (`docs/meta/APP_REVIEW.md`). Phase 15 is code-only in our repos; the client deploys `main` when the owner says so. Rule: a production fix lands on `main` first (own `fix(...)` commit), then `main` is **merged** into the phase branch (no rebase of a pushed branch).

---

## 0. Is phase ka goal

Phase 15 ke end tak:

- **Public REST API** (API keys, Phase 2): bahar ka system (client ka LMS / CRM / script) **call trigger** kare (phone dry-run / web / WhatsApp), **WhatsApp message / template** bheje, **campaign** banaye / chalaye / status dekhe, **contacts** push / update kare, aur **call / message result** fetch kare — sab ek hi `/api/v1/...` paths par, `X-API-Key` + scopes se.
- **Outbound webhooks** (signed, retries, delivery logs, replay, test button): `call.started`, `call.completed`, `call.insights.ready`, `campaign.completed`, `whatsapp.message.received`, `whatsapp.message.status`, `whatsapp.call.*`, `contact.opted_out` — bahar ke system ko result khud pahunche.
- **Call ke baad WhatsApp** (apne channel se, AutoChatix ki zaroorat nahi): flow ka **"Send WhatsApp"** step jo aaj sirf queue karta hai, ab sach mein template bheje; aur **outcome rules** ("disposition = promise_to_pay → payment reminder template, kal 10 baje") — window / opt-out / DND / wallet / marketing-limit rules ke saath.
- **Google Sheets sync** (contacts in, results out) + **CRM-ready** (webhooks + API, Zapier / Make / n8n se juda ja sake) — native CRM connectors baad mein.
- **Developer experience:** API docs page (public, versioned), **API keys page** mein scopes + per-key usage, **webhook test tool** (sample event bhejo, response dekho), **API request log** (last 7 days, per key), aur client payment API ka **mock** (`/mock/payment-link`) jisse integration test ho sake.

**Done when:**

- Ek bahar ka script (sirf API key ke saath) ek contact create kare → us par **call trigger** kare → call complete hone par uske endpoint par **`call.completed` webhook** (signed) aaye jismein outcome, duration, cost, insights summary ho → wahi script **`GET /calls/:id`** se result fetch kar le. Same for **WhatsApp template send** → **`whatsapp.message.status`** webhooks (sent → delivered → read).
- Flow ka "Send WhatsApp" step aur ek outcome rule, call ke baad **customer ke WhatsApp par template** bhejein (fake Meta par E2E; ledger charge; window / opt-out / DND respected), aur chat inbox mein dikhe.
- Webhook endpoint down ho to **retries** (1 m, 5 m, 30 m, 2 h, 12 h) chalein, delivery log dikhe, **replay** ho sake, 5 baar lagatar fail hone par endpoint **disable** + owner ko notification; signature verify karne ka sample code (Node, Python, PHP) docs mein ho aur test mein verify ho.
- Google Sheet se contacts import ho (scheduled), aur call results ek sheet mein append hon (Apps Script receiver template ke through, ya OAuth — §7 #4).
- Public API ke har route par: scopes enforced, tenant isolation, idempotency (`Idempotency-Key`), per-key rate limits, OpenAPI + docs page, error envelope same as dashboard API.
- Poora verify (lint, types, unit + integration, coverage gates) + Playwright suite do baar green + ek "external client" integration test (real HTTP server receiving webhooks, local only).

### Phase 15 mein kya NAHI hoga

| Kaam                                                                      | Kaunse phase mein                                                      |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Native CRM connectors (Salesforce, Zoho, HubSpot, LeadSquared) with OAuth | Later (§7 #5) — webhooks + API cover them via Zapier / Make / n8n      |
| OAuth 2.0 for third-party apps (marketplace, "Sign in with NotifyNow")    | Later                                                                  |
| Real SMS sending (DLT registration, SMS gateway)                          | Phase 18 with SIP / telephony (§7 #8) — `send_sms` stays "queued only" |
| Bulk WhatsApp campaigns (marketing broadcasts)                            | Phase 20                                                               |
| Security audit, pen test, load test at scale                              | Phase 16                                                               |
| SDKs published to npm / PyPI                                              | Later — Phase 15 gives code samples + OpenAPI (clients can generate)   |
| GraphQL / streaming API                                                   | Not planned                                                            |

### Conventions to follow

Same as earlier phases: [api.md](../conventions/api.md) (§12 public API, §14 webhooks preview — this phase makes them real), [security.md](../conventions/security.md), [secrets.md](../conventions/secrets.md), [data.md](../conventions/data.md), [data-model.md](../conventions/data-model.md), [audit.md](../conventions/audit.md), [definition-of-done.md](../conventions/definition-of-done.md), ADR 0028 (ports), ADR 0032 (wallet / billing), ADR 0037 (Meta provider), ADR 0038 (inbox), ADR 0043 / 0044 (Phase 14).

- **One API, two auths:** the public API is the **same** route + service as the dashboard (no second copy of business logic). A route opts in to API keys with a scope; `requireAuth(req)` returns the same context (`accountId`, `actor: api_key`, scopes). Audit rows carry `actor { type: 'api_key', id }`.
- **Personal data:** webhook payloads carry ids, statuses, outcome keys, amounts and — only when the endpoint opted in (`includePersonalData`) — phone / name / summary. Never message text by default. Logs: never payloads, secrets or keys (prefix only).
- **Money:** every send / call through the API is charged exactly like the dashboard (holds, ledger, budgets). No free path.
- **Idempotency:** every public `POST` that creates something accepts `Idempotency-Key` (existing middleware, 24 h); webhook deliveries are at-least-once with a stable `event.id` so receivers can de-duplicate.
- **Tests:** no external network (local HTTP receiver in tests), `--maxWorkers=2`, never raise test timeouts; a real bug in committed code → separate `fix(...)` commit with a regression test proven to fail first.
- **Git:** one commit per task per repo, `[P15-T15.x]` tag, `Co-Authored-By` footer, no push / merge without the owner's say-so.
- **Other projects:** never touched (Docker: only `cav-*`; port 3100 → use 3150 for E2E). The client's production server / database are never connected to from this repo.

---

## 1. Locked decisions (proposed — final after the owner answers §7)

### 1a. What exists today (reuse, don't rebuild)

| Already built                                                                                        | Where                                                             | Phase 15 use                                       |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------- |
| API keys (create / revoke / list, SHA-256, `cav_live_` / `cav_test_`, ≤ 20 per account, `whoami`)    | `modules/api-keys/*`, `shared/middlewares/api-key-auth.ts`        | the only public auth; add scopes + usage           |
| Scopes `calls:read/write`, `contacts:read/write`, `campaigns:read/write`, `webhooks:manage`          | `modules/api-keys/scopes.ts`                                      | extend (§1b)                                       |
| `idempotency()` middleware (Redis, 24 h)                                                             | `shared/middlewares/idempotency.ts`                               | every public create                                |
| Rate limiter (Redis store)                                                                           | `shared/middlewares/rate-limit.ts`                                | per-key limits                                     |
| Single call "Call now" `POST /calls { contactId, flowId                                              | agentId }` + dial guard, holds                                    | `modules/calls/calls.routes.ts`, `startSingleCall` | public call trigger |
| WhatsApp calls (business-initiated, permission check)                                                | `modules/whatsapp-calling/*`                                      | public WhatsApp call trigger                       |
| Inbox send (`sendMessage`, window rules, opt-out, DND, billing hold)                                 | `modules/inbox/outbound.service.ts`                               | public message send                                |
| Template send (`prepareTemplateSend`, marketing limits, variables)                                   | `modules/templates/send.service.ts`                               | public template send + post-call WhatsApp          |
| Campaigns create / run / pause / results                                                             | `modules/campaigns/*`                                             | public campaigns                                   |
| Contacts CRUD, imports (CSV / XLSX), custom fields, DND                                              | `modules/contacts/*`, `contact-imports/*`                         | public contacts push + Sheets import               |
| Flow nodes `send_whatsapp` / `send_sms` — **only queue** into `outcome.messages`; nothing sends them | `core/engine/nodes/send-message.ts`                               | **T15.6 sends WhatsApp** (SMS stays queued)        |
| Post-call insights + dispositions (Phase 14)                                                         | `modules/insights/*`                                              | outcome rules + `call.insights.ready` webhook      |
| Realtime event catalogue (`call.created`, `call.status`, `call.ended`, inbox events …)               | `core/realtime/events.ts`                                         | same emit points feed the webhook outbox           |
| SSRF URL guard (private / metadata / credential URLs blocked)                                        | `modules/ai-agents/functions.service.ts` (`FUNCTION_URL_BLOCKED`) | extract to `shared/net/url-guard.ts`; webhook URLs |
| Secret sealing (AES-GCM with `ENCRYPTION_KEY`)                                                       | `core/ai/secret-box.ts` (API-request headers, Phase 5 / 6)        | webhook signing secrets (move to `shared/crypto/`) |
| Mock client APIs (`/mock/payment-status`, `/mock/loan-balance`, `/mock/http-status/:code`)           | `modules/mock-apis/*`                                             | add `/mock/payment-link`, `/mock/webhook-receiver` |
| Swagger UI `/api/docs` + OpenAPI generator                                                           | `modules/docs/*`, `scripts/generate-openapi.ts`                   | public API docs page (tags, examples, auth)        |
| Permission `integrations.manage` (already in the role matrix: owner / admin)                         | `modules/rbac/permissions.ts`                                     | webhooks + Sheets + outcome rules UI               |
| Empty module folders `modules/public-api/`, `modules/webhooks/`                                      | —                                                                 | filled in this phase                               |

### 1b. Public API surface (v1)

Same paths as the dashboard, opened to API keys with scopes. **New scopes** (catalogue test updated): `messages:write` (WhatsApp text / template send), `messages:read`, `templates:read`, `whatsapp-calls:write`, `reports:read`, `exports:write`. Existing scopes keep their meaning.

| Method + path                                                                                                                                                  | Scope                              | What                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| `GET /api-keys/whoami`                                                                                                                                         | any                                | (exists) key, account, scopes                                                                  |
| `POST /contacts`, `PATCH /contacts/:id`, `GET /contacts`, `GET /contacts/:id`                                                                                  | `contacts:write` / `contacts:read` | upsert by phone (`?upsert=phone`) or `externalId`; custom fields by key                        |
| `POST /contacts/bulk-upsert` (≤ 1,000 rows)                                                                                                                    | `contacts:write`                   | sync from LMS / CRM; returns per-row result                                                    |
| `POST /calls`                                                                                                                                                  | `calls:write`                      | (exists) one call to a contact with a flow / agent; `variables` override (≤ 50); `externalRef` |
| `POST /whatsapp/calls`                                                                                                                                         | `whatsapp-calls:write`             | business-initiated WhatsApp call (permission must already be granted)                          |
| `GET /calls`, `GET /calls/:id`, `GET /calls/:id/transcript`, `GET /calls/:id/insights`                                                                         | `calls:read`                       | (exist) results; filter by `externalRef`                                                       |
| `POST /messages/template`                                                                                                                                      | `messages:write`                   | template to a phone / contact (creates the contact + conversation if needed)                   |
| `POST /messages/text`                                                                                                                                          | `messages:write`                   | free-form text inside the 24 h window only (else 409 `WHATSAPP_WINDOW_CLOSED`, exists)         |
| `GET /messages/:id`                                                                                                                                            | `messages:read`                    | status, timestamps, error, charge                                                              |
| `GET /templates`                                                                                                                                               | `templates:read`                   | approved templates with variables                                                              |
| `POST /campaigns`, `POST /campaigns/:id/start                                                                                                                  | pause                              | resume                                                                                         | cancel`, `GET /campaigns`, `GET /campaigns/:id`, `GET /campaigns/:id/results` | `campaigns:write` / `campaigns:read` | (exist for the dashboard) |
| `GET /reports/:tab`                                                                                                                                            | `reports:read`                     | (exists) numbers for BI tools                                                                  |
| `POST /exports/calls                                                                                                                                           | messages                           | report`, `GET /exports/:id`                                                                    | `exports:write`                                                               | (exists) files                       |
| `GET/POST/PATCH/DELETE /webhook-endpoints[/:id]`, `POST …/:id/test`, `POST …/:id/rotate-secret`, `GET …/:id/deliveries`, `POST /webhook-deliveries/:id/replay` | `webhooks:manage`                  | §1c                                                                                            |

Rules:

- **`externalRef`** (≤ 100 chars) on calls and messages so the client's system can find its own records (`GET /calls?externalRef=…`); stored and echoed in webhooks. Contacts already have `externalId` (≤ 100, Phase 3) — the API upserts by it.
- **Per-key rate limits** (Redis): 60 writes / min and 600 reads / min per key by default (§7 #2), headers `RateLimit-*`; superadmin can raise per account. Calls / messages are further limited by the existing dial / send limits and the wallet.
- **API keys page additions:** scopes picker grouped by area, `lastUsedAt`, requests in the last 24 h / 7 days, optional **IP allowlist** per key (CIDR list, §7 #3), expiry date (optional).
- **API request log** (`apiRequestLogs`, TTL 7 days): method, path template (no ids / query values), status, duration, key id, request id — never bodies. Shown per key.
- **Versioning:** `/api/v1` stays; breaking changes need `/api/v2` (none in this phase). `Deprecation` / `Sunset` headers convention documented.

### 1c. Outbound webhooks

**Model:**

- `webhookEndpoints`: `accountId`, `url` (https only in production; SSRF guard at save **and** at delivery — DNS re-resolved), `description`, `events[]` (or `*`), `secretSealed` (32 random bytes, shown once, rotate keeps the old one valid 24 h), `includePersonalData` (default false), `active`, `disabledReason`, `failureStreak`, `createdBy`. ≤ 10 per account.
- `webhookEvents` (outbox, TTL 30 days): `accountId`, `type`, `data`, `createdAt`, `id` = `evt_<ulid>` — written **in the same code path** that emits the realtime event (one helper `emitAccountEvent(type, data)` that does both), so nothing is missed.
- `webhookDeliveries` (TTL 30 days): `eventId`, `endpointId`, `attempt`, `status` (`pending | succeeded | failed | gave_up`), `responseStatus`, `responseMs`, `responseBodySnippet` (≤ 1 KB, text only), `nextAttemptAt`, `error`.

**Delivery:** queue `webhooks` (new BullMQ queue): job per (event × endpoint), POST JSON `{ id, type, createdAt, apiVersion: '2026-10', data }`, headers `X-Webhook-Id`, `X-Webhook-Timestamp`, `X-Webhook-Signature: v1=<hex HMAC-SHA256(secret, timestamp + "." + rawBody)>` (+ `v1=` of the previous secret during rotation), `User-Agent: NotifyNow-Webhooks/1.0`; timeout 10 s; 2xx = success; retries at 1 m, 5 m, 30 m, 2 h, 12 h (then `gave_up`); 5 events in a row given up **or** 24 h of failures → endpoint disabled + notification `webhook.endpoint_disabled` (owners / admins) + e-mail. Order is not guaranteed (documented); receivers de-duplicate on `id`.

**Event catalogue (v1):**

| Event                                          | When                                             | `data` (ids always; personal fields only with `includePersonalData`)                           |
| ---------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `call.started`                                 | a call is answered                               | callId, contactId, externalRef, provider, direction, campaignId, flowId / agentId              |
| `call.completed`                               | a call ends (any status) and billing settled     | + status, endReason, durationSec, costMicros, disposition, dispositionSource, recording (bool) |
| `call.insights.ready`                          | Phase 14 insights done / skipped                 | + summary, sentiment, keyInfo (promise date / amount) — summary only with personal data        |
| `campaign.completed`                           | a campaign (or a recurring run) finishes         | campaignId, counts (calls, answered, outcomes), costMicros                                     |
| `whatsapp.message.received`                    | a customer message arrives                       | messageId, conversationId, contactId, type; text only with personal data                       |
| `whatsapp.message.status`                      | sent / delivered / read / failed of our messages | messageId, externalRef, status, error code, chargeMicros                                       |
| `whatsapp.call.started` / `.ended` / `.missed` | WhatsApp calls                                   | callId, contactId, direction, durationSec, answeredBy (user id)                                |
| `contact.opted_out` / `.opted_in`              | STOP / START or DND change                       | contactId, channel, source                                                                     |

**Dashboard (Settings → Integrations → Webhooks):** list, add (URL, events, personal-data switch), secret shown once with copy, **Send test event** (choose a type, see the response), delivery log with filters + **Replay**, re-enable a disabled endpoint, rotate secret. Docs page: payload samples per event + signature verification code (Node, Python, PHP) — the code samples are executed in tests.

### 1d. Call ke baad WhatsApp (post-call messages)

- **Flow step "Send WhatsApp" becomes real:** when a call ends, every `outcome.messages[]` entry with `channel: 'whatsapp'` becomes a **post-call message**: the account's connected number (or the one chosen in the step — new optional `channelId` in the step config), the approved template by name + language, rendered params; sent through `prepareTemplateSend` (same rules as the dashboard: approved template, marketing frequency limit, opt-out, DND, wallet hold) **after** the call is settled. `send_sms` stays queued (SMS gateway is Phase 18) and the step shows "SMS sending starts with phone lines".
- **Outcome rules** (`outcomeRules`, Settings → Integrations → After the call): "When a call ends with outcome **X** (or sentiment / promise found / not answered N times), send template **T** to the contact, **now** or **after D minutes / at the next H:00 inside calling hours**". Variables from contact fields, call variables and insights (`{{promise_date}}`, `{{promise_amount}}`). ≤ 20 rules per account, evaluated after insights (or after the call when insights are off), each rule once per call.
- **Guards:** never send twice for the same call + rule (`postCallMessages` unique key `callId + source`), skip with a reason (`opted_out`, `dnd`, `no_template`, `no_number`, `low_balance`, `marketing_limit`, `outside_window_text_only`) shown on the call page ("After the call: payment reminder sent ✓ / skipped — opted out").
- **Model:** `postCallMessages`: `accountId`, `callId`, `source` (`flow:<nodeId>` | `rule:<ruleId>`), `templateId`, `params`, `scheduledAt`, `status` (`scheduled | sent | skipped | failed`), `reason`, `messageId`. Job `postcall.send` on the `whatsapp` queue (delayed jobs for "after D minutes").
- **Call page + inbox:** the call detail shows "After the call" rows; the message appears in the inbox chat like any template send (origin `system`).

### 1e. Google Sheets + CRM

Default (§7 #4): **no Google OAuth in Phase 15** (Google's sensitive-scope verification takes weeks):

- **Contacts in:** "Import from Google Sheet" = a sheet published as CSV (`https://docs.google.com/.../pub?output=csv`) → the existing import pipeline (mapping, validation, dedupe) — once or **scheduled** (hourly / daily) with "update existing by phone / externalId". URL guarded (Google domains only), size ≤ the import limit.
- **Results out:** an **Apps Script receiver** template (copy into the sheet → deploy as web app → paste its URL as a webhook endpoint with `call.completed`): appends a row per call. Shipped in `docs/integrations/google-sheets.md` + tested with a local fake receiver.
- **CRM:** webhooks + API + `externalRef` + docs for Zapier / Make / n8n (generic "Webhooks by Zapier" recipe). Native connectors are later.

### 1f. Developer experience

- **Docs page** (`/api/docs`, public in production for the public API part — §7 #6): getting started (create key → whoami → first call → webhook), auth, errors, idempotency, rate limits, pagination, webhooks + signatures, every public route with examples, changelog. Generated from OpenAPI (tags `Public API`), plus hand-written guides in `docs/api/*.md` rendered on the page.
- **Settings → Developers** (frontend): API keys (scopes, usage, IP allowlist, expiry), request log, webhooks, "Try it" (whoami with a pasted key — never stored).
- **Mocks:** `/mock/payment-link` (returns a fake payment URL for a loan id — used by templates' URL button in demos) and `/mock/webhook-receiver` (dev only: stores the last 50 deliveries in memory, shows the signature check) — `MOCK_APIS_ENABLED` only.

### 1g. Security

- Keys: SHA-256 at rest (exists), optional IP allowlist, optional expiry, per-key rate limits, revocation immediate (cache ≤ 30 s), every key use updates `lastUsedAt` (throttled), suspicious use (many 401s from one IP) → existing auth rate limiter.
- Webhooks: HTTPS only (production), SSRF guard at save + delivery (private ranges, metadata IPs, DNS rebinding), no redirects followed, response body never rendered as HTML, secrets sealed, signature with timestamp (replay window 5 min documented), personal data opt-in per endpoint.
- Tenant isolation on every public route (shared test loop as in Phase 14), scopes matrix snapshot, audit for key / endpoint / rule changes, no secrets / payloads in logs.

### 1h. Data model (new collections)

`webhookEndpoints`, `webhookEvents` (TTL 30 d), `webhookDeliveries` (TTL 30 d), `apiRequestLogs` (TTL 7 d), `outcomeRules`, `postCallMessages`, `sheetImports` (scheduled Google-Sheet imports: url, schedule, mapping, lastRunAt, lastResult). Additions: `apiKeys.ipAllowlist`, `apiKeys.expiresAt`, `apiKeys.usage` (daily counters); `calls.externalRef`, `messages.externalRef` (+ `{ accountId, externalRef }` indexes); `contacts.externalId` exists (add a unique-per-account partial index if missing); flow node `send_whatsapp.config.channelId?`. Migration `0017-integrations` (indexes, TTLs, backfill none).

**Catalogue changes (expected, final in the run prompt):** error codes + `WEBHOOK_URL_BLOCKED` 422, `WEBHOOK_ENDPOINT_LIMIT` 422, `API_KEY_IP_DENIED` 403, `API_KEY_EXPIRED` 401, `OUTCOME_RULE_LIMIT` 422, `SHEET_URL_INVALID` 422 (reused: `RATE_LIMITED`, `WHATSAPP_WINDOW_CLOSED`, `WHATSAPP_CALL_PERMISSION_MISSING`); audit `webhook_endpoint.created/updated/deleted/secret_rotated/disabled/enabled`, `outcome_rule.created/updated/deleted`, `api_key.updated`, `sheet_import.created/deleted`; notification `webhook.endpoint_disabled`; queues + `webhooks`; jobs `webhooks.deliver`, `postcall.send`, `sheets.import`, maintenance `api-logs-purge` (TTL backup).

---

## 2. Tasks ka overview

| #           | Task                                                                                                                                                                    | Repo | Size | Depends on  |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---- | ----------- |
| T15.1       | Public API foundation: scopes, `apiKeyAuth` on existing routes, per-key limits, request log, IP allowlist / expiry, `externalRef`                                       | BE   | L    | —           |
| T15.2       | Public send + trigger routes: contacts upsert / bulk, messages text / template, WhatsApp call trigger, templates read                                                   | BE   | M    | T15.1       |
| T15.3       | Webhook core: outbox (`emitAccountEvent`), endpoints, signing, delivery queue, retries, disable, replay, test                                                           | BE   | L    | T15.1       |
| T15.4       | Event wiring: every catalogue event emitted from its single place + payload builders + personal-data filter                                                             | BE   | M    | T15.3       |
| P15-B1-DONE | checkpoint (backend core green, external-client integration test)                                                                                                       | BE   | —    |             |
| T15.5       | Post-call WhatsApp: flow step sends, outcome rules, scheduler, guards, call-page rows                                                                                   | BE   | L    | T15.4       |
| T15.6       | Google Sheets in (published CSV, scheduled) + Apps Script receiver + Zapier / Make docs                                                                                 | BE   | M    | T15.3       |
| T15.7       | Frontend: Settings → Developers (keys, usage, IP, log), Integrations → Webhooks (test, log, replay), After the call (rules), Sheets imports, call-page "After the call" | FE   | L    | T15.2–T15.6 |
| P15-B2-DONE | checkpoint (both repos, Playwright twice)                                                                                                                               | both | —    |             |
| T15.8       | Docs page + guides + signature samples (tested) + mocks (`payment-link`, `webhook-receiver`)                                                                            | both | M    | T15.3       |
| T15.9       | Seeds, Playwright specs, security tests (isolation, scopes matrix, SSRF, replay), perf (1,000 webhooks / min)                                                           | both | M    | all         |
| T15.10      | Gap audit, ADR 0045 (public API) + 0046 (webhooks), setup + runbook, READMEs, CHANGELOGs, BUILD_PLAN_V2, sign-off                                                       | both | M    | all         |
| P15-B3-DONE | final verify + report                                                                                                                                                   | both | —    |             |

---

## 3. Tasks — step by step

### T15.1 — Public API foundation (backend)

1. `scopes.ts`: add the new scopes (§1b) with descriptions + groups; catalogue test; `API_KEY_SCOPES` used by the UI.
2. Route guard `access({ permission, scope })`: a route accepts **either** a user session with the permission **or** an API key with the scope (one helper, replaces ad-hoc `authenticate()` + `requirePermission()` on the routes listed in §1b). API-key requests never pass `blockWhenImpersonating` checks differently; dashboard-only routes stay session-only (team, billing top-up, settings, superadmin).
3. Per-key rate limiter (Redis, `rl:key:<id>`), headers, 429 `RATE_LIMITED` with `Retry-After`.
4. `apiKeys`: `ipAllowlist[]` (CIDR, ≤ 20), `expiresAt`, usage counters (daily, `$inc`, throttled `lastUsedAt`); `PATCH /api-keys/:id` (name, scopes, allowlist, expiry; audit `api_key.updated`).
5. `apiRequestLogs` + middleware (after response): method, route template (`req.route.path`), status, ms, keyId, requestId; TTL index 7 days; `GET /api-keys/:id/requests` (cursor).
6. `externalRef` on calls / messages (+ indexes `{ accountId, externalRef }`), accepted by create routes, filter on lists; contacts keep `externalId`.
7. Tests: scopes × routes matrix (session vs key), IP allowlist (IPv4 / IPv6 / CIDR), expiry, revoked key, rate limits, log has no ids / bodies, tenant isolation for keys.

### T15.2 — Public send + trigger routes (backend)

1. `POST /contacts` upsert (`?upsert=phone|externalId`, `externalId` exists), `POST /contacts/bulk-upsert` (≤ 1,000, per-row results, same validation as imports, custom fields by key, DND / opt-out never cleared by the API unless `consent` given — §7 #7).
2. `POST /messages/template { to (E.164) | contactId, channelId?, template { name, language }, params / headerMedia?, externalRef? }` → creates contact / conversation if missing, `prepareTemplateSend`, hold + capture as today; `POST /messages/text` (window only); `GET /messages/:id`.
3. `POST /whatsapp/calls { contactId | to, channelId?, flowId | agentId | userId }` (permission required, else 409 `WHATSAPP_CALL_PERMISSION_MISSING`).
4. `POST /calls` accepts `variables` (≤ 50, string / number, validated against the flow's variables) and `externalRef`.
5. `GET /templates` (approved, variables + examples).
6. Tests: every route with key + scope, idempotency replay, wallet / opt-out / DND / window refusals, no duplicate contact on concurrent upserts.

### T15.3 — Webhook core (backend)

1. Extract the SSRF guard to `shared/net/url-guard.ts` (used by AI functions, knowledge URLs, webhooks); DNS re-check at delivery; no redirects.
2. Models `webhookEndpoints`, `webhookEvents`, `webhookDeliveries` (+ TTLs); secrets sealed; ≤ 10 endpoints.
3. `emitAccountEvent(accountId, type, data)` → writes `webhookEvents` + enqueues one `webhooks.deliver` per matching active endpoint (and still publishes the realtime event where one exists).
4. Delivery worker: payload, signature (current + previous secret during rotation), 10 s timeout, response capture, retries (BullMQ custom backoff 1 m / 5 m / 30 m / 2 h / 12 h), `failureStreak`, auto-disable + notification + e-mail.
5. Routes: CRUD endpoints, `POST /:id/test { type }` (sample payload, synchronous result), `POST /:id/rotate-secret`, `POST /:id/enable`, `GET /:id/deliveries` (filters), `POST /webhook-deliveries/:id/replay`.
6. Tests: signature (golden vectors), retries timing (fake clock), disable after streak, replay, rotation overlap, SSRF (private IPs, `169.254.169.254`, IPv6 loopback, DNS rebinding fake), HTTPS-only in production, payload never logged.

### T15.4 — Event wiring (backend)

1. Emit each catalogue event from **one** place: call answered / ended + settled (calls + WhatsApp calls), insights done (Phase 14), campaign finished, inbound message, outbound status webhook from Meta, opt-out / DND changes.
2. Payload builders per event (typed, zod-checked in tests), personal-data filter by endpoint flag.
3. `externalRef` echoed.
4. Tests: each event fires once per real change (idempotent on Meta webhook retries), payload snapshots, nothing personal without the flag.
5. **External-client integration test** (`tests/integration/external-client.test.ts`): a local HTTP receiver + an API key → create contact → `POST /calls` (dry run) → `call.started` + `call.completed` (signature verified with the documented algorithm) → `GET /calls/:id` matches.

### P15-B1-DONE — checkpoint

Backend full verify (each command separately, coverage), external-client test green, CHANGELOG `Phase 15 · Batch 1`, tracker ticks, commit, continue.

### T15.5 — Post-call WhatsApp (backend)

1. Flow step `send_whatsapp`: config adds optional `channelId`; validator checks the template exists / approved at publish (warning, not blocking) — engine unchanged (still queues).
2. After a call settles: `postcall.collect` turns `outcome.messages` (whatsapp) into `postCallMessages` (`source: flow:<nodeId>`).
3. `outcomeRules` model + CRUD (`integrations.manage`, ≤ 20), evaluation after insights (or settle when insights are off), conditions: disposition in [...], sentiment, has promise, not answered N times in a row (campaign), call kind (phone / WhatsApp), flow / campaign filter; action: template + params mapping + timing (now / after D min / next calling-window hour).
4. `postcall.send` job (delayed): resolve contact phone + channel → `prepareTemplateSend` → result on the row; skip reasons; never twice (unique `callId + source`).
5. Call view: `afterCall[]` rows; inbox shows the template as `system` origin; webhook `whatsapp.message.status` carries `externalRef` = call's.
6. Tests: flow step sends after a dry-run call (fake Meta), rule fires once, every skip reason, timing inside calling hours, charges, opt-out race, insights-off path.

### T15.6 — Google Sheets + CRM docs (backend)

1. `sheetImports`: `POST /sheet-imports { url, schedule: once | hourly | daily, mapping, updateExisting }` (`contacts.import`), URL guard (Google published-CSV hosts only), fetch → existing import job; scheduler on maintenance; last result + errors file.
2. `docs/integrations/google-sheets.md`: published-CSV import steps; Apps Script receiver (script in `docs/integrations/apps-script-receiver.gs`, verifies the signature, appends a row) — tested against a local runner that executes the script's logic in Node (pure function extracted).
3. `docs/integrations/zapier-make-n8n.md`: recipes (webhook → CRM, CRM → API call).
4. Tests: scheduled import updates by phone, bad URL / non-CSV / too big, mapping errors, isolation.

### T15.7 — Frontend (both screens + call page)

1. **Settings → Developers:** API keys table (scopes chips, last used, 24 h / 7 d requests, IP allowlist, expiry, edit), create dialog with grouped scopes, request log drawer, "Test a key" (whoami), link to docs.
2. **Settings → Integrations → Webhooks:** list (status, events, last delivery), add / edit (URL, events multi-select, personal-data switch with a plain warning), secret once + copy, **Send test**, deliveries table (filters, response, **Replay**), disabled banner + enable, rotate secret.
3. **Settings → Integrations → After the call:** rules list + editor (when / send / timing, variable mapping with a live template preview), enable / disable, order.
4. **Contacts → Import from Google Sheet:** URL + schedule + mapping (reuse the import wizard), scheduled imports list.
5. **Flow builder:** Send WhatsApp step — number picker, template picker (approved only), params with variables; "sent after the call" hint; Send SMS step shows "starts with phone lines".
6. **Call detail:** "After the call" card (rows with status / reason / link to the chat).
7. Tests (unit + component): forms validation, permission views (only `integrations.manage` / `apikeys.manage`), empty / error states; API client tests; generated types.

### P15-B2-DONE — checkpoint

Both repos full verify, Playwright whole suite twice (port 3150) + log grep (keys, secrets, signatures, payloads, phones = 0), bundle numbers, CHANGELOGs, tracker, commit, continue.

### T15.8 — Docs + mocks (both)

1. Public docs page: getting started, auth, scopes, errors, idempotency, rate limits, pagination, webhooks (catalogue, payloads, signature, retries, replay), changelog; Swagger for the `Public API` tag; production setting for public docs (§7 #6).
2. Signature samples (Node, Python, PHP) in `docs/api/webhooks.md`; the Node + Python samples run in CI tests against golden vectors (Python only if available locally — else Node + a recorded vector).
3. Mocks: `/mock/payment-link`, `/mock/webhook-receiver` (dev only) + a "Dev receiver" option in the webhook form when mocks are on.

### T15.9 — Seeds, E2E, perf, security (both)

1. Seed: a demo API key (printed once), a webhook endpoint to the mock receiver, two outcome rules, a scheduled sheet import (disabled).
2. Playwright: create key → whoami in the docs "Try it"; add webhook (dev receiver) → test event → delivery log → replay; dry-run call → `call.completed` delivery visible; outcome rule → template in the inbox after the call; Send WhatsApp step in a flow → after-call row; viewer / agent views (no Developers / Integrations).
3. Perf: 1,000 events / min to 5 endpoints (local receiver) → delivery p95 < 5 s, no lost events, queue drains; API p95 for `POST /messages/template` and `POST /calls` under 50 rps (local).
4. Security tests: isolation loop over every public route with keys of two accounts, scopes matrix snapshot, SSRF corpus, signature tamper / old timestamp, IP allowlist bypass attempts (`X-Forwarded-For` only trusted per `TRUST_PROXY`), no secrets / payloads in logs.
5. Both repos full verify + Playwright twice.

### T15.10 — Gap audit, docs, sign-off (both)

1. Gap audit against §0 Done-when + §4.
2. ADR 0045 "Public API: one API, two auths, scopes"; ADR 0046 "Webhooks: outbox, signing, retries".
3. `docs/setup/webhooks.md` (receiver checklist), runbook additions (`docs/ops/staging.md`: stuck webhook queue, disabled endpoints, key rotation), conventions (api.md §12 / §14 final, data-model, error-codes, audit, websocket), `src/README.md` rows, both READMEs, CHANGELOGs, BUILD_PLAN_V2 ("Phase 15 done … Next: Phase 16").
4. `PHASE_15_SIGNOFF.md` (Phase 14 format): scope, numbers, Playwright runs, perf, deviations, bugs, open items (client deploy, real Meta send on production after App Review).

---

## 4. Deliverables checklist

- [ ] New scopes + `access({ permission, scope })` on every public route; per-key limits; request log; IP allowlist + expiry; `externalRef`
- [ ] Contacts upsert / bulk, messages template / text, WhatsApp call trigger, templates read
- [ ] Webhook outbox, endpoints, signing + rotation, retries, auto-disable + notification, replay, test event
- [ ] Every catalogue event wired from one place, personal-data opt-in, external-client integration test
- [ ] Post-call WhatsApp: flow step sends, outcome rules, scheduler, guards, call-page rows
- [ ] Google Sheets import (published CSV, scheduled) + Apps Script receiver + Zapier / Make / n8n docs
- [ ] Frontend: Developers, Webhooks, After the call, Sheet imports, flow step, call card
- [ ] Docs page + guides + tested signature samples + mocks
- [ ] Seeds, Playwright specs, perf, security tests
- [ ] ADR 0045 + 0046, setup guide, runbook, READMEs, CHANGELOGs, BUILD_PLAN_V2, sign-off

---

## 5. Risks

| Risk                                                         | Mitigation                                                                                                  |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| A client script floods calls / messages and burns the wallet | Per-key limits, existing dial / send limits, wallet holds, budgets, IP allowlist, key revocation            |
| Webhook URL used for SSRF                                    | One URL guard at save + delivery (DNS re-check), no redirects, https only, tests with a corpus              |
| Lost or duplicated events                                    | Outbox row written in the emitting code path, stable `evt_` ids, at-least-once + documented de-dupe, replay |
| Personal data leaving the system                             | Ids only by default, per-endpoint opt-in with a warning, docs say what each event carries                   |
| Post-call message spam / wrong customer                      | Once per call + source, opt-out / DND / marketing limits, calling-hours timing, skip reasons visible        |
| Public routes drift from dashboard logic                     | Same services, one guard helper, scopes × routes matrix test                                                |
| Google OAuth verification delays                             | No OAuth in this phase (published CSV + Apps Script)                                                        |
| Client production differs (own DB / env)                     | Migrations idempotent, new env vars none or optional, release notes for the client's deploy                 |

---

## 6. Recommended order

Batch 1 (backend core): T15.1 → T15.2 → T15.3 → T15.4 → **P15-B1-DONE**. Batch 2: T15.5 → T15.6 → T15.7 → **P15-B2-DONE**. Batch 3: T15.8 → T15.9 → T15.10 → **P15-B3-DONE**.

---

## 7. Decisions and open questions (owner — defaults apply if not answered)

| #   | Question                                               | Default                                                                            |
| --- | ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| 1   | Which outside systems connect first (LMS / CRM names)? | Generic API + webhooks; recipes for Zapier / Make / n8n                            |
| 2   | Per-key rate limits                                    | 60 writes / min, 600 reads / min; superadmin can raise per account                 |
| 3   | IP allowlist per key                                   | Optional (off by default)                                                          |
| 4   | Google Sheets: OAuth or published CSV + Apps Script?   | Published CSV + Apps Script (no Google verification wait)                          |
| 5   | Any native CRM connector now?                          | None in Phase 15                                                                   |
| 6   | Public API docs page public in production?             | Yes for the public API part (no login); dashboard-only routes hidden               |
| 7   | Can the API clear an opt-out / DND?                    | No — only with `consent { source, at }` and audited; DND list stays dashboard-only |
| 8   | SMS after the call                                     | Stays queued until phone lines (Phase 18)                                          |
| 9   | Webhook personal data                                  | Off by default, per endpoint opt-in                                                |
| 10  | Retry schedule / auto-disable                          | 1 m, 5 m, 30 m, 2 h, 12 h; disable after 5 given-up events or 24 h failing         |
| 11  | Outcome rule timing                                    | Now, after D minutes, or the next hour inside calling hours                        |
| 12  | Who manages webhooks / rules / keys                    | Owner + admin (`integrations.manage`, `apikeys.manage`); managers read-only        |
| 13  | API request log retention                              | 7 days                                                                             |
| 14  | Webhook event / delivery retention                     | 30 days                                                                            |

---

## Changelog

- 2026-10-29: plan drafted after Phase 14 sign-off and the NotifyNow brand change. Built on a code survey of `main` (`acf5d8b`): API keys + scopes + `apiKeyAuth` exist but no route uses them; `modules/public-api` and `modules/webhooks` are empty; flow `send_whatsapp` / `send_sms` only queue (nothing sends them); SSRF guard lives in AI functions; idempotency, rate limiting, template / inbox send, single calls and the realtime event catalogue are reusable. 14 owner questions with defaults (§7).
