# Phase 16 — Sign-off

**Date:** 2026-11-02 · **Branch:** `feature/phase-16-security-qa` (both repos, not merged) · **Plan:** [PHASE_16_PLAN.md](PHASE_16_PLAN.md)

**Verdict:** Phase 16 (security, compliance, QA) is built and tested on the fake providers, with **open items** (§8). Two targets were not met: API messages latency at 50 sends / s on one account, and five green backend runs in a row (3 of 5). Neither loses data or money.

Merging to `main`, the client's deploy, secret rotation, the DNS fix and legal review of the policy drafts are the owner's call.

## 1. Tasks

| Task   | What was built                                                                                                                      |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| T16.1  | Threat model, data map of every model and store (a test keeps it complete), secret rotation runbook                                 |
| T16.2  | `npm audit` 0 in both repos, one HSTS (`HSTS_BY_PROXY`), production OpenAPI shows the public API only, nginx block, `check:headers` |
| T16.3  | Secret box v2 with a key id, v1 still reads, sealed-field registry, resumable `keys:reseal` (ADR 0047)                              |
| T16.4  | Sensitive custom fields sealed at rest, one read path, masked in lists and for API keys                                             |
| T16.5  | Contact erasure and bulk erase, suppressions by keyed hash, leak scan over two accounts (ADR 0048)                                  |
| T16.6  | Account export (streamed zip), delete with 7 days to cancel, resumable purge, superadmin deletions card                             |
| T16.7  | Compliance matrix across call and send paths, opt-out words, opt-in record, calling-hours ceiling, Compliance page                  |
| T16.8  | Load checks: inbox, API messages and calls, WebSocket, voice, soak (`docs/ops/capacity.md`)                                         |
| T16.9  | Rate limit inventory, per-account API key limits, superadmin TOTP, audit kept 2 years                                               |
| T16.10 | Three flakes fixed, security route tests, local pen-test probes, Playwright `security-*` specs                                      |
| T16.11 | Pen-test checklist, gap audit, docs, release notes, this sign-off                                                                   |

## 2. Done-when (plan §0)

| Item                                                           | Status                                  |
| -------------------------------------------------------------- | --------------------------------------- |
| `npm audit --omit=dev` 0 high / critical, both repos           | Done: 0 vulnerabilities on 2 Nov        |
| Sensitive field and sealed secrets unreadable; rotation proven | Done: registry test and re-seal tests   |
| Erasure leaves nothing but the legal minimum; export complete  | Done: leak scan with two accounts       |
| Compliance matrix on every call and send path                  | Done: `tests/compliance/matrix.test.ts` |
| Load numbers with target and pass / fail                       | Done; 2 targets missed (§3)             |
| Pen-test checklist complete                                    | Done; open rows listed (§8)             |
| Full verify + Playwright twice green                           | See §3                                  |

## 3. Numbers

|                                                     | Before Phase 16              | After                                 |
| --------------------------------------------------- | ---------------------------- | ------------------------------------- |
| Backend tests                                       | 3,555                        | 3,755 (+1 skipped: PHP not installed) |
| Backend coverage (stmts / branches / funcs / lines) | 96.08 / 87.42 / 95.72 / 97.6 | 96.09 / 87.42 / 95.67 / 97.6          |
| Frontend tests                                      | 1,442                        | 1,467                                 |
| Frontend coverage                                   | 96.3 / 92.28 / 94 / 97.02    | 96.13 / 92.31 / 93.67 / 96.82         |
| Playwright                                          | 163                          | 169                                   |
| Bundle (gzip)                                       | main 315.22 KB               | main 320.42 KB                        |

**Backend full runs (T16.10):** 1 green, 2 failed (`calls/outbound`, `db/seed-calls`), 3 green, 4 green, 5 failed (`calls/ai-call`). Each failing test passed alone 3 / 3.

**Playwright:**

