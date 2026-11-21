# ADR 0054: Meta call errors and resilient WhatsApp call setup

Date: 2026-11-21 · Status: accepted

## Context

Meta Graph failures on calls over Meta direct were logged on the server but did not reach the call record or panel. A failed inbound `pre_accept` also prevented the configured team or AI route from answering, and a failed reject could leave a caller ringing.

## Decision

- Preserve a masked Meta error message (maximum 300 characters), code, subcode, operation and trace id on call records and in a seven-day `metaCallErrors` diagnostic collection. The collection is throttled per number, operation and code.
- Show errors in call details and a superadmin list. Expose a read-only calling diagnose action; it never places a call.
- Treat `pre_accept` as optional by default. Continue inbound routing after it fails; a failed `accept` ends the call.
- Attempt `terminate` after a failed `reject` or after an outbound `connect` returned a call id.
- Normalize the exchanged SDP to one audio section, OPUS and optional telephone-event, Meta setup roles, CRLF, and the configured public media IP. Never store SDP.
- Apply additive migration `0033-meta-call-errors`; model indexes are also declared so reads/writes work before migration.

## Rollout

Deploy backend and frontend `main`; staging/release deployment runs `node dist/ops/migrate.js up` before starting the API (`deploy/staging/scripts/deploy.sh`). The client team pulls and rebuilds the released client repository. If they manage migrations manually, run migration `0033` before relying on TTL cleanup and indexed listing. No environment changes are required.

## Consequences

The panel can show the exact safe Meta message without server log access. Messages and trace ids are diagnostic data; phone-like digit runs are masked and rows expire after seven days. The public IP SDP adjustment only applies when `WA_MEDIA_PUBLIC_IP` is already configured.
