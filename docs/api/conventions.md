# Conventions

| Thing          | Format                                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Phones         | E.164, e.g. `+919000000001`. Indian 10-digit numbers you send get `+91`. Lists show only the last 4 digits (`phoneLast4`).   |
| Money          | Integer **micros**: ₹1 = `1000000`; `2500000000` = ₹2,500.                                                                   |
| Times          | ISO 8601 in UTC (`2026-11-05T09:30:00.000Z`). Calling windows and reports use the account timezone (default `Asia/Kolkata`). |
| Ids            | 24-character hex strings. Treat them as opaque.                                                                              |
| `externalRef`  | Your own id (≤ 100 chars) on calls and messages; echoed in webhooks.                                                         |
| Envelope       | Success: `{ "success": true, "data": …, "meta"?: … }`. Error: see **Errors**.                                                |
| Unknown fields | Refused with `422` (no silent typos).                                                                                        |

Personal data: contact names and phones appear only where the route is about that contact. Webhooks carry personal data only to endpoints with **Include personal data** on.
