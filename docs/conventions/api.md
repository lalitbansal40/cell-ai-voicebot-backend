# API Conventions

How every HTTP endpoint of the Cell AI Voicebot API is shaped. The dashboard, the public API and the generated frontend types ([ADR 0029](../adr/0029-shared-api-types-via-openapi.md)) all depend on these rules.

Related: [ADR 0024 — API versioning & style](../adr/0024-api-versioning-and-style.md) · [ADR 0015 — Naming](../adr/0015-naming-conventions.md) · [ADR 0016 — Money](../adr/0016-money-representation.md) · [ADR 0018 — Phone numbers](../adr/0018-phone-numbers.md) · [Error codes](error-codes.md) · [Data conventions](data.md)

---

## 1. Base path & resource naming

1. Every endpoint lives under **`/api/v1`**.
2. Resources are **plural, kebab-case** nouns: `/api/v1/ai-agents`, `/api/v1/contact-lists`, `/api/v1/campaigns`.
3. Nesting goes **at most one level** deep and only for strict ownership: `/api/v1/campaigns/:id/contacts`.
4. IDs are 24-character MongoDB ObjectId strings.

```
✅ GET /api/v1/contact-lists/66f1c2…/contacts
❌ GET /api/v1/contactLists/66f1c2…/contacts/66f1…/calls   (camelCase + two levels)
```

## 2. Methods

| Method   | Use                                                    |
| -------- | ------------------------------------------------------ |
| `GET`    | List or read one resource. Never changes state.        |
| `POST`   | Create a resource **or** run an action.                |
| `PATCH`  | Partial update (send only changed fields).             |
| `PUT`    | Full replace — avoid; use `PATCH`.                     |
| `DELETE` | Delete (soft delete where [data.md](data.md) says so). |

**Actions** are `POST` on a sub-path verb:

```
POST /api/v1/campaigns/:id/pause
POST /api/v1/campaigns/:id/resume
POST /api/v1/campaigns/:id/cancel
POST /api/v1/calls/:id/hangup
```

## 3. Success envelope

```json
{ "success": true, "data": { "id": "66f1…", "name": "Loan reminder" } }
```

Lists return an array in `data` and pagination in `meta`:

```json
{
  "success": true,
  "data": [{ "id": "66f1…" }],
  "meta": { "page": 1, "limit": 20, "total": 134, "totalPages": 7 }
}
```

- `201 Created` on create — body contains the created resource.
- `204 No Content` on delete — no body.

