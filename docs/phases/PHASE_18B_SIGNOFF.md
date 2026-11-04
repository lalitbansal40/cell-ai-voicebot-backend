# Phase 18B — WhatsApp calling go-live — Sign-off

**Date:** 2026-11-04 · **Branch:** `feature/phase-18b-wa-calling` (both repos) · **Plan:** [PHASE_18B_WA_CALLING_PLAN.md](PHASE_18B_WA_CALLING_PLAN.md) · **Tracker:** [PHASE_18B_TASKS.md](PHASE_18B_TASKS.md)

## Verdict

**Built; live check open.** Calling can be switched on from the platform with a WhatsApp read-back, the readiness checklist names every reason calling can't work (tier, `calls` webhook, app permission, media, prices), customers can be asked for call permission from Contacts (one or up to 5,000 at once) with a guided English / Hinglish template, and the System page and healthwatch watch call audio. The real-device check ([CALLING_LIVE_CHECK.md](../meta/CALLING_LIVE_CHECK.md)) and the release wait for the number, a server and the owner's phones. Nothing was pushed, merged or synced to the client repo.

## Tasks

| Task     | What                                                                                                                                                            | Backend              | Frontend  |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | --------- |
| T18B.1   | Meta read-back after every calling write; `CALLING_SETTINGS_NOT_APPLIED`; "Turning on…"                                                                         | `1b9f079`            | `e43ba0e` |
| T18B.2   | Readiness: 10 checks, cache, switch blocked with the fix; numbers chip                                                                                          | `8af61f0`            | `16fea7b` |
| T18B.3   | `contacts.waCallPermission`, filter / segment rule, list column, contact page card, calls page entry                                                            | `ccfb948`            | `bbbe63c` |
| T18B.4   | Bulk permission: route, `callPermissionRuns`, migration 0020, job with skip reasons + wallet stop, audit, bell, progress; dialog from contacts / list / segment | `2dd4913`, `64fc091` | `efb9fde` |
| T18B.5   | Template presets en + hi; status + rejection reason in dialogs; entry points; chosen `templateId`                                                               | `47a38b2`            | `d9034b8` |
| T18B.6   | System "WhatsApp calls"; rules `wa-media-no-public-ip`, `wa-call-setup-failing`                                                                                 | `c24b43b`            | `8ae074d` |
| T18B.7   | Live check: not run, missing inputs listed                                                                                                                      | `5e3aac4`            | —         |
| T18B.8   | Release: pending entry + post-deploy checks (no sync, not asked)                                                                                                | `3d82dea`            | —         |
| T18B.9   | Docs, CHANGELOGs, README, BUILD_PLAN_V2, sign-off                                                                                                               | `797dc0f`, this file | `12575d8` |
| B1 fixes | migration down-chain test over 0020; websocket.md row                                                                                                           | `c9e513b`            | —         |

## Gap audit (plan §2)

| Gap                                     | Closed by                                                   |
| --------------------------------------- | ----------------------------------------------------------- |
| G1 real-device checklist never ran      | **Open** — T18B.7 lists the missing inputs (owner / client) |
| G2 no Meta read-back                    | T18B.1                                                      |
| G3 no readiness checklist               | T18B.2                                                      |
| G4 `calls` subscription unchecked       | T18B.2 (`calls_webhook` + `last_calls_webhook`)             |
| G5 no bulk permission                   | T18B.4                                                      |
| G6 permission only from the inbox       | T18B.3 (contact page, calls page)                           |
| G7 status not on the contacts list      | T18B.3 (column, filter, segment)                            |
| G8 template status hidden in the dialog | T18B.5                                                      |
| G9 media settings not watched           | T18B.6                                                      |
| G10 Phases 16–18 not deployed           | **Open** — T18B.8 release entry (client team, owner's go)   |

## Numbers

|                        | Before (Phase 18)  | After              |
| ---------------------- | ------------------ | ------------------ |
| Error codes            | 107                | 108                |
| Audit actions          | 173                | 174                |
| Notification types     | 38                 | 39                 |
| Migrations             | 0001–0019          | 0001–0020          |
| Backend tests          | 3,893 (+1 skipped) | 3,918 (+1 skipped) |
| Frontend tests         | 1,481              | 1,501              |
| `npm audit --omit=dev` | 0 / 0              | 0 / 0              |

## Test runs (owner's rule: each suite once)

- **B1 backend, once:** 3,916 passed, 2 failed — both real (the phase 2 down-chain test did not step over 0020; `websocket.md` lacked `call_permission_bulk.progress`), fixed in `c9e513b`, those 2 files re-run: 5 / 5.
- **B1 frontend, once:** 1,489 passed, 12 failed in 5 files — 5 were 15 s timeouts, the rest waits that ran out, at load average 18 (other projects' containers on the machine). The 5 files re-run alone: 71 / 71. Load flakes, not bugs.
- **Builds:** backend 0, frontend 0. **`openapi:check`:** 0.
- **Playwright:** the full run (170 tests, 1 worker by design — one shared backend and database) was stopped at 25 / 170, all passing, to save time; instead the 10 specs of the areas this phase touched (WhatsApp calls ×4, contacts ×2, templates ×2, WhatsApp billing roles, security admin) ran once: 33 passed, 2 failed — both real, from this phase's UI (the call permission button now opens an English / Hinglish menu; "Turn calling on below" also matched `getByText('Calling on')`). Specs fixed (frontend `e2e/` in the sign-off commit), those 2 files re-run: 10 / 10. Backend log grep for secrets / tokens / phones: 0 in both runs. **The other ~135 e2e tests did not run in this phase** (areas without 18B changes).
- **Coverage:** not run separately — that would be a second full run of each suite, against the owner's once-per-phase rule. Deviation from the run prompt.

## Secret scan

`git diff main...HEAD` (added lines) for the prompt's patterns: backend 7, frontend 2 hits, all false positives — the pattern list in the run prompt (2), fake test phone numbers `+91900009900x` / `+919876543210` (6), and the India placeholder `+919000000000` the bulk dialog sends to the price preview for a list / segment estimate (1). No tokens, secrets or real numbers.

## Deviations

- No coverage run (see above).
- Playwright: targeted specs instead of the full 170 (see above).
- `whatsapp.call_permission_bulk_done` is defined in `bulk-permissions.ts`, not in `CALLING_NOTIFICATIONS` (that map is the fixed Phase 12 set its test pins).
- A run's `skipped.suppressed` also counts contacts deleted or erased after the run started.

## Open items

1. **Owner / client:** the inputs in [CALLING_LIVE_CHECK.md](../meta/CALLING_LIVE_CHECK.md) — number on Cloud API with limit ≥ 2,000, app subscribed to `calls`, server with UDP 40000–40999 + `WA_MEDIA_PUBLIC_IP`, two phones — then steps 0–9.
2. **Owner:** merge to `main`, then the client sync and release ([releases.md](../ops/releases.md), pending Phases 16–18B).
3. Approve a call permission template on the production number (WhatsApp → Templates → Create call permission template).
