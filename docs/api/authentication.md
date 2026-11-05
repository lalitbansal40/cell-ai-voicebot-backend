# Authentication

Send your key in the `X-API-Key` header on every request. Keys start with `cav_live_`.

- **Scopes:** each route needs exactly one scope (shown as `x-scope` on every operation). A key without it gets `403 AUTH_FORBIDDEN` with `details: [{ "path": "scope", "message": "<scope> is required" }]`.
- **IP allowlist:** optional IPv4 / IPv6 addresses or ranges; other callers get `403 API_KEY_IP_DENIED`.
- **Expiry:** optional; after it the key gets `401 API_KEY_EXPIRED`.
- **Rotation:** create a new key, deploy it, then revoke the old one (revocation applies within 30 s).
- **Request log:** Settings → API keys shows each key's last 7 days of requests (route, status, time — never bodies).

| Answer | Meaning                                                                     |
| ------ | --------------------------------------------------------------------------- |
| `401`  | No key, a wrong key, an expired or revoked key                              |
| `403`  | The key lacks the scope, the IP is not allowed, or the account is suspended |
| `404`  | The id is not in this account (also for other accounts' ids)                |

## Scopes

<!-- scopes:start -->

| Scope                      | Group     | Lets the key                                                                                          |
| -------------------------- | --------- | ----------------------------------------------------------------------------------------------------- |
| `calls:read`               | Calls     | Read call records and results                                                                         |
| `calls:write`              | Calls     | Trigger calls                                                                                         |
| `whatsapp-calls:write`     | Calls     | Start WhatsApp calls with an AI agent                                                                 |
| `contacts:read`            | Contacts  | Read contacts                                                                                         |
| `contacts:write`           | Contacts  | Create and update contacts                                                                            |
| `campaigns:read`           | Campaigns | Read campaigns and their status                                                                       |
| `campaigns:write`          | Campaigns | Create and control campaigns                                                                          |
| `messages:read`            | WhatsApp  | Read WhatsApp messages sent by the API                                                                |
| `messages:write`           | WhatsApp  | Send WhatsApp messages and templates                                                                  |
| `templates:read`           | WhatsApp  | Read approved WhatsApp templates                                                                      |
| `reports:read`             | Reports   | Read report numbers                                                                                   |
| `exports:write`            | Reports   | Create and download exports                                                                           |
| `webhooks:manage`          | Webhooks  | Manage outbound webhooks                                                                              |
| `whatsapp-campaigns:read`  | WhatsApp  | Read WhatsApp bulk campaigns, recipients and reports                                                  |
| `whatsapp-campaigns:write` | WhatsApp  | Create, start and control WhatsApp bulk campaigns                                                     |
| `resources:read`           | Account   | Read flows, AI agents, WhatsApp numbers, lists, segments, caller numbers, IVRs and the wallet balance |

<!-- scopes:end -->
