# Phase 19 continuation — finish pending work + three campaign types + number-aware calling

**Owner requirements updated:** 5 Nov 2026 (Asia/Kolkata). **Status: locally implemented and verified; live-provider/release checks remain open.**
See [PHASE_19_SIGNOFF.md](../phases/PHASE_19_SIGNOFF.md) for results and limits.

## Paste this to start

```text
cell-ai-voicebot-backend/docs/prompts/PHASE_19_CONTINUATION_PROMPT.md poora padho.
Existing Phase 19 branches aur uncommitted work se resume karo; reset ya restart mat karo.
Original Phase 19 ka pending kaam aur is continuation ke P19R-T1 se P19R-T8 tak
saare tasks implement, test aur document karo. Campaign types exactly teen hon:
SIP / normal calls, bulk WhatsApp templates, aur WhatsApp calls.
WhatsApp Business App / coexistence number par bulk send cap 18 messages/second;
regular WhatsApp Cloud API number par 75 messages/second, per sending number.
WhatsApp incoming aur outgoing dono mein AI agent / published flow support ho.
Templates aur call actions mein connected number ke hisaab se filters, choices aur
readiness dikhao. Neeche ke acceptance cases aur original unfinished requirements
poore karo. Routine decisions khud lo, progress updates dete raho, full suites sirf
final sign-off par ek baar chalao. No push, merge, deploy ya client sync.
End mein honest Hinglish report do: kya verified hai aur kya live-provider blocked hai.
```

## 0. Authority, scope and resume state

Read this file, [PHASE_19_PROMPT.md](PHASE_19_PROMPT.md),
[PHASE_19_PLAN.md](../phases/PHASE_19_PLAN.md), and
[PHASE_19_TASKS.md](../phases/PHASE_19_TASKS.md) before editing. Read the relevant
security, secrets, API, data-model, billing, WebSocket and definition-of-done conventions.

The owner's latest instructions and this continuation replace conflicting Phase 19
requirements. In particular, replace the old global **80 msg/sec** default, the two-tab
campaign presentation, and the flow-only WhatsApp campaign program. Original requirements
that are not replaced remain in scope. The original STEP 0 branch creation, historical
baseline numbers and checkpoint B2 are historical; do not run them again.

The earlier **approximately 20% remaining** was a rough estimate before this scope
extension. It is not a measured completion percentage or a delivery deadline.

### Snapshot checked on 5 Nov 2026

| Area                               | State to resume from                                                                                                                                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend                            | `feature/phase-19-reseller-campaigns`; last inspected commit `f043528`, backend WhatsApp campaign tasks ticked                                                                                                       |
| Frontend                           | Same branch; last inspected commit `96f3eff`; substantial **uncommitted** wizard/dashboard work exists                                                                                                               |
| Original completed tracker rows    | T19.1–T19.12 and T19.14 are ticked; verify relevant behavior rather than rebuilding                                                                                                                                  |
| Original unfinished rows           | T19.13 wizard/dashboard, T19.15 WhatsApp call campaigns, T19.16 E2E/perf/docs/sign-off                                                                                                                               |
| Frontend work in progress          | `features/whatsapp-campaigns/*`, two `pages/campaigns/WhatsAppCampaign*Page.tsx`, API wrapper/types/events, routes, Contacts entry points, test fixtures and wizard tests                                            |
| Validation of this frontend draft  | Implementation and tests are unfinished; no final passing test/build/sign-off claim exists                                                                                                                           |
| Known backend feature gaps         | WhatsApp template campaign schema/model currently accept only `now / at`; recurrence and campaign-level header-media wiring remain; estimate currently prices all matching contacts using the first variant category |
| Existing WhatsApp AI functionality | `program.ts`, inbound settings, runtime and `ProgramPicker` already support flow/agent choices; extend and verify the existing system                                                                                |
| Existing template filter           | `TemplatesPanel.tsx` already has an optional number filter when multiple numbers exist; audit and strengthen its behavior across list/create/submit/send                                                             |

