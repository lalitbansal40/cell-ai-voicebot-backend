# 0020 — Telephony abstraction

- **Status:** accepted
- **Date:** 2026-10-08

## Context

SIP details are pending from the client, but most of the product must be built and tested now. NotifyNow broadcast APIs may also be useful as a fallback.

## Options considered

1. **`TelephonyProvider` interface with multiple implementations**.
2. **Hard-code SIP** — blocked until client answers.

## Decision

Define a **`TelephonyProvider`** interface (`startCall`, `answer`, `hangup`, `playAudio`, `onDtmf`, `onAudio`, `transfer`, …) with implementations: **WebCall** (browser mic, for development/testing), **SIP** (Phase 13), **NotifyNow** (optional broadcast fallback).

## Consequences

- **Positive:** ~75% of the product buildable before SIP details arrive.
- **Negative / trade-offs:** interface must be designed carefully up front.
- **Follow-ups:** Phase 7 (interface + WebCall), Phase 13 (SIP).

## Update — Phase 7 (2026-10-15)

Built: `CallLeg` (`core/telephony/types.ts`) and `WebCallLeg` over `/ws/media` (PCM16 24 kHz, 20 ms frames, pacer with clear for barge-in, DTMF, typed text in dev, transfer prompt answered in the browser). The runtime above it is [ADR 0035](0035-voice-runtime.md). SIP stays Phase 13 (ADR 0022) on the same interface at μ-law 8 kHz.
