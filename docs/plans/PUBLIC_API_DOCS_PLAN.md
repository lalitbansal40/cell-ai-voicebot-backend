# Public API + API docs — complete & production-ready (plan)

5 Nov 2026 · Status: **implemented locally (DOCS-T1…T9)** · Product name in docs: **NotifyNow API**

## 0. Aaj kya hai (code se verified)

| Area          | Abhi ki state                                                                                                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Auth          | `X-API-Key` (`cav_live_…`), 13 scopes (`src/modules/api-keys/scopes.ts`), IP allowlist, expiry, per-key limits 600 reads / 60 writes per min, 7-day request log, `GET /api-keys/whoami`                                                                                  |
| Public routes | **49 operations** tagged `Public API`: contacts (5), calls (6 incl. insights / after-call / transcript), campaigns (9), WhatsApp messages (3), templates list (1), WhatsApp calls + quote (2), reports (8), exports (4), webhook endpoints + deliveries (10), whoami (1) |
| Spec          | `GET /api/v1/openapi.public.json` (`buildPublicSpec`: sirf Public API ops + unke schemas; guides = `info.description`)                                                                                                                                                   |
| Docs UI       | Swagger UI `/api/docs` (production me `public` mode, dev me full) — own CSP, `tryItOutEnabled`                                                                                                                                                                           |
| Guides        | `docs/api/*.md` → `npm run gen:guides` → `guides.gen.ts`: getting-started, errors, idempotency, rate-limits, pagination, webhooks, changelog                                                                                                                             |
| Webhooks      | 11 events, HMAC `v1=` signature, retries 1m/5m/30m/2h/12h, replay, test event, `apiVersion: 2026-10`                                                                                                                                                                     |
| In-app        | Settings → API keys (create, scopes, allowlist, request log, Test a key) links to docs                                                                                                                                                                                   |

### Gaps found

1. **Quality:** 49 me se **0 operations ka `description`** hai (sirf one-line summary); sirf **9 ke examples**; per-route error codes, scope, limits, idempotency har route par nahi likhe.
2. **Discoverability:** API se ye IDs nikalne ka raasta nahi: flows, AI agents, WhatsApp numbers (`channelId`), contact lists, segments, caller numbers, IVRs, wallet balance. Isliye `POST /calls`, `POST /campaigns`, `POST /whatsapp/calls`, `POST /messages/*` use karne ke liye customer ko dashboard se ID copy karni padti hai.
3. **Missing features in API:** WhatsApp **bulk campaigns** (Phase 19) public nahi hain; recorded-voice (`line: voice_api`) aur WhatsApp-call campaigns (`line: whatsapp`) `POST /campaigns` se chalte hain par docs/examples me nahi.
4. **Stale docs:** `changelog.md` sirf Phase 15 tak; campaign lines, voice campaigns, WhatsApp call campaigns, naye error codes, rate limits update nahi.
5. **Broken guard:** `tests/security/phase15-routes.test.ts` fail (2 cases, `main` par bhi) — `GET /whatsapp/channels/{id}/calling/quote` public hai par record map / snapshot me nahi.
6. **Webhook events:** WhatsApp bulk campaign complete / paused ka event nahi; recorded-voice campaign `campaign.completed` me hi aata hai (payload me `line` nahi).
7. **Tooling:** Postman collection, code samples (Node / Python / PHP / curl har route), `operationId`, `servers` block, versioning / deprecation policy — nahi hai.

## 1. Locked decisions (defaults — owner badal sakta hai §8)

| #   | Decision                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Docs ek hi jagah: `https://wa.notifynow.in/api/docs` (Swagger UI) + `openapi.public.json` download + Postman download. Alag developer site abhi nahi                  |
| P2  | Read-only "resource" endpoints public honge (gap 2) under **new scope `resources:read`**                                                                              |
| P3  | WhatsApp bulk campaigns public honge under **new scopes `whatsapp-campaigns:read` / `whatsapp-campaigns:write`**                                                      |
| P4  | API version abhi `2026-10` hi rahega (sab changes additive); breaking change = naya version + 6 mahine purana chalega (policy guide me)                               |
| P5  | Har public op par: `operationId`, `description`, `x-scope`, request + 200 example, documented error codes, rate-limit + idempotency note — **CI test enforce karega** |
| P6  | Examples me sirf fake data (`+91900000xxxx`, `Asha Verma`, fake ids); kabhi real key / number nahi                                                                    |
| P7  | Sandbox/test keys abhi nahi; guide me "dry-run campaign + fake WhatsApp in staging" ka tareeka                                                                        |

## 2. Steps (in order)

