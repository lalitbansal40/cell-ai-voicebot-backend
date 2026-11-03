# Phase 18 — SIP telephony (detailed plan)

**Status:** Locked (2026-11-03) · **Date:** 2026-11-03 · **Size:** L (2–3 weeks) · **Branch:** `feature/phase-18-sip` (both repos)
**Build plan:** [BUILD_PLAN_V2.md §4 Phase 18](../plans/BUILD_PLAN_V2.md) · **Before:** [Phase 17 sign-off](PHASE_17_SIGNOFF.md) · **ADRs:** [0020 telephony abstraction](../adr/0020-telephony-abstraction.md), [0022 SIP media server](../adr/0022-sip-media-server.md), [0035 voice runtime](../adr/0035-voice-runtime.md), [0036 dialer](../adr/0036-campaign-scheduler-dialer.md), [0049 production server](../adr/0049-production-shared-server.md) · **Lab:** [sip-lab-notes.md](../poc/sip-lab-notes.md)

## 0. Is phase ka goal

Phase 18 ke end tak:

- Bot **asli phone number par call** kar sake: client ke SIP trunk se, Asterisk media server ke through, wahi flow / AI agent jo aaj dry-run aur WhatsApp par chalta hai.
- Customer ki awaaz bot tak aur bot ki awaaz customer tak saaf jaaye (G.711, 8 kHz), DTMF (keypad) chale, beech mein bolne par bot ruk jaaye (barge-in).
- Busy, no answer, reject, galat number, answering machine — har result sahi likha jaaye aur campaign retry rules usi hisaab se chalen.
- Human agent ko call transfer ho sake.
- Ek saath kitni calls (trunk limit) aur ek second mein kitni dials (CPS), dono ka limit **saare processes ke beech** maana jaaye.
- Paisa sahi kate: answered minutes, pulse rounding, holds settle; trunk ka kharcha bhi record ho.
- Recording, transcript, call detail — sab phone calls ke liye bhi same kaam karein.
- Kuch toote (Asterisk restart, ARI connection gaya, RTP band) to call saaf band ho aur paisa settle ho; koi "phantom" call na bache.
- Toll fraud na ho: sirf India ke allowed numbers, trunk sirf client ke IPs se, ARI sirf localhost par.
- Ek switch se wapas dry-run par aa sakein (`TELEPHONY_PROVIDER=dryrun`), bina release ke rollback.

**Done when:**

- ADR 0022 is **Accepted** (Asterisk ARI + ExternalMedia) and ADR 0050 records the SIP architecture on the shared server (ports, RTP range, trunk auth, limits).
- A local lab (`npm run sip:lab`) starts Asterisk + SIPp in `cav-sip-lab-*` containers, and `npm run test:sip` passes: answer + two-way audio, DTMF (RFC 4733), busy 486, no answer 480 / timeout, reject 603, invalid 404 / 484, answering machine greeting, customer hangup mid-turn, transfer, Asterisk restart mid-call.
- `SipTelephonyProvider` implements `TelephonyProvider` / `CallLeg` (ADR 0020) with no change to flow, agent, recording or billing code beyond the rate and cause mapping.
- Campaigns and single calls run on `sip` for an account whose line is SIP; dry-run stays the default and keeps all current tests green.
- Concurrency (trunk channels) and CPS limits hold across API and worker processes (Redis), proved by a test with two processes.
- With the real trunk (Gate S inputs): 10 test calls to the owner's phones pass the §3 T18.18 checklist (audio both ways, DTMF, barge-in, first-word latency recorded, transfer, caller ID shown, recording, charge).
- A SIPp load run up to the trunk limit (default 30 concurrent) on the Mac and, when it exists, staging: no dropped calls, RTP jitter and CPU recorded in `docs/ops/capacity.md`.
- Phase 17 finding fixed: a disposition decided by an AI turn is saved even if the customer hangs up while the turn runs.
- Admin → System shows SIP health; healthwatch alerts on ARI down / trunk unregistered.
- Verify per §6 (each suite **once**), Playwright once; docs and sign-off done.

### Phase 18 mein kya NAHI hoga

| Kaam                                                         | Kahan                                  |
| ------------------------------------------------------------ | -------------------------------------- |
| Inbound phone calls, DID → flow routing, IVR queue           | Phase 19 (only the hook is left ready) |
| Phone numbers page for inbound (business hours, missed list) | Phase 19                               |
| Bulk WhatsApp campaigns / bulk WhatsApp calling              | Phase 20                               |
| WhatsApp calls over Meta's SIP option                        | Research note only (T18.21)            |
| FreeSWITCH, Kamailio, multi-box media servers                | Only if T18.19 load fails              |
| Video, SMS over the trunk, fax                               | Not planned                            |
| Pilot with real customers                                    | Phase 21                               |
| Connecting to `45.114.245.71` or `13.232.191.62`             | Never                                  |

---

## 1. Findings and locked decisions

### 1a. Urgent findings

| #   | Finding                                                                                                                                         | Action                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| F1  | `docs/poc/sip-lab-notes.md` §5 names `13.232.191.62` as the NAT address. That is the client's **other** EC2, which we never touch.              | Correct the note in T18.1; the address comes from the production audit    |
| F2  | Phase 17 server items are still open (no SSH, no staging). Real-trunk tests and the production rollout need them.                               | Code, lab and load on the Mac first; T18.18 / T18.20 wait for Gate S + P  |
| F3  | WhatsApp call media already binds UDP **40000–40999** on the host (ADR 0049).                                                                   | Asterisk RTP uses **20000–20999**; ARI and SIP ports checked by the audit |
| F4  | Phase 17: a customer hangup during an AI turn loses the disposition that turn decided.                                                          | Fix in T18.12 (phone calls hang up mid-turn far more often than dry runs) |
| F5  | `TELEPHONY_PROVIDER` accepts only `dryrun`; `SIP_*` env vars exist in `.env.example` but nothing reads them; the comment still says "Phase 13". | T18.6 wires them; fix comments                                            |
| F6  | `CallLeg.rate` already allows `8_000`, and the OpenAI provider already maps 8 kHz to `audio/pcmu`.                                              | Reuse; check the STT / TTS / recording paths at 8 kHz in T18.4 and T18.11 |
| F7  | `HangupCause` has `busy`, `no_answer`, `rejected`, `invalid_number` already (dry run). No `machine`.                                            | Add `machine` (T18.9) and a SIP / Q.850 → cause table (T18.5)             |

