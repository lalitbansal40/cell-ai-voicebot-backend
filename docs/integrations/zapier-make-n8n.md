# Zapier, Make and n8n (CRM recipes)

NotifyNow has no native CRM connectors yet; webhooks + the public API connect it to any CRM through Zapier, Make (Integromat) or n8n.

## NotifyNow → CRM (webhooks)

1. In the tool: a **Webhook** trigger ("Catch Hook" in Zapier / Make "Custom webhook" / n8n "Webhook" node) → copy its URL.
2. NotifyNow → **Integrations → Webhooks → Add** that URL, events e.g. `call.completed`, `call.insights.ready`, `whatsapp.message.received`. Turn **Include personal data** on only if the CRM needs phone / name / summary.
3. **Send test event**, then map fields in the tool: `data.externalRef` / `data.contactExternalId` find the CRM record; `data.disposition`, `data.durationSec`, `data.costMicros / 1,000,000` (₹) update it.
4. Check the signature where the tool allows code (n8n Function node, Make custom app, Zapier "Code by Zapier"): see [webhooks — verifying](../api/webhooks.md#verifying-the-signature). De-duplicate on `id`.

## CRM → NotifyNow (API)

Create an API key (Settings → API keys) with the scopes you need and use an HTTP / "Webhooks by Zapier — POST" action:

| Goal                     | Request                                                                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Push a customer          | `POST https://wa.notifynow.in/api/v1/contacts?upsert=externalId` — `{ "phone": "+91…", "name": "…", "externalId": "<CRM id>", "variables": { "due_date": "2026-11-05" } }` (scope `contacts:write`)                       |
| Call them now            | `POST /api/v1/calls` — `{ "contactId": "…", "flowId": "…", "externalRef": "<CRM id>" }` + header `Idempotency-Key` (scope `calls:write`)                                                                                  |
| Send a WhatsApp template | `POST /api/v1/messages/template` — `{ "to": "+91…", "template": { "name": "payment_reminder", "language": "en" }, "variables": { "1": "Asha" }, "externalRef": "<CRM id>" }` + `Idempotency-Key` (scope `messages:write`) |
| Get the result           | `GET /api/v1/calls?externalRef=<CRM id>` (scope `calls:read`) — or wait for `call.completed`                                                                                                                              |

Headers: `X-API-Key: cav_live_…`, `Content-Type: application/json`. Limits: 60 writes / 600 reads a minute per key; errors use the same envelope as the dashboard (`{ success: false, error: { code, message, details } }`).
