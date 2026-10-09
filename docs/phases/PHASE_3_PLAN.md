# Phase 3 — Contacts, Lists & Custom Fields — Detailed Plan

**Status:** ready to start · **Prev:** [Phase 2 sign-off](PHASE_2_SIGNOFF.md) · **Source:** [BUILD_PLAN §Phase 3](../plans/BUILD_PLAN.md) · **Tracker:** [PHASE_3_TASKS.md](PHASE_3_TASKS.md)
**Branch:** `feature/phase-3-contacts` (both repos, from the Phase 2 tip) · **Commit tag:** `[P3-T3.x]`, checkpoints `[P3-Bx-DONE]`

---

## 0. Is phase ka goal

Phase 3 ke end tak client apne customers ki **sheet upload** karke contacts bana sake, har contact ke **apne variables** (loan amount, due date, EMI …) store ho, aur galat rows ki **saaf report** mile — taaki Phase 8 campaign inhi contacts ko call kar sake.

1. **Contact** — naam, phone (**E.164**, India default), email, tags, lists, **custom variables** (typed), DND / opt-out / consent, source.
2. **Custom field definitions** — key, label, type (`text`, `number`, `date`, `currency`, `phone`), required, default. Yahi keys flows me `{{loan_amount}}` banengi.
3. **Import** (CSV / Excel `.xlsx`) — upload → **column mapping** → **validation report** (invalid / duplicate / missing / DND) → **import background job** (progress live) → error CSV download.
4. **Lists** (ek upload = ek list), **segments** (saved filter), **tags**.
5. **DND / do-not-call** per account — manual add, file upload, remove (sirf owner / admin), contact **opt-out**.
6. **Contacts UI** — table, search, filters, column picker, bulk actions (tag, list, delete, export), contact detail (variables + call-history placeholder), import wizard, Lists / Segments / DND / Fields tabs.
7. **Export** contacts (CSV, background job, signed download link, audit).
8. **Retention jobs** — deleted contacts purge (30 din), import files + error reports (30 din), export files (24 h).

**Done when (BUILD_PLAN):** 100 customers ki sheet import ho, har contact ke variables dikhen, galat rows ki report mile — **Playwright se proven** (sample sheet me jaan-boojh ke invalid / duplicate / missing rows).

### Phase 3 mein kya NAHI hoga

| Kaam                                                               | Kaunse phase mein                                                        |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Calls / call history data (detail page par sirf placeholder)       | Phase 7 (calls collection), Phase 9 (history UI)                         |
| DND / opt-out **enforcement** while dialing (`skipReason`)         | Phase 8 (campaign scheduler) — Phase 3 sirf data + filters + badges      |
| Per-contact daily / weekly call caps (`lastCalledAt`, `callCount`) | Fields abhi ban jayenge (default 0 / null), logic Phase 8                |
| Public API (`X-API-Key`) for contacts push                         | Phase 10 — Phase 3 routes sirf dashboard (Bearer)                        |
| NCPR / national DND registry scrubbing                             | Out of scope (loan recovery = service calls) — client legal confirm kare |
| Data-principal "erase now" / per-account retention settings        | Phase 11 (compliance) — Phase 3 me fixed 30-din purge                    |
| `.xls` (old binary Excel), Google Sheets link import               | Out of scope — UI bolega "Save as .xlsx or .csv"                         |
| Multiple loans per borrower (same phone, alag loan rows)           | **Client question** (§7) — Phase 3 default: 1 phone = 1 contact          |
| Excel (`.xlsx`) export                                             | Later — Phase 3 export CSV (Excel me UTF-8 BOM ke saath sahi khulta hai) |

### Conventions to follow

[api.md](../conventions/api.md) (§6 pagination, §7 sorting, §8 filtering, **§11 uploads**, §13 tenant scoping) · [data-model.md](../conventions/data-model.md) §2.2 · [data.md](../conventions/data.md) §9 PII · [error-codes.md](../conventions/error-codes.md) · [websocket.md](../conventions/websocket.md) (`import.progress`) · [audit.md](../conventions/audit.md) · [compliance-notes.md](../compliance/compliance-notes.md) (DND, consent, DPDP) · ADRs [0004 database](../adr/0004-database.md), [0005 queues](../adr/0005-queue-and-background-jobs.md), [0016 money](../adr/0016-money-representation.md), [0017 dates](../adr/0017-dates-and-timezones.md), [0018 phone numbers](../adr/0018-phone-numbers.md), [0023 file storage](../adr/0023-file-storage.md), [0029 OpenAPI types](../adr/0029-shared-api-types-via-openapi.md).

---

## 1. Locked decisions (pehle se tay — implementation me dobara debate nahi)

### 1a. Contact identity, phone & values

