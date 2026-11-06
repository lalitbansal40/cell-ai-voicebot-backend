# Phase 20 sign-off — incoming phone calls on the SIP line

6 Nov 2026 · Prompt: [PHASE_20_INBOUND_SIP_PROMPT.md](../prompts/PHASE_20_INBOUND_SIP_PROMPT.md) · Plan: [INBOUND_SIP_PLAN.md](../plans/INBOUND_SIP_PLAN.md) · ADR: [0051](../adr/0051-inbound-sip.md)

Branch `feature/phase-20-inbound-sip` in both repos. Not pushed, merged or deployed.

## Tasks

| Task                                      | Status | Commits (backend / frontend)  |
| ----------------------------------------- | ------ | ----------------------------- |
| T1 Dialplan + inbound ARI app + env       | ✅     | `7daf649`                     |
| T2 Model + migration 0026                 | ✅     | `afa4856`                     |
| T3 Inbound leg + provider                 | ✅     | `36fbf29`                     |
| T4 Routing service, billing, missed calls | ✅     | `2f42b24`                     |
| T5 Answer / decline / callback            | ✅     | `a421075`                     |
| T6 Settings API + public docs             | ✅     | `e35b463`                     |
| T7 Frontend                               | ✅     | — / `46e3910`, test `ec31a89` |
| T8 Docs, export columns                   | ✅     | `04f94af` / `09018c6`         |
| T9 Checks + sign-off                      | ✅     | `15621fc`, `7c0270d`, this    |

## Deviations from the prompt

- Incoming-call facts live in `calls.inbound` (+ `calls.missed`) instead of inside `calls.sip` (which keeps line metrics).
- `ai_then_team`: any transfer step of the program rings the team (like WhatsApp), no separate `team` transfer target.
- No HTTP dev simulator (D27): the lab caller `deploy/asterisk/lab/call-in.sh` and the fake-ARI tests cover it.
- No new dashboard tiles: analytics already counts incoming / outgoing calls; missed calls are Calls → Missed. Calls export adds "Number called" and "Missed reason".
- Ledger breakdown has no `direction`; the call row and the incoming minute price show it.
- New audit actions are listed last in the catalogue so older position checks stay valid.

## Checks

- Backend: lint ✅, typecheck ✅, build ✅, `openapi:check` ✅, `docs:audit` 72 operations / 0 problems, `docs:smoke` 72 / 72 (the smoke stub and nullable `$ref` handling fixed; the same 4 failures were on `main`).
- Backend suite: the in-memory MongoDB dropped mid-run (`ECONNREFUSED`, 115 files cascaded). Rerun of those files: all pass after the audit-catalogue fix, except `tests/whatsapp-campaigns/campaigns.test.ts` recurrence (clock-dependent, fails on `main` too). New tests: `tests/sip/inbound-leg.test.ts` (6), `tests/sip/inbound-sip.test.ts` (8), `tests/sip/inbound-settings.test.ts` (3).
- Frontend: lint ✅, typecheck ✅, build ✅. Full suite once: 1581 / 1587; 5 failures were expectations of this phase (new Settings tab, number purpose, incoming price, Direction filter on every line) — updated and passing (44 / 44); the 6th is `inbox-page.test.tsx` "Retry a failed send" (fails on `main` too). New tests: `phone-numbers.test.tsx` (3) and the phone-call case in `live.test.tsx`.

## Live checks (not run — need the client's DID and the owner's phone)

1. Client routes the DID to our Asterisk; confirm where the DID is sent (request URI / `To`), trunk IPs, channel limit, incoming minute price.
2. Server: migration 0026, Asterisk rebuilt with `ARI_APP`, `SIP_INBOUND_ENABLED=true` on the API.
3. Owner's phone → DID: AI route speaks; team route rings a browser and both sides hear; closed hours plays the message and lists a missed call with a bell and `call.missed`; the wallet is charged once.
