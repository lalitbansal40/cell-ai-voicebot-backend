# Local SIP Lab (Phase 0 · T0.16)

Proves the SIP → Asterisk → Node audio chain **locally, without the client's trunk**:

```
SIPp (caller, Docker) ──SIP/RTP──▶ Asterisk 20 (PJSIP + ARI, Docker) ──ExternalMedia RTP (μ-law)──▶ Node ARI app (host :40000)
                                              ▲                                                         │
                                              └──────────────── ARI REST + events WebSocket ────────────┘
```

Notes and results: [`docs/poc/sip-lab-notes.md`](../../docs/poc/sip-lab-notes.md).

## Run

Requires Docker Desktop running and Node 24.

```bash
cd poc/sip-lab
./run-lab.sh          # ECHO=0 ./run-lab.sh to disable echo-back
```

The script:

1. Creates `.env.lab` with **random lab-only** ARI / softphone passwords (gitignored; template `.env.lab.example`).
2. Renders `generated/ari.conf` and `generated/pjsip_softphone.conf` from the templates and generates `generated/caller.wav` (4 s, μ-law 8 kHz).
3. Starts Asterisk (`andrius/asterisk:20`, compose project **`cav-sip-lab`**) and waits for ARI on `127.0.0.1:8088`.
4. Starts the ARI app (`app/`) on the host — Asterisk reaches it through `host.docker.internal` (IPv4).
5. Places one call with SIPp (`sipp/uac-rtp-dtmf.xml`): INVITE (PCMU) → RTP stream of `caller.wav` → DTMF `5`, `7` via SIP INFO → waits for the app's BYE.
6. App: answer → 800 ms beep → mixing bridge with an **ExternalMedia** channel → receives RTP on UDP `:40000`, logs DTMF, hangs up after 15 s.
7. Writes `output/<callId>/caller.wav` + `summary.json` (and `output/last-summary.json`), then stops the lab containers.

Exit code 0 = RTP received **and** DTMF received.

| Port (127.0.0.1) | Use                                 |
| ---------------- | ----------------------------------- |
| 8088/tcp         | ARI / HTTP                          |
| 5060/udp         | SIP (optional softphone)            |
| 10000–10050/udp  | RTP                                 |
| 40000/udp (host) | ExternalMedia RTP into the Node app |

## Manual softphone test (optional)

1. `./run-lab.sh` creates `.env.lab`; start just Asterisk + app: `docker compose up -d asterisk` and `cd app && ARI_USER=… ARI_PASSWORD=… EXTERNAL_HOST=<host-ip>:40000 npm start`.
2. In Zoiper / Linphone add account: user `softphone`, password `SOFTPHONE_PASSWORD` from `.env.lab`, domain `127.0.0.1:5060`, transport UDP.
3. Dial `100`, talk, press keys → see DTMF + RTP counters in the app log.

Docker Desktop on macOS NATs UDP; if softphone audio is one-way, run the lab in a Linux VM (UTM / Multipass) where container ports map directly.

## Development

```bash
cd app && npm ci && npm run typecheck && npm test
```

## Safety

- Lab-only credentials, never real secrets; `.env.lab`, `generated/`, `output/` are gitignored.
- Only the `cav-sip-lab` compose project is started/stopped — no other containers are touched.
- Nothing here talks to the client's server or SIP trunk.
