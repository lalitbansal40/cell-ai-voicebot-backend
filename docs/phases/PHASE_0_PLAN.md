# Phase 0 — Setup & Architecture Decisions (Detailed Plan)

**Project:** Cell AI Voicebot · **Phase:** 0 of 15 · **Status:** 🟢 Client ke jawab ke bina ho sakta hai
**Parent plan:** [`../plans/BUILD_PLAN.md`](../plans/BUILD_PLAN.md)

---

## 0. Is phase ka goal

Phase 0 ke end tak:

1. Dono repos (backend + frontend) **professional tooling ke saath ready** hon — lint, format, typecheck, test, CI, git rules.
2. Local machine pe **MongoDB + Redis** ek command se chalein.
3. Saare **bade technical decisions likhe hue** hon (ADR) — taaki aage kisi phase mein "ye kaise karein" pe ruka na pade.
4. **Voice AI PoC** se pata ho ki Hindi / English / Hinglish mein AI kitna achha, kitna fast aur kitna mehenga hai.
5. **Cost model** ka pehla draft ho — per minute kitna kharcha, client ko kitna charge.
6. Phase 1 seedha shuru ho sake, bina kisi confusion ke.

### Phase 0 mein kya NAHI hoga (scope se bahar)

| Kaam                                                   | Kaunse phase mein |
| ------------------------------------------------------ | ----------------- |
| Express app, logger, error handler, DB connection code | Phase 1           |
| Login / signup / users                                 | Phase 2           |
| Koi bhi business feature (contacts, wallet, flows…)    | Phase 3+          |
| Client ke server pe kuch install / deploy              | Phase 12          |
| Real SIP trunk se call                                 | Phase 13          |

Phase 0 mein sirf **hello-world level** code hoga, sirf ye prove karne ke liye ki tooling kaam kar raha hai.

---

## 1. Tasks ka overview

| #     | Task                                            | Size | Depends on        |
| ----- | ----------------------------------------------- | ---- | ----------------- |
| T0.1  | Machine prerequisites & accounts                | S    | –                 |
| T0.2  | Git & repo hygiene (dono repos)                 | S    | T0.1              |
| T0.3  | Docs folder ka ghar + project management setup  | S    | T0.2              |
| T0.4  | Architecture Decision Records (ADRs)            | M    | T0.3              |
| T0.5  | Backend scaffold (TypeScript project)           | M    | T0.4              |
| T0.6  | Frontend scaffold (Vite + React + TS)           | M    | T0.4              |
| T0.7  | Code quality tooling (ESLint, Prettier, Husky…) | S    | T0.5, T0.6        |
| T0.8  | Testing setup (dono repos)                      | S    | T0.5, T0.6        |
| T0.9  | Local infra: Docker Compose (MongoDB + Redis)   | S    | T0.5              |
| T0.10 | Env & secrets conventions                       | S    | T0.5, T0.6        |
| T0.11 | API, WebSocket & data conventions doc           | M    | T0.4              |
| T0.12 | Shared types strategy + proof                   | S    | T0.5, T0.6, T0.11 |
| T0.13 | Core data model draft (ERD)                     | M    | T0.11             |
| T0.14 | CI pipeline (GitHub Actions)                    | S    | T0.7, T0.8        |
| T0.15 | **Voice AI PoC**                                | L    | T0.1              |
| T0.16 | SIP local lab (optional, recommended)           | M    | T0.1              |
| T0.17 | Cost model draft                                | S    | T0.15             |
| T0.18 | Compliance research notes                       | S    | –                 |
| T0.19 | Client server access check (read-only)          | S    | Key file          |
| T0.20 | Phase 0 review, sign-off & plan update          | S    | Sab               |

**Size:** S = chhota (kuch ghante) · M = medium (~1 din) · L = bada (2–3 din, timeboxed)

**Parallel chal sakte hain:** T0.15 (PoC), T0.16 (SIP lab), T0.18 (compliance) baaki setup ke saath parallel.

---

## 2. Tasks — step by step

---

### T0.1 — Machine prerequisites & accounts

**Kyun:** Sabka setup ek jaisa ho, "mere machine pe chal raha hai" wali problem na aaye.

**Steps:**

- [ ] **Node 24 LTS** install (direct installer, ya `nvm`/`fnm`: `nvm install 24 && nvm use 24`); `node -v` se verify
- [ ] Package manager decide: **npm** (AutoChatix jaisa) — `npm -v` ≥ 10
- [ ] **Docker Desktop** install + chalu; `docker compose version` verify
- [ ] **Git** config: `user.name`, `user.email`, default branch `main`
- [ ] VS Code extensions: ESLint, Prettier, EditorConfig, DotENV, Docker, (optional) MongoDB for VS Code
- [ ] Tools: `curl`, `jq`, MongoDB Compass (DB dekhne ke liye), RedisInsight (optional)
- [ ] **GitHub access:** dono repos (`lalitbansal40/cell-ai-voicebot-backend`, `…-frontend`) pe push access confirm
- [ ] **OpenAI account:** API key with **Realtime model access**, billing on, usage limit set (PoC ke liye budget cap, jaise $20)
- [ ] Password manager decide (Bitwarden / 1Password / etc.) — SSH key, DB password, API keys yahin rakhenge
- [ ] Client ka **SSH key file** password manager / `~/.ssh/` mein, `chmod 400`

