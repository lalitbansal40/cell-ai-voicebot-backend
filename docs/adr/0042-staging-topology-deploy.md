# ADR 0042 — Staging topology and deployment

Status: Accepted (design); real staging verification is gated by Phase 13 owner inputs.

## Decision

Use one Ubuntu server and one hostname. Host nginx serves the versioned SPA and proxies the API/WebSockets/signed files. API/worker containers use host networking for WhatsApp UDP media; HTTP binds to loopback. Mongo/Redis are on a compose bridge and published only on loopback. Mongo uses port 27018 on both sides so a single-node replica address resolves locally inside and outside its container.

Build from immutable archives on the target server, avoiding Mac/Linux architecture mismatches and any image registry dependency. Compiled ops tools run in the same non-root Node 24 image. Secrets enter only through protected runtime files; frontend build values are public and separate. CI builds/inspects the image without pushing it.

Deploy migrates/indexes before restarting, checks build identity/readiness, atomically switches the web artifact and probes nginx. Failures restore the previous image/web pointer; database migrations stay backward compatible. Keep five recent releases plus current/previous. Only app source/release directories are pruned.

Encrypt Mongo+oplog and uploads backups with age, store them off-server, retain seven daily/four weekly within 30 days and exercise restoration in an isolated compose project. Monitor readiness, storage/memory, restarts, certificates and backup age. Real TLS/firewall/provider checks, App Review and review credentials require the owner's gates.

## Consequences

One server is operationally simple but remains a single failure domain. Backups and restore evidence are essential; staging is not a high-availability production design. Docker-capable users and deploy keys are privileged. Docker Desktop rehearsal requires bridge networking and service-DNS overrides; Linux deployment retains public UDP binding with private HTTP/data ports. A production topology and blue/green deployment are Phase 17 decisions.
