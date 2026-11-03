# Phase 18B — WhatsApp calling go-live (detailed plan)

**Status:** Locked (2026-11-04) · **Date:** 2026-11-04 · **Size:** M (1–1.5 weeks) · **Branch:** `feature/phase-18b-wa-calling` (both repos)
**Before:** [Phase 12 sign-off](PHASE_12_SIGNOFF.md) (WhatsApp calling built on the fake Meta), [Phase 18 sign-off](PHASE_18_SIGNOFF.md) · **Reference:** AutoChatix (`~/Documents/Autochatix`, working calling in production: `callingSettings.service.ts`, `callPermission.service.ts`, `calls.controller.ts`, `BulkCallPermissionDialog.tsx`) · **Meta:** Cloud API Calling docs, re-read 4 Nov 2026

## 0. Goal

Phase 18B ke end tak:

- Client ka asli WhatsApp number par **calling chalu ho** (hamare platform se ek switch), aur sach mein chalu hua ye Meta se **dobara padh kar pakka** ho.
- Agar calling chalu nahi ho sakti (chhota messaging tier, coexistence number, `calls` webhook subscribe nahi, app permission nahi, server ka media setup adhoora), to platform **saaf batata hai kya kami hai aur kaise theek karein** — "kyun nahi chal raha" ka andaza na lagana pade.
- **Consent (call permission) template** ek click mein bane, Meta ko approval ke liye jaaye, approve hone par permission maangne mein use ho.
- Permission ek customer se (chat, contact panel, **contact page**) aur **bahut saare customers se ek saath** (contacts list / segment / list) maangi ja sake, Meta ki limits (1 / din, 2 / hafta) ke saath.
- Asli phone par poora real-device checklist chale aur pass ho: permission, agent call, AI call, customer ki call (team / AI → team), recording, charges.

**Done when:**

- On the client's production number: Calling switched on from **Number → Calling**, our read-back shows `ENABLED`; the call button is visible on the phone.
- The 9-step real-device checklist ([meta-whatsapp.md §15](../setup/meta-whatsapp.md)) passes on production, results in `docs/meta/CALLING_LIVE_CHECK.md` (no phone numbers; last 4 only).
- The call permission template is created from the platform and **approved by Meta**; a permission request sent outside the 24 h window with it reaches a real phone.
- A bulk permission request to 20 test contacts sends, skips (limits / already allowed / no consent) and reports correctly.
- The Calling section shows a readiness checklist; every failing item has a plain fix text, and a number on a low tier says so before the switch.
- Each suite once (owner rule), Playwright once; sign-off written.

### Kya NAHI hoga

| Kaam                                   | Kahan                                |
| -------------------------------------- | ------------------------------------ |
| WhatsApp call campaigns (bulk calling) | Phase 20                             |
| WhatsApp calls over SIP                | Research note only (T18.21: not now) |
| Inbound phone (SIP) calls              | Phase 19                             |

---

## 1. What was checked (4 Nov 2026)

### 1a. Already built and tested (Phase 12) — reuse

