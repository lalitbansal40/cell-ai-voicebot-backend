# Phase 8 — Campaigns & Call Scheduler (Detailed Plan)

**Source:** [BUILD_PLAN.md](../plans/BUILD_PLAN.md) → Phase 8 · **Builds on:** Phase 3 (contacts, lists, segments, DND / opt-out, consent, `lastCalledAt` / `callCount`, exports), Phase 4 (per-call holds, budgets, `estimateCampaign`, `walletEvents`), Phase 5 (dispositions, `promiseToPay`, `callback`), Phase 6 (immutable flow versions, `isFlowInUse()` stub, `RunOutcome`), Phase 7 (`CallManager`, `CallSession`, `TelephonyProvider` / `CallLeg`, Calls API + pages, fake voice) · **Branch:** `feature/phase-8-campaigns` (both repos, from `main` = Phase 7 tip: backend `a6823cd`, frontend `7daa8ba`) · **Tracker:** [PHASE_8_TASKS.md](PHASE_8_TASKS.md)

---

## 0. Is phase ka goal

Phase 8 ke end tak client **ek list / segment ke hazaron contacts ko ek flow se call** karne ka campaign bana sake — schedule kare, calling window aur DND ka dhyan rakhte hue, retries ke saath, live dekhe, pause / resume / stop kare aur results export kare. SIP (Phase 13) abhi nahi hai, isliye poora pipeline ek **dry-run telephony provider** par chalega: wahi `CallManager`, wahi `CallSession`, wahi flow / AI, sirf "phone" simulate hota hai (ring, busy, no answer, simulated customer). SIP aane par sirf provider badlega.

1. **Campaign** — naam, **pinned flow version** (start par), audience (lists / segment / chune hue contacts), schedule (abhi / baad mein / recurring), calling window, retries, callbacks, concurrency, priority, mode (`dry_run` abhi; `live` Phase 13 se).
2. **Wizard** — Basics → Audience → Schedule & window → Retries & pacing → Review (**estimated cost**, wallet, warnings jaise "120 contacts ka Amount khaali hai").
3. **Audience snapshot** — start par contacts `campaignContacts` mein copy (phone + variables), duplicates / DND / opted-out / invalid phones / doosre active campaign wale contacts alag gine aur skip ki wajah ke saath.
4. **Scheduler + dispatcher** — BullMQ par: scheduled start, recurring runs, per-account dispatcher jo free slots bharta hai (priority + FIFO), **atomic concurrency slots** (account + campaign + process; Phase 7 ka check-then-register yahan theek), dial rate limit.
5. **Dial guard** (`assertDialAllowed`) — har dial se theek pehle: account active, campaign running, **calling window** (account ∩ campaign ∩ compliance hard bounds), **DND / opt-out**, contact deleted, **per-contact daily / weekly caps**, wallet / budget.
6. **Outbound call path** — `CallManager.startOutboundCall()` (provider ke through), Call par `campaignId`, `campaignContactId`, `attempt`; statuses `busy` / `no_answer` ab use honge.
7. **Dry-run provider** — seeded random outcomes (answer / busy / no answer / failed / invalid number), **simulated customer** (keys, words, silence, early hang-up) jo templates ke hisaab se react kare, **virtual clock** (speed ×1–×50, durations realistic), koi recording nahi, **koi paisa nahi** (virtual cost dikhe).
8. **Results & retries** — call khatam → contact ka result (answered / busy / no answer / failed / disposition), retry rules (kis result par, kitni baar, kitne gap par, window ke andar), **callbacks** (customer ne bola "kal 5 baje call karo" → us waqt dobara call), optional promise follow-up.
9. **Controls** — pause / resume / cancel (live calls ko khatam hone do ya politely band karo), **auto-pause** (wallet khatam, monthly budget, account suspended, lagaatar failures), auto-resume jab paisa aaye, **server restart par resume**.
10. **Live dashboard** — counters (pending / queued / calling / waiting / completed / failed / skipped), dispositions, spend (ya dry-run virtual cost), ETA, live calls, per-contact results table — WS live (`campaign.status`, `campaign.progress`).
11. **Export** — per-contact results CSV / XLSX (BOM, formula escaping, phones only for `contacts.export`).
12. **Single call** — contact page se **Call now** (dry-run simulated call abhi; SIP par real) aur **Test in browser** (Phase 7 tester contact ke saath).
13. **Compliance** — RBI recovery 08:00–19:00 / TRAI 09:00–21:00 hard bounds (real calls par), per-contact caps ("excessive calling" se bachav), DND skip with reason, audit trail.

**Done when (BUILD_PLAN):** **100 contacts ka dry-run campaign** chale — **retries + calling window + pause / resume + export** sahi kaam karein — **Playwright se proven**, plus wallet auto-pause / resume, callbacks, DND / caps skip, restart resume (backend test) aur roles.

### Phase 8 mein kya NAHI hoga

| Kaam                                                                                     | Kaunse phase mein                                                   |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Real phone dialing (`mode: live`), caller ID / phone numbers, answer detect, AMD         | Phase 13 (SIP) — campaign field + guard ready, `live` refused today |
| Trunk-level concurrency limits                                                           | Phase 13 (env + provider capacity; Phase 8 has account / process)   |
| Calls analytics dashboards, campaign comparison, post-call AI summary, scheduled reports | Phase 9                                                             |
| Public API to create / start campaigns, outbound webhooks (`campaign.completed`)         | Phase 10                                                            |
| Actually sending SMS / WhatsApp from outcomes (payment links)                            | Phase 10 (Phase 8 keeps them queued on the call outcome)            |
| Opt-out by keyword ("call mat karo") / DTMF on a call → DND                              | Phase 11 (compliance) — Phase 8 skips DND / opted-out at dial time  |
| Holiday calendars / blackout dates                                                       | Open question §7 (default: days of week only)                       |
| Multi-process dialing (several API instances sharing campaigns)                          | Phase 12 / 13 deployment (Phase 8: one API process, ADR 0025)       |
| Inbound calls                                                                            | Phase 14                                                            |

### Conventions to follow

Same as earlier phases: [api.md](../conventions/api.md) (Idempotency-Key on start / single call), [security.md](../conventions/security.md), [data.md](../conventions/data.md), [data-model.md](../conventions/data-model.md) (Campaign / CampaignContact drafted §2.5 — updated in T8.1), [websocket.md](../conventions/websocket.md) (`campaign.status` / `campaign.progress` already listed), [audit.md](../conventions/audit.md), [error-codes.md](../conventions/error-codes.md) (`CAMPAIGN_NOT_RUNNABLE`, `CALL_OUTSIDE_WINDOW` already reserved), [compliance-notes.md](../compliance/compliance-notes.md), [definition-of-done.md](../conventions/definition-of-done.md), ADR 0005 (queues), ADR 0017 (UTC + account timezone, `date-fns` + `@date-fns/tz`). Money only via the billing engine (per-call `holdForCall` / `settleCall`). Logs never carry phones, contact names, variables, transcript text or secrets. Tests make **no network calls**; time-dependent code takes a `Clock` (Phase 7 `FakeClock`).

---

## 1. Locked decisions (pehle se tay — implementation me dobara debate nahi)

### 1a. Architecture (one process dials and owns its calls)

```
Wizard / API ──► campaigns.service ──► Campaign (draft → scheduled → running …)
                        │ start: audience snapshot → campaignContacts (pending)
                        ▼
BullMQ queue `campaigns`
  ├── campaign.start:<campaignId>      (delayed to startAt)            ─┐
  ├── campaign.recur:<parentId>        (repeatable, recurring runs)      │
  ├── campaign.end:<campaignId>        (delayed to endAt)                │ jobs only change
  ├── campaign.dispatch:<accountId>    (every 2 s while running + wake)  │ Mongo state;
  ├── campaign.sweep                   (every 60 s: lost jobs, stuck)    │ all idempotent
  └── campaign.export:<exportJobId>                                     ─┘
                        │
        Dispatcher (per account, in the API process)
          1. running campaigns of the account, by priority (high → low), FIFO inside
          2. inside the window? wallet / budget ok? (else wait / auto-pause)
          3. free slots = Redis atomic lease (account, campaign, process)
          4. claim due campaignContacts (findOneAndUpdate: pending / retry_wait / callback_wait,
             nextAttemptAt ≤ now → queued) — one claim per slot
          5. assertDialAllowed(contact) → skip with reason, or
          6. CallManager.startOutboundCall({ provider, to, source: flowVersionId, campaign … })
                        │
        CallSession (Phase 7, unchanged) on a DryRunLeg (Phase 13: SipLeg)
                        │ onEnded(summary)
        Result handler: classify → campaignContact (completed / retry_wait / callback_wait / failed)
                        → stats $inc → contact.lastCalledAt / callCount / lastDisposition
                        → wake dispatcher → campaign.progress (≤ 1/s) → completion check
```