### 1b. What exists today (reuse, don't rebuild)

- `TelephonyProvider` / `CallLeg` interface (`src/core/telephony/types.ts`), PCM16 20 ms frames, `play` / `clearAudio` / `transfer` / `hangup`.
- Dry-run provider + simulated customer scenarios (`dryrun.ts`, `scenarios.ts`) — stays the default and the test line.
- Voice runtime: flow host, AI session (OpenAI realtime, `audio/pcmu` at 8 kHz), barge-in, latency metrics, recording, transcripts (ADR 0035).
- Campaign dispatcher, dial guard (calling window, TRAI / RBI bounds, DND, consent), retries, caps, per-account `maxConcurrentCalls` (default 10) and `dialsPerMinute` (60) (ADR 0036).
- Call model: `provider` enum already has `sip`; `providerCallId`, `hangupCause`.
- WhatsApp calling (Phase 12): server-side media, codec work, jitter handling, owner sweep, reaper — patterns to copy for RTP.
- Wallet holds per call, per-minute settle, reaper (Phase 4 / 17 wallet lock).
- Phase 17 kit: `cav-prod` compose, `release.sh` waits for live calls, healthwatch, Admin → System, `ops-status`.
- Lab: `poc/sip-lab/` (Asterisk 20 + ARI + ExternalMedia + SIPp, proven 2026-10-08).

### 1c. Gaps found

| Gap                                                                          | Task         |
| ---------------------------------------------------------------------------- | ------------ |
| No production Asterisk config, container or ports                            | T18.2        |
| No ARI client in `src/`                                                      | T18.3        |
| No RTP ↔ PCM16 bridge, jitter buffer or port pool                            | T18.4        |
| No SIP leg / provider, no SIP cause mapping                                  | T18.5        |
| Line choice is global env only; no per-account line / caller ID              | T18.6, T18.7 |
| Concurrency limit is per account, not per trunk; not shared across processes | T18.8        |
| No answering machine detection                                               | T18.9        |
| Billing has no pulse rounding or trunk cost                                  | T18.10       |
| Recording / transcript not tested at 8 kHz                                   | T18.11       |
| Disposition lost on mid-turn hangup                                          | T18.12       |
| No sweep for channels without calls or calls without channels                | T18.13       |
| No toll-fraud guard (number patterns, spend per minute)                      | T18.14       |
| No SIP health on System page / healthwatch                                   | T18.15       |
| UI has no line, caller ID, SIP cause or AMD setting                          | T18.16       |
| No automated SIP tests                                                       | T18.17       |

### 1d. Decisions (defaults; the owner can change them in §7)

| #   | Decision        | Default                                                                                                                            |
| --- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Media server    | **Asterisk 22 LTS**, ARI + ExternalMedia (RTP over UDP), our own image pinned by digest                                            |
| D2  | Where it runs   | Same host as the app, container `cav-prod-asterisk`, host network; staging gets `cav-stg-asterisk`                                 |
| D3  | Ports           | SIP 5060/udp+tcp (5061 TLS) **only from trunk IPs**; RTP 20000–20999/udp; ARI `127.0.0.1:8088`; our RTP 21000–21999 on `127.0.0.1` |
| D4  | Codec           | G.711 μ-law first, A-law second; no transcoding in Asterisk; leg rate 8 kHz                                                        |
| D5  | Trunk auth      | Whatever the client gives: registration (user + password) or IP `identify`; both supported by the template                         |
| D6  | DTMF            | RFC 4733 (`dtmf_mode=rfc4733`), fallback `auto`                                                                                    |
| D7  | Transfer        | Second outbound leg over the trunk, bridged in Asterisk (works on every trunk); `REFER` only if the trunk supports it              |
| D8  | AMD             | Off by default; per campaign `amd: off \| hangup \| leave_message`; Asterisk `AMD()` before `Stasis`                               |
| D9  | Concurrency     | `min(trunk limit SIP_MAX_CHANNELS, account maxConcurrentCalls)`; Redis counter shared by all processes; transfer legs count        |
| D10 | CPS             | `SIP_MAX_CPS` (default 2) global token bucket in Redis, plus the account `dialsPerMinute`                                          |
| D11 | Billing         | Per answered second, rounded up to the pulse `SIP_BILLING_PULSE_SEC` (default 60); trunk cost per minute stored for margin         |
| D12 | Rollback        | `TELEPHONY_PROVIDER=dryrun` (env) or the account line switch (superadmin) — no release needed                                      |
| D13 | Numbers allowed | `+91` 10-digit mobiles (6–9) and landlines; no international, no premium / short codes; per-account allowlist off by default       |
| D14 | Caller ID       | Per account from the `phoneNumbers` list (1600-series for BFSI service calls); falls back to `SIP_CALLER_ID`                       |
| D15 | Recording       | Both sides mixed, 8 kHz, same storage and retention as today                                                                       |
| D16 | Tests           | §6 policy: changed-file tests while working, each suite **once** per batch checkpoint, Playwright once at sign-off                 |

---

## 2. Tasks ka overview