1. Inspect `git status --short`, current branches, recent commits and diffs in both repos.
   Read untracked files too. Preserve the existing work and any unrelated owner edits.
2. Check for a still-running build/test process and its log before starting another.
3. Stay on the existing feature branches. Do not reset, clean, stash away, recreate the
   branches, blindly merge main, or regenerate a completed feature from scratch.
4. Record actual starting state and test failures in a continuation progress note.
5. Update the continuation tracker as each task is verified. Historical ticks do not
   override a newly discovered acceptance gap; record and fix that gap.

## 1. Locked product behavior

### 1a. Exactly three campaign types

| User-facing type      | Sender and execution                            | Program/content                                             | Required capability                              |
| --------------------- | ----------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------ |
| **SIP / Normal call** | Existing phone/SIP campaign engine              | Existing call flow behavior                                 | Configured phone line and eligible caller number |
| **WhatsApp message**  | Existing bulk WhatsApp template campaign engine | Approved template(s), variables, optional A/B, header media | Connected WhatsApp messaging number              |
| **WhatsApp call**     | Existing campaign engine using WhatsApp calling | Published flow **or active AI agent**                       | Connected number with calling enabled and ready  |

Campaigns must expose these three distinct choices in the create entry point and the
list/filter/navigation. A simple type picker plus three tabs is sufficient. Preserve
existing phone URLs and WhatsApp message URLs. Provide a distinct WhatsApp call route
or explicit type query. Keep the selected type in the URL so reload/deep links work.

Keep the existing two backend campaign collections/engines. A third UI type does not
require a third campaign model: call campaigns use `line: 'phone' | 'whatsapp'`; bulk
template campaigns use `whatsappCampaigns`. Display type, sending/caller number and
correct cost/status/report for each. Filter phone and WhatsApp call rows correctly.

**Meaning of "normal number" in the speed requirement:** a regular connected
WhatsApp Cloud API number, without Business App coexistence. An ordinary SIP/PSTN
number cannot send WhatsApp templates just because it is connected for phone calls.

### 1b. Bulk WhatsApp speed: 18 / 75 per sending number

These are **owner-selected application caps**, not a claim about guaranteed Meta
throughput. Preserve lower provider limits, messaging tiers, quality restrictions,
wallet checks and backoff.

| Sending number facts                                                    | Bulk campaign cap                                                                                  |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `mode === 'coexistence'` **or** `isOnBizApp === true`                   | **18 messages/second**                                                                             |
| `mode === 'cloud_api'` and `isOnBizApp === false`, classification known | **75 messages/second**                                                                             |
| Missing, conflicting or unknown classification                          | Conservatively **18**, explain/refresh classification; never infer 75 from a label or phone prefix |

Derive classification from the backend channel record/read-back; the client cannot
submit a faster mode. If there are legacy default values, ensure "unknown" is not
mistaken for a confirmed regular number. Reuse authoritative mode metadata.

- Rate is **per channel**, shared by all campaigns/workers using that sender. Two
  campaigns on one number share one allowance; two different numbers have independent
  allowances. Campaign sends and bulk call-permission sends share the sender budget.
  Account for other sends consuming the same provider limit in the common outbound path;
  preserve priority for interactive inbox traffic and avoid double-counting reservations.
- Implement an atomic Redis-backed shared limiter/pacer suitable for multiple workers.
  Space actual sends/reservations over time: **no batch of 50 sent immediately followed
  by a sleep**. For any rolling 1,000 ms window, campaign attempts must not exceed the
  effective 18/75 cap. Retries also consume allowance.
- Acquire allowance before a provider attempt. Keep keys bounded with TTL; no unbounded
  process-local map, long busy loop or global lock that blocks unrelated channels.
  If the limiter is unavailable, defer the send; do not fall back to unlimited sending.
