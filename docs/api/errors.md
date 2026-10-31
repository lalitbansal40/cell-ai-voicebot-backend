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

Quote `requestId` when you contact support. Branch on `code`, never on `message`, because messages can change.

| Status | Common codes                                                                                        | What to do                                             |
| ------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 400    | `REQUEST_MALFORMED`                                                                                 | Send valid JSON                                        |
| 401    | `AUTH_UNAUTHENTICATED`, `API_KEY_EXPIRED`                                                           | Check the `X-API-Key` header / create a new key        |
| 403    | `AUTH_FORBIDDEN`, `API_KEY_IP_DENIED`                                                               | Add the scope to the key / call from an allowed IP     |
| 404    | `RESOURCE_NOT_FOUND`                                                                                | The id doesn't exist in this account                   |
| 409    | `CONFLICT_DUPLICATE`, `CONFLICT_INVALID_STATE`, `WHATSAPP_WINDOW_CLOSED`, `IDEMPOTENCY_IN_PROGRESS` | Read the message; for windows, send a template instead |
| 422    | `VALIDATION_FAILED`, `WALLET_INSUFFICIENT_BALANCE`, `IDEMPOTENCY_KEY_REUSED`                        | Fix the request; top up the wallet                     |
| 429    | `RATE_LIMITED`                                                                                      | Wait `Retry-After` seconds                             |
| 5xx    | `INTERNAL_ERROR`, `PROVIDER_ERROR`, `PROVIDER_UNAVAILABLE`                                          | Retry later with the same `Idempotency-Key`            |
