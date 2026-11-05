# Recorded-voice campaigns (Cell24x7 Voice API) — local sign-off

5 Nov 2026. **Implemented and verified locally; live Cell24x7 check not run** (needs the
owner's approval and test number). Branch `feature/voice-api-cell24x7` in both repos;
nothing pushed, merged or deployed. Prompt: [VOICE_API_CELL24X7_PROMPT.md](../prompts/VOICE_API_CELL24X7_PROMPT.md).

## Tasks

| Task                                                                                  | Result                  |
| ------------------------------------------------------------------------------------- | ----------------------- |
| T1 env, Cell24x7 client, fake, error codes                                            | ✅                      |
| T2 model, ledger, rate card, engine hold/capture/release, migration 0025, DATA_MAP    | ✅                      |
| T3 superadmin enable / IVRs / status / webhook registration, phone-line `voiceApi`    | ✅                      |
| T4 create / validate / estimate / preview, dispatcher + sweep exclusions              | ✅                      |
| T5 batch loop (hold → submit → capture, gating, window, stop, uncertain, resolve)     | ✅                      |
| T6 secret webhook, poller, idempotent results, call rows, completion                  | ✅                      |
| T7 frontend: three-type picker, voice wizard, detail batches, admin cards, rate field | ✅                      |
| T8 docs, changelogs, release notes, channel guide                                     | ✅                      |
| T9 final checks                                                                       | ✅ with the notes below |

## Final checks (one run each; logs in the session scratchpad `final/`)

- Backend: lint ✅, build ✅, OpenAPI check ✅, typecheck ✅ after one test-type fix.
- Backend suite: the first run lost its in-memory MongoDB midway (`ECONNREFUSED`, 124 files
  cascaded). Failed files were rerun: all pass except the items below. Coverage was not run
  (owner asked for speed).
- Frontend: lint ✅, build ✅; suite 1574 / 1583 passed — 8 of 9 failures passed on rerun (load).
- New tests: client 10, backend integration 5 + webhook 1, frontend 3 — all pass.

## Known failures not caused by this work (also on `main`)

- `tests/security/phase15-routes.test.ts` (2): Phase 19 route `GET /whatsapp/channels/{id}/calling/quote`
  missing from the public-API snapshot and record map — needs an owner decision on its API-key exposure.
- Frontend `inbox-page.test.tsx` "Retry a failed send" — fails on `main` too.
- `tests/whatsapp-campaigns/campaigns.test.ts` recurrence case compares with a fixed
  "today 09:00" time — clock-dependent, untouched by this work.

## Live / release (not done)

Set `VOICE_API_PROVIDER=cell24x7`, `CELL24X7_WEBHOOK_SECRET` on the server (the token is in
the local `.env` only), register the webhook, price + enable a test account, send a 1-number
campaign to the owner's phone. The PDF does not name every `/details` field: confirm parsing
on that first live check. See [cell24x7-voice.md](../integrations/cell24x7-voice.md).
