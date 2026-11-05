# API changelog

- **2026-11-05:**
  - **Account resources** (`resources:read`): `GET /resources/flows`, `/agents`, `/whatsapp-numbers`, `/contact-lists`, `/segments`, `/phone-line`, `/ivrs`, `/wallet`.
  - **WhatsApp bulk campaigns** with API keys (`whatsapp-campaigns:read` / `:write`): create, estimate, start, pause, resume, stop, retry failed, recipients, export, report.
  - Webhooks: `whatsapp_campaign.completed`, `whatsapp_campaign.paused`; `campaign.completed` carries `line`.
  - Recorded-voice / IVR campaigns: `POST /campaigns` with `line: "voice_api"`; calls with `provider: voice_api`; error codes `VOICE_API_*`.
  - Every route documents its scope (`x-scope`), examples and errors; Postman collection at `/api/v1/postman.json`.
- **2026-11 (Phase 19):** campaign `line` (`phone` / `whatsapp`) with WhatsApp call campaigns (flow or agent, ask permission first); WhatsApp bulk campaigns in the dashboard; WhatsApp numbers paced at 18 / 75 messages per second.
- **2026-11 (Phase 18):** real phone calls over the SIP line (`mode: live`), caller numbers, answering machine detection (`phoneLine.amd`), new end reasons (`machine`, `rejected_by_customer`).
- **2026-10 (Phase 15):** the public API opens:
  - API keys with 13 scopes, an IP allowlist, expiry, per-key limits and a 7-day request log.
  - Contacts upsert and bulk upsert; WhatsApp template and text sends with message status; `externalRef` on calls and messages; WhatsApp AI calls.
  - Outbound webhooks with 11 events, HMAC-SHA256 signatures, retries, replay and a test event.
  - Webhook payloads carry `apiVersion: "2026-10"`.