## 4. Error envelope

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Some fields are invalid.",
    "details": [{ "path": "phone", "message": "Must be an E.164 number" }],
    "requestId": "req_8f2c…"
  }
}
```

- `code` comes from the [error code catalogue](error-codes.md) — `DOMAIN_REASON`, UPPER_SNAKE_CASE.
- `message` is safe to show a user: no stack traces, no internal names, no SQL/Mongo errors.
- `details` is optional; used for field-level validation errors (`path` uses dot notation: `variables.amount`).
- On `409 CONFLICT_DUPLICATE` a detail may carry `existingId` — the id of the record that already exists (e.g. the contact with that phone), so the UI can link to it.
- `requestId` always matches the `X-Request-Id` response header.

## 5. HTTP status codes

| Status | When                                                                        | Example code                                       |
| ------ | --------------------------------------------------------------------------- | -------------------------------------------------- |
| 200    | Successful read / update / action                                           | —                                                  |
| 201    | Resource created                                                            | —                                                  |
| 204    | Deleted, nothing to return                                                  | —                                                  |
| 400    | Body is not valid JSON / malformed request                                  | `REQUEST_MALFORMED`                                |
| 401    | Missing, invalid or expired authentication                                  | `AUTH_UNAUTHENTICATED`, `AUTH_TOKEN_EXPIRED`       |
| 403    | Authenticated but not allowed                                               | `AUTH_FORBIDDEN`                                   |
| 404    | Resource does not exist **in this account**                                 | `RESOURCE_NOT_FOUND`                               |
| 409    | Conflict: duplicate, invalid state transition, idempotent request in flight | `CONFLICT_DUPLICATE`, `CONFLICT_INVALID_STATE`     |
| 413    | Upload too large                                                            | `PAYLOAD_TOO_LARGE`                                |
| 415    | Wrong file / content type                                                   | `UNSUPPORTED_MEDIA_TYPE`                           |
| 422    | Well-formed but fails validation or business rules                          | `VALIDATION_FAILED`, `WALLET_INSUFFICIENT_BALANCE` |
| 429    | Rate limited                                                                | `RATE_LIMITED`                                     |
| 500    | Unexpected server error                                                     | `INTERNAL_ERROR`                                   |
| 502    | Upstream provider (telephony / AI) returned an error                        | `PROVIDER_ERROR`                                   |
| 503    | A dependency is down (DB, Redis, provider unreachable)                      | `PROVIDER_UNAVAILABLE`, `AI_UNAVAILABLE`           |

Rule: a resource that belongs to **another account** returns **404**, never 403 — we do not reveal that it exists.

## 6. Pagination

**Offset pagination** (default — admin lists, small/medium collections):

```
GET /api/v1/contacts?page=2&limit=50
→ meta: { "page": 2, "limit": 50, "total": 1342, "totalPages": 27 }
```

- `page` starts at 1. `limit` default 20, max 100 (larger → 422).

**Cursor pagination** (high-volume, append-only data: calls, call events, ledger entries, transcript turns):

```
GET /api/v1/calls?limit=50&cursor=eyJjcmVhdGVkQXQiOi…
→ meta: { "nextCursor": "eyJj…", "hasMore": true }
```

- The cursor is an opaque base64url string encoding `{ createdAt, _id }` of the last item. Clients never build cursors themselves.
- `nextCursor` is `null` when `hasMore` is `false`.

## 7. Sorting

- `?sort=-createdAt,name` — comma-separated, `-` prefix = descending.
- Each endpoint has an **allowlist** of sortable fields; an unknown field → `422 VALIDATION_FAILED`.
- Default sort: `-createdAt`.

## 8. Filtering & search

- Plain query params for exact filters: `?status=running&listId=66f1…`.
- Multiple values: comma-separated → `?status=failed,busy`.
- Date ranges: `createdFrom` / `createdTo` (ISO 8601, inclusive start, exclusive end).
- Free-text search: `?q=bansal`.
- Unknown query params → `422` (silently ignoring them hides client bugs).

## 9. Data formats

| Kind          | Format                                                                           | Example                                                         |
| ------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Field names   | camelCase                                                                        | `phoneE164`, `createdAt`                                        |
| Dates / times | ISO 8601 UTC with `Z`                                                            | `2026-10-08T06:30:00.000Z`                                      |
| Money         | Integer micro-units + currency ([ADR 0016](../adr/0016-money-representation.md)) | `{ "balanceMicros": 5500000000, "currency": "INR" }` (= ₹5,500) |
| Percentages   | Integer basis points (`*Bps`, 1 % = 100)                                         | `{ "commissionBps": 1000 }` (= 10 %)                            |
| Phone numbers | E.164                                                                            | `+919876543210`                                                 |
| Booleans      | JSON booleans                                                                    | `true` — never `"true"`                                         |
| Enum values   | **lower_snake_case** strings                                                     | `no_answer`, `promise_to_pay`                                   |
| IDs           | ObjectId hex strings                                                             | `66f1c2a9e4b0c1d2e3f4a5b6`                                      |

**Absent vs `null`:** an absent field means "not set / unchanged" (in `PATCH`); `null` means "explicitly cleared".

## 10. Headers

| Header                                                      | Direction | Rule                                                                                                           |
| ----------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------- |
| `Authorization: Bearer <accessToken>`                       | request   | Dashboard API auth ([ADR 0009](../adr/0009-auth-tokens.md))                                                    |
| `X-API-Key: <key>`                                          | request   | Public API auth (scoped API keys)                                                                              |
| `X-Request-Id`                                              | both      | Client may send one (UUID/ULID); otherwise the server generates it. Always echoed in the response and in logs. |
| `Idempotency-Key`                                           | request   | **Required** on `POST` that costs money or has external side effects (trigger call, start campaign, top-up).   |
| `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` | response  | On rate-limited routes.                                                                                        |
| `Retry-After`                                               | response  | On `429` (seconds).                                                                                            |

### Idempotency-Key rules

- Stored for **24 hours** per account (`idempotencyKeys` collection, TTL index).
- Same key + same request body → the stored response is **replayed** (same status and body).
- Same key + **different** body → `422 IDEMPOTENCY_KEY_REUSED`.
- Same key while the first request is still running → `409 IDEMPOTENCY_IN_PROGRESS`.

### Implementation (Phase 1)

- Middleware `idempotency({ scope, required })` in `src/shared/middlewares/idempotency.ts`, records in `idempotencyKeys` (unique `{ accountId, key }`, TTL index on `expiresAt`).
- The request fingerprint is `sha256(method + path + key-order-independent JSON body)`.
- The result is stored **before** the response is sent, so an immediate retry always sees it. Replays carry **`Idempotent-Replayed: true`**.
- 4xx responses are stored and replayed; 5xx responses are not stored (the record is deleted, so the client can retry).
- Mounted per route from Phase 4 / 8 (trigger call, start campaign, top-up) with `idempotency({ scope: accountScope })` — `accountScope` (`src/shared/auth/tenant.ts`) returns the authenticated `accountId` (Phase 2).
- Mounted today (Phase 4): `POST /wallet/topups` (scope = the caller's account) and `POST /admin/accounts/:id/wallet/adjustments` (scope = the superadmin's platform account; the target account is part of the hashed path, so one key never replays against another account). Phase 8: `POST /campaigns/:id/start` and `POST /calls` (single "Call now") — both **required**, scope = the caller's account.
- **AI playground turns** (Phase 5) don't use the header: `POST /agents/:id/playground/sessions/:sid/messages { text, clientTurnId }` carries a client-generated UUID per message. Repeating it returns the stored reply (`replay: true`) with no second model call and no second charge; the ledger key is `aiturn:<sessionId>:<clientTurnId>`. Knowledge ingest charges use `kbingest:<sourceId>:<version>`.
- Separate from the HTTP key, every billing-engine operation has its own **unique ledger idempotency key** (`topup:<orderId>`, `settle:<holdId>`, `adjust:<accountId>:<key>`, …), so a retried job or webhook can never move money twice even after the 24 h HTTP record expired ([ADR 0032](../adr/0032-wallet-billing-payments.md)).

## 11. File uploads

- `multipart/form-data`, file field name **`file`** (extra fields as normal form fields).
- Both the MIME type **and** the file extension are checked.

| Upload                  | Allowed                        | Max size                    |
| ----------------------- | ------------------------------ | --------------------------- |
| Contacts import         | `.csv`, `.xlsx`                | 10 MB                       |
| Audio prompt            | `.mp3`, `.wav`                 | 5 MB, ≤ 120 s               |
| Knowledge-base document | `.pdf`, `.docx`, `.txt`, `.md` | 10 MB each, 1–5 per request |

Too large → `413 PAYLOAD_TOO_LARGE`; wrong type → `415 UNSUPPORTED_MEDIA_TYPE`.

The file's **magic bytes** must match too (an `.xlsx` is a ZIP: `PK\x03\x04`; a CSV must not be a ZIP or contain NUL bytes), so a renamed file is rejected with 415.

**Knowledge documents** (Phase 5, [ADR 0033](../adr/0033-ai-agents-knowledge-tools.md)): `POST /knowledge-bases/:id/sources/files`, multipart field **`files`** (repeat it, 1–5 files). PDF must start with `%PDF-`; DOCX must be a ZIP containing `word/document.xml`; TXT / MD must not be a ZIP or contain NUL bytes (UTF-8 with or without BOM, else Windows-1252). More than 5 files → 422; ≤ 25 sources per base and ≤ 10 bases per account → `422 KNOWLEDGE_LIMIT_REACHED`; 20 adds / hour / account. Files are processed in the background (`202`, progress over WS `kb.source.updated`).

**Flow audio** (Phase 6): `POST /flow-audio`, multipart field **`file`** (one file) + optional `name`. The name must end in `.wav` / `.mp3` and the content must be a real WAV (PCM, A-law or μ-law, 8–48 kHz, mono / stereo) or MPEG Layer III file — probed from the bytes (RIFF / frame headers), so a renamed file is 415. Longer than 120 s → 422; ≤ 200 files per account; 20 uploads / hour / account. Playback through `GET /flow-audio/:id/url` (signed, 10 min).

**Write-only secrets** (Phase 5): agent function headers marked `secret` are never returned — responses show `{ secret: true, value: null, valueHint: '••••1234' }`. To keep a stored secret on `PATCH`, send the header with `value: null`; a new string replaces it.

**Contact imports** (Phase 3, [ADR 0031](../adr/0031-contact-import-pipeline.md)):

- CSV MIME types accepted: `text/csv`, `application/csv`, `text/plain`, `application/vnd.ms-excel` (browsers send it for `.csv`), `application/octet-stream`; XLSX: the OpenXML type, `application/zip`, `application/octet-stream`. Old `.xls` → 415 with "save as .xlsx".
- At most **50,000 data rows** and **100 columns**; row 1 is the header. An `.xlsx` that would unpack to more than 100 MB (zip bomb) is rejected without unpacking. These problems answer `422 IMPORT_FILE_INVALID` with `details: [{ path: 'file', message: '<reason>' }]` (`unreadable`, `not_csv`, `empty_file`, `no_header`, `too_many_rows`, `too_many_columns`, `unsafe_file`, `sheet_not_found`).
- `.xlsx` with several sheets: the first sheet is used until the mapping step picks another (`PUT /contact-imports/:id/mapping { sheet }`).
- CSV: UTF-8 with or without BOM; other bytes are read as Windows-1252 (warning `encoding_fallback`); `,` `;` tab `|` separators are detected from the header line.

## 12. Dashboard API vs public API

Both use the **same `/api/v1/...` paths and the same envelopes**. Only authentication differs:

- Dashboard: `Authorization: Bearer <accessToken>` + role permissions.
- Public API: `X-API-Key` + key **scopes**. Current scopes (`src/modules/api-keys/scopes.ts`, Phase 10 may add more): `calls:read`, `calls:write`, `contacts:read`, `contacts:write`, `campaigns:read`, `campaigns:write`, `webhooks:manage`.
- API keys (Phase 2): created by owners / admins (`apikeys.manage`), format `cav_live_` (production) / `cav_test_` + 32 base62 characters, stored as SHA-256, the full key is returned **once** (`Cache-Control: no-store`), max 20 active per account. `GET /api/v1/api-keys/whoami` checks a key.

## 13. Tenant scoping (security rule)

- Implementation (Phase 2): `tenantFilter(req)` / `findOwnedOr404(Model, id, req)` in `src/shared/auth/tenant.ts`; `tests/security/tenant-scope.test.ts` fails if any module reads `body|query|params.accountId`. A document of another account answers **404**, never 403.

- `accountId` is **never** read from the request body, query or path. It always comes from the authenticated context (user session or API key).
- Every database query is scoped by `accountId` ([data.md](data.md)).

```ts
// ✅
const contact = await Contact.findOne({ _id: id, accountId: ctx.accountId });
// ❌ trusts the client
const contact = await Contact.findOne({ _id: id, accountId: req.body.accountId });
```

## 14. Outbound webhooks (preview — built in Phase 15)

- `POST` with JSON body `{ "id": "evt_…", "type": "call.completed", "createdAt": "…", "data": { … } }`.
- Headers: `X-Webhook-Id`, `X-Webhook-Timestamp` (unix seconds), `X-Webhook-Signature: v1=<hex HMAC-SHA256(secret, timestamp + "." + rawBody)>`.
- Receivers should reject timestamps older than 5 minutes.
- Retries with backoff: 1 min, 5 min, 30 min, 2 h, 12 h; the endpoint is disabled after repeated failures and the account is notified.

## 14a. Call flows (Phase 6)

- **Optimistic revision:** every flow has a `revision`. `PUT /flows/:id/draft { revision, graph }`, `POST /flows/:id/publish { revision }` and `POST …/versions/:n/restore { revision }` succeed only with the current one; otherwise **409 `FLOW_REVISION_CONFLICT`** with `details` `revision` (current), `updatedBy` (name) and `updatedAt`. Renames (`PATCH`) don't need or bump it.
- **Structural vs semantic:** a draft save refuses only a broken graph shape (422 `VALIDATION_FAILED` at `graph.<path>`, 413 over 512 KB). Incomplete or wrong node settings are saved and returned as `issues[]` (`{ severity, code, message, nodeId?, edgeId?, field? }`) — the same list `POST /flows/:id/validate` returns.
- **Publish:** errors block it with **422 `FLOW_INVALID`** whose `details` are the issues (`path`, `message`, `issue`, `severity`, `nodeId`, `edgeId`); warnings don't. Publishing an unchanged draft is 409 `CONFLICT_INVALID_STATE`. Versions are immutable.
- **Secrets:** API request headers with `secret: true` are sealed at save; responses show only `valueHint` (`••••1234`). Send `value: null` to keep the stored value. Exports never contain secret values (`secret_removed:<node>.<header>` warning on import).
- **Export / import:** `GET /flows/:id/export?version=draft|<n>` downloads `{ format: "cell-ai-flow", schemaVersion: 1, name, description, graph, refs: { agents, audios } }` (attachment, no envelope). `POST /flows/import { file, name? }` always creates a new flow; agents / audio are mapped by id (same account) or name, else cleared with `agent_unmapped:<node>` / `audio_unmapped:<node>` warnings. Files with `__proto__` / `constructor` / `prototype` keys are refused.
- **Simulator:** `POST /flows/:id/simulations { version: draft | published | <n>, contactId? | variables? + testPhone? }` starts a text run (a draft with errors → 422 `FLOW_INVALID`; draft runs keep a snapshot of the graph). `POST …/simulations/:runId/inputs { clientInputId (uuid), kind: dtmf | speech | no_input | transfer_result | hangup, value? }` — idempotent by `clientInputId` (a replay returns the same `added` rows with `replay: true`, no second AI charge); 422 when the run waits for another kind (`details[0].message` "Waiting for dtmf"), 409 when it ended or another input won the race. `wait` nodes are skipped. 60 starts + inputs / min / user. Runs expire after 30 days.
- **In use:** deleting an agent used by a flow's draft or published version (or audio, or a flow used by campaigns from Phase 8) is **409 `RESOURCE_IN_USE`**; `details[]` list the users (`message` = name, `id`).

## 14b. Calls (Phase 7)

- **Start a browser test call:** `POST /calls/web { flowId + version? (published default | draft | n) | agentId, contactId? | variables? + testPhone? }` → **201** `{ call, mediaTicket, expiresAt, wsPath: "/ws/media", textInput }`. Needs `calls.trigger` plus `flows.read` (flow) or `agents.read` (agent); blocked while impersonating; 10 / min / user. Errors: 422 `FLOW_INVALID` (draft with errors), 409 `CONFLICT_INVALID_STATE` (nothing published), 422 `VALIDATION_FAILED` at `agentId` (agent switched off) or `variables.<name>`, 422 `WALLET_INSUFFICIENT_BALANCE` (no call is left behind), 429 `CALL_LIMIT_REACHED` (3 live per account), 503 `CALL_CAPACITY` (this server is full).
- **Media:** open `wss://<host>/ws/media?ticket=<mediaTicket>` within 60 s ([websocket.md §8](websocket.md)); an unconnected call is canceled after 75 s and its hold released.
- **History:** `GET /calls` uses cursor pagination (§6) with `status` (comma list), `flowId`, `agentId`, `contactId`, `isTest`, `from` / `to` (ISO date-times), `q` (contact name). `GET /calls/active` lists live calls; `/calls/:id`, `/:id/transcript` (final turns in order), `/:id/events` (no texts, digits or phones). Call views never include the test phone, the wallet hold or the recording key.
- **Recording:** `GET /calls/:id/recording` → `{ url, expiresAt, durationSec }` (5 minutes, `calls.listen`, audited, 404 when there is none).
- **Hang up:** `POST /calls/:id/hangup` ends a live call running on this server (`calls.trigger`, audited) → the ended call; **409 `CALL_NOT_ACTIVE`** when it is not live here.

