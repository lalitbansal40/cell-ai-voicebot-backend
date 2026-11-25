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

## Live findings (21–25 Nov 2026)

- **Incoming:** the calls fast path picked the disconnected "Cell24x7" row of +91 87797 21034 (the same phone number id as the managed "Cell").
  - So the call ended as `calling_restricted`, and `calls.terminate` failed with `AppError` (no token on that row).
  - Fixed: `inboundChannelFor` takes the active row only.
- **Outgoing:** `calls.connect` → Meta `10 / 2593180` "You do not have the necessary permissions required to send messages on behalf of this WhatsApp Business Account".
  - Our Tech Provider app has read / manage access to the partner's WABA, not "send on behalf". Code can't fix it.
  - Meta side: App Review → `whatsapp_business_messaging` **Advanced access**, and a **Multi-Partner Solution** with Pinnacle for this WABA (then Calling off → Calling on karo again).
  - **Test calling API → send** shows it.
