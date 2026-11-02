# Production runbook

Production runs on the client's shared server; the design is in [ADR 0049](../adr/0049-production-shared-server.md) and the facts found so far in [PRODUCTION_AUDIT.md](PRODUCTION_AUDIT.md).

## Layout

| Path                                   | Holds                                                               |
| -------------------------------------- | ------------------------------------------------------------------- |
| `/srv/cell-ai-voicebot/releases/<sha>` | Source of each release (last 3 kept)                                |
| `/srv/cell-ai-voicebot/current`        | Link to the running release                                         |
| `/srv/cell-ai-voicebot/frontend/<sha>` | Built SPA of each release; `frontend/current` link                  |
| `/srv/cell-ai-voicebot/env/`           | `backend.env`, `compose.env`, `frontend.env`, `ops.env` (700 / 600) |
| `/srv/cell-ai-voicebot/uploads`        | Local files until the S3 switch                                     |
| `/srv/cell-ai-voicebot/backups`        | Temporary backup files only (uploaded, then removed)                |
| `/srv/cell-ai-voicebot/logs`           | Deploy, backup and healthwatch logs                                 |
| `/srv/cell-ai-voicebot/state`          | `deploy.lock`, `alerts.json`                                        |
| `/srv/cell-ai-voicebot/deploy`         | The kit from `deploy/production/`                                   |

## Access

Who has which key is kept by the owner, never in this file. Our deploy user may use Docker and our folder only. Never connect to `45.114.245.71` (old SMS box) or `13.232.191.62` (the client's other machine).
