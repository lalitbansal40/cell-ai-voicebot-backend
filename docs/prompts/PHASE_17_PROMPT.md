# P17 RUN — Production Deployment & Operations (T17.1 → T17.15) — One-Paste Autonomous Run Prompt

> **HOW TO RUN — ek hi paste, poora phase. Beech mein kahin nahi rukna.**
>
> Phase 16 ki tarah: **ek paste = STEP 0 → Batch 1 → Batch 2 → Batch 3 → sign-off.** Checkpoint (`P17-B1-DONE`, `P17-B2-DONE`) pe sirf commit + chhota progress note likhna hai aur **usi turn mein agla task shuru karna hai**.
>
> **Paste this (working directory `/Users/lalitbansal/Documents/cell-ai-voicebot`):**
>
> `cell-ai-voicebot-backend/docs/prompts/PHASE_17_PROMPT.md padho aur STEP 0 se P17-B3-DONE tak POORA Phase 17 (teeno batches) step by step autonomously implement karo. Kahin bhi mat ruko: na batch ke baad, na checkpoint pe, na kisi question ke liye — saare decisions is prompt + PHASE_17_PLAN.md me pre-made hain (owner defaults §1). Har task ke baad verify (har command alag) + commit (tag [P17-T17.x]). Production server par sirf §2 ke rules ke andar kaam karo: pehle backup, sirf hamara folder / containers / nginx file, doosri app ko kabhi touch nahi. Hamare repos me push / merge NAHI. Context compact ho jaye to §3 RESUME SAFETY se wahin se aage chalo. Sirf P17-B3-DONE ke baad final report (Hinglish) do.`
>
> **Claude Code "auto / accept edits" mode me chalao.** **Docker Desktop chalu.** **Mac charger par, lid khuli** — lambi runs `caffeinate -dims` ke saath. Doosre projects ke containers / processes **kabhi mat chhoona** (port 3100 doosre project ka hai; Supabase containers bhi doosre project ke hain).
>
> **Paste se pehle owner ke kaam (§0 "Inputs"):** `~/.cav-prod/inputs.env` aur secret files bhar do, SSH keys rakh do, aur plan §7 ke jawab alag hon to plan mein likh do. Jo input missing hoga, uska sub-step skip hoga aur open item banega — run nahi rukega.

---

## 0. CONTEXT (verified facts on 2 Nov 2026 — dobara derive mat karna)

**Branches:** `main` = backend `96cc375`, frontend `b970099` (Phase 16 done, pushed to `origin/main` of both our repos). Backend branch **`feature/phase-17-production`** exists with commit `0a698a3` (plan + tracker + BUILD_PLAN_V2 line). Frontend branch: create **`feature/phase-17-production`** from `b970099` in STEP 0. **Never commit to `main`.**

**Production today (public checks only, 2 Nov 2026):**

