# Phase 4 — Sign-off

**Date:** 2026-10-09 · **Branch:** `feature/phase-4-wallet` (both repos, not merged) · **Plan:** [PHASE_4_PLAN.md](PHASE_4_PLAN.md) · **Tracker:** [PHASE_4_TASKS.md](PHASE_4_TASKS.md) · **ADR:** [0032](../adr/0032-wallet-billing-payments.md)

**Verdict:** ✅ Phase 4 (Wallet & Billing) complete — all 15 tasks done. **"Done when"** (a test top-up raises the balance, a dummy call charge shows correctly in the ledger, hold / release work) is proven by Playwright `e2e/wallet-topup.spec.ts` and `e2e/wallet-charges.spec.ts` (frontend repo). **Phase 5 can start.** Real Razorpay test mode is still **pending input** (no test keys yet — §8). Merging `feature/phase-4-wallet` (both repos) is a project-lead decision after review.

Verification: see §6 (filled at the `[P4-B3-DONE]` checkpoint).

## 1. Tasks — "Done when" check

| Task                                                    | Status | Evidence (commit; fe = frontend repo) | Notes                                                                                                                       |
| ------------------------------------------------------- | ------ | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| T4.1 Models, migration 0005, money helpers, env         | ✅     | `a0cdbc7`                             | 8 models + billing profile, insert-only ledger guard, `shared/money.ts`, GSTIN checksum, 6 audit actions, `billing` queue   |
| T4.2 Rate cards + pricing                               | ✅     | `6164317`                             | default + per-account versions, back to default, 60 s cache; pulse / AI per second / TTS / commission bps                   |
| T4.3 Billing engine                                     | ✅     | `ec5ad88`                             | credit / hold / extend / settle / release / chargeUsage / adjust — conditional update + ledger insert per transaction       |
| T4.4 Wallet APIs + billing profile                      | ✅     | `5c09158`, `8d801a3`                  | wallet, settings, rates, estimate, ledger (cursor, CSV), usage (IST); idempotency test made deterministic                   |
| T4.5 Notifications, alerts, reaper, reconcile           | ✅     | `a6a58a1`                             | bell API (one row per recipient), low / exhausted once per 24 h, stale holds, daily wallet = Σ ledger                       |
| T4.6 Payments + top-ups                                 | ✅     | `c69fcc5`                             | Razorpay REST + fake provider, order before gateway, verify, `creditTopup` in one transaction                               |
| T4.7 Webhook + order expiry                             | ✅     | `77a09db`                             | raw body, HMAC, event dedupe, outcomes + superadmin notices, 24 h expiry                                                    |
| T4.8 GST invoices + PDF + receipt                       | ✅     | `3d48793`                             | FY numbering in the transaction, pdfkit + Noto Sans, render job, receipt after render, signed download                      |
| T4.9 Superadmin billing                                 | ✅     | `5f2992b`, `011d4fb`                  | rate cards with diff audit, wallet / ledger, credit limit, adjustments, simulator, IST summary, payments, events, UI config |
| T4.10 Seed, bench, ADR 0032, Razorpay guide, docs       | ✅     | `b732468`                             | `db:seed` billing, `bench:wallet`, `docs/setup/razorpay.md`                                                                 |
| T4.11 FE foundation                                     | ✅     | `6e75157` (fe)                        | clients, money input, Wallet menu, bell, banner, live wallet                                                                |
| T4.12 FE overview + Add money                           | ✅     | `010d3cb` (fe)                        | cards, budgets, prices, settings; Add money with GST, Razorpay loader / verify, test payment, confirm poll                  |
| T4.13 FE transactions, usage, invoices, billing details | ✅     | `5c40afe` (fe)                        | URL filters, Load more, drawer, CSV export; lazy chart; fresh invoice links; Settings → Billing details                     |
| T4.14 FE superadmin UI                                  | ✅     | `96aa25b` (fe)                        | Rates / Wallet tabs, adjust with confirm, credit limit, simulator, `/admin/billing`                                         |
| T4.15 E2E, audit, docs, sign-off                        | ✅     | `e0aa41f` (fe), this doc              | 5 Playwright scenarios (15 total, twice), gap + security audit, docs                                                        |

