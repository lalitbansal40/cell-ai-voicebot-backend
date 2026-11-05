# Phase 19 continuation — local sign-off

5 November 2026. **Local implementation complete; live/provider release checks remain open.** Final command results
are listed below; this document does not approve production deployment or real traffic.
Both repositories stay on `feature/phase-19-reseller-campaigns`. No push, merge, deploy,
client sync, real customer call/message, provider spend or real payment was performed.

## Acceptance

| Case                             | Local evidence                                                                                                                                       | Status                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| A1 Three campaign types          | URL/list/wizard tests and browser: SIP / Normal, WhatsApp messages, WhatsApp calls                                                                   | Pass                                     |
| A2 Shared 18/75 caps             | Atomic Redis controlled-clock tests, two workers/retries/downgrade/failure; 2000-send wall-clock benchmark                                           | Pass                                     |
| A3 Wallet/tier/lifecycle/restart | Campaign/inbox integrations, stable IDs, paused hard-restart benchmark, matching counters/charges                                                    | Pass; acknowledgement-loss caveat below  |
| A4 Bulk campaigns                | Audience/category/market estimates, sensitive variables, media/location, recurrence, A/B, live report/retry/CSV tests and completed browser campaign | Pass                                     |
| A5 WhatsApp call campaigns       | Agent without fake flow ID, pinned flow, owned ready sender, consent at snapshot/dial, ask-first replay, unanswered limit, 100-recipient dry run     | Pass                                     |
| A6 Incoming/outgoing AI          | Existing agent/handoff/billing suites; real published flow host through both WhatsApp session directions; Contact-agent browser call                 | Pass locally; real devices open          |
| A7 Number-scoped templates       | Same-WABA/foreign tenant guards, scoped multipart upload, frozen builder sender, URL/cache tests and approval/send browser flows                     | Pass                                     |
| A8 Shared call choices           | Contact main/row, Calls, Inbox chooser; SIP/WhatsApp/both/multiple/read-only matrix and sender/contact quote/consent; no fallback                    | Pass                                     |
| A9 Regressions                   | Original/affected SIP, inbox, roles, templates, wallet, signup, reseller credit/view/act browser checks                                              | Pass across checkpoint + affected reruns |
| A10 Evidence/docs/contracts      | Full checkpoint and failed attempts preserved; affected fixes/reruns, coverage method and final command status below                                 | Pass locally                             |

## The one full-suite checkpoint

Frozen candidate: backend `fc8db33`, frontend `c6021b3`. Logs and actual exit codes:
`/tmp/cav-p19r-final/status.tsv`. These original runs failed; they are not relabeled green.

| Check                                                 | Original result                                                            | Statements / branches / functions / lines                  |
| ----------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Backend                                               | 381 files: 375 passed / 6 failed; 3963 passed / 7 failed / 1 skipped tests | 95.32 / 86.12 / 94.42 / 96.96%                             |
| Frontend                                              | 148 files: 146 passed / 2 failed; 1537 passed / 3 timeouts                 | 94.70 / 90.31 / 91.17 / 95.43%                             |
| Browser                                               | 18 passed / 18 failed / 39 not run                                         | Signup limiter/proxy and stale fixture assumptions exposed |
| Builds, OpenAPI, frontend contract, production audits | Passed                                                                     | Separate final checks after fixes below                    |

No second full suite was run. Only affected files/checks were rerun after fixes.
An overlapping affected-coverage/browser trial hit resource pressure and MongoDB
connection timeouts; failed/interrupted logs remain `/tmp/cav-p19r-*-affected-coverage.log`
and `/tmp/cav-p19r-browser-fixes2.log`. Heavy checks then ran serially.

## Fixes and affected passing evidence

- Environment table/example and generated guide drift corrected. Retired
  `auth.email_verified` stays in the audit catalogue with explicit retired metadata;
  every active action still needs a writer. Privacy and money-write guards remain intact.
