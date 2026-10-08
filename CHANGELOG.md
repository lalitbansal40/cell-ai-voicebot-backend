# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Phase 0 · Batch 1 (T0.1–T0.10)** — 2026-10-08
  - Repo hygiene: `.gitignore`, `.gitattributes`, `.editorconfig`, PR template; branches `main` → `dev` → `feature/phase-0-setup` (both repos).
  - Docs home in `docs/` (plans, phases, prompts, ADRs, conventions, setup, client, PoC/cost/compliance placeholders); task tracker; task prompt template; Definition of Done.
  - 28 Architecture Decision Records (`docs/adr/`).
  - Backend scaffold: Node 24 + TypeScript 6 (strict, NodeNext/CommonJS), module-based folder structure, `tsx` dev runner.
  - Frontend scaffold (separate repo): Vite 8 + React 19 + MUI 9 + React Router 8 + React Query + notistack.
  - Tooling (both repos): ESLint 9 (type-aware) + Prettier + Husky + lint-staged + commitlint.
  - Tests: Vitest (backend unit + MongoDB replica-set transaction smoke test via mongodb-memory-server; frontend RTL page tests).
  - Local infra: Docker Compose with MongoDB 8.2 single-node replica set (27018) and Redis 7.4 (6380).
  - `.env.example` (both repos) and secrets policy.

### Changed

- Plan updates: Node 20 → 24 LTS (Node 20 EOL), MongoDB 8.0 → 8.2 (8.0 fails on Linux kernel ≥ 6.19), ports → 5100/3100/27018/6380, React 18 → 19, ESLint 10 → 9 (plugin peer compatibility), TypeScript 7 → 6.0 (typescript-eslint support).
