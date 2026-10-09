# Phase 4 — Wallet & Billing — Detailed Plan

**Status:** ready to start · **Prev:** [Phase 3 sign-off](PHASE_3_SIGNOFF.md) · **Source:** [BUILD_PLAN §Phase 4](../plans/BUILD_PLAN.md) · **Tracker:** [PHASE_4_TASKS.md](PHASE_4_TASKS.md)
**Branch:** `feature/phase-4-wallet` (both repos, from the Phase 3 tip) · **Commit tag:** `[P4-T4.x]`, checkpoints `[P4-Bx-DONE]`

---

## 0. Is phase ka goal

Phase 4 ke end tak har account ka **prepaid wallet** ho, client **Razorpay se paisa add** kar sake (GST ke saath, invoice + email receipt), aur platform ke paas ek **billing engine** ho jo har call / AI usage ka paisa **sahi, atomic aur double-charge ke bina** kaate — taaki Phase 7 (voice runtime) aur Phase 8 (campaigns) seedha isi engine ko call karein.

1. **Wallet** per account — balance, on-hold, available, low-balance threshold, monthly budgets (micro-units, ADR 0016).
2. **Ledger** — har paisa ki entry (immutable), types: top-up, call charge, AI charge, TTS charge, adjustment, refund (subscription / recording reserved).
3. **Rate card** — platform default + per-account override (superadmin), history ke saath: call per minute + **pulse** (15 / 30 / 60 s), AI per minute, TTS per 1,000 chars, commission %.
4. **Hold → Settle → Release** engine: call shuru → estimate **hold**, lambi call → **hold extend**, call khatam → actual **charge**, baaki **release**. Direct usage charge (AI text etc.) bhi atomic.
5. **Atomic debit everywhere** — balance check + debit **ek hi conditional update**, ledger row **usi transaction** mein, **idempotency key unique** — AutoChatix ka AI-charge gap (read → check → write race, ledger alag, idempotency nahi) yahan repeat nahi hoga.
6. **Balance khatam** → `wallet.exhausted` event (Phase 7 call politely band kare, Phase 8 campaign auto-pause) — Phase 4 event + hooks deta hai.
7. **Top-up** — Razorpay Orders + Checkout, signature verify, **webhook** (raw body, HMAC), idempotent credit, GST (CGST + SGST ya IGST), **sequential GST invoice** (PDF), email receipt.
8. **Low-balance alert** — email + **in-app notification (bell)** + WS + banner; superadmin **manual credit / debit** (reason + audit), credit limit.
9. **UI** — Wallet page (balance cards, add money, transactions, usage chart, invoices), billing details, notifications bell, superadmin rates / wallet / billing pages.
10. **Safety nets** — stale-hold reaper, daily **reconciliation** (wallet = Σ ledger), pending-order expiry, payment-event log.

**Done when (BUILD_PLAN):** Test top-up se balance badhe, dummy call charge ledger mein sahi dikhe, hold / release sahi chale — **Playwright se proven** (fake payment provider + superadmin billing simulator; Razorpay test-mode manual checklist jab keys mil jaayein).

### Phase 4 mein kya NAHI hoga

| Kaam                                                                                | Kaunse phase mein                                                                     |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Real calls ka charge (call runtime se `holdForCall` / `settleCall` call karna)      | Phase 7 (voice runtime) — Phase 4 engine + simulator deta hai                         |
| Campaign auto-pause / resume logic, campaign wizard ka estimated cost               | Phase 8 — Phase 4 `wallet.exhausted` / `replenished` events + `POST /wallet/estimate` |
| AI text playground ka token billing                                                 | Phase 5 — Phase 4 `chargeUsage()` deta hai                                            |
| Recording storage charge (`recording_charge`)                                       | Phase 9 (type reserved)                                                               |
| Subscriptions / plans, auto-recharge (Razorpay recurring / mandates)                | Later (business decision) — `subscription` type reserved                              |
| Self-serve refunds, GST **credit notes**                                            | Later (CA ke saath) — Phase 4: superadmin debit adjustment + refund webhook alert     |
| e-Invoicing (IRN / QR) — sirf ₹5 Cr+ turnover par mandatory                         | Later (CA confirm)                                                                    |
| Multi-currency, international tax                                                   | Out of scope — sirf **INR**                                                           |
| Coupons / promo codes / free trial credit                                           | Later — superadmin manual credit se kaam chalega                                      |
| Razorpay **live** keys, production webhook URL, CSP for checkout on the real domain | Phase 12 (deployment) / Phase 15 (go-live)                                            |
| Postpaid billing / monthly statements PDF                                           | Later — Phase 4 ledger CSV export + usage page                                        |

### Conventions to follow

[api.md](../conventions/api.md) (§6 pagination, §10 **Idempotency-Key** — required on top-up, §13 tenant scoping) · [data-model.md](../conventions/data-model.md) §2.3 (updated in T4.1) · [data.md](../conventions/data.md) (§ immutable ledger, **§11 transactions**) · [error-codes.md](../conventions/error-codes.md) · [websocket.md](../conventions/websocket.md) (`wallet.updated`, `wallet.low_balance`) · [audit.md](../conventions/audit.md) · [secrets.md](../conventions/secrets.md) (Razorpay keys) · ADRs [0004 database](../adr/0004-database.md) (transactions), [0005 queues](../adr/0005-queue-and-background-jobs.md), [0016 money](../adr/0016-money-representation.md), [0017 dates](../adr/0017-dates-and-timezones.md), [0023 file storage](../adr/0023-file-storage.md), [0030 email](../adr/0030-email-delivery.md) · new **ADR 0032 — Wallet, billing engine & payments**.

---

## 1. Locked decisions (pehle se tay — implementation me dobara debate nahi)

### 1a. Money & arithmetic

