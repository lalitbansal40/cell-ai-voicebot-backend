# Phase 17 — Production Deployment & Operations (Detailed Plan)

**Status:** Locked — 2026-11-02 (owner defaults §7 #1–#11 in force) · **Branch:** `feature/phase-17-production` (both repos, from `main` = backend `96cc375`, frontend `b970099`) · **Overview:** [BUILD_PLAN_V2.md](../plans/BUILD_PLAN_V2.md) §4 Phase 17 · **Previous:** [PHASE_16_PLAN.md](PHASE_16_PLAN.md) · [sign-off](PHASE_16_SIGNOFF.md)

> **Live context (checked 2 Nov 2026, public requests only):** the app already runs for the client at `https://wa.notifynow.in` on the client's server (`154.210.160.233`) and the client's database. The client's team deploys by pulling the public repo `Cell24x7/cell-ai-voicebot` (folders `cell-ai-voicebot-phase13/backend` and `/frontend`) and rebuilding. We have **no SSH access** to that server. `GET /api/v1/health` answers `commit: "unknown"`, `builtAt: "unknown"`, so nobody can tell which code is live. The page sends HSTS only. Phase 16 was pushed to the client repo as `fb496c3` and is **not deployed yet**. Meta App Review was submitted on 30 Oct 2026 and is pending. Today a wallet top-up failed with `PROVIDER_ERROR` (Razorpay refused the order). The cause is on the server: keys or account mode.
>
> So Phase 17 is not a first deploy. It turns a production that the client runs by hand into one that is **known, repeatable, backed up, watched and recoverable**, without touching anything else on that server.

---

## 0. Is phase ka goal

Phase 17 ke end tak:

- Hum jaante hon ki production server par kya chal raha hai: OS, resources, database, Redis, nginx, ports, doosri apps, aur kaunsa commit live hai.
- Har release **ek command** se deploy ho, `GET /health` par sahi commit dikhe, migration pehle chale, aur kuch toote to **ek command** se rollback ho.
- Database aur uploads ka backup roz off-server jaaye, encrypted ho, aur restore **sach mein test** hua ho (time ke saath).
- Site down ho, disk bhare, queue phase jaaye, certificate expire hone wala ho, ya backup fail ho, to **alert aaye**, kisi ke dekhne se pehle.
- Phase 16 ke production-wale open items band hon: secrets rotate, DNS theek, CSP enforce, superadmin 2FA on, Razorpay theek, capacity real server par naapi hui.
- Doosri app (client ki) ko kuch na ho: alag user, folder, ports, Docker network, nginx block.

**Done when:**

- `docs/ops/PRODUCTION_AUDIT.md` exists, filled from a read-only audit of the real server, and every risk in it is fixed or an open item with an owner.
- `GET /api/v1/health` on `wa.notifynow.in` shows the real `commit` and `builtAt` of the deployed release, on **every DNS address** of the host.
- A release goes out with one documented command, runs migrations before the switch, passes post-deploy checks, and a rollback rehearsal on the real server takes under 5 minutes.
- Backups run every night plus before every deploy, go off-server encrypted, and one **timed restore drill** onto a separate database has passed (RPO and RTO recorded).
- An external uptime monitor and the server healthwatch send alerts to the agreed people; each alert type has been triggered once on purpose and received.
- `npm run check:headers -- https://wa.notifynow.in` passes with CSP enforced, and the old A record `45.114.245.71` is gone.
- Phase 16 is deployed to production with its release checklist ticked, and the wallet top-up works with live Razorpay.
- Capacity numbers from the production-sized server are in `docs/ops/capacity.md`, and the wallet-latency finding from Phase 16 is fixed or re-scoped with numbers.
- Full verify on both repos + Playwright twice green; runbooks and sign-off done.

### Phase 17 mein kya NAHI hoga

| Kaam                                                                    | Kahan                                |
| ----------------------------------------------------------------------- | ------------------------------------ |
| SIP trunk, real phone numbers, NAT for SIP                              | Phase 18                             |
| Inbound phone calls                                                     | Phase 19                             |
| Bulk WhatsApp campaigns and bulk WhatsApp calling                       | Phase 20                             |
| Pilot with real customers, launch                                       | Phase 21                             |
| Multi-server high availability, Kubernetes, auto-scaling                | Not planned; revisit after the pilot |
| Changing or touching the client's other apps or the EC2 `13.232.191.62` | Never                                |
| Customer 2FA, outside paid pen-test                                     | Owner decision (Phase 16 §7)         |

---

## 1. Findings and locked decisions

### 1a. Urgent findings (act before or at the start of the phase)

| #   | Finding                                                                                                                                                            | Why it matters                                                                          | Owner                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ---------------------- |
| U1  | **Closed 2 Nov 2026 (DNS shows one address).** `wa.notifynow.in` still has a second A record `45.114.245.71` (old SMS box, HTTPS fails)                            | Some visitors and Meta webhook calls can fail                                           | Client DNS             |
| U2  | Secrets (Meta App Secret, env files, review account password) were shared through chat                                                                             | Must be rotated                                                                         | Owner                  |
| U3  | The deploy repo `Cell24x7/cell-ai-voicebot` is public                                                                                                              | Anyone can read the code and docs; making it private changes how the server pulls       | Owner / client         |
| U4  | Live health shows `commit: unknown`                                                                                                                                | No one can tell which code runs; rollback target unknown                                | Us (T17.4)             |
| U5  | Wallet top-up fails with `PROVIDER_ERROR`                                                                                                                          | Customers cannot pay; the server log line `razorpay: request rejected` gives the reason | Client team + us       |
| U6  | Phase 16 pushed but not deployed; it needs `SUPPRESSION_HMAC_KEY` and migration `0018`; the calling-hours ceiling (08:00–19:00) refuses wider windows after deploy | First production release of this phase; behaviour change for accounts                   | Owner confirms ceiling |
| U7  | Meta App Review pending since 30 Oct                                                                                                                               | Don't disconnect the review number or change the review password                        | Owner                  |

### 1b. What exists today (reuse, don't rebuild)

- **Deploy kit** `deploy/staging/` (Phase 13): `compose.yaml` (api, worker, mongo, redis), `provision.sh`, `init-secrets.sh`, `deploy.sh` (serialised, readiness gate, automatic restore on failure), `rollback.sh`, `backup.sh` + `restore.sh` (age-encrypted, S3), `healthwatch.sh` + systemd timers, `check-image.sh`, `check-nginx.sh`, `render-nginx.sh`, `status.sh`, `tools.sh`, nginx templates, `deploy-from-mac.sh`. Rehearsed locally on 26 Oct 2026, never run on a real server.
- **CI:** `.github/workflows/ci.yml` (verify) and `deploy-staging.yml` (manual, environment review, pinned host keys). Never run.
- **Read-only audit script** `scripts/server-audit.sh` (allow-listed commands, prints no secrets).
- **App:** `GET /health` and `/ready`, build identity from `GIT_SHA` / `BUILT_AT`, `WORKERS_ENABLED` to split API and worker, `STORAGE_DRIVER=local|s3`, `TRUST_PROXY`, `HSTS_BY_PROXY`, `MFA_ENFORCED_FOR_ADMINS`, `API_DOCS_ENABLED`, maintenance jobs, `keys:reseal`, `check:headers`, `superadmin:create`, `db:migrate`.
- **Docs:** `docs/ops/staging.md` (runbook), `GATE_A.md`, `secret-rotation.md`, `nginx-security-headers.md`, `capacity.md`, `release-phase-15.md`, `release-phase-16.md`.
- **Load scripts** `perf:inbox`, `perf:api`, `perf:ws`, `perf:soak`, `bench:voice`.

### 1c. Gaps found

| Gap                                                                                                                    | Task         |
| ---------------------------------------------------------------------------------------------------------------------- | ------------ |
| No knowledge of the production server's setup                                                                          | T17.1        |
| Releases built without `GIT_SHA` / `BUILT_AT`                                                                          | T17.4        |
| Copying our `main` into the client repo is manual (risk of lost client edits)                                          | T17.5        |
| No production deploy kit (staging kit has staging names, ports, Atlas assumptions)                                     | T17.4        |
| Unknown whether production MongoDB is a replica set (wallet transactions need it), has auth, is reachable from outside | T17.1, T17.7 |
| Unknown whether Redis has persistence and `maxmemory-policy noeviction` (BullMQ needs it)                              | T17.1, T17.7 |
| Uploads and recordings probably on local disk, not backed up                                                           | T17.6        |
| No off-server backup, no restore drill                                                                                 | T17.6        |
| No external uptime monitor, no alerts                                                                                  | T17.8        |
| Log rotation and retention unknown; logs may fill the disk                                                             | T17.8        |
| API and workers may run in one process (load checks showed the queue competes with requests)                           | T17.2, T17.9 |
| Capacity measured on a laptop only; Mongo stall seen locally, cause unknown                                            | T17.9        |
| Sends on one wallet slow at 50 / s (Phase 16 finding)                                                                  | T17.10       |
| CSP report-only, HSTS sent by app and maybe nginx                                                                      | T17.11       |
| Superadmin 2FA not enforced                                                                                            | T17.11       |
| E2E backend process ended once, cause unknown                                                                          | T17.10       |
| Three virtual-clock test flakes                                                                                        | T17.10       |
| No staging environment that matches production                                                                         | T17.3        |
| No incident runbook with names and phone numbers                                                                       | T17.13       |

### 1d. Decisions (defaults; the owner can change them in §7)

1. **Isolation on the shared server:** our app runs as its own Linux user `cav`, under `/srv/cell-ai-voicebot/`, as Docker Compose project `cav-prod` on its own network, with its own ports bound to `127.0.0.1` only, and its own nginx `server` block in its own file. Nothing of the client's other apps is read, restarted or reconfigured.
2. **Deploy model (until we get access):** the client's team runs **one script** `deploy/production/scripts/release.sh <tag>` on the server; it does backup → pull → build with `GIT_SHA` / `BUILT_AT` → migrate → switch → checks → rollback on failure. With access (§7 #1) the same script runs from GitHub Actions after an approval.
3. **Releases are tags** in the client repo (`release-YYYYMMDD-<backend sha7>`), made by `scripts/sync-client-repo.sh` from our `main`. The script refuses if the client changed files we would overwrite.
4. **Processes:** separate `api` and `worker` containers (`WORKERS_ENABLED=false` / `true`). The worker runs the queues; the API answers requests and calls.
5. **Database:** stay on the client's MongoDB (it already holds production data). It must be a replica set with auth, bound to private addresses only, with a least-privilege app user. If it isn't, T17.7 fixes it in a maintenance window, or the owner chooses Atlas (§7 #3).
6. **Uploads and recordings:** move to S3 (`STORAGE_DRIVER=s3`, region `ap-south-1`) so they survive the server and are backed up by the bucket (versioning). Until then, they are in the nightly backup.
7. **Backups:** nightly at 02:00 IST plus before every release; `mongodump` compressed and encrypted with `age`, to an S3 bucket with versioning and 30-day expiry; 7 daily, 4 weekly, 3 monthly kept. Target **RPO 24 h** (1 h after §7 #4 if the owner wants it) and **RTO 2 h**.
8. **Monitoring:** UptimeRobot (free) on `/api/v1/health` and the home page every minute, plus `healthwatch.sh` every 5 minutes on the server (readiness, disk, memory, queue depth, failed jobs, certificate days, backup age). Alerts by e-mail; WhatsApp alert to the owner's number through our own app is a stretch goal.
9. **Logs:** JSON to Docker's `local` driver with rotation (50 MB × 5 per container), kept 14 days; never phones, names, texts, tokens (rule from Phase 16).
10. **Staging:** a second Compose project `cav-stg` on **another** small server if the client provides one (§7 #2); otherwise staging is the local rehearsal plus a copy of production restored on the Mac. Never on the production database.
11. **Security on the server:** SSH key-only, no root login, firewall allows 22 (office IPs), 80, 443 and UDP 40000–40999 (WhatsApp calling media); automatic security updates; fail2ban for SSH. These are host-wide, so the client's admin applies them with our checklist (§7 #5).
12. **CSP:** enforced after one week of report-only with no violations from the Meta sign-up popup and Razorpay checkout.
13. **Secrets:** in `/srv/cell-ai-voicebot/env/*.env`, mode 600, owner `cav`; copies only in the owner's password manager. Never in Git, chat or tickets.
14. **Nothing runs against production data from our machines.** Load tests, restore drills and re-seal dry runs use a copy.

---

## 2. Tasks ka overview

| #      | Task                                                                        | Repo     | Size | Needs access / client       |
| ------ | --------------------------------------------------------------------------- | -------- | ---- | --------------------------- |
| T17.1  | Read-only production audit                                                  | docs     | S    | Yes (client runs script)    |
| T17.2  | Production topology + ADR 0049                                              | docs     | S    | No                          |
| T17.3  | Staging environment                                                         | ops      | M    | Server (§7 #2)              |
| T17.4  | Production deploy kit + build identity                                      | BE + ops | M    | No (build), yes (first run) |
| T17.5  | Client repo sync + release tags + CI                                        | ops      | M    | Repo write (have it)        |
| T17.6  | Backups, uploads to S3, restore drill                                       | BE + ops | M    | Yes                         |
| T17.7  | Database and Redis production readiness                                     | ops      | M    | Yes                         |
| T17.8  | Monitoring, alerts, logs                                                    | ops      | M    | Yes                         |
| T17.9  | Capacity on the production-sized server                                     | BE       | M    | Staging server              |
| T17.10 | Performance fix (wallet) + open test flakes                                 | BE       | M    | No                          |
| T17.11 | Server and app security go-live (headers, CSP, 2FA, secrets, DNS, Razorpay) | both     | M    | Yes                         |
| T17.12 | First managed release: Phase 16 to production                               | ops      | M    | Yes                         |
| T17.13 | Runbooks, on-call, game day                                                 | docs     | S    | Client contacts             |
| T17.14 | Meta: App Review follow-up, Tech Provider, client's real number             | ops      | S    | Owner / Meta                |
| T17.15 | Gap audit, docs, sign-off                                                   | both     | S    | No                          |

Code tasks we can do now without access: T17.2, T17.4 (kit), T17.5, T17.6 (S3 code + scripts), T17.8 (scripts), T17.10. Everything on the real server waits for the inputs in §7 and the Gate list in §8.

---

## 3. Tasks — step by step

### T17.1 — Read-only production audit (docs)

1. Send the client's admin `scripts/server-audit.sh` with a one-line command to run it and paste the output (or run it ourselves over read-only SSH if §7 #1 gives access). Before sending, extend it (still read-only, still allow-listed) with:
   - Docker: `docker ps --format` names, images, status, ports (no `inspect`, no `env`), `docker compose ls`, `docker network ls`, `docker volume ls`, disk use per volume.
   - Our app: the folder it runs from, how it starts (Compose, PM2 or systemd), which process listens on which port (`ss -ltnup` without arguments of processes).
   - nginx: list of enabled site files and their `server_name` lines only (no `nginx -T`, no file contents).
   - TLS: certificate issuer and expiry date for `wa.notifynow.in` (`openssl x509 -noout -dates -issuer`), renewal timer present.
   - MongoDB: version, whether it runs in Docker or on the host, bind address, `rs.status().ok` and member count, auth on or off — through a command the client's admin runs, never printing users or the URI.
   - Redis: version, bind address, `CONFIG GET maxmemory-policy`, `appendonly`, `save`, used memory.
   - Firewall: `ufw status` or security-group description from the cloud console (screenshot from the client).
   - Time sync (`timedatectl`), swap, kernel, unattended upgrades, log rotation for Docker.
   - Free disk and inode use on `/` and the data volume; growth of the database folder.
   - Existing backups: any cron or timer, where they go.
2. Write `docs/ops/PRODUCTION_AUDIT.md`: a table per area (what, value, risk, action, owner). Put no secrets, no customer data, no internal IPs of other apps.
3. Classify every risk: **blocker** (fix before T17.12), **this phase**, **later**.
4. Check from outside (public only): DNS A / AAAA / CAA records, `check:headers`, TLS (protocols, ciphers, chain), open ports seen from the internet (TCP 80 / 443 / 22 and that 5100, 27017, 27018, 6379, 6380 are **closed**), UDP 40000–40999 reachable for calling.
5. **Done:** the audit file is reviewed with the owner; blockers listed in §8.

### T17.2 — Production topology + ADR 0049 (docs)

1. Draw the production layout (one diagram in the ADR): DNS → nginx (client's) → our `api` (127.0.0.1:5100) and static frontend; `worker`; MongoDB; Redis; S3; Meta, OpenAI, Razorpay, SMTP; UDP media ports.
2. Decide and record (from the audit): process split, ports, Compose project name, network, volumes, where env files live, who owns nginx changes, how certificates renew, how media ports pass the firewall.
3. Resource budget for our app on the shared server: CPU and memory limits per container (`deploy.resources.limits`), so our app can't starve the client's other app and the reverse. Default: api 2 CPU / 2 GB, worker 1.5 CPU / 1.5 GB, redis 512 MB; adjust after T17.9.
4. ADR 0049 "Production on the client's shared server" with the decisions in §1d, the alternatives (own server, Atlas, managed Redis) and why.
5. **Done:** ADR in the index; topology matches the audit.

### T17.3 — Staging environment (ops)

1. With a staging server (§7 #2): provision with `provision.sh`, Compose project `cav-stg`, subdomain `staging.wa.notifynow.in` (or what the owner picks), its own database and Redis, Razorpay **test** keys, OpenAI key with a low monthly cap, Meta test app or the same app in development mode, `EMAIL_DRIVER=smtp` to a test mailbox.
2. Without one: document the local rehearsal (Phase 13) as staging, and add "restore last night's production backup into a local throw-away database, run migrations, run smoke" as the pre-release check.
3. Every release goes to staging first; smoke + key pages checked; then production.
4. Staging is excluded from alerts to the client, and marked "Staging" in the page title and a banner (frontend env `VITE_ENV_LABEL`).
5. **Done:** a release goes through staging with the same script as production.

### T17.4 — Production deploy kit + build identity (backend + ops)

1. Copy `deploy/staging/` to `deploy/production/` and change: project `cav-prod`, container prefix `cav-prod-*`, env file names, no bundled MongoDB when an external URI is set, nginx template for `wa.notifynow.in` with the Phase 16 headers, HSTS sent by nginx only (`HSTS_BY_PROXY=true`).
2. **Build identity:** `Dockerfile` takes build args `GIT_SHA` and `BUILT_AT`; `release.sh` passes them; the frontend build writes `VITE_GIT_SHA` and shows it in Admin → System (and in `/version.json`). Test: an image built by the script answers `/health` with the commit.
3. `release.sh <tag>`:
   1. Refuse if another deploy runs (lock), if disk < 15 % free, or if the tag isn't in the repo.
   2. Backup now (T17.6) and wait for it; abort if it fails.
   3. Build images on the server, tag `cav-prod-api:<sha>`; keep the last 3 images for rollback.
   4. Run migrations with the new image (`node dist/ops/migrate.js up`), then `sync-indexes`.
   5. Start the new `worker`, then the new `api`; wait for `/ready` and `/health` with the expected commit.
   6. Switch the frontend `current` link to the new build folder.
   7. Post-deploy checks: health through nginx on every DNS address, home page, `/privacy`, a static asset with cache headers, login page, `check:headers`, WebSocket upgrade, Meta webhook GET verification answers 403 without the token.
   8. On any failure: put back the previous images and frontend link, keep migrations (they are written to be backward compatible), alert, exit non-zero.
   9. Print a summary: old → new commit, time taken, checks passed. Never print env values.
4. `rollback.sh` (to the previous release, or to a named one), `status.sh` (versions, containers, queue depth, last backup, certificate days).
5. **Zero-downtime goal:** nginx keeps serving the old API until the new one is ready; WebSocket clients reconnect (they already do); in-flight calls are drained (`SIGTERM` waits for live calls up to 10 min — check the current drain logic and set the stop timeout to match).
6. Migration rule written into `docs/conventions/definition-of-done.md`: every migration must work with the previous release still running (expand, then contract in a later release).
7. Tests: shellcheck on all scripts in CI; a Docker-based rehearsal on the Mac (as Phase 13) covering first deploy, second deploy, forced failure and rollback.
8. **Done:** rehearsal passes; `docs/ops/production.md` describes the kit.

### T17.5 — Client repo sync, release tags, CI (ops)

1. `scripts/sync-client-repo.sh <backend-ref> <frontend-ref>`: the steps from the memory, as code:
   1. Fetch the client repo; refuse if it has commits we haven't seen.
   2. Compare the client's two folders with `git archive` of the last released shas; list any file the client changed; stop and show them (the client once edited 4 branding files).
   3. Export the new refs into the folders, scan the diff for keys / URIs / `.env` files, commit as "Update NotifyNow code (backend <sha>, frontend <sha>)", tag `release-<date>-<sha7>`, push. Never `--force`.
   4. Write the release notes file for that tag from the phase release doc.
2. CI in the client repo (we have write access): on every push, check that both folders build (`npm ci`, typecheck, build) — not the full tests (they run in our repos). Add Dependabot alerts only (no automatic PRs there).
3. If the owner makes the repo private (U3): a read-only **deploy key** on the server for `git pull`; document how to add it.
4. **Done:** one release made end to end with the script; the tag points to the commit the server runs.

### T17.6 — Backups, uploads to S3, restore drill (backend + ops)

1. **S3 storage for uploads and recordings:** check the `s3` storage driver covers every writer (recordings, inbox media, exports, knowledge files, import files, invoices). Migration script `storage:migrate-to-s3` (resumable, dry run first, counts only, never file names with personal data in logs). Signed URLs keep their 15-minute lifetime.
2. **Backups:** adapt `backup.sh` for production: `mongodump --oplog` (consistent with a replica set) → `zstd` → `age` → S3 `prod/` prefix; record size and duration; before-release backups tagged with the release.
3. Lifecycle: daily 7, weekly 4, monthly 3; bucket versioning on, public access blocked, an IAM user limited to that prefix (put / get / list), no delete for the server user (deletion by lifecycle only, so a compromised server can't erase backups).
4. **Restore drill** on a separate machine (owner's Mac or staging): `restore.sh <timestamp>` into a throw-away database, run migrations, start the app against it with `WORKERS_ENABLED=false`, sign in, open a call page and a chat, count documents per collection against the backup's manifest. Record the time → RTO.
5. Monthly drill reminder (calendar) and a line in `status.sh` for "last successful restore drill".
6. The age private key stays only with the owner (offline copy + password manager). Without it, backups are useless: write that in the runbook.
7. **Done:** backups for 3 nights in the bucket; one timed drill passed.

### T17.7 — Database and Redis production readiness (ops)

1. MongoDB (from the audit):
   - Replica set (single member is fine) — required for transactions; if not, convert in a maintenance window with a backup first.
   - Auth on; app user with `readWrite` on the app database only; admin user only with the client's admin.
   - Bound to `127.0.0.1` or the private network; port closed from the internet (checked from outside).
   - Version: 8.0 or 8.2 per the kernel note in `server-audit.sh`; record it.
   - WiredTiger cache sized so MongoDB + our containers + the client's app fit in memory; swap on as a safety net, not as working memory (Phase 16 saw swap nearly full when Mongo stalled).
   - Slow query log at 200 ms; profiler off.
   - `npm run db:migrate:status` clean; `sync-indexes` run; disk alert at 80 %.
2. Redis: password or bound to loopback only, `maxmemory-policy noeviction` (BullMQ), AOF `everysec`, memory limit, port closed from outside.
3. Connection pool sizes per process recorded (API `maxPoolSize` 20 today) against MongoDB's connection limit.
4. **Done:** each item ticked in `PRODUCTION_AUDIT.md`.

### T17.8 — Monitoring, alerts, logs (ops)

1. External: UptimeRobot monitors for `https://wa.notifynow.in/api/v1/health` (keyword `"status":"ok"`) and the home page, every 1 minute, alert after 2 failures, to the alert e-mails (§7 #6). One more monitor per DNS address until U1 is fixed.
2. `healthwatch.sh` every 5 minutes (systemd timer) alerts when: `/ready` not ok; disk > 80 %; memory available < 10 %; `whatsapp` or `webhooks` queue waiting > 1,000 for 10 minutes; failed jobs rising; certificate < 14 days; last backup > 26 h old; MongoDB primary missing (the Phase 16 stall); container restarts > 3 in an hour. Each alert says what to check first (runbook link).
3. Mail for alerts goes through a provider that works when our app is down (healthwatch uses its own one-off image, as in Phase 13).
4. Logs: Docker `local` driver with rotation; `status.sh logs <service> --since 1h` filtered to level ≥ warn; a weekly log grep for secrets and personal data (the Playwright grep patterns) on the server.
5. App metrics we already log (`metric:` fields): add a superadmin **System** page reading queue depths, failed jobs, last backup, current commit, MongoDB and Redis status (no new external service). Frontend card in Admin.
6. Stretch: WhatsApp alert to the owner through the app's own template sending (only when the app is up — so e-mail stays the main channel).
7. Test every alert once on purpose (stop the API on staging, fill a test disk, expire a fake certificate date in the check) and record the time it arrived.
8. **Done:** alert table in `docs/ops/production.md` with "tested on" dates.

### T17.9 — Capacity on the production-sized server (backend)

1. On staging with the same CPU / memory as production (never on production): run `perf:inbox`, `perf:api -- messages`, `perf:api -- calls`, `perf:ws`, `perf:soak` (1 h) and `bench:voice`.
2. Voice: allow the bench to go past 20 calls (bench-only override, product limit unchanged) to find where late ticks > 5 % or stalled frames appear; set `CALL_LIMITS.concurrentPerProcess` from that with 30 % headroom.
3. Watch MongoDB during the soak (primary present, op latency, memory, swap). If the stall from Phase 16 repeats, capture `mongod` logs and server stats at that minute, and fix the cause (memory, I/O, cache size).
4. Record numbers in `docs/ops/capacity.md` next to the Mac numbers, with the server size.
5. **Done:** each target pass / fail with evidence; per-process limits set.

### T17.10 — Performance fix (wallet) and open flakes (backend)

1. **Wallet latency at 50 sends / s on one account** (Phase 16): measure where time goes (hold, delivery-status charge, transaction length). Options in order: shorter transactions (no reads inside that can move out), one charge per delivery status batch, a per-account single-writer queue instead of the in-process lock (works across API and worker processes). Target: p95 < 500 ms at 50 / s with exact money and 0 double charges. Regression test with the existing wallet tests plus `perf:api -- messages` numbers.
2. The in-process wallet lock from `3d915b1` only orders changes inside one process; with separate API and worker processes (T17.2) conflicts can return. Prove with a two-process test, then fix with the chosen option.
3. Flakes: `calls/outbound` (wrong number), `db/seed-calls`, `calls/ai-call` (typed values): find the race at the cause (no timeout raises), 5 full backend runs in a row green.
4. E2E backend process ended once during Playwright: run the suite with `E2E_BACKEND_LOGS=1` and keep stderr to a file; if it repeats, the fatal log line shows the cause.
5. **Done:** targets met or re-scoped with numbers; 5 green runs recorded.

### T17.11 — Server and app security go-live (both)

1. **DNS (U1):** client removes `45.114.245.71`; `check:headers` shows one address.
2. **Secrets (U2):** rotate per `docs/ops/secret-rotation.md`, one class at a time: Meta App Secret (and webhook verify token), JWT secrets, `ENCRYPTION_KEY` (with `ENCRYPTION_KEYS_OLD` and `keys:reseal`, dry run first, on production after a backup), SMTP, OpenAI, Razorpay, database passwords. Record dates in the runbook, not the values.
3. **Repo (U3):** owner decides; if private, deploy key (T17.5).
4. **Headers:** apply `docs/ops/nginx-security-headers.md`; HSTS once; CSP report-only for 7 days with a report endpoint, then enforce; re-check Meta Embedded Signup popup, Razorpay checkout, WebSocket, audio playback.
5. **Superadmin 2FA:** every superadmin sets it up and stores recovery codes; then `MFA_ENFORCED_FOR_ADMINS=true`.
6. **App settings:** `API_DOCS_ENABLED` off, `TRUST_PROXY` set to nginx only, `MOCK_APIS_ENABLED` off, `BILLING_SIMULATOR_ENABLED` off, `PAYMENT_PROVIDER=razorpay`, `EMAIL_DRIVER=smtp` with SPF / DKIM / DMARC passing (check with a mail tester), OpenAI project key with a monthly budget cap.
7. **Razorpay (U5):** read the `razorpay: request rejected` log line; check key mode (live vs test), key pair match, account activation; re-test a ₹1 top-up end to end (order → pay → webhook → wallet credited → GST invoice); set the Razorpay webhook URL and secret; check the webhook's signature path is exempt from the global rate limit (done in Phase 16).
8. **Host (client's admin, our checklist):** SSH keys only, no root login, firewall rules, fail2ban, unattended security upgrades, time sync.
9. **Done:** `PENTEST_CHECKLIST.md` CSP and DNS rows closed; Razorpay top-up proven.

### T17.12 — First managed release: Phase 16 to production (ops)

1. Pre-checks: owner confirmed the calling-hours ceiling (U6) or set a different one; `SUPPRESSION_HMAC_KEY` generated and stored; release notes read by the client's team; maintenance window agreed (low traffic time, IST).
2. Staging first (T17.3), then production with `release.sh`.
3. After deploy, the checklist from `docs/ops/release-phase-16.md`, plus: health commit equals the tag; a test call on the dry-run line; a WhatsApp message in and out on the review number (without disconnecting it); a template send; wallet top-up (T17.11); Compliance page; superadmin 2FA prompt.
4. Watch alerts and logs for 24 hours.
5. Rollback criteria written before the deploy (e.g. any 5xx rate > 2 % for 10 minutes, webhooks failing, logins failing).
6. **Done:** release record in `docs/ops/releases.md` (date, tag, who, duration, checks, issues).

### T17.13 — Runbooks, on-call, game day (docs)

1. `docs/ops/production.md`: layout, access, deploy, rollback, backups, restore, alerts, logs, secrets, certificate renewal, where each config lives.
2. Incident runbook per symptom: site down; API up but `/ready` red; MongoDB down or no primary; Redis down; disk full; queue backlog (Meta webhooks, sends); Meta webhooks failing or unverified; OpenAI errors; Razorpay failures; SMTP failures; certificate expired; a bad release; a leaked secret; a customer asks for data export or erasure (Phase 16 tools).
3. On-call: names, phone numbers and order (from the owner, §7 #6), what the client's team does vs what we do, response times.
4. **Game day** on staging: stop MongoDB, stop Redis, fill the disk, break a release, restore a backup; time each recovery; fix the runbook where it was wrong.
5. **Done:** game day results recorded; runbook reviewed by the client's team.

### T17.14 — Meta: App Review follow-up, Tech Provider, client's real number (ops)

Carries over Phase 13 T13.8–T13.10 that are still open.

1. Track the App Review result (submitted 30 Oct 2026); answer Meta's questions; resubmit with fixes if rejected.
2. After approval: app Live, Advanced Access confirmed, Tech Provider steps, the client's real number connected through Embedded Signup, webhook fields subscribed, calling settings synced.
3. Real-phone checks on production (Android + iPhone): message in / out, template, call permission, a WhatsApp call, media.
4. Account billing stays "Customer pays Meta" (we are a Tech Provider, not a BSP).
5. **Done:** Phase 13 tracker ticked for these rows, or open items with Meta's dates.

### T17.15 — Gap audit, docs, sign-off (both)

1. Gap audit against §0 Done-when, §4 and every row of §1c; each gap fixed or an open item with an owner.
2. Docs: `production.md`, `PRODUCTION_AUDIT.md`, `capacity.md`, `releases.md`, ADR 0049 in the index, `staging.md` pointers, both READMEs (deploy section), both CHANGELOGs, BUILD_PLAN_V2 changelog ("Phase 17 done … Next: Phase 18"), `docs/ops/release-phase-17.md`.
3. `docs/phases/PHASE_17_SIGNOFF.md` (Phase 16 format): scope, server facts, releases made, backup + drill numbers, alert tests, capacity, security items closed, deviations, bugs, flakes, open items + owners.
4. Tracker ticked; plan changelog final line.

---

## 4. Deliverables checklist

- [ ] Production audit with risks classified
- [ ] ADR 0049 and topology
- [ ] Staging (server or documented local equivalent)
- [ ] Production deploy kit with build identity, rollback rehearsed
- [ ] Client repo sync script, release tags, CI in the client repo
- [ ] Uploads on S3, nightly encrypted backups, timed restore drill
- [ ] MongoDB and Redis production settings verified
- [ ] Uptime monitor, healthwatch, log rotation, every alert tested
- [ ] Capacity on the production-sized server, per-process limits
- [ ] Wallet latency fixed or re-scoped; flakes fixed; 5 green runs
- [ ] DNS, secrets, CSP, HSTS, superadmin 2FA, Razorpay live top-up
- [ ] Phase 16 released to production with the new kit
- [ ] Runbooks, on-call, game day
- [ ] Meta App Review / Tech Provider / real number status
- [ ] Docs, release notes, sign-off

---

## 5. Risks

| Risk                                                        | Mitigation                                                                                                                 |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| A change on the shared server breaks the client's other app | Read-only audit first, own user / folder / network / nginx file, resource limits, client's admin applies host-wide changes |
| No server access: we can't see logs when something breaks   | One script for the client's team, status and log commands that print no secrets, §7 #1                                     |
| A migration breaks the old release during rollback          | Expand / contract rule, migrations tested against the previous release in the rehearsal                                    |
| Production MongoDB is not a replica set (transactions fail) | Audit checks it first; convert in a window with a backup                                                                   |
| Backups exist but don't restore                             | Timed drill before sign-off, monthly after                                                                                 |
| The age key is lost                                         | Two offline copies with the owner; runbook says so                                                                         |
| Alerts go nowhere or to one person                          | Two recipients, every alert tested                                                                                         |
| Enforced CSP breaks Meta sign-up or Razorpay                | 7 days report-only, manual checks, one-line rollback                                                                       |
| `ENCRYPTION_KEY` rotation loses data                        | Backup first, `--dry-run`, old key kept until re-seal reports 0                                                            |
| App Review rejected                                         | Fix and resubmit; review number and password untouched                                                                     |
| The client changes files in the deploy repo                 | Sync script stops and shows the changed files                                                                              |
| Disk fills from logs, recordings or Docker images           | Log rotation, S3 for files, image pruning keeps 3, disk alert at 80 %                                                      |

---

## 6. Recommended order

Now (no access needed): T17.2 → T17.4 (kit + build identity) → T17.5 → T17.6 (S3 code, scripts) → T17.8 (scripts, System page) → T17.10.

With the client's inputs (§8): T17.1 → T17.7 → T17.11 (DNS, Razorpay, headers) → T17.3 → T17.9 → T17.6 (drill) → T17.8 (alerts live) → **T17.12** → T17.13 → T17.14 → T17.15.

Checkpoints: **P17-B1-DONE** after the code-only tasks; **P17-B2-DONE** after the first managed release; **P17-B3-DONE** after the game day and sign-off.

---

## 7. Decisions and open questions (owner — defaults apply if not answered)

| #   | Question                                                                 | Default                                                                  |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 1   | Do we get SSH access (a `deploy` user limited to our folder and Docker)? | Ask for it; until then the client's team runs `release.sh`               |
| 2   | A separate small server for staging?                                     | Yes, 2 vCPU / 4 GB; otherwise local rehearsal + restored copy            |
| 3   | Database: stay on the client's MongoDB or move to Atlas?                 | Stay, if the audit shows replica set + auth; else decide after the audit |
| 4   | Backup RPO: 24 h or 1 h?                                                 | 24 h (nightly + before each release)                                     |
| 5   | Who applies host-wide hardening (firewall, SSH, updates)?                | The client's admin, with our checklist                                   |
| 6   | Alert recipients and on-call order (names, e-mails, phones)?             | Owner + one person from the client's team                                |
| 7   | Calling-hours ceiling 08:00–19:00 (Phase 16) as is?                      | Keep (TRAI-style hours); owner confirms before T17.12                    |
| 8   | Make the deploy repo private?                                            | Yes, with a deploy key                                                   |
| 9   | Uploads to S3 (cost: small) — which AWS account?                         | Client's AWS account, bucket in `ap-south-1`                             |
| 10  | Maintenance window for releases                                          | Weekdays 22:00–23:00 IST                                                 |
| 11  | Enforce superadmin 2FA after setup?                                      | Yes                                                                      |

---

## 8. What we need from the client (Gate P)

1. The output of `scripts/server-audit.sh` run on the production server (T17.1), or read-only SSH.
2. Answers to §7 #1, #2, #3, #6, #8, #9, #10.
3. The `razorpay: request rejected` log line (status, code, description) and confirmation that live keys are in use.
4. DNS change: remove `45.114.245.71`; add `staging.` record if staging gets a server.
5. An S3 bucket (or access to create one) and an IAM user for backups and uploads.
6. The owner's `age` public key for backups (private key stays with the owner).
7. UptimeRobot account or permission to create one with the owner's e-mail.
8. Who in the client's team runs releases until we have access, and their contact.
9. A maintenance window for the first managed release.

Never ask for or accept secrets in chat: they go into the server's env files or the owner's password manager.

**Gate P blockers (from T17.1, `docs/ops/PRODUCTION_AUDIT.md` §4):** SSH access + server audit output; how our app runs today; MongoDB replica set and auth; Redis password and `maxmemory-policy`; the Razorpay log line and keys.

---

## Changelog

- 2026-11-02: plan drafted after Phase 16 sign-off, from the repos at `main` (backend `96cc375`, frontend `b970099`), the Phase 13 deploy kit and tracker (T13.5–T13.11 open), the Phase 16 open items, and public checks of `wa.notifynow.in` (health `commit: unknown`, HSTS only). Includes the Razorpay `PROVIDER_ERROR` seen on 2 Nov.
- 2026-11-02: run prompt written (`docs/prompts/PHASE_17_PROMPT.md`), assuming SSH access to production and a staging server (§7 #1, #2 = yes) and the inputs in prompt §0. Adds literals: ADR 0049, audit +2 → 167, `GET /admin/system`, `POST /csp-report`, Redis wallet lock, release tags, backup layout, alert thresholds.
- 2026-11-02: STEP 0. Plan locked; literals per run prompt §1. Defaults in use for §7 #1–#11. **Inputs present: none** — `~/.cav-prod/` does not exist, no `cav-prod` / `cav-stg` SSH keys, no staging host, S3 bucket, age recipient, UptimeRobot key, alert e-mails or on-call list. Every server step (production and staging) is skipped and recorded as an open item; the code, kit and local rehearsals go ahead. Tools: no Homebrew on this Mac, so `shellcheck` and `age` run as one-off Docker containers (deviation).
- 2026-11-02: T17.10. Wallet lock across processes (`5cd4eb4`, numbers in `capacity.md`; the 500 ms target is still missed on the Mac, re-measure in T17.9). Flakes: `calls/ai-call` fixed at the cause (the test moved the fake clock before the call had written the customer's words down; it now waits for them). **`calls/outbound` (wrong number) and `db/seed-calls` stay open:** the simulated customer hangs up 1–3 virtual seconds after the bot's line, which at dry-run speed 100 is 10–30 ms of real time, shorter than a loaded machine needs to finish the AI turn. **Product finding (owner: Phase 18, real phones):** when a customer hangs up while the AI's turn is still running, the disposition that turn decided is not saved, because the outcome is only copied when the node finishes. E2E backend stdout is now always shown, so a fatal line can't be lost.
- 2026-11-03: T17.15. Final runs: backend 3,790 + 1 skipped, coverage 96.06 / 87.38 / 95.6 / 97.58, 5 runs (1, 3, 4 green; 2 and 5 hit known load flakes `calls/outbound`, `calls-wa/outbound`, `realtime/ws`). Frontend 1,471, coverage 96.12 / 92.33 / 93.66 / 96.81. Playwright once (owner asked for fewer repeat runs): 169 passed in 36 min, backend log grep clean. Sign-off written; server steps open.