- After T16.10: run 1 stopped at 16 passed, because the E2E backend process ended; the cause was not found and it did not happen again in a repeat of those specs (6 / 6). Run 2 (logs on): 169 / 169 in 29.0 min.
- Before that, 5 campaign specs failed: the T16.7 calling-hours ceiling (08:00–19:00) refused the specs' all-day window. The E2E database now widens the ceiling; production keeps it.
- Final run (P16-B3-DONE, logs on): 169 / 169 in 30.2 min; log grep over 19,594 lines clean. Backend final run: 3,755 passed, 1 skipped.

**Log grep** (run 2, 19,546 lines): 0 API keys, `whsec_`, signatures, phones, bearer tokens, passwords, `otpauth`, sealed values or sensitive test values.

**Load** (local Mac, not production; `docs/ops/capacity.md`): inbox 60,000 / 60,000 in 112 s, p95 48 ms (pass). API calls: clean 429 over the limit, p95 17 ms (pass). WebSocket 300,000 / 300,000, p95 2 ms (pass). API messages: no 500, exact money, p95 seconds (missed). Voice: 20 calls comfortable, higher not measured. Soak: memory flat, all accepted messages stored, one MongoDB stall of about a minute.

## 4. Security / privacy checklist

- Every new route is scoped to its account (404 otherwise) and refuses API keys: `tests/security/phase16-routes.test.ts`.
- Only the owner can export or delete the account; erase is owner and admin: snapshot test.
- NoSQL operators, mass assignment, SSRF and header injection probes: `tests/security/phase16-probes.test.ts`.
- New jobs log ids and counts only.

## 5. Deviations from the plan / prompt

- `fflate` instead of `archiver`, which added 6 moderate advisories.
- Dependabot already covered both repos.
- CSP stays report-only until checked with the real Meta popup and Razorpay.
- Load checks use Redis database 9 instead of a unique BullMQ prefix.
- `whatsapp` worker concurrency raised from 10 to 30.
- Voice benchmark stops at the 20-call product limit; the limit was not removed to measure further.
- The import bench cap is 50,000 rows, not 100,000.

## 6. Bugs found and fixed

| Commit               | Bug                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| `09ff40d`            | Team audit rows stored raw e-mails                                                                      |
| `fd1d8cc`            | Inbound messages and statuses scanned the account's messages: partial indexes need `$type` in the query |
| `3d915b1`            | Sends answered 500 at 50 / s: transactions on one wallet conflicted until the driver gave up            |
| `fbbaec1` (frontend) | A contact page showed the mask for a sensitive value right after saving                                 |
| `fb1da07` (frontend) | Tests not updated for the T16.7 Compliance tab and calling-hours ceiling                                |

The first three are in code on the client's `main` (`023cb92`). They reach production only when this branch is merged and deployed.

## 7. Known flakes

- `tests/calls/outbound.test.ts` (wrong number), `tests/db/seed-calls.test.ts`, `tests/calls/ai-call.test.ts` (typed values): virtual-clock tests that failed once under full-suite load and pass alone 3 / 3.
- Fixed at the cause: `realtime/ws` idle close, `campaigns/dispatcher` widened window, `calls/flow-call` max duration.

## 8. Open items

| Item                                                                 | Owner              |
| -------------------------------------------------------------------- | ------------------ |
| U1: `wa.notifynow.in` second address `45.114.245.71`                 | Owner / client DNS |
| U2: rotate secrets shared outside a password manager                 | Owner              |
| U3: repository `Cell24x7/cell-ai-voicebot` is public                 | Owner              |
| Merge to `main`, client deploy (migration `0018`, new env)           | Owner, then client |
| Legal review of the policy drafts                                    | Owner              |
| CSP from report-only to enforced                                     | Client deploy      |
| API messages latency at 50 / s on one account                        | Phase 17           |
| MongoDB stall in long local runs; re-check on the real server        | Phase 17           |
| Voice maximum above 20 calls per process                             | Phase 17           |
| E2E backend process ended once in Playwright, cause not found        | Phase 17           |
| Three virtual-clock flakes (§7)                                      | Next phase         |
| No outside pen-test                                                  | Owner              |
| Calling-hours ceiling 08:00–19:00 refuses wider windows after deploy | Owner to confirm   |