| Topic            | Decision                                                                                                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit             | Integer **micros** everywhere (₹1 = 1,000,000; ADR 0016), suffix `Micros`, `currency: 'INR'` only. Max single amount ₹1 crore (`1e13` micros) — far below `Number.MAX_SAFE_INTEGER`. Every money value validated `Number.isSafeInteger`.     |
| Percentages      | **Basis points** integers (`commissionBps: 1500` = 15 %, GST `1800`) — never float percentages. (data-model `commissionPercent` → `commissionBps` in T4.1.)                                                                                  |
| Rounding         | One helper `src/shared/money.ts`: `mulBps(micros, bps)` = round **half up** to whole micros; per-minute rates via `ratePerSecond = ceil` rules below. No floats in any money path (lint rule / review checklist).                            |
| Paise boundary   | Razorpay works in **paise**. Top-up amounts must be whole paise (`micros % 10,000 === 0`); tax computed in micros then **rounded to paise** (half up) per tax component; `toPaise()` throws on a non-whole value.                            |
| Display          | Frontend only (`formatCurrencyMicros` from Phase 3); API always returns micros.                                                                                                                                                              |
| Negative balance | `balanceMicros` can go **below 0 only by a settle overrun** (call ran past its hold during the graceful-end window, §1c). New holds / charges need `available > 0` and ≥ amount. Top-up first pays back the negative part (it's just a sum). |

### 1b. Wallet & ledger model

| Topic                  | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One wallet per account | Created in the **signup transaction** (and migration `0005` backfills existing accounts). `getOrCreateWallet()` upsert as a safety net. Platform account (`isPlatform`) gets none.                                                                                                                                                                                                                                                                                                                                                                                                           |
| Wallet fields          | `balanceMicros`, `holdMicros`, `creditLimitMicros` (default 0), `lowBalanceThresholdMicros` (default **₹500**), `budgets { monthlyCallMicros, monthlyAiMicros }` (0 = unlimited), `spend { month: 'YYYY-MM', callMicros, aiMicros, ttsMicros }` (account timezone month, reset on first charge of a new month), `alerts { lowBalanceNotifiedAt, exhaustedNotifiedAt }`, `version`.                                                                                                                                                                                                           |
| Available              | `available = balance + creditLimit − hold`. **AI / TTS direct charges ignore creditLimit** (prepaid only — "AI never runs on credit"); call holds may use the credit limit (superadmin decision per account, default 0).                                                                                                                                                                                                                                                                                                                                                                     |
| Ledger rows            | **Insert-only.** The one allowed mutation: a `held` row → `released` (status + `releasedAt`, `releaseReason`). Charges are **new rows** — a settle = release the hold row + insert a `captured` charge row in the same transaction (so amounts never change after insert, data.md §immutable).                                                                                                                                                                                                                                                                                               |
| Ledger fields          | `type` (`topup \| call_charge \| ai_charge \| tts_charge \| adjustment \| refund \| subscription \| recording_charge`), `direction` (`credit \| debit`), `status` (`held \| captured \| released`), `amountMicros` (> 0), `balanceAfterMicros` (snapshot, captured rows), `breakdown { telephonyMicros, aiMicros, ttsMicros, commissionMicros, billableSeconds, pulseSeconds, aiSeconds, ttsChars }`, `ref { type: call \| campaign \| topup \| manual \| simulator \| usage, id }`, `holdId` (charge → its hold), `rateCardId`, `idempotencyKey` (unique per account), `note`, `createdBy`. |
| Status meaning         | Credits (`topup`, credit `adjustment`, `refund` reversal) are inserted `captured`. Holds are `held` debits (affect `holdMicros` only). Captured debits change `balanceMicros`.                                                                                                                                                                                                                                                                                                                                                                                                               |
| Idempotency            | Every engine call takes an `idempotencyKey` (e.g. `hold:call:<id>`, `settle:call:<id>`, `topup:<orderId>`, `adjust:<uuid>`); unique index `{ accountId, idempotencyKey }`; a repeat returns the **existing** row, never a second debit.                                                                                                                                                                                                                                                                                                                                                      |
| Atomic operation shape | `withTransaction` → `WalletModel.findOneAndUpdate({ accountId, $expr: { $gte: [available, amount] } }, { $inc: … }, { session, returnDocument: 'after' })` → `null` ⇒ `WALLET_INSUFFICIENT_BALANCE` (transaction aborted) → insert ledger row(s) → commit. **No read-then-write**, no external calls inside the transaction, retries on `TransientTransactionError`.                                                                                                                                                                                                                         |
| Budgets                | Checked inside the same conditional update (`spend.callMicros + amount ≤ budget` when budget > 0) ⇒ `WALLET_BUDGET_EXCEEDED`. Holds count toward the budget only when settled.                                                                                                                                                                                                                                                                                                                                                                                                               |
| Retention              | Ledger, top-up orders: **forever** (financial). Invoices + PDFs: **8 years** (CA confirm). Payment events: 90 days. Notifications: 90 days.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### 1c. Rate card & call pricing

| Topic         | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model         | `rateCards`: `accountId` (null = **platform default**), `callPerMinuteMicros`, `pulseSeconds` (15 / 30 / 60), `aiPerMinuteMicros`, `ttsPer1kCharsMicros`, `commissionBps`, `billUnansweredAttempts` (bool, default false), `effectiveFrom`, `createdBy`, `note`. **Insert-only history**; effective card = latest `effectiveFrom ≤ now` for the account, else platform default. `inheritsDefault: true` row = "back to default".            |
| Defaults      | Migration `0005` inserts the platform default (placeholder until the client confirms rates — Phase 15): call **₹1.00 / min**, pulse **60 s**, AI **₹6.00 / min**, TTS **₹2.50 / 1k chars**, commission **0 bps** (prices already include margin), unanswered not billed. Source: [cost-model](../cost/cost-model.md) +~50 %.                                                                                                                |
| Call charge   | `billableSeconds = answered ? ceil(durationSec / pulse) × pulse : 0` (unanswered free unless `billUnansweredAttempts`); `telephony = ceil(billableSeconds × callPerMinute / 60)`; `ai = ceil(aiSeconds × aiPerMinute / 60)` (per second, no pulse); `tts = ceil(ttsChars × ttsPer1k / 1000)`; `commission = mulBps(telephony + ai + tts, commissionBps)`; total = sum. Pure function, rate card **snapshotted** (`rateCardId`) on the hold. |
| Hold size     | `holdForCall` default estimate = **3 minutes** of telephony + AI at the account's rates (`BILLING_LIMITS.callHoldMinutes`); `extendHold` adds **2 minutes** (`callHoldExtendMinutes`) when < 1 minute of hold remains.                                                                                                                                                                                                                      |
| Graceful end  | If `extendHold` fails (no balance) → result `{ ok: false, reason: 'insufficient' }` + `wallet.exhausted`; Phase 7 plays the "balance khatam" message and ends within `graceSeconds` (**30 s**). Settle **never fails**: it charges the real usage even if that passes the hold (overrun → balance may go negative by ≤ grace cost).                                                                                                         |
| Campaign hold | **Per call, not per campaign** (deviation from the BUILD_PLAN wording, on purpose): a 1,000-contact campaign would otherwise lock its whole estimate or fail to start. Campaign start (Phase 8) = show `POST /wallet/estimate` + require `available ≥ concurrency × callHold`. Exposure at any time = concurrent calls × hold.                                                                                                              |

### 1d. Top-up, Razorpay & GST

| Topic              | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Provider interface | `PaymentProvider` (`createOrder`, `fetchPayment`, `verifyCheckoutSignature`, `verifyWebhookSignature`, `parseWebhook`) in `src/core/payments/`. Implementations: **`razorpay`** (minimal `fetch` client, 10 s timeout, Basic auth — no SDK) and **`fake`** (dev / test / E2E, deterministic ids, HMAC with a local secret). `PAYMENT_PROVIDER` env: `fake` default outside production; **production requires `razorpay`** + all 3 keys (env validation).                                                                                                                                                                                                           |
| Amounts            | Base (wallet credit) chosen by the user: **min ₹100, max ₹5,00,000**, whole rupees, presets ₹500 / ₹1,000 / ₹2,000 / ₹5,000. GST **18 % on top** (`taxBps 1800`); total = base + tax. The wallet is credited the **base** amount.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| GST split          | Seller state (`BILLING_SELLER_STATE_CODE`) = buyer state (from billing profile) → **CGST 9 % + SGST 9 %**, else **IGST 18 %**. Each component rounded to paise. Buyer GSTIN optional (B2C allowed); when given → format + checksum + first 2 digits = state code.                                                                                                                                                                                                                                                                                                                                                                                                  |
| Billing profile    | Required before the first top-up (`BILLING_PROFILE_REQUIRED`): legal name, billing email, address line 1 (+2), city, **state (GST state code)**, PIN (6 digits), GSTIN optional. Stored on the account (`billing`), edit = `wallet.topup`.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Flow               | 1) `POST /wallet/topups` (**Idempotency-Key required**) → `TopupOrder` `created` + provider order (`receipt` = order id, `notes` = account + order id, auto-capture) → `{ topupOrderId, provider, providerOrderId, keyId, amountPaise, prefill }`. 2) Checkout success → `POST /wallet/topups/:id/verify { paymentId, signature }` → HMAC (timing-safe) → **fetch payment from Razorpay** (status `captured`, amount + currency match the order) → credit. 3) **Webhook** `payment.captured` / `order.paid` does the same → whichever arrives first credits; the other is a no-op (`idempotencyKey = topup:<orderId>` + `{ provider, providerPaymentId }` unique). |
| Webhook            | `POST /api/v1/webhooks/razorpay`, **raw body** (mounted before the JSON parser), `X-Razorpay-Signature` HMAC-SHA256 with `RAZORPAY_WEBHOOK_SECRET`, `crypto.timingSafeEqual`; event id (`X-Razorpay-Event-Id`) stored in `paymentEvents` (unique → duplicate deliveries ignored, 200). Handled: `payment.captured`, `order.paid`, `payment.failed`, `refund.processed` / `refund.failed` (→ superadmin notification, no auto-debit). Unknown events → 200 + logged. Bad signature → 401 (no details).                                                                                                                                                              |
| Credit = 1 txn     | Order `created → paid` (conditional update), ledger `topup` credit, wallet `$inc balance`, invoice number allocated — **one transaction**. PDF + email happen **after** commit in a `billing` job (`invoice.render`).                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Expiry / failure   | `created` orders older than 24 h → `expired` (job). `payment.failed` → `failed` + reason (no money moved). Late success on an expired order still credits (money was taken) + log warn.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Who                | `wallet.topup` (owner, admin). **Blocked while impersonating** and on a **suspended** account (superadmin credits instead). Rate limit: 10 orders / hour per account.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Checkout UI        | Razorpay `checkout.js` loaded on demand from `https://checkout.razorpay.com/v1/checkout.js`; with the `fake` provider a **"Test payment"** dialog (Pay / Fail) calls `POST /wallet/topups/:id/fake-complete` (exists only when provider = fake, never in production). Production CSP for the checkout domains → Phase 12 note.                                                                                                                                                                                                                                                                                                                                     |

