# 0017 — Dates & timezones

- **Status:** accepted
- **Date:** 2026-10-08

## Context

Calling windows (e.g. 9am–7pm), schedules and reports depend on the account's local time; storage must be unambiguous.

## Options considered

1. **UTC storage + account timezone + date-fns/@date-fns/tz**.
2. **moment-timezone** — legacy, large.
3. **dayjs + plugins** — fine, but tz plugin is weaker.

## Decision

Store and transmit **UTC ISO-8601**; each account has a timezone (default **`Asia/Kolkata`**); use **date-fns** + **@date-fns/tz** for tz math.

## Consequences

- **Positive:** correct calling windows across DST/timezones.
- **Negative / trade-offs:** none significant.
- **Follow-ups:** Phase 2 account settings.
