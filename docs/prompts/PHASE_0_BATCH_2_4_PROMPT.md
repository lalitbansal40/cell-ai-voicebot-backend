# P0 · BATCH 2–4 RUN — Conventions, CI, PoCs, Compliance, Server Audit, Sign-off (T0.11 → T0.20) — Autonomous Run Prompt

> **HOW TO RUN (ek saath sab):**
> `cell-ai-voicebot-backend/docs/prompts/PHASE_0_BATCH_2_4_PROMPT.md padho aur T0.11 se P0-DONE tak SAARE tasks step by step autonomously implement karo. Bich me koi question mat poochho, permission mat maango — saare decisions is prompt me pre-made hain. Har task ke baad verify + commit (tag [P0-T0.x]). Koi push / merge NAHI. Har batch ke end me uska DONE checkpoint, aur ant me P0-DONE + final report.`
>
> **Ya batch-wise (recommended — har batch ke baad review):**
>
> - Batch 2: `… T0.11 se P0-B2-DONE tak …` (conventions, shared types, ERD, CI)
> - Batch 3: `… T0.15 se P0-B3-DONE tak …` (Voice AI PoC, SIP lab, cost model) — **pehle OpenAI key `.env` me daalo**
> - Batch 4: `… T0.18 se P0-DONE tak …` (compliance, server audit, sign-off, Phase 1 plan) — **pehle SSH key path set karo**
>
> **Claude Code "accept edits" mode me chalao.** Working directory: `/Users/lalitbansal/Documents/cell-ai-voicebot`

---

## 0. CONTEXT (verified facts — dobara derive mat karna)

**Batch 1 (T0.1–T0.10) DONE** — dono repos me branch `feature/phase-0-setup` pe, last commits: backend `[P0-B1-DONE]`, frontend `[P0-T0.10]`. Kuch push nahi hua hai.

**Folders:**

```
/Users/lalitbansal/Documents/cell-ai-voicebot/
  docs/                         ← purani copies + PDFs (source of truth NAHI — mat chhedo)
  cell-ai-voicebot-backend/     ← git, branch feature/phase-0-setup
    docs/                       ← SOURCE OF TRUTH: plans/, phases/, prompts/, adr/ (0000–0028), conventions/,
                                   setup/, poc/, client/, cost/, compliance/
    src/ (module-based, sirf index.ts hello)  tests/infra/  scripts/  poc/  docker-compose.yml
  cell-ai-voicebot-frontend/    ← git, branch feature/phase-0-setup
    src/ app/ pages/ services/api/client.ts theme/ test/ …
```

**Pehle padho:** `docs/phases/PHASE_0_PLAN.md` (T0.11–T0.20 ka source), `docs/plans/BUILD_PLAN.md`, `docs/adr/README.md`, `docs/conventions/*`, `docs/setup/prerequisites.md`, `docs/client/answers.md`, `CHANGELOG.md`, dono READMEs.

**Verified stack (Batch 1 me install hua):**

| Cheez                 | Version / value                                                                                                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node / npm            | 24.19 / 11.17 (machine); `.nvmrc` 24, `engine-strict=true`                                                                                                                                                  |
| TypeScript            | **6.0.3 (pinned `~6.0.3`)** — typescript-eslint sirf `<6.1` support karta hai                                                                                                                               |
| ESLint                | **9.39 (pinned `^9`)** — import resolver ka optional peer ESLint 10 ke saath conflict karta hai                                                                                                             |
| Backend               | CommonJS + `module/moduleResolution: NodeNext`, tsx, Vitest 5, mongodb-memory-server 11 (MongoDB **8.2.12** pinned in `package.json → config.mongodbMemoryServer`)                                          |
| Frontend              | Vite 8, React 19, MUI 9, React Router 8, React Query 5, zod 4, Vitest 5 + RTL                                                                                                                               |
| Local infra           | `mongo:8.2` replica set `rs0` on `127.0.0.1:27018`, `redis:7.4-alpine` on `127.0.0.1:6380` (`npm run infra:up/down`)                                                                                        |
| **MongoDB 8.0 NAHI**  | 8.0.x Linux kernel ≥ 6.19 pe start nahi hota (SERVER-121912); Docker VM kernel 7.0 hai                                                                                                                      |
| npm 11 `allowScripts` | Backend: `esbuild ✓`, `unrs-resolver ✓`, `fsevents ✗`, `mongodb-memory-server ✗`. Frontend: `unrs-resolver ✓`, `fsevents ✗`. Naye deps ke baad `npm approve-scripts --allow-scripts-pending` se review karo |
| Machine               | macOS 26.6 arm64, Docker 29.7 + Compose v5.4 (Docker Desktop manually start karna padta hai: `open -a Docker`), **gh CLI nahi**, Homebrew nahi                                                              |
| Doosre containers     | Is machine pe ek **Supabase stack** chal raha hai — **kabhi stop/remove nahi**                                                                                                                              |
| Client server         | AWS EC2 `ubuntu@13.232.191.62`, m6a.2xlarge, key-file auth; **doosri app chal rahi hai — disturb nahi**                                                                                                     |

---

## 1. RULES OF ENGAGEMENT (strictly — har task)

1. **Question mat poochho, permission mat maango.** AskUserQuestion BANNED. Ambiguous → safe + plan/ADR-consistent option, report me likho.
2. **Git:** saara kaam `feature/phase-0-setup` pe (dono repos). Har task = ek commit per repo (jis repo me kuch badla), Conventional Commit + tag, e.g. `docs(conventions): add api and websocket conventions [P0-T0.11]`. Husky hooks (lint-staged + commitlint) pass hone chahiye — `--no-verify` **kabhi nahi**. **No push, no merge, no tag.**
3. **Verify har task ke baad** — jis repo me badla: `npm run lint && npm run format:check && npm run typecheck && npm test && npm run build`. Fail → fix → tab commit.
4. **Secrets:** OpenAI key, SSH key, client DB password, NotifyNow key, lab passwords — code / docs / commits / logs / report / output files me **kabhi nahi**. Key ko kabhi `echo`/print mat karo. Sirf `.env` (gitignored) se padho.
5. **Scope:** sirf T0.11–T0.20. Phase 1 ka production code (Express app, logger, DB connection, auth) **NAHI** — sirf jo prompt bole (proof code, PoC code, scripts, docs).
6. **PoC code** `poc/` me — backend build/lint/tsconfig se bahar (already excluded). Har PoC apna `package.json` + `tsconfig.json` + README rakhe; uske `node_modules/` aur `output/` gitignored.
7. **Paisa:** OpenAI spend hard cap — PoC runner `POC_MAX_USD` (default **10**) cross hote hi ruk jaye. Report me actual spend likho.
8. **Client server (T0.19): STRICT READ-ONLY.** Sirf neeche diye allowlisted commands. Koi install / update / restart / edit / delete / `sudo` / file copy nahi. Doosri app ke logs, data, env, config contents **nahi padhna**.
9. **Network:** sirf zaroori jagah — npm registry, Docker Hub, MongoDB binary downloads, OpenAI API, official docs/legal sources (research ke liye), client server (sirf T0.19).
10. **Docker:** sirf apne compose projects (`cell-ai-voicebot`, `cav-sip-lab`). Doosre containers / volumes / images ko haath nahi.
11. **Docs:** naya doc → `docs/README.md` index me link. Har badla decision → ADR + `BUILD_PLAN.md`/`PHASE_0_PLAN.md` changelog.
12. **Facts verify karo:** model names, pricing, API event names, legal rules — official source se **is run me** check karo (WebFetch/WebSearch), source link + "checked on <date>" likho. Yaad se mat likho.

---

## 2. RESUME SAFETY

- Naya session: dono repos me `git branch --show-current` + `git log --oneline -25`. Aakhri `[P0-T0.x]` / `[P0-Bx-DONE]` commit ke **agle task** se continue; jo ho chuka dobara nahi.
- Resume pe pehle dono repos me `npm ci && npm run lint && npm run typecheck && npm test` green confirm karo.
- PoC runs: `poc/voice-ai/output/<runId>/` me har scenario ka `summary.json` bana ho to wo scenario dobara mat chalao (paisa bachao) — runner `--resume <runId>` support kare.

---

# ═══════════ BATCH 2 — Conventions, Shared Types, ERD, CI ═══════════

## T0.11 — API, WebSocket, data & code conventions (BACKEND `docs/conventions/`) → commit

Har doc me: purpose, rules (numbered), ✅/❌ examples, aur related ADR links. Language: simple English (code examples ke saath).

### A. `docs/conventions/api.md`

