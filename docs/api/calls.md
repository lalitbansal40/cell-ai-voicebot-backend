# Calls

`POST /calls` calls one contact now with a published **flow** (`flowId`, optional `version`) or an active **AI agent** (`agentId`) — ids from `GET /resources/flows` and `GET /resources/agents`.

```bash
curl -X POST https://wa.notifynow.in/api/v1/calls \
  -H "X-API-Key: $NOTIFYNOW_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: loan-1001-call-1" \
  -d '{"contactId":"6720f0a1b2c3d4e5f6a7b8c9","agentId":"6720f0a1b2c3d4e5f6a7b8cb","variables":{"amount_due":"₹2,500"},"externalRef":"loan-1001"}'
```

- **Line:** `GET /resources/phone-line` — `sip` dials real phones; `dryrun` (test line) simulates the customer and never charges.
- **Caller number:** `callerNumberId` from the phone line (default: the account's first number).
- **Variables:** seed flow variables or the agent's allowed values.
- **Guards:** calling window (09:00–21:00 at most), DND / opt-out, daily / weekly caps per contact, wallet, concurrency.
- **Results:** `GET /calls/{id}` (status, end reason, duration, disposition, outcome, cost), `/transcript`, `/insights` (AI summary, sentiment, promise to pay), `/after-call` (WhatsApp sent after the call), or the `call.completed` / `call.insights.ready` webhooks.
- **Cost:** carrier minutes by pulse + AI minutes, in micros (`cost.totalMicros`).
