# Phase 10 — Tasks (tracker)

Plan: [PHASE_10_PLAN.md](PHASE_10_PLAN.md) · Overview: [BUILD_PLAN_V2.md](../plans/BUILD_PLAN_V2.md)

| ✓   | #      | Task                                                                                                                                                                                             | Repo | Size |
| --- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ---- |
| [x] | T10.1  | Models (Conversation, Message), contact / account fields, migration 0011 (+ backfill), `INBOX_LIMITS`, env, codes (→ 59), audit (→ 106), WS, notifications (→ 19), permissions                   | BE   | M    |
| [x] | T10.2  | `MetaClient` extension (send every type, read / typing, media upload / url / download, block, business profile) + fake (wamid, auto statuses, media, knobs) + schemas / fixtures                 | BE   | L    |
| [x] | T10.3  | Inbound pipeline: normalizers, contacts, conversations, ordering, unread / window, media downloads, opt-out / opt-in, statuses, coexistence import, backfill, WS + notifications                 | BE   | L    |
| [x] | T10.4  | Outbound pipeline: validation, window / opt-out / block / channel rules, idempotency, uploads, voice WebM → OGG remuxer, send job + retries, read receipts + typing, notes, 90-day retention job | BE   | L    |
| [ ] | T10.5  | Inbox API, views, topic auth, business profile + inbox settings, rate limits, OpenAPI                                                                                                            | BE   | M    |
| [ ] | T10.6  | Simulator kinds, dev media route, `dev:inbox`, seed, hardening, ADR 0038, docs, real-number checklist                                                                                            | BE   | M    |
| [ ] | T10.7  | FE foundation: clients, hooks, topic merges, WS, nav Inbox + badge (`LIVE_PHASE = 10`), routes, labels                                                                                           | FE   | M    |
| [ ] | T10.8  | Inbox page: list + chat view with every bubble type, media viewer / players, ticks, dividers, infinite scroll                                                                                    | FE   | L    |
| [ ] | T10.9  | Composer: text, emoji, attachments, voice note recorder, location, contact card, interactive builder, reply, reactions, notes, states                                                            | FE   | L    |
| [ ] | T10.10 | Contact panel, actions, Open / Start chat, Settings → Inbox, business profile editor, notifications, dashboard card, Simulate customer                                                           | FE   | M    |
| [ ] | T10.11 | Playwright E2E (5 specs) — whole suite twice                                                                                                                                                     | FE   | M    |
| [ ] | T10.12 | Gap audit, security checklist, docs, Phase 10 sign-off                                                                                                                                           | both | M    |

Checkpoints: `[P10-B1-DONE]` after T10.4 · `[P10-B2-DONE]` after T10.6 · `[P10-B3-DONE]` after T10.12.
