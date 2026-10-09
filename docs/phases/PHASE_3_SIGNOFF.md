# Phase 3 — Sign-off

**Date:** 2026-10-09 · **Branch:** `feature/phase-3-contacts` (both repos, not merged) · **Plan:** [PHASE_3_PLAN.md](PHASE_3_PLAN.md) · **Tracker:** [PHASE_3_TASKS.md](PHASE_3_TASKS.md)

**Verdict:** ✅ Phase 3 (Contacts, Lists & Custom Fields) complete — all 18 tasks done. **"Done when"** (100-customer sheet imported, every contact's variables shown, a report of the bad rows) is proven by Playwright `e2e/contacts-import.spec.ts` (frontend repo). **Phase 4 can start.** Merging `feature/phase-3-contacts` → `dev` (both repos) is a project-lead decision after review.

Verification: see §6 (filled at the `[P3-B3-DONE]` checkpoint).

## 1. Tasks — "Done when" check

| Task                                          | Status | Evidence (commit; fe = frontend repo)                                 | Notes                                                                                     |
| --------------------------------------------- | ------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| T3.1 Models, indexes, migration 0004          | ✅     | `6e3982a`                                                             | 7 models, `dnd.manage`, `CONTACT_LIMITS`, `contacts` queue, 3 WS events, 14 audit actions |
| T3.2 Normalisation library                    | ✅     | `d4d40c3`                                                             | phones, typed values (micros, DD/MM, Excel serials), tags, e-mail — 100 % covered         |
| T3.3 Custom fields API                        | ✅     | `a5ad6ac`                                                             | key rules, max 50, type lock while used, delete → 202 + cleanup job                       |
| T3.4 Contacts CRUD + search + filters         | ✅     | `282e0c2`, `2719a80`                                                  | filter compiler shared by search / segments / bulk / export; leading-0 search fixed       |
| T3.5 Lists + segments                         | ✅     | `d65a33e`                                                             | live counts, preview, broken-condition report                                             |
| T3.6 DND + opt-out + consent                  | ✅     | `0a15f0e`                                                             | contacts mirror, only `dnd.manage` removes                                                |
| T3.7 Upload + parsing + mapping               | ✅     | `05f5f51`, `0ffdaf3`                                                  | magic bytes, zip-bomb guard, Windows-1252, suggested mapping; sheet switch added in T3.16 |
| T3.8 Validate + error report                  | ✅     | `94dc1a6`, `e7a5aa6`                                                  | dry run, problem rows, injection-safe error CSV                                           |
| T3.9 Import run + DND upload                  | ✅     | `93e5d86`, `df4ef7a`, `606808a`                                       | batches, resume after crash, cancel, lock; revive keeps opt-out (fixed in T3.18)          |
| T3.10 Bulk actions + export                   | ✅     | `2ac158d`, `041e561`                                                  | ids / filter jobs, CSV export (BOM, injection-safe, 24 h, blocked while impersonating)    |
| T3.11 Retention purge jobs                    | ✅     | `3a802c8`                                                             | contacts / lists 30 d, import files 30 d, exports 24 h                                    |
| T3.12 Seed, samples, OpenAPI, perf, docs      | ✅     | `319d828`, `3b23e29`, `80801ca`                                       | `docs/samples`, `bench:contacts`; xlsx sample got a 2nd sheet in T3.18                    |
| T3.13 FE foundation                           | ✅     | `6c4ed67` (fe)                                                        | API clients, format / phone utils, routes, Contacts menu                                  |
| T3.14 FE contacts table + form                | ✅     | `f8b83ec` (fe)                                                        | filters in the URL, column picker, selection, bulk bar, typed form                        |
| T3.15 FE contact detail                       | ✅     | `8ebc44e` (fe)                                                        | typed variables, inline tags / lists, opt-out / DND / delete                              |
| T3.16 FE import wizard + activity             | ✅     | `5c8b386` (fe)                                                        | WS progress + polling fallback, resume by URL, DND variant                                |
| T3.17 FE lists, segments, DND, fields, export | ✅     | `1126048` (fe)                                                        | segment builder (also the advanced filter), export dialog                                 |
| T3.18 E2E, audit, docs, sign-off              | ✅     | `ad2f81d`, `b1b6806`, `041e561`, `a56b48d` + `69426bb` (fe), this doc | 5 Playwright scenarios, gap + security audit, gates raised                                |

Batch checkpoints: `7ddbca2` `[P3-B1-DONE]`, `690157e` `[P3-B2-DONE]`, `[P3-B3-DONE]` (the commit that adds §6). Run prompt: [PHASE_3_PROMPT.md](../prompts/PHASE_3_PROMPT.md).

## 2. Deliverables checklist (PHASE_3_PLAN §4)

| Deliverable                                                                                                              | Status |
| ------------------------------------------------------------------------------------------------------------------------ | ------ |
| Contact, list, custom field, segment, DND, import / export job models + indexes + migration 0004                         | ✅     |
| Normalisation library (phone, typed values, tags) with exhaustive tests                                                  | ✅     |
| Custom fields, contacts, lists, segments, DND / opt-out / consent APIs                                                   | ✅     |
| CSV + XLSX upload, mapping, validate report + error CSV, batched resumable import, DND upload                            | ✅     |
| Bulk actions, CSV export, background cleanup + retention purge jobs                                                      | ✅     |
| Seed + sample sheets + OpenAPI + performance numbers                                                                     | ✅     |
| Frontend: Contacts (table, filters, bulk, detail), import wizard, lists, segments builder, DND, fields, export, activity | ✅     |
| Playwright E2E for the "Done when" scenario                                                                              | ✅     |
| Docs (data-model, api, data, websocket, audit, error codes, ADR 0031, ADR 0018 notes), CHANGELOGs, sign-off              | ✅     |

## 3. Requirement → test mapping (gap audit)

| Requirement                                                                                                            | Test file(s)                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Models, unique / partial indexes, revive, migration 0004                                                               | `tests/db/contact-models.test.ts`, `tests/db/phase3-migrations.test.ts`                                                                                            |
| Phone / value / tag / e-mail normalisation (Excel lost digits, ₹, DD/MM, serials, Hindi)                               | `src/modules/contacts/normalize/{phone,values,misc}.test.ts`                                                                                                       |
| Filter compiler: operators per type, relative dates in the account timezone                                            | `src/modules/contacts/filter/compile.test.ts`, `tests/contacts/contacts-list.test.ts`                                                                              |
| Custom fields: key rules, limits, type lock, delete cleanup                                                            | `tests/custom-fields/custom-fields.test.ts`                                                                                                                        |
| Contacts CRUD, search (any phone format), filters, sort, duplicates (`existingId`)                                     | `tests/contacts/contacts-crud.test.ts`, `tests/contacts/contacts-list.test.ts`                                                                                     |
| Lists + segments (counts, preview, broken conditions)                                                                  | `tests/contacts/lists-segments.test.ts`                                                                                                                            |
| DND mirror, opt-out (only `dnd.manage` undoes), consent, opt-out survives re-import / revive                           | `tests/contacts/dnd.test.ts`, `tests/contact-imports/run.test.ts`, fe e2e `contacts-dnd-roles.spec.ts`                                                             |
| Upload checks (type, magic bytes, size, `.xls`, zip bomb, encoding, delimiter, sheets)                                 | `tests/contact-imports/parsers.test.ts`, `tests/contact-imports/imports-api.test.ts`                                                                               |
| Mapping (suggested, rules, new fields, sheet switch)                                                                   | `tests/contact-imports/mapping.test.ts`, `tests/contact-imports/imports-api.test.ts`                                                                               |
| Validate: exact sample totals, problem rows, injection-safe error CSV, no DB writes                                    | `tests/contact-imports/validate.test.ts`, `tests/contact-imports/candidate.test.ts`, fe e2e `contacts-import.spec.ts`                                              |
| Import run: batches, resume after crash, cancel, lock, suspension, DND kind                                            | `tests/contact-imports/run.test.ts`                                                                                                                                |
| Bulk actions (ids / filter), limits, export content (BOM, formulas, phones), scopes, expiry                            | `tests/contacts/bulk-export.test.ts`, fe e2e `contacts-segment-export.spec.ts`                                                                                     |
| Locks, progress throttling, retention purges                                                                           | `tests/contacts/locks-progress.test.ts`, `tests/contacts/retention.test.ts`                                                                                        |
| Tenant isolation — every Phase 3 endpoint (other account → 404, never listed)                                          | the isolation cases in each file above + `tests/security/tenant-scope.test.ts`; exports: `bulk-export.test.ts` (added in T3.18)                                    |
| Permissions: agent / viewer read-only, `contacts.import`, `contacts.export`, `dnd.manage`, impersonation blocks export | per-module tests above, fe e2e `contacts-dnd-roles.spec.ts` (agent + manager)                                                                                      |
| Rate limits (auth, refresh, global)                                                                                    | `tests/auth/rate-limit.test.ts`, `tests/http/security.test.ts`, `tests/http/rate-limit-redis.test.ts`                                                              |
| Seed + samples                                                                                                         | `tests/db/seed-contacts.test.ts`                                                                                                                                   |
| FE format / phone utils, API clients, contacts view in the URL                                                         | fe `src/utils/*.test.ts`, `src/services/api/contacts-api.test.ts`, `src/features/contacts/contacts-view.test.ts`                                                   |
| FE contacts table, form, bulk, column picker                                                                           | fe `src/features/contacts/contacts-tab.test.tsx`                                                                                                                   |
| FE contact detail                                                                                                      | fe `src/pages/contacts/contact-detail.test.tsx`                                                                                                                    |
| FE import wizard (every step, WS + polling, resume, cancel, DND) + activity                                            | fe `src/pages/contacts/import-wizard.test.tsx`, `src/pages/contacts/activity.test.tsx`                                                                             |
| FE segment builder (operators per type, live count), lists, DND, fields, export dialog, advanced filter                | fe `src/features/segments/*.test.ts(x)`, `src/features/contacts/{lists-dnd-tabs,fields-tab}.test.tsx`, `src/features/contact-exports/export-and-advanced.test.tsx` |
| "Done when" — sample sheet import with typed variables and a bad-row report                                            | fe e2e `contacts-import.spec.ts`                                                                                                                                   |

**Bugs the gap audit / E2E found and fixed in T3.18:**

1. An import that revived a soft-deleted contact reset its `optedOutAt`, `lastCalledAt` and `callCount` (the DND entry still blocked calls, but the opt-out record was lost) — `606808a`.
2. `/auth/refresh` shared the 30 / 15 min limit of the brute-forceable auth routes, but runs on every page load: an office behind one NAT was signed out after 30 reloads → own limit 600 — `ad2f81d`.
3. The global limit of 300 requests / min per IP: the E2E suite (and so a team behind one NAT) hit exactly 300 → 1,200 / min — `b1b6806`.
4. The segment preview debounced a new filter object on every render → re-rendered every 400 ms forever (fe).
5. Fields, lists and DND entries created by an import showed up on other pages only after a reload — caches are now refreshed when the import starts and ends, over WS or polling (fe).
6. Export jobs had no cross-account isolation test (GET / list / scopes of another account) — `041e561`.

## 4. Numbers

| Metric                                      | Backend                                                                                           | Frontend                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------- |
| Tests (end of Phase 2 → now)                | 540 → 936                                                                                         | 187 → 287 + 10 E2E        |
| Coverage (stmts / branches / funcs / lines) | 96.9 / 87.9 / 95.8 / 98.1                                                                         | 95.1 / 90.7 / 91.5 / 96.2 |
| Coverage gate (CI) — was                    | 95 / 80 / 90 / 95                                                                                 | 90 / 85 / 85 / 90         |
| Coverage gate (CI) — now                    | 95 / 85 / 95 / 95                                                                                 | 95 / 90 / 90 / 95         |
| Benchmark (50,000 rows, local)              | validate 0.6 s, import 4.6 s, `GET /contacts` p95 ≤ 93 ms (targets: import ≤ 120 s, p95 ≤ 300 ms) | —                         |

**Key versions added in Phase 3:** backend `libphonenumber-js` 1.13, `multer` 2.4, `csv-parse` 7.0, `csv-stringify` 6.9, `iconv-lite` 0.7, `read-excel-file` 9.3, dev `write-excel-file` 4.1; frontend `libphonenumber-js` 1.13 (`/min`).

## 5. Deviations from the plan

| Where | Deviation                                                                                                                            | Why                                                                     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| B1/B2 | See PHASE_3_PLAN changelog (`ContactJobs` injection, 202 deletes, external-id reports, never-truncate bulk caps, generated fixtures) | —                                                                       |
| T3.16 | Sheet switch = `PUT /mapping` with only `sheet` (empty `columns`)                                                                    | Re-reads columns + suggested mapping before the user maps               |
| T3.17 | Advanced filter kept in the URL (`?f=<json>`), savable as a segment                                                                  | Shareable views, Back works                                             |
| T3.18 | "Done when" expects 87 created (85 + 2 DND, imported and flagged), not 85 as written in the plan                                     | Matches `docs/samples/README.md` (DND numbers are imported and flagged) |
| T3.18 | xlsx sample has a 2nd sheet "Old loans"                                                                                              | Lets the E2E suite exercise the sheet picker; totals unchanged          |
| T3.18 | Contacts empty state has no own import button                                                                                        | "Import contacts" is always in the page header                          |
| T3.18 | Auth refresh limit 600 / 15 min, global limit 1,200 / min per IP                                                                     | Found by the E2E suite (bugs 2 and 3 above)                             |
| T3.18 | `E2E_FRONTEND_PORT` overrides 3100                                                                                                   | Another local app held 3100 during the checkpoint                       |

## 6. Verification (P3-B3-DONE)

_Filled at the checkpoint._

## 7. Remaining TODOs (by phase)

| Phase | Where                                 | What                                                                                         |
| ----- | ------------------------------------- | -------------------------------------------------------------------------------------------- |
| 4     | fe `/admin/accounts/:id` Rates tab    | Per-account rates (RateCard) — placeholder today                                             |
| 4     | backend / fe                          | In-app notifications (bell); "import finished" / "export ready" notifications                |
| 4 / 8 | backend                               | Mount the idempotency middleware on money / campaign routes                                  |
| 6 / 7 | backend                               | Template variables `{{key}}` from contact fields in scripts / flows                          |
| 7     | fe contact detail                     | Call history card (placeholder today), `lastCalledAt` / `callCount` updates                  |
| 8     | backend                               | Campaign audiences from lists / segments; DND + opt-out + calling window checks at dial time |
| 7 / 8 | backend `src/core/realtime/topics.ts` | `TODO(P7/P8)`: topic ownership check                                                         |
| 10    | backend                               | Public API routes behind `X-API-Key` (contacts upsert / bulk)                                |
| 11    | both                                  | Custom roles editor, 2FA / SSO; per-user (not per-IP) rate limits                            |
| CI    | fe `.github/workflows/e2e.yml`        | Run E2E on PRs once both repos run together; `BACKEND_REPO_TOKEN` while private              |
| 2+    | frontend build                        | Main chunk > 500 kB — route-level code splitting                                             |

## 8. Client inputs still pending

- **OpenAI API key** — Phases 5 / 7.
- **Client server SSH key** — read-only server audit (T0.19), Phase 12.
- **SIP trunk details** — Phase 13.
- **SMTP provider + sender domain (SPF / DKIM / DMARC)** — production email. Dev uses Mailpit.
- **Real sample sheet from the client** (column names, date / amount formats) — the importer handles the formats in `docs/samples`; a real sheet would confirm the suggested mapping.

## 9. Go / no-go for Phase 4

✅ **Go.** Wallet & billing build on the tenant-scoped modules, the audit service, BullMQ jobs with Redis locks and progress events, `formatCurrencyMicros` (micros already used for currency fields), and the shared `DataTable` / dialogs / URL-state patterns from the contacts UI.
