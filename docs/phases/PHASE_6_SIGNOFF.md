# Phase 6 — Sign-off

**Date:** 2026-10-12 · **Branch:** `feature/phase-6-flows` (both repos, not merged) · **Plan:** [PHASE_6_PLAN.md](PHASE_6_PLAN.md) · **Tracker:** [PHASE_6_TASKS.md](PHASE_6_TASKS.md) · **ADR:** [0034](../adr/0034-call-flow-engine.md)

**Verdict:** ✅ Phase 6 (call flow engine & builder) complete — all 15 tasks done. **"Done when"** (the Loan recovery flow is built in the builder and every branch — press 1, press 2, the AI path — runs in the simulator) is proven by Playwright `e2e/flows-loan.spec.ts` (frontend repo): the flow is created from the template with the recovery agent, has 0 errors and is published as v1; in the simulator the paid contact presses 1 and is thanked (Paid), the unpaid contact presses 1, is handed to the AI and promises for tomorrow (IST), 2 queues the payment-link SMS (Promise to pay), 3 talks to the AI, and silence / wrong keys end in the callback branch while the canvas highlight follows. **Phase 7 can start.** Everything runs on the deterministic fake AI provider and the mock payment API until the client inputs in §8 arrive. Merging `feature/phase-6-flows` (both repos) is a project-lead decision after review.

## 1. Tasks — "Done when" check

| Task                                       | Status | Evidence (commit; fe = frontend repo) | Notes                                                                                                                                                                  |
| ------------------------------------------ | ------ | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T6.1 Models, migration 0007, catalogue     | ✅     | `4c67ac1`                             | flows (embedded draft + revision), immutable versions, runs (30-day TTL), node stats, audio; `FLOW_LIMITS`; 2 error codes (41), 11 audit actions (68), 2 WS events     |
| T6.2 Graph schema, catalogue, templating   | ✅     | `29ea72a`                             | 15 node configs, named exits, palette catalogue, canonical checksum, variables, conditions, Hinglish + Devanagari intents; Phase 5 templating moved unchanged          |
| T6.3 Validator                             | ✅     | `891d151`                             | 23 issue codes incl. silent loops (SCC), address rules, missing agents / audio; every code reachable by a test                                                         |
| T6.4 Flows API                             | ✅     | `79a1ccf`                             | CRUD, revision-checked saves with sealed secrets, validate, publish / versions / restore, duplicate, archive, delete, import / export, 4 templates, agent in-use guard |
| T6.5 Audio library                         | ✅     | `6aff4eb`                             | WAV / MP3 probes, limits, signed playback, in-use guard, purge                                                                                                         |
| T6.6 Engine interpreter                    | ✅     | `8e5216a`                             | `advance()` with JSON state, node handlers, gather retries, guards, error handler, trace, stats; seeded fuzz                                                           |
| T6.7 Effects + billing                     | ✅     | `89c660d`                             | API node on the SSRF guard, AI agent node on `runAgentTurn` (`flow_simulator`), AI intents (`flow_intent`)                                                             |
| T6.8 Simulator API                         | ✅     | `9003358`                             | draft snapshot / published / version, contact or manual values, idempotent inputs, transcript, trace, cost, stats, rate limit                                          |
| T6.9 Templates, seed, OpenAPI, ADR, bench  | ✅     | `fb711f1`                             | seed (published Loan recovery, draft survey, welcome audio), ADR 0034, `bench:flow`, docs                                                                              |
| T6.10 FE foundation                        | ✅     | `b9baf54` (fe)                        | deps, clients, routes, `LIVE_PHASE = 6`, WS, shared fields, graph reducer + undo / redo, layout                                                                        |
| T6.11 FE list, templates, import, versions | ✅     | `2cf76d4` (fe), `bc7af3b`             | flows list, template picker with agent pick / create, import / export, versions page, agent "used in flows"                                                            |
| T6.12 FE builder canvas                    | ✅     | `e6b8df1` (fe)                        | palette, steps with named handles, problems list, save / conflict, publish, read-only modes, copy / paste, auto-layout, shortcuts                                      |
| T6.13 FE inspector forms                   | ✅     | `16a03c0` (fe)                        | settings for all 15 step types, flow settings and variables dialogs, audio upload / play, agent / API editors                                                          |
| T6.14 FE simulator + stats                 | ✅     | `08ae782` (fe)                        | simulator panel, canvas highlight, history, run detail page, stats overlay                                                                                             |
| T6.15 E2E, audit, docs, sign-off           | ✅     | this commit + fe `13d8e43`            | 11 Playwright flow tests (32 total, green twice), gap + security audit, docs                                                                                           |

