# P2 RUN — Auth, Accounts, RBAC + App Shell (T2.1 → T2.18) — Autonomous Run Prompt

> **HOW TO RUN — 3 batches, one at a time (same as Phase 1). Har batch ke baad report padho, phir agla paste karo.**
>
> **Batch 1 (backend auth core):**
> `cell-ai-voicebot-backend/docs/prompts/PHASE_2_PROMPT.md padho aur BATCH 1 (T2.1 se P2-B1-DONE tak) SAARE tasks step by step autonomously implement karo. Bich me koi question mat poochho, permission mat maango — saare decisions is prompt me pre-made hain. Har task ke baad verify + commit (tag [P2-T2.x]). Koi push / merge NAHI. Ant me P2-B1-DONE checkpoint + final report.`
>
> **Batch 2 (account, team, keys, audit, superadmin, WS):**
> `cell-ai-voicebot-backend/docs/prompts/PHASE_2_PROMPT.md padho aur BATCH 2 (T2.7 se P2-B2-DONE tak) SAARE tasks step by step autonomously implement karo. Bich me koi question mat poochho, permission mat maango. Har task ke baad verify + commit (tag [P2-T2.x]). Koi push / merge NAHI. Ant me P2-B2-DONE checkpoint + final report.`
>
> **Batch 3 (frontend + E2E + sign-off):**
> `cell-ai-voicebot-backend/docs/prompts/PHASE_2_PROMPT.md padho aur BATCH 3 (T2.13 se P2-B3-DONE tak) SAARE tasks step by step autonomously implement karo. Bich me koi question mat poochho, permission mat maango. Har task ke baad verify + commit (tag [P2-T2.x]). Koi push / merge NAHI. Ant me P2-B3-DONE checkpoint + Phase 2 sign-off + final report.`
>
> **Claude Code "accept edits" mode me chalao.** Working directory: `/Users/lalitbansal/Documents/cell-ai-voicebot`. **Docker Desktop chalu hona chahiye** (`open -a Docker`).

---

## 0. CONTEXT (verified facts — dobara derive mat karna)

**Phase 1 done & signed off** ([PHASE_1_SIGNOFF.md](../phases/PHASE_1_SIGNOFF.md)). Backend branch `feature/phase-1-foundation` (last commits `e1c4689 [P1-B3-DONE]`, `b73855f [P2-PLAN]`, 310 tests). Frontend branch `feature/phase-1-foundation` (`94f9361`, 85 tests). Neither merged.

**Phase 2 branches:** create **`feature/phase-2-auth`** in **both** repos from the tip of `feature/phase-1-foundation` (Phase 1 is not merged yet — branching from it keeps history; the merge order later is phase-1 → dev, then phase-2 → dev).

**Pehle padho (har batch se pehle):** [PHASE_2_PLAN.md](../phases/PHASE_2_PLAN.md) (**source of truth for scope + locked decisions §1**), [src/README.md](../../src/README.md), conventions [api.md](../conventions/api.md) (§10, §12, **§13**), [error-codes.md](../conventions/error-codes.md), [data.md](../conventions/data.md), [data-model.md](../conventions/data-model.md) §2.1, [websocket.md](../conventions/websocket.md) (§2, §5, §11), [secrets.md](../conventions/secrets.md), ADRs 0009, 0011, 0012, 0013, 0017, 0029, 0030. Frontend: `src/README.md`, `README.md`.

