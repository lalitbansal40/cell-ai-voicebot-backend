# PUBLIC API DOCS RUN — NotifyNow API complete & documented — Autonomous Run Prompt

> **HOW TO RUN (ise paste karo):**
> `cell-ai-voicebot-backend/docs/prompts/PUBLIC_API_DOCS_PROMPT.md poora padho aur DOCS-T1 se DOCS-T9 tak SAARE tasks step by step autonomously implement karo. Bich me question ya permission mat maango — decisions §4 me locked hain; routine choice existing conventions se lo aur report me likho. Har task ke baad sirf us task ke relevant tests + lint/typecheck, phir commit (tag [DOCS-Tn]). Full suites sirf DOCS-T9 me ek-ek baar (serial). Koi push / merge / deploy / client sync NAHI. Ant me [DOCS-DONE] commit + short Hinglish report.`
>
> Working directory: `/Users/lalitbansal/Documents/cell-ai-voicebot` (backend + frontend repos andar).

---

## 0. Context (verified 5 Nov 2026 — dobara derive mat karna)

- **Plan:** [PUBLIC_API_DOCS_PLAN.md](../plans/PUBLIC_API_DOCS_PLAN.md). Ye prompt plan ke D1–D9 ko DOCS-T1–T9 me badalta hai.
- **Repos / branch:** dono `main` par clean (backend `f7f2e32`, frontend `5b92582`, VAPI merged + pushed). Naya branch dono me `feature/public-api-docs`.
- **Public API foundation (reuse, rebuild mat karna):**
  - Auth: `X-API-Key` → `src/shared/middlewares/api-key-auth.ts`, `authenticate({ apiKeys: true })`, `access({ permission, scope })` (`src/shared/middlewares/access.ts`; session ko permission, key ko scope chahiye). Per-key limits `src/modules/public-api/key-limits.ts` (600 reads / 60 writes per min), request log `request-log.ts`.
  - Scopes: `src/modules/api-keys/scopes.ts` — 13 scopes (`calls:read`, `calls:write`, `whatsapp-calls:write`, `contacts:read`, `contacts:write`, `campaigns:read`, `campaigns:write`, `messages:read`, `messages:write`, `templates:read`, `reports:read`, `exports:write`, `webhooks:manage`) + `SCOPE_PERMISSIONS`. Frontend scope UI `src/features/settings/ApiKeysTab.tsx`.
  - Pattern example: `src/modules/contacts/contacts.routes.ts` (`apiRead = access({ permission: 'contacts.read', scope: 'contacts:read' })`).
  - Spec: `src/openapi.ts` (imports every `*.schema.ts` / `*.openapi.ts`), `src/shared/openapi/{registry,responses,zod}.ts` (`PUBLIC_API_TAG`, `bearerOrKey`, `errors[401…429]`, `ok()`), `npm run gen:openapi` → `openapi/openapi.json`, `npm run openapi:check`.
  - Public spec / UI: `src/modules/docs/public-spec.ts` (`buildPublicSpec`: ops tagged `Public API` + reachable schemas, guides as `info.description`), `docs.routes.ts` + `docs.page.ts` (Swagger UI `/api/docs`, own CSP, `init.js` file, mode `public` in production / `full` with `API_DOCS_ENABLED`), `openapi.controller.ts` (`/api/v1/openapi.json`, `/api/v1/openapi.public.json`).
  - Guides: `docs/api/{getting-started,errors,idempotency,rate-limits,pagination,webhooks,changelog}.md` → `npm run gen:guides` (`scripts/generate-docs-guides.ts`) → `src/modules/docs/guides.gen.ts` (committed; `tests/docs/guides.test.ts` checks drift); order `src/modules/docs/guides.ts` `GUIDE_ORDER`.
  - Webhooks: `src/modules/webhooks/events.ts` (`WEBHOOK_EVENT_TYPES` 11, `WEBHOOK_API_VERSION = '2026-10'`, `emitAccountEvent`, `withoutPersonalData`), `src/modules/webhooks/publish.ts`, payload docs in `docs/api/webhooks.md`.
  - Catalogue tests: `tests/calls-wa/catalogue.test.ts` (error / audit / notification / permission / ledger / WS counts), `tests/security/phase15-routes.test.ts` (scope × route matrix snapshot + `idFor` record map), `tests/security/rate-limits.test.ts` (`npm run gen:rate-limits` → `docs/security/RATE_LIMITS.md`), `src/shared/errors/error-codes.test.ts`.