1. **Base & naming:** `/api/v1/...`; resources plural kebab-case (`/api/v1/ai-agents`, `/api/v1/contact-lists`); nested max 1 level (`/api/v1/campaigns/:id/contacts`); IDs = 24-char ObjectId strings.
2. **Methods:** `GET` list/detail · `POST` create **ya action** · `PATCH` partial update · `PUT` sirf full replace (avoid) · `DELETE`. Actions: `POST /api/v1/campaigns/:id/pause`, `…/resume`, `…/cancel`, `POST /api/v1/calls/:id/hangup`.
3. **Success envelope:** `{ "success": true, "data": … , "meta"?: { … } }` — list ke liye `data` = array, `meta` = pagination. 201 on create (body me created resource), 204 no body (delete).
4. **Error envelope:** `{ "success": false, "error": { "code": "DOMAIN_REASON", "message": "Human readable", "details"?: [ { "path": "phone", "message": "Invalid E.164" } ], "requestId": "…" } }`. `message` user-safe (no stack, no internals).
5. **HTTP status table** — 200, 201, 204, 400 (malformed), 401 (no/invalid auth), 403 (no permission), 404, 409 (conflict/duplicate/state), 422 (validation), 429 (rate limit), 500, 502 (upstream provider error), 503 (dependency down) — har ek ka "kab use karna" + example code.
6. **Error code catalogue** → alag file `docs/conventions/error-codes.md`: format `DOMAIN_REASON`, table (code, HTTP status, meaning, phase). Initial list kam se kam: `VALIDATION_FAILED`, `REQUEST_MALFORMED`, `AUTH_UNAUTHENTICATED`, `AUTH_TOKEN_EXPIRED`, `AUTH_INVALID_CREDENTIALS`, `AUTH_FORBIDDEN`, `RESOURCE_NOT_FOUND`, `CONFLICT_DUPLICATE`, `CONFLICT_INVALID_STATE`, `RATE_LIMITED`, `IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_IN_PROGRESS`, `WALLET_INSUFFICIENT_BALANCE`, `WALLET_BUDGET_EXCEEDED`, `CONTACT_DND`, `CONTACT_OPTED_OUT`, `CALL_OUTSIDE_WINDOW`, `CAMPAIGN_NOT_RUNNABLE`, `FLOW_INVALID`, `PROVIDER_UNAVAILABLE`, `PROVIDER_ERROR`, `AI_UNAVAILABLE`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, `INTERNAL_ERROR`. Note: Phase 1 me ye `src/shared/errors/error-codes.ts` me code ban jayega (single source); doc us file se sync rahe.
7. **Pagination:**
   - Offset (default, admin lists): `?page=1&limit=20` (limit max 100) → `meta: { page, limit, total, totalPages }`.
   - Cursor (high-volume: calls, call events, ledger, transcripts): `?cursor=<opaque>&limit=50` → `meta: { nextCursor, hasMore }`; cursor = base64url of `{ createdAt, _id }`.
8. **Sorting:** `?sort=-createdAt,name` (`-` = desc), **per-endpoint allowlist** (unknown field → 422). Default `-createdAt`.
9. **Filtering:** plain query params (`?status=running&listId=…`), ranges `createdFrom` / `createdTo` (ISO), multi-value comma (`?status=failed,busy`). Search `?q=`. Unknown params ignore nahi — 422.
10. **Data formats:** dates ISO-8601 UTC (`2026-10-08T06:30:00.000Z`); money = integer `*Micros` + `currency` (ADR 0016); phone E.164 (ADR 0018); booleans true/false (strings nahi); **enum values lower_snake_case** (`no_answer`, `promise_to_pay`); field names camelCase (ADR 0015); null vs absent: absent = not set, `null` = explicitly cleared.
11. **Headers:** `Authorization: Bearer <access>` (dashboard) · `X-API-Key` (public API) · `X-Request-Id` (client bheje to reuse, warna server generate; har response me echo) · `Idempotency-Key` (required on paisa/side-effect wale POST: call trigger, campaign start, top-up; 24h store; same key + same body → stored response replay; same key + different body → 422 `IDEMPOTENCY_KEY_REUSED`; in-flight → 409 `IDEMPOTENCY_IN_PROGRESS`) · Rate limit: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` + `Retry-After` on 429.
12. **File uploads:** `multipart/form-data`, field name `file`; limits table — contacts CSV/XLSX 10 MB, audio prompt (mp3/wav) 10 MB, KB docs (pdf/docx/txt) 20 MB; MIME + extension both check; 413 `PAYLOAD_TOO_LARGE`, 415 `UNSUPPORTED_MEDIA_TYPE`.
13. **Dashboard API vs Public API (decision):** dono same `/api/v1/...` paths aur same envelope use karte hain; fark sirf auth ka hai — dashboard `Authorization: Bearer`, public API `X-API-Key` + scopes (`calls:write`, `contacts:write`, `campaigns:read` …). Full scopes list Phase 10 me.
14. **Outbound webhooks (Phase 10 preview):** `POST` JSON `{ id, type, createdAt, data }`; headers `X-Webhook-Id`, `X-Webhook-Timestamp`, `X-Webhook-Signature: v1=<hex HMAC-SHA256(secret, timestamp + "." + body)>`; receiver 5 min tolerance; retries exponential (1m, 5m, 30m, 2h, 12h) then disabled after N failures.
15. **Versioning/deprecation:** breaking change → `/api/v2`; deprecations announce via `Deprecation` + `Sunset` headers.
16. **Tenant scoping rule:** `accountId` **kabhi request body/query se nahi** — hamesha auth context se; har query `accountId` scoped.

### B. `docs/conventions/websocket.md`

1. Endpoints: `/ws/events` (JSON text frames — dashboard live updates) · `/ws/media` (web-call: binary audio + JSON control text frames).
2. **Auth (decision): short-lived WS ticket** — client pehle `POST /api/v1/ws/tickets` (Bearer auth) → `{ ticket, expiresAt }` (single-use, 60s, Redis me) → connect `wss://…/ws/events?ticket=…`. Reason: JWT URL/logs me leak na ho. Invalid → close `4001`.
3. **Envelope (server → client):** `{ "type": "call.status", "data": { … }, "ts": "ISO", "id": "evt_…" }`.
4. **Client → server messages:** `{ "type": "ping" }`, `{ "type": "subscribe", "topics": ["campaign:<id>", "call:<id>"] }`, `{ "type": "unsubscribe", … }`. Default: account-level events automatically; heavy streams (live transcript) sirf subscribed topic pe.
5. **Event catalogue** (table: type, when, data fields, topic): `call.created`, `call.status` (`queued|ringing|in_progress|completed|failed|busy|no_answer|canceled`), `call.transcript` (`{ callId, seq, speaker, text, final }`), `call.dtmf`, `call.ended` (`{ callId, durationSec, disposition, costMicros }`), `campaign.progress` (`{ campaignId, stats }`, throttled ≤ 1/sec), `campaign.status`, `wallet.updated` (`{ balanceMicros, holdMicros }`), `wallet.low_balance`, `import.progress`, `notification.created`, `presence.changed`.
6. **Keepalive:** client ping har 25s; server pong; server 60s silence pe close. **Reconnect:** exponential backoff 1s → 2s → 4s … max 30s + jitter; reconnect pe naya ticket; missed events ke liye REST se refetch (WS = notification, source of truth = REST).
7. **Close codes:** `1000` normal, `1001` going away, `4001` unauthorized, `4003` forbidden, `4008` policy/rate, `4009` too many connections, `4010` ticket expired.
8. **`/ws/media` web-call protocol:** text frames JSON control (`call.start { flowId | agentId, contactId?, variables? }` → `call.started { callId }`, `call.dtmf { digit }`, `call.hangup`, server → `call.ended`, `call.transcript`, `call.event`); binary frames = audio: **PCM16 little-endian mono 24 kHz, 20 ms chunks (960 bytes)** both directions; server may send `audio.clear` (barge-in: client turant playback flush kare).
9. Limits: max message size (events 64 KB, media 32 KB/frame), max connections per user (5), per account (50) — Phase 1/7 me tune.

### C. `docs/conventions/data.md`

1. Collections plural camelCase (`contacts`, `ledgerEntries`, `callEvents`); fields camelCase; `_id` ObjectId.
2. **Tenant:** har tenant document me `accountId` (ObjectId, required, indexed) — **har query scoped**; compound indexes me `accountId` pehla field.
3. Timestamps: Mongoose `timestamps: true` (`createdAt`, `updatedAt`); actor fields `createdBy` / `updatedBy` (userId) jahan audit chahiye.
4. **Soft delete** (`deletedAt: Date | null`, queries default `deletedAt: null`): contacts, contactLists, aiAgents, flows, campaigns, phoneNumbers, users. **Hard delete / never delete:** ledgerEntries (immutable — corrections = new entry), calls + transcripts (retention policy se purge), auditLogs.
5. **Immutability:** ledger entries, published flowVersions, callEvents — update nahi, sirf insert.
6. Enums: string unions, lower_snake_case values. Money `*Micros` integers + `currency`. Phones E.164. Dates UTC.
7. **Indexes:** har collection ki index list model file me + `data-model.md` me; naming default; unique indexes tenant-scoped (`{ accountId: 1, phoneE164: 1 }`); TTL indexes for ephemeral data (`refreshTokens.expiresAt`, `idempotencyKeys.expiresAt`, `wsTickets`, `webhookDeliveries` 30 din).
8. **Big data rule:** unbounded arrays document me nahi (16 MB limit) — transcripts, call events, campaign contacts **alag collections**.
9. **PII inventory** (table: collection.field, type, treatment): `contacts.phoneE164/name/email/variables` (loan data!), `calls.from/to`, `transcriptTurns.text`, recordings, `users.email/phone`. Treatment: encrypt-at-rest for `telephonyConfigs.sip.password`, `outboundWebhooks.secret`, API key secrets (hash); logs me phone mask (`+91******3210`); exports sirf permission wale roles.
10. Migrations: `src/db/migrations/NNNN-name.ts` (up/down), runner Phase 1; seeds `src/db/seeds/`. Schema change backward-compatible pehle (add optional field → backfill → enforce).
11. Transactions: wallet hold/capture/release + ledger writes **hamesha** ek transaction me (replica set required — ADR 0004).

