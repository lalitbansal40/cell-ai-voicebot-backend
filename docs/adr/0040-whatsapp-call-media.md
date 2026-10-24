# 0040 — WhatsApp call media: `werift` in our process, Opus via `opusscript` (WASM), the Phase 7 resampler, PoC passed

- **Status:** accepted
- **Date:** 2026-10-24

## Context

Phase 12 adds WhatsApp voice calls (Meta Calling API): user-initiated calls (UIC), business-initiated calls (BIC) after a call permission, agents in the browser and the AI voice pipeline on the same calls. Meta does not bridge to SIP for us; it hands over a WebRTC session: SDP offer / answer through Graph calls and the `calls` webhook, ICE-lite on Meta's side, DTLS-SRTP, Opus 48 kHz in 20 ms packets on one SSRC, DTMF as RFC 4733 `telephone-event/8000`. Meta ends a call after ≈ 20 s without media at the start and ≈ 30 s later in the call, so we must keep sending packets in silence. Our voice pipeline (Phase 7) works on PCM16 24 kHz `CallLeg`s. The plan (§1b) made a loopback proof of concept the gate for everything else in Phase 12.

## Options considered

1. **`werift` (pure TypeScript WebRTC) in the API / worker process, Opus native (`@discordjs/opus`)** — no extra service, full control over RTP; the native build is a risk on Node 24 and in CI.
2. **`werift` + Opus via `opusscript` (libopus compiled to WASM / asm.js)** — same as 1 without a native build; a little more CPU than native.
3. **Browser relay** (the agent's browser holds the WebRTC session with Meta, our server only signals) — no server media, but no AI on WhatsApp calls, no recording and the call dies with the tab. Plan B.
4. **A SIP / media server (FreeSWITCH / Janus) between Meta and us** — mature media, but a new service to run, scale and secure, and Meta's WebRTC still has to be terminated there.

## Decision

Option 2.

- **Library:** `werift@0.25.0` (exact pin). One `RTCPeerConnection` per call (`src/core/telephony/whatsapp/peer.ts`): full ICE, controlling (Meta is ICE-lite), `BUNDLE` + `rtcp-mux`, one SSRC, Opus PT 111 `48000/2` `minptime=10;useinbandfec=1` with `a=ptime:20` added to what we send (werift does not write it), `telephone-event/8000` PT 126, UDP only, IPv4 only, a self-signed **ECDSA P-256** certificate created once per process by werift. Gathering is complete before the SDP leaves us (no trickle: Meta takes one SDP).
- **Codec:** `opusscript@0.1.1` behind `codec.ts` (`createOpusCodec()` → `encode` / `decode` / `destroy`), mono 48 kHz, 20 ms frames, VoIP mode, 24 kbps; an empty packet (loss) decodes to one frame of silence. The native `@discordjs/opus` was tried first and **crashed (exit 139) or hung on Node 24** on macOS; it is not a dependency (no install script, nothing to build in CI).
- **Resampling:** the Phase 7 `Resampler` (`src/core/voice/audio/resample.ts`) for 48 ⇄ 24 kHz, wrapped in `resample.ts` (`LEG_RATE = 24_000`). Tests: 440 Hz / 1 kHz frequency error < 1 %, level ± 1 dB, no clicks at 20 ms frame joins.
- **DTMF:** RFC 4733 in `dtmf.ts` (one packet every 20 ms while held, three end packets, same timestamp; the receiver reports a digit once per timestamp). werift rewrites every outgoing packet to the primary codec's payload type, so telephone-event packets go straight to the sender's DTLS transport with the same SSRC and sequence space.
- **SDP:** `sdp.ts` reads only the shape (`describeSdp`) and gives a log-safe summary (`scrubSdp`); the raw SDP, ICE credentials, candidates and fingerprints are never logged.
- **Keep-alive:** we send an Opus packet every 20 ms for the whole call, silence included (an encoded silent frame, not DTX), from the moment the session connects; a stalled source sends silence.
- **NAT / ports:** prod binds UDP on `0.0.0.0` in `WA_MEDIA_PORT_MIN`–`WA_MEDIA_PORT_MAX` (40000–40999) and adds `WA_MEDIA_PUBLIC_IP` as a host candidate (1:1 NAT; the firewall opens that UDP range); `WA_STUN_URLS` only when the public IP is not known. No TURN: Meta is reachable on public addresses and runs ICE-lite. Tests bind `127.0.0.1` only (no network).
- **DTLS role:** in BIC we offer `setup:actpass` and Meta answers `setup:active`, so **Meta is the DTLS client** there; in UIC we answer Meta's offer with `setup:active` and are the client. The plan said "we are the DTLS client" for both — recorded as a deviation; werift follows the SDP either way.

### PoC numbers (`npm run poc:wa-call`, MacBook, Node 24, loopback 127.0.0.1)

Our peer ⇄ a Meta-like ICE-lite werift peer whose answer has the shape of Meta's documented SDP (`tests/fixtures/meta/calls-sdp-answer.txt`, checked by a test): 1 kHz one way, 440 Hz the other (Goertzel), DTMF `1 2 3`, silence keep-alive, close.

| Check                                     | Target (plan §1b) | Result                                                                                     |
| ----------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------ |
| Sequential runs (tone both ways + DTMF)   | 20 / 20           | **20 / 20**                                                                                |
| Setup (offer → connected)                 | ≤ 500 ms          | median **141 ms** (1 call), 181 ms (10), 221 ms (20)                                       |
| Keep-alive, 30 s silence                  | stays connected   | **1,500** packets received, still connected                                                |
| Parallel 1 / 10 / 20 calls                | all pass          | **1 / 1, 10 / 10, 20 / 20**                                                                |
| CPU per call (our side, % of one core)    | ≤ 3 %             | 5.0 % (1 call, incl. fixed process cost), **1.9 %** (10), **1.1 %** (20); marginal ≈ 0.9 % |
| Memory per call                           | ≤ 30 MB           | **≤ 5.7 MB**                                                                               |
| Encode → network → decode, each direction | —                 | median **0.5–0.7 ms**                                                                      |
| Jitter (RFC 3550 style)                   | —                 | median **0.25–0.41 ms**                                                                    |
| Added delay (decode → runtime → encode)   | ≤ 40 ms           | one 20 ms frame + Opus look-ahead (2.5 ms) + resampler taps ≈ **23 ms**                    |

The single-call CPU figure includes the process's fixed cost (timers, JIT, the second peer's share of the event loop); the per-call cost at 10 and 20 calls, which is what sizing needs, is within target. The `/ws/media` bridge delay (target ≤ 150 ms) is measured with the call leg in T12.4. No test number with calling exists, so the real-Meta check is a Phase 13 step (plan changelog).

**Plan B condition:** if Meta's real SDP / DTLS / ICE does not connect with werift in Phase 13 and cannot be fixed within the phase, human calls switch to the browser relay (option 3) and AI WhatsApp calls move to Phase 18. Not triggered.

## Consequences

- **Positive:** no media service to run; AI and humans use the same `CallLeg` path; pure JS / WASM dependencies, so `npm ci` works the same on macOS and Linux CI; one process holds dozens of calls (≈ 1–2 % CPU, ≈ 1–6 MB each).
- **Negative / trade-offs:** media runs on the Node event loop — a long synchronous job delays packets, so call media stays in the API process with nothing heavy on it, capped by `WA_MEDIA_MAX_CALLS` (50); WASM Opus uses more CPU than native; the DTMF send path relies on werift internals (covered by the loopback test, re-check on every werift upgrade); werift is a smaller project than libwebrtc.
- **Follow-ups:** real Meta BIC / UIC check in Phase 13 (steps in the plan changelog); watch per-process call counts and event-loop lag in staging; revisit a native Opus build only if CPU becomes the limit.
