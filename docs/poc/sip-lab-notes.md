# SIP Lab Notes (T0.16)

**Result: ✅ the full chain works locally** — SIP call → Asterisk → ARI app → ExternalMedia RTP into Node, with DTMF. Run: `poc/sip-lab/run-lab.sh` ([README](../../poc/sip-lab/README.md)). Date: 2026-10-08.

## 1. What was proven

| Check                                                                                                     | Result                                                                                             |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| SIP INVITE from SIPp answered by Asterisk and handed to ARI (`Stasis(cav-lab)`)                           | ✅ `StasisStart` ~2.1 s after lab start                                                            |
| ARI control from Node (answer, play, bridge, ExternalMedia, hangup) over REST + events WebSocket          | ✅                                                                                                 |
| **ExternalMedia** channel streams call audio as RTP (G.711 μ-law, payload type 0) to a UDP socket in Node | ✅ **142 RTP packets = 2.84 s** of caller audio received, first packet 25 ms after bridging        |
| DTMF reaches the app (`ChannelDtmfReceived`)                                                              | ✅ digits `5`, `7` (sent as SIP INFO)                                                              |
| App-initiated hangup → BYE to the caller                                                                  | ✅ SIPp: 1 successful call                                                                         |
| Echo-back (bonus): app sends received RTP back to Asterisk                                                | ⚠️ 142 packets **sent**; delivery to the caller not verified (SIPp does not record received audio) |

Caller audio before the bridge existed (~0.8 s while the beep played) is not forwarded — expected: ExternalMedia only carries audio once it is bridged.

## 2. Versions / images

| Component    | Version                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------- |
| Asterisk     | 20.20.1 LTS — `andrius/asterisk:20` (arm64 + amd64)                                       |
| SIPp         | 3.7.7 (TLS, SCTP, PCAP) — built from Alpine 3.24 packages (`poc/sip-lab/sipp/Dockerfile`) |
| Node ARI app | Node 24 + `ws`; plain `fetch` for ARI REST (no `ari-client` library)                      |

## 3. Problems found and fixes

| Problem                                                                                                                    | Fix                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Public SIPp images are from 2017 and amd64-only; Debian trixie/bookworm have **no** `sipp` package                         | Build from Alpine (`apk add sipp`)                                                                      |
| Asterisk image ships **no English sound files** (`sound:hello-world` unavailable)                                          | Use `tone:` media for the beep; production prompts will be our own TTS/audio files                      |
| `host.docker.internal` resolves to **IPv6 first**; `external_host` must be `host:port` → ARI 400                           | Resolve with `getent ahostsv4`                                                                          |
| `tone:440/700` is a **repeating cadence**; a channel with an active playback can't join a bridge → `addChannel` hung ~43 s | Stop the playback (`DELETE /playbacks/{id}`) before bridging; start the hangup timer right after answer |
| SIPp DTMF via RFC 2833 needs pcap files                                                                                    | Lab uses **SIP INFO** DTMF (`dtmf_mode=info`); real trunks use RFC 4733 — test in Phase 13              |
| Docker Desktop (macOS) proxies UDP: RTP arrives from `127.0.0.1:<random>`                                                  | Works for the lab; for softphone tests use a Linux VM. Production runs on Linux with real IPs           |

## 4. Asterisk vs FreeSWITCH (desk comparison — confirm in Phase 13 PoC)

| Criterion                | Asterisk (ARI + ExternalMedia / AudioSocket)                             | FreeSWITCH (ESL + mod_audio_stream / mod_audio_fork)                                              |
| ------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Node integration         | ARI = REST + WebSocket, JSON — trivial from Node (proven here)           | ESL = TCP event socket; audio-to-WebSocket needs a separate module (not in core for every distro) |
| Audio out to our runtime | ExternalMedia (RTP/UDP or AudioSocket TCP) **built in** since 16.6 / 18  | `mod_audio_stream` / `mod_audio_fork` community modules (build/licence to check)                  |
| Docs & community         | Very large, ARI well documented                                          | Large; strong telecom-carrier usage                                                               |
| Concurrency              | Comfortable for hundreds of concurrent calls per box; scale horizontally | Known for higher per-box concurrency and media performance                                        |
| Licensing                | GPLv2 (we only run it, not distribute)                                   | MPL 1.1                                                                                           |
| Ops                      | Simple config files; LTS 20/22                                           | More complex config (XML); SignalWire packaging changes to verify                                 |
| Lab effort               | Working in < 1 day                                                       | Not tried                                                                                         |

**Recommendation for ADR 0022:** prefer **Asterisk (ARI + ExternalMedia)** for Phase 13 — proven end to end here, simplest Node integration, built-in audio streaming. Revisit FreeSWITCH only if load tests on the client trunk show Asterisk cannot meet the required concurrency.

## 5. Phase 13 checklist (real SIP trunk)

- [ ] Trunk auth: registration (`type=registration`) **or** IP-based `identify` for the client's SBC IPs.
- [ ] NAT on EC2: `external_media_address` + `external_signaling_address` = public IP 13.232.191.62; `local_net` = VPC CIDR.
- [ ] Codecs: `allow=ulaw,alaw` (match trunk; G.711 lets audio go to OpenAI `audio/pcmu` without resampling).
- [ ] RTP port range (e.g. 10000–20000) + AWS security group: SIP 5060/5061 and RTP **only from trunk IPs**.
- [ ] DTMF: `dtmf_mode=rfc4733` (fallback `auto`); test with real handsets.
- [ ] Caller ID / DID per account; inbound DID → flow routing (Phase 14).
- [ ] Transfer to human: `REFER` or bridge to an outbound leg; test with the client's agents.
- [ ] Concurrency limit = trunk limit; enforce in the call queue (Phase 8).
- [ ] ExternalMedia ↔ voice runtime: one RTP port per call; jitter buffer; barge-in → clear queued audio.
- [ ] Media server hardening: no guest calls, `allowguest=no`, fail2ban-style protection, TLS/SRTP if the trunk supports it.
- [ ] Monitoring: call counts, RTP loss/jitter, ARI connection health; restart policy.
- [ ] Load test up to the trunk limit (SIPp in UAC mode against the staging trunk).
- [ ] Isolation on the client server: own containers/ports; do not disturb the existing application.