- `https://wa.notifynow.in` → nginx on the client's server **`154.210.160.233`**, on the client's database. A second A record **`45.114.245.71`** (old Kannel SMS box; HTTPS fails) is still in DNS. **Never connect to `45.114.245.71` or to the EC2 `13.232.191.62`** (the client's other machine).
- `GET /api/v1/health` → `{"status":"ok","version":"0.0.1","commit":"unknown","builtAt":"unknown"}`. Headers: HSTS only.
- The client's team deploys by pulling the **public** repo `Cell24x7/cell-ai-voicebot` (folders `cell-ai-voicebot-phase13/backend`, `/frontend`; local clone `~/Documents/Cell24x7-cell-ai-voicebot`) and rebuilding. Last push: `fb496c3` "Update NotifyNow code (backend 96cc375, frontend b970099)" = Phase 16, **not deployed**. The earlier push `023cb92` (backend `7452f50`, frontend `cf082cf`) is what runs, most likely.
- Wallet top-up fails with `PROVIDER_ERROR` (`razorpay.provider.ts` logs `razorpay: request rejected` with status / code / description). Order body is valid; cause is keys or account mode.
- Meta App Review submitted 30 Oct 2026, pending. **Don't disconnect the review number or change the review account's password.** Account billing stays "Customer pays Meta" (Tech Provider, not BSP).

**Numbers at start:** backend **3755 tests (+1 skipped) / 350 files**, gate **95 / 85 / 95 / 95**, coverage 96.09 / 87.42 / 95.67 / 97.6; frontend **1467 tests / 135 files**, gate **95 / 90 / 90 / 95**, coverage 96.13 / 92.31 / 93.67 / 96.82; **169 Playwright tests**. Bundle main 320.42 KB gzip. Catalogue: error codes **103**, audit actions **165**, notifications **36**. Migrations `0001` … `0018`. Queues `system`, `email`, `maintenance`, `contacts`, `billing`, `ai`, `campaigns`, `whatsapp`, `webhooks`. Next ADR: **0049**.

**Inputs (the owner provides them; treat them as available — if one is missing, skip only that sub-step and record an open item):**

| Input              | Where                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Non-secret facts   | `~/.cav-prod/inputs.env` (600): `CAV_PROD_HOST=154.210.160.233`, `CAV_PROD_SSH_USER`, `CAV_PROD_SSH_PORT`, `CAV_STG_HOST`, `CAV_STG_SSH_USER`, `CAV_STG_DOMAIN`, `CAV_ALERT_EMAILS`, `CAV_ONCALL` (names + phones, order), `CAV_MAINT_WINDOW`, `CAV_S3_BUCKET`, `CAV_S3_REGION=ap-south-1`, `CAV_AGE_RECIPIENT` (age public key), `CAV_HOST_ADMIN_OK` (`yes` = we may apply host-wide hardening ourselves), `CAV_DB_MODE` (`client` / `atlas`) |
| SSH keys           | `~/.ssh/cav-prod` (deploy user on production, limited to our folder + Docker group), `~/.ssh/cav-stg` (staging admin); host keys pinned in `~/.cav-prod/known_hosts`                                                                                                                                                                                                                                                                           |
| Production secrets | Already in `/srv/cell-ai-voicebot/env/*.env` on the server (or the client's current env file — T17.1 finds it). New ones (`SUPPRESSION_HMAC_KEY`, S3 keys, backup settings) generated **on the server** by `init-secrets.sh` or put there by the owner                                                                                                                                                                                         |
| Staging secrets    | `~/.cav-prod/staging/backend.env`, `frontend.env`, `ops.env` (600), from `deploy/production/env.example`                                                                                                                                                                                                                                                                                                                                       |
| age private key    | **Only with the owner.** Restore drills use `CAV_BACKUP_IDENTITY` pointing to the owner's key file on the Mac; never copy it to a server                                                                                                                                                                                                                                                                                                       |
| UptimeRobot        | API key in `~/.cav-prod/uptimerobot.env` (600) as `UPTIMEROBOT_API_KEY`                                                                                                                                                                                                                                                                                                                                                                        |

Never `cat`, `echo`, print, log, commit or paste any secret value. Read env files only by key name (`grep -c '^KEY='`, `cut -d= -f1`).

**Pehle padho (STEP 0 and after every context compaction):**

- [PHASE_17_PLAN.md](../phases/PHASE_17_PLAN.md) — **source of truth**: goal + Done-when §0, findings U1–U7 §1a, reuse §1b, gaps §1c, decisions §1d, tasks §3, risks §5, order §6, owner questions §7, client inputs §8.
- [PHASE_16_SIGNOFF.md](../phases/PHASE_16_SIGNOFF.md) §3, §7, §8; [PHASE_13_PLAN.md](../phases/PHASE_13_PLAN.md) §1a, §1f, §1g, T13.5–T13.10; [PHASE_13_TASKS.md](../phases/PHASE_13_TASKS.md).
- Ops: [staging.md](../ops/staging.md), [GATE_A.md](../ops/GATE_A.md), [secret-rotation.md](../ops/secret-rotation.md), [nginx-security-headers.md](../ops/nginx-security-headers.md), [capacity.md](../ops/capacity.md), [release-phase-16.md](../ops/release-phase-16.md), `deploy/staging/README.md`.
- ADRs 0042 (staging deploy), 0047 (key rotation), 0048 (erasure), 0032 (wallet), 0041 (WhatsApp calling media).
- Conventions: [secrets.md](../conventions/secrets.md), [security.md](../conventions/security.md), [definition-of-done.md](../conventions/definition-of-done.md); [src/README.md](../../src/README.md).

**What exists (use it, don't rebuild) — exact entry points:**

| Area          | Use                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deploy kit    | `deploy/staging/`: `compose.yaml` (project `cell-ai-voicebot-staging`, `cav-stg-api` / `cav-stg-worker` with `network_mode: host`, `HOST=127.0.0.1`, `PORT=5100`, worker 5101, mongo 27018 + redis 6380 on loopback, `stop_grace_period` 60 s / 30 s, `json-file` 20m × 5), `restore.compose.yaml`, `env.example`, `compose.env.example`, `frontend.env.example`, `ops.env.example` (`BACKUP_TARGET`, `ALERT_EMAIL`) |
| Scripts       | `deploy/staging/scripts/{common,provision,init-secrets,deploy,rollback,backup,restore,healthwatch,status,tools,check-image,check-nginx,render-nginx}.sh`, `retention.py`; `systemd/cav-backup.{service,timer}`; `deploy-from-mac.sh user@host key [backend-ref] [frontend-ref]`                                                                                                                                      |
| nginx         | `deploy/staging/nginx/cell-ai-voicebot.conf.template` (HSTS + `__CSP_HEADER__`), `.http.conf.template`, `cav-proxy.conf`, `cell-ai-voicebot-logformat.conf`                                                                                                                                                                                                                                                          |
| CI            | `.github/workflows/ci.yml` (verify), `deploy-staging.yml` (`workflow_dispatch`, environment review, `STAGING_KNOWN_HOSTS`)                                                                                                                                                                                                                                                                                           |
| Audit         | `scripts/server-audit.sh` (allow-listed read-only; header lists what is forbidden), `scripts/run-server-audit.sh`                                                                                                                                                                                                                                                                                                    |
| App           | `GET /health` (build from `GIT_SHA` / `BUILT_AT` env, `modules/health/*`), `GET /ready`, `WORKERS_ENABLED`, `STORAGE_DRIVER=local\|s3` + `S3_BUCKET` / `S3_REGION` (`core/storage/s3.storage.ts`), `TRUST_PROXY`, `HSTS_BY_PROXY`, `MFA_ENFORCED_FOR_ADMINS`, `API_DOCS_ENABLED`, `src/core/lifecycle.ts` (SIGTERM drain)                                                                                            |
| Ops CLIs      | `src/ops/{migrate,sync-indexes,keys-reseal,superadmin-create,email-test,alert,analytics-rebuild,cli}.ts`; `npm run check:headers -- https://<host>`; `scripts/smoke.ts`                                                                                                                                                                                                                                              |
| Load          | `npm run perf:inbox`, `perf:api -- messages\|calls`, `perf:ws`, `perf:soak`, `bench:voice` (cap = `CALL_LIMITS.concurrentPerProcess` 20), `PERF_SERVER_LOG=<file>`                                                                                                                                                                                                                                                   |
| Wallet        | `src/core/billing/engine.ts` (`run(accountId, fn, outer)`, in-process `inWalletOrder` from `3d915b1`), `holdForWhatsApp`, delivery charges in `modules/inbox/status.service.ts` + `whatsapp-billing/billing-hook.ts`                                                                                                                                                                                                 |
| Superadmin UI | `src/pages/admin/*`, `src/features/admin/*`, `AdminAccountDetailPage.tsx`                                                                                                                                                                                                                                                                                                                                            |

**Bugs to avoid:** printing an env file or `docker inspect` output (secrets); `docker compose down -v` (deletes volumes); `docker system prune` on a shared host (removes the client's images); restarting or reloading anything not ours (`systemctl restart nginx` instead of `nginx -t && nginx -s reload` after editing only our file); a port clash with the client's app; host networking binding our HTTP to `0.0.0.0`; a migration that breaks the previous release (rollback then fails); a backup that silently produced 0 bytes; a restore pointed at the production database; `mongodump` without `--oplog` on a replica set under writes; deleting old backups from the server user (it must not have delete rights); log rotation missing so the disk fills; CSP enforced before the Meta popup and Razorpay are checked; enabling `MFA_ENFORCED_FOR_ADMINS` before every superadmin has set up 2FA; rotating `ENCRYPTION_KEY` without `ENCRYPTION_KEYS_OLD` (all sealed tokens unreadable); disconnecting the App Review number; raising a test timeout to hide a flake; a load test against production; **inserting new audit actions mid-list (append at the end)**.

---

## 1. LOCKED DECISIONS (exact literals — the plan has the prose)

**Owner defaults (plan §7 #1–#11) are in force**, with #1 and #2 answered "yes" (we have SSH access as a deploy user on production and a staging server). Record "Defaults in use for §7 #1–#11; access assumed per §0 Inputs" in the plan changelog at STEP 0. If a default turns out impossible, pick the closest safe option, write it as a deviation and continue.

**Layout on every server:**

- Root `/srv/cell-ai-voicebot/{releases,current,frontend,env,uploads,backups,logs,deploy,state}`; owner user `cav` (uid 1000 inside containers); `env/` mode 700, files 600.
- Compose projects: production **`cav-prod`** (containers `cav-prod-api`, `cav-prod-worker`, `cav-prod-redis`; `cav-prod-mongo` only if `CAV_DB_MODE` says bundled), staging **`cav-stg`** (same names with `-stg-`).
- Ports (loopback only): api **5100**, worker health **5101**, redis **6380**, bundled mongo **27018**. If T17.1 finds any of them taken by the client's app, use **5200 / 5201 / 6480 / 27118** and record it.
- UDP media **40000–40999** on the public interface (calling). nginx: our site in **one file** `/etc/nginx/sites-available/cell-ai-voicebot.conf` + symlink; snippets `cav-proxy.conf`, `cell-ai-voicebot-logformat.conf` under `/etc/nginx/snippets/`.
- Resource limits: api `cpus: 2`, `mem_limit: 2g`; worker `cpus: 1.5`, `mem_limit: 1536m`; redis `mem_limit: 512m`, `maxmemory 400mb`, `maxmemory-policy noeviction`, `appendonly yes`, `appendfsync everysec`.
- Logging: Docker `local` driver, `max-size: 50m`, `max-file: 5`.

**Kit (backend repo):** `deploy/production/` = copy of `deploy/staging/` adapted, plus `scripts/release.sh`, `scripts/storage-migrate.sh`, `systemd/cav-healthwatch.{service,timer}` (every 5 min), `systemd/cav-backup.timer` at **02:00 IST** (`20:30 UTC`). Staging uses the same kit with `CAV_ENV=staging`. ADR **0049** "Production on the client's shared server".

**Build identity:** Dockerfile `ARG GIT_SHA` / `ARG BUILT_AT` → env; frontend `VITE_GIT_SHA`, `VITE_BUILT_AT`, `VITE_ENV_LABEL` (`Staging` on staging, empty on production) → `dist/version.json` `{ commit, builtAt }` and Admin → System. `release.sh` fails if `/health.commit` ≠ the tag's backend sha.

**Release tag:** `release-YYYYMMDD-<backend sha7>` in `Cell24x7/cell-ai-voicebot`, made only by `scripts/sync-client-repo.sh`. Release record appended to `docs/ops/releases.md` (date IST, tag, backend / frontend sha, operator, duration, checks, issues).

**`release.sh <tag>` order (production and staging):** lock (`flock /srv/cell-ai-voicebot/state/deploy.lock`) → preflight (disk ≥ 15 % free, tag exists, env keys present by name, ports free or ours) → backup (`backup.sh pre-release <tag>`; abort on failure) → fetch tag → build `cav-backend:<sha>` and frontend into `frontend/<sha>/` with build identity → migrate (`node dist/ops/migrate.js up`) + `sync-indexes` with the new image → start new worker → start new api → wait `/ready` + `/health.commit == sha` (120 s) → switch `current` + `frontend/current` symlinks → `nginx -t` and reload only if our file changed → post-deploy checks → record. Failure after any restart → previous images + symlinks back, alert, exit 1. Keeps the last **3** releases.

**Post-deploy checks (each must pass):** `/api/v1/health` through nginx on **every** A record of the host, `commit` matches; `/` 200 with `cache-control: no-cache` on `index.html`; a hashed asset `immutable`; `/privacy` 200; `/login` 200; `/api/v1/openapi.json` public spec only; `GET /api/v1/webhooks/meta` without token → 403; WebSocket upgrade on `/ws/events` → 101 or 401 (not 5xx); `npm run check:headers` (from the Mac).

**Migration rule** (add to `definition-of-done.md`): every migration works with the previous release still running (expand now, contract in a later release); `down` exists but is never run automatically.

**Backups:** `mongodump --archive --gzip --oplog` (or `--archive --gzip` with a note when the DB is not a replica set — T17.7 fixes that) → `age -r $CAV_AGE_RECIPIENT` → `s3://$CAV_S3_BUCKET/prod/YYYY/MM/DD/<HHMM>-<kind>.archive.gz.age` with `kind` = `nightly` | `pre-release-<tag>`; a JSON manifest next to it (`{ at, kind, bytes, sha256, collections: { name: count } }`, no data). Lifecycle: current versions 35 days, then monthly copies (`prod/monthly/`) kept 95 days; versioning on; public access blocked. Server IAM user: `s3:PutObject`, `s3:GetObject`, `s3:ListBucket` on `prod/*` only — **no delete**. After success: `node dist/ops/cli.js ops:record backup --ok --bytes <n> --at <iso>` writes `platformSettings.opsStatus.lastBackup`. Failure → alert immediately. Targets **RPO 24 h**, **RTO 2 h**.

**Uploads → S3:** `STORAGE_DRIVER=s3`, prefix `prod/files/`; `npm run storage:migrate-to-s3 -- [--dry-run] [--batch 200]` (resumable, copies then verifies size + sha256, switches the driver only after 100 % verified, counts only in logs, never keys with personal data). Signed URL lifetime unchanged (900 s).

**Monitoring:** UptimeRobot HTTP keyword monitors every **60 s**, alert after **2** fails: `https://wa.notifynow.in/api/v1/health` keyword `"status":"ok"`, `https://wa.notifynow.in/` keyword `NotifyNow`, plus the same on staging (alerts to the owner only). `healthwatch.sh` alert thresholds: `/ready` not ok 2 runs in a row; disk > **80 %**; memory available < **10 %**; `whatsapp` or `webhooks` waiting > **1,000** for 10 min; failed jobs +**50** in 1 h; certificate < **14 days**; last backup > **26 h**; MongoDB no primary; container restarts > **3** / h. One e-mail per alert key per hour; a recovery e-mail when it clears.

**Admin → System (new):** `GET /api/v1/admin/system` (superadmin only) → `{ commit, builtAt, env, uptimeSec, mongo: { ok, primary, version }, redis: { ok, usedMemoryMb }, queues: { [name]: { waiting, active, delayed, failed } }, lastBackup: { at, ok, bytes } | null, lastRestoreDrill: { at, rtoMinutes } | null, certificate: { daysLeft } | null }`. Frontend page `/admin/system`, read-only, refresh 30 s. No secrets, no hostnames of other apps.

**Wallet across processes (T17.10):** replace the in-process `inWalletOrder` with a Redis lock per wallet: key `wallet:lock:<accountId>`, `SET NX PX 5000`, owner token, released by a Lua compare-and-delete; waiters retry with 10–40 ms jitter up to **10 s**, then the existing transaction still runs (correctness never depends on the lock; the lock only prevents conflict storms). Delivery-status charges for one message stay one ledger move. Target: `perf:api -- messages` **p95 < 500 ms** at 50 / s, **0** 500s, **0** double charges, exact wallet — on staging and on the Mac.

**Catalogue additions (append at the end; update count tests in the same commit):**

- Audit actions **+2 → 167:** `ops.release_recorded`, `ops.restore_drill_recorded`.
- No new error codes, notifications, permissions or migrations (`platformSettings.opsStatus` is a new key in an existing collection; no migration needed — record it in `data-model.md`).

**Security go-live literals:** nginx sends HSTS (`max-age=31536000; includeSubDomains`), app `HSTS_BY_PROXY=true`; CSP `Content-Security-Policy-Report-Only` for **7 days** with `report-uri /api/v1/csp-report` (new public route, rate-limited, body ≤ 16 KB, logs directive + blocked host only), then `Content-Security-Policy`. `MFA_ENFORCED_FOR_ADMINS=true` only after `GET /api/v1/admin/system` shows every superadmin with `mfa.enabledAt` (add `superadminsWithoutMfa: number` to that response). `API_DOCS_ENABLED` unset, `MOCK_APIS_ENABLED` unset, `BILLING_SIMULATOR_ENABLED` unset, `PAYMENT_PROVIDER=razorpay`, `TRUST_PROXY=loopback`.

---

## 2. RULES OF ENGAGEMENT

1. **NEVER STOP, NEVER WAIT, NEVER ASK.** Checkpoints are commits, not pauses. The only output before the end is a 2–3 line progress note at each checkpoint, written while continuing in the same turn.
2. **Blocked? Unblock yourself.** Unclear spec → plan §1d / §7 default → safest convention-consistent choice → deviation note. Missing input (§0) → skip only that sub-step, open item, continue, retry at the next checkpoint. Tool problem → fix within the rules → still blocked → skip that sub-step, open item.
3. **Production server rules (the strictest in this project):**
   - Touch only: `/srv/cell-ai-voicebot/**`, containers / images / networks / volumes whose names start with `cav-prod` or `cav-backend` / `cav-frontend`, our nginx site file + 2 snippets, our two systemd units, our cron-free timers. **Never** stop, restart, inspect, exec into, prune or reconfigure anything else.
   - Read-only first: T17.1 runs before any change. Every change on production happens through `release.sh`, `rollback.sh`, `backup.sh`, `init-secrets.sh`, `storage-migrate.sh` or a command written into the runbook **before** it is run.
   - **Backup before any change** that touches data (release, storage migration, key re-seal, Mongo settings).
   - Host-wide changes (firewall, SSH config, fail2ban, unattended upgrades, kernel, Docker daemon, nginx main config) only if `CAV_HOST_ADMIN_OK=yes`; otherwise write the exact commands into `docs/ops/host-hardening.md` for the client's admin and record an open item.
   - Production changes only inside `CAV_MAINT_WINDOW` (default weekdays 22:00–23:00 IST). Read-only checks any time. If the run reaches a production step outside the window: do the next non-production step and come back.
   - Never run load tests, restore drills, `keys:reseal` writes or `storage:migrate-to-s3` writes against production before the same step passed on staging.
   - Never print secrets: no `env`, `printenv`, `docker inspect`, `cat` of env files, `docker compose config` (it expands env). Logs are read with filters (`--since`, level ≥ warn) and never pasted raw into docs.
   - Never connect to `45.114.245.71` or `13.232.191.62`.
4. **Git:** branch `feature/phase-17-production` in both repos; never on `main`; one commit per task per repo, one repo at a time; hooks must pass (no `--no-verify`, no `--force`); **no push / merge / tag in our repos**. The client repo `Cell24x7/cell-ai-voicebot` is pushed **only** by `scripts/sync-client-repo.sh` (tags + release commits), never `--force`. Footer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; lines ≤ 100 characters; message in a scratchpad file + `git commit -F`; no body line starts with `word:`.
5. **Verify after every code task: each command separately, read output + exit code; never chain `git commit` after checks.**
   - Backend: `npm run lint` · `npm run format:check` · `npm run typecheck` · targeted `npx vitest run <changed areas> --maxWorkers=2` · `npm run build` · `npm run gen:openapi` + stage + `npm run openapi:check`. Shell scripts: `shellcheck` (install with Homebrew if missing; it's a dev tool) on every changed `.sh`. Full `npx vitest run --coverage --maxWorkers=2` at the end of every task touching shared code and at every checkpoint (background, `caffeinate -dims`, wait for the notification; never another heavy job meanwhile).
   - Frontend: `npm run lint` · `npx prettier --check .` · `npm run typecheck` · `npx tsc -p tsconfig.e2e.json --noEmit` · targeted vitest · `npm run build`; `npm run gen:api` after backend schema changes; full coverage per frontend task.
   - Playwright whole suite at B2 / B3: infra up, this project's dev servers stopped, `E2E_FRONTEND_PORT=3150`, from the frontend folder; run 2 with `E2E_BACKEND_LOGS=1` + log grep (patterns in P17-B2-DONE).
   - A test failing only under load and passing alone 3 / 3 is a flake: record it for T17.10; never weaken it.
6. **Coverage gates stay green; never lower thresholds; never raise test timeouts; no dynamic `import()` in backend tests.**
7. **No external network in tests.** S3 is faked with a local stub server (as Razorpay is); UptimeRobot calls only in the setup script, never in tests.
8. **Mac Docker:** only `npm run infra:*` (`cav-*`), the rehearsal projects (`cav-prod-rehearsal`, `cell-ai-voicebot-restore-check`) and one-off `docker run --rm`.
9. **Docs in the same commit** as the code they describe. **Catalogue / count tests** updated in the same commit that adds entries.
10. **Real bugs in committed code:** reproduce → regression test proven failing first → separate `fix(<area>)` commit → plan changelog + final report. A production bug found live: note it for the owner; the fix goes through a normal release.
11. **Every production action is recorded** in `docs/ops/releases.md` or the task's evidence table: what, when (IST), result. No secrets, no customer data.
12. **Progress notes** (at each checkpoint, then keep going): "P17-B1-DONE ✅ — <tests> backend tests, coverage <x>; next: T17.x" — nothing more.

---

## 3. RESUME SAFETY (after a context compaction or a restart)

1. `git -C cell-ai-voicebot-backend branch --show-current` → `feature/phase-17-production`; same for the frontend; `git log --oneline -20` in both.
2. The last `[P17-…]` tag tells the position; `docs/phases/PHASE_17_TASKS.md` ticks must agree (fix the tracker if a tick is missing).
3. Uncommitted work → `git status` + `git diff` → finish that task, verify, commit. Never discard work without reading it.
4. **A production step may have been half done.** Before anything else on a server: `ssh … /srv/cell-ai-voicebot/deploy/scripts/status.sh` (read-only) → compare running commit with `docs/ops/releases.md`; a held `deploy.lock` with no running deploy → read `logs/deploy-*.log` (filtered), finish or roll back per the runbook, then release the lock.
5. `npm run infra:up` → backend lint + typecheck → targeted tests of the last task → continue with the **next** task. Don't redo committed tasks.
6. Then keep going to `P17-B3-DONE`; a resume is not a reason to stop or report early.

---

## STEP 0 — P17-SETUP (before T17.1)

1. Backend on `feature/phase-17-production` (`0a698a3` on top of `96cc375`); create the frontend branch from `b970099`. `git status` clean in both (backend: this prompt may be uncommitted).
2. `git fetch origin` both; if `origin/main` moved, merge `main` into the branch (`git merge --no-ff main`), full verify.
3. Inputs check (names only): `~/.cav-prod/inputs.env` keys present (`grep -c`), SSH keys exist with mode 400 / 600, `ssh -o BatchMode=yes -o UserKnownHostsFile=~/.cav-prod/known_hosts … true` succeeds on production and staging. Write the list of present / missing inputs (names only) into the plan changelog.
4. Plan status → **Locked**; changelog line: "Run prompt prepared — literals locked: ADR 0049, audit +2 → 167, `GET /admin/system`, `POST /csp-report`, no migration; defaults in use for §7 #1–#11; access assumed per prompt §0."
5. Commit the plan changes → `docs(plans): lock phase 17 decisions [P17-PLAN]` (this prompt is already committed as `[P17-PROMPT]`; if it shows as changed, include it).
6. Baseline: `npm run infra:up`; backend + frontend lint / typecheck green (record counts). **Then continue straight into T17.1.**

---

# ═══════════ BATCH 1 — Know it and build the kit (T17.1 → T17.5, T17.10) ═══════════

## T17.1 — Read-only production audit → `docs(ops): add production audit [P17-T17.1]`

1. Extend `scripts/server-audit.sh` (still allow-listed, still read-only, header updated): `docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'`, `docker compose ls`, `docker network ls`, `docker volume ls`, `docker system df`; `ss -ltnu` (no process args); nginx: enabled site file names + `grep -h server_name` lines only; certificate `openssl x509 -noout -issuer -dates` of the live cert file path found from our server block only; `timedatectl show -p NTPSynchronized`; swap; `ufw status` (if allowed without sudo, else "n/a"); unattended-upgrades presence; Docker log driver; free disk + inodes; MongoDB: version, bind, `rs.status().ok`, members count, auth enabled — via `mongosh --quiet --eval` with **no URI printed** (connection from the existing env by name); Redis: `INFO server|memory|persistence` selected fields, `CONFIG GET maxmemory-policy`.
2. Run it on production over SSH (`bash -s < scripts/server-audit.sh`), output to the scratchpad only. **Grep the output for secrets / customer data before using any of it** (key patterns, `mongodb://`, `@`, phones); redact.
3. Find how our app runs today (Compose, PM2 or plain node), from which folder, which env file **names**, which ports, which commit (`/health` says unknown — record the image creation date and the folder's git log if any).
4. Outside-in from the Mac: `dig +short A/AAAA/CAA wa.notifynow.in`; `npm run check:headers -- https://wa.notifynow.in`; TLS check (`openssl s_client -connect wa.notifynow.in:443 -servername …` protocols + chain); TCP 22 / 80 / 443 open, **5100, 5101, 6379, 6380, 27017, 27018 closed** (`nc -z -w 3`); UDP 40000–40999 reachability noted as "verified in T17.14 with a real call".
5. `docs/ops/PRODUCTION_AUDIT.md`: one table per area (OS, resources, Docker, our app, other apps — **names only, nothing else**, nginx, TLS, DNS, MongoDB, Redis, firewall, time, logs, backups, ports), columns **value · risk · action · task · owner**. Risks classified **blocker / this phase / later**. Blockers copied into plan §8 as "Gate P blockers".
6. Same audit on staging (shorter: it's ours) → appendix.
7. No code change → format check only. Commit.

## T17.2 — Topology + ADR 0049 → `docs(adr): production on the client's shared server [P17-T17.2]`

1. `docs/adr/0049-production-shared-server.md`: context (shared host, client deploys today, App Review), decisions §1 (user, folder, project, ports, network, limits, nginx file, process split, DB mode, S3, backups, monitoring, deploy model), alternatives (own server, Atlas, managed Redis, PM2) with reasons, consequences, a Mermaid diagram (DNS → nginx → api / static → worker → MongoDB / Redis / S3 → Meta / OpenAI / Razorpay / SMTP; UDP media).
2. Port and resource choices adjusted to T17.1 facts (record any change from §1 as a deviation).
3. ADR index row; `docs/ops/production.md` started (layout + access sections).

## T17.4 — Production deploy kit + build identity → `feat(ops): add production deploy kit with build identity [P17-T17.4]` (both repos)

1. `deploy/production/` per §1 (copy, then adapt; staging kit stays as is). `compose.yaml`: project `cav-prod`, names, limits, `local` logging, `stop_grace_period` = api **630 s** (calls drain up to 10 min + 30 s) / worker 60 s — **check `lifecycle.ts` drain timing first** and match it; redis settings §1; mongo service only when bundled.
2. Backend `Dockerfile`: `ARG GIT_SHA`, `ARG BUILT_AT` → `ENV`; test (`tests/http/health.test.ts` or a new one) that `/health` shows them; image label `org.opencontainers.image.revision`.
3. Frontend: `VITE_GIT_SHA`, `VITE_BUILT_AT`, `VITE_ENV_LABEL`; Vite plugin or build step writes `dist/version.json`; staging banner when the label is set; tests.
4. `scripts/release.sh` per §1 order, `rollback.sh [<tag>]`, `status.sh` (versions, containers ours only, queue depth via the API, last backup, cert days, disk), all sourcing `common.sh`, `set -euo pipefail`, logs to `logs/deploy-<ts>.log` with no env values.
5. `scripts/check-deploy.sh` = post-deploy checks §1 (used by `release.sh`, runnable alone).
6. Migration rule added to `definition-of-done.md`; a test in `tests/db/migrations.test.ts` (or new) that the latest migration's `up` leaves the previous release's queries working — at least: run `up`, then run the previous release's model `find` / index usage for the touched collections (document how this is checked when a migration is added).
7. **Rehearsal on the Mac** (Docker project `cav-prod-rehearsal`, `CAV_ROOT` in the scratchpad, bundled mongo, fake providers): first release, second release, forced failure (an image that throws at start) → automatic restore, `rollback.sh` to a named tag, drain with a live WebSocket. Record times in `docs/ops/production.md` "Local evidence".
8. `shellcheck` clean; CI job `shellcheck` added to `ci.yml` for `deploy/**/*.sh` and `scripts/*.sh`.

## T17.5 — Client repo sync + release tags + CI → `feat(ops): release to the client repo with one script [P17-T17.5]`

1. `scripts/sync-client-repo.sh <backend-ref> <frontend-ref> [--dry-run]`:
   1. Clean check of `~/Documents/Cell24x7-cell-ai-voicebot`; `git fetch`; refuse if local `main` ≠ `origin/main` or there are commits not made by this script since the last release tag (list them).
   2. **Client-edit check:** `git archive` of the last released shas (from the last tag message) into a temp folder; `diff -rq` against the two folders; any difference → stop, print the file list, exit 2 (never overwrite client edits).
   3. Export the new refs, `git add -A` the two folders, **scan the staged diff** (key patterns, `mongodb+srv://<user>:<password>@`, `BEGIN … PRIVATE KEY`, Razorpay live key ids, `.env` files other than `*.example`), commit "Update NotifyNow code (backend <sha7>, frontend <sha7>)" with the release notes path in the body, tag `release-YYYYMMDD-<backend sha7>` (annotated; message holds both full shas), push commit + tag (no `--force`).
   4. `--dry-run` does steps 1–3 without commit / push.
2. Tests: the script's pure parts (tag naming, diff parsing) as a small TS helper with unit tests, or `bats`-style shell tests run in CI with a temp git repo; no network.
3. CI in the client repo (`.github/workflows/build.yml` in that repo, pushed by the script's first run): on push to `main`, `npm ci` + typecheck + build for both folders; no tests, no secrets.
4. If the owner made the repo private: document the server's read-only deploy key setup in `production.md`.
5. First run: tag the **already pushed** Phase 16 release (`fb496c3`) as `release-20261102-96cc375` without a new commit (special-case flag `--tag-existing <commit>`), so T17.12 deploys a tag.

## T17.10 — Wallet across processes + open flakes → `fix(billing): keep wallet changes in order across processes [P17-T17.10]` and `test: fix remaining virtual-clock flakes [P17-T17.10]`

1. **Prove first:** a test that runs the API and worker roles as two Node processes (or two separate Mongoose connections with the engine) hammering one wallet; with the in-process lock only, show conflicts / 500s (regression test failing first).
2. Implement the Redis lock per §1 (`src/core/billing/wallet-lock.ts`), used by `run()` when no outer session; in-process queue removed or kept as a cheap first layer (document which). Lock loss mid-transaction is safe (transaction still commits or retries). Tests: two processes, lock expiry, Redis down → falls back to the transaction alone with a warning (never blocks sends).
3. `perf:api -- messages` on the Mac before / after; target §1; numbers into `docs/ops/capacity.md`. If not met, profile (`--cpu-prof` on the API child) and fix the next cause (delivery-charge path, `accountMonth` read, index); re-scope with numbers only if still missed.
4. Flakes `tests/calls/outbound.test.ts` (wrong number), `tests/db/seed-calls.test.ts`, `tests/calls/ai-call.test.ts` (typed values): find the race (fake clock vs real async work), fix at the cause like `seed-calls`' 10 ms real-time step; **no timeout raises**.
5. E2E backend exit: in `playwright.config.ts` keep backend stderr to `test-results/backend-stderr.log` always (not only with logs on), so a fatal line is never lost.
6. **5 full backend runs in a row green** (background, alone) — record each.

## P17-B1-DONE — checkpoint → `docs: mark phase 17 batch 1 complete [P17-B1-DONE]` (both repos)

1. Both repos full verify (each command separately, coverage both, builds, `openapi:check`, shellcheck).
2. Tracker ticks T17.1, T17.2, T17.4, T17.5, T17.10; CHANGELOGs `Phase 17 · Batch 1`; plan changelog.
3. Commit, 2-line progress note, **immediately start T17.6.**

---

# ═══════════ BATCH 2 — Data safety, watching, staging, security, first release (T17.6 → T17.9, T17.11, T17.12) ═══════════

## T17.6 — Backups, uploads to S3, restore drill → `feat(ops): add encrypted off-server backups and move files to s3 [P17-T17.6]` (backend)

1. **S3 coverage audit:** every storage writer uses `StorageProvider` (recordings, inbox media, uploads, exports, account exports, knowledge files, import files, invoices / PDFs, sheet imports). Fix any direct `fs` write in a `fix(storage)` commit with a test.
2. `src/ops/storage-migrate.ts` + `npm run storage:migrate-to-s3` per §1 (resumable cursor in `platformSettings.opsStatus.storageMigration`; dry run prints counts and bytes; verify by size + sha256; switch only at 100 %). Tests with the local S3 stub: dry run, partial run + resume, verify mismatch → refuses to switch, logs without keys.
3. `deploy/production/scripts/backup.sh nightly|pre-release <tag>` per §1 (manifest, `ops:record`, alert on failure, temp files removed, refuses if `age` recipient missing); `systemd/cav-backup.timer` 20:30 UTC. `src/ops/cli.ts` gains `ops:record backup|restore-drill …` writing `platformSettings.opsStatus` + audit `ops.release_recorded` / `ops.restore_drill_recorded` (audit catalogue +2 → 167 here; count tests).
4. `restore.sh <s3-key>` (Mac): downloads, decrypts with `CAV_BACKUP_IDENTITY`, restores into project `cell-ai-voicebot-restore-check` (ports 27118 / 6480, **never live ports**), runs migrations, starts the API with `WORKERS_ENABLED=false`, compares collection counts with the manifest, signs in as a drill superadmin created only in the copy, opens one call page and one chat via the API, prints the RTO. Refuses if `MONGODB_URI` points at anything but the restore project.
5. Staging: enable timers, run a nightly + a pre-release backup, then **restore drill** on the Mac from staging's backup. Production: S3 bucket lifecycle / versioning / IAM checked (`aws s3api get-bucket-versioning`, `get-bucket-lifecycle-configuration`, `get-public-access-block`; IAM policy shown by the owner if we can't read it), timer enabled, one manual backup in the window, then **restore drill from a production backup on the Mac** (the copy stays local, is deleted after the drill, and nothing from it is printed).
6. `storage:migrate-to-s3` on staging (dry run → run → switch), then on production in the window (pre-release backup first).
7. Evidence table in `production.md`: backup sizes, durations, drill date, RTO, RPO.

## T17.7 — MongoDB and Redis production readiness → `docs(ops): verify database and redis production settings [P17-T17.7]`

1. From the T17.1 facts, per item in plan T17.7: replica set (convert a standalone in the window: backup → `replSetName` → restart **only our** mongod if it's ours; if MongoDB belongs to the client's admin, write the steps into `host-hardening.md` and open an item), auth + least-privilege app user, bind / closed port (checked from outside), version, cache size vs memory budget, swap, slow log 200 ms, `db:migrate:status`, `sync-indexes`, connection pool vs `maxConnections`.
2. Redis: settings §1 applied through our compose (it's ours); verify `CONFIG GET` after restart; BullMQ queues intact (counts before / after).
3. Each item ticked in `PRODUCTION_AUDIT.md` with the evidence command (no secrets) and date.
4. If `CAV_DB_MODE=atlas`: Atlas cluster in `ap-south-1`, IP access list = production + staging IPs only, migration of data with `mongodump` / `mongorestore` in a window, rollback plan — written as its own sub-runbook before doing it.

## T17.8 — Monitoring, alerts, logs, System page → `feat(ops): add monitoring, alerts and a system page [P17-T17.8]` (both repos)

1. Backend `GET /api/v1/admin/system` per §1 (superadmin only, cached 10 s, cert days from a file path in env `TLS_CERT_PATH` mounted read-only, or `null`); tests: superadmin only (403 others, 401 key), no secrets in the body (assert no `mongodb`, `redis://`, `@`), queue numbers from a test queue. OpenAPI regenerated; frontend `gen:api`.
2. Frontend `/admin/system` page + nav entry for superadmins: commit / built at / env, each dependency green / red, queue table, last backup + drill, cert days, superadmins without 2FA; tests (render, red states, permission).
3. `healthwatch.sh` per §1 thresholds, state file in `state/alerts.json` (one mail per key per hour, recovery mail), mail through a one-off container (`node dist/ops/alert.js`) so it works when the API is down; `systemd/cav-healthwatch.timer` (5 min). Tests for the threshold logic (extract to a small TS module `src/ops/health-rules.ts` with unit tests; the shell calls it).
4. UptimeRobot: `scripts/uptime-setup.ts` (reads `UPTIMEROBOT_API_KEY` from the file; creates / updates the monitors §1 idempotently; prints monitor ids only). Not in tests.
5. Log rotation verified on both servers (`docker inspect` is forbidden — check with `docker info --format '{{.LoggingDriver}}'` and the compose file). Weekly secret / PII grep: `scripts/log-grep.sh` (patterns from P17-B2-DONE) run by the healthwatch timer once a week, alert on any hit.
6. **Alert tests on staging** (each once, on purpose): stop the API (uptime + `/ready`), fill a test file to cross 80 % on a small loop device or a lowered threshold env for the test, stop the backup timer and set `lastBackup` back 27 h in staging's DB, a fake cert path with 10 days, a queue with 1,001 waiting jobs on staging. Record arrival times in `production.md` → "Alerts tested".

## T17.3 — Staging environment → `feat(ops): bring up staging with the production kit [P17-T17.3]`

1. Provision the staging host (`provision.sh` with `CAV_HOST_ADMIN_OK` rules — staging is ours, so host-wide hardening is applied here: SSH keys only, no root login, `ufw` 22 (from `CAV_SSH_CIDRS` if given) / 80 / 443 / UDP 40000–40999, fail2ban, unattended-upgrades, time sync).
2. DNS `CAV_STG_DOMAIN` → staging IP (owner's DNS step is an input); certbot webroot; nginx from the production template with `VITE_ENV_LABEL=Staging`.
3. Env from `~/.cav-prod/staging/*.env` (copied with `scp` to `env/`, mode 600, never printed); `init-secrets.sh`; bundled MongoDB replica set + Redis (staging never uses the production DB); Razorpay **test** keys; OpenAI key with a low cap; SMTP to a test mailbox; Meta: same app in development mode or a test number — **never** the App Review number.
4. First release on staging with `release.sh` (tag from T17.5), `superadmin:create`, `staging:demo` seed, smoke, then the full post-deploy checks.
5. Excluded from customer alerts; UptimeRobot staging monitors alert the owner only.

## T17.9 — Capacity on the production-sized server → `test(perf): measure capacity on the production-sized server [P17-T17.9]`

1. Staging sized like production (if smaller, scale results and say so). Run on staging, **alone**, with `PERF_SERVER_LOG`: `perf:inbox`, `perf:api -- messages`, `perf:api -- calls`, `perf:ws`, `perf:soak` (60 min), `bench:voice` 20, then raised with a **bench-only** override (`BENCH_MAX_CALLS`, read only by `scripts/bench-voice.ts` and a matching override in the bench's `CallManager` construction — never in the product path) until late ticks > 5 % or stalled frames > 0.
2. During the soak: every minute record MongoDB `serverStatus` (connections, opcounters, wiredTiger cache, `repl.ismaster`), host `free -m`, `vmstat`, disk I/O. If a stall repeats: capture `mongod` log lines for that minute (filtered), find the cause, fix (cache size, memory limit, swap, I/O), rerun.
3. Set `CALL_LIMITS.concurrentPerProcess` from the voice result with 30 % headroom (code change + test + `capacity.md`), and `whatsapp` worker concurrency from the inbox result.
4. `docs/ops/capacity.md`: "Production-sized server" section next to the Mac numbers; each target pass / fail; server size.

## T17.11 — Security go-live → `feat(security): enforce csp and finish production security [P17-T17.11]` (both repos)

1. **DNS (U1):** confirm `45.114.245.71` is gone (`dig`), `check:headers` shows one address; until then UptimeRobot keeps a monitor per address.
2. **CSP report endpoint** `POST /api/v1/csp-report` per §1 (public, `STRICT_RATE_LIMIT`-style limiter, size limit, `application/csp-report` + `application/reports+json`, logs directive + blocked origin only, counts in `admin/system`); rate-limit inventory test + `RATE_LIMITS.md` updated; tests.
3. nginx production template: headers from `nginx-security-headers.md`, HSTS once (app `HSTS_BY_PROXY=true`), CSP report-only with `report-uri`. Release to staging, then production (inside T17.12's release or its own window). After **7 days** with no violations from Meta's sign-up popup (`*.facebook.com`, `connect.facebook.net`), Razorpay checkout (`checkout.razorpay.com`, `api.razorpay.com`), WebSocket and audio: switch to enforced (template variable), re-run Playwright on staging and the manual checks; one-line rollback in the runbook. If 7 days have not passed by P17-B3-DONE: open item with the switch date.
4. **Secrets rotation (U2)** per `secret-rotation.md`, one class at a time, staging first: JWT secrets (users sign in again — do it in the window), Meta App Secret + webhook verify token (update Meta dashboard first — owner input), SMTP, OpenAI, Razorpay, DB / Redis passwords; **`ENCRYPTION_KEY` last**: backup → new key + `ENCRYPTION_KEYS_OLD` → release → `keys:reseal -- --dry-run` → `keys:reseal` → dry run reports 0 → remove the old key in the next release. Record dates only.
5. **Superadmin 2FA:** every superadmin sets it up (owner action, input); `superadminsWithoutMfa == 0` in `admin/system` → `MFA_ENFORCED_FOR_ADMINS=true` in the next release; verify the prompt + a big action needing a fresh code.
6. **App settings** per §1 checked by name on production (`grep -c '^KEY=' env/backend.env`, values never printed; for booleans compare with `grep -c '^KEY=true$'`).
7. **Razorpay (U5):** read the filtered log line (`razorpay: request rejected` → status, code, description only); fix the env (owner provides the right keys into the env file); release; **₹1 live top-up** end to end with the owner's card (owner action): order → payment → webhook → wallet +₹1 → GST invoice PDF; Razorpay webhook URL `https://wa.notifynow.in/api/v1/webhooks/razorpay` + secret set in the Razorpay dashboard (owner input); a refund of the ₹1 is the owner's call.
8. **E-mail:** SPF, DKIM, DMARC pass (`dig TXT`, a test mail via `npm run email:test -- --production` to a mail tester); record the score.
9. **Host hardening on production:** apply only if `CAV_HOST_ADMIN_OK=yes`, else `docs/ops/host-hardening.md` (exact commands, verify steps, rollback) for the client's admin + open item.
10. `PENTEST_CHECKLIST.md` rows for CSP, DNS, secrets, 2FA, host updated with results and dates.

## T17.12 — First managed release: Phase 16 to production → `docs(ops): record the first managed production release [P17-T17.12]`

1. Pre-checks: calling-hours ceiling confirmed (plan §7 #7 default "keep" → the release notes say so to the client); `SUPPRESSION_HMAC_KEY` present by name; maintenance window; release notes `release-phase-16.md` + `release-phase-17.md` (new: build identity, S3, backups, alerts, System page, CSP report, wallet lock, new env names `VITE_*`, `TLS_CERT_PATH`, `HSTS_BY_PROXY=true`) shared with the client's team.
2. **Cut-over from the client's manual setup** (first time only): stop **our** old app process the way T17.1 found it runs (only ours), keep its folder untouched as `legacy-<date>` for rollback, point nginx to `cav-prod` (our server block only), keep the same database and data, same `uploads` folder mounted until the S3 switch. Rollback for the cut-over = start the legacy process + restore the previous nginx file (`nginx -t` first). Write this sub-runbook into `production.md` **before** running it.
3. `release.sh release-20261102-96cc375` on staging → full checks → on production in the window.
4. After deploy: `release-phase-16.md` checklist + post-deploy checks + `/health.commit == 96cc375` on every address; a dry-run test call; inbox message in / out **on a non-review test number** (or only receive on the review number without changing it); a template send; wallet top-up (T17.11); Compliance page; superadmin 2FA prompt (if enforced); `admin/system` all green.
5. Watch 24 h: alerts, error rate (`level ≥ 50` count per hour from filtered logs), queue depths. Rollback criteria written before deploy: 5xx > 2 % for 10 min, Meta webhooks failing > 5 min, logins failing, wallet errors.
6. `docs/ops/releases.md` first row; `ops:record` of the release (audit `ops.release_recorded`).
7. Then release Phase 17's own code the same way (a new sync + tag from this branch **only after the owner merges it to main** — if not merged by now, record the open item: "Phase 17 code release waits for merge").

## P17-B2-DONE — checkpoint → `docs: mark phase 17 batch 2 complete [P17-B2-DONE]` (both repos)

1. Both repos full verify (each command separately, coverage both, builds, `openapi:check`, shellcheck).
2. **Playwright whole suite twice** (169 + new stay green): run 2 with `E2E_BACKEND_LOGS=1` + log grep: `cav_(live|test)_[0-9A-Za-z]{32}`, `whsec_`, `v1=[0-9a-f]{64}`, `\+91[0-9]{10}`, `Bearer [A-Za-z0-9._-]{20,}`, `"password"`, `otpauth`, `\$enc`, `mongodb(\+srv)?://[^ ]*@`, `AKIA[0-9A-Z]{16}`, `age1[0-9a-z]{58}` (the recipient is public but shouldn't be logged), test marker values = 0.
3. Same grep over staging and production logs for the last 24 h (filtered on the server, counts only).
4. Bundle numbers, tracker ticks T17.3, T17.6–T17.9, T17.11, T17.12, CHANGELOGs `Phase 17 · Batch 2`, plan changelog.
5. Merge `main` if it moved (+ verify). Commit, 2-line progress note, **immediately start T17.13.**

---

# ═══════════ BATCH 3 — Runbooks, Meta, sign-off (T17.13 → T17.15) ═══════════

## T17.13 — Runbooks, on-call, game day → `docs(ops): add production runbook and game day results [P17-T17.13]`

1. `docs/ops/production.md` complete: layout, access (who has which key; no keys in the file), deploy, rollback, cut-over rollback, backups, restore, storage, alerts table (+ tested dates), logs, secrets (where each lives, rotation dates), certificate renewal (certbot timer + deploy hook test with `--dry-run`), capacity limits, the System page.
2. Incident runbook (one section each: symptom → first 3 checks → fix → verify → who to tell): site down; `/ready` red; MongoDB down / no primary; Redis down; disk full; queue backlog (Meta webhooks, sends, webhooks out); Meta webhooks failing or unverified; OpenAI errors / budget hit; Razorpay failures; SMTP failures; certificate expired; bad release; leaked secret; a customer asks for export or erasure (Phase 16 tools); App Review number problems.
3. On-call table from `CAV_ONCALL`: order, hours, response times; what the client's team does vs what we do.
4. **Game day on staging** (each timed, each with the runbook open): stop MongoDB; stop Redis; fill the disk past 80 %; release a broken image (automatic restore); `rollback.sh` to a named tag; restore last night's backup on the Mac. Fix every runbook step that was wrong. Results table in `production.md`.

## T17.14 — Meta: App Review, Tech Provider, real number → `docs(meta): record app review and live number status [P17-T17.14]`

1. Status of the App Review submitted 30 Oct (owner input or Meta dashboard screenshot from the owner): approved / questions / rejected. Questions → answer texts drafted in `docs/meta/APP_REVIEW.md`; rejected → fixes in their own commits + resubmission pack (Phase 13 T13.9 format).
2. After approval: app Live, Advanced Access for `whatsapp_business_management`, `whatsapp_business_messaging` (+ `business_management` if used), Tech Provider steps, the client's real number via Embedded Signup on production, webhook fields subscribed (`messages`, `message_template_status_update`, `calls`, …), calling settings synced, billing "Customer pays Meta".
3. Real-phone checks on production (Android + iPhone; owner's phones as input): message in / out, template, media, call permission request, a WhatsApp call (UDP media through the firewall — closes the T17.1 UDP item), opt-out word.
4. Phase 13 tracker rows T13.7–T13.10 ticked or left open with Meta's dates; `meta-app-review-status` facts updated in the plan changelog.

## T17.15 — Gap audit, docs, sign-off → `docs: add phase 17 sign-off and docs [P17-T17.15]` (both repos)

1. Gap audit: plan §0 Done-when + §4 + §1a U1–U7 + every row of §1c + this prompt §4. Every gap → fixed now or an explicit open item with the reason and owner.
2. Docs: `production.md`, `PRODUCTION_AUDIT.md`, `host-hardening.md` (if used), `capacity.md`, `releases.md`, `release-phase-17.md`, ADR 0049 in the index, `staging.md` (points to the production kit, Phase 13 notes kept), `security.md` + `PENTEST_CHECKLIST.md`, `data-model.md` (`platformSettings.opsStatus`), `audit.md` (+2), `api.md` (`/admin/system`, `/csp-report`), `src/README.md` rows (`src/ops/*`, wallet lock), both READMEs (Deploy section: how a release is made; env table: `VITE_*`, `TLS_CERT_PATH`), both CHANGELOGs, BUILD_PLAN_V2 changelog ("Phase 17 done … Next: Phase 18").
3. `docs/phases/PHASE_17_SIGNOFF.md` (Phase 16 format): scope, server facts (no secrets), releases made, backup + drill numbers (RPO / RTO), alerts tested, capacity, security items closed, tests + coverage (both), Playwright runs, bundle, deviations, bugs fixed, findings, flakes, open items + owners.
4. Tracker all ticked (or open with reason); plan changelog final line.

## P17-B3-DONE — checkpoint → `docs: mark phase 17 complete [P17-B3-DONE]` (both repos)

1. Final full verify both repos (each command separately), shellcheck, branch diffs scanned for keys / URIs (gitleaks if installed; otherwise the pattern scan, and say so), `npm audit --omit=dev` 0 high in both, Playwright once more (green), `git status` clean in both, `git log --oneline main..HEAD` listed.
2. Production final checks (read-only): `/health` commit on every address, `check:headers`, `status.sh`, last backup < 26 h, UptimeRobot all up, `admin/system` green.
3. **Final report (Hinglish, the only full report of the run):** what was built / done (per task, 1 line each), production state (live commit, release tags, cut-over done or not), numbers (tests before → after, coverage, Playwright, capacity, backup sizes, RPO / RTO, alert arrival times, bundle), commits per repo (short sha + subject), deviations, bugs fixed, findings, flakes, open items (incl. "owner actions: DNS, secret rotation dates, 2FA setup, Razorpay keys, CSP enforce date, repo visibility, merge Phase 17 to main, App Review"), and how the client's team makes the next release (one command).

---

## 4. FINAL CHECKLIST

**Step 0**

- [ ] Inputs checked (names only), plan locked, `[P17-PROMPT]`; baseline green

**Batch 1**

- [ ] T17.1 read-only audit (production + staging), outside-in checks, risks classified, blockers in plan §8
- [ ] T17.2 ADR 0049, topology, ports / limits from facts
- [ ] T17.4 production kit, build identity (API + SPA), `release.sh` / `rollback.sh` / `status.sh` / `check-deploy.sh`, migration rule, Mac rehearsal incl. forced failure, shellcheck in CI
- [ ] T17.5 `sync-client-repo.sh` with client-edit check + secret scan + tags, client repo build CI, Phase 16 tagged
- [ ] T17.10 wallet lock across processes (proven failing first), messages p95 target, 3 flakes fixed, backend stderr kept, 5 green runs
- [ ] P17-B1-DONE (verify) → continued without stopping

**Batch 2**

- [ ] T17.6 S3 coverage + `storage:migrate-to-s3`, encrypted backups + manifests, lifecycle / IAM, restore drills (staging + production copy) with RTO
- [ ] T17.7 MongoDB replica set / auth / bind / cache / slow log; Redis noeviction + AOF; evidence
- [ ] T17.8 `/admin/system` + page, healthwatch rules + tests, UptimeRobot, log rotation + weekly grep, every alert tested
- [ ] T17.3 staging host hardened, TLS, env, first release, demo seed
- [ ] T17.9 capacity on the production-sized server, voice max, Mongo watched in soak, limits set
- [ ] T17.11 DNS, CSP report endpoint + report-only → enforce (or dated item), secrets rotated (staging then production), 2FA enforced, settings by name, Razorpay ₹1 live, mail auth, host hardening (or handover), pen-test rows
- [ ] T17.12 cut-over runbook, Phase 16 released by tag, checks, 24 h watch, release record
- [ ] P17-B2-DONE (verify both, Playwright twice + log grep, server log grep, bundle) → continued without stopping

**Batch 3**

- [ ] T17.13 production runbook, incident runbook, on-call, game day timed
- [ ] T17.14 App Review status, Tech Provider, real number, real-phone checks incl. UDP call
- [ ] T17.15 gap audit, all docs, release notes, sign-off
- [ ] P17-B3-DONE (final verify, production read-only checks, clean trees, final Hinglish report)
