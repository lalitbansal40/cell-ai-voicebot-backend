# Webhooks

NotifyNow sends events to your server as HTTPS `POST` requests. Add endpoints in **Integrations → Webhooks** (owners / admins) or with the API (`/api/v1/webhook-endpoints`, scope `webhooks:manage`).

## The request

```http
POST /your/path HTTP/1.1
Content-Type: application/json
User-Agent: NotifyNow-Webhooks/1.0
X-Webhook-Id: evt_01JBCDEFGHJKMNPQRSTVWXYZ01
X-Webhook-Timestamp: 1761700000
X-Webhook-Signature: v1=d8605653d430091a…

{"id":"evt_01JBCDEFGHJKMNPQRSTVWXYZ01","type":"call.completed","apiVersion":"2026-10","createdAt":"2026-10-29T01:06:40.000Z","accountId":"…","data":{…}}
```

Answer with any `2xx` within **10 seconds**. Anything else (including redirects — they are never followed) is a failure.

## Verifying the signature

`X-Webhook-Signature` is `v1=` + the hex HMAC-SHA256 of `"<X-Webhook-Timestamp>.<raw body>"`, keyed with your endpoint's secret exactly as shown (`whsec_…`). During a secret rotation the header carries two values (`v1=<new>, v1=<old>`) for 24 hours — accept the request if any value matches.

1. Read the **raw** body bytes (before any JSON parsing).
2. Reject the request if `X-Webhook-Timestamp` is more than 5 minutes from your clock.
3. Compute the HMAC and compare with each `v1=` value in constant time.
4. De-duplicate on `id` (deliveries are at-least-once).

### Node.js

```js
const crypto = require('node:crypto');

/** `rawBody` = the exact bytes received (e.g. express.raw({ type: 'application/json' })). */
function verifyNotifyNow(rawBody, headers, secret, toleranceSec = 300) {
  const ts = Number(headers['x-webhook-timestamp']);
  if (!Number.isInteger(ts) || Math.abs(Date.now() / 1000 - ts) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${ts}.`).update(rawBody).digest();
  return String(headers['x-webhook-signature'] || '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('v1='))
    .some((part) => {
      const given = Buffer.from(part.slice(3), 'hex');
      return given.length === expected.length && crypto.timingSafeEqual(given, expected);
    });
}
```

### Python

```python
import hashlib, hmac, time

def verify_notifynow(raw_body: bytes, headers: dict, secret: str, tolerance_sec: int = 300) -> bool:
    try:
        ts = int(headers.get("X-Webhook-Timestamp", ""))
    except ValueError:
        return False
    if abs(time.time() - ts) > tolerance_sec:
        return False
    expected = hmac.new(secret.encode(), f"{ts}.".encode() + raw_body, hashlib.sha256).hexdigest()
    given = [p.strip()[3:] for p in headers.get("X-Webhook-Signature", "").split(",") if p.strip().startswith("v1=")]
    return any(hmac.compare_digest(g, expected) for g in given)
