# Phase 13 — Staging Deploy + Meta App Review (Detailed Plan)

**Status:** Draft — 2026-10-26 · **Branch:** `feature/phase-13-staging-app-review` (both repos, from `main` = the Phase 12 tip — backend `3371267 [P12-B3-DONE]`, frontend `3f2dbbd [P12-T12.12]`; Phase 12 merged by the project lead on 26 Oct 2026; the frontend branch is created at T13.1) · **Overview:** [BUILD_PLAN_V2.md](../plans/BUILD_PLAN_V2.md) · **Previous:** [PHASE_12_SIGNOFF.md](PHASE_12_SIGNOFF.md) · **Tracker:** [PHASE_13_TASKS.md](PHASE_13_TASKS.md)

---

## 0. Is phase ka goal

Phase 13 ke end tak:

- App ek **public HTTPS staging** pe chale (frontend + API + WebSockets + WhatsApp call media), `NODE_ENV=production` ke saare rules ke saath — real Meta, real OpenAI, Razorpay **test mode**, real SMTP, backups, monitoring, ek-click deploy aur rollback.
- **Real Meta app** bane aur chale: business verification, Embedded Signup **v4**, webhooks verified, callbacks (deauthorize + data deletion), privacy policy / terms / data deletion pages, app icon, category, Tech Provider onboarding.
- Phase 10 / 11 / 12 ki **real-number checklists** (setup guide §13, §14, §15) real phones pe pass hon — messages, templates + charges, WhatsApp calling (latency measured).
- **App Review** submit ho aur `whatsapp_business_management` + `whatsapp_business_messaging` ko **Advanced Access** mile; Meta app **Live** ho.
- Client ka **real number** Embedded Signup se connect ho sake.

1. **Code readiness** — Meta ke 2026 badlav: Embedded Signup v2 / v3 **15 Oct 2026 se deprecated** (v4 / v5 available; hamara code abhi `sessionInfoVersion: 3` bhejta hai), Graph API **v26.0** (hamara default `v23.0`), account model evolution (`waba_id` ab Messaging account ID), calling ke liye app ka Messaging account pe subscription.
2. **Legal + public pages** — Privacy Policy, Terms of Service, Data deletion instructions (status page already hai), footer links, app icon 1024 × 1024, contact page / email.
3. **Deploy artifacts** — backend Dockerfile, frontend static build + nginx config (SPA, `/api`, `/ws` upgrade, CSP for the Meta SDK + Razorpay, HSTS), Docker Compose stack, env template, health with build version, logs, graceful drain.
4. **Ops tooling** — production-safe reviewer demo seed, superadmin bootstrap, backups + restore drill, smoke script, GitHub Actions deploy + rollback.
5. **Staging server** — provisioning, hardening, firewall (TCP 22 / 80 / 443 + UDP media range), DNS, TLS, mail DNS (SPF / DKIM / DMARC), first deploy, monitoring, alerts.
6. **Meta app** — real app setup end to end (setup guide §1–§12 on that day), test number connected, webhooks live.
7. **Real checks** — §13 inbox, §14 templates + reconciliation, §15 calling, §12 re-check items, staging log grep.
8. **App Review pack** — permissions, use-case texts, per-permission screencasts, reviewer instructions, demo account, pre-submit checklist; submit → follow up → resubmit until approved.
9. **Docs + sign-off** — runbook (deploy, rollback, backup, restore, incident), ADR 0025 decided + ADR 0042 (staging), setup guides updated, sign-off.

**Done when:**

