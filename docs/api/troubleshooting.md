# Troubleshooting

| You see                                | Fix                                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------------------- |
| `401 AUTH_UNAUTHENTICATED`             | Send `X-API-Key`; check the key was not revoked or regenerated.                           |
| `403` with `details[0].path = "scope"` | Edit the key and add that scope.                                                          |
| `403 API_KEY_IP_DENIED`                | Add your server's public IP to the key's allowlist.                                       |
| `404` on an id you know                | It belongs to another account or was deleted.                                             |
| `409 WHATSAPP_WINDOW_CLOSED`           | Send a template, not text.                                                                |
| `409 TEMPLATE_NOT_APPROVED`            | Wait for WhatsApp's approval or use an approved template.                                 |
| `409 WHATSAPP_CALL_PERMISSION_MISSING` | Ask the customer for call permission from that number first.                              |
| `409 CAMPAIGN_NOT_RUNNABLE`            | Read `details`: a flow not published, an agent off, audio deleted, empty audience.        |
| `422 VALIDATION_FAILED`                | Each `details[]` entry names the field. Unknown fields are refused too.                   |
| `422 IDEMPOTENCY_KEY_REUSED`           | You reused a key for a different body — use a new key.                                    |
| `422 WALLET_INSUFFICIENT_BALANCE`      | Add money; paused campaigns with auto-resume continue.                                    |
| `429 RATE_LIMITED`                     | Wait `Retry-After`; batch your work.                                                      |
| Webhook signature fails                | Use the raw body bytes, the exact secret, and a clock within 5 minutes.                   |
| No webhooks arrive                     | Check the endpoint is active (it disables after repeated failures), then **Replay**.      |
| Calls stay `queued`                    | The account is on the test line, outside the calling window, or at its concurrency limit. |

The key's request log (Settings → API keys) shows every call it made in the last 7 days. Quote the `requestId` from an error to support.
