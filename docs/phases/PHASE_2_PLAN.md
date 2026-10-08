# Phase 2 — Auth, Accounts, RBAC + App Shell (Detailed Plan)

**Project:** Cell AI Voicebot · **Phase:** 2 of 15 · **Status:** 🟢 Client ke jawab ke bina ho sakta hai (production email ke liye SMTP chahiye — dev/test Mailpit se chalega)
**Parent plan:** [../plans/BUILD_PLAN.md](../plans/BUILD_PLAN.md) · **Previous:** [PHASE_1_SIGNOFF.md](PHASE_1_SIGNOFF.md) · **Tracker:** [PHASE_2_TASKS.md](PHASE_2_TASKS.md)

---

## 0. Is phase ka goal

Phase 2 ke end tak platform **multi-tenant aur secure** ho, aur dashboard ka **app shell** ready ho:

1. Koi bhi business **signup** kare → email **OTP verify** → apna **account (tenant)** + **owner** user bane.
2. **Login** (short access JWT + httpOnly refresh cookie, rotation + reuse detection), logout, logout-all, sessions list.
3. **Forgot / reset password**, change password.
4. **Team:** invite (email link), accept, resend, revoke, role change, enable / disable, remove, ownership transfer.
5. **RBAC:** 5 system roles (owner / admin / manager / agent / viewer) + permission catalogue; har route permission-guarded; frontend menu + routes bhi.
6. **API keys** (hashed, scoped, raw sirf ek baar dikhe) + `X-API-Key` auth middleware (public API Phase 10 me use hoga).
7. **Audit log** — kisne kya kiya (immutable), list + filters, 1 saal purge.
8. **Account settings** — business name, timezone, default language, calling window, recording / AI-disclosure flags.
9. **Superadmin** — accounts list / detail, suspend / enable, **impersonate** (audit ke saath, banner, time-limited).
10. **WebSocket tickets endpoint** (`POST /api/v1/ws/tickets`) — frontend realtime ON.
11. **Frontend:** auth screens, main layout (sidebar, header, light/dark, responsive), permission-gated routes + menu, 403/404, confirm dialog, dashboard skeleton, Team, Settings, Superadmin pages.
12. **Playwright E2E** — "naya account bane → team member invite ho → roles se menu badle".

**Done when (BUILD_PLAN):** Naya account bane, team member invite ho, roles se menu badle — Playwright test se proven.

### Phase 2 mein kya NAHI hoga

| Kaam                                                 | Kaunse phase mein                                                                         |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Wallet, rate cards, **superadmin "rates set karna"** | Phase 4 (RateCard model wahi banega) — Phase 2 superadmin page me "Rates" tab placeholder |
| Custom roles editor (apne roles banana)              | Later (Phase 11) — schema ready, Phase 2 me sirf 5 system roles                           |
| In-app notifications (bell)                          | Phase 4 (low balance pehla use-case)                                                      |
| Public API routes (`X-API-Key` se)                   | Phase 10 — Phase 2 me sirf keys + middleware + test route                                 |
| 2FA / SSO / social login                             | Phase 11 (security) — out of scope                                                        |
| UI translations (Hindi UI)                           | Out of scope (dashboard English)                                                          |
| Topic ownership check for WS (`TODO(P7/P8)`)         | Phase 7/8                                                                                 |

### Conventions to follow

[api.md](../conventions/api.md) (§10 headers, §12 dashboard vs public, **§13 tenant scoping**) · [error-codes.md](../conventions/error-codes.md) · [data.md](../conventions/data.md) · [data-model.md](../conventions/data-model.md) §2.1 · [websocket.md](../conventions/websocket.md) §2, §11 · [secrets.md](../conventions/secrets.md) · [code-style.md](../conventions/code-style.md) · ADRs [0009 auth tokens](../adr/0009-auth-tokens.md), [0011 UI kit](../adr/0011-ui-kit-and-template.md) (plain MUI, **no Mantis code**), [0012 state](../adr/0012-frontend-state.md), [0013 forms](../adr/0013-forms.md), [0017 dates](../adr/0017-dates-and-timezones.md), [0029 OpenAPI types](../adr/0029-shared-api-types-via-openapi.md), [0030 email](../adr/0030-email-delivery.md).

---

## 1. Locked decisions (pehle se tay — implementation me dobara debate nahi)

### 1a. Backend auth