- A process restart must not reset the shared budget or generate duplicate sends.
  Preserve stable recipient `clientId`, claims, pause/stop responsiveness and queue fairness.
- `WA_CAMPAIGN_MPS`, if retained for compatibility, can only **lower** the derived cap.
  It cannot raise 18 to 75 or either number to 80. Validate and document defaults/env
  behavior in one place. Do not introduce competing sources of rate policy.
- Re-evaluate classification when channel settings change. Existing reservations must
  respect a downgrade to the lower cap. Separate the per-second cap from the existing
  unique-recipient rolling 24-hour tier and the call-concurrency limit.
- Show the selected number's effective rate in campaign number selection/review/detail,
  e.g. "Business App number · up to 18 messages/sec". If lower limits apply, explain them.

### 1c. WhatsApp AI for incoming and outgoing calls

Users can attach an **active AI agent or published flow**, as they already can for
normal call actions, to both directions of WhatsApp calls:

- **Incoming:** per-number calling settings select AI answering and an agent/flow;
  an incoming webhook routes to that exact program. Preserve human ringing and AI-to-team
  handoff where already supported. Save/read back the selection and show it on the number.
- **Outgoing single call:** after selecting WhatsApp and a ready sender, select AI mode
  and an active agent/published flow; reuse `startOutbound` and the existing AI runtime.
- **Outgoing campaign:** the WhatsApp call campaign accepts a published flow or active
  agent. Validate account ownership and program status both on save/start and before
  execution. Preserve existing pinning/version semantics and record the program used.
  Do not insert a fake flow ID merely to satisfy the current required `flowId` field.
- Calls use existing recording/disclosure, contact context, knowledge, tools, outcomes,
  usage and wallet settlement paths. Prove the same runtime executes both directions;
  a settings dropdown alone is not completion.
- Calling availability is independent of messaging availability. The current code blocks
  coexistence numbers for calls: keep the capability guard and explain the restriction.
  An 18 msg/sec messaging number does not automatically become eligible for calling.
- Reuse permission and dial guards; preserve restrictions on impersonated calls unless
  an explicitly authorized change is made. Ordinary campaign editing in login-as act
  mode must still agree with backend guards; view mode remains read-only.

### 1d. Templates: filter, create, approval and send by WhatsApp number

- Always show a clear **WhatsApp number** selector in the template area, including when
  only one number is connected. Show number label and display phone. An optional
  "All WhatsApp numbers" list view is fine; creating/submitting/sending requires a
  concrete eligible WhatsApp sender. Never offer SIP-only phone numbers here.
- Apply selected `channelId` to the server query and query key. Keep filter selection
  in the URL. Clear stale rows and invalid template/variable/media selections when the
  sender changes; no cross-number data flash from a reused cache entry.
- Selected number pre-fills create template, call-permission preset, sync, media upload
  and submit-for-approval context. In the all-numbers view explicitly choose a number
  before create/submit; **never silently select the first connected number**.
- Backend validation must enforce channel ownership and the template's WABA relationship
  for list/get/create/edit/submit/media/send as applicable. No cross-tenant access or
  approval through a different WABA by changing a request ID.
- Templates belong to a WABA and may legitimately be shared by numbers in the same WABA.
  Preserve that behavior; do not invent number-private copies or duplicate Meta submissions.
  Clarify shared availability in the UI while sending through the selected number.
- Apply the same scope in inbox template sending, Contact "Send template", permission
  templates and campaign template pickers. Campaign send pickers use `APPROVED` templates
  only, while the management list still shows pending/rejected/draft statuses.
- Disconnected/disabled/unauthorized numbers show clear empty/disabled states. Changing
  the number during an open builder must not silently retarget the draft's approval.

### 1e. Call buttons and number choices wherever needed

