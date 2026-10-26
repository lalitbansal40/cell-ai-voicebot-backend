# P13 RUN — Staging Deploy + Meta App Review (T13.1 → T13.11) — Run Prompt

> **HOW TO RUN — 3 batches, one at a time (same as Phases 3–12), with OWNER GATES.** Phase 13 is half code and half real-world work (AWS, DNS, Meta's dashboard, real phones, screen recordings). The run does everything a machine can do by itself and **stops at each gate** with an exact checklist for the owner. After the owner finishes a gate, paste the next command.
>
> **Batch 1 (local, fully autonomous — Meta 2026 changes, legal pages, Docker / compose / nginx, ops scripts, local production rehearsal):**
> `cell-ai-voicebot-backend/docs/prompts/PHASE_13_PROMPT.md padho aur STEP 0 + BATCH 1 (P13-SETUP se P13-B1-DONE tak) SAARE tasks step by step autonomously implement karo. Bich me koi question mat poochho, permission mat maango — saare decisions is prompt + PHASE_13_PLAN.md me pre-made hain. Har task ke baad verify (har command alag) + commit (tag [P13-T13.x]). Koi push / merge NAHI. Ant me P13-B1-DONE checkpoint + GATE A ki owner checklist + final report (Hinglish).`
>
> **Batch 2 (after GATE A is done by the owner — staging server, first deploy, services live; stops at GATE B for the Meta dashboard, then finishes Meta wiring):**
> `cell-ai-voicebot-backend/docs/prompts/PHASE_13_PROMPT.md padho aur BATCH 2 (GATE A check se P13-B2-DONE tak) step by step karo. GATE A ya GATE B ka koi item missing ho to wahin STOP karke owner ke liye exact checklist do. Bich me aur koi question mat poochho. Har task ke baad verify + commit. Koi push / merge NAHI. Ant me P13-B2-DONE + report.`
>
> **Batch 3 (real checks with the owner's phones, App Review pack, submit, approval, sign-off):**
> `cell-ai-voicebot-backend/docs/prompts/PHASE_13_PROMPT.md padho aur BATCH 3 (T13.8 se P13-B3-DONE tak) karo. T13.8 owner ke saath paired session hai — har phone / browser step ke liye owner ko ek-ek step batao aur server side se verify karo. GATE C / GATE D par STOP karke checklist do. Har task ke baad verify + commit. Koi push / merge NAHI. Ant me P13-B3-DONE + Phase 13 sign-off + report.`
>
> **Claude Code "accept edits" mode me chalao.** Working directory: `/Users/lalitbansal/Documents/cell-ai-voicebot`. **Docker Desktop chalu** (`open -a Docker`). **Mac charger par, lid khuli** — lambi runs `caffeinate -dims` ke saath. Is machine par doosre project ke ~12 Supabase containers chalte hain (load average 5–20): flaky timeouts → pehle `uptime`, phir rerun; doosre containers **kabhi mat chhoona**.

---

## 0. CONTEXT (verified facts on 26 Oct 2026 — dobara derive mat karna)

**Owner decision (26 Oct 2026): the frontend and the backend run on ONE machine** — the same staging server serves the SPA (nginx static files), the API + WebSockets + WhatsApp call media, the worker, MongoDB and Redis. One hostname, same origin (plan §1a).

**Branches:** Phase 12 is signed off **and merged into `main` by the project lead** (fast-forward): backend `main` = `3371267 [P12-B3-DONE]`, frontend `main` = `3f2dbbd [P12-T12.12]`. Backend branch `feature/phase-13-staging-app-review` exists (from `main`) with `fad9900 docs(plans): add phase 13 detailed plan [P13-PLAN]`; this prompt is **uncommitted** on that branch. The **frontend** branch is created at the first frontend change (T13.1): `git switch -c feature/phase-13-staging-app-review main`. **Never commit to `main`.**

**Numbers at start:** backend **3162 tests**, gate **95 / 85 / 95 / 95** (measured 96.08 / 87.66 / 95.80 / 97.66); frontend **1304 tests + 148 Playwright tests**, gate **95 / 90 / 90 / 95** (measured 96.09 / 91.94 / 93.74 / 96.88). New frontend files need branch-complete tests. Catalogues (`tests/calls-wa/catalogue.test.ts`): error codes **83**, audit actions **127**, notification types **31**, `MESSAGE_TYPES` **17**; migrations `0001` … `0013`; simulator kinds **70**; nav `LIVE_PHASE = 11` (no Phase 13 nav item — unchanged). Bundle: main JS stream **452.0 KB** gzip (target for new public pages: ≤ +3 KB in the start bundle — legal pages are lazy).

**Pehle padho (har batch se pehle):**

- [PHASE_13_PLAN.md](../phases/PHASE_13_PLAN.md) — **source of truth**: §0 scope + Done when, §1a–§1g locked decisions, §1d Meta facts (re-checked 26 Oct 2026), §3 tasks, §5 risks, §7 owner questions (defaults).
- [PHASE_12_SIGNOFF.md](../phases/PHASE_12_SIGNOFF.md) — §5 deviations, §8 Phase 13 TODOs; [PHASE_11_SIGNOFF.md](../phases/PHASE_11_SIGNOFF.md) §8; [PHASE_10_SIGNOFF.md](../phases/PHASE_10_SIGNOFF.md) §8; [PHASE_9_SIGNOFF.md](../phases/PHASE_9_SIGNOFF.md) §8.
- [docs/setup/meta-whatsapp.md](../setup/meta-whatsapp.md) §1–§15 (the real checklists are §13, §14, §15; the day-of re-check list is §12), [razorpay.md](../setup/razorpay.md), [openai.md](../setup/openai.md), [github-settings.md](../setup/github-settings.md), [prerequisites.md](../setup/prerequisites.md).
- ADRs: [0025](../adr/0025-deployment-style.md) (deferred → **accepted** here), [0028](../adr/0028-local-dev-ports.md), [0030](../adr/0030-email-delivery.md), [0023](../adr/0023-file-storage.md), [0037](../adr/0037-whatsapp-channels-meta.md)–[0041](../adr/0041-whatsapp-calling.md).
- [docs/client/answers.md](../client/answers.md), [server-audit.md](../client/server-audit.md) (the client's EC2 — **not used in Phase 13**), [compliance-notes.md](../compliance/compliance-notes.md), conventions [security.md](../conventions/security.md), [secrets.md](../conventions/secrets.md), [definition-of-done.md](../conventions/definition-of-done.md).

**What exists (use it, don't rebuild):**

| Area                 | Provides                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime              | `npm run build` (tsc → `dist/`), `npm start` (`node --env-file-if-exists=.env dist/index.js`); `src/server.ts` validates env, listens on `PORT` (all interfaces today), graceful shutdown on SIGINT / SIGTERM with ordered `onShutdown` hooks (WhatsApp calls drain, call manager, sockets, queues); `WORKERS_ENABLED` runs BullMQ workers in-process                                                                                                                                                                                                                                                                                             |
| Health               | `GET /api/v1/health` (liveness: `status`, `uptimeSec`), `GET /api/v1/ready` (Mongo + Redis pings, 503 while shutting down) — `src/modules/health/*`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Env rules            | `src/config/env.ts` production checks: `APP_URL`, `FRONTEND_URL`, `CORS_ORIGINS`, `MONGODB_URI`, `REDIS_URL`, JWT secrets ≥ 32 chars, `ENCRYPTION_KEY` 32 bytes base64, `MAIL_FROM`, `EMAIL_DRIVER=smtp`, `PAYMENT_PROVIDER=razorpay` + keys + billing seller fields, `AI_PROVIDER` / `VOICE_PROVIDER=openai`, `MOCK_APIS_ENABLED=false`, `AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS=false`, `VOICE_TEXT_INPUT_ENABLED=false`, `DRY_RUN_MAX_SPEED ≤ 20`, `META_PROVIDER=meta` + default Graph host when WhatsApp is on, `WA_MEDIA_PUBLIC_IP` with real Meta, every `FAKE_*` / `WA_CALL_WINDOW_IGNORED` refused; env-docs test keeps `.env.example` in sync |
| Scripts              | `db:migrate` (+ `status`, `down`), `db:sync-indexes`, `superadmin:create`, `email:test`, `db:seed` (**refuses in production**), `server:audit` (client EC2, read-only — not in Phase 13), `gen:openapi`, `openapi:check`                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Security middleware  | `src/shared/middlewares/security.ts` (helmet; API CSP; CORS from `CORS_ORIGINS`), `TRUST_PROXY`, auth rate limits (`AUTH_RATE_LIMIT_MAX`), refresh cookie (`AUTH_COOKIE_DOMAIN` empty = host-only)                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Meta                 | `/api/v1/webhooks/meta` (GET verify + POST signed), `/api/v1/meta/deauthorize`, `/api/v1/meta/data-deletion` (signed request → code), frontend `/data-deletion` status page; `WEBHOOK_FIELDS` in `src/core/meta/schemas.ts`; Admin → WhatsApp shows the webhook URL + configured flags; `META_GRAPH_VERSION` default `v23.0`                                                                                                                                                                                                                                                                                                                      |
| Embedded Signup (FE) | `src/features/whatsapp/embedded-signup.ts` (`loginOptions` sends `extras: { setup: {}, sessionInfoVersion: 3, featureType? }` — **v3, deprecated by Meta**), `meta-sdk.ts` (`loadMetaSdk`, `parseSessionMessage`, `SESSION_INFO_WAIT_MS`), the fake "Test signup" dialog                                                                                                                                                                                                                                                                                                                                                                          |
| Payments / e-mail    | Razorpay webhook `POST /api/v1/webhooks/razorpay`; frontend `features/wallet/razorpay.ts` loads `checkout.razorpay.com`; SMTP via nodemailer (ADR 0030)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Storage              | `STORAGE_DRIVER=local` (`STORAGE_LOCAL_PATH`) or `s3`; recordings + inbox media + template examples                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Local infra          | `docker-compose.yml` (project `cell-ai-voicebot`, containers `cav-mongo` 27018, `cav-redis` 6380, `cav-mailpit` 1025 / 8025) — **dev only, never reused for staging rehearsal**                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| CI                   | backend `.github/workflows/ci.yml`; frontend `ci.yml` + `e2e.yml`; checks `verify`, `secrets-scan`, `commitlint`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Frontend env         | `VITE_API_URL` (`/api/v1`), `VITE_WS_URL` (empty = derived from the page origin), `VITE_APP_NAME`; `public/favicon.svg` only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

**Reference code:** AutoChatix (`/Users/lalitbansal/Documents/Autochatix`, **READ ONLY**) — `AutoChatix-backend/META_APP_REVIEW.md` lessons only (per-permission use-case text, native-app proof in every video, consent configuration = requested permissions, captions, one continuous recording). **Never copy** its code, app id, test logins, passwords or text.

**Bugs to avoid (typical deploy / review mistakes):**

- secrets in images (`COPY . .` with `.env`), build args, CI logs, the SPA bundle, screenshots or videos;
- publishing MongoDB / Redis / the API port to the internet; forgetting the UDP media range (calls connect but no audio);
- `TRUST_PROXY` wrong (rate limits by nginx IP, wrong client IPs, cookies not `Secure`);
- WebSocket proxy without `Upgrade` headers or with a 60 s read timeout (live views + calls drop);
- caching `index.html` (users keep an old bundle); not caching hashed assets;
- a CSP that blocks the Meta SDK / ES popup or Razorpay checkout;
- running migrations after the new code starts; non-backward-compatible migrations (rollback breaks);
- `db:seed` / fake providers on staging; real borrower data on staging;
- Embedded Signup still on v3; Graph version pinned to an expiring version;
- App Review: unneeded permissions, one video for two permissions, no written text, draft never submitted, consent screen not shown, result not shown in the WhatsApp app;
- backups that were never restored; certificates that never renew.

---

## 1. LOCKED DECISIONS (exact literals — PHASE_13_PLAN §1 has the prose)

**Owner decisions:** plan §7 #1–#18. Answered so far: **one machine for frontend + backend** (26 Oct 2026). Others: if the project lead has answered them by STEP 0, use the answers; otherwise **use the defaults** and record "defaults in use" in the plan changelog.

**Run-prompt refinements (locked now, recorded in the plan changelog at STEP 0):**

1. **Deploy from this Mac over SSH during Phase 13** (rule: no push) — `deploy/staging/scripts/deploy.sh <sha>` packs `git archive <sha>` of both repos, copies it to the server, **builds the images on the server** (linux/amd64, no registry, no arch mismatch), migrates, starts, checks, rolls back on failure. The GitHub Actions workflow is written + actionlint-checked now and becomes the deploy path after the project lead pushes / merges (GATE D).
2. **Host networking for `api` and `worker`** (Docker publishing 1,000 UDP ports spawns one proxy per port): new env **`HOST`** (default `0.0.0.0`; staging `127.0.0.1`) so the API listens on loopback only; WhatsApp media binds `0.0.0.0` on the UDP range; `mongo` / `redis` on the compose bridge network published on `127.0.0.1:27018` / `127.0.0.1:6380` only.
3. **Staging rehearsal without real keys** (Batch 1 is autonomous): a separate compose project `cell-ai-voicebot-rehearsal` on the Mac with `NODE_ENV=production`, `WHATSAPP_ENABLED` unset (off without `META_APP_ID`), generated dummy-but-valid secrets, a throwaway Mailpit as SMTP, Razorpay **dummy test-format keys** (no payment exercised), OpenAI dummy key (no AI exercised), `TELEPHONY_PROVIDER=dryrun`. It proves boot, migrations, nginx, health, ready, SPA, WebSocket, sign-in, deploy + rollback + backup + restore. Real-key flows run on staging (Batch 2 / 3).
4. **ES v4:** `loginOptions` → `{ config_id, response_type: 'code', override_default_response_type: true, extras: {} }` for Cloud API; coexistence → whatever Meta's docs say on the run day (today: v5 enables Business app onboarding by default, v2 / v3 used `featureType: 'whatsapp_business_app_onboarding'`) — if unclear, keep `extras: { featureType: 'whatsapp_business_app_onboarding' }` for coexistence only and note it. `parseSessionMessage` accepts `version` 3 / 4 / 5 (number or string) and events `FINISH`, `FINISH_ONLY_WABA`, `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`, `CANCEL`, `ERROR`.
5. **Graph:** `META_GRAPH_VERSION` default **`v26.0`** (env, `.env.example`, setup guide §7, fixtures that carry a version, fake + stub tests).
6. **Migration `0014-meta-2026.ts`** (additive, reversible): channel `wabaKind: 'whatsapp' | 'messaging' | null` (null = unknown, set from ES / Graph when Meta says) and `waacId: string | null` (sparse index `accountId + waacId`); no backfill required; down removes the fields.
7. **Health:** `GET /api/v1/health` → `{ status, uptimeSec, version, commit, builtAt }` from build-time env **`GIT_SHA`**, **`BUILT_AT`** (both optional; `unknown` when unset); OpenAPI updated; never hostnames / env.
8. **Legal content:** frontend `src/content/legal/privacy.md`, `terms.md` (front matter `lastUpdated: YYYY-MM-DD`, `status: draft | approved`); placeholders `{{company}}`, `{{address}}`, `{{email}}`, `{{grievanceOfficer}}`, `{{appName}}`, `{{website}}`; public env **`VITE_LEGAL_COMPANY`**, **`VITE_LEGAL_ADDRESS`**, **`VITE_LEGAL_EMAIL`**, **`VITE_LEGAL_GRIEVANCE_OFFICER`**, **`VITE_LEGAL_WEBSITE`** (all optional in dev — placeholders show `[company]` etc. with a visible "Draft" banner when `status: draft` or a value is missing).
9. **Demo seed env:** **`DEMO_SEED_CONFIRM`** (must equal the host of `APP_URL`), **`DEMO_OWNER_EMAIL`**, **`DEMO_OWNER_PASSWORD`** (≥ 16 chars), **`DEMO_TEST_PHONES`** (comma list of the team's own E.164 numbers; contacts beyond them get `+91 90000 0xxxx`-style numbers that are **not** real — documented as unreachable) — all only read by `scripts/staging-demo.ts`, never by the API.

**Server layout (staging, exact):**

```
/srv/cell-ai-voicebot/
  src/<sha>/backend, src/<sha>/frontend   # git archive of each deploy
  releases/<sha>/web/                     # built SPA
  releases/current -> <sha>               # symlink; releases/previous -> <sha>
  env/backend.env                         # 600, owner cav — the only secrets file
  env/compose.env                         # 600 — Mongo / Redis passwords for compose
  data/mongo  data/redis  uploads  backups  logs
  deploy/                                 # compose.yaml, nginx conf, scripts (copied from the repo per deploy)
```

- Users: **`cav`** (runs the stack, member of `docker`, no sudo), **`deploy`** (SSH entry for deploys, may run only `/srv/cell-ai-voicebot/deploy/scripts/deploy.sh` via `sudo -u cav` rule) — the run uses the owner-provided admin SSH user only in T13.5 provisioning.
- Compose project **`cell-ai-voicebot-staging`**; containers **`cav-stg-api`**, **`cav-stg-worker`**, **`cav-stg-mongo`**, **`cav-stg-redis`**; images **`cav-backend:<sha>`**; `stop_grace_period: 60s` (api), `30s` (worker); `restart: unless-stopped`; log driver `json-file` `max-size: 20m`, `max-file: "5"`; memory limits api 3g, worker 2g, mongo 2g, redis 512m.
- Ports: TCP **443 / 80** (nginx, public), **22** (SSH, owner's IPs), API **127.0.0.1:5100**, Mongo **127.0.0.1:27018**, Redis **127.0.0.1:6380**, UDP **40000–40999** (media, public).
- nginx site file **`/etc/nginx/sites-available/cell-ai-voicebot.conf`** (+ symlink in `sites-enabled`); nothing else in `/etc/nginx` changed except a `conf.d/cell-ai-voicebot-logformat.conf` defining `log_format cav_noargs`.

**Staging env values (non-secret literals; secrets come from the password manager):**

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=5100
APP_URL=https://<app-host>
FRONTEND_URL=https://<app-host>
CORS_ORIGINS=https://<app-host>
TRUST_PROXY=1
API_DOCS_ENABLED=false
LOG_LEVEL=info
AUTH_COOKIE_DOMAIN=
MONGODB_URI=mongodb://cav:<secret>@127.0.0.1:27018/cell_ai_voicebot?replicaSet=rs0&authSource=admin
REDIS_URL=redis://:<secret>@127.0.0.1:6380
WORKERS_ENABLED=false            # api container; the worker container sets true
TELEPHONY_PROVIDER=dryrun
STORAGE_DRIVER=local
STORAGE_LOCAL_PATH=/srv/cell-ai-voicebot/uploads
CALL_RECORDING_TMP_DIR=/srv/cell-ai-voicebot/uploads/tmp-rec
PAYMENT_PROVIDER=razorpay        # TEST keys rzp_test_… on staging
BILLING_INVOICE_PREFIX=STG
BILLING_SIMULATOR_ENABLED=false
AI_PROVIDER=openai
VOICE_PROVIDER=openai
MOCK_APIS_ENABLED=false
AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS=false
VOICE_TEXT_INPUT_ENABLED=false
EMAIL_DRIVER=smtp
WHATSAPP_ENABLED=true            # after GATE B; false (unset META_APP_ID) before it
META_PROVIDER=meta
META_GRAPH_VERSION=v26.0
WA_MEDIA_ENABLED=true
WA_MEDIA_PUBLIC_IP=<elastic ip>
WA_MEDIA_PORT_MIN=40000
WA_MEDIA_PORT_MAX=40999
```

**Frontend build env (staging):** `VITE_API_URL=/api/v1`, `VITE_WS_URL=` (empty → derived `wss://<app-host>/ws`), `VITE_APP_NAME=Cell AI`, `VITE_LEGAL_*` from plan §7 #11.

**nginx (exact behaviour):** `server_name <app-host>`; `listen 80` → `return 301 https://$host$request_uri` (except `/.well-known/acme-challenge/`); `listen 443 ssl http2`; TLS 1.2 + 1.3, Mozilla "intermediate" ciphers; HSTS `max-age=31536000; includeSubDomains`; `ssl_stapling on`; `client_max_body_size 105m`; `gzip on` (+ `brotli` only if the module exists — never install modules without need); `root /srv/cell-ai-voicebot/releases/current/web`; `location /assets/ { expires 1y; add_header Cache-Control "public, max-age=31536000, immutable"; }`; `location = /index.html { add_header Cache-Control "no-cache"; }`; `location / { try_files $uri /index.html; }`; `location /api/ { proxy_pass http://127.0.0.1:5100; proxy_set_header Host $host; X-Forwarded-For $proxy_add_x_forwarded_for; X-Forwarded-Proto $scheme; X-Real-IP $remote_addr; proxy_read_timeout 120s; }`; `location /ws/ { proxy_pass http://127.0.0.1:5100; proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; proxy_read_timeout 3600s; proxy_send_timeout 3600s; }`; `access_log ... cav_noargs` (no query strings — WS tickets, ES codes); headers on the SPA: `X-Content-Type-Options nosniff`, `Referrer-Policy strict-origin-when-cross-origin`, `Permissions-Policy "microphone=(self), camera=(), geolocation=()"`, `X-Frame-Options DENY`, `X-Robots-Tag "noindex, nofollow"`; `location = /robots.txt { return 200 "User-agent: *\nDisallow: /\n"; }`.

**SPA CSP (start as `Content-Security-Policy-Report-Only` for the first deploy, enforce after a clean day — T13.6 / T13.8):**

```
default-src 'self';
script-src 'self' https://connect.facebook.net https://checkout.razorpay.com;
frame-src https://www.facebook.com https://*.facebook.com https://api.razorpay.com https://checkout.razorpay.com;
connect-src 'self' wss://<app-host> https://graph.facebook.com https://*.facebook.com https://api.razorpay.com https://lumberjack.razorpay.com;
img-src 'self' data: blob: https://*.facebook.com https://*.fbcdn.net https://*.razorpay.com;
media-src 'self' blob:;
style-src 'self' 'unsafe-inline';
font-src 'self' data:;
worker-src 'self' blob:;
frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'
```

(Adjust only by evidence from the browser console during T13.6 / T13.8; record every change.)

**Smoke checks (`npm run smoke -- --url <base> [--demo-email … --demo-password-env NAME]`, exit 1 on the first failure):** `GET /api/v1/health` 200 + `commit` equals `--expect-commit` when given · `GET /api/v1/ready` 200 · `GET /` 200 HTML with `<div id="root">` · one `/assets/*.js` 200 with `immutable` · `GET /index.html` has `no-cache` · `GET /robots.txt` disallows · `GET /privacy` + `/terms` 200 (SPA) · `POST /api/v1/auth/login` with the demo user (password from the named env var, never an argument) → 200 · `POST /api/v1/ws/tickets` + WebSocket connect to `/ws/events` → open within 5 s · `GET /api/v1/webhooks/meta?hub.mode=subscribe&hub.verify_token=<from env META_WEBHOOK_VERIFY_TOKEN>&hub.challenge=<random>` echoes the challenge (only when the env var is present) · security headers present (HSTS on https). Never prints tokens, passwords or the challenge token.

**Backups (exact):** `backup.sh` nightly 02:30 UTC (systemd timer `cav-backup.timer`): `docker exec cav-stg-mongo mongodump --archive --gzip --oplog` + `tar` of `uploads/` (excluding `tmp-rec`) → `age` encryption to the owner's public key (recipient file `/srv/cell-ai-voicebot/env/backup.pub`) → `cav-<UTC timestamp>-{mongo.archive.gz,uploads.tar.gz}.age` → upload to the off-server target (S3 `s3://<bucket>/staging/` with versioning, or the owner's choice) → keep 7 daily + 4 weekly → write `backups/last-success` timestamp. `restore.sh <timestamp>` restores into the compose project `cell-ai-voicebot-restore-check` (ports 127.0.0.1:27118 / 6480), compares collection counts with the live DB, then removes that project. `healthwatch.sh` every 5 min (systemd timer): `/ready`, disk > 80 %, free memory < 10 %, container restarts in the last 10 min, cert expiry < 14 days, `last-success` older than 26 h → e-mail via the same SMTP (rate-limited to one mail per issue per hour).

**Commit names (exact):**

- `docs(plans): lock phase 13 decisions [P13-PLAN]`, `docs(prompts): add phase 13 run prompt [P13-PROMPT]`
- `feat(whatsapp): move embedded signup to v4 and graph api v26 [P13-T13.1]` (backend + frontend, one per repo)
- `feat(legal): add privacy policy, terms and contact pages [P13-T13.2]` (frontend; backend docs part in the same tag)
- `build: add docker image, staging compose and nginx config [P13-T13.3]`
- `feat(ops): add staging deploy, smoke, demo seed and backups [P13-T13.4]`
- `docs: mark phase 13 batch 1 complete [P13-B1-DONE]`
- `docs(ops): record the staging server setup [P13-T13.5]`, `docs(ops): record the first staging deploy [P13-T13.6]`, `docs(ops): record the meta app setup [P13-T13.7]`, `docs: mark phase 13 batch 2 complete [P13-B2-DONE]`
- `docs(ops): record the real-number checks [P13-T13.8]`, `docs(meta): add the app review pack [P13-T13.9]`, `docs(meta): record the app review result [P13-T13.10]`, `docs: add phase 13 sign-off and docs [P13-T13.11]`, `docs: mark phase 13 complete [P13-B3-DONE]`
- every real bug: its own `fix(<area>): …` commit with a regression test proven to fail first.

---

## 2. RULES OF ENGAGEMENT

1. **No questions / no permission requests — except at the gates** (GATE A–D) and inside the paired T13.8 session. Outside those, a safe convention-consistent choice → deviation in the report + plan changelog.
2. **Git:** branch `feature/phase-13-staging-app-review` in both repos; never on `main`; one commit per task per repo, sequential, one repo at a time; hooks must pass (no `--no-verify`, no `--force`); **no push / merge / tag**; footer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; message in a scratchpad file + `git commit -F`; no body line starts with `word:`.
3. **Verify after every code task — each command separately, read output + exit code; never chain `git commit` after checks.**
   - Backend: `npm run lint` · `npm run format:check` · `npm run typecheck` · `npm run test:coverage -- --maxWorkers=2` · `npm run build` · `npm run openapi:check` (stage `openapi/openapi.json` first).
   - Frontend: `npm run lint` · `npm run format:check` · `npm run typecheck` · `npx tsc -p tsconfig.e2e.json --noEmit` · `npm run test:coverage -- --maxWorkers=2` · `npm run build`; `npm run e2e` (whole suite) at T13.1, T13.2 and every checkpoint — infra up, this project's dev servers stopped, `E2E_FRONTEND_PORT=3150`, run from the frontend folder.
   - Infra files: `docker compose -f deploy/staging/compose.yaml config -q`, `hadolint` (one-off `docker run --rm -i hadolint/hadolint < Dockerfile`), `nginx -t` in a one-off `nginx:1.27` container with the config + a self-signed test cert, `shellcheck` (one-off container) on every `.sh`, actionlint on workflows.
   - Long runs in the background with `caffeinate -dims`; never poll them with sleeps.
4. **Coverage gates stay green; never lower thresholds; never raise test timeouts.**
5. **Secrets — hard rules:**
   - never print, echo, `cat`, log, commit or paste a secret (tokens, passwords, keys, `.env` contents, the server env file, SSH keys); check presence with `grep -c '^KEY=' file` or `test -n` only;
   - generated secrets (rehearsal) live only in the scratchpad (`$S/rehearsal/*.env`, `chmod 600`) and are deleted at the end of Batch 1;
   - staging secrets come from the owner: the owner places them in `~/.cav-staging/backend.env` on this Mac (`chmod 600`, outside both repos) or directly on the server; the run copies the file with `scp` and never opens it for reading beyond key-presence checks;
   - `.dockerignore` excludes every `.env*`; the image build test greps the built image (`docker run --rm <img> sh -c 'ls -a /app'`) for `.env` → none;
   - screenshots / videos never show env files, tokens, the Meta app secret, password fields with values, or real customer data.
6. **SSH / server rules:** connect only to the staging host the owner gives (GATE A) with the key path the owner gives; `StrictHostKeyChecking=accept-new` on first connect; never connect to the client's production EC2 (`13.232.191.62`) in Phase 13; every server change is done by an idempotent script in `deploy/staging/scripts/` (re-runnable) and recorded in `docs/ops/staging.md`; never `rm -rf` outside `/srv/cell-ai-voicebot/src` and `releases` (old deploys, keep the last 5); never stop / restart services that are not ours (except `nginx -t && systemctl reload nginx`).
7. **Docker on the Mac:** only `npm run infra:*` (`cav-*`) and the projects `cell-ai-voicebot-rehearsal` / `cell-ai-voicebot-restore-check`; gitleaks / actionlint / hadolint / shellcheck / nginx as one-off `docker run --rm`; never touch other containers / volumes.
8. **No external network in unit / integration tests.** Real Meta, OpenAI, Razorpay and SMTP only on staging and only through the checklists.
9. **Every new env var** → `env.ts` (backend) or `src/config/env.ts` / Vite types (frontend) + `.env.example` + README env table + a rule test; **every new script** → `package.json` + README "Scripts" + a test where it has logic.
10. **Docs in the same commit** (ADR, setup guides, src/README rows, compliance notes, runbook).
11. **Real bugs:** reproduce → regression test proven failing → separate `fix(<area>)` commit → note in the report + plan changelog. On staging: also redeploy and re-run the failed check.
12. **Never kill other projects' processes** (port 3100 belongs to another project). **Never use AutoChatix credentials or copy its text.**
13. **Owner gates protocol:** at a gate, print a numbered checklist (what to do, where to click, which values to put where — never ask for secrets in the chat; secrets go into the files named in rule 5), then STOP the batch with the report. On resume, verify each item mechanically (DNS resolves, SSH works, key names present, endpoint answers) before continuing; a missing item → stop again with only the missing items listed.

---

## 3. RESUME SAFETY

- Both repos: `git branch --show-current` → `feature/phase-13-staging-app-review` (frontend from T13.1); `git log --oneline -25`; continue after the last `[P13-…]` commit.
- `npm run infra:up` → `npm ci` (both) → `npm run db:migrate` (dev DB) → lint → typecheck → `test:coverage` green before continuing.
- Batch 1 requires `[P13-PROMPT]`; Batch 2 requires `[P13-B1-DONE]` + GATE A items; T13.7 (second half) requires GATE B; Batch 3 requires `[P13-B2-DONE]`.
- A half-done task → read `git status` / `git diff`, finish, verify, commit. Never discard work without reading it.
- Staging state is the truth for ops tasks: before any server change, run `deploy/staging/scripts/status.sh` (read-only: containers, current release, disk, cert expiry, last backup) and record it.

---

## STEP 0 — P13-SETUP (before T13.1)

1. Backend: branch `feature/phase-13-staging-app-review`, last commit `[P13-PLAN]` (`fad9900`); `git status` shows only `docs/prompts/PHASE_13_PROMPT.md` (untracked) and maybe `docs/phases/PHASE_13_PLAN.md` (modified — the one-machine note); anything else → stop and report.
2. Plan §7: write "Answered by the owner on 26 Oct 2026: frontend + backend on one machine (confirms §1a)"; other answers if given, else changelog "Defaults in use for §7 #1–#18 except the one-machine answer".
3. Plan changelog line "Run prompt prepared — refinements locked: deploy from the Mac over SSH with server-side image builds (Actions after push / merge); host networking + `HOST` env; production rehearsal without real keys; ES v4 literals; Graph v26.0; migration 0014 (`wabaKind`, `waacId`); health `version` / `commit` / `builtAt`; legal content + `VITE_LEGAL_*`; demo seed env; server layout; nginx + CSP literals; smoke list; backups (this prompt's §1 wins where the plan differs)".
4. Commit 1: plan → `docs(plans): lock phase 13 decisions [P13-PLAN]` (`npm run format:check` first). Commit 2: this prompt → `docs(prompts): add phase 13 run prompt [P13-PROMPT]`.

---

# ═══════════ BATCH 1 — Local, autonomous (T13.1 → T13.4) ═══════════

## T13.1 — Meta 2026 changes → `feat(whatsapp): move embedded signup to v4 and graph api v26 [P13-T13.1]`

1. **Re-read Meta's pages** (plan §1d list: ES versions, v4, v5 if published, implementation / session logging, coexistence onboarding, account model evolution, Graph v26.0 changelog, calling overview + call settings, webhooks fields, App Review, Tech Provider, data privacy). Differences → plan changelog + adjust §1 literals (deviation).
2. **Frontend** (create the branch first): `loginOptions` per §1 #4; `parseSessionMessage` per §1 #4; fixtures `src/test/fixtures/meta-es/{v3-finish,v4-finish,v4-finish-only-waba,v4-business-app,v4-cancel,v4-error}.json` from Meta's documented samples (source URL in a comment file); tests: every event, `version` as number / string, unknown event ignored, missing ids, coexistence options, Cloud API options exactly `extras: {}`; the fake "Test signup" dialog emits v4-shaped messages; Phase 9 E2E still green.
3. **Backend:** `META_GRAPH_VERSION` default `v26.0` (env + `.env.example` + README table + setup guide §7 + test); re-check each Graph path / field we use against v26.0 (`graph.client.ts`, `schemas.ts`, `call-schemas.ts`, `template-schemas.ts`, `message-schemas.ts`) — record "no change" or the change per endpoint in `tests/fixtures/meta/README.md`; migration `0014-meta-2026.ts` (§1 #6) + model fields + tests up / down; ES finish handler stores `waacId` / `wabaKind` when given (optional), never required; `WEBHOOK_FIELDS` vs the dashboard list of the day (add new relevant fields; the receiver ignores unknown fields safely — test).
4. **Account-model audit:** ADR 0037 gains a section "Account model evolution (Meta, 2026)" with a table: every stored / used `wabaId` (channel, templates, subscribed_apps, pricing analytics, coexistence sync, calling settings) → which account Meta means now → change needed in Phase 2 (H1 2027) / Phase 3 (H1 2028).
5. **Calling subscription note:** setup guide §15 adds "the app must also be subscribed to the number's Messaging account (Meta calling docs)"; T13.8 verifies with the real app.
6. Docs: setup guide §3 (ES v4 configuration: login variation Embedded Signup, products Cloud API (+ Business app onboarding), Check a launch config), §7 (v26.0), §12 (new re-check items), CHANGELOG lines later in T13.11.
7. Verify (both repos) + whole E2E once. Commits: backend then frontend, same subject.

## T13.2 — Legal + public pages → `feat(legal): add privacy policy, terms and contact pages [P13-T13.2]`

1. Frontend routes (lazy, no login, own small layout with the logo + footer): `/privacy`, `/terms`, `/contact`; `/data-deletion` gains the instructions section (in-app deletion by an owner, e-mail request, Facebook settings → app removal → callback → status code) above the existing lookup.
2. Markdown → safe renderer (`src/features/legal/render.ts`: headings `#`–`###`, paragraphs, `-` lists, `**bold**`, `[text](https://… or /path)` links only; everything else as plain text; never `dangerouslySetInnerHTML`) + placeholder fill from `VITE_LEGAL_*` (§1 #8) + "Draft — not approved yet" banner rule.
3. **Content** (English, clear, product-true — every claim checked against the code / settings and listed in compliance notes §13): privacy sections per plan §1c (who we are; data categories incl. WhatsApp messages / media / templates / calls / recordings / transcripts, contacts, payments via Razorpay, logs; purposes; legal basis under the DPDP Act 2023 + Rules 2025; Meta / WhatsApp data use only for the business that connected it; AI processing by OpenAI (US) + retention; sub-processors list (Meta, OpenAI, Razorpay, the SMTP provider, the hosting provider); retention values (calls 180 days, inbox 90 days, both configurable; backups 30 days); security; rights + how to use them + grievance officer; data deletion (3 ways); cookies (refresh cookie only, no tracking); children; changes; contact). Terms per plan §1c. `status: draft`.
4. Links: footer on sign-in / sign-up / forgot / reset / accept-invite pages and in the app (user menu → Privacy · Terms · Contact); sign-up text "By creating an account you agree to the Terms and the Privacy Policy" with links.
5. Icons: `public/icon-1024.png`, `icon-512.png`, `icon-192.png`, `apple-touch-icon.png` (180), `favicon.ico` generated from `favicon.svg` by a script `scripts/make-icons.mjs` (sharp or resvg as a **dev** dependency pinned; output committed) — if the owner provides a logo (§7 #12) use it; `manifest.webmanifest` (name, short_name, icons, theme colour), linked in `index.html`.
6. Tests: renderer (every element, hostile input stays text, `javascript:` links dropped), placeholder fill + draft banner, routes without login, footer links on every auth page, sign-up consent text, mobile layout; Playwright `e2e/legal-pages.spec.ts` (no login: privacy / terms / contact / data deletion → 200, headings, links work) in the `chromium` project. Bundle check (legal pages lazy; start bundle ≤ +3 KB).
7. Backend: `docs/compliance/compliance-notes.md` §13 "Privacy policy ↔ product" (each claim → setting / code / retention value).

## T13.3 — Deploy artifacts → `build: add docker image, staging compose and nginx config [P13-T13.3]`

1. **`HOST` env** (§1 #2): `server.listen(port, host)`; env + `.env.example` + README + test (listens on loopback when set).
2. **Health version** (§1 #7) + OpenAPI + `gen:api` (frontend types) + tests.
3. **Backend `Dockerfile`:** `node:24-bookworm-slim` pinned by digest; stage `deps` (`npm ci` with the lockfile), `build` (`npm run build`), `runtime` (`npm ci --omit=dev --ignore-scripts` then rebuild only what needs it, copy `dist/`, `assets/`, the migration files `dist` uses, `docs/samples/audio/*.wav` only if a runtime path reads them — check; `ENV NODE_ENV=production`; `USER node`; `WORKDIR /app`; `EXPOSE 5100`; `HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:5100/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`; build args `GIT_SHA`, `BUILT_AT` → env); `CMD ["node","dist/index.js"]`; scripts (`db:migrate` etc.) available as `node dist/scripts/...` or a compiled entry — make `npm run db:migrate`, `db:sync-indexes`, `superadmin:create`, `staging:demo`, `email:test` runnable inside the image **without `tsx`** (compile `scripts/` that production needs into `dist/scripts/` via `tsconfig.build.json` include, or ship `tsx` as a prod dependency only if compiling is impossible — record the choice).
4. **`.dockerignore`** (§2 rule 5) + a test script `scripts/check-image.sh` (no `.env`, no `tests/`, runs as `node`, size printed).
5. **`deploy/staging/compose.yaml`** (§1 server layout): `api` + `worker` (`network_mode: host`, `env_file: /srv/cell-ai-voicebot/env/backend.env`, `WORKERS_ENABLED` false / true, volumes `uploads`, healthcheck), `mongo` (`mongo:8.2` pinned, `--replSet rs0 --keyFile /data/keyfile --bind_ip_all --port 27017`, published `127.0.0.1:27018:27017`, init script creating the `cav` user + `rs.initiate({_id:'rs0',members:[{_id:0,host:'127.0.0.1:27018'}]})` so host-network apps reach it), `redis` (`redis:7.4-alpine` pinned, `--requirepass` from `compose.env`, `--appendonly yes`, `127.0.0.1:6380:6379`); volumes as bind mounts under `/srv/cell-ai-voicebot/data`.
6. **`deploy/staging/nginx/cell-ai-voicebot.conf`** + `cell-ai-voicebot-logformat.conf` (§1 nginx + CSP, `<app-host>` as a template variable filled by `render-nginx.sh`).
7. **`deploy/staging/env.example`** (every key of §1 staging env + the secrets as empty `KEY=` with comments) and `deploy/staging/compose.env.example`; `deploy/staging/README.md`.
8. **Frontend:** `deploy/staging/build-web.sh` (in the backend repo's deploy folder or the frontend repo — choose the frontend repo `scripts/build-web.sh`): `npm ci && VITE_*=… npm run build` → `dist/` tarball named by sha.
9. CI (backend `ci.yml`): job `image` (docker build, no push, `hadolint`, `check-image.sh`), job `infra-lint` (`compose config`, `nginx -t` container, `shellcheck`); actionlint clean.
10. Verify + infra checks (§2 rule 3).

## T13.4 — Ops tooling → `feat(ops): add staging deploy, smoke, demo seed and backups [P13-T13.4]`

1. **`scripts/staging-demo.ts`** + `npm run staging:demo` (plan §1e + §1 #9): idempotent (upsert by stable keys), refuses unless `NODE_ENV=production` **and** `DEMO_SEED_CONFIRM` = host of `APP_URL` (also allowed in tests), creates the demo account / users / contacts / list / segment / Loan recovery agent + published flow (reuse the template builders, not `db:seed`), credits the wallet through the engine (`credit` with idempotency key `staging-demo-credit-v1`), never prints the password, never writes fake Meta data; tests (idempotent twice, refusal paths, no password in logs, money through the engine).
2. **`scripts/smoke.ts`** + `npm run smoke` (§1 smoke list) + unit tests against a local test server (each check pass / fail, no secret in output).
3. **`deploy/staging/scripts/`** (bash, `set -euo pipefail`, shellcheck clean): `provision.sh` (T13.5 — packages, users, dirs, docker, nginx, certbot, chrony, swap, unattended-upgrades, fail2ban, ufw mirror of the security group, sysctl for UDP buffers `net.core.rmem_max=26214400`), `render-nginx.sh`, `deploy.sh <sha>` (§1 refinement 1: receive archive → build `cav-backend:<sha>` with `GIT_SHA` / `BUILT_AT` → build web → `docker compose run --rm api node dist/scripts/db-migrate.js up` → `db-sync-indexes` → `up -d --no-deps api worker` → wait `/ready` 90 s → `smoke` → switch `releases/current` → keep `previous`; any failure → `rollback.sh`), `rollback.sh` (previous image + previous web, no down-migration), `status.sh` (read-only), `backup.sh`, `restore.sh`, `healthwatch.sh`, systemd units `cav-backup.{service,timer}`, `cav-healthwatch.{service,timer}`.
4. **Mac-side wrapper** `deploy/staging/deploy-from-mac.sh <host> <ssh-key-path>`: `git archive` both repos at their branch heads (records both shas), `scp` to `/srv/cell-ai-voicebot/src/<sha>/`, runs `deploy.sh` over SSH, prints only statuses.
5. **`.github/workflows/deploy-staging.yml`** (backend; checks out the frontend repo at a given ref): `workflow_dispatch` inputs `backend_ref`, `frontend_ref`; `environment: staging`; needs `verify`; steps: checkout both, `ssh-agent` with `secrets.STAGING_SSH_KEY`, `known_hosts` from `secrets.STAGING_KNOWN_HOSTS`, run the same archive + `deploy.sh`; concurrency group `deploy-staging`; actionlint clean. Not runnable until GATE D.
6. **Local production rehearsal** (§1 refinement 3), all in the scratchpad + compose project `cell-ai-voicebot-rehearsal`: generate secrets (`openssl rand`) into `$S/rehearsal/backend.env` (600); a local CA + cert for `rehearsal.localhost`; nginx container with the real config rendered for that host (ports 8443 / 8080 on 127.0.0.1); mongo / redis / api / worker from the real compose file adapted only by an override file (paths under `$S/rehearsal`, host-network not available on Docker Desktop → the override switches api / worker to bridge networking with published ports — record it as a rehearsal-only difference); a throwaway Mailpit; `superadmin:create`; `staging:demo` (confirm env = `rehearsal.localhost`); `smoke` green; **deploy of sha A → sha B (a no-op commit in a scratch clone) → forced failure → automatic rollback to A**; `backup.sh` to a local folder target + `restore.sh` check; SIGTERM drain check (`docker stop` with a live WebSocket: `/ready` 503 first, exit 0 within the grace). Numbers recorded: image size, cold boot to ready, deploy time, rollback time, backup size + time, restore time. Tear down the rehearsal + restore-check projects and delete `$S/rehearsal`.
7. Docs: `docs/ops/staging.md` first version (runbook skeleton: layout, deploy, rollback, backup, restore, status, secrets rotation, cert renewal, incident steps, who to call), README "Deploy (staging)" section, `deploy/staging/README.md`.

## P13-B1-DONE — checkpoint → `docs: mark phase 13 batch 1 complete [P13-B1-DONE]`

1. Full verify of both repos (each command separately) + infra checks + actionlint both + gitleaks both (one-off image) + **Playwright whole suite twice** (2nd with `E2E_BACKEND_LOGS=1` + the Phase 12 log grep).
2. Rehearsal report in the plan changelog (numbers from T13.4 #6); CHANGELOG `Phase 13 · Batch 1`; tracker ticks T13.1–T13.4.
3. **Print GATE A** (below) as the final part of the report.

---

## 🔶 GATE A — owner inputs before Batch 2 (print exactly, numbered)

1. **Server** (plan §7 #1): an Ubuntu 24.04 LTS x86_64 server, ≥ 4 vCPU / 8 GB / 80 GB SSD, with a **static public IPv4** (Elastic IP), in `ap-south-1` (or tell us another region). Not the client's existing EC2.
2. **Security group / firewall:** inbound TCP 22 from your office / home IPs only, TCP 80 + 443 from anywhere, **UDP 40000–40999 from anywhere**; outbound all.
3. **SSH access:** an admin user with `sudo` (e.g. `ubuntu`) and the private key saved at `~/.ssh/cav-staging.pem` (`chmod 400`); tell the run the host IP and the user name (not secret).
4. **Domain** (plan §7 #2): the app hostname (e.g. `app.<client-domain>`) with an **A record → the Elastic IP** (TTL 300), plus a CAA record allowing `letsencrypt.org` if the domain uses CAA.
5. **E-mail** (plan §7 #6): SMTP host / port / user / password for the sender domain + **SPF, DKIM, DMARC DNS records** added as the SMTP provider says; the sender address (e.g. `no-reply@<domain>`).
6. **OpenAI:** a separate project API key for staging with a monthly budget cap (plan §7 #5).
7. **Razorpay test mode:** `rzp_test_…` key id + secret + a webhook secret (you will paste the webhook URL in Razorpay after the first deploy — the run prints it).
8. **Billing seller details** for invoices (plan §7 #10): legal name, address, GSTIN, state code.
9. **Backup target** (plan §7 #8): an S3 bucket (versioning on, lifecycle 30 days) + an access key limited to that bucket (put / get / list / delete), or another off-server target; and an `age` public key whose private key only you keep (`age-keygen` — the run can generate the pair on your Mac into `~/.cav-staging/backup.key` if you prefer; the private key never leaves your Mac / password manager).
10. **Alerts** (plan §7 #9): the e-mail address(es) for alerts; create an UptimeRobot (or similar) account — the run gives the two monitor URLs.
11. **Secrets file:** put items 5–9 into `~/.cav-staging/backend.env` on this Mac (`chmod 600`) using `deploy/staging/env.example` as the template (the run created it) — **never paste secrets into the chat**. Fill the non-secret lines too (`APP_URL`, `FRONTEND_URL`, `CORS_ORIGINS`, `WA_MEDIA_PUBLIC_IP`, `MAIL_FROM`, `BILLING_SELLER_*`). Leave the `META_*` lines empty (GATE B).
12. **Demo users:** choose the review demo owner e-mail (a mailbox you can read) and put `DEMO_OWNER_EMAIL`, `DEMO_OWNER_PASSWORD` (≥ 16 chars), `DEMO_TEST_PHONES` (your test phones, E.164) in `~/.cav-staging/demo.env` (600); a superadmin e-mail + password in `~/.cav-staging/superadmin.env` (600).
13. **Business verification** (plan §7 #3) — **start today** (takes 2–5 business days): business.facebook.com → the owning business → Security Center → Start verification (legal name, address, phone, website on the app domain, documents). Report when it is "Verified" (needed at GATE B / C).
14. **Legal:** send the privacy / terms drafts (`/privacy`, `/terms` on the rehearsal build, or the Markdown files) to the client's legal team for approval; get the grievance officer name + contact (plan §7 #11).

---

# ═══════════ BATCH 2 — Staging server + real services + Meta app (T13.5 → T13.7) ═══════════

**GATE A check (mechanical, no secret printed):** host reachable on 22 with the key; `getent hosts <app-host>` / `dig +short` = the Elastic IP; `~/.cav-staging/{backend,demo,superadmin}.env` exist with mode 600 and contain every required key name (`grep -c`); from the Mac `nc -vz <ip> 443` after nginx, and a UDP check later (T13.5 #3). Missing → stop with only the missing items.

## T13.5 — Staging server → `docs(ops): record the staging server setup [P13-T13.5]`

1. Copy `deploy/staging/` to the server; run `provision.sh` as the admin user (idempotent; prints a summary); create `cav` + `deploy` users, `/srv/cell-ai-voicebot/*` dirs (owner `cav`, `env/` 700).
2. Hardening (plan §1g): SSH `PasswordAuthentication no`, `PermitRootLogin no`, `AllowUsers <admin> deploy`; fail2ban sshd jail; unattended-upgrades security only; chrony; swap 4 GB; ufw mirroring the security group (22 from the given IPs, 80, 443, UDP 40000:40999) — enable only after confirming the SSH rule (never lock us out: keep the current session open, test a second session first).
3. **Outside-in checks from the Mac:** `nmap -Pn -p 22,80,443,5100,6380,27018 <ip>` → only 22 / 80 / 443 open; UDP: start a tiny UDP echo on port 40500 on the server (`socat` one-off) and send from the Mac → echoed → stop it.
4. nginx + certbot: render the site config (`render-nginx.sh <app-host>`), obtain the certificate (`certbot certonly --webroot`), enable the site, `nginx -t && systemctl reload nginx`, renewal timer + reload hook; SSL Labs (or `testssl.sh` one-off container from the Mac) → A.
5. Backup target check: `aws s3 ls` with the scoped key from the server (or the chosen target) → works; a test object put / delete.
6. Record everything in `docs/ops/staging.md` (no secrets / no other projects' data): OS, sizes, users, paths, ports, firewall, cert, backup target name, monitors to create. Commit.

## T13.6 — First deploy + services live → `docs(ops): record the first staging deploy [P13-T13.6]`

1. `scp ~/.cav-staging/backend.env` → `/srv/cell-ai-voicebot/env/backend.env` (600, `cav`); generate `compose.env` (Mongo / Redis passwords) **on the server** with `openssl rand` and write the matching `MONGODB_URI` / `REDIS_URL` passwords into `backend.env` by a server-side script (never through the Mac terminal output); generate the Mongo keyfile on the server.
2. `deploy-from-mac.sh` (first deploy, `WHATSAPP_ENABLED` off because `META_APP_ID` is empty) → migrations `0001`–`0014` applied → `/ready` → smoke green → `status.sh`.
3. `superadmin:create` with `superadmin.env` (copied, used, deleted from the server); `staging:demo` with `demo.env` (same) → demo account ready; sign in as both in a browser (owner does the browser part in Batch 3 if needed — the run checks via the API).
4. **Razorpay test:** print the webhook URL `https://<app-host>/api/v1/webhooks/razorpay` + events list (razorpay.md §3) for the owner (OWNER ACTION: paste it in Razorpay → Webhooks); then a test top-up through the API flow per razorpay.md §4 (owner completes the checkout in the browser with Razorpay's test card) → wallet credited, invoice `STG/…`, PDF link, e-mail.
5. **SMTP:** `email:test` inside the container to the alert address → arrives; headers SPF / DKIM / DMARC pass (owner confirms "Show original").
6. **OpenAI:** openai.md §3 live checklist via the API (agent playground answer; a short browser test call is done by the owner in Batch 3 T13.8).
7. **Backups + alerts:** `backup.sh` once → object in the target; `restore.sh` check → counts match; enable the timers; `healthwatch.sh --test` → e-mail; UptimeRobot monitors (OWNER ACTION with the two URLs: `https://<app-host>/api/v1/health`, `https://<app-host>/`).
8. **Drain check:** open a WebSocket (smoke helper) + redeploy the same sha → `/ready` 503 during drain, exit within the grace, back to green; the WebSocket reconnects.
9. **CSP report-only:** collect browser console reports during the owner's first browser session (Batch 3) — keep report-only until then.
10. Log check on the server: `docker logs` of api / worker since deploy → no secrets, no e-mails in clear (masked only), no phone numbers, no tokens. Record numbers (boot time, deploy time). Commit.

## 🔶 GATE B — Meta app (owner, in Meta's dashboard; the run prints this list with the real host filled in)

1. Business verification = **Verified** (GATE A #13).
2. developers.facebook.com/apps → **Create app** → type **Business** → use case **WhatsApp** (connect to the verified business portfolio).
3. Add product **Facebook Login for Business**.
4. **App settings → Basic:** App display name "Cell AI" (§7 #12), contact e-mail, **Privacy Policy URL** `https://<app-host>/privacy`, **Terms URL** `https://<app-host>/terms`, **User data deletion** → "Data deletion callback URL" `https://<app-host>/api/v1/meta/data-deletion` (and/or instructions URL `https://<app-host>/data-deletion`), **App icon** `icon-1024.png` (the run puts it in `~/.cav-staging/`), **Category** (Business and pages / the closest messaging category), **App domains** `<app-host>`. Save.
5. **Facebook Login for Business → Settings:** Allowed domains for the JavaScript SDK `https://<app-host>`; Login with the JavaScript SDK **on**; Deauthorize callback `https://<app-host>/api/v1/meta/deauthorize`; Data deletion request URL as in #4.
6. **Facebook Login for Business → Configurations → Create:** login variation **Embedded Signup**, products **Cloud API** (+ **WhatsApp Business app onboarding** if offered, for coexistence); permissions auto-selected (`whatsapp_business_management`, `whatsapp_business_messaging`, + whatever Meta adds — note them); copy the **Configuration ID**. Optional: WhatsApp → Embedded Signup Builder → "Check a launch config" with `{}` → screenshot the result.
7. **WhatsApp → Configuration → Webhook:** Callback URL `https://<app-host>/api/v1/webhooks/meta`; Verify token = a new random string ≥ 24 chars (put it in the env file first — #9 — and wait until the run redeploys, then click **Verify and save**); subscribe **every** field the run lists (`WEBHOOK_FIELDS`, printed by the run).
8. **App roles:** add the team as Administrators / Developers; note who.
9. Put into `~/.cav-staging/backend.env`: `META_APP_ID`, `META_APP_SECRET`, `META_ES_CONFIG_ID`, `META_WEBHOOK_VERIFY_TOKEN`, `META_GRAPH_VERSION=v26.0` (leave `META_CREDIT_LINE_ID` / `META_SYSTEM_USER_TOKEN` empty — customer pays, §7 #4). Tell the run "GATE B env ready" (no values).
10. Phones / numbers (§7 #13): 2 phones with WhatsApp (Android + iPhone), a new SIM for the platform's own test WABA (or use Meta's test number from **WhatsApp → API Setup**), and add the phones as recipients on the test number if Meta asks.

## T13.7 — Real Meta app wired → `docs(ops): record the meta app setup [P13-T13.7]`

1. GATE B check (key names present; app id format digits; config id digits).
2. Copy the env file → redeploy (`WHATSAPP_ENABLED` on) → smoke incl. the verify challenge → OWNER ACTION: click **Verify and save** + subscribe fields → the run confirms a dashboard **test event** reaches Admin → WhatsApp (last event) — the owner sends the test from the dashboard.
3. Setup guide §11 smoke (8 items) — run-side checks via the API / logs, browser parts by the owner: Admin → WhatsApp shows provider `meta` + every flag ✓; owner → Connect WhatsApp → Meta popup (ES v4) → finish with the platform's test number → card **Connected** (quality, limit, billing line "customer pays"); Sync now; the daily health job scheduled.
4. Verify ES v4 end to end in the logs (ids only): code exchanged once, `subscribed_apps` success, `register` with PIN success (or skipped for coexistence), session info received.
5. `docs/ops/meta-app.md`: app id (public), configuration id (public), where each setting lives, roles (names), ES launch-config result, dates — no secrets. Commit.

## P13-B2-DONE — checkpoint → `docs: mark phase 13 batch 2 complete [P13-B2-DONE]`

`status.sh` + smoke on staging green; monitors green; one nightly backup done; Meta test number Connected; webhooks verified; plan changelog (Batch 2 numbers + deviations) + CHANGELOG `Phase 13 · Batch 2` + tracker ticks.

---

# ═══════════ BATCH 3 — Real checks, App Review, sign-off (T13.8 → T13.11) ═══════════

## T13.8 — Real checks (paired with the owner) → `docs(ops): record the real-number checks [P13-T13.8]`

**How the session works:** the run gives the owner **one step at a time** ("On the iPhone send a photo with caption to the test number"), then verifies on the server (message row, status, webhook event, wallet line, call row — ids / counts only, never message text) and marks ✅ / ❌ in a results table (`docs/ops/real-checks.md`: item, date, device / browser, result, note). ❌ → reproduce locally with the fake provider if possible → regression test → `fix(...)` commit → redeploy → re-run.

1. **Before:** import Meta's official INR **messaging** and **calling** rate cards (owner provides the CSVs, plan §7 / Phase 11–12 owner inputs) via Admin → WhatsApp billing — if not available, note "placeholder rates" and continue (charges then can't be matched exactly → note in §14 / §15 results).
2. **§12 re-check** items (Graph version, ES events, coexistence window, credit sharing method, error codes, Phase 10 payloads, media hosts, voice flag, block API, profile fields).
3. **§13 inbox** — all 10 items (two phones, Chrome / Firefox / Safari for voice notes).
4. **§14 templates + charges** — all 9 items (the reconciliation item is checked the **next day**; leave it open and come back).
5. **§15 calling** — all 9 items on the number that allows calling (Meta test number with calling enabled in call settings / sandbox / a number with limit ≥ 2,000): permission in / outside the window, agent BIC (two-way audio, hold, keys, hang up both sides), AI BIC with a key press, UIC team ring (first wins, missed → bubble + bell), UIC AI → team, recording both sides, **latency**: the owner measures mouth-to-ear both directions (clap / beep method, phone video at 240 fps, or the counted-tone method — write the method down) + the run records `metrics.whatsapp` RTT / jitter / loss of those calls, Meta Insights duration vs our pulses (± 1 pulse), log check. Also confirm the app is subscribed to the number's Messaging account (T13.1 #5).
6. **Coexistence:** onboard a Business app number (if the owner has one) → contacts + history sync start within minutes; calling shows unavailable.
7. **Data deletion + deauthorize callbacks:** the owner removes the app from Facebook settings (test user) → signed requests verified → status page shows the code.
8. **CSP:** collect the report-only violations seen in these sessions → adjust (evidence only) → switch to enforcing → redeploy → re-check ES popup, Razorpay checkout, recordings, voice notes, calls.
9. **Staging log grep** per session (SDP lines, `+91` / digits of the test phones, contact / member names, message texts used, tokens, `EAAG`, passwords) → 0 hits.
10. Results table complete; open items (e.g. reconciliation next day) closed before the commit.

## T13.9 — App Review pack → `docs(meta): add the app review pack [P13-T13.9]`

1. `docs/meta/APP_REVIEW.md` (English for the form, notes in Hinglish ok): permissions (only `whatsapp_business_management`, `whatsapp_business_messaging`; + `business_management` only if the ES configuration lists it — then its own text + video); **use-case texts** (plan §3 T13.9 #2 drafts, finalised against the real UI); **screencast scripts** shot by shot (plan T13.9 #3: management = create a template in our app → In review → Approved; messaging = send text + template from the inbox → shown in the WhatsApp app on the phone (screen-mirrored next to the browser) → the customer replies → shown live; optional calling clip); captions text for each step; recording rules (continuous, English UI, captions on screen, cursor visible, 1080p, no secrets / no real customer data / no other tabs, no audio needed, consent screen visible where ES is shown); **reviewer instructions** (URL, "Facebook Login for Business integrated: yes", demo credentials entered **only in the form**, steps per permission, the connected test number, the phone number the reviewer can message, support e-mail); **pre-submit checklist** (plan T13.9 #5); a "Rejections" table (date, permission, reason, fix, resubmitted).
2. Demo account ready for reviewers: connected test number, 2 approved templates (utility + call permission), sample contacts, the AI agent + published flow, wallet credit; sign-in works from a fresh browser profile; the run checks via the API.
3. Captions: produce `docs/meta/captions/*.srt` or on-screen caption text per step (the owner overlays them while recording, or the run adds a caption bar component visible only with `?review-captions=1` — **not** in the product UI; if added, it is dev-only and removed after recording — record the choice).

## 🔶 GATE C — owner records + submits

1. Record the videos exactly per the scripts (`docs/meta/APP_REVIEW.md`) — one file per permission; check each against the checklist (consent screen where needed, native WhatsApp app result, captions, no secrets).
2. App Dashboard → App Review → Permissions and Features → **Request advanced access** for each permission → paste the text → attach the video → reviewer instructions + demo credentials → **Submit** (not draft). Data Use Checkup / Data Protection Assessment — answer if shown.
3. Tell the run "submitted on <date>" and paste Meta's messages (no personal data) when they arrive.

## T13.10 — Follow-up, approval, client number → `docs(meta): record the app review result [P13-T13.10]`

1. On each Meta message: map it to the checklist → fix (text / video / product — product fixes as `fix(...)` with tests + redeploy) → update `APP_REVIEW.md` Rejections table → the owner resubmits (GATE C again).
2. After approval: app **Live** (App Dashboard toggle); Tech Provider steps of that day (WhatsApp → Quickstart → Tech Provider onboarding — owner); verify Advanced Access shows "Approved" for both permissions; a **non-role** user's ES consent screen now lists the permissions.
3. **Client's real number** (§7 #14): superadmin sets the client account's Meta billing mode "customer pays" → the client's admin runs Connect WhatsApp (ES v4) with us → Connected → payment method added in WhatsApp Manager → a test message both ways → display name status noted → messaging limit noted (calling needs ≥ 2,000).
4. Record dates, the approval (screenshot stored outside git, mentioned by name), and the client connection result (ids only).

## 🔶 GATE D — project lead (optional during Phase 13, required before Phase 14 deploys)

Review + merge the Phase 13 branches (Phase 12 is already merged); push; set the GitHub `staging` environment (required reviewer) + secrets `STAGING_SSH_KEY`, `STAGING_KNOWN_HOSTS`, `STAGING_HOST`; run `deploy-staging.yml` once → green. The run records the result in T13.11 if done.

## T13.11 — Gap audit, docs, sign-off → `docs: add phase 13 sign-off and docs [P13-T13.11]`

1. Requirement → evidence table (plan §0 Done when, every task, every §7 decision).
2. Security checklist: SSL Labs / testssl result, nmap result, headers, CSP enforcing, secrets locations (env file on the server, `~/.cav-staging` on the Mac, password manager, GitHub environment if GATE D), image check, log greps, backup + restore evidence, access list (names).
3. Docs: `docs/ops/staging.md` (final runbook), `docs/ops/meta-app.md`, `docs/ops/real-checks.md`, `docs/meta/APP_REVIEW.md`, ADR 0025 **accepted** (Docker Compose + host nginx) and **ADR 0042 — Staging topology + deploy pipeline** (one machine, same origin, host networking for media, server-side builds, rollback rule, backups), setup guides (meta-whatsapp §3 / §7 / §11 / §15 with real results; razorpay; openai), compliance notes §13, both READMEs (status, deploy, legal pages, scripts, env), both CHANGELOGs (`Phase 13 · Batch 1 / 2 / 3`; frontend `Phase 13 · Staging + legal pages`), BUILD_PLAN_V2 (Phase 13 ✅ + changelog + "Next: Phase 14 (Records, transcripts & analytics)"), PHASE_13_TASKS all `[x]`, plan changelog.
4. `PHASE_13_SIGNOFF.md` (Phase 12 structure): tasks + evidence, deliverables, requirement → evidence, numbers (tests before → after, coverage, image size, boot / deploy / rollback times, backup size / restore time, page load (Lighthouse mobile on staging), call latency + RTT + jitter + loss), real checks results (§13 / §14 / §15 counts), App Review timeline, security, deviations, bugs, verification, TODOs by phase (Phase 14 records; Phase 15 public API; Phase 16 security audit + DPA + load tests + Sentry; Phase 17 production on the client server + S3 + blue / green; Phase 18 SIP; Phase 20 campaigns), owner inputs still pending, go / no-go for Phase 14.

## P13-B3-DONE — checkpoint → `docs: mark phase 13 complete [P13-B3-DONE]`

1. Both repos full verify + actionlint + gitleaks + Playwright whole suite **twice** (2nd with logs + grep) after the last code commit.
2. **Fresh clones** of both repos side by side (scratchpad, branch `feature/phase-13-staging-app-review`) → `npm ci` → all checks **without `.env`** → `gen:api` no diff → tests → E2E once → `docker build` of the image from the clone → delete the clones.
3. Staging: `status.sh`, smoke, last backup < 26 h, cert > 30 days, monitors green.
4. `npm audit` both (record; Phase 12 had backend 7 / frontend 3 — note new ones).
5. Fill the sign-off §Verification; commit; `infra:down` (only `cav-*` on the Mac). No push / merge.
6. **Final report (Hinglish):** per task ✅ / ⚠️ / ❌, `git log` both repos, staging URL + status, App Review status, real checks summary, numbers, bugs fixed, deviations, owner inputs still pending, Phase 14 go / no-go.

---

## 4. FINAL CHECKLIST

**Step 0**

- [ ] `[P13-PLAN]` lock (one-machine answer + defaults + refinements) and `[P13-PROMPT]`

**Batch 1**

- [ ] T13.1 ES v4 + Graph v26.0 + migration 0014 + account-model audit + webhook fields (both repos)
- [ ] T13.2 privacy / terms / contact / data deletion instructions, footer links, icons, manifest, legal E2E spec
- [ ] T13.3 `HOST` env, health version, Dockerfile, `.dockerignore`, staging compose, nginx + CSP, env templates, CI image + infra lint
- [ ] T13.4 demo seed, smoke, deploy / rollback / status / backup / restore / healthwatch scripts, Mac wrapper, Actions workflow, local production rehearsal (numbers)
- [ ] P13-B1-DONE (verify, E2E twice + grep, GATE A printed)

**Batch 2**

- [ ] GATE A complete (server, firewall incl. UDP, SSH, DNS, SMTP + DNS, OpenAI, Razorpay test, seller details, backup target + age key, alerts, secrets files, demo / superadmin files, business verification started, legal drafts sent)
- [ ] T13.5 provision + hardening + outside-in checks + TLS A + backup target
- [ ] T13.6 first deploy, superadmin, demo account, Razorpay test top-up, SMTP, OpenAI, backup + restore, monitors, drain check, logs clean
- [ ] GATE B complete (verified business, app, Login for Business, basic settings, ES v4 config, webhook, roles, env, phones)
- [ ] T13.7 Meta wired: webhook verified + test event, §11 smoke, ES v4 connect of the test number, notes
- [ ] P13-B2-DONE

**Batch 3**

- [ ] T13.8 §12 / §13 / §14 / §15 + coexistence + callbacks + CSP enforcing + log greps — results table
- [ ] T13.9 App Review pack + demo account ready + captions
- [ ] GATE C videos recorded + submitted
- [ ] T13.10 follow-ups → Advanced Access approved, app Live, Tech Provider steps, client's real number connected
- [ ] GATE D (optional) merge Phase 13 + push + Actions deploy
- [ ] T13.11 gap audit, runbook, ADR 0025 / 0042, setup guides, READMEs, CHANGELOGs, BUILD_PLAN_V2, sign-off
- [ ] P13-B3-DONE (verify, E2E twice, fresh clones, staging status, audit, report)
