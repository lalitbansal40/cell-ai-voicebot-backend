# Webhook receiver checklist (for the client's developers)

Use this list when you build the server that receives NotifyNow webhooks. The full reference is in the API docs (`/api/docs`) and [docs/api/webhooks.md](../api/webhooks.md).

## Before you add the endpoint

- [ ] **HTTPS** address on the public internet. Private / internal addresses are refused.
- [ ] Answers `2xx` within **10 seconds**. Do the real work in the background, after answering.
- [ ] Does **not redirect** (a `3xx` counts as a failure).
- [ ] Reads the **raw request body** before parsing JSON, because the signature covers the exact bytes.

## Security

- [ ] Store the signing secret (`whsec_…`, shown once) in your secrets manager, not in code.
- [ ] Verify `X-Webhook-Signature`:
  - It is an HMAC-SHA256 of `"<X-Webhook-Timestamp>.<raw body>"`.
  - Compare in constant time.
  - Accept any of the `v1=` values (there are two for 24 hours during a secret rotation).
- [ ] Reject requests whose `X-Webhook-Timestamp` is more than 5 minutes off.
- [ ] **De-duplicate on the event `id`.** Deliveries are at-least-once, and a retry or a Replay keeps the same id.
- [ ] Turn on **Include personal data** only if your system needs phones, names, summaries or message texts. Off by default.

## Operations

- [ ] Use **Send test event** (Integrations → Webhooks) after every change on your side.
- [ ] Events are not ordered. Use `createdAt` and the ids in `data`.
- [ ] If your server is down, NotifyNow retries after 1 min, 5 min, 30 min, 2 h and 12 h.
- [ ] After 5 events given up in a row (or 24 h of failures), the endpoint is turned off and the account's owners / admins get a notification and an e-mail. Fix the server, **Turn on**, then **Replay** what failed (the delivery log keeps 30 days).
- [ ] Rotate the secret with **New secret**. The old one keeps signing for 24 hours while you update your server.

## Google Sheets without a server

The Apps Script receiver ([docs/integrations/apps-script-receiver.gs](../integrations/apps-script-receiver.gs), guide in [google-sheets.md](../integrations/google-sheets.md)) appends events to a sheet. Apps Script can't read request headers, so it checks a secret `key` in its URL instead of the signature.
