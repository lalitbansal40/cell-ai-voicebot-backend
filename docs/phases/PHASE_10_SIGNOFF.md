# Phase 10 — Sign-off

**Date:** 2026-10-23 · **Branch:** `feature/phase-10-whatsapp-inbox` (both repos, not merged) · **Plan:** [PHASE_10_PLAN.md](PHASE_10_PLAN.md) · **Tracker:** [PHASE_10_TASKS.md](PHASE_10_TASKS.md) · **Run prompt:** [PHASE_10_PROMPT.md](../prompts/PHASE_10_PROMPT.md) · **ADR:** [0038](../adr/0038-whatsapp-inbox.md) · **Real-number checklist:** [setup guide §13](../setup/meta-whatsapp.md)

**Verdict:** ✅ Phase 10 (WhatsApp Inbox) complete — all 12 tasks done. **"Done when"** is proven by Playwright on the fake Meta provider (frontend repo, `e2e/inbox-*.spec.ts`):

- **Both directions:** a customer writes → the conversation appears live (unread, bell) → opening it sends a read receipt. Every inbound type renders and its media opens, plays or downloads. The agent replies with text, a photo with a caption, a quoted reply, a reaction, buttons (the customer taps one), a list and a link button, and a **voice note recorded in the browser**. The fake Meta confirms the voice note as a valid mono OGG / Opus. Ticks go sent → delivered → read.
- **Window and statuses:** an expired window blocks the composer (notes still possible) and the API answers 409; the customer's next message reopens it. Delivery failures show their reason with Retry.
- **Opt-out:** `STOP`, `band karo` and `बंद करो` opt the customer out, with a confirmation reply; `START` and `SHURU` opt them back in; a sentence that only contains a keyword does nothing.
- **Retention and coexistence:** the 90-day retention deletes old messages. A coexistence number shows Business app echoes and imported history, and syncs its contacts.
- **Roles:** viewers and impersonators read only, and an impersonator sends no read receipt.

The real-number checklist is ready for Phase 13. **Phase 11 can start.** Merging the branches is a project-lead decision after review.

## 1. Tasks — "Done when" check

| Task                                    | Status | Evidence (commit; fe = frontend repo)                                             | Notes                                                                                                                                                 |
| --------------------------------------- | ------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Step 0 plan + prompt                    | ✅     | `f7ef3d8`, `6be5f24`                                                              | owner answers 1–6 locked in the plan                                                                                                                  |
| T10.1 Models, migration 0011, catalogue | ✅     | `517320b`                                                                         | conversations, messages, inbox uploads; contact WhatsApp profile; codes 59, audit 106, notifications 19, 5 WS events, 3 permissions                   |
| T10.2 Meta core                         | ✅     | `6154ed3`                                                                         | send every type, read / typing, media upload / url / download (host allowlist), block, business profile; fake with auto statuses + knobs              |
| T10.3 Inbound pipeline                  | ✅     | `5744a07`, fix `3833db4`                                                          | every type normalised, contacts, conversations, unread, window, media downloads, statuses (monotonic), opt-out / opt-in, coexistence import, backfill |
| T10.4 Outbound pipeline                 | ✅     | `6b27144`                                                                         | validation, idempotency, uploads + sniffing, pure-TS WebM → OGG remuxer, send job + retries, receipts / typing, notes, retention job                  |
| P10-B1-DONE                             | ✅     | `f679f2b`                                                                         | `npm run dev:inbox`                                                                                                                                   |
| T10.5 Inbox API                         | ✅     | `e7c9386`                                                                         | API, topic auth, business profile, inbox settings, rate limits, OpenAPI                                                                               |
| T10.6 Dev tools, hardening, docs        | ✅     | `fd67d20`                                                                         | 29 inbox simulator kinds, seed, hardening, ADR 0038                                                                                                   |
| P10-B2-DONE                             | ✅     | `b6af964`                                                                         | manual HTTP check, logs clean                                                                                                                         |
| T10.7 FE foundation                     | ✅     | `1bdf325` (fe)                                                                    | clients, hooks, topic merge, optimistic sends, nav + badge, routes                                                                                    |
| T10.8 Inbox page                        | ✅     | `a87170f` (fe)                                                                    | list, chat, every bubble type                                                                                                                         |
| T10.9 Composer                          | ✅     | `9fe8953` (fe)                                                                    | every free-form type incl. voice notes, interactive builder, states                                                                                   |
| T10.10 Contact panel + entry points     | ✅     | `7d60661` (fe)                                                                    | actions, panel, Open / Start chat, Settings → Inbox, business profile, card, simulator drawer                                                         |
| T10.11 Playwright E2E                   | ✅     | fixes `2cae0a2`, `588a4b0` (fe), `c47524a` (fe), `3d4cb72` (fe); fe T10.11 commit | 5 specs, 26 tests; 103 total, green twice                                                                                                             |
| T10.12 Gap audit, docs, sign-off        | ✅     | this commit + fe docs commit                                                      | requirement → test table, security checklist, docs                                                                                                    |