- **49 public operations today** (tag `Public API`, schema files): `calls/calls.schema.ts`, `campaigns/campaigns.schema.ts`, `contacts/contacts.schema.ts`, `insights/insights.schema.ts`, `post-call/rules.schema.ts`, `public-api/messages.schema.ts`, `record-exports/record-exports.schema.ts`, `reports/reports.schema.ts`, `templates/templates.openapi.ts`, `webhooks/endpoints.schema.ts`, `whatsapp-calling/calling.openapi.ts`, `api-keys` (whoami).
- **Measured gaps:** 0 / 49 ops have `description`; 9 / 49 have examples; no `operationId`; no `servers`; changelog stops at Phase 15; `phase15-routes.test.ts` fails on `main` (2 cases: `GET /whatsapp/channels/{id}/calling/quote` missing from `idFor` + snapshot).
- **Not public today (needed for IDs):** `GET /flows` (`modules/flows/flows.routes.ts`, `router.use(authenticate())`), `GET /agents` (`modules/ai-agents/agents.routes.ts`), `GET /whatsapp/channels` (`modules/whatsapp/whatsapp.routes.ts`), `GET /contact-lists`, `GET /segments`, `GET /phone-line`, `GET /voice-api/ivrs`, `GET /wallet`. WhatsApp bulk campaigns `modules/whatsapp-campaigns/campaigns.routes.ts` (`/`, `/:id`, `/:id/estimate|start|pause|resume|stop|retry-failed|recipients|export|report`) are session-only.
- **Permissions that exist:** `flows.read`, `agents.read`, `whatsapp.read`, `contacts.read`, `account.read`, `wallet.read`, `campaigns.read|write|run`, `whatsapp.campaigns.read|write`.
- **Memory rules:** full suites ek baar (serial — parallel heavy runs ne Mongo crash kiya tha); deploy sirf client repo flow se (yahan nahi).

## 1. Goal

Ek customer sirf docs padh kar (dashboard me ID copy kiye bina) API key bana sake, saare IDs API se nikaal sake, contacts / WhatsApp templates / calls / teeno campaign types (SIP-phone, WhatsApp call, recorded voice) + WhatsApp bulk campaigns chala sake, results webhook ya polling se le sake — aur har route ka description, example, scope, errors, limits docs me sahi ho (CI enforce kare). Postman + code samples download ho sakein.

## 2. Scope

**In:** DOCS-T1…T9 (audit + CI quality guard, resource read endpoints + scope, bulk campaigns + webhook events in API, OpenAPI quality pass for every public route, guides rewrite + new guides, Swagger UI + Postman + in-app links, examples smoke script, minimal tests, docs / release).

**Out (mat karna):** sandbox / test keys, SDK packages (npm / pip), alag developer website, breaking changes to existing routes / payloads, new write endpoints for flows / agents / channels, push / merge / deploy.

## 3. Rules of engagement