- **One process owns a call** (Phase 7 rule). The dispatcher runs in the API process that holds the `CallManager`; BullMQ jobs only move Mongo state and wake the dispatcher, so a job retried on another process never dials twice (the claim + the unique `{ campaignContactId, attempt }` index on calls guard it).
- All state lives in Mongo (`campaigns`, `campaignContacts`, `calls`); Redis has leases, rate buckets and BullMQ jobs only — a Redis flush loses no campaign data (the sweep rebuilds jobs).
- New module `src/modules/campaigns/` (`campaigns.routes.ts`, `campaigns.schema.ts`, `campaigns.service.ts`, `audience.ts`, `dial-guard.ts`, `window.ts`, `dispatcher.ts`, `results.ts`, `slots.ts`, `jobs.ts`, `export.ts`, `recurrence.ts`), provider `src/core/telephony/dryrun.ts` + `simulated-customer.ts`.

### 1b. Dry-run telephony provider

| Part                | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name                | `DryRunProvider` (`name: 'dryrun'`), `Call.provider: 'dryrun'`, `isTest: true`. Selected by `campaign.mode = 'dry_run'` and by single "Call now" while no phone provider exists.                                                                                                                                                                                                                                                                                                                                                                                                            |
| Pre-answer outcome  | Seeded RNG, seed = `sha256(campaignContactId + attempt)` → same input, same result. Campaign setting `dryRun.mix` (basis points): answered 6500, no answer 2000, busy 1000, failed 300, invalid number 200 (defaults, editable, must sum to 10,000). Ring time 3–12 s (virtual).                                                                                                                                                                                                                                                                                                            |
| Hangup causes added | `HangupCause` + `busy`, `no_answer`, `rejected`, `invalid_number`; lifecycle `queued → ringing → busy / no_answer / failed`, `ringing → in_progress`. End reasons + `busy`, `no_answer`, `invalid_number`. (SIP maps its causes onto the same values in Phase 13.)                                                                                                                                                                                                                                                                                                                          |
| Simulated customer  | `SimulatedCustomer` listens to the leg (bot finished speaking, listening) and acts from a **scenario** chosen by the seed with `dryRun.scenarios` weights: `paid` (press 1), `promise` (press 1 → "kal tak de dunga"), `refuse`, `callback` ("kal shaam 5 baje call karna"), `silence`, `wrong_number`, `hangup_early`, `wrong_keys`. Scenarios are written for the 4 flow templates; any other flow gets a generic one (a menu key 1–3, a random phrase from a fixed Hinglish bank, silence, hang up). Think time 1–3 s virtual.                                                           |
| Voice / AI          | Always the **fake voice and fake AI model** (no OpenAI spend, like the Phase 7 demo calls), whatever `VOICE_PROVIDER` / `AI_PROVIDER` say. API nodes of the flow run for real (same as the Phase 6 simulator) — the wizard says so.                                                                                                                                                                                                                                                                                                                                                         |
| Time                | A `ScaledClock(speed)` per dry-run session: timers fire after `ms / speed` real ms, `now()` moves `speed×` → a 40 s call takes 2 s at ×20 but is saved as 40 s. `dryRun.speed` 1 / 5 / 10 / 20 (UI), up to `DRY_RUN_MAX_SPEED` (50, tests / bench). The leg's `play()` resolves on that clock (no real-time pacing, no audio sent anywhere). The same speed divides the campaign's **retry and promise follow-up delays** (`intervalMinutes / speed`), so a ×20 rehearsal retries a 15-minute gap after 45 s; calling windows and customer-requested callback times stay on the real clock. |
| Recording           | None (`recording: null`, event `recording_skipped { reason: 'dry_run' }`). Transcript and events are saved like any call.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Money               | **Not charged.** `VirtualCallBilling` prices the call as a phone call (`telephony: true`) with the account's rate card, stores it on `call.cost` with `charged: false`, adds it to `campaign.stats.virtualCostMicros`; no hold, no ledger row. The wallet gate in dry-run uses a **virtual balance** (wallet available at start − virtual spend) so "money runs out → auto-pause" can be rehearsed (§1j).                                                                                                                                                                                   |

### 1c. Outbound call path (`CallManager.startOutboundCall`)

```ts
interface StartOutboundCallInput {
  accountId: string;
  provider: 'dryrun' | 'sip'; // sip → 409 until Phase 13
  to: string; // E.164, server-only
  contactId: string;
  source:
    { kind: 'flow'; flowId: string; flowVersionId: string } | { kind: 'agent'; agentId: string };
  variables: Record<string, string>; // snapshot display values
  campaign?: { campaignId: string; campaignContactId: string; attempt: number };
  initiatedBy: string | null; // user for "Call now", null for campaigns
  dryRun?: { seed: string; mix: OutcomeMix; scenarios: ScenarioWeights; speed: number };
}
```

- Order: lease slot (§1h) → create Call (`queued`, `direction: outbound`, `from` = caller ID or `dryrun`, `to`, `campaignId`, `campaignContactId`, `attempt`) → billing (`holdForCall` for real providers, `VirtualCallBilling` for dry-run) → `provider.startCall()` → leg status `ringing` → `answered` → `CallSession` with `scriptFor(call)` (Phase 7 path, refactored out of `attach`) → on end: settle / virtual cost, release the lease, `onEnded` → result handler.
- Unique partial index on calls `{ campaignContactId: 1, attempt: 1 }` (when set) → a second dial of the same attempt fails at insert.
- The Phase 7 web-call limit moves onto the same atomic slots (fixes the "two creates at the same moment pass 3 by one" note).
- `Call` additions: `campaignContactId`, `attempt` (1-based), `charged` (false for dry-run), `direction` already exists. Calls list gets `campaignId` / `provider` filters; call detail shows "Simulated call · Campaign X · attempt 2".

### 1d. Dial guard (`assertDialAllowed`) — checked at claim time and again right before dialing

| #   | Check (first failing one wins)                                                                  | Result                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | Account suspended                                                                               | Campaign auto-pause `account_suspended`                                                                             |
| 2   | Campaign not `running` (paused / canceled meanwhile)                                            | Release the claim (back to its wait state)                                                                          |
| 3   | Outside the effective window (or < `windowEndBufferMin` before its end)                         | Release; campaign shows "Waiting for the calling window — next start Mon 09:00"                                     |
| 4   | Contact deleted                                                                                 | Skip `contact_deleted`                                                                                              |
| 5   | Phone (snapshot **or** current) on the account DND list                                         | Skip `dnd`                                                                                                          |
| 6   | Contact opted out                                                                               | Skip `opted_out`                                                                                                    |
| 7   | Snapshot phone invalid (not E.164 mobile / landline)                                            | Skip `invalid_phone` (normally caught at snapshot)                                                                  |
| 8   | Per-contact cap reached (all campaigns + single calls, account tz day / ISO week)               | Wait until the next day's window (`retry_wait`, reason `cap_reached`); after the campaign ends → skip `cap_reached` |
| 9   | Min gap since this contact's last call (`minGapMinutes`, default 30)                            | Wait until the gap passed                                                                                           |
| 10  | Wallet / budget: real → `holdForCall` fails; dry-run → virtual balance < per-call hold estimate | Campaign auto-pause `wallet_empty` / `budget_reached`                                                               |

- **Effective window** = account `settings.callingWindow` ∩ campaign `window` ∩ **compliance hard bounds** for real calls: TRAI 09:00–21:00 for every live campaign; **08:00–19:00** when the flow version uses an agent with `complianceMode: 'recovery'` (RBI). Dry-run campaigns use account ∩ campaign only (rehearsal, any hours) — labelled in the UI.
- Windows are `{ start: 'HH:mm', end: 'HH:mm', days: 0–6 }`, start < end (no overnight windows), in the campaign timezone (default account timezone, IANA, ADR 0017 with `date-fns` + `@date-fns/tz`). Pure helpers: `isInWindow(now, window, tz)`, `nextWindowStart(now, window, tz)`, `intersect(a, b)` (empty → wizard error).
- `windowEndBufferMin` = 5: no new dial in the last 5 minutes of a window (a call started at 18:58 would run past 19:00).
- Per-contact caps: account `settings.callCaps { perDay: 3, perWeek: 10, minGapMinutes: 30 }` (defaults; owner / admin edit in Settings → Calls), counted from `calls` (`{ accountId, contactId, createdAt }` index exists) for real **and** dry-run calls of that mode (dry-run calls count only against dry-run caps so a rehearsal never blocks a real campaign).
- Single "Call now" uses the same guard; `CALL_OUTSIDE_WINDOW` (422) / `CALL_NOT_ALLOWED` (422, `details[].message` = DND / opted out / cap) explain the refusal.

