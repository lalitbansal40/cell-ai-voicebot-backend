# Phase 4 — Task Tracker

Source plan: [PHASE_4_PLAN.md](PHASE_4_PLAN.md) — Batch 1 = T4.1–T4.5, Batch 2 = T4.6–T4.10, Batch 3 = T4.11–T4.15.

| Done | Task  | Title                                                                                                   | Repo | Size |
| ---- | ----- | ------------------------------------------------------------------------------------------------------- | ---- | ---- |
| [x]  | T4.1  | Models, migration 0005, money helpers, limits, env, error codes, events / audit, `billing` queue        | BE   | M    |
| [x]  | T4.2  | Rate cards (effective card, history) + pure pricing                                                     | BE   | M    |
| [x]  | T4.3  | Billing engine: atomic credit / hold / extend / settle / release / charge, budgets, idempotency         | BE   | L    |
| [x]  | T4.4  | Wallet APIs (wallet, settings, rates, estimate, ledger, export, usage) + billing profile                | BE   | M    |
| [x]  | T4.5  | Notifications (bell API) + low-balance / exhausted alerts + stale-hold reaper + reconciliation          | BE   | M    |
| [x]  | T4.6  | Payment provider (razorpay + fake) + top-up orders + checkout verify + credit transaction               | BE   | L    |
| [x]  | T4.7  | Razorpay webhook (raw body, signature, idempotent events) + order expiry                                | BE   | M    |
| [x]  | T4.8  | GST, invoice numbering (FY), invoice PDF, receipt email, invoices API                                   | BE   | M    |
| [x]  | T4.9  | Superadmin: rate cards, account wallet / ledger, adjustments, credit limit, simulator, platform summary | BE   | M    |
| [x]  | T4.10 | Seed, OpenAPI, ADR 0032, Razorpay setup guide, bench, backend docs                                      | BE   | M    |
| [ ]  | T4.11 | FE foundation: clients, money input, routes, WS, notifications bell, wallet banner                      | FE   | M    |
| [ ]  | T4.12 | Wallet overview + settings + Add money flow + dashboard card                                            | FE   | L    |
| [ ]  | T4.13 | Transactions, Usage chart, Invoices, Settings → Billing details                                         | FE   | M    |
| [ ]  | T4.14 | Superadmin UI: Rates, Wallet (adjust, simulator), `/admin/billing`                                      | FE   | M    |
| [ ]  | T4.15 | Playwright E2E, gap + security audit, docs, Phase 4 sign-off                                            | both | M    |

**Done when:** Test top-up se balance badhe, dummy call charge ledger mein sahi dikhe, hold / release sahi chale (Playwright E2E green).
