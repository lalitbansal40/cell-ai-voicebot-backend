# Scheduled AI WhatsApp calls

Schedule an AI WhatsApp call (a published flow or an active AI agent) to a contact for later — at least 5 minutes and at most 30 days ahead.

```bash
curl -X POST "$API/api/v1/whatsapp/scheduled-calls" \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" -H "Idempotency-Key: emi-10045-1" \
  -d '{
    "channelId": "6720f0a1b2c3d4e5f6a7b8cf",
    "contactId": "6720f0a1b2c3d4e5f6a7b8ca",
    "program": { "kind": "agent", "id": "6720f0a1b2c3d4e5f6a7b8cb" },
    "purpose": "EMI reminder",
    "dueAt": "2026-11-21T05:30:00.000Z",
    "retry": { "max": 1, "gapMin": 60, "on": ["no_answer", "busy"] }
  }'
```

Scopes: `calls:write` to create / change / cancel, `calls:read` to list.

- **At its time** every check of a call now runs again: call permission, DND / opt-out, 09:00–21:00 in the account timezone, wallet, limits. Outside the window it moves once to the next opening; otherwise it is `skipped` with `skipReason` (webhook `whatsapp_call.scheduled_skipped`).
- **Warnings** in the answer: `noPermission`, `permissionExpiresBeforeDue`, `outsideWindow`, `lowWallet` — the call is saved anyway.
- **Statuses:** `scheduled` → `dispatching` → `calling` → `done` / `failed`; or `skipped` / `cancelled`. `attempts[]` lists each try and its call.
- At most 3 open per contact and 500 per account.

| Route                                               | What                                                      |
| --------------------------------------------------- | --------------------------------------------------------- |
| `POST /api/v1/whatsapp/scheduled-calls`             | schedule (optional `Idempotency-Key`)                     |
| `GET /api/v1/whatsapp/scheduled-calls?status=open`  | list, newest first, cursor pages                          |
| `GET /api/v1/whatsapp/scheduled-calls/{id}`         | one                                                       |
| `PATCH /api/v1/whatsapp/scheduled-calls/{id}`       | change time / program / purpose / retry while `scheduled` |
| `POST /api/v1/whatsapp/scheduled-calls/{id}/cancel` | cancel while `scheduled`                                  |
