# P16 RUN — Security, Compliance & QA (T16.1 → T16.11) — One-Paste Autonomous Run Prompt

> **HOW TO RUN — ek hi paste, poora phase. Beech mein kahin nahi rukna.**
>
> Phase 15 ki tarah: **ek paste = STEP 0 → Batch 1 → Batch 2 → Batch 3 → sign-off.** Checkpoint (`P16-B1-DONE`, `P16-B2-DONE`) pe sirf commit + chhota progress note likhna hai aur **usi turn mein agla task shuru karna hai**.
>
> **Paste this (working directory `/Users/lalitbansal/Documents/cell-ai-voicebot`):**
>
> `cell-ai-voicebot-backend/docs/prompts/PHASE_16_PROMPT.md padho aur STEP 0 se P16-B3-DONE tak POORA Phase 16 (teeno batches) step by step autonomously implement karo. Kahin bhi mat ruko: na batch ke baad, na checkpoint pe, na kisi question ke liye — saare decisions is prompt + PHASE_16_PLAN.md me pre-made hain (owner defaults §1). Har task ke baad verify (har command alag) + commit (tag [P16-T16.x]). Checkpoint pe commit karke turant agla task. Koi push / merge NAHI. Client ke server ya database se connect NAHI. Context compact ho jaye to §3 RESUME SAFETY se wahin se aage chalo. Sirf P16-B3-DONE ke baad final report (Hinglish) do.`
>
> **Claude Code "auto / accept edits" mode me chalao.** **Docker Desktop chalu** (`open -a Docker`). **Mac charger par, lid khuli** — lambi runs `caffeinate -dims` ke saath. Doosre projects ke containers / processes **kabhi mat chhoona** (port 3100 doosre project ka hai).
>
> **Paste se pehle owner ke kaam (run in pe nahi rukta, par ye code se theek nahi hote):** plan §1a U1 (`45.114.245.71` wala DNS A record hatwana), U2 (secret rotation ki date tay karna), U3 (client repo private karwana). §7 ke jawab alag hon to paste se pehle plan mein likh do; warna defaults chalenge.

---

## 0. CONTEXT (verified facts on 1 Nov 2026 — dobara derive mat karna)

**Branches:** `main` = backend `1df8f82`, frontend `707127c` (Phase 15 + superadmin Add account). Branch **`feature/phase-16-security-qa`** exists in both repos from those commits. In the backend it holds uncommitted `docs/phases/PHASE_16_PLAN.md`, `docs/phases/PHASE_16_TASKS.md`, `docs/plans/BUILD_PLAN_V2.md` and this prompt. **Never commit to `main`.**

**Production context:** the app is live at `https://wa.notifynow.in` on the **client's** server and database, with Meta App Review in progress. This run never connects to that server or database, never deploys, never pushes, and never sends a login or a test payload there. The only live access allowed is read-only public `GET` / `HEAD` for header checks. If `origin/main` moves (`git fetch`), merge `main` into the Phase 16 branch at the next checkpoint (`git merge --no-ff main`, full verify); never rebase.

**Numbers at start:** backend **3555 tests / 330 files**, gate **95 / 85 / 95 / 95**, coverage 96.08 / 87.42 / 95.72 / 97.6; frontend **1442 tests / 130 files**, gate **95 / 90 / 90 / 95**, coverage 96.3 / 92.28 / 94 / 97.02; **163 Playwright tests**. Bundle: main 315.22 KB gzip. Catalogue counts (`tests/calls-wa/catalogue.test.ts`): error codes **96**, audit actions **150**, notification types **33**, `MESSAGE_TYPES` **17**. Migrations `0001` … `0017`. Queues `system`, `email`, `maintenance`, `contacts`, `billing`, `ai`, `campaigns`, `whatsapp`, `webhooks`. Next ADR: **0047**.

**Pehle padho (STEP 0 and after every context compaction):**

- [PHASE_16_PLAN.md](../phases/PHASE_16_PLAN.md) — **source of truth**: goal + Done-when §0, findings §1a, reuse §1b, gaps §1c, decisions §1d, tasks §3, risks §5, order §6, owner questions §7.
- [PHASE_15_SIGNOFF.md](../phases/PHASE_15_SIGNOFF.md) §5–§8, [PHASE_14_SIGNOFF.md](../phases/PHASE_14_SIGNOFF.md) §7–§8, [PHASE_12_SIGNOFF.md](../phases/PHASE_12_SIGNOFF.md) (virtual-clock tests), [BUILD_PLAN_V2.md](../plans/BUILD_PLAN_V2.md) Phase 16.
- ADRs 0009 (auth), 0016 (money), 0032 (wallet), 0033 (AI functions), 0038 (inbox), 0041 (WhatsApp calling), 0044 (insights), 0045 (public API), 0046 (webhooks).
- Conventions: [security.md](../conventions/security.md), [secrets.md](../conventions/secrets.md), [data.md](../conventions/data.md), [data-model.md](../conventions/data-model.md), [api.md](../conventions/api.md), [error-codes.md](../conventions/error-codes.md), [audit.md](../conventions/audit.md), [definition-of-done.md](../conventions/definition-of-done.md); [src/README.md](../../src/README.md).

