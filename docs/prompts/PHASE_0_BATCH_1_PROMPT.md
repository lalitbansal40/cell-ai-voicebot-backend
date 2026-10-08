# P0 · BATCH 1 RUN — Setup & Foundations (T0.1 → T0.10) — Autonomous Run Prompt

> **HOW TO RUN (ise paste karo):**
> `docs/prompts/PHASE_0_BATCH_1_PROMPT.md padho aur T0.1 se P0-B1-DONE tak SAARE tasks step by step autonomously implement karo. Bich me koi question mat poochho, permission mat maango — saare decisions is prompt me pre-made hain. Har task ke baad verify + commit (tag [P0-T0.x]). Koi push / merge NAHI. Ant me P0-B1-DONE checkpoint + final report.`
>
> **Claude Code "accept edits" mode me chalao.** Working directory: `/Users/lalitbansal/Documents/cell-ai-voicebot`

---

## 0. CONTEXT (verified facts — dobara derive mat karna)

**Project:** Cell AI Voicebot — multi-tenant AI voice calling platform (MERN + TypeScript). Poora product plan: `docs/BUILD_PLAN.md`. Is batch ka source plan: `docs/phases/PHASE_0_PLAN.md` (tasks T0.1–T0.10). Dono padh lo pehle.

**Folder layout (abhi):**

```
/Users/lalitbansal/Documents/cell-ai-voicebot/          ← git repo NAHI hai
  docs/                                                  ← plans (BUILD_PLAN, OVERVIEW_PLAN, CLIENT_QUESTIONS, phases/, prompts/) + PDFs
  cell-ai-voicebot-backend/   ← git repo, branch `main`, 0 commits, remote origin github.com/lalitbansal40/cell-ai-voicebot-backend (empty)
                                 sirf ek khaali `.env` file hai (0 bytes) — commit NAHI honi chahiye
  cell-ai-voicebot-frontend/  ← git repo, branch `main`, 0 commits, remote origin github.com/lalitbansal40/cell-ai-voicebot-frontend (empty), koi file nahi
```

**Machine (verified):** macOS 26.6 (Apple Silicon arm64), zsh. **Node v24.19.0**, npm 11.17.0 (nvm NAHI hai, Homebrew NAHI hai). Docker 29.7.2 + Docker Compose v5.4.0. git 2.54. `gh` CLI NAHI hai. Global git identity set hai (`Lalit Bansal` / GitHub noreply email) — wahi use karo, change mat karo.

**Reference project (sirf padhne ke liye, kabhi modify NAHI):** `/Users/lalitbansal/Documents/Autochatix/AutoChatix-backend` aur `/Users/lalitbansal/Documents/Autochatix/AutoChatix-frontend`.

---

## 1. LOCKED DECISIONS (plan se kuch updates — inhi ko follow karo)

| Cheez                 | Decision                                                                                                                                                                                                    | Note                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Node                  | **Node 24 LTS** (`.nvmrc` = `24`, `engines.node` = `">=24 <25"`)                                                                                                                                            | Plan me Node 20 likha tha — Node 20 **April 2026 me EOL** ho chuka hai. Docs update karne hain (T0.3)       |
| Package manager       | **npm** (lockfile commit hoga), `.npmrc` me `engine-strict=true`                                                                                                                                            |                                                                                                             |
| Backend module system | `package.json` `"type": "commonjs"`; tsconfig `module` + `moduleResolution` = **`NodeNext`**                                                                                                                | Relative imports bina extension (CJS mode)                                                                  |
| Backend dev runner    | `tsx watch` · build `tsc` · start `node dist/index.js`                                                                                                                                                      | esbuild nahi                                                                                                |
| Path aliases          | Backend: **nahi**. Frontend: `@/` → `src/`                                                                                                                                                                  |                                                                                                             |
| MongoDB               | **MongoDB 8.0** (Docker), **single-node replica set** `rs0`                                                                                                                                                 | Plan me 7 likha tha — update docs                                                                           |
| Redis                 | **Redis 7.4** (`redis:7.4-alpine`), AOF on                                                                                                                                                                  |                                                                                                             |
| Local ports           | Backend API **5100** · Frontend dev **3100** · Mongo **27018** · Redis **6380**                                                                                                                             | AutoChatix (5005/3000) aur kisi local Mongo/Redis se clash na ho. Plan me 5005/3000 likha tha — update docs |
| Frontend              | **Vite (latest) + React 19 + TypeScript**                                                                                                                                                                   | Plan me React 18 likha tha — latest stable lo, update docs                                                  |
| UI kit                | **MUI latest stable major** (`@mui/material`, `@emotion/react`, `@emotion/styled`, `@mui/icons-material`)                                                                                                   | AutoChatix ka Mantis template copy **NAHI** (license check pending — neeche T0.4 ADR 0011)                  |
| Router                | `react-router` latest (v7+, data router `createBrowserRouter`)                                                                                                                                              |                                                                                                             |
| Server state          | `@tanstack/react-query` (+ devtools sirf dev)                                                                                                                                                               |                                                                                                             |
| Validation            | `zod` latest (v4+)                                                                                                                                                                                          | Phase 0 me sirf frontend dep; backend Phase 1                                                               |
| Lint                  | ESLint 9+ flat config, `typescript-eslint` (type-aware), `eslint-plugin-import-x`, `eslint-config-prettier`; frontend + `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`                          |                                                                                                             |
| Format                | Prettier                                                                                                                                                                                                    |                                                                                                             |
| Git hooks             | Husky (latest) + lint-staged + commitlint (`@commitlint/config-conventional`)                                                                                                                               |                                                                                                             |
| Tests                 | Vitest (+ `@vitest/coverage-v8`); backend `mongodb-memory-server` (replica set, MongoDB 8.0 binary); frontend `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event`, `jsdom` |                                                                                                             |
| Docs ka ghar          | **Backend repo ka `docs/`** (source of truth). Frontend README wahan link karega                                                                                                                            |                                                                                                             |
| Task tracking         | File-based: `docs/phases/PHASE_0_TASKS.md` (GitHub Projects nahi)                                                                                                                                           |                                                                                                             |
| TypeScript            | Latest stable jo `typescript-eslint` officially support karta ho                                                                                                                                            | Agar latest unsupported ho to highest supported version lo, report me note                                  |

**Version rule:** Har package ka **latest stable** version lo (`npm install <pkg>` bina version ke). Agar koi peer-dependency conflict aaye to compatible version chuno — `--force` / `--legacy-peer-deps` **kabhi nahi**. Final report me har major dependency ka installed version likho.