Batch checkpoints: `a6874c1` `[P6-B1-DONE]`, `c161915` `[P6-B2-DONE]`, `[P6-B3-DONE]` (the commit that fills §6). Run prompt: [PHASE_6_PROMPT.md](../prompts/PHASE_6_PROMPT.md).

## 2. Deliverables checklist (PHASE_6_PLAN §4)

- [x] Flows with embedded draft (revision-checked saves), immutable published versions, restore, duplicate, archive, delete guard, import / export JSON.
- [x] 15 node types with typed configs, named exits, error exits, defaults and limits; shared catalogue for the builder.
- [x] Validator with all §1e rules; publish blocked on errors.
- [x] Engine interpreter (pure core + injected effects), loop guard, max duration, error handler, trace, node stats — Phase 7-ready state.
- [x] `ai_agent` node on Phase 5 agents (exits from outcomes, billing, caps), `api_request` node on the Phase 5 secure executor, AI / keyword intents.
- [x] Text simulator API (idempotent inputs, snapshots, transcript, trace, cost).
- [x] Audio library (WAV / MP3, duration checks, preview).
- [x] 4 templates + seed; `isAgentInUse` live; agent delete guard.
- [x] UI: flows list, template picker, builder (palette, nodes, inspector, validation, auto-layout, undo / redo, copy / paste, conflict handling), versions, simulator panel, stats overlay, read-only modes.
- [x] Docs: ADR 0034 (+ ADR 0014 follow-up), data-model, conventions (api, security, data, websocket, audit, errors), READMEs, CHANGELOGs, sign-off.

## 3. Requirement → test mapping (gap audit)

Backend tests live in `tests/flows/`, `tests/engine/` and next to the engine code (`src/core/engine/*.test.ts`); frontend unit tests next to the code; Playwright specs in the frontend `e2e/`.

