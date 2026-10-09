# Razorpay — test mode setup & manual checklist

Wallet top-ups use Razorpay (ADR 0032). Day-to-day development, tests and E2E use the **fake provider** (`PAYMENT_PROVIDER=fake`, the default outside production) — you only need this guide to try the real checkout in **test mode** or to prepare production.

> Never commit keys. `.env` is git-ignored; secrets go only there (docs/conventions/secrets.md). Test keys start with `rzp_test_`, live keys with `rzp_live_` — live keys are for production only.

## 1. Test-mode keys

1. Razorpay Dashboard → switch to **Test Mode** (top bar).
2. **Account & Settings → API Keys → Generate Test Key** → copy the Key Id and Key Secret (the secret is shown once).
3. In `cell-ai-voicebot-backend/.env`:

   ```dotenv
   PAYMENT_PROVIDER=razorpay
   RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxx
   RAZORPAY_KEY_SECRET=<test key secret>
   RAZORPAY_WEBHOOK_SECRET=<the secret you type in step 3>
   ```

   Leave `FAKE_PAYMENT_SECRET` empty when the provider is `razorpay`. Restart `npm run dev` (the env is read once at start).

## 2. Expose the local API for webhooks

Razorpay must reach `POST /api/v1/webhooks/razorpay` on your machine (API port **5100**). Any tunnel works, for example:

```bash
cloudflared tunnel --url http://localhost:5100
# or
ngrok http 5100
```

Use the HTTPS URL it prints: `https://<tunnel-host>/api/v1/webhooks/razorpay`. Stop the tunnel when you are done — it exposes your dev API.

## 3. Webhook

Dashboard (Test Mode) → **Account & Settings → Webhooks → Add New Webhook**:

| Field         | Value                                                                                   |
| ------------- | --------------------------------------------------------------------------------------- |
| Webhook URL   | `https://<tunnel-host>/api/v1/webhooks/razorpay`                                        |
| Secret        | a long random string — the same value as `RAZORPAY_WEBHOOK_SECRET`                      |
| Active events | `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`, `refund.failed` |

What the API does with them:

| Event                             | Result                                                                                           | `paymentEvents.outcome`         |
| --------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------- |
| `payment.captured` / `order.paid` | Order paid + wallet credited + invoice (once — the second of verify / webhook is a no-op)        | `credited` / `duplicate_credit` |
| same, unknown order               | Superadmin bell "Payment for an unknown order"                                                   | `unmatched`                     |
| same, amount / currency differs   | Not credited, superadmin bell "Payment did not match its top-up"                                 | `mismatch`                      |
| `payment.failed`                  | Order `failed` with the gateway reason (a later successful attempt on the same order still pays) | `failed`                        |
| `refund.*`                        | Superadmin bell; **no automatic debit** — adjust the wallet by hand if needed                    | `refund`                        |
| anything else                     | Stored and ignored                                                                               | `ignored`                       |

Bad signature → `401`; the same `X-Razorpay-Event-Id` again → `200 { duplicate: true }`, nothing changes. Bodies and signatures are never logged.

## 4. Manual checklist (test mode)

Log in as an owner of a test account, open **Wallet → Add money**. Razorpay test cards / UPI ids are listed in the Razorpay docs ("Test card details" / "Test UPI").

| #   | Do                                                                  | Expect                                                                                                                                             |
| --- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Fill the billing profile, add ₹500, pay with a successful test card | Wallet +₹500 (not +₹590 — GST is not wallet money); order `paid`; invoice `ready` within seconds; receipt email (Mailpit in dev)                   |
| 2   | Open the invoice                                                    | PDF: "TAX INVOICE", number `CAV/<FY>/…`, your GSTIN (if set), CGST + SGST for a Rajasthan buyer (seller state 08), IGST otherwise, amount in words |
| 3   | Pay with a failing test card                                        | Checkout shows the error; order `failed` with the reason; wallet unchanged; `payment.failed` event `failed`                                        |
| 4   | **Webhook first:** close the tab right after paying (before verify) | Webhook credits the wallet once; when the page is reopened the order shows `paid`                                                                  |
| 5   | **Verify first:** stop the tunnel, pay, then start it again         | Verify credits; the delayed webhook arrives as `duplicate_credit` — still one credit, one invoice                                                  |
| 6   | Dashboard → Webhooks → resend an old delivery                       | `200`, `{ duplicate: true }`; nothing changes                                                                                                      |
| 7   | Refund a test payment from the dashboard                            | `refund` event; superadmin bell "A payment was refunded"; wallet **not** debited automatically                                                     |
| 8   | Change one character of the webhook secret in `.env`, restart, pay  | Webhooks get `401` (dashboard shows failures); verify still credits; put the secret back                                                           |
| 9   | Superadmin → Billing → Payments / Payment events                    | Every order and webhook from the steps above with its status / outcome                                                                             |
| 10  | `npm run dev` logs                                                  | No key secret, signature, card data, GSTIN or address in any line                                                                                  |

## 5. Production

- `PAYMENT_PROVIDER=razorpay` is required in production (the fake provider is refused); live keys + a new live webhook with its own secret pointing at the production API URL.
- `BILLING_SELLER_NAME`, `BILLING_SELLER_ADDRESS`, `BILLING_SELLER_GSTIN` and `BILLING_SELLER_STATE_CODE` are required in production (the API refuses to start without them; the GSTIN must belong to that state). Confirm the SAC code and invoice wording with the CA (docs/compliance/compliance-notes.md).
- `FAKE_PAYMENT_SECRET` must not be set in production.
- `BILLING_SIMULATOR_ENABLED` defaults to `false` in production — keep it off.
