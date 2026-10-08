# Secrets & Environment Variables Policy

## Naming

- Env vars use `UPPER_SNAKE_CASE`.
- Frontend vars must start with `VITE_` — **these are bundled into the browser and are public**. Never put a secret in a `VITE_*` variable.
- Every variable is documented in the repo's `.env.example` (with the phase that starts using it) and in the README env table.

## Where secrets live

| ✅ Allowed                                                | ❌ Never                            |
| --------------------------------------------------------- | ----------------------------------- |
| Local `.env` / `.env.local` (gitignored)                  | Git (any branch, any commit)        |
| Server env vars, or a server `.env` file with `chmod 600` | Docs, README, ADRs, plans, prompts  |
| Team password manager (source of truth)                   | Chat / WhatsApp / email             |
| CI secrets store (GitHub Actions secrets)                 | Screenshots, screen shares          |
|                                                           | Logs, error messages, API responses |

## Environments

- Each environment (local / staging / production) has **its own** secrets.
- Production secrets are never copied to a laptop or used locally.
- `.env.example` only holds placeholders (`change-me`, empty) or local-safe defaults (localhost URLs).

## Rotation

- Rotate immediately on any leak or doubt (committed by mistake, shared in chat, ex-team member, compromised machine).
- Secrets already shared over chat/WhatsApp are treated as **exposed** and must be rotated **before production**:
  - [ ] Client DB password (shared over WhatsApp)
  - [ ] NotifyNow API key (shared in a chat message)
  - [ ] Client SSH key (shared as a file over WhatsApp) — ask the client to issue a new key pair for production access
- After rotation, update the password manager and the server env; never the repo.

## Client SSH key

- Store in the password manager and locally in `~/.ssh/` with `chmod 400`.
- Never copy it into a repo folder (`*.pem`, `*.key`, `id_rsa*` are gitignored as a safety net, not as permission).

## Validation

- The backend validates env vars with a zod schema at startup — implemented in `src/config/env.ts` (Phase 1). A missing or invalid required variable stops the app with an error listing variable **names** (never values). Production additionally requires JWT secrets ≥ 32 chars (no `change-me` placeholders), a 32-byte base64 `ENCRYPTION_KEY`, explicit URLs and CORS origins.

## Leak prevention

- `.gitignore` covers `.env`, `.env.*` (except `.env.example`), `*.pem`, `*.key`, `*.p12`, `id_rsa*`.
- CI adds secret scanning (gitleaks / GitHub secret scanning) in T0.14.
- Before committing, check `git status` — a `.env` file must never appear as staged.

## Checklist: adding a new env var

1. Add it to `.env.example` with a comment (purpose + phase) and `# SECRET — kabhi commit nahi` if it is a secret.
2. Add it to the README "Environment variables" table (name, required?, phase, description — never the value).
3. Add it to the env zod schema (Phase 1+), with a sensible default only if it is not a secret.
4. Add the real value to the password manager and each environment's server env.
