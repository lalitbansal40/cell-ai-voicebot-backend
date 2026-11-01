# Release notes — Phase 15 (integrations) for the client's deploy

**What's new:**

- Public API with scoped API keys.
- Outbound webhooks.
- WhatsApp after calls (flow "Send WhatsApp" steps and after-the-call rules).
- Scheduled Google Sheet contact imports.
- Public API docs at `/api/docs`.

## Before deploying

- **Back up the database** (`backup.sh` or an Atlas snapshot).
- **No new environment variables.** Optional, already known: `TRUST_PROXY` must name nginx so per-key IP allowlists see the real client address. `API_DOCS_ENABLED` stays unset in production; the docs page then shows the public API only.
- `MOCK_APIS_ENABLED` must stay off in production. The env check refuses it anyway.

## Deploy steps

1. Deploy the backend and run the migrations (`deploy.sh` does it; otherwise `npm run db:migrate`). The migration is **`0017-integrations`**: indexes and TTLs only, no data changes. It creates the `apiRequestLogs`, `webhookEndpoints`, `webhookEvents`, `webhookDeliveries`, `outcomeRules`, `postCallMessages` and `sheetImports` collections. `down` drops them.
2. The worker process starts the new queue **`webhooks`** by itself. New maintenance jobs: `webhook-health` (every 10 min) and `sheet-imports` (every 15 min). New WhatsApp-queue job: `postcall.send`.
3. Deploy the frontend. The menu shows **Integrations** (`LIVE_PHASE` 15).

## Check after deploy

- `GET /api/v1/health`: `uptimeSec` is small (the new build is running) and `commit` is the new one.
- `/api/docs` opens and lists only **Public API** routes, with the guides on top.
- Dashboard → **Settings → API keys** → create a test key → **Test a key** → "The key works". Revoke it.
- **Integrations → Webhooks** → add a test receiver (for example webhook.site) → **Send test event** → "Delivered".
- **Integrations → After the call** and **Google Sheets** open without errors.
- A call page shows the **After the call** card when a rule or flow step sent a message.
- WhatsApp numbers connect (Embedded Signup or manual) without "Action needed". The Tech Provider fix (`0053a8d`) is included.

## Rollback

Roll back the release (`rollback.sh`). The new collections stay but are unused. If needed, revert migration `0017` with `node dist/ops/migrate.js down` in the image (`npm run db:migrate:down` outside it).