**Output:** Prerequisites checklist done.
**Done when:** `node -v` → 24.x, `docker compose version` chale, OpenAI key se ek test request pass ho.

---

### T0.2 — Git & repo hygiene (dono repos)

**Kyun:** Shuru se saaf git history, galti se secret commit na ho.

**Steps (har repo mein):**

- [ ] Branch strategy: `main` (production-ready) · `dev` (integration) · `feature/<phase>-<short-name>` · `fix/<name>` · `chore/<name>`
- [ ] Commit convention: **Conventional Commits** (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`)
- [ ] `.gitignore`: `node_modules/`, `dist/`, `build/`, `coverage/`, `.env`, `.env.*` (par `!.env.example`), `*.log`, `logs/`, `recordings/`, `uploads/`, `*.pem`, `*.key`, `.DS_Store`, `poc/**/output/`
- [ ] Backend ki **existing khaali `.env`** — confirm ki gitignored hai, kabhi commit na ho
- [ ] `.gitattributes`: `* text=auto eol=lf`
- [ ] `.editorconfig`: 2 spaces, LF, UTF-8, final newline
- [ ] `README.md` skeleton: project kya hai, prerequisites, setup, scripts, folder structure, env
- [ ] `package.json` mein `"private": true`, `"license": "UNLICENSED"`
- [ ] PR template (`.github/pull_request_template.md`): kya badla, kaise test kiya, screenshots, checklist
- [ ] Pehla commit `main` pe → `dev` branch banana → dono push
- [ ] GitHub pe **branch protection** `main` ke liye: PR required, CI pass required (CI T0.14 ke baad on karna)

**Output:** Dono repos mein first commit + `dev` branch.
**Done when:** `git status` clean, `.env` ignored (`git check-ignore .env` output de), GitHub pe dono branches dikhein.

---

### T0.3 — Docs ka ghar + project management setup

**Kyun:** Plans, decisions, PoC results ek versioned jagah pe hon; kaam track ho.

**Decision:** Parent folder `cell-ai-voicebot/` git repo nahi hai. **Docs backend repo ke `docs/` mein move honge** (versioned, PR se review).

**Steps:**

- [ ] Backend repo mein structure:
  ```
  docs/
    plans/       BUILD_PLAN.md, OVERVIEW_PLAN.md (v1, archived)
    phases/      PHASE_0_PLAN.md, PHASE_1_PLAN.md …
    adr/         0001-….md …
    poc/         voice-ai-poc-results.md, sip-lab-notes.md
    conventions/ api.md, websocket.md, data.md, code-style.md
    client/      CLIENT_QUESTIONS.md, answers.md
    cost/        cost-model.md
    compliance/  compliance-notes.md
  ```
- [ ] Existing docs (`BUILD_PLAN`, `OVERVIEW_PLAN`, `CLIENT_QUESTIONS`, ye plan) move karna
- [ ] Task tracking: **GitHub Projects** (board: Backlog / Todo / In Progress / Review / Done) ya ek `docs/phases/PHASE_X_TASKS.md` checklist — ek choose karna
- [ ] **Task prompt template** banana (Claude se task-wise kaam karwane ke liye):
  - Context (phase, task, related files)
  - Goal, scope, out-of-scope
  - Steps / acceptance criteria
  - Tests chahiye
  - Done ka checklist
- [ ] **Definition of Done** (har task ke liye common):
  - lint + typecheck + tests pass
  - naye env vars `.env.example` mein
  - README / docs update
  - PR review + `dev` mein merge
- [ ] `CHANGELOG.md` (har phase ke end mein entry)
- [ ] `docs/client/answers.md` — client ke jawab aate hi yahan likhna

**Done when:** Saare docs repo mein, task board ready, prompt template file bani hui.

---

### T0.4 — Architecture Decision Records (ADRs)

**Kyun:** Har bada decision ek baar likha jaye — kya chuna, kyun, kya options the. Baad mein koi confusion nahi.

**ADR template:** Title · Status (proposed/accepted) · Context · Options · Decision · Consequences

**ADRs likhne hain (recommendation ke saath):**

| #    | Decision                 | Recommendation                                                                                                               |
| ---- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| 0001 | Repo structure           | 2 alag repos (backend, frontend) — already bane hain                                                                         |
| 0002 | Backend language/runtime | Node 24 LTS + TypeScript (strict) + Express 5 (Node 20 April 2026 me EOL)                                                    |
| 0003 | Backend code structure   | **Module-based**: `src/modules/<feature>/` + shared `src/core`, `src/shared` (neeche T0.5)                                   |
| 0004 | Database                 | MongoDB 8.2 + Mongoose; **replica set** (wallet ke multi-document transactions ke liye zaroori)                              |
| 0005 | Queue / jobs             | Redis 7.4 + BullMQ                                                                                                           |
| 0006 | Validation               | zod (request validation + env + shared schemas)                                                                              |
| 0007 | Logging                  | pino (JSON logs), request ID                                                                                                 |
| 0008 | Real-time                | `ws` library — 2 endpoints: `/ws/events` (dashboard) aur `/ws/media` (web call audio)                                        |
| 0009 | Auth tokens              | Access token (JWT, short) + refresh token (httpOnly secure cookie, rotate)                                                   |
| 0010 | Frontend build           | **Vite** + React 19 + TypeScript (CRA deprecated hai)                                                                        |
| 0011 | UI kit                   | MUI latest stable; AutoChatix ka **Mantis template copy nahi** jab tak license confirm na ho (TS version paid/Pro lagta hai) |
| 0012 | Frontend state           | React Query (server state) + Zustand ya Context (chhota UI state); Redux nahi                                                |
| 0013 | Forms                    | react-hook-form + zod                                                                                                        |
| 0014 | Flow builder             | reactflow (`@xyflow/react`)                                                                                                  |
| 0015 | Naming case              | Code + API + Mongo fields **camelCase**; collections plural                                                                  |
| 0016 | Money                    | Integer micro-units (₹1 = 1,000,000), field suffix `Micros`, currency alag field                                             |
| 0017 | Dates / time             | DB mein UTC; account timezone (default `Asia/Kolkata`); library `date-fns` + `date-fns-tz` (ya dayjs)                        |
| 0018 | Phone numbers            | E.164 store; `libphonenumber-js` se parse/validate; default region IN                                                        |
| 0019 | Testing                  | Backend: Vitest + Supertest + mongodb-memory-server; Frontend: Vitest + React Testing Library; e2e: Playwright (baad mein)   |
| 0020 | Telephony abstraction    | `TelephonyProvider` interface; implementations: WebCall, SIP, NotifyNow (optional)                                           |
| 0021 | Voice AI                 | PoC (T0.15) ke baad final; default: OpenAI Realtime; `VoiceAiProvider` interface                                             |
| 0022 | Media server             | **Deferred** — Phase 13 PoC (Asterisk ARI vs FreeSWITCH); T0.16 lab notes input                                              |
| 0023 | File storage             | `StorageProvider` interface — local disk (dev) / S3 (prod)                                                                   |
| 0024 | API versioning           | `/api/v1/...`                                                                                                                |
| 0025 | Deployment style         | Docker Compose ya PM2 — Phase 12 mein final (client server audit ke baad)                                                    |

**Steps:**

- [ ] Template file `docs/adr/0000-template.md`
- [ ] Har ADR ki ek file, status `proposed`
- [ ] Review → `accepted`
- [ ] `docs/adr/README.md` mein index

**Done when:** Saare ADR `accepted` (0021, 0022, 0025 `proposed/deferred` reh sakte hain, reason ke saath).

---

### T0.5 — Backend scaffold

**Kyun:** Ek saaf TypeScript project jisme aage ke saare phases fit ho jayein.

**Steps:**

- [ ] `npm init` → `package.json`: name `cell-ai-voicebot-backend`, `private`, `engines: { node: ">=24 <25" }`
- [ ] `.nvmrc` → `24`
- [ ] Dependencies (sirf Phase 0 ke liye zaroori): `typescript`, `tsx` (dev run/watch), `@types/node`
- [ ] `tsconfig.json`:
  - `strict: true`, `noUncheckedIndexedAccess: true`, `noImplicitOverride: true`, `noFallthroughCasesInSwitch: true`
  - `target: ES2022`, `module/moduleResolution`: CommonJS ya NodeNext (ADR mein decide; recommendation **CommonJS** — Mongoose/BullMQ ke saath simple)
  - `outDir: dist`, `rootDir: src`, `sourceMap: true`, `esModuleInterop: true`, `resolveJsonModule: true`, `skipLibCheck: true`
  - Path aliases **nahi** (relative imports) — build simple rahega
- [ ] `tsconfig.build.json` (tests exclude)
- [ ] Folder structure (khaali folders + `README` / `.gitkeep`):
  ```
  src/
    index.ts            ← entry (Phase 0: sirf "hello" + version log)
    app.ts              ← Express app (Phase 1)
    config/             ← env schema, constants
    shared/             ← errors, logger, middlewares, utils, types
    core/
      engine/           ← flow engine (Phase 6)
      voice/            ← call session, audio bridge, voice AI (Phase 7)
      telephony/        ← provider interface + webcall/sip/notifynow (Phase 7, 13)
      queues/           ← BullMQ queues + workers (Phase 8)
      billing/          ← wallet core (Phase 4)
    modules/            ← feature modules (har ek: routes, controller, service, model, schema, types)
      auth/ accounts/ users/ contacts/ wallet/ ai-agents/ flows/ campaigns/ calls/ webhooks/ public-api/
    jobs/               ← cron jobs
    db/                 ← connection, indexes, seeds, migrations
  tests/                ← integration tests
  scripts/              ← one-off scripts
  poc/                  ← PoC code (main build mein nahi)
  ```
- [ ] Scripts:
  - `dev` → `tsx watch src/index.ts`
  - `build` → `tsc -p tsconfig.build.json`
  - `start` → `node dist/index.js`
  - `typecheck` → `tsc --noEmit`
  - `lint`, `lint:fix`, `format`, `format:check`, `test`, `test:watch`, `test:coverage`
  - `check` → typecheck + lint + test + build (sab ek saath)
  - `infra:up` / `infra:down` (T0.9)

**Done when:** `npm run dev` "hello" print kare, `npm run build && npm start` chale, `npm run typecheck` pass.

---

### T0.6 — Frontend scaffold

**Steps:**

- [ ] `npm create vite@latest` → React + TypeScript template
- [ ] `.nvmrc` → `24`, `package.json` private + engines
- [ ] Core deps: `react-router-dom`, `@tanstack/react-query`, `@mui/material` (+ `@emotion/*`, icons), `axios`, `zod`, `react-hook-form`, `notistack`
- [ ] `tsconfig` strict (same flags as backend)
- [ ] Vite config: path alias `@/` → `src/` (frontend mein alias theek hai, Vite handle karta hai), dev server port `3100`, proxy `/api` → `http://localhost:5100` (CORS issues se bachne ke liye)
- [ ] Folder structure:
  ```
  src/
    main.tsx  App.tsx
    app/          ← providers (Theme, QueryClient, Router, Snackbar, WS), routes
    pages/        ← route-level pages
    features/     ← feature folders (auth, contacts, wallet, flows, calls…) — components + hooks + api
    components/   ← shared UI components
    layout/       ← main layout, sidebar, header
    hooks/  services/api/  theme/  types/  utils/  assets/
  ```
- [ ] AutoChatix se theme / layout pieces reuse ki list banana (copy Phase 2 mein hoga) — **license check** pehle
- [ ] Env: `VITE_API_URL`, `VITE_WS_URL`, `VITE_APP_NAME` (`.env.example` mein)
- [ ] Hello page: MUI theme ke saath "Cell AI Voicebot" heading, React Query provider wired
- [ ] Scripts: `dev`, `build`, `preview`, `typecheck`, `lint`, `lint:fix`, `format`, `format:check`, `test`, `check`
- [ ] Favicon, app title, `index.html` meta

**Done when:** `npm run dev` pe page khule, `npm run build` pass, typecheck pass.

---

### T0.7 — Code quality tooling (dono repos)

**Steps:**

- [ ] **ESLint** (flat config `eslint.config.js`): `typescript-eslint` (type-aware), `eslint-plugin-import` (order, no-cycle), frontend mein `react-hooks` + `react-refresh`
- [ ] Rules: `no-console` (warn, logger use karo — backend), `@typescript-eslint/no-floating-promises` (error — async bugs pakadta hai), `no-explicit-any` (warn), unused vars error
- [ ] **Prettier** (`.prettierrc`): `singleQuote`, `semi`, `printWidth: 100`, `trailingComma: all`; `eslint-config-prettier` (conflict off)
- [ ] **Husky + lint-staged**: pre-commit pe staged files lint + format
- [ ] **commitlint** (optional): commit message convention enforce
- [ ] `.vscode/settings.json` (format on save, ESLint fix on save) + `.vscode/extensions.json` (recommended)
- [ ] Dono repos mein config same rakhna (consistency)

**Done when:** Galat formatted file commit karne pe auto-fix ho, `npm run lint` clean.

---

### T0.8 — Testing setup

**Steps:**

- [ ] Backend: **Vitest** + `supertest` (Phase 1 se use) + `mongodb-memory-server` (replica set mode) — config + ek sample unit test
- [ ] Frontend: Vitest + `@testing-library/react` + `jsdom` + `@testing-library/user-event` — ek sample component test
- [ ] Coverage config (`v8`), `coverage/` gitignored
- [ ] Test naming: `*.test.ts(x)`, unit tests file ke paas, integration tests `tests/` mein
- [ ] Note: e2e (Playwright) Phase 2 ke baad add hoga

**Done when:** `npm test` dono repos mein pass, coverage report bane.

---

### T0.9 — Local infra (Docker Compose)

**Steps:**

- [ ] Backend repo mein `docker-compose.yml`:
  - **MongoDB 8.2** — single-node **replica set** (`--replSet rs0` + init script), volume, healthcheck, port `127.0.0.1:27018`
  - **Redis 7.4** — `appendonly yes`, volume, healthcheck, port `127.0.0.1:6380`
  - (optional) mongo-express / RedisInsight — profile ke peeche
- [ ] Ports sirf `127.0.0.1` pe bind (bahar expose nahi)
- [ ] `npm run infra:up` / `infra:down` / `infra:reset` (volumes delete — warning ke saath)
- [ ] README mein connection strings
- [ ] Verify: Compass se connect, `rs.status()` OK, `redis-cli ping` → PONG
- [ ] ⚠️ Note: client ka DB kaunsa hai abhi pata nahi (Mongo / MySQL). Agar Mongo nahi hai to production mein hum apna Mongo chalayenge (Phase 12) — risk list mein add

**Done when:** Ek command se Mongo (replica set) + Redis up, dono healthy.

---

### T0.10 — Env & secrets conventions

**Steps:**

- [ ] Naming: UPPER_SNAKE_CASE; frontend vars `VITE_` prefix (ye **browser mein public** hote hain — secret kabhi nahi)
- [ ] Backend `.env.example` — saare known vars, comment ke saath ki kaunsa phase use karega:
  - App: `NODE_ENV`, `PORT`, `APP_URL`, `FRONTEND_URL`, `LOG_LEVEL`, `CORS_ORIGINS`
  - Data: `MONGODB_URI`, `REDIS_URL`
  - Auth: `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL`, `ENCRYPTION_KEY` (PII)
  - AI: `OPENAI_API_KEY`, `OPENAI_REALTIME_MODEL`
  - Storage: `STORAGE_DRIVER` (local/s3), `STORAGE_LOCAL_PATH`, `S3_BUCKET`, `S3_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
  - Email: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`
  - Payments: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`
  - Telephony: `NOTIFYNOW_API_KEY` (optional), `SIP_*` (Phase 13 — placeholder)
- [ ] Frontend `.env.example`: `VITE_API_URL`, `VITE_WS_URL`, `VITE_APP_NAME`
- [ ] Rules (`docs/conventions/secrets.md`):
  - Secrets sirf `.env` / server env / password manager mein — **git, docs, chat, screenshots mein nahi**
  - Har environment (local / staging / prod) ke alag secrets
  - Leak hone pe turant rotate
  - Client ka SSH key + DB password + NotifyNow key → password manager
- [ ] Phase 1 mein env ko zod schema se validate karenge (missing var → app start hi na ho)

**Done when:** Dono `.env.example` complete, secrets policy doc likha.

---

### T0.11 — API, WebSocket & data conventions doc

**Kyun:** Har phase mein API ek jaisi dikhe; frontend ko andaaza lagana na pade.

**`docs/conventions/api.md`:**

- [ ] Base path `/api/v1`, resources plural + kebab-case (`/api/v1/ai-agents`)
- [ ] Methods: GET list/detail, POST create/action, PATCH partial update, DELETE
- [ ] Actions: `POST /api/v1/campaigns/:id/pause`
- [ ] **Success response:** `{ "success": true, "data": …, "meta": { pagination } }`
- [ ] **Error response:** `{ "success": false, "error": { "code": "WALLET_INSUFFICIENT_BALANCE", "message": "…", "details": [...] } }`
- [ ] HTTP status codes ki list (200, 201, 204, 400, 401, 403, 404, 409, 422, 429, 500, 503)
- [ ] **Error code catalogue** (format: `DOMAIN_REASON`) — ek file mein maintain
- [ ] Pagination: `page` + `limit` (default 20, max 100); logs/calls ke liye cursor-based option
- [ ] Sorting `sort=-createdAt`, filtering query params, search `q`
- [ ] Dates ISO 8601 UTC; money integer micros + `currency`; phone E.164; IDs string
- [ ] Headers: `Authorization: Bearer`, `X-API-Key` (public API), `X-Request-Id`, **`Idempotency-Key`** (paisa lagne wale POST — call trigger, top-up)
- [ ] Rate limit headers, 429 behaviour
- [ ] File upload: multipart, size limits

**`docs/conventions/websocket.md`:**

- [ ] Endpoints: `/ws/events` (JSON events), `/ws/media` (binary audio, web call)
- [ ] Auth: connect time pe token (query/subprotocol), server account verify kare
- [ ] Event envelope: `{ "type": "call.status", "data": {...}, "ts": "…" }`
- [ ] Event naming `domain.action`: `call.created`, `call.status`, `call.transcript`, `campaign.progress`, `wallet.updated`, …
- [ ] Ping/pong + reconnect rules

**`docs/conventions/data.md`:**

- [ ] Har tenant document mein `accountId` (indexed) — **har query scoped**
- [ ] `createdAt` / `updatedAt` (timestamps), `createdBy` jahan zaroori
- [ ] Soft delete policy (`deletedAt`) — kin collections pe
- [ ] Enums string unions, money `*Micros`, index naming
- [ ] PII fields list (encrypt / mask in logs)

**`docs/conventions/code-style.md`:** file naming (kebab-case), module structure, controller → service → model layering, no business logic in routes, async error handling, logging rules (PII mask).

**Done when:** Chaaron docs likhe aur review hue.

---

### T0.12 — Shared types strategy + proof

**Options:** (a) zod schemas → OpenAPI spec → frontend types generate (`openapi-typescript`) · (b) teesra shared npm package · (c) manually copy

**Recommendation:** **(a)** — backend zod schemas single source of truth; `zod-to-openapi` se spec; frontend `npm run gen:api` se types.

**Steps:**

- [ ] ADR likhna (decision)
- [ ] Chhota proof: backend mein ek dummy schema → `openapi.json` → frontend mein typed client generate
- [ ] Script names fix: backend `gen:openapi`, frontend `gen:api`

**Done when:** Dummy endpoint ka type frontend mein auto-generate ho.

---

### T0.13 — Core data model draft (ERD)

**Kyun:** Aage ke phases ke models pehle se soche hue hon — baad mein bade migrations na karne padein.

**Entities (sirf fields ka outline + relations):**

- [ ] Account, User, Role/Permission, ApiKey, AuditLog
- [ ] Contact, ContactList, CustomFieldDefinition, DndEntry, Tag
- [ ] Wallet, LedgerEntry, RateCard, Invoice
- [ ] AiAgent, KnowledgeSource, AgentFunction
- [ ] Flow, FlowVersion
- [ ] Campaign, CampaignContact (per-contact status / attempts)
- [ ] Call, CallEvent (timeline), TranscriptTurn, Recording, CallCost
- [ ] PhoneNumber (DID → flow mapping), TelephonyConfig
- [ ] OutboundWebhook, WebhookDelivery
- [ ] Notification
- [ ] Har entity: `accountId`, key indexes, kaunse fields PII
- [ ] Diagram (Mermaid ERD) `docs/conventions/data-model.md` mein

**Done when:** ERD review hua, Phase 1–10 ke saare entities cover.

---

### T0.14 — CI pipeline (GitHub Actions)

**Steps:**

- [ ] Workflow `ci.yml` (dono repos): trigger PR + push on `main`/`dev`
- [ ] Steps: checkout → setup Node 24 (cache npm) → `npm ci` → `lint` → `typecheck` → `test` → `build`
- [ ] Backend: tests ke liye mongodb-memory-server (Docker zaroori nahi)
- [ ] Secret scanning: GitHub secret scanning on + (optional) `gitleaks` step
- [ ] `npm audit --audit-level=high` (warning mode)
- [ ] Branch protection mein CI required (T0.2)
- [ ] Dependabot (weekly, grouped)

**Done when:** Ek test PR pe CI green ho; jaan-boojh ke lint error daalne pe red ho.

---

### T0.15 — Voice AI PoC ⭐ (sabse important)

**Kyun:** Poora product AI voice quality pe tika hai. Pehle hi pata chale ki Hindi/Hinglish mein kaisa kaam karta hai, kitna fast, kitna mehenga.

**Timebox:** 2–3 din. Code `poc/voice-ai/` mein (main app ka hissa nahi).

**Steps:**

- [ ] OpenAI docs se **current Realtime model naam + pricing** verify karna (models jaldi badalte hain)
- [ ] Mini setup: local web page (browser mic) ⇄ Node relay (WebSocket) ⇄ OpenAI Realtime
- [ ] Session config:
  - Instructions: loan recovery persona (polite, respectful, Hindi/English/Hinglish follow)
  - Voice choose (2–3 voices compare)
  - Turn detection: server VAD (silence duration tune)
  - Input transcription on
  - **Audio formats dono test:** PCM16 (high quality) aur **G.711 μ-law 8kHz** (asli phone jaisa)
- [ ] Ek function: `check_payment_status(customerId)` → mock response (paid / not paid)
- [ ] Context injection: `{{name}}`, `{{amount}}`, `{{days}}` variables prompt mein

**Test scenarios (har ek ka result note karna):**

| #   | Scenario                                    | Kya check karna                               |
| --- | ------------------------------------------- | --------------------------------------------- |
| 1   | Hindi mein greeting + loan reminder         | Naam, ₹5,500, "120 din" sahi bola?            |
| 2   | Customer English mein jawab de              | AI English mein switch hua?                   |
| 3   | Beech mein language badle (Hindi ↔ English) | Switch smooth?                                |
| 4   | Hinglish ("maine kal pay kar diya tha")     | Samjha?                                       |
| 5   | "Maine pay kar diya" → function call        | Function call hua, result ke hisaab se jawab? |
| 6   | Customer gussa / chillaye                   | Calm + polite raha?                           |
| 7   | Bot ke bolte waqt customer bole (barge-in)  | Bot ruka?                                     |
| 8   | 10 second chuppi                            | "Hello, kya aap sun rahe hain?"               |
| 9   | Background noise (TV / traffic)             | Galat trigger to nahi?                        |
| 10  | Numbers / dates / amounts                   | ₹, dates, EMI sahi pronunciation?             |
| 11  | Indian naam (Bansal, Chaudhary, Iyer…)      | Pronunciation                                 |
| 12  | Off-topic sawaal / abusive language         | Guardrail follow?                             |
| 13  | "Baad mein call karo"                       | Callback time poochha?                        |
| 14  | Lambi call (5+ min)                         | Context yaad raha? cost kitna?                |

**Measure karna:**

- [ ] **Latency:** customer chup → bot ki pehli awaaz (p50 / p95) — target ~1 sec
- [ ] **Cost per minute** (usage events se tokens → ₹)
- [ ] Transcription accuracy (Hindi / Hinglish)
- [ ] 8kHz G.711 pe quality kitni giri
- [ ] **Fixed TTS** (`speak` nodes ke liye) — OpenAI TTS se Hindi text bolwa ke quality check

**Optional (timeboxed, ½ din):** Option B ka quick check — Indian STT/TTS provider (jaise Sarvam) ki Hindi quality vs OpenAI.

**Output:** `docs/poc/voice-ai-poc-results.md` — har scenario ka result, numbers, recordings ke notes, **Go / No-go recommendation**, ADR 0021 update.

**Done when:** Scenarios 1–14 test hue, latency + cost numbers likhe, ADR 0021 accepted.

---

### T0.16 — SIP local lab (optional, strongly recommended)

**Kyun:** SIP client details ka wait hai, par apne laptop pe SIP seekh / test karke Phase 13 ka risk abhi kam kar sakte hain.

**Timebox:** 1–2 din. Code `poc/sip-lab/`.

**Steps:**

- [ ] Docker mein **Asterisk** (ARI enabled) chalana
- [ ] Softphone (Zoiper / Linphone) se Asterisk pe register → test call
- [ ] Node ARI app: call answer kare → ek audio file play kare → DTMF capture kare
- [ ] **ExternalMedia** / AudioSocket se call audio Node tak stream (yahi Phase 13 ka core hai)
- [ ] (Bonus) T0.15 ke PoC se jodna: softphone se baat → AI jawab de
- [ ] FreeSWITCH ka bhi short comparison (docs level)
- [ ] ⚠️ Mac + Docker pe RTP/UDP issues aa sakte hain → tab Linux VM (UTM/Multipass) use karna
- [ ] **Client ke server pe kuch nahi** — sab local

**Output:** `docs/poc/sip-lab-notes.md` — kya chala, kya problems aaye, Asterisk vs FreeSWITCH notes, Phase 13 ke liye checklist.

**Done when:** Softphone call → Node mein audio aaya + DTMF mila (ya clear notes ki kahan atka).

---

### T0.17 — Cost model draft

**Steps:**

- [ ] Inputs list:
  - AI cost per minute (T0.15 se)
  - TTS cost (`speak` nodes)
  - Telephony per minute / pulse — **client se pending** (placeholder value)
  - Recording storage per minute, server cost share
  - Platform margin %, GST 18% (top-up pe)
- [ ] Assumptions: avg call duration (jaise 1.5 min), answer rate (jaise 50%), retries
- [ ] Output table:
  - Cost per answered minute
  - Suggested selling rate per minute (margin ke saath)
  - **100-contact campaign ka estimate** (loan recovery example)
- [ ] Sensitivity: agar call 3 min chale / AI mehenga ho to kya

**Output:** `docs/cost/cost-model.md` (ya sheet).
**Done when:** Per-minute cost + selling rate ka draft ready, placeholders clearly marked.

---

### T0.18 — Compliance research notes

**Note:** Ye legal advice nahi — client / unke legal se confirm karwana hai.

**Steps (topics):**

- [ ] **TRAI:** commercial calls rules, DND / NCPR, promotional vs transactional/service calls, caller ID / series
- [ ] **RBI recovery guidelines:** calling time (8am–7pm), no threats / abusive language, identity disclose, privacy
- [ ] **DPDP Act 2023:** personal data, consent, purpose limitation, retention, delete request
- [ ] **Call recording:** disclosure / consent message
- [ ] **AI disclosure:** call shuru mein batana ki automated/AI call hai (best practice)
- [ ] Product mein kya features chahiye isse → list (calling window, DND, disclosure node, retention, data delete) → Phase 11 input

**Output:** `docs/compliance/compliance-notes.md` + "client se confirm karna hai" list.

---

### T0.19 — Client server access check (read-only) 🔒

**Kyun:** Pata chale server pe kya chal raha hai (Node version, Docker, Mongo, ports) — Phase 12 ke decisions isi pe depend.

**Rules (strict):**

- ❌ Kuch install / update / restart / delete nahi
- ❌ Koi config file edit nahi
- ❌ Doosri app ke logs / data copy nahi
- ✅ Sirf dekhna aur note karna

**Steps:**

- [ ] SSH login (`ubuntu@13.232.191.62`, key file) — kaam kare
- [ ] Note: OS version, CPU/RAM/disk free, Node/npm version (agar hai), Docker hai ya nahi, PM2 hai ya nahi
- [ ] Running services / listening ports (kaunsi app kaunsa port)
- [ ] Nginx / Apache hai? kaunse sites configured (sirf list)
- [ ] DB server chal raha hai? (Mongo / MySQL — process + port se, login nahi)
- [ ] Firewall (ufw) status
- [ ] Logout

**Output:** `docs/client/server-audit.md` (secrets ke bina) + risks list.
**Done when:** Audit note likha, server pe zero changes.

---

### T0.20 — Phase 0 review, sign-off & plan update

**Steps:**

- [ ] Saare tasks ke "Done when" check
- [ ] Dono repos: fresh clone → README follow → `npm ci` → `npm run check` pass (naye machine pe setup verify)
- [ ] ADRs final, `BUILD_PLAN.md` mein decisions update (jaise voice AI, folder structure)
- [ ] Risks list update (neeche)
- [ ] Client answers aaye hon to `docs/client/answers.md` + plan update
- [ ] `CHANGELOG.md` mein Phase 0 entry, `dev` → `main` merge, tag `v0.0.1`
- [ ] **Phase 1 ka detailed plan** banana

**Done when:** Sign-off checklist (section 3) poori.

---

## 3. Phase 0 — Final Deliverables checklist

**Repos & tooling**

- [ ] Backend repo: scaffold, scripts, tsconfig strict, folder structure, hello entry
- [ ] Frontend repo: Vite + React + TS + MUI + React Query, hello page
- [ ] ESLint, Prettier, Husky, lint-staged, EditorConfig — dono repos
- [ ] Vitest — dono repos, sample tests pass
- [ ] Docker Compose: Mongo (replica set) + Redis
- [ ] `.env.example` dono repos, secrets policy
- [ ] CI green, branch protection, Dependabot
- [ ] README dono repos (setup steps verified on fresh clone)

**Docs**

- [ ] ADRs (0001–0025)
- [ ] Conventions: API, WebSocket, data, code style, secrets
- [ ] Data model ERD
- [ ] Shared types proof
- [ ] Voice AI PoC results + recommendation
- [ ] SIP lab notes (optional)
- [ ] Cost model draft
- [ ] Compliance notes
- [ ] Server audit note
- [ ] Task prompt template, Definition of Done, CHANGELOG

---

## 4. Risks & mitigations

_Status updated at sign-off (2026-10-08)._

| Risk                                                       | Asar                            | Mitigation                                                                                         | Status                                                |
| ---------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| OpenAI Realtime Hindi/Hinglish quality kam                 | Core product weak               | T0.15 PoC (14 scenarios); Option B (Indian STT/TTS) fallback                                       | ⏳ open — PoC live runs pending (no key)              |
| AI cost per minute zyada                                   | Client ke liye mehenga          | Cost model; mini model (~3× sasta); IVR `speak` nodes jahan possible                               | ⏳ estimates only (mini ≈ ₹3.4/min, full ≈ ₹10.7/min) |
| Latency > 1.5 sec                                          | Baatcheet unnatural             | Streaming, VAD tuning, server region                                                               | ⏳ open — PoC measures it                             |
| Client ka DB Mongo nahi                                    | Stack mismatch                  | Apna MongoDB 8.2 (Docker) — Phase 12                                                               | ⏳ open — answers #5                                  |
| **MongoDB 8.0 fails on Linux kernel ≥ 6.19**               | DB start nahi hota              | MongoDB 8.2 everywhere (Docker, tests, prod)                                                       | ✅ mitigated (ADR 0004)                               |
| Mac Docker pe SIP/RTP issues                               | Lab atke                        | IPv4 host lookup; Linux VM for softphone tests                                                     | ✅ lab passed                                         |
| **npm 11 blocks install scripts**                          | Tools silently missing binaries | `allowScripts` reviewed per dependency; `npm approve-scripts --allow-scripts-pending` on every add | ✅ process in READMEs                                 |
| **TypeScript / ESLint version pins**                       | Upgrades break lint             | TS `~6.0`, ESLint `^9`; Dependabot ignores majors; `openapi-typescript` via npm `overrides`        | ✅ documented (ADR 0029, dependabot.yml)              |
| Mantis/MUI template license                                | Legal issue                     | Mantis copy nahi; plain MUI                                                                        | ⏳ open — user confirmation                           |
| Secrets leak (SSH key, DB password chat mein aaye)         | Security                        | Password manager, rotate before prod, gitleaks in CI + push protection                             | ⏳ rotation pending                                   |
| Client ke server pe galti se change                        | Doosri app down                 | Read-only allowlist audit script; isolated deploy plan                                             | ✅ tooling ready (audit blocked: no key)              |
| Client answers late                                        | SIP phases late                 | Web Call Tester se ~75% build                                                                      | ⏳ open                                               |
| **Regulatory change (RBI recovery drafts, TRAI AI rules)** | Rework of call rules            | Configurable window / caps / disclosure; re-check before go-live                                   | ⏳ monitor                                            |

---

## 5. Recommended order (day-wise idea)

| Din | Kaam                                                             |
| --- | ---------------------------------------------------------------- |
| 1   | T0.1, T0.2, T0.3 · T0.15 PoC shuru (parallel)                    |
| 2   | T0.4 ADRs, T0.5 backend scaffold, T0.6 frontend scaffold         |
| 3   | T0.7, T0.8, T0.9, T0.10 · PoC continue                           |
| 4   | T0.11 conventions, T0.12 shared types, T0.13 ERD                 |
| 5   | T0.14 CI, T0.17 cost model, T0.18 compliance, T0.19 server audit |
| 6   | T0.16 SIP lab (optional), T0.20 review + sign-off                |

_Ye andaaza hai — PoC results ke hisaab se aage-peeche ho sakta hai._

---

## Changelog

- 2026-10-08: Node 24 LTS (Node 20 EOL), MongoDB 8.2 (8.0 fails on Linux kernel ≥ 6.19), Redis 7.4, local ports API 5100 / web 3100 / Mongo 27018 / Redis 6380, React 19 + latest MUI, Mantis template not reused until license confirmed — see [ADR index](../adr/README.md).
