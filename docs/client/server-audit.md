# Client Server Audit (T0.19) — READ-ONLY

**Status:** ⚠️ **Blocked — SSH key not available on this machine** (checked 2026-10-08: no `CLIENT_SSH_KEY_PATH` in `.env`, no `~/.ssh/cell-voicebot-client.pem`). The audit tooling is ready; run it as soon as the key is placed.

Server: AWS EC2 `ubuntu@13.232.191.62`, m6a.2xlarge (8 vCPU), 108 GB storage — another application already runs there and **must not be disturbed**.

## How to run (project lead)

1. Save the client key from the password manager to `~/.ssh/cell-voicebot-client.pem` and run `chmod 400 ~/.ssh/cell-voicebot-client.pem` (or set `CLIENT_SSH_KEY_PATH=/path/to/key.pem` in the backend `.env`).
2. `npm run server:audit` → runs [`scripts/server-audit.sh`](../../scripts/server-audit.sh) over SSH and saves the **raw output outside the repo** (`$TMPDIR/cav-server-audit-*.txt`). Never commit the raw output.
3. Fill the sections below from the raw output (summaries only — no secrets, no other application's data).

### What the script does / does not do

- ✅ Read-only allowlist: OS + **kernel**, CPU/RAM/disk, Node/npm/Docker/PM2 presence, container and PM2 **names only**, listening ports (`ss -tuln`), running services, nginx/apache presence + enabled site file names, DB engines present, process names by memory, Asterisk/FreeSWITCH presence.
- ❌ Never: `sudo`, `env`/`printenv`, reading configs/`.env`/logs, `history`, process arguments, `docker inspect/exec/logs`, `pm2 env`, `nginx -T`, any write/install/restart/delete.
- SSH uses `StrictHostKeyChecking=accept-new` → adds the host key to the local `~/.ssh/known_hosts` on first connect (local change only).

## Findings (fill in after running)

| Area                           | Finding                                                                | Why it matters                                                           |
| ------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| OS / **kernel**                | _pending_                                                              | Kernel ≥ 6.19 → MongoDB **8.0 will not start**; we need ≥ 8.2 (ADR 0004) |
| CPU / RAM / disk free          | _pending_                                                              | Capacity for API + Mongo + Redis + Asterisk next to the existing app     |
| Node / npm                     | _pending_                                                              | We ship Node 24 inside containers or need an isolated install            |
| Docker usable by `ubuntu`?     | _pending_                                                              | Decides Docker Compose vs PM2 (ADR 0025)                                 |
| PM2 processes (names)          | _pending_                                                              | Avoid name/port clashes with the existing app                            |
| Ports in use                   | _pending_                                                              | → proposed free ports below                                              |
| nginx / apache                 | _pending_                                                              | Reverse proxy + SSL: add our own server block only                       |
| Databases present              | _pending_                                                              | Client DB type (answers.md #5)                                           |
| Asterisk / FreeSWITCH present? | _pending_                                                              | Is "SIP enabled" on this box or on the provider side?                    |
| Firewall                       | Cannot be checked without `sudo` → ask the client / AWS security group | SIP 5060/5061 + RTP range must be opened for the trunk only              |

### Proposed ports for our stack (adjust to avoid clashes found above)

| Service            | Port                 | Exposure                        |
| ------------------ | -------------------- | ------------------------------- |
| API                | 5100                 | localhost → nginx (443)         |
| Web (static build) | served by nginx      | 443                             |
| MongoDB            | 27018                | localhost only                  |
| Redis              | 6380                 | localhost only                  |
| Asterisk SIP       | 5060/udp (+5061 TLS) | trunk IPs only (security group) |
| Asterisk RTP       | 10000–20000/udp      | trunk IPs only                  |
| ARI                | 8088                 | localhost only                  |

## Risks & recommendations for Phase 12 (initial)

- Do **everything** in our own namespace: separate Linux user / folder, own containers (Docker Compose project `cell-ai-voicebot`) or PM2 namespace, own nginx server block, own database.
- Never restart shared services (nginx reload only after `nginx -t`, coordinated with the client).
- Kernel check decides the MongoDB version; MongoDB 8.2+ either way is safe.
- Ask the client for AWS security-group access (or a contact who applies rules).