### 1e. Campaign model & lifecycle (data-model.md §2.5, updated)

| Field (new / changed)                           | Type                                                                                                                                                                                         | Notes                                                                                                                                                                                                                         |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| mode                                            | `dry_run \| live`                                                                                                                                                                            | `live` refused (`CAMPAIGN_NOT_RUNNABLE`, "needs a phone line") until Phase 13                                                                                                                                                 |
| flowId / flowVersionId                          | ObjectId                                                                                                                                                                                     | Version **pinned at start** (latest published, or a chosen version); draft flows not allowed; only flows whose version's start step has the `campaign` trigger (default: all triggers; the Inbound support template has none) |
| audience                                        | `{ listIds: ObjectId[], segmentId?: ObjectId, filter?: ContactFilter, contactIds?: ObjectId[], excludeActiveCampaigns: boolean, skipIfMissing: string[] }`                                   | One or more sources (OR), then exclusions                                                                                                                                                                                     |
| schedule                                        | `{ startAt: Date \| null, endAt: Date \| null, timezone, recurrence: { freq: 'daily' \| 'weekly', days?: number[], time: 'HH:mm', until?: Date } \| null }`                                  | `startAt null` = start now                                                                                                                                                                                                    |
| window                                          | `{ start, end, days }`                                                                                                                                                                       | Must intersect the account window                                                                                                                                                                                             |
| retry                                           | `{ maxAttempts 1–5 (3), intervalMinutes 15–1440 (60), retryOn: (no_answer \| busy \| failed \| no_outcome)[] }`                                                                              | Default `[no_answer, busy, failed]`                                                                                                                                                                                           |
| followUps                                       | `{ callbacks: boolean (true), callbackMaxDays: 1–14 (7), promiseCheck: { enabled: false, daysAfter: 1 } }`                                                                                   |                                                                                                                                                                                                                               |
| pacing                                          | `{ concurrency 1–N (5), dialsPerMinute 1–120 (30), priority: high \| normal \| low }`                                                                                                        | Concurrency ≤ account `limits.maxConcurrentCalls`                                                                                                                                                                             |
| dryRun                                          | `{ mix, scenarios, speed }` \| null                                                                                                                                                          | Only for `dry_run`                                                                                                                                                                                                            |
| status                                          | `draft \| scheduled \| running \| paused \| completed \| canceled \| failed`                                                                                                                 | + `pauseReason: manual \| wallet_empty \| budget_reached \| account_suspended \| too_many_failures \| admin`                                                                                                                  |
| waitingUntil                                    | Date \| null                                                                                                                                                                                 | Running but outside the window → next window start (UI)                                                                                                                                                                       |
| stats                                           | `{ total, pending, queued, calling, waiting, completed, failed, skipped, canceled, answered, attempts, dispositions: { [d]: n }, skipped: { [reason]: n }, spentMicros, virtualCostMicros }` | Denormalised `$inc` counters + a recount job in the sweep                                                                                                                                                                     |
| estimate                                        | `{ contacts, calls, totalMicros, perCallMicros, at }`                                                                                                                                        | From the wizard review (Phase 4 `estimateCampaign`)                                                                                                                                                                           |
| parentId / runNumber                            | ObjectId \| null, number                                                                                                                                                                     | Recurring runs (§1g)                                                                                                                                                                                                          |
| startedAt / completedAt / canceledAt, startedBy | Date, ObjectId                                                                                                                                                                               |                                                                                                                                                                                                                               |
| **removed**                                     | `holdLedgerEntryId`                                                                                                                                                                          | Phase 4 decision: holds are **per call**, never per campaign                                                                                                                                                                  |

| From → to                   | By                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| draft → scheduled / running | `POST /campaigns/:id/start` (snapshot at start time — scheduled ones snapshot when they start)                |
| scheduled → running         | `campaign.start` job / sweep at `startAt`                                                                     |
| scheduled → draft           | `POST …/unschedule`                                                                                           |
| running → paused            | manual, auto (wallet, budget, suspended, failures, admin)                                                     |
| paused → running            | `POST …/resume` (refused while the cause holds), auto-resume after a top-up when `pauseReason = wallet_empty` |
| running / paused → canceled | `POST …/cancel { hangUpLive: boolean }` — waiting contacts → `canceled`                                       |
| running → completed         | nothing left to dial or wait for, or `endAt` reached (waiting contacts → `skipped: campaign_ended`)           |
| any active → failed         | flow version / agent unusable at start (e.g. agent deleted) — with `error.code`                               |

- **Edits:** draft — everything; scheduled — everything except mode; running / paused — name, `endAt`, window (narrow or widen inside the account), pacing, retry counts (apply to future attempts), follow-ups; never the flow version or the audience. `POST /campaigns/:id/duplicate` copies settings into a new draft.
- **Delete:** draft / completed / canceled / failed → soft delete; purge after 30 days (`campaignContacts` deleted; calls keep their own retention). Running / paused / scheduled → 409 `CONFLICT_INVALID_STATE`.
- **`isFlowInUse(flowId)`** (Phase 6 stub) → true when a scheduled / running / paused campaign (or a recurring parent) uses the flow → flow delete 409 `RESOURCE_IN_USE` listing the campaigns. Archiving a flow is allowed (pinned versions keep working).

### 1f. Audience & snapshot (`campaignContacts`)

- Sources (union): contact lists, a saved segment or an inline filter (Phase 3 `ContactFilter`), picked contact ids (≤ 1,000). Preview (`POST /campaigns/audience/preview`) returns counts: total, will call, and excluded by reason (`dnd`, `opted_out`, `invalid_phone`, `duplicate_phone`, `in_active_campaign`, `missing_values`) + 20 sample rows (names + last 4 digits only).
- **Snapshot at start** in batches of 1,000 (resumable: a `snapshot` cursor on the campaign; a crash mid-snapshot continues from the cursor): `{ campaignId, contactId, phoneE164, variables (display values of the fields the flow version uses + name), status: pending | skipped, skipReason?, seq (order), nextAttemptAt: startAt }`.
- **Duplicates:** same phone twice → the first one (by list / filter order) is kept, the rest `skipped: duplicate_phone`.
- **Missing values:** the wizard lists flow variables (`{{contact.amount}}` …) empty for N contacts; `skipIfMissing` fields → those contacts are `skipped: missing_values`, others call with the flow's empty-value behaviour (Phase 6 rule).
- Limits: ≤ 50,000 contacts per campaign (= import max), ≤ 10 active (scheduled + running + paused) campaigns per account, recurring parents count once.
- `CampaignContact` statuses: `pending | queued | calling | retry_wait | callback_wait | completed | failed | skipped | canceled`, plus `attempts`, `nextAttemptAt`, `lastCallId`, `lastResult` (`answered | no_answer | busy | failed | invalid_number`), `disposition`, `promiseToPay`, `callback`, `skipReason`, `claimToken`, `claimedAt`. Indexes: `{ campaignId: 1, contactId: 1 }` unique, `{ campaignId: 1, status: 1, nextAttemptAt: 1, seq: 1 }`, `{ accountId: 1, contactId: 1 }`.

### 1g. Scheduling

- **Start now** (`startAt: null`) → snapshot + `running`; **later** → `scheduled` + delayed job `campaign.start:<id>` at `startAt` (≤ 90 days ahead); the minute sweep starts any scheduled campaign whose time passed (lost job, restart).
- **End** (`endAt`, optional, > start): delayed `campaign.end:<id>`; at end → `completed`, waiting contacts `skipped: campaign_ended`, live calls finish normally.
- **Recurring** (`daily` at `HH:mm`, or `weekly` on days at `HH:mm`, `until` optional): the campaign is a **parent** (status `scheduled`, never dials); each occurrence creates a **run** = a child campaign (`parentId`, `runNumber`, name "Loan reminder · 16 Oct") with a fresh audience snapshot, the parent's settings and the then-latest published version (or the pinned one, per setting `versionPolicy: 'latest' | 'pinned'`, default `pinned`). A run that is still active when the next occurrence comes → the next one is skipped (event + notification). Pausing / canceling the parent stops future runs.
- Timezone: the campaign's (default account). Jobs are scheduled in UTC from the tz math; DST-safe via `@date-fns/tz` (IST has none, other zones tested).