---

## 2. RULES OF ENGAGEMENT (strictly — har task)

1. **Question mat poochho, permission mat maango.** AskUserQuestion BANNED. Koi cheez ambiguous ho to sabse safe + plan-consistent option chuno, aage badho, report me likho.
2. **Git:**
   - T0.2 me dono repos me `main` pe **ek initial commit**, phir `dev` branch, phir `feature/phase-0-setup` branch (dev se). **T0.3 se T0.10 ka saara kaam `feature/phase-0-setup` pe.**
   - Har task (jis repo me kuch badla) = **ek commit per repo**, Conventional Commit format, end me tag: e.g. `chore(tooling): add eslint and prettier config [P0-T0.7]`.
   - **No `git push`. No merge. `main`/`dev` ko T0.2 ke baad touch nahi karna.** Push/merge user khud karega.
   - `git add -A` se pehle `git status` dekho — **`.env` / secrets kabhi stage na hon.**
3. **Secrets:** koi API key, password, SSH key, token — code, docs, commit, logs, report me **kabhi nahi**. `.env.example` me sirf placeholder (`change-me`, khaali, ya `<…>`).
4. **Scope:** Sirf T0.1–T0.10. Phase 1+ ka kaam (Express app, logger, DB connection code, auth, koi feature) **NAHI**. Hello-world level code sirf tooling prove karne ke liye.
5. **Safety:**
   - `sudo` nahi. Global installs (`npm i -g`) nahi. System software install nahi.
   - AutoChatix folders **read-only**.
   - Parent `docs/` folder ki files **delete nahi** (repo me copy karni hain — T0.3).
   - Client ka server (13.232.191.62) — is batch me **bilkul touch nahi**.
   - `docker compose down -v` sirf apne compose project pe; koi aur container / volume / image delete nahi.
6. **Verify har task ke baad** (task ke "VERIFY" section ke commands). Fail ho to fix karo, tabhi commit. T0.7 ke baad se har commit se pehle dono repos me `npm run lint && npm run typecheck` (T0.8 ke baad `npm test` bhi) green hone chahiye.
7. **Har naya env var** → `.env.example` me (comment + kaunsa phase use karega).
8. **Docs consistency:** Jo bhi decision is prompt me plan se alag hai (Node 24, Mongo 8, ports, React 19, Mantis), wo repo ke docs me update karna hai (T0.3 + T0.4) — purane numbers kahin na reh jayein (`grep` se check).

---

## 3. RESUME SAFETY (agar session beech me toot jaye)

- Naya session shuru ho to dono repos me `git branch --show-current` aur `git log --oneline -20` dekho. Aakhri `[P0-T0.x]` commit se pata karo kahan tak hua; **agle task se continue** — jo ho chuka dobara mat karo.
- Har task commit hone ke baad state safe hai. Branch delete / `reset --hard` / force kuch nahi.
- Resume pe pehle dono repos me (agar scripts ban chuke hain) `npm ci && npm run lint && npm run typecheck` chala kar confirm karo pichhla kaam clean hai.

---

# ═══════════ TASKS ═══════════

## T0.1 — Machine prerequisites check (koi commit nahi — findings T0.3 me doc banenge)

**Karna:**

1. Ye commands chalao aur output note karo: `node -v`, `npm -v`, `docker --version`, `docker compose version`, `docker info --format '{{.ServerVersion}}'` (daemon chal raha hai?), `git --version`, `git config --global user.name`, `git config --global init.defaultBranch`, `sw_vers -productVersion`, `uname -m`.
2. Docker daemon band ho to report me blocker likho; T0.9 me compose file phir bhi banao, sirf runtime verify skip + report.
3. Dono remotes reachable: `git -C cell-ai-voicebot-backend ls-remote origin` aur frontend ke liye same (khaali output + exit 0 = OK). Fail → report (push user karega, isse kaam nahi rukta).
4. **Manual items (user karega — sirf report me list):** OpenAI API key with Realtime access + billing + budget cap; password manager choose; client ka SSH key file safe jagah + `chmod 400`; VS Code extensions (ESLint, Prettier, EditorConfig, DotENV, Docker); MongoDB Compass; GitHub branch protection (T0.14 ke baad).
5. Findings yaad rakho — T0.3 me `docs/setup/prerequisites.md` me likhne hain.

**VERIFY:** Node major = 24, Docker daemon up.

---

## T0.2 — Git & repo hygiene (DONO repos) → commit on `main`

**Dono repos me ye files banao:**

1. **`.gitignore`** (dono me same base; frontend me `dist/` bhi):
   ```
   # deps & builds
   node_modules/
   dist/
   build/
   coverage/
   *.tsbuildinfo
   # env & secrets
   .env
   .env.*
   !.env.example
   *.pem
   *.key
   *.p12
   id_rsa*
   # logs & runtime data
   *.log
   logs/
   npm-debug.log*
   recordings/
   uploads/
   tmp/
   poc/**/output/
   # OS / editor
   .DS_Store
   Thumbs.db
   .idea/
   .vscode/*
   !.vscode/settings.json
   !.vscode/extensions.json
   # tools
   .eslintcache
   ```
2. **`.gitattributes`**: `* text=auto eol=lf` + binary types (`*.png binary`, `*.jpg binary`, `*.pdf binary`, `*.mp3 binary`, `*.wav binary`).
3. **`.editorconfig`**: `root = true`; `[*]` indent_style space, indent_size 2, end_of_line lf, charset utf-8, trim_trailing_whitespace true, insert_final_newline true; `[*.md]` trim_trailing_whitespace false.
4. **`README.md`** skeleton (sections, abhi short content): Project name + one-line description · Status (Phase 0) · Prerequisites · Getting started · Scripts · Folder structure · Environment variables · Docs link (backend: `docs/`; frontend: backend repo ke docs ka link) · Conventions (link baad me). T0.5/T0.6/T0.9/T0.10 me ye sections bharte jaana.
5. **`.github/pull_request_template.md`**: sections — What changed · Why · How tested (commands) · Screenshots (UI) · Checklist (`[ ] lint`, `[ ] typecheck`, `[ ] tests`, `[ ] build`, `[ ] .env.example updated`, `[ ] docs updated`, `[ ] no secrets`).

**Git steps (dono repos):**

