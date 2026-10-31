# Idempotency

`POST` requests that cost money or reach your customers need an **`Idempotency-Key`** header. Examples are sending a message, starting a call and starting a campaign. Use any unique string of your own, such as your record id plus the action.

- The same key and the same body within **24 hours** returns the first response again, with `Idempotent-Replayed: true`. Nothing is sent twice.
- The same key with a **different** body gets `422 IDEMPOTENCY_KEY_REUSED`.
- The same key while the first request is still running gets `409 IDEMPOTENCY_IN_PROGRESS`. Retry in a moment.
- `5xx` answers are not stored, so a retry with the same key runs again.

Retry network errors and `5xx` answers with the **same** key. Use a **new** key only for a new action.
