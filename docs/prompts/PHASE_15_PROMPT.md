# P15 RUN — Integrations, Public API & Webhooks (T15.1 → T15.10) — One-Paste Autonomous Run Prompt

> **HOW TO RUN — ek hi paste, poora phase. Beech mein kahin nahi rukna.**
>
> Phase 14 ki tarah: **ek paste = STEP 0 → Batch 1 → Batch 2 → Batch 3 → sign-off.** Checkpoint (`P15-B1-DONE`, `P15-B2-DONE`) pe sirf commit + chhota progress note likhna hai aur **usi turn mein agla task shuru karna hai** — owner ka wait nahi, "continue?" nahi.
>
> **Paste this (working directory `/Users/lalitbansal/Documents/cell-ai-voicebot`):**
>
> `cell-ai-voicebot-backend/docs/prompts/PHASE_15_PROMPT.md padho aur STEP 0 se P15-B3-DONE tak POORA Phase 15 (teeno batches) step by step autonomously implement karo. Kahin bhi mat ruko: na batch ke baad, na checkpoint pe, na kisi question ke liye — saare decisions is prompt + PHASE_15_PLAN.md me pre-made hain (owner defaults §1). Har task ke baad verify (har command alag) + commit (tag [P15-T15.x]). Checkpoint pe commit karke turant agla task. Koi push / merge NAHI. Context compact ho jaye to §3 RESUME SAFETY se wahin se aage chalo. Sirf P15-B3-DONE ke baad final report (Hinglish) do.`
>
> **Claude Code "auto / accept edits" mode me chalao.** **Docker Desktop chalu** (`open -a Docker`). **Mac charger par, lid khuli** — lambi runs `caffeinate -dims` ke saath. Doosre projects ke containers / processes **kabhi mat chhoona** (port 3100 doosre project ka hai).

---

## 0. CONTEXT (verified facts on 29 Oct 2026 — dobara derive mat karna)

**Branches:** `main` = backend `acf5d8b` (Phase 14 + NotifyNow brand), frontend `a6c9533`. Backend branch **`feature/phase-15-integrations`** exists with `baad510 docs: add phase 15 detailed plan [P15-PLAN]` (+ an uncommitted plan edit aligning screens with the `/integrations` nav item, and this prompt, uncommitted). Frontend branch is created at the first frontend task: `git switch -c feature/phase-15-integrations main`. **Never commit to `main`.** Other branches exist (`docs/app-review-notifynow` with `f613a64`, `feature/notifynow-brand`, `feature/phase-14-records-analytics`) — leave them alone.

**Production context:** the app is live for the client at `https://wa.notifynow.in` (brand **NotifyNow**, NotifyNow Private Limited) on the **client's** server and database. This run never connects to it, never deploys, never pushes. If `origin/main` moves during the run (`git fetch`), **merge `main` into the Phase 15 branch at the next checkpoint** (`git merge --no-ff main`, full verify) — never rebase.

**Numbers at start:** backend **3331 tests / 314 files**, gate **95 / 85 / 95 / 95** (`vitest.config.mts`); frontend **1386 tests / 121 files + 158 Playwright tests / 50 files**, gate **95 / 90 / 90 / 95**. New frontend files need **branch-complete tests**. Catalogue counts (`tests/calls-wa/catalogue.test.ts`): error codes **90**, audit actions **138**, notification types **32**, `MESSAGE_TYPES` **17**. Migrations `0001` … `0016`. Queues `system`, `email`, `maintenance`, `contacts`, `billing`, `ai`, `campaigns`, `whatsapp`. Frontend nav `LIVE_PHASE = 14` (`src/layout/nav-config.ts`); the **Integrations** item (`/integrations`, `integrations.manage`, `phase: 15`) already exists and is hidden. Full test runs **always** with `--maxWorkers=2` (default workers knocked the shared in-memory Mongo over in Phase 14).

**Pehle padho (STEP 0 and after every context compaction):**

- [PHASE_15_PLAN.md](../phases/PHASE_15_PLAN.md) — **source of truth**: goal + Done-when §0, reuse table §1a, public API §1b, webhooks §1c, post-call WhatsApp §1d, Sheets + CRM §1e, developer experience §1f, security §1g, data model §1h, tasks §3, owner questions §7.
- [PHASE_14_SIGNOFF.md](../phases/PHASE_14_SIGNOFF.md) §5–§8 (deviations, flakes, open items); [BUILD_PLAN_V2.md](../plans/BUILD_PLAN_V2.md) Phase 15.
- ADRs 0016 (money), 0028 (ports), 0032 (wallet), 0033 (AI functions, SSRF), 0037 (Meta provider), 0038 (inbox), 0041 (WhatsApp calling), 0043 / 0044 (Phase 14).
- Conventions: [api.md](../conventions/api.md) (§12 public API, §13 tenant scoping, §14 webhooks preview), [security.md](../conventions/security.md), [secrets.md](../conventions/secrets.md), [data.md](../conventions/data.md), [data-model.md](../conventions/data-model.md), [error-codes.md](../conventions/error-codes.md), [audit.md](../conventions/audit.md), [websocket.md](../conventions/websocket.md), [definition-of-done.md](../conventions/definition-of-done.md); [src/README.md](../../src/README.md).

