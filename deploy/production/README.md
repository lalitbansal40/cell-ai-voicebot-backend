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
