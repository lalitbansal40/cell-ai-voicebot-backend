# 0022 — SIP media server

- **Status:** accepted (Phase 18, 2026-11-03)
- **Date:** 2026-10-08

## Context

Live calls over the client's SIP trunk need a media server that terminates SIP/RTP and streams audio to our Node runtime.

## Options considered

1. **Asterisk (ARI + ExternalMedia/AudioSocket)** — Node-friendly control API.
2. **FreeSWITCH (ESL + mod_audio_stream)** — strong at high concurrency.

## Decision

**Deferred** to the Phase 13 PoC, informed by the T0.16 local SIP lab, once client SIP details are known.

### Lab finding (T0.16, 2026-10-08)

The local lab ([sip-lab-notes.md](../poc/sip-lab-notes.md)) proved **Asterisk 20 + ARI + ExternalMedia** end to end: SIPp call → ARI app in Node → 142 RTP packets (μ-law) received + DTMF. **Recommendation: Asterisk (ARI + ExternalMedia)** for Phase 13; status stays `deferred` until the real client trunk is tested.

### Phase 18 decision (2026-11-03)

**Asterisk 22 LTS, ARI + ExternalMedia over RTP/UDP.** Proven in the T0.16 lab; ARI is plain REST + WebSocket from Node; ExternalMedia is built in. RTP (not AudioSocket) keeps codec, jitter and loss handling in our code, where the WhatsApp media path already does the same work. AudioSocket (TCP) is the fallback if UDP on the host is a problem. FreeSWITCH is revisited only if the Phase 18 load test (T18.19) misses the trunk limit. Placement, ports and limits: [ADR 0050](0050-sip-shared-server.md).

## Consequences

- **Positive:** one media server we have run end to end; no native Node modules (G.711 in TypeScript).
- **Positive (earlier):** decision waited for real trunk constraints.
- **Negative / trade-offs:** none now.
- **Follow-ups:** T0.16 lab notes; Phase 13.