## 2. Deliverables checklist (PHASE_10_PLAN §4)

- [x] Conversations + messages models, contact / account fields, migration 0011 + Phase 9 backfill.
- [x] Meta client: every free-form type, read / typing, media upload / download, block, business profile; fake with auto statuses, knobs and media.
- [x] Inbound: every type, contacts, conversations, unread, window, media downloads, statuses, opt-out / opt-in, coexistence echoes / history / contacts.
- [x] Outbound: every free-form type, uploads, browser voice notes (WebM → OGG remux), window / opt-out / block rules, idempotent sends with retries, read receipts, typing, notes, confirmations.
- [x] 90-day retention job (messages + media + orphan uploads).
- [x] Inbox API + OpenAPI + topic auth; business profile + inbox settings; simulator + `dev:inbox` + seed; hardening; ADR 0038; real-number checklist.
- [x] UI: Inbox (list, chat with every bubble, composer with every type, contact panel), Open / Start chat, Settings → Inbox, business profile editor, notifications, dashboard card, nav badge.
- [x] Playwright: done-when, window + statuses, opt-out + coexistence, roles, entry points — twice, logs clean.
- [x] Docs: ADR 0038, data-model, api, security, compliance, setup guide §12–13, READMEs, CHANGELOGs, sign-off.

## 3. Requirement → test mapping (gap audit)

Backend tests in `tests/inbox/`; frontend unit tests in `src/features/inbox/**` and `src/features/whatsapp/numbers/business-profile.test.tsx`; Playwright in the frontend `e2e/inbox-*.spec.ts`.

