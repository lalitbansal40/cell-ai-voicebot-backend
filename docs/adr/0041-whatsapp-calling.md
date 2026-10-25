# 0041 — WhatsApp calling: Meta's permission as the source of truth, the Phase 7 session for every call, a Redis call-control bus, pulse billing on Meta's duration

- **Status:** accepted
- **Date:** 2026-10-25

## Context

Phase 12 adds WhatsApp voice calls on top of the media stack of ADR 0040. Customers call the business (user-initiated, free at Meta) and the business calls customers who allowed it (business-initiated, billed by Meta per 6-second pulse at a per-minute rate of the customer's market). Calls are answered by a team member in the browser or by an AI program (agent or flow), and an AI call may hand over to a team member. A call's media lives in one process (the WebRTC session), while HTTP requests, webhooks and agents' browsers can reach any API instance. Meta changes call permissions, limits and restrictions on its side and tells us only part of it by webhook.

## Options considered

1. **Our own permission state as the gate** — fast, but Meta refuses calls our row allows (expired, revoked in the app, limits) and we would charge holds for calls that cannot happen.
2. **Meta's `GET call_permissions` before every call / request (cached 60 s), our row for the UI and history** — one Graph call per dial, always right.
3. **A separate session type for WhatsApp calls** — free to differ, but recording, transcripts, holds, extensions, polite ends and the AI hosts would be written twice.
4. **The Phase 7 `CallSession` with a `WhatsAppCallLeg`** — everything Phase 7 does works on WhatsApp calls; the differences live in the leg and the calls service.
5. **Sticky sessions for call control** — needs a load balancer feature and breaks on restarts.
6. **A Redis call-control bus** — owners by key with TTL, commands by pub / sub to the owning node, claims with `SET NX`.

## Decision

Options 2, 4 and 6.

- **Permissions:** `whatsappCallPermissions` per account × number × contact holds the UI state (`none / requested / temporary / permanent / declined / expired / revoked`), our request counters (1 / 24 h, 2 / 7 days), the unanswered streak (2 → nudge, 4 → revoked, like Meta) and the history. Every business-initiated dial and every request asks Meta first (`call_permissions`, 60 s Redis cache); Meta's "no" wins over our row. Requests go as the interactive `call_permission_request` inside the 24 h window and as the approved call-permission template outside it; replies (`call_permission_reply`, also `automatic` from callback permission) update the row and the request bubble. An hourly sweep expires temporary permissions (Meta sends no webhook).
- **Dial guard** (`dial-guard.ts`), first failure wins: the number (WhatsApp on, connected, calling enabled and available, country, restrictions) → the account (active, not impersonating) → the customer (not deleted / DND / opted out / blocked) + the TRAI calling window → one live call per customer, the account's concurrent calls, this process's media capacity → a runnable AI program → Meta's permission. The wallet is the hold itself.
- **Sessions:** every call is a Phase 7 `CallSession` on a `WhatsAppCallLeg`. Agent calls run `BridgeScript` (customer ⇄ agent's browser leg, keypad as RFC 4733, hold line); AI calls run the Phase 7 program; `HandoffScript` swaps the AI script for the bridge in the same session (one recording, one transcript) when an AI transfer is taken. Ring timeouts use the session's new `answerTimeout`.
- **Inbound routing:** a user-initiated `connect` is claimed by exactly one node with capacity (`claimInbound`), matched to a contact by phone, then BSUID (never invented), pre-checked (account active, calling enabled, no user-side restriction, our call hours, AI wallet) — a refusal rejects at Meta and leaves a missed bubble. We `pre_accept` at once with our answer SDP and `accept` with the same SDP: AI routes accept immediately; team routes ring the eligible users (`calls.answer`, available, online by the Redis presence leases, not busy, the ring list, ≤ 50) by per-user events; the first `answer` wins twice over (an agent can hold one call, `claimAgent`; the ring's `claimAnswer`), Meta's `accept` waits for the winner's media socket; decline removes one user; the ring timeout (≤ Meta's deadline) rejects → missed bubble + bell to the ring list.
- **Call-control bus** (`bus.ts`): `call:wa:owner:<waCallId>` / `call:node:<callId>` with TTL + heartbeat, `call:ctl:<node>` / `call:ctl:inbound` channels on a dedicated subscriber. Webhooks go to the owner (fast path from the receiver, the worker as backup, applied once per event); agent actions are request / reply commands to the owner (10 s timeout); hangups work from any process for every provider. A node that stops refreshing loses its calls: after `ownerTtlSec` a survivor fails them `server_shutdown` and terminates them at Meta.
- **Billing:** pure pulse math in `core/billing/whatsapp-calls.ts` — `pulses = ceil(duration / 6)`, per pulse = per-minute ÷ 10 (rounded up to the micro), selling = paise-rounded (Meta × (1 + markup)) or the account's fixed per-minute price, plus the paise-rounded platform fee; customer-pays numbers pay the fee only; user-initiated calls nothing at Meta. The calling rate card (`kind: calling`, base tier per market; cheaper volume tiers are our margin) in force at dial, the platform `whatsappCalling` settings and the account override make the quote. A business-initiated call holds `holdMinutes` at dial (+ the Phase 7 AI hold on AI calls), extends with the session, and settles on **Meta's terminate `duration`**; if it is late, after `lateTerminateGraceSec` on our measured talk time (`durationSource: ours`, a ledger note), and the hourly reconcile stores Meta's late pulses beside ours for the margin report — no money moves after a settle. A stale-hold reaper releases holds of calls whose process died; the Phase 4 / Phase 11 reapers never touch `whatsapp_call_charge` rows.

## Consequences

- **Positive:** one session code path for web, phone and WhatsApp calls; Meta can never be dialled against its own permission answer; any API instance can serve any request about any call; a dead process costs the customer nothing beyond the talk time Meta measured.
- **Negative / trade-offs:** one Graph call per dial (cached 60 s); a call's media cannot move to another node (a node restart ends its calls politely); the margin depends on Meta's volume tiers we do not see per call; presence is per socket lease (up to 90 s stale after a crash).
- **Follow-ups:** Phase 13 runs the real-device checklist (setup guide §15) and measures latency on real phones; Phase 17 places media nodes with public UDP ranges (`WA_MEDIA_PORT_MIN–MAX`, `WA_MEDIA_PUBLIC_IP`); calling analytics feed the reconciliation once Meta exposes per-call costs.
