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

## Consequences

- **Positive:** decision made with real trunk constraints.
- **Negative / trade-offs:** none now.
- **Follow-ups:** T0.16 lab notes; Phase 13.
