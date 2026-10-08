# 0016 — Money representation

- **Status:** accepted
- **Date:** 2026-10-08

## Context

Per-second call billing and AI token costs produce tiny fractional amounts; floats cause rounding errors in a ledger.

## Options considered

1. **Integer micro-units** (₹1 = 1,000,000) — exact, AutoChatix-proven.
2. **Decimal128** — exact, but awkward in JS.
3. **Floats** — rounding errors.

## Decision

All money stored and transmitted as **integer micro-units** (`MONEY_SCALE = 1_000_000`), field suffix **`Micros`**, with a separate `currency` field. Floats are never used for money. Conversion to display units only in the UI.

## Consequences

- **Positive:** exact arithmetic, consistent with AutoChatix wallet.
- **Negative / trade-offs:** must remember to convert at UI edges.
- **Follow-ups:** Phase 4 wallet.
