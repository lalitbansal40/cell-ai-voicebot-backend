# Report metrics (Phase 14)

One glossary for the Reports page, the Dashboard tiles, exports, e-mailed reports and the tests. The code is [`src/modules/analytics/definitions.ts`](../../src/modules/analytics/definitions.ts); the design is [ADR 0043](../adr/0043-analytics-rollups.md). Plan: [PHASE_14_PLAN.md](../phases/PHASE_14_PLAN.md) §1b.

## How numbers are made

- **Day** = the account's timezone day (`account.timezone`, default Asia/Kolkata). A call counts on the day it was **created**, a WhatsApp message on its chat time (`at`), money on the day the ledger row was written. A reply to a template counts on the **template's** day.
- **Rollups** (`statsDaily`): one row per account × day × channel (`voice`, `whatsapp`, `money`) × test flag × slice (`all`, `campaign`, `flow`, `agent` (AI agent), `user` (team member), `template`, `number` (WhatsApp number)). Counters are whole numbers: counts, seconds, micros. **Ratios are never stored** — they are computed when a report is read, and shown as "—" when the denominator is 0.
- **Freshness:** the analytics sweep (every minute) counts every call, message and ledger row whose `updatedAt` moved, applying only the difference to what that row added before (`analyticsMarks`). Late Meta durations, status webhooks and edited dispositions therefore never double count. Reports are cached for 60 s.
- **Correctness:** a nightly recount rebuilds the last 3 days from raw rows and fixes (and reports to the superadmins) any difference; `npm run analytics:rebuild` does the same for any range. Days older than the raw-data retention are never rebuilt — their raw rows are gone and the rollup is the record. Rollups (no personal data) are kept 25 months.
- **Test calls** (call tester, playground) count apart and are left out unless "Include test calls" is on.

## Calls (voice + WhatsApp)

| Metric              | Definition                                                                                                                    | Counters                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Calls attempted     | Final calls (not queued / ringing / in progress), except calls **canceled before dialing** (never rang)                       | `calls_attempted`                                            |
| Answered            | `timestamps.answeredAt` set                                                                                                   | `calls_answered`                                             |
| Answer rate         | answered ÷ attempted                                                                                                          | —                                                            |
| Talk time           | Sum of `durationSec` (rounded) of answered calls — for WhatsApp the duration billing uses (Meta's when it came)               | `calls_talk_sec`                                             |
| Average duration    | talk time ÷ answered                                                                                                          | —                                                            |
| Median / p90 length | From the duration histogram, buckets `0, 15, 30, 60, 120, 300, 600, 1800` s (lower bounds)                                    | `dur_b0` … `dur_b7`                                          |
| Outcome             | The call's final `disposition` (flow / AI agent / person / AI suggestion) as a key; answered calls without one → "No outcome" | `outcome_<key>`, `calls_no_outcome`                          |
| By status           | Final status                                                                                                                  | `status_<status>`                                            |
| Direction / mode    | Inbound vs outbound; AI (flow / agent) vs human (team member on WhatsApp)                                                     | `calls_inbound`, `calls_outbound`, `calls_ai`, `calls_human` |

Examples: a call that rang and was not picked up → attempted 1, answered 0. A queued campaign call canceled before the dialer reached it → not counted. A WhatsApp call whose Meta duration arrives 2 minutes after our end → talk time corrected by the difference, still one call.

## WhatsApp messages

| Metric               | Definition                                                                                                                                                                       | Counters                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Messages sent        | Business messages (origin agent / WhatsApp Business app / API / system; not notes, reactions, call bubbles, system rows or imported history) that reached `sent` or later        | `msg_sent`                                      |
| Delivered / Read     | Highest status reached: delivered or read / read                                                                                                                                 | `msg_delivered`, `msg_read`                     |
| Failed               | Business messages that ended `failed` (a message that failed and was retried is a new message)                                                                                   | `msg_failed`                                    |
| Templates sent       | Sent business messages that are templates                                                                                                                                        | `msg_tpl_sent`                                  |
| Replied              | A template followed by a customer message in the same chat within 24 h (first customer message only); counted on the template's day and slices                                   | `msg_replied`                                   |
| Reply rate           | replied ÷ templates sent                                                                                                                                                         | —                                               |
| Customer messages    | Messages from the customer (not reactions)                                                                                                                                       | `msg_inbound`                                   |
| First response time  | Customer wrote (first unanswered message) → first team reply (agent or the WhatsApp Business app); wall clock; median / p90 from buckets `0, 60, 300, 900, 3600, 14400, 86400` s | `resp_count`, `resp_sec`, `resp_b0` … `resp_b6` |
| Template performance | Per template (`template` slice): sent, delivered %, read %, replied %, failed % — from messages, so date filters work (the template's lifetime counters are shown apart)         | `template` rows                                 |

## Money

| Metric | Definition                                                                                                                                                                                                                                                                                                                                                                                      | Counters                      |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Spend  | Captured ledger debits of `call_charge`, `ai_charge`, `tts_charge`, `recording_charge`, `whatsapp_charge`, `whatsapp_call_charge`, `subscription`. Holds (until captured), released holds, top-ups, adjustments and top-up refunds are not spend. A charge whose ref is a call also counts on that call's campaign / flow / agent / number; a WhatsApp message charge on its template / number. | `spend_total`, `spend_<type>` |

## Slices and filters

| Report filter   | Rollup slice                                              |
| --------------- | --------------------------------------------------------- |
| Campaign        | `campaign` (`call.campaignId`)                            |
| Flow            | `flow` (`call.source.flowId`)                             |
| AI agent        | `agent` (`call.source.agentId`)                           |
| Team member     | `user` (call answered by / message sent by)               |
| Template        | `template` (`message.template.templateId`)                |
| WhatsApp number | `number` (`call.whatsapp.channelId`, `message.channelId`) |

One filter at a time reads that slice; the account totals read `all`. Combining two filters (e.g. campaign × team member) is answered from raw rows by the drill-down lists, not by the rollups.
