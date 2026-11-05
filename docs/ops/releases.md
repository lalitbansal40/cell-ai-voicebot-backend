# Production releases

| Date (IST) | Tag | Backend | Frontend | Operator | Duration | Checks | Issues |
| ---------- | --- | ------- | -------- | -------- | -------- | ------ | ------ |

No managed release yet: there is no server access (see [PRODUCTION_AUDIT.md](PRODUCTION_AUDIT.md)).

## 5 November 2026 — WhatsApp bulk campaign entry update

The owner authorized pushing the source repositories' `main` branches and syncing
`Cell24x7/cell-ai-voicebot`. The client repository baseline before this update is
`release-20261105-62dc374` (backend `62dc374`, frontend `e96a731`); the older pending
snapshot below is historical.

Frontend source: `c030aa2cae03268c7f44c923e12bf7b76146eb17`. Campaign creation now
offers **WhatsApp bulk campaign** alongside SIP / Normal call and WhatsApp call,
opening the existing channel → approved template → variables/media → audience →
schedule → wallet review/start flow. Switching new wizards preserves the campaign
name and supported audience. Sender/template failures offer retry; disconnected
senders and stale templates cannot advance. The CSV import link is corrected.

Local validation: 105 focused/regression tests, 2 Chromium browser tests (template
approval and dropdown → bulk campaign → completed report), frontend typecheck,
changed-file lint and production build passed. The browser used fake providers.
No backend runtime, migration or environment change is required by this update.
This repository sync does not record a production server deployment.

## Pending: Phases 16–18B (open item for the client team)

The client repo is at `release-20261103-6b656bd` (Phase 17). Phases 18 (SIP) and 18B (WhatsApp calling go-live) are on `main` of the dev repos only after the owner merges them; the client sync (`scripts/sync-client-repo.sh main main`) runs only when the owner asks.

Steps when it is released:

1. Migrations `0019-sip-lines` and `0020-call-permission-runs` run with the release (additive; the previous release keeps working).
2. Env: `WA_MEDIA_ENABLED=true`, `WA_MEDIA_PUBLIC_IP=<server public IPv4>`, UDP 40000–40999 open; Meta app subscribed to `calls`.
3. Post-deploy checks: `/health` shows the new commit; **Admin → System → WhatsApp calls** shows the public IP set; **Number → Calling** readiness all green on the production number; one call permission request to the owner's phone; then `docs/meta/CALLING_LIVE_CHECK.md` steps.

## Phase 19 continuation — candidate, validation pending

Three campaign types, shared 18/75 sender pacing, recurring/media message campaigns,
WhatsApp flow/agent campaigns, scoped templates and shared call choices. Migrations:
0021/0022 original Phase 19, then 0023/0024 continuation. `WA_CAMPAIGN_MPS` only lowers
backend-derived limits; unknown metadata uses 18 until refreshed. Preserve Redis jobs
on restart and refresh connected numbers after migration. Account purge includes durable
campaign/template headers. Read the Phase 19 sign-off before release; no deployment yet.

Phase 19 local release: [notes](release-phase-19.md) · [sign-off](../phases/PHASE_19_SIGNOFF.md). Live Meta/SIP and production rollout require separate owner authorization.
