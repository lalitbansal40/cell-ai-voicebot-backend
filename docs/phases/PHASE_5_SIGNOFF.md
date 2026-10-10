# Phase 5 — Sign-off

**Date:** 2026-10-10 · **Branch:** `feature/phase-5-agents` (both repos, not merged) · **Plan:** [PHASE_5_PLAN.md](PHASE_5_PLAN.md) · **Tracker:** [PHASE_5_TASKS.md](PHASE_5_TASKS.md) · **ADR:** [0033](../adr/0033-ai-agents-knowledge-tools.md)

**Verdict:** ✅ Phase 5 (AI agents & knowledge base) complete — all 15 tasks done. **"Done when"** (an agent is built and, in the playground, "maine pay kar diya" makes it check the mock API and answer correctly) is proven by Playwright `e2e/agents-done-when.spec.ts` (frontend repo): the paid contact is thanked with the amount and date, the unpaid contact is told the payment is not in the record and a promise for tomorrow (IST) is saved. **Phase 6 can start.** The live OpenAI run is **pending input** (no key — §8); everything runs on the deterministic fake provider until then. Merging `feature/phase-5-agents` (both repos) is a project-lead decision after review.

## 1. Tasks — "Done when" check

| Task                                   | Status | Evidence (commit; fe = frontend repo) | Notes                                                                                                                                                         |
| -------------------------------------- | ------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T5.1 Models, migration 0006, catalogue | ✅     | `f544ef2`                             | 8 models, rate-card AI prices, ledger token breakdown, secret box, env + production rules, 4 error codes (39), 10 audit actions (57), 2 WS events, `ai` queue |
| T5.2 Provider layer                    | ✅     | `85083ae`                             | OpenAI REST (retries, Retry-After, timeouts, error mapping), fake provider rules, pricing, prepaid + per-agent caps                                           |
| T5.3 Agents API + compiler             | ✅     | `e75e752`                             | CRUD, 4 templates, catalog, duplicate / activate, validation, pure compiler with 16 snapshots, preview, usage                                                 |
| T5.4 Functions + built-ins + mock API  | ✅     | `b11725c`                             | sealed write-only headers, SSRF-safe executor, templating, Test endpoint, simulated built-ins, dev mock payment API                                           |
| T5.5 Knowledge base                    | ✅     | `9ba7a9b`                             | uploads / URLs, PDF / DOCX / HTML / text parsers, chunker, embeddings, versioned ingest job with charges, in-memory search                                    |
| T5.6 Turn runtime                      | ✅     | `9ecfd00`, `5f30b4e`                  | gates, knowledge, tool loop, guardrails with retry, fallbacks, idempotent per-turn billing                                                                    |
| T5.7 Playground API                    | ✅     | `3063b40`, `a52549e`                  | sessions, `clientTurnId` replay, outcomes, reset, rate limit, purge                                                                                           |
| T5.8 Superadmin AI                     | ✅     | `23991e7`, `7624d12`                  | AI prices in rate cards (audit diff fixed), `/admin/ai/config`, AI counts in the summary                                                                      |
| T5.9 Seed, docs, bench                 | ✅     | `ab8bd36`                             | seed agents + KB + mock payments, samples, ADR 0033, OpenAI guide, `bench:retrieval`                                                                          |
| T5.10 FE foundation                    | ✅     | `32db57a` (fe)                        | clients, routes, `LIVE_PHASE = 5` + Knowledge nav, WS, shared fields                                                                                          |
| T5.11 FE agents list + editor          | ✅     | `3639b19` (fe)                        | list, templates, Basic / Voice / Limits form, changed-field saves, error badges, unsaved guard, preview, read-only, reload banner                             |
| T5.12 FE functions + knowledge         | ✅     | `a249413` (fe)                        | function editor + Test, built-ins, Knowledge tab, KB pages with live status and Try a question                                                                |
| T5.13 FE playground                    | ✅     | `b613681` (fe)                        | chat, tool cards, knowledge refs, cost, outcome, banners, retry with the same turn id, ledger tokens                                                          |
| T5.14 FE superadmin AI                 | ✅     | `fcbecba` (fe)                        | AI price fields, history columns, AI card, AI summary                                                                                                         |
| T5.15 E2E, audit, docs, sign-off       | ✅     | this commit + fe `[P5-T5.15]`         | 6 Playwright AI tests (21 total, green twice), gap + security audit, docs                                                                                     |

