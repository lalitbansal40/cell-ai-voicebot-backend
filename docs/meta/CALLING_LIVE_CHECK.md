# WhatsApp calling — live check (Phase 18B, T18B.7)

**Date:** 2026-11-04 · **Result: not run.** The inputs a real call needs are not available in this run. Nothing below was tried against Meta or a real phone.

## Missing inputs

| Input                                                                                             | Why it is needed                                | Status                                                  |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| A Cloud API number with messaging limit ≥ 2,000 / day (or Meta's public test number with calling) | Meta switches calling on only for these numbers | Not provided (the review number's tier is unknown here) |
| App subscribed to the `calls` webhook field                                                       | Without it no call event reaches us             | Not checked on the real app (no app secret in this run) |
| This branch released on a reachable server with UDP 40000–40999 open and `WA_MEDIA_PUBLIC_IP` set | Call audio goes to the server, not the browser  | No server access                                        |
| Two owner phones with WhatsApp                                                                    | Real calls only to the owner's phones           | Not available in this run                               |

## Steps (`docs/setup/meta-whatsapp.md` §15, real-device checklist)

| #   | Step                                                                           | Result  | Missing input                               |
| --- | ------------------------------------------------------------------------------ | ------- | ------------------------------------------- |
| 0   | Readiness checklist all green on the number                                    | not run | number, `calls` subscription, server        |
| 1   | Call permission request (in window → interactive; outside → approved template) | not run | number, phone, approved permission template |
| 2   | Agent call from the browser: ring, two-way audio, hold, keypad, hang up        | not run | number, server, phone                       |
| 3   | AI call: key press runs the flow branch                                        | not run | number, server, phone                       |
| 4   | Customer calls, route team: first Accept wins, missed call bubble              | not run | number, server, phone                       |
| 5   | Customer calls, route AI → team: takeover on the same call                     | not run | number, server, phone                       |
| 6   | Recording notice and playback with both sides                                  | not run | number, server, phone                       |
| 7   | Mouth-to-ear latency (< 400 ms)                                                | not run | server, phones                              |
| 8   | Meta's call duration vs our pulses (± 1); wallet price                         | not run | number, Meta Insights access                |
| 9   | Session logs: no SDP lines, phones, names or digits                            | not run | server logs of a real session               |

## What the platform shows meanwhile

With the fake Meta (tests `tests/calls-wa/readiness.test.ts`, `settings-readback.test.ts`), **Number → Calling** lists each failing item with its fix (low messaging limit, `calls` webhook not subscribed, call audio not ready, prices placeholder) and refuses to switch calling on while a blocking item fails; a switch WhatsApp did not apply shows "WhatsApp did not apply the change". On a real number the same checklist tells the owner exactly which of the inputs above is missing.

## To run it

1. Release this branch on the server (UDP 40000–40999 open, `WA_MEDIA_PUBLIC_IP` set); check **Admin → System → WhatsApp calls**.
2. Open **WhatsApp → Numbers → Calling** on the production number; make every item green.
3. Create and get approved a call permission template (WhatsApp → Templates → Create call permission template).
4. Run steps 1–9 above with the owner's phones; record date, pass / fail, latency and durations here (last 4 digits only).
