# WhatsApp calls

1. A calling-ready number: `GET /resources/whatsapp-numbers` → `calling.ready: true` (Business App numbers cannot call).
2. The customer must have **allowed calls from that number** (they accept a call-permission request; permissions expire). Otherwise `409 WHATSAPP_CALL_PERMISSION_MISSING`.
3. Optional price: `GET /whatsapp/channels/{id}/calling/quote?contactId=…` (selling price per minute).
4. Call: `POST /whatsapp/calls` with `mode: "ai"` and `program` (a published flow or an active agent).

```bash
curl -X POST https://wa.notifynow.in/api/v1/whatsapp/calls \
  -H "X-API-Key: $NOTIFYNOW_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: wa-call-1001" \
  -d '{"channelId":"6720f0a1b2c3d4e5f6a7b8d1","contactId":"6720f0a1b2c3d4e5f6a7b8c9","mode":"ai","program":{"kind":"agent","id":"6720f0a1b2c3d4e5f6a7b8cb"}}'
```

Results come as `GET /calls/{id}` (provider `whatsapp`) and the `whatsapp.call.started` / `whatsapp.call.ended` webhooks. Business-initiated calls are charged per 6-second pulse; customer-initiated calls are free. For many customers use a campaign with `line: "whatsapp"`.
