# Production runbook

Production runs on the client's shared server; the design is in [ADR 0049](../adr/0049-production-shared-server.md) and the facts found so far in [PRODUCTION_AUDIT.md](PRODUCTION_AUDIT.md).

## Layout

| Path                                   | Holds                                                               |
| -------------------------------------- | ------------------------------------------------------------------- |
| `/srv/cell-ai-voicebot/releases/<sha>` | Source of each release (last 3 kept)                                |
| `/srv/cell-ai-voicebot/current`        | Link to the running release                                         |
| `/srv/cell-ai-voicebot/frontend/<sha>` | Built SPA of each release; `frontend/current` link                  |
| `/srv/cell-ai-voicebot/env/`           | `backend.env`, `compose.env`, `frontend.env`, `ops.env` (700 / 600) |
| `/srv/cell-ai-voicebot/uploads`        | Local files until the S3 switch                                     |
| `/srv/cell-ai-voicebot/backups`        | Temporary backup files only (uploaded, then removed)                |
| `/srv/cell-ai-voicebot/logs`           | Deploy, backup and healthwatch logs                                 |
| `/srv/cell-ai-voicebot/state`          | `deploy.lock`, `alerts.json`                                        |
| `/srv/cell-ai-voicebot/deploy`         | The kit from `deploy/production/`                                   |

## Access

