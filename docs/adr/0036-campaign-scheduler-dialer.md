# 0036 — Campaign scheduler & dialer

- **Status:** accepted
- **Date:** 2026-10-21

## Context

Phase 8 calls lists of contacts on a schedule: a campaign pins a published flow version, snapshots its audience, dials inside a calling window with retries and customer callbacks, respects per-account / per-campaign concurrency and dial rates, and never calls a contact more often than the account allows. Real phone lines only arrive in Phase 13 (SIP), so everything has to run — and be tested — end to end on a **dry-run** line without real calls or real money. Calls are long-lived and owned by one process (ADR 0035); a dial must never happen twice, also across restarts and with two servers.

## Options considered

1. **Dispatcher in the call-owning process, Mongo as the state, Redis for leases and buckets, BullMQ for timing only.** Chosen.
2. **One BullMQ job per contact / attempt** — natural retries and delays, but up to 50,000 delayed jobs per campaign, pause / cancel / window changes need mass job edits, the job and the contact state can disagree, and the worker that runs the job would have to own the live call.
3. **A cron-like loop in the API process only** — simple, but no atomic slots across servers and calls owned by a process that may not run voice.

## Decision

- **State in Mongo:** `campaigns` (settings, pinned `flowVersionId`, `status` with compare-and-set moves + history, `stats` updated with `$inc` in the same step as a contact change) and `campaignContacts` (the audience snapshot taken at start: phone, name and only the fields the version uses; `status`, `dueRank` callback → retry → fresh, `nextAttemptAt`, counted `attempts` and every `dials`). Claims are `findOneAndUpdate` with a `claimToken`; calls carry a unique `{ campaignContactId, attempt }`, so a second dial of the same attempt is impossible.
- **Dispatcher:** one `CampaignDispatcher` per process next to `CallManager`; per-account loops (tick every 2 s while something runs, woken when a call ends, a campaign resumes or a window opens). A tick serves running campaigns high → normal → low priority (round robin within a priority), checks the effective window (account ∩ campaign ∩ TRAI 09–21 / RBI 08–19 for live calls, 5-minute end buffer), money (the wallet, or the virtual balance of a dry run), that the pinned version can still run, then for each contact: concurrency → rate bucket → claim → dial guard (DND on both phones, opt-out, invalid phone, per-contact caps per day / ISO week + minimum gap, counted per mode) → `startOutboundCall`. It never waits for a call; results are applied once per call when it ends.
- **Redis:** dial slots as sorted-set leases (account / campaign or web group / process, one Lua script, 30-second leases refreshed by the call heartbeat — a crashed process frees its slots by itself) and per-minute token buckets (campaign + account). Dry runs pace both in virtual minutes (× speed).
- **BullMQ (`campaigns` queue) for timing only:** delayed start / end jobs (ids with `-`), a job scheduler per recurring parent (`runs-<id>`, cron in the campaign timezone), exports, wake-ups and a sweep every minute. The sweep is the safety net: due starts and recurring occurrences (`nextRunAt` compare-and-set), interrupted snapshots, past `endAt`, stale claims, results of calls that ended while nobody listened, stats drift, budget pauses.
- **Results:** a pure `classifyResult` (plan §1i): final dispositions, promise follow-ups, customer callbacks moved into the window, retries after `interval ÷ dry-run speed` up to `maxAttempts`, invalid numbers, and not-counted ends (shutdown, wallet, max duration) that come back without using an attempt. 10 technical failures in a row pause the campaign (circuit breaker).
- **Money:** no campaign hold (ADR 0032): every call holds and settles on its own; wallet empty → auto-pause, a top-up auto-resumes (`autoResume`).
- **Dry-run provider:** `DryRunLeg` with seeded outcomes (answered / no answer / busy / failed / invalid number), simulated customers per template, a `ScaledClock` (×1–×50, ≤ ×20 in production), the fake voice and fake AI, and `VirtualCallBilling` (priced like a phone call, never charged, `charged: false`). The same `CallManager`, sessions, flow host, results and stats run as for real calls.
- **Recurring campaigns** are a parent (scheduled, never dials) that creates a child campaign per occurrence with a fresh snapshot and the pinned or the then-latest version; an occurrence is skipped while the previous run is active.

## Consequences

- **Positive:** one code path for dry runs and (Phase 13) live calls; restart-safe without a job per contact; atomic limits across processes; the 100-contact dry run, restarts, a Redis flush and two dispatchers are covered by tests on a fake clock.
- **Negative / trade-offs:** the dispatcher polls Mongo (a few queries per dial, ~58 Mongo operations per call in `bench:campaign`); a process that owns calls must run the dispatcher (API-only processes only create / start campaigns); customer callbacks keep their real time in dry runs, so a dry run with callbacks stays running until they are due.
- **Follow-ups:** Phase 13 SIP provider (`TELEPHONY_PROVIDER=sip`, live mode, trunk limit) and the carrier result mapping; Phase 10 public API + `campaign.completed` webhooks; fewer queries per dial if `bench:campaign` shows Mongo as the limit.
