# Phase 8 — Task Tracker

Source plan: [PHASE_8_PLAN.md](PHASE_8_PLAN.md) — Batch 1 = T8.1–T8.5, Batch 2 = T8.6–T8.9, Batch 3 = T8.10–T8.15.

| Done | Task  | Title                                                                                                                                                                      | Repo | Size |
| ---- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---- |
| [x]  | T8.1  | Models (Campaign, CampaignContact, Call / Contact / Account fields), migration 0009, `CAMPAIGN_LIMITS`, env, error codes, audit, WS, permission + role sync, notifications | BE   | M    |
| [x]  | T8.2  | Window math, dial guard, per-contact caps, atomic slots (Lua) + rate buckets                                                                                               | BE   | M    |
| [x]  | T8.3  | Outbound call path (`startOutboundCall`), busy / no-answer lifecycle, dry-run provider, simulated customer, scaled clock, virtual billing                                  | BE   | L    |
| [x]  | T8.4  | Campaign service: CRUD, audience preview + snapshot, estimate, lifecycle actions, `isFlowInUse`                                                                            | BE   | L    |
| [x]  | T8.5  | Scheduler + dispatcher + results: retries, callbacks, completion, auto-pause / resume, recover / sweep, shutdown                                                           | BE   | L    |
| [x]  | T8.6  | Recurring runs, notifications, contact `lastDisposition` + segment filter, admin limits + emergency pause, Settings call caps                                              | BE   | M    |
| [x]  | T8.7  | Campaigns API + single call API + results export + topic auth + OpenAPI                                                                                                    | BE   | M    |
| [x]  | T8.8  | Hardening: 100-contact dry run, restart / double-dial tests, circuit breaker, `bench:campaign`                                                                             | BE   | M    |
| [x]  | T8.9  | Sample CSV, seed, ADR 0036, docs, manual dry run                                                                                                                           | BE   | S    |
| [ ]  | T8.10 | FE foundation: clients, routes, `LIVE_PHASE = 8`, WS events, window / schedule fields                                                                                      | FE   | M    |
| [ ]  | T8.11 | Campaigns list + 5-step wizard (preview, estimate)                                                                                                                         | FE   | L    |
| [ ]  | T8.12 | Campaign detail: live dashboard, controls, results table, runs, export                                                                                                     | FE   | L    |
| [ ]  | T8.13 | Entry points: contact Call now / Test in browser, flow "used in campaigns", Settings → Calls, admin limits / pause, notifications, dashboard card                          | FE   | M    |
| [ ]  | T8.14 | Playwright E2E: 100-contact dry run, wallet pause / resume, callback, DND / caps, Call now, roles                                                                          | FE   | M    |
| [ ]  | T8.15 | Gap audit, security checklist, docs, Phase 8 sign-off                                                                                                                      | both | M    |

**Done when:** 100 contacts ka dry-run campaign chale — retries + calling window + pause / resume + export sahi kaam karein — Playwright se proven.