1. No questions — §4 follow; gap ho to safest additive choice + report.
2. Branch `git switch -c feature/public-api-docs` from `main` in both repos (exists → switch + resume).
3. One commit per task per touched repo, Conventional Commit + `[DOCS-Tn]`, hooks must pass, `Co-Authored-By` footer jaise pichhle commits me. No push / merge.
4. **Sab changes additive**: existing request / response fields, status codes, error codes, webhook payload fields remove / rename nahi; `apiVersion` `2026-10` hi rahe.
5. Har new public route account-scoped (`tenantFilter`), other account → 404, key ke liye per-key limits + request log apne aap (public gate).
6. Secrets / provider internals kabhi response me nahi (Meta tokens, SIP creds, provider cost / markup, webhook secrets except existing shown-once flows, Cell24x7 data).
7. Examples me sirf fake data: phones `+919000000001…`, names `Asha Verma` / `Ravi Kumar`, ids `6720f0a1b2c3d4e5f6a7b8c9` style, keys `cav_live_xxxxxxxxxxxx` placeholder. Real key / token / number kabhi nahi.
8. Har schema / catalogue change usi task me: OpenAPI regen, frontend `npm run gen:api`, catalogue count tests, `gen:rate-limits`, docs.
9. Long runs background me with real exit codes; full suites sirf T9.

## 4. Locked decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | Docs URL `https://<host>/api/docs` (Swagger UI, public mode in production). Downloads: `/api/v1/openapi.public.json`, `/api/v1/postman.json`                                                                                                                                                                                              |
| L2  | New scope **`resources:read`** (group "Account", "Read flows, AI agents, WhatsApp numbers, lists, segments, caller numbers and wallet balance") → permissions `flows.read, agents.read, whatsapp.read, contacts.read, account.read, wallet.read`                                                                                          |
| L3  | New scopes **`whatsapp-campaigns:read`** → `whatsapp.campaigns.read`; **`whatsapp-campaigns:write`** → `whatsapp.campaigns.read, whatsapp.campaigns.write` (group "WhatsApp"). Total scopes 13 → 16                                                                                                                                       |
| L4  | `GET /whatsapp/channels/{id}/calling/quote` stays public with `calls:write` — add to `idFor` record map + update snapshot                                                                                                                                                                                                                 |
| L5  | Every public op: `operationId` (unique camelCase verbNoun), `description` (≥ 40 chars, Markdown: what, scope, limits, idempotency, side effects, main error codes), `x-scope` (string or list), request example (if body), 2xx example, error refs 401 / 403 / 404 (if `{id}`) / 422 / 429 (+409 where state matters). Enforced by a test |
| L6  | Spec level: `servers: [{ url: 'https://wa.notifynow.in/api/v1', description: 'Production' }]` in the **public** spec only (full spec unchanged), tag order + tag descriptions (L7), API key scheme description                                                                                                                            |
| L7  | Tag order in public spec: Getting started (whoami), Account resources, Contacts, WhatsApp messages, WhatsApp templates, Calls, WhatsApp calls, Campaigns, WhatsApp bulk campaigns, Reports, Exports, Webhooks. Public spec ops keep `Public API` tag **plus** one area tag (existing area tags reused)                                    |
| L8  | Webhook events added (additive): `whatsapp_campaign.completed`, `whatsapp_campaign.paused`; `campaign.completed` payload gains `line` (`phone` / `whatsapp` / `voice_api`). Total events 11 → 13                                                                                                                                          |
| L9  | Resource routes return **minimal views** (§DOCS-T2 table); lists ≤ 200 rows (no cursor) except where existing routes already paginate                                                                                                                                                                                                     |
| L10 | Postman collection v2.1 generated from the public spec (`{{baseUrl}}`, `{{apiKey}}` header `X-API-Key`, folders = tags, examples as saved responses); committed `openapi/postman.json`, drift check like `openapi:check`                                                                                                                  |
| L11 | Code samples in guides: curl, Node (fetch), Python (requests), PHP (curl) — for the main flows, not every route                                                                                                                                                                                                                           |
| L12 | Error table in `docs/api/errors.md` generated (`npm run gen:api-errors`) from `error-codes.ts` filtered to codes reachable from public routes (list maintained in `src/modules/docs/public-errors.ts`)                                                                                                                                    |

## 5. Resume safety

`git branch --show-current` + `git log --oneline -20` dono repos; last `[DOCS-Tn]` ke baad wale task se continue; uncommitted work preserve.