| Topic               | Decision                                                                                                                                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Password hashing    | **argon2id** via **`@node-rs/argon2`** (prebuilt N-API binaries, no node-gyp). Params: `memoryCost 19456 KiB, timeCost 2, parallelism 1` (OWASP). Rehash on login if params change.                                                                                                                                                   |
| Password policy     | 10–128 chars, not equal to email / name, not in a small built-in common-password list (top ~1k, in repo). No forced complexity rules (NIST).                                                                                                                                                                                          |
| Access token        | **JWT HS256** via **`jose`** (verify CommonJS `require` works on Node 24 — else `jsonwebtoken`). TTL `JWT_ACCESS_TTL` (15m). Claims: `sub` userId, `acc` accountId, `rid` roleId, `tv` user tokenVersion, `sid` session (refresh family) id, `imp` impersonator userId (only when impersonating), `iss` `cav`, `aud` `cav-dashboard`. |
| Refresh token       | **Opaque** 32-byte random (`base64url`), stored as **HMAC-SHA256(JWT_REFRESH_SECRET, token)**. TTL `JWT_REFRESH_TTL` (30d). **Rotated on every refresh**; reuse of a rotated token → **revoke whole family** + audit `auth.refresh_reuse_detected`.                                                                                   |
| Refresh cookie      | Name `cav_rt`, `httpOnly`, `Secure` (production), `SameSite=Strict`, `Path=/api/v1/auth`. Refresh/logout also require an **allowed `Origin`** (CORS_ORIGINS) → CSRF protection.                                                                                                                                                       |
| Token invalidation  | `users.tokenVersion` bump (password change / reset, disable, role change, logout-all) → existing access tokens fail immediately (`tv` mismatch).                                                                                                                                                                                      |
| Per-request auth    | `authenticate` middleware verifies JWT then loads user + role + account (lean, indexed `_id`) — checks `user.status = active`, `account.status = active` (suspended → read-only, see below), `tv` match. No cache in Phase 2 (add later if needed).                                                                                   |
| Suspended account   | Login allowed (to see banner), **all non-GET requests → 403 `AUTH_ACCOUNT_SUSPENDED`**; superadmin unaffected.                                                                                                                                                                                                                        |
| Email verification  | Signup → 6-digit **OTP** (`crypto.randomInt`), HMAC-hashed, **10 min**, **5 attempts**, resend cooldown **60 s**, max 5 sends / hour. Login before verify → 403 `AUTH_EMAIL_NOT_VERIFIED` (UI shows OTP screen + resend).                                                                                                             |
| Password reset      | Email **link** with 32-byte token (HMAC-hashed), **30 min**, single use; reset bumps `tokenVersion` + revokes all refresh tokens.                                                                                                                                                                                                     |
| Invites             | Email link token (HMAC-hashed), **7 days**, single use; user doc `status: invited` (email globally unique, so an invited email can't sign up elsewhere until revoked).                                                                                                                                                                |
| Account enumeration | `signup` and `forgot-password` always answer **202** "check your email" (existing email → "you already have an account" email instead). Login failure always `AUTH_INVALID_CREDENTIALS` with a **dummy hash** compare when the user doesn't exist (constant time).                                                                    |
| Brute force         | Per-IP strict limiter on all `/auth/*` (existing `STRICT_RATE_LIMIT`) + **per-email lockout** in Redis: 5 failed logins / 15 min → 429 `AUTH_TOO_MANY_ATTEMPTS` (+ `Retry-After`). OTP/reset attempts counted per code.                                                                                                               |
| Dev secrets         | Outside production, missing `JWT_*` secrets fall back to fixed dev values with a **warn log** (like the storage signing key). Production already requires them (Phase 1 env rules).                                                                                                                                                   |
| Tenant scoping      | `req.auth.accountId` from the token **only** (api.md §13). Helper `scoped(Model, req)` / `tenantFilter(req)` used by every service; a lint-style test greps services for `req.body.accountId`.                                                                                                                                        |

### 1b. RBAC

| Topic              | Decision                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Permission strings | `domain.action`, lower_snake (e.g. `team.invite`). Single catalogue file `src/modules/rbac/permissions.ts` — the **only** place they're defined; exported to OpenAPI (`/api/v1/rbac/permissions`) so the frontend uses the same list.                                                                                                                                                   |
| System roles       | owner, admin, manager, agent, viewer — created per account at signup (`isSystem: true`, not deletable / editable in Phase 2). Role → permissions map in code (`SYSTEM_ROLES`); a migration re-syncs existing accounts when the map changes.                                                                                                                                             |
| Owner rules        | Exactly **one owner** per account; owner can't be disabled / removed / demoted; ownership transfer endpoint (owner only, target must be active admin → becomes owner, old owner → admin).                                                                                                                                                                                               |
| Superadmin         | Platform-level, **not** an account role: `users.platformRole = 'superadmin'`, user belongs to an internal **`platform` account** (slug `platform`, created by migration). Created only by CLI `npm run superadmin:create -- <email>` (no HTTP route). Separate permissions `platform.*`.                                                                                                |
| Impersonation      | Superadmin → `POST /api/v1/admin/accounts/:id/impersonate` → access token for that account's **owner** with `imp` claim, TTL **30 min**, **no refresh token**; audit `admin.impersonation_started` (both platform + target account logs). Blocked while impersonating: password / email change, ownership transfer, API key creation, inviting superadmins. UI shows a banner + "Stop". |

**Permission catalogue (Phase 2 defines the full list; later phases only use them):**

| Group                 | Permissions                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| Account               | `account.read`, `account.update`                                                               |
| Team                  | `team.read`, `team.invite`, `team.update` (role, enable/disable), `team.remove`                |
| API keys              | `apikeys.read`, `apikeys.manage`                                                               |
| Audit                 | `audit.read`                                                                                   |
| Contacts (P3)         | `contacts.read`, `contacts.write`, `contacts.import`, `contacts.export`                        |
| Wallet (P4)           | `wallet.read`, `wallet.topup`                                                                  |
| AI agents (P5)        | `agents.read`, `agents.write`                                                                  |
| Flows (P6)            | `flows.read`, `flows.write`, `flows.publish`                                                   |
| Calls (P7/9)          | `calls.read`, `calls.trigger`, `calls.listen` (recordings), `calls.export`                     |
| Campaigns (P8)        | `campaigns.read`, `campaigns.write`, `campaigns.run`                                           |
| Reports (P9)          | `reports.read`, `reports.export`                                                               |
| Integrations (P10/13) | `integrations.manage`, `telephony.manage`                                                      |
| Platform              | `platform.accounts.read`, `platform.accounts.manage`, `platform.impersonate` (superadmin only) |

**Role matrix:**

| Permission group                        | owner | admin | manager | agent | viewer |
| --------------------------------------- | :---: | :---: | :-----: | :---: | :----: |
| account.read                            |  ✅   |  ✅   |   ✅    |  ✅   |   ✅   |
| account.update                          |  ✅   |  ✅   |         |       |        |
| team.read                               |  ✅   |  ✅   |   ✅    |       |        |
| team.invite / team.update / team.remove |  ✅   |  ✅   |         |       |        |
| apikeys.read / apikeys.manage           |  ✅   |  ✅   |         |       |        |
| audit.read                              |  ✅   |  ✅   |         |       |        |
| contacts.read                           |  ✅   |  ✅   |   ✅    |  ✅   |   ✅   |
| contacts.write / import                 |  ✅   |  ✅   |   ✅    |       |        |
| contacts.export                         |  ✅   |  ✅   |   ✅    |       |        |
| wallet.read                             |  ✅   |  ✅   |   ✅    |       |   ✅   |
| wallet.topup                            |  ✅   |  ✅   |         |       |        |
| agents.* / flows.read+write             |  ✅   |  ✅   |   ✅    | read  |  read  |
| flows.publish                           |  ✅   |  ✅   |   ✅    |       |        |
| calls.read                              |  ✅   |  ✅   |   ✅    |  ✅   |   ✅   |
| calls.trigger / calls.listen            |  ✅   |  ✅   |   ✅    |  ✅   |        |
| calls.export / reports.export           |  ✅   |  ✅   |   ✅    |       |        |
| campaigns.read                          |  ✅   |  ✅   |   ✅    |  ✅   |   ✅   |
| campaigns.write / campaigns.run         |  ✅   |  ✅   |   ✅    |       |        |
| reports.read                            |  ✅   |  ✅   |   ✅    |       |   ✅   |
| integrations.manage / telephony.manage  |  ✅   |  ✅   |         |       |        |

(Owner-only actions are checked in code, not via permissions: ownership transfer, account deletion request.)

### 1c. Frontend

| Topic        | Decision                                                                                                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Access token | Kept **in memory only** (Zustand `authStore`); never localStorage. On app load → `POST /auth/refresh` (cookie) → token + `GET /auth/me`.                                                                           |
| 401 handling | Axios interceptor: attach `Authorization`; on `401 AUTH_TOKEN_EXPIRED` → **single-flight** refresh → retry the request **once**; refresh fails → clear session → `/login?next=…`.                                  |
| State        | React Query (server), **Zustand 5** for `authStore` (token, user, permissions, impersonation) only (ADR 0012).                                                                                                     |
| Forms        | react-hook-form + zod (`@hookform/resolvers`), server `details` → `applyFieldErrors` (Phase 1).                                                                                                                    |
| Layout       | Plain MUI 9 (ADR 0011 — no Mantis). Permanent sidebar ≥ md, temporary drawer < md; header: account name, WS status dot, theme toggle, user menu. Light/dark via MUI `colorSchemes` + `useColorScheme` (persisted). |
| Route guard  | `<RequireAuth>` (redirect to login with `next`), `<RequirePermission perm="…">` (→ 403 page), `<RequirePlatformAdmin>`; menu items declare their permission and hide when missing.                                 |
| Dates        | `date-fns` + `@date-fns/tz` — show times in the **account timezone** (ADR 0017).                                                                                                                                   |
| Realtime     | `RealtimeProvider getTicket={issueWsTicket}` once logged in (Phase 1 provider), disconnect on logout; header shows status.                                                                                         |
| Query keys   | Convention doc: `['<feature>', '<entity>', params?]`, all keys in `features/<x>/keys.ts` (ADR 0012 follow-up).                                                                                                     |

### 1d. New error codes (error-codes.md + `ERROR_CODES` together)

| Code                         | HTTP | When                                               |
| ---------------------------- | ---- | -------------------------------------------------- |
| `AUTH_EMAIL_NOT_VERIFIED`    | 403  | Login / action before the email OTP was confirmed  |
| `AUTH_ACCOUNT_SUSPENDED`     | 403  | Write request on a suspended account               |
| `AUTH_USER_DISABLED`         | 403  | Disabled team member tries to log in / use a token |
| `AUTH_SESSION_REVOKED`       | 401  | Refresh token revoked / reused (family revoked)    |
| `AUTH_CODE_INVALID`          | 422  | Wrong / expired OTP, reset or invite token         |
| `AUTH_TOO_MANY_ATTEMPTS`     | 429  | Login lockout / OTP attempts / resend cooldown     |
| `AUTH_IMPERSONATION_BLOCKED` | 403  | Action not allowed while impersonating             |

Existing ones reused: `AUTH_UNAUTHENTICATED`, `AUTH_TOKEN_EXPIRED`, `AUTH_INVALID_CREDENTIALS`, `AUTH_FORBIDDEN`, `CONFLICT_DUPLICATE`, `CONFLICT_INVALID_STATE`, `VALIDATION_FAILED`, `RESOURCE_NOT_FOUND`.

### 1e. Dependencies (verify latest at batch start; versions checked 2026-10-08)

| Repo     | Package                                  | Version (today) | Note                                                   |
| -------- | ---------------------------------------- | --------------- | ------------------------------------------------------ |
| backend  | `@node-rs/argon2`                        | 2.2.2           | prebuilt binaries — check `allowScripts` (expect none) |
| backend  | `jose`                                   | 6.2.12          | verify CJS `require` on Node 24 in T2.2                |
| backend  | `cookie-parser` + `@types/cookie-parser` | 1.4.7 / 1.4.10  | signed cookies not needed (opaque token)               |
| frontend | `zustand`                                | 5.0.15          | auth store                                             |
| frontend | `date-fns`, `@date-fns/tz`               | 4.4.0 / 1.5.0   | account-timezone display                               |
| frontend | `@playwright/test`                       | latest at T2.18 | E2E (browsers download — `allowScripts` review)        |

---

## 2. Tasks ka overview

| #     | Task                                                                                                                     | Repo | Size | Depends on         |
| ----- | ------------------------------------------------------------------------------------------------------------------------ | ---- | ---- | ------------------ |
| T2.1  | Data models, permission catalogue, system roles, migrations, seeds, superadmin CLI                                       | BE   | M    | Phase 1            |
| T2.2  | Crypto + token services (argon2, JWT, refresh rotation, codes), env, error codes                                         | BE   | M    | T2.1               |
| T2.3  | Auth middlewares: `authenticate`, `requirePermission`, `apiKeyAuth`, tenant helpers, suspension                          | BE   | M    | T2.2               |
| T2.4  | Signup + email OTP verify + resend (+ email templates)                                                                   | BE   | M    | T2.3               |
| T2.5  | Login / refresh / logout / logout-all / me / sessions + lockout                                                          | BE   | M    | T2.4               |
| T2.6  | Forgot / reset / change password                                                                                         | BE   | S    | T2.5               |
| T2.7  | Account settings API                                                                                                     | BE   | S    | T2.3               |
| T2.8  | Team: invite / accept / resend / revoke / list / role / enable-disable / remove / transfer ownership                     | BE   | L    | T2.5, T2.7         |
| T2.9  | API keys API + `X-API-Key` auth                                                                                          | BE   | M    | T2.3               |
| T2.10 | Audit log service + list API + purge job                                                                                 | BE   | M    | T2.3 (used by all) |
| T2.11 | Superadmin: accounts list / detail / suspend / enable / impersonate                                                      | BE   | M    | T2.5, T2.10        |
| T2.12 | WS tickets endpoint + realtime auth events (`session.revoked`, `account.suspended`)                                      | BE   | S    | T2.5               |
| T2.13 | Frontend auth infra: gen:api, authStore, interceptor + refresh, bootstrap, guards, `usePermission`                       | FE   | M    | T2.5               |
| T2.14 | Frontend auth screens: login, signup, verify OTP, forgot, reset, accept invite                                           | FE   | M    | T2.13              |
| T2.15 | Frontend app shell: layout, sidebar, header, theme, responsive, 403/404, confirm dialog, dashboard skeleton, realtime ON | FE   | L    | T2.13, T2.12       |
| T2.16 | Frontend Team + Settings (account, profile, security & sessions, API keys, audit log)                                    | FE   | L    | T2.15              |
| T2.17 | Frontend Superadmin pages + impersonation banner                                                                         | FE   | M    | T2.15, T2.11       |
| T2.18 | Playwright E2E, integration gap audit, docs, Phase 2 sign-off                                                            | both | M    | all                |

**Size:** S = kuch ghante · M = ~1 din · L = 2 din.

**Batches (same style as Phase 1):** **Batch 1 = T2.1–T2.6** (auth core) · **Batch 2 = T2.7–T2.12** (account, team, keys, audit, admin, WS) · **Batch 3 = T2.13–T2.18** (frontend + E2E + sign-off). Har batch: detailed run prompt → implement → `[P2-Bx-DONE]` checkpoint.

---

## 3. Tasks — step by step

### T2.1 — Data models, permissions, system roles, migrations, seeds, superadmin CLI

**Files:** `src/modules/rbac/{permissions.ts, system-roles.ts, rbac.schema.ts, rbac.routes.ts}`, `src/db/models/{account, user, role, refresh-token, auth-code, api-key, audit-log}.model.ts`, `src/db/migrations/{0002-platform-account.ts, 0003-sync-system-roles.ts}`, `scripts/{db-seed.ts, superadmin-create.ts}`, tests.

- [ ] `permissions.ts`: `PERMISSIONS` const (catalogue §1b) + `Permission` type + `PLATFORM_PERMISSIONS`; helper `isPermission(s)`.
- [ ] `system-roles.ts`: `SYSTEM_ROLES: Record<'owner'|'admin'|'manager'|'agent'|'viewer', Permission[]>` per matrix; unit test: owner ⊇ admin ⊇ manager; viewer has no write; every permission belongs to the catalogue; matrix snapshot matches the plan table.
- [ ] Models (Phase 1 plugins: `basePlugin`, `tenantPlugin` where tenant-scoped, `softDeletePlugin` for users):
  - `Account`: fields per data-model §2.1 **+** `ownerId`, `status` (`active|suspended`), `suspendedAt`, `suspendReason`, `isPlatform` (true only for `platform`), `createdAt`. Indexes: `slug` unique, `status`.
  - `User`: per data-model **+** `emailVerifiedAt`, `tokenVersion` (default 0), `platformRole` (`superadmin | null`), `invite: { tokenHash, expiresAt, invitedBy } | null`, `failedLoginCount`? (no — Redis), `lastLoginAt`, `passwordChangedAt`. Email lowercase+trim, `unique`. JSON transform **never** outputs `passwordHash`, `invite.tokenHash`, `tokenVersion`.
  - `Role`: per data-model (`accountId, name, key (owner…), permissions, isSystem`). Index `{ accountId, key }` unique.
  - `RefreshToken`: per data-model (`familyId`, `tokenHash`, `expiresAt` TTL, `revokedAt`, `revokedReason`, `replacedBy`, `userAgent`, `ip`, `lastUsedAt`, `impersonated`? no — impersonation has no refresh).
  - `AuthCode` (new collection `authCodes`): `userId, purpose (verify_email|reset_password), codeHash, attempts, sentCount, lastSentAt, expiresAt (TTL), usedAt`. Index `{ userId, purpose }`, TTL.
  - `ApiKey`, `AuditLog` per data-model (AuditLog: **no update/delete** — model throws on save of existing doc; `at` index).
- [ ] Update **data-model.md** §2.1 with the added fields + `authCodes` + `platform` account + ERD (Mermaid) in the same commit.
- [ ] Migrations: `0002-platform-account` (create `platform` account if missing) · `0003-sync-system-roles` (for every account upsert 5 system roles from `SYSTEM_ROLES`; idempotent; re-runnable when the map changes — documented).
- [ ] `scripts/superadmin-create.ts` + npm `superadmin:create -- <email> [name]`: prompts for password on TTY (or `--password-stdin`), creates/updates user in `platform` account with `platformRole: superadmin`, `emailVerifiedAt: now`; refuses weak passwords; never prints the password.
- [ ] `scripts/db-seed.ts` + npm `db:seed` (**refuses in production**): demo account `Demo Finance` + one active user per role (`owner@demo.local` … `viewer@demo.local`, password from `SEED_PASSWORD` env or a printed random one) + superadmin `admin@demo.local`; idempotent.
- [ ] `GET /api/v1/rbac/permissions` (auth required later in T2.3 — here just schema + catalogue export) → `{ permissions, roles: { key, permissions } }` for the frontend.
- [ ] Tests: model validation + indexes (`listIndexes`), JSON never leaks hashes, migrations idempotent (run twice), seed idempotent, CLI (create + update, weak password rejected), role matrix tests.

### T2.2 — Crypto + token services, env, error codes

**Files:** `src/modules/auth/{password.ts, tokens.ts, codes.ts, common-passwords.ts}`, `src/config/env.ts`, `src/shared/errors/error-codes.ts` + `docs/conventions/error-codes.md`, tests.

- [ ] `password.ts`: `hashPassword`, `verifyPassword` (returns `{ ok, needsRehash }`), `DUMMY_HASH` for constant-time misses, `validatePasswordPolicy(password, { email, name })` → `ErrorDetail[]` (length 10–128, not email/name, not common).
- [ ] `common-passwords.ts`: ~1k most common passwords (lowercase set) — source documented, no network.
- [ ] `tokens.ts`:
  - `signAccessToken({ userId, accountId, roleId, tokenVersion, sessionId, impersonatorId? }, ttl)` / `verifyAccessToken(token)` → typed claims; expired → `AUTH_TOKEN_EXPIRED`; anything else → `AUTH_UNAUTHENTICATED`; clock tolerance 5 s; `iss`/`aud` checked.
  - `createRefreshToken({ userId, familyId?, userAgent, ip })` → raw + doc; `rotateRefreshToken(raw)` → `{ raw, doc, user }` or throws `AUTH_SESSION_REVOKED` (revoked / reused → revoke family + audit) / `AUTH_UNAUTHENTICATED` (unknown) — runs in `withTransaction`.
  - `revokeFamily`, `revokeAllForUser(userId, reason)`.
  - `hmacToken(raw)` (HMAC-SHA256 with `JWT_REFRESH_SECRET`, timing-safe compare helper).
- [ ] `codes.ts`: `issueCode(userId, purpose)` (6 digits for verify_email, 32-byte token for reset/invite) with cooldown + hourly cap; `consumeCode(userId|token, purpose, input)` with attempt counting → `AUTH_CODE_INVALID` / `AUTH_TOO_MANY_ATTEMPTS`.
- [ ] Env: dev fallbacks for `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` outside production (warn once); new `AUTH_COOKIE_DOMAIN` (optional, production subdomain setups) — `.env.example`, README table, env-docs test.
- [ ] Error codes §1d → `ERROR_CODES` + error-codes.md (sync test stays green) + new error classes if needed (`TooManyAttemptsError` with `retryAfterSec` → `Retry-After` header in errorHandler).
- [ ] Tests: hash/verify/rehash, policy table, JWT round-trip / expired / wrong secret / wrong aud / alg none rejected, refresh rotation, **reuse → family revoked**, concurrent rotation of the same token (only one wins), code issue/consume/attempts/cooldown/expiry, timing-safe compare.

### T2.3 — Auth middlewares, tenant helpers, suspension

**Files:** `src/shared/middlewares/{authenticate.ts, require-permission.ts, api-key-auth.ts}`, `src/shared/auth/{context.ts, tenant.ts}`, `src/@types/express.d.ts`, tests.

- [ ] `req.auth: AuthContext` = `{ kind: 'user' | 'api_key', userId?, apiKeyId?, accountId, roleKey?, permissions: Set<string>, platformRole?, impersonatorId?, sessionId? }`.
- [ ] `authenticate()` — Bearer only; verify JWT; load user (+role, +account) lean; checks: user exists & `active`, `tv` match, email verified, account `active` **or** (suspended & method is GET/HEAD) else `AUTH_ACCOUNT_SUSPENDED`; sets `req.auth`; adds `accountId`/`userId` to `req.log` bindings.
- [ ] `requirePermission(...perms)` (all of) / `requireAnyPermission(...)`; `requirePlatformAdmin()`; `blockWhenImpersonating()`.
- [ ] `apiKeyAuth({ scopes })` — `X-API-Key`; lookup by `keyHash`; not revoked; account active; sets `req.auth.kind = 'api_key'`; `lastUsedAt` update throttled (≥ 60 s, fire-and-forget).
- [ ] Tenant helpers: `tenantFilter(req)` → `{ accountId }`; `findOwned(Model, id, req)` → 404 when not in the account (never 403 — no existence leak).
- [ ] Idempotency middleware scope → `req.auth.accountId` (Phase 1 left it injectable).
- [ ] OpenAPI: register `bearerAuth` + `apiKeyAuth` security on routes (components already declared in Phase 1).
- [ ] Tests: missing / malformed / expired / wrong `tv` / disabled user / unverified / suspended (GET ok, POST 403) / permission allowed & denied / platform admin / impersonation block / API key valid / revoked / wrong scope / tenant isolation (user of account A gets 404 on account B id).
- [ ] **Security test:** grep-based test fails if any `src/modules/**` file reads `req.body.accountId` / `req.query.accountId` / `req.params.accountId`.

### T2.4 — Signup + email OTP verify + resend

**Routes** (`src/modules/auth/`): `POST /api/v1/auth/signup`, `POST /auth/verify-email`, `POST /auth/verify-email/resend`.

- [ ] Signup body: `{ businessName, name, email, password, phone? (E.164), timezone? }` → validation (zod + password policy).
- [ ] New email → **transaction**: account (slug from business name, unique suffix), 5 system roles, owner user (`status: active`, `emailVerifiedAt: null`), `account.ownerId`; then `issueCode(verify_email)` → `getEmail().enqueue('auth.verify_email', …, { dedupeKey })`. Existing email → enqueue `auth.account_exists` email. **Both → 202** `{ message }` (same timing budget).
- [ ] Verify body `{ email, code }` → `consumeCode` → `emailVerifiedAt = now` → **logs the user in** (access token + refresh cookie, same as login) → 200 `{ accessToken, user, account, permissions }`. Audit `auth.email_verified`, `account.created`.
- [ ] Resend `{ email }` → 202 always; respects cooldown + hourly cap silently.
- [ ] Email templates: `auth.verify_email` (code, 10 min), `auth.account_exists` (login + reset links). Text + HTML, escaped (Phase 1 template system).
- [ ] Strict rate limiter on all three routes.
- [ ] Tests: happy path (OTP read from memory email provider), duplicate email (202 + other template), weak password 422 details, wrong code attempts → 429, expired code, resend cooldown, slug uniqueness, transaction rollback on failure (no orphan account).

### T2.5 — Login / refresh / logout / sessions + lockout

**Routes:** `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `POST /auth/logout-all`, `GET /auth/me`, `GET /auth/sessions`, `DELETE /auth/sessions/:id`.

- [ ] Login `{ email, password }`: lockout check (Redis `auth:lock:<email-hash>`), dummy-hash path, status checks (`disabled` → `AUTH_USER_DISABLED`, unverified → `AUTH_EMAIL_NOT_VERIFIED`), rehash if needed, `lastLoginAt`, new refresh family → cookie + `{ accessToken, expiresIn, user, account, permissions }`. Audit `auth.login` / `auth.login_failed` (meta: reason, no password).
- [ ] Refresh: cookie only + Origin check → rotate → new cookie + access token; errors clear the cookie.
- [ ] Logout: revoke current family, clear cookie (204, idempotent). Logout-all: bump `tokenVersion`, revoke all families, push WS `session.revoked`.
- [ ] `GET /auth/me` → `{ user, account, role, permissions, impersonation? }` (frontend bootstrap).
- [ ] Sessions: list active families (userAgent, ip, createdAt, lastUsedAt, current flag); revoke one (own sessions only).
- [ ] Tests: full cookie flow with supertest agent, rotation, reuse detection (old cookie replay → 401 + family revoked + audit), lockout after 5 failures (+ `Retry-After`), CSRF (bad Origin → 403), disabled / unverified / suspended paths, logout idempotent, sessions isolation.

### T2.6 — Forgot / reset / change password

**Routes:** `POST /auth/forgot-password`, `POST /auth/reset-password`, `POST /auth/change-password` (auth).

- [ ] Forgot `{ email }` → 202 always; active verified user → reset token → email `auth.reset_password` (link `FRONTEND_URL/reset-password?token=…`).
- [ ] Reset `{ token, password }` → policy → hash → `tokenVersion++` → revoke all refresh tokens → audit → 200 (user must log in again).
- [ ] Change `{ currentPassword, newPassword }` → verify current → policy → hash → `tokenVersion++` → revoke **other** sessions → new tokens for this session; blocked while impersonating.
- [ ] Email `auth.password_changed` (security notice) after reset/change.
- [ ] Tests: token single use, expiry, old access token rejected after reset, other sessions revoked, wrong current password, impersonation blocked.

### T2.7 — Account settings API

**Routes:** `GET /api/v1/account` (`account.read`), `PATCH /api/v1/account` (`account.update`).

- [ ] Editable: `name`, `timezone` (validated against `Intl.supportedValuesOf('timeZone')`), `country` (ISO-3166 alpha-2), `defaultLanguage` (`hi|en|hinglish`), `settings.callingWindow` (`HH:mm` start < end, days 0–6 unique, non-empty), `settings.recordingEnabled`, `settings.aiDisclosureEnabled`. Not editable: `slug`, `status`, `ownerId`.
- [ ] Audit `account.updated` with changed field **names** only.
- [ ] Tests: each validation rule, permission denied for manager/agent/viewer, suspended account PATCH → 403, audit entry.

### T2.8 — Team management

**Routes** (`src/modules/team/`): `GET /team/users` (`team.read`, filters status/role/search, pagination), `POST /team/invites` (`team.invite`), `POST /team/invites/:userId/resend`, `DELETE /team/invites/:userId` (revoke), `POST /auth/accept-invite` (public), `PATCH /team/users/:id` (`team.update` — role, status), `DELETE /team/users/:id` (`team.remove`, soft delete), `POST /team/transfer-ownership` (owner only).

- [ ] Invite `{ email, name, roleKey }` (roleKey ≠ owner) → existing global email → 409 `CONFLICT_DUPLICATE`; create user `status: invited` + invite token → email `team.invite` (inviter, account name, link `FRONTEND_URL/accept-invite?token=…`, 7 days).
- [ ] Accept `{ token, name?, password }` → active + verified + logged in (tokens + cookie).
- [ ] Role change → bump target `tokenVersion` (permissions refresh), push WS `session.revoked`? (no — `user.updated` event so the UI refetches `me`). Disable → `tokenVersion++` + revoke sessions + WS `session.revoked`.
- [ ] Guards: can't change/disable/remove owner or yourself (except own profile), only owner can grant/remove `admin`, transfer rules (§1b).
- [ ] Audit every action (`team.invited`, `team.invite_revoked`, `team.role_changed`, `team.disabled`, `team.enabled`, `team.removed`, `account.ownership_transferred`).
- [ ] Tests: full matrix (who can do what), last-owner protection, invite expiry/reuse, accept sets password + logs in, disabled user's tokens stop working immediately, tenant isolation, pagination/search.

### T2.9 — API keys

**Routes** (`src/modules/api-keys/`): `GET /api-keys` (`apikeys.read`), `POST /api-keys` (`apikeys.manage`, blocked while impersonating), `DELETE /api-keys/:id` (revoke).

- [ ] Key format `cav_live_<32 base62>` (`cav_test_` outside production); store `prefix` (first 12 chars) + `keyHash` (SHA-256); **raw key returned once** in the create response.
- [ ] Scopes from a `API_KEY_SCOPES` catalogue (e.g. `calls:write`, `contacts:write`, `campaigns:read`, … — full list in Phase 10, Phase 2 defines the mechanism + current list).
- [ ] `GET /api/v1/api-keys/whoami` (API-key auth) — test route returning `{ accountId, keyId, scopes }` (documented, used by Phase 10 smoke).
- [ ] Audit `apikey.created` / `apikey.revoked`; max 20 active keys per account.
- [ ] Tests: raw key never stored / never returned again, revoked key → 401, wrong scope → 403, `lastUsedAt` throttling, tenant isolation.

### T2.10 — Audit log

**Files:** `src/modules/audit/{audit.service.ts, audit.routes.ts, audit-actions.ts}`, `src/core/queues/workers/audit-purge.worker.ts`.

- [ ] `audit.record({ req | system }, action, target?, meta?)` — actor from `req.auth` (user / api_key / system; impersonation → `actor.impersonatorId`), ip, at; **never throws** into the request (logs on failure); meta validated to contain no obvious PII keys (`password`, `token`, `code`, `email` values → stripped).
- [ ] `AUDIT_ACTIONS` catalogue (typed) — every action string used in Phase 2 listed + documented in a new **docs/conventions/audit.md**.
- [ ] `GET /api/v1/audit-logs` (`audit.read`) — cursor pagination, filters: `actorId`, `action` (prefix), `from`/`to`, `targetType`; newest first.
- [ ] Purge job: BullMQ repeatable daily (system queue or `maintenance` queue) deletes entries older than 365 days (batch delete).
- [ ] Tests: record from user / api key / system / impersonation, PII stripping, immutability (update attempt throws), list filters + pagination + tenant isolation, purge deletes only old entries.

### T2.11 — Superadmin

**Routes** (`src/modules/admin/`, all `requirePlatformAdmin`): `GET /admin/accounts` (search name/slug/owner email, status filter, pagination, counts: users), `GET /admin/accounts/:id` (account + owner + users count + recent audit), `POST /admin/accounts/:id/suspend` `{ reason }`, `POST /admin/accounts/:id/enable`, `POST /admin/accounts/:id/impersonate`, `POST /admin/impersonation/stop`.

- [ ] Suspend → `status: suspended` + WS `account.suspended` to the account (UI shows banner) + audit (platform + target). Enable reverses.
- [ ] Impersonate → §1b rules; response `{ accessToken, expiresIn, account, user }`; audit both sides; stop → audit end (token simply expires / discarded).
- [ ] `platform` account can't be suspended / impersonated.
- [ ] Tests: non-superadmin 403 on every route, suspend → writes blocked + reads ok, impersonation token claims, no refresh cookie issued, blocked actions while impersonating, audit entries.

### T2.12 — WS tickets + realtime auth events

- [ ] `POST /api/v1/ws/tickets` (auth) `{ channel?: 'events' }` → `WsTicketService.issue({ userId, accountId, channel })` → `{ ticket, expiresAt }` (Phase 1 service; `media` channel stays for Phase 7).
- [ ] Event catalogue additions (websocket.md §5 + backend `events.ts` + frontend `events.ts`): `session.revoked` (user-targeted: `{ reason }`), `account.suspended` / `account.enabled`, `user.updated` (`{ userId }`).
- [ ] `pushToUser(userId, …)` helper in realtime (route by account + filter user) if not present.
- [ ] On `session.revoked` for a user → server also closes that user's sockets (4001).
- [ ] Remove `npm run ws:dev-ticket` dependency from docs (keep the script for DEV, mention the real endpoint).
- [ ] Tests: ticket requires auth, ticket bound to the caller, events delivered only to the right user/account, sockets closed on revoke.

### T2.13 — Frontend auth infra

- [ ] Backend `gen:openapi` → frontend `gen:api` (all Phase 2 routes typed).
- [ ] `authStore` (Zustand): `accessToken`, `user`, `account`, `permissions`, `impersonation`, actions `setSession`, `clear`.
- [ ] `services/api/auth.ts` (login, signup, verify, refresh, logout, me, …) using `unwrap`; `withCredentials` already on.
- [ ] Interceptors: request → Bearer; response → `AUTH_TOKEN_EXPIRED` single-flight refresh + retry once (guard against loops: refresh/logout calls excluded); other 401 → clear + redirect. Remove Phase 2 TODOs in `client.ts`.
- [ ] Bootstrap: `<AuthBootstrap>` tries refresh+me on load (spinner), then renders routes; listens to WS `session.revoked` → logout.
- [ ] Guards `RequireAuth`, `RequirePermission`, `RequirePlatformAdmin`, `RedirectIfAuthed`; hook `usePermission(perm)` / `useCan()`.
- [ ] Query key convention doc (`src/README.md`) + `queryClient.clear()` on logout.
- [ ] Tests: interceptor single-flight (3 parallel 401s → 1 refresh), retry once, refresh failure → logout, guards redirect with `next`, permission hook.

### T2.14 — Frontend auth screens

- [ ] Pages: `/login`, `/signup`, `/verify-email` (6-box OTP input, paste support, resend with countdown), `/forgot-password`, `/reset-password?token=`, `/accept-invite?token=`.
- [ ] react-hook-form + zod (mirror password policy client-side for instant feedback; server stays the authority), `applyFieldErrors`, loading states, error alerts via `getErrorMessage`, `AUTH_EMAIL_NOT_VERIFIED` from login → go to verify screen, 429 → show retry time.
- [ ] Auth layout (centered card, logo, theme-aware), accessibility (labels, focus, Enter submits).
- [ ] Tests (RTL): each page happy path + main error paths with mocked API.

### T2.15 — Frontend app shell

- [ ] `AppLayout`: sidebar (menu config with icon, label, path, permission), header (account name, impersonation/suspended banner slot, WS status dot, theme toggle, user menu: profile, sessions, logout), content outlet, breadcrumbs/page title component.
- [ ] Responsive: permanent drawer ≥ md, collapsible; temporary drawer < md; mobile header menu button.
- [ ] Theme: light/dark (`colorSchemes`, `useColorScheme`, persisted), brand colors in `theme/`.
- [ ] Pages: Dashboard skeleton (welcome, account card, placeholder widgets for calls/wallet/campaigns with "coming in Phase X"), 403 page, 404 (existing), error boundary page.
- [ ] Shared components: `ConfirmDialog` (+ `useConfirm()` promise API), `PageHeader`, `EmptyState`, `DataTable` (MUI table + pagination + loading/empty/error), `StatusChip`.
- [ ] Realtime ON: `RealtimeProvider getTicket={issueWsTicket}` inside auth; status indicator; handle `account.suspended` / `user.updated` (refetch `me`).
- [ ] Menu (Phase 2 live items): Dashboard, Team, Settings; later items present but hidden until their phase (config flag).
- [ ] Tests: menu hides items without permission, drawer responsive behaviour, theme toggle, confirm dialog, banner rendering.

### T2.16 — Frontend Team + Settings

- [ ] **Team** (`team.read`): table (name, email, role, status, last login), search + filters, invite dialog, resend / revoke invite, change role, enable/disable, remove (ConfirmDialog), transfer ownership (owner only); actions hidden without permission.
- [ ] **Settings** tabs: Account (`account.update` editable, else read-only; timezone autocomplete, calling window editor), Profile (name, phone), Security (change password, sessions list + revoke, logout-all), API keys (`apikeys.*`: list, create dialog with scopes, **show-once key with copy button**, revoke), Audit log (`audit.read`: table, filters, cursor "load more", times in account TZ).
- [ ] Tests: per page main flows + permission-based hiding.

### T2.17 — Frontend Superadmin

- [ ] Routes `/admin/accounts` (list, search, status filter), `/admin/accounts/:id` (detail, users count, recent audit, suspend/enable with reason dialog, Impersonate button), "Rates" tab placeholder ("Phase 4").
- [ ] Impersonation: store real session aside, switch `authStore` to impersonation token, persistent **warning banner** ("Viewing as <account> — Stop"), auto-stop on expiry, Stop → restore superadmin session.
- [ ] Superadmin menu section only for `platformRole = superadmin`.
- [ ] Tests: guards, suspend flow, impersonation start/stop/expiry.

### T2.18 — E2E, gap audit, docs, sign-off

- [ ] Playwright (`@playwright/test`, Chromium only) in the **frontend repo** (`e2e/`), runs against local backend + frontend dev servers; OTP / invite links read from the **Mailpit API**.
- [ ] Scenarios: (1) signup → OTP → dashboard → logout → login; (2) owner invites manager → accept invite (new context) → manager sees Team read-only, no API keys/Audit menu; (3) owner changes manager → viewer → menu changes after refresh/event; (4) superadmin suspends account → owner sees banner + write blocked → enable; (5) forgot → reset → old session invalid.
- [ ] CI: Playwright job (optional / manual trigger until both repos run together in CI — documented).
- [ ] Gap audit table (requirement → test) like Phase 1; coverage gates kept (thresholds re-measured, round down to 5).
- [ ] Docs: README (auth setup, seed, superadmin CLI, Mailpit OTP), conventions (error codes, websocket events, audit.md, api.md auth section), data-model.md, ADR updates (0009 implementation notes, 0011 status note), CHANGELOGs, PHASE_2_TASKS, BUILD_PLAN status, **PHASE_2_SIGNOFF.md**.
- [ ] Security checklist run: no secrets in logs (grep test), cookies flags, CORS + Origin check, rate limits, enumeration responses, token invalidation paths, tenant isolation tests, gitleaks.

---

## 4. Deliverables checklist

- [ ] Accounts, users, roles, refresh tokens, auth codes, API keys, audit logs models + migrations + seed + superadmin CLI
- [ ] Permission catalogue + 5 system roles (single source, exported to frontend)
- [ ] argon2id passwords, JWT access, rotating refresh cookie with reuse detection, token invalidation
- [ ] Signup + OTP verify, login / refresh / logout / logout-all / me / sessions, forgot / reset / change password
- [ ] `authenticate`, `requirePermission`, `apiKeyAuth`, tenant helpers, suspension rule
- [ ] Account settings API
- [ ] Team: invite / accept / resend / revoke / role / enable-disable / remove / ownership transfer
- [ ] API keys + `X-API-Key` middleware
- [ ] Audit log + list API + purge job
- [ ] Superadmin accounts + suspend / enable + impersonation
- [ ] `POST /api/v1/ws/tickets` + realtime auth events
- [ ] Frontend: auth infra, auth screens, app shell, Team, Settings, Superadmin, realtime ON
- [ ] Playwright E2E for the "Done when" scenario
- [ ] Docs, CHANGELOGs, sign-off

## 5. Risks

| Risk                                                 | Mitigation                                                                                               |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Token / cookie flow bugs (refresh races, loops)      | Single-flight refresh, retry once, exhaustive interceptor tests, Playwright reload/expiry scenario       |
| Cross-tenant data leak                               | `accountId` only from token, `findOwned` 404, grep test, isolation test per module                       |
| Account enumeration / brute force                    | 202 responses, dummy hash, per-IP + per-email limits, OTP attempt caps                                   |
| Native dependency install issues (`@node-rs/argon2`) | Prebuilt binaries; verify on macOS + Linux CI (fallback: `argon2` package with approved script)          |
| `jose` ESM in CommonJS backend                       | Node 24 `require(esm)`; verify in T2.2, fallback `jsonwebtoken`                                          |
| Impersonation abuse                                  | Superadmin only (CLI-created), 30 min, no refresh, audited both sides, blocked sensitive actions, banner |
| Production email not configured                      | Phase 1 rule fails fast; client SMTP still pending — dev/test via Mailpit                                |
| Scope creep (custom roles, notifications, rates)     | Explicitly deferred (§0 table)                                                                           |

## 6. Recommended order

| Day | Tasks        |
| --- | ------------ |
| 1   | T2.1, T2.2   |
| 2   | T2.3, T2.4   |
| 3   | T2.5, T2.6   |
| 4   | T2.7, T2.8   |
| 5   | T2.9, T2.10  |
| 6   | T2.11, T2.12 |
| 7   | T2.13, T2.14 |
| 8   | T2.15        |
| 9   | T2.16        |
| 10  | T2.17, T2.18 |

_Estimate — run batch-wise with detailed run prompts (Batch 1 = T2.1–T2.6, Batch 2 = T2.7–T2.12, Batch 3 = T2.13–T2.18)._

---

## Changelog

- 2026-10-08: Plan created after Phase 1 sign-off.
- 2026-10-08: Run prompt [PHASE_2_PROMPT.md](../prompts/PHASE_2_PROMPT.md) added (one file, 3 batches). Precisions there: branch `feature/phase-2-auth` from the phase-1 tip; `jose` verified with CommonJS on Node 24 (fallback `jsonwebtoken`); `@node-rs/argon2` has no install scripts; `PATCH /auth/me` (profile name/phone) added in T2.16; `GET /auth/invite-info` for the accept page; new WS events `account.updated`, `team.changed`; `maintenance` queue for the audit purge; Playwright 1.64.0.
- 2026-10-08: Batch 1 (T2.1–T2.6) done. Deviations: superadmin CLI + `db:seed` moved from T2.1 to T2.2 (need password hashing); auth limiter is **per IP + route, 30 / 15 min** (new `AUTH_RATE_LIMIT`, own Redis store `rl:auth:`, IPv6 /56 via `ipKeyGenerator`) instead of the global `STRICT_RATE_LIMIT` (10 / 15 min per IP would lock out offices behind one NAT — brute force is covered by the per-email lockout + OTP caps); lockout answers 401 for the first 5 failures and 429 from the 6th; reset checks the token → validates the password → then consumes the token (a weak password doesn't burn the link); `basePlugin` got a `hide` option for secret fields; `authCodes` keeps one live code per user + purpose (new code replaces the old one). Bugs found in the checkpoint and fixed: OTP in the email subject (logged) → subjects never carry secrets; gitleaks false positive on the common-password list → path allowlisted.
