# Release notes — public API docs (DOCS)

- **No migration.** No new env vars. nginx unchanged (`/api/` already proxies `/api/docs`, `/api/v1/openapi.public.json`, `/api/v1/postman.json`).
- **Scopes:** +3 (`resources:read`, `whatsapp-campaigns:read`, `whatsapp-campaigns:write`) → 16. Existing keys keep their scopes; owners add new ones in Settings → API keys.
- **Routes open to keys:** `/api/v1/resources/*` (8 read-only), every `/api/v1/whatsapp-campaigns` route, `POST /api/v1/campaigns/{id}/estimate`. New public `GET /api/v1/postman.json`, `GET /api/docs/page.css`.
- **Webhooks:** events 11 → 13 (`whatsapp_campaign.completed`, `whatsapp_campaign.paused`); `campaign.completed` adds `line` (additive, `apiVersion` stays `2026-10`).
- **Checks:** `npm run docs:audit` (0 problems), `npm run docs:smoke` (72 / 72), `openapi:check` also diffs `openapi/postman.json`.
- **Live check after deploy:** open `/api/docs` (public mode), download both files, call `whoami` and `GET /resources/flows` with a real key.
