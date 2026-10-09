# Error Code Catalogue

Every API error returns `error.code` from this list ([api.md §4](api.md#4-error-envelope)). Format: **`DOMAIN_REASON`**, UPPER_SNAKE_CASE.

From Phase 1 the single source of truth is `src/shared/errors/error-codes.ts`; this document must stay in sync with that file (update both in the same PR).

| Code                          | HTTP | Meaning                                                                                                                                   | Phase |
| ----------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `REQUEST_MALFORMED`           | 400  | Body is not valid JSON or the request cannot be parsed                                                                                    | 1     |
| `VALIDATION_FAILED`           | 422  | One or more fields failed validation (see `details`)                                                                                      | 1     |
| `PAYLOAD_TOO_LARGE`           | 413  | Request body or upload exceeds the limit                                                                                                  | 1     |
| `UNSUPPORTED_MEDIA_TYPE`      | 415  | Wrong content type or file type                                                                                                           | 1     |
| `RATE_LIMITED`                | 429  | Too many requests; see `Retry-After`                                                                                                      | 1     |
| `IDEMPOTENCY_KEY_REUSED`      | 422  | `Idempotency-Key` reused with a different request body                                                                                    | 1     |
| `IDEMPOTENCY_IN_PROGRESS`     | 409  | A request with the same `Idempotency-Key` is still running                                                                                | 1     |
| `RESOURCE_NOT_FOUND`          | 404  | Resource does not exist in this account                                                                                                   | 1     |
| `CONFLICT_DUPLICATE`          | 409  | Unique value already exists (e.g. same phone in the account)                                                                              | 1     |
| `CONFLICT_INVALID_STATE`      | 409  | Action not allowed in the current state (e.g. pause a completed campaign)                                                                 | 1     |
| `INTERNAL_ERROR`              | 500  | Unexpected server error (details only in logs, by `requestId`)                                                                            | 1     |
| `AUTH_UNAUTHENTICATED`        | 401  | Missing or invalid credentials / token                                                                                                    | 2     |
| `AUTH_TOKEN_EXPIRED`          | 401  | Access token expired — refresh and retry                                                                                                  | 2     |
| `AUTH_INVALID_CREDENTIALS`    | 401  | Wrong email or password                                                                                                                   | 2     |
| `AUTH_FORBIDDEN`              | 403  | Authenticated but missing permission / API key scope                                                                                      | 2     |
| `AUTH_EMAIL_NOT_VERIFIED`     | 403  | Login / action before the signup email OTP was confirmed (UI shows the OTP screen)                                                        | 2     |
| `AUTH_ACCOUNT_SUSPENDED`      | 403  | Write request on a suspended account (reads still allowed)                                                                                | 2     |
| `AUTH_USER_DISABLED`          | 403  | Disabled team member tries to sign in or use a token                                                                                      | 2     |
| `AUTH_SESSION_REVOKED`        | 401  | Refresh token revoked, expired or reused (whole session family revoked) — sign in again                                                   | 2     |
| `AUTH_CODE_INVALID`           | 422  | Wrong / expired / used email OTP, reset link or invite link                                                                               | 2     |
| `AUTH_TOO_MANY_ATTEMPTS`      | 429  | Login lockout, too many OTP tries or resend cooldown (`Retry-After` header)                                                               | 2     |
| `AUTH_IMPERSONATION_BLOCKED`  | 403  | Action not allowed while a superadmin is viewing as the user                                                                              | 2     |
| `IMPORT_FILE_INVALID`         | 422  | Uploaded sheet can't be used: unreadable, empty, no header row, too many rows / columns, unsafe (zip bomb) — `details[].message` says why | 3     |
| `CONTACT_DND`                 | 422  | Contact is on the account's do-not-call list                                                                                              | 3     |
| `CONTACT_OPTED_OUT`           | 422  | Contact opted out of calls                                                                                                                | 3     |
| `WALLET_INSUFFICIENT_BALANCE` | 422  | Not enough available balance for this action                                                                                              | 4     |
| `WALLET_BUDGET_EXCEEDED`      | 422  | Monthly spend budget reached                                                                                                              | 4     |
| `BILLING_PROFILE_REQUIRED`    | 422  | Billing details (legal name, address, GST state) must be saved before a wallet top-up                                                     | 4     |
| `PAYMENT_VERIFICATION_FAILED` | 422  | Checkout signature wrong, payment not captured, or amount / currency / order don't match the top-up order                                 | 4     |
| `AI_UNAVAILABLE`              | 503  | Voice AI provider unavailable                                                                                                             | 5/7   |
| `FLOW_INVALID`                | 422  | Call flow fails validation (dangling nodes, missing end, …)                                                                               | 6     |
| `CALL_OUTSIDE_WINDOW`         | 422  | Call blocked: outside the allowed calling window                                                                                          | 7/8   |
| `CAMPAIGN_NOT_RUNNABLE`       | 409  | Campaign cannot start (no contacts, no published flow, no caller number, …)                                                               | 8     |
| `PROVIDER_UNAVAILABLE`        | 503  | Telephony / external provider unreachable                                                                                                 | 7/13  |
| `PROVIDER_ERROR`              | 502  | Telephony / external provider returned an error                                                                                           | 7/13  |

## Client-only codes (frontend — never sent by the server)

The dashboard turns every failed request into an `ApiError` (`src/services/api/errors.ts` in the frontend repo). When there is no valid error envelope it uses one of these codes; `status` is `0` when no response arrived.

| Code               | Status      | When                                                                        |
| ------------------ | ----------- | --------------------------------------------------------------------------- |
| `NETWORK_ERROR`    | — (0)       | No response (server down, offline, CORS blocked, DNS)                       |
| `TIMEOUT`          | — (0)       | Request exceeded the client timeout (15 s)                                  |
| `REQUEST_CANCELED` | — (0)       | Request aborted by the app (navigation, unmount)                            |
| `UNKNOWN_ERROR`    | as received | Response without a valid envelope (e.g. proxy 502 HTML) or a non-HTTP error |

These codes are **not** in `error-codes.ts` (the sync test only reads rows with a numeric status) and must never be returned by the API.

## Rules

1. Add new codes here **and** in `error-codes.ts` together; never reuse a code for a different meaning.
2. Prefer an existing generic code over inventing a near-duplicate.
3. `message` text can change; `code` is a stable contract for clients.