- Contact variable reads use the central send-purpose reader; snapshots/estimates do
  not retain plaintext. Billing-core aggregation counts actual captured charges using
  stable client IDs and message IDs across retries. CSV formula cells are escaped.
- Recipient status/reply changes and counters commit together. Concurrent duplicate /
  late events and injected rollback/retry are tested. Failed-to-delivered/read recovery
  clears failed buckets and increments accepted counts once.
- Recurrence stops active child recipients; insufficient funds pause before a fresh
  snapshot and resume snapshots once. Durable header replacement/deletion preserves
  shared files and cleans rejected/raced/failed writes.
- Archived WhatsApp flow programs are rejected/paused. Sender/contact price quotes use
  the sender's payer, destination market and account rates without provider costs.
- Template multipart parsing accepts exactly one file plus the selected channel field.
  Invalid sender URLs hide cached rows/languages. Open builders keep their sender.
- Reseller signup/login and the auth guard use the same panel default; safe same-app
  return links remain. Browser helpers await the final heading; current view/back labels,
  scoped customer headings and required campaign idempotency headers are used.
- Pacing guards run before final acquisition and repeat after a short sleep. Fake logs
  preserve acceptance time and separately record provider method-entry `attemptedAt`.

Selected passing reruns (overlap intentionally not summed):

| Area                                                                      | Passing result                                     | Log                                             |
| ------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------- |
| Backend guards / message HTTP workflows                                   | 51 passed / 1 skipped                              | `/tmp/cav-p19r-guards-fix-tests.log`            |
| Message counter/media/recurrence and inbound ordering                     | 25 passed                                          | `/tmp/cav-p19r-atomic-tests.log`                |
| Backend serial failures recheck                                           | 79 passed; one new snapshot failure then corrected | `/tmp/cav-p19r-be-serial-tests.log`             |
| Latest routes, runtime and campaign workflows                             | 37 passed                                          | `/tmp/cav-p19r-be-final-focused-tests.log`      |
| Dispatcher, live delegation, unavailable programs, ask-first/export hooks | 36 passed                                          | `/tmp/cav-p19r-be-dispatcher-final-tests.log`   |
| Final pacing change                                                       | 35 passed                                          | `/tmp/cav-p19r-attempt-tests.log`               |
| Real published flow incoming/outgoing                                     | 2 passed (selected tests)                          | `/tmp/cav-p19r-published-flows-tests.log`       |
| Frontend serial affected files                                            | 104 passed in 11 files                             | `/tmp/cav-p19r-fe-serial-tests.log`             |
| Auth/reseller redirect                                                    | 24 passed                                          | `/tmp/cav-p19r-fe-auth-coverage.log`            |
| Original templates/interactive/live timeout recheck                       | 71 passed                                          | `/tmp/cav-p19r-fe-reruns.log`                   |
| Browser campaign/template/Contact/roles                                   | 13 passed; reseller failure separately fixed       | `/tmp/cav-p19r-browser-serial.log`              |
| Reseller credit/create/login-as/return/reclaim                            | 2 passed                                           | `/tmp/cav-p19r-reseller-browser-final2.log`     |
| Impersonation                                                             | 1 passed                                           | `/tmp/cav-p19r-impersonation-browser-final.log` |

All 75 originally planned browser cases have passing evidence across the frozen
checkpoint and affected reruns. This is not a claim that a new complete browser run
passed at once. Earlier 52-pass/4-failure recheck supplied the remaining unchanged
inbox/calling/billing/role cases. No assertion, timeout, permission guard, production
rate limit or coverage threshold was weakened.

## Coverage checkpoint

The original full reports remain in the primary repositories. Focused reports live in
`/tmp/cav-p19r-be-*-coverage` and `/tmp/cav-p19r-fe-*-coverage`. Narrow coverage runs include
the entire source denominator, so their global-threshold exit is expected to be 1;
their individual test results are stated separately above.

