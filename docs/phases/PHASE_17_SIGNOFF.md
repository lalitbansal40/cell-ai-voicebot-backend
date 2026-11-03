# Phase 17 — Sign-off

**Date:** 2026-11-03 · **Branch:** `feature/phase-17-production` (both repos, not merged) · **Plan:** [PHASE_17_PLAN.md](PHASE_17_PLAN.md) · **Prompt:** [PHASE_17_PROMPT.md](../prompts/PHASE_17_PROMPT.md)

**Verdict:** the production **kit is built and rehearsed on the Mac**, but **nothing has run on a server.** There was no SSH access to production, no staging server, no S3 bucket, no backup key, no UptimeRobot account and no alert contacts (prompt §0 inputs: none present). So the Done-when items that need a server are open, with owners in §8. Nothing was deployed and the live site was not changed.

## 1. Tasks

| Task   | Done here                                                                                                                           | Waits for a server / owner                                      |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| T17.1  | Outside-in audit of `wa.notifynow.in`; audit script extended and pointed at the production host                                     | Running the server audit                                        |
| T17.2  | ADR 0049 (isolation, ports, limits, releases, call wait, backups, watching)                                                         | Ports confirmed by the audit                                    |
| T17.3  | —                                                                                                                                   | A staging server                                                |
| T17.4  | `deploy/production` kit, `release.sh`, build identity on API and SPA, call wait; Mac rehearsal passed                               | First release on a server                                       |
| T17.5  | `sync-client-repo.sh` (stops on client edits and secrets), build CI for the client repo; Phase 16 tagged `release-20261102-96cc375` | —                                                               |
| T17.6  | `storage:migrate-to-s3` (verified, resumable), backups record their result, `ops-record`                                            | S3 bucket, age key, first backup, timed restore drill           |
| T17.7  | Checks listed in the audit                                                                                                          | Server access to MongoDB and Redis                              |
| T17.8  | Admin → System page, healthwatch checks for MongoDB primary, queues and failed jobs                                                 | UptimeRobot, alert e-mails, testing each alert                  |
| T17.9  | —                                                                                                                                   | A production-sized staging server                               |
| T17.10 | Redis wallet lock across processes; `ai-call` flake fixed; E2E backend output always kept                                           | Messages p95 target on the real server                          |
| T17.11 | CSP report endpoint and report-uri, production nginx checked in CI, host hardening guide                                            | Applying headers and CSP live, secrets, 2FA, Razorpay, mail DNS |
| T17.12 | —                                                                                                                                   | Server access and a window                                      |
| T17.13 | Incident runbook                                                                                                                    | On-call names, game day on staging                              |
| T17.14 | App Review status and post-approval steps written down                                                                              | Meta's result                                                   |
| T17.15 | This sign-off, docs                                                                                                                 | —                                                               |

## 2. Done-when (plan §0)

| Item                                                    | Status                                                   |
| ------------------------------------------------------- | -------------------------------------------------------- |
| `PRODUCTION_AUDIT.md` from a read-only server audit     | **Partly:** outside-in only                              |
| `/health` shows the real commit on every address        | **Open:** kit does it; live still `unknown`              |
| One-command release, rollback under 5 min on the server | **Rehearsed on the Mac** (rollback 4 s); not on a server |
| Nightly encrypted backups + timed restore drill         | **Open**                                                 |
| Uptime monitor + healthwatch, each alert tested         | **Open**                                                 |
| `check:headers` with CSP enforced; old A record gone    | Old A record gone (U1 closed); headers **open**          |
| Phase 16 in production, Razorpay top-up works           | **Open**                                                 |
| Capacity on the production-sized server                 | **Open**; Mac numbers in `capacity.md`                   |
| Full verify + Playwright                                | See §3 (Playwright once, by owner request)               |

## 3. Numbers

|                                                     | Before Phase 17              | After                                          |
| --------------------------------------------------- | ---------------------------- | ---------------------------------------------- |
| Backend tests                                       | 3,755 (+1 skipped)           | 3,790 (+1 skipped)                             |
| Backend coverage (stmts / branches / funcs / lines) | 96.09 / 87.42 / 95.67 / 97.6 | 96.06 / 87.38 / 95.6 / 97.58                   |
| Frontend tests                                      | 1,467                        | 1,471 (coverage 96.12 / 92.33 / 93.66 / 96.81) |
| Playwright                                          | 169                          | 169 passed in 36 min, backend log grep clean   |

