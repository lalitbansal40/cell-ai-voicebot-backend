# Rate limits

Each key may make **600 reads** (`GET`) and **60 writes** (`POST` / `PATCH` / `DELETE`) a minute. Every response carries `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`. Over the limit, the API answers `429 RATE_LIMITED` with `Retry-After` (seconds).

- Use the bulk route for many contacts: `POST /contacts/bulk-upsert`, up to 1,000 per request with a result per row.
- Use webhooks instead of polling for call results and message statuses.
- Ask support if your account needs higher limits.

## Named limiters

Beyond the per-key defaults above, a few routes carry their own named limiter (window and limit fixed, keyed per account or per IP):

| Limiter key                | Window | Limit | Keyed by         | Used by                                                                  |
| -------------------------- | ------ | ----- | ---------------- | ------------------------------------------------------------------------ |
| `signup-ip`                | 1 h    | 5     | client IP        | `POST /auth/signup`                                                      |
| `login-as`                 | 1 h    | 30    | account          | superadmin / reseller log-in-as                                          |
| `reseller-customer-create` | 1 day  | 50    | reseller account | `POST /reseller/customers`                                               |
| `reseller-credit`          | 1 h    | 60    | reseller account | `POST /reseller/customers/:id/credit` (give + reclaim share the limiter) |
| `wa-campaign-create`       | 1 h    | 30    | account          | `POST /whatsapp-campaigns`                                               |

## Phase 19 sender pacing

In addition to request limiters, all outbound WhatsApp attempts share the Redis sender
pacer: known Cloud API 75/sec, Business App/coexistence or unknown 18/sec. The optional
`WA_CAMPAIGN_MPS` only lowers the derived limit. Redis time, a rolling 1000ms window,
minimum spacing and a two-second key TTL prevent process-local resets/bursts. Inbox
priority 1 precedes bulk priority 10. Daily messaging tiers and provider backoff remain.
Signup uses a separate `rl:signup:` store/window; it does not reuse the auth store.

`GET /auth/signup-options` uses the auth limiter; it does not consume the signup allowance.
