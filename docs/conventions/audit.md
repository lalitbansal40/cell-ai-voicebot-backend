# Audit log

Who did what in an account — an immutable, append-only log (`auditLogs`, [data-model.md](data-model.md) §2.1). Owners and admins read it (`audit.read`, `GET /api/v1/audit-logs`); a daily job deletes entries older than **365 days**.

## Rules

1. Write through `recordAudit()` / `auditRequest(req, action, { target, meta })` (`src/modules/audit/audit.service.ts`). It never throws — a failed write is logged and the request continues.
2. `action` must be one of `AUDIT_ACTIONS` (`src/modules/audit/audit-actions.ts`) — typed, and a test keeps this table identical to the code. New action → add it in both places in the same PR.
3. `meta` holds **no secrets and no PII values**: keys matching `pass|token|secret|code|otp|cookie|authorization|hash` are dropped, e-mail values are masked (`a***@example.com`). Record field **names**, not values (`{ fields: ['timezone'] }`).
4. Actor: `user` (with `impersonatorId` when a superadmin acts as the user), `api_key`, or `system`; `platform: true` marks superadmin actions (suspend / enable).
5. Entries can't be updated or deleted (model hooks); only the purge job deletes, with `{ allowPurge: true }`.

## Actions

| Action                          | Actor            | Target           | Meta                       |
| ------------------------------- | ---------------- | ---------------- | -------------------------- |
| `account.created`               | user (owner)     | account          | —                          |
| `account.updated`               | user             | account          | `fields`                   |
| `account.ownership_transferred` | user (old owner) | user (new owner) | `from`, `to` (user ids)    |
| `account.suspended`             | user (platform)  | account          | `reason`                   |
| `account.enabled`               | user (platform)  | account          | —                          |
| `auth.email_verified`           | user             | user             | —                          |
| `auth.login`                    | user             | —                | —                          |
| `auth.login_failed`             | user             | —                | `reason` (`bad_password`)  |
| `auth.logout`                   | user             | —                | —                          |
| `auth.logout_all`               | user             | —                | —                          |
| `auth.session_revoked`          | user             | session          | —                          |
| `auth.refresh_reuse_detected`   | user             | session          | —                          |
| `auth.password_reset_requested` | user             | —                | —                          |
| `auth.password_reset`           | user             | —                | —                          |
| `auth.password_changed`         | user             | —                | —                          |
| `team.invited`                  | user             | user (invitee)   | `roleKey`                  |
| `team.invite_resent`            | user             | user             | —                          |
| `team.invite_revoked`           | user             | user             | `email` (masked)           |
| `team.invite_accepted`          | user (invitee)   | user             | —                          |
| `team.role_changed`             | user             | user             | `from`, `to` (role keys)   |
| `team.disabled`                 | user             | user             | —                          |
| `team.enabled`                  | user             | user             | —                          |
| `team.removed`                  | user             | user             | `email` (masked)           |
| `apikey.created`                | user             | api_key          | `name`, `scopes`, `prefix` |
| `apikey.revoked`                | user             | api_key          | `name`, `prefix`           |
| `admin.impersonation_started`   | user (platform)  | account          | `ownerId`, `expiresAt`     |
| `admin.impersonation_stopped`   | user (platform)  | account          | —                          |

Login failures for e-mails that don't exist are not audited (there is no account) — they only count towards the per-email lockout.

## API

`GET /api/v1/audit-logs?limit=50&cursor=…&action=team.*&actorId=…&targetType=user&from=…&to=…` — newest first, cursor pagination (`meta: { nextCursor, hasMore }`), actor names joined. Times are UTC ISO-8601; the dashboard shows them in the account timezone.