### D. `docs/conventions/code-style.md`

1. **Backend files** kebab-case (`contact-import.service.ts`); module layout + layering (ADR 0003, `src/README.md` link); **named exports only** (default export sirf jahan tool maange — config files).
2. **Frontend files:** components PascalCase (`ContactTable.tsx`), hooks `useX.ts`, others kebab-case; ek component per file; feature folders; named exports; pages lazy-load (Phase 2).
3. **React Query keys** factory pattern: `export const contactKeys = { all: ['contacts'] as const, list: (p) => [...contactKeys.all, 'list', p] as const, detail: (id) => [...] }`.
4. **Errors (backend):** `AppError(code, httpStatus, message, details?)` subclasses; kabhi string throw nahi; controllers async wrapper / Express 5 native async; unknown errors → 500 `INTERNAL_ERROR` + log with requestId.
5. **Logging:** pino child logger with `requestId`, `accountId`, `callId`; levels (`debug` dev only, `info` lifecycle, `warn` recoverable, `error` failures); PII mask; `console.*` nahi.
6. **Async:** no floating promises (lint enforced); fire-and-forget sirf explicit `void promise.catch(log)` ke saath + comment kyun.
7. **Validation:** har route input zod se; types `z.infer` se — duplicate interfaces nahi.
8. **Comments:** "why" likho, "what" nahi; TODO format `TODO(P<phase>): …`.
9. **Tests:** `*.test.ts(x)` next to code; integration `tests/`; test names behaviour describe karein; har bug fix ke saath regression test.
10. **Imports:** order lint enforced; frontend `@/` alias; backend relative; circular imports error.
11. **Git:** Conventional Commits + task tag; small PRs; PR template.

### E. Wire-up

- `docs/README.md` index + `docs/conventions/definition-of-done.md` me links (api, websocket, data, code-style, error-codes).
- Dono READMEs ke "Conventions" section me in docs ke links (frontend → GitHub URLs, jaise pehle).
- `npx prettier --write` docs.

**Commits:** backend `docs(conventions): add api, websocket, data and code style conventions [P0-T0.11]` · frontend `docs: link shared conventions [P0-T0.11]`

**VERIFY:** 5 naye files (`api.md`, `websocket.md`, `data.md`, `code-style.md`, `error-codes.md`) + index links; format/lint pass.

---

## T0.12 — Shared types strategy + proof (DONO repos) → commit per repo + ADR

**Decision (ADR 0029, accepted):** backend zod schemas = single source → OpenAPI 3.1 JSON (`openapi/openapi.json`, committed) → frontend `openapi-typescript` se `src/services/api/schema.gen.ts` (committed). Frontend CI backend repo pe depend nahi karta (generated file committed hai).

### Backend

1. Deps: `zod` (v4) + **`@asteasolutions/zod-to-openapi`** (pehle `npm view @asteasolutions/zod-to-openapi peerDependencies` se zod v4 support confirm karo). **Agar zod v4 support na ho:** fallback — zod v4 native `z.toJSONSchema()` se component schemas + chhota typed builder (`openapi3-ts` types) se document; ADR 0029 me likho kaunsa path liya.
2. Files:
   - `src/shared/openapi/registry.ts` — `OpenAPIRegistry` instance + `extendZodWithOpenApi(z)` (agar library ko chahiye).
   - `src/shared/openapi/common.schemas.ts` — `ErrorEnvelopeSchema`, `successEnvelope(schema)` helper, `OffsetPageMetaSchema`, `CursorPageMetaSchema` (T0.11 api.md ke exactly hisaab se), registered as components.
   - `src/modules/system/system.schema.ts` — `AppInfoSchema` (`name`, `version`, `node`, `env` — `getAppInfo()` ke same fields) + `registerPath` for `GET /api/v1/system/info` (200 → success envelope with AppInfo; 500 → ErrorEnvelope). **Sirf documented — route implement Phase 1 me.** `src/modules/system/` folder `src/README.md` table me add karo.
   - `src/shared/openapi/document.ts` — `buildOpenApiDocument()` → OpenAPI 3.1 (`info.title` "Cell AI Voicebot API", `info.version` from `process.env.npm_package_version ?? '0.0.0-dev'`, `servers: [{ url: '/api/v1' }]`? → **paths full `/api/v1/...` rakho, servers `[{ url: 'http://localhost:5100' }]`**), security schemes `bearerAuth` (JWT) + `apiKeyAuth` (`X-API-Key` header).
3. `scripts/generate-openapi.ts` → `openapi/openapi.json` likhe (2-space JSON + trailing newline, **deterministic** — keys stable; do baar chalane pe same output).
4. Scripts: `"gen:openapi": "tsx scripts/generate-openapi.ts"`, `"openapi:check": "npm run gen:openapi && git diff --exit-code -- openapi/openapi.json"` (CI me use).
5. Tests: `src/modules/system/system.schema.test.ts` — `AppInfoSchema.parse(getAppInfo())` pass; invalid shape fail · `src/shared/openapi/document.test.ts` — document me `/api/v1/system/info` path + `AppInfo`, `ErrorEnvelope` components; `openapi` = `3.1.x`.
6. `.prettierignore` me `openapi/openapi.json` **mat** daalo — prettier format consistent rakhe (generator ke baad `prettier --write openapi/openapi.json` script me include ya generator khud prettier-compatible likhe; `openapi:check` stable hona chahiye).
7. README: "API contract (OpenAPI)" section — kaise regenerate, kab (har schema change), CI check.

### Frontend

1. devDep `openapi-typescript`.
2. `scripts/gen-api.mjs` — spec path `process.env.OPENAPI_SPEC ?? '../cell-ai-voicebot-backend/openapi/openapi.json'` → `src/services/api/schema.gen.ts`; file header comment `// AUTO-GENERATED by npm run gen:api — do not edit`. Script: `"gen:api": "node scripts/gen-api.mjs"`.
3. `schema.gen.ts` ko ESLint ignore + `.prettierignore` (generated) — par typecheck me include rahe.
4. `src/services/api/types.ts` — `export type AppInfo = components['schemas']['AppInfo'];`, `ApiErrorEnvelope`, `SuccessEnvelope<T>`.
5. `src/services/api/system.ts` — `getSystemInfo(): Promise<AppInfo>` using `apiClient` (unwrap envelope; abhi kahin call nahi).
6. Test `src/services/api/types.test.ts` — Vitest `expectTypeOf` se AppInfo fields types check + `getSystemInfo` ko axios mock (vi.spyOn(apiClient, 'get')) karke envelope unwrap test.
7. README: "API types" section (regenerate steps; backend spec pehle generate karo).

### ADR

- `docs/adr/0029-shared-api-types-via-openapi.md` (accepted) + `docs/adr/README.md` index row. ADR 0006 ke Follow-ups me 0029 link.

**Commits:** backend `feat(api): add openapi generation from zod schemas [P0-T0.12]` · frontend `feat(api): generate api types from openapi spec [P0-T0.12]`

**VERIFY:** backend `npm run gen:openapi` 2× → `git diff --exit-code` clean (deterministic) · `npm run openapi:check` pass · frontend `npm run gen:api` → `schema.gen.ts` banta hai → `npm run typecheck && npm test` pass · dono repos full verify.

---

## T0.13 — Core data model draft (ERD) (BACKEND `docs/conventions/data-model.md`) → commit

**Goal:** Phase 1–14 ke saare entities ka outline — fields (naam + type + note), relations, indexes, PII, retention. Ye **design doc** hai, Mongoose models Phase-wise banenge.

**Structure:**

1. Overview + conventions link (data.md).
2. **Mermaid `erDiagram`** — saare entities + relationships (cardinalities). Bada ho to 3 diagrams: (a) Tenancy & auth, (b) Contacts / campaigns / calls, (c) Wallet / AI / flows / integrations.
3. **Per-entity section** (har ek: purpose · fields table (field, type, required, notes) · indexes · PII · retention · owning phase).
4. **Embedded vs separate** decisions table.
5. **Open questions** list.

**Entities + pre-decided key fields** (sab me `_id`, `accountId` (tenant wale), `createdAt`, `updatedAt`):

