# Production incidents

For `wa.notifynow.in`. Start every incident with `deploy/scripts/status.sh` and Admin → System. Read logs filtered (`--since 30m`, level warn and up); never paste raw logs, they can hold customer data. Tell the owner when a customer is affected for more than 10 minutes.

| Symptom                                | First checks                                                                             | Fix                                                                                                                                             | Verify                                    |
| -------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Site down (UptimeRobot)                | `status.sh`; `curl -s 127.0.0.1:5100/health` on the server; nginx error log for our site | API down: `docker compose -p cav-prod up -d api`. nginx down: the client's admin, `nginx -t` first                                              | Health 200 through nginx on every address |
| `/ready` red, health green             | Admin → System: MongoDB, Redis                                                           | Restart only the failed one of ours (`cav-prod-redis`); the client's MongoDB: the client's admin                                                | `/ready` 200                              |
| MongoDB: no primary                    | System page; MongoDB log for that minute                                                 | Wait 2 minutes (elections); then the client's admin restarts mongod. Seen locally in Phase 16 under memory pressure: check swap and free memory | System page "Primary"                     |
| Redis down                             | `docker ps` for `cav-prod-redis`; its log                                                | `up -d redis`; AOF brings the queues back                                                                                                       | Queue counts readable                     |
| Disk full                              | `df -h`, `docker system df`                                                              | Remove old release images (`docker image rm cav-backend:<old sha>`, keep 3), old `src/` folders. Never delete `uploads/`, `data/` or backups    | Disk under 80 %                           |
| Queue backlog (`whatsapp`, `webhooks`) | System page counts; worker log for `job failed`                                          | Worker stopped: `up -d worker`. A provider slow: wait; Meta retries webhooks                                                                    | Waiting falls                             |
| Meta webhooks failing                  | Admin → WhatsApp setup failed events; `meta webhook:` warnings                           | Signature errors: the App Secret in `backend.env` must match Meta; after a rotation, both sides                                                 | New events stored                         |
| OpenAI errors or budget hit            | `ai:` warnings; OpenAI dashboard usage                                                   | Raise the cap or wait; calls fall back to the technical line                                                                                    | A test call answers                       |
| Razorpay failures                      | `razorpay: request rejected` line (status, code, description)                            | Keys / mode per [production.md](production.md)                                                                                                  | A ₹1 top-up credits the wallet            |
| E-mail not arriving                    | `email:` warnings; `npm run email:test -- --production`                                  | SMTP password, SPF / DKIM / DMARC                                                                                                               | Test mail received                        |
| Certificate near expiry                | System page days; `systemctl list-timers` for certbot                                    | `certbot renew --dry-run`, then `certbot renew`; `nginx -t` and reload                                                                          | Days left > 60                            |
| Bad release                            | Errors right after the release; `logs/releases.log`                                      | `deploy/scripts/rollback.sh`                                                                                                                    | Health shows the previous commit          |
| Leaked secret                          | Which one, where it went                                                                 | Rotate that one at once per [secret-rotation.md](secret-rotation.md); `ENCRYPTION_KEY` with the re-seal steps                                   | Old value refused                         |
| A customer asks for export or erasure  | Who asks, for which account or number                                                    | Phase 16 tools: Settings → Account export; contact Erase permanently; superadmin deletions                                                      | The audit row                             |
| App Review number problems             | Admin → WhatsApp setup; Meta's dashboard                                                 | Don't disconnect it or change the review login while the review is open                                                                         | Messages flow again                       |

## On call

The owner fills this in; nothing here is invented.

| Order | Name | Phone | Hours | Does |
| ----- | ---- | ----- | ----- | ---- |
| 1     |      |       |       |      |
| 2     |      |       |       |      |

The client's team runs releases and server commands until we have access. We read the logs they share and send fixes as releases.

## Game day

Not run: it needs a staging server. On one, time each of these with this page open, and fix any step that was wrong: stop MongoDB, stop Redis, fill the disk past 80 %, release an image that throws at start, `rollback.sh` to a named release, restore last night's backup on the Mac.
