# WhatsApp messages

1. Find the sending number: `GET /resources/whatsapp-numbers` (`id` = `channelId`).
2. Find an approved template: `GET /whatsapp/templates?status=APPROVED&channelId=…` (templates belong to the WhatsApp Business Account; numbers of the same account share them).
3. Send it: `POST /messages/template` with `Idempotency-Key`.

```bash
curl -X POST https://wa.notifynow.in/api/v1/messages/template \
  -H "X-API-Key: $NOTIFYNOW_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-881-shipped" \
  -d '{"channelId":"6720f0a1b2c3d4e5f6a7b8d1","to":"+919000000001","template":{"name":"order_shipped","language":"en"},"variables":{"1":"Asha","2":"881"}}'
```

- **Variables:** numbered (`"1"`, `"2"`) or named, exactly as in the template. Missing ones answer `422 TEMPLATE_VARIABLES_MISSING`.
- **Header media:** `header: { "mediaToken": "…" }` (an uploaded file) or `header: { "location": { … } }` when the template has such a header.
- **Text:** `POST /messages/text` works only within 24 hours of the customer's last message (`409 WHATSAPP_WINDOW_CLOSED` otherwise).
- **Status:** `GET /messages/{id}` or the `whatsapp.message.status` webhook: `queued → sent → delivered → read`, or `failed` with WhatsApp's error code.
- **Price:** by template category (marketing / utility / authentication / service) and the destination country, held at send and charged when WhatsApp bills it; see the wallet ledger.
- **Opt-out:** contacts who wrote STOP (or are on do-not-call) are refused with `CONTACT_OPTED_OUT`. Only a person in the dashboard can opt them back in.

For many recipients use **WhatsApp bulk campaigns** instead of a loop.