| Entity (collection)                              | Key fields / decisions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Phase |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| Account (`accounts`)                             | name, slug (unique), status (`active\|suspended`), timezone (default `Asia/Kolkata`), country (`IN`), defaultLanguage, settings { callingWindow { start "09:00", end "19:00", days [1..6] }, recordingEnabled, aiDisclosureEnabled }                                                                                                                                                                                                                                                                                                    | 2     |
| User (`users`)                                   | accountId, name, email (unique global, lowercase), phone?, passwordHash, roleId, status (`invited\|active\|disabled`), lastLoginAt, deletedAt                                                                                                                                                                                                                                                                                                                                                                                           | 2     |
| Role (`roles`)                                   | accountId, name, permissions [string], isSystem (owner/admin/manager/agent/viewer)                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 2     |
| RefreshToken (`refreshTokens`)                   | userId, accountId, familyId, tokenHash, expiresAt (TTL), revokedAt, replacedBy, userAgent, ip                                                                                                                                                                                                                                                                                                                                                                                                                                           | 2     |
| ApiKey (`apiKeys`)                               | accountId, name, prefix (visible), keyHash, scopes [string], lastUsedAt, revokedAt, createdBy                                                                                                                                                                                                                                                                                                                                                                                                                                           | 2/10  |
| AuditLog (`auditLogs`)                           | accountId, actor { type `user\|api_key\|system`, id }, action, target { type, id }, meta, ip, at — retention 1 year                                                                                                                                                                                                                                                                                                                                                                                                                     | 2     |
| IdempotencyKey (`idempotencyKeys`)               | accountId, key, method+path, requestHash, status, responseStatus, responseBody, expiresAt (TTL 24h); unique (accountId, key)                                                                                                                                                                                                                                                                                                                                                                                                            | 1     |
| Contact (`contacts`)                             | accountId, phoneE164 (unique per account), name, email?, variables { [key]: string\|number\|date } (loan data → **PII**), tags [string] (no Tag collection), listIds [ObjectId], dnd bool, optedOutAt?, lastCalledAt?, callCount, deletedAt                                                                                                                                                                                                                                                                                             | 3     |
| ContactList (`contactLists`)                     | accountId, name, source { type `upload\|api\|manual`, fileName? }, contactCount, deletedAt                                                                                                                                                                                                                                                                                                                                                                                                                                              | 3     |
| CustomFieldDefinition (`customFieldDefinitions`) | accountId, key (unique per account, `^[a-z][a-z0-9_]*$`), label, type (`text\|number\|date\|currency\|phone`), required, defaultValue                                                                                                                                                                                                                                                                                                                                                                                                   | 3     |
| DndEntry (`dndEntries`)                          | accountId, phoneE164 (unique per account), reason, source (`manual\|upload\|keyword\|dtmf`)                                                                                                                                                                                                                                                                                                                                                                                                                                             | 3     |
| ImportJob (`importJobs`)                         | accountId, listId, fileName, fileKey, mapping {}, status (`pending\|processing\|completed\|failed`), totals { rows, imported, updated, invalid, duplicates }, errorReportFileKey                                                                                                                                                                                                                                                                                                                                                        | 3     |
| Wallet (`wallets`)                               | accountId (unique), currency, balanceMicros, holdMicros, creditLimitMicros (default 0 — AI never on credit), lowBalanceThresholdMicros, budgets { monthlyCallMicros, monthlyAiMicros }                                                                                                                                                                                                                                                                                                                                                  | 4     |
| LedgerEntry (`ledgerEntries`)                    | accountId, type (`topup\|call_charge\|ai_charge\|tts_charge\|adjustment\|refund\|subscription`), status (`held\|captured\|released`), amountMicros, currency, breakdown { telephonyMicros, aiMicros, ttsMicros, commissionMicros }, ref { type `call\|campaign\|topup\|manual`, id }, idempotencyKey (unique per account), note, createdBy — **immutable**                                                                                                                                                                              | 4     |
| RateCard (`rateCards`)                           | accountId (null = platform default), telephonyPerMinuteMicros, pulseSeconds (15/30/60), aiPerMinuteMicros, ttsPer1kCharsMicros, commissionPercent, effectiveFrom                                                                                                                                                                                                                                                                                                                                                                        | 4     |
| TopupOrder (`topupOrders`)                       | accountId, provider `razorpay`, providerOrderId/PaymentId (unique), baseMicros, taxMicros, totalMicros, status, ledgerEntryId                                                                                                                                                                                                                                                                                                                                                                                                           | 4     |
| Invoice (`invoices`)                             | accountId, number (unique, sequential), kind (`topup\|subscription`), ledgerEntryId, amounts, taxBreakdown, pdfFileKey                                                                                                                                                                                                                                                                                                                                                                                                                  | 4     |
| AiAgent (`aiAgents`)                             | accountId, name, provider (`openai_realtime`), model, voice, languageMode (`auto\|hi\|en\|hinglish`), systemPrompt, openingLine, closingLine, toneRules, temperature, maxCallSeconds, silenceTimeoutSec, bargeIn, functions [AgentFunction embedded: name, description, parametersSchema, http { method, url, headers, bodyTemplate, resultPath, timeoutMs }], builtInTools [string], knowledgeSourceIds, limits { dailyMicros, monthlyMicros }, fallbackMessages {}, status, deletedAt                                                 | 5     |
| KnowledgeSource (`knowledgeSources`)             | accountId, agentId, type (`file\|url`), name, fileKey/url, status, chunkCount, vectorRef — **vector store choice Phase 5 me (open question)**                                                                                                                                                                                                                                                                                                                                                                                           | 5     |
| Flow (`flows`)                                   | accountId, name, description, status (`draft\|published\|archived`), draftVersionId, publishedVersionId, deletedAt                                                                                                                                                                                                                                                                                                                                                                                                                      | 6     |
| FlowVersion (`flowVersions`)                     | accountId, flowId, version (int, unique per flow), nodes [ ], edges [ ], variablesSchema, createdBy, publishedAt — **published = immutable**                                                                                                                                                                                                                                                                                                                                                                                            | 6     |
| Campaign (`campaigns`)                           | accountId, name, flowId, **flowVersionId (pinned at start)**, audience { listIds, segment? }, callerNumberId, schedule { startAt, timezone, recurrence? }, window { start, end, days }, retry { maxAttempts, intervalMinutes, retryOn [`busy\|no_answer\|failed`] }, concurrency, status (`draft\|scheduled\|running\|paused\|completed\|canceled\|failed`), stats {…}, estimatedCostMicros, holdLedgerEntryId                                                                                                                          | 8     |
| CampaignContact (`campaignContacts`)             | accountId, campaignId, contactId, phoneE164 + variables **snapshot**, status (`pending\|queued\|calling\|completed\|failed\|skipped`), attempts, nextAttemptAt, lastCallId, disposition, skipReason; **unique (campaignId, contactId)**                                                                                                                                                                                                                                                                                                 | 8     |
| Call (`calls`)                                   | accountId, direction (`outbound\|inbound`), provider (`webcall\|sip\|notifynow`), providerCallId, from, to, contactId?, campaignId?, campaignContactId?, flowId?, flowVersionId?, agentId?, status, hangupCause, timestamps { queuedAt, startedAt, answeredAt, endedAt }, durationSec, billableSec, disposition, sentiment, summary, languageDetected, recording { fileKey, durationSec, sizeBytes } (embedded), cost { telephonyMicros, aiMicros, ttsMicros, totalMicros }, ledgerEntryId, variables snapshot, error { code, message } | 7     |
| CallEvent (`callEvents`)                         | accountId, callId, seq, type (`node_entered\|node_exited\|dtmf\|ai_function_call\|status\|error\|…`), data, at — unique (callId, seq)                                                                                                                                                                                                                                                                                                                                                                                                   | 7     |
| TranscriptTurn (`transcriptTurns`)               | accountId, callId, seq, speaker (`customer\|bot\|agent`), text, language, startMs, endMs, confidence, interrupted — unique (callId, seq)                                                                                                                                                                                                                                                                                                                                                                                                | 7     |
| PhoneNumber (`phoneNumbers`)                     | accountId, e164 (unique global), provider, capabilities { inbound, outbound }, inboundFlowId?, inboundAgentId?, status, deletedAt                                                                                                                                                                                                                                                                                                                                                                                                       | 13/14 |
| TelephonyConfig (`telephonyConfigs`)             | accountId, provider, sip { host, port, transport, username, passwordEnc, callerId }, concurrencyLimit, status                                                                                                                                                                                                                                                                                                                                                                                                                           | 13    |
| OutboundWebhook (`outboundWebhooks`)             | accountId, url, events [string], secretEnc, active, failureCount, disabledAt                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 10    |
| WebhookDelivery (`webhookDeliveries`)            | accountId, webhookId, eventId, type, payload, status, attempts, nextAttemptAt, responseStatus, durationMs — TTL 30 days                                                                                                                                                                                                                                                                                                                                                                                                                 | 10    |
| Notification (`notifications`)                   | accountId, userId?, type, title, body, link, readAt                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 2+    |