### D1 — Audit script + checklist (CI guard)

1. `scripts/docs-audit.ts`: public spec padh kar har op ke liye table: method, path, operationId, scope, description?, request example?, response example?, error codes?, idempotency?. Output `docs/api/_audit.md` (generated).
2. Test `tests/docs/public-spec-quality.test.ts`: har public op me `operationId` (unique, camelCase), `description` ≥ 40 chars, `x-scope` (valid scope), body wale ops me request example, 2xx example, `401/403/404/422/429` refs. Shuru me fail → D3 ke baad green.
3. Fix gap 5: quote route ko `phase15-routes.test.ts` record map me add karo aur snapshot update (scope `calls:write` — owner confirm §8).

### D2 — Missing public endpoints (discoverability, gap 2)

Sab **read-only**, account-scoped, minimal fields (secrets / tokens / provider cost kabhi nahi), cursor pagination jahan list badi ho, scope `resources:read`:

| Route                                 | Returns                                                                                                           |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `GET /flows?status=published`         | `id, name, publishedVersion, triggers, agents[{id,name}]`                                                         |
| `GET /agents?active=true`             | `id, name, language, voice, isActive`                                                                             |
| `GET /whatsapp/channels`              | `id, label, displayPhoneNumber, status, mode, messagingLimitTier, calling: { status, ready }`, effective msgs/sec |
| `GET /contact-lists`, `GET /segments` | `id, name, count`                                                                                                 |
| `GET /phone-line`                     | line (sip / dryrun), caller numbers, `voiceApi.enabled`                                                           |
| `GET /voice-api/ivrs`                 | assigned IVRs (pehle se hai — public tag + scope)                                                                 |
| `GET /wallet`                         | `balanceMicros, availableMicros, holdMicros, currency` (no ledger)                                                |

Changes: new scope in `scopes.ts` + `SCOPE_PERMISSIONS` (`flows.read, agents.read, whatsapp.read, contacts.read, account.read, billing.read`), API-key UI me scope label, `access({ permission, scope })` on routes, OpenAPI `Public API` tag, scope catalogue count tests.

### D3 — WhatsApp bulk campaigns + campaign lines in API (gap 3)

1. Existing `/whatsapp-campaigns` routes (create, update, estimate, start (Idempotency-Key), pause, resume, stop, get, list, recipients, export) par `access({ permission: 'whatsapp.campaigns.*', scope: 'whatsapp-campaigns:*' })` + `Public API` tag; per-key write limit apply.
2. `POST /campaigns` docs: 3 examples — `line: phone` (flow / agent), `line: whatsapp` (channelId + program), `line: voice_api` (audio / IVR, retries). Estimate + start + contacts response examples incl. `voice` fields.
3. Webhook events (gap 6): add `whatsapp_campaign.completed`, `whatsapp_campaign.paused`; `campaign.completed` / `campaign.paused` payload me `line` add (additive). Catalogue + payload samples + `withoutPersonalData` rules + tests.

### D4 — OpenAPI quality pass (gap 1) — har route

Har `registerPath` me (12 schema files: calls, campaigns, contacts, insights, post-call, public-api/messages, record-exports, reports, templates, webhooks, whatsapp-calling, api-keys + D2/D3 naye):

1. `operationId` (e.g. `createContact`, `startCampaign`), stable — Postman / SDK isi se banenge.
2. `description` (Markdown): kya karta hai, scope, limits, idempotency, side effects (wallet hold / charge), common errors with codes.
3. Request + response `examples` (fake data, P6). Money hamesha **micros**, time ISO-8601 UTC, phone E.164.
4. Error responses: shared `errors[...]` + route-specific codes ka table description me (e.g. `WALLET_INSUFFICIENT_BALANCE`, `WHATSAPP_OUTSIDE_WINDOW`, `VOICE_API_NOT_PRICED`).
5. Spec level: `servers: [{ url: 'https://wa.notifynow.in/api/v1' }]`, security scheme descriptions, tag order + tag descriptions (Getting started, Contacts, Calls, WhatsApp messages, WhatsApp calls, Campaigns, WhatsApp bulk campaigns, Reports & exports, Webhooks, Account resources).
6. `npm run gen:openapi` → `openapi:check` → frontend `gen:api` (types unchanged ya additive).

### D5 — Guides (`docs/api/*.md`) rewrite + new

Har guide me curl + Node + Python + PHP snippet; sab examples D6 smoke se verify:

