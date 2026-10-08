# Phase 2 — Sign-off

**Date:** 2026-10-09 · **Branch:** `feature/phase-2-auth` (both repos, not merged) · **Plan:** [PHASE_2_PLAN.md](PHASE_2_PLAN.md) · **Tracker:** [PHASE_2_TASKS.md](PHASE_2_TASKS.md)

**Verdict:** ✅ Phase 2 (Auth, Accounts, RBAC + App Shell) complete — all 18 tasks done. **"Done when"** (new account → member invited → menu follows the role) is proven by Playwright `e2e/team-rbac.spec.ts` (frontend repo). **Phase 3 can start.** Merging `feature/phase-2-auth` → `dev` (both repos) is a project-lead decision after review.

Verification: see §6 (filled at the `[P2-B3-DONE]` checkpoint).

## 1. Tasks — "Done when" check

| Task                             | Status | Evidence (commit; fe = frontend repo)                     | Notes                                                                                 |
| -------------------------------- | ------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| T2.1 Models, RBAC, migrations    | ✅     | `a997bec`                                                 | 7 models, 31 permissions, 5 system roles, migrations 0002 / 0003                      |
| T2.2 Crypto + tokens             | ✅     | `b051bbd`                                                 | argon2id, HS256 JWT (`jose`), refresh HMAC, OTP / reset tokens, seed + superadmin CLI |
| T2.3 Middlewares + tenancy       | ✅     | `544d41a`                                                 | `authenticate`, `requirePermission`, `apiKeyAuth`, Origin check, suspension rule      |
| T2.4 Signup + OTP                | ✅     | `e57fa0f`                                                 | enumeration-safe 202, resend cooldown / caps                                          |
| T2.5 Login / refresh / sessions  | ✅     | `c746e70`, `f7299eb`                                      | rotation + reuse detection, lockout; lost-response grace added in T2.18               |
| T2.6 Passwords                   | ✅     | `8a5b217`, `65e70ec`                                      | forgot / reset / change; OTP kept out of email subjects                               |
| T2.7 Account settings API        | ✅     | `43f4cf7`, `bc9bc22`                                      | timezone validation fixed in T2.18                                                    |
| T2.8 Team                        | ✅     | `15038dd`                                                 | invite → ownership transfer, immediate token invalidation                             |
| T2.9 API keys                    | ✅     | `db9ac84`                                                 | scoped, SHA-256, shown once, `whoami`                                                 |
| T2.10 Audit log                  | ✅     | `7506f59`                                                 | 27 typed actions = audit.md, cursor list, 365-day purge                               |
| T2.11 Superadmin                 | ✅     | `5e6de01`                                                 | suspend / enable, 30-min impersonation, both-side audit                               |
| T2.12 WS tickets + auth events   | ✅     | `c37b5a1`                                                 | `POST /api/v1/ws/tickets`, `session.revoked` closes sockets                           |
| T2.13 FE auth infra              | ✅     | `328d676` (fe)                                            | memory store, single-flight refresh (Web Locks), guards, bootstrap                    |
| T2.14 FE auth screens            | ✅     | `7dab32c` (fe)                                            | 6 pages, OTP paste + countdown, field errors from the server                          |
| T2.15 FE app shell               | ✅     | `b0b6e02`, `1a08b5d` (fe)                                 | sidebar / header / banners / theme; sidebar overlap fixed in T2.18                    |
| T2.16 FE Team + Settings         | ✅     | `0b5dcc7`, `dcc2950` (fe), `a0017e3`                      | 5 settings tabs; `PATCH /auth/me` backend                                             |
| T2.17 FE Superadmin              | ✅     | `4d91afd` (fe)                                            | list / detail / suspend / enable / impersonate, Rates placeholder                     |
| T2.18 E2E, audit, docs, sign-off | ✅     | `7222863`, `ffb8768`, `32df52b` (fe), `d65aad0`, this doc | 5 Playwright scenarios, manual CI workflow, gap + security audit, gates raised        |

Batch checkpoints: `9a7355b` `[P2-B1-DONE]`, `61bf9fa` `[P2-B2-DONE]`, `[P2-B3-DONE]` (the commit that adds §6). Run prompt: [PHASE_2_PROMPT.md](../prompts/PHASE_2_PROMPT.md).

## 2. Deliverables checklist (PHASE_2_PLAN §4)

| Deliverable                                                                           | Status |
| ------------------------------------------------------------------------------------- | ------ |
| Models + migrations + seed + superadmin CLI                                           | ✅     |
| Permission catalogue + 5 system roles (single source, exported to the frontend)       | ✅     |
| argon2id, JWT access, rotating refresh cookie with reuse detection, invalidation      | ✅     |
| Signup / OTP, login / refresh / logout(-all) / me / sessions, forgot / reset / change | ✅     |
| `authenticate`, `requirePermission`, `apiKeyAuth`, tenant helpers, suspension         | ✅     |
| Account settings API                                                                  | ✅     |
| Team: invite / accept / resend / revoke / role / enable-disable / remove / transfer   | ✅     |
| API keys + `X-API-Key` middleware                                                     | ✅     |
| Audit log + list API + purge job                                                      | ✅     |
| Superadmin accounts + suspend / enable + impersonation                                | ✅     |
| `POST /api/v1/ws/tickets` + realtime auth events                                      | ✅     |
| Frontend: auth infra, screens, shell, Team, Settings, Superadmin, realtime ON         | ✅     |
| Playwright E2E for the "Done when" scenario                                           | ✅     |
| Docs, CHANGELOGs, sign-off                                                            | ✅     |