### 1e. Invoices

| Topic   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| When    | One **tax invoice per paid top-up** (advance received for services — CA to confirm "receipt voucher vs tax invoice"; template is configurable text).                                                                                                                                                                                                                                                                         |
| Number  | Platform-wide, **per Indian financial year** (Apr–Mar, IST), consecutive, ≤ 16 chars: `CAV/26-27/000001` (`BILLING_INVOICE_PREFIX`, default `CAV`). Allocated with an atomic `$inc` on `invoiceCounters { fy }` **inside the credit transaction** (no gaps on success; an aborted txn doesn't consume a number).                                                                                                             |
| Content | Seller (name, address, GSTIN, state) from env, buyer from the billing profile **snapshot**, SAC (`BILLING_SAC_CODE`, default `998319` — CA confirm), description "Prepaid wallet recharge", base, CGST / SGST or IGST, total in figures **and words** (Indian system), payment id, date (IST).                                                                                                                               |
| PDF     | `pdfkit` + **Noto Sans** (OFL, committed under `assets/fonts/` with its licence) for the ₹ sign (Latin text only — pdfkit can't shape Devanagari, so billing details are entered in English letters as on the GST registration); rendered by the `invoice.render` job → storage `accounts/<id>/invoices/<number>.pdf` → `pdfFileKey`; download via **signed URL (15 min)**. Re-render allowed (same data), never renumbered. |
| Email   | `wallet.receipt` template (key reserved in the email registry) to the billing email + owner: amount, invoice number, link to `/wallet?tab=invoices` (**no attachment, no amounts of other data**). Queued via the email queue (Phase 1).                                                                                                                                                                                     |

### 1f. Alerts, notifications & safety nets

| Topic                   | Decision                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Low balance             | After every debit / hold: `available` crossed **below** the threshold (was ≥ before) → WS `wallet.low_balance`, in-app notification, email to users with `wallet.topup`. Max **once per 24 h**; re-armed when available goes back above the threshold. Threshold 0 = off.                                                                                                                                  |
| Exhausted / replenished | `available ≤ 0` after an operation → WS `wallet.exhausted` + internal `walletEvents.emit('exhausted')` + notification (once per 24 h). Credit bringing it back > 0 → `walletEvents.emit('replenished')` (Phase 8 decides about resuming). `wallet.updated` after every change (throttled ≤ 1 / s per account).                                                                                             |
| Notifications (bell)    | `notifications` collection (data-model §Notification): `userId` (null = all users of the account with the right permission), `type`, `title`, `body`, `link`, `readAt`; API list / unread count / mark read / mark all; WS `notification.created`; 90-day TTL. Types in Phase 4: `wallet.low_balance`, `wallet.exhausted`, `wallet.topup_paid`, `wallet.adjusted`, `billing.refund_received` (superadmin). |
| Stale-hold reaper       | `billing.reap_holds` every 5 min: `held` rows older than **2 h** → released (`releaseReason: 'stale'`), `warn` log (ids only). Phase 7 replaces it with call-state checks.                                                                                                                                                                                                                                 |
| Reconciliation          | `billing.reconcile` daily 02:30 IST: per wallet `balance == Σ captured credits − Σ captured debits` and `hold == Σ held`; mismatch → `error` log + superadmin notification (**no auto-fix**).                                                                                                                                                                                                              |
| Order expiry            | `billing.expire_orders` hourly (§1d).                                                                                                                                                                                                                                                                                                                                                                      |
| Queue                   | New BullMQ queue **`billing`** (workers behind `WORKERS_ENABLED`): `invoice.render`, `billing.reap_holds`, `billing.reconcile`, `billing.expire_orders`, `notifications.purge`. Job data = ids only.                                                                                                                                                                                                       |

### 1g. Superadmin

| Topic             | Decision                                                                                                                                                                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rate cards        | Edit platform default (new version) and per-account override (new version / back to default); history list. Audit `rate_card.updated` (meta: scope, changed fields, old → new).                                                                                                                         |
| Manual adjustment | Credit **or** debit, amount + **mandatory reason** (≥ 5 chars) + Idempotency-Key; debit allowed below 0 only with an explicit `allowNegative` (rare correction). Ledger `adjustment` row with `createdBy`, audit `wallet.adjusted` on **both** sides (platform + account), notification to the account. |
| Credit limit      | `PATCH /admin/accounts/:id/wallet { creditLimitMicros }` (0 – ₹1,00,000), audit.                                                                                                                                                                                                                        |
| Simulator         | `BILLING_SIMULATOR_ENABLED` (default **false in production**): start a simulated call (real `holdForCall`), end it with `{ answered, durationSec, aiSeconds, ttsChars }` (real `settleCall` / `releaseHold`). Ledger `ref.type = 'simulator'`. Used by tests, E2E and the "Done when" demo.             |
| Platform view     | `/admin/billing`: month totals (top-ups, usage by type, GST collected), top accounts by spend, recent payments, payment events needing attention (failed / refund / unmatched), reconciliation mismatches.                                                                                              |
| Permission        | New platform permission **`platform.billing.manage`** (superadmin only, never while impersonating).                                                                                                                                                                                                     |

### 1h. Frontend

| Area         | Decision                                                                                                                                                                                                                                                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Routes       | `/wallet` (tabs **Overview**, **Transactions**, **Usage**, **Invoices** — tab in the URL `?tab=`), Settings → **Billing details** tab, `/admin/billing`, admin account detail → **Rates** (real) + **Wallet** tabs. `LIVE_PHASE = 4` (Wallet menu item already declared).                                                                                |
| Overview     | Cards: Balance, On hold, Available, This month's spend (call / AI / TTS) with budget bars; status chip (OK / Low / Exhausted); "Add money" (wallet.topup); low-balance threshold + budgets dialog; effective rates (read-only "Your prices"). Dashboard gets a small balance card.                                                                       |
| Add money    | Dialog: presets + custom amount (rupees input → micros, whole rupees, min / max), live GST breakdown (CGST / SGST or IGST from the profile state), billing details step if missing, Pay → Razorpay Checkout (or Test payment dialog) → "Confirming payment…" (polls the order until `paid` / `failed`, WS `wallet.updated`) → success with invoice link. |
| Transactions | DataTable (cursor "Load more"), filters type / status / date range, columns date (account TZ), description, type, status chip, debit / credit amount, balance after; row → detail drawer with breakdown (billable seconds, pulse, rate). CSV export (date range ≤ 1 year).                                                                               |
| Usage        | Daily stacked bars (call / AI / TTS) + totals for a date range (default this month) — **`@mui/x-charts`** (MIT; verify MUI 9 compatibility in T4.11, fallback `recharts`).                                                                                                                                                                               |
| Invoices     | Table (number, date, base, tax, total, status) + Download (fresh signed URL).                                                                                                                                                                                                                                                                            |
| Live         | WS `wallet.updated` → wallet query updated; `wallet.low_balance` / `wallet.exhausted` → global **banner** (users with `wallet.read`) + snackbar; `notification.created` → bell badge.                                                                                                                                                                    |
| Bell         | Header bell (all signed-in users): unread badge, menu with latest 20, mark read / all, link navigation.                                                                                                                                                                                                                                                  |
| Money input  | `rupeesToMicros(string)` / `microsToRupees` (Phase 3 util) — never floats; amounts validated client-side with the same min / max.                                                                                                                                                                                                                        |

### 1i. Permissions & roles

| Permission                | Roles (system)                                                         | Gives                                                                    |
| ------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `wallet.read` (existing)  | owner, admin, manager, viewer                                          | Wallet page, transactions, usage, invoices, rates (read)                 |
| `wallet.topup` (existing) | owner, admin                                                           | Add money, billing details, low-balance threshold, budgets               |
| `platform.billing.manage` | superadmin (platform permission, new)                                  | Rate cards, adjustments, credit limit, simulator, platform billing pages |
| Agent                     | no wallet access (menu hidden, API 403)                                | —                                                                        |
| Notifications             | every signed-in user (own + account-wide items they're allowed to see) | —                                                                        |

### 1j. API surface (all `/api/v1`, Bearer, tenant-scoped unless noted)

| Method & path                                                                                                              | Perm                       | Notes                                                                 |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------- |
| `GET /wallet`                                                                                                              | wallet.read                | balance, hold, available, status, threshold, budgets, month spend     |
| `PATCH /wallet/settings`                                                                                                   | wallet.topup               | `lowBalanceThresholdMicros`, `budgets` — audit                        |
| `GET /wallet/rates`                                                                                                        | wallet.read                | effective rate card (no internal ids of other accounts)               |
| `POST /wallet/estimate`                                                                                                    | wallet.read                | `{ calls, avgDurationSec, answerRate, aiShare }` → estimate (Phase 8) |
| `GET /wallet/ledger` · `GET /wallet/ledger/:id`                                                                            | wallet.read                | cursor; filters `type`, `status`, `refType`, `from`, `to`             |
| `GET /wallet/ledger/export`                                                                                                | wallet.read                | CSV stream, `from`/`to` required (≤ 366 days), injection-safe, BOM    |
| `GET /wallet/usage`                                                                                                        | wallet.read                | `from`, `to`, `groupBy=day\|type`, account timezone                   |
| `POST /wallet/topups`                                                                                                      | wallet.topup               | Idempotency-Key, rate-limited, blocked impersonating / suspended      |
| `GET /wallet/topups` · `GET /wallet/topups/:id`                                                                            | wallet.read                | history, status for polling                                           |
| `POST /wallet/topups/:id/verify`                                                                                           | wallet.topup               | checkout signature → credit                                           |
| `POST /wallet/topups/:id/fake-complete`                                                                                    | wallet.topup               | **only** with the fake provider (404 otherwise)                       |
| `GET /billing/profile` · `PUT /billing/profile`                                                                            | wallet.read / wallet.topup | audit `billing.profile_updated`                                       |
| `GET /invoices` · `GET /invoices/:id` · `GET /invoices/:id/download`                                                       | wallet.read                | download → `{ url, expiresInSec }`                                    |
| `GET /notifications` · `GET /notifications/unread-count` · `POST /notifications/:id/read` · `POST /notifications/read-all` | signed in                  | cursor, `unread=true` filter                                          |
| `POST /webhooks/razorpay`                                                                                                  | **public**, signature      | raw body                                                              |
| `GET·PUT /admin/rate-cards/default` · `GET /admin/rate-cards/default/history`                                              | platform.billing.manage    | new version on PUT                                                    |
| `GET·POST·DELETE /admin/accounts/:id/rate-cards`                                                                           | platform.billing.manage    | history / new override / back to default                              |
| `GET /admin/accounts/:id/wallet` · `GET /admin/accounts/:id/ledger` · `PATCH /admin/accounts/:id/wallet`                   | platform.billing.manage    | credit limit                                                          |
| `POST /admin/accounts/:id/wallet/adjustments`                                                                              | platform.billing.manage    | Idempotency-Key                                                       |
| `POST /admin/accounts/:id/billing/simulated-calls` · `POST …/simulated-calls/:holdId/end`                                  | platform.billing.manage    | only when the simulator is enabled                                    |
| `GET /admin/billing/summary` · `GET /admin/payments` · `GET /admin/payment-events`                                         | platform.billing.manage    | platform view                                                         |

### 1k. Engine contract for later phases (ADR 0032)

`src/core/billing/engine.ts` — every function: `accountId`, `idempotencyKey`, returns the ledger row(s) and the new wallet snapshot; throws typed errors.

| Function                                                                             | Used by                     |
| ------------------------------------------------------------------------------------ | --------------------------- |
| `estimateCall({ accountId, minutes?, aiShare? })` / `estimateCampaign(...)`          | Phase 8 wizard, `/estimate` |
| `holdForCall({ accountId, ref, estimateMicros? })` → hold row                        | Phase 7 call start          |
| `extendHold({ holdId, addMicros? })` → `{ ok } \| { ok: false, reason }`             | Phase 7 long calls          |
| `settleCall({ holdId, usage })` → release hold + charge row (never fails on balance) | Phase 7 call end            |
| `releaseHold({ holdId, reason })`                                                    | Phase 7 failed / unanswered |
| `chargeUsage({ accountId, type, amountMicros \| usage, ref })` (prepaid only)        | Phase 5 AI text, Phase 9    |
| `credit({ accountId, type, amountMicros, ref, note, createdBy })`                    | top-up, adjustments         |
| `walletEvents` (`low_balance`, `exhausted`, `replenished`)                           | Phase 8 auto-pause          |

---

## 2. Tasks ka overview

| #     | Task                                                                                                                                                | Repo | Size | Depends on |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---- | ---------- |
| T4.1  | Models, indexes, migration 0005 (wallets backfill, default rate card, counters), money helpers, limits, env, errors, events, audit, `billing` queue | BE   | M    | Phase 3    |
| T4.2  | Rate cards (resolve effective, history) + pure pricing (call charge, estimates)                                                                     | BE   | M    | T4.1       |
| T4.3  | Billing engine: atomic credit / hold / extend / settle / release / chargeUsage, budgets, idempotency, transactions, concurrency tests               | BE   | L    | T4.2       |
| T4.4  | Wallet APIs (wallet, settings, rates, estimate, ledger list / detail / export, usage) + billing profile + GSTIN validation                          | BE   | M    | T4.3       |
| T4.5  | Notifications (model, API, WS) + low-balance / exhausted alerts (WS, email, bell) + stale-hold reaper + reconciliation                              | BE   | M    | T4.3       |
| T4.6  | Payment provider interface (razorpay + fake), top-up orders API, checkout verify, credit transaction                                                | BE   | L    | T4.4       |
| T4.7  | Razorpay webhook (raw body, signature, events, idempotent), payment-event log, order expiry job                                                     | BE   | M    | T4.6       |
| T4.8  | GST calculation, invoice numbering (FY), invoice PDF (`pdfkit`), receipt email, invoices API                                                        | BE   | M    | T4.6       |
| T4.9  | Superadmin: rate cards, account wallet / ledger, adjustments, credit limit, simulator, platform billing summary, payment events                     | BE   | M    | T4.3–T4.8  |
| T4.10 | Seed, OpenAPI, ADR 0032, Razorpay test-mode guide, perf / concurrency check, backend docs                                                           | BE   | M    | T4.1–T4.9  |
| T4.11 | FE foundation: gen:api, API clients, money input utils, `LIVE_PHASE = 4`, routes, WS wiring, notifications bell, wallet banner                      | FE   | M    | T4.10      |
| T4.12 | Wallet Overview + settings + Add money flow (billing details, GST preview, Razorpay / test checkout, confirm) + dashboard card                      | FE   | L    | T4.11      |
| T4.13 | Transactions (filters, detail, export), Usage chart, Invoices tabs; Settings → Billing details                                                      | FE   | M    | T4.11      |
| T4.14 | Superadmin UI: Rates tab, Wallet tab (adjust, credit limit, simulator), `/admin/billing`                                                            | FE   | M    | T4.11      |
| T4.15 | Playwright E2E, gap + security audit, docs, Phase 4 sign-off                                                                                        | both | M    | all        |

**Size:** S = kuch ghante · M = ~1 din · L = 2 din.

**Batches (same style as Phase 3):** **Batch 1 = T4.1–T4.5** (money core) · **Batch 2 = T4.6–T4.10** (payments, invoices, admin, docs) · **Batch 3 = T4.11–T4.15** (frontend + E2E + sign-off). Har batch: detailed run prompt → implement → `[P4-Bx-DONE]` checkpoint (full verify, fresh clone, secret scan).

---

## 3. Tasks — step by step

### T4.1 — Models, migration 0005, money helpers, catalogue

- [x] Models in `src/db/models/` (base plugin; **no soft delete** on money collections): `wallet.model.ts`, `ledger-entry.model.ts` (immutable: schema hooks reject `updateOne` / `findOneAndUpdate` except the `held → released` transition helper), `rate-card.model.ts` (`accountId` nullable — tenant plugin exception documented), `topup-order.model.ts` (+ `expired`), `invoice.model.ts`, `invoice-counter.model.ts` (`{ fy }` unique), `payment-event.model.ts` (TTL 90 d), `notification.model.ts` (TTL 90 d); `account.billing` sub-document.
- [x] Indexes: wallets `{ accountId }` unique; ledger `{ accountId, idempotencyKey }` unique, `{ accountId, createdAt: -1, _id: -1 }`, `{ accountId, ref.type, ref.id }`, `{ status, createdAt }` (reaper), `{ holdId }`; rate cards `{ accountId, effectiveFrom: -1 }`; topup orders `{ provider, providerOrderId }` unique, `{ provider, providerPaymentId }` unique partial, `{ accountId, createdAt: -1 }`, `{ status, createdAt }`; invoices `{ number }` unique, `{ accountId, createdAt: -1 }`, `{ topupOrderId }` unique; payment events `{ provider, eventId }` unique; notifications `{ accountId, userId, readAt, createdAt: -1 }`.
- [x] Migration **`0005-wallets`**: wallet for every non-platform account (balance 0, threshold ₹500), platform default rate card (§1c), `invoiceCounters` collection; `down` removes what it created (only when every wallet is empty / no ledger rows — else refuse). Signup creates the wallet in its transaction.
- [x] `src/shared/money.ts`: `MONEY_SCALE`, `rupeesToMicros`, `microsToPaise` (throws on fractions of a paisa), `paiseToMicros`, `mulBps`, `ceilDiv`, `assertMicros`, `amountInWords` (Indian numbering). 100 % covered.
- [x] `BILLING_LIMITS` (`limits.ts`): top-up min / max, presets, call hold / extend minutes, grace seconds, reaper age, max adjustment, credit-limit max, ledger export max days, rate-limit for orders.
- [x] Env (`env.ts` + `.env.example` + env-docs sync test): `PAYMENT_PROVIDER`, `BILLING_SELLER_NAME`, `BILLING_SELLER_ADDRESS`, `BILLING_SELLER_GSTIN`, `BILLING_SELLER_STATE_CODE`, `BILLING_SAC_CODE`, `BILLING_INVOICE_PREFIX`, `BILLING_SIMULATOR_ENABLED`, `FAKE_PAYMENT_SECRET` (dev only); production refinements (provider razorpay + keys + seller details required, simulator off by default).
- [x] Error codes (+ error-codes.md, sync test): `BILLING_PROFILE_REQUIRED` (422), `PAYMENT_VERIFICATION_FAILED` (422); reuse `WALLET_INSUFFICIENT_BALANCE`, `WALLET_BUDGET_EXCEEDED`, `PROVIDER_ERROR` / `PROVIDER_UNAVAILABLE`, `CONFLICT_INVALID_STATE`.
- [x] Permission `platform.billing.manage` (`PLATFORM_PERMISSIONS`); WS events `wallet.exhausted` (+ existing `wallet.updated`, `wallet.low_balance`, `notification.created`) in `WS_EVENT_TYPES` + websocket.md; audit actions `wallet.topup_paid`, `wallet.adjusted`, `wallet.settings_updated`, `wallet.credit_limit_updated`, `billing.profile_updated`, `rate_card.updated` (audit.md + catalogue); `QUEUES.billing` + worker skeleton.
- [x] data-model.md §2.3 updated (bps, direction, `balanceAfterMicros`, `holdId`, `inheritsDefault`, `billUnansweredAttempts`, `expired`, counters, payment events, account billing).
- [x] Tests: model validation, every unique index, ledger immutability guard, migration up / down (+ refuse down with money), money helpers table-driven (rounding half up, paise guard, words for 0 / 1 / 1,25,000.50 / 1 crore), catalogue / docs sync tests green, tenant-scope test covers new models (rate card null-account exception explicit).

### T4.2 — Rate cards & pricing

- [x] `src/core/billing/rates.ts`: `effectiveRateCard(accountId, at = now)` (account override unless `inheritsDefault`, else platform default; cached 60 s per account, invalidated on change); `createRateCardVersion()`.
- [x] `src/core/billing/pricing.ts` (pure): `callCharge(rate, usage)` (§1c), `holdEstimate(rate, minutes)`, `estimateCampaign(rate, { calls, avgDurationSec, answerRate, aiShare })`, all integer.
- [x] Validation: rates ≥ 0 and ≤ ₹1,000 / min, pulse ∈ {15, 30, 60}, commission 0–10,000 bps.
- [x] Tests: table-driven call charges (0 s, 1 s, exactly one pulse, 61 s at 60 / 30 / 15 s pulse, unanswered free vs billed, AI per second, TTS chars, commission rounding), estimates, effective-card resolution with history + future `effectiveFrom` + back-to-default, cache invalidation.

### T4.3 — Billing engine

- [x] `src/core/billing/engine.ts` (§1k) with `withTransaction` + conditional `findOneAndUpdate` (§1b) for: `credit`, `holdForCall`, `extendHold`, `settleCall` (release hold row + insert charge row, overrun allowed), `releaseHold`, `chargeUsage` (prepaid, no credit limit), `adjust` (credit / debit, `allowNegative`).
- [x] Idempotency: duplicate `idempotencyKey` → return the stored row (E11000 inside the txn handled), never double effect; settle / release of an already-released hold → no-op returning the existing result.
- [x] Budgets + month spend in the same update (account-timezone month rollover); `balanceAfterMicros` snapshot.
- [x] After commit (outside the txn): emit `wallet.updated` (throttled), threshold crossing → alerts (T4.5 hook), `walletEvents`.
- [x] Tests: each operation's wallet + ledger effect; insufficient / budget errors leave **no** row; **50 parallel holds** against a balance for 10 → exactly 10 succeed, hold sum exact, balance never negative; parallel settle + release on one hold → one wins; crash simulation (throw between steps) → transaction rolled back; overrun settle → negative balance then new hold refused; AI charge ignores credit limit; transient transaction error retried; idempotent repeats (same key, different amount → the stored row, logged warn).

### T4.4 — Wallet APIs & billing profile

- [x] Routes §1j for wallet, settings, rates, estimate, ledger (cursor `createdAt,_id`), ledger detail, export (streaming CSV, BOM, safe cells, account-TZ dates, ≤ 366 days, ≤ 200k rows), usage aggregation (`$dateTrunc` in the account timezone, `groupBy` day / type).
- [x] Billing profile `GET / PUT /billing/profile`: GST state list (code + name, 2-digit codes incl. 97 = Other Territory), GSTIN regex + checksum (mod-36) + state match, PIN `^[1-9][0-9]{5}$`; audit.
- [x] Settings: threshold 0 – ₹1,00,000, budgets 0 – ₹1 crore; audit `wallet.settings_updated` (old → new).
- [x] OpenAPI for all; `Wallet`, `LedgerEntry`, `RateCard` (public view), `UsageSeries`, `BillingProfile` schemas.
- [x] Tests: shapes, filters, pagination, export content (injection, BOM, TZ), usage grouping across a month boundary in IST, permissions per role (agent 403, manager read-only), isolation (other account's ledger id → 404), suspended → writes 403, impersonation allowed for reads.

### T4.5 — Notifications, alerts & safety jobs

- [x] Notifications module: create helper (`notifyUsers({ accountId, permission?, userId?, type, title, body, link })`), API §1j, WS `notification.created`, TTL purge; only users with the needed permission see account-wide wallet notices.
- [x] Alerts: low-balance / exhausted logic (§1f) with `alerts.*NotifiedAt` (atomic claim so parallel debits send once); emails `wallet.low_balance` (recipients: active users with `wallet.topup`), templates escaped, no amounts of other accounts.
- [x] Jobs on `billing`: `billing.reap_holds` (5 min), `billing.reconcile` (daily 02:30 IST), `notifications.purge`; cron registration like `maintenance`.
- [x] Tests: crossing once (not on every debit), re-arm after top-up, 24 h cap, threshold 0 = off, recipients by permission, bell API (unread count, read, read-all, other user's notification 404), reaper only old holds + idempotent, reconcile detects an injected mismatch and stays quiet otherwise.

### T4.6 — Payments: provider + top-up orders

- [x] `src/core/payments/`: `types.ts`, `razorpay.provider.ts` (fetch: `POST /v1/orders`, `GET /v1/payments/:id`; Basic auth; 10 s timeout; errors → `PROVIDER_ERROR` / `PROVIDER_UNAVAILABLE`; no secrets / card data in logs), `fake.provider.ts`, `index.ts` (factory from env).
- [x] `POST /wallet/topups`: validate amount, billing profile, not impersonating / suspended, Idempotency-Key middleware (first real mount), GST calc (T4.8 helper), order created **before** the provider call (`status: creating` → `created` with provider id; provider failure → `failed`), rate limit.
- [x] `POST /wallet/topups/:id/verify`: signature (timing-safe) → fetch payment → amount / currency / order match → `creditTopup()` (single transaction: order `paid`, ledger credit, wallet, invoice number) → enqueue `invoice.render` + receipt email → audit + notification + `wallet.updated`.
- [x] `fake-complete` (fake only): simulates a signed webhook / payment (`paid` or `failed`).
- [x] Tests (provider mocked with a local HTTP stub, no network): happy path, bad signature, amount mismatch, payment not captured, provider down (no order left half-made), double verify, verify after webhook, Idempotency-Key replay, min / max / fraction amounts, profile missing, impersonation / suspended / manager 403, rate limit, production env refuses `fake`.

### T4.7 — Razorpay webhook & order lifecycle

- [x] Raw-body route `POST /api/v1/webhooks/razorpay` mounted **before** `express.json` (only this path), 256 KB limit; signature check; event id dedupe (`paymentEvents`); handlers §1d; responds 200 fast (work is DB-only); unmatched order ids stored with `outcome: 'unmatched'` + superadmin notification.
- [x] `billing.expire_orders` hourly job; late payment on an `expired` order still credits.
- [x] Tests with real HMAC fixtures: valid / invalid / missing signature, tampered body, replayed event, out-of-order (`payment.captured` after verify), `payment.failed`, refund events → notification only, unknown event 200, JSON parser untouched for every other route, no body / secret in logs.

### T4.8 — GST & invoices

- [x] `src/core/billing/gst.ts`: `computeTopupTax(baseMicros, sellerState, buyerState)` → `{ cgst, sgst, igst, taxMicros, totalMicros }` (paise rounding per component); GSTIN validator (shared with T4.4).
- [x] Invoice numbering in the credit transaction (FY from IST date); `invoice.render` job: PDF via `pdfkit` + Noto Sans (₹, Latin text), A4, seller / buyer / SAC / tax table / amount in words / payment id; storage key; re-render idempotent.
- [x] `wallet.receipt` email template (text + HTML, escaped).
- [x] `GET /invoices`, `GET /invoices/:id`, `GET /invoices/:id/download` (signed URL; 409 while rendering).
- [x] Tests: intra vs inter-state, rounding cases (₹100, ₹999, ₹1,234), FY rollover at 31 Mar 23:59 IST → 1 Apr, 20 parallel credits → 20 consecutive unique numbers, aborted credit consumes no number, PDF starts with `%PDF` and contains the number / GSTIN / words (text extraction), email content, isolation.

### T4.9 — Superadmin billing

- [x] Routes §1j under `requirePlatformAdmin` + `platform.billing.manage`: default rate card (+ history), account rate cards (history / override / back to default), account wallet + ledger, credit limit, adjustments (Idempotency-Key, reason, both-side audit, notification), simulator (enabled flag), platform summary (month totals, top accounts, GST collected), payments list, payment events (filters `outcome`).
- [x] Rate-card change audit with diff; effective-card cache invalidated.
- [x] Tests: permissions (customer owner 403, impersonating superadmin 403), each action's ledger / audit / notification, simulator: start → hold visible → end answered (charge = expected) / unanswered (full release) / long call (overrun), simulator disabled → 404, summary numbers against seeded data.

### T4.10 — Seed, OpenAPI, ADR, docs (`[P4-B2-DONE]` after this)

- [x] `db:seed`: Demo Finance billing profile (fake GSTIN of the right format, state 08 Rajasthan), ₹1,000 seed credit (adjustment), a few simulated calls (held / charged / released), 1 fake top-up with invoice — idempotent.
- [x] `gen:openapi` + `openapi:check` green; every new route documented with errors.
- [x] **ADR 0032** — Wallet, billing engine & payments (atomic pattern, per-call holds, insert-only ledger with release + charge rows, provider interface, fake provider, GST / invoice numbering, what Phase 7 / 8 must call).
- [x] `docs/setup/razorpay.md`: test-mode keys, webhook URL via a tunnel, events to subscribe, manual checklist (pay, fail, webhook-first, verify-first, refund alert).
- [x] Perf / concurrency script `scripts/bench-wallet.ts` (dev only): 1,000 holds + settles over 20 parallel workers → time, wallet = Σ ledger, no negative; numbers recorded in the sign-off.
- [x] Docs: data-model §2.3, api.md (money fields, idempotency usage), data.md (retention: ledger / invoices / payment events), websocket.md, audit.md, error-codes.md, secrets.md (Razorpay + fake secret), compliance-notes (GST / invoice notes, CA questions), README "Wallet & billing", CHANGELOG.

### T4.11 — Frontend foundation

- [ ] `gen:api`; clients `src/services/api/{wallet,billing,invoices,notifications,admin-billing}.ts`; keys `features/wallet/keys.ts`.
- [ ] `src/utils/money.ts`: `parseRupeesInput` (Indian grouping, ≤ 2 decimals, no floats → micros), `formatRupeesInput`; GST state list (shared constant from the API or a static list synced by test).
- [ ] `LIVE_PHASE = 4`; routes `/wallet`, `/settings/billing`, `/admin/billing`; WS hooks for `wallet.updated` / `wallet.low_balance` / `wallet.exhausted` / `notification.created`.
- [ ] Notifications bell in the header + `WalletBanner` in `Banners` (low / exhausted, link to Add money for `wallet.topup`).
- [ ] Tests: menu visibility per role (agent no Wallet), money input parsing table, bell (badge, read, read-all, WS increment), banner per status and permission.

### T4.12 — Wallet overview & Add money

- [ ] Overview cards, status chip, month spend vs budgets, "Your prices", settings dialog (threshold, budgets — `wallet.topup`), dashboard balance card.
- [ ] Add money dialog: presets / custom, GST preview, billing-details step (form with state select, GSTIN check), Pay → Razorpay Checkout (script loader, handler → verify) or Test payment dialog (fake) → confirming state (poll `GET /wallet/topups/:id` every 2 s up to 60 s + WS) → success (invoice link) / failure / cancelled (`modal.ondismiss`) messages; Idempotency-Key per dialog attempt.
- [ ] Tests: amount validation, GST preview (intra / inter-state), missing profile path, fake success / failure, Razorpay handler mocked (`window.Razorpay`), dismissed checkout, polling timeout message, permission hiding (manager: no Add money), impersonating: Add money hidden.

### T4.13 — Transactions, Usage, Invoices, Billing details

- [ ] Transactions tab (filters in the URL, Load more, detail drawer with breakdown, export dialog with date range), Usage tab (chart + totals, date range), Invoices tab (download), Settings → Billing details (form, read-only without `wallet.topup`).
- [ ] Tests: filters → query, drawer breakdown formatting, export request, chart data mapping (stubbed chart), invoice download (fresh URL), billing form validation + server errors.

### T4.14 — Superadmin UI

- [ ] Account detail **Rates** tab (effective card, history, edit override / back to default, confirm), **Wallet** tab (balance cards, ledger, Adjust dialog credit / debit + reason, credit limit, Simulator panel: start call → shows hold → end with answered / duration / AI seconds / TTS chars → result).
- [ ] `/admin/billing`: month summary cards, top accounts, recent payments, payment events needing attention, default rate card editor.
- [ ] Tests: forms + confirmations, simulator flow, permission (non-superadmin never sees it).

### T4.15 — E2E, gap audit, docs, sign-off

- [ ] Playwright scenarios (fake payment provider, simulator on):
  1. **"Done when" top-up**: owner fills billing details → adds ₹1,000 → test payment → balance ₹1,000, ledger "Wallet recharge" + invoice `CAV/…` with GST ₹180 (CGST + SGST or IGST as per state) → PDF downloads (`%PDF`) → receipt email in Mailpit.
  2. **"Done when" charge + hold / release**: superadmin sets the account's rates → starts a simulated call → owner sees **On hold** → ends it answered (90 s, 60 s pulse → 2 min) → ledger charge with the exact breakdown, hold released, balance correct; second call unanswered → full release, no charge.
  3. Low balance & exhausted: threshold above balance after a charge → banner + bell + email; simulated call refused when available is 0 (`WALLET_INSUFFICIENT_BALANCE`), top-up clears the banner.
  4. Superadmin manual credit and debit with reason → ledger rows, audit entries on both sides, notification to the account.
  5. Roles: manager sees wallet read-only (no Add money / settings); agent has no Wallet menu (and `/wallet` → 403); impersonating superadmin can't top up.
- [ ] Old 10 scenarios still green; whole suite twice.
- [ ] Gap audit (requirement → test), security checklist: webhook signature + raw body, timing-safe compares, amounts only from the provider, idempotency on every money path, no card / payment secrets / GSTIN in logs (`E2E_BACKEND_LOGS=1` scan), signed URLs for invoices, isolation per endpoint, rate limits, production env refuses `fake` + simulator off, gitleaks; coverage gates re-measured (never lower).
- [ ] Razorpay test-mode manual run (when the platform's test keys are available) per `docs/setup/razorpay.md` — result recorded in the sign-off (or listed as pending input).
- [ ] Docs: both READMEs, CHANGELOGs, PHASE_4_TASKS, BUILD_PLAN status, this plan ticked, **PHASE_4_SIGNOFF.md**; `[P4-B3-DONE]` (full verify both repos, E2E twice, fresh clones, gitleaks, `infra:down`).

---

## 4. Deliverables checklist

- [ ] Wallet, ledger, rate card, top-up order, invoice, counter, payment event, notification models + migration 0005
- [ ] Money helpers (micros, bps, paise, amount in words) with exhaustive tests
- [ ] Rate cards + pure pricing + billing engine (credit / hold / extend / settle / release / charge / adjust) — atomic, idempotent, concurrency-tested
- [ ] Wallet, ledger, usage, estimate, settings, billing profile APIs
- [ ] Notifications (bell) + low-balance / exhausted alerts + reaper + reconciliation
- [ ] Razorpay top-up (orders, checkout verify, webhook) + fake provider + GST + sequential invoices (PDF) + receipt email
- [ ] Superadmin rates, adjustments, credit limit, simulator, platform billing view
- [ ] Frontend: wallet (overview, add money, transactions, usage, invoices), billing details, bell, banner, admin billing
- [ ] Playwright E2E for the "Done when" scenarios
- [ ] Docs (ADR 0032, data-model, api, data, websocket, audit, error codes, secrets, compliance, Razorpay setup), CHANGELOGs, sign-off

## 5. Risks

| Risk                                                      | Mitigation                                                                                                             |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Double charge / double credit (retries, webhook + verify) | Unique idempotency keys per account, unique provider payment id, conditional state transitions, tests for every race   |
| Balance race (parallel calls)                             | Single conditional `findOneAndUpdate` per change inside a transaction; 50-parallel test; bench script                  |
| Wallet and ledger drift                                   | Same transaction always; daily reconciliation with alert; `balanceAfterMicros` snapshots                               |
| Float rounding in money                                   | Micros + bps integers only, `money.ts` single source, safe-integer asserts, table tests                                |
| Webhook forgery / replay                                  | HMAC on the raw body, timing-safe, event-id dedupe, amounts re-fetched from the provider                               |
| Provider down during top-up                               | Order saved first, provider errors → `failed`, user retries with a new order; webhook / verify both credit; expiry job |
| Calls overrun the hold when the balance ends              | Hold extension + graceful end (Phase 7) + settle allows a small overrun; new holds blocked until topped up             |
| GST / invoice rules wrong                                 | Configurable seller details, SAC, prefix; CA questions listed (§7); numbering per FY tested; credit notes deferred     |
| No Razorpay test keys yet                                 | Fake provider (same interface) for dev / tests / E2E; manual test-mode checklist when keys arrive                      |
| PDF fonts (₹) / Devanagari                                | Noto Sans embedded (OFL), billing text Latin-only, test                                                                |
| Stuck holds (crashed call / process)                      | Reaper every 5 min (2 h age); Phase 7 call-state aware                                                                 |
| Personal / payment data in logs                           | No card data ever touches us (Checkout); payment ids only; GSTIN / address not logged; E2E log scan                    |

## 6. Recommended order

| Day | Tasks        |
| --- | ------------ |
| 1   | T4.1         |
| 2   | T4.2, T4.3   |
| 3   | T4.3         |
| 4   | T4.4, T4.5   |
| 5   | T4.6         |
| 6   | T4.7, T4.8   |
| 7   | T4.8, T4.9   |
| 8   | T4.10        |
| 9   | T4.11, T4.12 |
| 10  | T4.12, T4.13 |
| 11  | T4.14        |
| 12  | T4.15        |

_Estimate — run batch-wise with one detailed run prompt (Batch 1 = T4.1–T4.5, Batch 2 = T4.6–T4.10, Batch 3 = T4.11–T4.15)._

## 7. Open questions (defaults used until answered)

| #   | Question                                                                                  | Who            | Default in Phase 4                                                             |
| --- | ----------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------ |
| 1   | Final selling rates (call / AI / TTS), pulse, are unanswered / ringing seconds billed?    | Client         | ₹1.00 / min, 60 s pulse, AI ₹6.00 / min, TTS ₹2.50 / 1k chars, unanswered free |
| 2   | Platform Razorpay account — test keys now, live keys before go-live                       | You / business | Fake provider until test keys arrive                                           |
| 3   | Seller legal name, address, GSTIN, state for invoices                                     | Business       | Env placeholders; invoices say "sample" in dev                                 |
| 4   | Tax invoice vs receipt voucher for prepaid recharges; SAC code; e-invoicing applicability | CA             | Tax invoice per recharge, SAC 998319, no e-invoice                             |
| 5   | Minimum / maximum recharge, free trial credit for new accounts                            | Business       | ₹100 – ₹5,00,000; no free credit (superadmin can credit)                       |
| 6   | Low-balance threshold default                                                             | Client         | ₹500                                                                           |
| 7   | Refund policy for unused balance                                                          | Business       | Manual (superadmin debit + Razorpay dashboard refund)                          |
| 8   | Invoice retention period                                                                  | CA             | 8 years                                                                        |

---

## Changelog

- 2026-10-09: Plan created after Phase 3 sign-off.
- 2026-10-09: Run prompt [PHASE_4_PROMPT.md](../prompts/PHASE_4_PROMPT.md) added (one file, 3 batches). Precisions there: module layout + route mounting (raw-body webhook before the JSON parser), deps injection (`billing: { storage, jobs, payments }`), wallet / ledger JSON, idempotency key formats, transaction purity (effects after commit — `withTransaction` re-runs callbacks), exact engine signatures and conditional-update shapes, extensions as child hold rows, Razorpay REST details (orders, payments, capture, both signatures, event-id header), fake provider shares the webhook path, top-up order states incl. `creating`, GST state list + GSTIN mod-36 checksum, billing text Latin-only (pdfkit can't shape Devanagari), FY numbering in IST, invoice PDF layout, email keys `wallet.receipt` / `wallet.low_balance`, notification visibility by stored permission, billing crons (UTC), new env vars + production refinements, 6 audit actions (→ 47), 2 error codes, `wallet.updated` payload adds `availableMicros` + `status`, `wallet.exhausted`; dependencies `pdfkit`, `unpdf` (tests), Noto Sans, `@mui/x-charts` 9.15 (MUI 9 peer OK).
- 2026-10-09: Batch 1 (T4.1–T4.5) done. Precisions / deviations: **notifications fan out one row per recipient** (`userId` required) instead of one account-wide row with `userId: null` — each user needs their own read state; the wallet declares `accountId` itself (the tenant plugin's plain index clashed with the unique one); **commission counts as call spend** in the month counters and the usage chart (one rule both can compute; was a pro-rata split); budgets: TTS charges count towards the AI budget; extending a hold refused for money returns `{ ok: false, reason: 'insufficient' | 'budget' }` (no `wallet.exhausted` by itself — that event is about available ≤ 0); WS `wallet.low_balance` is emitted on every crossing by the engine's event layer, notifications / emails by the alert hook (registered in `createApp`); settling a hold that was released without a charge → 409, settle / release replays are no-ops; `getOrCreateWallet` safety net; shared keyset cursor helper (audit log refactored onto it) and zone-aware day helpers; a security test enforces money writes only in `src/core/billing` and no float math there. Bug found and fixed: the Phase 1 idempotency in-progress test raced on a fixed 80 ms delay under load (now gated). Tests 936 → 1089.
- 2026-10-09: Batch 2 (T4.6–T4.10) done. Precisions / deviations: a **failed payment attempt does not block a later captured payment on the same order** (`failed → paid` allowed, like `expired → paid`); `fake-complete` builds and signs a webhook and runs the **same webhook path** as Razorpay; the wallet is ensured **before** the credit transaction (snapshot reads); `topups ↔ webhooks` share `payment-match.ts` (no import cycle); adjustment **Idempotency-Key scope = the superadmin's platform account** (`idempotencyKeys.accountId` is an ObjectId) — the target account is in the hashed path, so a key never replays against another account, and the engine key is `adjust:<target>:<key>`; `GET /admin/payments` filters by `account` (the tenant-scope guard forbids reading `query.accountId` in modules); invoice PDF table widths written as integer percents (keeps the no-float guard strict); the platform summary counts **unread** reconcile notices of the calling superadmin as "open". Bench (1,000 × hold → settle, single wallet): 1 worker 170 calls/s, 20 workers ~69 calls/s with p99 ≈ 5.8 s (write-conflict retries on one document) — correctness holds; Phase 8 must cap per-account concurrency (ADR 0032). Razorpay test mode: **pending input** (no test keys in `.env`). Tests 1089 → 1176.