Batch checkpoints: `33c15a5` `[P5-B1-DONE]`, `b76899c` `[P5-B2-DONE]`, `[P5-B3-DONE]` (the commit that fills §6). Run prompt: [PHASE_5_PROMPT.md](../prompts/PHASE_5_PROMPT.md).

## 2. Deliverables checklist (PHASE_5_PLAN §4)

- ✅ Agent builder (persona, lines, variables, voice & language, tone rules, limits, guardrails, fallbacks) with 4 templates and a prompt preview.
- ✅ Custom API functions with secret headers, SSRF guard and a Test button; built-in tools (simulated).
- ✅ Knowledge bases (files + web pages) with live processing, search and agent links.
- ✅ Text playground billed per turn from the wallet, outcomes recorded.
- ✅ Superadmin AI prices, AI configuration, AI usage numbers.
- ✅ Fake provider for dev / tests / E2E; OpenAI provider ready (live run pending a key).
- ✅ ADR 0033, `docs/setup/openai.md`, security / data / compliance / cost docs, seed, samples, retrieval bench.

## 3. Requirement → test mapping (gap audit)

| Requirement                                                                                      | Tests                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Models, indexes, TTLs, migration up / down refusal                                               | `tests/db/ai-models.test.ts`, `tests/db/phase5-migrations.test.ts`                                                                                                    |
| Secret box (round trip, tamper, wrong key, hint)                                                 | `src/core/ai/secret-box.test.ts`                                                                                                                                      |
| Env rules (production: openai + key, no fake / mock / private hosts)                             | `tests/config/env.test.ts`, `tests/ai/mock-api.test.ts`                                                                                                               |
| OpenAI provider (shapes, retries, timeouts, errors, no key in logs)                              | `tests/ai/providers.test.ts`                                                                                                                                          |
| Fake provider rules, embeddings                                                                  | `src/core/ai/fake.provider.test.ts`                                                                                                                                   |
| Pricing, budgets (prepaid, caps across IST midnight)                                             | `src/core/ai/pricing.test.ts`, `tests/ai/budget.test.ts`                                                                                                              |
| Agents CRUD, validation, templates, permissions, isolation, audit field names                    | `tests/ai/agents-api.test.ts`                                                                                                                                         |
| Compiler (order, rules, variables, truncation, purity) — 16 snapshots                            | `src/core/ai/compile.test.ts`                                                                                                                                         |
| Function CRUD, secrets write-only, Test endpoint, rate limit, redacted logs                      | `tests/ai/functions.test.ts`                                                                                                                                          |
| SSRF table (prod + dev), executor (encoding, typed body, CR-LF, caps, redirects)                 | `tests/ai/ssrf.test.ts`                                                                                                                                               |
| Built-in tools (date windows in IST, amounts, outcomes, disabled, live refused)                  | `src/core/ai/tools.test.ts`                                                                                                                                           |
| Mock payment API (seeded, even / odd, disabled / production 404)                                 | `tests/ai/mock-api.test.ts`                                                                                                                                           |
| Parsers (PDF, DOCX headings, Hindi, Windows-1252, scanned), magic checks                         | `src/core/ai/parsers/parsers.test.ts`                                                                                                                                 |
| Chunker (headings, danda, overlap, hard cut)                                                     | `src/core/ai/chunker.test.ts`                                                                                                                                         |
| Vector index (ranking, boost, LRU, versions)                                                     | `src/core/ai/vector-index.test.ts`                                                                                                                                    |
| Ingest (charge once, wallet empty, reindex versions, provider retries, URL fetch + SSRF, lock)   | `tests/ai/ingest.test.ts`                                                                                                                                             |
| Knowledge API (limits, 413 / 415, URL add, delete cascade, 409 linked, isolation, rate limit)    | `tests/ai/knowledge-api.test.ts`                                                                                                                                      |
| Turn runtime (tools, knowledge, guardrails, fallbacks, caps, idempotent charge, no text in logs) | `tests/ai/run-turn.test.ts`, `src/core/ai/guardrails.test.ts`                                                                                                         |
| Playground API ("Done when" over HTTP, replay, ended, rate limit, roles, isolation, purge)       | `tests/ai/playground-api.test.ts`                                                                                                                                     |
| Superadmin AI (price → next turn, config guard, summary)                                         | `tests/ai/admin-ai.test.ts`, `tests/billing/admin-summary.test.ts`                                                                                                    |
| Seed idempotent                                                                                  | `tests/db/seed-ai.test.ts`                                                                                                                                            |
| FE clients, routes, live sources, shared fields                                                  | fe `src/features/agents/foundation.test.tsx`                                                                                                                          |
| FE list / templates / editor / preview / read-only / reload banner                               | fe `src/pages/agents/agents-pages.test.tsx`                                                                                                                           |
| FE functions, built-ins, knowledge tab and pages                                                 | fe `src/pages/agents/functions-knowledge.test.tsx`, `src/features/agents/helpers.test.ts`                                                                             |
| FE playground + ledger tokens                                                                    | fe `src/features/agents/playground/playground.test.tsx`                                                                                                               |
| FE superadmin AI                                                                                 | fe `src/features/admin-billing/admin-billing.test.tsx`, `src/features/wallet/overview-add-money.test.tsx`                                                             |
| End to end                                                                                       | fe `e2e/agents-done-when.spec.ts`, `agents-knowledge.spec.ts`, `agents-functions-security.spec.ts`, `agents-billing-limits.spec.ts` (2 tests), `agents-roles.spec.ts` |