- `https://<staging-host>` serves the app over HTTPS (A grade on SSL Labs, HSTS), `/api/v1/health` shows the deployed commit, `/api/v1/ready` is green, WebSockets connect, deploy + rollback work from GitHub Actions, the nightly backup ran and one restore was tested.
- Meta dashboard: webhook **Verified**, every field of `WEBHOOK_FIELDS` subscribed, deauthorize + data deletion callbacks answer signed requests, Embedded Signup v4 connects the platform's own test number end to end (code exchange → WABA subscribe → register → **Connected** card).
- Setup guide §13 (10 items), §14 (9 items) and §15 (9 items) all pass on real phones and are recorded in the sign-off (with mouth-to-ear latency); staging logs for those sessions have 0 hits for SDP lines, phone numbers, names, message texts, tokens.
- App Review: `whatsapp_business_management` and `whatsapp_business_messaging` **Advanced Access approved**, app **Live**, Tech Provider steps done; a non-test business (the client's real number) connects through Embedded Signup.
- Whole Playwright suite still green twice locally (fake providers) after the code changes; coverage gates kept.

### Phase 13 mein kya NAHI hoga

| Kaam                                                                                            | Kaunse phase mein                                                                |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Production deploy on the client's EC2 (the server with the other app)                           | Phase 17 (needs the read-only server audit, DB details, domain, access)          |
| SIP trunk / phone calls (`TELEPHONY_PROVIDER` stays `dryrun`)                                   | Phase 18                                                                         |
| Records / analytics / reports                                                                   | Phase 14                                                                         |
| Public API, outgoing webhooks to customers                                                      | Phase 15                                                                         |
| Full security audit, pen test, DPDP DPA templates, load tests                                   | Phase 16 (Phase 13 does the staging hardening baseline only)                     |
| Solution Partner + credit line ("platform pays Meta") — Tech Providers can't share credit lines | Later, only if the owner decides (§7 #4); Phase 13 launches "customer pays Meta" |
| Real customer (borrower) data on staging                                                        | Never — staging holds demo / test data only (DPDP)                               |
| Sentry-style error tracking                                                                     | Phase 16 (Phase 13: log-based alerts + uptime)                                   |
| Multi-server / autoscaling                                                                      | Phase 17+                                                                        |

### Conventions to follow

Same as earlier phases: [api.md](../conventions/api.md), [security.md](../conventions/security.md), [secrets.md](../conventions/secrets.md), [data.md](../conventions/data.md), [definition-of-done.md](../conventions/definition-of-done.md), ADR 0025 (deployment style — decided in this phase), ADR 0028 (ports), ADR 0030 (email), ADR 0037–0041 (WhatsApp), the setup guides ([meta-whatsapp.md](../setup/meta-whatsapp.md), [razorpay.md](../setup/razorpay.md), [openai.md](../setup/openai.md), [github-settings.md](../setup/github-settings.md)).

- **Secrets:** never in git, CI logs, Docker images, build args, the frontend bundle (`VITE_*` are public) or screencasts. Server env file `chmod 600`, owner = the app user; GitHub Actions secrets in the `staging` **environment** (required reviewer). Password manager is the source of truth. The client's SSH key + DB password shared over WhatsApp are treated as exposed (answers.md) — never reused for staging.
- **AutoChatix:** read-only reference (its App Review lessons: correct use-case text per permission, native-app proof, consent config = requested permissions). Never copy its code, credentials, app id, test logins or text verbatim.
- **Other projects on any machine / server:** never touched (Docker: only `cell-ai-voicebot` compose project; nginx: only our server block; ports per ADR 0028).
- **Customer data:** demo data only on staging; logs keep the Phase 9–12 rules (no texts, numbers, names, SDP, tokens).
- **Tests:** no external network in unit / integration tests (Meta, OpenAI, Razorpay stay faked or stubbed); real services only in the staging checklists.
- **Meta facts:** re-checked 26 Oct 2026 (§1d); T13.1 re-reads every listed page on the day it starts and records differences in the changelog.

---

## 1. Locked decisions (proposed — final after the owner answers §7)

### 1a. Staging shape

- **Frontend + backend on one machine** (owner, 26 Oct 2026): the same server serves the SPA, the API + WebSockets + call media, the worker, MongoDB and Redis.
- **One staging server** (separate from the client's production EC2 — §7 #1): Ubuntu 24.04 LTS, ≥ 4 vCPU / 8 GB RAM / 80 GB SSD (e.g. AWS `t3.xlarge` / `m6a.xlarge` in `ap-south-1`), a public IPv4 (Elastic IP) — WhatsApp media needs a stable public IP (`WA_MEDIA_PUBLIC_IP`).
- **One hostname, same origin** (§7 #2): `https://<app-host>` serves the SPA and proxies `/api/*` and `/ws/*` to the API — no CORS, host-only refresh cookie (`AUTH_COOKIE_DOMAIN` empty), one TLS cert, one Meta "App domain". Recommended host = the **final production hostname** (e.g. `app.<client-domain>`) pointed at staging during review; Phase 17 moves the DNS to production, so the Meta app settings, privacy URL and ES allowed domains never change (no re-review).
- **Docker Compose** (ADR 0025 → accepted): project `cell-ai-voicebot`, services `api` (HTTP + WS + WhatsApp media, `WORKERS_ENABLED=false`), `worker` (BullMQ jobs, `WORKERS_ENABLED=true`, no HTTP port exposed), `mongo` (8.2, single-node replica set `rs0`, auth on), `redis` (7.4, AOF, password); **nginx + certbot on the host** (simplest TLS renewals); the SPA is a static folder served by nginx. API and media run in one container (`network_mode` / ports: TCP 5100 on 127.0.0.1 + UDP `WA_MEDIA_PORT_MIN–MAX` published on the public IP).
- **NODE_ENV=production on staging** — every production check runs (fake providers refused): `META_PROVIDER=meta`, `AI_PROVIDER=openai`, `VOICE_PROVIDER=openai`, `PAYMENT_PROVIDER=razorpay` (**test keys**), `EMAIL_DRIVER=smtp`, `MOCK_APIS_ENABLED=false`, `AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS=false`, `VOICE_TEXT_INPUT_ENABLED=false`, `BILLING_SIMULATOR_ENABLED=false`, `TELEPHONY_PROVIDER=dryrun`, `TRUST_PROXY=1`, `API_DOCS_ENABLED=false`, `LOG_LEVEL=info`, `BILLING_INVOICE_PREFIX=STG` (staging invoices never collide with production numbering).
- **Storage:** `STORAGE_DRIVER=local` on a dedicated volume (`/srv/cell-ai-voicebot/uploads`), backed up nightly with the database (§7 #7 — S3 is the Phase 17 default).
- **Process lifecycle:** deploy = build images → `db:migrate` → `db:sync-indexes` → start new containers → `/ready` green → done; the API's SIGTERM drain (calls, sockets) gets `stop_grace_period: 60s`; deploys announced to testers (live WhatsApp calls end `server_shutdown` after the grace).

### 1b. Code changes Meta forces (T13.1)

- **Embedded Signup v4:** new **Facebook Login for Business configuration** with login variation "Embedded Signup" and the product **Cloud API** (+ WhatsApp Business app onboarding for coexistence) → new `META_ES_CONFIG_ID`; `FB.login` `extras` becomes `{}` for v4 (keep `featureType: 'whatsapp_business_app_onboarding'` only if the v4 / v5 docs still ask for it on that day — v5 turns Business app onboarding on by default); `parseSessionMessage` accepts the v4 / v5 `version` values and every `FINISH*` event (`FINISH`, `FINISH_ONLY_WABA`, `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`), `CANCEL`, `ERROR`; v4 always sends session info. Fake provider + fixtures updated to the v4 payloads; the ES "Check a launch config" tool in the dashboard confirms the final config.
- **Graph API v26.0:** `META_GRAPH_VERSION` default → `v26.0`; re-read every endpoint we call (phone numbers, WABA, subscribed_apps, register, messages, media, templates, call settings, calls, call permissions, pricing analytics, business profile, block users, smb_app_data) for changed fields; fixtures + schemas updated; the frontend SDK version follows `graphVersion` from `/whatsapp/config`.
- **Account model evolution (Meta Phase 1, H2 2026):** `waba_id` in webhooks / ES now means the **Messaging account ID**; audit every place we store / use `wabaId` (channel model, templates per WABA, subscribed_apps, pricing analytics, coexistence) and record which ID each call needs; no behaviour change expected now (Meta: Phase 1 needs no code change), but `waac_id` is captured when present (optional field, never required) so Phase 2 (H1 2027) is a small change.
- **Calling:** Meta's calling page asks that the app is subscribed to the number's **Messaging account** too; confirm our `subscribed_apps` call covers it with the real app (T13.8).
- **Webhook fields:** re-check `WEBHOOK_FIELDS` against the dashboard list on the day (new / renamed fields).

### 1c. Legal + public pages (T13.2)

- Public routes (no login): `/privacy`, `/terms`, `/data-deletion` (exists — add the instructions text above the status lookup), `/contact` (company, address, grievance officer for DPDP, support email). Linked from the sign-in / sign-up pages and the app footer.
- Content as reviewed Markdown files in the frontend repo (`src/content/legal/*.md`, rendered as plain text + headings, no raw HTML), with `Last updated` dates; the company details come from `VITE_LEGAL_*` public env (name, address, email) so staging / production can differ without code changes.
- **Privacy policy covers** (draft by us, approved by the client's legal team — §7 #11): who we are; data we process (account users, contacts, call recordings + transcripts, WhatsApp messages / media / templates / call data, payment data via Razorpay, technical logs); purposes; Meta WhatsApp data use (only to provide the service for the business that connected the number); **AI processing by OpenAI** (US) incl. retention settings; sub-processors (Meta, OpenAI, Razorpay, the SMTP provider, the hosting provider); retention (calls 180 days, inbox 90 days, as configured); security; rights under the DPDP Act 2023 / Rules 2025 (access, correction, erasure, grievance, nomination) and how to use them; data deletion (in-app + Meta's callback + email); children; changes; contact + grievance officer.
- **Terms** cover: the service, accounts and roles, acceptable use (TRAI / RBI recovery rules, WhatsApp Business Policy + Commerce Policy, no spam, consent), the customer's responsibility for its contacts' consent, prepaid wallet + GST invoices + refunds, Meta / WhatsApp charges, AI output disclaimer, availability, suspension, liability, governing law (India), contact.
- **Data deletion:** keep the signed callback (`/api/v1/meta/data-deletion`) + status page, and add the written instructions URL (Meta accepts either; we show both).
- **App icon:** 1024 × 1024 PNG (+ 512 / 192 / favicon) from the product logo — owner provides or approves (§7 #12).

### 1d. Meta facts (re-checked 26 Oct 2026, developers.facebook.com → WhatsApp Business Platform)

- **App Review (Tech Provider):** Advanced Access is needed for every permission when other businesses use the app; without it calls on WABAs we don't own fail with error `200` and the permission is not offered in Embedded Signup. **Business verification first** ("must be verified before you can start the app review process").
- `whatsapp_business_management` — written: how we access onboarded clients' business assets; video: our app (or WhatsApp Manager) **creating a message template**.
- `whatsapp_business_messaging` — written: the messaging functions we offer and how clients use them; video: our app **sending a message to a WhatsApp number and the WhatsApp client (web or mobile) showing it**. This permission also covers **making calls** (no separate calling permission or video).
- `whatsapp_business_manage_events` only with the Marketing Messages API + Conversions API — **not requested**. `business_management` only if the ES v4 configuration auto-selects it — then it gets its own text + video.
- Rules: **one video per permission** (never one video for several permissions with different use cases); screen recordings only (no screenshots); every permission needs its written description; **request only needed permissions** (unneeded ones are a top rejection reason); submissions left in draft are never reviewed; average turnaround ≈ 24 h.
- Test users for Embedded Signup before Advanced Access must have a **developer / admin role** on the app.
- Tech Provider: business verification (2–5 business days, documents + domain verification), App Review, then customers onboard via ES; after signup we exchange the code, subscribe the app to the WABA, register the number with a 6-digit PIN, (optionally) enable calling, and the customer adds a payment method in WhatsApp Manager (customer pays Meta).
- Third-party reports (Oct 2026): the **Access Verification** form is being removed from the App Dashboard; business verification + App Review stay — re-check on the day. Meta's Trust Center also lists **Data Use Checkup** (yearly) and **Data Protection Assessment** for some advanced permissions — answer if the dashboard asks.
- **Embedded Signup versions:** v2 / v3 available until **15 Oct 2026**; v4 (8 Oct 2025), v5 (20 Oct 2026); requests for v2 / v3 / no version are now **served as v4**; v4 `extras` "purposely empty"; WABA-only sharing (`only_waba_sharing`) works until 16 Nov 2026.
- **Coexistence (Business app users):** finish event `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`; skip number registration; **contacts + history sync within 24 h** (each once) or the customer must be offboarded; 20 mps throughput; **calling not supported**; Business app ≥ 2.24.17; webhooks `account_update`, `history`, `smb_app_state_sync`, `smb_message_echoes`.
- **Calling:** Cloud API only; messaging limit ≥ **2,000**; business-initiated calling not available in the US, Canada, Egypt, Vietnam, Nigeria (India allowed); webhook field `calls`; media WebRTC ICE + DTLS + SRTP, Opus (PCMA / PCMU also); permission requests 1 / day + 2 / week in production; 4 unanswered → revoked; **sandbox (Tech Partners only) and public test numbers** have relaxed limits (25 / 100) and no 2,000 rule; calling is off by default on test numbers.
- **Graph API:** latest v26.0 (29 Jul 2026); v21.0 expires 21 Jan 2027 (expired versions are routed to the next usable one).

### 1e. Demo account for reviewers + testers (T13.4)

- Script `npm run staging:demo` (allowed with `NODE_ENV=production`, refuses unless `DEMO_SEED_CONFIRM=<host>` matches `APP_URL`, idempotent): account "Demo Finance (Review)", owner `review@<domain>` (password from the password manager, passed by env, never printed), an admin + an agent user, 20 sample contacts with **fake names and the team's own test numbers only**, a list + segment, the Loan recovery AI agent + published flow, call recording notice, wallet credited by a superadmin adjustment (test money), WhatsApp settings defaults. **No fake Meta data** — the WhatsApp number is connected for real via Embedded Signup (T13.8), templates are created in the app and approved by Meta.
- `npm run superadmin:create` (exists) for the platform's superadmin; strong unique password; the reviewer never gets superadmin.
- Public sign-up stays on (Meta reviewers may also sign up); verification e-mails go out through the real SMTP.

### 1f. Deploy pipeline (T13.3 / T13.4)

- **Images:** `ghcr.io/lalitbansal40/cell-ai-voicebot-backend:<git-sha>` (multi-stage, Node 24 slim, `npm ci --omit=dev`, `tsc` build, non-root user, `HEALTHCHECK` on `/api/v1/health`, no secrets, `.dockerignore` excludes `.env`, `uploads`, `coverage`, tests); the frontend is built in CI into a versioned tarball (`dist-<git-sha>.tgz`) with the staging `VITE_*` values.
- **GitHub Actions** `deploy-staging.yml` (both repos or one orchestrating workflow): trigger `workflow_dispatch` (+ optional on push to `main`), job in the `staging` environment (required reviewer = project lead), needs the CI `verify` job green, builds + pushes the image, SSH to the server with a deploy-only key (restricted `authorized_keys` command or a deploy user without sudo), runs `deploy.sh <sha>`: pull image → `docker compose run --rm api npm run db:migrate` → `db:sync-indexes` → `up -d` → wait for `/ready` (60 s) → smoke → on failure **automatic rollback** to the previous sha (kept in `/srv/cell-ai-voicebot/releases/current`). Migrations must stay backward compatible for one release (rollback safety).
- **Health version:** `/api/v1/health` adds `version` (package), `commit` (git sha from build arg `GIT_SHA`), `builtAt` — no secrets, no hostnames.
- **Smoke script** `npm run smoke -- --url https://<host>`: health (commit matches), ready, `GET /api/v1/webhooks/meta` verify challenge with the token from env (only from the server / CI secret), SPA index + one asset with cache headers, WebSocket ticket + connect, sign-in of the demo user (read-only checks). Exit code ≠ 0 → rollback.

### 1g. Server hardening + network (T13.5)

- Ubuntu 24.04, unattended security upgrades, NTP (chrony), swap 4 GB, timezone UTC (app uses account time zones), a dedicated `cav` user (no password login), SSH keys only, `PermitRootLogin no`, SSH limited to the team's IPs (security group) + fail2ban.
- **Firewall / security group:** inbound TCP 22 (team IPs), 80 / 443 (any), **UDP `40000–40999` (any — WhatsApp media)**; nothing else (Mongo / Redis / API bound to 127.0.0.1 or the compose network only); outbound open.
- Docker Engine + compose plugin from Docker's repo; log driver `json-file` with `max-size=20m`, `max-file=5`; nginx access logs without query strings on `/api/v1/meta/*` and `/ws/*` (tickets) — `log_format` strips `$args`.
- **nginx:** HTTP → HTTPS redirect, TLS 1.2 / 1.3 only, HSTS (`max-age=31536000; includeSubDomains` — preload only in Phase 17), OCSP stapling, gzip + brotli, `client_max_body_size` = the largest upload (100 MB documents), proxy timeouts for WS (`proxy_read_timeout 3600s`), `Upgrade` / `Connection` headers for `/ws/`, `X-Forwarded-For` / `-Proto`, SPA fallback `try_files $uri /index.html`, `Cache-Control: immutable` for hashed assets and `no-cache` for `index.html`, **CSP** for the SPA allowing `connect.facebook.net` / `*.facebook.com` (Meta SDK + ES popup), `checkout.razorpay.com` / `api.razorpay.com`, `wss://<host>`, `blob:` for audio, `media-src` for recordings; `X-Content-Type-Options`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: microphone=(self)`; `robots.txt` = `Disallow: /` + `X-Robots-Tag: noindex` on staging (legal pages stay reachable by URL).
- **TLS:** certbot (HTTP-01), auto-renew timer + `nginx -s reload` hook; SSL Labs A.
- **Mail DNS:** SPF, DKIM (from the SMTP provider), DMARC `p=none` → `quarantine` later; `MAIL_FROM` on the verified domain.
- **Backups:** nightly `mongodump --archive --gzip` (with `--oplog`) + uploads `tar` → encrypted (age / gpg) → off-server (S3 bucket with versioning + lifecycle 30 days, or the owner's choice §7 #8); keep 7 daily + 4 weekly; a monthly **restore drill** into a throwaway compose project; backup job alerts on failure.
- **Monitoring:** uptime checks (every 1 min) on `/api/v1/health` and the SPA from an external service (UptimeRobot / Better Stack — §7 #9) → e-mail + WhatsApp / SMS alerts; disk > 80 %, memory, container restarts, certificate expiry < 14 days, backup age > 26 h, `/ready` failing — via a small cron script that e-mails the team (no new SaaS needed); log retention 14 days.

---

## 2. Tasks ka overview

| #           | Task                                                                                                                                                              | Repo          | Size | Depends      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ---- | ------------ |
| T13.1       | Meta 2026 changes: Embedded Signup v4, Graph v26.0, account-model audit (`waac_id`), webhook fields, calling subscription check; fake + fixtures                  | both          | M    | —            |
| T13.2       | Legal + public pages: privacy, terms, data deletion instructions, contact, footer links, app icon set, `VITE_LEGAL_*`                                             | FE (+BE docs) | M    | —            |
| T13.3       | Deploy artifacts: Dockerfile, `.dockerignore`, compose for staging, nginx config, env template, health `version` / `commit`, graceful drain check                 | both          | M    | —            |
| T13.4       | Ops tooling: `staging:demo` seed, backup / restore scripts, smoke script, GitHub Actions deploy + rollback, local production rehearsal                            | both          | M    | T13.3        |
| P13-B1-DONE | checkpoint: whole verify + E2E twice locally; the production compose stack boots locally with real test keys behind a tunnel                                      |               |      |              |
| T13.5       | Staging server: provision, harden, firewall + UDP range, Docker, nginx, TLS, DNS, mail DNS, backup target, monitors                                               | ops           | M    | T13.3, §7    |
| T13.6       | First deploy + services live: env file, deploy via Actions, migrations, superadmin, demo seed, Razorpay test webhook, SMTP, OpenAI, backup + restore drill        | ops           | M    | T13.4, T13.5 |
| T13.7       | Real Meta app: business verification, app + products, ES v4 config, domains, webhooks + fields, callbacks, basic settings, roles / test users, §11 smoke          | ops           | M    | T13.2, T13.6 |
| P13-B2-DONE | checkpoint: staging live with the real Meta app (Development mode), the platform's test number connected, webhooks verified                                       |               |      |              |
| T13.8       | Real checks: §12 re-check, §13 inbox, §14 templates + reconciliation, §15 calling (latency), staging log grep; bugs → `fix(...)` + redeploy                       | both          | L    | P13-B2       |
| T13.9       | App Review pack: permissions, texts, screencast scripts + recordings, reviewer instructions, demo account ready, pre-submit checklist (`docs/meta/APP_REVIEW.md`) | docs          | M    | T13.8        |
| T13.10      | Submit + follow-up: Live mode, Tech Provider steps, submit, answer / resubmit loop, approval → client's real number via ES, rate cards, billing mode              | ops           | M*   | T13.9        |
| T13.11      | Gap audit, docs (runbook, ADR 0025 + 0042, setup guides, READMEs, CHANGELOGs, BUILD_PLAN_V2), sign-off                                                            | both          | M    | all          |
| P13-B3-DONE | checkpoint                                                                                                                                                        |               |      |              |

\* T13.10's duration depends on Meta (review ≈ 24 h on average; business verification 2–5 business days; each resubmission adds days).

---

## 3. Tasks — step by step

### T13.1 — Meta 2026 changes (code)

1. Re-read on the day and record differences in the changelog: ES versions + v4 / v5 pages, ES implementation (session logging, message events), coexistence onboarding, Graph v26.0 changelog (WhatsApp-related), account model evolution, calling overview + call settings, webhooks field list, App Review page, Tech Provider page, data privacy page.
2. **Frontend ES:** `loginOptions` → v4 (`extras: {}`; the coexistence path per the docs of that day); `parseSessionMessage` accepts the new `version` values and all finish / cancel / error events; unit tests with the v4 / v5 sample payloads (copied from Meta's docs into fixtures) + the old v3 payload (backward compatible while Meta still sends it).
3. **Backend ES finish:** `POST /whatsapp/signup` keeps code-first exchange; accepts missing `phoneNumberId` (WABA-only) as before; stores `waac_id` when present (new optional field on the channel, migration `0014` additive, never required); `subscribed_apps` + `register` + PIN unchanged; tests with v4 fixtures.
4. **Graph v26.0:** default `META_GRAPH_VERSION=v26.0` (env, `.env.example`, setup guide §7); fixtures re-checked per endpoint (schemas in `src/core/meta/schemas.ts` / `call-schemas.ts`); the stub-server tests pass; note any removed / renamed field.
5. **Account-model audit:** a table in ADR 0037 (update) listing each stored / used `wabaId` and which account Meta means; no behaviour change unless the docs require it.
6. **Webhook fields:** compare `WEBHOOK_FIELDS` with the dashboard list; add new relevant fields (ignored safely by the receiver if unused) and update setup guide §5.
7. Fake Meta + E2E: the fake ES dialog emits v4-shaped events; Phase 9 E2E specs stay green.
8. Commit: `feat(whatsapp): move embedded signup to v4 and graph api v26 [P13-T13.1]` (+ separate `fix(...)` commits for any real bug found).

### T13.2 — Legal + public pages

1. Routes `/privacy`, `/terms`, `/contact`; `/data-deletion` gets an instructions section (how to request deletion in the app, by e-mail, via Facebook settings → the callback) above the status lookup.
2. Markdown content in `src/content/legal/` (privacy, terms) with `{{companyName}}`-style placeholders filled from `VITE_LEGAL_COMPANY`, `VITE_LEGAL_ADDRESS`, `VITE_LEGAL_EMAIL`, `VITE_LEGAL_GRIEVANCE_OFFICER` (public values only); rendered with a tiny safe renderer (headings, paragraphs, lists, links — no HTML); `Last updated` from front matter.
3. Footer links (Privacy · Terms · Contact · Data deletion) on sign-in, sign-up, forgot-password and inside the app shell (settings / help menu); the sign-up form says "By creating an account you agree to the Terms and the Privacy Policy" with links.
4. App icon set: `public/icon-1024.png` (Meta), `icon-512.png`, `icon-192.png`, `favicon.svg` / `.ico`; `manifest.webmanifest` name + icons.
5. Tests: routes render without login, links present on auth pages, placeholders filled, no raw HTML rendered, mobile layout; Playwright public-pages spec (no login, 200, titles).
6. Backend: `docs/compliance/compliance-notes.md` §13 (what the policy says vs what the product does — every claim traced to a setting / retention value); privacy text reviewed against Phase 9–12 data flows.
7. Commit: `feat(legal): add privacy policy, terms and contact pages [P13-T13.2]`.

### T13.3 — Deploy artifacts

1. `Dockerfile` (backend): stages `deps` (npm ci) → `build` (tsc) → `runtime` (Node 24 slim, `npm ci --omit=dev`, `dist/`, `assets/`, `docs/samples/audio` only if used at runtime, `USER node`, `EXPOSE 5100`, `HEALTHCHECK`); build arg `GIT_SHA`; image scan (Docker Scout / Trivy) in CI — no high CVEs in our layers.
2. `.dockerignore`: `.env*`, `node_modules`, `dist`, `coverage`, `tests`, `uploads`, `.git`, `poc`, docs except what runtime needs.
3. `deploy/staging/compose.yaml`: `api`, `worker`, `mongo` (auth, keyfile for the replica set, volume, `--bind_ip` compose network only), `redis` (`requirepass`, AOF, volume), healthchecks, `restart: unless-stopped`, `stop_grace_period: 60s` for `api`, UDP port range published for `api`, resource limits (memory), json-file log limits; **no Mailpit**.
4. `deploy/staging/nginx/cell-ai-voicebot.conf` (§1g) + `deploy/staging/env.example` (every variable with comments, no values for secrets) + `deploy/staging/README.md` (what each file is).
5. `/api/v1/health` returns `version`, `commit`, `builtAt` (tests; OpenAPI + `gen:api`).
6. Verify graceful shutdown in containers: SIGTERM → `/ready` 503 → live calls drained within the grace → exit 0 (integration test exists; add a compose-level manual check to T13.6).
7. CI: build the image on every PR (no push), `hadolint`, `nginx -t` on the config in a container, `docker compose config` validation.
8. Commit: `build: add docker image, staging compose and nginx config [P13-T13.3]` (+ `feat(health): show the deployed version`).

### T13.4 — Ops tooling

1. `scripts/staging-demo.ts` + `npm run staging:demo` (§1e), with a test (idempotent, refuses without the confirm env, never prints the password, no fake Meta writes).
2. `deploy/staging/scripts/backup.sh` (mongodump + uploads → encrypt → upload → prune) and `restore.sh` (into a named throwaway project, then checks counts); `deploy/staging/scripts/healthwatch.sh` (disk / memory / restarts / cert expiry / backup age → e-mail); systemd timers or cron files.
3. `scripts/smoke.ts` + `npm run smoke` (§1f) with unit tests against a local server.
4. `.github/workflows/deploy-staging.yml` (backend) + frontend artifact job; `deploy/staging/scripts/deploy.sh` (pull, migrate, sync indexes, up, wait ready, smoke, record release, rollback on failure); docs of required GitHub secrets (`STAGING_SSH_KEY`, `STAGING_HOST`, `STAGING_KNOWN_HOSTS`, registry token) — names only.
5. **Local production rehearsal:** the staging compose stack on the laptop under a new compose project name (never the dev `cav-*` containers), `NODE_ENV=production`, real **test** keys (Razorpay test, OpenAI with a capped key, a separate **dev Meta app** + `cloudflared` tunnel per setup guide §10, SMTP sandbox), `staging:demo`, smoke, deploy + rollback rehearsal with two image tags, backup + restore drill.
6. Commit: `feat(ops): add staging deploy, smoke, demo seed and backups [P13-T13.4]`.

### P13-B1-DONE — checkpoint

Both repos: lint, format, typecheck, build, `openapi:check` / `gen:api` no diff, coverage (gates kept), actionlint, gitleaks, Playwright whole suite twice; the rehearsal report (boot time, image size, deploy time, rollback time, backup size, restore time). Commit `docs: mark phase 13 batch 1 complete [P13-B1-DONE]`.

### T13.5 — Staging server

1. Create the server (§1a, §7 #1) + Elastic IP; tag `project=cell-ai-voicebot`, `env=staging`.
2. OS hardening (§1g); `cav` user; Docker; nginx; certbot; chrony; swap; unattended upgrades; fail2ban.
3. Security group / firewall (§1g) — verify from outside: `nmap` of the public IP shows only 22 (team IP), 80, 443 open on TCP; a UDP probe reaches the media range.
4. DNS: `A` record for the app host → Elastic IP (TTL 300 during review); CAA record for Let's Encrypt; mail records (SPF / DKIM / DMARC) for the sender domain.
5. TLS cert + nginx config deployed; SSL Labs A; HSTS on.
6. Backup target (bucket / remote) with versioning + lifecycle; credentials scoped to put / list / get on that bucket only.
7. Uptime monitors + alert contacts.
8. Record in `docs/ops/staging.md`: host, sizes, OS, ports, paths, who has access (names only), monitors, backup location — no secrets, no IP of other projects.

### T13.6 — First deploy + services live

1. Server env file `/srv/cell-ai-voicebot/env/backend.env` (600) from the password manager: fresh `JWT_*`, `ENCRYPTION_KEY` (32 bytes base64), Mongo / Redis passwords, OpenAI (separate project key + monthly spend cap), Razorpay **test** key + secret + webhook secret, SMTP, billing seller details (§7 #10), `WA_MEDIA_PUBLIC_IP`, Meta values (T13.7 fills them; until then `WHATSAPP_ENABLED=false`).
2. Deploy through GitHub Actions (first run with the required reviewer) → migrations → indexes → `/ready` green → smoke green.
3. `superadmin:create` (password manager) → sign-in; `staging:demo` → demo account ready.
4. **Razorpay test mode** (setup guide razorpay §3–§4): webhook to `https://<host>/api/v1/webhooks/razorpay` (events as in the guide §3), a test top-up end to end → GST invoice PDF + e-mail.
5. **SMTP:** `npm run email:test` in the container; sign-up verification e-mail arrives (inbox, not spam) — SPF / DKIM pass in the headers.
6. **OpenAI** (setup guide openai §3): the agent playground answers, a browser test call with the Loan recovery flow runs (real Realtime voice), data retention settings as in §2 of the guide.
7. Backup ran once manually + restore drill; healthwatch e-mail test; uptime alert test (stop the api container for 2 min in a quiet window).
8. Graceful drain check: start a browser test call, deploy the same sha again → the call ends cleanly with `server_shutdown` after the grace, the app comes back, no errors.
9. Log check: container logs contain no secrets / tokens / e-mails in clear / phone numbers.

### T13.7 — Real Meta app

1. Business portfolio (§7 #3) → **business verification** (Security Center: legal name, address, phone, website on the app domain, documents; domain verification via DNS TXT or meta-tag) — start on day 1 of the phase (2–5 business days).
2. Create the app (type Business, WhatsApp use case) connected to that portfolio; products **WhatsApp** + **Facebook Login for Business**.
3. **App settings → Basic:** display name, contact e-mail, privacy URL (`/privacy`), terms URL (`/terms`), data deletion instructions URL (`/data-deletion`) / callback, app icon 1024, category (Business and pages / Messaging — the closest on that day), app domains = the app host.
4. **Facebook Login for Business:** allowed JS SDK domains, "Login with the JavaScript SDK" on, deauthorize + data deletion callback URLs (setup guide §6); **ES v4 configuration** (products: Cloud API, + Business app onboarding) → `META_ES_CONFIG_ID`; "Check a launch config" result saved in the T13.7 notes.
5. **Webhooks:** callback `https://<host>/api/v1/webhooks/meta`, verify token (≥ 24 chars, new) → **Verified**; subscribe every `WEBHOOK_FIELDS` field; test events from the dashboard reach Admin → WhatsApp (last event).
6. Env on the server (setup guide §7) incl. `META_GRAPH_VERSION=v26.0`; `WHATSAPP_ENABLED=true`; redeploy; Admin → WhatsApp shows provider `meta`, every flag ✓.
7. App roles: the team as admins / developers; reviewers' test users if Meta asks; the platform's own test WABA + the Meta **public test number** (calling off by default — enable call settings for §15) + one real SIM number for the platform (§7 #13).
8. Setup guide §11 smoke (8 items) on staging.
9. Notes in `docs/ops/meta-app.md`: app id (public), configuration id (public), which settings are where, who has which role (names), dates — no secrets.

### P13-B2-DONE — checkpoint

Staging live (HTTPS, monitors, backups) with the real Meta app in Development mode, ES v4 connected the platform's test number (Connected card with quality, limit, billing line), webhooks verified and flowing. Commit `docs: mark phase 13 batch 2 complete [P13-B2-DONE]`.

### T13.8 — Real checks (two phones: Android + iPhone; Chrome, Firefox, Safari)

1. **§12 re-check** (Graph version, ES events, coexistence sync window, credit sharing method, error codes, Phase 10 payloads, media hosts, voice flag, block API, profile fields).
2. **§13 inbox** — all 10 items (every inbound and outbound type, ticks, voice notes in 3 browsers, invalid number, 24 h window + 409, STOP / BAND KARO / बंद करो / START, reactions / quotes / deletes, block / profile, coexistence number with echoes + history, typing indicator, log check).
3. **§14 templates + charges** — all 9 items (create → approved by webhook, rejected with reason + bell / e-mail, send outside the window → one charge at the previewed price, **next day reconciliation ≤ 2 %**, free service reply released, pause / quality, call permission template approved, customer stops marketing → refused / utility allowed, log check). Import Meta's official INR messaging rate card first (owner input).
4. **§15 calling** — all 9 items on the public test number / sandbox (or a number with limit ≥ 2,000): permission request in / outside the window, agent BIC call (two-way audio, hold, keys, hang up both sides), AI BIC call with a key press, UIC team ring (first Accept wins, missed → bubble + bell), UIC AI → team handoff, recording with both sides, **mouth-to-ear latency both directions (target < 400 ms) + RTT**, Meta Insights duration vs our pulses (± 1 pulse), log check. Import the official INR calling rate card first (owner input).
5. Coexistence: onboard a Business app number → contacts + history sync started within minutes (the 24 h rule), calling shown unavailable.
6. Data deletion callback: trigger from Facebook settings (remove the app) → signed request verified, status page shows the code; deauthorize callback recorded.
7. **Staging log grep** for each session (SDP lines, `+91` / digits, names, texts, tokens, `EAAG`, passwords) → 0 hits.
8. Every bug: regression test first → `fix(...)` commit → redeploy → re-run the item. Results table (item, date, phone / browser, result, note) goes into the sign-off.

### T13.9 — App Review pack (`docs/meta/APP_REVIEW.md`)

1. **Permissions:** `whatsapp_business_management`, `whatsapp_business_messaging` (+ `business_management` only if the ES config requires it). Nothing else.
2. **Use-case texts** (English, product-specific, ≤ the form's limit), e.g. management: "Cell AI lets lenders and other businesses connect their own WhatsApp Business account through Embedded Signup. We use whatsapp_business_management to read the connected phone numbers and their status, subscribe our app to the account's webhooks, and create, edit, sync and delete the business's message templates (for example payment reminders and the call permission request) from our dashboard. We only access accounts that the business connected and only to provide these features to that business."; messaging: "... send and receive WhatsApp messages from a shared team inbox (text, media, interactive messages, templates outside the 24-hour window), mark messages as read, manage the business profile, register the number, and place and receive WhatsApp voice calls (business-initiated calls only after the customer grants call permission) answered by team members in the browser or by the business's AI voice agent ..." — final texts reviewed in T13.9.
3. **Screencasts** (one per permission, continuous, English UI, captions on screen for every step, no audio needed, ≤ the size limit, 1080p, cursor visible, no secrets / real customer data / other tabs):
   - **Management video:** sign in to staging → WhatsApp → Templates → create a utility template (variables, sample values) → submit → status "In review" → Meta approves → "Approved" in the list; (optionally) show the template in WhatsApp Manager. If ES must be shown too: Connect WhatsApp → Meta consent screen with the permissions → Connected card.
   - **Messaging video:** inbox → open the test customer chat → send a text + the approved template → the **WhatsApp app on the phone** (screen mirrored next to the browser) shows them → the customer replies → the reply appears live in the inbox; second file (if the form allows several) or appendix: call permission request → Allow on the phone → Call from the browser → the phone rings and answers.
   - **business_management video** (only if requested): the ES step where the business portfolio is selected.
4. **Reviewer instructions:** URL, demo credentials (from the password manager, entered into the form only), "Facebook Login for Business is integrated: yes", step-by-step per permission, where the demo data is, that the demo account already has a connected test number and approved templates, the test phone number the reviewer can message, support e-mail.
5. **Pre-submit checklist** (all ✓ before submit): business verified; app basic settings complete (icon, privacy, terms, data deletion, category, contact); ES configuration lists exactly the requested permissions; code's OAuth / ES config matches; demo account works from a fresh browser; privacy + terms reachable without login; webhooks verified; videos match the text of each permission; nothing in draft; Data Use Checkup / Data Protection Assessment answered if shown.
6. Record the videos (store outside git — shared drive), write the texts into the form, keep a copy of the submitted texts in `docs/meta/APP_REVIEW.md` (no credentials).

### T13.10 — Submit, follow up, approve, real client number

1. App Review → Permissions and Features → **Request advanced access** for each permission → attach video + text → **Submit** (not draft).
2. Track daily; answer reviewer questions within 24 h; on rejection: read the reason, map it to the checklist, fix (text / video / product), log it in the pack's "Rejections" table, resubmit.
3. After approval: app **Live**; Tech Provider steps of that day (dashboard → WhatsApp → Quickstart → Tech Provider onboarding); confirm the permissions now appear in the ES consent screen for a non-role user.
4. **Client's real number** (§7 #14): the client's business signs in to staging (or production later) → Connect WhatsApp → ES v4 → Connected → payment method added in WhatsApp Manager (customer pays Meta) → a test message both ways; display name approved; messaging limit noted (calling needs ≥ 2,000).
5. Superadmin: import the official INR messaging + calling rate cards; set the account's Meta billing mode ("customer pays") before the client connects.
6. Record dates, reviewer messages (no personal data) and the final approval screenshot in the sign-off.

### T13.11 — Gap audit, docs, sign-off

1. Requirement → evidence table (every §0 item, every task, every §7 decision).
2. Security checklist: TLS / headers report, open ports scan, secrets locations (only env file + password manager + GitHub environment), image scan, log grep results, backup + restore evidence, access list.
3. Docs: `docs/ops/staging.md` (runbook: deploy, rollback, migrations, backups, restore, rotate secrets, renew certs, incident steps, contacts), `docs/ops/meta-app.md`, `docs/meta/APP_REVIEW.md`, ADR 0025 **accepted** (Docker Compose), ADR **0042** (staging topology + deploy pipeline), setup guides updated (meta-whatsapp §3 v4, §7 v26, §15 real results; razorpay; openai), compliance notes §13, READMEs (deploy section), CHANGELOGs, BUILD_PLAN_V2 (Phase 13 ✅, next Phase 14), PHASE_13_TASKS all `[x]`, plan changelog.
4. `PHASE_13_SIGNOFF.md` (same structure as Phase 12): tasks + evidence, deliverables, requirement → evidence, numbers (tests, coverage, image size, deploy / rollback time, boot time, backup size / restore time, page load on 4G, call latency + RTT), checklists results, security, deviations, bugs, verification, TODOs by phase, owner inputs, go / no-go for Phase 14.
5. Commits: backend `docs: add phase 13 sign-off and docs [P13-T13.11]`, frontend docs commit, then `docs: mark phase 13 complete [P13-B3-DONE]`.

---

## 4. Deliverables checklist

- [ ] ES v4 + Graph v26.0 + account-model audit + webhook fields re-check (code, fake, fixtures, tests).
- [ ] Privacy policy, terms, contact, data deletion instructions, footer links, app icon set.
- [ ] Dockerfile, staging compose, nginx config, env template, health version, CI image build + scan.
- [ ] Demo seed, smoke, backup / restore, healthwatch, GitHub Actions deploy + rollback.
- [ ] Staging server hardened, TLS A, HSTS, firewall incl. UDP media range, DNS + mail DNS, monitors, backups + restore drill.
- [ ] Production-mode services live: Razorpay test, SMTP, OpenAI, WhatsApp (real Meta).
- [ ] Real Meta app complete (verification, settings, ES v4, webhooks, callbacks, roles).
- [ ] Real checks §12 / §13 / §14 / §15 passed and recorded; staging logs clean.
- [ ] App Review pack + videos; submitted; Advanced Access approved; app Live; Tech Provider steps.
- [ ] Client's real number connected via ES.
- [ ] Docs: runbook, ADR 0025 / 0042, setup guides, compliance §13, READMEs, CHANGELOGs, sign-off.

## 5. Risks

| Risk                                                                        | Mitigation                                                                                                                                  |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Business verification slow / refused (documents, domain)                    | start on day 1 of the phase; the legal entity's GST / incorporation documents ready; website on the app domain with matching name / address |
| App Review rejected (wrong text, video not aligned, extra permission)       | per-permission texts + videos exactly as Meta asks; request only 2 permissions; pre-submit checklist; AutoChatix lessons; resubmit loop     |
| ES v4 behaves differently from v3 (events, coexistence)                     | T13.1 with Meta's v4 samples; "Check a launch config"; test with a role user before review                                                  |
| Graph v26.0 field changes break parsing                                     | per-endpoint re-check + schema tests; `META_GRAPH_VERSION` env lets us pin back to v23.0 quickly                                            |
| Messaging limit < 2,000 blocks the calling checks                           | Meta public test number / sandbox (relaxed, no 2,000 rule); real-number calling later when the limit grows                                  |
| UDP media blocked (security group, NAT, ISP)                                | open the range in the security group; `WA_MEDIA_PUBLIC_IP`; probe from outside; TURN env reserved                                           |
| Calls dropped on every deploy                                               | deploy windows announced; SIGTERM drain + `stop_grace_period`; Phase 17 adds blue / green                                                   |
| Production-mode staging needs real keys (OpenAI cost, SMTP reputation)      | separate OpenAI project with a spend cap; SMTP with SPF / DKIM / DMARC; Razorpay stays in test mode                                         |
| Secrets leak in CI / images / videos                                        | env only on the server, GitHub environment secrets, `.dockerignore`, gitleaks, image scan, videos reviewed before upload                    |
| Data loss on the single server                                              | nightly encrypted off-server backups, restore drill, uploads included                                                                       |
| Staging indexed / abused (open sign-up)                                     | noindex + robots, auth rate limits, e-mail verification, monitoring of sign-ups                                                             |
| Meta changes rules again during review (2026 saw ES v4 / v5, account model) | re-check pages at the start of T13.1, T13.7 and T13.9; changelog entries                                                                    |
| Domain not available from the client in time                                | ask on day 1 (§7 #2); fallback = our own domain for staging only (then the Meta app URLs change in Phase 17 → extra review risk)            |
| Client legal approval of privacy / terms delayed                            | our draft from product facts on day 1; publish "draft" only after approval; review needs the final URLs live                                |

## 6. Recommended order

Day 1: send §7 questions; start business verification; T13.1 + T13.2 + T13.3 in parallel → T13.4 → P13-B1 → T13.5 (as soon as the server + domain exist) → T13.6 → T13.7 → P13-B2 → T13.8 → T13.9 → T13.10 (waits on Meta) → T13.11 → P13-B3. Owner inputs gate T13.5 (server, domain), T13.7 (business documents), T13.8 (rate cards, phones), T13.10 (client number).

## 7. Decisions and open questions (owner — defaults apply if not answered)

| #   | Question                                                                                     | Default (used if no answer)                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Staging server: a new separate server (whose AWS account?) or the client's existing EC2?     | New separate EC2 `t3.xlarge` (or `m6a.xlarge`) in `ap-south-1` in the **client's** AWS account; the existing EC2 stays untouched until Phase 17 |
| 2   | Hostname for the app (Meta app domain, privacy URL)?                                         | The final production host (e.g. `app.<client-domain>`) pointed at staging now; DNS moves in Phase 17                                            |
| 3   | Whose Meta Business portfolio owns the app / is the Tech Provider (legal entity, documents)? | The client's company (it sells the product); we get admin / developer roles                                                                     |
| 4   | Who pays Meta at launch?                                                                     | "Customer pays Meta" for every account (Tech Provider can't share credit lines); Solution Partner later if wanted                               |
| 5   | Staging in production mode with real OpenAI / Razorpay test / real SMTP?                     | Yes (`NODE_ENV=production`), Razorpay in **test** mode, OpenAI key with a monthly cap (₹ to confirm)                                            |
| 6   | SMTP provider + sender domain?                                                               | Amazon SES (ap-south-1) on the client's domain, `no-reply@<domain>`                                                                             |
| 7   | File storage on staging?                                                                     | Local volume + nightly off-server backup (S3 in Phase 17)                                                                                       |
| 8   | Backup target?                                                                               | Private S3 bucket (versioning, 30-day lifecycle) in the same AWS account, encrypted archives                                                    |
| 9   | Uptime / alert tool and who gets alerts?                                                     | UptimeRobot (free) + e-mail to the project lead; WhatsApp / SMS alerts later                                                                    |
| 10  | GST seller details for staging invoices?                                                     | The client's real seller name / address / GSTIN, invoice prefix `STG` (test payments only)                                                      |
| 11  | Who writes / approves privacy policy + terms; grievance officer name + contact?              | We draft from the product facts; the client's legal team approves; grievance officer = client's nominee                                         |
| 12  | App icon / logo + app display name?                                                          | "Cell AI" with the current logo; owner approves the 1024 icon                                                                                   |
| 13  | Test phones + numbers for the real checks?                                                   | 2 phones (Android + iPhone) with WhatsApp; the Meta public test number + one new SIM for the platform's test WABA                               |
| 14  | Client's real WhatsApp number (Cloud API or Business app?) and who operates the ES flow?     | A Cloud API number (calling needs it), the client's admin runs ES with us on a call                                                             |
| 15  | Deploy trigger: manual only or also on every push to `main`?                                 | Manual (`workflow_dispatch`) with the required reviewer during Phase 13                                                                         |
| 16  | Merge Phase 12 into `main` before the first staging deploy?                                  | Yes — project lead reviews and merges Phases 12 (and 13 batch 1) before T13.6; staging deploys `main` only                                      |
| 17  | Open sign-up on staging?                                                                     | On (reviewers may sign up), with rate limits + e-mail verification + noindex                                                                    |
| 18  | Calling in the App Review videos?                                                            | Mentioned in the messaging text + a short extra clip only if the form allows; the required messaging video stays message-only                   |

**Answered by the owner / project lead on 26 Oct 2026:** frontend + backend run on **one machine** (confirms §1a); **#16** Phase 12 is merged into `main` in both repos (fast-forward), so Phase 13 branches start from `main`. Every other question: defaults in use until answered.

## Changelog

- 2026-10-26: plan drafted after Phase 12 sign-off; Meta pages re-checked the same day (App Review, Tech Provider, ES versions / v4 / coexistence, account model evolution, calling overview, Graph v26.0) — findings in §1d; forced code changes in §1b.
- 2026-10-26 (STEP 0): defaults in use for §7 #1–#18 except the one-machine answer and #16 (Phase 12 merged). Run prompt prepared — refinements locked: deploy from the Mac over SSH with server-side image builds (GitHub Actions after push / merge); host networking for `api` / `worker` + a new `HOST` env (API on loopback); production rehearsal on the Mac without real keys; ES v4 literals (`extras: {}`); Graph v26.0; migration 0014 (`wabaKind`, `waacId`); health `version` / `commit` / `builtAt`; legal content + `VITE_LEGAL_*`; demo seed env; server layout; nginx + CSP literals; smoke list; backups (the prompt's §1 wins where this plan differs).
- 2026-10-26 (P13-B1-DONE): Batch 1 complete — T13.1 Embedded Signup v4 (Cloud API `extras: {}`, coexistence keeps the Business app feature; v4 / v5 session events incl. `FINISH_OBO_MIGRATION`, `FINISH_GRANT_ONLY_API_ACCESS`, `CANCEL` with `error_message`), Graph v26.0, migration 0014 (`wabaKind`, `waacId`), `account_review_update` / `account_alerts` webhook fields, account-model audit in ADR 0037; T13.2 privacy / terms / contact / data deletion pages, icons, manifest, legal E2E spec; T13.3 Dockerfile (+ compiled ops tools), staging compose, nginx + CSP, env templates, health build info, `HOST`, CI image + infra lint; T13.4 demo seed, smoke, deploy / rollback / status / backup / restore / healthwatch / tools, Mac wrapper, Actions workflow, ADR 0042, runbook. Deviations: health and readiness are also served under `/api/v1` (nginx blocks both readiness paths from the internet — fix `dcc6ce7`); mongo / redis run on the compose bridge published on 127.0.0.1 (the API / worker keep host networking); the frontend is built on the server in a Node container from the archive (`scripts/build-web.sh`); `email:test` runs in production only with `--production`; the backup / restore drill was not re-run on the Mac (no `age` binary allowed) and runs on staging in T13.6. Bugs fixed with regression tests: open WebSockets blocked the HTTP drain on SIGTERM (`a211911`), readiness reachable from the internet (`dcc6ce7`); the API stopped answering on IPv6 once `HOST` defaulted to 0.0.0.0, so `localhost` (::1) calls to its own mock API failed — found by the E2E run (`c914c19`; `HOST` is optional again); frontend: Meta's automatic app event logging (`565d1da`), links that normalise outside the app (`89e99b3`). Rehearsal numbers in the runbook (first deploy 180 s, next 39 s, automatic rollback on a failing release, manual rollback 2–3 s, drain 1.2 s, image 611 MB / ≈ 110 MB compressed). Backend 3195 tests (96.09 / 87.68 / 95.78 / 97.66), frontend 1329 (96.14 / 91.92 / 93.79 / 96.93), Playwright 151 green twice, bundle +0.8 KB as one stream.