Use one shared call-method/number chooser across relevant entry points: Contact detail,
contact-row call actions, Calls/new-call, Inbox conversation call button, and campaign
creation. Audit actual entry points; avoid separate conflicting implementations.

| Connected capabilities  | Call action behavior                                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| SIP only                | Offer **Normal call (SIP)** with eligible caller number(s)                                                                             |
| WhatsApp calling only   | Offer **WhatsApp call** with ready WhatsApp number(s)                                                                                  |
| Both                    | User chooses **Normal call** or **WhatsApp call**, then sender if needed                                                               |
| WhatsApp messaging only | Messaging/template actions available; WhatsApp call disabled with the actual reason and setup/request-permission action where relevant |
| None                    | Show useful setup state/link; no send/dial request is made                                                                             |

Only show methods the user may use. With one eligible sender, preselect it; with
multiple, require selection. Keep sender/contact/type visible in the confirmation.
Selecting a new sender invalidates readiness/permission/price previews for the previous
sender. Consent is checked for **that channel/contact pair**; the contact-level summary
`waCallPermission` is insufficient to authorize a dial from another number.

For WhatsApp, expose the existing human/AI choices where supported and the agent/flow
picker for AI. An unapproved call may offer **Ask for call permission** through the
existing path; it must not dial anyway. Normal calls use SIP readiness, caller ID,
window/caps and DND guards. No automatic fallback to a different transport on failure.
Keep direct backend API checks authoritative when UI state becomes stale.

## 2. Implementation tasks (in order)

### P19R-T1 — Audit current work, define shared capabilities and reconcile tracker

1. Complete §0 resume checks. Read the uncommitted frontend work before editing.
2. Inventory all campaign, template, number and call entry points, their permission
   guards, and the backend services they invoke. Store a concise checklist in the
   continuation progress note; each entry ends implemented, verified-existing or open.
3. Reuse current readiness/capability APIs and introduce shared derived helpers where
   appropriate. Expose only public capability/reason fields, never SIP credentials or
   Meta tokens. Add an API only if existing responses cannot express the needed state.
4. Record exact remaining original requirements: T19.13, frontend portions of T19.14,
   T19.15, T19.16; recurrence, header media, skip estimates and any verified backend gaps.
   Backend ticks remain historical, not proof that every original acceptance case passes.
5. Add meaningful capability/method matrix tests, including custom roles with WhatsApp
   read permission but no phone campaign read permission.

### P19R-T2 — Channel-aware 18/75 throughput

Implement §1b in `modules/whatsapp-campaigns/pacing.ts`, dispatcher/jobs and the shared
outbound/bulk-permission paths as needed. Current `campaignMps()` has a global fallback
of 80 and `dispatch.ts` sleeps after a batch: replace both behaviors, not just the constant.

Tests must prove: Business App and coexistence each cap at 18; regular Cloud API caps
at 75; unknown uses the conservative branch; old env values cannot raise caps; lower
overrides work; two workers/campaigns share one channel's allowance; separate channels
remain independent; retries and restarts respect the budget; pause/stop during pacing;
downgrade to Business App; provider throttling and daily tier still work; Redis failure
defers. Assert provider-attempt timestamps over rolling windows with controlled time.

### P19R-T3 — Finish WhatsApp message campaign backend gaps and UI

Complete original T19.13 and applicable frontend T19.14, extending the existing draft:

1. Three-type campaign entry/navigation per §1a. Existing message wizard, dashboard,
   lazy routes, permission checks and Contacts/list/segment entry points must work.
2. Wizard: sender → approved template(s)/A-B split and previews → all variable mappings
   with sample contact → audience → schedule → cost/wallet/skips → review/start.
   Validate split integers, unique variant keys, required variable sources, loaded
   templates, real audience, future schedule/timezone and all schema bounds.
3. Finish **recurrence end to end** using existing Phase 8 helpers: model/schema/service,
   scheduler/sweep, recurrence UI, parent/run relation, cloning and idempotent next-run
   creation. Stop prevents future runs; pause semantics are explicit. No recurring
   dropdown whose backend still only accepts `now/at`.
