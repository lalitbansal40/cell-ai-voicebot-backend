# 0022 — SIP media server

- **Status:** deferred
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

## Consequences

- **Positive:** decision made with real trunk constraints.
- **Negative / trade-offs:** none now.
- **Follow-ups:** T0.16 lab notes; Phase 13.
