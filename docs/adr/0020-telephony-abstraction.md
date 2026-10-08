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
