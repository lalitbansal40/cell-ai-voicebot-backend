# Backend source layout

Module-based structure (see [ADR 0003](../docs/adr/0003-backend-code-structure.md)).

| Folder                | Purpose                                                                                      | Filled in    |
| --------------------- | -------------------------------------------------------------------------------------------- | ------------ |
| `index.ts`            | Process entry point (Phase 0: prints app info; Phase 1: starts HTTP + WS server)             | Phase 0 / 1  |
| `openapi.ts`          | Assembles the OpenAPI 3.1 document from all module schemas (`npm run gen:openapi`)           | Phase 0+     |
| `config/`             | Env schema (zod), constants, app config                                                      | Phase 1      |
| `shared/errors/`      | App error classes, error codes catalogue                                                     | Phase 1      |
| `shared/middlewares/` | Express middlewares (auth, validation, request ID, rate limit…)                              | Phase 1–2    |
| `shared/utils/`       | Generic helpers (money, phone, dates, crypto…)                                               | Phase 1+     |
| `shared/types/`       | Cross-module TypeScript types                                                                | Phase 1+     |
| `shared/openapi/`     | OpenAPI registry, extended `z`, common envelope/pagination schemas (ADR 0029)                | Phase 0 / 1+ |
| `core/engine/`        | Call flow engine (graph runtime)                                                             | Phase 6      |
| `core/voice/`         | Call session manager, audio bridge, voice AI adapters                                        | Phase 7      |
| `core/telephony/`     | `TelephonyProvider` interface + WebCall / SIP / NotifyNow providers                          | Phase 7, 13  |
| `core/queues/`        | BullMQ queues and workers                                                                    | Phase 8      |
| `core/billing/`       | Wallet core: hold / capture / release, atomic debits                                         | Phase 4      |
| `modules/auth/`       | Signup, login, tokens, password reset                                                        | Phase 2      |
| `modules/accounts/`   | Tenant accounts, settings                                                                    | Phase 2      |
| `modules/users/`      | Users, roles, team                                                                           | Phase 2      |
| `modules/contacts/`   | Contacts, lists, custom fields, imports, DND                                                 | Phase 3      |
| `modules/wallet/`     | Wallet API, ledger, top-ups, invoices                                                        | Phase 4      |
| `modules/ai-agents/`  | AI agent configs, knowledge base, functions                                                  | Phase 5      |
| `modules/flows/`      | Call flows + versions (builder API)                                                          | Phase 6      |
| `modules/campaigns/`  | Campaigns, scheduling, results                                                               | Phase 8      |
| `modules/calls/`      | Call records, transcripts, recordings                                                        | Phase 7, 9   |
| `modules/webhooks/`   | Outbound webhooks + inbound provider webhooks                                                | Phase 10     |
| `modules/public-api/` | API-key authenticated public API                                                             | Phase 10     |
| `modules/system/`     | System endpoints (`GET /api/v1/system/info`); schema documented in Phase 0, route in Phase 1 | Phase 0 / 1  |
| `jobs/`               | Scheduled / cron jobs                                                                        | Phase 4+     |
| `db/`                 | Connection, indexes, seeds, migrations                                                       | Phase 1      |

Outside `src/`: `tests/` (integration tests), `scripts/` (one-off scripts), `poc/` (proofs of concept, not built).

## Module file convention

Each module in `modules/<feature>/` uses these files (as needed):

- `<feature>.routes.ts` — Express router, wires middlewares + controller
- `<feature>.controller.ts` — HTTP layer: parse request, call service, shape response
- `<feature>.service.ts` — business logic (the only place for it)
- `<feature>.model.ts` — Mongoose model
- `<feature>.schema.ts` — zod schemas (request validation, OpenAPI)
- `<feature>.types.ts` — module types
- `<feature>.test.ts` — unit tests next to the code

**Layering rule:** routes → controller → service → model. No business logic in routes or controllers.