Security checklist: SSRF table in production and development policy (`tests/ai/ssrf.test.ts`, knowledge URL tests); secret header values never in responses / audit / tool-call logs (`tests/ai/functions.test.ts` grep, E2E network capture of `GET /agents/:id`); runtime logs carry no message / persona / contact text (`tests/ai/run-turn.test.ts`); prompt-injection fixture stored as plain data and framed as reference data (`tests/ai/ingest.test.ts`, compiler / runtime preamble); mock API absent in production (`tests/ai/mock-api.test.ts`); E2E backend logs grep (§6); gitleaks both repos (§6).

## 4. Numbers

|                                                     | Before (Phase 4) | After                         |
| --------------------------------------------------- | ---------------- | ----------------------------- |
| Backend tests                                       | 1176             | 1526                          |
| Frontend tests                                      | 412              | 478                           |
| Playwright                                          | 15               | 21 (green twice)              |
| Backend coverage (stmts / branches / funcs / lines) | —                | 97.1 / 88.31 / 96.61 / 98.13  |
| Frontend coverage                                   | —                | 95.64 / 90.21 / 92.71 / 96.45 |

Retrieval bench (`npm run bench:retrieval`, 3 knowledge bases × 2,000 chunks = 6,000, 1,536 dims): warm p50 9.2 ms · p95 10.1 ms · p99 11.5 ms; cold (load + cache) 586 ms; vector cache 40 MB.

Coverage gates stay at backend 95 / 85 / 95 / 95 and frontend 95 / 90 / 90 / 95 — the new values rounded down to 5 equal the current gates (never lowered).

## 5. Deviations from the plan

