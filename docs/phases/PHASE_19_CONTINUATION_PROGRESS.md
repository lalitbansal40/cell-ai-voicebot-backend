# Phase 19 continuation progress

Started 5 Nov 2026. Both repos remain on `feature/phase-19-reseller-campaigns`.
Backend baseline `f043528`; frontend baseline `96f3eff`. Existing uncommitted frontend
wizard, API contracts, routes, entry points and tests are preserved. Local `cav-mongo`,
`cav-redis`, `cav-mailpit` are healthy. No existing test/build process was running.

## Entry-point inventory

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

Original T19.13/T19.15/T19.16 and frontend T19.14 validation remain pending. Backend
recurrence, campaign media, accurate skip/category estimates are acceptance gaps despite
the historical campaign task ticks. Final suite/sign-off has not run.

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