Batch checkpoints: `63c259c` `[P4-B1-DONE]`, `48580c5` `[P4-B2-DONE]`, `[P4-B3-DONE]` (the commit that fills §6). Run prompt: [PHASE_4_PROMPT.md](../prompts/PHASE_4_PROMPT.md).

## 2. Deliverables checklist (PHASE_4_PLAN §4)

- ✅ Prepaid wallet per account (created at signup / migration 0005), insert-only ledger, rate cards (platform default + per account, versioned).
- ✅ Billing engine as the only writer of money (security test), atomic conditional updates + transactions + idempotency keys, per-call holds with extension and graceful end, settle never fails.
- ✅ Razorpay top-ups (checkout verify + webhook, either first) with GST (CGST + SGST / IGST), consecutive FY invoice numbers, PDF invoice, receipt email; fake provider for dev / tests / E2E.
- ✅ Low balance / exhausted alerts (banner, bell, email), stale-hold reaper, daily reconciliation, order expiry, notification purge.
- ✅ Superadmin: rates, account wallet / ledger, credit limit, manual adjustments with audit on both sides, billing simulator, platform month summary, payments, payment events.
- ✅ UI: balance / on hold / available, budgets, prices, ledger with filters + export, usage chart, Add money, invoices, billing details, bell; superadmin pages.
- ✅ Docs: ADR 0032, data-model §2.3, api / data / websocket / audit / error-codes / secrets conventions, compliance GST notes + CA questions, Razorpay setup guide, READMEs, CHANGELOGs.

## 3. Requirement → test mapping (gap audit)