All recorded in the [plan changelog](PHASE_5_PLAN.md#changelog) (batch 1 and batch 2 entries). In short: migration backfills AI prices instead of new rate-card versions; case-insensitive collation instead of a `nameLower` field; new agents start active; built-in `live` mode throws until Phase 7 (no `NOT_IMPLEMENTED` code); `Content-Type` / `Transfer-Encoding` reserved headers; DOCX parsed through HTML to keep headings; blocked knowledge URLs reuse `FUNCTION_URL_BLOCKED`; the Try-a-question search is free (turns bill their query embedding); turn idempotency by `clientTurnId`; history holds text turns only; knowledge search uses the user's words (last reply only for messages under 4 words); 25 demo contacts (Phase 3 seed); 21 E2E tests instead of 20 (the billing scenario is split in two).

Real bugs found and fixed (each with a regression test): audit meta dropped token-count keys (AI price diffs lost) · knowledge search diluted by the previous reply (found in the batch 2 manual check) · empty tool arguments / variables dropped by MongoDB, crashing the playground (found by Playwright) · `Date.parse('2026-02-30')` accepted by built-in dates · ingest could stay "processing" after an unexpected error · a Phase 3 test depended on the real clock.

## 6. Verification (P5-B3-DONE)

Run on 2026-10-10 (each command separately, exit codes read; infra `cav-*` only).

| Check                                                                                                                                         | Backend                                                                                                                      | Frontend                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `lint` / `format:check` / `typecheck` / `build`                                                                                               | ✅ 0 / 0 / 0 / 0                                                                                                             | ✅ 0 / 0 / 0 / 0 (+ `tsc -p tsconfig.e2e.json` ✅)    |
| `openapi:check` / `gen:api` no diff                                                                                                           | ✅                                                                                                                           | ✅                                                    |
| `test:coverage`                                                                                                                               | ✅ 1526 tests · 97.1 / 88.24 / 96.61 / 98.13                                                                                 | ✅ 478 tests · 95.64 / 90.21 / 92.71 / 96.45          |
| actionlint (Docker)                                                                                                                           | ✅ no findings                                                                                                               | ✅ no findings                                        |
| Playwright (`E2E_FRONTEND_PORT=3150`)                                                                                                         | —                                                                                                                            | ✅ 21 / 21, twice (2nd run with `E2E_BACKEND_LOGS=1`) |
| Fresh clones side by side, `npm ci`, no `.env`: all checks + tests + E2E once                                                                 | ✅                                                                                                                           | ✅ 21 / 21                                            |
| gitleaks (history)                                                                                                                            | ✅ no leaks                                                                                                                  | ✅ no leaks                                           |
| `grep console.log src` / `grep sk- src e2e`                                                                                                   | 0 / 0                                                                                                                        | 0                                                     |
| Float grep + engine-only money writes                                                                                                         | ✅ (`tests/security/money-writes.test.ts`)                                                                                   | —                                                     |
| E2E backend log grep (1,518 lines: secret header value, user messages, persona, knowledge text, `Bearer`, `sk-`, demo phones, injection text) | ✅ 0 hits                                                                                                                    | —                                                     |
| Manual e2e on the dev server (fake provider, batch 2)                                                                                         | ✅ seed, paid / unpaid + promise, KB answer, OTP persona blocked, cap / wallet-empty fallbacks, ledger + summary, clean logs | —                                                     |

Notes: the machine (16 GB shared with other projects' Docker and test runs) ran short of RAM during the checkpoint, so the Vitest suites ran with `--maxWorkers=2` — no timeouts were raised; one long frontend unit test was split in two instead. Infra stopped afterwards with `npm run infra:down` (only `cav-*` containers).

## 7. Remaining TODOs (by phase)

- **Phase 6 (flows):** `isAgentInUse` must check published flows (purge and delete guards); `ai_agent` node exits from the outcome fields; node preview via `compileAgent`.
- **Phase 7 (voice runtime):** `compileAgent(…, { channel: 'voice' })` for Realtime sessions; live built-in hooks (`end_call`, `transfer_to_human`, …); per-turn knowledge via `searchKnowledgeBases`; `assertAgentBudget` before / during calls; call text turns billed with `kind: 'call'`; confirm ADR 0021.
- **Phase 8 (campaigns):** callbacks from `schedule_callback`; promise-to-pay follow-ups.
- **Phase 9 (reports):** dispositions and outcomes in reports; AI spend per agent (`AgentUsage`).
- **Phase 10 (integrations):** `send_sms_after_call` with DLT templates; outbound webhooks for outcomes.
- Re-seal script for function secrets when `ENCRYPTION_KEY` rotates (documented in secrets.md).

## 8. Client / business inputs still pending

- **OpenAI API key** (project key + budget) → run the `docs/setup/openai.md` live checklist; request Zero Data Retention for production.
- Text model choice and selling prices (defaults ₹0.20 / 1k text tokens, ₹0.01 / 1k embedding tokens).
- Recovery script wording and the company name customers hear; allowed contact fields for the AI (DPDP minimisation).
- The client's real payment-status API (URL, auth header) to replace the mock.
- Transfer numbers; SMS / DLT templates; SIP trunk; SMTP + sending domain; server SSH key (from earlier phases).

## 9. Go / no-go for Phase 6

**Go.** Agents, functions, knowledge and the playground are complete and tested end to end on the fake provider; the contract for Phases 6–7 is in ADR 0033. The only open item is the live OpenAI run, which needs a key and does not block flow-builder work.