## 3. Requirement → test mapping (gap audit)

| Requirement                                                                                   | Test file(s)                                                                            |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Models, hidden secrets, indexes, migrations 0002 / 0003                                       | `tests/db/auth-models.test.ts`, `tests/db/phase2-migrations.test.ts`                    |
| Hashing, JWT claims, HMAC, OTP / reset tokens, refresh rotation + grace                       | `src/modules/auth/crypto.test.ts`, `tests/auth/refresh-codes.test.ts`                   |
| Signup (202, enumeration, timezone), verify, resend caps                                      | `tests/auth/signup.test.ts`, `src/shared/validation/timezone.test.ts`                   |
| Login, lockout 429 + `Retry-After`, cookie flags, refresh reuse / lost response, Origin check | `tests/auth/login.test.ts`, `tests/auth/middlewares.test.ts`                            |
| Forgot / reset / change password, sessions end                                                | `tests/auth/password-flows.test.ts`, fe e2e `password.spec.ts`                          |
| Permission guards, API-key auth, suspension, impersonation blocks                             | `tests/auth/middlewares.test.ts`, `tests/admin/admin.test.ts`                           |
| Tenant isolation (no cross-account reads / writes)                                            | `tests/security/tenant-scope.test.ts`, per-module tests (`team`, `api-keys`, `account`) |
| Account settings, team rules, API keys, audit list / catalogue / purge                        | `tests/account/`, `tests/team/`, `tests/api-keys/`, `tests/audit/`                      |
| WS tickets + auth events                                                                      | `tests/realtime/ws-tickets-http.test.ts`, `tests/realtime/notify.test.ts`               |
| Rate limits (auth limiter, Redis store)                                                       | `tests/http/security.test.ts`, `tests/http/rate-limit-redis.test.ts`                    |
| No secrets in logs / email subjects                                                           | `tests/http/request-logging.test.ts`, `tests/auth/signup.test.ts`, E2E log scan (§6)    |
| FE session store, refresh interceptor, guards, bootstrap                                      | fe `src/features/auth/*.test.ts(x)`, `src/services/api/client.test.ts`                  |
| FE auth pages                                                                                 | fe `src/pages/auth/auth-pages.test.tsx`                                                 |
| FE shell, nav by permission, banners, shared components                                       | fe `src/layout/layout.test.tsx`, `src/components/components.test.tsx`                   |
| FE Team + Settings                                                                            | fe `src/pages/team-settings.test.tsx`, `src/features/settings/settings-flows.test.tsx`  |
| FE Superadmin + impersonation                                                                 | fe `src/pages/admin/admin.test.tsx`, e2e `impersonation.spec.ts`, `suspend.spec.ts`     |
| "Done when" — invite → menu follows role                                                      | fe e2e `team-rbac.spec.ts`; sign-up flow `signup.spec.ts`                               |

**Bugs the gap audit / E2E found and fixed in T2.18:**

1. Reloading during a token refresh dropped the new cookie → the old token was replayed → whole session revoked with a false `auth.refresh_reuse_detected`. Fix: 10 s lost-response grace (only while the successor is unused) — ADR 0009.
2. `Asia/Kolkata` (the platform default) failed signup / settings validation: `Intl.supportedValuesOf` lists only `Asia/Calcutta`. Fix: validate via `Intl.DateTimeFormat`, reject raw offsets; frontend shows current names — ADR 0017.
3. The permanent sidebar (≥ md) covered the left 240 px of every page.
4. Starting impersonation landed on `/403` (admin guard saw the new session first) → admin routes send an impersonating session to `/`.
5. Flaky `email-queue` test (job finished and was removed before `getJob`).
6. Phase 2 plan scenario gaps closed: manager read-only Team + no API keys / Audit tabs, manager → viewer, other sessions end after a reset.

## 4. Numbers

| Metric                                      | Backend                   | Frontend                  |
| ------------------------------------------- | ------------------------- | ------------------------- |
| Tests (end of Phase 1 → now)                | 310 → 540                 | 85 → 187 + 5 E2E          |
| Coverage (stmts / branches / funcs / lines) | 95.2 / 83.7 / 94.2 / 97.2 | 91.9 / 87.9 / 86.2 / 93.8 |
| Coverage gate (CI) — was                    | 90 / 80 / 90 / 90         | 90 / 85 / 80 / 90         |
| Coverage gate (CI) — now                    | 95 / 80 / 90 / 95         | 90 / 85 / 85 / 90         |