4. Finish **header media end to end** via existing upload/storage/template-send path:
   type/size/tenant checks, preview and the actual outbound payload. Uploaded approval
   examples are not automatically per-recipient send media. Handle media variables and
   required headers; cleanly invalidate incompatible media after template changes.
5. Fix **estimate accuracy**: use shared audience/skip/variant resolution without
   writing recipient rows, calculate per-variant category/market using existing pricing,
   and return skip counts and wallet shortfall. Respect audience cap and exclusions.
   Do not quote every recipient at variant A's category, swallow pricing failures as
   zero cost, or present upper-bound counts as exact eligible counts. Start revalidates.
6. Preserve stable start Idempotency-Key on a network retry; prevent duplicate draft
   saves/double clicks. Block start on pending/failed/stale estimate, empty eligible
   audience or insufficient balance; show reseller credit note as appropriate.
7. Dashboard/detail: sender and effective speed, live status/counters, pause reasons,
   tier next-batch time, pause/resume/stop confirmation, retryable failures, recipient
   pagination/filter, masked CSV export, funnel/cost/error/day/variant reports.
   Poll fallback and WebSocket invalidation must refresh full state, including late
   delivery/reply updates after dispatch completes. Do not regress counters from stale events.
8. Existing multi-contact selection must not claim to send to "all matching" while
   silently forwarding only visible/selected IDs. Implement the supported audience path
   or show the exact supported selection and limits.

Tests: finish `features/whatsapp-campaigns/wizard.test.tsx`; add campaign-detail/list,
role/custom-role/deep-link, live events + poll fallback, entry-point and draft validation
cases. Extend backend campaign tests for estimate skips/mixed categories/pricing errors,
header media and recurrence, including repeated sweep/restart. Re-run affected old phone
campaign, Contacts/lists/segments and template tests after the UI integration.

### P19R-T4 — WhatsApp AI call campaigns

Complete original T19.15 with §1a/§1c requirements:

1. Add/finish `line`, owned `channelId`, WhatsApp flow-or-agent program, JSON/OpenAPI,
   list filters/type labels, estimates and dispatcher branch in the existing call engine.
   Preserve old phone campaign records/payloads and SIP flow validation.
2. Check channel calling readiness, program, wallet, media capacity and dial guards.
   Use the existing outbound WhatsApp call service/runtime; propagate campaign recipient
   identity and existing results/retry/settlement machinery. Avoid duplicate calls on
   a recovered claim and release slots/holds on every failure path.
3. Snapshot/re-check per-channel call permission before dial. Support `no_call_permission`
   and `unanswered_limit`; two unanswered attempts stop further attempts for that recipient.
4. `askPermissionFirst` uses an approved permission template and existing bulk permission
   run. A grant joins the eligible recipient once while the campaign is active, from
   that channel only. Late/duplicate grants do not revive stopped campaigns or add a
   recipient twice; revoke/expiry before dial prevents the call.
5. Wizard selects **WhatsApp call**, ready number and published flow/active agent;
   optional ask-first template and audience consent note. Detail/results show transport,
   number and program. Apply §1e, rather than routing it into the message wizard.
6. Add additive migrations only if needed after inspecting migration 0022's actual
   contents. Use the next unused number; update registry/down-chain tests and DATA_MAP.

Tests: allowed-only, grant/revoke/wrong-channel, unanswered cap, flow and agent modes,
readiness changes after start, restart/claim safety, slots/holds, pause/resume/stop,
ask-first idempotency, 100-contact fake/dry-run completion; frontend line/number/program
validation and results. Retain SIP campaign regression coverage.

### P19R-T5 — Verify and complete WhatsApp incoming/outgoing AI setup