| Requirement (PHASE_6_PLAN)                                                                  | Tests                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §1a draft + revision, 409 with who saved, immutable versions, restore, duplicate, archive   | `flows-api.test.ts` (saves, stale revision, archive / delete), `versions.test.ts` (publish, immutable, restore), fe `builder.test.tsx` (conflict dialog), E2E builder + versions  |
| §1b graph format, handles, positions, limits, canonical checksum                            | `schema.test.ts`, `exits.test.ts`, `canonical.test.ts`, `catalog.test.ts`, `validate.test.ts` (too-large graph)                                                                   |
| §1c variables (contact / flow / system), server-only `{{contact.phone}}`, rendering         | `variables.test.ts`, `render.test.ts`, `validate.test.ts` (unknown tokens, server-only tokens), `simulator-api.test.ts` (manual values)                                           |
| §1d 15 node types and their behaviour                                                       | `nodes.test.ts` (every type), `engine.test.ts`, fe `basic-forms` / `gather-ai-forms` / `logic-forms` tests                                                                        |
| §1e validation rules, publish blocked on errors                                             | `validate.test.ts` (every code reachable), `versions.test.ts` (422 `FLOW_INVALID`), fe `builder.test.tsx` (unsaved Validate), E2E logic (blocked address)                         |
| §1f interpreter: inputs, retries, guards, max duration, error handler, trace, stats         | `engine.test.ts`, `fuzz.test.ts` (300 graphs × 50 inputs), `stats.test.ts`                                                                                                        |
| §1g `ai_agent` exits from outcomes, billing per input, caps / wallet fallbacks              | `nodes.test.ts`, `effects.test.ts`, `simulator-done-when.test.ts`, E2E loan (AI promise) + roles (wallet row "Flow simulator")                                                    |
| §1g `api_request` on the SSRF guard, sealed secrets, failure / error exits                  | `effects.test.ts` (metadata IP, timeout, bad JSON, secrets), `nodes.test.ts`, E2E logic (500 → Failure edge, secret never exported)                                               |
| AI / keyword intents (Hinglish + Devanagari), AI classifier billed once                     | `intents.test.ts`, `intent-ai.test.ts`, `effects.test.ts`, `nodes.test.ts`, E2E logic (speech intents)                                                                            |
| §1h audio library: probes, limits, signed URL, in-use guard, isolation                      | `audio-probe.test.ts`, `flow-audio.test.ts`, `effects.test.ts` (account only), `flows-api.test.ts` (foreign audio → `audio_missing`, added in T6.15), E2E versions (WAV played)   |
| §1i simulator: snapshots, idempotent inputs, transcript, trace, cost, history, rate limit   | `simulator-api.test.ts`, fe `simulator.test.tsx` (retry with the same id), `simulation-page.test.tsx`, E2E loan + roles                                                           |
| §1j templates + seed                                                                        | `templates.test.ts`, `seed-flows.test.ts`, E2E loan ("Done when")                                                                                                                 |
| §1k pricing: `flow_simulator` / `flow_intent` ledger kinds, money only via `chargeUsage`    | `effects.test.ts`, `simulator-done-when.test.ts`, `tests/security/money-writes.test.ts`, E2E roles (ledger drawer)                                                                |
| §1l builder UI (palette, connect, inspector, undo / redo, copy / paste, auto-layout, stats) | fe `graph.test.ts`, `builder.test.tsx`, `builder-props.test.tsx`, inspector tests, E2E builder (drag connections, layout, reload, conflict)                                       |
| §1m permissions: viewer / agent read-only, impersonation, suspended accounts                | `flows-api.test.ts`, `versions.test.ts`, `simulator-api.test.ts`, `flow-audio.test.ts`, fe page tests, E2E roles                                                                  |
| §1n tenant isolation (flows, runs, agents / audio inside graphs, contacts)                  | `flows-api.test.ts` ("another account", foreign agent / audio), `simulator-api.test.ts` (foreign runs / contacts), `import-export.test.ts`, `tests/security/tenant-scope.test.ts` |
| Hostile import (huge, unknown types, prototype keys), export without secrets                | `import-export.test.ts` ("refuses hostile or wrong files", forbidden keys deeply), E2E logic (exported file has no secret)                                                        |
| Agent in use can't be deleted / purged                                                      | `agents-in-use.test.ts`, E2E roles                                                                                                                                                |
| Logs never carry texts, customer words, phones or secrets                                   | `simulator-api.test.ts` (request logs), `engine.test.ts` (call-mode trace), E2E log grep (§6)                                                                                     |

Gap found and closed in T6.15: a graph saved with **another account's audio id** had no API-level test (the effect was already account-scoped) — `flows-api.test.ts` now proves `audio_missing`, no name leak and a refused simulation.

## 4. Numbers

|                                                     | Before (Phase 5)              | After                         |
| --------------------------------------------------- | ----------------------------- | ----------------------------- |
| Backend tests                                       | 1526                          | 1865                          |
| Frontend tests                                      | 478                           | 614                           |
| Playwright                                          | 21                            | 32 (green twice)              |
| Backend coverage (stmts / branches / funcs / lines) | 97.1 / 88.31 / 96.61 / 98.13  | 97.27 / 88.93 / 97.26 / 98.23 |
| Frontend coverage                                   | 95.64 / 90.21 / 92.71 / 96.45 | 95.62 / 90.28 / 93.25 / 96.52 |

Engine bench (`npm run bench:flow`, 149 nodes, 10,000 `advance` calls): p50 77 µs · p95 96 µs · p99 163 µs; `validateFlow` on the largest graph 2.3 ms.

