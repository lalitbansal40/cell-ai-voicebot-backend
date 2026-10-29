# 0046 — Outbound webhooks: an outbox row in the emitting code path, one job per attempt, HMAC over the raw bytes, the AI-function URL guard at save and delivery

- **Status:** accepted
- **Date:** 2026-10-29

## Context

Phase 15 sends account events (calls, campaigns, WhatsApp messages and calls, opt-outs) to the client's own systems (LMS, CRM, Zapier / Make / n8n, a Google Sheet). Events happen in many code paths, some inside Mongo transactions. Receivers are slow, down or wrong; a URL is user input and could point at our own network (SSRF). Payloads may carry personal data. Phase 5 already has an SSRF guard (AI functions and knowledge URLs: resolve, check every address, dial the pinned one) and a secret box (AES-GCM with `ENCRYPTION_KEY`).

## Options considered

1. **Send from the code path** (HTTP inline) — blocks the caller, loses events when the receiver is down.
2. **Outbox row + queued delivery** — the code path only writes a row; a worker sends.
3. Retries: **BullMQ attempts + backoff** on one job vs **one job per attempt** (our schedule, job id per attempt).
4. One job per event for all endpoints vs **one per event × endpoint**.
5. Signature over the parsed JSON vs **over the exact bytes sent**.

## Decision

Options 2, one job per attempt, one per event × endpoint, raw bytes.

- **Outbox:** `emitAccountEvent(accountId, type, data, { session? })` (`modules/webhooks/events.ts`) is the only publisher. It writes `webhookEvents` (`_id = evt_<ULID>`, TTL 30 days) — inside the caller's transaction when given — and fans out only after that session ended **and** the row exists (a rolled-back transaction sends nothing). Fan-out: one `webhookDeliveries` row per active endpoint that takes the type (`events` or `*`), unique `{ endpointId, eventId }`, and one `webhooks.deliver` job. It never throws into the caller (logs counts).
- **Delivery** (`deliver.job.ts`, queue `webhooks`, concurrency 20 per process): job id `wh-<deliveryId>-<attempt>`, data = ids only. A job for an attempt already made is a no-op (compare-and-set on `attempt`). Failure → the next attempt is a new delayed job after 1 m, 5 m, 30 m, 2 h, 12 h; after the 6th attempt the delivery is `gave_up`. 5 events given up in a row, or 24 h with only failures (maintenance `webhook-health`, every 10 min), turn the endpoint off: notification `webhook.endpoint_disabled` + e-mail to owners / admins, audit `webhook_endpoint.disabled` (actor system). A success resets the streak. Replay = one more attempt now, same event id. "Send test event" posts a sample synchronously and logs a `test: true` delivery (never retried, never counted).
- **Transport:** the Phase 5 guard moved to `shared/net/url-guard.ts` (`resolvePublicAddress`): scheme (https only in production), no credentials, literal IPs, DNS resolved at **every** delivery with every address checked (a mixed public + private answer is refused — rebinding), the pinned address dialed with the original host as SNI / `Host`. Webhooks allow any port (`anyPort`); private hosts only outside production with `AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS` (the env check forbids it in production). No redirects (3xx = failure `redirect`), 10 s timeout, payload ≤ 64 KB, answer: status, ms and the first 1 KB of a text body only.
- **Payload:** `{ id, type, apiVersion: '2026-10', createdAt, accountId, data }`. Personal fields (`phone`, `name`, `summary`, `text`, also one level deep) only for endpoints with `includePersonalData` (off by default).
- **Signature:** headers `X-Webhook-Id`, `X-Webhook-Timestamp` (unix s), `X-Webhook-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`; the key is the secret string as shown (`whsec_<base64url of 32 random bytes>`). Rotation keeps the previous secret signing for 24 h (`, v1=<previous>`). Receivers compare in constant time and reject timestamps more than 5 minutes off. Golden vectors computed with `openssl` (`tests/fixtures/webhooks/vectors.json`).
- **Secrets:** sealed with the secret box (moved to `shared/crypto/secret-box.ts`), shown once (create / rotate, `Cache-Control: no-store`), never in lists, logs or audit (audit carries the URL host only).

## Consequences

- At-least-once with stable ids: receivers de-duplicate on `id`. Order is not guaranteed.
- A down receiver costs one queued job per pending attempt, never a blocked caller or another endpoint.
- ≤ 10 endpoints per account; delivery rows and events expire after 30 days, so a replay works for 30 days.