| #      | Task                                                    | Repo | Size | Batch | Needs        |
| ------ | ------------------------------------------------------- | ---- | ---- | ----- | ------------ |
| T18.1  | Inputs, trunk questionnaire, ADR 0022 accept + ADR 0050 | docs | S    | B1    | —            |
| T18.2  | Asterisk kit (image, config templates, compose, lab)    | ops  | M    | B1    | —            |
| T18.3  | ARI client (REST + events, reconnect)                   | BE   | M    | B1    | —            |
| T18.4  | RTP media bridge (G.711 ↔ PCM16, jitter, port pool)     | BE   | M    | B1    | —            |
| T18.5  | `SipCallLeg` + `SipTelephonyProvider`, cause mapping    | BE   | M    | B1    | —            |
| T18.6  | Config, line selection, boot checks                     | BE   | S    | B1    | —            |
| T18.7  | Phone numbers + caller ID per account                   | both | M    | B2    | —            |
| T18.8  | Dialer on SIP: trunk concurrency, CPS, retries by cause | BE   | M    | B2    | —            |
| T18.9  | Answering machine detection                             | BE   | M    | B2    | —            |
| T18.10 | Billing: pulse, trunk cost, reconcile                   | BE   | S    | B2    | —            |
| T18.11 | Recording + transcripts at 8 kHz                        | BE   | S    | B2    | —            |
| T18.12 | Disposition saved on mid-turn hangup                    | BE   | S    | B2    | —            |
| T18.13 | Reliability: reconnect, sweeps, restarts, media timeout | BE   | M    | B2    | —            |
| T18.14 | Security + toll-fraud guard                             | both | S    | B3    | —            |
| T18.15 | Monitoring: System page, healthwatch, call metrics      | both | S    | B3    | —            |
| T18.16 | Frontend: line, caller ID, causes, AMD, admin numbers   | FE   | M    | B3    | —            |
| T18.17 | SIP test suite (`test:sip`) + CI job                    | both | M    | B1→B3 | —            |
| T18.18 | Real trunk test calls                                   | ops  | S    | B3    | 🔴 Gate S    |
| T18.19 | Load: SIPp up to trunk limit                            | BE   | S    | B3    | staging opt. |
| T18.20 | Rollout on production with the Phase 17 kit             | ops  | S    | B3    | 🔴 Gate P+S  |
| T18.21 | WhatsApp over SIP: research note                        | docs | S    | B3    | —            |
| T18.22 | Gap audit, docs, sign-off                               | both | S    | B3    | —            |

Batches: **B1** = media path works in the lab; **B2** = product on SIP (dialer, money, records); **B3** = safety, UI, real trunk, load, rollout.

---

## 3. Tasks — step by step

### T18.1 — Inputs, questionnaire, ADRs (docs)

1. `docs/integrations/sip-trunk.md`: the questionnaire for the client (Gate S, §8) with why each item matters, and a filled-in example with fake values.
2. Fix sip-lab-notes §5 (F1): NAT address = production host from the audit, never `13.232.191.62`.
3. ADR 0022 → **Accepted**: Asterisk 22 LTS, ARI + ExternalMedia; FreeSWITCH only if T18.19 fails. Note the lab result and why not AudioSocket (RTP keeps codec / jitter control in our hands; AudioSocket is the fallback if UDP on the host is a problem).
4. ADR 0050 "SIP on the shared server": container, host network, ports (D3), trunk auth (D5), firewall rules, limits (D9–D10), rollback (D12), mermaid diagram (trunk ↔ Asterisk ↔ ARI app in API / worker ↔ voice runtime). Add to `docs/adr/README.md`.
5. Decide which process owns SIP calls: the **worker** (`WORKERS_ENABLED=true`) holds the ARI connection and the RTP ports, like WhatsApp AI calls; the API only starts calls through the queue. Write it in ADR 0050.

### T18.2 — Asterisk kit (ops)