**Key versions added in Phase 2:** `@node-rs/argon2` 2.2, `jose` 6.2, `cookie-parser` 1.4; frontend `zustand` 5.0, `react-hook-form` 7.89 + `@hookform/resolvers` 5, `date-fns` 4 + `@date-fns/tz` 1.5, `@playwright/test` 1.64.0 (exact, Chromium headless shell).

## 5. Deviations from the plan

| Where | Deviation                                                                                               | Why                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| B1/B2 | See PHASE_2_PLAN changelog (CLI moved to T2.2, auth limiter per IP + route, lockout 401 → 429, etc.)    | —                                                                                             |
| T2.13 | Refresh serialised across tabs with the Web Locks API; `AUTH_UNAUTHENTICATED` also triggers one refresh | Rotating refresh tokens race between tabs; `tokenVersion` bump answers `AUTH_UNAUTHENTICATED` |
| T2.15 | Permanent sidebar is not collapsible (always open ≥ md; temporary drawer < md)                          | Not needed for the Phase 2 pages — revisit with the flow builder (Phase 6)                    |
| T2.17 | Impersonation ends on the first request after expiry (401), not by a timer; a full reload also ends it  | Token is memory-only by design (no refresh cookie)                                            |
| T2.18 | E2E uses its own DB (`cav_e2e`) + Redis db 5, wiped every run; runs `workers: 1`                        | Dev data untouched; specs share the auth limiter and Mailpit                                  |
| T2.18 | CI E2E workflow is manual (`workflow_dispatch`)                                                         | As planned until both repos run together in CI                                                |
| T2.18 | Backend fixes landed in T2.18 (refresh grace, timezone validation)                                      | Found by the E2E suite                                                                        |

## 6. Verification (P2-B3-DONE)

Checked on 2026-10-09 (`npm run infra:up`; dev servers stopped):

| Check                                                                                                                                                               | Result                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Backend lint, format:check, typecheck, build, `openapi:check`, `test:coverage` (540 tests, gate 95 / 80 / 90 / 95 met), actionlint                                  | ✅                                                            |
| Frontend lint, format:check, typecheck, `test:coverage` (187 tests, gate 90 / 85 / 85 / 90 met), build (DEV page absent from `dist/`), actionlint (incl. `e2e.yml`) | ✅                                                            |
| Playwright E2E — 5 scenarios, **run twice in a row**                                                                                                                | ✅ 5 / 5 both runs (~27 s each)                               |
| Fresh clone of both repos side by side → `npm ci` + all checks **without any `.env`**, `gen:api` → no diff, E2E from the clone (= CI workflow conditions)           | ✅ (E2E 5 / 5)                                                |
| Backend logs during E2E (`E2E_BACKEND_LOGS=1`, 570 lines): no passwords, codes, reset / invite tokens, cookies, `Bearer`, JWTs; recipients masked (`e***@…`)        | ✅                                                            |
| Cookie flags, Origin check, auth rate limits, enumeration-safe responses, token invalidation, tenant isolation                                                      | ✅ covered by the tests in §3                                 |
| gitleaks over both full histories + grep for key patterns / tracked `.env`                                                                                          | ✅ no findings (test passphrases allowlisted in the frontend) |
| `npm run infra:down` at the end                                                                                                                                     | ✅                                                            |

## 7. Remaining TODOs (by phase)

| Phase | Where                                 | What                                                                            |
| ----- | ------------------------------------- | ------------------------------------------------------------------------------- |
| 4     | fe `/admin/accounts/:id` Rates tab    | Per-account rates (RateCard) — placeholder today                                |
| 4     | backend / fe                          | In-app notifications (bell)                                                     |
| 4 / 8 | backend                               | Mount the idempotency middleware on money / campaign routes                     |
| 7 / 8 | backend `src/core/realtime/topics.ts` | `TODO(P7/P8)`: topic ownership check                                            |
| 10    | backend                               | Public API routes behind `X-API-Key`                                            |
| 11    | both                                  | Custom roles editor, 2FA / SSO                                                  |
| CI    | fe `.github/workflows/e2e.yml`        | Run E2E on PRs once both repos run together; `BACKEND_REPO_TOKEN` while private |
| 2+    | frontend build                        | Main chunk > 500 kB — route-level code splitting                                |

## 8. Client inputs still pending

- **OpenAI API key** — Phases 5 / 7.
- **Client server SSH key** — read-only server audit (T0.19), Phase 12.
- **SIP trunk details** — Phase 13.
- **SMTP provider + sender domain (SPF / DKIM / DMARC)** — production email for OTP / invites / resets. Dev uses Mailpit.

## 9. Go / no-go for Phase 3

✅ **Go.** Contacts build directly on tenant scoping (`accountId` from the token), `requirePermission('contacts.*')` (permissions already in the catalogue), the audit service, the `DataTable` / `PageHeader` / `ConfirmProvider` components, query-key convention and the hidden `Contacts` menu item (`phase: 3`).