| Requirement (PHASE_10_PLAN §0 / §1)        | Tests                                                                                                                                                                                                                                              |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §0 #1 data; §1b model, indexes             | `models.test.ts`, `catalogue.test.ts` (limits, codes, audit, notifications, permissions, WS), `tests/db/phase10-migrations.test.ts` (0011 up / down)                                                                                               |
| §0 #2 inbound pipeline, every type (§1c)   | `inbound.test.ts` (each fixture `messages-*.json`), `inbox-units.test.ts` (normalisers, previews), `meta-message-schemas.test.ts`, `coexistence-backfill.test.ts`; fe `bubbles.test.tsx` (every bubble); E2E done-when                             |
| §0 #3 outbound, every free-form type (§1d) | `outbound.test.ts` (exact Graph payloads, idempotency, order, retries, error reasons), `meta-graph-messaging.test.ts`, `meta-fake-inbox.test.ts`; fe `composer.test.tsx`, `interactive.test.tsx` (exact request bodies); E2E done-when             |
| Voice notes (§1d-voice, decision #6)       | `voice-remux.test.ts` (EBML / Opus / OGG, corrupt and truncated input, 10-minute remux), fe `voice.test.tsx` (type preference, states, mic release, strict mode), E2E done-when (fake mic → valid mono OGG / Opus)                                 |
| §0 #4 read receipts + typing (§1i)         | `outbound.test.ts`, `inbox-routes.test.ts` (impersonator: no receipt), fe `foundation.test.tsx` (throttle, read on open, not for impersonators), E2E done-when + roles + entry points (receipts off → none)                                        |
| §0 #5 24-hour window                       | `outbound.test.ts`, `inbox-routes.test.ts` (409, notes OK), fe `composer.test.tsx`, E2E window-statuses                                                                                                                                            |
| §1e statuses (monotonic, failed reasons)   | `inbound.test.ts`, `inbox-units.test.ts` (status rank), `fake-statuses.test.ts`, fe `helpers.test.ts` (same rule), E2E window-statuses (00006–00009 knobs)                                                                                         |
| §0 #6 opt-out / opt-in (decisions #3, #4)  | `inbound.test.ts` (English / Hinglish / Hindi, whole-message only, confirmations, 24 h cooldown, message order — regression of `3833db4`), `inbox-routes.test.ts` (settings), fe `entry-points.test.tsx`, E2E opt-out + entry points (custom ROKO) |
| §0 #7 coexistence                          | `coexistence-backfill.test.ts`, `hardening.test.ts` (5,000-message history), E2E opt-out-coexistence                                                                                                                                               |
| §0 #8 retention (decision #1)              | `outbound.test.ts` (retention job), `hardening.test.ts` (20,000 messages), E2E opt-out-coexistence                                                                                                                                                 |
| §0 #9 conversation management (§1i)        | `inbox-routes.test.ts` (list, filters, search, cursor, assign, close / reopen, block, unread, start), fe `inbox-page.test.tsx`, `entry-points.test.tsx`, E2E roles                                                                                 |
| §0 #10 business profile                    | `inbox-routes.test.ts` (read, edit, photo, validation, audit), fe `business-profile.test.tsx`, E2E entry points                                                                                                                                    |
| §0 #11 realtime (§1j)                      | `inbound.test.ts` (account events without text), `inbox-routes.test.ts` (topic auth, isolation), fe `foundation.test.tsx` (merge, dedupe, out-of-order), E2E (every live step)                                                                     |
| §0 #12 dev tools                           | `simulator-seed.test.ts` (29 kinds, seed, wrong secret), `meta-fake-inbox.test.ts`                                                                                                                                                                 |
| §0 #13 UI (§1p)                            | fe `inbox-page.test.tsx` (layouts, list, log, jump, pill), `bubbles.test.tsx`, `composer.test.tsx`, `entry-points.test.tsx`, `layout.test.tsx` (badge), E2E                                                                                        |
| §1l security & privacy                     | §5 below                                                                                                                                                                                                                                           |
| §1m permissions                            | `catalogue.test.ts` (role matrix), `inbox-routes.test.ts` (roles × routes, impersonator, suspended), fe permission tests, E2E roles                                                                                                                |
| §1n API + OpenAPI                          | `inbox-routes.test.ts`, `tests/http/docs.test.ts`, `openapi:check`                                                                                                                                                                                 |

Gaps found and closed in Batch 3: the send / retry responses lacked the quote and sender (regression test in `inbox-routes.test.ts`); three frontend bugs found by the E2E run (§6).

## 4. Numbers

|                                                     | Before (Phase 9)              | After                         |
| --------------------------------------------------- | ----------------------------- | ----------------------------- |
| Backend tests                                       | 2463                          | 2712                          |
| Frontend tests                                      | 803                           | 1048                          |
| Playwright                                          | 77                            | 103 (green twice)             |
| Backend coverage (stmts / branches / funcs / lines) | 97.22 / 89.62 / 96.95 / 98.27 | 97.09 / 89.54 / 96.64 / 98.22 |
| Frontend coverage                                   | 96.16 / 91.16 / 93.67 / 96.87 | 96.81 / 92.61 / 94.59 / 97.39 |

Hardening (`tests/inbox/hardening.test.ts`, laptop): 1,000 inbound messages ≈ 3 s; 200 parallel sends ≈ 0.8 s; a 5,000-message history import ≈ 1.8 s; retention of 20,000 messages ≈ 0.35 s; a 10-minute voice note remuxed in ≈ 4 ms.

Bundle (frontend, gzip of everything `index.html` loads, same build script on both): `main` 453.5 KB → branch 461.9 KB counted per file (**+8.4 KB**). The start-up code itself grows **+2.7 KB** (all start-up JS gzipped as one stream: 457.0 → 459.6 KB); the rest comes from the bundler splitting the start-up code into 42 files instead of 18 because more lazy chunks now share modules. Lazy: the Inbox page (20.8 KB), composer dialogs, voice recorder, emoji picker, lightbox, Settings → Inbox, the dashboard card, the contact page chat button and the menu badge. Recorded as a deviation (§5).

Coverage gates stay at backend 95 / 85 / 95 / 95 and frontend 95 / 90 / 90 / 95 — the new values rounded down to 5 equal the current gates (never lowered).

## 5. Security checklist (§1l) and deviations

- Customer data never in logs, audit, notifications, job data or account WS events — unit tests (`inbound.test.ts`, `outbound.test.ts`, `inbox-routes.test.ts`: the stored notification has no message text) and the E2E log grep (§7).
- Uploads sniffed (magic bytes vs kind and declared type), file names sanitised; media download host allowlist (`META_MEDIA_HOST_SUFFIXES`); the voice parser bounded (corrupt / truncated inputs tested).
- XSS: hostile texts, `javascript:` links, file names, vCard fields, interactive titles, referral headlines and form answers render as text (fe `bubbles.test.tsx`); only `http(s):` links become anchors (`rel="noopener noreferrer"`).
- Signed short-lived media links; another account's ids → 404; topic auth by account + `inbox.read`; impersonators read only and send no receipts.
- Dedupe by wamid / clientId and monotonic statuses (backend and frontend share the rule).
- `console.log` in `src`: 0 / 0. No network in tests: `graph.facebook.com`, `fbsbx`, `fbcdn` appear only in allowlist constants, default env values, fake URLs and stub-server fixtures.

Deviations (all in the [plan changelog](PHASE_10_PLAN.md#changelog)): T10.1 / T10.3 / T10.4 / T10.5 notes; Batch 3: menu icon `ForumOutlined` with badge key `inbox-unread`; tick labels Queued / Sent / Delivered / Read / Failed; inbox simulator kinds kept in their own frontend list; business profile hooks in `features/whatsapp/profile.ts`; the menu badge lazy; the composer tools on their own row; the dev server pre-bundles the dependencies of lazy screens (`optimizeDeps.entries`); **bundle +8.4 KB per file (+2.7 KB as code)** against the ≤ 3 KB target — the project lead may accept it or ask for bundler chunk tuning.

## 6. Bugs found and fixed

Each with a regression test proven to fail first:

- **Batch 1:** keywords applied out of message order (a START processed before an earlier STOP left the customer opted out) — `3833db4`.
- **Batch 3, found by the E2E run:**
  - Send / retry responses lacked the reply quote and sender name — `2cae0a2`.
  - The message box shrank to zero width in a narrow three-pane chat — fe `588a4b0`.
  - React strict mode started the voice recorder twice, so the stale recording took over the preview — fe `c47524a`.
  - The contact panel missed opt-outs until a reload — fe `3d4cb72`.

## 7. Verification (P10-B3-DONE)

Filled in by the `[P10-B3-DONE]` commit.

## 8. Remaining TODOs (by phase)

- **Phase 11 (templates + billing):** template sends outside the window; wallet settle from the stored `pricing`; block marketing to opted-out contacts.
- **Phase 12 (calling):** the call permission request as an interactive message + its `button_reply`; the panel's calling placeholder.
- **Phase 13 (staging + App Review):** run the real-number checklist ([setup guide §13](../setup/meta-whatsapp.md)); record the `whatsapp_business_messaging` screencast.
- **Phase 15:** message webhooks / public API for conversations.
- **Phase 16:** account deletion of conversations, messages and media.

## 9. Owner inputs still pending

- Open questions §7 #7–#10 (defaults in use):
  - saved replies / auto-assignment / SLA — later phase;
  - AI bot replies on WhatsApp — after Phase 12;
  - a deleted contact keeps its chats;
  - owners, admins and managers may block.
- A legal review of the 90-day retention.
- From Phase 9: the Meta app, Business verification, a test WhatsApp number, a staging domain.

## 10. Go / no-go for Phase 11

**Go.** Every free-form type works both ways through the same Graph contract the real Meta number will use. The window, statuses, opt-outs, retention and coexistence are enforced on the server and proven end to end. Phase 11 has its hooks: the outbound builders, the window check, the stored pricing and the opt-out state.
