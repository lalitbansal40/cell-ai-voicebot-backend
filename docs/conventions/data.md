# Data Conventions (MongoDB)

Rules for every collection. The full entity list lives in [data-model.md](data-model.md).

Related: [ADR 0004 — Database](../adr/0004-database.md) · [ADR 0015 — Naming](../adr/0015-naming-conventions.md) · [ADR 0016 — Money](../adr/0016-money-representation.md) · [ADR 0017 — Dates](../adr/0017-dates-and-timezones.md) · [ADR 0018 — Phones](../adr/0018-phone-numbers.md)

---

## 1. Naming

- Collections: **plural camelCase** — `contacts`, `ledgerEntries`, `callEvents`.
- Fields: **camelCase** — `phoneE164`, `holdMicros`.
- Primary key: `_id` (ObjectId); exposed in the API as `id`.

## 2. Tenancy

- Every tenant-owned document has **`accountId`** (ObjectId, required, indexed).
- **Every query is scoped by `accountId`** — no exceptions outside superadmin tooling.
- In compound indexes `accountId` is the **first** field.

```ts
// ✅
Contact.find({ accountId, listIds: listId });
// ❌ cross-tenant leak risk
Contact.find({ listIds: listId });
```

## 3. Timestamps & actors

- Mongoose `timestamps: true` → `createdAt`, `updatedAt` on every collection.
- `createdBy` / `updatedBy` (userId) where an audit trail matters (flows, campaigns, agents, wallet adjustments).

## 4. Deletion

| Policy                                                                             | Collections                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Soft delete** (`deletedAt: Date \| null`; default queries add `deletedAt: null`) | `contacts`, `contactLists`, `aiAgents`, `flows`, `campaigns`, `phoneNumbers`, `users`                                                                                                              |
| **Never delete / immutable** (corrections are new rows)                            | `ledgerEntries`, `auditLogs`, `topupOrders` (kept forever), `invoices` (8 years)                                                                                                                   |
| **Retention purge** (deleted by a scheduled job after the retention period)        | `calls`, `transcriptTurns`, `callEvents`, recordings, soft-deleted `aiAgents` (30 days)                                                                                                            |
| **TTL index** (auto-expire)                                                        | `refreshTokens`, `idempotencyKeys`, `webhookDeliveries` (30 days), `agentPlaygroundSessions` (30 days), `paymentEvents`, `notifications` and `agentToolCalls` (90 days) — WS tickets live in Redis |

## 5. Immutability

- `ledgerEntries`, **published** `flowVersions` and `callEvents` are insert-only; never `updateOne` them. The one allowed ledger change is `held → released` (a model guard enforces it; a call charge is a **new** `captured` row, never an edited hold), always inside a transaction and only from `src/core/billing/engine.ts`.

## 6. Types

- Enums: TypeScript string unions, **lower_snake_case** values (`no_answer`).
- Money: integer `*Micros` + `currency` — never floats.
- Phones: E.164 string, field name `phoneE164`.
- Dates: `Date` (stored UTC).
- Free-form contact data: `variables: Record<string, string | number | Date>` with keys validated against `customFieldDefinitions`.

## 7. Indexes

- Every model file declares its indexes; [data-model.md](data-model.md) lists them per entity.
- Unique constraints are **tenant-scoped**: `{ accountId: 1, phoneE164: 1 }` unique — not `phoneE164` alone.
- Use the default index names; define TTL indexes explicitly (`expireAfterSeconds`).
- Index sync runs at startup in development and as a deploy step in production (Phase 1).

## 8. Size limits — keep documents bounded

MongoDB documents max out at 16 MB. **Unbounded lists never live inside a document** — they get their own collection:

- transcripts → `transcriptTurns`
- call timelines → `callEvents`
- campaign audience → `campaignContacts`

Small, bounded lists (agent functions, tags, a recording's metadata) may be embedded.

## 9. PII inventory

| Collection.field                                                                                   | Contains                                                          | Treatment                                                                                                                          |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `contacts.phoneE164`, `name`, `email`                                                              | Personal identifiers                                              | Masked in logs (`+91******3210`); exports need permission                                                                          |
| `contacts.variables`                                                                               | Loan data (amount, due days, …)                                   | Treated as sensitive PII; masked in logs; export needs permission                                                                  |
| `contacts.searchText`                                                                              | Derived from name / email / phone / external id                   | Never serialised; masked like its sources                                                                                          |
| `importJobs.columns.samples`, import files (storage `imports/`), error reports (`import-reports/`) | Uploaded sheet cells                                              | Account-prefixed storage keys, signed URLs only, deleted 30 days after the job ends; problem rows store row numbers + reasons only |
| Export files (storage `exports/`)                                                                  | Contact data as CSV                                               | `contacts.export` permission, blocked while impersonating, audited, signed URLs (15 min), deleted after 24 h                       |
| Redis `contacts` queue jobs                                                                        | Ids only (account, job, list, field key)                          | No PII by design                                                                                                                   |
| `calls.from`, `calls.to`                                                                           | Phone numbers                                                     | Masked in logs                                                                                                                     |
| `transcriptTurns.text`                                                                             | What the customer said                                            | Retention policy; never logged                                                                                                     |
| Recordings (storage)                                                                               | Voice                                                             | Signed URLs only; retention policy                                                                                                 |
| `users.email`, `users.phone`                                                                       | Team member identifiers                                           | Masked in logs                                                                                                                     |
| `telephonyConfigs.sip.passwordEnc`                                                                 | SIP credential                                                    | **Encrypted at rest** (`ENCRYPTION_KEY`)                                                                                           |
| `outboundWebhooks.secretEnc`                                                                       | Webhook signing secret                                            | **Encrypted at rest**                                                                                                              |
| `apiKeys.keyHash`                                                                                  | API key                                                           | **Hashed** — raw key shown once at creation                                                                                        |
| `users.passwordHash`                                                                               | Password                                                          | Hashed (argon2/bcrypt — Phase 2)                                                                                                   |
| Redis `email` queue jobs (`to`, `vars`)                                                            | Recipient email + template variables (Phase 2: OTP / reset links) | Removed on success; failed jobs kept **24 h**; dedupe keys 24 h; never logged (masked recipient only)                              |

## 10. Migrations & seeds

- Migrations: `src/db/migrations/NNNN-short-name.ts` exporting `up()` / `down()`; a runner records applied migrations (Phase 1).
- Seeds (dev/demo data): `src/db/seeds/`.
- Schema changes are **backward compatible first**: add optional field → backfill → enforce/require in a later release.

## 11. Transactions

- Wallet holds, captures, releases **and** their ledger rows always run in **one transaction** (replica set required — local Docker and tests already run a replica set).
- Keep transactions short; no external API calls inside a transaction.
