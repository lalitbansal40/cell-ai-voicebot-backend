# <PHASE/BATCH> RUN — <Title> — Autonomous Run Prompt (Template)

> **HOW TO RUN (ise paste karo):**
> `docs/prompts/<FILE>.md padho aur <first task> se <DONE marker> tak SAARE tasks step by step autonomously implement karo. Bich me koi question mat poochho, permission mat maango — saare decisions is prompt me pre-made hain. Har task ke baad verify + commit (tag [<TAG>]). Koi push / merge NAHI. Ant me <DONE marker> checkpoint + final report.`
>
> **Claude Code "accept edits" mode me chalao.** Working directory: `<path>`

---

## 0. Context (verified facts — dobara derive mat karna)

- Phase / task IDs:
- Related docs (plan, ADRs, conventions):
- Repos + branch to work on:
- Current state (what already exists, what earlier phases provide):
- Relevant files / modules:

## 1. Goal

<What must be true at the end — 2–5 lines.>

## 2. Scope

**In scope:**

- …

**Out of scope (do NOT do):**

- …

## 3. Locked decisions

| Topic | Decision | Note |
| ----- | -------- | ---- |
| …     | …        | …    |

## 4. Rules of engagement

1. No questions / no permission requests — choose the safe, plan-consistent option and report it.
2. Git: one commit per task per repo, Conventional Commit + `[<TAG>]`; no push, no merge.
3. No secrets in code, docs, commits, logs or report.
4. Tenant scoping: every query scoped by `accountId` (Phase 1+).
5. Every new env var → `.env.example` + README table + env schema.
6. Verify after every task (lint, typecheck, tests, build) before committing.
7. Stay inside scope; follow ADRs and conventions in `docs/`.

## 5. Resume safety

- Check `git branch --show-current` + `git log --oneline -20`; continue from the task after the last `[<TAG>]` commit.

## 6. Tasks

### <TASK-ID> — <title>

**Steps:**

1. …

**VERIFY:**

- …

**Commit:** `<type>(<scope>): <message> [<TAG>]`

## 7. Tests required

- Unit: …
- Integration: …

## 8. Final checkpoint

- Full verification in all touched repos.
- Update task tracker + CHANGELOG.
- `<DONE marker>` commit.

## 9. Final report format

1. Summary per task (✅ / ⚠️ / ❌ + 1 line)
2. Commits (`git log --oneline`)
3. Versions / dependencies added
4. Deviations + reasons
5. Verification results
6. Manual steps for user
7. Risks / open items

## 10. Must-not-miss checklist

- [ ] …
