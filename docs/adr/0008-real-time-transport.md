# 0008 — Real-time transport

- **Status:** accepted
- **Date:** 2026-10-08

## Context

The dashboard needs live events (call status, transcripts, campaign progress) and the Web Call Tester streams binary audio between browser and backend.

## Options considered

1. **`ws`** — minimal, binary-friendly, used in AutoChatix.
2. **socket.io** — rooms/reconnect built-in, but extra protocol overhead and awkward for raw audio.

## Decision

**`ws`** with two endpoints: `/ws/events` (JSON event envelope `{type, data, ts}`) and `/ws/media` (binary audio for web calls). Auth via token on connect; account-scoped rooms implemented in-house (AutoChatix `pushToAccount` pattern).

## Consequences

- **Positive:** low overhead, one library for events + audio.
- **Negative / trade-offs:** reconnect/rooms written by us.
- **Follow-ups:** event catalogue in T0.11; implementation Phase 1/7.