**Final runs (3 Nov):** backend suite 5 times: runs 1, 3, 4 green; run 2 failed `calls/outbound` (same seed) and `calls-wa/outbound` (rejected / not answered); run 5 failed `realtime/ws` (idle close). All known load flakes, none in Phase 17 code. Frontend build: main chunk 1,089 kB (gzip 321 kB). Playwright ran once instead of twice: the owner asked for fewer repeat runs.

**Mac rehearsal of the kit:** first deploy 48 s, second 66 s, a release that throws at start restored the previous one, `rollback.sh` 4 s.

**Messages load, API and worker as two processes:** p95 7.7–31 s before the Redis wallet lock, 951 ms after; no 500, money exact. Target 500 ms still missed on the Mac, where MongoDB in Docker Desktop is the limit.

## 4. Live site (outside-in, 2 Nov 2026)

One A record (`154.210.160.233`); TLS 1.2 / 1.3, certificate to 13 Dec 2026; database and Redis ports closed from outside; `/ready` public; HSTS twice and no other page headers; no cache headers on the SPA; `commit: unknown`; Razorpay top-up fails with `PROVIDER_ERROR`. Phase 16 is pushed to the client repo (`fb496c3`, tag `release-20261102-96cc375`) and not deployed.

## 5. Deviations

- No server step ran: no inputs (prompt §0). Each is an open item, not a pass.
- `shellcheck` and `age` run as one-off Docker containers; this Mac has no Homebrew.
- The production kit reuses the staging scripts (`deploy/staging/scripts`) instead of a full copy, with production files in `deploy/production`; `release.sh` installs both together.
- CSP violation counts are logged, not shown on the System page.
- `X-Robots-Tag: noindex` kept in the production template (owner may change it).

## 6. Bugs found and fixed

| Commit    | Bug                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------ |
| `5cd4eb4` | With API and worker in separate processes, the in-process wallet queue no longer kept one wallet's transactions in order |
| design    | A release stopped the API while calls were live, ending them with the technical line; releases now wait up to 10 minutes |

## 7. Findings and flakes

- **Product finding (owner: Phase 18):** if a customer hangs up while the AI's turn is still running, the disposition that turn decided is not saved.
- **Open flakes:** `tests/calls/outbound.test.ts` (wrong number) and `tests/db/seed-calls.test.ts`: the simulated customer acts 10–30 ms of real time after the bot at dry-run speed 100, shorter than a loaded machine's AI turn. `calls/flow-call`, `calls-wa/outbound` and `realtime/ws` (idle close) each failed under load.
- **Fixed:** `calls/ai-call` (the test moved the fake clock before the words were written down).

## 8. Open items

| Item                                                                               | Owner                         |
| ---------------------------------------------------------------------------------- | ----------------------------- |
| SSH access (deploy user) to production; run `npm run server:audit -- prod`         | Owner / client admin          |
| A staging server (T17.3, T17.9, game day)                                          | Owner                         |
| S3 bucket + IAM user, `age` key, UptimeRobot, alert e-mails, on-call names         | Owner                         |
| First managed release (Phase 16) with `release.sh`; cut-over from the manual setup | Us + client team, in a window |
| MongoDB replica set and auth, Redis settings on the server                         | Client admin + us             |
| Razorpay: the log line and the right keys; ₹1 live top-up                          | Client + owner                |
| Headers, CSP (7 days report-only, then enforce), secret rotation, superadmin 2FA   | Us + owner                    |
| Host hardening                                                                     | Client admin                  |
| Messages p95 under 500 ms on the real server                                       | Us, Phase 17 follow-up        |
| App Review result, Tech Provider, the client's real number                         | Owner / Meta                  |
| Calling-hours ceiling 08:00–19:00 confirmed                                        | Owner                         |
| Merge the Phase 17 branch to `main`                                                | Owner                         |
