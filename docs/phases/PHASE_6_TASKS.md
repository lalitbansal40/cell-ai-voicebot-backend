# Phase 6 — Task Tracker

Source plan: [PHASE_6_PLAN.md](PHASE_6_PLAN.md) — Batch 1 = T6.1–T6.5, Batch 2 = T6.6–T6.9, Batch 3 = T6.10–T6.15.

| Done | Task  | Title                                                                                                                                               | Repo | Size |
| ---- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---- |
| [x]  | T6.1  | Models, migration 0007, `FLOW_LIMITS`, error codes, audit / WS catalogue, ledger kinds, data-model docs                                             | BE   | M    |
| [x]  | T6.2  | Graph schema + node catalogue, shared templating refactor, variables catalogue, condition evaluator, intent matcher                                 | BE   | L    |
| [x]  | T6.3  | Validator (all rules, silent-loop SCC check, URL rules)                                                                                             | BE   | M    |
| [x]  | T6.4  | Flows API: CRUD, draft revision, validate, publish / versions / restore, duplicate, archive, delete, import / export, templates, agent in-use guard | BE   | L    |
| [x]  | T6.5  | Audio library: upload, WAV / MP3 probe, signed preview, in-use guard                                                                                | BE   | S    |
| [ ]  | T6.6  | Engine interpreter: state, inputs / outputs, non-AI nodes, gather retries, loop guard, error handler, trace, stats                                  | BE   | L    |
| [ ]  | T6.7  | Effects: `api_request`, `ai_agent` (exits, `extraInstructions`), AI intent classifier, billing                                                      | BE   | L    |
| [ ]  | T6.8  | Simulator API: runs, idempotent inputs, snapshots, TTL, rate limit, stats endpoint                                                                  | BE   | M    |
| [ ]  | T6.9  | 4 templates, seed, OpenAPI, ADR 0034, engine bench, docs                                                                                            | BE   | M    |
| [ ]  | T6.10 | FE foundation: deps, gen:api, clients, routes, `LIVE_PHASE = 6`, WS, shared `VariablePicker`, graph reducer + undo / redo                           | FE   | M    |
| [ ]  | T6.11 | Flows list, template picker, import / export, versions page, agent "used in flows" touches                                                          | FE   | M    |
| [ ]  | T6.12 | Builder canvas: palette, nodes + handles, edges, toolbar, save / conflict, validation panel, auto-layout, copy / paste                              | FE   | L    |
| [ ]  | T6.13 | Inspector forms (15 node types), flow settings / variables dialogs, audio upload, agent / API editors                                               | FE   | L    |
| [ ]  | T6.14 | Simulator panel, canvas highlight, run detail, node stats overlay                                                                                   | FE   | M    |
| [ ]  | T6.15 | Playwright E2E, gap + security audit, docs, Phase 6 sign-off                                                                                        | both | M    |

**Done when:** Loan recovery flow builder mein bane aur simulator mein har branch (1 press, 2 press, AI path) chale — Playwright se proven.