1. Reuse `whatsapp-calling/program.ts`, `settings.service.ts`, `calls.service.ts`,
   inbound webhook routing/runtime, `ProgramPicker.tsx` and `CallWithAiDialog.tsx`.
2. Audit visible number settings for incoming AI and outbound AI defaults/selection;
   complete missing save/read-back, labels, empty states and deep links.
3. Ensure incoming AI agent/flow and single outgoing AI agent/flow really execute
   and produce call outcome, recording/usage and correct billing. Keep handoff behavior.
4. Reject another account's program, inactive/deleted agent, unpublished/deleted flow,
   unsupported number and stale capability state. Handle an agent disabled after setup.
5. Fake-provider integration tests for both directions and both program kinds; UI tests
   for save/reload/number switch. Preserve existing inbound/handoff/media tests. Real
   Meta checks are separate open items when the owner's server/phones are unavailable.

### P19R-T6 — Number-scoped templates through approval and send

Implement §1d across management list/builder/drawer/presets, backend template channel
validation, inbox/Contact sending and campaign template pickers. Reuse the existing
filter and WABA model rather than duplicating template ownership.

Tests: zero/one/multiple WhatsApp numbers; SIP-only number absent; selected sender in
URL/query/cache/create/submit; all-numbers requires explicit create sender; rejected
wrong-WABA approval/send; same-WABA shared template allowed; tenant 404; sender switch
invalidates old selection; pending/rejected visible in management but unselectable for
campaign send; draft does not silently change sender while the builder is open.

### P19R-T7 — Shared call method and sender picker

Implement §1e at every call entry point inventoried in P19R-T1. Reuse the existing SIP
`CallNowDialog`, WhatsApp `CallButton`/new-call dialog, readiness/permission panels and
AI picker. Keep current call bars/popups and active call lifecycle intact.

Tests: SIP-only, WhatsApp-only, both, neither, messaging-only coexistence, several senders,
read-only roles, permission missing/expired for selected WhatsApp sender, disabled AI,
window/wallet/readiness changes, switching methods, no silent fallback or duplicate
request on double click. Browser coverage must include Contact → Normal call and
Contact → WhatsApp → AI agent plus Inbox and campaign entry points.

### P19R-T8 — Integration, E2E, perf, docs and final sign-off

Complete original T19.16 and all amended acceptance checks below.

1. Update OpenAPI and regenerate frontend types after backend schema changes. Inventory
   errors/audits/notifications/permissions/ledger/WS events from actual code; the old
   locked totals are historical. Add/change counts only for deliberate catalogue changes,
   in the same task, and verify the current role matrix (including WhatsApp permissions).
2. Add/update Playwright specs for all three campaign types, template filter → create →
   approval simulation → send, Contact call-method matrix, incoming AI settings/call,
   outgoing AI flow/agent, and original signup/reseller/login-as flows. Use fake providers;
   affected existing specs remain in the run. Keep the repo's one-worker policy.
3. Add/finish `perf:wa-campaign` with 1,000 eligible recipients for each 18/75 sender
   classification and adequate fake daily tier. Verify attempts per rolling second,
   shared sender pacing, independent numbers, tier waiting, pause/resume, kill/restart,
   zero duplicate client IDs and matching counters/charges. Distinguish fake-clock rate
   proofs from wall-clock performance; record both methods honestly in capacity docs.
4. Update both CHANGELOGs/READMEs, API/security/reseller docs, models/DATA_MAP/erase map,
   rate-limit and env inventories, release notes/migrations, capability/readiness guide,
   campaign usage docs, roadmap and trackers. Original white-label/commission/click
   tracking and Phase 20 inbound SIP work remain separate open scope.
5. Final checks on a frozen candidate: lint/typecheck/build both; backend coverage once;
   OpenAPI consistency; frontend coverage once; new/affected Playwright once; dependency
   audit and secret scans from the original sign-off requirements. Capture real exit
   codes/log paths. Never edit code during a full run. Fix a real failure and rerun the
   affected files/checks; refresh final evidence if the fix changes the candidate.
