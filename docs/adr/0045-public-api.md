# 0045 — Public API: one API, two auths (session or scoped key), per-key limits, public docs

- **Status:** accepted
- **Date:** 2026-10-29

## Context

Phase 15 opens the platform to the client's own systems (LMS, CRM, Zapier / Make / n8n). API keys and 7 scopes have existed since Phase 2 (`apiKeyAuth`), but no route accepted them. The dashboard API already has the routes clients need (contacts, calls, campaigns, reports, exports, templates, WhatsApp). Keys are long-lived secrets used by servers, not people. A leaked key must be stoppable fast, must not reach other accounts and must not pull phone numbers in bulk.

## Options considered

1. **A separate `/public/v1` API** with its own handlers and envelopes.
2. **The same `/api/v1` routes accept either a session or a key**, and each route declares the scope a key needs.
3. Scopes mapped to roles vs **scopes mapped to permissions**, so the shared services check one model.

## Decision

Option 2 with 3b.

- **`access({ permission, scope })`** (`shared/middlewares/access.ts`):
  - A session needs `permission`.
  - A key needs `scope`, otherwise it gets 403 `AUTH_FORBIDDEN` (`details: [{ path: 'scope' }]`).
  - Routers that host public routes use `authenticate({ apiKeys: true })`.
  - `requirePermission` always refuses keys, so a route opens to keys only on purpose.
  - Keys reach the services with the permissions their scopes imply (`SCOPE_PERMISSIONS`). Keys never get `contacts.export`, so exports by key never carry phone numbers.
- **13 scopes in 6 groups** (`api-keys/scopes.ts`): calls, contacts, campaigns, messages, templates, reports, exports, webhooks and WhatsApp AI calls.
- **The key gate** (`publicApiGate` on `/api/v1`, before every router):
  - It looks the key up by SHA-256 hash, with a 30 s in-process cache. Revoke and edit drop the cache at once on the instance that made the change. Other instances follow within 30 s, which meets the "revoked within 30 s" contract.
  - Expiry: 401 `API_KEY_EXPIRED`.
  - IP allowlist (CIDR, IPv4 / IPv6, ≤ 20): 403 `API_KEY_IP_DENIED`. It is checked against `req.ip`, so `X-Forwarded-For` counts only per `TRUST_PROXY`.
  - Per-key limits: 600 reads and 60 writes a minute, `RateLimit-*` headers, 429 + `Retry-After`. The counters live in Redis (`rl:key:<id>:r|w`).
  - A 7-day request log (method, route template, status, ms, request id; no ids, query values or bodies).
  - Daily usage counters, flushed every 10 s.
- **Writes by key** carry `origin: 'api'` / `source.type: 'api'` and an optional `externalRef` (≤ 100 characters), returned in views and webhooks. Money-moving POSTs require `Idempotency-Key`.
- **Docs** (plan §7 #6):
  - Routes open to keys are tagged `Public API` in OpenAPI.
  - `GET /api/v1/openapi.public.json` holds only those operations, only the schemas they reach, and the hand-written guides (`docs/api/*.md`, copied into `guides.gen.ts` by `npm run gen:guides`) as the Markdown description.
  - `/api/docs` is always served. With `API_DOCS_ENABLED` (dev / staging) it offers the full spec too; in production only the public one.
  - A test pins that the public spec lists exactly the key-enabled routes. A scope × route matrix snapshot pins that each route opens to one scope.

## Consequences

- One code path per feature: a fix or a guard (wallet holds, DND, opt-out, marketing limits, calling windows) applies to dashboard and API users alike.
- Adding a public route = `access({ permission, scope })` + the `Public API` tag. The security test fails if the tag and the key access disagree, or if a route opens to more than one scope.
- The full OpenAPI document (`/api/v1/openapi.json`) stays public as before. It holds no secrets. The docs page in production shows only the public part.
- Not done: OAuth apps / per-user tokens, per-account custom limits (a superadmin setting is a later phase) and a Redis-backed key cache.
