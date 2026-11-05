# Getting started

The NotifyNow API is the same API the dashboard uses. Your server calls it with an **API key** instead of a login. Every request and response is JSON over HTTPS.

- Base URL: `https://wa.notifynow.in/api/v1`
- Header: `X-API-Key: cav_live_…`
- Download: [OpenAPI](/api/v1/openapi.public.json) · [Postman collection](/api/v1/postman.json)

## 1. Create a key

In the dashboard, go to **Settings → API keys → Create API key** (owners and admins):

1. Choose only the scopes your system needs (see **Authentication**).
2. Optionally limit the key to your servers' IP addresses and set an expiry date.

The full key is shown **once**. Keep it in your server's secrets — never in a browser or a mobile app.

## 2. Check the key

```bash
curl https://wa.notifynow.in/api/v1/api-keys/whoami -H "X-API-Key: $NOTIFYNOW_KEY"
```

```json
{
  "success": true,
  "data": {
    "accountId": "…",
    "apiKeyId": "…",
    "scopes": ["resources:read", "contacts:write", "messages:write"]
  }
}
```

## 3. Find your ids

Calls, campaigns and messages need ids of things set up in the dashboard. Read them with `resources:read`:

| You need               | Call                                                      |
| ---------------------- | --------------------------------------------------------- |
| a flow `flowId`        | `GET /resources/flows`                                    |
| an AI agent            | `GET /resources/agents`                                   |
| a WhatsApp `channelId` | `GET /resources/whatsapp-numbers`                         |
| a list / segment       | `GET /resources/contact-lists`, `GET /resources/segments` |
| a caller number        | `GET /resources/phone-line`                               |
| an IVR menu            | `GET /resources/ivrs`                                     |
| the wallet balance     | `GET /resources/wallet`                                   |

## 4. First calls

Upsert a contact, send an approved template, then start a call:

```bash
curl -X POST "https://wa.notifynow.in/api/v1/contacts?upsert=phone" \
  -H "X-API-Key: $NOTIFYNOW_KEY" -H "Content-Type: application/json" \
  -d '{"phone":"+919000000001","name":"Asha Verma","externalId":"CRM-1001","variables":{"amount_due":2500000000}}'

curl -X POST https://wa.notifynow.in/api/v1/messages/template \
  -H "X-API-Key: $NOTIFYNOW_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: crm-1001-reminder-2026-11-05" \
  -d '{"to":"+919000000001","template":{"name":"emi_reminder","language":"en"},"variables":{"1":"Asha","2":"₹2,500"},"externalRef":"CRM-1001"}'

curl -X POST https://wa.notifynow.in/api/v1/calls \
  -H "X-API-Key: $NOTIFYNOW_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: crm-1001-call-1" \
  -d '{"contactId":"6720f0a1b2c3d4e5f6a7b8c9","flowId":"6720f0a1b2c3d4e5f6a7b8ca","externalRef":"CRM-1001"}'
```

### Node.js

```js
const api = (path, body, key) =>
  fetch(`https://wa.notifynow.in/api/v1${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      'X-API-Key': process.env.NOTIFYNOW_KEY,
      'Content-Type': 'application/json',
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => {
    const json = await r.json();
    if (!json.success) throw new Error(`${json.error.code}: ${json.error.message}`);
    return json.data;
  });

const message = await api(
  '/messages/template',
  {
    to: '+919000000001',
    template: { name: 'emi_reminder', language: 'en' },
    variables: { 1: 'Asha', 2: '₹2,500' },
  },
  'crm-1001-reminder-2026-11-05',
);
```

### Python

```python
import os, requests

def api(path, body=None, key=None):
    headers = {"X-API-Key": os.environ["NOTIFYNOW_KEY"]}
    if key:
        headers["Idempotency-Key"] = key
    r = requests.request("POST" if body else "GET", f"https://wa.notifynow.in/api/v1{path}", json=body, headers=headers, timeout=30)
    data = r.json()
    if not data["success"]:
        raise RuntimeError(f'{data["error"]["code"]}: {data["error"]["message"]}')
    return data["data"]

flows = api("/resources/flows")
```

### PHP

```php
<?php
function notifynow(string $path, ?array $body = null, ?string $key = null): array {
    $ch = curl_init("https://wa.notifynow.in/api/v1$path");
    $headers = ['X-API-Key: ' . getenv('NOTIFYNOW_KEY'), 'Content-Type: application/json'];
    if ($key) $headers[] = "Idempotency-Key: $key";
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_HTTPHEADER => $headers]);
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
    $res = json_decode(curl_exec($ch), true);
    if (!$res['success']) throw new RuntimeException($res['error']['code']);
    return $res['data'];
}
```

`externalRef` (up to 100 characters) is your own id. It comes back on the call or message and in webhooks.

## 5. Get results

Add a webhook endpoint (**Webhooks**) instead of polling. Every event is signed; deliveries retry for 12 hours.

## Rules worth knowing

- **Account boundary:** a key sees only its own account. Another account's id answers `404`.
- **Customer protections:** keys never see full phone numbers in exports, and the API can never clear an opt-out or a do-not-call entry.
- **Revocation:** a revoked or expired key stops working within 30 seconds.
