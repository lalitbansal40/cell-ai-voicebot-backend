# 0001 — Repo structure

- **Status:** accepted
- **Date:** 2026-10-08

## Context

The product has a Node API and a React dashboard that deploy and scale differently. Both GitHub repos (`cell-ai-voicebot-backend`, `cell-ai-voicebot-frontend`) already exist. We also need one versioned home for plans and decisions.

## Options considered

1. **Two repos (backend, frontend)** — matches existing GitHub repos and AutoChatix; independent CI/deploys. Cross-repo changes need two PRs.
2. **Monorepo (npm workspaces)** — shared types and atomic changes. Requires restructuring the existing repos and more tooling.
3. **Third docs repo** — clean separation, but one more repo to keep in sync.

## Decision

Keep **two repos**. All project docs (plans, ADRs, conventions, prompts) live in the **backend repo `docs/`** folder; the frontend README links there. Type sharing is handled via OpenAPI generation (T0.12), not a shared package.

## Consequences

- **Positive:** no restructuring; each app has its own pipeline.
- **Negative / trade-offs:** a feature touching both apps needs coordinated PRs.
- **Follow-ups:** shared types strategy in T0.12.
