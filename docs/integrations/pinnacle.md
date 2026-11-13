# Managed WhatsApp numbers (Pinnacle partner API)

A **managed number** is a WhatsApp number onboarded at Pinnacle (our partner, panel `wa1.cell24x7.com`) rather than through our own Embedded Signup. Every API call for it goes to **Pinnacle's API**; every event for it arrives on our **Pinnacle webhook**. Customers see a normal number with a "Managed" badge. Messages, templates, media, the business profile, the inbox, campaigns and WhatsApp AI / team calling all work unchanged.

Plan: `docs/prompts/PINNACLE_PROVIDER_PROMPT.md`. Sign-off: `docs/phases/PINNACLE_SIGNOFF.md`.

## How it works

1. **Onboarding at Pinnacle.** The customer is onboarded in Pinnacle's panel. The WABA appears under _Tech Provider → Tech Provider Customers_.
2. **Credit line.** In the same panel, request the **credit line** for the WABA. Meta then bills Pinnacle, Pinnacle bills our wallet, and we charge the customer from their wallet (platform pays Meta).
3. **Add managed number (superadmin).** We check the key with Pinnacle (`getuserdetails`) and read the WABA and number details through Pinnacle. Then we call Pinnacle `setwebhook` with our URL and a secret header, and read it back with `getwebhook`. If the read-back doesn't match, nothing is saved.
4. **Running.** Callbacks reach `POST /api/v1/webhooks/pinnacle/{channelId}`; they are Meta's payload, unchanged. From here, events go through the same store, queue and handlers as Meta's own webhooks.

| What                              | Where                                                                                                                                                                        |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client                            | `src/core/meta/pinnacle.client.ts` (`createPinnacleClient`): Meta's Graph paths under `https://partnersv1.pinbot.ai/v3`, header `apikey`; calls on `PINNACLE_VOICE_BASE_URL` |
| Fake                              | `src/core/meta/fake-pinnacle.ts`. Key `pin_test_…` = valid, `pin_bad_…` = invalid, `pin_low_…` = "Insufficient Balance" on sends / calls                                     |
| Per-number routing                | `clientFor(ctx, channel)` in `src/modules/whatsapp/context.ts`; guard test `src/core/meta/routing.guard.test.ts`                                                             |
| Webhook                           | `src/modules/whatsapp/pinnacle-webhooks.*`; shared ingest `ingestEnvelope` in `webhooks.service.ts`                                                                          |
| Add / key / webhook / credit line | `connectManaged`, `replaceManagedKey`, `resetManagedWebhook`, `setManagedCreditLine` in `whatsapp.service.ts`                                                                |
| Health                            | `syncChannel` → `syncManaged` (daily health pass and "Sync")                                                                                                                 |
| Balance alerts                    | `src/modules/whatsapp/provider-alerts.ts`                                                                                                                                    |

## Runbook — add a managed number

**Before you start:** `PINNACLE_ENABLED=true` on the server, and `APP_URL` is the public https API URL. The URL is part of the webhook Pinnacle calls.

1. **In Pinnacle's panel:**
   - _Whatsapp → Manage Accounts_: copy the **WABA ID** and the **phone number ID**.
   - _Admin → Manage API Keys_: copy the number's **API key**.
   - _Tech Provider → Tech Provider Customers_: check the **Credit-line request** column. It shows NA, requested, or approved.
2. **On our platform:** Admin → Accounts → the customer → WhatsApp → **Add managed number (Pinnacle)**.
   - Enter a label, the WABA ID, the phone number ID and the API key.
   - Under "Credit line at the partner", pick **Active** only if the panel shows the credit line as approved; otherwise pick **Requested**.
3. **Submit.** The dialog checks the key and sets the webhook.
   - **Active:** the number is **Connected**.
   - **Requested:** it is **Action needed — billing is being activated**. Sends and calls are blocked until you switch the credit line to **Active**.
