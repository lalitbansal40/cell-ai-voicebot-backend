# WhatsApp templates by API

Create, submit, edit and delete WhatsApp message templates from your own system. Templates belong to the number's WhatsApp Business Account: every number of that account can send them once Meta approves them.

You need a key with **`templates:write`** (create / submit / edit / delete; it can also read). A key with only `templates:read` can list approved templates.

## 1. Find the number

`GET /resources/whatsapp-numbers` → the `id` of a connected number is the `channelId`.

## 2. Create (and submit)

```bash
curl -X POST https://wa.notifynow.in/api/v1/whatsapp/templates \
  -H "X-API-Key: $NOTIFYNOW_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: tpl-payment-reminder-v1" \
  -d '{
    "channelId": "6720f0a1b2c3d4e5f6a7b8cf",
    "name": "payment_reminder",
    "language": "en",
    "category": "UTILITY",
    "components": [
      { "type": "BODY", "text": "Hi {{1}}, your EMI of {{2}} is due on {{3}}.",
        "example": { "body_text": [["Asha", "₹4,500", "5 Dec"]] } },
      { "type": "FOOTER", "text": "Reply STOP to opt out" },
      { "type": "BUTTONS", "buttons": [
        { "type": "QUICK_REPLY", "text": "Paid" },
        { "type": "QUICK_REPLY", "text": "Call me" } ] }
    ]
  }'
```

The answer is the template with `status: "PENDING"` (Meta is reviewing it). Send `"submit": false` to keep a `DRAFT` instead.

If the template was saved but Meta refused the submit, you still get `201` with `status: "DRAFT"` and `submitError` (code, message, details). Fix it with `PATCH /whatsapp/templates/{id}` and call `POST /whatsapp/templates/{id}/submit`.

## 3. Media header (image / video / document)

1. Create with `"submit": false` and `{ "type": "HEADER", "format": "IMAGE" }`.
2. Upload the example file:

   ```bash
   curl -X POST https://wa.notifynow.in/api/v1/whatsapp/templates/$ID/media \
     -H "X-API-Key: $NOTIFYNOW_KEY" -F file=@banner.jpg
   ```

   JPEG / PNG ≤ 5 MB (IMAGE), MP4 ≤ 16 MB (VIDEO), PDF ≤ 100 MB (DOCUMENT).

3. Submit: `POST /whatsapp/templates/{id}/submit`.

## 4. Wait for Meta

- Webhook **`template.status_changed`** (`APPROVED`, `REJECTED` with `reason`, `PAUSED`, `DISABLED`…) — subscribe your endpoint to it, or
- poll `GET /whatsapp/templates/{id}`.

## 5. Send it

Once `APPROVED`: `POST /messages/template` (see **WhatsApp messages**).

## Rules

| Part       | Rule                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `name`     | lowercase letters, digits and `_`, ≤ 512; unique per language; a deleted name is locked 30 days                                |
| `category` | `UTILITY` or `MARKETING` (authentication templates are refused); Meta may change it                                            |
| `BODY`     | required, ≤ 1,024 characters; every variable needs an `example`                                                                |
| Variables  | positional `{{1}}`, `{{2}}` or named (`"parameterFormat": "named"`, `{{customer_name}}`, examples in `body_text_named_params`) |
| `HEADER`   | TEXT (≤ 60, one variable), IMAGE, VIDEO, DOCUMENT or LOCATION                                                                  |
| `FOOTER`   | ≤ 60, no variables                                                                                                             |
| `BUTTONS`  | quick replies, URL (one suffix variable), phone number, copy code                                                              |
| Limits     | 250 templates per WhatsApp account until it is verified (6,000 after); 20 creates / edits per hour per key                     |
| Edits      | an approved template: at most once per 24 h and 10 times per 30 days; the category can't change                                |

Deleting: `DELETE /whatsapp/templates/{id}` (this language) or `?scope=name` (every language). The ready-made call-permission template and template sync are dashboard-only.