### 1h. Concurrency, rate and priority

| Limit                      | Value / source                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| Calls per account at once  | `account.limits.maxConcurrentCalls` (default 10; superadmin sets per account; web test calls count) |
| Calls per campaign at once | `campaign.pacing.concurrency` (≤ the account limit)                                                 |
| Calls per process          | `CALL_LIMITS.concurrentPerProcess` (20) — dry-run calls count too                                   |
| Dials per minute           | per campaign `pacing.dialsPerMinute`, per account `account.limits.dialsPerMinute` (default 60)      |
| Trunk limit                | Phase 13 (`TELEPHONY_MAX_CONCURRENT`)                                                               |

- **Slots** = Redis sorted sets of leases (`slots:acct:<id>`, `slots:camp:<id>`, `slots:proc:<pid>`; member = callId, score = lease expiry). One Lua script drops expired members, checks all three counts and adds the member to all three atomically (or none). Leases are refreshed by the call heartbeat (10 s) and removed at call end; a crashed process's leases expire in 30 s.
- **Rate**: token bucket per campaign and per account in Redis (Lua), refilled per second.
- **Priority / fairness**: the account dispatcher serves running campaigns high → normal → low; equal priority round-robin (one claim each in turn); inside a campaign: due callbacks first, then retries, then fresh contacts by `seq`.
- Dispatcher tick: every 2 s while the account has running campaigns, plus an immediate wake (deduped job id) when a call ends, a campaign resumes or a window opens (`waitingUntil` delayed wake).

### 1i. Results, retries, callbacks

| Call result                                                                                                                     | Contact becomes                                                                                                                   | Counts as attempt |
| ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Answered + disposition `paid` / `refused_to_pay` / `dispute` / `not_interested` / `language_barrier` / `wrong_number` / `other` | `completed` (final)                                                                                                               | ✓                 |
| Answered + `promise_to_pay`                                                                                                     | `completed`; with `followUps.promiseCheck` → `callback_wait` at promise date + `daysAfter` (window start)                         | ✓                 |
| Answered + `callback_requested` with a date / time                                                                              | `callback_wait` at that time (moved into the window, ≤ `callbackMaxDays`, ≤ `endAt`) when `followUps.callbacks`; else `completed` | ✓                 |
| Answered, no disposition (hung up early, silence)                                                                               | `no_outcome` → retry when in `retryOn`, else `completed`                                                                          | ✓                 |
| `no_answer` / `busy`                                                                                                            | `retry_wait` at now + interval (moved into the window) while attempts < max and in `retryOn`; else `failed`                       | ✓                 |
| `failed` (media / engine / AI error)                                                                                            | as above with `failed` in `retryOn`                                                                                               | ✓                 |
| `invalid_number`                                                                                                                | `failed`, `skipReason: invalid_phone`                                                                                             | ✓                 |
| `server_shutdown` / `limit` / `wallet_empty` before or during the call                                                          | back to its previous wait state, `nextAttemptAt` = now (or window start)                                                          | ✗                 |
| Campaign canceled with `hangUpLive`                                                                                             | `canceled`                                                                                                                        | ✗                 |

- Every result writes: `campaignContact` (status, attempts, lastResult, disposition, promise, callback, lastCallId), `campaign.stats` (`$inc`, also dispositions / skips), contact `lastCalledAt`, `callCount`, **`lastDisposition`** (new contact field + segment filter, so "promise due today" segments work), then a dispatcher wake. Idempotent by `callId` (a result is applied once: `campaignContact.lastCallId` + attempt compare-and-set).
- Completion: when `pending + queued + calling + waiting = 0` → `completed`, `campaign.status`, notification.

### 1j. Money

- **No campaign hold** (Phase 4 decision): every call holds / extends / settles on its own; campaign start shows the estimate and the wallet but never locks money.
- **Estimate** (review step + stored): `estimateCampaign` with `calls = contacts × expected attempts (1 + (maxAttempts − 1) × unanswered share)`, `avgDurationSec` from the account's last 100 answered calls of that flow (else 60 s), `answerRate` default 60 %, AI share from the flow (agent steps present → 50 %, else 0). Shown as a range with the assumptions.
- **Auto-pause:** a hold refused (`WALLET_INSUFFICIENT_BALANCE`) or the monthly call budget reached → campaign `paused` (`wallet_empty` / `budget_reached`), in-app + email notification, `campaign.status`. Live calls keep running (Phase 7 extends / ends them politely).
- **Auto-resume:** on every wallet change that raises the available balance (`walletEvents` `updated` / `replenished`, Phase 4) → campaigns paused with `wallet_empty` and `autoResume: true` (default) re-run the wallet gate and resume when it passes; budget pauses resume on the 1st of the month (account tz) or a budget change.
- **Dry-run:** virtual balance (§1b) with the same pause / resume rules (resume when the user tops up or resumes by hand).
- Spend on the dashboard = sum of settled call costs (`stats.spentMicros`, from settle results); dry-run shows `virtualCostMicros` labelled "would have cost".

### 1k. Restart safety & failure handling

