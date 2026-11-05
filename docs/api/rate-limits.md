# Rate limits

Each key may make **600 reads** (`GET`) and **60 writes** (`POST` / `PATCH` / `DELETE`) a minute. Every response carries `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`. Over the limit the API answers `429 RATE_LIMITED` with `Retry-After` (seconds).

Back off and retry:

```js
async function withRetry(call, tries = 5) {
  for (let i = 0; ; i += 1) {
    const res = await call();
    if (res.status !== 429 || i === tries - 1) return res;
    const wait = Number(res.headers.get('retry-after') ?? 1) * 1000;
    await new Promise((r) => setTimeout(r, wait + Math.random() * 250));
  }
}
```

- Use bulk routes: `POST /contacts/bulk-upsert` (1,000 rows), campaigns instead of one call per contact.
- Use webhooks instead of polling.
- Ask support if your account needs higher limits.

## Route-specific limits

| Route                        | Limit                   |
| ---------------------------- | ----------------------- |
| `POST /whatsapp-campaigns`   | 30 per hour per account |
| `POST /whatsapp/calls`       | 10 per minute           |
| `POST /webhooks/voice-api/…` | provider only           |

## Sending speed

WhatsApp bulk campaigns are paced per WhatsApp number: **75 messages / second** on a confirmed Cloud API number, **18 / second** on a Business App (coexistence) or unconfirmed number, and by the number's daily messaging tier. Recorded-voice campaigns dial about 4 calls at a time on the provider's line.
