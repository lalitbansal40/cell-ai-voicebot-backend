# Release notes — recorded-voice campaigns (Cell24x7, VAPI)

- **Migration** `0025-voice-api` (additive): account `voiceApi` defaults, campaign `voiceApi: null`,
  index `campaign_contact_voice_result`. Down drops the index only.
- **Env** (all optional while `VOICE_API_PROVIDER=off`, the default): `VOICE_API_PROVIDER`,
  `CELL24X7_VOICE_BASE_URL`, `CELL24X7_VOICE_API_TOKEN` (secret), `CELL24X7_VOICE_CALLER_ID`,
  `CELL24X7_WEBHOOK_SECRET` (secret), `VOICE_API_BATCH_SIZE`, `VOICE_API_LINES`,
  `VOICE_API_POLL_SEC`, `VOICE_API_FAKE_DELAY_MS`. `fake` is refused in production.
- **Catalogues**: 8 error codes `VOICE_API_*`, 3 audit actions (`account.voice_api_changed`,
  `voice_api.webhook_registered`, `voice_api.batch_resolved`), notification
  `voice_api.provider_error`, ledger type `voice_broadcast_charge` (usage kind
  `voice_broadcast`), pause reasons `provider_error` / `provider_uncertain`, skip reason
  `not_indian_mobile`, rate card `voiceApiPulseMicros` (default 0 = not priced),
  call provider `voice_api`, jobs `voice.batch` / `voice.poll` / `voice.result`.
- **Routes**: `PATCH /admin/accounts/:id/voice-api`, `GET /admin/voice-api/status`,
  `POST /admin/voice-api/webhook`, `GET /admin/voice-api/ivrs`,
  `POST /admin/campaigns/:id/voice-batches/:no/resolve`, `GET /voice-api/ivrs`,
  `POST /webhooks/voice-api/:secret` (public). `GET /phone-line` adds `voiceApi.enabled`.
- **Order**: migrate → deploy API + workers → set env → Register webhook → enable accounts.
- Live checks and deployment need the owner's approval (see the integration guide).
