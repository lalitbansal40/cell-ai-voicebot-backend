# Phase 15 — Tasks (tracker)

Plan: [PHASE_15_PLAN.md](PHASE_15_PLAN.md) · Branch: `feature/phase-15-integrations`

| ✓   | #      | Task                                                                                                                                      | Repo | Size |
| --- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---- |
| [ ] | T15.1  | Public API foundation: scopes, session-or-key guard on existing routes, per-key limits, request log, IP allowlist / expiry, `externalRef` | BE   | L    |
| [ ] | T15.2  | Public send + trigger routes: contacts upsert / bulk, messages text / template, WhatsApp call trigger, templates read                     | BE   | M    |
| [ ] | T15.3  | Webhook core: outbox, endpoints, signing + rotation, delivery queue, retries, auto-disable, replay, test event                            | BE   | L    |
| [ ] | T15.4  | Event wiring for the whole catalogue, personal-data filter, external-client integration test                                              | BE   | M    |
| [ ] | T15.5  | Post-call WhatsApp: flow step sends, outcome rules, scheduler, guards, call-page rows                                                     | BE   | L    |
| [ ] | T15.6  | Google Sheets import (published CSV, scheduled), Apps Script receiver, Zapier / Make / n8n docs                                           | BE   | M    |
| [ ] | T15.7  | Frontend: Developers, Webhooks, After the call, Sheet imports, flow Send WhatsApp step, call-page card                                    | FE   | L    |
| [ ] | T15.8  | Docs page + guides + tested signature samples + mocks                                                                                     | both | M    |
| [ ] | T15.9  | Seeds, Playwright specs, perf (1,000 webhooks / min), security tests                                                                      | both | M    |
| [ ] | T15.10 | Gap audit, ADR 0045 / 0046, setup + runbook, READMEs, CHANGELOGs, BUILD_PLAN_V2, sign-off                                                 | both | M    |

Checkpoints: `[P15-B1-DONE]` after T15.4 · `[P15-B2-DONE]` after T15.7 · `[P15-B3-DONE]` after T15.10.