- **Graceful shutdown:** stop the dispatchers first (no new dials), then Phase 7 shutdown ends live calls (`server_shutdown`, not counted as attempts → re-dialed after restart).
- **Recover on boot / sweep (every 60 s):** campaigns `running` → ensure a dispatcher job; `scheduled` past `startAt` → start; `campaignContacts` `queued` / `calling` whose call is final or missing (claimed > 2 min ago, no live lease) → apply the result or release the claim; stats recount when drift is found (logged as a warning).
- **Circuit breaker:** 10 consecutive technical failures (`failed` with an engine / AI / media error) in a campaign → auto-pause `too_many_failures` (e.g. the pinned flow's agent was turned off).
- **Pinned version checks at start:** flow version exists, its agents exist and are active, no `audio_missing` → else 409 `CAMPAIGN_NOT_RUNNABLE` with details.
- **Idempotency:** start / resume / cancel are state-checked (repeat = same state, no error); `POST /campaigns/:id/start` and `POST /calls` need `Idempotency-Key` (api.md).

### 1l. Limits (`CAMPAIGN_LIMITS`)

| Limit                                    | Value                     |
| ---------------------------------------- | ------------------------- |
| Contacts per campaign                    | 50,000                    |
| Active campaigns per account             | 10                        |
| Picked contact ids                       | 1,000                     |
| Snapshot batch                           | 1,000                     |
| Schedule ahead                           | 90 days                   |
| Max attempts / interval                  | 1–5 / 15–1440 min         |
| Callback horizon                         | 1–14 days (default 7)     |
| Concurrency per campaign / dials per min | 1–account limit / 1–120   |
| Dispatcher tick / claim lease            | 2 s / 2 min               |
| Window end buffer                        | 5 min                     |
| Consecutive failures → pause             | 10                        |
| Progress event throttle                  | 1 / s per campaign        |
| Dry-run speed                            | 1–50 (UI 1 / 5 / 10 / 20) |
| Export rows / link TTL / file kept       | 100,000 / 15 min / 24 h   |
| Deleted campaign purge                   | 30 days                   |

### 1m. Live progress

- `campaign.status { campaignId, status, pauseReason? }` (account) on every transition; `campaign.progress { campaignId, stats }` (topic `campaign:<id>`, throttled 1/s, always on the last change); `call.created` / `call.ended` already carry `campaignId`.
- `campaign:<id>` topic authorisation: the campaign belongs to the account + `campaigns.read` (closes the Phase 7 "not found until Phase 8" branch in `topic-auth.ts`).
- Dashboard ETA = remaining dials ÷ recent throughput (last 10 min), shifted by window gaps; shown as "≈ 25 min" or "continues tomorrow 09:00".

### 1n. Export

- `POST /campaigns/:id/export { format: csv | xlsx }` → async job (Phase 3 export pattern: `ExportJob` gains `kind: contacts | campaign_results` (default `contacts`) + `campaignId`; download through the existing export link route), `export.progress` WS, signed link 15 min, file kept 24 h.
- Columns: contact name, phone (full only with `contacts.export`, else last 4), status, attempts, last result, disposition, promise date / amount, callback, last call time, duration, cost, skip reason, call link id, + the snapshot variables. CSV with BOM and formula escaping (Phase 3), XLSX via `write-excel-file` (already a dependency).
- Audited `campaign.exported`.

### 1o. Single call ("Call now")

- `POST /calls { contactId, flowId + version ('published' \| n) \| agentId }` (`calls.trigger`, `Idempotency-Key`) → `startOutboundCall` with the dry-run provider while no phone provider exists (Phase 13: SIP) — same dial guard, caps, slots; response = the call; the contact page shows it live and links to the detail.
- "Test in browser" = the Phase 7 tester prefilled with the contact (`/calls/test?contactId=`; tester gains the param).
- Impersonators can't start calls (Phase 7 rule).

### 1p. Security, privacy & compliance

- Tenant scoping on every model (`tenantPlugin`), campaign ids never leak across accounts (404), topic checks (§1m).
- Phones never in logs, events or WS payloads; the dashboard shows names + last 4 digits; full phones only in exports with `contacts.export`.
- Variables snapshot holds only fields the flow uses + name (data minimisation); purge with the campaign.
- Compliance: hard window bounds for live calls, per-contact caps + min gap, DND / opt-out at dial time (snapshot and current phone), recording notice + AI disclosure from Phase 6 / 7 flows, audit of every start / pause / resume / cancel / export / single call, superadmin emergency **pause all campaigns of an account** (audited, `pauseReason: admin`, only a superadmin resumes).
- Recovery agents (`complianceMode: recovery`) → 08:00–19:00 bound shown in the wizard; the account window setting warns when it goes outside 08:00–21:00.

### 1q. Permissions & roles (already in RBAC, + one new)

| Permission                 | Owner / Admin | Manager | Agent | Viewer |
| -------------------------- | ------------- | ------- | ----- | ------ |
| `campaigns.read`           | ✓             | ✓       | ✓     | ✓      |
| `campaigns.write`          | ✓             | ✓       | —     | —      |
| `campaigns.run`            | ✓             | ✓       | —     | —      |
| `campaigns.export` (new)   | ✓             | ✓       | —     | —      |
| `calls.trigger` (Call now) | ✓             | ✓       | ✓     | —      |

- New permission → migration calls `syncSystemRoles()` (Phase 2 rule). Creating / starting needs `flows.read` for the flow; impersonators read only; suspended accounts read only.

### 1r. API surface (all `/api/v1`, Bearer, tenant-scoped)

| Method | Path                                  | Notes                                                                                  |
| ------ | ------------------------------------- | -------------------------------------------------------------------------------------- |
| GET    | `/campaigns`                          | Filters `status`, `mode`, `flowId`, `q`, `parentId`; cursor pagination; stats included |
| POST   | `/campaigns`                          | Create draft (`campaigns.write`)                                                       |
| GET    | `/campaigns/:id`                      | Campaign + stats + estimate + waiting info                                             |
| PATCH  | `/campaigns/:id`                      | Edit (rules §1e), `revision` check like flows                                          |
| DELETE | `/campaigns/:id`                      | Soft delete (state rules)                                                              |
| POST   | `/campaigns/:id/duplicate`            | New draft                                                                              |
| POST   | `/campaigns/audience/preview`         | Counts + exclusions + samples + missing values                                         |
| POST   | `/campaigns/:id/estimate`             | Cost estimate for the current settings                                                 |
| POST   | `/campaigns/:id/start`                | Start now / schedule (`campaigns.run`, Idempotency-Key)                                |
| POST   | `/campaigns/:id/unschedule`           | scheduled → draft                                                                      |
| POST   | `/campaigns/:id/pause` / `resume`     | `campaigns.run`                                                                        |
| POST   | `/campaigns/:id/cancel`               | `{ hangUpLive }`                                                                       |
| GET    | `/campaigns/:id/contacts`             | Per-contact results (filters status / result / disposition / skip reason, cursor)      |
| GET    | `/campaigns/:id/runs`                 | Runs of a recurring parent                                                             |
| POST   | `/campaigns/:id/export`               | CSV / XLSX job (`campaigns.export`); `GET /exports/:id` reused                         |
| POST   | `/calls`                              | Single outbound call (§1o)                                                             |
| GET    | `/calls?campaignId=&provider=`        | Phase 7 list + new filters                                                             |
| PATCH  | `/account/settings`                   | + `callCaps` (owner / admin)                                                           |
| PATCH  | `/admin/accounts/:id/limits`          | `maxConcurrentCalls`, `dialsPerMinute` (superadmin)                                    |
| POST   | `/admin/accounts/:id/campaigns/pause` | Emergency pause all (superadmin)                                                       |

- Error codes (new): `CALL_NOT_ALLOWED` (422 — DND / opted out / cap; details say which), `CAMPAIGN_LIMIT_REACHED` (429 — active campaigns), `CAMPAIGN_REVISION_CONFLICT` (409 — edit with a stale `revision`, like `FLOW_REVISION_CONFLICT`); reused: `CAMPAIGN_NOT_RUNNABLE` (409), `CALL_OUTSIDE_WINDOW` (422), `CONFLICT_INVALID_STATE` (409), `RESOURCE_IN_USE`, `WALLET_INSUFFICIENT_BALANCE`, `CALL_LIMIT_REACHED`.
- Audit actions (new): `campaign.created`, `campaign.updated`, `campaign.started`, `campaign.scheduled`, `campaign.paused`, `campaign.resumed`, `campaign.canceled`, `campaign.deleted`, `campaign.exported`, `campaign.admin_paused`, `call.triggered`, `account.limits_updated` (meta: ids, counts, reasons — no phones).
- Notifications (new types): `campaign.completed`, `campaign.paused` (reason), `campaign.run_skipped` (dotted like the Phase 4 `wallet.*` types).

### 1s. Frontend

- **Campaigns list** (`/campaigns`, `campaigns.read`): status chips, mode badge (Dry run), flow + version, progress bar, answered %, spend / virtual cost, next start, actions (pause / resume / duplicate / delete per role + state), filters in the URL, live updates.
- **Wizard** (`/campaigns/new`, `/campaigns/:id/edit`; `campaigns.write`): 1 Basics (name, mode, flow → published version, read-only summary of the flow), 2 Audience (lists / segment / filter / pick contacts, live preview counts + exclusions + missing values + skip toggles), 3 Schedule & window (now / later date-time, end, recurrence, timezone, window days + hours with the effective window and compliance bound shown), 4 Retries & pacing (attempts, interval, retry on, callbacks, promise follow-up, concurrency, dials per minute, priority, dry-run outcome mix + scenarios + speed), 5 Review (all settings, estimate range + wallet available + warnings, Save draft / Schedule / Start now). Unsaved-changes guard; field errors per step.
- **Campaign detail** (`/campaigns/:id`): header (status, pause reason, waiting info, controls by role), counters + progress bar + ETA, dispositions chart (`@mui/x-charts`, already a dependency), spend / virtual cost, live calls (links to `/calls/:id`), per-contact results table (filters, cursor "Load more", attempts, last result, disposition, promise, callback, skip reason), settings summary, runs tab for recurring parents, export button with progress, activity (audit-like timeline of status changes). Subscribes to `campaign:<id>`.
- **Entry points:** contact page — **Call now** (dry-run label until SIP) + **Test in browser** + calls / campaigns of the contact; flow page — "Used in campaigns" + delete refusal names them; Settings → Calls — calling window (moved here from Account) + call caps; superadmin account page — limits + "Pause all campaigns"; notifications for completed / paused; dashboard card "Campaigns" (running count, today's calls); `LIVE_PHASE = 8`.
- Lazy chunks: wizard, detail; main bundle growth ≤ 5 KB gzip.

### 1t. Testing strategy

- **Unit (backend):** window math (every day / boundary / buffer / intersect / tz incl. a DST zone), dial guard table (every row), result classification table (every row), slots Lua (counts, expiry, three-way atomicity, concurrent claims), rate bucket, recurrence (next occurrences, skip when a run is active), estimate, seeded dry-run outcomes (same seed → same result; mix proportions over 10,000 seeds ±2 %), simulated customer scenarios on the 4 templates.
- **Integration:** campaign API (every route, roles, isolation, state rules, revision conflict), snapshot (dedupe, DND, opted-out, missing values, resume after a crash mid-snapshot), dispatcher with a `FakeClock` (window waits, retries at the right time, callbacks, caps, min gap, priority / fairness, concurrency never exceeded), **100-contact dry-run at ×50** end to end (counts add up, every contact final, no contact dialed twice per attempt), wallet auto-pause / auto-resume (real billing with a billable test provider + dry-run virtual), budget pause, circuit breaker, restart (kill the dispatcher mid-run → recover → no double dials), graceful shutdown, export (CSV / XLSX content, phone masking by permission), `isFlowInUse`, topic auth, logs without phones.
- **Frontend unit:** wizard steps (validation, preview, estimate), list, detail (live updates from a fake realtime client), entry points, roles.
- **E2E (Playwright):** the "Done when" 100-contact dry-run campaign at ×20 (retries, window wait → window widened → dials, pause / resume mid-run, export CSV contents), wallet auto-pause (virtual) + resume, a callback scheduled, DND / opted-out skipped with reasons, single "Call now" from a contact, roles (viewer read-only, agent no start, impersonator read-only).
- Coverage gates stay ≥ backend 95 / 85 / 95 / 95, frontend 95 / 90 / 90 / 95.

### 1u. Contract for later phases

| Function / data                                               | Used by                                                         |
| ------------------------------------------------------------- | --------------------------------------------------------------- |
| `CallManager.startOutboundCall` + `assertDialAllowed` + slots | Phase 10 API trigger, Phase 13 SIP provider, Phase 14 callbacks |
| `campaign.mode = live` + `callerNumberId`                     | Phase 13 (phone numbers, 1600-series caller ID)                 |
| `campaignContacts` results + `contact.lastDisposition`        | Phase 9 reports, segments                                       |
| `campaign.status` / completion hooks                          | Phase 10 webhooks (`campaign.completed`)                        |
| Hard window bounds + caps                                     | Phase 11 compliance review                                      |
| `DryRunProvider` + `SimulatedCustomer`                        | Phase 11 load tests, demos                                      |

---

## 2. Tasks ka overview

| #     | Task                                                                                                                                                                        | Repo | Size | Depends on   |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---- | ------------ |
| T8.1  | Models (Campaign, CampaignContact, Call / Contact / Account fields), migration 0009, `CAMPAIGN_LIMITS`, env, error codes, audit, WS, permission + role sync, notifications  | BE   | M    | —            |
| T8.2  | Window math + dial guard + per-contact caps (pure, `date-fns` + `@date-fns/tz`), slots (Lua) + rate buckets                                                                 | BE   | M    | T8.1         |
| T8.3  | Outbound call path: `startOutboundCall`, lifecycle / causes, `DryRunProvider`, `SimulatedCustomer`, `ScaledClock`, `VirtualCallBilling`, web calls on the new slots         | BE   | L    | T8.1, T8.2   |
| T8.4  | Campaign service: CRUD, validation, audience preview + snapshot, estimate, lifecycle actions, `isFlowInUse`                                                                 | BE   | L    | T8.1, T8.2   |
| T8.5  | Scheduler + dispatcher + result handler: jobs, claims, retries, callbacks, completion, auto-pause / resume, recover / sweep, shutdown                                       | BE   | L    | T8.3, T8.4   |
| T8.6  | Recurring runs, notifications, contact updates (`lastDisposition` + segment filter), admin limits + emergency pause, Settings call caps                                     | BE   | M    | T8.5         |
| T8.7  | Campaigns API + single call API + export + topic auth + OpenAPI                                                                                                             | BE   | M    | T8.4–T8.6    |
| T8.8  | Hardening: 100-contact dry run, restart / double-dial tests, circuit breaker, `bench:campaign`                                                                              | BE   | M    | T8.7         |
| T8.9  | Seed, ADR 0036, docs (README, data-model, conventions, compliance, setup), manual dry run                                                                                   | BE   | S    | T8.8         |
| T8.10 | FE foundation: `gen:api`, clients, query hooks, routes, `LIVE_PHASE = 8`, WS events, shared window / schedule fields                                                        | FE   | M    | T8.7         |
| T8.11 | Campaigns list + wizard (5 steps, preview, estimate)                                                                                                                        | FE   | L    | T8.10        |
| T8.12 | Campaign detail: live dashboard, controls, results table, runs, export                                                                                                      | FE   | L    | T8.10        |
| T8.13 | Entry points: contact Call now / Test in browser / history, flow "used in campaigns", Settings → Calls (window + caps), admin limits / pause, notifications, dashboard card | FE   | M    | T8.11, T8.12 |
| T8.14 | Playwright E2E: 100-contact dry run (Done when), wallet pause / resume, callback, DND / caps, Call now, roles                                                               | FE   | M    | T8.11–T8.13  |
| T8.15 | Gap audit, security checklist, docs, Phase 8 sign-off                                                                                                                       | both | M    | all          |

Batches: **Batch 1 = T8.1–T8.5** (`[P8-B1-DONE]`), **Batch 2 = T8.6–T8.9** (`[P8-B2-DONE]`), **Batch 3 = T8.10–T8.15** (`[P8-B3-DONE]`).

---

## 3. Tasks — step by step

### T8.1 — Models, migration 0009, limits, catalogue

- [ ] `campaign.model.ts` (§1e, `tenantPlugin`, soft delete, `revision`), `campaign-contact.model.ts` (§1f, indexes), `Call` + `campaignContactId`, `attempt`, `charged`, provider `dryrun`, statuses / end reasons (`busy`, `no_answer`, `invalid_number`), unique partial index `{ campaignContactId, attempt }`; `Contact.lastDisposition`; `Account.limits { maxConcurrentCalls, dialsPerMinute }`, `Account.settings.callCaps`.
- [ ] Migration **0009-campaigns**: indexes, account defaults (`limits`, `callCaps`), `syncSystemRoles()` for `campaigns.export`; up / down + rollback test.
- [ ] `CAMPAIGN_LIMITS` (§1l), `DRY_RUN_MAX_SPEED` env (default 50, production ≤ 20), `TELEPHONY_PROVIDER` env (`dryrun` only in Phase 8; `sip` reserved), production rules + tests.
- [ ] Error codes (`CALL_NOT_ALLOWED`, `CAMPAIGN_LIMIT_REACHED`, `CAMPAIGN_REVISION_CONFLICT`), audit actions (§1r) with meta shapes, WS payload schemas (`campaign.status` + `pauseReason`, `campaign.progress`), notification types, permission `campaigns.export` + role matrix test.
- [ ] Add `date-fns` + `@date-fns/tz` (exact versions, licence MIT checked) per ADR 0017.
- [ ] data-model.md (Campaign / CampaignContact rewritten, `holdLedgerEntryId` removed with the Phase 4 reason), error-codes.md, audit.md, websocket.md, rbac docs updated.

### T8.2 — Window math, dial guard, caps, slots

- [ ] `campaigns/window.ts`: `isInWindow`, `nextWindowStart`, `intersect`, `effectiveWindow({ account, campaign, live, recovery })`, end buffer — pure, `Clock`-free inputs; 100 % branch tests incl. Sunday, days list gaps, exact boundary minutes, `Asia/Kolkata` + one DST zone (e.g. `Europe/London`).
- [ ] `campaigns/dial-guard.ts`: `assertDialAllowed(input) → ok | wait(until, reason) | skip(reason) | pause(reason)` (§1d table, each row tested), DND lookup on snapshot + current phone, opt-out, deleted contact, caps (day / ISO week in account tz, per mode), min gap.
- [ ] `campaigns/slots.ts`: Lua lease script (three sets, expiry, atomic), refresh, release, `count(accountId)`; rate buckets (campaign + account); tests with real Redis (unique prefix) incl. 50 concurrent claim attempts never exceeding limits.
- [ ] Web test calls (Phase 7) move to the slots (per-account limit atomic) — Phase 7 tests stay green.

### T8.3 — Outbound call path + dry-run provider

- [ ] `CallManager.startOutboundCall` (§1c): refactor the session start out of `attach`, provider registry (`webcall`, `dryrun`; `sip` → `CAMPAIGN_NOT_RUNNABLE` / 409), lease → Call → billing → `startCall` → session → end → lease release + `onEnded`.
- [ ] Lifecycle: transitions `ringing → busy | no_answer | failed`, causes `busy`, `no_answer`, `rejected`, `invalid_number` → statuses / end reasons; table tests.
- [ ] `core/telephony/dryrun.ts`: `DryRunLeg` (seeded pre-answer outcome + ring time, `play()` on the scaled clock, DTMF / text from the simulated customer, hangup), `ScaledClock` (speed, tested against `FakeClock`).
- [ ] `simulated-customer.ts`: scenarios (§1b) for Loan recovery / Payment reminder / Feedback survey / Inbound support + generic; reacts to "bot done speaking"; deterministic per seed; tests run each scenario on its template and assert the disposition.
- [ ] `VirtualCallBilling`: prices as a phone call, `charged: false`, no ledger rows (money-writes test extended: dry-run never writes ledger), returns virtual cost to the campaign.
- [ ] Dry-run forces the fake voice + fake AI model (test: `VOICE_PROVIDER=openai` env still gives a fake session for dry-run calls).

### T8.4 — Campaign service

- [ ] CRUD with revision checks, validation (flow published & not deleted, version exists, window ∩ account non-empty, recurrence valid, pacing ≤ account limits, `live` refused), duplicate, delete rules, list with filters.
- [ ] `audience.ts`: preview (counts by exclusion, samples with last 4 digits, missing flow variables per field) and snapshot (batched, resumable cursor, dedupe by phone, `excludeActiveCampaigns`, `skipIfMissing`, variables limited to the fields the version uses + name).
- [ ] Estimate (§1j) + stored estimate; wallet available in the response.
- [ ] Actions: start (now / schedule, pinned version checks), unschedule, pause, resume (cause check), cancel (`hangUpLive` → `CallManager.hangup` for the campaign's live calls), all state-checked + audited + `campaign.status`.
- [ ] `isFlowInUse` real (flow delete 409 lists campaigns; Phase 6 tests updated).

### T8.5 — Scheduler, dispatcher, results

- [ ] Queue `campaigns` (`QUEUES`), worker + job names (§1a), deduped job ids, schedules registered on boot; `campaign.start` / `end` / `dispatch` / `sweep`.
- [ ] `dispatcher.ts`: per-account loop (§1h) — priority + round robin, window wait (`waitingUntil` + delayed wake), wallet / budget gate (real + virtual), slots + rate, claim (`findOneAndUpdate` with `claimToken`), guard, `startOutboundCall`; never awaits a call's end.
- [ ] `results.ts`: classification table (§1i), retries into the window, callbacks (date / time → tz → window), promise follow-up, stats `$inc`, contact updates, completion, wake; idempotent per call.
- [ ] Auto-pause / resume (wallet, budget, suspended account via `account.suspended` hook, circuit breaker), notifications.
- [ ] Recover + sweep (§1k), graceful shutdown order (dispatchers stop before calls end).
- [ ] Tests with `FakeClock` + dry-run at ×50: window waits, retry timing, callbacks, caps / min gap, priority, concurrency ceiling, completion, auto-pause / resume, recover after a simulated crash (claims released, no double dial), logs without phones.

### T8.6 — Recurring runs, notifications, contacts, admin (`[P8-B1-DONE]` after T8.5)

- [ ] `recurrence.ts`: next occurrences (daily / weekly, `until`, tz), repeatable job per parent, run creation (snapshot, version policy), skip when a run is active (+ notification), parent pause / cancel stops runs.
- [ ] Notifications + emails (`campaign.completed`, `campaign.paused`, `campaign.run_skipped`) to the starter + owners / admins (in-app; email for auto-pauses), using the Phase 4 alert pattern (once per pause).
- [ ] Contact `lastDisposition` written by results; segment filter fields `lastDisposition`, `lastCalledAt` (before / after / never) + Phase 3 filter tests.
- [ ] Admin: `PATCH /admin/accounts/:id/limits`, emergency pause all (audited, `pauseReason: admin`, resume only by a superadmin); account suspension auto-pauses campaigns, enabling does not auto-resume.
- [ ] Settings: `callCaps` in `PATCH /account/settings` (owner / admin), calling window warning outside 08:00–21:00.

### T8.7 — Campaigns API, single call, export

- [ ] Routes §1r with schemas, OpenAPI registration, rate limits (`rl:campaign:` writes 60 / min per user), impersonation + suspended rules, Idempotency-Key on start / `POST /calls`.
- [ ] `GET /campaigns/:id/contacts` (filters, cursor, names + last 4), `GET /campaigns/:id/runs`.
- [ ] `POST /calls` single call (§1o) + `GET /calls` filters `campaignId` / `provider`; call view gains `campaign { id, name, attempt }`, `charged`.
- [ ] Export job (§1n): CSV + XLSX, masking by permission, progress, signed link, retention cleanup, audit.
- [ ] `campaign:<id>` topic authorisation + tests; `campaign.progress` throttle tests.
- [ ] Tests: every route × role, isolation (another account → 404, never listed, topic refused), state rules, revision conflict, idempotent start.

### T8.8 — Hardening & bench

- [ ] Integration: the **100-contact dry run** (mixed outcomes, `maxAttempts 3`, interval 15 min on a `FakeClock`, a window gap overnight) → every contact final, `stats` = recount, attempts ≤ 3, no `{ campaignContactId, attempt }` duplicate, retries only inside the window.
- [ ] Restart: stop the dispatcher + kill live dry-run sessions mid-run → recover → finishes with the same totals, no double dial; Redis flush mid-run → sweep rebuilds jobs.
- [ ] Circuit breaker (agent turned off after start), pinned version guards, account suspended mid-run, wallet empty mid-run (real billing test provider) + top-up resume.
- [ ] `npm run bench:campaign [contacts] [speed] [concurrency]` (1,000 contacts × ×50 × 20): dispatcher tick time p95, dials / s, event-loop lag, Mongo ops per call, RSS; numbers in README + sign-off (no perf asserts).

### T8.9 — Seed, ADR, docs (`[P8-B2-DONE]` after this)

- [ ] Sample `docs/samples/campaign-100.csv`: 100 valid contacts (names, unique phones, amount, due date; a few marked for DND / opt-out by the E2E itself) — the Phase 3 sample keeps its deliberate bad rows.
- [ ] Seed: "Demo Finance" gets a completed dry-run campaign (30 contacts, mixed results, one callback pending) and a draft campaign — idempotent; demo segment "Promise due today".
- [ ] **ADR 0036 — Campaign scheduler & dialer** (dispatcher in the call-owning process, Mongo state + Redis leases, no campaign hold, dry-run provider with virtual time / money, window + caps rules); ADR 0005 follow-up note (queue design done).
- [ ] Docs: README (Campaigns section, env vars, how to run a dry run), data-model, api.md, websocket.md, audit.md, error-codes.md, security.md (exports, phones), compliance-notes.md (enforcement table: window / caps / DND skip → Phase 8 ✅), cost-model (estimate assumptions).
- [ ] Manual check on the dev server through the API (no UI before Batch 3): 100-contact dry run with retries + a window wait + pause / resume + export, clean logs.

### T8.10 — Frontend foundation

- [ ] `gen:api`; clients `campaigns.ts`, calls `start`; `features/campaigns/{keys,queries,labels}.ts`; WS events (`campaign.status`, `campaign.progress`, topic subscribe on the detail); `LIVE_PHASE = 8`; routes `/campaigns`, `/campaigns/new`, `/campaigns/:id`, `/campaigns/:id/edit` (wizard + detail lazy).
- [ ] Shared fields: `CallingWindowField` (days + hours, effective window hint), `ScheduleField` (now / later / recurring, timezone), `OutcomeMixField` (dry-run mix sums to 100 %), money / percent helpers; tests.

### T8.11 — Campaigns list + wizard

- [ ] List (§1s) with live updates, empty state ("Create your first campaign"), role-aware actions, confirm dialogs.
- [ ] Wizard 5 steps (§1s): per-step validation, audience preview (debounced, counts + exclusions + missing values + skip toggles), estimate on Review, Save draft / Schedule / Start now (Idempotency-Key), server errors mapped to fields, unsaved-changes guard, edit mode with the running-campaign restrictions.
- [ ] Tests incl. roles and the `live` mode disabled with "needs a phone line (SIP)".

### T8.12 — Campaign detail

- [ ] Header + controls (pause / resume / cancel with "hang up live calls" option, duplicate, edit, delete), pause reason / waiting banners, counters + progress + ETA, dispositions chart, spend / virtual cost, live calls, results table (filters, load more, link to calls), runs tab, settings summary, export with progress + download, activity timeline.
- [ ] Live via `campaign:<id>` progress + `call.ended`; tests with the fake realtime client.

### T8.13 — Entry points

- [ ] Contact page: Call now (flow / agent picker, dry-run label, shows the call live, guard errors explained), Test in browser (`/calls/test?contactId=`; tester reads the param), the contact's calls + campaigns.
- [ ] Flow page: "Used in campaigns"; delete refusal names them.
- [ ] Settings → Calls: calling window (moved from Account) + call caps; superadmin account page: limits + "Pause all campaigns"; notification texts / links for the new types; dashboard "Campaigns" card; Calls list filters campaign / provider and the "Simulated" badge.
- [ ] Bundle check (main growth ≤ 5 KB gzip; wizard / detail own chunks).

### T8.14 — Playwright E2E

- [ ] Helpers `e2e/campaigns.ts` (create via wizard, wait for counters, read results, export download).
- [ ] Scenarios (separate short tests, one account per spec):
  1. **Done when:** 100 contacts imported (`docs/samples/campaign-100.csv`) → wizard (list, Loan recovery v1, window that **excludes now** → campaign shows "Waiting for the calling window") → widen the window → dials at ×20 → **pause** mid-run (counters stop) → **resume** → completes with retries (`attempts` up to 3, retried rows visible) → **export CSV** (rows = 100, statuses / dispositions match the table, phones per permission).
  2. **Wallet (dry-run virtual):** low wallet → auto-pause "would run out" banner + notification → top-up → auto-resume.
  3. **Callback + DND / opted-out:** a callback scheduled with its time; DND / opted-out contacts skipped with reasons; caps reached shown as waiting.
  4. **Call now** from a contact (simulated call → detail with campaign-less source, transcript) and the guard refusing a DND contact.
  5. **Roles:** viewer read-only, agent can't start / edit, manager can, impersonator read-only, superadmin emergency pause.
- [ ] All earlier 44 tests stay green; whole suite **twice**; `E2E_FRONTEND_PORT=3150` locally.

### T8.15 — Gap audit, security, docs, sign-off

- [ ] Requirement → test table for §0 / §1 / every task; missing tests added.
- [ ] Security checklist: isolation (campaigns, contacts, topics, exports), no double dials under concurrency, phones absent from logs / events / WS (grep in `E2E_BACKEND_LOGS=1`), exports masked without `contacts.export`, compliance bounds for `live` (unit), gitleaks both repos, money-writes (dry-run writes no ledger).
- [ ] Coverage re-measured (gates raised to new values rounded down to 5, never lowered), bundle numbers vs `main`, `bench:campaign` numbers.
- [ ] Docs both repos (READMEs, CHANGELOGs), BUILD_PLAN Phase 8 ✅, PHASE_8_TASKS all `[x]`, this plan ticked + changelog, **PHASE_8_SIGNOFF.md**; `[P8-B3-DONE]` (full verify both repos, E2E twice, fresh clones without `.env`, actionlint, `infra:down`).

---

## 4. Deliverables checklist

- [ ] Campaign + CampaignContact models, migration 0009, limits, codes, audit, WS, permission, notifications.
- [ ] Window math, dial guard (DND, opt-out, caps, min gap, wallet / budget, compliance bounds), atomic slots + rate buckets.
- [ ] Outbound call path (`startOutboundCall`) with busy / no-answer statuses; dry-run provider with simulated customers, virtual time and virtual cost.
- [ ] Campaign service: CRUD, audience preview + resumable snapshot, estimate, start / schedule / pause / resume / cancel, `isFlowInUse`.
- [ ] Scheduler + dispatcher + results: retries, callbacks, promise follow-ups, completion, auto-pause / resume, recover / sweep, shutdown; recurring runs.
- [ ] Campaigns API, single call API, results export (CSV / XLSX), topic auth, OpenAPI; seed; ADR 0036; `bench:campaign`.
- [ ] UI: campaigns list, 5-step wizard, live detail dashboard, results + export, Call now / Test in browser, Settings → Calls (window + caps), admin limits + emergency pause, notifications, dashboard card.
- [ ] Playwright: 100-contact dry run (window, retries, pause / resume, export), wallet, callback, DND / caps, Call now, roles.
- [ ] Docs: ADR 0036, data-model, conventions, compliance, READMEs, CHANGELOGs, sign-off.

## 5. Risks

| Risk                                                               | Mitigation                                                                                                                   |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Double dialing a contact (retries, crashes, two jobs)              | Claim with `claimToken` + unique `{ campaignContactId, attempt }` on calls + idempotent results; restart / concurrency tests |
| Calling outside allowed hours (regulatory)                         | Pure window math with 100 % branch tests, hard bounds for live calls, guard re-checked right before dialing, end buffer      |
| Excessive calling of one borrower across campaigns                 | Account-wide caps + min gap counted from `calls`, shown in the wizard and the detail                                         |
| Stats drifting from reality                                        | `$inc` in the same step as the status change + sweep recount with a warning log                                              |
| Money runs out mid-campaign                                        | Per-call holds (Phase 4), auto-pause + notification, auto-resume on top-up, live calls end politely (Phase 7)                |
| Dry-run differs from real SIP (answer timing, AMD, carrier errors) | Same `CallManager` / session / results code; provider-specific parts isolated; SIP mapping table prepared for Phase 13       |
| Dry-run fooling users into thinking calls were made                | "Dry run" badges everywhere, "Simulated call" on calls, virtual cost labelled "would have cost", no recordings               |
| Large audiences (50k) slow to snapshot / show                      | Batched resumable snapshot, indexed claims, cursor pages, counters instead of counts, bench at 1,000 × ×50                   |
| Event-loop pressure from many simulated calls                      | Per-process cap 20, scaled clock without audio pacing, bench numbers in the sign-off                                         |
| Timezone / DST mistakes                                            | ADR 0017 library, UTC storage, tests in a DST zone                                                                           |
| Flaky timing tests                                                 | `FakeClock` / `ScaledClock` everywhere in backend tests; E2E waits on counters, never on sleeps; no raised timeouts          |
| Low RAM on the dev machine                                         | `--maxWorkers=2`, bench run alone                                                                                            |

## 6. Recommended order

| Day   | Tasks |
| ----- | ----- |
| 1     | T8.1  |
| 2     | T8.2  |
| 3–4   | T8.3  |
| 5–6   | T8.4  |
| 7–9   | T8.5  |
| 10    | T8.6  |
| 11    | T8.7  |
| 12    | T8.8  |
| 13    | T8.9  |
| 14    | T8.10 |
| 15–16 | T8.11 |
| 17–18 | T8.12 |
| 19    | T8.13 |
| 20    | T8.14 |
| 21    | T8.15 |

_Estimate — run batch-wise with one detailed run prompt (Batch 1 = T8.1–T8.5, Batch 2 = T8.6–T8.9, Batch 3 = T8.10–T8.15)._

## 7. Open questions (defaults used until answered)

| #   | Question                                                                 | Who    | Default in Phase 8                                                           |
| --- | ------------------------------------------------------------------------ | ------ | ---------------------------------------------------------------------------- |
| 1   | Calling window for recovery calls; does RBI 08:00–19:00 apply (licence)? | Client | Account 09:00–19:00 Mon–Sat; live recovery calls hard-bounded to 08:00–19:00 |
| 2   | Max attempts per borrower per day / week; minimum gap                    | Client | 3 / day, 10 / week, 30 min gap                                               |
| 3   | Holidays / blackout dates (national holidays, Sundays already off)       | Client | None (days of week only)                                                     |
| 4   | Should dry-run calls cost money?                                         | You    | No — virtual cost only, no ledger rows                                       |
| 5   | Default retries (attempts, gap, on which results)                        | Client | 3 attempts, 60 min, on no answer / busy / failed                             |
| 6   | Callbacks: honour customer-requested times automatically?                | Client | Yes, within the window and 7 days                                            |
| 7   | Promise-to-pay follow-up call after the promise date?                    | Client | Off by default (setting per campaign)                                        |
| 8   | Default concurrency per account (before the SIP trunk limit is known)    | You    | 10 calls, 60 dials / min                                                     |
| 9   | Recurring runs: latest published version or the pinned one?              | You    | Pinned (`versionPolicy` setting)                                             |
| 10  | Who gets campaign emails (starter, owners, admins)?                      | Client | Starter + owners / admins; email only for auto-pauses                        |
| 11  | Export phone numbers in full?                                            | Client | Only with `contacts.export`, else last 4 digits                              |

---

## Changelog

- 2026-10-16: Plan created after Phase 7 sign-off (Phase 7 merged to `main`: backend `a6823cd`, frontend `7daa8ba`).
- 2026-10-16: Run prompt [PHASE_8_PROMPT.md](../prompts/PHASE_8_PROMPT.md) added (one file, 3 batches). Precisions there: module layout, exact Campaign / CampaignContact fields (+ `dueRank` claim order, `history` for the Activity tab instead of the audit log), call lifecycle for busy / no answer, window math rules (`[start, end)`, DST-tested), pure `decideDial` + 3-query wrapper, Lua slots (account / campaign / process leases) and rate buckets, BullMQ job ids with `-` (BullMQ refuses `:`), in-process dispatcher loops woken by jobs, result classification incl. callbacks without a date (= no outcome), dry-run leg / scaled clock / virtual billing details, simulated-customer scripts per template, fake AI rules for callback / refusal / wrong number, export through `ExportJob.kind`, dotted notification types, env vars (`TELEPHONY_PROVIDER`, `DRY_RUN_MAX_SPEED`, `CAMPAIGNS_ENABLED`), error codes 44 → 47, audit 71 → 83, E2E specs and sample `campaign-100.csv`. Dry-run speed also divides retry / promise follow-up delays; auto-resume re-checks the wallet on every balance increase.
