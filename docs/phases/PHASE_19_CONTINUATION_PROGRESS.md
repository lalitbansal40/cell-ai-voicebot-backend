# Phase 19 continuation progress

Started 5 Nov 2026. Both repos remain on `feature/phase-19-reseller-campaigns`.
Backend baseline `f043528`; frontend baseline `96f3eff`. Existing uncommitted frontend
wizard, API contracts, routes, entry points and tests are preserved. Local `cav-mongo`,
`cav-redis`, `cav-mailpit` are healthy. No existing test/build process was running.

## Current state

Local P19R-T1–T8 and original T19.13/T19.15/T19.16 are implemented and verified.
[Sign-off](PHASE_19_SIGNOFF.md) records 75 browser cases, final command results and
coverage: new executable lines backend 95.63%, frontend 96.89%. Latest pacing/runtime
rerun 103/103, guard suite 33 passed / 1 existing skipped; both builds/contracts/audits
pass. The 2000-send benchmark passes at peaks 17/48 under 18/75 with exact counters,
charges and zero duplicate IDs. Live Meta/SIP/server checks remain open. The sections
below preserve the initial inventory and failures; they are historical observations.

## Initial entry-point inventory (historical)

| Entry point                         | Existing implementation                                            | Continuation state                                                     |
| ----------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Campaign list/create                | `CampaignsPage`, phone wizard, uncommitted WhatsApp message wizard | Open: three types, WhatsApp call program, complete message wizard      |
| Campaign message worker             | `whatsapp-campaigns/dispatch.ts`, inbox `send.job.ts`              | Open: shared per-channel 18/75 pacing at actual provider send          |
| Templates list/create/approval      | `TemplatesPanel`, `TemplateBuilder`, template services             | Open: URL number filter, explicit create sender, fixed builder context |
| Template sends                      | Inbox dialog, `ContactTemplateButton`, campaign dispatcher         | Verify owned sender/WABA; finish campaign media and estimates          |
| Contact primary call                | `ContactDetailPage` → SIP `CallNowDialog`                          | Open: shared method/sender chooser                                     |
| Contact WhatsApp call card          | `ContactCallingCard` → `CallButton`                                | Existing permission path; open shared capability choices               |
| Calls page                          | `CallsPage` → `NewWhatsAppCallDialog`                              | Open: shared method/sender choices                                     |
| Inbox header call                   | WhatsApp `CallButton`                                              | Open: shared chooser, preserve current conversation sender             |
| Incoming WhatsApp AI                | settings `inbound.aiProgram`, webhook/runtime                      | Existing flow/agent support; verify both execution directions          |
| Outgoing WhatsApp AI                | `CallWithAiDialog`, `ProgramPicker`, `startOutbound`               | Existing single-call support; campaign integration pending             |
| Contact/list/segment campaign links | Uncommitted WhatsApp wizard links                                  | Verify role/prefill and add type choices where appropriate             |

At the initial checkpoint, original T19.13/T19.15/T19.16 and frontend T19.14 validation remained pending. Backend
recurrence, campaign media, accurate skip/category estimates are acceptance gaps despite
the historical campaign task ticks. The initial inventory predates the full suite and subsequent checks below.

## Validation log

- Baseline frontend typecheck passed. Draft wizard baseline: 7 failing tests (mock import order and ambiguous field selectors); corrected test setup/selectors, then 7/7 passed.
- P19R-T1: frontend capabilities 4/4 tests, typecheck and targeted ESLint passed; commit `1616eec`.
- P19R-T2: backend limiter/campaign/outbound/bulk-permission regressions 52/52 passed across 4 files; typecheck and full lint passed. Shared Redis budget covers the provider-send path. Final sign-off is pending.

## Task decisions and evidence

- P19R-T1: shared public capability helpers distinguish messaging from calling; Business
  App/coexistence remains messaging-only; WhatsApp-only campaign read roles do not gain
  SIP/calling campaign access. Backend readiness/dial guards remain authoritative.

- P19R-T2: atomic rolling-window limiter uses Redis time, no future reservations, bounded TTL, and fails closed. All message sources consume one sender budget; interactive sends have queue priority 1, bulk work priority 10. Batch sleep is replaced by provider pacing.

