# Phase 19 sign-off — candidate

5 November 2026. **Final verification pending; this is not a release approval.**
Both repos remain on `feature/phase-19-reseller-campaigns`. No push, merge, deployment
or client sync has been performed.

## Scope and current evidence

Original T19.1–T19.12/T19.14 are historical implementation; continuation completes the
message wizard and WhatsApp call integration. Original T19.16 and P19R-T8 require final
full-suite, E2E, perf and security evidence before completion.

| Acceptance                       | Current evidence                                                                                 | Final status                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------- |
| A1 Three campaign types          | List/deep-link, wizard/DTO targeted tests                                                        | Final browser pending                 |
| A2 18/75 shared sender budgets   | 1000-attempt controlled-clock Redis tests                                                        | Wall-clock perf pending               |
| A3 Tier/wallet/lifecycle/restart | Campaign/inbox targeted regressions                                                              | Restart/perf final pending            |
| A4 Message campaigns             | Recurrence, media/location, mixed pricing, actual capture cost and UI tests                      | Final coverage/browser pending        |
| A5 WhatsApp call campaigns       | Consent/revoke/unanswered tests; 100-contact agent dry run                                       | Final browser pending                 |
| A6 Incoming/outgoing AI          | Existing inbound/outbound/handoff/read-back tests passed                                         | Existing flow + new agent E2E pending |
| A7 Scoped templates              | Same-WABA sharing, wrong-WABA/tenant approval/edit tests; frontend filter tests                  | Browser pending                       |
| A8 Shared call choices           | SIP/WA/both/multiple/messaging-only/read-only component matrix                                   | Browser pending                       |
| A9 Regressions                   | Backend 68/68 earlier, latest 94/94 relevant checks; frontend 49/49 plus corrected Contact 10/10 | Final suites pending                  |
| A10 Contracts/docs/sign-off      | Additive migrations 0023/0024, regenerated API, guide and storage cleanup                        | Final checks pending                  |

## Defects found and corrected

- Agent-only dry-run scenarios incorrectly waited for generic DTMF; speech-only agent
  scenarios now complete. Two earlier 100-contact timeouts were real failures.
- Template list used historical channel association instead of WABA sharing. List/get
  now derive eligible owned same-WABA senders; approvals remain explicitly scoped.
- Signup reused the auth Redis rate-limit store with a different window. It has a
  separate `rl:signup:` store; thresholds have not been relaxed.
- Normal capture ledger references use client IDs, late charges message IDs. Campaign
  reports now include both, including retained retry attempts.
- Recovered accepted send jobs now reconcile tracking without sending again.
- Legacy default false flags no longer prove regular WhatsApp classification. Meta must
  explicitly report the flag before the 75/sec branch is available.

## Migrations, environment and catalogues

Original 0021/0022 remain required, followed by 0023 (recurrence, send-count marker) and
0024 (call-campaign transport/index). `WA_CAMPAIGN_MPS` only lowers the derived cap;
`WA_CAMPAIGN_MAX_RECIPIENTS` defaults to 100000. Refresh number metadata after migration.
No new permission, ledger type, audit action, WS event or error code was added by the
continuation; final catalogue tests verify original Phase 19 totals from code.

## Performance and failed attempts

`perf:wa-campaign` uses an isolated fake-provider server, cav_perf and Redis DB 9. Two
campaigns share each sender; two independent numbers get 1000 recipients each. It
records actual fake-provider timestamps, checks rolling budgets, hard-restarts after
all campaigns pause/quiesce, and checks unique IDs/counters/charges. Controlled-clock
Redis proofs are separate from wall-clock completion time. Earlier benchmark runs
failed on synthetic error knobs, callback-timer loss from killing active fake sends,
an incorrect paused-queue metric, and the ledger-reference bug. None is reported green.
Final wall-clock benchmark passed: 18 sender peak 18/sec, 75 sender peak 57/sec; 1000 attempts/messages/counted recipients/captured charges per sender, zero duplicate IDs, hard restart recovered. Overall 72.107 s; log `/tmp/cav-p19r-perf7.log`. See capacity.md for methodology and limits.

## Live and separate checks

Real Meta phone incoming/outgoing calls, real SIP carrier calls and production deployment
remain unrun without the owner's test numbers/server. Local fake providers cannot
certify carrier quality or guaranteed Meta throughput. White-label, commission engine,
click tracking and Phase 20 inbound SIP remain separate planned scope.
