# Staging deployment

One Ubuntu 24.04 server serves the SPA, API, WebSockets, media, workers and data stores. This directory is separate from the development compose stack. [Runbook](../../docs/ops/staging.md) · [Phase 13 prompt and owner gates](../../docs/prompts/PHASE_13_PROMPT.md).

Nothing here contains a credential. Copy `env.example` into `~/.cav-staging/backend.env` on the Mac, mode 600, and fill it outside chat/git. Copy `frontend.env.example` for **public** build values; backend secrets must never enter the frontend build. `compose.env.example` documents database passwords generated on the server by `scripts/init-secrets.sh`. `ops.env.example` holds the backup target and alert recipient; scoped AWS credentials belong in AWS's native credentials file or an instance role.

On the new staging server, the administrator installs this directory at `/srv/cell-ai-voicebot/deploy`, owned by `cav`, with group access for the trusted deploy user. Run `provision.sh` only after checking the host and supplying the team's SSH CIDRs. It prepares firewall rules; enable them only after testing a second SSH session. The deploy user is trusted to deploy application code and belongs to the `cav` group; the Docker-capable `cav` account is privileged. Protect both SSH keys accordingly.

```bash
# Server, after Gate A and provisioning; run as cav:
deploy/scripts/init-secrets.sh
deploy/scripts/status.sh

# Mac: archives the two committed refs, transfers them and builds on the server:
deploy/staging/deploy-from-mac.sh deploy@STAGING_HOST ~/.ssh/cav-staging.pem

# Server:
deploy/scripts/rollback.sh
deploy/scripts/tools.sh migrate status
deploy/scripts/backup.sh
deploy/scripts/restore.sh YYYYMMDDTHHMMSSZ
deploy/scripts/healthwatch.sh --test
```

The production image runs all commands using compiled JavaScript. `npm run build:ops` compiles smoke/demo tools and their seed dependencies into `dist-tools/`; regular ops entry points are in `dist/ops/`. Only the sample knowledge files and welcome tone used by those tools are shipped. No `tsx`, test sources, env files or Git history are required at runtime.

The database is MongoDB Atlas (`MONGODB_URI` in backend.env): deploy then starts only Redis and backups dump Atlas through a one-off tools container. The bundled `mongo` service (compose profile `bundled-mongo`) starts only for a bundled URI, e.g. the rehearsal.

The API and worker use Linux host networking; HTTP binds to loopback. Mongo and Redis use a bridge with loopback-only published ports. Mongo listens on port **27018 internally and externally** so its advertised single-node replica address works on either side. This differs from a 27017-in-container mapping; both the keyfile bootstrap and the replica address are checked in rehearsal. Never publish the data ports on all interfaces.

The worker uses port 5101, no public HTTP listener and no WhatsApp media. The API owns media on UDP 40000–40999. nginx serves `/api/`, `/ws/`, signed `/files/` downloads and SPA fallback; `/api/v1/health` includes build information, `/api/v1/ready` checks dependencies. Root `/health` and internal `/ready` remain compatible with the earlier server protocol.

Backups require `age`, `aws` (S3 target), Docker and Python 3.9+. They contain the encrypted app database (no oplog), uploads and collection counts. Seven daily/four weekly snapshots are retained within 30 days. Restore uses only the throwaway `cell-ai-voicebot-restore-check` project; it checks collection counts and safely extracts uploads. Pause writes during a count-comparison drill. Keep the age private identity on the owner's Mac; run the drill on the Mac with that identity.

Install the `systemd/` units after the first successful backup/restore. The backup timer runs at 02:30 UTC; healthwatch runs every five minutes and limits repeat mail to hourly per issue. Configure S3 versioning and expiry of current/noncurrent versions and an external HTTPS monitor at Gate A/B.

CI builds the image without publishing it and checks Dockerfile, compose, shell, nginx and workflow syntax. `deploy-staging.yml` is a manual workflow behind the GitHub `staging` environment. For a private frontend repository, a scoped read-only `STAGING_REPO_TOKEN` is needed in addition to the three staging SSH/host secrets. It is not activated or run by this local batch.
