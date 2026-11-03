# Phase 18 — Sign-off

**Date:** 2026-11-03 · **Branch:** `feature/phase-18-sip` (both repos, not merged) · **Plan:** [PHASE_18_PLAN.md](PHASE_18_PLAN.md) · **Prompt:** [PHASE_18_PROMPT.md](../prompts/PHASE_18_PROMPT.md)

**Verdict:** the SIP line is **built and proven in the Mac lab** against a real Asterisk 22 with SIPp playing the trunk: two-way audio, every pre-answer result, customer hangup, answering machines, transfer, an Asterisk restart, and 30 calls at once with 0 % loss. **No real carrier call was made and nothing is on the server:** there are no trunk details (Gate S) and still no server access (Gate P, Phase 17). Every account stays on the test line until a superadmin switches it; the switch, the guards and the rollback are in place.

## 1. Tasks

| Task   | Done here                                                                                                                         | Waits for                                    |
| ------ | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| T18.1  | ADR 0022 accepted (Asterisk 22 LTS, ARI + ExternalMedia RTP), ADR 0050 (SIP on the shared server), trunk questionnaire            | —                                            |
| T18.2  | Asterisk image (pinned base, our config rendered from env, 46 modules), compose profile `sip` for staging and production, Mac lab | —                                            |
| T18.3  | ARI client (REST + events, reconnect)                                                                                             | —                                            |
| T18.4  | RTP: packets, jitter buffer, port pool, G.711 session                                                                             | —                                            |
| T18.5  | SIP leg and provider; Q.850 → cause table; `machine`                                                                              | —                                            |
| T18.6  | Env, per-account line, migration 0019, real SIP calls in the call manager (hold, bill, record)                                    | —                                            |
| T18.7  | Phone numbers (superadmin pool, caller ID per account / campaign)                                                                 | Real 1600 numbers                            |
| T18.8  | Trunk channels and calls per second across processes; declined calls not retried                                                  | —                                            |
| T18.9  | AMD: hang up or leave a message                                                                                                   | Tuning on real voicemail                     |
| T18.10 | Pulse by rate card + account override, trunk cost, CDR reconcile                                                                  | The trunk's rate and CDRs                    |
| T18.11 | 8 kHz recordings                                                                                                                  | Hindi accuracy at 8 kHz (no OpenAI key here) |
| T18.12 | Disposition kept on a mid-turn hangup (Phase 17 finding; closed the wrong-number flake)                                           | —                                            |
| T18.13 | Reconnect, orphan channels, line-down waits, Asterisk restart                                                                     | —                                            |
| T18.14 | Number guard, spend guard, redaction, threat model, firewall rules                                                                | Firewall applied by the client's admin       |
| T18.15 | System SIP card, healthwatch rules, superadmin bell                                                                               | UptimeRobot (Phase 17)                       |
| T18.16 | Admin phone numbers, account Phone line card, live campaign settings, call detail, System card, one Playwright spec               | —                                            |
| T18.17 | `npm run test:sip` (11 lab checks), CI workflow for SIP changes                                                                   | —                                            |
| T18.18 | Checklist and status written                                                                                                      | **Gate S**: trunk details, test numbers      |
| T18.19 | `perf:sip` 30 calls                                                                                                               | Staging / production-sized server            |
| T18.20 | Rollout and rollback steps, six runbook rows                                                                                      | **Gate P + S**                               |
| T18.21 | WhatsApp over SIP note (not now)                                                                                                  | —                                            |
| T18.22 | This sign-off, docs                                                                                                               | —                                            |

## 2. Numbers

|                                                     | Before Phase 18               | After                                                         |
| --------------------------------------------------- | ----------------------------- | ------------------------------------------------------------- |
| Backend tests                                       | 3,790 (+1 skipped)            | 3,893 (+1 skipped), all green                                 |
| Backend coverage (stmts / branches / funcs / lines) | 96.06 / 87.38 / 95.6 / 97.58  | 95.95 / 87.17 / 95.34 / 97.51 (gate 95 / 85 / 95 / 95)        |
| Frontend tests                                      | 1,471                         | 1,481                                                         |
| Frontend coverage                                   | 96.12 / 92.33 / 93.66 / 96.81 | 95.84 / 92.04 / 93.03 / 96.53 (gate 95 / 90 / 90 / 95)        |
| Playwright                                          | 169                           | 170, all green (26 min), backend log grep 0 for every pattern |
| SIP lab (`test:sip`)                                | —                             | 11 / 11                                                       |
| Error codes / audit actions / notifications         | 103 / 167 / 36                | 107 / 173 / 38                                                |