| Area                                                                                                                                                                              | Where                                                                         | AutoChatix has it too             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------- |
| Calling settings: on / off, call button visibility (+ countries), call hours + holidays, callback permission, inbound route (team / AI / AI → team), ring time                    | `whatsapp-calling/settings.service.ts`, `CallingSection.tsx` in Number drawer | on / off + icon only              |
| Meta settings sync (manual + `account_settings_update` webhook), restrictions with expiry, bells                                                                                  | `settings.service.ts`, `webhooks.ts`                                          | no                                |
| Availability rules: coexistence, not Cloud API, messaging limit < 2,000, BIC country exclusions                                                                                   | `availability.ts` (matches Meta's docs re-read today)                         | partly                            |
| Permission state from **Meta's** `call_permissions` API (actions + limits), our cache, reply webhook                                                                              | `permissions.service.ts`                                                      | own counter only                  |
| Permission request: interactive inside the 24 h window, approved template outside it                                                                                              | `RequestPermissionDialog.tsx` (chat + contact panel)                          | yes                               |
| Call permission template preset (UTILITY, `CALL_PERMISSION_REQUEST` component)                                                                                                    | Templates → "Create call permission template"                                 | no (uses any approved template)   |
| Business-initiated calls: agent (browser via our server) and AI; user-initiated: team ring, AI, AI → team handoff; hold, keypad, transfer, recording, billing by Meta's talk time | `calls.service.ts`, `bridge.ts`, `handoff.ts`, `billing.ts`                   | agent only, browser ↔ Meta direct |
| Media on our server (no TURN needed: the agent's audio goes over our WebSocket)                                                                                                   | ADR 0040                                                                      | needs TURN                        |

### 1b. Gaps found

| #   | Gap                                                                                                                                                                            | Why it matters                                                                                                                 | Task   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------ |
| G1  | **The real-device checklist never ran** (Phase 13 has no sign-off; Phase 12 §8 left it for Phase 13)                                                                           | Nothing proves calling works against real Meta, real phones and the production server                                          | T18B.7 |
| G2  | After switching calling on / off we **don't read Meta back**                                                                                                                   | Meta can answer `success` and still not apply it (AutoChatix found this); the UI would show "On" while the phone has no button | T18B.1 |
| G3  | **No readiness checklist**: a low tier, a missing `calls` webhook subscription, a missing app permission, no public media IP / closed UDP all look like "calling doesn't work" | The most likely reason the client sees calling "not working" — e.g. a new number on `TIER_250` can't enable calling at all     | T18B.2 |
| G4  | `calls` webhook subscription is not checked anywhere                                                                                                                           | Without it calls connect at Meta but we never hear them                                                                        | T18B.2 |
| G5  | **No bulk permission request** (contacts list / segment / list)                                                                                                                | Customers who never messaged can only be reached with the template, one by one today (AutoChatix has a bulk dialog)            | T18B.4 |
| G6  | Permission can't be requested from the **contact page** or the **calls page**, only the inbox chat / panel                                                                     | Teams work from Contacts; the button is hidden unless a chat exists                                                            | T18B.3 |
| G7  | Permission status not on the **contacts list** (column / filter / segment rule)                                                                                                | Can't find "who allowed calls" before a call day                                                                               | T18B.3 |
| G8  | Template review status for the permission template isn't surfaced in the permission dialog (which template, approved or not, rejected reason)                                  | Users pick nothing and the request fails outside the window                                                                    | T18B.5 |
| G9  | Production media settings (`WA_MEDIA_ENABLED`, `WA_MEDIA_PUBLIC_IP`, UDP 40000–40999 open) aren't checked by the System page / healthwatch                                     | The production server was never audited (Phase 17 Gate P)                                                                      | T18B.6 |
| G10 | Phase 16–18 are not deployed; production runs Phase 15 code                                                                                                                    | Every fix here also needs a release                                                                                            | T18B.8 |

---

## 2. Tasks

| #      | Task                                                                                        | Repo | Size | Needs                                  |
| ------ | ------------------------------------------------------------------------------------------- | ---- | ---- | -------------------------------------- |
| T18B.1 | Enable / disable with Meta read-back; clear errors                                          | both | S    | —                                      |
| T18B.2 | Calling readiness checklist (number, tier, webhook field, app permission, media, prices)    | both | M    | —                                      |
| T18B.3 | Permission from the contact page and calls page; status on the contacts list + segment rule | both | M    | —                                      |
| T18B.4 | Bulk permission request (selection, list, segment) as a job with results                    | both | M    | —                                      |
| T18B.5 | Permission template: guided create, review status in the dialog, Meta rejection reasons     | both | S    | —                                      |
| T18B.6 | Media readiness on System page + healthwatch                                                | both | S    | —                                      |
| T18B.7 | Real-device checklist on production + App Review calling video                              | ops  | S    | 🔴 number tier ≥ 2,000, server release |
| T18B.8 | Release Phases 16–18B to production                                                         | ops  | S    | 🔴 client team deploy                  |
| T18B.9 | Docs, sign-off                                                                              | docs | S    | —                                      |

### T18B.1 — Enable with read-back (both)

1. `settings.service.ts` `updateCalling`: after Meta's POST returns, call Meta's GET (existing `syncCalling`) and compare `status` and `call_icon_visibility` (and call hours when sent). Mismatch → 502-style `CALLING_SETTINGS_NOT_APPLIED` ("WhatsApp did not apply the change. Refresh and check the number before trying again"), the stored state is Meta's read-back, not our wish.
2. Map Meta's calling errors to plain words (number not eligible, tier, coexistence, rate limit), keeping the Meta code in the log only.
3. Frontend: the switch shows "Turning on…" until the read-back; on mismatch the switch returns to Meta's state with the message.
4. Tests: fake Meta that accepts but doesn't apply → error + stored state = read-back; normal path; icon visibility mismatch.

### T18B.2 — Readiness checklist (both)

1. `GET /whatsapp/channels/:id/calling/readiness` → items, each `{ key, ok, detail, fix }`:
   - Cloud API number (not coexistence / WhatsApp Business app),
   - messaging limit ≥ 2,000 (show the current tier and how tiers grow: quality, unique recipients, business verification),
   - business verification status,
   - app subscribed to the `calls` webhook field (app-level check through `GET /{app-id}/subscriptions` with the app token; cached 1 h),
   - `whatsapp_business_messaging` permission on the number (from the debug token / embedded signup grant),
   - calling status at Meta (read-back) and restrictions,
   - last `calls` webhook received (date) — proves the path end to end,
   - media: `WA_MEDIA_ENABLED`, public IP set, a self-test that a UDP port in the range is bindable (no external probe from the app),
   - calling prices imported (not the placeholder card).
2. Calling section shows the checklist above the switch; the switch is disabled with the first failing item's fix text when a must-have fails.
3. Numbers list: a "Calling: not ready" chip with the count of failing items.
4. Tests: each item true / false on the fake Meta; the UI checklist and the disabled switch.

### T18B.3 — Permission from contacts (both)

1. Contact page: a WhatsApp calling card (same component as the inbox panel): status (Allowed until … / Not allowed / Asked, waiting / Declined), "Ask permission", "Call" (agent) and "AI call" when allowed — needs the contact's WhatsApp number on a calling-enabled channel (pick the channel when the account has several).
2. Calls page: "New WhatsApp call" → pick a contact → the same card.
3. Contacts list: column "WhatsApp calls" (Allowed / Asked / Declined / —) and a filter; a segment rule `whatsappCallPermission = allowed | asked | declined | none` (reads our permission cache; refreshed from Meta before a call as today).
4. Tests: card states, buttons per role (`calls.trigger`, `calls.answer`), filter and segment.

### T18B.4 — Bulk permission request (both)

1. `POST /whatsapp/call-permissions/bulk` `{ channelId, target: { contactIds | listId | segmentId }, templateId (required — bulk never relies on the 24 h window), variables }` → a job (queue `whatsapp`), returns a run id; `GET …/bulk/:runId` → counts and per-reason skips.
2. Per contact, in order: suppressed / DND / opted out → skip; already allowed → skip; Meta's limit (`call_permissions` action) → skip with "next at"; no WhatsApp number → skip; else send the template (wallet hold + charge as a template message) and record the request.
3. Pacing by the number's messaging tier (Phase 11 send path); stop on wallet empty; idempotent per run + contact.
4. Frontend: "Ask for call permission" in the contacts list bulk actions, list page and segment page → dialog (channel, approved permission template, variables preview, estimated cost) → progress and results (sent, skipped by reason, failed).
5. Audit `whatsapp.call_permission_bulk_requested` (+1), notification when done (+1).
6. Tests: every skip reason, limits, wallet stop, idempotent retry, counts; frontend dialog and results.

### T18B.5 — Permission template, guided (both)

1. "Create call permission template" also from the Calling section and the permission dialog when no approved one exists; Hinglish + English presets; category picker with Meta's note (UTILITY when it is about the customer's account, else MARKETING).
2. Permission dialog: lists permission templates with their review state (Approved / In review / Rejected + reason); outside the window only approved ones can be chosen, with "why" text.
3. Rejected template → the reason from Meta's `message_template_status_update` and an "Edit and resubmit" link.
4. Tests: entry points, states, rejection reason.

### T18B.6 — Media readiness on System + healthwatch (both)

1. System page "WhatsApp calls" card: media on, public IP set, port range, live calls, last call setup time, last error.
2. Healthwatch rule: media enabled but no public IP in production → alert; calls failing setup 3 times in 15 min → alert.
3. Tests: rules, card.

### T18B.7 — Real-device checklist on production (ops, 🔴)

1. Preconditions: the client's number on **Cloud API**, messaging limit **≥ 2,000** (or Meta's calling sandbox / public test number for a dry pass), app subscribed to `calls`, release with T18B.1–6, server UDP 40000–40999 open, `WA_MEDIA_PUBLIC_IP` set.
2. Run the 9 steps of [meta-whatsapp.md §15](../setup/meta-whatsapp.md) with the owner's phones; record pass / fail, latency, Meta's durations vs our pulses in `docs/meta/CALLING_LIVE_CHECK.md`.
3. Record App Review video 2b (calling) per [APP_REVIEW.md](../meta/APP_REVIEW.md) if the review still needs it.
4. Every failure → a fix task before sign-off.