Bundle (frontend, gzip of everything `index.html` loads, same method on both builds): `main` 429.1 KB → branch 438.2 KB (**+9.1 KB**). The builder is its own lazy chunk (`FlowBuilderPage`, 92 KB gzip) and never loads on other pages; no React Flow / dagre code in the initial chunks.

Coverage gates stay at backend 95 / 85 / 95 / 95 and frontend 95 / 90 / 90 / 95 — the new values rounded down to 5 equal the current gates (never lowered).

## 5. Deviations from the plan

All recorded in the [plan changelog](PHASE_6_PLAN.md#changelog) (batch 1, 2 and 3 entries). In short: stats counter field `errorCount`; incomplete node configs are saved as issues (only the graph shape is 422); no `connected` handle on transfer; template graphs authored in T6.4; duplicate / import naming; agent delete 409 while a flow uses it; engine files under `src/core/engine/`; unconnected AI exits fall back to `resolved`; simulator history visible to every `flows.read` user; bundle growth **+9.1 KB** over the 5 KB target (the flows list / new / versions / run pages are eager — lazy-splitting them saved only ~2 KB because shared UI code moved into preloaded chunks); a refused agent delete names the flows in a snackbar, not a dialog; builder E2E runs at a 1600 × 1000 desktop viewport.

Real bugs found and fixed (each with a regression test): `extraPorts` copied before the port was known (backend) · duplicate names "(copy) (copy 2)" (backend) · the reducer trimmed step names while typing (fe) · **found by Playwright:** clicking a step on the canvas never selected it (controlled nodes dropped "select" changes) · new palette steps stacked on top of each other and under the settings panel · restoring a version opened the old cached draft · Validate results were hidden while there were unsaved changes · an emptied number field became 0 (found while testing the forms).

## 6. Verification (P6-B3-DONE)

Filled by the `[P6-B3-DONE]` checkpoint commit.

## 7. Remaining TODOs (by phase)

- **Phase 7 (voice runtime):** host for `advance()` on live calls (map `say` / `play` / `listen_*` / `transfer` / `hangup` actions to the media server, timers as inputs, barge-in from `interruptible`); live built-ins; TTS and audio conversion (8 kHz μ-law) for `play_audio`; `call`-mode stats and traces (texts already redacted); `maxCallDurationSec` of AI nodes.
- **Phase 8 (campaigns):** `isFlowInUse` from campaigns (a stub today; the flow delete guard and the purge already call it), campaigns pin a `flowVersionId`; callbacks and promise follow-ups from flow outcomes.
- **Phase 9 (reports):** per-node funnel reports from `flow_node_stats` (call mode), dispositions and outcomes per flow version.
- **Phase 10 (integrations):** actually send the queued SMS (DLT) / WhatsApp messages; `api` trigger for flows.
- **Phase 13 (transfer):** real transfers and queues behind `transfer_to_agent`.
- **Phase 14 (inbound):** map inbound numbers to flows (`inbound` trigger).

## 8. Client / business inputs still pending

- Real IVR script and texts (Hindi / English / Hinglish), menu keys; the company name customers hear.
- Custom field names for amount / due date / loan id (defaults `amount`, `due_date`, `loan_id` become flow variables when missing — an empty value leaves a gap in the greeting).
- The client's payment-status API (URL, auth, response) to replace the mock.
- Human transfer numbers / queues (template placeholder `+919000000000`).
- SMS DLT templates, WhatsApp templates, payment-link format.
- Pre-recorded audio vs TTS for the main prompts; max call duration (default 900 s).
- From earlier phases: OpenAI API key, SIP trunk, SMTP + sending domain, server SSH key.

## 9. Go / no-go for Phase 7

**Go.** Flows are built, validated, versioned and simulated end to end; the engine is a pure state machine with injected effects, so the Phase 7 voice host only maps its actions to the media server. Open items are client inputs and live providers (§8), none of which block the voice runtime work on the fake provider and the local SIP lab.
