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
