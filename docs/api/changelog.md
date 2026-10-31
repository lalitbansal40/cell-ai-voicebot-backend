# API changelog

- **2026-10 (Phase 15):** the public API opens:
  - API keys with 13 scopes, an IP allowlist, expiry, per-key limits and a 7-day request log.
  - Contacts upsert and bulk upsert; WhatsApp template and text sends with message status; `externalRef` on calls and messages; WhatsApp AI calls.
  - Outbound webhooks with 11 events, HMAC-SHA256 signatures, retries, replay and a test event.
  - Webhook payloads carry `apiVersion: "2026-10"`.