### T18B.8 — Release (ops, 🔴)

1. Sync `main` (Phases 16–18B) to the client repo with `sync-client-repo.sh`; the client team deploys (or `release.sh` once Gate P is open).
2. Post-deploy: `/health` commit, Calling section readiness all green on the production number.

### T18B.9 — Docs, sign-off

`docs/setup/meta-whatsapp.md` §15 (readiness, bulk permission), `audit.md`, catalogue counts, CHANGELOGs, BUILD_PLAN_V2 line, `PHASE_18B_SIGNOFF.md`.

---

## 3. Tests (owner rule)

While writing: only the changed files' tests. Checkpoint after T18B.6: backend once, frontend once (coverage), builds, Playwright once with the new specs (enable with read-back on the fake Meta; bulk permission request). A known flake → that file once more only.

## 4. Risks

| Risk                                     | Mitigation                                                                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| The client's number is below 2,000 a day | Readiness shows it with the way to grow the tier; use Meta's public test number for the dry pass; the real-device check waits |
| Meta changes calling limits / rules      | Rules in `availability.ts` + `config/limits.ts`; re-read the docs at T18B.7                                                   |
| Permission template rejected             | Presets follow Meta's examples (say why the business will call); rejection reason shown; resubmit                             |
| Bulk asks annoy customers / hurt quality | Template only, Meta's limits enforced, DND / opt-out skipped, pacing by tier                                                  |
| Production server not reachable by us    | Client team deploys; the readiness checklist tells them what is missing                                                       |

