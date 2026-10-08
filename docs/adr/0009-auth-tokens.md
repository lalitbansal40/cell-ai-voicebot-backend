# 0009 — Auth tokens

- **Status:** accepted
- **Date:** 2026-10-08

## Context

Dashboard users need secure sessions; storing long-lived JWTs in localStorage (AutoChatix style) is vulnerable to XSS token theft.

## Options considered

1. **Short access JWT + refresh token in httpOnly cookie** — XSS can't read the refresh token; rotation possible.
2. **Long-lived JWT in localStorage** — simple, but risky.
3. **Server sessions (cookie + store)** — simple revocation, but stateful.

## Decision

**Short-lived access token** (JWT, ~15 min) sent as `Authorization: Bearer`, plus a **refresh token** in an `httpOnly`, `Secure`, `SameSite` cookie, **rotated on every refresh with reuse detection** (reuse → revoke session family). Public API uses hashed API keys (`X-API-Key`).

## Consequences

- **Positive:** strong default security.
- **Negative / trade-offs:** refresh flow + CSRF considerations on the refresh endpoint.
- **Follow-ups:** implemented in Phase 2.

## Implementation (Phase 2 · Batch 1)

- Access token: HS256 via `jose` (ESM, loaded with Node 24 `require(esm)`), claims `sub` (user), `acc` (account), `rid` (role), `tv` (user `tokenVersion`), `sid` (refresh family / session), `imp` (impersonating superadmin), `iss` `cav`, `aud` `cav-dashboard`, TTL `JWT_ACCESS_TTL`. `authenticate` re-loads user, role and account on every request (disable / role change / suspension apply immediately).
- Refresh token: opaque 32 bytes, stored as HMAC-SHA256(`JWT_REFRESH_SECRET`), cookie `cav_rt` (`HttpOnly`, `Secure` in production, `SameSite=Strict`, `Path=/api/v1/auth`, optional `AUTH_COOKIE_DOMAIN`). Rotation in a transaction with a conditional update (concurrent rotations: one wins, the other counts as reuse). Reuse / revoked / expired → whole family revoked, `AUTH_SESSION_REVOKED`, cookie cleared. **Lost-response grace (added at Phase 2 E2E):** a token rotated less than 10 s ago (`REFRESH_REUSE_GRACE_MS`) whose successor was never used is a lost response (page reload or dropped connection mid-refresh), not a leak. The unused successor is revoked and a new one issued in the same family. Outside the window, if the successor was already used, or if the token was revoked for any reason other than `rotated`, it is still treated as reuse. Found by the Playwright suite: a reload right after a role change signed the user out with a false `auth.refresh_reuse_detected`.
- CSRF: refresh / logout require an `Origin` from `CORS_ORIGINS` (missing Origin allowed only outside production).
- Passwords: argon2id (`@node-rs/argon2`, m=19 MiB, t=2, p=1, rehash on login); policy 10–128 chars, not email / name, not one of 1,000 common passwords.
- Enumeration: signup, resend and forgot-password always answer 202 after ≥ 300 ms; unknown-email logins run a dummy argon2 verify; "disabled" is only revealed with the right password.
- Brute force: auth routes 30 / 15 min per IP + route (own Redis store `rl:auth:`, IPv6 grouped by /56), 5 failed logins / 15 min per email, OTP 5 tries / 60 s resend / 5 per hour.
