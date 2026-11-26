# Prompt: finish the IVR (Cell24x7) work, add a template-create API, and show the Pinnacle API to superadmins (ITP)

> **Who runs this:** the coding agent working in `cell-ai-voicebot-backend` + `cell-ai-voicebot-frontend`.
> **Plan:** [IVR_TEMPLATE_API_PINNACLE_PLAN.md](../plans/IVR_TEMPLATE_API_PINNACLE_PLAN.md).
> **Goal in one line:**
>
> 1. Close what's left of recorded voice / IVR on Cell24x7 (`voice.truebeeps.com`), with every check possible from the panel.
> 2. Let API keys create / submit / edit / delete WhatsApp templates, documented next to the other public APIs.
> 3. Show the Pinnacle partner API (endpoints + the account's configured key) to **superadmins only**.
>
> **Work order:** task by task, ITP-T0 → TPL-T1…T8 → PIN-T1…T8 → IVR-T1…T11 → ITP-T9 / T10. Finish a task, run its tests, then move on.
>
> **Repo rules:**
>
> - zod → OpenAPI → `gen:api` in the frontend;
> - the error-code / audit / notification / webhook-event catalogues and their docs;
> - CHANGELOGs;
> - conventional commits (lowercase subject, tag `[TPL]` / `[PIN]` / `[IVR]`);
> - each test suite once per phase; the full backend suite in groups of ≤ 8 files with `--maxWorkers=4` (the in-memory Mongo crashes on one big parallel run).

---

## 0. Hard constraints (apply to every task)

| #   | Constraint                                                                                                                                                                                                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | **No new env variables.** The live `.env` can't change. New settings are constants in `src/config/*.ts` (e.g. `VOICE_API_CONFIG`, a new `PARTNER_API_CONFIG`).                                                                                                                                                                |
| C2  | **No server access.** Every check is in the panel: Admin, Settings, Campaigns. Never rely on `docker logs` or `curl` on the server.                                                                                                                                                                                           |
| C3  | **Secrets.**<br>• A Cell24x7 token, a Pinnacle API key or a webhook secret is never written to a log, an audit `meta`, an API response (except the step-up Reveal, PIN-T3), an export, a test snapshot or a commit.<br>• Logs carry `last4` at most.<br>• The env the user pasted in chat earlier must never appear anywhere. |
| C4  | **Migrations** (if any) are additive and idempotent, and the code must work before the migration runs. Prefer no migration.                                                                                                                                                                                                   |
| C5  | **Release:** `main` in both repos → `scripts/sync-client-repo.sh <be> <fe>` (dry run first, release tag, secret scan, never force push).                                                                                                                                                                                      |
| C6  | **Phone numbers:** never in logs. Masked to `…last4` in admin / superadmin views of provider answers.                                                                                                                                                                                                                         |
| C7  | **Superadmin-only means backend-enforced** (`requirePlatformAdmin` or the full-access-superadmin check), never only hidden in the UI.                                                                                                                                                                                         |

## 1. Decisions (final)

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Owner open questions → defaults:<br>(a) PDF-dependent items (`/report`, a credits endpoint, the exact `/details` fields) are built behind "if the PDF names it". With no PDF the task is skipped and noted in the sign-off.<br>(b) The test call is a button that only runs when a superadmin presses it with an "owner's OK" checkbox. Never automatic.<br>(c) API keys may **not** create the call-permission template.<br>(d) Pinnacle key **Reveal** is allowed with a step-up and is audited. |
| D2  | A template API key scope `templates:write` → permission `templates.manage`.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| D3  | Pinnacle partner-API "Try it" covers **read-only** ops only, through our backend. The key never reaches the browser except on Reveal.                                                                                                                                                                                                                                                                                                                                                              |
| D4  | Cell24x7 incoming: not possible on this provider. Say so in the UI and docs. No code for it.                                                                                                                                                                                                                                                                                                                                                                                                       |
| D5  | New webhook event `template.status_changed` (public contract, versioned like the others).                                                                                                                                                                                                                                                                                                                                                                                                          |

---

## ITP-T0: groundwork (no behaviour change)

1. `git status` both repos. **Ask the owner** whether the uncommitted WCF fix (inbound fast path `inboundChannelFor`, Test calling API `send` step, code-10 hint, its tests + changelog) ships first or is dropped. If it ships: commit it alone (`fix(whatsapp-calling): … [WCF]`) before any ITP work.
2. Read these files fully and list the gaps in the PR description:
   - **Voice API:**
     - `src/config/voice-api.ts`;
     - `src/core/voice-api/{cell24x7.client,fake.client,types,index}.ts`;
     - `src/modules/voice-api/*`;
     - `src/modules/campaigns/voice-api/{batch,results,jobs,settings}.ts`;
     - the voice wizard + detail in `features/campaigns`;
     - the Admin Cell24x7 card (`features/admin` SIP trunk);
     - `docs/integrations/cell24x7-voice.md`, `docs/phases/VOICE_API_SIGNOFF.md`.
   - **Templates:**
     - `src/modules/templates/{templates.routes,template.service,validate,example-media.service,notify,webhooks}.ts`;
     - `src/modules/api-keys/scopes.ts`;
     - `src/shared/middlewares/access.ts`;
     - `src/modules/docs/{public-docs,public-spec,guides,quality}.ts`;
     - `src/modules/webhooks/{events,publish,samples}.ts`;
     - frontend `services/api/api-keys.ts`, `features/settings/ApiKeysTab.tsx`.
   - **Pinnacle:**
     - `src/core/meta/pinnacle.client.ts`, `fake-pinnacle.ts`;
     - `src/modules/whatsapp/whatsapp-admin.{routes,service}.ts`;
     - `docs/integrations/pinnacle.md`;
     - `src/modules/auth/login-as-session.ts` (`requireStepUp`);
     - `src/shared/auth/impersonation.ts`;
     - `src/shared/middlewares/require-permission.ts` (`requirePlatformAdmin`);
     - the frontend admin account page (WhatsApp section) and `StepUpDialog.tsx`.
3. Write the current failing tests (on `main`, groups of 8) into the sign-off as "known before ITP": tts-cache purge, recurrence, phase15 quote, if still there.
4. Ask for / look for `Cell24x7_Voice_API.pdf` and Pinnacle's partner API document. Note what they contain (endpoints, field names, rate limits). Missing = D1(a).

---

## Part A: template-create API (TPL)

### TPL-T1: scope

- `src/modules/api-keys/scopes.ts`:
  - `API_KEY_SCOPE_INFO['templates:write'] = { group: 'WhatsApp', description: 'Create, submit, edit and delete WhatsApp templates' }`;
  - `SCOPE_PERMISSIONS['templates:write'] = ['templates.read', 'templates.manage']`.
- Keep `templates:read` as is.
- Check the key create / edit validation accepts the new scope, and the scope list docs (`docs/api/*`, `api.md §12` table) include it.
- Frontend `services/api/api-keys.ts` (scope list / `scopesByGroup`) and the picker in `ApiKeysTab.tsx` show it under **WhatsApp**.
- **Tests:**
  - backend: a key create with `templates:write` → stored;
  - frontend: the picker shows the box and the edit keeps it.

### TPL-T2: routes open to keys

In `src/modules/templates/templates.routes.ts`, swap `...manage` / `read` for `access(...)` on:

| Method / path                              | access                                                                                         | Notes                                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `POST /whatsapp/templates`                 | `{ permission: 'templates.manage', scope: 'templates:write' }`                                 | body may carry `submit: true` + `channelId` → create then submit in one request |
| `GET /whatsapp/templates/{id}`             | `{ permission: 'templates.read', scope: 'templates:read' }` (`templates:write` keys also pass) | detail with the components                                                      |
| `PATCH /whatsapp/templates/{id}`           | write scope                                                                                    | Meta's edit limits unchanged                                                    |
| `POST /whatsapp/templates/{id}/submit`     | write scope                                                                                    |                                                                                 |
| `POST /whatsapp/templates/{id}/media`      | write scope                                                                                    | multipart `file` (image / video / document per header format)                   |
| `DELETE /whatsapp/templates/{id}`          | write scope                                                                                    | `?scope=name` = every language                                                  |
| `PATCH /whatsapp/templates/{id}/variables` | write scope                                                                                    | variable sources                                                                |

- **Never opened to keys:** `POST /templates/sync`, `POST /templates/call-permission` (D1c).
- `blockWhenImpersonating()` stays for dashboard sessions: keep it in the chain, as `access` already does for sessions.
- `GET /whatsapp/templates` with a key:
  - `templates:read` only → APPROVED only (today's rule);
  - `templates:write` → the `status` filter is honoured, so a key can see its PENDING / REJECTED ones (D-T3 in the plan).
- **Rate limit:** key on `req.auth.apiKeyId` for keys and `userId` for sessions (`templates:<id>`). Same limit `TEMPLATE_LIMITS.createsPerHourPerUser`.
- **Idempotency:** apply the existing `Idempotency-Key` middleware to `POST /templates` and `/submit` (same key + same body → same answer; another body → `409 IDEMPOTENCY_KEY_REUSED`, or whatever the repo uses).

### TPL-T3: services accept an API-key actor

- `actorOf(req)` (templates routes) returns `{ type: 'api_key', id: apiKeyId, ip }` for keys.
- `createTemplate` / `submitTemplate` / `editTemplate` / `deleteTemplate` / `uploadHeaderExample` / `setVariableSources`:
  - `createdBy` = null for keys + new optional `createdByApiKeyId` on the template model (additive field, default null; no migration needed);
  - audit `template.*` with `actor.type = 'api_key'`, `meta.apiKeyId`;
  - bells ("submitted / approved") keep going to `templates.manage` users.
- Managed (Pinnacle) numbers: submit goes through `clientFor` (unchanged). Confirm with a test.
- `submit: true` on create:
  - create, then submit in the same request;
  - if submit fails after the create, answer `201` with the template (status `DRAFT`) + `submitError: { code, message }` rather than losing the draft;
  - document this.

### TPL-T4: webhook event `template.status_changed`

- `src/modules/webhooks/events.ts`: add `'template.status_changed'`.
- `samples.ts`: a sample payload.
- `publish.ts`: `publishTemplateStatus(template, previous)`, called from the templates webhook handler (`templates/webhooks.ts`) whenever status changes: APPROVED, REJECTED (+ reason), PAUSED, DISABLED, IN_APPEAL…
- **Payload:** `{ templateId, name, language, category, status, previousStatus, reason, channelIds, wabaId, at }`. No bodies, no personal data.
- Webhooks page (frontend) event list + docs (`docs/api/webhooks*.md`, the public docs event table).
- **Tests:** a status webhook from the fake Meta → one event delivered with the right payload; the same status twice → one event.

### TPL-T5: OpenAPI + public docs

- `templates.openapi.ts` (or wherever template paths are registered): every opened path is in the public spec with `x-scope`, request / response schemas, error responses (401 / 403 scope / 404 / 409 / 422 / 429 / 502).
- `src/modules/docs/public-docs.ts`, area **"WhatsApp templates"**, one entry per operation: `summary`, `area`, `scope`, a description that lists the rules (name `^[a-z0-9_]{1,512}$`, language, category UTILITY / MARKETING; AUTHENTICATION refused; header / body / footer / buttons limits; examples needed for variables; 250 / 6,000 limits per WABA; Meta's edit limits) and the errors.
- **Examples:**
  1. a utility template with `{{1}}` `{{2}}` + footer + 2 quick replies, `submit: true`;
  2. marketing with an IMAGE header: create → `POST /{id}/media` → `POST /{id}/submit`;
  3. named variables `{{customer_name}}`;
  4. a URL button with a variable suffix;
  5. the error example `TEMPLATE_INVALID` with field paths.
- Guide in `guides.ts`: **"Create a WhatsApp template by API"**. Steps: key with `templates:write` → create → (media) → submit → wait for `template.status_changed` (or poll `GET /{id}`) → send with `POST /whatsapp/messages/template` (link the existing op).
- `npm run gen:guides` if guides are generated.
- `gen:openapi`, `gen:postman`. Make sure `openapi.public.json` contains the new ops and the docs quality test passes (every public op has a description + example).

### TPL-T6: frontend

- API keys page: the new scope (TPL-T1).
- In-app API reference (if any list exists besides the `/api/docs` link): add the template ops next to the others.
- Templates page: a template created by API shows "Created by API key <name>" (reads `createdByApiKeyId` → the key name, via the template detail / list DTO).
- `gen:api`.

### TPL-T7: errors / catalogue checks

- Use only existing error codes. If a new one is needed (e.g. `TEMPLATE_SUBMIT_AFTER_CREATE_FAILED`), add it to `error-codes.ts`, `docs/conventions/error-codes.md` and the frontend texts.
- Catalogue tests: `tests/calls-wa/catalogue.test.ts` counts (if audit / error / notification counts change), the public-API route snapshot, the security route matrices (`phase15-routes`, `login-as-matrix`, `full-access-matrix`), the docs smoke test.

### TPL-T8: tests (`tests/templates/api-key-templates.test.ts` + frontend)

1. No key → 401. A key without `templates:write` → 403 with `details[0].path = 'scope'`. With the scope → 201.
2. Create a draft → `GET /{id}` → submit → PENDING (fake Meta). The fake approval webhook → APPROVED + one `template.status_changed`.
3. `submit: true` → PENDING in one call. A forced submit failure → 201 DRAFT + `submitError`.
4. Media header upload by key → submit carries the handle.
5. Edit within the limits; past the limit → the existing error.
6. Delete one / `?scope=name`.
7. A managed (Pinnacle) number → the submit hits the fake Pinnacle.
8. The same `Idempotency-Key` → the same template id; another body → the conflict error.
9. Rate limit per key (two keys don't share it).
10. Audit rows carry `apiKeyId`, never the key secret.
11. A `templates:read` key: the list shows APPROVED only; `templates:write`: the `status` filter works.
12. `POST /templates/sync` and `/templates/call-permission` with any key → 403 / 401.
13. A key of account A can't read / edit account B's template (404).
14. Frontend: the scope picker shows `templates:write`; Templates shows "Created by API key".

---

## Part B: Pinnacle partner API, superadmin only (PIN)

### PIN-T1: endpoint catalogue (constant)

- `src/modules/whatsapp/partner-api.catalogue.ts` exports `PARTNER_API_ENDPOINTS: readonly PartnerEndpoint[]`:
  ```ts
  interface PartnerEndpoint {
    id: string; // 'messages.send'
    group:
      | 'Key'
      | 'Callback'
      | 'Number'
      | 'Profile'
      | 'Messages'
      | 'Templates'
      | 'Media'
      | 'Register'
      | 'Calling';
    method: 'GET' | 'POST' | 'DELETE';
    path: string; // '/{phoneNumberId}/messages' (placeholders {phoneNumberId} {wabaId} {mediaId})
    host: 'base' | 'voice';
    summary: string;
    body?: Record<string, unknown>; // example
    response?: Record<string, unknown>;
    notes?: string;
    supported: boolean; // false = calling (provider_unsupported)
    tryIt: boolean; // true only for safe reads (PIN-T4)
  }
  ```
- **Fill it from `pinnacle.client.ts`** (and the Pinnacle doc from T0 if available):

  | Group     | Endpoints                                                                                                                                                                           |
  | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Key       | `GET /getuserdetails`                                                                                                                                                               |
  | Callback  | `POST /{phone}/setwebhook`, `GET /{phone}/getwebhook`                                                                                                                               |
  | Number    | `GET /business/{phone}`, `GET /business/{waba}/phone_numbers`                                                                                                                       |
  | Profile   | `GET` / `POST /business/{phone}/whatsapp_business_profile`                                                                                                                          |
  | Messages  | `POST /{phone}/messages` (text, template, media, interactive examples)                                                                                                              |
  | Templates | `GET` / `POST /{waba}/message_templates`, `DELETE /{waba}/message_templates?name=`                                                                                                  |
  | Media     | `POST /{phone}/media`, `GET /{mediaId}`, `GET /downloadMedia/{mediaId}`, `POST /app/uploads`                                                                                        |
  | Register  | `POST /{phone}/register`                                                                                                                                                            |
  | Calling   | `/{phone}/calls`, `/{phone}/settings`, `/{phone}/call_permissions` on the voice host: `supported: false` with the note "Pinnacle doesn't carry calling — use Calls via Meta direct" |

- `tryIt: true` only for: `getuserdetails`, `getwebhook`, `business/{phone}`, `business/{waba}/phone_numbers`, profile GET, `message_templates` GET.
- **Unit test:** every entry has a group / method / path / summary, the placeholders are known, `tryIt` only on GETs, no real ids or keys inside.

### PIN-T2: info service + route

- `src/modules/whatsapp/partner-api.service.ts` `partnerApiInfo(accountId)`:
  - finds managed channels (`provider: 'pinnacle'`, status ≠ disconnected) with `+tokenSealed`;
  - `configured` = any has a key.
- Returns:
  ```ts
  {
    configured,
    numbers: [{
      channelId, label, wabaId, phoneNumberId, displayPhoneNumber, status,
      keyLast4, keyCheckedAt,
      baseUrl, voiceBaseUrl,
      webhook: { url: `${APP_URL}/api/v1/webhooks/pinnacle/${id}`, headerName: 'x-cell-webhook-secret', setAt },
    }],
    endpoints: PARTNER_API_ENDPOINTS,
    errorFormat: { example: { code: 400, status: 'failed', message: '…' }, note: 'sometimes HTTP 200' },
  }
  ```
  (`baseUrl` = `PINNACLE_BASE_URL` + `/v3`, `voiceBaseUrl` = `PINNACLE_VOICE_BASE_URL`.) Never the key itself or the webhook secret.
- **Route** `GET /api/v1/admin/accounts/:id/partner-api` (`requirePlatformAdmin`).
- **Full-access path** `GET /api/v1/whatsapp/partner-api` (customer router): allowed only when `isFullAccess(req.auth)` **and** `impersonatorKind === 'superadmin'`. Anyone else → `403 AUTH_FORBIDDEN`. Account = the session's account.
- OpenAPI in the **internal** spec only. A test asserts it is not in `openapi.public.json`.

### PIN-T3: Reveal key (step-up)

- `POST /api/v1/admin/whatsapp/channels/:id/managed/api-key/reveal`:
  - `requirePlatformAdmin` + `requireStepUp()` (the superadmin's own password + 2FA, valid 5 min, from SAC);
  - the full-access twin `POST /api/v1/whatsapp/channels/:id/partner-api/reveal` with the same superadmin check + `requireStepUp()`.
- **Response:** `{ apiKey, keyLast4, expiresInSec: 60 }` with header `Cache-Control: no-store` and `Pragma: no-cache`.
- **Audit:** `whatsapp.managed_key_revealed` with `{ channelId, keyLast4 }` (never the key). Rate limit: 5 per hour per superadmin.
- Without a step-up → `428 STEP_UP_REQUIRED` (the frontend opens `StepUpDialog` and retries, as the existing api client already does).

### PIN-T4: Try it (read-only proxy)

- `POST /api/v1/admin/whatsapp/channels/:id/partner-api/try`, body `{ endpointId: string, params?: { name?: string; limit?: number } }`, plus the full-access twin.
- **Checks:**
  - `endpointId` must be in the catalogue with `tryIt: true`, else `422 PARTNER_API_OP_NOT_ALLOWED`;
  - the channel must be a managed one of that account with a key.
- **Pinnacle client:** add a `partnerGet(apiKey, path, query)` (same base URL, `apikey` header, timeout, error mapping, no retries on 4xx), plus the fake.
- **Response:**
  ```ts
  { endpointId, httpStatus, durationMs, body: masked(json) }
  ```
  `masked` = every string with ≥ 8 digits → `…last4`; drop any `apikey` / `token` / `secret` keys.
- Errors are returned as `{ ok: false, httpStatus, body }` (the raw partner error, masked) rather than thrown, so the console shows them.
- **Limits:** 20 per 10 min per superadmin (Redis); `PARTNER_API_CONFIG.tryPer10Min` in `src/config/partner-api.ts`.
- **Audit:** `whatsapp.partner_api_called` `{ channelId, endpointId, httpStatus }`.

### PIN-T5: catalogues + docs

- **Audit actions:** `whatsapp.managed_key_revealed`, `whatsapp.partner_api_called` (+ `docs/conventions/audit.md` rows).
- **Error code:** `PARTNER_API_OP_NOT_ALLOWED` (422) (+ `docs/conventions/error-codes.md`, frontend text).
- `docs/integrations/pinnacle.md`, a new section **"Partner API reference (superadmin)"**: where it is, who sees it, Reveal rules, Try-it ops, curl examples.
- `DATA_MAP`: the partner key can be revealed to superadmins (step-up, audited, never stored client-side).

### PIN-T6: frontend

- `src/features/admin/partner-api/`:
  - `PartnerApiPanel.tsx`, `EndpointTable.tsx`, `RevealKey.tsx`, `TryIt.tsx`;
  - `partner-api-texts.ts` (helpers in their own files, react-refresh rule);
  - `queries.ts`; API client `services/api/partner-api.ts`.
- **Panel:**
  1. **Header:** per number: label, WABA id / phone number id (copy), base URL + voice URL (copy), header `apikey`, key `pin_••••ab12` + **Reveal** (60 s countdown, copy, then masked again; no localStorage), the callback URL + header name, the error format box.
  2. **Endpoint table:** search box + group tabs.
     - Each row: method chip, path (with the ids filled in), summary, "unsupported" chip for Calling, expand → body / response JSON + **curl** (copy).
     - The curl uses `$PINNACLE_KEY` unless revealed, then the real key while the 60 s run.
  3. **Try it** button on `tryIt` rows → shows status, ms and the masked JSON.
- **Mounts:**
  - (a) Admin → Accounts → account → WhatsApp → each managed number card → a **"Partner API"** button → a drawer with the panel for that number;
  - (b) Settings → API keys → a card **"Partner API (Pinnacle) — superadmin only"**, rendered only when the session is a superadmin in Full access (`useIsFullAccess()` + impersonation `kind === 'superadmin'`) **and** `configured`.
- If `configured` is false (admin view): "No partner API key configured for this account — Add managed number (Pinnacle) in WhatsApp."
- `gen:api`, lint (helpers in their own files, no `Date.now()` in render).

### PIN-T7: tests

**Backend** (`tests/whatsapp/partner-api.test.ts`):

1. owner, admin, View login-as, reseller, API key → 403 / 401 on every route;
2. a full-access superadmin → 200;
3. an account with no managed key → `configured: false`; with one → the numbers + endpoints, no key, no secret in the JSON;
4. Reveal: no step-up → 428; after a step-up → the key, `no-store` header, audit row without the key; the 6th in an hour → 429;
5. Try it:
   - `getuserdetails` against the fake Pinnacle → 200 masked;
   - a write endpoint id → 422;
   - an unknown id → 422;
   - another account's channel → 404;
   - the 21st call → 429;
   - a partner error comes back as `ok: false` with the masked body;
6. a captured logger shows no key;
7. the public OpenAPI has none of these paths.

**Frontend:**

- the card hidden for an owner, shown for a full-access superadmin;
- the admin drawer renders the groups;
- Reveal → step-up → shown → masked after 60 s (fake timers);
- curl copy text uses `$PINNACLE_KEY` before Reveal;
- Try it renders JSON;
- Calling rows show "unsupported".

### PIN-T8: catalogue tests

- Audit / error counts in `tests/calls-wa/catalogue.test.ts`.
- Route matrices: superadmin routes are excluded from the dashboard matrix the same way other `/admin` routes are; the full-access twins are asserted refused for View and allowed for full.

---

## Part C: IVR / recorded voice on Cell24x7 (IVR)

### IVR-T1: Test connection (panel)

- **Backend:** `POST /api/v1/admin/accounts/:id/voice-api/test-connection` (`requirePlatformAdmin`).
  - Uses the account's token (or the platform token if the account uses it) → `GET /ivrs`.
  - Saves `account.voiceApi.lastCheck = { ok, reason: 'ok'|'timeout'|'dns'|'tls'|'refused'|'auth'|'no_credits'|'error', httpStatus, at }` (additive field, no migration).
  - Answers the same object.
  - Reuse the "cannot reach" reasons from `fix(voice-api): say why this server cannot reach cell24x7` (db45848).
- Audit `voice_api.connection_tested` `{ ok, reason }`.
- **Frontend:** the Cell24x7 card gets a **Test connection** button + the last result (✅ / ❌ + plain reason + time).

### IVR-T2: Send test call

- `POST /api/v1/admin/accounts/:id/voice-api/test-call`.
  - **Body:** `{ phone: 10-digit Indian mobile, content: { kind: 'audio', flowAudioId } | { kind: 'ivr', ivrId }, ownerApproved: true }`. `ownerApproved` must be `true` → else 422.
  - **Limit:** 3 per hour per account (`VOICE_API_CONFIG.testCallsPerHour`).
  - Creates a 1-number `line: voice_api` campaign flagged `isTest: true` (named `Test call <date>`, hidden from customer campaign lists, or listed with a "Test" chip — pick one and document it).
  - Runs the normal batch path (hold → submit → capture); the wallet is charged as usual.
  - Returns `{ campaignId, batchId }`.
- **Card:** live status of the last test (webhook / poll result: answered / not reached, duration, key pressed).
- Audit `voice_api.test_call_sent` `{ campaignId, phoneLast4 }`.

### IVR-T3: Last provider answer (field shape)

- In `cell24x7.client.ts`, after a successful `/details` page and in the webhook handler, save to Redis `voiceapi:lastshape:<accountId|platform>` (TTL 7 days):
  ```ts
  { source: 'details'|'webhook', keys: string[], statusValues: string[], sample: masked, at }
  ```
  masked = digits ≥ 8 → `…last4`, audio URLs dropped.
- `GET /api/v1/admin/accounts/:id/voice-api/last-shape` (superadmin) + a card section **"Last provider answer"** (keys list, statuses seen, the masked sample).
- **Unknown statuses:**
  - any status not in the status map → log `voice_api_unknown_status` (status only) + a superadmin bell `voice_api.unknown_status`, once a day per status;
  - the row is treated as "dialing" (not final) until polled again.
- After the live check (IVR-T11): set the parser to the confirmed field names. Keep the lenient fallbacks.

### IVR-T4: IVR key-press report

- Results already store the key pressed in `outcome.voiceApi` (check the field name in `results.ts`).
- **Campaign stats:** `ivrDigits: Record<string, number>` ("1", "2", …, "none"), counted once per number (on final).
  - Add it to the campaign stats DTO + public `GET /campaigns/{id}` (docs example).
  - If counters live in `campaign.stats`, add `$inc` in the same update as the final status (no double count). Otherwise compute with an aggregation on read, cached 60 s.
- **Frontend** campaign detail → Results tab: an "IVR key pressed" bar list with counts and %, plus a filter "pressed N" on the results table (query param `digit`).
- **Export:** a `Key pressed` column in the campaign contacts / calls CSV.
- **Webhook `call.completed`:** make sure `outcome.voiceApi.digit` is in the payload for `voice_api` calls (sample + docs).
- **Tests:** counts, the filter, the export column, the webhook payload.

### IVR-T5: provider `/report` reconciliation _(only if the PDF names `/report`)_

- `VoiceApiClient.report(requestId)` (+ fake).
- Daily job `voice.reconcile` (queue `campaigns` or wherever voice jobs run; cron in the existing scheduler list) for each batch with a request id in the last 3 days. It compares the provider totals (submitted / answered / credits) with ours.
- A difference > 2% → a row in `voiceApiReconcile` (or `campaign.voiceApi.reconcile` field) + a superadmin bell `voice_api.reconcile_mismatch`, once per batch.
- No money moves.
- Admin → System: the last run + mismatches count.
- **No PDF:** skip and note it in the sign-off.

### IVR-T6: credits / 402

- If the PDF has a balance endpoint: `balance()` + a card line "Cell24x7 credits: N" (Test connection also reads it) + a bell below `VOICE_API_CONFIG.lowCreditsAlert` (1,000).
- If not: the card shows "402 (no credits) in the last 24 h: N" from the existing pause records.

### IVR-T7: audio by API

- `/flow-audio` today is `authenticate()` (sessions only). Open it to keys:
  - `authenticate({ apiKeys: true })`;
  - `GET /flow-audio` → `access({ permission: <its read permission>, scope: 'campaigns:read' })`;
  - `POST /flow-audio` (upload) → `access({ permission: <its write permission>, scope: 'campaigns:write' })`;
  - `DELETE` stays dashboard-only.
- **Rules:**
  - the same type / size / duration rules (≤ 120 s, ≤ 10 MB, mp3 / wav / ogg / m4a for Cell24x7);
  - duration measured on the server;
  - the rate limit keyed per key.
- Public docs (area "Campaigns" or "Recorded voice"): upload example (multipart curl) + "use `flowAudioId` in `voiceApi.content`".
- **Tests:** a key upload works; the wrong scope → 403; an over-long audio → 422; another account's audio id in a campaign → 404 / 422.

### IVR-T8: health rules

- `health-rules.ts`:
  - `voice-api-unreachable`: an account with recorded voice on whose last Test connection / poll in the last hour had no answer;
  - `voice-api-uncertain`: an uncertain batch unresolved > 30 min.
- Admin → System status fields + `health-check.ts` texts + `incidents.md` rows + tests.

### IVR-T9: incoming not available

- The Cell24x7 card and the campaign wizard help text: "Incoming calls: not available on Cell24x7 — incoming calls come in on your phone line (SIP) or WhatsApp."
- `docs/integrations/cell24x7-voice.md`: an "Incoming" section.
- No code paths.

### IVR-T10: docs

- `cell24x7-voice.md`: Test connection, Test call, Last provider answer, the key-press report, reconcile (if built), credits, audio by API, health rules, incoming.
- `VOICE_API_SIGNOFF.md` "Live check" table (empty, filled in at IVR-T11).
- CHANGELOGs.

### IVR-T11: live check (owner present, panel only)

Fill this table in `VOICE_API_SIGNOFF.md`:

| #   | Check                                              | Expected                                                                                               |
| --- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | Admin → account → Cell24x7 → **Test connection**   | ✅ reachable, key valid                                                                                |
| 2   | **Send test call** to the owner's phone (owner OK) | the phone rings, plays the audio; the card shows answered + duration; the wallet ledger has the charge |
| 3   | IVR test call, press 1                             | key pressed "1" on the card and in the campaign report                                                 |
| 4   | **Last provider answer**                           | field names recorded → parser fix commit if needed                                                     |
| 5   | `/report` reconcile (if built)                     | no mismatch                                                                                            |

---

## ITP-T9: checks (both repos)

1. **Backend:**
   - `npx prettier --check src tests`, `npx eslint src tests --max-warnings=0`, `npx tsc --noEmit -p .`;
   - `npm run gen:openapi && npm run gen:postman` (committed), `npm run openapi:check`, `npm run docs:audit` (0 problems);
   - the new test files first;
   - then the full suite in groups of ≤ 8 files, `--maxWorkers=4`. Rerun failed groups alone; report only real failures + the known ones from T0.
2. **Frontend:** `npm run gen:api`, eslint `--max-warnings=0`, `npx tsc -b`, the new tests, the full suite `--maxWorkers=4` (rerun timeouts alone).
3. **Secret grep on the diff:** `mongodb+srv`, `sk-proj`, `META_APP_SECRET` values, `pin_` followed by real-looking keys, `Bearer ` with a token, `CELL24X7_VOICE_API_TOKEN=`. Nothing.
4. `git diff --stat` reviewed. No stray files: the scratchpad, `.env`, and the prompt files only if intended.

## ITP-T10: ship

1. Commits (lowercase, conventional):
   - `feat(templates): create, submit and delete templates with an api key [TPL]`
   - `feat(whatsapp): pinnacle partner api reference for superadmins [PIN]`
   - `feat(voice-api): test connection, test call, key-press report and health [IVR]`
   - `docs(itp): …`
2. Push `main` in both repos.
3. `scripts/sync-client-repo.sh <be> <fe> --dry-run`, then the real run. Note the release tag.
4. Tell the client team: pull + rebuild. No env change. Migrations only if one was added (prefer none).
5. `docs/phases/ITP_SIGNOFF.md`:
   - each task ✅ / skipped (with the reason, e.g. "no PDF");
   - deviations;
   - test results;
   - the panel live-check table:

   | #   | Check                                                            | Expected                                                                             |
   | --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
   | 1   | API key with `templates:write` → curl create with `submit: true` | PENDING                                                                              |
   | 2   | Approve at Meta / wait                                           | `template.status_changed` webhook received                                           |
   | 3   | Superadmin → account → managed number → **Partner API**          | endpoints listed; Reveal with step-up shows the key 60 s; Try it `getuserdetails` ✅ |
   | 4   | The same account's owner → Settings → API keys                   | no Partner API card                                                                  |
   | 5   | Full-access superadmin → Settings → API keys                     | the Partner API card shows                                                           |
   | 6   | Cell24x7 live checks                                             | IVR-T11 table                                                                        |

## Done means

- Every task of TPL, PIN and IVR is done or explicitly skipped (with the reason).
- No env change. No secret in code, logs, audit or the client repo.
- Superadmin-only routes are refused for everyone else (tests).
- Public docs show the template ops next to the others with examples.
- Tests are green except the known failures from T0.
- Both mains are pushed and the client repo is released.
- The sign-off is written.
