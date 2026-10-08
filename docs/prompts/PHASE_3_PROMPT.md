# P3 RUN — Contacts, Lists & Custom Fields (T3.1 → T3.18) — Autonomous Run Prompt

> **HOW TO RUN — 3 batches, one at a time (same as Phase 2). Har batch ke baad report padho, phir agla paste karo.**
>
> **Batch 1 (data + APIs):**
> `cell-ai-voicebot-backend/docs/prompts/PHASE_3_PROMPT.md padho aur BATCH 1 (T3.1 se P3-B1-DONE tak) SAARE tasks step by step autonomously implement karo. Bich me koi question mat poochho, permission mat maango — saare decisions is prompt + PHASE_3_PLAN.md me pre-made hain. Har task ke baad verify (har command alag) + commit (tag [P3-T3.x]). Koi push / merge NAHI. Ant me P3-B1-DONE checkpoint + final report (Hinglish).`
>
> **Batch 2 (import / export / jobs):**
> `cell-ai-voicebot-backend/docs/prompts/PHASE_3_PROMPT.md padho aur BATCH 2 (T3.7 se P3-B2-DONE tak) SAARE tasks step by step autonomously implement karo. Bich me koi question mat poochho, permission mat maango. Har task ke baad verify + commit (tag [P3-T3.x]). Koi push / merge NAHI. Ant me P3-B2-DONE checkpoint + final report.`
>
> **Batch 3 (frontend + E2E + sign-off):**
> `cell-ai-voicebot-backend/docs/prompts/PHASE_3_PROMPT.md padho aur BATCH 3 (T3.13 se P3-B3-DONE tak) SAARE tasks step by step autonomously implement karo. Bich me koi question mat poochho, permission mat maango. Har task ke baad verify + commit (tag [P3-T3.x]). Koi push / merge NAHI. Ant me P3-B3-DONE checkpoint + Phase 3 sign-off + final report.`
>
> **Claude Code "accept edits" mode me chalao.** Working directory: `/Users/lalitbansal/Documents/cell-ai-voicebot`. **Docker Desktop chalu hona chahiye** (`open -a Docker`).

---

## 0. CONTEXT (verified facts — dobara derive mat karna)

**Phase 2 done & signed off** ([PHASE_2_SIGNOFF.md](../phases/PHASE_2_SIGNOFF.md)). Branch **`feature/phase-3-contacts`** already exists in **both** repos (created from the Phase 2 tip: backend `39e1b0f [P2-B3-DONE]` → `e145744 [P3-PLAN]`; frontend `477356d`). Phase 1 / 2 branches are not merged — merge order later: phase-1 → dev, phase-2 → dev, phase-3 → dev.

**Numbers at start:** backend **540 tests**, coverage gate **95 / 80 / 90 / 95** (measured 95.2 / 83.7 / 94.2 / 97.2); frontend **187 tests + 5 Playwright scenarios**, gate **90 / 85 / 85 / 90** (measured 91.9 / 87.9 / 86.2 / 93.8). **Statements 95 is tight on the backend → every new file needs thorough tests from the start.**

**Pehle padho (har batch se pehle):** [PHASE_3_PLAN.md](../phases/PHASE_3_PLAN.md) (**source of truth — scope + locked decisions §1, limits §1e, client defaults §7**), [src/README.md](../../src/README.md), conventions [api.md](../conventions/api.md) (§5 404-not-403, §6, §7, §8, **§11 uploads**, §13), [error-codes.md](../conventions/error-codes.md), [data.md](../conventions/data.md) §9, [data-model.md](../conventions/data-model.md) §2.2, [websocket.md](../conventions/websocket.md) §5, [audit.md](../conventions/audit.md), [compliance-notes.md](../compliance/compliance-notes.md) §2–§4, ADRs 0004, 0005, 0016, 0017 (+ Phase 2 notes), 0018, 0023, 0029. Frontend: `src/README.md`, `README.md`.

