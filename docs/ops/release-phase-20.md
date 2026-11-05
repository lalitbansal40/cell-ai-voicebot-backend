# Release notes — incoming phone calls (Phase 20)

- **Migration** `0026-inbound-sip` (additive): `phoneNumbers.inbound` defaults (off), index `missed_calls` on calls. Down drops the index only.
- **Env**: `SIP_INBOUND_ENABLED` (default off; needs `TELEPHONY_PROVIDER=sip`), `SIP_INBOUND_PER_CALLER_PER_HOUR` (10), `SIP_INBOUND_RESERVED_CHANNELS` (0, below `SIP_MAX_CHANNELS`), `SIP_INBOUND_RING_MAX_SEC` (120). Asterisk: `ARI_APP` in `asterisk.env` (default `cav`).
- **Asterisk**: `extensions.conf` is now a template; trunk calls go to `<ARI_APP>-inbound`. Rebuild / restart the Asterisk container with the release.
- **Catalogues**: error codes `CALL_ALREADY_ANSWERED`, `CALL_NOT_RINGING`, `INBOUND_PROGRAM_REQUIRED`, `INBOUND_PROGRAM_NOT_READY`; audit actions `call.answered`, `call.callback_done`, `phone_number.inbound_updated`; notification `call.sip_missed`; webhook event `call.missed` (14 events); end reasons `line_busy`, `spam_guard`, `inbound_refused`; contact source `inbound_call`; phone number purpose `both`; rate card `inboundCallPerMinuteMicros` (null = call price).
- **Routes**: `GET /phone-numbers/inbound`, `PATCH /phone-numbers/:id/inbound`, `POST /calls/:id/answer`, `POST /calls/:id/decline`, `POST /calls/:id/callback-done`; `GET /calls?missed=open|all`; admin phone numbers accept `purpose`. Public: `/resources/phone-line` adds `inboundNumbers`; `call.started` / `call.completed` add `did`.
- **Order**: migrate → deploy API + workers → rebuild Asterisk → set `SIP_INBOUND_ENABLED=true` on the API → superadmin adds the DID (incoming) → account turns the number on.
- **Rollback**: `SIP_INBOUND_ENABLED=false` (callers hear "unavailable"); the previous release ignores the new fields.
- Live checks need the client's DID and the owner's approval ([sip-inbound.md](../integrations/sip-inbound.md)).
