# Reports and exports

**Reports** (`reports:read`): `GET /reports/{tab}` for `overview`, `calls`, `whatsapp`, `templates`, `campaigns`, `flows`, `agents`, `team`.

```bash
curl "https://wa.notifynow.in/api/v1/reports/campaigns?from=2026-11-01&to=2026-11-05&compare=true" -H "X-API-Key: $NOTIFYNOW_KEY"
```

- `from` / `to` are days in the account timezone, at most 366 days apart; `compare=true` adds the previous period.
- Answers are cached for 60 seconds and carry an `ETag`; send `If-None-Match` to get `304`.

**Exports** (`exports:write`): `POST /exports/calls`, `/exports/messages`, `/exports/report` answer an export job.

1. Start the export (CSV or XLSX, at most 200,000 rows; one at a time per account).
2. Poll `GET /exports/{id}` every few seconds until `status: "ready"`.
3. Download from its URL within 15 minutes (read the job again for a fresh link).

Phones are masked for API keys; message exports never contain message text.
