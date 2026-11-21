# SAC sign-off — superadmin full access + WhatsApp calling

21 Nov 2026 · Prompt: [SUPERADMIN_WA_CALLING_PROMPT.md](../prompts/SUPERADMIN_WA_CALLING_PROMPT.md) · Plan: [SUPERADMIN_AND_WA_CALLING_PLAN.md](../plans/SUPERADMIN_AND_WA_CALLING_PLAN.md) · ADR: [0052](../adr/0052-superadmin-full-access-and-wa-calling.md)

Branch `feature/sac-superadmin-wa-calling` in both repos.

## Tasks

| Task                                                          | Status | Backend / frontend    |
| ------------------------------------------------------------- | ------ | --------------------- |
| T0 Docs baseline                                              | ✅     | `2ee9fd7`             |
| T1 Full access login-as, extend, step-up                      | ✅     | `b7bbc8a`             |
| T2 Full access everywhere, attribution, ringing               | ✅     | `ba8ee1d`             |
| T3 Full access UI                                             | ✅     | — / `76cfa0b`         |
| T4 Meta webhook verify + fix                                  | ✅     | `8b5c51a`             |
| T5 Webhook status + Fix button                                | ✅     | `18e3b59` / `23554c8` |
| T6 AI answers incoming: switch, validation, fallback, default | ✅     | `c96abd5`             |
| T7 Incoming switch UI                                         | ✅     | — / `4b52468`         |
| T8 Scheduled AI calls                                         | ✅     | `330789b`             |
| T9 AI callback → scheduled call                               | ✅     | `f0b54d3`             |
| T10 Schedule AI call UI                                       | ✅     | — / `e57c739`         |
| T11 Switch managed number to Meta direct                      | ✅     | `84e2262` / `0cb015f` |
| T12 Calling hardening                                         | ✅     | `46a28a6` / `7128fa8` |
| T13 Docs, checks, sign-off                                    | ✅     | this commit           |

## Deviations from the prompt

- D2: owner MFA is not a thing (two-step sign-in is superadmin-only), so MFA routes stay refused in a login-as; account delete cancel and contact erase also ask for the step-up.
- D10: a failed webhook check keeps the number `connected` (not `action_needed`) so sends and Retry setup are untouched; the card, bell and healthwatch show it. Repair runs only when `messages` / `calls` are missing.
- D19: scheduled calls are placed by a 15 s runner in the process with call media (a BullMQ worker has no media); exactly-once by a conditional claim + unique `(scheduledCallId, attempt)`.
- T10: warnings come back after the call is saved; the dialog then offers "Phir bhi rakho" or "Cancel this scheduled call".
- T12: TURN is shown on Admin → System (not a new calling readiness item — the 10-item list is fixed in the UI and tests). Uncertain connects keep `status: failed` with a `connect_uncertain` timeline step; a late call is terminated.
- Migrations are 0029 (webhook check), 0030 (incoming default), 0031 (scheduled calls); no migration was needed for login-as `full`.
- Fixed old tests broken on `main` by earlier commits: audit doc rows, catalogue positions, embedded signup config id, Pinnacle on by default.

## Checks

- Backend: lint ✅, typecheck ✅, build ✅, build:ops ✅, docs:audit 77 operations / 0 problems ✅, docs:smoke ✅. Full suite once: the in-memory MongoDB dropped mid-run (124 files cascaded); rerun of those files: all pass except 2 known failures also on `main` — `tests/voice/tts-cache.test.ts` purge and `tests/whatsapp-campaigns/campaigns.test.ts` recurrence (clock).
- Frontend: lint ✅, typecheck ✅, build ✅, full suite 1635 / 1637 — the 2 (`api-keys-tab`) are load timeouts and pass alone.

## Env (all optional)

`LOGIN_AS_FULL_ENABLED` (true), `WA_SCHEDULED_CALLS_ENABLED` (true), `WA_TURN_URLS`, `WA_TURN_USERNAME`, `WA_TURN_CREDENTIAL`.

## Live checklist (not run — needs the owner's number / phone)

1. Real Meta number onboarded (ES + Partner Solution) → card shows Webhook ✓.
2. Remove `calls` in the Meta app → Webhook check / Fix → ✓ again.
3. Customer calls on WhatsApp: switch ON → AI answers; OFF → team browser rings, both hear; nobody online → missed + bell.
4. Inbox: Call myself, Call with AI, Schedule AI call (5 min) — all connect, recorded, charged.
5. Superadmin Full access in another account: same steps; audit says "by the platform team"; account export asks for the step-up.
6. Pinnacle number → Switch to Meta direct → messages and calls through Graph; Pinnacle webhook cleared.
7. Wallet charge = Meta Insights duration (± 1 pulse); `WA_MEDIA_PUBLIC_IP` and UDP 40000–40999 open on the server (client team).