| Requirement                                                                                                   | Test(s)                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Integer micros / bps, no floats in the money core                                                             | `src/shared/money.test.ts`, `tests/security/money-writes.test.ts` (float grep), fe `utils/money.test.ts`                                |
| Only `src/core/billing` writes wallets / ledger                                                               | `tests/security/money-writes.test.ts`                                                                                                   |
| Ledger insert-only (only `held → released`)                                                                   | `tests/db/billing-models.test.ts`                                                                                                       |
| Atomic debit under concurrency, never negative                                                                | `tests/billing/engine.test.ts` (50 parallel holds for 10, 20 AI charges vs a credit, parallel settle / release), `npm run bench:wallet` |
| Idempotency (same key = one effect, also in parallel; HTTP replay)                                            | `engine.test.ts`, `topups-api.test.ts`, `admin-billing.test.ts` (adjustment replay / reused key)                                        |
| Rollback + transient retry with a single effect                                                               | `engine.test.ts`                                                                                                                        |
| Hold → settle (pulse, AI per second, TTS, commission), unanswered → release                                   | `src/core/billing/pricing.test.ts`, `engine.test.ts`, `admin-billing.test.ts` (simulator), E2E `wallet-charges`                         |
| Overrun past the hold, extension, graceful refusal                                                            | `engine.test.ts`, `admin-billing.test.ts` (long call)                                                                                   |
| Credit limit only for holds; budgets (TTS counts as AI)                                                       | `engine.test.ts`, `wallet-api.test.ts`                                                                                                  |
| Month spend in the account timezone                                                                           | `engine.test.ts`, `wallet-api.test.ts` (usage IST, zero-fill)                                                                           |
| Top-up: profile required, impersonation / suspended / manager 403, 10 / h                                     | `tests/billing/topups-api.test.ts`                                                                                                      |
| Verify: timing-safe signature, payment re-fetched + captured + amount match                                   | `tests/payments/providers.test.ts`, `topups-api.test.ts`                                                                                |
| Webhook: raw body only there, 401 bad / tampered, dedupe, all outcomes                                        | `tests/payments/webhooks.test.ts`                                                                                                       |
| Order expiry + late payment, stuck `creating`                                                                 | `webhooks.test.ts`                                                                                                                      |
| GST split + rounding, FY rollover at 31 Mar IST                                                               | `src/core/billing/gst.test.ts`, fe `utils/money.test.ts` (same preview)                                                                 |
| Invoice numbers consecutive, parallel-safe, aborted txn consumes none                                         | `tests/billing/invoices.test.ts`                                                                                                        |
| Invoice PDF content (number, GSTINs, CGST/SGST vs IGST, words, `%PDF`), fonts                                 | `invoices.test.ts` (unpdf), E2E `wallet-topup` (`%PDF` via the signed link)                                                             |
| Receipt email only after render; failed after last attempt                                                    | `invoices.test.ts`, E2E `wallet-topup` (Mailpit)                                                                                        |
| Signed invoice links (15 min), tampered refused, other account 404                                            | `invoices.test.ts`, E2E `wallet-topup`                                                                                                  |
| Low / exhausted: once per 24 h, re-arm, recipients by permission                                              | `tests/billing/alerts.test.ts`, E2E `wallet-alerts`                                                                                     |
| Reaper + reconcile + purge                                                                                    | `tests/billing/notifications.test.ts`, `tests/queues/billing-worker.test.ts`, `tests/db/seed-billing.test.ts`                           |
| Superadmin only (owner 403, impersonating 403), simulator 404 when off                                        | `tests/billing/admin-billing.test.ts`, fe `admin-billing.test.tsx`                                                                      |
| Rate change audited with diff; customers see it at once                                                       | `admin-billing.test.ts`, E2E `wallet-charges`                                                                                           |
| Adjustments: reason, both-side audit, bell; debit below zero only when allowed                                | `admin-billing.test.ts`, E2E `wallet-adjustments`                                                                                       |
| Platform summary numbers                                                                                      | `tests/billing/admin-summary.test.ts`                                                                                                   |
| Tenant isolation of every wallet / ledger / invoice / notification route                                      | `wallet-api.test.ts`, `invoices.test.ts`, `notifications.test.ts`, `topups-api.test.ts`                                                 |
| Production refuses the fake provider; simulator off; seller details required                                  | `src/config/env.test.ts`                                                                                                                |
| UI permissions (agent no Wallet / 403, manager read-only, impersonator no top-up, platform account no wallet) | fe `foundation.test.tsx`, `overview-add-money.test.tsx`, E2E `wallet-roles`                                                             |
| Add money flow (GST preview, billing step, Razorpay handler / dismiss, test payment, timeout, 429)            | fe `overview-add-money.test.tsx`, E2E `wallet-topup`                                                                                    |
| Live wallet without refetch, bell count from WS                                                               | fe `foundation.test.tsx`                                                                                                                |
| No secrets / PII / signatures in logs                                                                         | `webhooks.test.ts` (log capture), §6 log scan                                                                                           |

## 4. Numbers

| What                                   | Before Phase 4                  | After                                                   |
| -------------------------------------- | ------------------------------- | ------------------------------------------------------- |
| Backend tests                          | 936                             | 1176 (coverage 97.36 / 88.97 / 96.68 / 98.52)           |
| Frontend tests                         | 287                             | 412 (coverage 95.77 / 91.09 / 92.77 / 96.75)            |
| Playwright scenarios                   | 10                              | 15                                                      |
| Coverage gates                         | BE 95/85/95/95 · FE 95/90/90/95 | unchanged (re-measured, rounded down to 5)              |
| `bench:wallet` 1 worker, 300 calls     | —                               | 170 calls/s, p99 11 ms                                  |
| `bench:wallet` 20 workers, 1,000 calls | —                               | ~69 calls/s, p99 ≈ 5.8 s, 0 failures, wallet = Σ ledger |
| Main frontend chunk                    | —                               | 1.31 MB (chart in its own 291 kB chunk)                 |

## 5. Deviations from the plan

