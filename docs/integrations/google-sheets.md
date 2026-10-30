# Google Sheets

Two directions, no Google sign-in needed (no OAuth — PHASE_15_PLAN §7 #4).

## Contacts in: import from a published sheet

1. In Google Sheets: **File → Share → Publish to the web**. Choose the sheet tab, **Comma-separated values (.csv)**, **Publish**, and copy the link. It looks like `https://docs.google.com/spreadsheets/d/e/2PACX-…/pub?gid=0&single=true&output=csv`.
2. In NotifyNow: **Contacts → Import → From Google Sheet** (or **Integrations → Google Sheets**): paste the link, give it a name, map the columns (phone is required; existing contact fields only — create new fields first in Settings), choose **Once**, **Every hour** or **Every day**, and whether to **update existing contacts** (matched by phone).
3. NotifyNow downloads the sheet right away to check the link and the mapping, creates a list "Google Sheet: <name>" and imports. Scheduled imports run again every hour / day; each run is a normal import (validation, duplicates, do-not-call, an error file for rows that failed). **Run now** imports again at once; deleting the import stops it — contacts and the list stay.

Limits: ≤ 5 sheet imports per account, the same size / row limits as file imports. A link that isn't a published CSV, a sheet that's no longer published (a sign-in page comes back) or a file that's too big → 422 `SHEET_URL_INVALID` with the reason. Keep the published link private: anyone with it can read the sheet.

API: `GET / POST /api/v1/sheet-imports`, `POST /api/v1/sheet-imports/:id/run`, `DELETE /api/v1/sheet-imports/:id` (`contacts.import`, dashboard sign-in).

## Results out: a row per finished call

Use the Apps Script receiver [`apps-script-receiver.gs`](apps-script-receiver.gs):

1. Open the results sheet → **Extensions → Apps Script**, paste the file, save.
2. **Project Settings → Script properties**: `RECEIVER_KEY` = a long random text you make up.
3. **Deploy → New deployment → Web app**: Execute as **Me**, Who has access **Anyone** → copy the web app URL.
4. In NotifyNow → **Integrations → Webhooks → Add**: URL = the web app URL + `?key=<RECEIVER_KEY>`, event **call.completed**.
5. **Send test event** — a row appears (Received at, Event id, Call id, External ref, Status, Outcome, Duration, Cost ₹, Contact id).

Apps Script web apps can't read request headers, so the signature (`X-Webhook-Signature`) can't be checked inside the script; the secret `key` in the URL is the check. Rows are de-duplicated by event id. To check signatures, put any small server in front (see [Zapier / Make / n8n](zapier-make-n8n.md) or the code samples in [webhooks](../api/webhooks.md)). The logic is mirrored and tested in `scripts/lib/sheets-receiver.ts`.
