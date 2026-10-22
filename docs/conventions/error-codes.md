# Error Code Catalogue

Every API error returns `error.code` from this list ([api.md §4](api.md#4-error-envelope)). Format: **`DOMAIN_REASON`**, UPPER_SNAKE_CASE.

From Phase 1 the single source of truth is `src/shared/errors/error-codes.ts`; this document must stay in sync with that file (update both in the same PR).

| Code                          | HTTP | Meaning                                                                                                                                                                            | Phase |
| ----------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `REQUEST_MALFORMED`           | 400  | Body is not valid JSON or the request cannot be parsed                                                                                                                             | 1     |
| `VALIDATION_FAILED`           | 422  | One or more fields failed validation (see `details`)                                                                                                                               | 1     |
| `PAYLOAD_TOO_LARGE`           | 413  | Request body or upload exceeds the limit                                                                                                                                           | 1     |
| `UNSUPPORTED_MEDIA_TYPE`      | 415  | Wrong content type or file type                                                                                                                                                    | 1     |
| `RATE_LIMITED`                | 429  | Too many requests; see `Retry-After`                                                                                                                                               | 1     |
| `IDEMPOTENCY_KEY_REUSED`      | 422  | `Idempotency-Key` reused with a different request body                                                                                                                             | 1     |
| `IDEMPOTENCY_IN_PROGRESS`     | 409  | A request with the same `Idempotency-Key` is still running                                                                                                                         | 1     |
| `RESOURCE_NOT_FOUND`          | 404  | Resource does not exist in this account                                                                                                                                            | 1     |
| `CONFLICT_DUPLICATE`          | 409  | Unique value already exists (e.g. same phone in the account)                                                                                                                       | 1     |
| `CONFLICT_INVALID_STATE`      | 409  | Action not allowed in the current state (e.g. pause a completed campaign)                                                                                                          | 1     |
| `INTERNAL_ERROR`              | 500  | Unexpected server error (details only in logs, by `requestId`)                                                                                                                     | 1     |
| `AUTH_UNAUTHENTICATED`        | 401  | Missing or invalid credentials / token                                                                                                                                             | 2     |
| `AUTH_TOKEN_EXPIRED`          | 401  | Access token expired — refresh and retry                                                                                                                                           | 2     |
| `AUTH_INVALID_CREDENTIALS`    | 401  | Wrong email or password                                                                                                                                                            | 2     |
| `AUTH_FORBIDDEN`              | 403  | Authenticated but missing permission / API key scope                                                                                                                               | 2     |
| `AUTH_EMAIL_NOT_VERIFIED`     | 403  | Login / action before the signup email OTP was confirmed (UI shows the OTP screen)                                                                                                 | 2     |
| `AUTH_ACCOUNT_SUSPENDED`      | 403  | Write request on a suspended account (reads still allowed)                                                                                                                         | 2     |
| `AUTH_USER_DISABLED`          | 403  | Disabled team member tries to sign in or use a token                                                                                                                               | 2     |
| `AUTH_SESSION_REVOKED`        | 401  | Refresh token revoked, expired or reused (whole session family revoked) — sign in again                                                                                            | 2     |
| `AUTH_CODE_INVALID`           | 422  | Wrong / expired / used email OTP, reset link or invite link                                                                                                                        | 2     |
| `AUTH_TOO_MANY_ATTEMPTS`      | 429  | Login lockout, too many OTP tries or resend cooldown (`Retry-After` header)                                                                                                        | 2     |
| `AUTH_IMPERSONATION_BLOCKED`  | 403  | Action not allowed while a superadmin is viewing as the user                                                                                                                       | 2     |
| `IMPORT_FILE_INVALID`         | 422  | Uploaded sheet can't be used: unreadable, empty, no header row, too many rows / columns, unsafe (zip bomb) — `details[].message` says why                                          | 3     |
| `CONTACT_DND`                 | 422  | Contact is on the account's do-not-call list                                                                                                                                       | 3     |
| `CONTACT_OPTED_OUT`           | 422  | Contact opted out of calls                                                                                                                                                         | 3     |
| `WALLET_INSUFFICIENT_BALANCE` | 422  | Not enough available balance for this action                                                                                                                                       | 4     |
| `WALLET_BUDGET_EXCEEDED`      | 422  | Monthly spend budget reached                                                                                                                                                       | 4     |
| `BILLING_PROFILE_REQUIRED`    | 422  | Billing details (legal name, address, GST state) must be saved before a wallet top-up                                                                                              | 4     |
| `PAYMENT_VERIFICATION_FAILED` | 422  | Checkout signature wrong, payment not captured, or amount / currency / order don't match the top-up order                                                                          | 4     |
| `AI_UNAVAILABLE`              | 503  | Voice AI provider unavailable                                                                                                                                                      | 5/7   |
| `FLOW_INVALID`                | 422  | Call flow fails validation (dangling nodes, missing end, …)                                                                                                                        | 6     |
| `CALL_OUTSIDE_WINDOW`         | 422  | Call blocked: outside the allowed calling window                                                                                                                                   | 7/8   |
| `CAMPAIGN_NOT_RUNNABLE`       | 409  | Campaign cannot start (no contacts, flow not published / without the campaign trigger, agent off, missing audio, live mode without a phone line, …; `details[]` list the problems) | 8     |
| `PROVIDER_UNAVAILABLE`        | 503  | Telephony / external provider unreachable                                                                                                                                          | 7/13  |
| `PROVIDER_ERROR`              | 502  | Telephony / external provider returned an error                                                                                                                                    | 7/13  |
| `AI_SPEND_CAP_REACHED`        | 422  | The agent's daily / monthly spending cap is reached (agent set to stop at the cap)                                                                                                 | 5     |
| `AGENT_INACTIVE`              | 409  | The AI agent is turned off                                                                                                                                                         | 5     |
| `FUNCTION_URL_BLOCKED`        | 422  | An agent function / knowledge URL points at a blocked address (private, metadata, wrong scheme or port)                                                                            | 5     |
| `KNOWLEDGE_LIMIT_REACHED`     | 422  | Knowledge base limit reached (knowledge bases per account, sources per base or chunks per base)                                                                                    | 5     |
| `FLOW_REVISION_CONFLICT`      | 409  | The flow draft was saved by someone else since it was loaded — `details` carry the current `revision`, `updatedBy`, `updatedAt`                                                    | 6     |
| `RESOURCE_IN_USE`             | 409  | The item is used elsewhere (agent / audio used by flows, flow used by campaigns) — `details[]` list the users (`id`, `message` = name)                                             | 6     |
| `CALL_LIMIT_REACHED`          | 429  | The account already has its maximum number of calls running (web test calls: 3)                                                                                                    | 7     |
| `CALL_CAPACITY`               | 503  | This server instance is at its call limit — retry shortly                                                                                                                          | 7     |
| `CALL_NOT_ACTIVE`             | 409  | The call is not running (hang up of an ended call, media for a finished call)                                                                                                      | 7     |
| `CALL_NOT_ALLOWED`            | 422  | The contact can't be called now: on the do-not-call list, opted out, or a daily / weekly / gap cap reached (`details[].message` says which)                                        | 8     |
| `CAMPAIGN_LIMIT_REACHED`      | 429  | Too many active (scheduled / running / paused) campaigns for the account                                                                                                           | 8     |
| `CAMPAIGN_REVISION_CONFLICT`  | 409  | A campaign edit sent a stale `revision` (someone else saved first)                                                                                                                 | 8     |
| `WHATSAPP_NOT_CONFIGURED`     | 503  | WhatsApp is turned off / not configured on this server (`WHATSAPP_ENABLED=false`)                                                                                                  | 9     |
| `WHATSAPP_SIGNUP_FAILED`      | 422  | Embedded Signup could not be completed (code expired / used, no WhatsApp account or permission shared) — `details[0].path = 'step'`                                                | 9     |
| `WHATSAPP_NUMBER_IN_USE`      | 409  | The number is connected (not disconnected) in another account                                                                                                                      | 9     |
| `WHATSAPP_CHANNEL_LIMIT`      | 409  | The account already has the maximum number of connected WhatsApp numbers                                                                                                           | 9     |
| `WHATSAPP_CHANNEL_NOT_READY`  | 409  | The WhatsApp number needs its setup finished or a reconnect before this action                                                                                                     | 9     |
| `META_API_ERROR`              | 502  | The Meta Graph API returned an error — `details` carry Meta's `code`, `subcode`, `fbtraceId` (never tokens)                                                                        | 9     |
| `META_SIGNATURE_INVALID`      | 401  | A Meta webhook / `signed_request` signature is missing or wrong                                                                                                                    | 9     |
| `WHATSAPP_WINDOW_CLOSED`      | 409  | The customer's 24-hour service window is closed — only internal notes (templates arrive in Phase 11); `details[0].path = 'windowExpiresAt'`                                        | 10    |
| `WHATSAPP_RECIPIENT_BLOCKED`  | 409  | The team blocked this customer on WhatsApp — unblock to reply                                                                                                                      | 10    |
| `WHATSAPP_MEDIA_INVALID`      | 422  | The file is not allowed for its kind or its content doesn't match (sniffed), a voice note is stereo / corrupt / too long / too short — `details[0].message` names the reason       | 10    |
| `WHATSAPP_MEDIA_TOO_LARGE`    | 413  | The file is larger than WhatsApp allows for its kind — `details[0].message` carries the limit                                                                                      | 10    |
| `INBOX_MEDIA_EXPIRED`         | 410  | Media of an inbound message older than 7 days can't be downloaded from Meta any more                                                                                               | 10    |

`FLOW_INVALID` details are the validation issues: `{ path, message, issue, severity, nodeId?, edgeId? }` (Phase 6).

AI provider failures (OpenAI) reuse `PROVIDER_UNAVAILABLE` (timeout, 429 / 5xx after retries, network) and `PROVIDER_ERROR` (rejected request) — Phase 5.

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