1. `git status` — backend me confirm `.env` untracked hai aur `.gitignore` banne ke baad `git check-ignore .env` → `.env` print kare.
2. `git add -A` → `git status` (sirf upar wali files stage hon) → commit: `chore: initial repo setup [P0-T0.2]`.
3. `git branch dev` → `git checkout -b feature/phase-0-setup dev`.
4. **Push NAHI.**

**VERIFY:** `git log --oneline` = 1 commit; `git branch` me `main`, `dev`, `feature/phase-0-setup`; current = feature branch; `git check-ignore .env` OK (backend).

---

## T0.3 — Docs ka ghar + project management (BACKEND repo) → commit

1. Backend repo me structure banao:
   ```
   docs/
     README.md          ← docs index (har folder kya hai + key files ke links)
     plans/             BUILD_PLAN.md, OVERVIEW_PLAN.md
     phases/            PHASE_0_PLAN.md, PHASE_0_TASKS.md
     prompts/           PHASE_0_BATCH_1_PROMPT.md, TASK_PROMPT_TEMPLATE.md
     adr/               (T0.4)
     conventions/       definition-of-done.md, secrets.md (T0.10)
     setup/             prerequisites.md
     poc/               README.md (placeholder: T0.15 / T0.16 results yahan aayenge)
     client/            CLIENT_QUESTIONS.md, answers.md
     cost/              README.md (placeholder — T0.17)
     compliance/        README.md (placeholder — T0.18)
   ```
2. **Copy** (move nahi — parent folder ki files waise hi rehne do) sirf `.md` files parent `docs/` se: `BUILD_PLAN.md`, `OVERVIEW_PLAN.md`, `CLIENT_QUESTIONS.md`, `phases/PHASE_0_PLAN.md`, `prompts/PHASE_0_BATCH_1_PROMPT.md`. **PDFs repo me nahi.**
3. `OVERVIEW_PLAN.md` ke top pe note: `> ⚠️ ARCHIVED (v1) — superseded by plans/BUILD_PLAN.md (v2, SIP based).`
4. **Repo copies me decisions update** (section 1 table): Node 20 → 24 LTS, MongoDB 7 → 8.0, backend port 5005 → 5100, frontend port 3000 → 3100, React 18 → React 19 (latest), Mantis reuse → "MUI latest; Mantis license pending (ADR 0011)". `docs/BUILD_PLAN.md` aur `PHASE_0_PLAN.md` dono me. `PHASE_0_PLAN.md` me relative paths (`docs/BUILD_PLAN.md` → `../plans/BUILD_PLAN.md`) theek karo. Har updated file ke end me chhota `## Changelog` entry: `- 2026-10-08: Node 24, Mongo 8, ports 5100/3100, React 19 — see ADR index.` Ant me `grep -rn "Node 20\|node 20\|MongoDB 7\|5005\|React 18" docs/` → sirf archived OVERVIEW_PLAN / changelog lines bachein.
5. **`docs/phases/PHASE_0_TASKS.md`**: T0.1–T0.20 checkbox list (title + size + status). Is batch ke end me T0.1–T0.10 `[x]` karna (P0-B1-DONE pe).
6. **`docs/prompts/TASK_PROMPT_TEMPLATE.md`** — Claude se task-wise kaam karwane ka template, sections: HOW TO RUN line · Context (phase, task IDs, related docs/files, branch) · Goal · In scope · Out of scope · Locked decisions · Steps (numbered) · Acceptance criteria / VERIFY commands · Tests required · Git rules (commit format, no push) · Rules (no questions, no secrets, tenant scoping…) · Final report format.
7. **`docs/conventions/definition-of-done.md`**: lint ✓ · typecheck ✓ · tests (naye logic ke tests) ✓ · build ✓ · `.env.example` updated · docs/README updated · no secrets · tenant scoping (Phase 1+) · PR template filled · reviewed + merged to `dev`.
8. **`docs/setup/prerequisites.md`**: T0.1 ke findings (versions table), required tools, install guide (Node 24 — nvm/fnm optional for other devs), Docker Desktop, VS Code extensions, Compass, manual items checklist (T0.1 point 4).
9. **`docs/client/answers.md`**: table — client se pending details (SIP host/port/transport/auth, caller ID / DID, codecs + RTP range + concurrency, server pe running apps/ports, DB type + host + user + db name, domain) · columns: Question | Status (pending) | Answer | Date. **Koi secret value isme nahi likhni** (DB password wagerah sirf password manager me).
10. **`CHANGELOG.md`** (repo root, Keep a Changelog format): `## [Unreleased]` → `### Added` — Phase 0 batch 1 items (end me update karna).
11. **Frontend repo:** README ke Docs section me likho ki saare docs backend repo ke `docs/` me hain (relative mention + GitHub URL `https://github.com/lalitbansal40/cell-ai-voicebot-backend/tree/main/docs`). Frontend commit T0.6 ke saath chala jayega (alag commit zaroori nahi).
12. `docs/README.md` index me har file ka link.

**Commit (backend):** `docs: add project docs structure, plans and templates [P0-T0.3]`

**VERIFY:** `find docs -type f | sort` expected files dikhayein; grep check (point 4) pass; koi PDF repo me nahi.

---

## T0.4 — Architecture Decision Records (BACKEND repo `docs/adr/`) → commit

1. `docs/adr/0000-template.md`: `# NNNN — Title` · **Status:** proposed | accepted | deferred | superseded · **Date** · **Context** · **Options considered** (pros/cons) · **Decision** · **Consequences** (positive / negative / follow-ups).
2. Har ADR alag file `docs/adr/NNNN-kebab-title.md`, **real content** ke saath (context 2–5 lines, kam se kam 2 options, decision, consequences). Language: Hinglish ya simple English — consistent rakho.