6. Write `PHASE_19_SIGNOFF.md` with original tasks + P19R tasks, actual test/build/coverage
   numbers, rate results, migration/env changes, regressions fixed, flakes and exact
   unrun/live-blocked checks. Mark complete only when locally verifiable acceptance
   criteria pass; label unavailable live-provider checks explicitly.

## 3. Required acceptance matrix

| #   | Done when                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1  | Exactly three campaign choices exist; their URLs/lists/create/detail dispatch to the correct engine and sender                                               |
| A2  | Business App/coexistence sends never exceed 18/sec and confirmed regular WhatsApp sends never exceed 75/sec per sender, including concurrent workers/retries |
| A3  | Daily tier, lower provider/env caps, wallet, pause/stop and restart safety still work with the new pacer                                                     |
| A4  | Bulk templates support correct audience/skips, variables/media, schedule/recurrence, estimate, A/B, live results, retries, export and reports                |
| A5  | WhatsApp call campaigns run flow or agent, dial allowed contacts only, and handle ask-first/unanswered/restart safely                                        |
| A6  | Incoming WhatsApp call runs the selected AI agent or flow; outgoing single and campaign calls run their selected program                                     |
| A7  | Template list/create/approval/send use the selected owned WhatsApp number/WABA, including shared-WABA and wrong-tenant tests                                 |
| A8  | Contact and other call actions offer Normal/WhatsApp and sender choices according to real connection/readiness/permissions                                   |
| A9  | SIP calling/campaigns, inbox, templates, reseller balances/login-as and existing read-only guards pass affected regressions                                  |
| A10 | Original Phase 19 done-when items and amended tasks have test evidence, docs/types/catalogues are current, and no unverified work is called complete         |

## 4. Execution rules

- Work through P19R-T1 → T8. Resolve routine choices from existing conventions and
  record decisions; continue useful local work when an external live check is blocked.
  Send concise progress updates, without a permission question at every task.
- During implementation run the changed task's tests only, plus affected regressions.
  Do not rerun checkpoint B2 or repeatedly run the full suites. Final sign-off is the
  next full-suite checkpoint. Keep coverage thresholds; do not weaken assertions,
  security guards, tenant filters, real error handling or timeouts to obtain green.
- Use fake Meta/SIP/payment/AI providers and local stubs in tests. No real customer
  calls/messages, production changes, payments, push/merge/deploy/client sync. Live
  checks require the owner's explicit instruction and their test numbers.
- Do not inspect secret env files or print credentials/message contents/PII. Use
  synthetic fixtures and masked phone identifiers in persisted reports.
- Only manage this project's `cav-*` containers and verified repo processes. Respect
  other local projects. Long tests run in the background with actual exit-code capture;
  use `caffeinate` when available, without hiding failures behind pipelines.
- Commit verified task changes on the current feature branches with `[P19R-Tn]` tags,
  passing hooks, using the active agent's actual identity. Do not add the old prompt's
  hard-coded Claude co-author footer for another tool/agent. Never commit unrelated edits
  or claim the working tree is clean while deliberately preserved owner changes remain.
- If a task needs a migration/schema/catalogue change, ship its validation, docs and
  generated contract changes together. Every query/job remains scoped to account/channel.
- If AutoChatix reference code helps, inspect only relevant source under
  `~/Documents/Autochatix/AutoChatix-backend` read-only; never copy secrets or mutate/run
  that project. The current Cell code and these requirements govern this implementation.

## 5. Final report (short Hinglish)

Report the three campaign types, 18/75 pacing, WhatsApp incoming/outgoing AI, number-scoped
templates and call choices. Include A1–A10 pass/fail/open, actual checks and any failures,
remaining live checks, local commit IDs, and whether anything was pushed/deployed.
Do not describe this prompt's creation as completion of the requested product changes.