Who has which key is kept by the owner, never in this file. Our deploy user may use Docker and our folder only. Never connect to `45.114.245.71` (old SMS box) or `13.232.191.62` (the client's other machine).

## Releases

A release is a tag in the client repo, made by `scripts/sync-client-repo.sh`. On the server, as `cav`, in the maintenance window:

```bash
export CAV_PROJECT=cav-prod
/srv/cell-ai-voicebot/deploy/scripts/release.sh release-YYYYMMDD-<backend sha7>
```

It checks env keys by name and 15 % free disk, installs the kit from the tag, backs up, unpacks the source, builds the image and SPA with their commits, migrates, waits up to 10 minutes for live calls to end, starts the new worker and API, checks `/ready` and the commit through nginx, and switches. Any failure after the restart puts the previous release back and exits non-zero. Each release adds a line to `logs/releases.log` and a row to [releases.md](releases.md).

A stopped API ends live calls with the technical line, which is why the release waits. The first cut-over doesn't: nothing tells it about the old setup, so check for live calls by hand first.

**Rollback:** `deploy/scripts/rollback.sh [<40-character sha>]`. Default is the previous release. Migrations stay; see the rule in `definition-of-done.md`.

## Local evidence (T17.4, 2 Nov 2026)

`deploy/production/rehearsal/run.sh` on the Mac: real image and SPA builds, migrations `0001`–`0018`, bundled MongoDB, dummy keys, plain HTTP through a container nginx.

| Step                              | Result                                                          |
| --------------------------------- | --------------------------------------------------------------- |
| First deploy                      | Pass, 48 s; `/health` shows the commit                          |
| Second deploy, with the call wait | Pass, 66 s                                                      |
| Release that throws at start      | Failed as meant; previous release restored, `current` unchanged |
| `rollback.sh` to a named release  | Pass, 4 s                                                       |

**Not rehearsed:** TLS, real nginx site file, host networking and UDP media, because Docker Desktop has no host networking. They wait for a staging server.

## Making a release in the client repo

From the Mac, with both our repos on the code to release:

```bash
scripts/sync-client-repo.sh <backend-ref> <frontend-ref> --dry-run
scripts/sync-client-repo.sh <backend-ref> <frontend-ref>
```

It stops with exit 2 if the client repo has new commits, or if its folders differ from the last release; bring those edits into our repos first. It stops with exit 3 if the new code holds anything that looks like a secret, or an `.env` file. It never forces a push. It also keeps `.github/workflows/build.yml` in that repo, which only proves each push builds.

If the repo becomes private, give the server a read-only deploy key and set `RELEASE_REPO_URL` in `env/ops.env` to the SSH address.

**Tagged so far:** `release-20261102-96cc375` on client commit `fb496c3` (Phase 16; not deployed).

## Backups and files

- **Database:** `deploy/scripts/backup.sh` every night at 02:00 IST (`cav-backup.timer`) and before each release. Encrypted with `age` to the owner's key, sent to `BACKUP_TARGET` in S3, 7 daily and 4 weekly kept. It records the result for Admin → System (`ops-record backup`). The server's S3 user should have put / get / list only, so it can't delete backups.
- **Restore drill:** on the owner's Mac with `deploy/scripts/restore.sh <timestamp>` and the private key (`CAV_BACKUP_IDENTITY`), into the throw-away `cell-ai-voicebot-restore-check` project. Then record it: `node dist/ops/ops-record.js restore-drill --rto-minutes <n>`.
- **Files to S3:** with `STORAGE_DRIVER=local` and `S3_BUCKET` / `S3_REGION` set, run `npm run storage:migrate-to-s3 -- --dry-run`, then without `--dry-run`. Each file is read back and compared by size and SHA-256; it stops at the first mismatch and resumes there. When it says all files are verified, set `STORAGE_DRIVER=s3` and release. Keys stay the same.

**Not done yet:** no backup has run on production and no drill has been timed, because there is no server access.

## Watching

| Check                | Where                         | Alert when                                                                       |
| -------------------- | ----------------------------- | -------------------------------------------------------------------------------- |
| Health and home page | UptimeRobot, every minute     | 2 failures in a row                                                              |
| Readiness            | `healthwatch.sh`, every 5 min | `/ready` not ok                                                                  |
| Disk, memory         | `healthwatch.sh`              | disk > 80 %, memory available < 10 %                                             |
| Certificate          | `healthwatch.sh`              | under 14 days                                                                    |
| Backup age           | `healthwatch.sh` + app check  | last good backup older than 26 h                                                 |
| Container restarts   | `healthwatch.sh`              | a new restart since the last run                                                 |
| MongoDB primary      | app check (`health-check.js`) | no primary                                                                       |
| Queues               | app check                     | `whatsapp` or `webhooks` waiting > 1,000; 50 more failed jobs since the last run |

Each alert key is mailed at most once an hour, through a one-off container, so mail works when the API is down. **Alerts tested:** none yet (needs a server).

**Admin → System** (`/admin/system`, superadmins) shows the commit, build time, MongoDB, Redis, queues, last backup, drill and release, certificate days and superadmins without 2FA. Set `TLS_CERT_PATH` to the certificate file to get the certificate line.

## Security settings (T17.11)

- **Headers:** our nginx file sends HSTS once, plus `nosniff`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` and the CSP; set `HSTS_BY_PROXY=true` so the API doesn't send HSTS too.
- **CSP:** starts report-only (`render-nginx.sh <host> --csp report`), with `report-uri /api/v1/csp-report`. Look for `csp: blocked` warnings in the API logs while using the Meta sign-up popup, Razorpay checkout, a web call and audio playback. After 7 days without such lines, render with `--csp enforce`, `nginx -t`, reload. Undo: render with `--csp report` again.
- **Two-step sign-in:** when Admin → System shows 0 superadmins without it, set `MFA_ENFORCED_FOR_ADMINS=true` and release.
- **Env values to check by name:** `API_DOCS_ENABLED`, `MOCK_APIS_ENABLED`, `BILLING_SIMULATOR_ENABLED` unset or false; `PAYMENT_PROVIDER=razorpay`; `TRUST_PROXY` set; `SUPPRESSION_HMAC_KEY` present. `release.sh` checks the secrets are present, never their values.
- **Razorpay:** if top-ups fail with `PROVIDER_ERROR`, the API log line `razorpay: request rejected` has Razorpay's status, code and description. Usual causes: a test key id with a live secret, a key pair that doesn't match, or the account not activated for live payments.
- **Host:** see [host-hardening.md](host-hardening.md).
- **Secret rotation:** [secret-rotation.md](secret-rotation.md), staging first, `ENCRYPTION_KEY` last.

**Not done yet (needs access or owner action):** headers and CSP on the live nginx, the 7-day CSP check, secret rotation, 2FA set-up by each superadmin, the Razorpay fix and a ₹1 live top-up, SPF / DKIM / DMARC check, host hardening.

## Phone calls (SIP, Phase 18)

**Not live yet:** no trunk details (Gate S) and no server access (Gate P) on 3 Nov 2026. When both exist:

1. Server audit confirms 5060, 20000–20999 and 8088 are free; the client's admin opens SIP / RTP to the trunk IPs only ([host-hardening.md](host-hardening.md)).
2. `env/asterisk.env` from `deploy/asterisk/asterisk.env.example`; `backend.env`: `TELEPHONY_PROVIDER=sip`, `ARI_PASSWORD` (same value), `SIP_CALLER_ID`, `SIP_MAX_CHANNELS` / `SIP_MAX_CPS` from the trunk; the RTP range at least 4 × channels ([capacity.md](capacity.md)).
3. `COMPOSE_PROFILES=sip release.sh <tag>`. Every account stays on the test line.
4. Admin → Phone numbers: add the 1600 numbers, give one to the owner's test account; switch that account to the phone line; run the [sip-trunk.md](../integrations/sip-trunk.md) §2 checklist with at most 5 calls to the owner's phones.
5. Rollback drill: the account back to the test line (under a minute); then `docker stop cav-prod-asterisk` and see new calls answer `LINE_BUSY` without errors.
6. Pilot accounts only after that (Phase 21).