| #    | Title                   | Status       | Decision (summary)                                                                                                                                                                                                                                                                                                                                                   |
| ---- | ----------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0001 | Repo structure          | accepted     | 2 repos (backend, frontend); docs backend repo me                                                                                                                                                                                                                                                                                                                    |
| 0002 | Runtime & language      | accepted     | Node 24 LTS + TypeScript strict; Node 20 EOL reason                                                                                                                                                                                                                                                                                                                  |
| 0003 | Backend code structure  | accepted     | Module-based `src/modules/<feature>` + `src/core` + `src/shared` (T0.5 tree)                                                                                                                                                                                                                                                                                         |
| 0004 | Database                | accepted     | MongoDB 8 + Mongoose; replica set (wallet transactions); local Docker, prod Phase 12                                                                                                                                                                                                                                                                                 |
| 0005 | Queue & background jobs | accepted     | Redis 7.4 + BullMQ                                                                                                                                                                                                                                                                                                                                                   |
| 0006 | Validation              | accepted     | zod (requests, env, shared schemas → OpenAPI)                                                                                                                                                                                                                                                                                                                        |
| 0007 | Logging                 | accepted     | pino JSON logs + request ID; PII masking                                                                                                                                                                                                                                                                                                                             |
| 0008 | Real-time transport     | accepted     | `ws`; `/ws/events` (JSON) + `/ws/media` (binary audio)                                                                                                                                                                                                                                                                                                               |
| 0009 | Auth tokens             | accepted     | Short JWT access token + refresh token httpOnly Secure SameSite cookie, rotation + reuse detection                                                                                                                                                                                                                                                                   |
| 0010 | Frontend build tool     | accepted     | Vite + React 19 + TS (CRA deprecated)                                                                                                                                                                                                                                                                                                                                |
| 0011 | UI kit & template       | **proposed** | MUI latest. AutoChatix frontend `package.json` name `mantis-react-ts` hai (Mantis **TypeScript = paid/Pro** version lagta hai). AutoChatix frontend ka README / LICENSE / `package.json` padh ke jo mile wo context me likho. Decision: jab tak user license confirm na kare, **Mantis code copy nahi**; apna thin layout plain MUI pe. Follow-up: user confirm kare |
| 0012 | Frontend state          | accepted     | React Query (server) + Zustand (small client state, jab zaroorat ho); Redux nahi                                                                                                                                                                                                                                                                                     |
| 0013 | Forms                   | accepted     | react-hook-form + zod resolver                                                                                                                                                                                                                                                                                                                                       |
| 0014 | Flow builder library    | accepted     | `@xyflow/react` (reactflow v12+)                                                                                                                                                                                                                                                                                                                                     |
| 0015 | Naming conventions      | accepted     | camelCase (code, API JSON, Mongo fields); collections plural; files kebab-case; React components PascalCase                                                                                                                                                                                                                                                          |
| 0016 | Money representation    | accepted     | Integer micro-units (₹1 = 1,000,000), suffix `Micros`, `currency` field; floats kabhi nahi                                                                                                                                                                                                                                                                           |
| 0017 | Dates & timezones       | accepted     | DB/API UTC ISO-8601; account timezone default `Asia/Kolkata`; `date-fns` + `@date-fns/tz`                                                                                                                                                                                                                                                                            |
| 0018 | Phone numbers           | accepted     | E.164 store; `libphonenumber-js`; default region IN                                                                                                                                                                                                                                                                                                                  |
| 0019 | Testing stack           | accepted     | Vitest, Supertest, mongodb-memory-server (replset), RTL + jsdom; Playwright e2e baad me                                                                                                                                                                                                                                                                              |
| 0020 | Telephony abstraction   | accepted     | `TelephonyProvider` interface; impls WebCall, SIP, NotifyNow (optional)                                                                                                                                                                                                                                                                                              |
| 0021 | Voice AI provider       | proposed     | Default OpenAI Realtime behind `VoiceAiProvider` interface; final after PoC T0.15                                                                                                                                                                                                                                                                                    |
| 0022 | SIP media server        | deferred     | Asterisk ARI vs FreeSWITCH — Phase 13 PoC + T0.16 lab                                                                                                                                                                                                                                                                                                                |
| 0023 | File storage            | accepted     | `StorageProvider` interface — local disk (dev) / S3 (prod)                                                                                                                                                                                                                                                                                                           |
| 0024 | API versioning & style  | accepted     | REST `/api/v1`, envelope `{success,data,meta}` / `{success:false,error:{code,message,details}}` (detail T0.11)                                                                                                                                                                                                                                                       |
| 0025 | Deployment style        | deferred     | Docker Compose vs PM2 — Phase 12 (server audit T0.19 ke baad)                                                                                                                                                                                                                                                                                                        |
| 0026 | Package manager         | accepted     | npm + committed lockfile + `engine-strict`                                                                                                                                                                                                                                                                                                                           |
| 0027 | Module system           | accepted     | Backend CommonJS output with `module/moduleResolution: NodeNext`; frontend ESM (Vite)                                                                                                                                                                                                                                                                                |
| 0028 | Local dev ports         | accepted     | API 5100, web 3100, Mongo 27018, Redis 6380 (AutoChatix clash avoid)                                                                                                                                                                                                                                                                                                 |

3. `docs/adr/README.md`: index table (number, title, status, link).
4. `docs/README.md` me ADR index ka link.

**Commit:** `docs(adr): add architecture decision records 0001-0028 [P0-T0.4]`

**VERIFY:** 28 ADR files + template + README; har file me sab sections; ADR 0011 me Mantis finding likhi hai.

---

## T0.5 — Backend scaffold (BACKEND repo) → commit

1. **`package.json`**: name `cell-ai-voicebot-backend`, version `0.0.1`, description, `"private": true`, `"license": "UNLICENSED"`, `"type": "commonjs"`, `"main": "dist/index.js"`, `"engines": { "node": ">=24 <25" }`. (Abhi koi `dependencies` nahi.)
2. **`.nvmrc`** → `24` · **`.npmrc`** → `engine-strict=true`
3. **devDependencies:** `typescript`, `tsx`, `@types/node` (Node 24 types — `@types/node@24`).
4. **`tsconfig.json`** (base — typecheck ke liye, `noEmit: true`, **rootDir/outDir yahan NAHI** warna tests include karne pe TS6059 aayega):
   - `target: "ES2023"`, `lib: ["ES2023"]`, `module: "NodeNext"`, `moduleResolution: "NodeNext"`
   - `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`, `useUnknownInCatchVariables`, `forceConsistentCasingInFileNames` — sab `true`
   - `esModuleInterop`, `resolveJsonModule`, `skipLibCheck`, `isolatedModules` — `true`; `types: ["node"]`; `noEmit: true`
   - `include`: `src`, `tests`, `scripts`, `*.config.ts`; `exclude`: `node_modules`, `dist`, `poc`