```

### PHP

```php
<?php
function verify_notifynow(string $rawBody, array $headers, string $secret, int $toleranceSec = 300): bool {
    $ts = $headers['X-Webhook-Timestamp'] ?? '';
    if (!ctype_digit($ts) || abs(time() - (int) $ts) > $toleranceSec) return false;
    $expected = hash_hmac('sha256', $ts . '.' . $rawBody, $secret);
    foreach (explode(',', $headers['X-Webhook-Signature'] ?? '') as $part) {
        $part = trim($part);
        if (str_starts_with($part, 'v1=') && hash_equals($expected, substr($part, 3))) return true;
    }
    return false;
}
// $ok = verify_notifynow(file_get_contents('php://input'), getallheaders(), getenv('NOTIFYNOW_WEBHOOK_SECRET'));
```

## Retries, disabling and replay

- Failed deliveries are retried after **1 min, 5 min, 30 min, 2 h and 12 h** (6 attempts), always with the same `id`.
- After **5 events given up in a row**, or **24 hours of failures**, the endpoint is turned off and owners / admins get a notification and an e-mail. Turn it on again after fixing the receiver.
- The delivery log (30 days) shows each attempt's status code, time and the first 1 KB of your answer. **Replay** sends a delivery again now.
- **Send test event** posts a sample of any event type and shows your answer.
- Events are not ordered; use `createdAt` and the ids in `data`.

## Personal data

By default payloads carry ids, statuses, outcomes and amounts only. Turn on **Include personal data** for an endpoint to also get `phone`, `name`, the call `summary` and message `text`.

## Events

| Event                                                                    | When                                                      |
| ------------------------------------------------------------------------ | --------------------------------------------------------- |
| `call.started`                                                           | a call is answered                                        |
| `call.completed`                                                         | a call ended (any status) and its cost is settled         |
| `call.insights.ready`                                                    | the post-call AI summary / outcome is ready (or skipped)  |
| `campaign.completed`                                                     | a campaign (or a recurring run) finished                  |
| `whatsapp.message.received`                                              | a customer message arrived                                |
| `whatsapp.message.status`                                                | one of your messages was sent / delivered / read / failed |
| `whatsapp.call.started` · `whatsapp.call.ended` · `whatsapp.call.missed` | WhatsApp calls                                            |
| `contact.opted_out` · `contact.opted_in`                                 | STOP / START or a do-not-call change                      |

The `data` of each event, with samples, is listed in [Event payloads](#event-payloads).

## Event payloads

The `data` of each event (made-up values). Fields marked personal — `phone`, `name`, `summary`, `text` — are sent only to endpoints with **Include personal data**.

### `call.started`

```json
{
  "callId": "6720f0a1b2c3d4e5f6a7b8c9",
  "contactId": "6720f0a1b2c3d4e5f6a7b8ca",
  "contactExternalId": "CUST-1001",
  "externalRef": "loan-1001",
  "provider": "dryrun",
  "direction": "outbound",
  "campaignId": "6720f0a1b2c3d4e5f6a7b8cb",
  "flowId": "6720f0a1b2c3d4e5f6a7b8cc",
  "agentId": null,
  "phone": "+919876543210",
  "name": "Asha Verma"
}
```

### `call.completed`

```json
{
  "callId": "6720f0a1b2c3d4e5f6a7b8c9",
  "contactId": "6720f0a1b2c3d4e5f6a7b8ca",
  "contactExternalId": "CUST-1001",
  "externalRef": "loan-1001",
  "provider": "dryrun",
  "direction": "outbound",
  "campaignId": "6720f0a1b2c3d4e5f6a7b8cb",
  "flowId": "6720f0a1b2c3d4e5f6a7b8cc",
  "agentId": null,
  "status": "completed",
  "endReason": "hangup_node",
  "durationSec": 94,
  "costMicros": 2350000,
  "disposition": "promise_to_pay",
  "dispositionSource": "flow",
  "recording": true,
  "phone": "+919876543210",
  "name": "Asha Verma"
}
```

### `call.insights.ready`

```json
{
  "callId": "6720f0a1b2c3d4e5f6a7b8c9",
  "contactId": "6720f0a1b2c3d4e5f6a7b8ca",
  "externalRef": "loan-1001",
  "status": "done",
  "sentiment": "positive",
  "disposition": "promise_to_pay",
  "keyInfo": {
    "promiseDate": "2026-11-05",
    "promiseAmountMicros": 2500000000
  },
  "summary": "The customer agreed to pay ₹2,500 on 5 November."
}
```

### `campaign.completed`

```json
{
  "campaignId": "6720f0a1b2c3d4e5f6a7b8cb",
  "runLabel": null,
  "counts": {
    "contacts": 120,
    "calls": 168,
    "answered": 92,
    "completed": 115,
    "failed": 5
  },
  "outcomes": {
    "promise_to_pay": 31,
    "callback": 12
  },
  "costMicros": 412500000
}
```

### `whatsapp.message.received`

```json
{
  "messageId": "6720f0a1b2c3d4e5f6a7b8cd",
  "conversationId": "6720f0a1b2c3d4e5f6a7b8ce",
  "channelId": "6720f0a1b2c3d4e5f6a7b8cf",
  "contactId": "6720f0a1b2c3d4e5f6a7b8ca",
  "contactExternalId": "CUST-1001",
  "type": "text",
  "phone": "+919876543210",
  "name": "Asha Verma",
  "text": "I paid this morning"
}
```

### `whatsapp.message.status`

```json
{
  "messageId": "6720f0a1b2c3d4e5f6a7b8cd",
  "conversationId": "6720f0a1b2c3d4e5f6a7b8ce",
  "channelId": "6720f0a1b2c3d4e5f6a7b8cf",
  "contactId": "6720f0a1b2c3d4e5f6a7b8ca",
  "externalRef": "reminder-77",
  "status": "delivered",
  "errorCode": null,
  "chargeMicros": 115000
}
```

### `whatsapp.call.started`

```json
{
  "callId": "6720f0a1b2c3d4e5f6a7b8c9",
  "contactId": "6720f0a1b2c3d4e5f6a7b8ca",
  "channelId": "6720f0a1b2c3d4e5f6a7b8cf",
  "direction": "inbound",
  "answeredBy": "6720f0a1b2c3d4e5f6a7b8d0",
  "phone": "+919876543210"
}
```

### `whatsapp.call.ended`

```json
{
  "callId": "6720f0a1b2c3d4e5f6a7b8c9",
  "contactId": "6720f0a1b2c3d4e5f6a7b8ca",
  "channelId": "6720f0a1b2c3d4e5f6a7b8cf",
  "direction": "inbound",
  "durationSec": 182,
  "answeredBy": "6720f0a1b2c3d4e5f6a7b8d0",
  "phone": "+919876543210"
}
```

### `whatsapp.call.missed`

```json
{
  "callId": "6720f0a1b2c3d4e5f6a7b8c9",
  "contactId": "6720f0a1b2c3d4e5f6a7b8ca",
  "channelId": "6720f0a1b2c3d4e5f6a7b8cf",
  "direction": "inbound",
  "phone": "+919876543210"
}
```

### `contact.opted_out`

```json
{
  "contactId": "6720f0a1b2c3d4e5f6a7b8ca",
  "contactExternalId": "CUST-1001",
  "channel": "whatsapp",
  "source": "stop_keyword",
  "phone": "+919876543210"
}
```

### `contact.opted_in`

```json
{
  "contactId": "6720f0a1b2c3d4e5f6a7b8ca",
  "contactExternalId": "CUST-1001",
  "channel": "whatsapp",
  "source": "start_keyword",
  "phone": "+919876543210"
}
```
