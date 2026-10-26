# Staging runbook

**Status:** local implementation and rehearsal in progress. No staging host has been provisioned or deployed by this continuation. Gate A is required before any server connection. Meta dashboard work, real phones and App Review approval remain Gates B/C. [Prompt](../prompts/PHASE_13_PROMPT.md) · [Artifacts](../../deploy/staging/README.md).

## Layout and access

The app owns `/srv/cell-ai-voicebot/{src,releases,env,data,uploads,backups,logs,deploy}`. `cav` runs Docker, `deploy` uploads code and invokes the approved deploy script; the owner-provided administrator provisions the host. `env/` is 700 and secret files are 600. Use a different server from the client's production EC2. Keep a working administrator SSH session open while testing new keys and firewall rules.

Public ports are TCP 80/443 and UDP 40000–40999. SSH 22 is limited to the team's CIDRs. HTTP 5100, worker HTTP 5101, Mongo 27018 and Redis 6380 bind to loopback. nginx has query-free access logs, one-year immutable hashed assets, uncached HTML, WebSocket upgrades and long media timeouts. Start CSP in report-only mode, collect evidence in the real-browser checks, then enforce it.

## First server setup (Gate A)

1. Record the new host/IP/domain and run read-only checks first. Copy `deploy/staging/` as the administrator and run `provision.sh` with `CAV_ADMIN_USER`, `CAV_SSH_CIDRS` and `CAV_STAGING_HOST_CONFIRMED=yes`. Install authorized keys for both users, test a second session, then rerun with `CAV_ENABLE_FIREWALL=yes`.
2. Copy `backend.env`, `frontend.env` and `ops.env` into the app's `env/` directory. Run `init-secrets.sh` as `cav`; it creates database passwords/keyfile once and updates the matching runtime URIs. Never print these files. Give Node uid 1000 write access to uploads; the database keyfile is copied to a private uid-999 file inside Mongo at startup.
3. Render the HTTP-only nginx configuration, install the log format and proxy snippet, and obtain the certificate with certbot webroot. Render the full site, run `nginx -t`, and reload nginx. Install a certbot deploy hook that tests/reloads nginx; verify the renewal timer.
4. Use outside-in TCP/UDP tests, TLS assessment and SMTP DNS checks from the prompt. Record results here; none are claimed from a local container test.

## Deploy and rollback

`deploy-from-mac.sh user@host key [backend-ref] [frontend-ref]` archives committed code in the two repositories. It prints the immutable shas, never secrets. Source arrives under `src/<backend-sha>/`. Images build on the target CPU, migrations/indexes run before restart, and the web artifact is stored under `releases/<backend-sha>/web`. `current`/`previous` are atomic symlinks.

`deploy.sh` serializes deploys, checks internal readiness/build identity, switches the web pointer, then checks nginx-facing health, assets/cache/legal routes. Any failure after restart restores the prior image and web pointer; migrations are retained. Every migration must support the previous release. Shutdown exposes readiness 503 for one second, then closes live event sockets before waiting for the HTTP listener. Five recent releases plus current/previous are retained. Data/uploads are never removed by deploy or rollback. A first deploy has no earlier release; a failure requires the administrator to inspect status and fix the initial configuration.

After deploying, use `tools.sh` with temporary `CAV_TOOLS_ENV` files for superadmin/demo credentials. Remove temporary copies after use. The demo seed is idempotent, guarded by the exact APP_URL host and strong owner password; it creates 20 blocked fictional contacts plus the team's supplied phone numbers. It does not fabricate Meta channels. Only rehearsal.localhost accepts `--without-knowledge`, which creates pending sample sources without contacting OpenAI. On real staging, seed ingestion uses the configured provider and is chargeable.

The manual GitHub workflow uses the same archive/deploy path after its verify job and required environment review. Until Gate D, do not push or run the workflow. SSH host keys must be pinned in `STAGING_KNOWN_HOSTS` for Actions; first manual connection uses `accept-new`.

## Backups and restore drill

Configure `BACKUP_TARGET=s3://bucket/staging/` in `env/ops.env`, enable bucket versioning plus 30-day expiration for current and noncurrent versions and supply scoped credentials through an instance role/AWS credentials file. Store only the age recipient in `env/backup.pub`. `backup.sh` dumps Mongo with oplog, archives uploads excluding temporary recordings, encrypts both plus a count manifest, uploads all three, prunes managed timestamps and writes `backups/last-success` only after success.

Run `restore.sh <timestamp>` on the owner’s Mac with `CAV_BACKUP_IDENTITY` pointing to the Mac’s protected key. It uses project `cell-ai-voicebot-restore-check`, ports 27118/6480, never live ports. Supply `CAV_LIVE_COUNTS_FILE` exported from the quiesced staging database when running the drill on the Mac. Both live and backup-manifest collection counts must match; uploads must be readable and contain no escaping paths, symlinks or special files. Quiesce writes for a deterministic count comparison. The private identity stays on the Mac; only encrypted backups leave staging. Local folder targets are restricted to the rehearsal project.

Install/enable `cav-backup.timer` and `cav-healthwatch.timer` after this succeeds. Backup failures trigger alert mail immediately after a failed dump/upload. Monitor mail runs in a one-off image even if the API is down. Alert mail checks readiness, disk, free memory, new container restarts, certificate expiry and backup age. The first failed backup must be investigated; do not reset last-success manually.

## Incidents and rotation

- Start with `status.sh`, then inspect only `cav-stg-*` logs. Do not paste raw logs containing customer data or credentials. Readiness red means dependency/drain failure; health red means the process is unavailable.
- For a bad release, run `rollback.sh`; confirm health commit and SPA version, then reproduce locally before redeploying. Never down-migrate automatically.
- For storage pressure, inspect app-owned directories; retain backups off-server before pruning. Do not remove database files or uploads to make a deploy pass.
- Rotate one secret class at a time in the password manager and mode-600 files, redeploy, verify, then revoke the old secret. Changing ENCRYPTION_KEY requires a data-reencryption procedure; never replace it casually. Database passwords require coordinated database/user and URI changes; init-secrets preserves existing credentials.
- For certificate failures, verify DNS, ACME reachability and the renewal timer before forcing renewal. For Meta/SMTP/OpenAI/payment failures, use each setup guide and the owner's provider dashboard.

The owner must supply the staging operator and alert/on-call contacts at Gate A. No contact names or credentials are invented here.

## Local evidence

Rehearsal uses project `cell-ai-voicebot-rehearsal`, isolated data/ports, generated credentials, real production env validation, dummy provider keys and throwaway Mailpit. Docker Desktop uses bridge networking, service DNS/directConnection for Mongo, a proxy reload after container replacement, STARTTLS Mailpit and a local CA; the Linux host uses host networking for API/worker. These are rehearsal-only topology differences. Measurements and final check results will be entered after completion; no real provider or phone check is implied.