5. **`tsconfig.build.json`**: extends base; `noEmit: false`, `rootDir: "src"`, `outDir: "dist"`, `sourceMap: true`, `declaration: false`, `removeComments: false`; `include: ["src"]`; `exclude: ["**/*.test.ts", "**/*.spec.ts"]`.
6. **Folder tree** (khaali folders me `.gitkeep`):
   ```
   src/
     index.ts
     config/
     shared/  errors/  middlewares/  utils/  types/
     core/    engine/  voice/  telephony/  queues/  billing/
     modules/ auth/ accounts/ users/ contacts/ wallet/ ai-agents/ flows/ campaigns/ calls/ webhooks/ public-api/
     jobs/
     db/
   tests/
   scripts/
   poc/
   ```
   `shared/` ke andar sub-folders: `errors`, `middlewares`, `utils`, `types`; `core/` ke andar: `engine`, `voice`, `telephony`, `queues`, `billing`.
7. **`src/README.md`**: har folder ka purpose (ek-ek line) + kaunsa phase bharega + module ke andar standard files (`*.routes.ts`, `*.controller.ts`, `*.service.ts`, `*.model.ts`, `*.schema.ts` (zod), `*.types.ts`, `*.test.ts`) + layering rule (routes → controller → service → model; business logic sirf service me).
8. **`src/index.ts`** (hello entry):
   - `export const getAppInfo = (): { name: string; version: string; node: string; env: string }` → name `cell-ai-voicebot-backend`, version `process.env.npm_package_version ?? "0.0.0-dev"` (**package.json import mat karo** — rootDir issue), node `process.version`, env `process.env.NODE_ENV ?? "development"`.
   - `if (require.main === module)` → `console.info(...)` app info (ek line ESLint disable comment ke saath: `// eslint-disable-next-line no-console -- logger Phase 1 me aayega`).
9. **Scripts:**
   ```
   "dev": "tsx watch src/index.ts",
   "build": "tsc -p tsconfig.build.json",
   "start": "node dist/index.js",
   "typecheck": "tsc --noEmit",
   "clean": "node -e \"require('fs').rmSync('dist',{recursive:true,force:true})\""
   ```
   (`lint`, `format`, `test`, `check`, `infra:*` scripts aage ke tasks me add honge.)
10. `npm install` → `package-lock.json` commit.
11. README: Getting started (`npm ci`, `npm run dev`), Scripts table, Folder structure (src/README link).

**Commit:** `chore(backend): scaffold typescript project and folder structure [P0-T0.5]`

**VERIFY:** `npm run typecheck` ✓ · `npm run build` → `dist/index.js` bane ✓ · `npm start` app info print ✓ · `timeout 5 npm run dev` (ya background + kill) info print ✓ · `npm run clean` dist hataye ✓.

---

## T0.6 — Frontend scaffold (FRONTEND repo) → commit