- P19R-T3 message engine: shared dry-run audience resolution now prices eligible contacts by assigned variant category/market, returns skips/shortfall and propagates pricing failures. Durable campaign headers are copied per recipient; recurring runs have a unique root/occurrence index (migration 0023). Completion waits for provider acceptance; queued messages obey pause/stop. Sent→failed tracking and retry send-count deduplication are fixed. Backend targeted campaign/migration checks: 16/16; frontend draft/wizard/detail checks: 16/16. Three-type navigation and final regression checks remain open.

## Continuation implementation checkpoint

P19R-T3/T4/T6/T7 are implemented; final integration remains P19R-T8. P19R-T5 reuses
the existing program/runtime: inbound, outbound, handoff and settings-readback targeted
checks passed (the first combined run had only a newly added template fixture failure,
subsequently fixed). Existing browser flow execution plus the new Contact-agent scenario
are included in the final affected browser run.

- Call-campaign backend regression: 68/68 across five files. The 100-contact pure-agent
  dry run passed after fixing the simulator's inappropriate DTMF steps for agent-only calls.
  Two earlier 100-contact timeouts were real simulator defects, not green flakes.
- Shared picker/template/Contact final targeted frontend checks: 49/49. Other affected
  UI checks: 105 passed with one immediate-loading selector failure; selector corrected
  and Contact file then passed 10/10.
- Post-queue pause/stop and actual provider acceptance are enforced. Recovered accepted
  jobs reconcile tracking without resending. Further gates recheck template/quality.
- Template list formerly filtered stored channel associations; corrected to owned WABA
  and derived shared-number availability. New approval/edit/media validation retains this.
- Benchmark exposed a genuine report defect: normal capture references use stable client
  IDs, while late charges use message IDs. Reports now resolve both and include retries.
- Early perf runs did not drain because fixtures hit fake-provider failure knobs and
  because killing active provider callback timers lost fake delivery signals. The
  benchmark now pauses/quiesces all four campaigns before a hard process restart.
  It asserts 1000 attempts/messages/counted recipients per sender, rolling rate, zero
  duplicate IDs and actual capture sums; a run stopped on an incorrect ledger-query
  assertion, which was corrected without weakening the charge check. Final run pending.
- New contract flag prevents the legacy `isOnBizApp=false` default from being interpreted
  as confirmed regular-number classification. Old channels stay at 18 until read-back.
- Found/fixed auth limiter store reuse during real process startup; signup has its own
  hour-long Redis store. No limiter threshold was relaxed. Browser signup fixtures use
  distinct synthetic client IPs to represent separate visitors.

No full coverage or final Playwright run has been claimed yet. No push/deploy/client sync.

- Latest number-classification/template/message regression run: 94/94 across four files.
  Shared template/Contact/picker frontend run: 49/49. Backend typecheck and builds pass.
- The perf pause assertion now measures provider attempts rather than the number of
  queued DB rows (dispatch can finish creating rows already claimed before pause).
  Dispatch additionally checks lifecycle before every recipient and returns untouched
  claims when paused. Ledger-reference query correction retains the strict 1000-charge
  assertion; the next perf run is the release evidence, not earlier failed attempts.

- Wall-clock perf passed (`/tmp/cav-p19r-perf7.log`): 2000 actual provider sends,
  peaks 18/57 under 18/75 caps, 2000 unique client/provider IDs, 2000 captured charges,
  matching counters, paused hard restart recovered. Overall 72.107 s.
- Implementation is now frozen for the next full-suite checkpoint. Tests/sign-off
  fixes, if needed, will be recorded and run only against affected files afterwards.

### Post-checkpoint fixes and verification — 5 November 2026

Frozen checkpoint: backend `fc8db33`, frontend `c6021b3`. The single full run completed:
backend 381 files (375 passed, 6 failed), 3963 passed / 7 failed / 1 skipped tests;
frontend 148 files (146 passed, 2 failed), 1537 passed / 3 timed-out tests. Backend
coverage S/B/F/L was 95.32/86.12/94.42/96.96; frontend 94.70/90.31/91.17/95.43.
These original coverage gates failed and are not reported as passing full suites.
Both builds, OpenAPI comparison, generated frontend contract and production dependency
audits passed. Initial browser checkpoint: 18 passed, 18 failed, 39 not run.

