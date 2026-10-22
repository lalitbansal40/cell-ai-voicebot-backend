# 0037 — WhatsApp channels & Meta integration

- **Status:** accepted
- **Date:** 2026-10-22

## Context

Phase 9 lets a customer account connect its WhatsApp Business numbers through Meta's **Embedded Signup**, so later phases can chat (10), send templates (11), call (12) and run bulk campaigns (20) on them. We are a Meta Tech / Solution Partner: the customer grants our app access to their WhatsApp Business Account (WABA), and we act on it with a business token. Two owner decisions shape the design: Meta billing must work **either** on our credit line (platform pays Meta, the wallet charges the customer later) **or** with the customer's own payment method; and numbers that stay on the **WhatsApp Business app** (coexistence) must work, including messages the business sends from its phone. The real Meta app is created later — everything must be built and tested without Meta.

## Options considered

1. **A `MetaClient` interface with a Graph implementation and a deterministic fake; server-side token exchange; one stored webhook event per change.** Chosen.
2. **Meta's Node SDK / a third-party BSP API** — less code, but hides the Graph errors we must map, ties tests to network mocks and adds a vendor between us and Meta.
3. **Front-end token flow (`response_type: token`)** — simpler signup, but the browser would hold a business token and the token would be a short-lived user token.
4. **Process webhooks inline in the HTTP request** — no queue, but Meta wants a fast 200, and a slow handler or a crash would lose events.

## Decision

- **`MetaClient`** (`src/core/meta`): `createGraphMetaClient` (plain `fetch`, timeout, 3 retries with backoff + jitter on network / 5xx / rate-limit codes, error mapping to `MetaApiError` with `retryable` / `tokenInvalid`, messages scrubbed of tokens / secrets / codes, the two query-credential calls never logged) and `createFakeMetaClient` (state in Redis, deterministic ids from business + phone, single-use `fake.` codes, revocable tokens, error knobs). Both answer with Meta-shaped JSON parsed by the same zod schemas, checked against fixtures from Meta's documented samples. `META_PROVIDER` picks one; production requires `meta`.
- **Embedded Signup verification:** the browser sends only the `code` (+ the session's WABA / phone ids as **hints**). The server exchanges the code, calls `debug_token` (both WhatsApp scopes required) and accepts only WABA ids the token was granted; then resolves the number, checks duplicates, fetches details, subscribes the app, sets up billing, registers the number with a fresh 6-digit PIN (Cloud API) or requests the coexistence contacts + history syncs. A failure after a valid token saves the channel `action_needed` with the failed step; Retry setup resumes there.
- **Token storage:** business tokens and PINs are sealed (AES-256-GCM, `ENCRYPTION_KEY`), `select: false`, never in responses, WS, audit, notifications, emails or logs; `getChannelToken` is the only server-side way to open one.
- **One number → one active channel** platform-wide: a partial unique index on `phoneNumberId` (non-disconnected) plus a Redis lock per number; the same account reconnects the same record (history kept), another account gets `WHATSAPP_NUMBER_IN_USE`.
- **Billing modes:** per account, set by a superadmin before connecting — `platform`: our System User joins the WABA and our credit line is attached (`whatsapp_credit_sharing_and_attach`); `customer`: nothing is attached, `paymentMethodOk` follows the WABA's funding. A credit line can't be removed from a WABA, so the mode is copied to the channel at connect and kept once attached.
- **Webhook pipeline:** `POST /webhooks/meta` checks `X-Hub-Signature-256` over the raw body, stores one sealed `metaWebhookEvents` row per `entry × change` (sha256 idempotency key), queues `webhook.process` (job id `wa-event-<id>`) and answers 200; storage / queue failure answers 503 so Meta retries, and a redelivery of a stored-but-unprocessed event is queued again. The worker routes by phone number id or WABA, runs the Phase 9 handlers (account update, quality, name, capability, coexistence echoes / history / contacts) and keeps everything else **deferred** (`listDeferred` / `markConsumed` for Phases 10–12). Events expire after 7 days (deferred coexistence and unhandled fields after 30).
- **Health:** a daily pass and "Sync now" re-check every active channel (token, details); status transitions write history, push `whatsapp.channel.updated`, audit system changes and notify owners / admins (email for needs-reconnect, restricted, admin disconnect) once per transition.
- **Disconnect** clears the token and PIN and unsubscribes the app only when no other active channel uses the WABA; the number is **never deregistered** at Meta.
- **Manual connect** (superadmin) takes a System User token instead of a code for the platform's own test number — same steps from `debug_token` on.
- **Meta app callbacks:** deauthorize and data deletion (`signed_request`, constant-time HMAC, 1-day age limit); data deletion clears that user's tokens / PINs and answers `{ url, confirmation_code }` with a public status page.
- **Dev simulator:** `POST /dev/meta/webhooks` builds Meta-shaped payloads, updates the fake Meta and hands a signed body to the real receiver — no shortcut around the pipeline.

## Consequences

- **Positive:** the whole phase runs and is tested without Meta (unit, stub-server, integration, 1,000-event burst, worker restart, E2E later); the real switch is env-only (`docs/setup/meta-whatsapp.md`); later phases get a stable contract (`MetaClient`, `getChannelToken`, deferred events, channel fields).
- **Negative / trade-offs:** the fake can drift from Meta — fixtures must be re-checked against Meta's docs at setup (Graph version, Embedded Signup event names, coexistence sync API and window, the credit-sharing method Meta is replacing); webhook events are stored twice in effect (row + queue job); WABA-level events are matched to numbers by display number.
- **Follow-ups:** Phase 10 consumes `messages` / echoes / history; Phase 11 templates + Meta charges in the wallet; Phase 12 calls (not on coexistence numbers); Phase 13 App Review with the real app.
