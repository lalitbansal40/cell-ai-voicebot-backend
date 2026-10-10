# Phase 5 — Task Tracker

Source plan: [PHASE_5_PLAN.md](PHASE_5_PLAN.md) — Batch 1 = T5.1–T5.5, Batch 2 = T5.6–T5.9, Batch 3 = T5.10–T5.15.

| Done | Task  | Title                                                                                                       | Repo | Size |
| ---- | ----- | ----------------------------------------------------------------------------------------------------------- | ---- | ---- |
| [x]  | T5.1  | Models, migration 0006, env, limits, error codes, audit / WS catalogue, `ai` queue, secret box, rate fields | BE   | M    |
| [x]  | T5.2  | AI provider layer: interface, OpenAI REST client, fake provider, pricing, spend caps                        | BE   | M    |
| [x]  | T5.3  | Agents API: CRUD, templates, catalog, activate / duplicate, validation, prompt compiler + preview           | BE   | L    |
| [x]  | T5.4  | Custom functions (secret headers, SSRF-safe executor, test) + built-in tools + dev mock API                 | BE   | L    |
| [x]  | T5.5  | Knowledge base: uploads / URLs, parsing, chunking, embeddings, ingest job, search                           | BE   | L    |
| [x]  | T5.6  | Turn runtime: retrieval, tool loop, guardrail check, fallbacks, billing, tool-call log                      | BE   | L    |
| [x]  | T5.7  | Playground API: sessions, messages, outcomes, purge, rate limit                                             | BE   | M    |
| [x]  | T5.8  | Superadmin AI prices, `/admin/ai/config`, AI usage in summary                                               | BE   | S    |
| [x]  | T5.9  | Seed, sample KB docs, OpenAPI, ADR 0033, OpenAI setup guide, retrieval bench, docs                          | BE   | M    |
| [x]  | T5.10 | FE foundation: clients, routes, `LIVE_PHASE = 5`, WS, shared fields                                         | FE   | M    |
| [x]  | T5.11 | Agents list, template picker, editor (Basic / Voice & Language / Limits), prompt preview                    | FE   | L    |
| [x]  | T5.12 | Functions tab, Knowledge tab, knowledge base pages                                                          | FE   | L    |
| [x]  | T5.13 | Playground UI                                                                                               | FE   | M    |
| [x]  | T5.14 | Superadmin AI prices + config card                                                                          | FE   | S    |
| [x]  | T5.15 | Playwright E2E, gap + security audit, docs, Phase 5 sign-off                                                | both | M    |

**Done when:** Agent bane, playground mein "maine pay kar diya" bolne pe mock API se check karke sahi jawab de (Playwright E2E green).
