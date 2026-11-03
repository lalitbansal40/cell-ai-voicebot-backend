# Phase 18 — Tasks (tracker)

Plan: [PHASE_18_PLAN.md](PHASE_18_PLAN.md) · Branch: `feature/phase-18-sip` · Tests: plan §6 (each suite once per checkpoint)

| ✓   | #      | Task                                                    | Repo | Size | Batch |
| --- | ------ | ------------------------------------------------------- | ---- | ---- | ----- |
| [x] | T18.1  | Inputs, trunk questionnaire, ADR 0022 accept + ADR 0050 | docs | S    | B1    |
| [x] | T18.2  | Asterisk kit (image, config templates, compose, lab)    | ops  | M    | B1    |
| [x] | T18.3  | ARI client (REST + events, reconnect)                   | BE   | M    | B1    |
| [x] | T18.4  | RTP media bridge (G.711 ↔ PCM16, jitter, port pool)     | BE   | M    | B1    |
| [x] | T18.5  | `SipCallLeg` + `SipTelephonyProvider`, cause mapping    | BE   | M    | B1    |
| [x] | T18.6  | Config, line selection, boot checks                     | BE   | S    | B1    |
| [x] | T18.7  | Phone numbers + caller ID per account                   | both | M    | B2    |
| [x] | T18.8  | Dialer on SIP: trunk concurrency, CPS, retries by cause | BE   | M    | B2    |
| [x] | T18.9  | Answering machine detection                             | BE   | M    | B2    |
| [x] | T18.10 | Billing: pulse, trunk cost, reconcile                   | BE   | S    | B2    |
| [x] | T18.11 | Recording + transcripts at 8 kHz                        | BE   | S    | B2    |
| [x] | T18.12 | Disposition saved on mid-turn hangup                    | BE   | S    | B2    |
| [x] | T18.13 | Reliability: reconnect, sweeps, restarts, media timeout | BE   | M    | B2    |
| [x] | T18.14 | Security + toll-fraud guard                             | both | S    | B3    |
| [x] | T18.15 | Monitoring: System page, healthwatch, call metrics      | both | S    | B3    |
| [x] | T18.16 | Frontend: line, caller ID, causes, AMD, admin numbers   | FE   | M    | B3    |
| [x] | T18.17 | SIP test suite (`test:sip`) + CI job                    | both | M    | B1→B3 |
| [ ] | T18.18 | Real trunk test calls (Gate S)                          | ops  | S    | B3    |
| [x] | T18.19 | Load: SIPp up to trunk limit                            | BE   | S    | B3    |
| [ ] | T18.20 | Rollout on production (Gate P + S)                      | ops  | S    | B3    |
| [x] | T18.21 | WhatsApp over SIP: research note                        | docs | S    | B3    |
| [x] | T18.22 | Gap audit, docs, sign-off                               | both | S    | B3    |

Open (Gate S / P, see [sign-off](PHASE_18_SIGNOFF.md) §5): T18.18 real trunk calls, T18.20 production rollout — checklists and steps are written.
