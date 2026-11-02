# Phase 16 — Security, Compliance & QA (Detailed Plan)

**Status:** Locked — 2026-11-01 (owner defaults §7 #1–#11 in force) · **Branch:** `feature/phase-16-security-qa` (both repos, from `main` = backend `1df8f82`, frontend `707127c`) · **Overview:** [BUILD_PLAN_V2.md](../plans/BUILD_PLAN_V2.md) §4 Phase 16 · **Previous:** [PHASE_15_PLAN.md](PHASE_15_PLAN.md) · [sign-off](PHASE_15_SIGNOFF.md)

> **Live context:** the app runs at `https://wa.notifynow.in` on the client's server and database, and Meta App Review is in progress. Phase 16 is code-only in our repos; the client deploys. We never connect to the client's production server or database from this work. Live checks in this plan are public HTTP requests only.

---

## 0. Is phase ka goal

Phase 16 ke end tak:

- Customer ka sensitive data (loan details, Meta tokens) encrypted ho, aur keys bina downtime rotate ho sakein.
- Har customer ka data **export** aur **delete** ho sake, aur delete sach mein delete kare.
- Calling hours, DND, disclosure, opt-out aur WhatsApp opt-in ke rules ka **evidence** ho, sirf code nahi.
- Security review poora ho: OWASP checklist, dependency fixes, headers, rate limits, audit review.
- Load tests se pata ho ki system kahan tak chalta hai, aur known flaky tests theek hon.

**Done when:**

- `0` high / critical in `npm audit --omit=dev` (both repos), and the CI audit job is green.
- A sensitive contact field and every sealed secret are unreadable in a raw DB dump, and `ENCRYPTION_KEY` rotation is proven by a test (old data still opens, re-seal moves it to the new key).
- Contact erasure leaves no phone, name, text, transcript or recording of that person, except the minimum legal record (§1d). Account export gives a complete, permission-checked archive.
- A compliance test matrix passes for calling hours, DND, opt-out, disclosure and opt-in, across every call and send path.
- Load numbers are recorded for the 5 scenarios in T16.8, each with a target and a pass / fail.
- The pen-test checklist is complete, with every finding fixed or listed as an open item with an owner.
- Full verify on both repos + Playwright twice green.

### Phase 16 mein kya NAHI hoga

| Kaam                                                         | Kaunse phase mein                    |
| ------------------------------------------------------------ | ------------------------------------ |
| Server setup, backups, monitoring, automated deploys         | Phase 17                             |
| SIP / real phone load tests                                  | Phase 18                             |
| External paid pen test, formal certification, legal sign-off | Owner decision (§7 #6), outside code |
| 2FA for customer users                                       | Default: superadmins only (§7 #5)    |

---

## 1. Findings and locked decisions

### 1a. Urgent findings from the survey (act before the phase starts)

These were found while writing this plan (public requests on 2026-11-01). They don't wait for Phase 16 code.

| #   | Finding                                                                                                                                                                                 | Why it matters                                                                                                   | Who / what                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| U1  | **`wa.notifynow.in` has two A records:** `154.210.160.233` (answers 200) and `45.114.245.71` (HTTPS fails; this is the old SMS box)                                                     | Some visitors and requests randomly fail. This can hit the Meta reviewer and Meta webhooks **during App Review** | Owner / client: remove the `45.114.245.71` A record now                                             |
| U2  | **Secrets were shared outside a password manager:** App Secret, env files and the review account password went through chat                                                             | Against [secrets.md](../conventions/secrets.md). The owner planned to rotate them after testing                  | Owner + client: rotate on a fixed date (T16.1). The review login changes only after App Review ends |
| U3  | **The code repo `Cell24x7/cell-ai-voicebot` is public**                                                                                                                                 | Anyone can read our source and deploy templates                                                                  | Client: make it private. Our main repos: check visibility too                                       |
| U4  | **Live site headers are thin:** the page sends HSTS only (no CSP, `X-Frame-Options`, `nosniff`, `Referrer-Policy`); `/api` sends HSTS **twice**. The client's nginx is not our template | Clickjacking and weaker browser protection                                                                       | T16.2 gives the client an nginx block; Phase 17 owns applying it                                    |

### 1b. What exists today (reuse, don't rebuild)

| Already built                                                                                                                     | Where                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Password hashing (argon2), login lockout, same-timing unknown user, httpOnly + `SameSite=Strict` refresh cookie, auth rate limits | `modules/auth/*`, `config/limits.ts`                                                                                |
| Secret box (AES-256-GCM) for function headers, flow API headers, webhook secrets, Meta tokens, PIN                                | `shared/crypto/secret-box.ts`                                                                                       |
| Tenant scope test, money-writes test, route isolation + permission / scope matrices                                               | `tests/security/*`                                                                                                  |
| Immutable audit log, SSRF guard, prompt-injection guards, log masking rules                                                       | `audit-log.model.ts`, `shared/net/url-guard.ts`, `core/ai/guardrails.ts`, [security.md](../conventions/security.md) |
| Calling window (default 09:00–19:00, Mon–Sat), DND, opt-out / opt-in keywords, AI disclosure                                      | account settings, `modules/dnd`, `modules/inbox/keywords.ts`, `core/ai/compile.ts`                                  |
| Per-account retention + purges, record exports, Meta deauthorize + data-deletion callbacks                                        | `modules/retention`, `modules/record-exports`, `meta-callbacks.service.ts`                                          |
| CI: lint, format, types, coverage, build, OpenAPI, secrets scan, audit, commitlint                                                | `.github/workflows/ci.yml`                                                                                          |
| Benches: wallet, contacts, campaign, voice, flow, retrieval, reports, webhooks                                                    | `scripts/bench-*`, `scripts/perf-*`                                                                                 |

### 1c. Gaps found

| Gap                                                                                                                                                                                                  | Evidence                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `npm audit` highs: backend `body-parser`, `multer`, `zod`; frontend `follow-redirects`, `zod` (fixes available). Moderates: backend `ip-address`, `nodemailer`, `qs`; frontend `fast-uri`, `seroval` | `npm audit --omit=dev`, 2026-11-01 |
| Contact variables (loan data), names and phones are plain in the database                                                                                                                            | `contact.model.ts`                 |
| The secret box has one key, with no key id, so `ENCRYPTION_KEY` can't rotate without breaking every sealed value                                                                                     | `secret-box.ts` (`v1` format only) |
| `DELETE /contacts/:id` is soft: the phone, chats, calls and transcripts stay                                                                                                                         | `deleteContact`                    |
| No whole-account export, no account delete, no contact erasure                                                                                                                                       | code search                        |
| Meta data deletion clears tokens only (correct for that callback; the policy text must say so)                                                                                                       | `handleDataDeletion`               |
| Full `/api/v1/openapi.json` is public on production and lists dashboard and admin routes                                                                                                             | live 200                           |
| Global limit 1,200 / min per IP, auth 30 / 15 min; no written inventory of limits per route                                                                                                          | `config/limits.ts`                 |
| Carried over: 50 rps API perf, per-account key limits, PHP sample not executed, sign-up timing out under load (cause unknown), virtual-clock test flakes                                             | Phase 12, 14, 15 sign-offs         |

### 1d. Decisions (defaults, owner can change in §7)

- **Encryption approach (§7 #1):** layered, not everything.
  - **Phone and e-mail stay searchable in plain form.** `phoneE164` is used in 55 source files, with unique indexes, dialing, inbox and imports. Encrypting it would touch all of them for little gain over encryption at rest. It is protected by database encryption at rest (Atlas / disk), masking, permissions and export rules.
  - **Application-level encryption for what is sensitive and never searched:** custom fields marked `sensitive` (loan amount, loan id and similar), which are opened only when used. Existing Meta tokens and secrets stay sealed.
- **Key rotation:** the sealed format gets a key id (`v2:<keyId>:…`). `ENCRYPTION_KEY` stays current, `ENCRYPTION_KEYS_OLD` is optional and read-only, and old `v1` values keep opening. `npm run keys:reseal` moves data in batches and can resume. No downtime.
- **Erasure (§7 #2):** hard-delete or scrub the person's contact, chats, media, transcripts, recordings and insight text. Keep money rows and audit rows with no personal data. The phone is kept only as a one-way HMAC (own key, never rotated) in a suppression record, so a re-import can't bring back an opted-out number. A 7-day grace period applies to whole-account delete, none to a contact.
- **Who can do it:** contact erasure needs `contacts.erase` (owner / admin). Account export and delete are owner-only with password re-entry and are blocked while impersonating. Superadmin can run account delete, audited on both sides.
- **Docs exposure:** on production, `/api/v1/openapi.json` returns the public spec only. The full spec is served only with `API_DOCS_ENABLED`.
- **Superadmin 2FA:** TOTP for platform admins only (the highest-risk accounts, impersonation).
- **Tests:** no external network, `--maxWorkers=2`, never raise test timeouts to hide a flake. A real bug gets its own `fix(...)` commit with a regression test. Load tests use a throw-away DB `cav_perf`, never a shared one.
- **Git:** one commit per task per repo with a `[P16-T16.x]` tag. No push or merge without the owner's say-so. A production fix goes to `main` first.
- **Other projects:** only `cav-*` containers; E2E on port 3150; no connection to the client's production server or database.

---

## 2. Tasks ka overview

| #      | Task                                                                                  | Repo | Size | Depends on |
| ------ | ------------------------------------------------------------------------------------- | ---- | ---- | ---------- |
| T16.1  | Threat model + secrets runbook + rotation day checklist                               | docs | S    | —          |
| T16.2  | Dependencies, security headers, docs exposure, cookies / CORS review                  | both | S    | —          |
| T16.3  | Key rotation: secret box v2, `keys:reseal`                                            | BE   | M    | —          |
| T16.4  | Sensitive custom fields encrypted                                                     | both | L    | T16.3      |
| T16.5  | Contact erasure + suppression                                                         | both | L    | T16.4      |
| T16.6  | Account export + account delete                                                       | both | L    | T16.5      |
| T16.7  | Compliance matrix + fixes + evidence page                                             | both | M    | —          |
| T16.8  | Load tests (5 scenarios incl. the Phase 15 carry-over)                                | BE   | M    | T16.2      |
| T16.9  | Hardening: rate limit inventory, per-account key limits, superadmin 2FA, audit review | both | M    | T16.2      |
| T16.10 | Flake fixes + E2E and security tests                                                  | both | M    | all above  |
| T16.11 | OWASP pen-test checklist, gap audit, docs, sign-off                                   | both | M    | all above  |

Size: S ≈ 1 day, M ≈ 2–3 days, L ≈ 3–5 days for one developer. Expect about **3 weeks** (more than the "M" in BUILD_PLAN_V2, because erasure and export touch every module).

---

## 3. Tasks — step by step

### T16.1 — Threat model + secrets runbook (docs)

1. `docs/security/THREAT_MODEL.md`: assets (phones, loan data, recordings, chats, wallet money, Meta tokens), actors (outsider, another customer, a staff user, a leaked API key, a malicious webhook target or sheet, a customer's words to the AI), entry points, and which control or test covers each. An uncovered row becomes a task or an open item.
2. Data map `docs/security/DATA_MAP.md`: every collection and file store holding personal data, its retention and its erase action. **T16.5 and T16.6 are checked against this file**, and a test fails if a model with a personal field isn't listed.
3. `docs/ops/secret-rotation.md`: every secret (`JWT_*`, `ENCRYPTION_KEY`, Mongo URI, Redis, OpenAI, Meta App Secret, System User token, Razorpay, SMTP, review account), who rotates it, the order, the effect on sessions, and how to verify. A date for the first rotation, after App Review.

### T16.2 — Dependencies, headers, exposure (both)

1. Upgrade to fix all highs and moderates (`multer`, `zod`, `body-parser` chain, `nodemailer`, `follow-redirects`, others). Check the `zod` upgrade against `zod-to-openapi` and regenerate the spec; re-run the upload and mail tests.
2. `npm audit --audit-level=high` must pass in CI on both repos. Add a Dependabot or equivalent weekly check.
3. Production `/api/v1/openapi.json` → public spec only. Update tests and the `gen:api` flow (local file, unaffected).
4. Security headers: test Helmet on the API. Fix the double HSTS by choosing one owner (nginx) in production. Update `deploy/staging/nginx` and add `docs/ops/nginx-security-headers.md`, a block the client can paste. Move CSP from report-only to enforced after checking Meta SDK, Razorpay, WebSocket and audio.
5. `npm run smoke` gets header checks, and a read-only `scripts/check-live-headers.ts` checks any URL over public HTTP.
6. Review CORS, `origin-check`, refresh cookie flags, upload limits and MIME checks, and body size limits; write the result in the checklist.

### T16.3 — Key rotation (backend)

1. `shared/crypto/secret-box.ts`: format `v2:<keyId>:<iv>:<tag>:<data>`; `keyId` = short hash of the derived key; `open` tries the matching key and still reads `v1`. Env: `ENCRYPTION_KEYS_OLD` (optional, comma list, base64 checks in `env.ts`).
2. `src/ops/keys-reseal.ts` (`npm run keys:reseal`, `--dry-run`, resumable, batched, counts only, never values) over every sealed field listed in one registry: function headers, flow API headers, webhook secrets, channel tokens, PINs, and sensitive fields from T16.4. The storage-signing key has its own short-lived links; document the effect.
3. Tests: old value opens after rotation; re-seal moves all values; a wrong key gives a clear error and no partial write; restart in the middle is safe; a test fails if a `*Sealed` field isn't in the registry.
4. Runbook section; ADR 0047 "Encryption at rest and key rotation".

### T16.4 — Sensitive custom fields (both)

1. `customFields.sensitive: boolean` (off by default). Values are sealed in `contacts.variables`, with a `{ $enc: 'v2:…' }` shape so old rows stay readable.
2. Every reader goes through one helper, including flows and agents (`contactVariables`), templates (`{{field}}`), imports, exports, segments, reports, API responses and webhooks. Find them all first and list them in the plan changelog.
3. Rules: a sensitive field can't be used in search or segment filters (422 with a clear message; the UI hides it). It's masked in lists, and shown on the contact page and in exports only with `contacts.export`. It's never in logs, audit, or AI prompts unless a flow or agent uses it on purpose.
4. Migration `0018-sensitive-fields`: marking a field sensitive starts a background job (progress, resumable); no change for existing fields until an owner marks them.
5. Frontend: "Sensitive" toggle with a warning in Settings → Contact fields; masked values; tests.
6. Performance: bench 100,000 contacts for list, import and campaign start; record before and after.

### T16.5 — Contact erasure + suppression (both)

1. `POST /contacts/:id/erase` and bulk (≤ 1,000, background job, progress), with `contacts.erase`, a typed confirmation in the UI, and audit without personal data.
2. Action per DATA_MAP row: contact removed; conversations and messages scrubbed or removed, media files deleted; call rows keep id, duration, cost and status but lose number, name, variables, transcript, recording, insights and summary; campaign contacts, post-call messages, webhook events and deliveries, import rows, exports and search text are cleaned.
3. Money stays: ledger rows and invoices are kept, with no personal text.
4. Suppression: `{ accountId, phoneHmac, reason, at }`, checked on import, API upsert, inbound message handling and sends, so an erased, opted-out number doesn't come back by accident. A customer who writes first is a new lawful contact unless they had opted out (§7 #3).
5. Refused while a call to that contact is live, or a campaign is mid-dial (409 with the reason, or skip and retry); restart safe and idempotent.
6. Meta side is documented: chats held on the customer's phone or by Meta aren't ours to delete.
7. Tests: a "leak scan" seeds a person across every collection and files, erases them, then searches the **whole test DB and storage** for the phone, name and a marker text → 0 hits apart from the HMAC. It runs for each model in DATA_MAP.

### T16.6 — Account export + delete (both)

1. `POST /account/export` (owner, password re-entry, one at a time): a zip with contacts, calls + transcripts, messages, flows, agents, templates, ledger and audit (JSON / CSV), and recordings optional. Signed link for 24 h, deleted after 7 days; e-mail when ready; streamed so memory stays flat.
2. `POST /account/delete` (owner + password + typed account name): stops campaigns, API keys and webhooks, disconnects WhatsApp numbers, 7-day grace with cancel, e-mail to owner; then a resumable purge job using the same erase code as T16.5. Blocked with a clear message while the wallet has a hold; the refund of a remaining balance is a manual step for support (§7 #4). Invoices and ledger are kept as the law requires.
3. Superadmin: see pending deletes, cancel, run; audited on both sides.
4. Tests: complete export (each collection present, none from another account), export size bench, grace + cancel, purge leak scan, another account's data untouched, restart mid-purge.

### T16.7 — Compliance matrix (both)

1. Test matrix (`tests/compliance/*`) of **path × rule**. Paths: web test, dry run, campaign, API `POST /calls`, WhatsApp agent call, WhatsApp AI call, inbox send, API send, after-call send, flow step. Rules: calling window (account timezone, boundary minutes, days), DND, opt-out, AI disclosure at call start, recording notice, marketing frequency, the 24-hour window, opt-in record on template sends. Every gap becomes a `fix(...)` commit.
2. Opt-out keywords in Hindi, Hinglish and English (`STOP`, `band karo`, …); both directions; the voice "don't call me" path sets DND.
3. Opt-in record: source and time on the contact; shown in the UI; required for marketing templates (§7 #7: warn or block).
4. Calling window defaults and per-customer limits: confirm the legal hours with the client (§7 #8), then lock a superadmin ceiling so an account can't widen beyond it.
5. Settings → Compliance (read-only page): the account's window, disclosure text, opt-out words and counts, plus an export for a regulator or auditor (CSV: DND changes and opt-outs with dates, phones masked unless permitted).
6. Privacy Policy and Terms: update for erasure, export and Meta deletion. Still `draft` until legal approves.

### T16.8 — Load tests (backend)

Each scenario gets a `perf:*` script in `cav_perf`, with a target and a recorded result. **Targets are proposals until the first run; a missed target means a finding with a fix or a decision, not a changed number.**

| Scenario                                                | Load                                           | Target                                                         |
| ------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------- |
| Meta webhook burst into inbox                           | 500 events / s for 2 min (statuses + messages) | 0 lost, no duplicates, queue drained ≤ 2 min, API p95 < 300 ms |
| WhatsApp template sends via API (carried from Phase 15) | 50 rps for 60 s across 50 keys, fake Meta      | p95 < 500 ms, 0 double charges, wallet balances exactly        |
| `POST /calls` (carried from Phase 15)                   | 50 rps for 60 s, dry-run line                  | p95 < 500 ms; over capacity answers a clear 429, never a 500   |
| WebSocket                                               | 1,000 connections, 100 events / s              | delivery p95 < 500 ms, no leak after disconnect                |
| Voice sessions                                          | `bench:voice` up to failure                    | record max per process, CPU and memory for Phase 17 sizing     |

Also a soak: mixed load for 1 hour; memory and queue depth flat. Find the sign-up timing-out cause from Phase 14 and 15 here (argon2 thread pool and e-mail enqueue under load are the first suspects; verify, don't assume).

### T16.9 — Hardening (both)

1. `docs/security/RATE_LIMITS.md`, an inventory of every public or expensive route, generated from a test that fails when a new unauthenticated route has no limiter. Fix the gaps (signup, invites, OTP resend, public unsubscribe, deletion status).
2. Per-account API key limits (Phase 15 §7 #2): superadmin sets them in the account's admin page, audited; keys pick them up within 30 s.
3. Superadmin 2FA: TOTP + recovery codes, required for platform admins before impersonation and account delete; a setup flow; a runbook for a lost device.
4. Session review: revoke all on password change (test), impersonation limits, invite token expiry; "Add account" (POST `/admin/accounts`) gets its own rate limit.
5. Audit review: every sensitive action has a row (matrix test), no personal data in `meta`, and a 2-year retention decision.
6. Upload review: file type by content, size limits, zip bombs, CSV formula injection in exports, HTML in message text and webhook snippets.

### T16.10 — Flakes + tests (both)

1. Fix the known flakes **at the cause**, without raising timeouts: `flow-call` max duration (the fake clock keeps running while the call settles), `dispatcher` under load, `inbox-roles`, heavy hardening tests. Target: 5 full backend runs green in a row.
2. PHP signature sample runs in tests when `php` exists.
3. Playwright `e2e/security-*.spec.ts`: sensitive field masked by role, contact erasure, account export and delete with cancel, compliance page, superadmin 2FA.
4. `tests/security/phase16-*.test.ts`: all new routes isolated (404), permission matrix snapshot, erasure leak scan, no personal data in logs.
5. Log grep extended: sensitive field values and erased markers.

### T16.11 — Pen-test checklist + sign-off (both)

1. `docs/security/PENTEST_CHECKLIST.md` against the OWASP API Top 10 and ASVS-based items: each row has a test or manual step, a result and evidence. Manual probes run on **local or staging only**, never on the client's production.
2. Gap audit: §0 Done-when + §4. Every gap is fixed or an open item with an owner.
3. Docs: ADR 0047, ADR 0048 "Erasure and suppression", conventions (`security.md`, `data.md`, `data-model.md`, `error-codes.md`, `audit.md`), READMEs, CHANGELOGs, `docs/ops/release-phase-16.md` (migration, new env, what the client must do), BUILD_PLAN_V2 changelog.
4. `PHASE_16_SIGNOFF.md`: scope, numbers, load results, findings, deviations, flakes, open items.

---

## 4. Deliverables checklist

- [x] Threat model, data map, secret rotation runbook
- [x] `npm audit` clean, security headers, production docs exposure closed
- [x] Key rotation + `keys:reseal`
- [x] Sensitive custom fields encrypted, with bench numbers
- [x] Contact erasure + suppression + leak scan
- [x] Account export + delete with grace
- [x] Compliance matrix, opt-in record, Compliance page, policy updates (draft)
- [x] 5 load scenarios + soak recorded
- [x] Rate limit inventory, per-account key limits, superadmin 2FA, audit + upload review
- [x] Flakes fixed, Playwright + security tests
- [x] Pen-test checklist, ADRs, docs, release notes, sign-off

---

## 5. Risks

| Risk                                                        | Mitigation                                                                                            |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Erasure removes too much (money or another customer's data) | Works from DATA_MAP, account scoped, leak scan + "other account untouched" tests, dry-run count first |
| A missed reader shows sealed text or breaks a call          | One helper, a test that fails on direct variable reads, E2E on flows and templates, off by default    |
| Lost `ENCRYPTION_KEY` makes sealed data unreadable          | Key backup in the runbook, `--dry-run`, old keys kept until re-seal reports 0                         |
| `zod` / `multer` upgrades change behavior                   | Separate commits, full tests, OpenAPI diff reviewed                                                   |
| Enforced CSP breaks Meta popup or Razorpay                  | Report-only first, E2E, staged rollout with a one-line rollback                                       |
| Load tests disturb other projects on the machine            | Own DB and prefix; run alone; never on the client's server                                            |
| The client's nginx differs from our template                | A paste-ready block + a public header check; Phase 17 owns it                                         |
| Legal requirements assumed by a developer                   | Rules are configurable and policy text stays draft until legal approves (§7)                          |

---

## 6. Recommended order

Before coding: U1–U3 (owner / client). Batch 1 (foundation): T16.1 → T16.2 → T16.3 → **P16-B1-DONE**. Batch 2 (data rights): T16.4 → T16.5 → T16.6 → **P16-B2-DONE**. Batch 3 (assurance): T16.7 → T16.9 → T16.8 → T16.10 → T16.11 → **P16-B3-DONE**.

---

## 7. Decisions and open questions (owner — defaults apply if not answered)

| #   | Question                                                 | Default                                                                                                                                                |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Encrypt phones and names too?                            | No: only sensitive custom fields + secrets. Phone stays plain (searchable), with DB encryption at rest. Encrypting phones adds weeks and blocks search |
| 2   | On erasure, keep call rows without personal data?        | Yes, for billing and reports                                                                                                                           |
| 3   | An erased, not opted-out person messages again           | Treated as a new contact; opted-out stays blocked for sends                                                                                            |
| 4   | Wallet balance on account delete                         | Manual refund through support; no automatic refund                                                                                                     |
| 5   | 2FA scope                                                | Superadmins now; customer owners optional later                                                                                                        |
| 6   | External paid pen test?                                  | Not in this phase; recommended before full launch (Phase 21). Client decides and pays                                                                  |
| 7   | Marketing template without an opt-in record              | Warn, don't block, so existing work continues; block later if legal says so                                                                            |
| 8   | Legal calling hours for the client's loan recovery       | Keep 09:00–19:00 Mon–Sat as default; **client's compliance team confirms** before go-live                                                              |
| 9   | Data law position (India DPDP and RBI rules for lenders) | We build the tools; the client's legal team decides what applies and approves the policy                                                               |
| 10  | Audit log retention                                      | 2 years                                                                                                                                                |
| 11  | Is the client's DB encrypted at rest?                    | Client confirms. Atlas encrypts by default; a self-managed DB needs checking in Phase 17                                                               |

---

## Changelog

- 2026-11-01: plan drafted after Phase 15 sign-off, from a code survey of `main` (`1df8f82`) and public checks of `wa.notifynow.in`. Found the second A record, thin live headers, `npm audit` highs, soft contact delete and no key rotation. 11 owner questions with defaults (§7).
- 2026-11-01: run prompt prepared — literals locked: error codes +7 → 103, audit +15 → 165, notifications +3 → 36, permissions +3, migration 0018; defaults in use for §7 #1–#11.
- 2026-11-01: Batch 1 done (T16.1–T16.3). Backend 3581 tests, coverage 96.07 / 87.4 / 95.73 / 97.59; frontend 1442 tests, 96.3 / 92.28 / 94 / 97.02. `npm audit --omit=dev` 0 in both repos. Deviation: Dependabot already covered both repos, so no new file. Deviation: the real Meta popup and Razorpay can't run in tests, so CSP stays report-only until the client checks it on the live site. Flake seen once under full-suite load, 3 / 3 alone: `tests/calls-wa/inbound.test.ts` "customer hangs up while ringing"; kept for T16.10.
- 2026-11-01: T16.4 done. Contact variable readers moved to `modules/privacy/sensitive.ts`: `ai-agents/{variables,functions.service}`, `templates/send.service`, `inbox/conversations.service`, `contacts/contacts.service`, `contact-exports/export.job`, `campaigns/audience`, `post-call/{evaluate,send.job}`. Stored copies keep the value out or sealed: `calls.variables` (`calls/{call.service,session}`), `campaignContacts.variables` (`campaigns/snapshot`), `agentPlaygroundSessions.variables`, `flowRuns.state.contact` and the Redis call state (sealed text), `postCallMessages.variables` (sealed text). Bench at 50,000 rows, the import limit per file (deviation from the prompt's 100,000, which the importer refuses): import 8.3 s → 10.4 s, +25 % with every field sealed, a worst case; list and search are no slower. Finding, kept: the cost is AES plus larger documents, and it only affects accounts that mark fields sensitive. Campaign start doesn't decrypt, so it wasn't benched separately. Known limit: what the bot says or a template sends is stored as conversation (`transcriptTurns`, `messages`, simulator transcript), so a spoken or sent value appears there; erase removes it. A flow that copies a sensitive field into a flow variable keeps it in that variable.
- 2026-11-02: Batch 2 done (T16.4–T16.6). Backend 3629 tests, coverage 96.04 / 87.36 / 95.64 / 97.57; frontend 1458 tests, 96.17 / 92.27 / 93.75 / 96.87. Playwright run 1: 163 / 163. **Run 2 not clean, open item:** the Mac lid was closed and it kept sleeping (19 sleeps in one evening; backend logs show Mongo connections timing out), so two attempts stopped at 13 and 67 passed. Retry at the next checkpoint. Log scan over the 4,831 lines of the partial run found no keys, `whsec_`, signatures, phones, Bearer tokens, passwords, sealed values or summaries. Deviation: `fflate` instead of `archiver` for the zip, because archiver adds 6 moderate advisories; `npm audit --omit=dev` stays at 0. Export memory: RSS +204–252 MB at 100,000 contacts and +231 MB at 1,000,000 under a 256 MB heap, so it is flat; a 150 MB heap is too small at 400,000 and above. Deviation: `callEvents` and notifications changed from the first data map draft (scrub and delete). Main merged into the branch: owner password in Add account. Bug found and fixed in this batch: the three new models weren't in `models/all.ts`, caught by `tests/ops/sync-indexes`. Flakes under load, passing alone 3 / 3: `calls-wa/inbound`, `campaigns/dispatcher`, `templates-page`, `campaigns-pages`, `campaign-detail`.
- 2026-11-02: T16.8 done. Results in `docs/ops/capacity.md`: inbox, API calls and WebSocket pass; API messages latency missed (p95 seconds, no 500, exact money, open for Phase 17); soak memory and queue flat, but one MongoDB stall of about a minute gave errors, cause not found; voice measured to the 20-call limit only. Two real bugs fixed: partial indexes unused on wamid lookups (`fd1d8cc`), wallet transaction conflicts answering 500 (`3d915b1`). Sign-up symptom not reproduced. Deviation: Redis database 9 instead of a unique BullMQ prefix.
- 2026-11-02: T16.10. Fixed at the cause: `ws` idle close (the close could come before the wait for `open`), dispatcher widened window (a single clock advance could come before the wake's timer), `flow-call` max duration (now asserted against the 80 s the waits would take, because the fake clock keeps ticking while the call settles). **5 runs in a row were not reached: 3 of 5 green.** Run 2: `calls/outbound` (wrong number) and `db/seed-calls`. Run 5: `calls/ai-call` (typed values). All are virtual-clock tests that failed once under full load, and each passed alone 3 / 3. They stay open with this evidence. PHP sample test added; skipped here, PHP isn't installed. Bug found by the new spec: a contact page kept the mask after saving (`fix(contacts)`).
- 2026-11-02: T16.11 done. Pen-test checklist completed against OWASP API Top 10 with local probes, gap audit against §0 and §4 (all delivered; open items with owners in the sign-off), docs, release notes `docs/ops/release-phase-16.md`, sign-off. Playwright after T16.10: run 1 stopped when the E2E backend ended (cause not found, not reproduced); run 2 169 / 169 with a clean log grep.
- 2026-11-02: **P16-B3-DONE.** Final verify: backend 3,755 passed (1 skipped), coverage 96.09 / 87.42 / 95.67 / 97.6; frontend 1,467, 96.13 / 92.31 / 93.67 / 96.82; Playwright 169 / 169 (30.2 min, logs on, grep clean); `npm audit --omit=dev` 0 in both repos; branch diffs pattern-scanned for keys and URIs (gitleaks not installed), nothing found.