Combined checkpoint evidence uses current-source focused reports for changed files,
and the original full report for unchanged files. Only reports whose source matches
current source after formatting normalization are eligible. For each file/metric,
the numerator is the largest measured covered count and the denominator the largest
measured total across eligible reports. This is a conservative bound, not a second
full run or a fabricated union of execution counts. New executable lines use LCOV
line hits from matching current lines; deleted/changed lines never inherit stale hits.
The final recorded totals and commands are in the evidence JSON beside this sign-off.
Thresholds remain backend 95/85/95/95 and frontend 95/90/90/95; new executable lines ≥95%.

## Final command and coverage results

Both repositories: full lint (zero errors/warnings), typecheck, build, regenerated API
comparison and `npm audit --omit=dev` pass; audits report zero production vulnerabilities.
Backend typecheck initially caught test mock return types; the corrected check exits 0.
Final privacy/money/audit/environment/docs guards: 33 passed / 1 existing skipped test.
Latest sender/fake-provider/WhatsApp-runtime coverage rerun: **103/103 tests across 7 files**.
Credential pattern scan of added lines since the continuation baselines found no private
keys, provider-key literals or JWT literals. Secret env files were never inspected.

| Checkpoint | Statements | Branches | Functions |   Lines | New executable lines |
| ---------- | ---------: | -------: | --------: | ------: | -------------------: |
| Backend    |    95.273% |  86.174% |   95.027% | 96.892% |     525/549 = 95.63% |
| Frontend   |    95.077% |  90.864% |   91.869% | 95.809% |     624/644 = 96.89% |

The final pacing edit changes two large existing source files. Thirty previously
executed, otherwise unchanged functions in those files retain baseline evidence only
when the same LCOV identifier resolves to one TypeScript node and its full token hash
matches the current function exactly. Modified functions use current execution evidence.
Those per-function proofs are persisted in the [evidence JSON](evidence/PHASE_19_LOCAL_CHECKS.json),
along with exact covered/total counts, command paths, log hashes, all 75 passing browser
cases and the failed original checkpoint. This limited reuse adds no synthetic hits.

## Performance

Latest `/tmp/cav-p19r-perf-final3.log`: **PASS**, 71.705 s. Two campaigns share each
sender, 1000 recipients per sender; peaks 17 and 48 per rolling 1000ms under 18/75 caps;
2000 unique client/provider IDs, 2000 captures, exact message/recipient/counter matches.
Hard restart recovers after all campaigns pause and fake callbacks quiesce.

Earlier failed benchmarks included fake error knobs, callback loss from killing active
fake sends, incorrect queue/ledger assertions, a missing worktree build, and a post-fix
19-record rolling window on the 18 sender. Final pacing order/provider-entry timing
corrected the last defect without changing caps or the rolling-window assertion.
[Capacity methodology](../ops/capacity.md) distinguishes this from controlled-clock
proofs and from arbitrary provider acknowledgement loss. Existing provider/network
idempotency limits still apply; no distributed app can infer an unacknowledged external
send with certainty from a paused fake restart.

## Migrations, catalogues and live work

Apply additive 0021/0022 then 0023/0024; `sentCounted` includes legacy failed rows with
`sentAt`. Refresh Meta classification: unknown is 18 until explicit read-back confirms
regular Cloud API. `WA_CAMPAIGN_MPS` only lowers caps; max recipients defaults to 100000.
No new permission, ledger type, audit action, notification, error or WS event was added
by the continuation. Original Phase 19 catalogue tests and current role tests pass.
See [release notes](../ops/release-phase-19.md), [channel guide](../conventions/campaign-channels.md)
and [data map](../security/DATA_MAP.md).

Real Meta incoming/outgoing calls on owner devices, carrier SIP calls, production
capacity/server checks, migrations/backups and deployment remain unrun and require
separate owner authorization/test numbers. White-label, commission engine, click
tracking and Phase 20 incoming SIP remain separate planned work.