1. **Scaffold:** repo me `.git` hai isliye seedha create na karo — scratch/temp folder me: `npm create vite@latest web -- --template react-ts`. Interactive prompt aaye to `CI=true` env ke saath dobara; phir bhi atke to template files manually banao. Generated files (`.git` chhod ke, aur unka `.gitignore` merge karke — hamara T0.2 wala base rahe) repo me copy karo. Template ka demo content (counter, logos, `App.css` demo styles) hata do.
2. **`package.json`**: name `cell-ai-voicebot-frontend`, version `0.0.1`, `"private": true`, `"license": "UNLICENSED"`, `"type": "module"`, `"engines": { "node": ">=24 <25" }`. `.nvmrc` → `24`, `.npmrc` → `engine-strict=true`.
3. **Dependencies:** `react`, `react-dom` (19), `react-router`, `@tanstack/react-query`, `@tanstack/react-query-devtools`, `@mui/material`, `@emotion/react`, `@emotion/styled`, `@mui/icons-material`, `axios`, `zod`, `react-hook-form`, `@hookform/resolvers`, `notistack`. devDeps: template ke + `@types/node`.
4. **TS config:** template ke `tsconfig.app.json` me strict flags add (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`) + `baseUrl`/`paths`: `"@/*": ["./src/*"]`. `tsconfig.node.json` me vite config ke liye `types: ["node"]`.
5. **`vite.config.ts`:** `resolve.alias` `@` → `path.resolve(__dirname, 'src')` (ya `fileURLToPath(new URL('./src', import.meta.url))`); `server: { port: 3100, strictPort: true, proxy: { '/api': { target: 'http://localhost:5100', changeOrigin: true }, '/ws': { target: 'ws://localhost:5100', ws: true } } }`; `preview.port: 3101`.
6. **Folder structure** (`.gitkeep` in khaali):
   ```
   src/
     main.tsx
     App.tsx
     app/        providers.tsx (Theme + CssBaseline + QueryClient + Snackbar), router.tsx
     pages/      HomePage.tsx, NotFoundPage.tsx
     features/
     components/
     layout/
     hooks/
     services/api/  client.ts
     theme/      index.ts
     types/
     utils/
     assets/
     test/       setup.ts (T0.8)
   ```
   `src/README.md`: har folder ka purpose + rules (feature folders me component + hooks + api; shared components `components/`; pages sirf route-level composition).
7. **Theme (`src/theme/index.ts`):** MUI `createTheme` — primary `#1d5fa3` (placeholder brand, comment: "brand colors pending"), secondary teal, light + dark `colorSchemes` support, system font stack, `shape.borderRadius: 8`. Dark mode toggle Phase 2 me.
8. **`app/providers.tsx`:** `ThemeProvider` + `CssBaseline` + `QueryClientProvider` (`QueryClient` defaults: `staleTime: 30_000`, `retry: 1`, `refetchOnWindowFocus: false`) + `SnackbarProvider` (notistack) + `ReactQueryDevtools` sirf `import.meta.env.DEV` me.
9. **`app/router.tsx`:** `createBrowserRouter` — `/` → `HomePage`, `*` → `NotFoundPage`. `App.tsx` = `<Providers><RouterProvider/></Providers>`.
10. **`HomePage`:** MUI `Container` + `Typography` h4 "Cell AI Voicebot" + subtitle "Phase 0 — setup ready" + app version (`import.meta.env.VITE_APP_NAME`). **`NotFoundPage`:** 404 + home link.
11. **`services/api/client.ts`:** axios instance — `baseURL: import.meta.env.VITE_API_URL ?? '/api/v1'`, `timeout: 15000`, `withCredentials: true`; interceptors ke TODO comments (auth Phase 2). Abhi kahin call nahi hoga.
12. **`src/vite-env.d.ts`:** `ImportMetaEnv` typed: `VITE_API_URL`, `VITE_WS_URL`, `VITE_APP_NAME` (sab `string`, readonly).
13. **`index.html`:** `<title>Cell AI Voicebot</title>`, `lang="en"`, meta description, `theme-color`, favicon `public/favicon.svg` (simple: rounded square + phone/sound-wave mark, brand color).
14. **Scripts:**
    ```
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "typecheck": "tsc -b --pretty"
    ```
    (lint/format/test/check aage.)
15. `npm install` → lockfile commit. README: Getting started, scripts, structure, env, docs link (T0.3 point 11), ports (3100, proxy → 5100).

**Commit:** `chore(frontend): scaffold vite react typescript app with mui and react query [P0-T0.6]`

**VERIFY:** `npm run typecheck` ✓ · `npm run build` ✓ (`dist/` bane) · `npm run dev` background me start → `curl -s http://localhost:3100 | grep -i "cell ai voicebot"` ✓ → process band · unknown route (`/xyz`) build me NotFound handle (SPA) — dev server pe `curl` 200 ✓.

---

## T0.7 — Code quality tooling (DONO repos) → commit per repo

1. **Install (devDeps):** `eslint`, `@eslint/js`, `typescript-eslint`, `eslint-plugin-import-x`, `eslint-import-resolver-typescript`, `eslint-config-prettier`, `globals`, `prettier`, `husky`, `lint-staged`, `@commitlint/cli`, `@commitlint/config-conventional`. Frontend me additionally `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh` (template ke purane eslint config ko replace karo, duplicate na rahe).
2. **`eslint.config.js`** (flat; backend me `.mjs` ya `.js` with ESM — backend package `commonjs` hai to **`eslint.config.mjs`**):
   - `ignores`: `dist`, `coverage`, `node_modules`, `poc`, `*.tsbuildinfo`
   - `@eslint/js` recommended + `tseslint.configs.recommendedTypeChecked` with `parserOptions.projectService: true` + `tsconfigRootDir`
   - Config/JS files (`*.config.*`, `eslint.config.*`, `commitlint.config.*`) ke liye `tseslint.configs.disableTypeChecked`
   - `import-x` flat recommended + typescript resolver; rules: `import-x/order` (groups: builtin, external, internal, parent, sibling, index; newlines-between always; alphabetize), `import-x/no-cycle: error`, `import-x/no-duplicates: error`
   - Rules: `@typescript-eslint/no-floating-promises: error`, `@typescript-eslint/no-misused-promises: error`, `@typescript-eslint/no-explicit-any: warn`, `@typescript-eslint/no-unused-vars: [error, { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]`, `@typescript-eslint/consistent-type-imports: error`, `eqeqeq: error`, `no-console: warn` (backend; `scripts/` aur tests me off)
   - Frontend: `react-hooks` recommended, `react-refresh/only-export-components: warn`, `globals.browser`; backend: `globals.node`
   - **Last me** `eslint-config-prettier`
3. **`.prettierrc.json`:** `{ "singleQuote": true, "semi": true, "printWidth": 100, "trailingComma": "all", "arrowParens": "always", "endOfLine": "lf" }` · **`.prettierignore`:** `dist`, `coverage`, `node_modules`, `package-lock.json`, `*.pdf`, `poc/**/output`.
4. **Husky:** `npx husky init` (ye `prepare: husky` script add karta hai) →
   - `.husky/pre-commit`: `npx lint-staged`
   - `.husky/commit-msg`: `npx --no -- commitlint --edit "$1"`
   - Default `npm test` wali line pre-commit se hatao.
5. **`lint-staged`** (package.json me): `"*.{ts,tsx,js,mjs,cjs}": ["eslint --fix --max-warnings=0", "prettier --write"]`, `"*.{json,md,yml,yaml,css,html}": ["prettier --write"]`.
6. **`commitlint.config.mjs`:** extends `@commitlint/config-conventional`; `header-max-length: 120` (task tags ke liye jagah).
7. **`.vscode/settings.json`:** `editor.formatOnSave: true`, `editor.defaultFormatter: esbenp.prettier-vscode`, `editor.codeActionsOnSave: { "source.fixAll.eslint": "explicit" }`, `typescript.tsdk: node_modules/typescript/lib`, `files.eol: "\n"`. **`.vscode/extensions.json`:** recommendations — `dbaeumer.vscode-eslint`, `esbenp.prettier-vscode`, `editorconfig.editorconfig`, `mikestead.dotenv`, `ms-azuretools.vscode-docker`, `mongodb.mongodb-vscode`.
8. **Scripts:** `"lint": "eslint . --max-warnings=0"`, `"lint:fix": "eslint . --fix"`, `"format": "prettier --write ."`, `"format:check": "prettier --check ."`.
9. `npm run format` ek baar poore repo pe (docs bhi) → `npm run lint` clean karo (warnings bhi 0).
10. Configs dono repos me **jitna ho sake same** rakho (difference sirf react/node specific).

**Commits:** backend `chore(tooling): add eslint, prettier, husky, lint-staged and commitlint [P0-T0.7]` · frontend same message.

**VERIFY:**

- `npm run lint` ✓ · `npm run format:check` ✓
- **lint-staged check (commit kiye bina):** ek badly-formatted temp file (`tmp-format-check.ts`) banao → `git add` → `npx lint-staged` chalao → file auto-format hui confirm → `git restore --staged tmp-format-check.ts && rm tmp-format-check.ts` (history me kuch na jaye)
- **commitlint check:** `echo "bad message" | npx commitlint` → **fail** hona chahiye · `echo "chore: valid message" | npx commitlint` → pass
- Is task ka asli commit hooks ke through pass ho (dono repos)

---

## T0.8 — Testing setup (DONO repos) → commit per repo

**Backend:**

1. devDeps: `vitest`, `@vitest/coverage-v8`, `mongodb-memory-server`, `supertest`, `@types/supertest`.
2. **`vitest.config.ts`:** `environment: 'node'`, `include: ['src/**/*.test.ts', 'tests/**/*.test.ts']`, `coverage: { provider: 'v8', reporter: ['text', 'html', 'lcov'], include: ['src/**'], exclude: ['src/**/*.test.ts'] }`, `testTimeout: 30000` (infra test ke liye), `hookTimeout: 120000`.
3. **`src/index.test.ts`:** `getAppInfo()` — name sahi, node `v24` se start, env default `development`.
4. **`tests/infra/mongo-replset.test.ts`:** `MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { version: '8.0.<latest patch jo available ho>' } })` → `mongodb` driver se connect (devDep `mongodb` add karo — mongoose Phase 1 me) → ek **transaction** me 2 collections me insert + commit → count verify → cleanup. Purpose: prove replica set + transactions kaam karte hain (wallet ke liye zaroori).
5. Scripts: `"test": "vitest run"`, `"test:watch": "vitest"`, `"test:coverage": "vitest run --coverage"`.
6. Pehla run MongoDB binary download karega (~100MB) — normal hai; report me time note.

**Frontend:**

1. devDeps: `vitest`, `@vitest/coverage-v8`, `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event`.
2. `vite.config.ts` me `test` block (import `defineConfig` from `vitest/config`): `environment: 'jsdom'`, `setupFiles: ['./src/test/setup.ts']`, `css: false`, coverage v8 same reporters.
3. **`src/test/setup.ts`:** `import '@testing-library/jest-dom/vitest'` + `afterEach(cleanup)`.
4. **`src/test/render.tsx`:** helper `renderWithProviders(ui, { route })` — Theme + QueryClient (retry false) + MemoryRouter / `createMemoryRouter`.
5. **Tests:** `HomePage.test.tsx` — heading "Cell AI Voicebot" dikhe · `NotFoundPage.test.tsx` — 404 text + home link.
6. tsconfig me test types (`vitest/globals` nahi — explicit imports use karo).
7. Same scripts.

**Dono:** `coverage/` gitignored (already). README me Testing section (unit tests file ke paas `*.test.ts(x)`, integration `tests/`, e2e Playwright baad me).

**Commits:** `test: add vitest setup with sample and infra tests [P0-T0.8]` (dono repos).

**VERIFY:** `npm test` ✓ dono · `npm run test:coverage` report bane ✓ · `npm run lint && npm run typecheck` ✓ (test files bhi lint/typecheck me).

---

## T0.9 — Local infra: Docker Compose (BACKEND repo) → commit

1. **`docker-compose.yml`** (project name: `name: cell-ai-voicebot`):
   - **mongo:** image `mongo:8.0`, container_name `cav-mongo`, command `["mongod", "--replSet", "rs0", "--port", "27018", "--bind_ip_all"]`, ports `"127.0.0.1:27018:27018"`, volume `cav-mongo-data:/data/db`, `restart: unless-stopped`, **healthcheck jo replica set init bhi kare:**
     ```
     test: mongosh --port 27018 --quiet --eval "try { rs.status().ok } catch (e) { rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:27018' }] }).ok }"
     interval: 5s
     timeout: 10s
     retries: 20
     start_period: 10s
     ```
   - **redis:** image `redis:7.4-alpine`, container_name `cav-redis`, command `["redis-server", "--appendonly", "yes"]`, ports `"127.0.0.1:6380:6379"`, volume `cav-redis-data:/data`, healthcheck `redis-cli ping` (interval 5s), `restart: unless-stopped`.
   - Named volumes `cav-mongo-data`, `cav-redis-data`. Koi optional UI container nahi (Compass use karenge).
2. **Scripts:**
   ```
   "infra:up": "docker compose up -d --wait",
   "infra:down": "docker compose down",
   "infra:reset": "docker compose down -v",
   "infra:logs": "docker compose logs -f --tail=100",
   "infra:ps": "docker compose ps"
   ```
3. **Connection strings** (README + `.env.example` T0.10):
   - `MONGODB_URI=mongodb://127.0.0.1:27018/cell_ai_voicebot?replicaSet=rs0`
   - `REDIS_URL=redis://127.0.0.1:6380`
   - Agar host se replica set discovery me issue ho to fallback `?directConnection=true` (README me note).
4. README "Local infrastructure" section: commands, ports, Compass connection string, `infra:reset` warning (**saara local data delete**), troubleshooting (port busy → `lsof -i :27018`, Docker daemon band).
5. Risk note `docs/setup/prerequisites.md` me: client ka production DB type abhi unknown — Mongo na ho to apna Mongo (Phase 12).

**Commit:** `chore(infra): add docker compose for mongodb replica set and redis [P0-T0.9]`

**VERIFY:**

- `npm run infra:up` → dono healthy (`npm run infra:ps`)
- `docker exec cav-mongo mongosh --port 27018 --quiet --eval "rs.status().members[0].stateStr"` → `PRIMARY`
- Host se: `docker exec cav-mongo mongosh "mongodb://127.0.0.1:27018/?replicaSet=rs0" --quiet --eval "db.runCommand({ping:1}).ok"` → `1`
- `docker exec cav-redis redis-cli ping` → `PONG`
- `npm run infra:down` → containers band, volumes **bache** (`docker volume ls | grep cav-`)
- Docker daemon unavailable ho to: compose file `docker compose config` se validate + report me blocker.

---

## T0.10 — Env & secrets conventions (DONO repos) → commit per repo

1. **Backend `.env.example`** — groups + har var pe comment (`# used from Phase X`), values placeholder / local-safe defaults:
   ```
   # ── App (Phase 1)
   NODE_ENV=development
   PORT=5100
   APP_URL=http://localhost:5100
   FRONTEND_URL=http://localhost:3100
   CORS_ORIGINS=http://localhost:3100
   LOG_LEVEL=debug
   # ── Data (Phase 1)
   MONGODB_URI=mongodb://127.0.0.1:27018/cell_ai_voicebot?replicaSet=rs0
   REDIS_URL=redis://127.0.0.1:6380
   # ── Auth & security (Phase 2)
   JWT_ACCESS_SECRET=change-me
   JWT_REFRESH_SECRET=change-me
   JWT_ACCESS_TTL=15m
   JWT_REFRESH_TTL=30d
   ENCRYPTION_KEY=change-me-32-bytes-base64
   # ── AI (Phase 5/7)
   OPENAI_API_KEY=
   OPENAI_REALTIME_MODEL=
   # ── Storage (Phase 7/9)
   STORAGE_DRIVER=local
   STORAGE_LOCAL_PATH=./uploads
   S3_BUCKET=
   S3_REGION=ap-south-1
   AWS_ACCESS_KEY_ID=
   AWS_SECRET_ACCESS_KEY=
   # ── Email (Phase 1/2)
   SMTP_HOST=
   SMTP_PORT=587
   SMTP_USER=
   SMTP_PASS=
   MAIL_FROM="Cell AI Voicebot <no-reply@example.com>"
   # ── Payments (Phase 4)
   RAZORPAY_KEY_ID=
   RAZORPAY_KEY_SECRET=
   RAZORPAY_WEBHOOK_SECRET=
   # ── Telephony (Phase 13 / optional)
   NOTIFYNOW_API_KEY=
   SIP_HOST=
   SIP_PORT=5060
   SIP_TRANSPORT=udp
   SIP_USERNAME=
   SIP_PASSWORD=
   SIP_CALLER_ID=
   ```
   Har "secret" line ke upar comment: `# SECRET — kabhi commit nahi`.
2. **Backend local `.env`** (existing khaali file, gitignored): `.env.example` copy karke local-safe values (App + Data group). **Secrets khaali chhodo.** Confirm still ignored.
3. **Frontend `.env.example`:**
   ```
   # ⚠️ VITE_* variables browser bundle me PUBLIC hote hain — inme kabhi secret mat daalna
   VITE_API_URL=/api/v1
   VITE_WS_URL=ws://localhost:3100/ws
   VITE_APP_NAME=Cell AI Voicebot
   ```
   Local `.env.local` (gitignored by `.env.*`) same values ke saath.
4. **`docs/conventions/secrets.md`** (backend repo):
   - Naming: UPPER_SNAKE_CASE; frontend `VITE_` prefix = public
   - Secrets kahan: local `.env` (gitignored) · server env / `.env` file with `chmod 600` · team password manager · **kabhi nahi:** git, docs, chat/WhatsApp, screenshots, logs, error messages
   - Har environment (local / staging / prod) ke alag secrets; prod secrets local me nahi
   - Rotation: leak / doubt pe turant rotate; jo secrets chat me share hue hain (client ka DB password, NotifyNow key) unhe "exposed" maan ke production se pehle rotate karwana — follow-up list me
   - Client SSH key: password manager + local `~/.ssh/` me `chmod 400`; repo me kabhi nahi
   - Phase 1 me zod se env validation (missing required var → app start nahi hoga)
   - Gitleaks / secret scanning CI me (T0.14)
   - New var add karne ka checklist: `.env.example` + comment + README table + (Phase 1+) env schema
5. Dono READMEs me "Environment variables" section: table (var, required?, phase, description) — sirf names, values nahi.

**Commits:** backend `chore(config): add env example and secrets policy [P0-T0.10]` · frontend `chore(config): add env example [P0-T0.10]`

**VERIFY:** `git status` — `.env` / `.env.local` untracked + ignored (`git check-ignore`) · `.env.example` tracked · `grep -rnE "sk-[A-Za-z0-9_-]{20,}|nn_[0-9a-f]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----" --exclude-dir=node_modules --exclude-dir=.git .` → **koi match nahi** (dono repos).

---

## P0-B1-DONE — Final checkpoint

1. **Full verification (dono repos):** `npm ci` → `npm run lint` → `npm run format:check` → `npm run typecheck` → `npm test` → `npm run build` — sab ✓. Backend: `npm run infra:up` → healthy → `npm run infra:down`.
2. **Fresh-clone test:** temp folder me dono repos `git clone <local path>` (feature branch) → README ke steps follow → `npm ci && npm run lint && npm run typecheck && npm test && npm run build` pass → temp folder delete.
3. `docs/phases/PHASE_0_TASKS.md` me T0.1–T0.10 `[x]`; `CHANGELOG.md` `[Unreleased]` me batch 1 items.
4. `grep` checks: secrets (T0.10 verify), stale decisions (T0.3 point 4).
5. Commit (backend): `docs: mark phase 0 batch 1 complete [P0-B1-DONE]` (frontend me kuch badla ho to same message).
6. **Koi push / merge nahi.**

---

## FINAL REPORT (chat me, is format me)

1. **Summary** — har task (T0.1–T0.10): ✅ done / ⚠️ partial / ❌ blocked + 1 line.
2. **Commits** — dono repos ka `git log --oneline` (feature branch).
3. **Versions installed** — Node, npm, TypeScript, Vite, React, MUI, React Router, React Query, zod, ESLint, typescript-eslint, Prettier, Vitest, Husky, MongoDB image, Redis image.
4. **Deviations** — plan / is prompt se kuch alag kiya to kya aur kyun.
5. **Verification results** — har VERIFY ka pass/fail.
6. **Manual steps for user** — push (`git push -u origin main dev feature/phase-0-setup` dono repos), GitHub branch protection (T0.14 ke baad), OpenAI key, password manager, SSH key `chmod 400`, VS Code extensions, Mantis license confirm (ADR 0011), exposed secrets rotate list.
7. **Risks / open items** — next batch (T0.11–T0.14) ke liye notes.

---

## MUST-NOT-MISS CHECKLIST (ek bhi cheez na chhoote)

- [ ] Backend ki existing khaali `.env` **kabhi commit na ho** (har commit se pehle `git status`)
- [ ] Dono repos me `main` (1 initial commit) + `dev` + `feature/phase-0-setup`; baaki kaam sirf feature branch pe
- [ ] Har task ka alag commit with `[P0-T0.x]` tag; commitlint pass
- [ ] Node **24** har jagah (`.nvmrc`, `engines`, docs, ADR 0002) — "Node 20" kahin active docs me na bache
- [ ] Ports **5100 / 3100 / 27018 / 6380** har jagah consistent (vite proxy, `.env.example`, compose, README, ADR 0028, docs)
- [ ] Mongo **replica set** init ho + transaction test pass (T0.8 infra test)
- [ ] Backend tsconfig: base (noEmit, no rootDir) + build (rootDir/outDir) split — tests typecheck hon
- [ ] `src/index.ts` package.json import na kare
- [ ] Frontend scaffold temp folder me, phir copy — `.git` overwrite na ho
- [ ] Template demo content (counter, logos, demo CSS) hataya
- [ ] ESLint type-aware + config files ke liye disableTypeChecked; `--max-warnings=0` pass
- [ ] Husky hooks executable (`chmod +x` agar zaroori) + pre-commit me default `npm test` line hati
- [ ] `.vscode/settings.json` + `extensions.json` tracked (gitignore exception kaam kare)
- [ ] Docs sirf `.md` repo me copy, PDFs nahi; parent `docs/` delete nahi
- [ ] ADR 0011 me Mantis license finding + "copy nahi jab tak confirm"
- [ ] 28 ADRs + template + index, sab sections filled
- [ ] `.env.example` dono repos, har secret placeholder, VITE_ public warning
- [ ] `docs/client/answers.md` me koi secret value nahi
- [ ] Secret grep → 0 matches
- [ ] Fresh-clone test pass
- [ ] PHASE_0_TASKS + CHANGELOG updated
- [ ] No push, no merge, no client server, no AutoChatix edits, no sudo, no global installs