**What exists (use it, don't rebuild):**

| Area                 | Provides                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Module pattern (BE)  | `src/modules/<x>/{x.routes.ts, x.schema.ts, x.service.ts}` (controllers only where needed). Router factory `createXRouter()` → `router.use(authenticate())` → `requirePermission('…')` → `...handle({ body, query, params }, async ({ body, query, params, req, res }) => …)`; mounted in `src/routes.ts`; schema files imported in `src/openapi.ts`.                                                                                                                                                                     |
| Auth / tenancy       | `authenticate()`, `requirePermission(p)`, `requireAnyPermission`, `blockWhenImpersonating()`, `requireAuth(req)` → `{ userId, accountId, roleKey, permissions, impersonatorId? … }`, `tenantFilter(req)`, `toObjectId(id)`, `findOwnedOr404(model, id, req, projection?)`; suspended account → non-GET 403 automatically.                                                                                                                                                                                                 |
| Envelope / errors    | `ok(res, data, meta?)`, `created`, `noContent`; `AppError`, `ValidationError(details)`, `NotFoundError`, `ConflictError(code, message?, details?)`, `ForbiddenError`; `ERROR_CODES` ↔ error-codes.md (sync test).                                                                                                                                                                                                                                                                                                         |
| Validation / OpenAPI | `PaginationQuerySchema`, `CursorQuerySchema`, `sortSchema`, `PhoneE164Schema`, `ObjectIdSchema`, `strictQuery`, `isTimezone`; `registry`, `z.openapi`, `successEnvelope()`, `OffsetPageMetaSchema`, `src/shared/openapi/responses.ts` (standard error responses); `npm run gen:openapi` / `openapi:check`.                                                                                                                                                                                                                |
| DB                   | `basePlugin({ hide })`, `tenantPlugin`, `softDeletePlugin` (`withDeleted`), `withTransaction(fn)`, migrations registry (`0001`–`0003`), `syncSystemRoles(accountId?)` / `syncAllSystemRoles()` in `src/modules/rbac/roles.service.ts`.                                                                                                                                                                                                                                                                                    |
| Audit                | `AUDIT_ACTIONS` (27, typed) ↔ audit.md (sync test), `auditRequest(req, action, { target, meta })`, `recordAudit(input)`, `sanitizeMeta`.                                                                                                                                                                                                                                                                                                                                                                                  |
| Realtime             | `notifyAccount(accountId, type, data)`, `notifyUser(…)`, `pushToUser`, `tryGetRealtime()`; backend `src/core/realtime/events.ts` + frontend `src/services/realtime/events.ts` event maps.                                                                                                                                                                                                                                                                                                                                 |
| Queues               | `QUEUES` (`system`, `email`, `maintenance`) in `src/core/queues/names.ts`, `createQueue / createWorker(name, processor, { ...deps, concurrency })`, `startMaintenanceWorker(deps)` (daily `audit-purge` via `upsertJobScheduler`, `processMaintenanceJob` switches on `job.name`), `closeAllQueues`.                                                                                                                                                                                                                      |
| Storage              | `StorageProvider { put, get, delete, exists, signedUrl }`, `storageKey({ accountId, area, id, ext })`, `createStorage(env)`; **only passed to `createApp({ storage })` for `/files/*` today — not to API routers / workers yet (T3.1 wires it).**                                                                                                                                                                                                                                                                         |
| Limits / masking     | `src/config/limits.ts`, `maskPhone`, `maskEmail` (`src/shared/utils/mask.ts`), pino redaction.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Tests (BE)           | `useTestDb()`, `createTestAccount()` → `{ account, roles, addUser(role) → { user, token } }`, `tokenFor(user, { imp })`, `TEST_PASSWORD`, `useCapturedEmail`, `requireRedis`, `uniquePrefix`, `buildTestApp`, `tests/security/tenant-scope.test.ts` (grep test).                                                                                                                                                                                                                                                          |
| Frontend             | `apiClient` + `unwrap`, `ApiError`, `applyFieldErrors` (strips `body.`), auth store / `useCan()` / `RequirePermission`, `DataTable` (offset pagination, loading / error / empty), `PageHeader`, `EmptyState`, `StatusChip`, `CopyButton`, `RelativeTime`, `useConfirm()`, `formatInAccountTz`, `src/utils/timezone.ts`, `src/utils/audit-format.ts`, `useWsEvent`, `nav-config.ts` (`LIVE_PHASE = 2`, Contacts item `phase: 3`), test helpers `renderWithProviders`, `signInAs(role)`, `ROLE_PERMISSIONS`, `fakeSession`. |
| E2E                  | `e2e/` Playwright 1.64 (isolated `cav_e2e` DB + Redis db 5, `prepare-backend.mjs`, Mailpit helpers, `signUpOwner`, `signIn`, `signInAsSuperadmin`), `E2E_BACKEND_LOGS=1`, manual workflow `e2e.yml`.                                                                                                                                                                                                                                                                                                                      |
| Docker               | `npm run infra:up` → Mongo 27018, Redis 6380, Mailpit 1025 / 8025.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

**Dependencies (checked 2026-10-09 — re-check `npm view` at batch start, newer patch / minor OK, record it):**

| Repo | Package                       | Version       | Note                                                                                                                                                                         |
| ---- | ----------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BE   | `multer` / `@types/multer`    | 2.4.0 / 2.3.0 | memory storage, upload route only                                                                                                                                            |
| BE   | `csv-parse` / `csv-stringify` | 7.0.3 / 6.9.0 | MIT                                                                                                                                                                          |
| BE   | `read-excel-file`             | 9.3.12        | `"type": "module"` but has a **CJS export `read-excel-file/node`** (`require` → `./node/index.cjs`) — verify in T3.7; fallback `exceljs` 4.4.0 (record deviation + ADR 0031) |
| BE   | `iconv-lite`                  | 0.7.3         | windows-1252 fallback                                                                                                                                                        |
| BE   | `libphonenumber-js`           | 1.13.15       | already a dependency (^1.13.14) — bump                                                                                                                                       |
| FE   | `libphonenumber-js`           | 1.13.15       | import from `libphonenumber-js/min`                                                                                                                                          |

Machine: Docker running; **never touch other containers (Supabase stack)** — only `npm run infra:*` / `docker compose` in the backend repo / `docker exec cav-*`.

---

## 1. LOCKED DECISIONS

**Everything in [PHASE_3_PLAN.md §1](../phases/PHASE_3_PLAN.md) is locked** (identity, phone rules, typed variables, fields, import pipeline, lists / segments / DND / opt-out / consent / bulk / export, limits, queue / events / audit / error codes, frontend). Additions / precisions for implementation:

| Topic              | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Module layout      | `src/modules/contacts/` (contacts + tags + bulk), `contacts/normalize/` (pure lib), `contacts/filter/` (zod filter schema + `compileContactFilter`), `src/modules/custom-fields/`, `src/modules/contact-lists/`, `src/modules/segments/`, `src/modules/dnd/`, `src/modules/contact-imports/` (`parsers/`, `mapping.ts`, `validate.job.ts`, `run.job.ts`, `error-report.ts`), `src/modules/contact-exports/`. Worker: `src/core/queues/workers/contacts.worker.ts` dispatching on `job.name`. |
| Route prefixes     | `/api/v1/contacts`, `/contacts/search`, `/contacts/bulk`, `/contacts/:id/opt-out`, `/contact-tags`, `/custom-fields`, `/contact-lists`, `/segments`, `/segments/preview`, `/dnd-entries`, `/contact-imports`, `/contact-exports` (api.md plural kebab-case).                                                                                                                                                                                                                                 |
| Storage wiring     | `createApiRouter({ …, storage })` and `startContactsWorker({ ...queueDeps, storage })` receive the `StorageProvider` from `server.ts` (same instance as `createApp`). Tests: extend `buildTestApp(overrides, deps)` so `deps` also accepts `storage` (today it picks only `rateLimit` / `authRateLimit`); use `new LocalStorage(<per-file tmp dir>, 'http://localhost:5100', signingKey(env))` and clean the dir in `afterAll`. Storage areas: `imports`, `import-reports`, `exports`.       |
| Contact JSON       | `{ id, phoneE164, name, email, externalId, variables, tags, listIds, dnd, optedOutAt, consent, source, lastCalledAt, callCount, createdAt, updatedAt }` — **`searchText` and `deletedAt` hidden** (`basePlugin({ hide })`). Detail adds `lists: [{ id, name }]`.                                                                                                                                                                                                                             |
| Variables in Mongo | Mongoose `Map` of `Schema.Types.Mixed`; writes always through `parseFieldValue` (never raw client values). Path in queries: `variables.<key>`.                                                                                                                                                                                                                                                                                                                                               |
| Filter shape       | `ContactFilterSchema = { listIds?: id[], tags?: { mode: 'any' \| 'all', values: string[] }, dnd?: boolean, optedOut?: boolean, createdFrom?, createdTo?, q?, conditions?: [{ key, op, value? , value2? }] }` (≤ 20 conditions). `compileContactFilter(accountId, filter, fieldsByKey, { now, timezone })` is pure. Date ops evaluate "today" in the **account timezone**.                                                                                                                    |
| Import job API     | `POST /contact-imports` (upload) → `PUT /:id/mapping` → `POST /:id/validate` → `POST /:id/start` → `POST /:id/cancel`; `GET /contact-imports`, `GET /:id`, `GET /:id/error-report` (`{ url }`), `GET /contact-imports/template.csv`. Response `ImportJob` never includes file keys or cell values.                                                                                                                                                                                           |
| Export job API     | `POST /contact-exports` → `GET /contact-exports/:id` (`{ …, downloadUrl? }` signed 15 min when `ready`) → `GET /contact-exports` (history).                                                                                                                                                                                                                                                                                                                                                  |
| Locks              | Redis `contacts:import-lock:<accountId>` (`SET NX PX 1800000`, value = jobId, refreshed per batch, released in `finally`); bulk-by-filter + export use `contacts:job-lock:<accountId>:<kind>` (one each per account).                                                                                                                                                                                                                                                                        |
| Progress throttle  | Emit `import.progress` / `export.progress` at most once per second + always on state change (helper `createProgressReporter`).                                                                                                                                                                                                                                                                                                                                                               |
| Maintenance jobs   | Add job names `contacts-purge`, `import-files-purge`, `export-files-purge` (cron `15 3 * * *`, `30 3 * * *`, `0 * * * *` UTC) in `maintenance.worker.ts` (switch on name; unknown name still throws).                                                                                                                                                                                                                                                                                        |
| Audit actions      | Exactly the 14 new strings of PHASE_3_PLAN §1f (→ 41 total). `meta` = counts / ids / filter kind only.                                                                                                                                                                                                                                                                                                                                                                                       |
| Commit tags        | `[P3-T3.x]`; checkpoints `[P3-B1-DONE]`, `[P3-B2-DONE]`, `[P3-B3-DONE]`; frontend uses the same tags.                                                                                                                                                                                                                                                                                                                                                                                        |
| Frontend routes    | `/contacts` → redirect `/contacts/all`; `/contacts/:tab` (`all`, `lists`, `segments`, `dnd`, `fields`); `/contacts/c/:id`; `/contacts/import`, `/contacts/import/:jobId`; `/contacts/activity`. All under `RequirePermission perm="contacts.read"`; import routes additionally `contacts.import`.                                                                                                                                                                                            |

**Version rule:** no `--force` / `--legacy-peer-deps`; after each install `npm approve-scripts --allow-scripts-pending` → decide → README "Install scripts" (expect none for these packages).

---

## 2. RULES OF ENGAGEMENT

1. **No questions / no permission requests.** Safe, convention-consistent choice → report as deviation.
2. **Git:** branch `feature/phase-3-contacts` (both repos). One commit per task per repo (Conventional Commit + tag). Hooks must pass (**no `--no-verify`**). **No push / merge / tag.** Footer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Commits **sequentially, one repo at a time**.
3. **Verify after every task — each command separately, read the output** (Phase 2 lesson: a commit chained after a failing check slipped through). **Never chain `git commit` after checks with `;` or `&&` in the same command — commit only after you have read every result.**
   - Backend: `npm run lint` · `npm run format:check` · `npm run typecheck` · `npm run test:coverage` · `npm run build` · `npm run openapi:check`
   - Frontend: `npm run lint` · `npm run format:check` · `npm run typecheck` · `npm run test:coverage` · `npm run build` (+ `npm run e2e` from T3.18 on, infra up, dev servers stopped)
4. **Coverage gates must stay green** (BE 95 / 80 / 90 / 95, FE 90 / 85 / 85 / 90). New code drops them → **add tests**, never lower thresholds (re-measure + raise only at sign-off).
5. **Tests are part of every task** — unit + integration (supertest + real Redis), **tenant-isolation test for every route** (other account's id → 404), permission matrix per role (owner / admin / manager / agent / viewer), suspended account (writes 403), impersonation where relevant.
6. **PII:** never log phone / name / email / variables / cell values / file contents (use `maskPhone` / row numbers). Fixtures use obvious fakes: names like `Test Borrower 001`, phones from `+9190000000xx`–`+9199999999xx` patterns generated in code, emails `@example.com`. Job data in Redis = ids only.
7. **Every new env var** (expect none) → `env.ts` + `.env.example` + README table (env-docs test).
8. **OpenAPI:** every route registered (request incl. multipart, response, security, error responses) → `gen:openapi` → commit `openapi/openapi.json` with the task. Frontend `gen:api` at T3.13 and whenever the spec changes.
9. **Docs in the same commit** (`src/README.md` module rows, conventions, data-model.md, websocket.md, audit.md, error-codes.md, ADR notes).
10. **Docker:** only `npm run infra:*`; never stop / remove other containers or volumes.
11. **Real bugs found during manual checks / E2E** → reproduce, fix, regression test, separate `fix(...)` commit, note in the report (Phase 2 found 4 this way).
12. **Prettier may reformat files during lint-staged** — if you script edits with exact string replacements afterwards, re-read the file first (Phase 2 lesson: replacements silently missed collapsed lines).
13. **Time / timezone:** dates in tests use fixed values and account timezone `Asia/Kolkata`; ICU lists `Asia/Calcutta` — validator already accepts both (ADR 0017 note).

---

## 3. RESUME SAFETY

- Both repos: `git branch --show-current` → `feature/phase-3-contacts`; `git log --oneline -25`; continue after the last `[P3-T3.x]` / checkpoint.
- `npm run infra:up` → `npm ci` (both) → lint → typecheck → `test:coverage` green before continuing.
- Batch 2 requires `[P3-B1-DONE]`; Batch 3 requires `[P3-B2-DONE]` — if missing, stop and report.

---

# ═══════════ BATCH 1 — Data + APIs (T3.1 → T3.6) ═══════════

## T3.1 — Models, migration, limits, catalogue, queue, storage wiring → `feat(contacts): add contact, list, field, segment, dnd and job models [P3-T3.1]`

**Files:** `src/db/models/{contact, contact-list, custom-field, segment, dnd-entry, import-job, export-job}.model.ts`, `src/db/migrations/0004-dnd-manage-permission.ts` (+ registry), `src/modules/rbac/{permissions,system-roles}.ts`, `src/config/limits.ts`, `src/shared/errors/error-codes.ts`, `src/core/queues/names.ts`, `src/core/queues/workers/contacts.worker.ts`, `src/core/realtime/events.ts`, `src/modules/audit/audit-actions.ts`, `src/routes.ts` + `src/server.ts` (storage DI), `tests/helpers/test-app.ts`, tests, docs.

1. **Install** `multer @types/multer csv-parse csv-stringify read-excel-file iconv-lite` + bump `libphonenumber-js` (exact versions recorded). `npm approve-scripts --allow-scripts-pending`.
2. **Models** (fields / indexes exactly per PHASE_3_PLAN T3.1 + §1a–§1d; `basePlugin({ hide: ['searchText'] })` etc.; tenant plugin on all; soft delete on contacts, lists): enum values as constants exported from each model file (`IMPORT_STATUSES`, `EXPORT_STATUSES`, `DND_SOURCES`, `FIELD_TYPES = ['text','number','date','currency','phone']`, `CONTACT_SOURCE_TYPES`). Partial unique indexes use `partialFilterExpression: { deletedAt: null }` (contacts / lists) and `{ externalId: { $type: 'string' }, deletedAt: null }`. Name index with `collation: { locale: 'en', strength: 2 }`.
3. **`dnd.manage`** permission (group `Contacts`, description "Remove numbers from the do-not-call list") → owner + admin (owner / admin already = all `PERMISSIONS`); manager / agent / viewer unchanged. Migration `0004-dnd-manage-permission`: `up` = `syncAllSystemRoles()`; `down` = `$pull: { permissions: 'dnd.manage' }` from system roles. Role matrix snapshot test updated.
4. **`CONTACT_LIMITS`** exactly PHASE_3_PLAN §1e (+ `XLSX_MAX_UNCOMPRESSED_BYTES`, `PROGRESS_THROTTLE_MS = 1000`, `EXPORT_URL_TTL_SEC = 900`, retention days).
5. **Error code** `IMPORT_FILE_INVALID` (422) in code + error-codes.md (sync test).
6. **Queue** `QUEUES.contacts = 'contacts'`; `contacts.worker.ts` with `CONTACT_JOBS` names (`import.validate`, `import.run`, `export.run`, `bulk.run`, `field.delete_values`, `list.delete_members`) and a dispatcher that throws on unknown names (processors filled in later tasks — T3.1 registers the worker with stub processors that throw `not implemented` **only for names not yet built**; tests cover the dispatcher). Started in `server.ts` behind `WORKERS_ENABLED`, closed by `closeAllQueues`.
7. **Storage DI** (§1 "Storage wiring") + test helper support + one test proving routers receive it.
8. **Events** `export.progress`, `contacts.bulk_completed`, `contacts.changed` (+ existing `import.progress` typed) in `events.ts` + websocket.md §5. **Audit** 14 new actions in `AUDIT_ACTIONS` + audit.md table (sync test).
9. **data-model.md §2.2** rewritten to the new shapes (variables typing, `externalId`, `source`, `searchText` hidden, Segment, ImportJob / ExportJob, dropped `contactCount`, indexes); data.md §9 rows for `searchText`, import files, error reports, export files.
10. **Tests:** each model (required / defaults / enums / hidden fields / every index via `listIndexes()` incl. partial + collation), unique conflicts + soft-deleted duplicates allowed, migration up twice + down, catalogue / audit / error-code / events sync tests, tenant-scope grep test includes the new models, worker dispatcher, storage DI.

## T3.2 — Normalisation library → `feat(contacts): add phone, value, tag and email normalisation [P3-T3.2]`

**Files:** `src/modules/contacts/normalize/{phone, values, tags, email, search-text, defaults, index}.ts` + `*.test.ts` next to them.

1. `normalizePhone(raw: unknown, defaultCountry: CountryCode)` → `{ ok: true, e164 } | { ok: false, reason: 'phone_missing' | 'phone_invalid' | 'phone_lost_digits' }` — handles strings and numbers, trims, strips `'` prefix, spaces / dashes / dots / brackets, `(0)`, leading `0` (national), 12-digit starting with the country calling code without `+`, `00` international prefix; rejects letters / extensions; scientific notation → `phone_lost_digits`; uses `parsePhoneNumberFromString` + `isValid()`.
2. `parseFieldValue(type, raw, { dateFormat = 'DMY', currency = 'INR' })` → `{ ok, value } | { ok: false, reason: 'type_invalid' | 'too_long' }`: text (trim, ≤ 1000, empty → absent), number (Indian / western grouping, sign, decimals; reject `NaN` / `Infinity` / mixed text), currency (`₹`, `Rs`, `Rs.`, `INR` prefixes / suffixes, grouping, ≤ 2 decimals → **integer micros**, use string math — no float rounding errors: `12500.10` → `12500100000`), date (`DMY` / `MDY` / `YMD` with `/ - .` separators, `DD-MMM-YYYY` month names en, ISO, JS `Date` from XLSX, Excel serial 1–2958465 with the 1900 leap-year bug handled → `YYYY-MM-DD`; real calendar check), phone (→ E.164 via `normalizePhone`).
3. `formatFieldValue(type, stored)` → export string (currency micros → `12500.10`, date as stored, others `String`).
4. `normalizeTags(input: string | string[])` (split `,` `;`, lower-case, trim, regex, dedupe, ≤ 20 → `{ ok, tags } | { ok: false, reason: 'tags_invalid' }`); `normalizeEmail`; `buildSearchText({ name, email, phoneE164, externalId })`; `applyDefaultsAndRequired(fields, variables, { mode: 'create' | 'update' })` → `{ variables, missing: string[] }`.
5. **Tests:** table-driven ≥ 120 cases (list in PHASE_3_PLAN T3.2 + negative zero, `1e3` as number text, `Rs. 1,25,000.5`, `₹ -500` (allowed, negative currency), 2-decimal limit, `05-oct-2026`, `2026-02-29` invalid, `2028-02-29` valid, serial `60` (1900-02-29 bug), `+1 415…` with IN default valid, `+91 12345` invalid, `98765 43210 ext 5` invalid). **100 % coverage** for `normalize/`.

## T3.3 — Custom fields API → `feat(custom-fields): add custom field definitions api [P3-T3.3]`

1. Routes / rules per PHASE_3_PLAN T3.3 + §1b. `GET /custom-fields?withUsage=true` → `usageCount` per key (`countDocuments({ accountId, deletedAt: null, ['variables.' + key]: { $exists: true } })`). `POST` (`contacts.write`) validates key regex + reserved list + max 50 + `defaultValue` via `parseFieldValue`; `order` = max + 1. `PATCH /:id` (type only when `usageCount === 0`, else `409 CONFLICT_INVALID_STATE` "This field has data on N contacts"). `PUT /custom-fields/order { ids: [...] }` (all ids of the account, no extras). `DELETE /:id` → delete definition in a transaction + enqueue `field.delete_values { accountId, key }` → **202** `{ jobQueued: true }`; implement that job processor now (batched `updateMany $unset` with `variables.<key>`; idempotent) + `contacts.changed` event.
2. Audit `custom_field.created|updated|deleted` (meta: key, type).
3. Tests: CRUD + order, reserved / invalid keys, limit 50, default typed (bad default → 422), type change both paths, delete job removes values (run processor directly), permissions (agent / viewer 403 on writes, read OK), isolation, suspended 403, OpenAPI.

## T3.4 — Contacts API + filter compiler → `feat(contacts): add contacts crud, search, filters and tags [P3-T3.4]`

1. **Filter** (`contacts/filter/`): `ContactFilterSchema` (zod, OpenAPI-registered as `ContactFilter`), operator allowlist per type (PHASE_3_PLAN §1d), `compileContactFilter` (pure; currency values given in rupees by the client → micros; dates `YYYY-MM-DD`; `within_next_days` / `overdue_by_days` relative to today in account TZ; `contains` escaped regex `i`; `exists` / `not_exists`; unknown key → 422 `VALIDATION_FAILED` with path `conditions.N.key`). Query-param variant for `GET /contacts`: `listId`, `tag` (comma = any), `tagsAll` (comma), `dnd`, `optedOut`, `segmentId` (loads saved filter), `createdFrom`, `createdTo`, `q`, `page`, `limit`, `sort` — `strictQuery` (unknown → 422).
2. **Service:** `listContacts(req, filter, pagination, sort)` (sort allowlist + collation for `name`), `getContact` (with list names), `createContact` (normalise all fields; unknown variable key → 422; `applyDefaultsAndRequired`; DND lookup → `dnd`; revive soft-deleted phone; live duplicate phone / externalId → `409 CONFLICT_DUPLICATE` with `details: [{ path: 'phone', message, existingId }]`), `updateContact` (partial; variables merge; `null` clears non-required; phone change re-checks duplicates + DND; `searchText` rebuilt), `deleteContact` (soft; audit `contacts.deleted` count 1), `listTags` (aggregation `$unwind tags` → `[{ tag, count }]` sorted by count, limit 200).
3. Routes: `GET /contacts`, `POST /contacts/search` (body `{ filter, page, limit, sort }`), `GET /contacts/:id`, `POST /contacts`, `PATCH /contacts/:id`, `DELETE /contacts/:id`, `GET /contact-tags`. Permissions: read `contacts.read`, writes `contacts.write`.
4. Tests (big file, split by concern): CRUD + revive + duplicates (phone / externalId) + DND flag on create, every filter + every operator per type (fake timers for relative dates in `Asia/Kolkata`), search by `98765 43210`, `+91-98765…`, partial digits, Hindi name, email, externalId; sort incl. case-insensitive name; pagination meta; unknown query param 422; required / default; `null` clears; permissions per role; isolation (get / patch / delete / search can't see other account); suspended 403; impersonation allowed for writes.

## T3.5 — Lists + segments → `feat(contacts): add contact lists and segments [P3-T3.5]`

1. Lists per PHASE_3_PLAN T3.5: counts via one aggregation for the page (`$match { accountId, deletedAt: null, listIds: { $in: ids } }` → `$unwind` → `$match` ids → `$group`); `DELETE` → soft delete + job `list.delete_members` (implement now: batched `$pull`) + audit `contact_list.deleted` + `contacts.changed`. Name unique among live lists (409 with existing id). Max 500.
2. Segments: CRUD + `POST /segments/preview { filter }` → `{ count, sample }` (sample = 5 newest, same Contact JSON); `GET /segments?withCounts=true` (count per segment, max 100 → acceptable); `DELETE` audit `segment.deleted`. Filter validated against current fields; a saved segment whose field was later deleted → that condition is reported as `invalid` in `GET` (`invalidConditions: [index]`) and **ignored = no match** (documented, tested).
3. Tests per PHASE_3_PLAN T3.5 + limits + isolation (segment of another account via `segmentId` on `/contacts` → 404).

## T3.6 — DND, opt-out, consent → `feat(dnd): add do-not-call list, opt-out and consent [P3-T3.6]`

1. DND routes / rules per PHASE_3_PLAN T3.6 + §1d; mirror updates in `withTransaction` (`dndEntries` upsert + `contacts.updateMany({ accountId, phoneE164 }, { dnd: true })`). `DELETE /dnd-entries/:id` (`dnd.manage`) sets `contacts.dnd = false` but **does not** clear `optedOutAt` — a contact that opted out stays opted out; only `DELETE /contacts/:id/opt-out` clears both (documented + tested).
2. Opt-out endpoints (`POST` → `contacts.write`; `DELETE` → `dnd.manage`), audit `contact.opted_out`, `dnd.added` (count 1, source manual), `dnd.removed`.
3. Consent on create / patch (`consent.at` ≤ now, `source` 1–120 chars).
4. Tests per PHASE_3_PLAN T3.6 + `GET /dnd-entries?q=98765` + idempotent add returns existing (200 vs 201 documented) + isolation + manager 403 on remove.

## P3-B1-DONE — checkpoint → `docs: mark phase 3 batch 1 complete [P3-B1-DONE]`

1. `npm run infra:up` → backend full verify (each separately) + actionlint (`docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest -no-color`).
2. **Manual check** (backend `npm run db:migrate && npm run db:seed && npm run dev`; login via curl as `owner@demo.local`, token in a scratchpad file — never commit): create 2 fields → create contact with every type → search by phone formats → segment preview → add DND → contact `dnd: true` → manager cannot remove (403) → owner removes; check server log for **no phone / name** (grep the fake values); `kill -INT` clean shutdown.
3. Secret scan (grep + gitleaks via Docker `zricethezav/gitleaks:latest`) — 0.
4. Docs: PHASE_3_TASKS T3.1–T3.6 `[x]`, PHASE_3_PLAN changelog line (+ deviations), `src/README.md` module rows, README "Contacts (Phase 3)" section (API overview, permissions), CHANGELOG `Phase 3 · Batch 1`, ADR 0018 "Implementation (Phase 3)" note.
5. Commit; `npm run infra:down`. No push / merge.
6. **Report (Hinglish):** per task ✅/⚠️/❌, `git log`, versions + allowScripts, deviations, verification (each command + manual), tests 540 → N + coverage, open items for Batch 2.

---

# ═══════════ BATCH 2 — Import, export, jobs (T3.7 → T3.12) ═══════════

## T3.7 — Upload, parsers, mapping → `feat(contact-imports): add file upload, csv and xlsx parsing and column mapping [P3-T3.7]`

1. **Verify `read-excel-file/node` from CJS** (`require` + TS types under NodeNext) with a tiny spike test; on failure switch to `exceljs` and record it. Write **ADR 0031 — Contact import pipeline** (libraries + why, states, batching, resume, lock, limits, encoding, zip-bomb guard, no single transaction, retention).
2. **Upload route** `POST /contact-imports` (`contacts.import`; for `kind=dnd` also `contacts.write`): `multer({ storage: memoryStorage(), limits: { fileSize: 10 MB, files: 1, fields: 5 } })`; multer `LIMIT_FILE_SIZE` → `413 PAYLOAD_TOO_LARGE`; ext + MIME allowlist (`text/csv`, `application/vnd.ms-excel` (browsers send it for CSV), `text/plain`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `application/octet-stream` only with a valid magic check) → else `415`; magic bytes; store via storage (`area: 'imports'`); create job `uploaded`; register the multipart schema in OpenAPI.
3. **Parsers** (`parsers/csv.ts`, `parsers/xlsx.ts`, `parsers/row-source.ts`): `openRowSource(storage, job)` → `{ header: string[], rows: AsyncIterable<{ rowNumber, cells: string[] }>, warnings }`; CSV: BOM strip, UTF-8 validity check on the first 64 KB (`TextDecoder('utf-8', { fatal: true })`) → fallback `iconv-lite` windows-1252 + warning `encoding_fallback`; delimiter sniff (count `,;\t|` outside quotes on the header line); `relax_column_count` + `ragged_rows` warning; skip fully empty rows; max columns 100. XLSX: list sheets, chosen sheet, **zip-bomb guard** (sum of uncompressed sizes from the ZIP central directory ≤ 100 MB before parsing — small helper reading the central directory with `fflate`'s unzip filter or manual parse; test with a crafted fixture), cells → strings (Date → `YYYY-MM-DD`; numbers → `String(n)` with integer check; booleans `TRUE/FALSE`). Row cap 50,000 → `IMPORT_FILE_INVALID` reason `too_many_rows`; header missing / all blank → `no_header`; zero data rows → `empty_file`.
4. **Upload response** `ImportJob` with `columns [{ index, header, samples (first 3 non-empty values) }]`, `rowCount`, `sheets`, `suggestedMapping` (`mapping.ts` heuristics per PHASE_3_PLAN §1c incl. type guess: ≥ 80 % of samples parse as date → `date`, number with ₹/Rs → `currency`, number → `number`, phone-like → `phone`, else `text`), `warnings`.
5. **Mapping** `PUT /contact-imports/:id/mapping` (states `uploaded` / `mapped` / `validated` → `mapped`; resets totals): zod-validated (phone exactly once, one target per column, `field:<key>` exists, `new_field` key rules + not existing + total fields ≤ 50, `dateFormat` per date column, list `{ mode: 'new', name }` free or `{ mode: 'existing', listId }` owned, `updateExisting`, `tags`, `consentSource`). For `kind=dnd`: only `phone` + optional `reason` (text column) targets.
6. **Other routes:** history `GET /contact-imports` (pagination, newest first), `GET /:id`, `POST /:id/cancel` (states per plan; deletes stored file when not yet importing), `GET /contact-imports/template.csv` (`text/csv; charset=utf-8`, BOM, `Content-Disposition: attachment; filename="contacts-template.csv"`).
7. **Fixtures** `tests/fixtures/imports/` (generated by a script `tests/fixtures/imports/make-fixtures.ts` where binary — committed outputs small; the 50,001-row file generated at test time, not committed).
8. **Tests:** every parser case from PHASE_3_PLAN T3.7, upload checks (413 / 415 / magic mismatch), suggested mapping (Hinglish headers `Naam`, `Mobile No.`, `Loan Amt (Rs)`, `Due Dt`), mapping validation errors (each rule), state machine (illegal transitions → 409), cancel, isolation, permissions (viewer / agent 403, manager OK), suspended 403, template content.

## T3.8 — Validate + error report → `feat(contact-imports): add dry-run validation and error report [P3-T3.8]`

1. `POST /:id/validate` (state `mapped` or `validated`; lock; enqueue `import.validate { importJobId }`; state `validating`) → processor: load job + fields + account country / TZ → stream rows → per row build candidate (normalise mapped columns; `new_field` values parsed with their declared type; tags; consent date) → reasons list → in-file duplicates (`Map<phone, firstRow>`) → existing contacts lookup in batches of 500 (`$in` phones, live only) → DND lookup batch → totals (`rows, created (would), updated (would), unchanged (would), invalid, duplicates, dnd`) + `problemRows` (first 100: `{ row, reasons }`) → error CSV (`row,<original headers…>,reasons`; injection-safe; written via `csv-stringify` to storage `area: 'import-reports'`) → `validated`; release lock; WS progress throttled.
2. Failure → `failed` + `errorMessage` (generic, no PII) + lock released.
3. **Sample data** `docs/samples/contacts-sample-100.csv` (+ `.xlsx` generated by the fixture script, + `dnd-sample.csv`) with the exact mix of PHASE_3_PLAN T3.8 (85 valid, 5 invalid phones incl. 1 scientific notation, 3 missing required `loan_amount`, 3 duplicates in file, 2 matching seeded / pre-created contacts, 2 numbers on the DND list) and a README table of expected totals.
4. **Tests:** sample → exact totals + problem rows + error CSV rows / headers / injection; re-validate after mapping change; validate while another job runs → 409; failure path; progress events (fake realtime); no contact writes (count unchanged).

## T3.9 — Import run + DND upload → `feat(contact-imports): add batched resumable import and dnd upload [P3-T3.9]`

1. `POST /:id/start` (state `validated`; lock) → in a transaction: create `new_field` definitions (re-check limit / keys) + list (`new` mode) → job `importing`, `startedAt` → enqueue `import.run`.
2. Processor: resume from `progress.processed` (skip rows ≤ checkpoint); per batch of 500 → normalise (same code path as validate — **one shared `buildCandidate()`**) → in-file duplicate tracking persists across batches (rebuild the seen-phones set from the file up to the checkpoint on resume) → `bulkWrite` with `updateOne` upserts keyed `{ accountId, phoneE164, deletedAt: null }` … **revive** handled by a pre-lookup of soft-deleted phones in the batch → classify created / updated / unchanged → `$addToSet: { listIds, tags }`, `$set` merged fields (`updateExisting`; empty cells never clear), `$setOnInsert` `source { type: 'import', importJobId }`, `consent`, `dnd` from DND lookup, `searchText` → on E11000 retry the batch once → update `progress` + `totals` → account status check → cancel flag check → lock refresh → throttled WS.
3. Completion: `completed`, `completedAt`, audit `contacts.import_completed` (totals), `contacts.changed`, lock released. Cancel during run → `canceled` after the current batch, audit `contacts.import_canceled`. Suspended → `failed` reason `account_suspended`.
4. `kind=dnd`: same pipeline; upsert `dndEntries` (`source: 'upload'`, reason column) + contacts mirror; totals `{ rows, created (new entries), updated (existing), invalid, duplicates }`; audit `dnd.added` (count, source upload).
5. Audit `contacts.import_started` on start.
6. **Tests:** sample import end-to-end via the processors (created 85 / updated 2 / invalid 8 / duplicates 3 / dnd 2 — adjust to the documented truth), variables typed in Mongo (micros, `YYYY-MM-DD`), list membership + tags + consent + source, `updateExisting` off → `unchanged` and still in list, empty cell keeps value, opted-out phone stays DND after re-import, **resume** (simulate crash: run processor with a hook that throws after batch 2 → run again → final counts identical, no duplicates), cancel mid-run, lock 409, suspended mid-run, E11000 retry (two concurrent processors on overlapping phones), 5,000-row generated import < 15 s, isolation (another account's job id → 404 on start / cancel / get).

## T3.10 — Bulk actions + export → `feat(contacts): add bulk actions and csv export [P3-T3.10]`

1. `POST /contacts/bulk` per PHASE_3_PLAN §1d / T3.10: zod discriminated union on `action`; `ids` path validates ownership with one `countDocuments` (mismatch → 404); `filter` path → lock → job `bulk.run` (batched 1,000, `updateMany` / soft delete / DND upsert) → WS `contacts.bulk_completed` + `contacts.changed`; response 200 `{ count }` (ids) or 202 `{ jobQueued: true }` (filter). Audit `contacts.bulk_updated` / `contacts.deleted` / `dnd.added` with counts.
2. Export per PHASE_3_PLAN T3.10: `blockWhenImpersonating()`, `contacts.export`; job processor with cursor + `csv-stringify` streaming into a buffer → storage (`area: 'exports'`), header labels (`name, phone, email, external_id, tags, lists, dnd, opted_out, consent_source, consent_at, <field keys>, created_at`), lists by name, booleans `yes/no`, values via `formatFieldValue`, injection prefix except phone columns, BOM, `\r\n`; cap 100,000 (more → job `failed` reason `too_many_rows` + message); `ready` + `expiresAt = now + 24 h` + `export.progress` + audit `contacts.exported`.
3. Tests per PHASE_3_PLAN T3.10.

## T3.11 — Retention purge → `feat(contacts): add retention purge jobs [P3-T3.11]`

1. Three maintenance job names + schedulers (§1 table); processors: contacts hard-delete (`deletedAt < now − 30 d`, batched 1,000, also `$pull` nothing needed); import files + reports (`completedAt|failedAt|canceledAt < now − 30 d` → storage delete (ignore not-found) → unset keys, `filesPurgedAt`); exports (`expiresAt < now` → delete file → status `expired`).
2. Logs: counts only. Tests with fixed dates; unknown maintenance job still throws; audit purge unaffected.

## T3.12 — Seed, samples, OpenAPI, performance, docs → `chore(contacts): add seed data, sample sheets, benchmark and docs [P3-T3.12]`

1. `db:seed` additions per PHASE_3_PLAN T3.12 (idempotent: upsert by key / name / phone).
2. Samples finalised + `docs/samples/README.md` (columns, expected validate totals, how to use).
3. `scripts/bench-contacts.ts` (+ npm `bench:contacts`, refuses `NODE_ENV=production`, uses a throw-away account `bench-<ts>` and deletes it at the end): generate 50,000-row CSV → upload → map → validate → start → wait (poll) → timings; then 20 × `GET /contacts` (page 1, search, segment filter) → p50 / p95. Record numbers in the B2 report and sign-off.
4. `openapi:check` green; every new route has examples for the main schemas.
5. Docs: api.md §11 (xlsx first-sheet / sheet choice, row / column limits, MIME list, magic check), README "Contacts & imports" (flow, limits, sample files, DND, export as Text tip, purge rules), `src/README.md`, compliance-notes §4 rows (DND / opt-out / consent → Phase 3 status), CHANGELOG.

## P3-B2-DONE — checkpoint → `docs: mark phase 3 batch 2 complete [P3-B2-DONE]`

1. Infra up → backend full verify (each separately) + actionlint.
2. **Manual e2e** (dev server + curl, scratchpad files only): upload `contacts-sample-100.csv` → mapping (accept suggestion) → validate → read totals + download the error CSV via the signed URL → start → watch progress (`GET /:id` polling) → contacts count = expected; upload the `.xlsx` sample (second sheet selection); DND upload; bulk tag by filter; export → download → open CSV: BOM, injection-safe, rupee formatting; kill the server **during** a 50k import → restart → job resumes and completes with identical counts; grep server logs for the fake phone numbers / names → **0**.
3. `npm run bench:contacts` → numbers.
4. Secret scan (grep + gitleaks) — 0.
5. Docs: PHASE_3_TASKS T3.7–T3.12 `[x]`, plan changelog line (+ deviations), CHANGELOG `Phase 3 · Batch 2`.
6. Commit; `infra:down`. **Report (Hinglish)** like B1 + benchmark numbers.

---

# ═══════════ BATCH 3 — Frontend, E2E, sign-off (T3.13 → T3.18) ═══════════

All frontend commits in `cell-ai-voicebot-frontend` on `feature/phase-3-contacts`. Shared components first, pages after. Every page: loading / error (retry) / empty states, permission-aware actions, keyboard-accessible, labels on every input, works at 375 px width.

## T3.13 — Frontend foundation → `feat(contacts): add contacts api clients, formatting utils and routes [P3-T3.13]`

1. Backend `npm run gen:openapi` → frontend `npm run gen:api`; aliases in `src/services/api/types.ts` (`Contact`, `ContactList`, `Segment`, `ContactFilter`, `CustomField`, `DndEntry`, `ImportJob`, `ExportJob`, …).
2. API clients (`contacts.ts`, `contact-lists.ts`, `segments.ts`, `dnd.ts`, `custom-fields.ts`, `contact-imports.ts` (upload with `FormData` + `onUploadProgress`), `contact-exports.ts`) using `unwrap` / list envelopes.
3. `npm i libphonenumber-js` (exact) → `src/utils/phone.ts` (`normalizePhoneInput`, `isValidPhone` with `/min`), `src/utils/format.ts` (PHASE_3_PLAN §1g) + tests (incl. micros → `₹12,500.10`, `₹1,25,000`, date-only never shifts in `America/Los_Angeles` TZ test).
4. `LIVE_PHASE = 3`; routes (§1 table) with `RequirePermission`; `ContactsPage` (PageHeader with actions: Import, Add contact, Export — permission-aware) + URL tabs; `features/contacts/keys.ts`; `ROLE_PERMISSIONS` + `dnd.manage` in `src/test/auth.ts`; WS event types + `useContactsLiveUpdates()` (invalidates `contacts`, `contact-lists`, `segments`, `dnd`, `custom-fields` keys on `contacts.changed`).
5. Tests: nav visibility per role, tab routing + unknown tab → `/contacts/all`, permission redirects, format / phone utils, live-updates invalidation.

## T3.14 — Contacts table + create / edit → `feat(contacts): add contacts table, filters, bulk actions and contact form [P3-T3.14]`

1. `ContactsTab` per PHASE_3_PLAN T3.14; filters bar (search, list select, tag autocomplete (`/contact-tags`), DND select, opted-out select, segment select, "Clear filters"); filters in the URL search params (shareable, back button works); `DataTable` extended with optional **selection** (checkbox column, header select-page, "Select all N matching" banner) and **sortable headers** — keep existing DataTable tests green.
2. Column picker (`features/contacts/ColumnPicker.tsx`, `localStorage` key `cav.contacts.columns.<userId>`, try/catch).
3. Bulk bar (`BulkActionsBar`): add / remove tag (dialog with tag input), add / remove list (dialog with list select + "create new list"), add to DND, delete (confirm with count), export selected (opens ExportDialog in T3.17 — build the dialog stub now, finish in T3.17); ids vs filter mode; 202 → info snackbar "Running in background…" + completion via `contacts.bulk_completed`.
4. `ContactFormDialog` (create / edit) per PHASE_3_PLAN T3.14 with `buildContactSchema(fields)` (zod built from definitions), currency input (rupees ↔ micros), date input, phone inputs, tags chips input, lists multi-select, consent; server errors via `applyFieldErrors` (paths `variables.<key>`, `phone`); 409 duplicate → alert with link to `/contacts/c/<existingId>`.
5. Tests per PHASE_3_PLAN T3.14 + URL filters round-trip + select-all-matching sends `filter` not ids.

## T3.15 — Contact detail → `feat(contacts): add contact detail page [P3-T3.15]`

Per PHASE_3_PLAN T3.15 + `PageHeader` title = name or formatted phone; created / updated via `formatInAccountTz`; consent block; actions menu; tags / lists inline edit (optimistic update with rollback on error); opt-out confirm explains effect; deleted → back to `/contacts/all` with snackbar; 404 → `EmptyState` "Contact not found" + back link. Tests per plan.

## T3.16 — Import wizard + activity → `feat(contact-imports): add import wizard and activity page [P3-T3.16]`

1. `ImportWizardPage` (`/contacts/import[/:jobId]`): step derived from job status (`uploaded` → Map, `mapped` → Options/Validate, `validating` → Validate (progress), `validated` → Review, `importing` → Import progress, `completed` → Summary, `failed` / `canceled` → message + "Start again"); URL updates to `/contacts/import/<id>` after upload; **polling fallback** (`refetchInterval` 3 s while `validating` / `importing` and WS not `open`).
2. Upload step: drop zone (native drag events + hidden input, keyboard accessible), client checks (ext, 10 MB), upload progress bar, `IMPORT_FILE_INVALID` / 413 / 415 messages, "Download sample template" (`/contact-imports/template.csv`), link to `docs`-like help text (phone column as Text in Excel).
3. Map step: table of columns (header, samples, target select grouped: Contact fields / Your fields / Create new field / Ignore), inline new-field form (label → key slug, type select pre-filled from the suggestion), date-format select for date targets, sheet select for xlsx (changing sheet re-requests mapping data), client rules (phone once, unique targets) with inline errors.
4. Options step: list new (name prefilled) / existing (select), update-existing switch with help text, tags input, consent source.
5. Validate / Review step: totals cards (Valid, Will create, Will update, Unchanged, Invalid, Duplicates, On DND list), problem rows table (row number + reasons in plain English map `phone_lost_digits` → "Phone number lost digits in Excel — format the column as Text"), "Download error report", Back to mapping, "Import N contacts" button.
6. Import / Summary: progress bar (processed / total), cancel (confirm), summary cards, "View contacts" → `/contacts/all?listId=…`, "Import another file".
7. DND variant: from the Do-not-call tab → same page with `?kind=dnd` (Upload → Map (phone, reason) → Validate → Import).
8. `ActivityPage` (`/contacts/activity`): tabs Imports / Exports, tables with status chips, totals, created by, time, actions (resume, cancel, download report / export when ready).
9. Tests per PHASE_3_PLAN T3.16 (mock API + FakeWebSocket events + polling fallback with fake timers).

## T3.17 — Lists, Segments, DND, Fields + export → `feat(contacts): add lists, segment builder, do-not-call, fields tabs and export [P3-T3.17]`

Per PHASE_3_PLAN T3.17. **SegmentBuilder** is reusable (also used as "Advanced filter" on the Contacts tab → `POST /contacts/search`). Value inputs per type (currency in rupees, date picker, number, text, relative-days number). Live preview count (debounced 400 ms, `POST /segments/preview`). Fields tab: drag-free reorder with up / down buttons (accessible) → `PUT /custom-fields/order`. ExportDialog: scope radio (selected / current filter / list / segment), column checklist (default all), start → progress (WS + polling) → "Download" (fresh signed URL from `GET /contact-exports/:id`), hidden during impersonation. Tests per plan + export blocked UI when impersonating.

## T3.18 — Playwright E2E, gap audit, docs, sign-off → backend `test: add phase 3 gap tests and docs [P3-T3.18]` + frontend `test(e2e): add contacts import, segment, dnd and rbac scenarios [P3-T3.18]`

1. **E2E** (`e2e/contacts-*.spec.ts`; helpers: `uploadFile(page, path)` via `setInputFiles`, `seedFields` via the UI or API with the owner's token from the page): the 5 scenarios of PHASE_3_PLAN T3.18 using `docs/samples/contacts-sample-100.csv|.xlsx` (path resolved from the sibling backend repo) — assert exact report totals, error CSV download content (`page.waitForEvent('download')`), contact count in the list, detail page values (`₹12,500.00`, `05 Oct 2026` format per util), segment count, export CSV content (BOM, injection-safe cell), DND manager vs owner, agent read-only. All existing 5 Phase 2 scenarios stay green. **Run twice.**
2. **Gap audit** table (requirement → test) for every bullet of PHASE_3_PLAN §0 / §1 / T3.x; add missing tests.
3. **Security checklist:** `E2E_BACKEND_LOGS=1 npm run e2e` → grep logs for every fake phone / name / email of the sample + `variables` values → 0; Redis keys during an import contain no PII (`redis-cli --scan` + `HGETALL` on a job key in the e2e Redis db); signed URLs only (no public file route); isolation tests list; CSV injection tests; zip bomb; upload type checks; rate limits unchanged; gitleaks both repos (allowlist any new **test-only** passphrase / fixture phone pattern only if flagged).
4. **Coverage** re-measured both repos → raise gates to new values rounded down to 5 (never lower).
5. **Docs:** frontend README (Contacts section, import tips, E2E scenarios list), backend README, CHANGELOGs (`Phase 3 · Batch 3`), data-model / api / websocket / audit / error-codes final pass, BUILD_PLAN Phase 3 ✅ + Phase 4 next, PHASE_3_TASKS all `[x]`, PHASE_3_PLAN boxes ticked + changelog, **PHASE_3_SIGNOFF.md** (same structure as Phase 2: tasks + evidence, deliverables, requirement → test, numbers incl. benchmark, deviations, verification, TODOs by phase, client inputs incl. PHASE_3_PLAN §7 questions, go / no-go for Phase 4).

## P3-B3-DONE — checkpoint → `docs: mark phase 3 complete with verification results [P3-B3-DONE]`

1. `infra:up` → full verify **both repos** (each command separately) + actionlint both + `npm run e2e` (all 10 scenarios) **twice**.
2. Fresh clone of both repos side by side (scratchpad) → `npm ci` → all checks **without `.env`** → `gen:api` no diff → E2E once → delete clones.
3. Secret scan (grep + gitleaks) both repos.
4. Sign-off §Verification filled; commit; `infra:down` (only `cav-*` containers). No push / merge.
5. **Final report (Hinglish):** per task ✅/⚠️/❌ (T3.13–T3.18 + whole-phase summary), `git log` both repos (whole phase), versions + allowScripts, deviations (all batches), verification (each command + E2E + fresh clone), tests before → after (backend 540 → N, frontend 187 → N, E2E 5 → 10) + coverage + new gates, benchmark numbers, real bugs found + fixed, Phase 3 sign-off status, open items for Phase 4, client questions (PHASE_3_PLAN §7) + pending inputs (OpenAI key, SSH key, SIP, SMTP + domain), merge order note.

---

## MUST-NOT-MISS CHECKLIST

**Batch 1**

- [ ] Branch `feature/phase-3-contacts` both repos; one commit per task; hooks pass; never commit chained after checks; no push / merge / tag
- [ ] 7 models + every index (partial uniques, collation) + hidden `searchText`; data-model.md + data.md updated
- [ ] `dnd.manage` + migration 0004 (up / down) + role snapshot; `CONTACT_LIMITS`; `IMPORT_FILE_INVALID`; `QUEUES.contacts` + worker dispatcher; storage DI; 3 new WS events; 14 audit actions (sync tests)
- [ ] Normalisation lib: phone (incl. lost digits, 12-digit `91…`), number / currency micros (string math) / date (DMY default, MDY option, Excel serial + 1900 bug) / text / phone; tags; email; 100 % coverage
- [ ] Custom fields: key rules + reserved + max 50 + type-change guard + delete job + order
- [ ] Contacts: CRUD, revive, duplicates 409 with existing id, DND flag, search any phone format, filters + all operators (TZ-aware), sort collation, strict query, tags endpoint
- [ ] Lists (computed counts, delete keeps contacts) + segments (preview, invalid conditions)
- [ ] DND mirror + `dnd.manage` remove + opt-out / undo + consent
- [ ] Isolation + permission matrix + suspended tests for every route; OpenAPI for every route

**Batch 2**

- [ ] `read-excel-file` CJS verified (or exceljs fallback) + ADR 0031
- [ ] Upload: size 413, type 415 (ext + MIME + magic), multer limits, OpenAPI multipart
- [ ] CSV: BOM, UTF-8 check + windows-1252 fallback, delimiter sniff, quotes / multiline, ragged; XLSX: sheets, dates, numbers, zip-bomb guard; 50k rows / 100 cols caps
- [ ] Suggested mapping (Hinglish headers, type guess); mapping validation; state machine; cancel; template CSV
- [ ] Validate: shared `buildCandidate`, in-file duplicates, existing + DND lookups, totals, ≤ 100 problem rows, injection-safe error CSV, progress throttle, lock
- [ ] Import run: new fields + list, batches 500, upsert / revive / merge (empty cells keep), source, consent, resume from checkpoint, cancel, suspended, E11000 retry, audit, `contacts.changed`
- [ ] DND upload; bulk (ids sync / filter job); export (BOM, injection, formatting, 100k cap, 24 h, blocked when impersonating)
- [ ] Purge jobs (contacts 30 d, import files 30 d, exports 24 h); seed; samples + README; benchmark numbers; docs

**Batch 3**

- [ ] gen:api; clients; phone + format utils; `LIVE_PHASE = 3`; routes + permissions; live updates + polling fallback
- [ ] Contacts table: URL filters, sort, column picker, selection + select-all-matching, bulk bar, form dialog (dynamic typed fields, duplicate link)
- [ ] Detail page (typed variables, badges, actions, inline tags / lists, call-history placeholder, 404)
- [ ] Import wizard (resumable, all steps, DND variant) + activity page
- [ ] Lists, SegmentBuilder (+ advanced filter), DND (remove only `dnd.manage`), Fields (reorder, type lock), ExportDialog (hidden when impersonating)
- [ ] Playwright 5 new scenarios + 5 old green, run twice; log / Redis PII scan; gap audit; coverage raised (never lower)
- [ ] Docs both repos + PHASE_3_SIGNOFF.md + BUILD_PLAN status; fresh clones; gitleaks; `infra:down`
