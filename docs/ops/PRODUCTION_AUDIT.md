# Production audit — `wa.notifynow.in`

**Date:** 2026-11-02 · **Method:** public checks from outside only. **The read-only server audit has not run:** there is no SSH access to the production server (`~/.cav-prod/` inputs absent). Every "server" row below says what to check, and how, once access exists (`npm run server:audit -- prod`).

Risk levels: **blocker** (fix before the first managed release, T17.12), **phase** (this phase), **later**.

## 1. Outside-in (done)

| Area           | Value (2 Nov 2026, 09:50 UTC)                                                                                          | Risk                                                                                       | Action                                                              | Task   | Owner        |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ------ | ------------ |
| DNS A          | `154.210.160.233` only (system resolver, 8.8.8.8, 1.1.1.1). The second record `45.114.245.71` is gone                  | None now (U1 closed)                                                                       | Keep `check:headers` in post-deploy checks                          | T17.11 | Client DNS   |
| DNS AAAA / CAA | None                                                                                                                   | later: without CAA any CA can issue                                                        | Add `CAA 0 issue "letsencrypt.org"`                                 | T17.11 | Client DNS   |
| TLS            | Let's Encrypt `YR2`, `CN=wa.notifynow.in`, valid to **13 Dec 2026**; TLS 1.2 and 1.3 accepted, 1.1 refused             | phase: renewal timer not verified                                                          | Check certbot timer + deploy hook on the server                     | T17.1  | Us           |
| HTTP → HTTPS   | `301`                                                                                                                  | None                                                                                       | —                                                                   | —      | —            |
| Open TCP ports | 80, 443 open; 22 closed from here; 5100, 5101, 6379, 6380, 27017, 27018, 3000, 8080 closed                             | None (databases not exposed). SSH is on another port or IP-limited                         | Confirm SSH port in inputs                                          | T17.1  | Client admin |
| Health         | `/api/v1/health` 200, `commit: unknown`, `builtAt: unknown`                                                            | **blocker**: no one knows which code runs (U4)                                             | Build identity                                                      | T17.4  | Us           |
| Readiness      | `/ready` and `/api/v1/ready` answer **200 to the public**                                                              | phase: tells outsiders about dependencies; should be internal                              | Our nginx block returns 404 for `/ready` from outside               | T17.4  | Us           |
| Headers        | HSTS sent **twice** on the API; no `nosniff`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, CSP on pages | phase                                                                                      | nginx block + `HSTS_BY_PROXY=true`                                  | T17.11 | Us + client  |
| OpenAPI        | `/api/v1/openapi.json` lists admin routes                                                                              | phase: fixed in code by Phase 16, not deployed                                             | Release Phase 16                                                    | T17.12 | Us           |
| SPA caching    | `index.html` and hashed assets sent with **no** `Cache-Control`; gzip on                                               | phase: browsers may keep an old `index.html` after a release, or refetch assets every time | nginx: `no-cache` on `index.html`, `immutable` 1 year on `/assets/` | T17.4  | Us           |
| Meta webhook   | `GET /api/v1/webhooks/meta` without token → 403                                                                        | None                                                                                       | —                                                                   | —      | —            |
| WebSocket      | `/ws/events` upgrade over HTTP/1.1 → 101                                                                               | None                                                                                       | —                                                                   | —      | —            |
| Legal pages    | `/privacy` 200                                                                                                         | None                                                                                       | —                                                                   | —      | —            |
| Payments       | Top-up → `PROVIDER_ERROR` (Razorpay refused the order)                                                                 | **blocker** for paying customers (U5)                                                      | Read the `razorpay: request rejected` log line; fix keys / mode     | T17.11 | Client + us  |

## 2. On the server (not run — needs access)

Run `npm run server:audit -- prod` (extended in T17.1: Docker names / volumes, nginx `server_name` lines, certificate dates, MongoDB and Redis answers that need no login, firewall, time, updates, timers). Then fill this table.

| Area                  | What to find                                                           | Why                                                                                  | Default risk until checked |
| --------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------- |
| OS, kernel, resources | Ubuntu version, kernel, CPU, RAM, disk free, inodes, swap              | Sizing, MongoDB version choice, disk alerts                                          | phase                      |
| How our app runs      | Compose / PM2 / plain node, folder, env file names, ports, image dates | Cut-over plan (T17.12) and rollback                                                  | **blocker**                |
| Other apps            | Container / service names only                                         | Ports and memory we must not take                                                    | **blocker**                |
| Ports free for us     | 5100, 5101, 6380, 27018 (else 5200, 5201, 6480, 27118)                 | Our loopback ports                                                                   | **blocker**                |
| MongoDB               | Version, where it runs, replica set, primary, auth on, bind address    | Wallet transactions need a replica set; auth off = anyone on the host reads the data | **blocker**                |
| Redis                 | Version, password, `maxmemory-policy`, AOF                             | BullMQ needs `noeviction`; queue loss on restart without AOF                         | **blocker**                |
| nginx                 | Our site file, other sites' `server_name`, reload method               | Change only our file                                                                 | phase                      |
| Certificate renewal   | certbot timer + deploy hook                                            | Expiry 13 Dec 2026                                                                   | phase                      |
| Firewall              | ufw / security group: 22 (limited), 80, 443, UDP 40000–40999           | WhatsApp calling media                                                               | phase                      |
| Time sync             | NTP synchronized                                                       | TOTP, signed URLs, webhook signatures                                                | phase                      |
| Updates               | unattended-upgrades                                                    | Security patches                                                                     | phase                      |
| Docker logs           | Log driver and rotation                                                | Disk filling                                                                         | phase                      |
| Existing backups      | Timers / cron, target                                                  | Today: assumed none                                                                  | **blocker**                |
| Uploads               | Where recordings and media are stored, size                            | Not backed up if on local disk                                                       | phase                      |

## 3. Staging

No staging server exists (plan §7 #2 input missing). Until one does, staging = the Mac rehearsal (`cav-prod-rehearsal`) plus a restored backup copy (T17.6).

## 4. Gate P blockers (copied to plan §8)

1. SSH access to production (deploy user) and the server audit output.
2. How our app runs today (for the cut-over and its rollback).
3. MongoDB: replica set and auth status.
4. Redis: password and `maxmemory-policy`.
5. Razorpay log line and the right keys.
