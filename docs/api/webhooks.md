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

Code samples (Node, Python, PHP) are on the API docs page (Phase 15 T15.8).

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

The `data` of each event, with samples, is listed in [Event payloads](#event-payloads) (filled in T15.4).

## Event payloads

_Filled in T15.4 from the payload builders._
