# 0003 — Backend code structure

- **Status:** accepted
- **Date:** 2026-10-08

## Context

AutoChatix uses a layer-based layout (`controllers/`, `services/`, `models/` with 70+ files each), which makes features hard to find and own. This product has clear domains (contacts, wallet, flows, calls…) plus heavy shared runtime pieces (flow engine, voice, telephony, queues).

## Options considered

1. **Layer-based** (AutoChatix style) — familiar, but features are scattered across folders.
2. **Module-based** — each feature owns its routes/controller/service/model/schema; shared runtime in `core/`.

## Decision

**Module-based**: `src/modules/<feature>/` (`*.routes.ts`, `*.controller.ts`, `*.service.ts`, `*.model.ts`, `*.schema.ts`, `*.types.ts`, `*.test.ts`), cross-cutting runtime in `src/core/` (engine, voice, telephony, queues, billing), generic helpers in `src/shared/` (errors, middlewares, utils, types), plus `config/`, `jobs/`, `db/`. Layering rule: routes → controller → service → model; business logic only in services.

## Consequences

- **Positive:** features are self-contained and easy to navigate.
- **Negative / trade-offs:** need discipline to keep `shared/` from becoming a dumping ground.
- **Follow-ups:** folder purposes documented in `src/README.md`.
