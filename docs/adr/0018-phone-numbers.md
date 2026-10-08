# 0018 — Phone numbers

- **Status:** accepted
- **Date:** 2026-10-08

## Context

Contacts arrive from Excel sheets in many formats (`98765…`, `+91 98765…`, `0987…`); SIP dialing and dedupe need one canonical format.

## Options considered

1. **E.164 + libphonenumber-js**.
2. **Raw strings** — duplicates and dial failures.

## Decision

Store phones in **E.164** (`+919876543210`), parse/validate with **libphonenumber-js**, default region **IN**.

## Consequences

- **Positive:** reliable dedupe and dialing.
- **Negative / trade-offs:** invalid rows must be reported on import.
- **Follow-ups:** Phase 3 import.

## Implementation (Phase 3)

- `normalizePhone(raw, accountCountry)` (`src/modules/contacts/normalize/phone.ts`): trims, strips a leading `'` and separators, `(0)`, `00` → `+`, and also accepts `919876…` (country code without `+`). Valid = `isValid()` (mobile and landline). Scientific notation (`9.87654E+09`) is reported as `phone_lost_digits` — Excel dropped digits — instead of guessing.
- Search matches the stored E.164 digits; leading `0` / `00` typed by users are ignored.
