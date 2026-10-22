# Phase 9 — Tasks (tracker)

Plan: [PHASE_9_PLAN.md](PHASE_9_PLAN.md) · Overview: [BUILD_PLAN_V2.md](../plans/BUILD_PLAN_V2.md)

| ✓   | #     | Task                                                                                                                                                                     | Repo | Size |
| --- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ---- |
| [x] | T9.1  | Models (WhatsAppChannel, MetaWebhookEvent, MetaDeletionRequest), migration 0010, `WHATSAPP_LIMITS`, env + production rules, codes, audit, WS, notifications, permissions | BE   | M    |
| [x] | T9.2  | `src/core/meta`: MetaClient (Graph + fake), signatures (`X-Hub-Signature-256`, `signed_request`), schemas + Meta fixtures                                                | BE   | M    |
| [x] | T9.3  | Channel service: Embedded Signup connect (verify, discovery, subscribe, register), reconnect, retry setup, PIN, sync, rename, disconnect, statuses                       | BE   | L    |
| [x] | T9.4  | Webhook pipeline: verify, signature, event store, queue + worker, routing, Phase 9 handlers, deferred fields, retries                                                    | BE   | L    |
| [x] | T9.5  | Health job + notifications, deauthorize / data deletion callbacks, superadmin (status, events + replay, force disconnect, manual connect), simulator                     | BE   | M    |
| [x] | T9.6  | API routes + OpenAPI + rate limits, seed, `dev:whatsapp`                                                                                                                 | BE   | M    |
| [x] | T9.7  | Hardening, ADR 0037, `docs/setup/meta-whatsapp.md`, docs                                                                                                                 | BE   | M    |
| [x] | T9.8  | FE foundation: clients, hooks, WS, nav (`LIVE_PHASE = 9`, renumber), routes, Meta SDK loader + session listener, Test signup dialog                                      | FE   | M    |
| [x] | T9.9  | WhatsApp → Numbers: empty state, connect wizard, cards, drawer, actions, live updates, roles                                                                             | FE   | L    |
| [x] | T9.10 | Superadmin pieces, Admin WhatsApp status, notifications, dashboard card, `/data-deletion` page, bundle check                                                             | FE   | M    |
| [x] | T9.11 | Playwright E2E (connect, outcomes, roles, Meta endpoints) — twice                                                                                                        | FE   | M    |
| [x] | T9.12 | Gap audit, security checklist, docs, Phase 9 sign-off                                                                                                                    | both | M    |

**Done when:** Owner test mode me Connect WhatsApp se number connect kare → Connected + quality + limit + display name; signed webhook events live card update karen + bell; token invalid → Needs reconnect → reconnect; disconnect; roles — Playwright se proven; real Meta ke liye setup doc + env rules ready.