## 5. What we need from the client

1. The production number's messaging tier (WhatsApp Manager) and business verification status.
2. Confirmation that the app is subscribed to the `calls` webhook field (or access to do it).
3. Two phones for the real-device check and a 1-hour window.
4. A deploy of the latest `main` (Phases 16–18B).

## Changelog

- 2026-11-04: plan drafted from a check of Phase 12 code and sign-off, AutoChatix's calling services and UI, and Meta's Calling docs (prerequisites: messaging limit ≥ 2,000 unique recipients a day, Cloud API number, `calls` webhook field, `whatsapp_business_messaging`, calling enabled in call settings; BIC excluded for US, CA, EG, VN, NG).
- 2026-11-04: run prompt written (`docs/prompts/PHASE_18B_PROMPT.md`): literals locked — `CALLING_SETTINGS_NOT_APPLIED` (errors 108), readiness route and 10 item keys, filter key `whatsappCallPermission` + `contacts.waCallPermission`, bulk route / skip reasons / `callPermissionRuns` + migration 0020, audit 174, notifications 39, health rules `wa-media-no-public-ip`, `wa-call-setup-failing`; owner test rule (each suite once).
- 2026-11-04: STEP 0. Plan locked; literals per run prompt §1 (errors +1 → 108, audit +1 → 174, notifications +1 → 39, migration 0020, readiness keys, bulk skip reasons). Defaults in use; client inputs (§5): **none** (number tier, `calls` subscription, phones, server not given).