4. **Check:**
   - The number card shows "Webhook set" with a time.
   - Send one test message (with the owner's permission).

### Other actions (number card, superadmin only)

- **Replace API key:** after Pinnacle issues a new key. The new key is checked and the webhook is set with it.
- **Reset webhook:** gives the number a new secret and sets the webhook again. Use it after someone changed the callback in Pinnacle's panel (_Whatsapp → Multiple Callback_). The daily health pass also re-sets the webhook once by itself.
- **Credit line Requested / Active:** mirrors the panel. Switch to Active only after Pinnacle approved it.
- **Disconnect:** we clear our webhook at Pinnacle (best effort) and wipe the key. The number stays in Pinnacle's panel.

### Revoking the credit line

Revoking is done in Pinnacle's panel or through their revocation API. We never call it. **A revoke applies to every WABA of the business portfolio and can't be undone.** After a revoke, switch the number to **Requested**, or disconnect it.

## Registration

A number Meta still shows as **Pending** isn't registered on the Cloud API. When it is added, we register it through the partner at once with the platform PIN (`WHATSAPP_REGISTER_PIN`, built-in default — nothing to set on the server). If that fails, the number card shows **Register number**. If the number already has its own two-step PIN, the card asks for it (**Enter PIN**). The same applies to numbers connected through Embedded Signup.

## Status reasons

| Reason code                    | Shown to the owner                         | What to do                                                                                                            |
| ------------------------------ | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `partner_credit_line_pending`  | Billing for this number is being activated | Approve the credit line in the panel → switch to **Active**                                                           |
| `provider_key_invalid`         | Needs attention from support               | **Replace API key**                                                                                                   |
| `provider_number_missing`      | Needs attention from support               | The key no longer lists the number: replace the key, or check the number in the panel                                 |
| `provider_webhook_mismatch`    | Needs attention from support               | **Reset webhook**; check _Multiple Callback_ in the panel                                                             |
| `register_at_partner`          | Being registered                           | **Register number** on the number card (uses `WHATSAPP_REGISTER_PIN`), or register in Pinnacle's panel, then **Sync** |
| `pin_required`                 | Enter PIN                                  | The number has its own two-step PIN: enter it in **Enter PIN**                                                        |
| calling `provider_unsupported` | Calling not available on this number       | Ask Pinnacle to enable WhatsApp Voice (_Admin → Whatsapp Voice Requests_)                                             |

## Partner balance

When Pinnacle answers "Insufficient Balance":

- the message or call **fails**; the bubble reads "The partner account balance is low — contact support";
- the message is **not** retried;
- wallet holds are released;
- superadmins get the **"Partner WhatsApp balance is low"** bell, at most once an hour;
- the number stays connected.

Top up the Pinnacle wallet, then resend.

## Not available for managed numbers

- Coexistence (WhatsApp Business app) numbers.
- Two-step PIN register from our side.
- Our Meta credit line.
- Meta pricing / call analytics reconciliation: these numbers are skipped, because Pinnacle bills us.
- Embedded Signup from our dashboard. Managed numbers are only added by superadmins.

## Admin API

All routes below are superadmin only, refused while impersonating, and answer `503 WA_PROVIDER_NOT_CONFIGURED` when `PINNACLE_ENABLED` is off.

- `POST /api/v1/admin/accounts/{id}/whatsapp/managed-numbers` with body `{ label, wabaId, phoneNumberId, apiKey, creditLine: "partner_pending" | "partner_active" }` → `201 { channel, outcome }`. Errors:
  - `PINNACLE_KEY_INVALID` (422)
  - `PINNACLE_NUMBER_NOT_ON_KEY` (422)
  - `WHATSAPP_NUMBER_IN_USE` (409)
  - `PINNACLE_WEBHOOK_NOT_SET` (502; nothing saved)
  - `WA_PROVIDER_ERROR` (502)
- `POST /api/v1/admin/whatsapp/channels/{id}/managed/api-key` with body `{ apiKey }`.
- `POST /api/v1/admin/whatsapp/channels/{id}/managed/webhook`.
- `POST /api/v1/admin/whatsapp/channels/{id}/managed/credit-line` with body `{ status }`.
- `GET /api/v1/admin/whatsapp/status` → `pinnacle { enabled, baseUrl, voiceBaseUrl }`.
- `GET /api/v1/admin/accounts/{id}` → per number: `provider`, `managed`, `pinnacle { keyLast4, webhookUrl, webhookSetAt, keyCheckedAt, lastBalanceErrorAt }`. The response never contains the key or the secret.

**Webhook (public):**

- `POST /api/v1/webhooks/pinnacle/{channelId}`, header `x-cell-webhook-secret`:
  - `403 PINNACLE_WEBHOOK_FORBIDDEN` when the secret is wrong or missing;
  - `404` for an unknown or disconnected number;
  - changes for another number are dropped.
- `GET` on the same path answers `ok`.
- Meta's own deliveries for a managed number are dropped. The same event arriving on both paths is stored once (idempotency key).

**Dev (fake provider):** `POST /api/v1/dev/meta/managed-number` returns a fake number and its `pin_test_…` key to try the dialog.

## Env

| Variable                  | Default                        | Notes                                                                                                |
| ------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `PINNACLE_ENABLED`        | `false`                        | Needs `WHATSAPP_ENABLED`                                                                             |
| `PINNACLE_BASE_URL`       | `https://partnersv1.pinbot.ai` | https in production                                                                                  |
| `PINNACLE_VOICE_BASE_URL` | = base                         | WhatsApp Voice host. **Ask Pinnacle for the production host** (their doc shows a test load balancer) |
| `PINNACLE_TIMEOUT_MS`     | `15000`                        | 2000–60000                                                                                           |
| `WHATSAPP_REGISTER_PIN`   | built-in platform PIN          | 6-digit two-step PIN used to register numbers; override only if needed                               |

## Open with Pinnacle

1. Production host of the WhatsApp Voice API.
2. Are `calls` webhooks (connect with SDP, terminate) relayed by `setwebhook` unchanged and quickly?
3. SDP passthrough both ways: business-initiated `connect`, and user-initiated `pre_accept` / `accept`.
4. Exact paths for phone number and profile reads (`/v3/business/{id}`), block users and media delete.
5. Rate limits per key and number.
6. Does `setwebhook` override the panel's _Multiple Callback_, and is it allowed for numbers onboarded through their Embedded Signup? Does `getwebhook` echo our headers? We accept the read-back without headers.
7. Callback source IPs.
8. Pricing / conversation analytics for reconciliation.
