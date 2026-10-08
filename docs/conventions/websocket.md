# WebSocket Conventions

Real-time channels between the backend and the dashboard. Library: `ws` ([ADR 0008](../adr/0008-real-time-transport.md)).

**Golden rule:** WebSocket events are **notifications**. The source of truth is always the REST API — after a reconnect the client refetches what it shows.

---

## 1. Endpoints

| Endpoint     | Frames                           | Purpose                                                                        |
| ------------ | -------------------------------- | ------------------------------------------------------------------------------ |
| `/ws/events` | JSON text                        | Dashboard live updates (call status, campaign progress, wallet, notifications) |
| `/ws/media`  | Binary audio + JSON text control | Web Call Tester — browser mic ⇄ voice runtime (Phase 7)                        |

## 2. Authentication — single-use tickets

JWTs are **never** put in a WebSocket URL (URLs end up in proxy/server logs).

1. Client calls `POST /api/v1/ws/tickets` with `Authorization: Bearer <accessToken>` (optional body `{ "channel": "events" | "media" }`).
2. Server returns `{ "ticket": "wst_…", "expiresAt": "…" }` — random, **single-use**, valid **60 seconds**, stored in Redis with the user + account.
3. Client connects: `wss://<host>/ws/events?ticket=wst_…`.
4. Server consumes the ticket (deletes it); invalid/expired → close `4001` / `4010`.

## 3. Server → client envelope

```json
{
  "id": "evt_01J9…",
  "type": "call.status",
  "ts": "2026-10-08T06:30:00.000Z",
  "data": { "callId": "66f1…", "status": "ringing" }
}
```

- `type` is `domain.action`, lower case.
- `id` is unique per event (lets the client de-duplicate).

## 4. Client → server messages

```json
{ "type": "ping" }
{ "type": "subscribe", "topics": ["campaign:66f1…", "call:66f2…"] }
{ "type": "unsubscribe", "topics": ["call:66f2…"] }
```

- Account-level events (call status, campaign status, wallet, notifications) are delivered automatically to every connection of the account.
- Heavy streams (live transcript, campaign progress) are delivered only to connections **subscribed** to that topic.
- Topics are validated against the account — subscribing to another account's resource is silently ignored and logged.

## 5. Event catalogue

| Type                   | When                                             | `data`                                                                                                            | Topic             |
| ---------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ----------------- |
| `call.created`         | A call is created (queued)                       | `{ callId, direction, to, campaignId? }`                                                                          | account           |
| `call.status`          | Call status changes                              | `{ callId, status }` — `queued \| ringing \| in_progress \| completed \| failed \| busy \| no_answer \| canceled` | account           |
| `call.transcript`      | A transcript turn is produced / finalised        | `{ callId, seq, speaker, text, final }`                                                                           | `call:<id>`       |
| `call.dtmf`            | A key press is received                          | `{ callId, digit }`                                                                                               | `call:<id>`       |
| `call.ended`           | Call finished and costed                         | `{ callId, durationSec, disposition, costMicros }`                                                                | account           |
| `campaign.status`      | Campaign status changes                          | `{ campaignId, status }`                                                                                          | account           |
| `campaign.progress`    | Counters change (throttled ≤ 1/sec per campaign) | `{ campaignId, stats }`                                                                                           | `campaign:<id>`   |
| `wallet.updated`       | Balance / hold changes                           | `{ balanceMicros, holdMicros, currency }`                                                                         | account           |
| `wallet.low_balance`   | Available balance crosses the threshold          | `{ availableMicros, thresholdMicros }`                                                                            | account           |
| `import.progress`      | Contact import progresses                        | `{ importJobId, processed, total, status }`                                                                       | account           |
| `notification.created` | New in-app notification                          | `{ notificationId, title }`                                                                                       | account (or user) |
| `presence.changed`     | A team member goes online/offline                | `{ userId, status }`                                                                                              | account           |

New events must be added to this table in the same PR that emits them.

## 6. Keepalive & reconnect

- Client sends `{ "type": "ping" }` every **25 s**; server replies `{ "type": "pong" }`.
- Server closes a connection after **60 s** without any message.
- Reconnect with exponential backoff + jitter: 1 s → 2 s → 4 s → … capped at 30 s. Each reconnect gets a **new ticket**.
- After reconnect the client refetches the data on screen via REST (events missed while offline are not replayed).

## 7. Close codes

| Code   | Meaning                                        |
| ------ | ---------------------------------------------- |
| `1000` | Normal close                                   |
| `1001` | Server going away (deploy/restart) — reconnect |
| `4001` | Unauthorized (missing/invalid ticket)          |
| `4003` | Forbidden                                      |
| `4008` | Policy violation / rate limited                |
| `4009` | Too many connections                           |
| `4010` | Ticket expired                                 |

## 8. `/ws/media` — Web Call protocol (Phase 7)

**Text frames (JSON control):**

| Direction       | Message                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| client → server | `call.start { flowId? , agentId?, contactId?, variables? }` (exactly one of `flowId` / `agentId`)     |
| server → client | `call.started { callId }`                                                                             |
| client → server | `call.dtmf { digit }`                                                                                 |
| client → server | `call.hangup {}`                                                                                      |
| server → client | `call.transcript { seq, speaker, text, final }`, `call.event { type, data }`, `call.ended { reason }` |
| server → client | `audio.clear {}` — barge-in: client must flush its playback buffer immediately                        |

**Binary frames (audio), both directions:**

- **PCM16 little-endian, mono, 24 kHz**, **20 ms** per frame = **960 bytes**.
- Telephony (SIP) audio is G.711 μ-law 8 kHz; conversion happens server-side in the audio bridge, never in the browser.

## 9. Limits (initial — tuned in Phase 1/7)

| Limit                      | Value                                 |
| -------------------------- | ------------------------------------- |
| Max text message size      | 64 KB (events), 32 KB per media frame |
| Connections per user       | 5                                     |
| Connections per account    | 50                                    |
| Client messages per second | 20 (events), audio frames exempt      |