## 6. Tasks

### DOCS-T1 — Audit script + quality guard + fix the broken route test

1. `scripts/docs-audit.ts` (`npm run docs:audit`): build public spec in-process (`buildPublicSpec` on the generated registry doc), write `docs/api/_audit.md` table: method, path, operationId, x-scope, description chars, request example, 2xx example, error refs, tags. Not served; committed for review.
2. `tests/docs/public-spec-quality.test.ts`: for each public op assert L5 rules + unique `operationId` + `x-scope` values ∈ `API_KEY_SCOPES`; public spec has `servers` (L6) and tag order (L7). Mark it `it.todo`-free: it fails now and turns green after T4 (commit T1 with the test **skipped via a `QUALITY_ENFORCED` const = false**; T4 flips it to true — no assertion weakening).
3. Fix L4: `tests/security/phase15-routes.test.ts` `idFor` → `/api/v1/whatsapp/channels/` returns a real channel id from the seed; update snapshot (`-u` only for that file) and verify the 2 cases pass.

**VERIFY:** audit file generated; quality test file runs (skipped mode) ; phase15-routes passes.
**Commit:** `test(docs): audit the public API spec and fix the route matrix [DOCS-T1]`

### DOCS-T2 — Account resource endpoints (`resources:read`)

1. `scopes.ts`: add `resources:read` (L2) + `SCOPE_PERMISSIONS`; frontend `ApiKeysTab` shows it (labels come from `GET /api-keys/scopes`; check UI grouping); update scope count tests.
2. Make these routes key-capable with `authenticate({ apiKeys: true })` + `access({ permission, scope: 'resources:read' })` **only on these GETs** (other routes in the same router stay session-only), tag `Public API` + area tag "Account resources", minimal views:

