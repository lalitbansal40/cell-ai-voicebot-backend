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

## Incoming calls

Customers can call your numbers too (Phase 20). Who answers is set in the app (**Settings → Phone numbers**): a flow or AI agent, your team in the browser, AI that can hand over to the team, or the team with AI when nobody picks up — plus call hours and what happens after hours.

- **Your numbers:** `GET /resources/phone-line` → `inboundNumbers` (number, label, on / off, route).
- **Incoming calls:** `GET /calls?direction=inbound` — `inbound.did` is the number the customer dialed; `from` is the caller (`anonymous` when hidden).
- **Missed calls (callback list):** `GET /calls?missed=open` — calls nobody (person or AI) took, with `missed.reason`: `no_answer`, `no_agents`, `after_hours`, `line_busy`, `wallet_low`, `caller_hung_up`. Calling the customer back (`POST /calls`) clears their missed calls of the last 24 hours.
- **Webhooks:** `call.started` / `call.completed` carry `direction` and `did`; `call.missed` arrives for each missed call.
- **Cost:** incoming minutes at the incoming minute price (`GET /wallet/rates` → `inboundCallPerMinuteMicros`) + AI minutes; missed calls and after-hours / low-wallet messages are free.
