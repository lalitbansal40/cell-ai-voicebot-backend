# Errors

Every error has the same shape, with an HTTP status and a stable `code`:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Check the highlighted fields.",
    "details": [{ "path": "body.phone", "message": "Not a valid phone number" }],
    "requestId": "8a1c2f0e-…"
  }
}
```

Quote `requestId` when you contact support. Branch on `code`, never on `message` — messages can change.

**Retry** only `429` (after `Retry-After`), `5xx` and network errors — with the **same** `Idempotency-Key`. Other `4xx` answers will not change until you change the request.

## Codes on public routes

<!-- errors:start -->

| Code                               | Status | What to do                                                                |
| ---------------------------------- | ------ | ------------------------------------------------------------------------- |
| `REQUEST_MALFORMED`                | 400    | Send valid JSON.                                                          |
| `VALIDATION_FAILED`                | 422    | Fix the fields listed in `details` (path + message).                      |
| `PAYLOAD_TOO_LARGE`                | 413    | Send a smaller body (1 MB) or fewer rows.                                 |
| `RATE_LIMITED`                     | 429    | Wait `Retry-After` seconds, then retry.                                   |
| `IDEMPOTENCY_KEY_REUSED`           | 422    | Use a new `Idempotency-Key` for a different request.                      |
| `IDEMPOTENCY_IN_PROGRESS`          | 409    | The first request with this key is still running — retry shortly.         |
| `RESOURCE_NOT_FOUND`               | 404    | The id does not exist in this account.                                    |
| `CONFLICT_DUPLICATE`               | 409    | A record with this phone / external id / name exists — see `details`.     |
| `CONFLICT_INVALID_STATE`           | 409    | The status does not allow this now — read the message.                    |
| `AUTH_UNAUTHENTICATED`             | 401    | Send a valid `X-API-Key`.                                                 |
| `AUTH_FORBIDDEN`                   | 403    | Add the scope in `details[0]` to the key, or call from an allowed IP.     |
| `API_KEY_EXPIRED`                  | 401    | Create a new key.                                                         |
| `API_KEY_IP_DENIED`                | 403    | Call from an IP on the key’s allowlist.                                   |
| `WALLET_INSUFFICIENT_BALANCE`      | 422    | Add money to the wallet.                                                  |
| `WALLET_BUDGET_EXCEEDED`           | 422    | Raise the monthly budget in Wallet → Settings.                            |
| `CONTACT_OPTED_OUT`                | 422    | The contact opted out — do not message them.                              |
| `WHATSAPP_WINDOW_CLOSED`           | 409    | Outside 24 hours since the customer wrote: send a template.               |
| `TEMPLATE_NOT_FOUND`               | 404    | Check the template name and language (`GET /whatsapp/templates`).         |
| `TEMPLATE_NOT_APPROVED`            | 409    | Only `APPROVED` templates can be sent.                                    |
| `TEMPLATE_PAUSED`                  | 409    | WhatsApp paused this template — use another one.                          |
| `TEMPLATE_VARIABLES_MISSING`       | 422    | Give every template variable a value.                                     |
| `CALL_LIMIT_REACHED`               | 429    | Too many calls at once for the account — retry later.                     |
| `CALL_CAPACITY`                    | 503    | The server is busy — retry later.                                         |
| `LINE_BUSY`                        | 409    | Every phone line is in use — retry later (campaigns wait by themselves).  |
| `NUMBER_NOT_ALLOWED`               | 422    | Only Indian mobiles and landlines can be called on the phone line.        |
| `CALLER_NUMBER_INVALID`            | 422    | Use a caller number from `GET /resources/phone-line`.                     |
| `CAMPAIGN_NOT_RUNNABLE`            | 409    | Fix what `details` lists (flow, agent, audio, audience), then start.      |
| `CAMPAIGN_LIMIT_REACHED`           | 429    | Too many active campaigns — finish or cancel one.                         |
| `CAMPAIGN_REVISION_CONFLICT`       | 409    | Someone else changed the campaign — read it again.                        |
| `WA_CAMPAIGN_NOT_EDITABLE`         | 409    | A started bulk campaign cannot be edited.                                 |
| `WA_CAMPAIGN_AUDIENCE_EMPTY`       | 422    | Nobody in the audience can get the message (opted out, DND, no WhatsApp). |
| `WHATSAPP_CALL_PERMISSION_MISSING` | 409    | The customer has not allowed calls from this number — ask first.          |
| `WHATSAPP_CALLING_DISABLED`        | 409    | Turn calling on for this WhatsApp number.                                 |
| `WHATSAPP_CALL_LIMIT_REACHED`      | 429    | WhatsApp’s call limit for this customer is reached — try later.           |
| `WEBHOOK_URL_BLOCKED`              | 422    | Use a public https URL.                                                   |
| `REPORT_RANGE_INVALID`             | 422    | Use a range of at most 366 days, `from` before `to`.                      |
| `VOICE_API_NOT_ENABLED`            | 403    | Recorded voice is not on for the account — contact support.               |
| `VOICE_API_NOT_PRICED`             | 409    | Recorded voice has no price yet — contact support.                        |
| `VOICE_API_AUDIO_INVALID`          | 422    | Use your own WAV / MP3 of at most 120 seconds.                            |
| `VOICE_API_IVR_MISSING`            | 409    | Use an IVR from `GET /resources/ivrs`.                                    |
| `PROVIDER_ERROR`                   | 502    | The provider refused the request — read the message.                      |
| `PROVIDER_UNAVAILABLE`             | 503    | A provider is down — retry later with the same `Idempotency-Key`.         |
| `INTERNAL_ERROR`                   | 500    | Retry later; quote `requestId` to support if it repeats.                  |

<!-- errors:end -->