**Load (`perf:sip`, Mac lab, 30 calls × 60 s, bot talking all the time):** 30 / 30 answered, 0 % loss, 1.2 ms jitter, 10.5 % of a core in our process, event loop p99 12 ms, Asterisk 0.3 % CPU / 88 MB, no leaked ports.

**Test runs (owner's rule: each suite once):** B1 backend run — result not usable (exit code of a wrapper, Docker had stopped). B2 backend once — 3,878 passed, 6 failed (5 real gaps fixed in `2c4db6a`, 1 load flake). Sign-off run once: Playwright 170 / 170, `test:sip` 11 / 11, builds and OpenAPI green; backend 1 real gap (erase map entry for `phoneNumbers`, fixed in `7b8e64d`); frontend 1 load flake. The coverage report is not printed when a test fails, so both suites ran once more with coverage (`--coverage.reportOnFailure` the second time): backend all green; frontend 9 tests timed out at 15 s under coverage load in heavy files (templates, agent functions, reports, campaign wizard) — those files passed alone (154 / 154). **The frontend never had one fully green run with coverage in this phase**; its numbers above are from the run with the 9 timeouts.

## 3. Deviations

- Asterisk image: the maintained `andrius/asterisk:22` base pinned by digest with our config, not a source build.
- One SIPp scenario plays every trunk case by the dialed number's last digit (no separate agent container).
- Each process has its own ARI app (`cav-api`, `cav-worker`): Call now runs in the API process.
- `SIP_PCMU_PASSTHROUGH` not built: G.711 in TypeScript costs ~0.35 % of a core per call (T18.19).
- `SIP_BILLING_PULSE_SEC` dropped: the rate card has the pulse; accounts override it.
- After a transfer the call is billed until it ends (customer + agent time); the agent leg's carrier cost is not split out.
- The spend guard rings the bell; no e-mail for it (the healthwatch e-mail covers the line itself).
- DTMF over RFC 4733 from a real phone is not in the lab (SIPp sends none); the ARI DTMF path is unit-tested.

## 4. Bugs and findings

| What                                                                                                        | Where                   |
| ----------------------------------------------------------------------------------------------------------- | ----------------------- |
| A hangup during an AI turn lost the decided disposition (Phase 17 finding)                                  | `f97fb91`               |
| Asterisk re-INVITEd the trunk for connected-line names (SIPp, and some carriers, drop the call)             | `02be7a9`               |
| Asterisk 22.11 segfaults when its RTP range runs out; range must be ≥ 4 × channels                          | ADR 0050, `capacity.md` |
| B2 suite: phone numbers missing from OpenAPI, DATA_MAP, tenant rules; body `accountId`; migration step-down | `2c4db6a`               |
| A 0-second answered call charges nothing (existing pulse rule)                                              | noted                   |

**Flakes:** `calls-wa/leg-media` "10 legs in parallel" failed under the full suite and passed alone (WhatsApp media, not Phase 18). Frontend under coverage load: `templates-page`, `functions-knowledge`, `reports`, `campaigns-pages`, `contact-detail`, `inbox/entry-points`, `agents-pages`, `calls-pages`, `campaign-detail`, `flows-pages` time out at 15 s; each passes alone. Backend: `calls/flow-call` (max duration) failed once in a coverage run and passed alone 10 / 10. The Phase 17 wrong-number flake (`calls/outbound`, `db/seed-calls`) is closed by T18.12.

## 5. Open items

| Item                                                                                                                                               | Owner                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Trunk details (host, auth, IPs, codecs, DTMF, channels, CPS, 1600 numbers, rate, CDRs, test window) — [sip-trunk.md](../integrations/sip-trunk.md) | Client                 |
| Server access, staging (Phase 17 Gate P)                                                                                                           | Owner / client admin   |
| 10 real test calls (T18.18), production rollout + rollback drill (T18.20)                                                                          | Us, after both gates   |
| Firewall: SIP / RTP open to the trunk IPs only                                                                                                     | Client admin           |
| Hindi recognition at 8 kHz vs 24 kHz                                                                                                               | Us, with an OpenAI key |
| AMD tuning on real voicemail greetings                                                                                                             | Us, with the trunk     |
| §7 owner questions (pulse, AMD default, machine charging, spend limit, TLS) — defaults in use                                                      | Owner                  |
| Merge the Phase 18 branches to `main`                                                                                                              | Owner                  |