1. `deploy/asterisk/Dockerfile`: Debian slim + Asterisk 22 LTS from source or a pinned, maintained image (decide in T18.1, pin by digest); only modules we use (`res_pjsip*`, `res_ari*`, `res_stasis*`, `chan_pjsip`, `app_amd`, `res_rtp_asterisk`, `codec_ulaw`, `codec_alaw`, `app_stasis`, `res_http_websocket`); run as non-root.
2. Config templates in `deploy/asterisk/conf/` rendered at start from env (no secrets in files in git): `pjsip.conf` (transport, trunk endpoint, `identify` or `registration`, `allow=ulaw,alaw`, `dtmf_mode=rfc4733`, `direct_media=no`, `external_media_address`, `external_signaling_address`, `local_net`), `rtp.conf` (20000–20999, `strictrtp=yes`, ICE off), `ari.conf` (one user, password from env), `http.conf` (bind `127.0.0.1:8088`), `extensions.conf` (outbound context `cav-out` → AMD optional → `Stasis(cav)`; inbound context answers 404 until Phase 19), `logger.conf` (console + JSON-ish, no SIP passwords), `modules.conf` (`noload` everything else), `acl` / `allowguest=no`.
3. `deploy/asterisk/render.sh` + shellcheck; a test that renders templates from a sample env and checks no placeholder or secret is left in comments.
4. Compose: service `asterisk` in `deploy/staging/compose.yaml` and `deploy/production/compose.yaml` (profile `sip`, so dry-run installs don't start it), limits 1 CPU / 512 MB, `local` logs 20m×5, healthcheck `asterisk -rx 'core show uptime'`, restart `unless-stopped`.
5. Local dev: `docker compose --profile sip` in the root dev compose with container names `cav-asterisk`, `cav-sipp`; README section.
6. Lab: move `poc/sip-lab` ideas into `deploy/asterisk/lab/` with SIPp UAS scenarios (see T18.17); `npm run sip:lab` starts it, `sip:lab:down` stops it. Only `cav-sip-lab-*` names.
7. Rehearsal: the Phase 17 Mac rehearsal (`cav-prod-rehearsal`) runs with the `sip` profile and one SIPp call end to end.

### T18.3 — ARI client (backend)

1. `src/core/telephony/sip/ari-client.ts`: REST over `fetch` (basic auth), events over `ws` (`/ari/events?app=cav&subscribeAll=false`), typed subset of events we use (`StasisStart`, `StasisEnd`, `ChannelStateChange`, `ChannelDestroyed`, `ChannelDtmfReceived`, `ChannelHangupRequest`, `ChannelVarset` for AMD, `Dial`, `BridgeDestroyed`).
2. Calls: `originate` (endpoint `PJSIP/<number>@trunk`, `app=cav`, `appArgs=<callId>`, `callerId`, `timeout`, `variables`), `answer`, `hangup(reason)`, `externalMedia` (`external_host=127.0.0.1:<port>`, `format=ulaw|alaw`, `direction=both`), bridges (create / add / remove / destroy), `getChannelVar`, `list channels`.
3. Reconnect with backoff (0.5 s → 10 s), resubscribe, `connected` state for health; every REST call has a 3 s timeout; errors logged with call id, never with credentials.
4. Unit tests with a fake ARI server (HTTP + WS in-process): event parsing, reconnect, timeouts, auth header, unknown events ignored.

### T18.4 — RTP media bridge (backend)

1. `src/core/telephony/sip/rtp.ts`: one UDP socket per call from a port pool (`SIP_APP_RTP_PORTS=21000-21999`, bound to `127.0.0.1`); parse RTP header (version, PT 0 / 8, seq, timestamp, SSRC); drop wrong SSRC after lock-in (strict RTP), ignore RTCP or count it.
2. Codec: G.711 μ-law / A-law ↔ PCM16 with lookup tables (no native module); unit tests with known sample vectors.
3. Jitter buffer: 60 ms target, 200 ms max, reorder by seq, conceal one lost frame by repeating, count loss / late / jitter (RFC 3550 formula) for `metrics.sip`.
4. Outgoing: 20 ms frames (160 samples) paced by the existing pacer at 8 kHz, seq / timestamp / SSRC our own, marker bit on talk start; `clearAudio()` drops the queue at once.
5. Pass-through option: when the AI provider takes `audio/pcmu`, send μ-law bytes straight (no decode / encode) — measure CPU both ways, keep the faster one behind a flag.
6. Port pool: leases with call id, release on end, sweep leaked ports every minute; pool exhaustion → call fails `limit` before originate.
7. Tests: loopback UDP send / receive, reorder, loss, jitter numbers, pool exhaustion, release on error.

### T18.5 — `SipCallLeg` + `SipTelephonyProvider` (backend)

1. `src/core/telephony/sip/provider.ts` implements `TelephonyProvider` (`name: 'sip'`): `startCall({callId, to})` → lease port → originate → wait for `StasisStart` → answer handling → create mixing bridge with the channel and an ExternalMedia channel → return `SipCallLeg` (`rate = 8_000`).
2. Status: `ringing` on originate accepted / 180, `answered` on `Up`, `ended` with cause from the table below; ring timeout `SIP_RING_TIMEOUT_SEC` (default 40).
3. Cause table (`sip/causes.ts`), from SIP response and Q.850 cause (`ChannelDestroyed.cause`):

   | SIP / Q.850                       | `HangupCause`                                     |
   | --------------------------------- | ------------------------------------------------- |
   | 486, 600 / 17                     | `busy`                                            |
   | 480, 408, ring timeout / 18, 19   | `no_answer`                                       |
   | 603, 403 / 21                     | `rejected`                                        |
   | 404, 484, 410 / 1, 3, 22, 28      | `invalid_number`                                  |
   | 503, 502, 500 / 34, 38, 41, 42    | `media_error` (trunk failure, retryable)          |
   | normal clearing after answer / 16 | `customer_hangup` or `normal` (who hung up first) |

   Raw SIP code and Q.850 cause are saved on the call (`sip.code`, `sip.q850`) for support.

4. DTMF: `ChannelDtmfReceived` → `onDtmf`; dedupe repeated digits within 40 ms.
5. `play` / `clearAudio` / `playing` through the RTP bridge; `onOutgoing` for recording.
6. `transfer(phone, timeoutSec)`: originate a second channel to the agent with the account caller ID; on answer, remove ExternalMedia from the bridge, add the agent channel, stop the AI session, return `connected`; on busy / no answer / timeout return the matching result and keep the AI on the call. The transfer leg counts against concurrency and is billed (T18.10).
7. `hangup(cause)`: hang up the customer channel, destroy bridge and ExternalMedia, release the port; idempotent.
8. `notify()` is a no-op (phone legs).
9. Tests with the fake ARI + loopback RTP: full call, every cause, DTMF, barge-in, transfer success / fail, hangup from each side, double hangup.

### T18.6 — Config, line selection, boot checks (backend)

1. Env (`src/config/env.ts`, `.env.example`, README env table): `TELEPHONY_PROVIDER` = `dryrun | sip`; `ARI_URL`, `ARI_USER`, `ARI_PASSWORD` (secret), `ARI_APP` (default `cav`), `SIP_TRUNK_ENDPOINT` (default `trunk`), `SIP_CALLER_ID`, `SIP_MAX_CHANNELS` (30), `SIP_MAX_CPS` (2), `SIP_RING_TIMEOUT_SEC` (40), `SIP_APP_RTP_PORTS` (21000-21999), `SIP_BILLING_PULSE_SEC` (60), `SIP_TRUNK_COST_PAISE_PER_MIN` (optional). Existing `SIP_HOST` / `SIP_PORT` / `SIP_TRANSPORT` / `SIP_USERNAME` / `SIP_PASSWORD` move to the Asterisk render env (not read by Node). Fix the "Phase 13" comments.
2. Production boot check: `TELEPHONY_PROVIDER=sip` requires `ARI_*`, a caller ID and the port range; fails fast with the missing key **names**.
3. Per-account line: `account.voiceLine = 'dryrun' | 'sip'` (default `dryrun`), changed by superadmin only; the effective provider = env allows it **and** the account line. Campaign and single-call paths read it; WhatsApp calls are unaffected.
4. Migration `0019-sip-lines`: sets `voiceLine: 'dryrun'` on every account, creates `phoneNumbers` indexes; works with the previous release running (DoD migration rule).
5. Audit: `account.voice_line_changed`.

### T18.7 — Phone numbers + caller ID (both)

1. Model `phoneNumbers`: `number` (E.164, unique), `kind` (`1600` / `landline` / `mobile` / `other`), `accountId` (nullable = pool), `purpose` (`outbound`; `inbound` reserved for Phase 19), `label`, `dltPrincipalEntityId` (optional text), `status` (`active` / `disabled`), timestamps.
2. Superadmin API: list / create / update / assign / unassign / disable (`/admin/phone-numbers`), with audit actions `phone_number.created`, `.updated`, `.assigned`, `.released`. Account API: `GET /phone-numbers` (own, read-only).
3. Caller ID choice: campaign → `callerNumberId` (one of the account's active outbound numbers) → account default → `SIP_CALLER_ID`. Stored on the call (`callerId`).
4. Validation: number must be `+91` and 10 digits; 1600-series pattern check with a warning, not a block (series rules may change — config, not code).
5. Frontend: Admin → Phone numbers page (table, add, assign to account, disable); account Settings → Phone line card (line type, numbers, read-only).
6. Tests: API, permissions (superadmin only for writes), audit rows, campaign validation of `callerNumberId`.

### T18.8 — Dialer on SIP (backend)

1. Trunk concurrency: Redis semaphore `sip:channels` with leases per call id (TTL 2 h, refreshed every 30 s by the call owner); acquire before originate, release on end; transfer leg takes a second lease. Account limit stays as today.
2. CPS: Redis token bucket `sip:cps` at `SIP_MAX_CPS`; the dispatcher waits for a token before originate.
3. When the trunk is full: the campaign slot waits (no failure, no retry count used); single calls get `409 LINE_BUSY` with a clear message.
4. Retries by cause: `busy`, `no_answer`, `media_error` → retry rules as dry run; `invalid_number`, `rejected` (603) → no retry, contact flagged `invalid_number` / `rejected`; `machine` → per campaign AMD setting.
5. Dial guard unchanged (calling window, DND, consent, TRAI / RBI hours) plus the T18.14 number check.
6. Live calls count for `release.sh` (Phase 17 `live-calls.ts`) includes SIP calls (it reads the call collection — add a test).
7. Two-process test: API + worker processes with a fake ARI; 50 queued calls with `SIP_MAX_CHANNELS=5` never exceed 5; CPS never above the limit.

### T18.9 — Answering machine detection (backend)

1. Dialplan: when the call's `CAV_AMD=1`, run `AMD()` with tuned defaults (initial silence 2500 ms, greeting 1500 ms, after-greeting silence 800 ms, total 5000 ms) before `Stasis`; the result (`AMDSTATUS`, `AMDCAUSE`) is read in `StasisStart`.
2. `HUMAN` / `NOTSURE` → normal call. `MACHINE` → campaign setting: `hangup` (cause `machine`, no charge beyond the pulse rule decided in §7), or `leave_message` (wait for the beep / silence, play the campaign's voicemail TTS once, hang up).
3. New `HangupCause` `machine`, call outcome `voicemail`, analytics glossary row, report filters.
4. The extra seconds AMD takes are recorded (`metrics.sip.amdMs`) so the first-word latency stays honest.
5. Tests: SIPp scenarios with a recorded greeting (machine) and a short "hello" (human); unit tests for the setting paths.

### T18.10 — Billing (backend)

1. Answered duration from Asterisk (`Up` → `ChannelDestroyed`) and our own clock; use the smaller, record both (`durationSource`).
2. Pulse rounding: `ceil(seconds / pulse) × pulse` at the account's per-minute rate; pulse from env, per-account override by superadmin.
3. Not answered → no charge, hold released (same as dry run). Transfer leg → billed at the same rate from its answer, as a separate ledger line `call.transfer`.
4. Trunk cost (`SIP_TRUNK_COST_PAISE_PER_MIN`) stored on the call for the margin report; not shown to accounts.
5. Reconcile: optional CSV import of the trunk CDR (`npm run sip:cdr-reconcile -- file.csv`) compares minutes per day; report only, no money moves.
6. Tests: pulse edges (1 s, 60 s, 61 s), transfer billing, unanswered, hangup during AMD, wallet lock path unchanged.

### T18.11 — Recording + transcripts at 8 kHz (backend)

1. Recording mixes customer and bot at 8 kHz; file format as today; check the encoder and player at 8 kHz.
2. STT at 8 kHz (`audio/pcmu`) — compare word accuracy on 10 sample Hindi / Hinglish phone recordings vs 24 kHz; write the result in `voice-ai-poc-results.md`.
3. Transcript timestamps from the RTP clock; recording retention and erase (Phase 16) work for phone calls.
4. Tests: recording length matches duration ±1 s; erase removes phone recordings.

### T18.12 — Disposition saved on mid-turn hangup (backend)

1. When the customer leg ends while an AI turn (or its tool call) is running, wait up to `CALL_LIMITS.turnGraceMs` (default 3000 ms) for the turn's tool results before settling; the disposition, promise date, callback time from that turn are saved.
2. No audio is sent after the hangup; billing ends at the hangup time, not after the grace.
3. Tests on dry run (deterministic) and SIP fake: hangup during tool call → disposition saved; grace timeout → saved as `incomplete` with the reason.
4. Remove the Phase 17 open flake note once `calls/outbound` (wrong number) and `seed-calls` are green because of this.

### T18.13 — Reliability (backend)

1. ARI disconnect during calls: keep RTP running; on reconnect, list channels and match by `appArgs` call id; channels we don't know → hang up; calls we own with no channel → end `media_error`, settle.
2. Sweep every minute (owner process): calls `in_progress` on `sip` for longer than the max duration, or with no RTP for `SIP_MEDIA_TIMEOUT_SEC` (10) → hang up `media_timeout`, settle, release lease + port.
3. Asterisk restart: all live calls end `media_error`, settle; new calls wait until ARI is connected (dispatcher pauses, no retries used).
4. Worker shutdown (SIGTERM): stop new originates, wait for live SIP calls as `release.sh` does (Phase 17), then end politely.
5. Idempotency: originate uses the call id as channel id, so a retried job can't create two calls.
6. Tests for each case with the fake ARI; one lab test restarts the Asterisk container mid-call (T18.17).

### T18.14 — Security + toll-fraud guard (both)

1. Number check before originate (D13): `+91` mobile `[6-9]\d{9}` or landline pattern; block international, `1xx` short codes, premium; reason `number_not_allowed` on the call and in the campaign results.
2. Spend guard: per account max new SIP minutes per hour (default 600, superadmin can change); breach → pause the account's campaigns + bell + e-mail.
3. Asterisk: trunk only from trunk IPs (`identify` + firewall rule in `host-hardening.md`), `allowguest=no`, anonymous endpoint absent, ARI only on 127.0.0.1 with a long random password, SIP TLS / SRTP when the trunk supports it (§7).
4. Secrets: `ARI_PASSWORD`, SIP password only in env files; logger redaction list extended; secret scan patterns in `sync-client-repo.sh` and the log grep extended with `ARI_PASSWORD` value shape.
5. Threat model (`docs/security/threat-model.md`) gets a SIP section: toll fraud, SIP scanning, RTP injection, ARI exposure, caller ID spoofing; each with the control.
6. Tests: number patterns, spend guard pause, redaction.

### T18.15 — Monitoring (both)

1. `metrics.sip` on each call: codec, packets in / out, loss %, jitter ms, AMD ms, SIP code, Q.850, first audio ms.
2. Admin → System: SIP card (ARI connected, trunk registration state from `pjsip show registrations` via ARI `asterisk/info` or a CLI check, live channels / limit, CPS, last 24 h causes, average loss / jitter).
3. Healthwatch rules: ARI disconnected > 2 min, trunk not registered (when registration is used), live channels stuck at the limit > 10 min, loss > 5 % average over 15 min; each alert tested once on the lab.
4. Logs: one line per call start / end with call id, cause, duration (no numbers in full — last 4 only).

### T18.16 — Frontend (FE)

1. Call detail: line (`Phone` / `WhatsApp` / `Test`), caller ID, SIP code + cause in plain words ("Busy", "Number not in service"), quality (loss, jitter), AMD result.
2. Campaign form: caller number (when the account has more than one), AMD setting with help text, voicemail message (when `leave_message`); shows "Test line" banner when the account line is dry run.
3. Single call dialog: same caller number choice; clear `LINE_BUSY` message.
4. Admin → Phone numbers page (T18.7); Admin → Account → Line switch (dryrun / sip) with confirm.
5. Admin → System SIP card (T18.15).
6. Reports / analytics filters: line, cause `machine` / `voicemail`.
7. Tests: one test file per page / dialog changed; Playwright: one new spec `sip-line.spec.ts` (admin assigns number, sets line, campaign shows caller number) against the fake ARI.

### T18.17 — SIP test suite (both)

1. `npm run test:sip` (separate vitest config `vitest.sip.config.ts`, not in the default suite): needs `npm run sip:lab`; SIPp UAS scenarios in `deploy/asterisk/lab/scenarios/`: `answer-speak.xml` (plays a WAV, sends DTMF via RFC 4733 pcap), `busy-486.xml`, `noanswer.xml`, `reject-603.xml`, `notfound-404.xml`, `machine.xml` (long greeting), `hangup-midturn.xml`, `transfer-agent.xml` (second UAS).
2. AI in the lab uses the existing fake voice provider (no OpenAI key); audio checks compare energy / tone frequency, not words.
3. CI: a separate job `sip-lab` on `ubuntu-latest` (Docker available), runs only when `src/core/telephony/sip/**`, `deploy/asterisk/**` or the SIP tests change (paths filter) — so normal PRs don't pay for it.
4. Default suite uses the fake ARI only (fast, no Docker).

### T18.18 — Real trunk test calls (ops, 🔴 Gate S)

Checklist, 10 calls to the owner's own phones (two networks: Jio / Airtel / Vi), each line recorded in `docs/integrations/sip-trunk.md` §results:

1. Trunk registered / identified; options ping OK.
2. Call rings, caller ID shows the 1600 / assigned number.
3. Audio both ways clear; first bot word latency after answer (target ≤ 1.5 s; AMD off).
4. Barge-in stops the bot within 300 ms.
5. DTMF 0–9, `*`, `#` each received once.
6. Busy, reject, switched-off, invalid number → right cause.
7. Transfer to the owner's second phone connects; AI leaves.
8. Recording and transcript present and audible.
9. Charge = pulse rule; trunk CDR minutes match.
10. AMD on: voicemail detected on a phone with voicemail on.

### T18.19 — Load (backend)

1. `npm run perf:sip -- --calls 30 --duration 120`: SIPp UAS answering, fake AI with real audio pacing, 30 concurrent (or trunk limit) for 10 minutes.
2. Record: CPU / RAM of worker and Asterisk, RTP loss / jitter, event loop lag, port leaks (0), wallet results exact.
3. Mac numbers now; staging numbers when it exists (Phase 17 T17.9). Write in `docs/ops/capacity.md`.

### T18.20 — Rollout on production (ops, 🔴 Gate P + S)

1. Server audit confirms ports 5060, 20000–20999, 8088 free and the firewall plan; client admin opens SIP / RTP **only from trunk IPs**.
2. Release with `release.sh` (Phase 17) with profile `sip`; account lines stay `dryrun`.
3. Superadmin switches the **owner's test account** to `sip`; T18.18 checklist on production; then one pilot account (Phase 21 decides real customers).
4. Rollback drill: switch back to dry run in under 1 minute; stop the `asterisk` container; no app restart needed.
5. Runbook entries in `docs/ops/incidents.md`: trunk down, one-way audio, calls stuck, toll-fraud alert.

### T18.21 — WhatsApp over SIP (docs)

Research note `docs/integrations/whatsapp-sip.md`: Meta's SIP option for WhatsApp calling, what it needs (SIP endpoint, TLS, SRTP, Meta config), what we would gain (one media path), cost, and a recommendation (build in a later phase or not). No code.

### T18.22 — Gap audit, docs, sign-off (both)

1. Docs: ADRs, `docs/integrations/sip-trunk.md`, `docs/ops/production.md` SIP section, `capacity.md`, `audit.md` (new actions), `data-model.md` (`phoneNumbers`, call `sip` fields, `voiceLine`), `websocket.md` unchanged check, threat model, both CHANGELOGs, `src/README.md`, BUILD_PLAN_V2 changelog.
2. Gap audit: every Done-when line → pass or open item with owner; every §1c gap → task commit.
3. `PHASE_18_SIGNOFF.md` with numbers, deviations, bugs, open items.
4. Client repo sync only when the owner asks (Phase 17 `sync-client-repo.sh`).

---

## 4. Deliverables checklist

- [ ] ADR 0022 Accepted, ADR 0050 written, README index rows
- [ ] `docs/integrations/sip-trunk.md` (questionnaire + results), sip-lab-notes fixed
- [ ] `deploy/asterisk/` (Dockerfile, conf templates, render, lab, scenarios), compose services (profile `sip`)
- [ ] `src/core/telephony/sip/` (`ari-client`, `rtp`, `g711`, `jitter`, `port-pool`, `causes`, `provider`, `leg`)
- [ ] Env keys + boot check + `.env.example` + README table
- [ ] Migration `0019-sip-lines`; `phoneNumbers` model; `account.voiceLine`; call `callerId` + `sip` fields
- [ ] Admin + account phone number APIs, audit actions, OpenAPI regenerated
- [ ] Dialer trunk semaphore + CPS bucket, retries by cause, `LINE_BUSY`
- [ ] AMD (dialplan + settings + `machine` / `voicemail`)
- [ ] Billing pulse, transfer line, trunk cost, CDR reconcile script
- [ ] 8 kHz recording / STT check
- [ ] Disposition grace fix
- [ ] Reconnect, sweeps, restart handling, media timeout
- [ ] Number guard, spend guard, Asterisk hardening, redaction, threat model
- [ ] `metrics.sip`, System card, healthwatch rules
- [ ] Frontend pages / dialogs / filters + tests + one Playwright spec
- [ ] `test:sip` + CI `sip-lab` job (paths filter)
- [ ] Real trunk checklist results (or open item)
- [ ] `perf:sip` numbers in `capacity.md`
- [ ] Production rollout + rollback drill (or open item)
- [ ] WhatsApp SIP note
- [ ] Sign-off, CHANGELOGs, tracker

---

## 5. Risks

| Risk                                                            | Mitigation                                                                                   |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Trunk details late (Gate S)                                     | B1 + B2 fully in the lab; only T18.18 / T18.20 wait                                          |
| One-way or no audio (NAT, wrong external address, firewall)     | `external_media_address` from the audit, `direct_media=no`, lab test on Linux, runbook entry |
| Latency on 8 kHz phone audio (AMD adds 2–5 s)                   | AMD off by default; measure first-word latency per call; `audio/pcmu` pass-through           |
| Hindi STT worse at 8 kHz                                        | T18.11 measurement; tune prompts / language hint; owner decision if too low                  |
| Shared host: UDP ranges or CPU contention with the client's app | Separate ranges (D3), container limits, load test, audit confirms                            |
| Toll fraud / SIP scanners                                       | Trunk-IP-only firewall, no guest, number + spend guards, alerts                              |
| Regulatory (1600-series, DLT, calling hours)                    | Caller ID from the assigned list, dial guard unchanged, owner confirms series and hours      |
| Asterisk image supply chain                                     | Build ourselves or pin a digest; scan in CI; only needed modules                             |
| Docker Desktop on Mac proxies UDP (lab audio quirks)            | Lab tests check energy, not exact bytes; real audio checks on Linux CI / staging             |
| Test time grows with SIP                                        | §6 policy: SIP suite separate and paths-filtered; default suite uses the fake ARI            |

---

## 6. Test policy (owner request, 2026-11-03: fewer runs, faster work)

Goal: the same safety with **4–5× less waiting** than Phase 17.

| When                      | What runs                                                                                                                                             | Not run                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| While writing a task      | Only the test files for the changed code (`npx vitest run <files>` or `vitest related <changed files>`)                                               | Full suites                            |
| Task commit               | lint + typecheck + those tests (pre-commit already formats)                                                                                           | Coverage, build                        |
| Batch checkpoint (B1, B2) | Backend full suite **once** (no coverage), frontend full suite **once**, build, OpenAPI check; `test:sip` once if SIP code changed                    | Playwright, repeats                    |
| Sign-off (B3)             | Backend full suite **once with coverage**, frontend **once with coverage**, builds, `test:sip` once, Playwright **once** with backend logs + log grep | Second Playwright run, 5× backend runs |
| A known flake fails       | Re-run **only that test file** once; record it                                                                                                        | Whole suite again                      |
| A real failure            | Fix, re-run that file, then continue; the next checkpoint covers the rest                                                                             | —                                      |

- Playwright between batches: only specs for pages that changed (`npx playwright test <spec>`).
- Load tests (`perf:sip`) once at the end of B3, not per batch.
- Long runs in the background; no code edits while a full suite runs.

Rough time per checkpoint: before ~2.5 h (5 backend + 2 Playwright) → now ~35–50 min.

---

## 7. Decisions and open questions (owner — defaults apply if not answered)

| #   | Question                                                           | Default                               |
| --- | ------------------------------------------------------------------ | ------------------------------------- |
| 1   | Asterisk on the same server as the app, or its own small server?   | Same server, own container (D2)       |
| 2   | Trunk concurrent channel limit and CPS?                            | 30 channels, 2 CPS                    |
| 3   | Billing pulse: 60 s, 30 s or per second?                           | 60 s                                  |
| 4   | Charge for machine-detected calls?                                 | Charge only if `leave_message` played |
| 5   | AMD default per new campaign?                                      | Off                                   |
| 6   | Transfer: allowed numbers (any agent phone, or team members only)? | Team members' saved phones only       |
| 7   | Spend guard: SIP minutes per account per hour?                     | 600                                   |
| 8   | TLS / SRTP to the trunk if supported?                              | Yes when the trunk supports it        |
| 9   | Caller ID series (1600 for BFSI service calls) confirmed?          | 1600-series, from the client          |
| 10  | Calling hours ceiling 08:00–19:00 (Phase 16 item) confirmed?       | 09:00–19:00 kept                      |
| 11  | First production account on SIP                                    | Owner's test account only             |

---

## 8. What we need from the client

**Gate S (SIP trunk):**

1. SIP host / IP, port, transport (UDP / TCP / TLS).
2. Auth type: registration (username + password, sent securely, never in chat) or IP-based; our public IP to whitelist.
3. Trunk's signaling and media IP ranges (for the firewall).
4. Codecs offered (G.711 μ-law / A-law), DTMF mode (RFC 4733 / INFO / in-band).
5. Concurrent channel limit and calls per second.
6. Caller ID / DID numbers (1600-series), how they must be sent (From / P-Asserted-Identity), DLT principal entity details if needed.
7. Rate per minute, pulse, and how CDRs are shared (portal / CSV).
8. Whether transfer via REFER is allowed, or only a second call.
9. Test window and allowed test numbers.
10. Support contact at the trunk provider for one-way audio / registration issues.

**Gate P (still open from Phase 17):** SSH access to production, server audit, staging server, maintenance window.

---

## 9. Recommended order

1. T18.1 → T18.2 (lab up) → T18.3 → T18.4 → T18.5 → T18.6, with T18.17 scenarios growing alongside → **B1 checkpoint**.
2. T18.12 early in B2 (small, fixes flakes) → T18.7 → T18.8 → T18.13 → T18.10 → T18.9 → T18.11 → **B2 checkpoint**.
3. T18.14 → T18.15 → T18.16 → T18.19 → T18.21 → T18.18 / T18.20 when the gates open → T18.22 → **B3 sign-off**.

---

## Changelog

- 2026-11-03: plan drafted after Phase 17 sign-off, from `main` (backend `6b656bd`, frontend `60c5fe4`), ADR 0020 / 0022 / 0035 / 0036 / 0049, the T0.16 SIP lab notes, the current telephony code (`CallLeg.rate` 8 kHz ready, `sip` in `CALL_PROVIDERS`, `TELEPHONY_PROVIDER` dry run only) and the owner's request for fewer test runs (§6).
- 2026-11-03: run prompt written (`docs/prompts/PHASE_18_PROMPT.md`): literals locked (Asterisk 22 LTS, ports 5060 / 20000–20999 / 8088 / 21000–21999, migration 0019, errors +4 → 107, audit +6 → 173, notifications +2 → 38, ADR 0050), test policy §6 as rule 5.
- 2026-11-03: STEP 0. Plan locked; literals per run prompt §1 (ADR 0050 + 0022 Accepted, migration 0019, errors +4 → 107, audit +6 → 173, notifications +2 → 38, ports 5060 / 20000–20999 / 8088 / 21000–21999). Defaults in use for §7 #1–#11; test policy §6. **Gate S inputs: none** (`~/.cav-sip/` absent); Gate P still absent (Phase 17).
- 2026-11-03: P18-B1-DONE. T18.1–T18.6 + T18.17 part 1. Backend full suite once (no coverage): **result unknown** — the recorded exit code was the wrapper's, not the suite's, and the output file was lost with a scratchpad clean-up; Docker Desktop had also stopped, so Redis tests could not have passed. The B2 run is the first trustworthy full run of this phase. Frontend unchanged in B1, not re-run. `npm run test:sip` 10/10 on the Mac lab (two-way audio, busy, rejected, not found, trunk failure, ring-out, customer hangup, AMD machine / person, transfer). Deviations: the Asterisk image is the maintained `andrius/asterisk:22` base pinned by digest with our config on top (not a source build); one SIPp scenario plays every trunk case by the dialed number's last digit (no separate agent container); each process has its own ARI app (`cav-api`, `cav-worker`) because Call now runs in the API process; `SIP_PCMU_PASSTHROUGH` not built (the AI provider already takes PCM16 at 8 kHz; decided in T18.19 by CPU numbers). Found: Asterisk re-INVITEs the trunk for connected-line names (now off); a 0-second answered call charges nothing (existing pulse rule).
- 2026-11-03: T18.12. A hangup during an AI turn now waits up to 3 s (`CALL_LIMITS.turnGraceMs`) for the running turn and its tool calls, so the disposition / promise / callback they decide is kept; after the grace the session ends with an `error` event `turn_timeout`. Regression test failed before the fix. `calls/outbound`, `db/seed-calls` and `calls/ai-call` passed 3 / 3 each, files only: the Phase 17 wrong-number flake is closed.
- 2026-11-03: P18-B2-DONE. T18.7–T18.13. Backend full suite once (no coverage, real exit code recorded): 3,878 passed + 1 skipped, 6 failed in 5 files. Five were real gaps of this batch (phone numbers schema not imported by `src/openapi.ts`, no `DATA_MAP.md` row, `phoneNumbers` not listed as a platform pool in the tenant check, the assign route reading `accountId` from the body, the phase 2 migration test not stepping down 0019) — fixed in `2c4db6a`, those files re-run green (100 tests). The sixth, `calls-wa/leg-media` "10 legs in parallel", passed alone 9 / 9: a load flake (WhatsApp media, not Phase 18 code). `test:sip` 11 / 11 after T18.13. Decisions: pulse from the rate card with the account override (`SIP_BILLING_PULSE_SEC` dropped); after a transfer the call is billed until it ends; a declined call (603) ends `rejected_by_customer`, skip reason `rejected`, not retried; while ARI is down dials answer `LINE_BUSY` (campaigns wait). Hindi accuracy at 8 kHz: open item (no OpenAI key).
- 2026-11-03: P18-B3-DONE. T18.14–T18.22 (T18.18 / T18.20 open: Gate S / P). Sign-off numbers in [PHASE_18_SIGNOFF.md](PHASE_18_SIGNOFF.md) §2: backend 3,893 + 1 skipped green, coverage 95.95 / 87.17 / 95.34 / 97.51; frontend 1,481, coverage 95.84 / 92.04 / 93.03 / 96.53 with 9 load timeouts (pass alone); Playwright 170 / 170; `test:sip` 11 / 11; `perf:sip` 30 calls 0 % loss. `npm audit` 0 both repos; diff secret scan clean (fake test numbers only).
