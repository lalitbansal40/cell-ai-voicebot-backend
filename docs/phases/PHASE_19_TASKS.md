# Phase 19 — Tasks (tracker)

Plan: [PHASE_19_PLAN.md](PHASE_19_PLAN.md) · Prompt: [PHASE_19_PROMPT.md](../prompts/PHASE_19_PROMPT.md) · Branch: `feature/phase-19-reseller-campaigns` · Tests: targeted per task; full suites at B2 and sign-off only

**Active resume prompt (5 Nov 2026):** [PHASE_19_CONTINUATION_PROMPT.md](../prompts/PHASE_19_CONTINUATION_PROMPT.md).
Resume from existing work. B2 is historical; the next full-suite checkpoint is final sign-off.
The earlier approximate 20% remaining estimate predates the expanded scope below.

| ✓   | #      | Task                                  | Repo | Size | Batch |
| --- | ------ | ------------------------------------- | ---- | ---- | ----- |
| [x] | T19.1  | Account kinds and parent              | be   | S    | B1    |
| [x] | T19.2  | Signup without e-mail                 | both | M    | B1    |
| [x] | T19.3  | Log in as v2 (view / act)             | both | M    | B1    |
| [x] | T19.4  | Superadmin resellers and users        | both | M    | B1    |
| [x] | T19.5  | Reseller API                          | be   | M    | B2    |
| [x] | T19.6  | Credit transfer                       | be   | M    | B2    |
| [x] | T19.7  | Reseller dashboard numbers            | be   | S    | B2    |
| [x] | T19.8  | Reseller panel                        | fe   | M    | B2    |
| [x] | T19.9  | WhatsApp campaign model + audience    | be   | M    | B3    |
| [x] | T19.10 | Estimate + wallet                     | be   | S    | B3    |
| [x] | T19.11 | Sender + tier pacing                  | be   | L    | B3    |
| [x] | T19.12 | Stats, replies, retry, export, report | be   | M    | B3    |
| [x] | T19.13 | Campaign wizard + dashboard           | fe   | L    | B3    |
| [x] | T19.14 | Roles, limits, catalogue              | both | S    | B3    |
| [x] | T19.15 | WhatsApp call campaigns               | both | M    | B4    |
| [x] | T19.16 | E2E, perf, docs, sign-off             | both | M    | B4    |

## Continuation — owner additions and remaining acceptance gaps

Prepared 5 Nov 2026; unchecked means implementation/verification is still pending.
Original ticks above describe the earlier checkpoint, not completion of this amendment.
T19.14's frontend permission checks still need verification with the unfinished UI.
Uncommitted frontend wizard/dashboard/tests must be completed and validated before T19.13 is ticked.

| ✓   | #       | Task                                                                                    | Repo | Original coverage                                                   |
| --- | ------- | --------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------- |
| [x] | P19R-T1 | Resume audit, entry-point inventory, shared capability contract                         | both | Reconcile current work                                              |
| [x] | P19R-T2 | Per-sender shared 18/75 msg/sec limiter and pacing tests                                | both | Extends T19.11/T19.14                                               |
| [x] | P19R-T3 | Three-type campaign UI; finish message wizard, recurrence, media and accurate estimates | both | Completes T19.13 and frontend T19.14; fixes backend acceptance gaps |
| [x] | P19R-T4 | WhatsApp call campaigns with AI flow/agent and ask-permission-first                     | both | Completes/extends T19.15                                            |
| [x] | P19R-T5 | Incoming/outgoing WhatsApp AI setup and runtime verification                            | both | Reuse existing Phase 12/18B features                                |
| [x] | P19R-T6 | WhatsApp number filter through template creation, approval and sending                  | both | Strengthen existing filter/WABA scoping                             |
| [x] | P19R-T7 | Shared Normal/WhatsApp call method and sender choices at all relevant entry points      | both | New owner requirement                                               |
| [x] | P19R-T8 | E2E/perf, regressions, contracts/docs/catalogues and honest final sign-off              | both | Completes/extends T19.16                                            |

Acceptance criteria and test cases: continuation prompt §1–§3. Do not tick a row merely
because a screen or test file exists; record passing evidence and remaining live checks.

Local continuation checks completed on 5 Nov 2026. See [sign-off](PHASE_19_SIGNOFF.md) and its evidence JSON for original failures, affected reruns, coverage and 75 browser cases. T19.16/P19R-T8 ticks describe local delivery; real Meta/SIP, production and owner test-number checks remain explicitly open.
