# ADR 0052: Superadmin full access and WhatsApp calling (Meta direct, scheduled AI calls, AI incoming)

**Status:** Accepted (SAC, 21 Nov 2026) · Plan: [SUPERADMIN_AND_WA_CALLING_PLAN.md](../plans/SUPERADMIN_AND_WA_CALLING_PLAN.md) · Prompt: [SUPERADMIN_WA_CALLING_PROMPT.md](../prompts/SUPERADMIN_WA_CALLING_PROMPT.md)

## Context

The platform team must be able to work in any customer account exactly like its owner (support, setup, calls). Login-as `view` / `act` (Phase 19) kept 18 sensitive routes and WhatsApp calls blocked. WhatsApp calling needed one-click actions in the inbox (call myself, call with AI, schedule an AI call), a simple "AI answers incoming calls" switch, a webhook that is set and verified at onboarding, and a path for partner (Pinnacle) numbers to use the Meta Graph API directly.

## Decision

**Full access login-as.** A third mode `full` (superadmin only, `LOGIN_AS_FULL_ENABLED`): 4 h, extendable in 4 h steps up to 12 h (`ims` claim keeps the start). `blockWhenImpersonating` and `blockSensitiveWhenImpersonating` pass for `full`. Danger actions (account export / delete, contact erase, ownership transfer, owner password / sessions, API key create / change) add `requireStepUp()`: the superadmin's own password + two-step code, good for 5 min per session (Redis). The step-up replaces the owner's password re-check in those services. A password change in full access returns a login-as token, never an owner session. Real money (Razorpay top-up) stays refused (`WALLET_TOPUP_IMPERSONATION`). Writes record the superadmin next to the owner (`calls.actedBy`, `messages.sentByImpersonator`, `campaigns` / `whatsappCampaigns.createdByImpersonator`, audit `impersonatorId`).

**Ringing.** WebSocket tickets of a login-as session carry `sessionId` + `impersonatorId`. Such sockets are not "online" for ringing (presence member `<user>:imp:<session>:<socket>`) and skip ring events (`notifyRing` → `pushToUser({ ringSessions })`), unless the session turned on **Ring me too**.

**Meta webhook check.** Onboarding subscribes our app (`POST /{waba}/subscribed_apps`) and checks `GET /{waba}/subscribed_apps` + `GET /{app}/subscriptions` (`messages`, `calls` needed). A missing field is repaired with `POST /{app}/subscriptions` (all `WEBHOOK_FIELDS`). A failure never blocks the number (it stays `connected`; `webhookCheck.status = failed` shows on the card). **Webhook check / Fix** runs it on demand (6 / 10 min / number, admin twin); Sync / the daily pass only check, ring the bell on ok → failed and feed healthwatch `wa-webhook-missing`.

**AI answers incoming calls.** The switch maps onto the existing routes (`ai_then_team` / `ai` / `team`, advanced `team_then_ai`). An AI route needs a runnable program, call audio on the server, wallet money and calling on. At the call, if the AI can't start (wallet, program, engine) the team is rung; nobody → missed call with a callback task (`calls.missed`, now also for WhatsApp). An account default (`settings.waIncoming`) seeds new numbers. **Stop live AI calls** ends every AI call of a number over the call bus.

**Scheduled AI calls.** `whatsappScheduledCalls`. Placed by a 15 s runner in the process that owns call media (not a BullMQ worker, which has no media): rows are claimed `scheduled → dispatching` with a conditional update; each try's call is unique by `(scheduledCallId, attempt)`, so a replay returns the same call. At its time the normal dial guard runs again; outside the calling window it moves once to the next opening, a full line puts it back 5 min (3×), any other refusal skips it with a reason (bell, chat line, webhook `whatsapp_call.scheduled_skipped`). Retries (0–2) on `no_answer` / `busy` / `failed`. The AI agent's `schedule_callback` becomes a scheduled call (`origin: ai_callback`) when the agent has the tool on.

**Partner number → Meta direct.** Our Embedded Signup for the same WABA and number reuses `connect()` on the same channel row (ids kept); the partner credit line stays the payer (`attached`, ours is never attached), the partner webhook is cleared best-effort, partner facts are archived.

**Calling hardening.** `metrics.firstAudioMs` (answer → first word) and healthwatch `wa-ai-latency-high` (p95 > 2.5 s, 30 min). A connect Meta never answered (timeout / 5xx) is never redialed; a late status carrying our call id (`biz_opaque_callback_data`) is terminated. Optional TURN relay (`WA_TURN_*`).

## Consequences

- A superadmin can do anything the owner can, with a step-up for irreversible actions and every write audited.
- New collections / fields are additive (migrations 0029–0031).
- Scheduled calls depend on the media process running; with several media processes the claim keeps each try exactly once.
- Pinnacle must not answer `calls` events of a number subscribed to both apps (open question to the partner).