| Guide                                           | Content                                                                                                                                                                             |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| getting-started (update)                        | key banana, scopes, whoami, pehla contact / template / call, IDs kahan se (D2 routes)                                                                                               |
| authentication (new)                            | `X-API-Key`, scopes table (auto from `scopes.ts`), IP allowlist, expiry, rotation, request log, 401 vs 403                                                                          |
| conventions (new)                               | E.164 phones, micros, ISO time + account timezone, ids, `externalRef`, PII masking rules                                                                                            |
| errors (update)                                 | envelope + **public error code table generated** from `error-codes.ts` (sirf public routes ke codes)                                                                                |
| idempotency / pagination / rate-limits (update) | current numbers from `config/limits.ts` (generated table), retry/backoff advice, `Retry-After`                                                                                      |
| whatsapp-messages (new)                         | templates list → send template (variables, header media), text in 24h window, statuses, pricing / categories, opt-out                                                               |
| calls (new)                                     | flow vs agent, `manualVariables`, results, transcript, insights, after-call, test line vs SIP                                                                                       |
| whatsapp-calls (new)                            | call permission, quote, AI call, statuses, billing                                                                                                                                  |
| campaigns (new)                                 | 3 types, create → estimate → start → poll / webhook → results / export; recorded voice (batches, charge at send, Stop limits); WhatsApp bulk (templates only, 18/75 msgs/sec, tier) |
| reports-exports (new)                           | tabs, date range, export job polling + 15-min link                                                                                                                                  |
| webhooks (update)                               | all events incl. D3, payload per event, signature code, retries, replay, ordering                                                                                                   |
| versioning (new)                                | `2026-10`, additive policy, deprecation notice, changelog subscription                                                                                                              |
| changelog (update)                              | Phase 18 (SIP), Phase 19 (campaign lines, WhatsApp call campaigns, bulk campaigns), VAPI (voice campaigns), D2/D3 additions                                                         |
| troubleshooting (new)                           | top 15 errors with fixes, request log use, support contact                                                                                                                          |

`GUIDE_ORDER` update, `npm run gen:guides`, guides test.

### D6 — Docs UI, downloads, in-app links

1. Swagger UI: `persistAuthorization`, `X-API-Key` authorize button, tag order, branding (NotifyNow logo / title, favicon), operation filter / search, "Download OpenAPI" + "Download Postman" links in page header (CSP-safe, no inline script).
2. `scripts/gen-postman.ts` → `GET /api/v1/postman.json` (public spec se; `{{baseUrl}}`, `{{apiKey}}` variables, examples saved as responses). Committed + check test like `openapi:check`.
3. Frontend: Settings → API keys par "API docs", "Download Postman", scope descriptions; Integrations page par link. (Test a key already hai.)
4. nginx: `/api/docs`, `openapi.public.json`, `postman.json` cache 1 h; no auth.

### D7 — Examples smoke (docs sach bolte hain)

`scripts/api-docs-smoke.ts`: local server (fake Meta / fake voice / dry-run line) par ek test account + key banao, **har documented request example** chalao, status code + response shape ko spec se validate (ajv). CI me nahi (slow) — release se pehle ek baar.

### D8 — Tests (kam, sirf relevant)

- `public-spec-quality.test.ts` (D1) · scopes / route matrix snapshot update (`phase15-routes`) · D2 routes: 1 file (key with / without `resources:read`, other-account 404, no secret fields) · D3: bulk campaign via key 1 file (create → start idempotent → stop) + webhook event payload test · guides + postman generated-file checks.

### D9 — Release

CHANGELOG (both), `docs/api/changelog.md`, README env/docs section, release note, client deploy (Cell24x7 repo flow), live check: docs page production par khul raha hai, `openapi.public.json` + `postman.json` download, ek real key se whoami + contacts list.

## 3. Order + rough size

D1 (½ din) → D2 (1 din) → D3 (1 din) → D4 (1½ din, sabse bada) → D5 (1½ din) → D6 (½ din) → D7 (½ din) → D8/D9 (½ din). Lagbhag 6–7 din ka kaam (andaza).

## 4. Owner se confirm (defaults upar)

| Sawaal                                                   | Default                                 |
| -------------------------------------------------------- | --------------------------------------- |
| Read-only resource routes + naya scope `resources:read`? | Haan                                    |
| WhatsApp bulk campaigns API se?                          | Haan, naye scopes ke saath              |
| `calling/quote` API key se khula rahe?                   | Haan, `calls:write`                     |
| Docs URL                                                 | `wa.notifynow.in/api/docs`              |
| Test / sandbox keys                                      | Abhi nahi (baad me alag feature)        |
| SDK packages (npm / pip)                                 | Abhi nahi; Postman + code samples kaafi |
