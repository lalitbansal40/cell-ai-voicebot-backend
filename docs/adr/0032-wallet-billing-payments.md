# 0032 — Wallet, billing engine & payments

- **Status:** accepted
- **Date:** 2026-10-09

## Context

Every account pays in advance (prepaid wallet) and every call, AI minute and TTS character is charged from that wallet. Phase 7 (voice runtime) and Phase 8 (campaigns) will move money thousands of times a day, often for the same account at the same moment, so the money core must be correct under concurrency before anything calls it.

The AutoChatix code we studied (read-only) showed the gaps we must not repeat:

- **read → check → write** on the balance: two parallel AI charges both see enough balance and both debit (double spend / negative balance);
- the ledger row written **separately** from the balance change (crash between them → wallet ≠ ledger);
- **no idempotency** — a retried job or webhook charges or credits twice;
- floats for money (`0.1 + 0.2`), and amounts in rupees with decimals.

Customers recharge with Razorpay (UPI / cards / netbanking) and need a GST tax invoice for every recharge.

## Options considered

1. **Balance field + insert-only ledger, all writes in one engine module, conditional update + ledger insert in one MongoDB transaction, idempotency key per operation** — chosen.
2. **Balance derived from the ledger on every read** (no balance field) — always consistent, but every hold needs an aggregate and a lock; slow and still racy without a lock.
3. **Optimistic version field on the wallet** (read, compare-and-set on `version`) — works, but every conflict costs an extra round trip and retry logic in every caller.
4. **External billing provider** (Stripe Billing / Chargebee) — no INR prepaid-per-second model, adds a third party to every call.

Payments: Razorpay directly behind a small `PaymentProvider` interface (vs. a payments SDK abstraction) — one provider today, a fake provider for dev / tests / E2E.

## Decision

Option 1.

### Money core (`src/core/billing`)

- **Integers only**: micros (₹1 = 1,000,000), basis points for percentages, paise guard at the payment boundary. No floats in any money path (a security test greps the core for float patterns).
- **`engine.ts` is the only writer** of `wallets` and `ledgerEntries` (security test fails if any other `src/` file writes them). Operations: `credit`, `holdForCall`, `extendHold`, `settleCall`, `releaseHold`, `chargeUsage`, `adjust`.
- Each operation = **one conditional `findOneAndUpdate`** (`$expr`: available ≥ amount, budgets) **+ the ledger insert, in one transaction**, with a **unique idempotency key** (`accountId + idempotencyKey`). A replay returns the stored rows and changes nothing. Side effects (WS `wallet.updated`, alerts, `walletEvents`) run **after commit**.
- The wallet must exist **before** a transaction starts (transactions read a snapshot); `getOrCreateWallet` runs first.
- **Insert-only ledger**: the one allowed mutation is `held → released` (option `ledgerRelease`). Settling a call = release every hold row + insert one captured charge row with the price breakdown. A mongoose guard throws on any other update / delete (only the dev benchmark may delete its own `bench-*` account rows, never in production).
- **Per-call holds** (not per campaign): exposure = concurrent calls × hold (3 min of call + AI). `extendHold` adds 2 min when < 60 s remain; when it fails the call ends gracefully within 30 s. `settleCall` never fails on balance — an overrun may take the balance below zero by at most the grace cost.
- Commission is part of call spend; TTS counts against the AI budget. Monthly budgets (call / AI) are enforced in the same conditional update.
- **Rate cards** are versioned rows (platform default + per-account override, "back to default" row). The hold snapshots the card id, so a price change never re-prices a running call. Effective card cached 60 s per process — with several API instances a change can take up to 60 s to reach all of them (accepted; the admin change invalidates the local cache at once).
- Safety jobs: stale-hold reaper (held > 2 h → released), nightly reconcile (wallet = Σ ledger, superadmin notice on mismatch), alerts once per 24 h with an atomic claim, re-armed on recovery.

### Payments

- `PaymentProvider` interface: `createOrder`, `fetchPayment`, `verifyCheckoutSignature`, `verifyWebhookSignature`. Razorpay REST client (10 s timeout, no SDK) and a **fake provider** (`PAYMENT_PROVIDER=fake`, dev / test / E2E only — refused in production) whose `fake-complete` goes through the same webhook path.
- Order first (`creating` → `created`), then checkout. Credit happens on **verify** (signature + payment re-fetched + captured + amount match) **or webhook**, whichever comes first; both call `creditTopup`, which marks the order paid, credits the wallet and allocates the invoice number in **one transaction** — the second caller is a no-op.
- Webhook: raw body (≤ 256 KB) before the JSON parser, timing-safe HMAC, dedupe by `(provider, eventId)`, outcomes recorded in `paymentEvents` (90 days). Unmatched / mismatched payments and refunds notify superadmins; refunds are never auto-debited.

### GST & invoices

- 18 % GST: CGST 9 + SGST 9 when the buyer's state = seller's state, else IGST 18, each component computed in micros and rounded to whole paise (top-ups are whole rupees, so 9 % of them is always exact).
- Invoice numbers `CAV/<FY>/000001`, one consecutive series per Indian financial year (IST), allocated by `$inc` **inside** the credit transaction — an aborted payment consumes no number (GST requires no gaps).
- The PDF is rendered by the `invoice.render` job (pdfkit + bundled Noto Sans, OFL), stored privately, downloaded only through a 15-minute signed URL; the receipt email is sent after the first render only.

### Measured (dev laptop, `npm run bench:wallet`, single account)

| Workers on one wallet | Calls (hold → settle) | Throughput | p50 / p95 / p99 per call | wallet = Σ ledger |
| --------------------- | --------------------- | ---------- | ------------------------ | ----------------- |
| 1                     | 300                   | 170 / s    | 6 / 7 / 11 ms            | ✓                 |
| 5                     | 1,000                 | 67 / s     | 12 / 42 / 2,224 ms       | ✓                 |
| 20                    | 1,000                 | 69 / s     | 13 / 1,969 / 5,824 ms    | ✓                 |

Parallel writers on **one** wallet serialise on its document (transaction write conflicts are retried), so the tail grows with contention while correctness holds. Realistic load is far lower — 1,000 concurrent 2-minute calls ≈ 8 hold-or-settle operations / s per account. Phase 8 must still cap per-account call concurrency; if one account ever needs more, the next step is sharding holds per campaign, not weakening the atomic pattern.

## What later phases must call

| Phase | Use                                                                                                                                                                  |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5     | `chargeUsage({ accountId, type, amountMicros \| usage, ref })` for AI text / playground (prepaid only)                                                               |
| 7     | `holdForCall` at call start → `extendHold` on long calls → `settleCall` at the end (or `releaseHold` if not billable); replace the 2 h reaper with call-state checks |
| 8     | `POST /wallet/estimate` in the wizard; require `available ≥ concurrency × hold`; auto-pause on `walletEvents` `exhausted`, decide on `replenished`                   |
| 9     | `chargeUsage` for recordings / subscriptions; live Razorpay keys + webhook in production                                                                             |

## Consequences

- Correct under concurrency and retries by construction; every rupee has a ledger row and the nightly reconcile proves it.
- All money code is in one module — reviews and audits look in one place; nothing else can write (tests enforce it).
- Rate changes may need up to 60 s to reach every API instance.
- Hot accounts are bounded by single-document write throughput (see the numbers above).
- GST rules, SAC code and the invoice format need a CA's confirmation before live billing (compliance notes); the seller details come from env.