| Route                         | Permission                                           | Response (minimal)                                                                                                                                                |
| ----------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /flows?status=published` | `flows.read`                                         | `id, name, status, publishedVersion, triggers, agents[{ id, name }], updatedAt` (no graph, no secrets)                                                            |
| `GET /agents?active=true`     | `agents.read`                                        | `id, name, language, voice, isActive, updatedAt` (no prompts, no function secrets)                                                                                |
| `GET /whatsapp/channels`      | `whatsapp.read`                                      | `id, label, displayPhoneNumber, status, mode, messagingLimitTier, qualityRating, messagesPerSecond (18/75 policy), calling: { status, ready, unavailableReason }` |
| `GET /contact-lists`          | `contacts.read`                                      | `id, name, contactsCount, updatedAt`                                                                                                                              |
| `GET /segments`               | `contacts.read`                                      | `id, name, updatedAt`                                                                                                                                             |
| `GET /phone-line`             | `account.read`                                       | existing view (`line`, `numbers`, `voiceApi.enabled`)                                                                                                             |
| `GET /voice-api/ivrs`         | `campaigns.write` (session) / `resources:read` (key) | `{ id, name }[]`                                                                                                                                                  |
| `GET /wallet`                 | `wallet.read`                                        | for keys: `balanceMicros, availableMicros, holdMicros, creditLimitMicros, currency` only (session view unchanged)                                                 |

If a dashboard route already returns a richer view, add a `view=public` mapping for key requests (never leak extra fields to keys); keep session responses identical. 3. OpenAPI: register key responses as separate schemas (`PublicFlow`, `PublicAgent`, `PublicWhatsAppChannel`, `PublicContactList`, `PublicSegment`, `PublicWallet`) with examples. 4. `tests/public-api/resources.test.ts` (one file): key with `resources:read` → 200 + only allowed fields (assert no `graph`, `prompt`, `token`, `secret`, `metaCost` keys anywhere); key without scope → 403; other account's id paths → 404; session unchanged (one snapshot of field keys).

**VERIFY:** new test, phase15-routes (matrix snapshot update for the new routes), api-keys tests, catalogue counts; `gen:openapi`, `gen:rate-limits`, frontend `gen:api` + typecheck.
**Commit:** `feat(public-api): read flows, agents, numbers, lists and wallet with an API key [DOCS-T2]`

### DOCS-T3 — WhatsApp bulk campaigns + campaign lines + webhook events

1. Scopes L3; `modules/whatsapp-campaigns/campaigns.routes.ts`: every route gets `authenticate({ apiKeys: true })` + `access({ permission: 'whatsapp.campaigns.read|write', scope: 'whatsapp-campaigns:read|write' })`; start keeps its required `Idempotency-Key`; tag `Public API` + "WhatsApp bulk campaigns". Login-as / impersonation guards unchanged.
2. `campaigns.schema.ts` docs: `POST /campaigns` gets **three named examples** (`phoneFlow`, `whatsappAgent`, `recordedVoice`) and the estimate / contacts responses show `voice` fields; list query `line` documented (`phone` lists phone + recorded voice).
3. Webhooks L8: add the 2 events to `WEBHOOK_EVENT_TYPES`, emit from `modules/whatsapp-campaigns/lifecycle.ts` completion / pause (via existing `emitAccountEvent` in the same transaction pattern as `publishCampaignCompleted`), payload: `{ campaignId, name, status, pauseReason?, counts: { recipients, sent, delivered, read, replied, failed }, chargedMicros }`; `campaign.completed` adds `line`. `withoutPersonalData` (no personal fields here). Endpoint event picker in frontend lists them (labels).
4. `docs/api/webhooks.md`: events table + payload samples for the 2 new events and the new field.
5. `tests/public-api/whatsapp-campaigns-key.test.ts` (one file): key with write scope creates → estimates → starts (same Idempotency-Key twice → same campaign, one start) → stops; read-only key gets 403 on start; webhook outbox row for `whatsapp_campaign.completed` with the documented payload keys.

**VERIFY:** new test + existing `tests/whatsapp-campaigns/*` affected files + webhooks tests + catalogue (events 13, scopes 16) + phase15-routes snapshot.
**Commit:** `feat(public-api): run WhatsApp bulk campaigns with an API key [DOCS-T3]`

### DOCS-T4 — OpenAPI quality pass (every public route)

For **every** public op (49 + T2 + T3 ≈ 72) in the 12+ schema files:

1. `operationId` (list in `docs/api/_audit.md`, e.g. `listContacts`, `createContact`, `bulkUpsertContacts`, `startCall`, `sendTemplateMessage`, `startCampaign`, `startWhatsAppCampaign`, `listFlows` …).
2. `description` per L5 — include: required scope, permission note, rate-limit class (read / write), idempotency (where `Idempotency-Key` is required or honored), side effects (wallet hold / charge, sends, dials), important error codes with one-line meaning, pagination style.
3. Examples (OpenAPI `example` / `examples`) for request bodies and the main 2xx response; error example for the most common 4xx of that route (envelope `{ success: false, code, message, details }`).
4. `x-scope` extension on each op (add a helper in `shared/openapi/responses.ts`: `publicOp({ scope, ... })` to avoid copy-paste).
5. `public-spec.ts`: add `servers` (L6), tag order + descriptions (L7), API key scheme description (where to create, header name, scopes link), `externalDocs` → `/api/docs`.
6. Flip `QUALITY_ENFORCED = true` in the T1 test; it must pass with **no exceptions list**.

**VERIFY:** quality test green, `openapi:check`, `docs:audit` regenerated (all columns filled), frontend `gen:api` + typecheck, `tests/docs/*`.
**Commit:** `docs(api): describe and exemplify every public route [DOCS-T4]`

### DOCS-T5 — Guides

Rewrite / add `docs/api/*.md` (English, short sentences, tables, code blocks per L11), update `GUIDE_ORDER`, `npm run gen:guides`:

| File                                                         | Must cover                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getting-started.md` (update)                                | create key (Settings → API keys, owner / admin), choose scopes, whoami, base URL, first calls: list flows / numbers (T2) → upsert contact → send template → start a call                                                                                                                           |
| `authentication.md` (new)                                    | header, all 16 scopes table (generated block from `scopes.ts` via `gen:guides` placeholder `<!-- scopes -->`), IP allowlist, expiry, rotation, revoke (≤ 30 s), request log, 401 vs 403 vs 404                                                                                                     |
| `conventions.md` (new)                                       | E.164, micros (₹1 = 1,000,000), ISO-8601 UTC + account timezone, ids, `externalRef`, masking (`phoneLast4`), envelopes                                                                                                                                                                             |
| `errors.md` (update)                                         | envelope + generated table L12 (`<!-- errors -->` block) + what to retry                                                                                                                                                                                                                           |
| `idempotency.md`, `pagination.md`, `rate-limits.md` (update) | current numbers (generated from `config/limits.ts` where possible), `Retry-After`, backoff example                                                                                                                                                                                                 |
| `whatsapp-messages.md` (new)                                 | numbers (T2), templates list, template send with variables + header media + buttons, text inside 24 h, statuses + webhook, pricing categories, opt-out / DND behaviour                                                                                                                             |
| `calls.md` (new)                                             | flow vs agent, ids from T2, `manualVariables`, test line vs SIP, results, transcript, insights, after-call, costs                                                                                                                                                                                  |
| `whatsapp-calls.md` (new)                                    | permission rules, quote, start AI / human call, statuses, billing, errors                                                                                                                                                                                                                          |
| `campaigns.md` (new)                                         | lifecycle create → estimate → start (Idempotency-Key) → pause / resume / cancel → contacts / export / webhook; three lines with full examples; recorded voice (batches, charge at send, Stop limit, Indian mobiles only); WhatsApp bulk (templates only, A/B, 18 / 75 msgs/sec, tiers, recurrence) |
| `reports-exports.md` (new)                                   | tabs, range ≤ 366 days, compare, export job polling + 15-min link, masked phones                                                                                                                                                                                                                   |
| `webhooks.md` (update)                                       | 13 events, payloads, signature verify (keep Node / Python / PHP), retries, disable rules, replay, ordering                                                                                                                                                                                         |
| `versioning.md` (new)                                        | `2026-10`, additive policy, deprecation (6 months, changelog + e-mail to key owners), how to pin webhook payload version                                                                                                                                                                           |
| `changelog.md` (update)                                      | Phase 18 (SIP), Phase 19 (campaign lines, WhatsApp call campaigns, bulk campaigns), VAPI (recorded voice), DOCS (resources, bulk API, events, docs) — dated                                                                                                                                        |
| `troubleshooting.md` (new)                                   | top 15 codes with fixes, request log, IP allowlist, clock skew for signatures, support contact                                                                                                                                                                                                     |

`scripts/generate-docs-guides.ts`: support the generated blocks (`<!-- scopes -->`, `<!-- errors -->`, `<!-- limits -->`); `tests/docs/guides.test.ts` stays the drift check. `npm run gen:api-errors` = part of `gen:guides` (one command).

**VERIFY:** `gen:guides` clean diff after commit, guides test, quality test, public spec renders (`buildPublicSpec` unit test).
**Commit:** `docs(api): rewrite the public API guides [DOCS-T5]`

### DOCS-T6 — Docs UI, Postman, in-app links

1. `docs.page.ts` / `init.js`: `persistAuthorization: true`, `filter: true`, `docExpansion: 'none'`, `operationsSorter` off (tag order L7), NotifyNow title + logo (`assets/` served same-origin, CSP-safe), header bar links "Download OpenAPI", "Download Postman" (static HTML, no inline script).
2. `scripts/gen-postman.ts` (`npm run gen:postman`, part of `gen:openapi`): L10 → `openapi/postman.json`; route `GET /api/v1/postman.json` (public, cached 1 h, `Content-Disposition: attachment; filename="notifynow-api.postman_collection.json"`); `openapi:check` also diff-checks it.
3. Frontend: Settings → API keys: buttons "Open API docs" (`/api/docs`, new tab), "Download Postman", scope descriptions incl. new scopes; Integrations page link "API & webhooks docs". Labels for the 2 new webhook events in the endpoint form.
4. `deploy/production/nginx/*.template` + staging: ensure `/api/docs*`, `/api/v1/openapi.public.json`, `/api/v1/postman.json` proxied, `Cache-Control: public, max-age=3600` for the JSON files.

**VERIFY:** `tests/docs/*` (page / init / CSP), postman drift check, frontend api-keys test updated, frontend typecheck / lint.
**Commit:** backend `feat(docs): brand the API docs and serve a Postman collection [DOCS-T6]`; frontend `feat(settings): link the API docs and Postman collection [DOCS-T6]`

### DOCS-T7 — Examples smoke (docs tell the truth)

`scripts/api-docs-smoke.ts` (`npm run docs:smoke`, NOT in CI): start the app in-process with fake Meta / fake voice / dry-run line (pattern of `scripts/smoke.ts` / e2e helpers), create a test account + owner + API key with all scopes, seed one flow / agent / channel / list; then for **every public op with a request example**: substitute ids, send it, assert the status is one of the documented 2xx and the body validates against the response schema (ajv on the public spec). Print a table; exit 1 on any mismatch. Run once; fix spec / examples / code (never the assertion) until green. Save the output table in `docs/api/_smoke.md`.

**VERIFY:** `npm run docs:smoke` exit 0.
**Commit:** `test(docs): verify every documented example against the API [DOCS-T7]`

### DOCS-T8 — Docs + catalogues

Backend + frontend CHANGELOG, `src/README.md` (docs section), root README "API docs" lines, `docs/conventions/api.md` (public op rules L5, how to add a public route: `publicOp`, tags, examples, scope, tests), `docs/security/THREAT_MODEL.md` / `DATA_MAP.md` (new key-readable fields), `docs/ops/release-public-api-docs.md` (scopes 16, events 13, new routes, no migration, nginx change), plan status.
**Commit:** `docs(api): record the public API docs release [DOCS-T8]`

### DOCS-T9 — Final checks + sign-off

1. Backend: `lint`, `typecheck`, `build`, `openapi:check` (incl. postman), `npm test` **once** with `--no-file-parallelism` if Mongo pressure appears; Frontend: `lint`, `build`, `npm test` once. Rerun only failed files; separate pre-existing failures (check on `main` in a temp worktree) from new ones.
2. `npm run docs:smoke` once more on the frozen candidate.
3. `docs/phases/PUBLIC_API_DOCS_SIGNOFF.md`: tasks ✅ / ⚠️, op count, quality test result, smoke table summary, scopes / events / routes added, known pre-existing failures, live checks left (production `/api/docs` opens in public mode, downloads work, a real key: whoami + list flows).
   **Commit:** `docs(api): record public API docs sign-off [DOCS-DONE]` (both repos if frontend changed after T6).

## 7. Tests (sirf yeh)

| File                                              | Covers                                                                                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `tests/docs/public-spec-quality.test.ts`          | L5 / L6 / L7 for every public op                                                                                                   |
| `tests/public-api/resources.test.ts`              | T2 scope, minimal fields, 404 / 403                                                                                                |
| `tests/public-api/whatsapp-campaigns-key.test.ts` | T3 key flow + idempotent start + event payload                                                                                     |
| existing (update only)                            | `phase15-routes` snapshot / `idFor`, catalogue counts (scopes 16, events 13), `guides.test.ts`, api-keys tab test, rate-limits doc |

## 8. Final report (short Hinglish)

1. Har task ✅ / ⚠️ / ❌ + 1 line. 2. Commits dono repos. 3. Op count + quality test + smoke result. 4. Test / build numbers + pre-existing failures. 5. Live checks bache. 6. Push / deploy: "nahi kiya".
