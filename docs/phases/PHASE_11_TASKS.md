# Phase 11 — Tasks (tracker)

Plan: [PHASE_11_PLAN.md](PHASE_11_PLAN.md) · Overview: [BUILD_PLAN_V2.md](../plans/BUILD_PLAN_V2.md)

| ✓   | #      | Task                                                                                                                                                                                                | Repo | Size |
| --- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---- |
| [x] | T11.1  | Models (templates, rate cards, platform settings), message / ledger / wallet / contact / account fields, migration 0012, `TEMPLATE_LIMITS`, env, codes, audit, notifications, WS, permissions, jobs | BE   | M    |
| [x] | T11.2  | `MetaClient`: templates CRUD + paging, resumable upload, template payloads, `pricing_analytics`; fake (review + pricing knobs); schemas + fixtures                                                  | BE   | L    |
| [x] | T11.3  | Template service (create / edit / submit / delete / sync, limits, edit rules), 4 template webhooks + backfill, `user_preferences`, call permission template, notifications + WS                     | BE   | L    |
| [x] | T11.4  | WhatsApp billing: rate card + price math, markup (global / account), engine hold / capture / release / late charge, reaper, budget, status hook, CSV import, money-writes                           | BE   | L    |
| [x] | T11.5  | Template send (variables, header media / location, buttons, rules, errors), service-reply billing, start chat with a template, price preview                                                        | BE   | M    |
| [x] | T11.6  | API + OpenAPI, superadmin rates / markup / margin / reconciliation, simulator kinds, seed, `dev:templates`, hardening, ADR 0039, docs, real-WABA checklist                                          | BE   | M    |
| [ ] | T11.7  | FE foundation: clients, hooks, WS event, labels, permissions, routes                                                                                                                                | FE   | M    |
| [ ] | T11.8  | Templates tab: list, drawer, builder with phone preview, call permission template                                                                                                                   | FE   | L    |
| [ ] | T11.9  | Send template dialog (inbox + contact page), inbox banner / Templates button / cost hint, template bubbles                                                                                          | FE   | M    |
| [ ] | T11.10 | Wallet (labels, prices, budget, usage), superadmin rates / billing settings / account override / reports, notifications, dashboard line, bundle check                                               | FE   | M    |
| [ ] | T11.11 | Playwright E2E (4 specs) — whole suite twice                                                                                                                                                        | FE   | M    |
| [ ] | T11.12 | Gap audit, security checklist, docs, Phase 11 sign-off                                                                                                                                              | both | M    |

Checkpoints: `[P11-B1-DONE]` after T11.4 · `[P11-B2-DONE]` after T11.6 · `[P11-B3-DONE]` after T11.12.
