# Production deployment

The kit for `wa.notifynow.in` on the client's shared server. Design: [ADR 0049](../../docs/adr/0049-production-shared-server.md). Runbook: [production.md](../../docs/ops/production.md).

This folder holds what differs from staging: `compose.yaml` (project `cav-prod`, CPU and memory limits, `local` logs, Redis `noeviction`), env templates, nginx templates, systemd units and `scripts/release.sh`. The other scripts are shared with staging, from `deploy/staging/scripts/`. On a server they are installed together in `/srv/cell-ai-voicebot/deploy/`, and each release replaces them from its tag.

```bash
# on the server, as cav
export CAV_PROJECT=cav-prod
deploy/scripts/release.sh release-YYYYMMDD-<backend sha7>
deploy/scripts/rollback.sh               # to the previous release
deploy/scripts/status.sh
```

`rehearsal/run.sh <empty folder>` runs the kit on a laptop with real image builds, a bundled MongoDB and dummy keys: first deploy, second deploy, a release that throws at start, and a rollback. Never run it on a server.

## Phone calls (SIP, Phase 18)

Asterisk runs as `cav-prod-asterisk` only with the Compose profile `sip` ([ADR 0050](../../docs/adr/0050-sip-shared-server.md)).

1. Copy `deploy/asterisk/asterisk.env.example` to `env/asterisk.env` (600) and fill it from the trunk details ([sip-trunk.md](../../docs/integrations/sip-trunk.md)). Put the same `ARI_PASSWORD` into `env/backend.env` with `TELEPHONY_PROVIDER=sip`.
2. The client's admin opens UDP/TCP 5060 and UDP 20000–20999 **only from the trunk IPs** ([host-hardening.md](../../docs/ops/host-hardening.md)).
3. Release with the profile: `COMPOSE_PROFILES=sip release.sh <tag>`.
4. Accounts stay on the test line until a superadmin switches one to the phone line. Rollback: switch the account back, or stop `cav-prod-asterisk` (live calls end and are settled).
