# Rate limits

Each key may make **600 reads** (`GET`) and **60 writes** (`POST` / `PATCH` / `DELETE`) a minute. Every response carries `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`. Over the limit, the API answers `429 RATE_LIMITED` with `Retry-After` (seconds).

- Use the bulk route for many contacts: `POST /contacts/bulk-upsert`, up to 1,000 per request with a result per row.
- Use webhooks instead of polling for call results and message statuses.
- Ask support if your account needs higher limits.
