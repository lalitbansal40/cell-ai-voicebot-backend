# Phase 15 — Sign-off

**Date:** 2026-11-01 · **Branch:** `feature/phase-15-integrations` (both repos, not merged) · **Plan:** [PHASE_15_PLAN.md](PHASE_15_PLAN.md) · **Tracker:** [PHASE_15_TASKS.md](PHASE_15_TASKS.md)

**Verdict:** ✅ Phase 15 (integrations, public API, webhooks) is complete on the fake providers, with **two open items** from the plan (§8: API load at 50 rps, per-account key limits). "Done when" evidence:

- **External client:** `tests/integration/external-client.test.ts` and `e2e/integrations-api-webhooks.spec.ts`: an API key and a local receiver → contact → call → signed `call.completed` → the same result from `GET /calls/:id`; template → `whatsapp.message.status` sent / delivered / read.
- **WhatsApp after the call:** `e2e/integrations-after-call.spec.ts` (rule) and `e2e/integrations-flow-whatsapp.spec.ts` (flow step): a real fake-voice call → template in the chat + the After the call card.
- **Webhook failures:** retries, delivery log, replay and auto-disable with notification (`tests/webhooks/`); signature samples: Node and Python run against the openssl golden vectors, PHP is documented but not executed.
- **Google Sheets:** scheduled published-CSV imports; call results to a sheet through the Apps Script receiver (logic tested, not run on Google).
- **Every public route:** one scope each (matrix snapshot), other accounts → 404, idempotency, per-key limits, OpenAPI + public docs page.
- **Verify:** both repos lint / types / format / builds / coverage; Playwright twice (§3).

Merging to `main`, the client's deploy and real Meta sends are the owner's call (§8).

## 1. Tasks

| Task                             | Status | Evidence (fe = frontend repo)      | Notes                                                  |
| -------------------------------- | ------ | ---------------------------------- | ------------------------------------------------------ |
| Step 0 plan + prompt             | ✅     | `baad510`, `84360f9`, `ef46e28`    | 14 owner defaults                                      |
| T15.1 Public API foundation      | ✅     | `f7cea64`                          | `access()`, 13 scopes, limits, request log, IP, expiry |
| T15.2 Send + trigger routes      | ✅     | `f89a03f`                          | upsert, bulk, messages, WhatsApp AI call               |
| T15.3 Webhook core               | ✅     | `eefc2a2`                          | outbox, signing, retries, disable, replay, test        |
| T15.4 Event wiring               | ✅     | `a48cb7b`                          | 11 events, external-client test                        |
| P15-B1-DONE                      | ✅     | `aa1b5a2`                          |                                                        |
| T15.5 WhatsApp after calls       | ✅     | `aa7426b`, fix `4cd5fa9`           | flow step, rules, timing, skip reasons                 |
| T15.6 Google Sheets + CRM        | ✅     | `2b552fa`                          | imports, Apps Script, Zapier / Make / n8n              |
| T15.7 Frontend                   | ✅     | `9114e78` (fe), fix `6d37cae` (fe) | Integrations, API keys, flow form, call card           |
| P15-B2-DONE                      | ✅     | `d9bef58`, `5dbf4c7` (fe)          | Playwright 158 / 158, log grep 0                       |
| T15.8 Docs + mocks               | ✅     | `8ec7aa5`, `5718ab7` (fe)          | public docs, guides, samples, dev receiver             |
| T15.9 Seeds, E2E, perf, security | ✅     | `4744f73`, `c218e37` (fe)          | 5 new Playwright tests, `perf:webhooks`                |
| T15.10 Gap audit, docs           | ✅     | this commit + fe docs commit       |                                                        |

## 2. Deliverables checklist (PHASE_15_PLAN §4)

- [x] Scopes + `access()` on every public route; per-key limits; request log; IP allowlist + expiry; `externalRef`
- [x] Contacts upsert / bulk, messages template / text, WhatsApp call trigger, templates read
- [x] Webhook outbox, endpoints, signing + rotation, retries, auto-disable + notification, replay, test event
- [x] Every catalogue event wired once, personal-data opt-in, external-client test
- [x] WhatsApp after calls: flow step, rules, scheduler, guards, call-page rows
- [x] Google Sheets import + Apps Script receiver + Zapier / Make / n8n docs
- [x] Frontend: API keys, Webhooks, After the call, Sheet imports, flow step, call card
- [x] Docs page + guides + tested signature samples (Node, Python) + mocks
- [ ] Seeds, Playwright, perf, security: done, **except the 50 rps API perf** (§8)
- [x] ADR 0045 + 0046, setup guide, runbook, READMEs, CHANGELOGs, BUILD_PLAN_V2, sign-off

## 3. Numbers

|                                                     | Before Phase 15 | After                                           |
| --------------------------------------------------- | --------------- | ----------------------------------------------- |
| Backend tests                                       | 3,331           | 3,555                                           |
| Backend coverage (stmts / branches / funcs / lines) | —               | 96.08 / 87.42 / 95.72 / 97.6                    |
| Frontend tests                                      | 1,386           | 1,442                                           |
| Frontend coverage                                   | —               | 96.3 / 92.28 / 94 / 97.02                       |
| Playwright                                          | 158             | 163                                             |
| Bundle (gzip)                                       | main 312.86 KB  | main 315.22 KB; IntegrationsPage 9.66 KB (lazy) |