Reversible fixes were prepared in detached local worktrees after the checkpoint;
main feature branches stayed unchanged during the run. Defects corrected:

- Optional environment declarations and generated public guides now match source.
- Sensitive custom fields use the central send-purpose reader, with no plaintext in
  audience snapshots/estimates; the privacy guard remains enabled.
- Campaign cost reads live in billing core, preserving the money-write guard.
- The retired email-verification audit action remains in history with explicit retired
  metadata; active-writer checks continue to cover every active action.
- Status/reply counters now commit with recipient changes in a transaction. Concurrent
  duplicate and late delivered/read events, plus injected rollback/retry, are tested.
- Recurring series stop also skips active child recipients. Fresh-run readiness,
  insufficient-wallet pause/resume and empty audience are tested.
- Durable header replacement/deletion preserves referenced files and releases unused
  copies; failed validation releases its new copy. CSV exports escape formula cells.
- Archived WhatsApp flow programs pause/reject execution; incoming/SIP pin policy stays
  intact. A new owned sender/contact quote shows only account selling prices.
- Multipart template headers accept the selected channel field as well as one file;
  browser testing caught the previous zero-field parser limit.
- Browser signup fixtures trust exactly the local proxy hop, await the final reseller
  heading, and preserve production signup thresholds. Role fixtures use current View as /
  Back to admin labels; campaign start supplies the required idempotency header.

Focused passing evidence before load testing: backend guards/routes 51 passed / 1 skipped;
quote routes 5/5; campaign atomic/media/recurrence 20/20; inbox + atomic earlier 25/25;
real WhatsApp runtime replay/cancel 1/1; live campaign delegation/readiness 4/4;
template routes including scoped multipart 8/8. Frontend original affected files 71/71,
new quote/API 6/6, wizard steps 7/7 and campaign page/draft 13/13.

First browser recheck: 52 passed, 4 failed, 4 not run. Scoped templates, message wizard
through completed report, incoming human/AI, roles, permissions, billing and wallet
passed. The four failures produced the selector/signup/idempotency/multipart fixes above.
A subsequent overlapping coverage/browser trial suffered local resource pressure and
MongoDB connection timeouts; it is failed/interrupted evidence, not a passing rerun.
Heavy checks will run serially. No test timeout or coverage threshold has been raised.
Final coverage/browser/perf rechecks and sign-off remain open.

### Final affected checks

- Single-worker frontend recheck: 104/104 across 11 files; auth redirect regression:
  24/24. New executable line evidence: 96.87% before the auth fix; refreshed final
  checkpoint is recorded in sign-off. Production thresholds remain unchanged.
- Backend serial recheck: 79 passed, one new duplicate-snapshot test failed. MongoDB /
  Mongoose exposes some bulk error codes as `writeErrors[].err.code`; normalization
  now accepts only duplicate-key codes and continues to throw every other write error.
  Subsequent affected runtime/routes/campaign checks: 37/37, dispatcher checks: 36/36.
- Both selected published-flow tests execute the real flow host through WhatsApp
  incoming/outgoing media/session runtimes and save `FlowRun` outcomes; 2/2 passed.
- Browser evidence now covers all 75 planned cases across the original frozen run and
  affected reruns. Latest campaign/template/Contact run: 13 passed / 1 reseller failure.
  Reseller redirect corrected in product; a transient duplicate heading in the return
  test was scoped to level 1. Reseller rerun 2/2 and impersonation rerun 1/1 passed.
- Pacing regression tests after moving guards before final acquisition: 35/35. The
  final wall-clock benchmark passes: 1000 recipients per sender, peak 17/48 under 18/75,
  zero duplicate IDs, 2000 captures and matching counters, hard restart; 71.705 s.
  See capacity.md for the failed 19-record run and corrected provider-entry timing.

Final lint/typecheck/build/contracts/audits and refreshed coverage are recorded in the
sign-off. No push, merge, deployment, customer traffic or client sync was performed.