| Topic                   | Decision                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity                | **1 phone = 1 contact** per account: unique `{ accountId, phoneE164 }` (partial: `deletedAt: null`). Optional **`externalId`** (client's loan / CRM id), unique per account when set (partial index).                                                                                                                                                                                               |
| Phone parsing           | `libphonenumber-js` (already a dependency), default region = **account.country** (IN). Accept: `9876543210`, `09876543210`, `+91 98765-43210`, `919876543210` (12 digits starting with the country code → `+` added), `(0)…`. Store E.164. Valid = `isValid()`; mobile **and** landline allowed. `isPossible` but not valid → invalid.                                                              |
| Excel phone traps       | Numeric cells → read as integer string (no `.0`). Scientific notation (`9.87654E+09`) → **invalid, reason "number stored in Excel lost digits — format the column as Text"**. Leading apostrophe stripped.                                                                                                                                                                                          |
| Name / email            | `name` optional, trimmed, max 120, Unicode (Hindi OK). `email` optional, lower-cased, validated (zod email). Empty string = absent.                                                                                                                                                                                                                                                                 |
| Variables storage       | `variables: Map<string, string \| number>` — **typed by the field definition**: `text` → string (≤ 1000), `number` → finite number, `currency` → **integer micros** (`₹12,500.50` → `12500500000`, ADR 0016, currency = account currency INR), `date` → **`YYYY-MM-DD` string** (date-only, no timezone shift), `phone` → E.164 string. Unknown keys rejected (422) except from import "new field". |
| Number / currency input | Accept Indian grouping (`1,25,000`), `₹` / `Rs` / `INR` prefixes, spaces; reject text, `NaN`, `Infinity`; currency max 2 decimals.                                                                                                                                                                                                                                                                  |
| Date input              | Formats: `DD/MM/YYYY`, `DD-MM-YYYY`, `DD.MM.YYYY`, `YYYY-MM-DD`, `DD-MMM-YYYY` (`05-Oct-2026`), Excel serial numbers / Excel date cells. **Ambiguity rule: India default `DD/MM`**; mapping screen per date column lets the user switch to `MM/DD/YYYY`. Invalid calendar dates (31/02) → invalid.                                                                                                  |
| Required & default      | Missing required value → `defaultValue` if set, else row/contact **invalid** (`missing_required`). Default applied on create/import only, never overwrites an existing value on update.                                                                                                                                                                                                             |
| Tags                    | Free strings, **lower-cased**, trimmed, `^[\p{L}\p{N} _-]{1,40}$`u, max **20 per contact**, deduped. No Tag collection; tag list = aggregation.                                                                                                                                                                                                                                                     |
| Lists on a contact      | `listIds[]`, max **50 per contact**; adding is idempotent (`$addToSet`).                                                                                                                                                                                                                                                                                                                            |
| Source                  | `source: { type: manual \| import \| api, importJobId? }` (first creation).                                                                                                                                                                                                                                                                                                                         |
| Soft delete & revive    | Delete = `deletedAt` (hidden everywhere). Creating / importing a phone that matches a soft-deleted contact **revives** it (clears `deletedAt`, replaces data, old lists removed). Purge job hard-deletes after **30 days**.                                                                                                                                                                         |
| Search                  | `searchText` (lower-case: name + email + phone digits + externalId), escaped substring regex, always combined with `accountId` + `deletedAt: null`. Phone search accepts any format (digits extracted).                                                                                                                                                                                             |
| Sort                    | Allowlist: `createdAt`, `updatedAt`, `name`, `lastCalledAt` (default `-createdAt`). Name sort uses collation `{ locale: 'en', strength: 2 }` + matching index.                                                                                                                                                                                                                                      |

### 1b. Custom fields

| Topic       | Decision                                                                                                                                                                                                                                                                                       |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Key         | `^[a-z][a-z0-9_]{0,39}$`, unique per account, **immutable** after create. Reserved (rejected): `name`, `phone`, `email`, `tags`, `lists`, `id`, `account`, `contact`, `external_id`, `created_at`, `updated_at`, `dnd`, `opted_out`, `consent`, `source`. Label auto-slugs to a key in the UI. |
| Max         | **50** fields per account (→ `409 CONFLICT_INVALID_STATE`, same pattern as API keys).                                                                                                                                                                                                          |
| Type change | Allowed only when **no live contact** has a value for the key; else `409 CONFLICT_INVALID_STATE` ("Field has data").                                                                                                                                                                           |
| Edit        | Label, required, defaultValue (validated against type), `order` (display order).                                                                                                                                                                                                               |
| Delete      | Removes the definition **and** `$unset variables.<key>` on all contacts of the account (background job on the `contacts` queue) — UI confirm warns "values on N contacts will be deleted". Audited.                                                                                            |
| Flow usage  | Keys are the `{{key}}` placeholders in Phase 5/6; system placeholders `{{name}}`, `{{phone}}`, `{{email}}` always exist.                                                                                                                                                                       |

### 1c. Import pipeline

| Topic              | Decision                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Files              | `.csv` and `.xlsx` only, **10 MB**, **50,000 data rows**, **100 columns**, header row required (row 1). Extension **and** MIME **and** magic bytes checked (xlsx = ZIP `PK\x03\x04`; CSV must not contain NUL bytes). `.xls` / others → `415 UNSUPPORTED_MEDIA_TYPE` with "Save as .xlsx or .csv".                                                                                                                         |
| Upload handling    | **multer 2** memory storage (`limits.fileSize` 10 MB, 1 file, field `file`) on this route only; file saved to storage `accounts/<accountId>/imports/<jobId>.<ext>` (ADR 0023). Request body never logged.                                                                                                                                                                                                                  |
| CSV parsing        | **csv-parse** (streaming): UTF-8 with BOM stripped; if the bytes are not valid UTF-8 → decode **windows-1252** (`iconv-lite`) and add a warning; delimiter sniffed from the header line (`,` `;` `\t` `\|`); quotes / multiline cells supported; empty lines skipped; ragged rows padded / reported.                                                                                                                       |
| XLSX parsing       | **read-excel-file** (`/node`, CJS export, MIT, maintained): workbook sheet list returned; user picks a sheet (default first). Dates → JS Date → `YYYY-MM-DD`; numbers → strings without float noise. **Zip-bomb guard:** reject if uncompressed size > 100 MB or rows > 50,000 (checked before full parse). Fallback if blocked: `exceljs` (decide in T3.7, ADR 0031).                                                     |
| Header handling    | Trimmed; empty header → `Column C`; duplicate headers → suffixed `(2)`. Header cells used only as labels.                                                                                                                                                                                                                                                                                                                  |
| Mapping targets    | `name`, `phone` (**required**, exactly one), `email`, `external_id`, `tags` (comma / semicolon separated), `consent_at`, `field:<key>` (existing field), `new_field` (`{ key, label, type }` — created when the import starts), `ignore`. One target per column (except `ignore`), each target once.                                                                                                                       |
| Suggested mapping  | Header heuristics (case / space / `_` insensitive, Hinglish too): phone ← `phone, mobile, mobile no, contact, number, phone number, mob`; name ← `name, naam, customer, customer name, borrower`; email ← `email, e-mail, mail`; external_id ← `loan id, account no, customer id`; existing fields matched by key or label; else `new_field` with type guessed from sample values (number / date / currency / text).       |
| Options            | Target list: **new** (default name = file name + date, editable) or **existing**. `updateExisting` (default **on**): matched contacts get name / email / variables / tags merged (empty cells **don't** clear values). `tags` added to every row. `consentSource` (e.g. "Loan agreement") → `consent { source, at: consent_at column or import time }`.                                                                    |
| Row outcomes       | `created`, `updated`, `unchanged` (exists, `updateExisting` off — still added to the list), `invalid` (reasons: `phone_invalid`, `phone_missing`, `phone_lost_digits`, `email_invalid`, `missing_required:<key>`, `type_invalid:<key>`, `too_long:<key>`, `tags_invalid`), `duplicate_in_file` (**first occurrence wins**, later rows reported with the first row number), `dnd` (imported **and** flagged — not skipped). |
| Validate (dry run) | `POST /contact-imports/:id/validate` → job on queue `contacts` (no writes) → totals + first **100** problem rows inline + **error CSV** (original row number, original cells, reasons) in storage. Always required before start (mapping changes → state back to `mapped`).                                                                                                                                                |
| Import run         | Job re-parses the file and writes in **batches of 500** (`bulkWrite` upserts by phone, `$addToSet listIds`, `$set` merged fields); checkpoint `processedRows` after each batch → a retried job **resumes**; E11000 race (two imports, same phone) → batch retried once. Not one big transaction (by design — partial import is reported).                                                                                  |
| Concurrency        | **1 running import / validate per account** (Redis lock `contacts:import-lock:<accountId>`, 30 min TTL refreshed per batch); worker concurrency 2 globally. Second start → `409 CONFLICT_INVALID_STATE`.                                                                                                                                                                                                                   |
| States             | `uploaded → mapped → validating → validated → importing → completed`, plus `failed` (with `errorMessage`, no PII) and `canceled`. Cancel allowed in `uploaded / mapped / validated` (deletes file) and `importing` (stops after the current batch, rows written stay).                                                                                                                                                     |
| Progress           | `importJobs.progress { processed, total }` = source of truth; WS `import.progress { importJobId, processed, total, status }` (account room, throttled ≤ 1 / s) + final event on every state change.                                                                                                                                                                                                                        |
| Account suspended  | Worker checks account status before each batch → job `failed` (`account_suspended`).                                                                                                                                                                                                                                                                                                                                       |
| Template           | `GET /contact-imports/template.csv` → header `name,phone,email,external_id,tags,<field keys…>` + 1 example row; UI "Download sample".                                                                                                                                                                                                                                                                                      |
| Retention          | Uploaded file + error report deleted **30 days** after `completedAt / failedAt / canceledAt` (`maintenance` queue); the job document stays (totals only, no PII).                                                                                                                                                                                                                                                          |

### 1d. Lists, segments, DND, opt-out, consent, export, bulk

| Topic         | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lists         | `contactLists { name, description?, source }`, name unique per account (live only), max **500** per account. **Counts computed on read** (aggregation over the page's list ids, index `{ accountId, listIds }`) — the `contactCount` field from data-model.md is dropped (no drift). Delete list → soft delete + `$pull listIds` from contacts (background job); **contacts are not deleted**.                                                                                                                                                                        |
| Segments      | `segments { name, filter }` — saved filter evaluated at query time. Filter: `listIds` (any), `tags` (`any` / `all`), `dnd`, `optedOut`, `createdFrom/To`, and up to **20** `conditions [{ key, op, value }]` on fields. Ops by type: text `eq, neq, contains, exists, not_exists`; number / currency `eq, neq, gt, gte, lt, lte, between, exists`; date `on, before, after, between, within_next_days, overdue_by_days`; phone `eq, exists`. Compiled server-side by a pure, tested `compileContactFilter()` (never raw Mongo from the client). Max **100** segments. |
| Filters reuse | `GET /contacts` accepts the same filter (query params for simple ones, `segmentId`, or `POST /contacts/search` with a filter body for the builder preview). Same compiler everywhere (contacts list, segment preview, bulk by filter, export).                                                                                                                                                                                                                                                                                                                        |
| DND           | `dndEntries { phoneE164, reason?, source: manual \| upload \| keyword \| dtmf, addedBy? }` unique per account. Add (single / file upload) → `contacts.dnd = true` for that phone (and new / imported contacts look up DND on write). **Remove → permission `dnd.manage` (owner, admin)** + confirm + audit; `contacts.dnd` reset if no entry.                                                                                                                                                                                                                         |
| Opt-out       | Contact action "Opt out" (`contacts.write`) → `optedOutAt` + DND entry (`source: manual`, reason "opted out") so a re-import can't bring them back. Undo = remove DND (needs `dnd.manage`) + clear `optedOutAt`.                                                                                                                                                                                                                                                                                                                                                      |
| Consent       | `consent { source, at }` — from import options / mapping or contact edit; shown on detail. No enforcement in Phase 3.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Bulk actions  | `POST /contacts/bulk { action, ids? \| filter? , payload }` — actions `add_tags`, `remove_tags`, `add_to_list`, `remove_from_list`, `delete`, `add_to_dnd`. `ids` ≤ **1,000** → synchronous; `filter` → job on `contacts` queue (≤ 100,000 contacts) → WS `contacts.bulk_completed { action, count }`. Delete always confirmed in UI.                                                                                                                                                                                                                                 |
| Export        | `POST /contact-exports { filter \| listId \| segmentId, columns? }` → job → CSV (**UTF-8 BOM**, `\r\n`, all variables formatted: currency as rupees, dates `YYYY-MM-DD`) → storage `accounts/<id>/exports/<jobId>.csv` → signed URL (15 min, regenerated on request). **CSV-injection safe**: cells starting with `=`, `+`, `-`, `@`, tab, CR get a leading `'`. Max **100,000** rows. File deleted after **24 h**. WS `export.progress`. Permission `contacts.export`, audited with row count (no PII).                                                              |
| Permissions   | Reuse catalogue: `contacts.read` (view everything incl. lists / segments / DND / fields), `contacts.write` (create / edit / delete contacts, lists, segments, fields, add DND, opt-out, bulk), `contacts.import`, `contacts.export`. **New: `dnd.manage`** (remove DND / undo opt-out) → owner + admin; migration **0004** runs `syncSystemRoles()`. Manager keeps contacts read / write / import / export (no `dnd.manage`); agent + viewer read only.                                                                                                               |
| Auth          | Dashboard only (`authenticate` + `requirePermission`); suspended accounts read-only (existing rule); impersonation allowed (audited) — **export blocked while impersonating** (`AUTH_IMPERSONATION_BLOCKED`, PII leaves the system).                                                                                                                                                                                                                                                                                                                                  |

### 1e. Limits (`src/config/limits.ts` → `CONTACT_LIMITS`)

| Limit                           | Value               |
| ------------------------------- | ------------------- |
| Import file size                | 10 MB               |
| Import rows / columns           | 50,000 / 100        |
| XLSX uncompressed size          | 100 MB              |
| Import batch size               | 500                 |
| Problem rows returned inline    | 100                 |
| Custom fields / account         | 50                  |
| Lists / account                 | 500                 |
| Segments / account              | 100                 |
| Segment conditions              | 20                  |
| Tags / contact, lists / contact | 20 / 50             |
| Bulk by ids                     | 1,000               |
| Bulk / export by filter         | 100,000             |
| Text value length               | 1,000               |
| Page size (contacts)            | default 20, max 100 |

### 1f. Queues, events, audit, error codes

| Topic       | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Queue       | New BullMQ queue **`contacts`** (`QUEUES.contacts`): job names `import.validate`, `import.run`, `export.run`, `bulk.run`, `field.delete_values`, `list.delete_members`. Job data = **ids only** (no PII in Redis). attempts 3, exponential backoff, `removeOnComplete`, failed kept 24 h.                                                                                                                                                                                                                                            |
| Maintenance | Daily jobs on the existing `maintenance` queue: `contacts.purge_deleted` (> 30 days), `imports.purge_files` (> 30 days), `exports.purge_files` (> 24 h).                                                                                                                                                                                                                                                                                                                                                                             |
| WS events   | `import.progress` (exists in websocket.md), **new** `export.progress { exportJobId, processed, total, status }`, `contacts.bulk_completed { action, count }`, `contacts.changed { reason }` (after import / bulk / field delete → UI refetches). Frontend `events.ts` + backend `events.ts` + websocket.md §5 together.                                                                                                                                                                                                              |
| Audit (new) | `contacts.import_started`, `contacts.import_completed` (totals), `contacts.import_canceled`, `contacts.exported` (count, filter kind), `contacts.deleted` (count, single or bulk), `contacts.bulk_updated` (action, count), `contact.opted_out`, `dnd.added` (count, source), `dnd.removed`, `custom_field.created`, `custom_field.updated`, `custom_field.deleted`, `contact_list.deleted`, `segment.deleted`. **No phone numbers / names in `meta`.** `AUDIT_ACTIONS` + audit.md together (test-synced).                           |
| Error codes | **New:** `IMPORT_FILE_INVALID` (422 — unreadable / empty / no header / too many rows or columns / zip bomb; `details[].message` says why). Reused: `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, `VALIDATION_FAILED`, `CONFLICT_DUPLICATE` (phone / externalId / field key / list name — `details` carry the existing id), `CONFLICT_INVALID_STATE` (limits, wrong import state, field has data, import already running), `RESOURCE_NOT_FOUND`, `AUTH_IMPERSONATION_BLOCKED`. `CONTACT_DND` / `CONTACT_OPTED_OUT` stay for Phase 8. |
| PII         | Logs never contain phones / names / emails / variables / file contents (mask helpers; import errors logged by row number only). Error reports + exports are PII files: account-prefixed keys, signed URLs only, purge jobs. data.md §9 PII inventory updated (import files, error reports, export files, `searchText`).                                                                                                                                                                                                              |

### 1g. Frontend

| Topic          | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Navigation     | `LIVE_PHASE = 3` → **Contacts** menu item live (`contacts.read`). Routes: `/contacts` (tabs: **Contacts · Lists · Segments · Do-not-call · Fields**, tab in URL `/contacts/:tab`), `/contacts/c/:id` (detail), `/contacts/import` + `/contacts/import/:jobId` (wizard, resumable), `/contacts/activity` (imports & exports history).                                                                                                                                                                                                                                                    |
| Table          | Server-side pagination / sort / search (debounced 300 ms) / filters (list, tag, DND status, opted-out, segment); **column picker** for custom fields (persisted per user in `localStorage`, try/catch); row checkbox + "select all N matching" → bulk bar.                                                                                                                                                                                                                                                                                                                              |
| Forms          | react-hook-form + zod; **dynamic contact form** from field definitions (text, number, currency with `₹` adornment, date via `type="date"`, phone). Phone validated client-side with `libphonenumber-js/min` (same default region), server stays the authority.                                                                                                                                                                                                                                                                                                                          |
| Formatting     | `src/utils/format.ts`: `formatPhone` (IN national `+91 98765 43210`), `formatCurrencyMicros` (`en-IN`, ₹), `formatDateOnly` (no timezone shift), `formatNumber` (`en-IN`).                                                                                                                                                                                                                                                                                                                                                                                                              |
| Import wizard  | MUI Stepper: **Upload** (drag & drop + click, client-side extension / size check, sample template link) → **Map columns** (per column: header, 3 sample values, target select, inline "new field" with type, date-format select for date columns, sheet select for xlsx) → **Options** (list new / existing, update existing, tags, consent source) → **Validate** (live progress, totals cards, problem rows table, error CSV download, Back to fix mapping) → **Import** (live progress, summary, "View contacts" → list filter). Leaving and coming back resumes from the job state. |
| Live updates   | `useWsEvent('import.progress' / 'export.progress' / 'contacts.bulk_completed' / 'contacts.changed')` → progress UI + query invalidation; polling fallback every 3 s when WS is off.                                                                                                                                                                                                                                                                                                                                                                                                     |
| Detail page    | Header (name, formatted phone, DND / opted-out / deleted badges, actions: edit, opt out, add to DND, delete), sections: Details (email, external id, source, created / updated in account TZ), **Variables** (label: formatted value, in field order; empty shown as "—"), Lists & tags (editable chips), Consent, **Call history** placeholder ("arrives in Phase 7").                                                                                                                                                                                                                 |
| Permissions UI | Buttons hidden without permission (`contacts.write`, `contacts.import`, `contacts.export`, `dnd.manage`); export hidden while impersonating.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Query keys     | `features/contacts/keys.ts`: `['contacts', 'list', params]`, `['contacts', 'detail', id]`, `['contact-lists', …]`, `['segments', …]`, `['dnd', …]`, `['custom-fields']`, `['contact-imports', id]`, `['contact-exports', id]`.                                                                                                                                                                                                                                                                                                                                                          |

### 1h. Dependencies (verify latest at batch start; checked 2026-10-09)

| Repo     | Package                      | Version (today)  | Note                                                                                        |
| -------- | ---------------------------- | ---------------- | ------------------------------------------------------------------------------------------- |
| backend  | `multer` + `@types/multer`   | 2.4.0 / 2.3.0    | upload route only, memory storage                                                           |
| backend  | `csv-parse`, `csv-stringify` | 7.0.3 / 6.9.0    | streaming parse / export                                                                    |
| backend  | `read-excel-file`            | 9.3.12           | ESM package with a CJS `./node` export — verify `require` in T3.7; fallback `exceljs` 4.4.0 |
| backend  | `iconv-lite`                 | 0.7.3            | windows-1252 fallback for non-UTF-8 CSV                                                     |
| backend  | `libphonenumber-js`          | 1.13.x (present) | bump to latest                                                                              |
| frontend | `libphonenumber-js`          | 1.13.15          | `/min` metadata build                                                                       |
| both     | `allowScripts`               | —                | review any new install scripts (`npm approve-scripts --allow-scripts-pending`)              |

---

## 2. Tasks ka overview

| #     | Task                                                                                                           | Repo | Size | Depends on  |
| ----- | -------------------------------------------------------------------------------------------------------------- | ---- | ---- | ----------- |
| T3.1  | Models, indexes, migration 0004 (`dnd.manage`), limits, error code, `contacts` queue, events / audit catalogue | BE   | M    | Phase 2     |
| T3.2  | Normalisation library: phone, typed values (number / currency / date / text / phone), tags, email              | BE   | M    | T3.1        |
| T3.3  | Custom fields API                                                                                              | BE   | S    | T3.2        |
| T3.4  | Contacts CRUD + search / filter / sort + filter compiler + tags endpoint                                       | BE   | L    | T3.3        |
| T3.5  | Lists + segments API                                                                                           | BE   | M    | T3.4        |
| T3.6  | DND + opt-out + consent                                                                                        | BE   | M    | T3.4        |
| T3.7  | Upload + file parsing (CSV / XLSX) + import job model + suggested mapping + template + mapping API             | BE   | L    | T3.4        |
| T3.8  | Validate (dry-run) job + error report                                                                          | BE   | M    | T3.7        |
| T3.9  | Import run job (batches, resume, cancel, lock, progress WS) + DND file upload                                  | BE   | L    | T3.8, T3.6  |
| T3.10 | Bulk actions + export job + background field / list cleanup                                                    | BE   | M    | T3.5, T3.6  |
| T3.11 | Retention purge jobs                                                                                           | BE   | S    | T3.9, T3.10 |
| T3.12 | Seed data, sample sheets, OpenAPI, performance check, backend docs                                             | BE   | M    | T3.1–T3.11  |
| T3.13 | Frontend foundation: gen:api, API clients, format utils, nav, routes, contacts shell + tabs                    | FE   | M    | T3.12       |
| T3.14 | Contacts table, filters, column picker, bulk bar, create / edit dialog                                         | FE   | L    | T3.13       |
| T3.15 | Contact detail page                                                                                            | FE   | M    | T3.14       |
| T3.16 | Import wizard + imports / exports activity page                                                                | FE   | L    | T3.13       |
| T3.17 | Lists, Segments (builder), Do-not-call, Fields tabs + export dialog                                            | FE   | L    | T3.14       |
| T3.18 | Playwright E2E, gap + security audit, docs, Phase 3 sign-off                                                   | both | M    | all         |

**Size:** S = kuch ghante · M = ~1 din · L = 2 din.

**Batches (same style as Phase 2):** **Batch 1 = T3.1–T3.6** (data + APIs) · **Batch 2 = T3.7–T3.12** (import / export / jobs) · **Batch 3 = T3.13–T3.18** (frontend + E2E + sign-off). Har batch: detailed run prompt → implement → `[P3-Bx-DONE]` checkpoint (full verify, fresh clone, secret scan).

---

## 3. Tasks — step by step

### T3.1 — Models, indexes, migration, limits, catalogue

- [x] Models in `src/db/models/` (base plugin: tenant `accountId`, timestamps, soft delete where noted):
  - `contact.model.ts` — `phoneE164`, `name?`, `email?`, `externalId?`, `variables` (Map, mixed string / number), `tags[]`, `listIds[]`, `dnd` (default false), `optedOutAt?`, `consent? { source, at }`, `source { type, importJobId? }`, `searchText`, `lastCalledAt?` (null), `callCount` (0), `deletedAt`.
  - `contact-list.model.ts` — `name`, `description?`, `source { type, fileName? }`, `deletedAt`.
  - `custom-field.model.ts` (`customFieldDefinitions`) — `key`, `label`, `type`, `required`, `defaultValue?`, `order`.
  - `segment.model.ts` — `name`, `filter` (validated shape), `createdBy`.
  - `dnd-entry.model.ts` — `phoneE164`, `reason?`, `source`, `addedBy?`.
  - `import-job.model.ts` — `kind: contacts \| dnd`, `fileName`, `fileKey`, `fileType: csv \| xlsx`, `sheet?`, `sheets[]`, `columns [{ index, header, samples[] }]`, `rowCount`, `mapping`, `options`, `status`, `progress { processed, total }`, `totals { rows, created, updated, unchanged, invalid, duplicates, dnd }`, `problemRows[]` (≤ 100: `{ row, reasons[] }` — **no cell values**), `errorReportKey?`, `listId?`, `warnings[]`, `errorMessage?`, `createdBy`, `startedAt`, `completedAt`, `canceledAt`.
  - `export-job.model.ts` — `filterKind`, `filter`, `columns`, `status`, `progress`, `rowCount`, `fileKey?`, `createdBy`, `completedAt`, `expiresAt`.
- [x] Indexes (exactly as data-model.md after update): contacts `{ accountId, phoneE164 }` unique partial `deletedAt: null`; `{ accountId, externalId }` unique partial (string + not deleted); `{ accountId, deletedAt, createdAt: -1 }`; `{ accountId, listIds }`; `{ accountId, tags }`; `{ accountId, dnd }`; `{ accountId, name }` with collation en/2. Lists `{ accountId, name }` unique partial live. Fields `{ accountId, key }` unique. Segments `{ accountId, name }` unique. DND `{ accountId, phoneE164 }` unique. Import / export jobs `{ accountId, createdAt: -1 }`.
- [x] Permission `dnd.manage` in the catalogue (group "Contacts") → owner / admin; migration **`0004-dnd-manage-permission`** calls `syncSystemRoles()` (`down` removes it); frontend test `ROLE_PERMISSIONS` updated in T3.13.
- [x] `CONTACT_LIMITS` in `src/config/limits.ts` (§1e).
- [x] Error code `IMPORT_FILE_INVALID` in `error-codes.ts` + error-codes.md (test-synced).
- [x] `QUEUES.contacts` + worker registration skeleton (`src/core/queues/workers/contacts.worker.ts`) behind `WORKERS_ENABLED`.
- [x] WS event types (`export.progress`, `contacts.bulk_completed`, `contacts.changed`) + websocket.md §5; audit actions (§1f) in `AUDIT_ACTIONS` + audit.md.
- [x] Tests: model validation + hidden fields, every unique index (incl. partial / revive), migration up / down, catalogue sync tests still green, tenant-scope test covers the new models.

### T3.2 — Normalisation library (`src/modules/contacts/normalize/`)

- [x] `phone.ts` — `normalizePhone(raw, defaultCountry) → { ok, e164 } | { ok: false, reason }` (all §1a cases incl. `phone_lost_digits`, apostrophe, 12-digit `91…`, extension text rejected).
- [x] `values.ts` — `parseFieldValue(type, raw, { dateFormat })` for text / number / currency (micros) / date (`YYYY-MM-DD`, Excel serial, `Date`) / phone; `formatFieldValue(type, stored)` for export / templates.
- [x] `tags.ts`, `email.ts`, `search-text.ts` (build `searchText`).
- [x] `applyDefaultsAndRequired(fields, variables)`.
- [x] Tests: table-driven, ≥ 120 cases (Hindi names, Indian grouping, `₹`, `Rs.`, negative numbers, 29/02 leap year, 31/04 invalid, `MM/DD` option, Excel serial 45000, scientific phone, `+1` US number with IN default, landline `+911123456789`, empty / whitespace). Coverage 100 % for this folder.

### T3.3 — Custom fields API (`/api/v1/custom-fields`)

- [x] `GET` (ordered, with `usageCount` on request `?withUsage=true`), `POST`, `PATCH /:id` (label / required / defaultValue / order; type only when unused), `DELETE /:id` (→ job `field.delete_values`, returns 202), `PUT /order` (reorder).
- [x] Rules §1b (key regex, reserved, max 50, defaultValue typed, type-change guard).
- [x] Audit `custom_field.*`. OpenAPI registered.
- [x] Tests: CRUD, permissions (agent / viewer 403), limits, reserved keys, type change with / without data, delete cascade job, tenant isolation (other account's field → 404), suspended → 403 on writes.

### T3.4 — Contacts API (`/api/v1/contacts`)

- [x] `GET /contacts` (offset pagination, `q`, filters `listId`, `tag` (comma = any), `tagsAll`, `dnd`, `optedOut`, `segmentId`, `createdFrom/To`, `sort` allowlist; unknown params → 422), `POST /contacts/search` (filter body, same response), `GET /contacts/:id` (with list names), `POST /contacts`, `PATCH /contacts/:id` (`variables` partial merge; `null` clears a non-required value), `DELETE /contacts/:id` (soft), `GET /contact-tags` (distinct tags with counts).
- [x] `compileContactFilter(filter, fields)` → Mongo query (pure, typed per field type, always `accountId` + `deletedAt: null`); zod schema for the filter shared by contacts / segments / bulk / export.
- [x] Create: normalise → DND lookup sets `dnd` → revive soft-deleted phone → `409 CONFLICT_DUPLICATE { existingId }` for a live duplicate (phone or externalId).
- [x] Response shape `Contact` (variables as stored; `listIds` + `lists [{ id, name }]` on detail).
- [x] Tests: CRUD, every filter + operator, search by any phone format / Hindi name, sort incl. collation, pagination meta, revive path, duplicate 409 details, unknown variable key 422, required / default, permissions per role, tenant isolation (list / get / patch / delete other account → 404), suspended → 403, impersonation allowed + audited where relevant.

### T3.5 — Lists + segments

- [x] `/api/v1/contact-lists`: `GET` (pagination, `q`, computed `contactCount`), `POST`, `PATCH /:id` (name / description), `DELETE /:id` (soft + job `list.delete_members`, audit). Max 500, name unique (409).
- [x] `/api/v1/segments`: `GET` (with optional `?withCounts=true`), `POST`, `PATCH`, `DELETE` (audit), `POST /segments/preview { filter }` → `{ count, sample: Contact[5] }`. Max 100, ≤ 20 conditions, keys must exist (422).
- [x] Tests: counts after add / remove / delete contact, list delete keeps contacts, segment operators per type (`within_next_days`, `overdue_by_days` with fake timers in account TZ), invalid condition / op for type → 422, isolation.

### T3.6 — DND, opt-out, consent

- [x] `/api/v1/dnd-entries`: `GET` (pagination, `q` phone search), `POST { phone, reason? }` (normalise; idempotent → existing entry returned), `DELETE /:id` (`dnd.manage`, audit `dnd.removed`), contacts `dnd` mirror updated in the same transaction.
- [x] `POST /contacts/:id/opt-out` (`contacts.write`) → `optedOutAt` + DND entry; `DELETE /contacts/:id/opt-out` (`dnd.manage`) → clears both. Audit `contact.opted_out`.
- [x] Consent via create / patch (`consent: { source, at }`, `at` ≤ now).
- [x] Tests: mirror both directions, re-create contact for a DND phone → `dnd: true`, manager can add but not remove (403), opt-out survives re-import (checked again in T3.9), isolation.

### T3.7 — Upload, parsing, mapping (`/api/v1/contact-imports`)

- [x] `POST /contact-imports` (multipart `file`, `kind=contacts|dnd`, `contacts.import`) → checks (ext, MIME, magic bytes, size → 413 / 415), store file, parse header + first 20 rows + count rows (streaming) → `ImportJob` `uploaded` with `columns`, `sheets`, `rowCount`, `suggestedMapping`, `warnings` (encoding fallback, ragged rows). Errors → `IMPORT_FILE_INVALID` with reason.
- [x] Parsers in `src/modules/contact-imports/parsers/`: `csv.ts` (BOM, delimiter sniff, windows-1252 fallback, quotes / multiline), `xlsx.ts` (sheets, dates, numbers, zip-bomb guard), common `RowSource` async iterator (re-used by validate / run / DND).
- [x] `PUT /contact-imports/:id/mapping { sheet?, mapping, options }` → validates targets (phone once, existing fields, new-field key rules / limit, list exists or new name free) → `mapped`.
- [x] `GET /contact-imports` (history, pagination), `GET /:id`, `POST /:id/cancel`, `GET /contact-imports/template.csv`, `GET /:id/error-report` (→ signed URL).
- [x] ADR **0031 — Contact import pipeline** (libraries, job states, batching, no single transaction, limits, encoding).
- [x] Tests (fixtures in `tests/fixtures/imports/`: UTF-8 BOM, windows-1252, semicolon, tab, quoted multiline, Hindi, ragged, empty, header-only, 50,001 rows (generated), xlsx with dates / numbers / scientific phones / 2 sheets, fake `.xlsx` with CSV bytes, zip bomb, `.xls`): every outcome, suggested mapping (Hinglish headers), mapping validation errors, isolation, permission (`contacts.import`), suspended 403.

### T3.8 — Validate (dry run) + error report

- [x] `POST /contact-imports/:id/validate` → lock → job `import.validate`: stream rows → normalise per mapping → duplicates in file (Map phone → first row) → existing contacts (batched `$in` lookups, 500) → DND lookup → totals + `problemRows` (≤ 100) + error CSV (`row, <original columns…>, reasons`, CSV-injection safe) → `validated`; WS progress.
- [x] Re-validate after mapping change; validate on a running job → 409.
- [x] Tests: the 100-row sample (`docs/samples/contacts-sample-100.csv`: 85 valid, 5 invalid phones, 3 missing required, 3 duplicates in file, 2 existing, 2 DND) → exact totals; error CSV content; no DB writes; progress events.

### T3.9 — Import run + DND upload

- [x] `POST /contact-imports/:id/start` (state `validated`, lock) → create new fields + list (one transaction) → job `import.run`: batches of 500 → `bulkWrite` upserts (created / updated / unchanged per §1c, revive soft-deleted, `source`, `consent`, DND flag) → checkpoint → WS progress → `completed` + totals + audit `contacts.import_completed` + `contacts.changed`.
- [x] Resume after a crashed / retried job from `progress.processed`; cancel mid-run; account suspended mid-run → `failed`; second concurrent import → 409; E11000 retry.
- [x] `kind=dnd` imports: mapping = phone (+ optional reason column) → upsert `dndEntries` + contacts mirror; totals.
- [x] Tests: sample import end-to-end (counts, variables typed, list membership, tags, consent), `updateExisting` on / off, empty cells don't clear, opted-out contact stays DND after re-import, resume (kill after batch 2), cancel, lock, suspended, 5,000-row import < 15 s in CI, isolation.

### T3.10 — Bulk actions, export, background cleanup

- [x] `POST /contacts/bulk` (§1d) — ids sync (≤ 1,000, all must belong to the account, else 404 for the request) / filter job; audit `contacts.bulk_updated` / `contacts.deleted`.
- [x] `POST /contact-exports`, `GET /contact-exports` (history), `GET /contact-exports/:id` (status + signed URL when ready). Job `export.run`: cursor over the compiled filter (batch 1,000), `csv-stringify`, BOM, injection-safe, formatted values, header from columns (default: name, phone, email, external_id, tags, lists, dnd, opted_out, <fields>, created_at). Blocked while impersonating.
- [x] Jobs `field.delete_values`, `list.delete_members` (batched updates, idempotent).
- [x] Phone columns are **exempt** from the injection prefix: the value is always our validated E.164 (`+` and digits only, so it can't carry a formula). Excel may still display a long number, so the README tells users to import the CSV as Text.
- [x] Tests: each bulk action (ids + filter), limits, export content (BOM, injection cases `=1+1`, `@SUM(…)`, `-2+3`, tab / CR prefixes, phone column unchanged), 100k cap, signed URL expiry, impersonation 403, permissions, isolation.

### T3.11 — Retention purge jobs

- [x] Daily repeatable jobs on `maintenance`: hard-delete contacts `deletedAt` < now − 30 d (batched); delete import files + error reports 30 d after finish (keep job doc, clear keys); delete export files after 24 h (status `expired`).
- [x] Tests with fake timers / dates: only expired items removed, storage deletes called, idempotent, isolation not relevant (system job) but per-account counts logged without PII.

### T3.12 — Seed, samples, OpenAPI, performance, backend docs

- [x] `db:seed`: Demo Finance gets fields `loan_id` (text), `loan_amount` (currency), `emi_amount` (currency), `due_date` (date), `days_past_due` (number), `branch` (text); list "Demo borrowers" with 25 fake contacts (fake names, `+91 9xxxxxxxxx` from a reserved fake range); 2 DND entries; 1 segment "Overdue > 30 days".
- [x] `docs/samples/contacts-sample-100.csv` + `contacts-sample-100.xlsx` (fake data, documented expected totals) + `dnd-sample.csv`.
- [x] `gen:openapi`; every route has request / response schemas + errors (`openapi:check` green).
- [x] Performance script `scripts/bench-contacts.ts` (dev only): 50,000-row import time, `GET /contacts` p95 with 50k contacts + search + segment filter → numbers recorded in the sign-off (targets: import ≤ 120 s locally, list p95 ≤ 300 ms).
- [x] Docs: data-model.md (§2.2 updated: variables types, `externalId`, `source`, `searchText`, Segment, ImportJob / ExportJob, dropped `contactCount`), api.md §11 (xlsx rules, row / column limits), data.md §9 (PII files), compliance-notes mapping row update, ADR 0018 implementation notes, README "Contacts & imports" section, CHANGELOG.
- [x] `[P3-B2-DONE]` checkpoint after this task.

### T3.13 — Frontend foundation

- [x] Backend `gen:openapi` → frontend `gen:api`; API clients `src/services/api/{contacts,contact-lists,segments,dnd,custom-fields,contact-imports,contact-exports}.ts`; type aliases.
- [x] `src/utils/format.ts` (§1g) + tests; `libphonenumber-js/min` helper `src/utils/phone.ts`.
- [x] `LIVE_PHASE = 3`; routes (§1g) under `RequirePermission perm="contacts.read"`; `ContactsPage` shell with URL tabs; `features/contacts/keys.ts`; test helper `ROLE_PERMISSIONS` + `dnd.manage`.
- [x] WS event types + `useWsEvent` wiring helper (`useContactsLiveUpdates`).
- [x] Tests: nav shows Contacts for agent / viewer (read) and hides for nobody else, tabs routing, format utils.

### T3.14 — Contacts table + create / edit

- [x] `ContactsTab`: DataTable with search, filters (list, tag autocomplete from `/contact-tags`, DND, opted-out, segment), sort headers, column picker (fields), row selection + "select all N matching", bulk bar (add / remove tag, add / remove list, add to DND, delete with confirm, export selected), empty state with "Import contacts" CTA.
- [x] `ContactFormDialog` (create / edit): base fields + dynamic field inputs + tags + lists + consent; server field errors (`variables.loan_amount` paths) mapped; duplicate 409 → "Open existing contact" link.
- [x] Tests: filters → query params, column picker persistence (and `localStorage` throwing), bulk by ids vs by filter, dialog validation per type, permission hiding (agent: no create / bulk), impersonation hides export.

### T3.15 — Contact detail

- [x] `/contacts/c/:id`: sections per §1g, inline tag / list editing, opt-out / undo (permission-aware), add to DND, delete (confirm → back to list), 404 page for missing / other account, Call history placeholder card.
- [x] Tests: formatted variables per type, empty values, badges, actions + permissions, 404.

### T3.16 — Import wizard + activity

- [x] Wizard (§1g) incl. resume by URL, cancel, mapping UI rules (phone required, unique targets, new-field inline form with key slug + type), date-format select, sheet select, options, validate report (totals cards, problem rows, error CSV link), import progress + summary; DND upload variant (kind `dnd`, 2 steps).
- [x] `/contacts/activity`: imports + exports history (status chips, totals, download links, cancel).
- [x] Tests: each step, invalid file type / size client-side, server `IMPORT_FILE_INVALID` message, mapping validation, WS progress + polling fallback, resume at each state, cancel.

### T3.17 — Lists, Segments, Do-not-call, Fields tabs + export

- [x] Lists tab (table with counts, create / rename / delete with confirm, click → contacts filtered).
- [x] Segments tab + **SegmentBuilder** (condition rows: field → operators by type → value input; tags any / all; lists; DND / opted-out toggles; live count preview debounced; save / edit / delete).
- [x] Do-not-call tab (search, add single, upload file → wizard kind dnd, remove only with `dnd.manage`).
- [x] Fields tab (table key / label / type / required / default / usage; create / edit dialog with key slug + immutable key; reorder; delete confirm with usage count).
- [x] `ExportDialog` (scope: selected / filter / list / segment; columns; progress; download).
- [x] Tests: builder operators per type, preview count, DND remove hidden for manager, field type change disabled when used, export flow.

### T3.18 — E2E, gap audit, docs, sign-off

- [x] Playwright scenarios (existing `e2e/` setup):
  1. **"Done when"**: owner creates fields via import "new field" → uploads `contacts-sample-100.csv` → maps (suggested mapping accepted, date column DD/MM) → validate → report shows 5 invalid + 3 missing + 3 duplicates (+ error CSV downloads) → import → 85 created / 2 updated → list shows 87 → contact detail shows typed variables (₹, date).
  2. XLSX import of the same data (sheet select).
  3. Segment "days_past_due > 30" count + bulk tag + export CSV (content checked: BOM, injection-safe).
  4. DND: add → contact badge; manager can't remove; owner removes; opt-out survives re-import.
  5. Agent (read-only): sees contacts + detail, no import / create / bulk / export.
- [x] Gap audit table (requirement → test), security checklist (PII not in logs during E2E with `E2E_BACKEND_LOGS=1`, files only via signed URLs, isolation tests per endpoint, CSV injection, zip bomb, upload type checks, rate limits, gitleaks), coverage gates re-measured (never lower).
- [x] Docs: both READMEs, CHANGELOGs, PHASE_3_TASKS, BUILD_PLAN status, this plan ticked, **PHASE_3_SIGNOFF.md**; `[P3-B3-DONE]` (full verify both repos, E2E twice, fresh clones, gitleaks, `infra:down`).

---

## 4. Deliverables checklist

- [x] Contact, list, custom field, segment, DND, import / export job models + indexes + migration 0004
- [x] Normalisation library (phone, typed values, tags) with exhaustive tests
- [x] Custom fields, contacts, lists, segments, DND / opt-out / consent APIs
- [x] CSV + XLSX upload, mapping, validate report + error CSV, batched resumable import, DND upload
- [x] Bulk actions, CSV export, background cleanup + retention purge jobs
- [x] Seed + sample sheets + OpenAPI + performance numbers
- [x] Frontend: Contacts (table, filters, bulk, detail), import wizard, lists, segments builder, DND, fields, export, activity
- [x] Playwright E2E for the "Done when" scenario
- [x] Docs (data-model, api, data, websocket, audit, error codes, ADR 0031, ADR 0018 notes), CHANGELOGs, sign-off

## 5. Risks

| Risk                                                          | Mitigation                                                                                                                  |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Excel mangles phones (scientific notation, dropped leading 0) | Detect and report `phone_lost_digits`, sample template with Text column, UI hint                                            |
| Wrong date interpretation (DD/MM vs MM/DD)                    | India default + per-column format choice + sample values shown in mapping + validate report                                 |
| Big files → memory / time                                     | 10 MB / 50k rows caps, streaming CSV, batched writes, zip-bomb guard, perf script with targets                              |
| Partial imports after crash                                   | Checkpointed batches, idempotent upserts, resume, clear "partially imported" status                                         |
| Two imports touching the same phones                          | Per-account lock + unique index + E11000 retry                                                                              |
| PII leaks (logs, Redis, files, exports)                       | Ids-only job data, masked logs, account-prefixed storage, signed URLs, purge jobs, export blocked when impersonating, audit |
| CSV injection when the client opens exports in Excel          | Prefix `'` on dangerous leading characters (tested)                                                                         |
| Filter queries slow on `variables.*` (no index)               | Always scoped by `accountId` + `deletedAt`; perf script; add targeted indexes later if p95 > 300 ms                         |
| Field type / key changes break flows later                    | Key immutable, type change only when unused                                                                                 |
| Business rule unknown: one borrower with several loans        | Default 1 phone = 1 contact; duplicate rows reported; client question §7                                                    |
| `read-excel-file` CJS / security issue                        | Verify in T3.7; fallback `exceljs` (ADR 0031)                                                                               |

## 6. Recommended order

| Day | Tasks               |
| --- | ------------------- |
| 1   | T3.1, T3.2          |
| 2   | T3.3, T3.4          |
| 3   | T3.4, T3.5          |
| 4   | T3.6, T3.7          |
| 5   | T3.7, T3.8          |
| 6   | T3.9                |
| 7   | T3.10, T3.11, T3.12 |
| 8   | T3.13, T3.14        |
| 9   | T3.14, T3.15        |
| 10  | T3.16               |
| 11  | T3.17               |
| 12  | T3.18               |

_Estimate — run batch-wise with one detailed run prompt (Batch 1 = T3.1–T3.6, Batch 2 = T3.7–T3.12, Batch 3 = T3.13–T3.18)._

## 7. Open questions for the client (defaults used until answered)

| #   | Question                                                                                                          | Default in Phase 3                                     |
| --- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 1   | One borrower with **several loans** (same phone, different loan rows) — one call per loan or one call per person? | 1 phone = 1 contact; later rows reported as duplicates |
| 2   | Date format in your sheets — always `DD/MM/YYYY`?                                                                 | `DD/MM/YYYY`, switchable per column                    |
| 3   | Do you have an existing do-not-call / opt-out list to upload?                                                     | DND upload ready                                       |
| 4   | What consent / relationship proof should be recorded per borrower (source text)?                                  | Free-text `consent.source` + date                      |
| 5   | How long should deleted contacts and uploaded sheets be kept?                                                     | 30 days (Phase 11 makes it configurable)               |
| 6   | Typical sheet size per day (rows)?                                                                                | Up to 50,000 rows per file                             |

---

## Changelog

- 2026-10-09: Plan created after Phase 2 sign-off.
- 2026-10-09: Run prompt [PHASE_3_PROMPT.md](../prompts/PHASE_3_PROMPT.md) added (one file, 3 batches). Precisions there: storage passed to API routers / workers by dependency injection; module layout; filter schema shape; import / export job API; Redis locks; maintenance job names + crons; `read-excel-file` CJS check (fallback `exceljs`).
- 2026-10-09: Batch 1 (T3.1–T3.6) done. Precisions / deviations: `ContactJobs` interface (API enqueues through it, tests record jobs) + `CONTACT_JOB_HANDLERS` registry in the worker; storage + jobs passed to routers via `createApiRouter({ contacts })`; `WS_EVENT_TYPES` runtime list + docs-sync test (new); `ErrorDetail.existingId` on duplicates; `accepted()` (202) envelope helper; deleting a field / list answers **202** and cleans up in a job; currency **filter** values are rupees (stored micros); a saved segment with a deleted field reports `invalidConditions` and matches nothing; `DELETE /dnd-entries/:id` keeps a contact's opt-out (only `DELETE /contacts/:id/opt-out` clears it); `POST /dnd-entries` for an already-listed number answers 200 with the existing entry. Bugs found and fixed: Devanagari vowel signs rejected in tags (`\p{M}` added); search by a national number with a leading `0` (`098761…`) found nothing (leading zeros stripped).
- 2026-10-09: Batch 2 (T3.7–T3.12) done. Precisions / deviations: test fixtures are generated in code (`tests/helpers/import-files.ts`: CSV / XLSX builders, crafted zip bomb) instead of committed binaries — only the documented sample sheets are committed (`docs/samples`, byte-exact via `.gitattributes`); `write-excel-file` added as a dev dependency (XLSX in tests / samples); `read-excel-file` worked from CommonJS, `exceljs` not needed; external ids that belong to another contact or repeat in the file are reported (`external_id_taken`, `duplicate_external_id:<row>`) instead of failing the batch; bulk `add_tags` / `add_to_list` skip contacts that would pass 20 tags / 50 lists (never truncate) and counts are real changes; exports with more than 100,000 rows are refused at creation (409) as well as in the job; default list names avoid collisions (`… (2)`) and use the account timezone; `{ new: true }` replaced by `returnDocument: 'after'` (Mongoose 9 deprecation). Benchmark (50,000 rows): validate 0.6 s, import 4.6 s, list queries p95 ≤ 93 ms. Bugs found and fixed: Mongoose `minimize` dropped an empty export selection; Mongoose 9 rejects update pipelines without `updatePipeline: true`; timestamps made every matched contact count as modified; after a mid-import crash the last written batch was counted as "updated" (now "created"); a flaky Phase 2 test (API-key `lastUsedAt` race).
- 2026-10-09: Batch 3 (T3.13–T3.18) done — **Phase 3 complete**, see [PHASE_3_SIGNOFF.md](PHASE_3_SIGNOFF.md). Precisions / deviations: the advanced filter on the Contacts tab is kept in the URL (`?f=<json>`) and can be saved as a segment; the xlsx sample got a second 2-row sheet ("Old loans") so the E2E suite can switch sheets; the "Done when" E2E expects **87 created** (85 new + the 2 DND numbers, imported and flagged) — the "85 created" in T3.18 above predates the sample README; the Contacts empty state has no own import button (the page header always shows "Import contacts"); E2E frontend port configurable (`E2E_FRONTEND_PORT`). Bugs found and fixed: the segment preview re-rendered every 400 ms forever (debounced object identity); new fields from an import were missing on contact pages until a reload (field / list / DND caches now refreshed when the import starts and ends, also when polling); an import reviving a deleted contact wiped its opt-out and call history; `/auth/refresh` shared the 30 / 15 min auth limit (signed people out after 30 page loads per IP) → 600; the global limit of 300 requests / min per IP locked out an office NAT (the E2E suite hit exactly 300) → 1,200; export jobs lacked a cross-account isolation test.
