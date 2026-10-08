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
- Mounted per route from Phase 4 / 8 (trigger call, start campaign, top-up); the scope is the authenticated `accountId` (Phase 2).

## 11. File uploads

- `multipart/form-data`, file field name **`file`** (extra fields as normal form fields).
- Both the MIME type **and** the file extension are checked.

| Upload                  | Allowed                 | Max size |
| ----------------------- | ----------------------- | -------- |
| Contacts import         | `.csv`, `.xlsx`         | 10 MB    |
| Audio prompt            | `.mp3`, `.wav`          | 10 MB    |
| Knowledge-base document | `.pdf`, `.docx`, `.txt` | 20 MB    |

Too large → `413 PAYLOAD_TOO_LARGE`; wrong type → `415 UNSUPPORTED_MEDIA_TYPE`.

## 12. Dashboard API vs public API

Both use the **same `/api/v1/...` paths and the same envelopes**. Only authentication differs:

- Dashboard: `Authorization: Bearer <accessToken>` + role permissions.
- Public API: `X-API-Key` + key **scopes** (e.g. `calls:write`, `contacts:write`, `campaigns:read`). The full scope list is defined in Phase 10.

## 13. Tenant scoping (security rule)

- `accountId` is **never** read from the request body, query or path. It always comes from the authenticated context (user session or API key).
- Every database query is scoped by `accountId` ([data.md](data.md)).

```ts
// ✅
const contact = await Contact.findOne({ _id: id, accountId: ctx.accountId });
// ❌ trusts the client
const contact = await Contact.findOne({ _id: id, accountId: req.body.accountId });
```

## 14. Outbound webhooks (preview — built in Phase 10)

- `POST` with JSON body `{ "id": "evt_…", "type": "call.completed", "createdAt": "…", "data": { … } }`.
- Headers: `X-Webhook-Id`, `X-Webhook-Timestamp` (unix seconds), `X-Webhook-Signature: v1=<hex HMAC-SHA256(secret, timestamp + "." + rawBody)>`.
- Receivers should reject timestamps older than 5 minutes.
- Retries with backoff: 1 min, 5 min, 30 min, 2 h, 12 h; the endpoint is disabled after repeated failures and the account is notified.

## 15. Versioning & deprecation

- The contract is served at **`GET /api/v1/openapi.json`** (OpenAPI 3.1, raw document — **not** wrapped in the success envelope) and browsable at **`/api/docs`** (Swagger UI, off in production unless `API_DOCS_ENABLED=true`). [ADR 0029](../adr/0029-shared-api-types-via-openapi.md).

- Breaking changes go to `/api/v2`; `/api/v1` keeps working until it is retired.
- Deprecated endpoints send `Deprecation` and `Sunset` headers before removal.
- Additive changes (new optional fields, new endpoints) are not breaking.