1. **Notifications fan out one row per recipient** (`userId` required) instead of one account-wide row — each user needs their own read state.
2. **Commission counts as call spend** in month counters and the usage chart; **TTS counts against the AI budget**.
3. **A failed payment attempt does not block a later captured payment** on the same order (`failed → paid`, like `expired → paid`).
4. **`fake-complete` builds and signs a webhook** and runs the same path as Razorpay (no separate test-only credit code).
5. **Adjustment Idempotency-Key is scoped to the platform account** (`idempotencyKeys.accountId` is an ObjectId); the target account is in the hashed path, so a key never replays elsewhere. Engine key `adjust:<target>:<key>`.
6. **`GET /admin/payments` filters by `account`**, not `accountId` (the tenant-scope security test forbids reading `query.accountId` in modules).
7. **New `GET /admin/billing/config`** (`simulatorEnabled`, `paymentProvider`) so the UI shows the simulator only when the server allows it.
8. **Platform summary "open reconcile mismatches"** = unread reconcile notices of the calling superadmin.
9. **The platform account has no wallet in the UI** (menu, banner, card, page, billing tab hidden) — it pays nothing; billing lives under `/admin/billing`.
10. **Ledger detail drawer** shows the hold id of a charge instead of listing the related hold rows (the detail API returns one row).
11. **Frontend unit tests run offline** with a 15 s per-test timeout (busy machine under coverage); **E2E forces same-origin API / WS** (a local `VITE_WS_URL` at :3100 broke live updates on :3150).

## 6. Verification (P4-B3-DONE)

_Filled at the `[P4-B3-DONE]` checkpoint._

## 7. Remaining TODOs (by phase)

| Phase | Where                          | What                                                                                                                                                                                          |
| ----- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5     | backend                        | AI text / playground usage → `chargeUsage()` (prepaid)                                                                                                                                        |
| 7     | backend voice runtime          | `holdForCall` at call start → `extendHold` on long calls → `settleCall` / `releaseHold`; replace the 2 h reaper with call-state checks; play the "balance khatam" line on a refused extension |
| 8     | backend / fe campaigns         | `POST /wallet/estimate` in the wizard; require `available ≥ concurrency × hold`; auto-pause on `walletEvents` `exhausted`, decide on `replenished`; cap per-account concurrency (bench §4)    |
| 9     | backend / fe                   | Refund handling with credit notes (today: superadmin notice + manual debit); recordings / subscriptions via `chargeUsage`; usage reports                                                      |
| 9+    | ops                            | Live Razorpay keys + webhook, production CSP allowing `checkout.razorpay.com`, seller GST details                                                                                             |
| 2+    | frontend build                 | Main chunk > 500 kB — route-level code splitting                                                                                                                                              |
| CI    | fe `.github/workflows/e2e.yml` | Run E2E on PRs once both repos run together                                                                                                                                                   |

## 8. Client / business / CA inputs still pending

- **Razorpay test keys** (then live keys + webhook) — the manual checklist in `docs/setup/razorpay.md` is ready; recorded as _pending input_.
- **Final selling rates** (call / AI / TTS, pulse, unanswered billing) — placeholders ₹1.00 / min, 60 s, ₹6.00 / min AI, ₹2.50 / 1k chars.
- **Seller legal name, address, GSTIN, state** for invoices (required in production).
- **CA questions** (compliance notes §8): tax point on recharge vs usage, SAC code, B2C wording, credit notes, e-invoicing threshold, refund of unused balance.
- **Recharge limits, free trial credit, low-balance default** (now ₹100 – ₹5,00,000, none, ₹500).
- Carried over: **OpenAI API key** (Phases 5 / 7), **client server SSH key** (read-only audit), **SIP trunk details** (Phase 13), **SMTP provider + sender domain** (production email).

## 9. Go / no-go for Phase 5

✅ **Go.** Phase 5 (AI agents & knowledge base) can bill AI usage through `chargeUsage()` from day one; the bell, alerts and wallet events are in place for its notices, and the shared money / table / dialog patterns are ready in the UI.