The main bundle limit is +2 KB. Against current `main` (313.41 KB, which already has the Add account form) Phase 15 adds 1.81 KB.

**Perf (`npm run perf:webhooks`, local Docker Mongo + Redis, 5 local receivers):** 5,000 events in 300 s to 5 endpoints → 25,000 / 25,000 received, 0 lost, 0 duplicates, 0 bad signatures; event → receipt p50 11 ms, p95 29 ms, max 343 ms (target p95 < 5 s); queue drained. The receivers answer at once on the same machine, so this measures our side only.

**Playwright (port 3150):**

- T15.7 code: run 1 had 130 passed, 9 failed, 19 not run (sign-up and first pages timing out under load); those 9 files passed alone 31 / 31. Run 2: 158 / 158.
- Final code: run 1: 163 / 163 (31.7 min). Run 2 (logs on): 163 / 163 (25.6 min).

**Log grep** (run 2, 9,389 backend lines): full API keys, `whsec_`, signature values, phones, customer names, message texts, summaries, E2E passwords, Bearer tokens → 0.

## 4. Security / privacy checklist

- [x] Every key route isolated per account: another account's key with every scope → 404 (`tests/security/phase15-routes.test.ts`).
- [x] Scope × route matrix snapshot: each route opens to exactly one scope (`whoami`: any valid key).
- [x] SSRF corpus at save, DNS re-check at delivery, no redirects (`tests/webhooks/`).
- [x] Signature tamper / old timestamp refused; golden vectors from openssl.
- [x] IP allowlist uses `req.ip`; `X-Forwarded-For` counts only per `TRUST_PROXY`; revoked key out within 30 s; per-key limits (`tests/public-api/access.test.ts`).
- [x] Keys, secrets and payloads never in logs (tests + log grep); the dev receiver keeps no payloads; secrets shown once.
- [x] Mocks return 404 when off or in production; the production docs page lists public routes only.

## 5. Deviations from the plan / prompt

1. The Developers screen stays Settings → API keys (no new page). "Try it" is a link to the docs; the checked flow is "Test a key".
2. Retries are one delayed job per attempt (ADR 0046); one delivery row per event × endpoint with its last 10 attempts.
3. Outcome rules run when insights reach a final state, the one evaluation point. The call page reads `GET /calls/:id/after-call`.
4. Apps Script can't read headers, so the receiver checks a secret `key` in its URL instead of the signature.
5. Sheet imports match by phone only and use existing fields only.
6. `POST /whatsapp/calls` keeps its dashboard body (`channelId`, `contactId`, `mode: 'ai'`, `program`), with no `to` shortcut. Template sends take `variables` by key; media headers are dashboard only.
7. Seed rules both use the EMI template (no callback template exists in the seed).
8. The API can never clear an opt-out or DND.
9. Other deviations are listed per task in the plan changelog.

## 6. Bugs found and fixed

- **After-call rules never ran for sweep-skipped calls** (unanswered, too short, insights off), so "not answered twice" could not fire. Found by the E2E, fixed with a regression test (`4cd5fa9`).
- **Managers had no menu link** to the Google Sheets tab they may use (`6d37cae`).
- **Tech Provider connect** stopped at "Action needed" because `primary_funding_id` is BSP-only. Found on the client's server, hotfix `0053a8d` on `main`.
- **A circular import** (app → dev receiver → delivery job) hung test start-up. Removed before commit.
- The migration `down` missed two collections; the rule form hid "Fill every value"; the webhook dialog closed itself during render.

## 7. Known flakes (not Phase 15 logic)

- `tests/calls/flow-call.test.ts` "the flow max duration…": 69 s against ≤ 65 under full-suite load; passes alone 3 / 3 (seen twice, also on the final code).
- `tests/campaigns/dispatcher.test.ts`: two cases under full-suite load; pass alone 3 / 3.
- Playwright: sign-up timing out under load in one whole-suite run (see §3). The same symptom was recorded in the Phase 14 sign-off; the cause is still unknown.

## 8. Open items

| Item                                                                                                                                                                         | Owner       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| **Not done:** `POST /messages/template` and `POST /calls` at 50 rps (plan T15.9 §3). Needs many keys (60 writes / min each) and a voice runtime; move to Phase 16 load tests | Dev         |
| **Not done:** superadmin raising key limits per account (plan §7 #2). Limits are fixed at 600 reads / 60 writes a minute                                                     | Owner + dev |
| PHP signature sample is not executed in tests                                                                                                                                | Dev         |
| Apps Script receiver not run on real Google                                                                                                                                  | Owner + dev |
| Merge the branches to `main` and the client's deploy ([release notes](../ops/release-phase-15.md))                                                                           | Owner       |
| Real Meta sends after App Review; account billing "Customer pays Meta" while we are not a BSP                                                                                | Owner       |
| Owner answers to plan §7 if they differ from the defaults                                                                                                                    | Owner       |