**Indexes (minimum, doc me har entity ke saath):** `contacts {accountId,phoneE164} unique`, `contacts {accountId,listIds}`, `contacts {accountId,tags}`, `calls {accountId,createdAt:-1}`, `calls {accountId,campaignId,status}`, `calls {provider,providerCallId} unique sparse`, `campaignContacts {campaignId,status,nextAttemptAt}`, `ledgerEntries {accountId,createdAt:-1}`, `ledgerEntries {accountId,idempotencyKey} unique`, `transcriptTurns {callId,seq} unique`, `callEvents {callId,seq} unique`, TTL indexes (refreshTokens, idempotencyKeys, webhookDeliveries).

**Embedded vs separate table** (minimum): AgentFunction → embedded (small, edited together) · Recording → embedded in Call · TranscriptTurn / CallEvent → separate (unbounded) · CampaignContact → separate (thousands) · Tags → strings on contact (no collection) · FlowVersion → separate (immutable history).

**Open questions:** vector store (OpenAI vector store vs MongoDB 8.2 vector search vs other) — Phase 5; recordings storage format (μ-law WAV vs Opus) — Phase 7; client production DB (answers.md #5); retention periods (client legal — T0.18).

**Commit:** `docs(data): add core data model draft with erd [P0-T0.13]`

**VERIFY:** Mermaid syntax valid — `npx -y @mermaid-js/mermaid-cli` se har diagram ko session ke scratchpad folder me render karke check karo (repo me koi rendered file nahi); agar CLI install/run fail ho to syntax manually double-check karo aur report me note likho; `docs/README.md` index link; data.md se cross-link.

---

## T0.14 — CI pipeline + repo automation (DONO repos) → commit per repo

1. **`.github/workflows/ci.yml`** (dono repos):
   - `on`: `pull_request` (all branches) + `push` on `main`, `dev`.
   - `permissions: contents: read`; `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }`.
   - Job `verify` (`ubuntu-24.04`, `timeout-minutes: 20`): `actions/checkout` (latest major) → `actions/setup-node` (`node-version-file: .nvmrc`, `cache: npm`) → `npm ci` → `npm run lint` → `npm run format:check` → `npm run typecheck` → `npm test` → `npm run build`.
   - **Backend extra:** `actions/cache` for `~/.cache/mongodb-binaries` (key: `mongodb-${{ runner.os }}-8.2.12`) before tests; step `npm run openapi:check`.
   - Job `secrets-scan`: `gitleaks/gitleaks-action@v2` (`fetch-depth: 0`; personal repo → no license needed; `GITHUB_TOKEN` env). Repo root me `.gitleaks.toml` (default rules extend + allowlist for `.env.example` placeholders `change-me`).
   - Job `audit` (non-blocking): `npm audit --audit-level=high` with `continue-on-error: true`.
   - Job `commitlint` (sirf `pull_request`): checkout `fetch-depth: 0` → `npm ci` → `npx commitlint --from ${{ github.event.pull_request.base.sha }} --to ${{ github.event.pull_request.head.sha }} --verbose`.
   - Har action ka **latest major version** use karo (docs/README se check karo), comments me likho.
2. **`.github/dependabot.yml`** (dono): `npm` weekly (Monday, `Asia/Kolkata`), groups: `dev-dependencies` (minor+patch) + `production-dependencies` (minor+patch); **ignore** `typescript` semver-major/minor-above-6.0 (comment: typescript-eslint support) aur `eslint` / `@eslint/js` major (comment: plugin peer compat); `github-actions` weekly; `open-pull-requests-limit: 5`; commit-message prefix `chore(deps)`.
3. **Local workflow validation:** `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest -color` (dono repos) → 0 errors. Docker band ho to `open -a Docker` karke wait.
4. **`docs/setup/github-settings.md`** (backend): user ke liye manual steps — push commands, branch protection `main` + `dev` (require PR, require status checks `verify` + `secrets-scan` (+ `commitlint`), require linear history, no force push, no deletions), enable Dependabot alerts + secret scanning + push protection, default branch `main`. Settings URLs ke saath.
5. READMEs me CI badge placeholder + "CI" section (kya-kya chalta hai, local pe same commands).
6. ⚠️ Workflows GitHub pe tabhi chalenge jab user push karega — report me likho; locally actionlint + same npm commands green hon.

**Commits:** `ci: add github actions, gitleaks, dependabot [P0-T0.14]` (dono repos).

**VERIFY:** actionlint clean · `.gitleaks.toml` valid — `docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:latest detect --source /repo --no-banner --redact` (dono repos, git history pe) → **no leaks** · dono repos full verify.

## P0-B2-DONE

- Dono repos full verify (lint, format:check, typecheck, test, build) + backend `openapi:check`.
- `PHASE_0_TASKS.md` me T0.11–T0.14 `[x]`; `CHANGELOG.md` `[Unreleased]` me Batch 2 entry.
- Commit backend `docs: mark phase 0 batch 2 complete [P0-B2-DONE]`.

---

# ═══════════ BATCH 3 — Voice AI PoC, SIP Lab, Cost Model ═══════════

**Batch 3 prerequisites (shuru me check karo):**

- `cell-ai-voicebot-backend/.env` me `OPENAI_API_KEY` set hai? (value print mat karo — sirf `[ -n "$KEY" ]` type check.)
  - **Set nahi hai →** T0.15 ka **saara code + offline tests** banao, live runs skip, results doc me "⏳ pending — OpenAI key required" + report me blocker. T0.17 me AI cost "pending PoC" placeholder ke saath banao.
- Docker Desktop running (T0.16).

## T0.15 — Voice AI PoC ⭐ (BACKEND `poc/voice-ai/`) → commit(s)

**Goal:** Measure karo ki OpenAI Realtime Hindi / English / Hinglish loan-recovery call me kitna achha, kitna fast, kitna mehenga hai — **automated scenario runner** se (Claude mic me nahi bol sakta, isliye customer ki awaaz TTS se banegi) + ek **browser mode** jisme user khud baat karke test kare.

### Step 0 — Facts verify (is run me, official docs se)

- OpenAI Realtime ka **current GA model name**, WebSocket URL, session config shape (audio input/output formats — PCM 24 kHz aur G.711 μ-law naam kya hain), turn detection (server VAD) params, input transcription config, function calling events, `response.done` usage fields, interruption/truncate events.
- **Pricing**: realtime model audio in/out + text tokens; TTS model price; transcription model price. Source URLs + "checked on <date>" `docs/poc/voice-ai-poc-results.md` me.
- Event names code me ek `events.ts` constants file me rakho (docs ke hisaab se).

### Step 1 — Project setup (`poc/voice-ai/`)

- `package.json` (private, `"type": "module"`, engines node 24), deps: `ws`; devDeps: `typescript@~6.0.3`, `tsx`, `@types/ws`, `@types/node@24`. `tsconfig.json` strict. Scripts: `typecheck`, `test` (`node --test` via tsx), `serve` (browser mode), `run` (scenario runner), `tts-check`, `report`.
- `README.md` — kya hai, kaise chalana, env vars, output kahan, cost cap.
- Env: `../../.env` se `OPENAI_API_KEY` (chhota loader — dotenv dependency nahi chahiye to `node --env-file=../../.env`), `OPENAI_REALTIME_MODEL` (default = docs se verified GA model), `POC_MAX_USD` (default 10), `POC_PORT` (default 5199).
- `npm approve-scripts --allow-scripts-pending` review; lockfile commit.
- `poc/voice-ai/output/` gitignored (root `.gitignore` me `poc/**/output/` already hai — verify).

### Step 2 — Audio utils (`src/audio.ts`) + tests

- PCM16 ↔ Float32, **resample** (24k ↔ 8k ↔ 16k, linear/windowed-sinc — quality note), **G.711 μ-law encode/decode**, **noise mixing** (white/pink noise at given SNR dB), **silence generator**, **WAV writer/reader** (PCM16 + μ-law), chunker (20 ms frames).
- Tests (`node:test`): μ-law roundtrip error bound, resample length correctness, WAV header correctness, chunk sizes (24k → 960 bytes / 20 ms).

### Step 3 — Realtime client (`src/realtime-client.ts`)

- WebSocket connect (auth header), `session.update` builder with: instructions, voice, input/output audio format (`pcm24k` | `g711_ulaw` mode), server VAD (threshold, prefix padding, silence duration — configurable), input transcription on, tools.
- Event log: har event `{ t: performance.now(), type, … }` → `events.jsonl` (audio payloads **log mat karo** — sirf byte counts).
- Helpers: `appendAudio(chunk)`, `commit()`, `waitFor(type, predicate, timeout)`, collect bot audio deltas → buffer, transcripts (bot + customer), function calls, `response.done` usage.
- Function call handling: `check_payment_status({ customerId })` → `src/mock-tools.ts` (scenario decide kare `paid` / `not_paid` / `partial`), result wapas bhejo, response continue.
- Cost meter: usage → USD (pricing table from Step 0, `src/pricing.ts` with source + date comment) → running total; **`POC_MAX_USD` cross → abort run** cleanly.

### Step 4 — Persona prompt (`src/persona.ts`)

- Loan recovery agent persona: polite, respectful, short sentences, **customer jis language me bole usi me jawab** (Hindi / English / Hinglish), tone match (gussa → calm + empathetic), no threats / no abusive language (RBI-style), identity disclose ("main <Company> ki taraf se AI assistant bol rahi hoon"), payment claim pe `check_payment_status` call, callback request pe date/time poochhe, off-topic pe politely wapas laaye.
- Variables injected: `{{name}}` (Lalit Bansal), `{{amount}}` (₹5,500), `{{days}}` (120), `{{company}}` (placeholder "Demo Finance"), `{{customerId}}`.
- Opening line Hindi: "Namaste {{name}} ji, main {{company}} ki taraf se bol rahi hoon. Aapka ₹{{amount}} ka loan {{days}} din se pending hai…"

### Step 5 — Customer voice (TTS) (`src/tts.ts`)

- OpenAI TTS (docs se verified current model) → customer utterances PCM (2 voices alternate karo), resample to session format; cache by hash in `output/tts-cache/` (dobara paisa na lage).

### Step 6 — Scenarios (`src/scenarios.ts`) — 14 (PHASE_0_PLAN T0.15 table)

| #   | Scenario                    | Automated steps                                   | Auto checks                                                                     |
| --- | --------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1   | Hindi greeting + reminder   | session start → bot opening                       | bot transcript me naam, "5,500"/"paanch hazaar paanch sau", "120"/"ek sau bees" |
| 2   | Customer English reply      | EN utterance                                      | bot reply Latin-script English (heuristic: ASCII ratio + no Devanagari)         |
| 3   | Language switch mid-call    | HI → EN → HI turns                                | har bot reply ki language last customer turn se match                           |
| 4   | Hinglish                    | "maine kal pay kar diya tha"                      | function call hua / relevant reply                                              |
| 5   | "Maine pay kar diya" → tool | HI claim, mock = `paid` / `not_paid` (2 sub-runs) | `check_payment_status` called with customerId; reply result ke consistent       |
| 6   | Angry customer              | loud/angry text ("bar bar call kyun karte ho!")   | reply me apology/calm words, no threat words (blocklist)                        |
| 7   | Barge-in                    | bot bolte waqt 1.5s baad customer audio           | interruption event/truncate hua; bot audio ruka                                 |
| 8   | 10 s silence                | silence frames                                    | bot re-prompt ("hello / kya aap sun rahe hain") within ~12s                     |
| 9   | Background noise            | utterance + noise at 5 dB SNR                     | correct transcription/relevant reply; no false turn on pure noise segment       |
| 10  | Numbers/dates/amounts       | customer: "main 15 tareekh tak 2,750 de dunga"    | bot repeats correctly in transcript                                             |
| 11  | Indian names                | names: Bansal, Chaudhary, Iyer, Venkataraman      | human listening (auto: transcript spelling)                                     |
| 12  | Off-topic / abusive         | off-topic question + abusive line                 | politely redirect, no abusive reply                                             |
| 13  | "Baad me call karo"         | callback request                                  | bot asks date/time                                                              |
| 14  | Long call (5+ min)          | ~12 turns loop (mixed)                            | context retained (bot refers earlier amount/date); cost/min                     |

- Har scenario **2 audio modes**: `pcm24k` aur `g711_ulaw` (phone-like). Total runs ≈ 30. Pehle scenario 1 ko 3 voices pe (voice compare) chalao.
- Run order sasta → mehenga; scenario 14 last; budget cap har run se pehle check.

### Step 7 — Runner (`src/runner.ts`)

- CLI: `npm run run -- --scenarios all|1,2,5 --modes pcm24k,g711_ulaw --voice <v> [--resume <runId>]`.
- Per scenario output `output/<runId>/<scenario>-<mode>/`: `customer.wav`, `bot.wav`, `conversation.wav` (dono mix, timeline aligned), `events.jsonl`, `transcript.md`, `summary.json` (latencies per turn, transcripts, function calls, usage, costUsd, auto-check results).
- **Latency definition:** customer audio ka last non-silent frame bhejne ka time → bot ka pehla audio delta (ms); saath me server `speech_stopped` → first delta bhi record. Per turn + p50/p95.
- Realtime pacing: audio real-time speed pe bhejo (20 ms frames, 20 ms interval) — warna VAD/latency galat.

### Step 8 — Browser mode (`src/server.ts` + `public/`)

- `npm run serve` → `http://localhost:5199` — page: Start/Stop, mode select (pcm24k / g711 simulate), variables inputs, live transcript (customer/bot), per-turn latency, running cost.
- Browser mic → AudioWorklet → PCM16 24k (g711 mode me server side 8k μ-law convert) → WS → server relay → OpenAI; bot audio → browser playback; barge-in pe playback clear.
- Key sirf server side (browser me kabhi nahi).
- User ke liye: ye manual test hai — report me "kaise test karein" steps.

### Step 9 — Fixed TTS check (`src/tts-check.ts`) — `speak` nodes ke liye

- 6 sentences (Hindi, English, Hinglish; amounts ₹5,500 / ₹12,75,000, dates "15 October", phone numbers) × 2–3 voices → `output/tts-check/*.wav` + cost per 1k chars.

### Step 10 — Report (`src/report.ts`) → `docs/poc/voice-ai-poc-results.md`

- Sections: Setup (model, voices, date, sources) · Metrics table (scenario × mode: p50/p95 latency, function call ok, language ok, auto-checks, cost) · **Cost per minute** (avg, by mode) in USD + INR (FX rate source + date) · G.711 vs PCM quality notes · TTS check notes · **Human listening scorecard** (table user bharega: clarity, naturalness, Hindi pronunciation, numbers, tone — 1–5) + "kaise sunein" (wav paths) · Issues found · **Go / No-go recommendation** with thresholds: p50 ≤ 1.2 s, p95 ≤ 2.0 s, language match ≥ 90% turns, function-call scenarios 100% pass, barge-in works; cost/min reported (decision user ke saath T0.17 me).
- Output WAVs/JSONL **commit nahi** (gitignored) — doc me sirf numbers + paths.
- **ADR 0021 update:** thresholds pass → `accepted` (OpenAI Realtime, model name, audio mode recommendation); fail → `proposed` + kya fail hua + next option (STT→LLM→TTS). Optional Option B check sirf agar `SARVAM_API_KEY` (ya similar) `.env` me ho — warna doc me "not run".

**Commits:** `feat(poc): add voice ai realtime poc tooling [P0-T0.15]` (code) · `docs(poc): add voice ai poc results [P0-T0.15]` (results + ADR).

**VERIFY:** `cd poc/voice-ai && npm run typecheck && npm test` pass · (key ho to) runs complete, spend ≤ cap · `git status` me koi wav/jsonl/key nahi · backend root lint/typecheck still pass (poc excluded).

---

## T0.16 — SIP local lab (BACKEND `poc/sip-lab/`) → commit — timebox ~1 din

**Goal:** Bina client ke, local Docker me **SIP call → Asterisk → Node (ARI) → audio stream + DTMF** chain prove karna. Automated caller = **SIPp** (koi human/softphone zaroori nahi).

1. **Image choice (verify tags is run me):** Asterisk 20/22 LTS image (e.g. `andrius/asterisk` — tag exist karta hai ya nahi check; na mile to `debian:bookworm-slim` + `apt-get install asterisk` wala chhota Dockerfile). SIPp image (verify; na mile to alpine/debian + `sipp` package Dockerfile).
2. **`poc/sip-lab/docker-compose.yml`** — project name `cav-sip-lab`; services `asterisk`, `sipp` (profile/one-shot); private network; ports sirf `127.0.0.1` pe: ARI HTTP `8088`, SIP UDP `5060` (softphone optional), RTP UDP range `10000-10050`.
3. **Asterisk config** (`poc/sip-lab/asterisk/`): `pjsip.conf` (UDP transport; endpoint `sipp` IP-match from docker subnet, no auth; endpoint `softphone` with password **`.env.lab` se**, gitignored — `.env.lab.example` committed), `extensions.conf` (`exten 100 → Answer → Stasis(cav-lab)`), `ari.conf` (user/password `.env.lab` se), `http.conf` (enabled, bind 0.0.0.0:8088), `rtp.conf` (10000–10050), `modules.conf` minimal. Lab-only credentials, real secrets nahi.
4. **Node ARI app** (`poc/sip-lab/app/`, own package.json, deps `ws`): REST (fetch) + events WebSocket (`/ari/events?app=cav-lab`):
   - `StasisStart` → answer → play `sound:hello-world` → create **ExternalMedia** channel (`external_host=host.docker.internal:40000`, `format=ulaw`, direction both) → mixing bridge (caller + external media).
   - UDP socket `:40000` → RTP packets count + μ-law decode (`poc/voice-ai/src/audio.ts` reuse/copy) → `output/<callId>/caller.wav`.
   - `ChannelDtmfReceived` → log digit.
   - 15 s baad hangup; summary JSON: rtpPackets, seconds of audio, dtmf digits, events timeline.
   - (Bonus) received audio echo back via RTP → proves bidirectional path.
5. **SIPp scenario** (`poc/sip-lab/sipp/uac-pcap-dtmf.xml`): INVITE to `100@asterisk` → 200/ACK → play RTP pcap (SIPp bundled `g711a.pcap`/`g711u` sample) → send RFC 2833 DTMF pcap (bundled `dtmf_2833_1.pcap`) → BYE. Codec ulaw/alaw Asterisk config se match.
6. **Run script** `npm run lab` (or `./run-lab.sh`): `docker compose up -d asterisk` → wait ARI ready → start Node app → run SIPp once → collect summary → `docker compose down` (sirf `cav-sip-lab`).
7. **(Bonus, optional)** T0.15 realtime client ko ExternalMedia stream se jodo: SIP caller audio → AI → reply audio back. Time bache to.
8. **Manual softphone guide** (Zoiper/Linphone → `127.0.0.1:5060`, user `softphone`) — README me; Mac + Docker NAT/RTP issues ka note; issue ho to Linux VM (UTM/Multipass) suggest.
9. **`docs/poc/sip-lab-notes.md`:** kya chala (with numbers), images/versions, problems + fixes, **Asterisk (ARI + ExternalMedia) vs FreeSWITCH (ESL + mod_audio_stream)** comparison table (Node integration, docs, concurrency, licensing, ops), **Phase 13 checklist** (trunk registration/IP auth, NAT `external_media_address`/`external_signaling_address`, codecs, RTP range + security group, DTMF mode, transfer via REFER, concurrency, monitoring), aur ADR 0022 ke liye recommendation (status `deferred` rahe + recommendation note, ya `proposed`).
10. Fail/timebox hit → jitna hua + exact blocker notes (wahi bhi valid output).

**Commit:** `feat(poc): add local sip lab with asterisk ari and sipp [P0-T0.16]` (+ notes + ADR 0022 note).

**VERIFY:** `npm run lab` end-to-end ek baar: summary me `rtpPackets > 0` aur DTMF digit received (ya documented blocker) · lab containers band · `docker ps` me doosre containers untouched · koi lab password commit nahi.

---

## T0.17 — Cost model draft (BACKEND `docs/cost/cost-model.md`) → commit

1. **Inputs table** (har row: value, unit, source, date, confidence):
   - AI realtime cost per minute — T0.15 measured (avg + p90; pcm vs g711) — key nahi tha to "pending" + docs pricing se estimate (clearly labelled estimate).
   - TTS cost per 1k chars — T0.15 tts-check / pricing page.
   - Telephony per minute + pulse — **client pending** → placeholder range ₹0.30–₹1.00/min **(assumption, confirm with client)** + pulse 15/30/60 s effect.
   - Recording storage — μ-law 8 kHz mono = 64 kbps ≈ 0.48 MB/min; S3 `ap-south-1` price per GB-month (official pricing, date); retention 90 days assumption.
   - Server cost share — placeholder (client ka server; ₹0 direct) + note.
   - FX USD→INR (source + date).
   - Platform margin % scenarios (30 / 50 / 100%); GST 18% on top-ups (note: tax on platform service — CA se confirm).
2. **Formulas** (explicit): billable minutes with pulse rounding `ceil(sec / pulse) × pulse / 60`; cost per answered minute per call type: (a) IVR-only (TTS + DTMF), (b) AI agent full call, (c) mixed (30 s TTS + AI rest).
3. **Outputs:** cost/min per type · suggested selling rate per margin · **100-contact loan recovery campaign example** (assumptions: 50% answer, avg 1.5 min answered, unanswered ring cost per pulse rules, 2 retries on no-answer) → total cost, selling price, profit.
4. **Sensitivity table:** avg call 3 min, AI price +50%, telephony 2×, answer rate 30% / 70%, pulse 60 s vs 15 s.
5. Optional `poc/cost-model/calc.ts` (own tiny package or plain `node` script, no deps) jo same numbers print kare — doc me numbers isi se aayein (consistency).
6. Clear "⏳ pending inputs" list: telephony rate (client), final AI numbers (if key missing), recording retention (legal).

**Commit:** `docs(cost): add per-minute cost model draft [P0-T0.17]`

## P0-B3-DONE

- PoC packages ke `typecheck` + `test` pass; backend + frontend full verify.
- `PHASE_0_TASKS.md` T0.15–T0.17 `[x]` (ya `⚠️ partial` + reason); CHANGELOG Batch 3 entry (actual OpenAI spend ke saath).
- Commit `docs: mark phase 0 batch 3 complete [P0-B3-DONE]`.

---

# ═══════════ BATCH 4 — Compliance, Server Audit, Sign-off, Phase 1 Plan ═══════════

## T0.18 — Compliance research notes (BACKEND `docs/compliance/compliance-notes.md`) → commit

**Top pe disclaimer:** "Research notes, legal advice nahi — client / unke legal team se confirm karna zaroori."

Har topic: **rule summary · source link (official: trai.gov.in, rbi.org.in, meity.gov.in / egazette) · checked-on date · product impact · confidence (high/medium/low)**. Is run me sources fetch karke verify karo; jo verify na ho "unverified" mark karo.

1. **TRAI — commercial communications:** TCCCPR 2018 + latest amendments (2024–2025 changes check karo): promotional vs service/transactional calls, DND / NCPR preferences, DLT registration (principal entity, headers, consent templates), number series (promotional vs service/transactional — current rules verify), allowed calling hours for promotional calls (verify), penalties.
2. **RBI — recovery practices:** recovery agents / outsourcing guidelines + Fair Practices Code: calling time window (verify exact hours, e.g. 8 am–7 pm), no harassment/intimidation, identity disclosure, privacy (no calls to family/friends about debt), applicability to NBFCs / digital lending (Digital Lending guidelines — recovery agent disclosure to borrower).
3. **DPDP Act 2023 + DPDP Rules (verify notified status/dates):** client = Data Fiduciary, hum = Data Processor; consent / legitimate use for debt recovery, purpose limitation, security safeguards, breach notification, retention & erasure, data principal rights, cross-border transfer note (OpenAI US processing!).
4. **Call recording:** disclosure/consent best practice (India), retention.
5. **AI disclosure:** call start pe "automated/AI call" batana — current Indian requirement hai ya best practice (verify); recommend default ON.
6. **Product feature list → phase mapping** (table): calling window enforcement (account default + campaign override, hard block outside window → `CALL_OUTSIDE_WINDOW`), DND/opt-out (keyword + DTMF "9 dabaiye" → `dndEntries`), consent record field on contact (source, timestamp), disclosure node + recording notice node (Phase 6), per-contact daily/weekly call caps, PII encryption + masking, retention jobs + delete-on-request (Phase 11), DPA template with client, audit logs, sub-processor list (OpenAI, AWS…), breach runbook.
7. **Questions for client legal** (numbered list).
8. Update `docs/compliance/README.md` (placeholder hatao → link), `docs/client/answers.md` me compliance questions section add.

**Commit:** `docs(compliance): add telecom, rbi and dpdp research notes [P0-T0.18]`

---

## T0.19 — Client server access check (STRICT READ-ONLY) 🔒 → commit

**Prerequisite:** SSH key path — `cell-ai-voicebot-backend/.env` me `CLIENT_SSH_KEY_PATH=/absolute/path/to/key.pem` (path secret nahi, par `.env` me hi rakho) **ya** default `~/.ssh/cell-voicebot-client.pem`. Key file permission check karo (`400` ya `600` hona chahiye). User ki key file pe khud `chmod` **mat** karo — agar permissions zyada open hon ya ssh "UNPROTECTED PRIVATE KEY" error de, to T0.19 ko `⚠️ blocked` mark karo aur report me exact fix command (`chmod 400 <path>`) do.

**Key nahi mili →** sirf script + template banao (neeche), T0.19 = `⚠️ blocked`, report me "key path set karke `npm run server:audit` chalao".

1. **`scripts/server-audit.sh`** (committed, **read-only allowlist only**, no `sudo`, no writes on server, `set -u`, har command `|| echo "n/a"`):
   ```
   whoami; hostname
   uname -srm                      # KERNEL — MongoDB 8.0 vs 8.2 decision
   cat /etc/os-release | grep -E '^(NAME|VERSION)='
   nproc; free -h; df -h --output=source,size,used,avail,pcent,target -x tmpfs -x devtmpfs
   uptime
   command -v node && node -v; command -v npm && npm -v
   command -v docker && docker --version
   docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}' 2>&1 | head -50   # permission denied bhi note
   command -v pm2 && pm2 jlist 2>/dev/null | node -e "…only name,status,pm_exec_path basename…" (ya `pm2 ls` names only)
   ss -tuln                         # listening ports (no process names — sudo nahi)
   systemctl list-units --type=service --state=running --no-pager --plain | head -80
   command -v nginx && nginx -v; ls /etc/nginx/sites-enabled 2>/dev/null
   command -v apache2 && apache2 -v
   command -v mongod && mongod --version | head -1; command -v mysqld && mysqld --version; command -v psql && psql --version
   ps -eo comm,rss --sort=-rss | head -15   # process names only (no args — args me secrets ho sakte hain)
   command -v asterisk; command -v freeswitch
   ```
   **Explicitly forbidden** (script me comment block): `sudo`, `env`, `printenv`, `cat` of any config/.env/log, `history`, `ps aux` with args, `docker inspect`, `docker exec`, `pm2 env`, `nginx -T`, kisi bhi file me write.
2. Script ko run karne ka wrapper: `npm run server:audit` → `ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new ubuntu@13.232.191.62 'bash -s' < scripts/server-audit.sh > <scratchpad>/server-audit-raw.txt` (raw output **commit nahi**, scratchpad me). `accept-new` local `~/.ssh/known_hosts` me host key add karega — report me note.
3. **`docs/client/server-audit.md`** (committed, **no secrets, no other app's data**): date, OS + **kernel** (→ MongoDB 8.2 needed? kernel ≥ 6.19 → 8.0 nahi chalega), CPU/RAM/disk free, runtimes present, Docker usable by `ubuntu`?, PM2 present?, **ports in use** (list) → **proposed free ports for our app** (API, web, Mongo, Redis, media server SIP/RTP — clash-free), web server (nginx/apache) presence, DB engines present (→ answers.md #5 context), SIP software present?, firewall: "sudo ke bina check nahi — client se poochho / AWS security group", **risks + recommendations for Phase 12** (Docker Compose vs PM2 → ADR 0025 input).
4. `docs/client/answers.md` #4 ko audit findings se update (status `partially answered`).
5. ADR 0025 Context me audit findings + recommendation (status `proposed`).

**Commit:** `docs(client): add read-only server audit [P0-T0.19]` (script + doc + ADR/answers updates).

**VERIFY:** script me forbidden commands nahi (`grep -nE "sudo|printenv|docker exec|docker inspect|nginx -T|history" scripts/server-audit.sh` → sirf comment lines) · committed doc me koi password/key/token nahi · raw output repo me nahi.

---

## T0.20 — Phase 0 review, sign-off & plan update → commits + P0-DONE

1. **Done-when check:** `PHASE_0_PLAN.md` ke T0.1–T0.20 har "Done when" ke against status (✅ / ⚠️ partial / ❌ blocked + reason) → `docs/phases/PHASE_0_SIGNOFF.md` (sign-off checklist = PHASE_0_PLAN section 3 deliverables, har item status + evidence link/commit).
2. **Fresh-clone test** (dono repos, scratchpad me, feature branch): `npm ci → lint → format:check → typecheck → test → build` (+ backend `openapi:check`; frontend `gen:api` with `OPENAPI_SPEC` pointing to the cloned backend) → pass → temp delete.
3. **ADRs final:** 0021 (PoC result se), 0022 (SIP lab recommendation), 0025 (audit se), 0029 (accepted), 0011 (Mantis — abhi bhi user confirmation pending ho to `proposed` rahe), index update.
4. **`BUILD_PLAN.md` update:** final decisions (Node 24, Mongo 8.2, TS 6 / ESLint 9 pins, voice AI result, ports, OpenAPI types, WS ticket auth, Phase 1 readiness) + changelog line.
5. **`PHASE_0_PLAN.md` section 4 risks update:** add — MongoDB kernel issue (mitigated by 8.2), npm 11 `allowScripts` (review on every dep add), TS/ESLint version pins (Dependabot ignores), PoC findings risks, server audit risks; har risk ka status.
6. `docs/client/answers.md` latest; `docs/conventions/secrets.md` rotation checklist still open items.
7. `PHASE_0_TASKS.md` saare tasks final status; `CHANGELOG.md` → `[Unreleased]` me Phase 0 complete summary (release `v0.0.1` user merge ke baad tag karega).
8. **Phase 1 detailed plan** → `docs/phases/PHASE_1_PLAN.md` — PHASE_0_PLAN jaisi structure: goal · scope-out table · tasks overview table (T1.x, size, depends) · har task step-by-step (Kyun / Steps checkboxes / Output / Done when) · deliverables checklist · risks · day-wise order. Content source: BUILD_PLAN Phase 1 bullets + ADRs (0002–0009, 0023, 0024, 0027, 0029) + conventions (api, websocket, data, code-style, error-codes) + secrets.md (zod env schema). Minimum tasks: env config (zod) · Express 5 app + server bootstrap/graceful shutdown · pino logger + request ID · error handling (AppError + error codes file + envelope) · validation middleware (zod) · security middlewares (helmet, CORS allowlist, rate limit, body limits) · MongoDB connection + index sync + migrations runner · Redis + BullMQ bootstrap · WebSocket server (`/ws/events` with ticket auth stub, rooms, ping/pong) · health/readiness endpoints + `GET /api/v1/system/info` (OpenAPI se) · idempotency middleware · StorageProvider (local + S3) · email service (SMTP) · OpenAPI served at `/api/v1/openapi.json` + Swagger UI (dev) · frontend API client error normalisation + WS client hook · tests (Supertest integration) · README/docs updates. `docs/phases/PHASE_1_TASKS.md` tracker bhi.
9. `docs/README.md` index me naye files.

**Commits:** `docs: phase 0 sign-off and plan updates [P0-T0.20]` · `docs(plans): add phase 1 detailed plan [P0-T0.20]` · final `docs: mark phase 0 complete [P0-DONE]` (dono repos me jahan kuch badla).

---

## FINAL REPORT (chat me, Hinglish, is format me)

1. **Summary** — T0.11–T0.20 har task: ✅ / ⚠️ / ❌ + 1 line.
2. **Commits** — dono repos `git log --oneline` (is run ke).
3. **Key results** — PoC: latency p50/p95, cost/min (₹), language/function-call pass rate, Go/No-go; SIP lab: rtp/dtmf result; cost model headline numbers; server audit headline (kernel, free ports, Docker/PM2); compliance top 5 product impacts.
4. **Deviations** — prompt/plan se kya alag aur kyun.
5. **Verification** — har VERIFY pass/fail.
6. **OpenAI spend** (actual USD).
7. **Manual steps for user** — push (dono repos: `git push -u origin main dev feature/phase-0-setup`), GitHub settings (`docs/setup/github-settings.md`), PoC browser test + human listening scorecard bharna, softphone test (optional), Mantis license, secrets rotation, client legal questions bhejna, client se pending answers, merge `feature → dev → main` + tag `v0.0.1`.
8. **Blockers / open items** + Phase 1 shuru karne ke liye kya ready hai.

---

## MUST-NOT-MISS CHECKLIST

- [ ] Saara kaam `feature/phase-0-setup` pe; har task ka commit `[P0-T0.x]`; hooks pass (no `--no-verify`); no push/merge/tag
- [ ] T0.11: 5 convention docs (api, websocket, data, code-style, error-codes) + index + README links (dono repos)
- [ ] Enum values lower_snake_case, field names camelCase, `accountId` kabhi request se nahi — docs me clearly
- [ ] WS auth = single-use ticket (JWT URL me nahi)
- [ ] T0.12: OpenAPI deterministic (`openapi:check` pass), frontend generated types committed + typecheck, ADR 0029
- [ ] T0.13: Mermaid ERD + saare entities (table wale) + indexes + PII + embedded-vs-separate + open questions
- [ ] T0.14: ci.yml dono repos (Node from `.nvmrc`, mongodb binary cache, openapi:check backend), gitleaks + `.gitleaks.toml`, dependabot with TS/ESLint pins ignored, actionlint clean, github-settings.md
- [ ] T0.15: facts (model, events, pricing) docs se verify + source/date; spend cap enforced; 14 scenarios × 2 modes; latency definition consistent; audio/JSONL/key commit nahi; ADR 0021 updated; key missing → code + offline tests + pending
- [ ] T0.16: SIPp automated call; ExternalMedia RTP received; DTMF; `cav-sip-lab` only; lab creds `.env.lab` gitignored; notes + Phase 13 checklist + ADR 0022 note
- [ ] T0.17: formulas explicit, assumptions labelled, pending inputs list, 100-contact example, sensitivity table
- [ ] T0.18: official sources + dates + confidence; disclaimer; feature→phase mapping; questions for client legal
- [ ] T0.19: read-only allowlist script; no sudo/env/config reads; raw output repo me nahi; kernel + ports + proposed free ports; answers #4 + ADR 0025 updated; key missing → blocked + script ready
- [ ] T0.20: sign-off doc, fresh-clone (both repos + gen:api against cloned backend), ADRs final, BUILD_PLAN + risks updated, PHASE_1_PLAN + PHASE_1_TASKS, CHANGELOG, index
- [ ] Secrets grep (both repos): `grep -rnE "sk-[A-Za-z0-9_-]{20,}|nn_[0-9a-f]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----" --exclude-dir=node_modules --exclude-dir=.git .` → 0 matches; gitleaks clean
- [ ] Supabase / doosre containers untouched; client server pe zero changes
