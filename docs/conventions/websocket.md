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

1. Client calls `POST /api/v1/ws/tickets` with `Authorization: Bearer <accessToken>` (optional body `{ "channel": "events" }`; `media` comes with Phase 7). Limit: 30 tickets per minute per user.
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

| Type                      | When                                                                                                                                     | `data`                                                                                                            | Topic             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------- |
| `call.created`            | A call is created (queued)                                                                                                               | `{ callId, direction, to, campaignId? }`                                                                          | account           |
| `call.status`             | Call status changes                                                                                                                      | `{ callId, status }` — `queued \| ringing \| in_progress \| completed \| failed \| busy \| no_answer \| canceled` | account           |
| `call.transcript`         | A transcript turn is produced / finalised                                                                                                | `{ callId, seq, speaker, text, final }`                                                                           | `call:<id>`       |
| `call.dtmf`               | A key press is received                                                                                                                  | `{ callId, digit }`                                                                                               | `call:<id>`       |
| `call.ended`              | Call finished and costed                                                                                                                 | `{ callId, durationSec, disposition, costMicros }`                                                                | account           |
| `campaign.status`         | Campaign status changes                                                                                                                  | `{ campaignId, status }`                                                                                          | account           |
| `campaign.progress`       | Counters change (throttled ≤ 1/sec per campaign)                                                                                         | `{ campaignId, stats }`                                                                                           | `campaign:<id>`   |
| `wallet.updated`          | Balance / hold changes                                                                                                                   | `{ balanceMicros, holdMicros, availableMicros, currency, status }`                                                | account           |
| `wallet.low_balance`      | Available balance crosses the threshold                                                                                                  | `{ availableMicros, thresholdMicros }`                                                                            | account           |
| `wallet.exhausted`        | Available balance reached 0 (new calls / holds refused until a top-up)                                                                   | `{ availableMicros }`                                                                                             | account           |
| `import.progress`         | Contact import / validation progresses (throttled ≤ 1/sec, always on status change)                                                      | `{ importJobId, processed, total, status }`                                                                       | account           |
| `export.progress`         | Contact export progresses (throttled ≤ 1/sec, always on status change)                                                                   | `{ exportJobId, processed, total, status }`                                                                       | account           |
| `contacts.bulk_completed` | A background bulk action on contacts finished                                                                                            | `{ action, count }`                                                                                               | account           |
| `contacts.changed`        | Many contacts changed at once (import, bulk, field / list deleted, DND upload) — contact pages refetch                                   | `{ reason }`                                                                                                      | account           |
| `notification.created`    | New in-app notification                                                                                                                  | `{ notificationId, title }`                                                                                       | account (or user) |
| `presence.changed`        | A team member goes online/offline                                                                                                        | `{ userId, status }`                                                                                              | account           |
| `session.revoked`         | The user's sessions were ended (logout-all, password change, disabled, removed) — the server also closes that user's sockets with `4001` | `{ reason }`                                                                                                      | user              |
| `account.updated`         | Account settings changed                                                                                                                 | `{ fields }`                                                                                                      | account           |
| `account.suspended`       | A superadmin suspended the account (read-only)                                                                                           | `{ reason }`                                                                                                      | account           |
| `account.enabled`         | The account was re-enabled                                                                                                               | `{}`                                                                                                              | account           |
| `user.updated`            | A member's role / profile changed — that user refetches `GET /auth/me`                                                                   | `{ userId }`                                                                                                      | user              |
| `team.changed`            | Members or invitations changed — the Team page refetches                                                                                 | `{}`                                                                                                              | account           |

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

## 10. Phase 1 implementation notes (`src/core/realtime/`)

- **Tickets** (`ws-tickets.ts`): Redis key `wst:<ticket>`, `SET … EX 60 NX`, consumed with **`GETDEL`** (single use). Unknown / used ticket → close **4001**; ticket whose embedded `exp` is past → **4010**; a `media` ticket on `/ws/events` → **4003**. Issuing endpoint `POST /api/v1/ws/tickets` (Phase 2); `npm run ws:dev-ticket` stays as a DEV shortcut for fake ids.
- **Upgrade**: only `/ws/events`; other paths → socket destroyed. Messages sent before the ticket check finishes are buffered (max 20) and replayed — an immediate `ping` / `subscribe` after `open` is never lost.
- **Fan-out**: `pushToAccount` / `pushToTopic` publish `{ target, event }` to Redis channel **`ws:fanout`**; every API instance subscribes on a dedicated connection and delivers to its local sockets.
- **Liveness vs idle**: ws-level ping/pong every 30 s detects dead TCP (no pong → terminate); the **60 s idle timeout** counts only application messages (clients send `ping` every 25 s) → close **4008** `idle timeout`.
- **Limits** (defaults): 5 connections per user, 50 per account (**4009**), 20 client messages/s (**4008** `rate limit`), 64 KB max payload (**1009**), 20 topics per connection.
- **Topics**: only `call:<id>` / `campaign:<id>`; ownership check is a hook — **TODO(P7/P8)**: verify the resource belongs to the account.
- **Shutdown**: hook `ws` (20) closes every client with **1001** `server shutting down`.

## 11. Frontend client (`src/services/realtime/` in the frontend repo)

- **`RealtimeClient`** (framework-agnostic) + `RealtimeProvider` and hooks `useWsStatus()`, `useWsEvent(type, handler)`, `useWsTopic(topic)`. One connection per browser tab.
- **URL:** `VITE_WS_URL` is the **base** (`ws://localhost:3100/ws` in dev, through the Vite proxy); the client appends `/events?ticket=…`. Unset → derived from the page origin (`wss:` on HTTPS).
- **Ticket provider:** `getTicket()` calls `POST /api/v1/ws/tickets` (Phase 2) once the user is signed in; signed out → the provider is `null` and the client stays idle. A failing ticket call leaves the client `idle` (no retry loop).
- **States:** `idle` → `connecting` → `open` → `reconnecting` / `closed`.
- **Keepalive:** `{ "type": "ping" }` every **25 s** while open.
- **Reconnect:** full-jitter exponential backoff — `random() × min(30 s, 1 s × 2^attempt)`; reset after a successful open; the browser `online` event reconnects immediately.
- **Close codes:**

| Code                          | Client behaviour                                                   |
| ----------------------------- | ------------------------------------------------------------------ |
| `1000`                        | Closed on purpose — no reconnect                                   |
| `4003`                        | Forbidden — no reconnect (`lastError = forbidden`)                 |
| `4001` / `4010`               | New ticket + reconnect; **3 in a row** → `closed` (`unauthorized`) |
| `4009`                        | Too many connections — reconnect after the max delay (30 s)        |
| `4008`, `1001`, `1006`, other | Reconnect with backoff                                             |

- **Topics** are reference-counted (two components on `call:<id>` → one `subscribe` frame) and re-sent after every reconnect.
- **Events** are de-duplicated by `id` (last 200); unknown `type`s are ignored (forward compatible).
- **After a reconnect** the app invalidates React Query caches so the screen refetches (missed events are not replayed — §6).
- The typed event map mirrors §5 and backend `src/core/realtime/events.ts` — update all three together.
- DEV only: `/dev/realtime` page — paste a URL from `npm run ws:dev-ticket` to watch live events.
