# WCF sign-off — WhatsApp call errors and resilience

Release changes: backend migration `0033-meta-call-errors`; no environment variable changes. Production deployment runs migrations before API startup in `deploy/staging/scripts/deploy.sh` (`node dist/ops/migrate.js up`). For a manual client release, run the normal database migration command before rebuilding.

## Panel verification after release

| #   | Check                                                                  | Expected                                                                                |
| --- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | Number details → **Test calling API** (optionally enter a test number) | Each read-only check reports pass/fail and Meta code when available; no call is placed. |
| 2   | Call the number from another phone with AI off                         | The panel rings and an agent can answer, or a Meta error is visible.                    |
| 3   | Call again with AI on                                                  | AI answers, or an actionable error is visible.                                          |
| 4   | Outgoing **Call myself**                                               | Call connects, or popup shows Meta code and message.                                    |
| 5   | Admin → WhatsApp → **Meta call errors**                                | Failures include operation, code/message, trace id, number suffix and time.             |

Capture the displayed codes and `fbtraceId` for any failure. Do not send unmasked customer numbers or SDP.
