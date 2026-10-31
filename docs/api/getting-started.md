# Getting started

The NotifyNow API is the same API the dashboard uses. Your systems call it with an **API key** instead of a login. Every request and response is JSON over HTTPS. The base URL is your NotifyNow address + `/api/v1`, for example `https://wa.notifynow.in/api/v1`.

## 1. Create a key

In the dashboard, go to **Settings → API keys → Create API key** (owners and admins). Then:

1. Choose only the scopes your system needs.
2. Optionally limit the key to your servers' IP addresses and set an expiry date.

The full key (`cav_live_…`) is shown **once**. Store it in your server's secrets, never in a browser or an app.

| Scope                  | Lets the key                                     |
| ---------------------- | ------------------------------------------------ |
| `calls:read`           | read calls, transcripts, AI insights, after-call |
| `calls:write`          | start a call                                     |
| `whatsapp-calls:write` | start a WhatsApp call with an AI agent           |
| `contacts:read`        | read contacts                                    |
| `contacts:write`       | create / update contacts, bulk upsert            |
| `campaigns:read`       | read campaigns and their runs                    |
| `campaigns:write`      | create, start, pause, resume, cancel campaigns   |
| `messages:read`        | read WhatsApp messages sent by the API           |
| `messages:write`       | send WhatsApp templates and replies              |
| `templates:read`       | read approved WhatsApp templates                 |
| `reports:read`         | read report numbers                              |
| `exports:write`        | create and download exports                      |
| `webhooks:manage`      | manage outbound webhooks                         |

## 2. Check the key

```bash
curl https://wa.notifynow.in/api/v1/api-keys/whoami -H "X-API-Key: $NOTIFYNOW_KEY"
```

```json
{
  "success": true,
  "data": { "accountId": "…", "apiKeyId": "…", "scopes": ["contacts:write", "messages:write"] }
}
```

## 3. First calls

Create or update a contact by phone (`contacts:write`):

```bash
curl -X POST "https://wa.notifynow.in/api/v1/contacts?upsert=phone" \
  -H "X-API-Key: $NOTIFYNOW_KEY" -H "Content-Type: application/json" \
  -d '{"phone":"+919876543210","name":"Asha","externalId":"CRM-1001","variables":{"loan_id":"LN-1001"}}'
```

Send an approved WhatsApp template (`messages:write`). `Idempotency-Key` is required, and retrying with the same key never sends twice:

```bash
curl -X POST https://wa.notifynow.in/api/v1/messages/template \
  -H "X-API-Key: $NOTIFYNOW_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: crm-1001-reminder-2026-11-05" \
  -d '{"to":"+919876543210","template":{"name":"emi_reminder","language":"en"},"variables":{"1":"Asha","2":"₹2,500"},"externalRef":"CRM-1001"}'
```

Start a call with a published flow or an AI agent (`calls:write`):

```bash
curl -X POST https://wa.notifynow.in/api/v1/calls \
  -H "X-API-Key: $NOTIFYNOW_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: crm-1001-call-1" \
  -d '{"contactId":"6720f0a1b2c3d4e5f6a7b8c9","flowId":"6720f0a1b2c3d4e5f6a7b8ca","externalRef":"CRM-1001"}'
```

`externalRef` (up to 100 characters) is your own id. It comes back on the call or message and in webhooks.

## 4. Get results by webhook

Add an endpoint in **Integrations → Webhooks**, or with `POST /webhook-endpoints` (`webhooks:manage`). NotifyNow posts signed events such as `call.completed`, `call.insights.ready` and `whatsapp.message.status` to your server. See **Webhooks** below for the signature check and code samples.

## Rules worth knowing

- **Account boundary:** a key only sees its own account. Another account's id answers `404`.
- **Customer protections:** keys never see full phone numbers in exports, and the API can never clear an opt-out or a do-not-call entry.
- **Revocation:** a revoked or expired key stops working within 30 seconds.