**What exists (use it, don't rebuild)** — plan §1a, plus these exact entry points:

| Area        | Use                                                                                                                                                                                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API keys    | `modules/api-keys/*` (`createApiKey`, revoke, list, `whoami`), `scopes.ts` (`API_KEY_SCOPE_INFO`), `shared/middlewares/api-key-auth.ts` (`apiKeyAuth({ scopes })`, header `X-API-Key`, suspended accounts read-only) — **no route uses it yet**                            |
| Middlewares | `idempotency({ scope })`, `createRateLimiter` + `createRedisRateLimitStore` (`rl:`), `authenticate()`, `requirePermission()`, `blockWhenImpersonating()`, `handle({ body, query, params })`                                                                                |
| Calls       | `POST /calls` "Call now" (`StartCallBody { contactId, flowId                                                                                                                                                                                                               | agentId, version }`, `startSingleCall`, dial guard, holds), `GET /calls`, `/calls/:id`, transcript, insights; `CallSession.onEnded` |
| WhatsApp    | `inbox/outbound.service.ts` `sendMessage`, `assertCanSend`, `isWindowOpen`; `templates/send.service.ts` `loadSendableTemplate`, `prepareTemplateSend`, `assertTemplateAllowed`, `assertMarketingFrequency`; `whatsapp-calling/*` (`createWhatsAppCalls`, permission check) |
| Flow engine | `core/engine/nodes/send-message.ts` — `send_whatsapp` / `send_sms` only push `QueuedMessage` into `state.outcome.messages` (**nothing sends them**); node schemas `core/engine/schema.ts`                                                                                  |
| Events      | `core/realtime/events.ts` (`WsEventMap`: `call.created`, `call.status`, `call.ended`, `call.insights`, inbox events …) — every emit point is a candidate for the webhook outbox                                                                                            |
| SSRF        | URL guard inside `modules/ai-agents/functions.service.ts` (`FUNCTION_URL_BLOCKED`, private / metadata / credentials) — to be extracted                                                                                                                                     |
| Secrets     | `core/ai/secret-box.ts` (AES-GCM with `ENCRYPTION_KEY`)                                                                                                                                                                                                                    |
| Contacts    | `contacts.schema.ts` (`externalId` ≤ 100 exists), `contact-imports/*` pipeline (parse, mapping, validate, run), DND, opt-out                                                                                                                                               |
| Mocks       | `modules/mock-apis/*` (`/mock/payment-status`, `/mock/loan-balance`, `/mock/http-status/:code`, `MOCK_APIS_ENABLED`), `modules/dev-jobs/*` (`/dev/jobs/:name`, Phase 14)                                                                                                   |
| Docs        | `modules/docs/*` (Swagger UI `/api/docs`, `API_DOCS_ENABLED`), `scripts/generate-openapi.ts`, `openapi/openapi.json`                                                                                                                                                       |
| RBAC        | `integrations.manage` (owner, admin), `apikeys.read`, `apikeys.manage`                                                                                                                                                                                                     |
| Frontend    | `features/settings/ApiKeysTab.tsx` (Settings → API keys), `layout/nav-config.ts` (Integrations item), flow builder step forms, `features/calls/detail/*`, `renderWithProviders`, `fakeRealtime`                                                                            |
| E2E         | `e2e/helpers.ts`, `e2e/calls.ts`, `e2e/inbox.ts` (`InboxApi`), `e2e/reports.ts` (`runDevJob`), `E2E_FRONTEND_PORT=3150`                                                                                                                                                    |

**Bugs to avoid** (typical integration mistakes): writing the webhook event outside the code path that made the change (missed events); one delivery job for all endpoints (one slow receiver blocks the rest); following redirects or skipping the DNS re-check (SSRF / rebinding); signing the parsed body instead of the raw bytes; comparing signatures with `===` (use `timingSafeEqual`); retries that resend with a new event id; leaking a revoked key for minutes through a cache; trusting `X-Forwarded-For` for the IP allowlist without `TRUST_PROXY`; a second copy of business logic for the API; sending a post-call template twice on a job retry; sending to an opted-out / DND contact; logging webhook payloads, response bodies, API keys or secrets.

---

## 1. LOCKED DECISIONS (exact literals — the plan has the prose)

**Owner defaults (plan §7 #1–#14) are in force** — the owner chose "never wait". Record "Defaults in use for §7 #1–#14" in the plan changelog at STEP 0. If a default turns out impossible, pick the closest safe option, write it as a deviation (plan changelog + final report) and continue.

**Module layout (backend):**

- `src/shared/net/url-guard.ts` — `assertPublicUrl(url, { httpsOnly })` + `resolvePublicAddress(host)` (moved from AI functions; AI functions, knowledge URLs and webhooks import it). `src/shared/crypto/secret-box.ts` (moved from `core/ai/secret-box.ts`, re-exported there for compatibility).
- `src/shared/middlewares/access.ts` — `access({ permission, scope, sessionOnly? })`: a user session with `permission` **or** an API key with `scope`; sets the same auth context (`actor: { type: 'api_key', id }` for keys).
- `src/modules/public-api/` — `request-log.ts` (middleware + model use), `key-limits.ts`, `messages.routes.ts` / `messages.service.ts` / `messages.schema.ts` (`/messages/*`), `contacts-upsert.service.ts`, `whatsapp-calls.routes.ts`.
- `src/modules/webhooks/` — `events.ts` (catalogue + payload builders + `emitAccountEvent`), `endpoints.service.ts` / `.routes.ts` / `.schema.ts`, `deliver.job.ts`, `signing.ts`, `samples.ts` (test payloads).
- `src/modules/post-call/` — `collect.ts` (outcome messages → rows), `rules.service.ts` / `.routes.ts` / `.schema.ts`, `send.job.ts`, `evaluate.ts`.
- `src/modules/sheet-imports/` — service, routes, schema, `run.job.ts` (reuses `contact-imports`).
- Docs: `docs/api/*.md` (getting-started, auth, errors, idempotency, rate-limits, pagination, webhooks, changelog), `docs/integrations/google-sheets.md`, `docs/integrations/apps-script-receiver.gs`, `docs/integrations/zapier-make-n8n.md`, `docs/setup/webhooks.md`, ADR `0045-public-api.md`, `0046-webhooks.md`.

**Models / collections (registered in `src/db/models/all.ts`):** `webhook-endpoint.model.ts` → `webhookEndpoints`; `webhook-event.model.ts` → `webhookEvents` (TTL 30 d on `createdAt`); `webhook-delivery.model.ts` → `webhookDeliveries` (TTL 30 d); `api-request-log.model.ts` → `apiRequestLogs` (TTL 7 d); `outcome-rule.model.ts` → `outcomeRules`; `post-call-message.model.ts` → `postCallMessages` (unique `{ accountId, callId, source }`); `sheet-import.model.ts` → `sheetImports`.

**New fields:** `apiKeys`: `ipAllowlist: string[]` (CIDR, ≤ 20), `expiresAt: Date | null`, `usage: { day: 'YYYY-MM-DD', reads, writes }[]` (last 7 days kept); `calls.externalRef`, `messages.externalRef` (string ≤ 100 | null, index `{ accountId, externalRef }` partial on string); `contacts.externalId` — add a unique partial index `{ accountId, externalId }` if missing (migration checks duplicates first and reports them instead of failing); flow node `send_whatsapp.config.channelId?: ObjectId string`. Migration **`0017-integrations`** (indexes + TTLs; no data backfill).

**Limits (`src/config/limits.ts`, exact):**

```ts
export const PUBLIC_API_LIMITS = {
  writesPerMinute: 60,
  readsPerMinute: 600,
  bulkUpsertMax: 1_000,
  externalRefMax: 100,
  ipAllowlistMax: 20,
  callVariablesMax: 50,
  requestLogTtlDays: 7,
  /** Revoked / changed keys stop working within this time. */
  keyCacheSec: 30,
} as const;

export const WEBHOOK_LIMITS = {
  endpointsPerAccount: 10,
  timeoutMs: 10_000,
  retryDelaysSec: [60, 300, 1_800, 7_200, 43_200],
  disableAfterGivenUp: 5,
  disableAfterFailingHours: 24,
  responseSnippetBytes: 1_024,
  eventTtlDays: 30,
  secretRotationOverlapHours: 24,
  maxPayloadBytes: 64 * 1024,
} as const;

export const POSTCALL_LIMITS = {
  rulesPerAccount: 20,
  maxDelayMinutes: 1_440,
} as const;

export const SHEET_IMPORT_LIMITS = {
  importsPerAccount: 5,
  allowedHosts: ['docs.google.com'],
  /** Same byte / row caps as file imports (CONTACT_LIMITS). */
} as const;
```

**Scopes (`scopes.ts`, + 6 → 13):** existing `calls:read`, `calls:write`, `contacts:read`, `contacts:write`, `campaigns:read`, `campaigns:write`, `webhooks:manage`; new `messages:read`, `messages:write`, `templates:read`, `whatsapp-calls:write`, `reports:read`, `exports:write`. Each entry gets a `group` (Calls, Contacts, Campaigns, WhatsApp, Reports, Webhooks) for the UI.

**Routes (all under `/api/v1`, zod + OpenAPI tag `Public API` for key-enabled ones, tenant scope):**

| Method + path                                                                                               | Session permission                  | Key scope                                                                               |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------- |
| `GET /contacts`, `GET /contacts/:id`                                                                        | `contacts.read`                     | `contacts:read`                                                                         |
| `POST /contacts` (`?upsert=phone                                                                            | externalId`), `PATCH /contacts/:id` | `contacts.write`                                                                        | `contacts:write`      |
| `POST /contacts/bulk-upsert`                                                                                | `contacts.write`                    | `contacts:write`                                                                        |
| `POST /calls` (+ `variables`, `externalRef`)                                                                | `calls.trigger`                     | `calls:write`                                                                           |
| `GET /calls`, `/calls/:id`, `/calls/:id/transcript`, `/calls/:id/insights`                                  | `calls.read`                        | `calls:read`                                                                            |
| `POST /whatsapp/calls`                                                                                      | `calls.trigger`                     | `whatsapp-calls:write`                                                                  |
| `POST /messages/template`, `POST /messages/text`                                                            | `inbox.reply`                       | `messages:write`                                                                        |
| `GET /messages/:id`                                                                                         | `inbox.read`                        | `messages:read`                                                                         |
| `GET /templates`                                                                                            | `templates.read`                    | `templates:read`                                                                        |
| campaigns list / detail / results                                                                           | `campaigns.read`                    | `campaigns:read`                                                                        |
| campaigns create / start / pause / resume / cancel                                                          | `campaigns.write` / `campaigns.run` | `campaigns:write`                                                                       |
| `GET /reports/:tab`                                                                                         | `reports.read`                      | `reports:read`                                                                          |
| `POST /exports/calls                                                                                        | messages                            | report`, `GET /exports/:id`                                                             | existing              | `exports:write`   |
| `GET/POST /webhook-endpoints`, `GET/PATCH/DELETE /webhook-endpoints/:id`, `POST /webhook-endpoints/:id/test | rotate-secret                       | enable`, `GET /webhook-endpoints/:id/deliveries`, `POST /webhook-deliveries/:id/replay` | `integrations.manage` | `webhooks:manage` |
| `GET/POST /outcome-rules`, `PATCH/DELETE /outcome-rules/:id`                                                | `integrations.manage`               | — (session only)                                                                        |
| `GET/POST /sheet-imports`, `DELETE /sheet-imports/:id`, `POST /sheet-imports/:id/run`                       | `contacts.import`                   | — (session only)                                                                        |
| `PATCH /api-keys/:id`, `GET /api-keys/:id/requests`                                                         | `apikeys.manage` / `apikeys.read`   | — (session only)                                                                        |
| `GET /calls/:id/after-call`                                                                                 | `calls.read`                        | `calls:read`                                                                            |
| `POST /mock/payment-link`, `GET/POST /mock/webhook-receiver`                                                | — (`MOCK_APIS_ENABLED` only)        | —                                                                                       |

Session-only stays session-only: team, wallet top-ups, settings, billing, superadmin, impersonation, retention, report e-mails.

**Webhook payload (exact):** `{ "id": "evt_<26-char ulid>", "type": "<event>", "apiVersion": "2026-10", "createdAt": "<ISO>", "accountId": "<id>", "data": { … } }`. Headers: `Content-Type: application/json`, `User-Agent: NotifyNow-Webhooks/1.0`, `X-Webhook-Id: <evt id>`, `X-Webhook-Timestamp: <unix seconds>`, `X-Webhook-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>[, v1=<previous secret's>]`. Secret: 32 random bytes, shown once as `whsec_<base64url>`.

**Event catalogue (exact names, v1):** `call.started`, `call.completed`, `call.insights.ready`, `campaign.completed`, `whatsapp.message.received`, `whatsapp.message.status`, `whatsapp.call.started`, `whatsapp.call.ended`, `whatsapp.call.missed`, `contact.opted_out`, `contact.opted_in` (11). `data` fields per plan §1c; personal fields (`phone`, `name`, `summary`, message `text`) only when the endpoint has `includePersonalData: true`.

**Post-call message skip reasons (exact):** `opted_out`, `dnd`, `no_template`, `template_not_approved`, `no_number`, `no_phone`, `low_balance`, `marketing_limit`, `rule_disabled`, `call_not_eligible`.

**Jobs (names / ids — ids never contain `:`):** new queue **`webhooks`**: `webhooks.deliver` (id `wh-<deliveryId>-<attempt>`, custom backoff from `WEBHOOK_LIMITS.retryDelaysSec`); queue `whatsapp`: `postcall.send` (id `postcall-<postCallMessageId>`, delayed by the rule timing); queue `contacts`: `sheets.import` (id `sheet-<importId>-<runKey>`); queue `maintenance`: `sheet-imports` (repeatable `*/15 * * * *`, schedules due imports), `webhook-health` (repeatable `*/10 * * * *`, disables endpoints failing > 24 h). Post-call collection runs **inside the existing call-settle path** (no new job).

**Error codes (+6 → 96):** `WEBHOOK_URL_BLOCKED` 422, `WEBHOOK_ENDPOINT_LIMIT` 422, `API_KEY_IP_DENIED` 403, `API_KEY_EXPIRED` 401, `OUTCOME_RULE_LIMIT` 422, `SHEET_URL_INVALID` 422. Reused: `RATE_LIMITED`, `AUTH_FORBIDDEN` (missing scope), `WHATSAPP_WINDOW_CLOSED`, `WHATSAPP_CALL_PERMISSION_MISSING`, `IDEMPOTENCY_IN_PROGRESS`, `IDEMPOTENCY_KEY_REUSED`.

**Audit actions (+12 → 150):** `api_key.updated`, `webhook_endpoint.created`, `webhook_endpoint.updated`, `webhook_endpoint.deleted`, `webhook_endpoint.secret_rotated`, `webhook_endpoint.disabled`, `webhook_endpoint.enabled`, `outcome_rule.created`, `outcome_rule.updated`, `outcome_rule.deleted`, `sheet_import.created`, `sheet_import.deleted`. Details: ids, URL host only (never the path / query), event names, counts — never secrets or payloads.

**Notification types (+1 → 33):** `webhook.endpoint_disabled` (owners + admins; e-mail too, template `webhooks.endpoint_disabled`).

**Env:** **none new.** Webhooks deliver from the API process' worker set like other queues. If one turns out necessary: `env.ts` + `.env.example` + README table + env-docs test, and a deviation note.

**Frontend:**

- Settings → **API keys** tab (`features/settings/ApiKeysTab.tsx`) extended: grouped scopes, last used, 24 h / 7 d requests, IP allowlist, expiry, edit dialog, request log drawer, "Test a key".
- **Integrations** page `pages/integrations/IntegrationsPage.tsx`, route `/integrations/:tab?` (`webhooks` default, `after-call`, `sheets`), lazy chunk, `RequirePermission integrations.manage` (sheets tab also for `contacts.import`); `LIVE_PHASE` 14 → **15** in `nav-config.ts` (nav tests updated).
- `features/integrations/webhooks/*` (list, form, secret dialog, test dialog, deliveries table + replay), `features/integrations/after-call/*` (rules list + editor with template preview), `features/integrations/sheets/*`.
- Flow builder: Send WhatsApp step form (number picker, approved-template picker, params, "sent after the call" hint); Send SMS step hint "starts with phone lines".
- Call detail `features/calls/detail/AfterCallCard.tsx`.
- Bundle: integrations chunk ≤ 60 KB gzip; main bundle growth ≤ 2 KB gzip.

---

## 2. RULES OF ENGAGEMENT

1. **NEVER STOP, NEVER WAIT, NEVER ASK.** Checkpoints are **commits, not pauses**. The only output before the end is a 2–3 line progress note at each checkpoint, written **while continuing in the same turn**.
2. **Blocked? Unblock yourself.** Unclear spec → plan §1 / §7 default → safest convention-consistent choice → deviation note. Tool / infra problem (Docker down, port busy, flaky test) → fix it within the rules (`open -a Docker`, Monitor until-loop, rerun once, `uptime`) → still blocked → skip only that sub-step, record it as an open item, continue, retry at the next checkpoint. Anything needing a secret, the client's server, a push or a destructive action → don't do it, record it, continue.
3. **Git:** branch `feature/phase-15-integrations` in both repos; never on `main`; one commit per task per repo, one repo at a time; hooks must pass (no `--no-verify`, no `--force`); **no push / merge to main / tag**; footer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; message in a scratchpad file + `git commit -F`; no body line starts with `word:`.
4. **Verify after every code task — each command separately, read output + exit code; never chain `git commit` after checks.**
   - Backend: `npm run lint` · `npm run format:check` · `npm run typecheck` · targeted `npx vitest run <changed areas> --maxWorkers=2` · `npm run build` · `npm run openapi:check` (stage `openapi/openapi.json` first). Full `npx vitest run --coverage --maxWorkers=2` at the end of every backend task that touches shared code and at every checkpoint (background, `caffeinate -i`, wait for the notification — never poll with sleeps, never run another heavy suite meanwhile).
   - Frontend: `npm run lint` · `npx prettier --check .` · `npm run typecheck` · `npx tsc -p tsconfig.e2e.json --noEmit` · targeted vitest · `npm run build`; full `npx vitest run --coverage --maxWorkers=2` per frontend task; whole Playwright suite at B2 / B3 and after T15.9 — infra up, this project's dev servers stopped, `E2E_FRONTEND_PORT=3150`, from the frontend folder; run 2 with `E2E_BACKEND_LOGS=1` + log grep.
   - A heavy test that fails only under full-suite load and passes alone 3 / 3 is a **flake**: record it (sign-off §7), don't weaken it.
5. **Coverage gates stay green; never lower thresholds; never raise test timeouts; no dynamic `import()` in backend tests.**
6. **Secrets / personal data:** never print, log or commit `.env` values, API keys (prefix only), webhook secrets, signatures, payloads, response bodies, phone numbers, names or message texts. Tests assert the new jobs' logs contain none of them.
7. **No external network in tests.** Webhook receivers are local HTTP servers on `127.0.0.1` (tests allow loopback only through an explicit test flag of the URL guard, never in production config). OpenAI / Meta stay faked.
8. **Docker on the Mac:** only `npm run infra:*` (`cav-*`) and one-off `docker run --rm`; never touch other containers / volumes. Dev DB `cell_ai_voicebot` on `cav-mongo` 27018, E2E DB `cav_e2e`. **Never connect to Atlas or the client's database.**
9. **Never kill other projects' processes** (port 3100 is another project; E2E uses 3150).
10. **Docs in the same commit** as the code they describe (ADR, conventions, `src/README.md` rows, guides).
11. **Real bugs in committed code:** reproduce → regression test proven failing first → separate `fix(<area>)` commit → plan changelog + final report.
12. **Catalogue / count tests** (error codes, audit actions, notification types, scopes, queues, job names, limits, permissions snapshot) are updated in the same commit that adds the entries; `docs/conventions/audit.md` table stays identical to the code (its test).
13. **One source of business logic:** a public route calls the same service as the dashboard route. Never fork a service for the API.
14. **Progress notes** (at each checkpoint, then keep going): "P15-B1-DONE ✅ — <tests> backend tests, coverage <x>; next: T15.5" — nothing more.

---

## 3. RESUME SAFETY (after a context compaction or a restart)

1. `git -C cell-ai-voicebot-backend branch --show-current` → `feature/phase-15-integrations`; same for the frontend once it exists; `git log --oneline -20` in both.
2. The last `[P15-…]` tag tells the position; `docs/phases/PHASE_15_TASKS.md` ticks must agree (fix the tracker if a tick is missing).
3. Uncommitted work → `git status` + `git diff` → finish that task, verify, commit. Never discard work without reading it.
4. `npm run infra:up` → `npm run db:migrate` (dev) → backend lint + typecheck → targeted tests of the last task → continue with the **next** task. Don't redo committed tasks.
5. Then keep going to `P15-B3-DONE` — a resume is not a reason to stop or report early.

---

## STEP 0 — P15-SETUP (before T15.1)

1. Backend on `feature/phase-15-integrations`; `git status` shows only `docs/phases/PHASE_15_PLAN.md` (modified) and `docs/prompts/PHASE_15_PROMPT.md` (untracked). Anything else → read it; unrelated work stays unstaged.
2. `git fetch origin` both repos; if `origin/main` moved past `acf5d8b` / `a6c9533`, merge `main` into the Phase 15 branch.
3. Plan changelog line: "Run prompt prepared (one-paste autonomous run) — literals locked: modules, models, limits, scopes (+6 → 13), routes, payload + signature, events (11), jobs, error codes (+6 → 96), audit actions (+12 → 150), notification (+1 → 33); defaults in use for §7 #1–#14."
4. Commit 1: plan → `docs(plans): lock phase 15 decisions [P15-PLAN]`. Commit 2: this prompt → `docs(prompts): add phase 15 run prompt [P15-PROMPT]`.
5. Baseline: `npm run infra:up`, `npm run db:migrate`, backend + frontend lint / typecheck green (record counts). **Then continue straight into T15.1.**

---

# ═══════════ BATCH 1 — Backend core (T15.1 → T15.4) ═══════════

## T15.1 — Public API foundation → `feat(api): open the dashboard routes to scoped api keys [P15-T15.1]`

1. `scopes.ts`: + 6 scopes with `group`; scopes catalogue test; OpenAPI security scheme `ApiKeyAuth` (`X-API-Key`).
2. `shared/middlewares/access.ts` `access({ permission, scope, sessionOnly })`: tries the session (Bearer) first, then `X-API-Key`; key path: hash lookup through a 30 s in-process + Redis cache (revocation / edit bumps a version key so all instances drop it), expiry → 401 `API_KEY_EXPIRED`, IP allowlist (client IP from `req.ip` honouring `TRUST_PROXY`) → 403 `API_KEY_IP_DENIED`, scope missing → 403 `AUTH_FORBIDDEN` with `details: [{ path: 'scope', message: '<scope> is required' }]`. Audit actor `api_key`.
3. Replace `authenticate()` + `requirePermission()` with `access(...)` on every route in the §1 routes table (dashboard behaviour unchanged — existing tests must stay green untouched except for the added key cases).
4. `key-limits.ts`: per-key limiter (Redis `rl:key:<keyId>:r|w`), reads vs writes by method, `RateLimit-*` headers, 429 `RATE_LIMITED` + `Retry-After`; dashboard sessions keep the existing global limiter.
5. `apiKeys` fields (`ipAllowlist`, `expiresAt`, `usage`), `PATCH /api-keys/:id` (name, scopes, ipAllowlist, expiresAt) + audit `api_key.updated`; usage `$inc` per day (bulk-flushed, ≤ 1 write / key / 10 s); `lastUsedAt` throttled.
6. `request-log.ts`: after-response middleware for key requests only → `apiRequestLogs` `{ accountId, apiKeyId, method, route (req.route.path template), status, ms, requestId, at }` (TTL 7 d); `GET /api-keys/:id/requests` (cursor, 50).
7. `externalRef` on `calls` / `messages` (model + views + list filter `?externalRef=`); migration `0017-integrations` (indexes, TTLs, `contacts.externalId` unique partial index with a duplicate pre-check that reports counts and leaves the index out if duplicates exist — then an open item).
8. Docs: api.md §12 rewritten (scopes table, key auth, limits, IP allowlist, expiry, request log), data-model, error-codes, audit; `src/README.md` rows.
9. Tests: `tests/public-api/access.test.ts` — matrix every §1 route × (session with / without permission, key with / without scope, revoked, expired, IP allowed / denied incl. IPv6 + CIDR, suspended account write) ; key cache invalidation ≤ 30 s (fake clock); per-key limits; request log content (no ids / query / body); usage counters; migration up / down.

## T15.2 — Public send + trigger routes → `feat(api): add contact upsert, message send and whatsapp call trigger for the api [P15-T15.2]`

1. `contacts-upsert.service.ts`: `POST /contacts?upsert=phone|externalId` (create or update; custom fields by key; opt-out / DND never cleared without `consent { source, at }` → audit), `POST /contacts/bulk-upsert` (≤ 1,000 rows, per-row `{ index, status: created | updated | failed, id?, error? }`, one transaction per 100, concurrency-safe on the unique phone index).
2. `messages.service.ts`: `POST /messages/template { to | contactId, channelId?, template { name, language }, params?, headerMedia?, buttons?, externalRef? }` → resolve / create contact + conversation, `loadSendableTemplate` + `prepareTemplateSend` + existing send path (holds, ledger, marketing limits, opt-out, DND); `POST /messages/text { to | contactId, channelId?, text, externalRef? }` (window only → 409 `WHATSAPP_WINDOW_CLOSED`); `GET /messages/:id` (status, history, error, charge, externalRef). Idempotency on both POSTs.
3. `whatsapp-calls.routes.ts`: `POST /whatsapp/calls { contactId | to, channelId?, flowId | agentId }` → existing business-initiated call path (permission required → 409 `WHATSAPP_CALL_PERMISSION_MISSING`).
4. `POST /calls`: `variables` (≤ 50 keys, string | number, checked against the flow's declared variables → 422 per key) and `externalRef`.
5. `GET /templates` (approved only for keys; dashboard keeps its filters): name, language, category, variables with examples, buttons.
6. Docs: api.md public routes section, OpenAPI examples on every key route.
7. Tests: each route with a key + scope; idempotency replay returns the first result; refusals (wallet, opt-out, DND, window, permission, unapproved template); concurrent upserts never duplicate; bulk partial failures; tenant isolation.

## T15.3 — Webhook core → `feat(webhooks): add signed outbound webhooks with retries and replay [P15-T15.3]`

1. Move the URL guard to `shared/net/url-guard.ts` (AI functions + knowledge import it; their tests stay green); add DNS re-resolution at connect time (custom `lookup` on the agent), no redirects, https-only unless `NODE_ENV !== 'production'` **and** the test flag.
2. Move `secret-box.ts` to `shared/crypto/` (re-export).
3. Models (`webhookEndpoints`, `webhookEvents`, `webhookDeliveries`) + limits; secrets sealed; `secretPrevious` + `rotatedAt` for overlap.
4. `signing.ts`: `sign(secret, timestamp, rawBody)`, `verify(header, secrets, timestamp, rawBody, toleranceSec = 300)` with `timingSafeEqual`; golden vectors in `tests/fixtures/webhooks/vectors.json`.
5. `events.ts` `emitAccountEvent(accountId, type, data, { session? })`: insert `webhookEvents` (in the caller's transaction when given), enqueue one `webhooks.deliver` per active matching endpoint (outside the transaction, after commit), never throws into the caller (logs counts).
6. `deliver.job.ts`: build payload (personal-data filter), POST with `WEBHOOK_LIMITS.timeoutMs`, record delivery (status, ms, snippet — text only, ≤ 1 KB), retry schedule, `gave_up` → `failureStreak++` → disable at `disableAfterGivenUp` + notification + e-mail + audit `webhook_endpoint.disabled`; success resets the streak. Maintenance `webhook-health` disables endpoints with only failures for `disableAfterFailingHours`.
7. Routes: CRUD (≤ 10, `WEBHOOK_ENDPOINT_LIMIT`; URL guard → `WEBHOOK_URL_BLOCKED`), `POST /:id/test { type }` (sample payload from `samples.ts`, delivered synchronously, result returned, also logged as a delivery with `test: true`), `POST /:id/rotate-secret` (new secret shown once; old valid 24 h), `POST /:id/enable`, `GET /:id/deliveries` (filters: status, type, from / to; cursor), `POST /webhook-deliveries/:id/replay` (new attempt, same event id).
8. Docs: api.md §14 final, `docs/api/webhooks.md` (catalogue placeholder filled in T15.4, signature, retries, replay, de-dupe), ADR 0046.
9. Tests: signing vectors + tamper + old timestamp; retries with a fake clock (exact delays); disable after streak + notification + e-mail; replay; rotation overlap (both signatures valid, then only the new); SSRF corpus (`127.0.0.1`, `10.x`, `169.254.169.254`, `[::1]`, `0.0.0.0`, decimal / octal IPs, `user:pass@`, DNS rebinding via a fake resolver, redirect to private); production https-only; no payload / secret / body in logs; tenant isolation of every route; one slow endpoint doesn't delay another (separate jobs).

## T15.4 — Event wiring → `feat(webhooks): send call, campaign, whatsapp and contact events [P15-T15.4]`

1. Emit points (one place each): `call.started` (answered transition in `CallSession` / WhatsApp leg), `call.completed` (after settle — phone + WhatsApp — once, with final cost), `call.insights.ready` (insights done / skipped), `campaign.completed` (status → completed, incl. recurring runs), `whatsapp.message.received` (inbound processor, after the message is stored; Meta retries de-duplicated by wamid), `whatsapp.message.status` (status advance only, not repeats), `whatsapp.call.started|ended|missed`, `contact.opted_out|opted_in` (STOP / START, DND add / remove).
2. Payload builders typed per event (`WebhookEventMap`), personal fields marked; `externalRef` echoed (call / message), `contactExternalId` when set.
3. Docs: `docs/api/webhooks.md` catalogue with a sample per event (generated from the builders' snapshots); websocket.md cross-reference.
4. Tests: each event fires exactly once per real change (Meta webhook retries, settle retries, late durations); payload snapshots with and without personal data; outbox row inside the same transaction where one exists.
5. **External-client integration test** `tests/integration/external-client.test.ts`: real app + local receiver + an API key → `POST /contacts` → `POST /calls` (dry-run flow) → receiver gets `call.started` + `call.completed` (signature verified with the **documented** algorithm, not our helper) → `GET /calls/:id` equals the webhook's data; then `POST /messages/template` → `whatsapp.message.status` sent → delivered → read (fake Meta statuses).

## P15-B1-DONE — checkpoint → `docs: mark phase 15 batch 1 complete [P15-B1-DONE]`

1. Backend full verify (each command separately) + full coverage (`--maxWorkers=2`), external-client test green, `openapi:check`.
2. Tracker ticks T15.1–T15.4, backend CHANGELOG `Phase 15 · Batch 1`, plan changelog (deviations so far).
3. Commit, 2-line progress note, **immediately start T15.5.**

---

# ═══════════ BATCH 2 — Post-call, Sheets, frontend (T15.5 → T15.7) ═══════════

## T15.5 — Post-call WhatsApp → `feat(post-call): send whatsapp templates after calls from flows and outcome rules [P15-T15.5]`

1. Flow `send_whatsapp` config + `channelId?`; validator: template must exist + be approved on the chosen / default number → **warning** issue (not blocking); engine unchanged.
2. `collect.ts`, called from the call-settle path (phone + WhatsApp AI calls): `outcome.messages` with `channel: 'whatsapp'` → `postCallMessages` (`source: flow:<nodeId>`, `scheduledAt: now`); `send_sms` entries ignored (still queued, shown as "SMS starts with phone lines").
3. `outcomeRules` model + CRUD (`integrations.manage`, ≤ 20 → `OUTCOME_RULE_LIMIT`, audit): `{ name, active, order, when: { dispositions?: string[], sentiment?: label[], hasPromise?: boolean, notAnsweredInARow?: number, callKinds?: ('phone' | 'whatsapp')[], flowIds?, campaignIds? }, send: { channelId?, templateId, params: [{ from: 'contact' | 'call' | 'insights' | 'text', key | value }] }, timing: { mode: 'now' | 'after' | 'next_window_hour', delayMinutes? } }`.
4. `evaluate.ts`: after insights finish (or at settle when insights are off / skipped), every active rule in `order` → `postCallMessages` (`source: rule:<ruleId>`, unique), `scheduledAt` from timing (calling window from the account settings).
5. `send.job.ts` `postcall.send` (delayed until `scheduledAt`): re-checks (contact phone, opted-out, DND, template approved, number connected, wallet, marketing limit) → skip with the exact reason, else the template send path (origin `system`, `externalRef` = call's) → `status: sent`, `messageId`. Retry-safe (status guard), never twice.
6. `GET /calls/:id/after-call` + `afterCall[]` summary on the call view; inbox shows the message; `whatsapp.message.status` webhooks follow.
7. Docs: data-model (`outcomeRules`, `postCallMessages`), api.md, flow-step docs, `src/README.md`.
8. Tests: flow step sends after a dry-run call (fake Meta) + ledger charge; rule once per call (retries, concurrent settle); every skip reason; timing (now / after / next window hour across midnight + Sunday); insights-off path; opt-out between scheduling and sending; tenant isolation; no texts / phones in logs.

## T15.6 — Google Sheets + CRM docs → `feat(integrations): import contacts from google sheets and document crm recipes [P15-T15.6]`

1. `sheetImports` (≤ 5): `POST /sheet-imports { url, schedule: 'once' | 'hourly' | 'daily', mapping, updateExisting: 'phone' | 'externalId' | false }`; URL must be `https://docs.google.com/spreadsheets/d/e/<id>/pub?…output=csv` (else `SHEET_URL_INVALID`) and pass the URL guard; fetch with size / row caps; feeds the existing import job (validation, dedupe, DND, errors file).
2. Maintenance `sheet-imports` (every 15 min) enqueues due `sheets.import` jobs; last result + counts on the row; `POST /:id/run` runs now.
3. `docs/integrations/google-sheets.md` (publish as CSV steps, schedule, mapping), `apps-script-receiver.gs` (verifies the signature, appends a row per `call.completed`), with the pure logic mirrored in `scripts/lib/sheets-receiver.ts` and tested against golden vectors; `docs/integrations/zapier-make-n8n.md` (webhook → CRM, CRM → `POST /calls` / `POST /messages/template` recipes).
4. Tests: published-URL forms, non-CSV / HTML login page / too big, mapping errors, scheduled run updates existing by phone, isolation, audit.

## T15.7 — Frontend → `feat(integrations): add api key details, webhooks, after-call rules and sheet imports [P15-T15.7]` (frontend repo)

1. `git switch -c feature/phase-15-integrations main` (frontend), `npm run gen:api`.
2. Settings → API keys (extend `ApiKeysTab`): grouped scope picker, chips, last used, 24 h / 7 d requests, IP allowlist editor (CIDR validation), expiry, edit dialog, request log drawer, "Test a key" (whoami; the pasted key never stored / logged).
3. `/integrations/:tab?` page (`LIVE_PHASE` → 15): **Webhooks** (list with status + last delivery, add / edit with events multi-select + personal-data switch and warning, secret-once dialog with copy, send test dialog with the response, deliveries table with filters + replay, disabled banner + enable, rotate secret); **After the call** (rules list, enable switch, order, editor: when / send / timing with a live template preview filling sample values); **Google Sheets** (add with URL check + schedule + mapping via the import wizard, list with last run + Run now + delete).
4. Flow builder Send WhatsApp step form (number picker, approved templates only, params with variable chips, hint); Send SMS hint.
5. Call detail `AfterCallCard` (rows: template, status / reason, link to the chat, scheduled time).
6. Tests: every form's validation, permissions (owner / admin vs manager / agent / viewer; `integrations.manage` only), empty / error / loading states, secret shown once, replay / test flows, API client tests, nav tests for `LIVE_PHASE` 15.
7. Verify (frontend full coverage), bundle numbers, commit.

## P15-B2-DONE — checkpoint → `docs: mark phase 15 batch 2 complete [P15-B2-DONE]` (both repos)

1. Both repos full verify (each command separately, coverage both, builds, `openapi:check`).
2. **Playwright whole suite twice** (existing 158 must stay green) — run 2 with `E2E_BACKEND_LOGS=1` + log grep: `cav_live_` / `cav_test_` full keys, `whsec_`, `X-Webhook-Signature` values, webhook payload fields, phones, names, message texts, summaries = 0.
3. Bundle numbers, tracker ticks T15.5–T15.7, CHANGELOGs `Phase 15 · Batch 2`, plan changelog.
4. Merge `main` if it moved (+ verify). Commit, 2-line progress note, **immediately start T15.8.**

---

# ═══════════ BATCH 3 — Docs, tests, sign-off (T15.8 → T15.10) ═══════════

## T15.8 — Docs page + mocks → `feat(docs): add the public api docs, webhook guides and dev mocks [P15-T15.8]` (both repos)

1. `/api/docs`: Public API tag first, hand-written guides from `docs/api/*.md` rendered beside Swagger (getting started: create key → whoami → first call → webhook), error / idempotency / rate-limit / pagination pages, webhook catalogue + samples, changelog; in production the docs page shows **only** routes tagged `Public API` (§7 #6) — test it.
2. Signature samples (Node, Python, PHP) in `docs/api/webhooks.md`; the Node sample runs in a test against the golden vectors; the Python sample runs only if `python3` exists (skip otherwise, noted).
3. Mocks (`MOCK_APIS_ENABLED`): `POST /mock/payment-link { loanId, amount }` → fake URL; `/mock/webhook-receiver` (stores the last 50 deliveries in memory, shows whether the signature verifies); the webhook form offers "Dev receiver" when mocks are on.
4. Frontend: "Try it" on the API keys tab links to the docs; Integrations → Webhooks "Dev receiver" option.
5. Tests: docs page filtering in production, mocks off in production (404), receiver signature check.

## T15.9 — Seeds, E2E, perf, security → `test: add phase 15 seeds, e2e, performance and security checks [P15-T15.9]` (both repos)

1. `db:seed`: a demo API key (printed once, test prefix), a webhook endpoint to the mock receiver (all events), two outcome rules (promise → payment reminder next window hour; not answered twice → callback template), a disabled sheet import; idempotent; seed test.
2. Playwright (`e2e/integrations-*.spec.ts`, helpers `e2e/integrations.ts`): create a key with scopes → "Test a key"; add a webhook (dev receiver) → send test → delivery row → replay; a dry-run call → `call.completed` delivery in the log; an outcome rule → template in the inbox after the call + After-the-call card; a flow Send WhatsApp step → after-call row; API key edit (IP allowlist) ; viewer / agent / manager views (no Integrations, keys read-only).
3. `scripts/perf-webhooks.ts` (`npm run perf:webhooks`, throw-away DB `cav_perf`, local receivers): 1,000 events / min × 5 endpoints for 5 min → delivery p95 < 5 s, 0 lost, 0 duplicates beyond retries, queue drains; `POST /messages/template` and `POST /calls` at 50 rps for 60 s → p95 + errors; record numbers.
4. Security tests (`tests/security/phase15-*.test.ts`): isolation loop over every key-enabled route with keys of two accounts (404), scopes × routes matrix snapshot, SSRF corpus (from T15.3) at save and delivery, signature tamper / replay window, IP allowlist with spoofed `X-Forwarded-For` (trusted only per `TRUST_PROXY`), revoked key within 30 s, no keys / secrets / payloads in logs, rate limits per key.
5. Both repos full verify + **Playwright whole suite twice** (with the new specs).

## T15.10 — Gap audit, docs, sign-off → `docs: add phase 15 sign-off and docs [P15-T15.10]` (both repos)

1. Gap audit: plan §0 Done-when + §4 checklist + this prompt §4; every gap → fix now (own commit) or an explicit open item with the reason.
2. Docs: ADR 0045 "Public API: one API, two auths, scopes", ADR 0046 "Webhooks: outbox, signing, retries, replay"; `docs/setup/webhooks.md` (receiver checklist for the client); runbook `docs/ops/staging.md` (stuck webhook queue, disabled endpoints, key rotation, post-call send failures); conventions (api.md §12 / §14, data-model, error-codes, audit, websocket); `src/README.md` rows; both READMEs (features, scripts); both CHANGELOGs; BUILD_PLAN_V2 changelog ("Phase 15 done … Next: Phase 16"); **release notes for the client's deploy** (`docs/ops/release-phase-15.md`: migration 0017, no new env, new queue `webhooks`, `LIVE_PHASE` 15, what to check after deploy).
3. `docs/phases/PHASE_15_SIGNOFF.md` (Phase 14 format): scope delivered, tests + coverage (both), Playwright runs, perf numbers, bundle, deviations, bugs fixed, flakes, open items + owners (client deploy, real Meta sends after App Review, owner answers to §7 if they differ).
4. Tracker all ticked; plan changelog final line.

## P15-B3-DONE — checkpoint → `docs: mark phase 15 complete [P15-B3-DONE]` (both repos)

1. Final full verify both repos (each command separately), branch diffs scanned for keys / URIs (gitleaks if installed), Playwright once more (green), `git status` clean in both, `git log --oneline main..HEAD` listed.
2. **Final report (Hinglish, the only full report of the run):** what was built (per task, 1 line each), numbers (tests before → after, coverage, Playwright, perf, bundle), commits per repo (short sha + subject), deviations, bugs fixed, flakes, open items (incl. "push / merge to main and the client's deploy are the owner's call"), and how to try it locally (`npm run dev` both → http://localhost:3150/integrations; `npm run db:seed` prints the demo key; docs at http://localhost:5100/api/docs).

---

## 4. FINAL CHECKLIST

**Step 0**

- [ ] `[P15-PLAN]` lock (defaults + literals) and `[P15-PROMPT]`; baseline green

**Batch 1**

- [ ] T15.1 scopes (+6), `access()` on every listed route, per-key limits, key cache, IP allowlist, expiry, usage, request log, `externalRef`, migration 0017, access matrix tests
- [ ] T15.2 contacts upsert + bulk, messages template / text / status, WhatsApp call trigger, call variables, templates read, refusal tests
- [ ] T15.3 URL guard + secret box moved, outbox, endpoints, signing + rotation, delivery queue + retries + disable + notification, test event, replay, SSRF corpus
- [ ] T15.4 all 11 events wired once each, payload builders + personal-data filter, external-client integration test
- [ ] P15-B1-DONE (verify, coverage) → continued without stopping

**Batch 2**

- [ ] T15.5 flow Send WhatsApp sends after the call, outcome rules, timing, skip reasons, after-call view
- [ ] T15.6 Google Sheet imports (published CSV, scheduled), Apps Script receiver (tested logic), Zapier / Make / n8n docs
- [ ] T15.7 API keys tab, `/integrations` (webhooks, after the call, sheets), flow step form, AfterCallCard, `LIVE_PHASE` 15
- [ ] P15-B2-DONE (verify both, Playwright twice + log grep, bundle) → continued without stopping

**Batch 3**

- [ ] T15.8 docs page (production filter), guides, tested signature samples, mocks
- [ ] T15.9 seeds, Playwright specs, `perf:webhooks` numbers, security tests, Playwright twice
- [ ] T15.10 gap audit, ADR 0045 / 0046, setup + runbook + conventions + READMEs + CHANGELOGs + BUILD_PLAN_V2 + client release notes, sign-off
- [ ] P15-B3-DONE (final verify, clean trees, final Hinglish report)