## 14c. WhatsApp (Phase 9)

- **Off:** with `WHATSAPP_ENABLED=false` every `/whatsapp/*` route answers **503 `WHATSAPP_NOT_CONFIGURED`**; the Meta-facing routes don't exist (404).
- **Config:** `GET /whatsapp/config` (any signed-in user) → `{ enabled, provider, appId, configId, graphVersion }` — `appId` / `configId` only with the real provider; never secrets.
- **Numbers:** `GET /whatsapp/channels` (`whatsapp.read`) → `{ items, counts, limit }`; `GET /whatsapp/channels/:id` adds ids, Meta statuses, `events24h` and the history. Another account's id → 404.
- **Connect:** `POST /whatsapp/channels/embedded-signup { code, mode, sessionInfo? }` (`whatsapp.manage`, never while impersonating, 10 / hour / account) → `{ channel, outcome: connected | action_needed | needs_reconnect, reconnected }`. Errors: 422 `WHATSAPP_SIGNUP_FAILED` (`details[0]` = `{ path: 'step', message: exchange | verify | waba | phone }`), 409 `WHATSAPP_NUMBER_IN_USE`, 409 `WHATSAPP_CHANNEL_LIMIT`, 409 `CONFLICT_INVALID_STATE` (the number is being connected right now), 502 `META_API_ERROR` (`details[0]`: `metaCode`, `metaSubcode`, `fbtraceId`). Browser ids are hints, checked against the token.
- **Actions** (`whatsapp.manage`): `PATCH /:id { label }`, `POST /:id/sync` (1 / min / number → 429), `/:id/retry-setup` (409 unless `action_needed`), `/:id/register { pin }` (409 unless a PIN is needed; wrong PIN → 422 at `pin`), `/:id/coexistence-sync`, `/:id/disconnect` (never deregisters the number). 409 `WHATSAPP_CHANNEL_NOT_READY` when a number must be reconnected first.
- **Meta-facing (public):** `GET|POST /webhooks/meta` (verify challenge; `X-Hub-Signature-256`, raw body ≤ 3 MB, 401 `META_SIGNATURE_INVALID`, 503 when storage is down so Meta retries), `POST /meta/deauthorize`, `POST /meta/data-deletion` (form `signed_request`; the latter answers Meta's own `{ url, confirmation_code }` without the envelope), `GET /meta/data-deletion/:code`.
- **Superadmin:** `GET /admin/whatsapp/status`, `GET /admin/whatsapp/events?status=`, `POST /admin/whatsapp/events/:id/replay`, `POST /admin/whatsapp/channels/:id/disconnect { reason }`, `PATCH /admin/accounts/:id/whatsapp-billing { metaPayer }`, `POST /admin/accounts/:id/whatsapp/manual-connect { wabaId, phoneNumberId, accessToken }`.
- **Dev:** `POST /dev/meta/webhooks { channelId, kind }` (not in production; `MOCK_APIS_ENABLED`).

## 14d. WhatsApp inbox (Phase 10)

- **Off:** with `WHATSAPP_ENABLED=false` every `/inbox/*` route answers **503 `WHATSAPP_NOT_CONFIGURED`** and `/account/inbox-settings` doesn't exist.
- **Permissions:** `inbox.read` (every role) reads; `inbox.reply` (owner, admin, manager, agent) sends, writes notes, closes / reopens, pings typing, uploads and takes a conversation itself; `inbox.assign` (owner, admin, manager) assigns anyone, blocks / unblocks, retries downloads. Impersonators read only (the read marker is a no-op); suspended accounts read only. Another account's ids → 404.
- **List:** `GET /inbox/conversations?status=open|closed&filter=all|unread|mine|unassigned&channelId&q&cursor&limit` (≤ 50) → rows newest first, `meta.nextCursor`; `q` (≥ 2 chars) matches contact names / numbers and message text (`match: { messageId, snippet }`).
- **Detail / messages / panel:** `GET /inbox/conversations/:id` (window, channel, assignee), `GET /:id/messages?before=<olderCursor>|around=<messageId>&limit` (≤ 100, oldest → newest, `meta: { olderCursor, hasNewer }`, reply quotes, sender names; reactions are folded into their target), `GET /:id/contact` (contact, recent calls, other conversations; `callPermission: null` until Phase 12).
- **Send:** `POST /inbox/conversations/:id/messages { clientId (uuid), type, … }` — types `text`, `image`, `video`, `audio`, `voice`, `document`, `sticker` (`mediaToken` from an upload), `location`, `contacts` (`contactIds`), `buttons`, `list`, `cta_url`, `reaction` (`messageId`, `emoji`, `''` removes), `note`; optional `replyToMessageId`. 201 queued, 200 for a repeated `clientId`. 409 `WHATSAPP_WINDOW_CLOSED` (details `windowExpiresAt`), 409 `WHATSAPP_RECIPIENT_BLOCKED`, 409 `WHATSAPP_CHANNEL_NOT_READY`, 422 per field, 429 (60 / min / user). Statuses arrive as `inbox.message.updated` on the topic.
- **Uploads:** `POST /inbox/media` multipart `kind` + `file` (+ `durationSec`) → 201 `{ mediaToken, kind, mimeType, size, fileName, durationSec, voice, expiresAt }` (this user, 24 h, once). 413 `WHATSAPP_MEDIA_TOO_LARGE`, 422 `WHATSAPP_MEDIA_INVALID` (`details[0].message`: `type_mismatch`, `not_allowed`, `stereo_voice`, `corrupt`, `too_long`, `too_short`); 20 / min / user.
- **Actions:** `POST /:id/read` (204; blue ticks when the account sends read receipts), `/:id/unread` (204), `/:id/typing` → `{ sent }`, `PATCH /:id { assignedTo }`, `/:id/close`, `/:id/reopen`, `/:id/block`, `/:id/unblock` (409 when Meta refuses — only after a message in the last 24 h), `POST /inbox/conversations/start { channelId, contactId }` (201 new / 200 existing).
- **Media / retries:** `GET /inbox/messages/:id/media` → `{ url (signed, 5 min), mimeType, fileName, expiresInSec }` (404 until ready); `POST /inbox/messages/:id/retry` (failed outgoing → a new queued message with `retryOf`); `POST /inbox/messages/:id/media/retry` (204; 410 `INBOX_MEDIA_EXPIRED` after 7 days).
- **Other:** `GET /inbox/summary`, `GET /inbox/config` (composer limits, retention days, fake provider flag); `GET|PATCH /account/inbox-settings` (`account.read` / `account.update`); `GET|PATCH /whatsapp/channels/:id/profile`, `POST /whatsapp/channels/:id/profile/photo` (`whatsapp.read` / `whatsapp.manage`).
- **Dev:** `POST /dev/meta/webhooks { channelId, kind, from?, text?, conversationId?, days? }` (44 kinds), `GET /dev/meta/media/:id` (signed fake media), `GET /dev/meta/sent?channelId` (what the fake received) — not in production; `MOCK_APIS_ENABLED`.

## 14e. WhatsApp templates + charges (Phase 11)

- **Off / permissions:** with `WHATSAPP_ENABLED=false` every `/whatsapp/*` route answers 503. `templates.read` (every role) reads; `templates.manage` (owner, admin, manager) creates, edits, submits, deletes, syncs, uploads examples and sets variable sources. Impersonators and suspended accounts read only; another account's ids → 404.
- **Templates:** `GET /whatsapp/templates?channelId&status=A,B&category&purpose&q&includeDeleted` (rows without bodies / examples), `GET /:id` (components, variables + sources, history, usage, `nextEditAt`), `POST /whatsapp/templates { channelId, name, language, category, parameterFormat?, components (Meta JSON), ttlSeconds?, submit? }` (201; `submit: false` keeps a draft), `PATCH /:id` (drafts freely; Meta templates when approved / rejected / paused — 409 `TEMPLATE_EDIT_NOT_ALLOWED` with `status` / `edit_limit` / `category_locked` / `not_editable`), `POST /:id/submit`, `DELETE /:id?scope=language|name` (rows → `DELETED`; 409 for disabled), `PATCH /:id/variables { sources: [{ key, kind, value? }] }`, `POST /:id/media` (multipart `file`: the media header example), `POST /whatsapp/templates/call-permission { channelId, language?, body?, submit? }`, `POST /whatsapp/templates/sync { channelId }` (1 / min / number). Create / edit / submit 20 / h / user (`rl:templates:`). Errors: `TEMPLATE_NAME_TAKEN` (also a name deleted < 30 days ago), `TEMPLATE_LIMIT_REACHED` (250 / 6,000 per WABA, 100 / h), 422 with one detail per field path, 502 `META_API_ERROR`.
- **Sending:** `POST /inbox/conversations/:id/messages { clientId, type: 'template', templateId, variables?: { key: value }, header?: { mediaToken } | { location } }` — works with the window closed; 404 `TEMPLATE_NOT_FOUND`, 409 `TEMPLATE_NOT_APPROVED` / `TEMPLATE_PAUSED` / `TEMPLATE_MARKETING_BLOCKED` (`opted_out` / `dnd` / `stopped_marketing`), 422 `TEMPLATE_VARIABLES_MISSING` (keys only) / `TEMPLATE_PARAMS_INVALID`, 429 `WHATSAPP_FREQUENCY_LIMIT` (`retryAfterSec`). `POST /inbox/conversations/start { channelId, contactId, template? }` creates the chat and sends the first template in one call (`clientId` returned). Every sent message except notes is priced and held first: 422 `WALLET_INSUFFICIENT_BALANCE` / `WALLET_BUDGET_EXCEEDED` with `details[0].path = 'whatsapp'`. Message views carry `template { templateId, name, language, category }` and `billing { payer, category, market, priceMicros, status }`.
- **Prices:** `POST /whatsapp/price-preview { channelId, contactId | phone, templateId | category }` → `{ payer, market, marketLabel, category, priceMicros, currency, note: billed_when_delivered | free_tier_may_apply | customer_pays_meta }` (`inbox.read` or `templates.read`). `GET /wallet/rates` adds `whatsapp { payer, markets: [{ market, label, prices }] }` (selling prices only); `PATCH /wallet/settings { budgets.monthlyWhatsappMicros }`; ledger `type=whatsapp_charge`; usage series `whatsappMicros`.
- **Superadmin (`platform.billing.manage`):** `GET /admin/whatsapp-rates`, `POST /admin/whatsapp-rates/import` (multipart CSV ≤ 2 MB → `{ markets, errors (row numbers), diff }`, nothing saved), `POST /admin/whatsapp-rates { markets, source, note?, effectiveFrom? }`, `GET|PATCH /admin/whatsapp-billing` (markup / fee / hold age + non-INR platform numbers), `PATCH /admin/accounts/:id/whatsapp-billing { metaPayer?, markupBps?, fixedPrices?, platformFeeMicros? }`, `GET /admin/reports/whatsapp-margin?month=YYYY-MM&accountId&format=csv`, `GET /admin/reports/whatsapp-reconciliation?month`.
- **Dev:** `POST /dev/meta/webhooks` adds 14 kinds (58 in total: `template_*` with `templateId`, `user_stopped_marketing` / `user_resumed_marketing` with `from`, `pricing_tier_update`, `run_template_sync`, `run_hold_reaper`, `run_whatsapp_reconcile`, `late_billable_status` with `messageId`); `GET /dev/meta/templates?channelId` (the fake's templates, no bodies).

## 14f. WhatsApp calling (Phase 12)

- **Off / permissions:** `WHATSAPP_ENABLED=false` → every `/whatsapp/*` route 503. `calls.read` (every role) reads settings and permissions; `whatsapp.calling.manage` (owner, admin) changes call settings; `inbox.reply` requests permission; `calls.trigger` places calls and holds them; `calls.answer` (owner, admin, manager, agent) answers / declines and sets availability; `calls.listen` transfers (supervisors). Impersonators read only; another account's ids → 404.
- **Settings:** `GET /whatsapp/channels/:id/calling` (status, unavailable reason, call icon, countries, call hours, callback permission, inbound route / AI program / ring timeout / ring list, permission request text, restrictions, syncedAt); `PATCH` (Meta first, only Meta's changed fields; 409 `WHATSAPP_CALLING_UNAVAILABLE` on coexistence / messaging limit < 2,000 / country; 422 per field: HHMM, IANA zone, ≤ 2 ranges a day without overlap, ≤ 20 holidays, ring list ≤ 50, ring timeout 10–30 s; 502 mapped Meta errors); `POST /…/calling/sync`. 10 / min / number.
- **Permissions:** `GET /whatsapp/call-permissions?channelId&contactId&refresh` (panel state `canCall` / `reason` / `expiresAt` / `nextRequestAt` + history, Meta's answer ≤ 60 s old); `POST /whatsapp/call-permissions/request { channelId, contactId, body? }` → 201 `{ messageId, kind: interactive | template }` (409 `WHATSAPP_CALL_PERMISSION_EXISTS`, 429 `WHATSAPP_CALL_PERMISSION_LIMIT` with `retryAfterSec`, 409 `WHATSAPP_CALL_PERMISSION_TEMPLATE_MISSING` outside the window). 20 / h / user.
- **Calls:** `POST /whatsapp/calls { channelId, contactId, mode: human | ai, program? }` (Idempotency-Key) → 201 `{ callId, mediaTicket?, expiresAt?, wsPath?, call }` — the media ticket of the caller's browser leg on agent calls; dial guard errors `WHATSAPP_CALLING_DISABLED` / `_UNAVAILABLE` / `_RESTRICTED`, `WHATSAPP_CALL_PERMISSION_MISSING`, `WHATSAPP_CALL_PERMISSION_CHECK_FAILED`, `WHATSAPP_CALL_LIMIT_REACHED`, `WHATSAPP_CALL_ACTIVE`, `CALL_NOT_ALLOWED` (dnd / opted_out / blocked), `CALL_OUTSIDE_WINDOW` (`retryAfterSec`), `CALL_LIMIT_REACHED`, `CALL_CAPACITY`, `CALL_AGENT_UNAVAILABLE`, `WALLET_INSUFFICIENT_BALANCE`, 502 `WHATSAPP_CALL_FAILED`. 10 / min / user. `POST /whatsapp/calls/:id/answer` (first wins → `{ callId, mediaTicket, expiresAt, wsPath }`; 409 `WHATSAPP_CALL_TAKEN`, 409 `WHATSAPP_CALL_NOT_RINGING`, 403 when not in the ring), `/decline`, `/hold { on }`, `/transfer { userId? }` (AI calls → ring the team or one user), `POST /calls/:id/media-ticket` (the agent's socket again), `POST /calls/:id/hangup` (Phase 7, any server). Agent actions reach the server holding the call (10 s → 409 `CALL_NOT_ACTIVE`).
- **Lists:** `GET /calls?provider=whatsapp&direction=inbound|outbound&mode=human|ai` (Phase 7 filters); call views add `mode`, `agentUserId` and `whatsapp { channelId, conversationId, direction, metaStatus, metaDuration, answeredBy, transferredTo, timeline }` (never SDP, ICE data or phones).
- **Availability:** `PATCH /users/me/call-availability { status: available | busy | offline }` (self only).
- **Prices:** `GET /wallet/rates` adds `whatsappCalling { payer, pulseSec, markets: [{ market, label, perMinuteMicros }] }` (selling price of one minute, never Meta's cost); ledger `type=whatsapp_call_charge`.
- **Superadmin (`platform.billing.manage`):** `GET /admin/whatsapp-rates?kind=calling`, `POST /admin/whatsapp-rates/import?kind=calling` (CSV `Market, Currency, Per minute` + optional `Calling codes` and volume tier columns such as `50000+` → `{ callingMarkets, errors, diff }`), `POST /admin/whatsapp-rates { kind: 'calling', callingMarkets, source, note?, effectiveFrom? }`, `PATCH /admin/whatsapp-billing { calling: { markupBps?, platformFeePerMinuteMicros?, holdMinutes?, holdExtendMinutes? } }` (`GET` adds `calling` + `callingDefaults`), `PATCH /admin/accounts/:id/whatsapp-billing { calling: { markupBps?, fixedPerMinuteMicros?, platformFeePerMinuteMicros? } | null }`; the margin report adds rows `kind: call` (mismatches = calls charged on our time).
- **Dev:** `POST /dev/meta/webhooks` adds 12 calling kinds (`user_call`, `user_hangup` / `user_dtmf` with `waCallId?` / `digits?`, `permission_reply_accept` / `_permanent` / `_reject`, `permission_expire`, `calling_restricted`, `calling_unrestricted`, `settings_changed`, `call_tier_update`, `run_permission_sweep`; customer kinds take `from`); `POST /dev/meta/calls/user-call { channelId, from? }`; `GET /dev/meta/calls?channelId`.

## 14g. Records & insights (Phase 14)

- **Insights:** `GET /calls/:id/insights` (`calls.read`) → `{ callId, status: pending | done | skipped | failed | null, reason, disposition, dispositionSource: flow | agent | user | ai | null, latest, history[], canRegenerate }`; each version `{ version, status, reason, output { summary, suggestedDisposition, sentiment { label, score }, keyInfo { promiseDate, promiseAmountMicros, callbackAt, disputeReason, wrongNumber, languagePreference, notes }, confidence }, model, costMicros, createdBy, createdAt }`. `POST /calls/:id/insights/regenerate` (`calls.listen`, not while impersonating) → 202 + the view; 409 `CONFLICT_INVALID_STATE` (already running), `INSIGHTS_NOT_AVAILABLE`, `INSIGHTS_DISABLED`; 422 `WALLET_INSUFFICIENT_BALANCE`. Event `call.insights { callId, status, version }` on `call:<id>`.
- **Outcome by hand:** `PATCH /calls/:id/disposition { disposition }` (`calls.trigger`) — an active key of the account (422 `DISPOSITION_UNKNOWN`); source becomes `user`. An AI suggestion only fills an empty outcome; flow / agent / user outcomes are never replaced.
- **Settings:** `GET / PUT /account/insights-settings { enabled?, chatSummaryOnClose? }` (`account.read` / `account.update`; `transcribeHumanCalls` is read-only here — it lives in the WhatsApp calling settings). `GET / PUT /account/dispositions { dispositions: { key, label, active }[] }` (≤ 30, unique keys; a key used by calls can't be removed — deactivate it).

## 15. Versioning & deprecation

- The contract is served at **`GET /api/v1/openapi.json`** (OpenAPI 3.1, raw document — **not** wrapped in the success envelope) and browsable at **`/api/docs`** (Swagger UI, off in production unless `API_DOCS_ENABLED=true`). [ADR 0029](../adr/0029-shared-api-types-via-openapi.md).

- Breaking changes go to `/api/v2`; `/api/v1` keeps working until it is retired.
- Deprecated endpoints send `Deprecation` and `Sunset` headers before removal.
- Additive changes (new optional fields, new endpoints) are not breaking.
