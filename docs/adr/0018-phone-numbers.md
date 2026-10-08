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