**What exists (use it, don't rebuild) — exact entry points:**

| Area                                                 | Use                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secret box                                           | `shared/crypto/secret-box.ts`: `secretBoxKey(env)`, `seal(key, plain)`, `open(key, sealed)`, format `v1:<iv>:<tag>:<data>`, `SecretBoxError`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Sealed fields (the full list today)                  | `whatsappChannels.tokenSealed`, `whatsappChannels.registration.pinSealed`, `metaWebhookEvents.payloadSealed`, `webhookEndpoints.secretSealed`, `webhookEndpoints.secretPreviousSealed`, `aiAgents.functions[].headers[].sealed`, flow API-node secret headers (`flows.service.ts`; both draft and versions). Find any others by searching `seal(`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Contact variables readers (start list; search again) | `core/ai/run-turn.ts`, `core/ai/compile.ts`, `core/engine/engine.ts`, `modules/calls/{agent-script,flow-script,session,call.service,calls.service}.ts`, `modules/insights/insights.service.ts`, `modules/inbox/{outbound.service,conversations.service}.ts`, `modules/public-api/messages.service.ts`, `modules/contacts/contacts.service.ts`, `modules/ai-agents/{agents.service,playground.service,variables,functions.service}.ts`, `modules/contact-exports/export.job.ts`, `modules/contact-imports/{candidate,analyse,run.job}.ts`, `modules/templates/{send.service,template.service}.ts`, `modules/campaigns/{audience,export,single-call,dispatcher}.ts`, `modules/flows/{run-values,simulator.service,flows.service}.ts`, `modules/post-call/{send.job,evaluate}.ts`, `modules/webhooks/publish.ts`, `modules/record-exports/*` |
| Personal data stores (start list for DATA_MAP)       | `contacts`, `contactLists`, `conversations`, `messages`, `inboxUploads` + media files, `calls`, `callEvents`, `transcriptTurns`, `callInsights`, `conversationSummaries`, recordings files, `campaignContacts`, `flowRuns`, `agentPlaygroundSessions`, `postCallMessages`, `webhookEvents`, `webhookDeliveries`, `metaWebhookEvents`, `whatsappCallPermissions`, `dndEntries`, `importJobs` + files, `exportJobs` + files, `sheetImports` (url), `users`, `authCodes`, `apiRequestLogs`, `ledgerEntries`, `invoices`, `auditLogs`, `mockPaymentRecords`. **66 model files exist: check all of them.**                                                                                                                                                                                                                                     |
| Storage                                              | `core/storage` `StorageProvider`; users: `modules/calls/recording.ts`, `modules/calls/maintenance.ts`, `modules/inbox/{upload.service,media.service,outbound.service,retention.job}.ts`, `modules/contact-imports/*`, `modules/sheet-imports/run.job.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Soft delete + retention                              | `deleteContact` in `contacts.service.ts` (sets `deletedAt` only), `modules/retention/*`, `calls-purge`, `inbox-retention`, `modules/calls/maintenance.ts`, `modules/inbox/retention.job.ts` — reuse the file and row deletes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Exports                                              | `exportJobs` pipeline (`modules/contact-exports`, `modules/record-exports`), `EXPORT_JOB_SCOPES`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Auth                                                 | `modules/auth/{login.service,lockout,session,hmac,password}.ts`, `findUserByEmail`, `verifyPassword`, `blockWhenImpersonating()` (`require-permission.ts`), `requirePlatformAdmin()`, `AUTH_RATE_LIMIT` (30 / 15 min), `GLOBAL_RATE_LIMIT` (1,200 / min)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Superadmin                                           | `modules/admin/admin.service.ts` (`auditBothSides`, `findCustomerAccount`, `createAccount`, `resendOwnerInvite`, `setAccountLimits`, `impersonate`), `AdminAccountDetailPage.tsx`, `LimitsCard.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Public API                                           | `modules/public-api/key-limits.ts` (`publicApiGate`), `config/limits.ts` `PUBLIC_API_LIMITS`, `shared/middlewares/api-key-auth.ts` (30 s cache)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Docs                                                 | `modules/docs/openapi.controller.ts` (`createOpenApiHandler`, `createPublicOpenApiHandler`), `public-spec.ts`, `tests/http/docs.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Headers                                              | `shared/middlewares/security.ts` (Helmet; HSTS in production), `deploy/staging/nginx/cell-ai-voicebot.conf.template` (HSTS + `__CSP_HEADER__`), `scripts/smoke.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Compliance                                           | `settings.callingWindow` (default 09:00–19:00, days 1–6), `modules/dnd/*`, `modules/inbox/keywords.ts`, disclosure in `core/ai/compile.ts`, `recordingNotice`, `assertCanSend`, `assertMarketingFrequency`, `contacts.consent`, call `dial guard`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Perf                                                 | `scripts/perf-reports.ts` (`perfUri`), `scripts/perf-webhooks.ts`, `scripts/bench-{voice,campaign,wallet,contacts}.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Frontend                                             | `features/settings/*`, Settings tabs in `pages/SettingsPage.tsx`, `features/contacts/*`, `features/admin/*`, `renderWithProviders`, `signInAs`, `useConfirm`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| E2E                                                  | `e2e/helpers.ts`, `contacts.ts`, `calls.ts`, `inbox.ts`, `reports.ts` (`runDevJob`), `integrations.ts`, `E2E_FRONTEND_PORT=3150`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

**Bugs to avoid:** a reader that gets `{ $enc }` and prints it into a call or a template; encrypting a value twice on retry; a re-seal that loses data if stopped midway; erasing by phone across accounts; a purge query missing `accountId`; "deleted" rows that a nightly rollup or a retry job brings back; erasing the row but leaving the file; erased text surviving in `searchText`, `flowRuns`, `callEvents`, `metaWebhookEvents`, `webhookEvents` payloads or export files; deleting ledger rows and breaking wallet totals; export zips buffered in memory; a TOTP code accepted twice; recovery codes stored in plain text; a CSP that silently breaks the Meta popup or Razorpay; raising a timeout to hide a flake; a load test pointed at a shared DB; audit `meta` with phones; **inserting new audit actions mid-list (a slice test breaks — append at the end)**; a new module importing `deliver.job` into `app.ts` (a circular import hung test start-up in Phase 15).

---

## 1. LOCKED DECISIONS (exact literals — the plan has the prose)

**Owner defaults (plan §7 #1–#11) are in force** unless the plan says otherwise. Record "Defaults in use for §7 #1–#11" in the plan changelog at STEP 0. If a default turns out impossible, pick the closest safe option, write it as a deviation and continue. **Legal questions are not decided in code:** rules stay configurable and policy pages stay `status: draft`.

**Module layout (backend):**

- `src/shared/crypto/secret-box.ts` (v2), `src/shared/crypto/sealed-registry.ts` (every sealed field, with how to read and write it), `src/ops/keys-reseal.ts`.
- `src/modules/privacy/`: `sensitive.ts` (read / write helpers), `erase.service.ts`, `erase.job.ts`, `erase-map.ts` (one erase action per store), `suppression.ts`, `account-export.service.ts`, `account-export.job.ts`, `account-delete.service.ts`, `account-purge.job.ts`, `privacy.routes.ts`, `privacy.schema.ts`.
- `src/modules/compliance/`: `compliance.service.ts`, `compliance.routes.ts`, `compliance.schema.ts`.
- `src/modules/auth/mfa.service.ts` + `mfa.routes.ts`, `src/modules/auth/totp.ts` (RFC 6238 with `node:crypto`, no new dependency).
- Docs: `docs/security/{THREAT_MODEL,DATA_MAP,RATE_LIMITS,PENTEST_CHECKLIST}.md`, `docs/ops/{secret-rotation,nginx-security-headers,release-phase-16}.md`, `docs/adr/0047-encryption-key-rotation.md`, `docs/adr/0048-erasure-suppression.md`.
- Scripts: `scripts/check-live-headers.ts`, `scripts/perf-inbox.ts`, `scripts/perf-api.ts`, `scripts/perf-ws.ts`, `scripts/perf-soak.ts`.

**Encryption:**

- Sealed format: `v2:<keyId>:<iv>:<tag>:<data>`; `keyId` = first 8 hex characters of SHA-256 of the derived key. `open` chooses by `keyId` and still reads `v1` (tries current, then old keys).
- Env: optional `ENCRYPTION_KEYS_OLD` (comma list, each base64 of 32 bytes, validated by `env.ts`).
- New env `SUPPRESSION_HMAC_KEY` (base64, ≥ 32 bytes), never rotated, separate from `ENCRYPTION_KEY`. Optional at boot: without it in production, erase routes answer 503 `PROVIDER_UNAVAILABLE` so an existing deploy still starts. A dev fallback exists outside production.
- `npm run keys:reseal` (`--dry-run`, `--batch <n>`, default 200): resumable, re-reads each value, writes only if it changed, prints counts per field and never values. A test fails if any model has a `*Sealed` / `sealed` field missing from `sealed-registry.ts`.
- Phone, name and e-mail stay plain (plan §7 #1).

**Sensitive fields:**

- `customFields.sensitive: boolean` (default false; ADR 0047). Stored in `contacts.variables` as `{ $enc: 'v2:…' }`.
- One read path `readContactVariables(contact, { purpose })` and one write path in `modules/privacy/sensitive.ts`. `purpose` is `call | send | function | export | view | list`. A guard test fails if a file outside the helper reads `contact.variables` directly (a short, reviewed allowlist).
- Rules: search / segment filter on a sensitive field → 422 `SENSITIVE_FIELD_NOT_ALLOWED`; list views show `••••`; the contact page and exports show values only with `contacts.export`; API responses and webhooks never carry them unless the endpoint / key has personal data access (webhooks: `includePersonalData`; keys: never); never in logs, audit, `searchText`, `flowRuns.trace` or insight prompts. A flow, agent or template using the field gets the real value at run time.
- Marking / unmarking runs job `contacts.sensitive_field` on the `contacts` queue (idempotent, resumable, progress on the field: `sensitiveJob: { status, done, total }`).

**Erasure + suppression:**

- `POST /contacts/:id/erase` `{ confirm: 'ERASE' }` → 200 with counts; `POST /contacts/bulk-erase` `{ ids: [≤ 1,000], confirm: 'ERASE' }` → 202 + job `contacts.erase` on the `contacts` queue; `GET /contacts/erase-jobs/:id`. Permission **`contacts.erase`** (owner, admin), blocked while impersonating, session only (no API key scope).
- Refused with 409 `CONTACT_ERASE_BLOCKED` while that contact has a live call; a campaign contact mid-dial is skipped and retried by the job.
- Actions (`erase-map.ts`, one entry per DATA_MAP row):
  - **Delete:** contact, conversations, messages + media, inbox uploads, transcripts, insights, conversation summaries, recordings, playground sessions, flow runs, post-call messages, webhook events / deliveries about the contact, call permissions, DND entry (the opt-out moves to suppression), campaign contact personal fields.
  - **Scrub, keep the row:** `calls` (`to`, `from` when it's the customer, `variables`, `outcome`, recording, insights, contact link removed; id, status, duration, cost stay), `callEvents` (text removed), `ledgerEntries` (keep amounts, remove any phone or name), `importJobs` (files deleted when they hold the number: the whole file is removed), `exportJobs` (files holding the contact deleted).
  - **Keep:** audit rows (no personal data by rule; the leak scan proves it), invoices, `statsDaily` (numbers only).
- `metaWebhookEvents` hold raw sealed payloads: delete rows matching the contact's `waId`.
- Suppression model `suppressions` `{ accountId, phoneHmac, reason: 'erased' | 'opted_out' | 'dnd', at }`, unique `{ accountId, phoneHmac }`, HMAC-SHA256 of E.164 with `SUPPRESSION_HMAC_KEY`. Checked on file / sheet import, API upsert and sends. A person who writes first after a plain erase is a new contact; `opted_out` / `dnd` stay blocked for business-initiated sends (plan §7 #3).

**Account export + delete:**

- `POST /account/export` `{ password, includeRecordings? }` → 202; `GET /account/exports`, `GET /account/exports/:id` (signed link, 24 h). One at a time → 409 `ACCOUNT_EXPORT_IN_PROGRESS`; files deleted after 7 days by maintenance `account-exports-cleanup` (daily). Job `account.export` on `contacts`. Streamed zip; JSON lines for records, CSV for contacts. Use an existing zip capability if there is one, otherwise one new dependency `archiver` (pinned, audited, recorded as a deviation).
- `POST /account/delete` `{ password, confirmName }` → status `scheduled`, `scheduledFor = now + 7 days`; `POST /account/delete/cancel`. Refused with 409 `ACCOUNT_DELETE_BLOCKED` while a wallet hold exists. On scheduling: campaigns paused, API keys revoked, webhooks paused, numbers stay until purge. On purge: WhatsApp numbers disconnected, every store purged using the erase code, the account row kept as a tombstone (`status: 'deleted'`, name replaced, invoices + ledger + audit kept). Maintenance `account-purge` (hourly), resumable. Permissions **`account.export`** and **`account.delete`** (owner only), password re-entry → 422 `REAUTH_FAILED`, blocked while impersonating.
- Superadmin: `GET /admin/account-deletions`, `POST /admin/accounts/:id/deletion/cancel`, `POST /admin/accounts/:id/deletion/run` (only after the grace), audited on both sides. Remaining wallet balance: shown, handled manually (plan §7 #4).

**Compliance:**

- `GET /account/compliance` (`account.read`), `GET /account/compliance/export` (CSV of DND and opt-out changes; phones masked unless `contacts.export`).
- `platformSettings.callingWindowCeiling` default `{ start: '08:00', end: '19:00' }` (superadmin editable; a value to confirm with the client, plan §7 #8). An account can't save a window outside it → 422 `VALIDATION_FAILED`. It doesn't change the default 09:00–19:00.
- Opt-in: `contacts.consent` `{ source, at }`; marketing template without it → send proceeds with a warning in the response and UI (plan §7 #7), behind setting `requireOptInForMarketing` (default false).

**Hardening:**

- Production `/api/v1/openapi.json` serves the public spec unless `API_DOCS_ENABLED`.
- Superadmin TOTP: `POST /auth/mfa/setup`, `POST /auth/mfa/confirm`, `POST /auth/mfa/verify`, `POST /auth/mfa/disable`; secret sealed in `users.mfa.secretSealed` (add to the registry), 10 recovery codes stored as hashes, a used time-step can't repeat. Enforced by `MFA_ENFORCED_FOR_ADMINS` (default **false**, so a deploy can't lock the only superadmin out; the release notes say to enable it after setup). Impersonate, account delete run and `POST /admin/accounts` need a fresh MFA check when enforced → 403 `MFA_REQUIRED`; a wrong code → 422 `MFA_INVALID`.
- Per-account key limits: `accounts.apiLimits { readsPerMinute, writesPerMinute }` (null = default 600 / 60, max 6,000 / 600), `PATCH /admin/accounts/:id/api-limits`, picked up within 30 s.
- Upload checks by content; CSV / XLSX exports neutralise formula-leading cells (`= + - @`).

**Catalogue additions (append at the end of each list; update the count tests in the same commit):**

- Error codes **+7 → 103:** `SENSITIVE_FIELD_NOT_ALLOWED` 422, `CONTACT_ERASE_BLOCKED` 409, `ACCOUNT_EXPORT_IN_PROGRESS` 409, `ACCOUNT_DELETE_BLOCKED` 409, `REAUTH_FAILED` 422, `MFA_REQUIRED` 403, `MFA_INVALID` 422.
- Audit actions **+15 → 165:** `contact.erased`, `contacts.bulk_erased`, `custom_field.sensitive_changed`, `account.export_requested`, `account.export_downloaded`, `account.delete_requested`, `account.delete_canceled`, `account.purged`, `account.api_limits_changed`, `compliance.exported`, `compliance.ceiling_changed`, `mfa.enabled`, `mfa.disabled`, `mfa.recovery_used`, `keys.resealed`.
- Notifications **+3 → 36:** `account.export_ready`, `account.delete_scheduled`, `contacts.erase_completed`. E-mail templates `account.export_ready`, `account.delete_scheduled`, `account.delete_canceled`.
- Permissions **+3:** `contacts.erase`, `account.export`, `account.delete`.
- Migration **`0018-security-privacy`**: indexes for `suppressions` and `accountExports`, defaults on `customFields.sensitive`, `accounts.apiLimits`, `users.mfa`; no data rewrite; `down` removes what it adds. Tests: extend `phase2-migrations` by one `migrateDown`.
- Models: `suppression`, `account-export`, `erase-job`; `accounts.deletion { status, requestedAt, requestedBy, scheduledFor, purgedAt }`.
- Jobs: `contacts.sensitive_field`, `contacts.erase`, `account.export`, `account.purge`. Maintenance: `account-purge`, `account-exports-cleanup`.

**Load targets (plan T16.8):** proposals; **never change a target to pass.** A miss is a finding: fix it or record it with a reason and owner.

---

## 2. RULES OF ENGAGEMENT

1. **NEVER STOP, NEVER WAIT, NEVER ASK.** Checkpoints are commits, not pauses. The only output before the end is a 2–3 line progress note at each checkpoint, written while continuing in the same turn.
2. **Blocked? Unblock yourself.** Unclear spec → plan §1 / §7 default → safest convention-consistent choice → deviation note. Tool problem (Docker down, port busy, flaky test) → fix it within the rules → still blocked → skip only that sub-step, record it as an open item, continue, retry at the next checkpoint. Anything needing a secret, the client's server, a push or a destructive action → don't do it, record it, continue.
3. **Git:** branch `feature/phase-16-security-qa` in both repos; never on `main`; one commit per task per repo, one repo at a time; hooks must pass (no `--no-verify`, no `--force`); **no push / merge to main / tag**; footer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; lines ≤ 100 characters; message in a scratchpad file + `git commit -F`; no body line starts with `word:`.
4. **Verify after every code task: each command separately, read output + exit code; never chain `git commit` after checks.**
   - Backend: `npm run lint` · `npm run format:check` · `npm run typecheck` · targeted `npx vitest run <changed areas> --maxWorkers=2` · `npm run build` · `npm run openapi:check` (stage `openapi/openapi.json` first). Full `npx vitest run --coverage --maxWorkers=2` at the end of every backend task that touches shared code and at every checkpoint (background, `caffeinate -i`, wait for the notification; never poll with sleeps, never run another heavy suite meanwhile).
   - Frontend: `npm run lint` · `npx prettier --check .` · `npm run typecheck` · `npx tsc -p tsconfig.e2e.json --noEmit` · targeted vitest · `npm run build`; full `npx vitest run --coverage --maxWorkers=2` per frontend task; whole Playwright suite at B2 / B3 and after T16.10 — infra up, this project's dev servers stopped, `E2E_FRONTEND_PORT=3150`, from the frontend folder; run 2 with `E2E_BACKEND_LOGS=1` + log grep.
   - A test failing only under full-suite load and passing alone 3 / 3 is a flake: record it and keep it for T16.10; don't weaken it.
5. **Coverage gates stay green; never lower thresholds; never raise test timeouts; no dynamic `import()` in backend tests.**
6. **Secrets / personal data:** never print, log or commit `.env` values, keys, TOTP secrets, recovery codes, phones, names, message texts or sensitive field values. Tests assert the new jobs' logs contain none of them.
7. **No external network in tests.** Meta and OpenAI stay faked.
8. **Docker on the Mac:** only `npm run infra:*` (`cav-*`) and one-off `docker run --rm`. Dev DB `cell_ai_voicebot` on `cav-mongo` 27018, E2E DB `cav_e2e`, load DB `cav_perf`. **Never connect to Atlas or the client's database, and never read `~/Downloads/*.env*`.**
9. **Never kill other projects' processes** (port 3100 is another project; E2E uses 3150).
10. **Destructive code must be proven before it runs anywhere:** every purge query has `accountId`; erase and purge have tests that seed **two accounts** and prove the other is untouched. No erase, purge or re-seal runs against any database except test DBs and `cav_perf`.
11. **Docs in the same commit** as the code they describe.
12. **Real bugs in committed code:** reproduce → regression test proven failing first → separate `fix(<area>)` commit → plan changelog + final report. A serious production bug: note it for the owner in the report; the fix on `main` is the owner's call.
13. **Catalogue / count tests** are updated in the same commit that adds entries; `docs/conventions/audit.md` and `error-codes.md` stay identical to the code.
14. **One source of logic:** erase and purge share `erase-map.ts`; a sensitive value has one read path.
15. **Progress notes** (at each checkpoint, then keep going): "P16-B1-DONE ✅ — <tests> backend tests, coverage <x>; next: T16.4" — nothing more.

---

## 3. RESUME SAFETY (after a context compaction or a restart)

1. `git -C cell-ai-voicebot-backend branch --show-current` → `feature/phase-16-security-qa`; same for the frontend; `git log --oneline -20` in both.
2. The last `[P16-…]` tag tells the position; `docs/phases/PHASE_16_TASKS.md` ticks must agree (fix the tracker if a tick is missing).
3. Uncommitted work → `git status` + `git diff` → finish that task, verify, commit. Never discard work without reading it.
4. `npm run infra:up` → `npm run db:migrate` (dev) → backend lint + typecheck → targeted tests of the last task → continue with the **next** task. Don't redo committed tasks.
5. Then keep going to `P16-B3-DONE`; a resume is not a reason to stop or report early.

---

## STEP 0 — P16-SETUP (before T16.1)

1. Both repos on `feature/phase-16-security-qa`; backend `git status` shows only the plan, tracker, BUILD_PLAN_V2 and this prompt. Anything else → read it; unrelated work stays unstaged.
2. `git fetch origin` both repos; if `origin/main` moved past `1df8f82` / `707127c`, merge `main` into the branch.
3. Plan status → **Locked**; changelog line: "Run prompt prepared — literals locked: error codes +7 → 103, audit +15 → 165, notifications +3 → 36, permissions +3, migration 0018; defaults in use for §7 #1–#11."
4. Commit 1: plan + tracker + BUILD_PLAN_V2 → `docs(plans): lock phase 16 decisions [P16-PLAN]`. Commit 2: this prompt → `docs(prompts): add phase 16 run prompt [P16-PROMPT]`.
5. Baseline: `npm run infra:up`, `npm run db:migrate`, backend + frontend lint / typecheck green (record counts). **Then continue straight into T16.1.**

---

# ═══════════ BATCH 1 — Foundation (T16.1 → T16.3) ═══════════

## T16.1 — Threat model + secrets runbook → `docs(security): add threat model, data map and rotation runbook [P16-T16.1]`

1. `docs/security/THREAT_MODEL.md`: assets (phones, loan data, recordings, chats, wallet money, Meta tokens); actors (outsider, another customer, a staff user, a leaked API key, a malicious webhook target or sheet, a customer's words to the AI); entry points; for each pair the control and the test that covers it. An uncovered row → a task here or an open item.
2. `docs/security/DATA_MAP.md`: **go through all 66 model files + every storage user.** Per store: personal fields, retention, erase action (delete / scrub / keep + why), export included (y / n). Models with no personal data are listed too, marked "none".
3. Test `tests/security/data-map.test.ts`: every Mongoose model is named in DATA_MAP.md (a new model without a row fails).
4. `docs/ops/secret-rotation.md`: every secret (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `ENCRYPTION_KEY`, `SUPPRESSION_HMAC_KEY`, Mongo URI, Redis, OpenAI, Meta App Secret, System User token, Razorpay, SMTP, the review account); who rotates it, the order, the effect on sessions, how to verify, and a first-rotation date placeholder for the owner ("after App Review ends; review login last").
5. Update `docs/conventions/secrets.md` with a link. No code change → format check only.

## T16.2 — Dependencies, headers, exposure → `fix(security): upgrade vulnerable packages and tighten headers [P16-T16.2]` (both repos)

1. Backend: fix highs `body-parser`, `multer`, `zod` and moderates `ip-address`, `nodemailer`, `qs`. Frontend: highs `follow-redirects`, `zod`, moderates `fast-uri`, `seroval`. Upgrade one group at a time; run its tests. `zod`: check `@asteasolutions/zod-to-openapi`, then regenerate and **read the OpenAPI diff**; run `npm run gen:api` in the frontend. `multer`: upload tests. `nodemailer`: e-mail tests.
2. `npm audit --omit=dev` → 0 high / critical in both repos; record any moderate with no fix. CI: `npm audit --audit-level=high` stays required; add `.github/dependabot.yml` (weekly, both repos).
3. Production `/api/v1/openapi.json` → public spec unless `API_DOCS_ENABLED`. Update `tests/http/docs.test.ts`; `gen:openapi` and the frontend's `gen:api` keep using the full local file.
4. Headers: tests for the API's Helmet set. **One HSTS owner:** add env `HSTS_BY_PROXY` (default false); when true the API doesn't send HSTS, fixing the double header. In `deploy/staging/nginx` add missing headers; CSP stays report-only in staging until checked in Playwright with Meta SDK, Razorpay, WebSocket and audio, then enforced by the template variable, with a one-line rollback. `docs/ops/nginx-security-headers.md`: a paste-ready block for the client's nginx.
5. `scripts/check-live-headers.ts <url>` (`npm run check:headers`): read-only `GET` / `HEAD`, reports each expected header, tests each DNS address separately (the U1 finding) and exits 1 on a problem; unit-tested with a local stub. `scripts/smoke.ts` gets the same header checks.
6. Review CORS, `origin-check`, cookie flags, body limits and upload limits. Write results as rows in `docs/security/PENTEST_CHECKLIST.md` (created here). Fix findings in this task, each with a test.

## T16.3 — Key rotation → `feat(security): rotate encryption keys without downtime [P16-T16.3]`

1. `secret-box.ts` v2 per §1: `secretKeys(env)` returns `{ current, all }`; `seal` writes v2; `open` picks by `keyId` and reads v1. Update every caller; keep `seal` / `open` signatures compatible, or change all callers in this commit.
2. `env.ts`: `ENCRYPTION_KEYS_OLD`, `SUPPRESSION_HMAC_KEY`, validation, `.env.example`, README env table.
3. `sealed-registry.ts`: one entry per field in §0 with `{ model, path, read, write }`. Nested arrays (agent headers, flow nodes in draft and versions) get their own walkers.
4. `src/ops/keys-reseal.ts` + `npm run keys:reseal` + compile for the image; `tools.sh` op `keys:reseal`. Audit `keys.resealed` (counts only).
5. Tests: v1 still opens; rotate → all fields open; re-seal moves all to the new key; second run changes 0; stop in the middle + resume; wrong key → clear error, no writes; tampering refused; registry completeness test; logs have no values.
6. ADR 0047 (encryption layers: what is sealed, what is not and why; rotation; backup of keys). `docs/ops/secret-rotation.md` gets the steps. `docs/conventions/secrets.md` + `data.md` updated.

## P16-B1-DONE — checkpoint → `docs: mark phase 16 batch 1 complete [P16-B1-DONE]`

1. Both repos full verify (each command separately, coverage both, builds, `openapi:check`).
2. Tracker ticks T16.1–T16.3, CHANGELOGs `Phase 16 · Batch 1`, plan changelog.
3. Commit, 2-line progress note, **immediately start T16.4.**

---

# ═══════════ BATCH 2 — Data rights (T16.4 → T16.6) ═══════════

## T16.4 — Sensitive fields → `feat(privacy): encrypt custom fields marked sensitive [P16-T16.4]` (both repos)

1. Migration `0018-security-privacy` + models per §1 (catalogue + count tests here for what this task adds).
2. `modules/privacy/sensitive.ts`. **Search again for every reader** (§0 is a start list) and move each to the helper; put the final list in the plan changelog.
3. Guard test: no direct `contact.variables` / `.variables` read of contact data outside the allowlist.
4. Rules per §1 at each path: calls and flows, agents + functions, templates, inbox, API, webhooks, imports (a re-import writes sealed), exports, segments + audience (422), reports, insights prompts, `searchText`, `flowRuns.trace`.
5. Job `contacts.sensitive_field` (both directions, idempotent, safe to restart). Add sensitive values to the T16.3 re-seal registry.
6. Frontend: "Sensitive" switch with a warning and progress in Settings → Contact fields; masked values in lists; contact page by permission; fields hidden from segment filters. Branch-complete tests.
7. Tests per path: a flow call and a template send get the real value; the DB dump shows no value; viewer sees `••••`; API + webhook without it; logs clean. Bench 100,000 contacts: list, import and campaign start before / after; record in the plan changelog. A slowdown over 20 % is a finding.

## T16.5 — Erasure + suppression → `feat(privacy): erase a contact everywhere and keep it suppressed [P16-T16.5]` (both repos)

1. `erase-map.ts`, `erase.service.ts`, `erase.job.ts`, routes per §1. **Every DATA_MAP row has one entry; a test fails if not.**
2. Suppression checks at file / sheet imports, API upsert, bulk upsert and sends; opt-outs and DND of an erased person become suppression rows.
3. Live-call refusal, mid-dial skip + retry. Rollups, retries and scheduled post-call jobs must not bring anything back: a queued job for an erased contact ends with a skip.
4. **Leak scan** `tests/privacy/erase-leak.test.ts`: seed one person with a unique phone, name and text marker through every store and a local storage folder, in two accounts; erase in one; walk **every collection of the test DB and every stored file**. Hits for the marker → 0 in that account, except allowed fields. The other account is unchanged. Same scan with the phone in digits-only and masked forms.
5. Wallet totals and ledger counts are the same before and after; reports stay correct.
6. Frontend: contact page "Erase permanently" with typed `ERASE`, bulk action with progress, permission-based. Tests. `Privacy Policy` draft text. ADR 0048.
7. Audit `contact.erased`, `contacts.bulk_erased` with counts only.

## T16.6 — Account export + delete → `feat(privacy): export and delete a whole account [P16-T16.6]` (both repos)

1. Export per §1: memory stays flat (a test or bench with 100,000 contacts; record peak RSS), one at a time, signed link, cleanup, notification + e-mail, sensitive fields decrypted only inside the owner's export.
2. Delete per §1: schedule, cancel, purge job, resumable, tombstone, WhatsApp disconnect through the existing service, campaign pause, key revoke, webhook pause. The account can't log in during purge. Suspended accounts: still allowed for the owner.
3. Superadmin screens and routes; audit both sides; show pending deletes and remaining wallet balance.
4. Frontend: Settings → Account "Export all data" and "Delete account" (password + typed name, grace banner with Cancel); admin list. Tests.
5. Tests: export contains each store listed in DATA_MAP and nothing from another account; grace + cancel; purge leak scan (reuse T16.5) with a second account untouched; restart mid-purge; hold blocks delete; impersonation blocked; wrong password; owner only.

## P16-B2-DONE — checkpoint → `docs: mark phase 16 batch 2 complete [P16-B2-DONE]` (both repos)

1. Both repos full verify (each command separately, coverage both, builds, `openapi:check`).
2. **Playwright whole suite twice** (existing 163 stay green): run 2 with `E2E_BACKEND_LOGS=1` + log grep: full keys, `whsec_`, signature values, phones, names, message texts, summaries, sensitive values, TOTP secrets, passwords, Bearer tokens = 0.
3. Bundle numbers, tracker ticks T16.4–T16.6, CHANGELOGs `Phase 16 · Batch 2`, plan changelog.
4. Merge `main` if it moved (+ verify). Commit, 2-line progress note, **immediately start T16.7.**

---

# ═══════════ BATCH 3 — Assurance (T16.7 → T16.11) ═══════════

## T16.7 — Compliance → `feat(compliance): prove calling, opt-out and consent rules on every path [P16-T16.7]` (both repos)

1. `tests/compliance/matrix.test.ts`, **path × rule** table-driven. Paths: web test, dry run, campaign, API `POST /calls`, WhatsApp agent call, WhatsApp AI call, inbox send, API template / text send, after-call send (rule and flow step), sheet / file import. Rules: calling window (account timezone, first / last minute, closed day), DND, opt-out, suppression, AI disclosure at call start, recording notice, marketing frequency, 24-hour window, consent warning. Rows that don't apply are marked `n/a` with a reason. A missing rule → `fix(compliance)` commit with its test.
2. Opt-out words: Hindi, Hinglish, English (`STOP`, `band karo`, `mat bhejo`, `unsubscribe`, others in `keywords.ts`), case and spacing; opt-in again; voice path sets DND ("don't call me" → the existing disposition / DND path; if none exists, add it behind the flow's outcome and document it).
3. Opt-in: consent shown on the contact page, in imports and API; warning on marketing sends; `requireOptInForMarketing`.
4. `callingWindowCeiling` (superadmin), validation, tests.
5. Settings → Compliance (read-only) + CSV export; audit `compliance.exported`. Tests for permissions and masked phones.
6. Privacy Policy and Terms text for erasure, export and Meta deletion: keep `status: draft`. `docs/security/COMPLIANCE.md`: rule → code → test, and which ones the client's legal team must confirm (§7 #8, #9).

## T16.9 — Hardening → `feat(security): add rate limit inventory, per-account key limits and admin 2fa [P16-T16.9]` (both repos)

1. Test `tests/security/rate-limits.test.ts`: walks the Express routes and fails when an unauthenticated route, or one on an allowlist of expensive routes, has no limiter. `docs/security/RATE_LIMITS.md` is generated from it. Fix gaps: signup, invites, OTP resend, public unsubscribe, deletion status, `POST /admin/accounts`.
2. Per-account key limits per §1 + `LimitsCard` UI + tests (default, raised, 30 s pickup, ceiling).
3. Superadmin TOTP per §1: `totp.ts` against RFC 6238 vectors; replay refused; recovery codes hashed and single use; setup screen (shows the secret + `otpauth://` link, copyable; no new QR dependency), verify step on login; lost-device runbook; default off via `MFA_ENFORCED_FOR_ADMINS`. A lockout test proves a superadmin can't be locked out by enabling it without setup.
4. Sessions: all revoked on password change; invite expiry; impersonation limits (tests, fix gaps).
5. Audit review: a matrix test that every sensitive action writes a row; a test that scans audit `meta` from a full E2E-like run for phone / name patterns; retention 2 years in `retention` config.
6. Uploads: content-type sniffing, size limits, zip bomb test, CSV formula neutralising in every export, HTML shown as text in message and webhook snippets. Tests with a corpus.
7. Add rows and results to `PENTEST_CHECKLIST.md`.

## T16.8 — Load tests → `test(perf): add inbox, api, websocket and soak load checks [P16-T16.8]`

1. All in `cav_perf` + a unique BullMQ prefix, refuse `NODE_ENV=production`, drop at the end, print numbers and PASS / FAIL, run **alone** with nothing else heavy (never on the client's server).
2. `npm run perf:inbox`: Meta webhook burst, 500 events / s × 2 min, signed, on the fake provider. Target: 0 lost, 0 duplicates, drained ≤ 2 min, API p95 < 300 ms.
3. `npm run perf:api -- messages`: 50 rps × 60 s across 50 keys (each stays under 60 writes / min, or per-account limits from T16.9) on fake Meta. Target: p95 < 500 ms, 0 double charges, wallet balances exactly with the ledger.
4. `npm run perf:api -- calls`: 50 rps × 60 s on the dry-run line. Target: p95 < 500 ms; over capacity a clear 429, never a 500; calls and holds reconcile.
5. `npm run perf:ws`: 1,000 connections, 100 events / s. Target: delivery p95 < 500 ms, no leak after disconnect.
6. `npm run bench:voice` raised until failure: record max per process, CPU, memory for Phase 17 sizing.
7. `npm run perf:soak`: mixed load 1 hour; memory and queue depth flat (record samples).
8. **Sign-up under load:** reproduce the Phase 14 / 15 symptom (`Check your email` not appearing). Measure argon2 pool and e-mail enqueue first; fix the cause in a `fix(auth)` commit or record the finding with evidence.
9. Results table in the plan changelog + `docs/ops/capacity.md`. A missed target: fix it, or open item with reason and owner.

## T16.10 — Flakes + tests → `test: fix known flakes and add phase 16 e2e and security checks [P16-T16.10]` (both repos)

1. Fix at the cause, with no timeout raises: `tests/calls/flow-call.test.ts` max duration (69 vs ≤ 65 under load; fake clock keeps ticking during settle), `tests/campaigns/dispatcher.test.ts` (two cases), Phase 12 virtual-clock tests, Playwright `inbox-roles.spec.ts`, heavy hardening tests. Each with a commit-sized explanation in the plan changelog. A flake with no fix stays open with evidence.
2. Target: **5 full backend runs in a row green** (background, alone). Record each run.
3. PHP sample in `tests/docs/public-docs.test.ts`: runs when `php` exists (skip + note otherwise; don't install anything).
4. Playwright `e2e/security-*.spec.ts`, helpers `e2e/security.ts`: sensitive field masked by role and used in a call; contact erasure (gone from list, chat and call page; re-import blocked for an opted-out number); account export download; account delete + cancel + banner; compliance page; superadmin 2FA setup and login; key limits; viewer / agent / manager views.
5. `tests/security/phase16-*.test.ts`: every new route isolated per account (404), permission matrix snapshot, API keys refused on all privacy and MFA routes, logs without values.
6. Both repos full verify + **Playwright whole suite twice** + extended log grep.

## T16.11 — Pen-test checklist, gap audit, sign-off → `docs: add phase 16 sign-off and docs [P16-T16.11]` (both repos)

1. Finish `docs/security/PENTEST_CHECKLIST.md` against the OWASP API Security Top 10 and ASVS-based items: broken object and function level auth, auth, mass assignment, resource use, SSRF, misconfiguration, inventory, unsafe API use, injection (NoSQL, prompt, CSV, header), XSS, CSRF, file upload, secrets, logging. Each row: test or manual step, result, evidence. **Manual probes run on local only.** Findings are fixed (own `fix(...)` commit) or open items with an owner.
2. Gap audit: plan §0 Done-when + §4 + §1a U1–U4 + every row in §1c + this prompt §4. Every gap → fix now or an explicit open item with the reason.
3. Docs: `security.md` (new sections), `data.md`, `data-model.md`, `error-codes.md`, `audit.md`, `api.md`; `src/README.md` rows; both READMEs (features, scripts, env table); both CHANGELOGs; ADRs 0047, 0048 in the ADR index; BUILD_PLAN_V2 changelog ("Phase 16 done … Next: Phase 17"); `docs/ops/staging.md` runbook (re-seal, erase job stuck, purge stuck, export cleanup, MFA lost device). **`docs/ops/release-phase-16.md` for the client's deploy:** migration 0018; new env (`SUPPRESSION_HMAC_KEY`, optional `ENCRYPTION_KEYS_OLD`, `HSTS_BY_PROXY`, `MFA_ENFORCED_FOR_ADMINS`); new permissions; the nginx block; DNS check; what to verify after deploy; rollback.
4. `docs/phases/PHASE_16_SIGNOFF.md` (Phase 15 format): scope, tests + coverage (both), Playwright runs, load results, bundle, deviations, bugs fixed, findings, flakes, open items + owners.
5. Tracker all ticked; plan changelog final line.

## P16-B3-DONE — checkpoint → `docs: mark phase 16 complete [P16-B3-DONE]` (both repos)

1. Final full verify both repos (each command separately), branch diffs scanned for keys / URIs (gitleaks if installed; otherwise pattern scan, and say so), `npm audit --omit=dev` 0 high, Playwright once more (green), `git status` clean in both, `git log --oneline main..HEAD` listed.
2. **Final report (Hinglish, the only full report of the run):** what was built (per task, 1 line each), numbers (tests before → after, coverage, Playwright, load, bundle), commits per repo (short sha + subject), deviations, bugs fixed, findings, flakes, open items (incl. "U1–U3 owner actions, push / merge to main, client's deploy, legal confirmation, secret rotation date"), and how to try it locally.

---

## 4. FINAL CHECKLIST

**Step 0**

- [ ] `[P16-PLAN]` lock (defaults + literals) and `[P16-PROMPT]`; baseline green

**Batch 1**

- [ ] T16.1 threat model, data map for all 66 models + storage, data-map test, rotation runbook
- [ ] T16.2 audit 0 high in both repos, Dependabot, public OpenAPI only in production, one HSTS, CSP plan, nginx block, `check:headers` incl. each DNS address, CORS / cookie / upload review
- [ ] T16.3 secret box v2, v1 still reads, registry + completeness test, `keys:reseal` (dry run, resumable), ADR 0047
- [ ] P16-B1-DONE (verify) → continued without stopping

**Batch 2**

- [ ] T16.4 sensitive fields on every reader, guard test, job, UI, bench
- [ ] T16.5 erase + bulk, suppression at all entry points, leak scan with two accounts, money intact, UI, ADR 0048
- [ ] T16.6 account export (streamed), delete + grace + cancel + purge, superadmin, UI, leak scan
- [ ] P16-B2-DONE (verify both, Playwright twice + log grep, bundle) → continued without stopping

**Batch 3**

- [ ] T16.7 compliance matrix, opt-out words, opt-in, ceiling, Compliance page + CSV, policy drafts, COMPLIANCE.md
- [ ] T16.9 rate limit test + inventory, per-account key limits, superadmin TOTP, session + audit + upload reviews
- [ ] T16.8 perf inbox, API messages, API calls, WebSocket, voice max, soak; sign-up under load investigated; capacity doc
- [ ] T16.10 flakes fixed at the cause, 5 green backend runs, PHP sample, E2E + security tests, Playwright twice
- [ ] T16.11 pen-test checklist, gap audit, all docs, release notes, sign-off
- [ ] P16-B3-DONE (final verify, clean trees, final Hinglish report)