**What exists (use it, don't rebuild):**

| Area                               | Provides                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config/env.ts`                | `loadEnv/getEnv/resetEnvForTests`, `ENV_KEYS` (env-docs test), `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `JWT_ACCESS_TTL` (15m), `JWT_REFRESH_TTL` (30d), `ENCRYPTION_KEY`, `APP_URL`, `FRONTEND_URL`, `CORS_ORIGINS`; production requires JWT secrets ≥ 32 chars                                                                                                                                                                              |
| `src/config/limits.ts`             | `STRICT_RATE_LIMIT = { windowMs: 15 min, limit: 10 }`, `GLOBAL_RATE_LIMIT`                                                                                                                                                                                                                                                                                                                                                                      |
| `src/shared/middlewares/*`         | `validate` / **`handle(schemas, async ({ body, query, params, req, res }) => …)`**, `strictRateLimiter(overrides)`, `createRateLimiter`, `idempotency({ required, scope: (req) => accountId })`, `errorHandler`, `notFound`, `corsMiddleware` (`CORS_EXPOSED_HEADERS`), `securityHeaders`, `docsCsp`                                                                                                                                            |
| `src/shared/errors/*`              | `AppError(code, message?, details?, { cause })`, `ValidationError(details)`, `NotFoundError`, `ConflictError(code)`, `UnauthenticatedError(code)`, `ForbiddenError`, `RateLimitedError`, `ProviderError`; `ERROR_CODES` ↔ error-codes.md (sync test)                                                                                                                                                                                            |
| `src/shared/http/envelope.ts`      | `ok(res, data, meta?)`, `created`, `noContent`                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/shared/validation/schemas.ts` | `ObjectIdSchema`, `PaginationQuerySchema`, `CursorQuerySchema`, `sortSchema`, `PhoneE164Schema`, `strictQuery`                                                                                                                                                                                                                                                                                                                                  |
| `src/shared/openapi/*`             | `registry`, `z` (with `.openapi()`), `ErrorEnvelopeSchema`, `successEnvelope()`, `OffsetPageMetaSchema`, `CursorPageMetaSchema`; `bearerAuth` + `apiKeyAuth` security schemes already declared; `npm run gen:openapi` / `openapi:check`                                                                                                                                                                                                         |
| `src/db/*`                         | `connectMongo`, `withTransaction(fn)`, plugins `basePlugin` (id JSON, timestamps), `tenantPlugin` (`accountId` indexed), `softDeletePlugin` (`withDeleted`), migrations registry `src/db/migrations/index.ts` (`0001-baseline`), `npm run db:migrate[:status                                                                                                                                                                                    | :down]`, `db:sync-indexes`; `src/db/models/idempotency-key.model.ts` |
| `src/core/queues/*`                | `getAppRedis`, `createQueue/createWorker(name, …, { redisUrl, logger, prefix })`, `QUEUES` (`system`, `email`), `closeAllQueues({ logger })` (5 s budget), heartbeat worker                                                                                                                                                                                                                                                                     |
| `src/core/email/*`                 | `getEmail().enqueue(templateKey, to, vars, { dedupeKey })`, `sendTemplate`, typed registry `EmailTemplateVars` in `templates/index.ts` (add templates there), `escapeHtml`, `renderLayout/renderTextLayout`, `MemoryEmailProvider` (tests)                                                                                                                                                                                                      |
| `src/core/realtime/*`              | `getRealtime().pushToAccount(accountId, type, data)`, `pushToTopic`, `WsTicketService(redis).issue({ userId, accountId, channel })`, clients carry `accountId` + `userId`, `WS_CLOSE`, `WsEventMap` (`events.ts`), fan-out via Redis `ws:fanout`                                                                                                                                                                                                |
| `src/server.ts`                    | `startServer(options)` (env, logger, port 0, installSignalHandlers, queuePrefix, emailProvider, exit); shutdown http 10 → ws 20 → queues 30 → email 35 → redis 40 → mongo 50                                                                                                                                                                                                                                                                    |
| tests                              | `tests/helpers/{test-app.ts (testEnv, buildTestApp), mongo.ts (startTestMongo — shared replica set), redis.ts (requireRedis, uniquePrefix, flushPrefix)}`, `tests/e2e/server.e2e.test.ts`, `tests/config/env-docs.test.ts`; coverage gate 90/80/90/90                                                                                                                                                                                           |
| docker                             | `npm run infra:up` → Mongo 27018, Redis 6380, **Mailpit 1025/8025** (`curl localhost:8025/api/v1/messages`)                                                                                                                                                                                                                                                                                                                                     |
| **Frontend**                       | `apiClient` + `unwrap`, `ApiError` / `toApiError` / `getErrorMessage` / `applyFieldErrors`, `createQueryClient({ notify })` (`meta.silent`), `RealtimeProvider getTicket={null}` in `providers.tsx`, hooks `useWsStatus/useWsEvent/useWsTopic`, `renderWithProviders({ route, routes, queryClient })`, `FakeWebSocket`, `SystemInfoCard`, DEV `/dev/realtime`; coverage gate 90/85/80/90; `client.ts` has the two `TODO (Phase 2)` interceptors |

**Dependencies verified on 2026-10-08:**

| Repo | Package                                  | Version        | Verified                                                                                                                                                                                                                                                            |
| ---- | ---------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BE   | `jose`                                   | 6.2.12         | **ESM-only**, `require('jose')` works on Node 24 (`require(esm)`) — SignJWT/jwtVerify round-trip OK. TS 6 `module: NodeNext` allows importing it from CJS; if `tsc` or Vitest complains → fallback `jsonwebtoken` 9.0.3 (+ `@types/jsonwebtoken`), record deviation |
| BE   | `@node-rs/argon2`                        | 2.2.2          | prebuilt N-API, **no install scripts**; argon2id hash/verify OK                                                                                                                                                                                                     |
| BE   | `cookie-parser` / `@types/cookie-parser` | 1.4.7 / 1.4.10 |                                                                                                                                                                                                                                                                     |
| FE   | `zustand`                                | 5.0.15         |                                                                                                                                                                                                                                                                     |
| FE   | `date-fns` / `@date-fns/tz`              | 4.4.0 / 1.5.0  |                                                                                                                                                                                                                                                                     |
| FE   | `@playwright/test`                       | 1.64.0         | browsers via `npx playwright install chromium` (downloads to the user cache, not node_modules)                                                                                                                                                                      |

Machine: Docker running; **never touch other containers (Supabase stack)** — only `npm run infra:*` / `docker compose` inside the backend repo.

---

## 1. LOCKED DECISIONS

**Everything in [PHASE_2_PLAN.md §1](../phases/PHASE_2_PLAN.md) is locked** (auth, RBAC + permission catalogue + role matrix, superadmin, impersonation, frontend, error codes, deps). Additions / precisions for implementation:

| Topic           | Decision                                                                                                                                                                                                                                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Module layout   | `src/modules/{rbac, auth, account, team, api-keys, audit, admin, realtime-tickets}/` each with `*.routes.ts`, `*.controller.ts` (thin), `*.service.ts` (logic), `*.schema.ts` (zod + OpenAPI registration). Models in `src/db/models/`. Register every schema file in `src/openapi.ts` and every router in `src/routes.ts`. |
| Route prefix    | All under `/api/v1`. Auth routes `/api/v1/auth/*`; admin `/api/v1/admin/*`.                                                                                                                                                                                                                                                 |
| Response shapes | Success envelope everywhere; lists = `ok(res, items, { pagination })` (offset for team/admin lists, cursor for audit). Never return `passwordHash`, token hashes, `tokenVersion`, `invite.tokenHash`.                                                                                                                       |
| Session payload | Login / verify / accept-invite / refresh return `AuthSession` = `{ accessToken, expiresIn (sec), user: PublicUser, account: PublicAccount, role: { key, name }, permissions: string[], impersonation: null \| { impersonatorId, expiresAt } }`. `GET /auth/me` returns the same minus `accessToken/expiresIn`.              |
| Cookie          | `cav_rt`; `httpOnly`, `secure: NODE_ENV === 'production'`, `sameSite: 'strict'`, `path: '/api/v1/auth'`, `maxAge` = refresh TTL, `domain` = `AUTH_COOKIE_DOMAIN` if set. Cleared with the same attributes.                                                                                                                  |
| Origin check    | `/auth/refresh`, `/auth/logout`: if `Origin` header present it must be in `CORS_ORIGINS` (else 403 `AUTH_FORBIDDEN`); absent Origin allowed only outside production (curl/tests) — production requires it.                                                                                                                  |
| HMAC secret     | `hmacToken(raw)` = HMAC-SHA256(`JWT_REFRESH_SECRET`, raw) hex — used for refresh tokens, reset/invite tokens and OTP codes (OTP hash also binds `userId:purpose:code`).                                                                                                                                                     |
| Lockout keys    | Redis `auth:lock:<sha256(email)>` counter, TTL 15 min, threshold 5 → 429 `AUTH_TOO_MANY_ATTEMPTS` with `Retry-After` = remaining TTL; reset on success.                                                                                                                                                                     |
| Slug            | `slugify(businessName)` (lowercase a-z0-9-, max 40) + `-<4 random base36>` if taken; reserved: `platform`, `admin`, `api`, `www`.                                                                                                                                                                                           |
| Audit actions   | Exact list in §T2.10 — use only these strings.                                                                                                                                                                                                                                                                              |
| WS events (new) | `session.revoked` `{ reason }` (user-targeted), `account.suspended` `{ reason }`, `account.enabled` `{}`, `user.updated` `{ userId }`, `team.changed` `{}` (account-wide, Team page refetch).                                                                                                                               |
| Frontend routes | `/login`, `/signup`, `/verify-email`, `/forgot-password`, `/reset-password`, `/accept-invite` (public); `/` dashboard, `/team`, `/settings/:tab` (`account`, `profile`, `security`, `api-keys`, `audit`), `/admin/accounts`, `/admin/accounts/:id`, `/403`, `*` 404; DEV `/dev/realtime` stays.                             |
| Commit tags     | `[P2-T2.x]`; checkpoints `[P2-B1-DONE]`, `[P2-B2-DONE]`, `[P2-B3-DONE]`; frontend commits same tags.                                                                                                                                                                                                                        |

**Version rule:** exact versions above (re-check `npm view <pkg> version` at batch start; newer patch/minor OK, record it); no `--force` / `--legacy-peer-deps`; after each install `npm approve-scripts --allow-scripts-pending` → decide → README "Install scripts".

---

## 2. RULES OF ENGAGEMENT

1. **No questions / no permission requests.** Safe, convention-consistent choice → report as deviation.
2. **Git:** branch `feature/phase-2-auth` (both repos). One commit per task per repo (Conventional Commit + tag). Hooks must pass (**no `--no-verify`**). **No push / merge / tag.** Footer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Run commits **sequentially, one repo at a time** (parallel shells once ran a commit in the wrong repo).
3. **Verify after every task — each command separately, read the output** (no `>/dev/null &&` chains hiding failures):
   - Backend: `npm run lint` · `npm run format:check` · `npm run typecheck` · `npm run test:coverage` · `npm run build` · `npm run openapi:check`
   - Frontend: `npm run lint` · `npm run format:check` · `npm run typecheck` · `npm run test:coverage` · `npm run build`
   - Use `npm run typecheck`, not `npx tsc`. Infra up for backend tests.
4. **Coverage gate must stay green.** If new code drops it → **add tests**, never lower thresholds (re-measure + raise at the sign-off only).
5. **Tests are part of every task** — unit + integration (supertest with `startTestMongo` + real Redis), tenant-isolation test for every tenant-scoped route.
6. **No secrets** in code, logs, fixtures (obvious fakes: `Passw0rd-test-only!`, `owner@demo.local`). Never log passwords, tokens, OTPs, cookies, `Authorization` (logger redaction already covers headers — add `req.body.password`, `*.token`, `*.code` paths if missing + test).
7. **Every new env var** → `env.ts` (+ tests) + `.env.example` + README env table (env-docs test enforces) + local `.env`.
8. **OpenAPI:** every route registered (request + response + security + error responses) → `gen:openapi` → commit `openapi/openapi.json` in the same commit. Frontend `gen:api` at T2.13 and whenever the spec changes in Batch 3.
9. **Docs in the same commit** (`src/README.md` module rows, `README.md`, conventions, data-model.md, ADR notes).
10. **Docker:** only `npm run infra:*`; never stop/remove other containers or volumes.
11. **Real bugs found during manual checks** → reproduce, fix, regression test, separate `fix(...)` commit, note in the checkpoint report (Phase 1 lesson: the queue shutdown bug).

---

## 3. RESUME SAFETY

- Both repos: `git branch --show-current` → `feature/phase-2-auth` (create from `feature/phase-1-foundation` if missing); `git log --oneline -20`; continue after the last `[P2-T2.x]` / checkpoint.
- `npm run infra:up` → `npm ci` (both) → lint → typecheck → `test:coverage` green before continuing.
- Batch 2 requires `[P2-B1-DONE]`; Batch 3 requires `[P2-B2-DONE]` — if missing, stop and report.

---

# ═══════════ BATCH 1 — Auth core (T2.1 → T2.6) ═══════════

## T2.1 — Models, permissions, roles, migrations, seed, superadmin CLI → `feat(rbac): add tenancy and auth models, permission catalogue and system roles [P2-T2.1]`

**Files:** `src/modules/rbac/{permissions.ts, system-roles.ts, rbac.schema.ts, rbac.routes.ts, rbac.controller.ts}`, `src/db/models/{account, user, role, refresh-token, auth-code, api-key, audit-log}.model.ts`, `src/db/migrations/{0002-platform-account.ts, 0003-sync-system-roles.ts}` (+ register in `index.ts`), `src/modules/account/slug.ts`, `scripts/{db-seed.ts, superadmin-create.ts}`, tests, docs.

1. **`permissions.ts`** — `export const PERMISSIONS = [...] as const` exactly the catalogue of PHASE_2_PLAN §1b (account, team, apikeys, audit, contacts, wallet, agents, flows, calls, campaigns, reports, integrations, telephony); `export const PLATFORM_PERMISSIONS = ['platform.accounts.read', 'platform.accounts.manage', 'platform.impersonate'] as const`; types `Permission`, `PlatformPermission`; `isPermission(s)`. Each permission has a one-line description (`PERMISSION_INFO`) for the UI.
2. **`system-roles.ts`** — `SYSTEM_ROLE_KEYS = ['owner','admin','manager','agent','viewer']`; `SYSTEM_ROLES: Record<SystemRoleKey, { name: string; permissions: Permission[] }>` exactly per the role matrix (agent: `account.read, contacts.read, agents.read, flows.read, calls.read, calls.trigger, calls.listen, campaigns.read`; viewer: `account.read, contacts.read, wallet.read, agents.read, flows.read, calls.read, campaigns.read, reports.read`; manager: everything in the matrix rows marked for manager; admin = owner = all `PERMISSIONS`). Tests: owner ⊇ admin ⊇ manager ⊇ agent-or-viewer-specific checks, viewer/agent have no `*.write|manage|update|invite|remove|topup|publish|run|export|import`, every listed permission ∈ catalogue, snapshot of the matrix.
3. **Models** (all with `basePlugin`; tenant ones with `tenantPlugin`):
   - `Account` — `name`, `slug` (unique), `status` (`active|suspended`, default active), `suspendedAt`, `suspendReason`, `ownerId` (ObjectId), `isPlatform` (default false), `timezone` (default `Asia/Kolkata`), `country` (default `IN`), `defaultLanguage` (`hi|en|hinglish`, default `hinglish`), `settings: { callingWindow: { start: '09:00', end: '19:00', days: [1,2,3,4,5,6] }, recordingEnabled: true, aiDisclosureEnabled: true }`. Indexes `{ slug: 1 }` unique, `{ status: 1 }`.
   - `User` (tenant + soft delete) — `name`, `email` (lowercase, trim, unique **global**), `phone?` (E.164), `passwordHash?`, `roleId`, `status` (`invited|active|disabled`), `emailVerifiedAt?`, `tokenVersion` (0), `platformRole` (`superadmin|null`), `invite?: { tokenHash, expiresAt, invitedBy }`, `lastLoginAt?`, `passwordChangedAt?`. `toJSON` strips `passwordHash`, `tokenVersion`, `invite.tokenHash`. Indexes: `{ email: 1 }` unique (partial: `deletedAt: null`), `{ accountId: 1, status: 1 }`, `{ 'invite.tokenHash': 1 }` sparse.
   - `Role` (tenant) — `key` (system key or custom later), `name`, `permissions`, `isSystem`. Index `{ accountId: 1, key: 1 }` unique.
   - `RefreshToken` — `userId`, `accountId`, `familyId`, `tokenHash` (unique), `expiresAt` (TTL 0), `revokedAt?`, `revokedReason?` (`logout|logout_all|rotated|reuse_detected|password_changed|disabled|session_revoked`), `replacedBy?`, `userAgent?`, `ip?`, `lastUsedAt`. Indexes per data-model.
   - `AuthCode` (`authCodes`) — `userId`, `purpose` (`verify_email|reset_password`), `codeHash`, `attempts` (0), `sentCount` (1), `lastSentAt`, `expiresAt` (TTL 0), `usedAt?`. Index `{ userId: 1, purpose: 1 }`.
   - `ApiKey` (tenant) — per data-model (`name, prefix, keyHash unique, scopes, lastUsedAt, revokedAt, createdBy`).
   - `AuditLog` (tenant) — `actor { type: user|api_key|system, id?, impersonatorId? }`, `action`, `target? { type, id }`, `meta?`, `ip?`, `at` (default now). Index `{ accountId: 1, at: -1 }`, `{ accountId: 1, action: 1, at: -1 }`. **Immutable:** pre-hooks on `updateOne/updateMany/findOneAndUpdate/replaceOne/deleteOne/deleteMany` throw unless option `{ allowPurge: true }` (purge job only); `save()` of an existing doc throws.
4. **Slug** (`src/modules/account/slug.ts`): `slugify`, `uniqueSlug(name)` (reserved words, collision suffix) + tests.
5. **Migrations**: `0002-platform-account` (insert `{ slug: 'platform', name: 'Platform', isPlatform: true, status: 'active' }` if missing; down removes only if no users) · `0003-sync-system-roles` (for each non-platform account upsert 5 system roles with current `SYSTEM_ROLES` permissions; idempotent; doc comment: "add a new migration that calls `syncSystemRoles()` whenever the matrix changes"). Export `syncSystemRoles(accountId?, session?)` from `src/modules/rbac/` (also used at signup).
6. **`scripts/superadmin-create.ts`** + npm `"superadmin:create": "tsx --env-file-if-exists=.env scripts/superadmin-create.ts"` → `npm run superadmin:create -- <email> [name]`; password from a hidden TTY prompt or `--password-stdin`; in T2.1 the CLI checks only length 10–128 — **T2.2 switches it to `validatePasswordPolicy`** (do that edit in the T2.2 commit). Creates/updates user in the `platform` account (`platformRole: 'superadmin'`, `status: 'active'`, `emailVerifiedAt: now`, role = platform account's `owner` role created on the fly). Never echoes the password. Exits non-zero with a clear message on errors.
7. **`scripts/db-seed.ts`** + npm `"db:seed"` — refuses in production; idempotent; account **Demo Finance** (`slug demo-finance`) + roles + users `owner@demo.local`, `admin@demo.local`, `manager@demo.local`, `agent@demo.local`, `viewer@demo.local` (all active + verified) + superadmin `admin@platform.local`; password = `SEED_PASSWORD` env if set (new env var, dev only, documented) else a random one **printed once** to stdout.
8. **RBAC schema** (`rbac.schema.ts`): response shape `{ permissions: [{ key, description, group }], roles: [{ key, name, permissions }] }` registered here; the route `GET /api/v1/rbac/permissions` is **mounted in T2.3** (it needs `authenticate`).
9. **data-model.md** §2.1 updated (new fields, `authCodes`, platform account, ERD) in this commit.
10. **Tests:** each model: required fields, defaults, indexes via `listIndexes()`, JSON never leaks secrets; AuditLog immutability; migrations up twice = no duplicates, down; seed twice = same counts; CLI create + update + bad email; slug tests; role tests.

## T2.2 — Crypto + token services, env, error codes → `feat(auth): add password hashing, jwt, refresh rotation and one-time codes [P2-T2.2]`

**Deps:** `npm i jose@6.2.12 @node-rs/argon2@2.2.2` → approve-scripts review (expect none).
**Files:** `src/modules/auth/{password.ts, common-passwords.ts, tokens.ts, refresh.service.ts, codes.service.ts, hmac.ts, auth.constants.ts}`, `src/config/env.ts`, `src/shared/errors/{error-codes.ts, app-error.ts}`, `src/shared/middlewares/error-handler.ts` (`Retry-After`), `docs/conventions/error-codes.md`, tests.

1. **`auth.constants.ts`** — `ACCESS_AUDIENCE = 'cav-dashboard'`, `ISSUER = 'cav'`, `REFRESH_COOKIE = 'cav_rt'`, `OTP_TTL_MS = 10 min`, `OTP_MAX_ATTEMPTS = 5`, `OTP_RESEND_COOLDOWN_MS = 60 s`, `OTP_MAX_SENDS_PER_HOUR = 5`, `RESET_TTL_MS = 30 min`, `INVITE_TTL_MS = 7 d`, `IMPERSONATION_TTL = '30m'`, `LOCKOUT_THRESHOLD = 5`, `LOCKOUT_WINDOW_SEC = 900`, `ARGON2_PARAMS = { memoryCost: 19456, timeCost: 2, parallelism: 1 }`.
2. **`password.ts`** — `hashPassword(pw)`, `verifyPassword(hash, pw) → { ok, needsRehash }` (needsRehash when params differ), `verifyAgainstDummy(pw)` (constant-time miss path using a precomputed `DUMMY_HASH`), `validatePasswordPolicy(pw, { email?, name? }) → ErrorDetail[]` (`path: 'password'`; messages: too short (<10), too long (>128), same as email / contains email local part, same as name, too common).
3. **`common-passwords.ts`** — exported `Set` of ~1000 common passwords (lowercased), embedded; header comment with source (e.g. SecLists `10k-most-common` top 1000, MIT) — no network at runtime.
4. **`hmac.ts`** — `hmacToken(raw)`, `safeEqualHex(a, b)` (timing-safe), `randomToken(bytes = 32)` (base64url), `randomOtp()` (`crypto.randomInt(0, 1_000_000)` zero-padded 6 digits).
5. **`tokens.ts`** (jose) — `signAccessToken(claims, { ttl })` HS256 with `JWT_ACCESS_SECRET` (`TextEncoder` key), `iss/aud/sub/iat/exp/jti`; `verifyAccessToken(token)` → `AccessClaims { sub, acc, rid, tv, sid, imp? }`; `JWTExpired` → `UnauthenticatedError('AUTH_TOKEN_EXPIRED')`; any other failure (bad signature, alg `none`, wrong aud/iss, malformed) → `AUTH_UNAUTHENTICATED`; `clockTolerance: 5`.
6. **`refresh.service.ts`** — `issueRefresh({ userId, accountId, familyId?, userAgent, ip })` → `{ raw, doc }`; `rotateRefresh(raw, meta)` inside `withTransaction`: find by hash → not found → `AUTH_UNAUTHENTICATED`; `revokedAt` set (already rotated/revoked) → **revoke whole family** (`reuse_detected`) + emit an internal hook `onReuseDetected` (audit wired in T2.10; until then log warn) → `AUTH_SESSION_REVOKED`; expired → `AUTH_SESSION_REVOKED`; else mark old `revokedAt/rotated/replacedBy`, create new in same family, return `{ raw, doc }`. Concurrency: use `findOneAndUpdate({ _id, revokedAt: null }, …)` so only one concurrent rotation wins; the loser → treated as reuse. `revokeFamily(familyId, reason)`, `revokeAllForUser(userId, reason, { exceptFamilyId? })`, `listActiveSessions(userId)`.
7. **`codes.service.ts`** — `issueOtp(userId)` (verify_email): if an unexpired code exists → enforce cooldown 60 s (`AUTH_TOO_MANY_ATTEMPTS`, `retryAfterSec`) and hourly cap (count via `sentCount` within the hour) → replace code (new hash, attempts 0); returns raw code. `consumeOtp(userId, code)` → wrong → `attempts++` → ≥ 5 → `AUTH_TOO_MANY_ATTEMPTS` (code burned) else `AUTH_CODE_INVALID`; expired / used → `AUTH_CODE_INVALID`; ok → `usedAt`. `issueResetToken(userId)` → raw 32-byte token (stored hash, 30 min); `consumeResetToken(raw)` → `{ userId }` or `AUTH_CODE_INVALID`.
8. **Error codes** (§1d of the plan): add `AUTH_EMAIL_NOT_VERIFIED 403`, `AUTH_ACCOUNT_SUSPENDED 403`, `AUTH_USER_DISABLED 403`, `AUTH_SESSION_REVOKED 401`, `AUTH_CODE_INVALID 422`, `AUTH_TOO_MANY_ATTEMPTS 429`, `AUTH_IMPERSONATION_BLOCKED 403` to `ERROR_CODES` (user-safe messages) **and** error-codes.md (Phase column `2`). `AppError` gets optional `retryAfterSec`; `errorHandler` sets `Retry-After` when present (test).
9. **Env:** `JWT_*` dev fallbacks (non-production only) via `getAuthSecrets(env, logger)` → warn once `"JWT secrets not set — using development defaults"`; new optional `AUTH_COOKIE_DOMAIN`, dev-only `SEED_PASSWORD` (if not added in T2.1) → `.env.example` (comments + phase), README table, `.env`; env tests.
10. **Logger redaction:** ensure `req.body.password`, `req.body.currentPassword`, `req.body.newPassword`, `req.body.code`, `req.body.token`, `*.accessToken`, `*.refreshToken`, `headers.cookie`, `res.headers["set-cookie"]` are redacted (extend `src/shared/logger.ts` paths + test).
11. **Tests:** password hash/verify/needsRehash/dummy, policy table (≥ 8 cases), HMAC/safeEqual, OTP format (6 digits, leading zeros), JWT round-trip / expired (fake timers) / tampered / `alg: none` / wrong aud / wrong secret / missing claims, refresh issue → rotate → old reused → family revoked, concurrent rotate (Promise.all of 2) → exactly one success, expired refresh, OTP cooldown / hourly cap / attempts / expiry / reuse, reset token single use + expiry, `Retry-After` header, redaction.

## T2.3 — Auth middlewares, tenant helpers, suspension → `feat(auth): add authenticate, permission guards, api-key auth and tenant helpers [P2-T2.3]`

**Deps:** `npm i cookie-parser@1.4.7` · `npm i -D @types/cookie-parser@1.4.10` (mount `cookieParser()` in `createApp` after body parsers).
**Files:** `src/shared/auth/{auth-context.ts, tenant.ts}`, `src/shared/middlewares/{authenticate.ts, require-permission.ts, api-key-auth.ts, origin-check.ts}`, `src/@types/express.d.ts`, `src/modules/rbac/rbac.routes.ts` (mount), `src/app.ts`, tests.

1. `AuthContext` (`req.auth`): `{ kind: 'user'|'api_key'; accountId: string; userId?: string; apiKeyId?: string; roleKey?: string; permissions: ReadonlySet<string>; scopes?: ReadonlySet<string>; platformRole?: 'superadmin'; impersonatorId?: string; sessionId?: string; account: { id, status, timezone } }`. Helper `requireAuth(req)` (throws if missing — for services).
2. `authenticate()` — `Authorization: Bearer` only (else `AUTH_UNAUTHENTICATED`); verify; load `User.findById(sub).lean()` (exclude deleted) + `Role` + `Account`; checks in order: user missing → `AUTH_UNAUTHENTICATED`; `tv` mismatch → `AUTH_UNAUTHENTICATED`; `status === 'disabled'` → `AUTH_USER_DISABLED`; not verified → `AUTH_EMAIL_NOT_VERIFIED`; account suspended and method not GET/HEAD/OPTIONS and not superadmin → `AUTH_ACCOUNT_SUSPENDED`; permissions = role permissions (+ `PLATFORM_PERMISSIONS` if superadmin and acting in the platform account); `req.log = req.log.child({ accountId, userId })`.
3. `requirePermission(...perms)` (all), `requireAnyPermission(...perms)`, `requirePlatformAdmin()` (`platformRole === 'superadmin'` **and** not impersonating), `blockWhenImpersonating()` → `AUTH_IMPERSONATION_BLOCKED`.
4. `apiKeyAuth({ scopes = [] })` — `X-API-Key`; format check `^cav_(live|test)_[A-Za-z0-9]{32}$`; lookup `keyHash = sha256(raw)` (not HMAC — keys are high-entropy; document) and `revokedAt: null`; account active (suspended → writes blocked same rule); scopes ⊇ required → else `AUTH_FORBIDDEN`; `lastUsedAt` fire-and-forget update if older than 60 s.
5. `originCheck()` (for refresh/logout) per §1 table.
6. Tenant helpers: `tenantFilter(req)` → `{ accountId: new ObjectId(req.auth.accountId) }`; `findOwnedOr404(Model, id, req, projection?)`.
7. Idempotency: export `accountScope = (req) => req.auth?.accountId` for later routes (document in api.md implementation note).
8. Mount `GET /api/v1/rbac/permissions` (`authenticate` only) — returns catalogue + system roles.
9. OpenAPI: helper `secured(route)` adding `security: [{ bearerAuth: [] }]` + 401/403 error responses; register rbac route.
10. **Tests** (supertest on a test router + real models): every check of step 2 (one test each), permission allow/deny, any-permission, platform admin, impersonation block, API key valid / malformed / revoked / wrong scope / suspended write, `lastUsedAt` throttle, origin check, tenant isolation via `findOwnedOr404` (other account id → 404), rbac route shape.
11. **Security grep test** `tests/security/tenant-scope.test.ts`: fail if any file under `src/modules/**` matches `/(body|query|params)\??\.accountId/`.

## T2.4 — Signup + email OTP → `feat(auth): add signup with email otp verification [P2-T2.4]`

**Files:** `src/modules/auth/{auth.routes.ts, auth.controller.ts, auth.service.ts, auth.schema.ts, session.ts (builds AuthSession + cookie)}`, `src/core/email/templates/{auth-verify-email.ts, auth-account-exists.ts}` (+ registry), tests.

| Route                            | Auth                        | Body                                                                                      | Success                                                            | Errors                                                |
| -------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------- |
| `POST /auth/signup`              | public, `strictRateLimiter` | `{ businessName (2–80), name (1–80), email, password, phone? (E.164), timezone? (IANA) }` | **202** `{ message: 'Check your email for a verification code.' }` | 422 validation / policy                               |
| `POST /auth/verify-email`        | public, strict              | `{ email, code (6 digits) }`                                                              | **200** `AuthSession` + `Set-Cookie cav_rt`                        | 422 `AUTH_CODE_INVALID`, 429 `AUTH_TOO_MANY_ATTEMPTS` |
| `POST /auth/verify-email/resend` | public, strict              | `{ email }`                                                                               | **202** always                                                     | — (cooldown silently respected)                       |

1. Signup (new email): `withTransaction` → account (`uniqueSlug`) → `syncSystemRoles(accountId, session)` → owner user (`status: active`, `emailVerifiedAt: null`, `passwordHash`) → `account.ownerId` → commit; then `issueOtp` → `getEmail().enqueue('auth.verify_email', email, { name, code, minutes: 10 }, { dedupeKey: \`verify:${userId}:${n}\` })`. Existing email (any status) → enqueue `auth.account_exists` (`{ loginUrl, resetUrl }`) — **same 202**. Unverified existing owner re-signing up → resend OTP instead (same 202). Add an artificial minimum response time (e.g. pad to ≥ 300 ms) for both branches.
2. Verify: find user by email → missing → `AUTH_CODE_INVALID` (no enumeration) → `consumeOtp` → `emailVerifiedAt = now` → create session (refresh family + cookie + access token) → `AuthSession`. (Audit hooks `auth.email_verified` + `account.created` are added in T2.10 — leave a typed call site via an `auditHook` no-op until then? **No** — add `src/modules/audit/audit.service.ts` minimal `record()` writing to the model **now** (T2.10 adds the API, catalogue doc, purge, PII stripping). Note in commit.)
3. Templates: `auth.verify_email` vars `{ name, code, minutes }` (code in a large monospace block; text part too), `auth.account_exists` vars `{ name, loginUrl, resetUrl }` — URLs from `FRONTEND_URL`.
4. OpenAPI for all three (+ `AuthSession` schema registered once, reused).
5. **Tests:** happy path end-to-end (memory email provider captures the code → verify → session + cookie flags asserted: HttpOnly, SameSite=Strict, Path=/api/v1/auth, no Secure in test); duplicate email → 202 + `auth.account_exists` sent + no second account; unverified re-signup → new OTP; weak / common password → 422 details; invalid email / phone / timezone → 422; wrong code ×5 → 429 then even the right code fails; expired code (fake time); resend cooldown; slug collision; transaction rollback (force a failure after account insert → no orphan account/roles); response never contains `passwordHash`.

## T2.5 — Login / refresh / logout / me / sessions → `feat(auth): add login, refresh rotation, logout and sessions [P2-T2.5]`

| Route                       | Auth                   | Body                  | Success                                                                  | Errors                                                                                            |
| --------------------------- | ---------------------- | --------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `POST /auth/login`          | public, strict         | `{ email, password }` | 200 `AuthSession` + cookie                                               | 401 `AUTH_INVALID_CREDENTIALS`, 403 `AUTH_USER_DISABLED` / `AUTH_EMAIL_NOT_VERIFIED`, 429 lockout |
| `POST /auth/refresh`        | cookie + `originCheck` | —                     | 200 `AuthSession` + rotated cookie                                       | 401 `AUTH_UNAUTHENTICATED` / `AUTH_SESSION_REVOKED` (cookie cleared)                              |
| `POST /auth/logout`         | cookie + `originCheck` | —                     | 204 (idempotent, cookie cleared)                                         | —                                                                                                 |
| `POST /auth/logout-all`     | bearer                 | —                     | 204                                                                      | —                                                                                                 |
| `GET /auth/me`              | bearer                 | —                     | 200 `AuthSession` minus token                                            | 401                                                                                               |
| `GET /auth/sessions`        | bearer                 | —                     | 200 `[{ id (familyId), userAgent, ip, createdAt, lastUsedAt, current }]` | —                                                                                                 |
| `DELETE /auth/sessions/:id` | bearer                 | —                     | 204                                                                      | 404 not own                                                                                       |

1. Login order: normalize email → lockout check → find user (not deleted) → none / no `passwordHash` (invited) → dummy verify → fail; verify → fail → increment lockout → `AUTH_INVALID_CREDENTIALS`; `disabled` → `AUTH_USER_DISABLED`; unverified → issue/resend OTP (cooldown-aware) + `AUTH_EMAIL_NOT_VERIFIED`; success → reset lockout, rehash if needed, `lastLoginAt`, new family, cookie, `AuthSession`. Suspended account → login allowed (`account.status` in the session drives the UI banner). Superadmin login → session in the platform account with `platformRole`.
2. Refresh → `rotateRefresh` → load user + checks (disabled / deleted / tv not needed for refresh but status yes) → new access token with same `sid` (familyId).
3. Logout-all → `tokenVersion++`, `revokeAllForUser(…, 'logout_all')`, `pushToUser(session.revoked)` (if `pushToUser` arrives in T2.12, call it then — **add `pushToUser` now in T2.5** to `core/realtime` (fan-out target `{ accountId, userId }`) with tests, T2.12 reuses it).
4. `me` → `AuthSession` without token (role, permissions, account status, impersonation info).
5. Sessions list/revoke (own only; revoking current = logout).
6. **Tests:** cookie round-trip with `supertest.agent`, rotation changes the cookie, replay old cookie → 401 `AUTH_SESSION_REVOKED` + new cookie also dead (family revoked), parallel refresh, lockout (5 fails → 429 + `Retry-After`, success after window via Redis TTL manipulation), unknown email timing path uses dummy verify (spy), invited user without password → invalid credentials, disabled / unverified responses, suspended account login OK but POST elsewhere 403, logout idempotent + cookie cleared attrs, logout-all invalidates old access token (tv), sessions list/revoke isolation, `me` shape, Origin check on refresh (bad origin 403, allowed origin 200).

## T2.6 — Forgot / reset / change password → `feat(auth): add forgot, reset and change password [P2-T2.6]`

| Route                        | Auth                             | Body                               | Success                                     | Errors                                     |
| ---------------------------- | -------------------------------- | ---------------------------------- | ------------------------------------------- | ------------------------------------------ |
| `POST /auth/forgot-password` | public, strict                   | `{ email }`                        | 202 always                                  | —                                          |
| `POST /auth/reset-password`  | public, strict                   | `{ token, password }`              | 200 `{ message }`                           | 422 `AUTH_CODE_INVALID` / policy           |
| `POST /auth/change-password` | bearer, `blockWhenImpersonating` | `{ currentPassword, newPassword }` | 200 `AuthSession` (new tokens, same family) | 401 `AUTH_INVALID_CREDENTIALS`, 422 policy |

1. Forgot → only active + verified users get `auth.reset_password` email (`{ name, resetUrl: FRONTEND_URL/reset-password?token=…, minutes: 30 }`); others silently nothing; min response time.
2. Reset → consume token → policy (with user email/name) → hash → `passwordChangedAt`, `tokenVersion++`, `revokeAllForUser('password_changed')`, email `auth.password_changed`, `pushToUser(session.revoked)`.
3. Change → verify current → policy (+ new ≠ current) → hash → `tokenVersion++` → revoke **other** families → re-issue access token for the current session → email `auth.password_changed`.
4. Templates `auth.reset_password`, `auth.password_changed` (+ registry, escaped).
5. **Tests:** reset happy path + single use + expiry + old access token rejected + all sessions revoked; forgot for unknown / invited / unverified → no email; change: wrong current, same password, policy, other sessions revoked but current still valid, impersonation blocked (fake impersonation token).

## P2-B1-DONE — checkpoint → `docs: mark phase 2 batch 1 complete [P2-B1-DONE]`

1. `npm run infra:up` → backend full verify (each separately) + actionlint.
2. **Manual e2e** (backend `npm run dev`, curl with a cookie jar in the scratchpad — never commit it):
   - signup → OTP read from **Mailpit API** (`curl -s localhost:8025/api/v1/messages` + message endpoint) → verify → `Set-Cookie` flags → `/auth/me` with Bearer;
   - refresh (cookie jar) → new cookie; replay the old cookie → 401 `AUTH_SESSION_REVOKED`; the new one now also fails;
   - 5 wrong logins → 429 + `Retry-After`;
   - forgot → reset link from Mailpit → reset → old access token 401;
   - `npm run db:seed` → login as each role; `npm run superadmin:create -- admin@platform.local` (password via stdin) → login;
   - logs contain no password / OTP / token / cookie (grep the log file);
   - `kill -INT` → clean shutdown order, port free.
3. Secret scan (grep + gitleaks) — 0.
4. Docs: PHASE_2_TASKS T2.1–T2.6 `[x]`, PHASE_2_PLAN changelog line (+ deviations), `src/README.md` module rows + auth flow section, README (auth quickstart: seed, superadmin, Mailpit OTP; env table), CHANGELOG `Phase 2 · Batch 1`, ADR 0009 "Implementation (Phase 2)" note.
5. Commit; `npm run infra:down`. No push / merge.
6. **Report (Hinglish):** per task ✅/⚠️/❌, `git log`, versions + allowScripts, deviations, verification (each command + manual), tests before → after + coverage, open items for Batch 2.

---

# ═══════════ BATCH 2 — Account, team, keys, audit, superadmin, WS (T2.7 → T2.12) ═══════════

## T2.7 — Account settings → `feat(account): add account settings api [P2-T2.7]`

| Route                   | Permission       | Body                                                                                                                                                                         | Success                                                 |
| ----------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `GET /api/v1/account`   | `account.read`   | —                                                                                                                                                                            | 200 `PublicAccount` (+ `settings`, `ownerId`, `status`) |
| `PATCH /api/v1/account` | `account.update` | any of `{ name, timezone, country, defaultLanguage, settings: { callingWindow: { start, end, days }, recordingEnabled, aiDisclosureEnabled } }` (strict, at least one field) | 200 updated account                                     |

- Validation: `name` 2–80; `timezone` ∈ `Intl.supportedValuesOf('timeZone')`; `country` `^[A-Z]{2}$`; `defaultLanguage` `hi|en|hinglish`; `callingWindow.start/end` `^([01]\d|2[0-3]):[0-5]\d$`, start < end, `days` unique ints 0–6, 1–7 items. Partial nested update merges (don't wipe other settings).
- Audit `account.updated` meta `{ fields: [...] }`; WS `pushToAccount('account.updated', { fields })` (add to events catalogue) so other tabs refetch.
- **Tests:** every rule, partial merge, permission denied (manager/agent/viewer), suspended → 403, audit + event, tenant (can only ever touch own account — no id in path).

## T2.8 — Team → `feat(team): add invites, roles, enable-disable, removal and ownership transfer [P2-T2.8]`

| Route                               | Permission / guard                | Body / query                                                                   | Success                                                                                              |
| ----------------------------------- | --------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `GET /team/users`                   | `team.read`                       | `page, limit, status?, roleKey?, search?` (name/email contains, escaped regex) | 200 list + offset pagination                                                                         |
| `POST /team/invites`                | `team.invite`, not impersonating  | `{ email, name, roleKey ∈ admin                                                | manager                                                                                              | agent    | viewer }` | 201 user (`status: invited`) |
| `POST /team/invites/:userId/resend` | `team.invite`                     | —                                                                              | 202 (new token, old invalid; cooldown 60 s)                                                          |
| `DELETE /team/invites/:userId`      | `team.invite`                     | —                                                                              | 204 (hard delete of the invited user doc)                                                            |
| `POST /auth/accept-invite`          | public, strict                    | `{ token, password, name? }`                                                   | 200 `AuthSession` + cookie                                                                           |
| `GET /auth/invite-info?token=`      | public, strict                    | —                                                                              | 200 `{ email, accountName, inviterName, roleName }` (for the accept page) or 422 `AUTH_CODE_INVALID` |
| `PATCH /team/users/:id`             | `team.update`                     | `{ roleKey? , status?: active                                                  | disabled }`                                                                                          | 200 user |
| `DELETE /team/users/:id`            | `team.remove`                     | —                                                                              | 204 (soft delete, sessions revoked)                                                                  |
| `POST /team/transfer-ownership`     | **owner only**, not impersonating | `{ userId, password }` (re-auth)                                               | 200 `{ ownerId }`                                                                                    |

Rules (all → `CONFLICT_INVALID_STATE` 409 or `AUTH_FORBIDDEN` 403 as noted):

- Global unique email → invite of an existing email → 409 `CONFLICT_DUPLICATE` (message generic: "This email can't be invited.").
- Nobody can change / disable / remove the **owner** (409); nobody acts on **themselves** via team routes (409).
- Only the **owner** can grant or revoke `admin` (others → 403).
- Disable → `tokenVersion++`, revoke all sessions, `pushToUser(session.revoked)`; enable → nothing else. Role change → `tokenVersion++` (forces token refresh → new permissions) + `pushToUser('user.updated')`.
- Remove → soft delete + revoke sessions + `session.revoked`; email can't be reused while soft-deleted? → **unique index is partial on `deletedAt: null`**, so re-invite after removal is allowed (test it).
- Transfer → target must be `active` `admin` → target role owner, old owner → admin, `account.ownerId` updated, both `tokenVersion++`, in a transaction.
- Invite email `team.invite` `{ inviterName, accountName, roleName, acceptUrl: FRONTEND_URL/accept-invite?token=…, days: 7 }`; invited-user email change is not supported (revoke + re-invite).
- Every mutation → audit + `pushToAccount('team.changed', {})`.
- **Tests:** permission matrix per route (owner/admin/manager/agent/viewer), each rule above, invite → accept → login, expired / reused / revoked invite token, resend invalidates the old token, disabled user's old access token rejected immediately + refresh fails, role change reflected in `me` after refresh, remove + re-invite same email, transfer (password wrong → 401, target not admin → 409, success swaps roles), pagination + search + regex escaping, tenant isolation (ids from another account → 404).

## T2.9 — API keys → `feat(api-keys): add hashed scoped api keys [P2-T2.9]`

| Route                  | Permission                          | Body                                                           | Success                                                                           |
| ---------------------- | ----------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `GET /api-keys`        | `apikeys.read`                      | —                                                              | 200 `[{ id, name, prefix, scopes, lastUsedAt, createdBy, createdAt, revokedAt }]` |
| `POST /api-keys`       | `apikeys.manage`, not impersonating | `{ name (1–60), scopes (non-empty subset of API_KEY_SCOPES) }` | 201 `{ apiKey: {...}, key: '<raw — shown once>' }`                                |
| `DELETE /api-keys/:id` | `apikeys.manage`                    | —                                                              | 204 (sets `revokedAt`, idempotent)                                                |
| `GET /api-keys/whoami` | **`apiKeyAuth()`**                  | —                                                              | 200 `{ accountId, apiKeyId, scopes }`                                             |

- `API_KEY_SCOPES` (`src/modules/api-keys/scopes.ts`): `calls:read`, `calls:write`, `contacts:read`, `contacts:write`, `campaigns:read`, `campaigns:write`, `webhooks:manage` — documented in api.md §12 (Phase 10 may extend).
- Raw format `cav_live_` / `cav_test_` + 32 base62 chars (crypto random); store `prefix` = first 13 chars, `keyHash` = sha256 hex. Max **20** active keys (409). Response headers `Cache-Control: no-store` on create.
- Audit `apikey.created` (meta name, scopes, prefix) / `apikey.revoked`.
- **Tests:** create → raw works on whoami; list never contains raw or hash; revoke → 401; scope missing → 403 (route with `apiKeyAuth({ scopes: ['calls:write'] })` in a test router); limit 20; tenant isolation; impersonation blocked; `no-store` header.

## T2.10 — Audit log → `feat(audit): add audit log api, action catalogue and purge job [P2-T2.10]`

**Files:** `src/modules/audit/{audit.service.ts (from T2.4 — complete it), audit-actions.ts, audit.routes.ts, audit.schema.ts}`, `src/core/queues/workers/maintenance.worker.ts` (`QUEUES.maintenance`), `docs/conventions/audit.md`, tests.

- `AUDIT_ACTIONS` (typed union, documented in audit.md with meta fields): `account.created`, `account.updated`, `account.ownership_transferred`, `account.suspended`, `account.enabled`, `auth.email_verified`, `auth.login`, `auth.login_failed`, `auth.logout`, `auth.logout_all`, `auth.session_revoked`, `auth.refresh_reuse_detected`, `auth.password_reset_requested`, `auth.password_reset`, `auth.password_changed`, `team.invited`, `team.invite_resent`, `team.invite_revoked`, `team.invite_accepted`, `team.role_changed`, `team.disabled`, `team.enabled`, `team.removed`, `apikey.created`, `apikey.revoked`, `admin.impersonation_started`, `admin.impersonation_stopped`. Wire every call site from T2.4–T2.9 (+ T2.11) to these exact strings (replace any interim strings; test that all used actions ∈ catalogue).
- `record(ctx, action, { target?, meta? })`: actor from `req.auth` (user / api_key / impersonation → `impersonatorId`) or `{ type: 'system' }`; `ip` from `req.ip` (trust proxy aware); **meta sanitizer** drops keys matching `/pass|token|secret|code|otp|cookie|authorization/i` and masks email-looking values with `maskEmail`; never throws (catch → `logger.error`); `auth.login_failed` for unknown email is recorded in the **platform** account? → **No**: skip audit for unknown emails (no account) — log only.
- `GET /api/v1/audit-logs` (`audit.read`) — `CursorQuerySchema` + filters `actorId?`, `action?` (exact or prefix with `.*`), `from?`, `to?` (ISO), `targetType?`; sort `at` desc, cursor = base64url of `{ at, id }`; response items `{ id, actor: { type, id, name? (joined user name), impersonatorId? }, action, target, meta, ip, at }`.
- Purge: `maintenance` queue + worker with job scheduler `audit-purge` daily 03:00 UTC → `AuditLog.deleteMany({ at: { $lt: now - 365d } }, { allowPurge: true })` in batches of 10k; log count; started in `startServer` when `WORKERS_ENABLED` (queue prefix option respected).
- **Tests:** sanitizer, actor variants, list filters + cursor paging (create 25 entries, page 10/10/5), tenant isolation, permission, purge deletes only > 365 d, immutability, every catalogue string documented in audit.md (test parses the doc like the error-codes sync test).

## T2.11 — Superadmin → `feat(admin): add superadmin accounts, suspension and impersonation [P2-T2.11]`

| Route (`requirePlatformAdmin`)         | Body / query                                                | Success                                                                               |
| -------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `GET /admin/accounts`                  | `page, limit, status?, search?` (name / slug / owner email) | 200 list `{ id, name, slug, status, ownerEmail, usersCount, createdAt }` + pagination |
| `GET /admin/accounts/:id`              | —                                                           | 200 `{ account, owner, usersCount, usersByStatus, recentAudit (last 20) }`            |
| `POST /admin/accounts/:id/suspend`     | `{ reason (3–200) }`                                        | 200 account                                                                           |
| `POST /admin/accounts/:id/enable`      | —                                                           | 200 account                                                                           |
| `POST /admin/accounts/:id/impersonate` | —                                                           | 200 `AuthSession` (impersonation, **no cookie**)                                      |
| `POST /admin/impersonation/stop`       | bearer = impersonation token                                | 204 (audit end)                                                                       |

- Platform account (`isPlatform`) can't be suspended / impersonated (409). Suspend/enable → audit in **target** account (actor = superadmin, `actor.platform: true`) **and** platform account; WS `account.suspended` / `account.enabled` to the target account.
- Impersonation token: `signAccessToken({ sub: owner._id, acc, rid, tv: owner.tokenVersion, sid: 'imp_<random>', imp: superadminId }, { ttl: '30m' })`; `authenticate` exposes `impersonatorId`; `me` returns `impersonation: { impersonatorId, impersonatorEmail, expiresAt }`; refresh endpoint never issues impersonation tokens.
- Blocked while impersonating (via `blockWhenImpersonating` — verify each route has it): change-password, transfer-ownership, api-key create, team invites with role admin? → **all invites blocked**, logout-all (would log the owner out everywhere) blocked.
- **Tests:** every route 403 for normal users (incl. owner), 401 without token; list filters/search/pagination; suspend → target owner GET ok / POST 403 / WS event; enable restores; platform protected; impersonation claims + `me`; blocked actions return `AUTH_IMPERSONATION_BLOCKED`; impersonation token expires (fake time); stop audit; superadmin's own platform routes can't be used while impersonating.

## T2.12 — WS tickets + realtime auth events → `feat(realtime): add ws ticket endpoint and auth events [P2-T2.12]`

- `POST /api/v1/ws/tickets` (bearer) body `{ channel?: 'events' }` → `WsTicketService.issue({ userId, accountId, channel })` → 201 `{ ticket, expiresAt }`; rate limit 30/min per user (createRateLimiter keyed by userId).
- Events: add `session.revoked`, `account.suspended`, `account.enabled`, `account.updated`, `user.updated`, `team.changed` to **websocket.md §5**, backend `events.ts` (`WsEventMap`), and later frontend `events.ts` (T2.13).
- `pushToUser(accountId, userId, type, data)` (added T2.5) — on `session.revoked` also **close that user's sockets** with 4001 `session revoked` on every instance (fan-out message carries a `close` flag).
- Disabled user / suspended account sockets: suspended → keep connected (read-only), disabled → closed via `session.revoked`.
- `npm run ws:dev-ticket` stays (DEV) — README now points to the real endpoint first.
- **Tests:** ticket requires auth; ticket bound to caller (connect → events for that account only); `pushToUser` only reaches that user; revoke closes sockets (4001) across two instances; rate limit.

## P2-B2-DONE — checkpoint → `docs: mark phase 2 batch 2 complete [P2-B2-DONE]`

1. Full backend verify + actionlint.
2. **Manual e2e** (curl, Mailpit, a small `ws` scratch client):
   - seed → owner invites a manager (Mailpit link) → `invite-info` → accept → manager `GET /team/users` 200, `POST /team/invites` 403;
   - owner changes manager → viewer → manager's old token 401 → refresh → `me.permissions` changed;
   - owner disables viewer → viewer's WS socket closed 4001 + token 401;
   - API key create → `whoami` with `X-API-Key` → revoke → 401;
   - audit list shows all of the above with sanitized meta;
   - superadmin: list accounts → suspend demo → owner POST 403 + WS `account.suspended` → enable → impersonate → `me.impersonation` → change-password 403 → stop;
   - `POST /ws/tickets` → connect → `account.updated` after PATCH /account;
   - shutdown order clean (incl. maintenance worker), port free.
3. Secret scan + gitleaks.
4. Docs: tasks `[x]`, plan changelog, `src/README.md`, README (team / API keys / superadmin / audit), api.md (auth + scopes), websocket.md events, audit.md, data-model.md, CHANGELOG `Phase 2 · Batch 2`.
5. Commit; `infra:down`. Report as in Batch 1 (+ OpenAPI path count).

---

# ═══════════ BATCH 3 — Frontend, E2E, sign-off (T2.13 → T2.18) ═══════════

Frontend first step: `git checkout feature/phase-2-auth` (create from `feature/phase-1-foundation` if missing) → baseline verify → backend `gen:openapi` → frontend `gen:api` (commit with T2.13).

## T2.13 — Frontend auth infra → `feat(auth): add session store, token refresh interceptor and route guards [P2-T2.13]`

**Deps:** `npm i zustand@5.0.15`.
**Files:** `src/services/api/{auth.ts, account.ts}`, `src/features/auth/{store.ts, session.ts, AuthBootstrap.tsx, guards.tsx, usePermission.ts, keys.ts}`, `src/services/api/client.ts`, `src/services/realtime/events.ts` (new events), tests.

1. `gen:api` → typed `AuthSession`, `PublicUser`, … aliases in `services/api/types.ts`.
2. `authStore` (Zustand, **no persist**): `{ status: 'loading'|'authenticated'|'anonymous', accessToken, expiresAt, user, account, role, permissions: Set<string>, impersonation, savedSession (superadmin session while impersonating) }` + actions `setSession(session)`, `clear()`, `startImpersonation(session)`, `stopImpersonation()`.
3. `services/api/auth.ts`: `signup, verifyEmail, resendVerification, login, refresh, logout, logoutAll, me, forgotPassword, resetPassword, changePassword, sessions, revokeSession, inviteInfo, acceptInvite, issueWsTicket` (all `unwrap`).
4. `client.ts`: request interceptor adds `Authorization` from the store (skip when absent); response interceptor: `ApiError` with `code === 'AUTH_TOKEN_EXPIRED'` and request not `/auth/refresh|/auth/logout|/auth/login` and not already retried → **single-flight** `refreshPromise ??= refresh().finally(() => refreshPromise = null)` → `setSession` → retry once with the new token; refresh failure / other 401 (`AUTH_UNAUTHENTICATED`, `AUTH_SESSION_REVOKED`) on authenticated calls → `clear()` + `queryClient.clear()` + navigate `/login?next=<current>` (via a small `authEvents` emitter consumed by `AuthBootstrap`, no router import in the client). Remove the two `TODO (Phase 2)` comments.
5. `AuthBootstrap`: on mount → `refresh()` (cookie) → `setSession` or `anonymous`; full-screen loader while `loading`; subscribes to `authEvents` + WS `session.revoked` (→ logout + snackbar "You were signed out") + `user.updated` for self (→ refresh session) + `account.suspended/enabled` (→ refetch `me`).
6. Guards: `RequireAuth` (anonymous → `/login?next=`; unverified can't happen — server never issues), `RedirectIfAuthed` (auth pages → `/`), `RequirePermission({ perm | anyOf })` → `/403`, `RequirePlatformAdmin`; hooks `usePermission(perm)`, `useCan()` → `(perm) => boolean`, `useSession()`.
7. Providers: `RealtimeProvider getTicket={status === 'authenticated' ? getWsTicket : null}` where `getWsTicket = async () => (await issueWsTicket()).ticket` (module-level constant, so it is stable).
8. Query keys convention in `src/README.md` (`features/<x>/keys.ts`), `queryClient.clear()` on logout.
9. **Tests:** store actions; interceptor: Bearer attached, 3 parallel `AUTH_TOKEN_EXPIRED` → exactly 1 refresh + 3 retries, refresh failure → clear + event, no retry loop on `/auth/refresh`, non-auth 401 path; bootstrap loading → authenticated / anonymous; guards redirect with `next`; permission hooks; WS `session.revoked` → logout.

## T2.14 — Auth screens → `feat(auth): add login, signup, otp, forgot, reset and accept-invite pages [P2-T2.14]`

- `AuthLayout` (centered card, product name, theme toggle, footer links). Pages + routes (public, `RedirectIfAuthed` except reset/accept):
  - `/login` — email, password, "show password", submit; `AUTH_EMAIL_NOT_VERIFIED` → navigate `/verify-email?email=`; 429 → message with seconds; success → `next` or `/`.
  - `/signup` — business name, name, email, password (+ live policy hints), phone (optional), timezone (default browser tz); success → `/verify-email?email=`.
  - `/verify-email` — 6 single-digit inputs (auto-advance, backspace, **paste 6 digits**), resend button with 60 s countdown, wrong code message, success → `/`.
  - `/forgot-password` → always shows "If an account exists, we sent a link." ; `/reset-password?token=` → new password + confirm → success → `/login` with snackbar.
  - `/accept-invite?token=` → `invite-info` (show account, inviter, role) → name + password → logged in → `/`; invalid token → error state with link to login.
- Shared zod schemas `features/auth/schemas.ts` (client mirror of password length rules; server details via `applyFieldErrors`).
- Accessibility: labels, `autoComplete` (`email`, `current-password`, `new-password`, `one-time-code`), Enter submits, focus first error.
- **Tests (RTL, mocked API):** each page happy path; login unverified → redirect; signup 422 details on fields; OTP paste + auto-advance + resend countdown (fake timers); reset invalid token; accept invite invalid token.

## T2.15 — App shell → `feat(layout): add app shell, navigation, theme, dashboard and shared components [P2-T2.15]`

- `src/layout/{AppLayout.tsx, Sidebar.tsx, Header.tsx, nav-config.ts, Banners.tsx}`:
  - `nav-config.ts`: items `{ key, label, icon, path, permission?, platformOnly?, phase? }` — Phase 2 live: Dashboard, Team (`team.read`), Settings; Admin section (platformOnly): Accounts. Future items (Contacts P3, Wallet P4, Agents P5, Flows P6, Calls P7, Campaigns P8, Reports P9, Integrations P10) defined but `hidden: true` until their phase.
  - Sidebar: permanent ≥ md (collapsible to icons, state in localStorage via try/catch), temporary drawer < md, active item highlight.
  - Header: menu button (< md), account name, WS status dot (tooltip: connected / reconnecting / offline), theme toggle (`useColorScheme`, light/dark/system), user menu (name, email, role; Profile, Security, Sign out, Sign out everywhere).
  - Banners: impersonation (warning, "Stop"), account suspended (error, "Read-only — contact support").
- Pages: `DashboardPage` (welcome, account summary card, `SystemInfoCard`, placeholder cards "Calls — Phase 7", "Wallet — Phase 4", "Campaigns — Phase 8"), `ForbiddenPage` (`/403`), existing `NotFoundPage`, `ErrorBoundary` route element (`errorElement`) with retry + requestId when an `ApiError`.
- Shared components `src/components/`: `ConfirmDialog` + `ConfirmProvider` + `useConfirm()` (`await confirm({ title, message, confirmText, destructive })`), `PageHeader`, `EmptyState`, `DataTable` (columns, rows, loading skeleton, empty, error with retry, pagination controls), `StatusChip`, `CopyButton`, `RelativeTime` (date-fns + account tz).
- Deps: `npm i date-fns@4.4.0 @date-fns/tz@1.5.0`.
- Router: authenticated routes under `RequireAuth` + `AppLayout`; HomePage → DashboardPage.
- **Tests:** nav hides items without permission (render as each role), admin section only for superadmin, responsive drawer (`matchMedia` mock), theme toggle, banners, ConfirmDialog resolve true/false, DataTable states, error boundary, 403 route.

## T2.16 — Team + Settings → `feat(team,settings): add team management and settings pages [P2-T2.16]`

- **Team** `/team` (`team.read`): `DataTable` (name, email, role, status chip, last login RelativeTime), search (debounced 300 ms), status + role filters, pagination; actions per row by permission + rules (hide for owner/self): change role (select; admin option only for owner), disable/enable, remove (ConfirmDialog destructive), resend / revoke invite; "Invite member" dialog (email, name, role); "Transfer ownership" (owner only, dialog with admin select + password). Refetch on WS `team.changed`.
- **Settings** `/settings/:tab` tabs:
  - `account` — form (name, timezone Autocomplete from `Intl.supportedValuesOf`, country, default language, calling window: start/end time inputs + day toggles, recording + AI disclosure switches); read-only view without `account.update`; dirty-state guard + save bar.
  - `profile` — name, phone (E.164 hint) (**backend:** add `PATCH /auth/me` `{ name?, phone? }` in this task with tests + OpenAPI, since profile edit was not in Batch 1/2 routes).
  - `security` — change password form, sessions table (current tag, revoke), "Sign out everywhere" (ConfirmDialog).
  - `api-keys` (`apikeys.read`) — list, create dialog (name + scope checkboxes with descriptions) → **show-once dialog** with the raw key, `CopyButton`, warning text; revoke (ConfirmDialog).
  - `audit` (`audit.read`) — table (time in account tz, actor, action, target, meta summary), filters (action, actor, date range), "Load more" (cursor).
- **Tests:** team actions visibility per role, invite flow, role change dialog, remove confirm; settings account validation + read-only mode; security sessions revoke; api key show-once (raw key not rendered after closing, not in query cache); audit load more.

## T2.17 — Superadmin → `feat(admin): add superadmin accounts pages and impersonation [P2-T2.17]`

- `/admin/accounts` (`RequirePlatformAdmin`): DataTable (name, slug, owner email, users, status, created), search, status filter.
- `/admin/accounts/:id`: summary, users by status, recent audit, Suspend (reason dialog) / Enable, **Impersonate** (ConfirmDialog explaining 30 min + audit), tabs "Overview", "Rates — coming in Phase 4" (placeholder).
- Impersonation flow: `startImpersonation(session)` keeps the superadmin session in `savedSession`, switches token (no refresh for impersonation; on `AUTH_TOKEN_EXPIRED` while impersonating → auto `stopImpersonation()` + snackbar), banner with countdown + Stop (`POST /admin/impersonation/stop` → restore saved session → navigate `/admin/accounts/:id`). Page reload while impersonating → session lost by design → bootstrap restores the superadmin via refresh cookie (document).
- **Tests:** guard, list/search, suspend/enable dialogs, impersonation start → banner → stop restores, expiry auto-stop, reload behaviour (store reset → bootstrap).

## T2.18 — Playwright E2E, gap audit, docs, sign-off → backend `test: add phase 2 integration gap tests and docs [P2-T2.18]` + frontend `test(e2e): add playwright auth and rbac scenarios [P2-T2.18]`

1. Frontend: `npm i -D @playwright/test@1.64.0` → `npx playwright install chromium` (record in README; not a dependency install script) → `playwright.config.ts` (baseURL `http://localhost:3100`, `webServer` entries: **backend** `npm run dev --prefix ../cell-ai-voicebot-backend` (url `http://localhost:5100/ready`) and **frontend** `npm run dev` (url `http://localhost:3100`), `reuseExistingServer: true`, retries 0 local / 1 CI, trace on-first-retry), npm `"test:e2e": "playwright test"`, `e2e/` ignored by Vitest (`include` already `src/**`), ESLint covers `e2e/`.
2. Helpers `e2e/helpers/{mailpit.ts (poll latest message to an address, extract OTP / link), api.ts (seed reset via backend script? → use unique emails per run `e2e+<ts>@example.com`, no DB wipe), auth.ts}`.
3. Scenarios (`e2e/*.spec.ts`):
   - `signup.spec.ts` — signup → OTP from Mailpit → dashboard shows business name → logout → login → dashboard.
   - `team-rbac.spec.ts` — owner invites manager → accept in a new browser context (Mailpit link) → manager sees Team (read-only, no Invite button), no API keys / Audit tabs → owner changes manager → viewer → manager's page (after WS `user.updated`/reload) hides Team → **"roles se menu badle" ✅**.
   - `suspend.spec.ts` — superadmin (created via `npm run superadmin:create` with `--password-stdin` in global setup) suspends the account → owner sees suspended banner + saving settings fails with message → enable → works.
   - `password.spec.ts` — forgot → reset link → old session shows signed-out on next request → login with new password.
   - `impersonation.spec.ts` — superadmin impersonates → banner → change password blocked message → stop → back to admin page.
4. Prereqs documented: `npm run infra:up`, backend `.env` with Mailpit SMTP, `npm run db:migrate`. CI: add a **manual** (`workflow_dispatch`) Playwright job in the frontend CI that checks out both repos + services (Mongo replset, Redis, Mailpit) — or document why it's deferred to Phase 12 if the cross-repo checkout needs a token (record decision).
5. Backend gap audit (table in sign-off, like Phase 1): every route → test file; add missing tests; re-measure coverage both repos → raise thresholds to the new rounded-down values if higher (never lower).
6. Security checklist (record results): logs contain no secrets (grep test across captured logs in auth tests), cookie flags, Origin check, rate limits on all public auth routes, enumeration-safe responses, token invalidation paths (password reset, change, disable, role change, logout-all), tenant isolation tests exist for every tenant route (list them), API key hashing, impersonation limits, gitleaks.
7. Docs: README both repos (auth setup, seed, superadmin, E2E how-to), `src/README.md` both, conventions (api.md auth + scopes, error-codes, websocket events, audit.md, data-model), ADR 0009 implementation notes, ADR 0011 note (layout built with plain MUI), CHANGELOGs, PHASE_2_TASKS all `[x]`, PHASE_2_PLAN deliverables `[x]` + changelog, BUILD_PLAN Phase 2 status ✅, **`docs/phases/PHASE_2_SIGNOFF.md`** (same structure as Phase 1: tasks + evidence, deliverables, requirement → test map, numbers, deviations, verification, remaining TODOs by phase, client inputs, go/no-go for Phase 3).

## P2-B3-DONE — checkpoint → `docs: mark phase 2 complete [P2-B3-DONE]`

1. `infra:up` → full verify **both repos** (each command separately) + actionlint both + `npm run test:e2e` (all scenarios green, run twice for flakiness).
2. Fresh clone of both repos (scratchpad) → `npm ci` → verify → E2E once → delete clones.
3. Manual browser-less checks via curl for anything E2E doesn't cover (refresh reuse, lockout) — or reference the Batch 1 results if unchanged.
4. Secret scan + gitleaks both repos.
5. Sign-off §verification filled; commit; `infra:down`. No push / merge.
6. **Final report (Hinglish):** per task ✅/⚠️/❌ (T2.13–T2.18 + whole-phase summary), `git log` both repos (whole phase), versions + allowScripts, deviations (all batches), verification (each command + E2E + fresh clone), tests before → after (backend 310 → N, frontend 85 → N, E2E N scenarios) + coverage, Phase 2 sign-off status, open items for Phase 3, client inputs pending (OpenAI key, SSH key, SIP, SMTP + domain), merge order note (phase-1 → dev, then phase-2 → dev).

---

## MUST-NOT-MISS CHECKLIST

**Batch 1**

- [ ] Branch `feature/phase-2-auth` in both repos (from phase-1 tip); one commit per task; hooks pass; no push/merge/tag
- [ ] Permission catalogue + role matrix exactly as the plan; single source; tests + snapshot
- [ ] Models + indexes + JSON never leaks secrets; AuditLog immutable; data-model.md updated
- [ ] Migrations 0002 / 0003 idempotent; `syncSystemRoles`; seed (refuses prod); superadmin CLI (no HTTP route, no password echo)
- [ ] argon2id params + rehash; password policy + common list; dummy hash path
- [ ] JWT (jose, HS256, iss/aud, tv, sid, imp) + expired vs invalid codes; dev secret fallback + warn
- [ ] Opaque refresh + HMAC hash + rotation + reuse → family revoke + concurrency safe
- [ ] OTP (6 digits, 10 min, 5 attempts, 60 s cooldown, 5/hour); reset token 30 min single use
- [ ] 7 new error codes in code + doc; `Retry-After` support; logger redaction extended
- [ ] `authenticate` checks order, suspension rule (GET ok), `requirePermission`, `requirePlatformAdmin`, `blockWhenImpersonating`, `apiKeyAuth`, `originCheck`, tenant helpers, grep security test
- [ ] Signup 202 both branches + min response time; verify logs in; resend 202; templates escaped
- [ ] Login lockout + dummy verify + statuses; refresh cookie flags; logout / logout-all / me / sessions; `pushToUser`
- [ ] Forgot 202 / reset / change password + token invalidation + security email
- [ ] OpenAPI for every route; env-docs test green; coverage gate green

**Batch 2**

- [ ] Account settings validation + partial merge + audit + `account.updated` event
- [ ] Team: all routes + every rule (owner, self, admin-only-by-owner, partial unique email, transfer) + invite email + `team.changed`
- [ ] API keys: format, prefix, sha256, show-once, max 20, scopes catalogue, `whoami`, `no-store`
- [ ] Audit: exact action catalogue + audit.md + sanitizer + cursor list + purge job (maintenance queue)
- [ ] Superadmin: list/detail/suspend/enable/impersonate/stop, platform protected, blocked actions, both-side audit
- [ ] WS tickets endpoint + new events in websocket.md / events.ts + socket close on revoke across instances

**Batch 3**

- [ ] Token only in memory; single-flight refresh + retry once; no loops; logout clears query cache
- [ ] Bootstrap via refresh cookie; guards with `next`; permission hooks; realtime ON only when authenticated
- [ ] All 6 auth screens incl. OTP paste/countdown, a11y autocomplete attributes
- [ ] App shell: responsive sidebar, header (WS dot, theme, user menu), banners, dashboard skeleton, 403, error boundary, shared components
- [ ] Team page + 5 settings tabs (+ backend `PATCH /auth/me`); API key show-once never cached
- [ ] Superadmin pages + impersonation start/stop/expiry/reload behaviour + Rates placeholder
- [ ] Playwright 5 scenarios incl. "roles se menu badle"; Mailpit helpers; run twice
- [ ] Gap audit + security checklist + coverage re-measure (never lower)
- [ ] Docs both repos + ADR notes + PHASE_2_SIGNOFF.md + BUILD_PLAN status; fresh clones; secret scans; `infra:down`
