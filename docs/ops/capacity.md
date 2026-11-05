# Capacity (Phase 16 load checks)

Measured on 2 Nov 2026 on a MacBook (Apple Silicon), with one API process that also runs the workers, and
MongoDB and Redis in Docker Desktop sharing their VM with another project. **These numbers are not a
production measurement.** Run them again on the real server size before relying on them (Phase 17).

Run them with `npm run build`, then `npm run perf:inbox`, `perf:api -- messages`, `perf:api -- calls`,
`perf:ws`, `perf:soak`, `bench:voice`. They use the `cav_perf` database and Redis database 9, drop both at
the end, and refuse `NODE_ENV=production`. `PERF_SERVER_LOG=<file>` keeps the API's logs.

| Check                                    | Target                                       | Result                                                              | Verdict       |
| ---------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------- | ------------- |
| Inbox: 500 events / s × 2 min            | 0 lost, 0 doubles, ≤ 2 min, p95 < 300 ms     | 60,000 / 60,000, 0 doubles, drained in 112 s, p95 48 ms             | Pass          |
| API messages: 50 / s × 60 s, one account | p95 < 500 ms, 0 double charges, exact wallet | 9,000 / 9,000, no 500, 0 double charges, exact wallet; p95 4.2–86 s | **Missed**    |
| API calls: 50 / s × 60 s                 | p95 < 500 ms, clear 429, no 500              | 3 accepted, 2,997 clean 429, p95 17 ms                              | Pass          |
| WebSocket: 1,000 clients, 100 events / s | p95 < 500 ms, no leak                        | 300,000 / 300,000, p95 2 ms, 0 left open                            | Pass          |
| Voice                                    | Find the maximum                             | 20 calls: 2.13 % CPU per call, 8.5 MB each, 0 stalled               | **Partly**    |
| Soak: mixed load × 60 min                | Memory and queue flat                        | Memory 266 → 248 MB; 172,905 / 172,905 stored                       | **See below** |
| Sign-up while busy                       | `Check your email` appears                   | 647 of 648 answered 202, p95 325 ms                                 | See below     |

## Findings

**Sends on one wallet are slow at 50 / s (open, owner: Phase 17).** Every wallet change is a transaction on
one row, so one account's changes run one at a time, including the charge for each delivery status. At
50 sends / s that queue grows. No send fails and the money stays exact, but the answer takes seconds. Below
that rate it keeps up: the soak's 5 sends / s showed no backlog. The order of runs changed the numbers a lot
(the worst p95, 86 s, was the first run after a soak). Options for Phase 17: shorter transactions, or
batching delivery charges. Measure on the real database first.

**MongoDB stopped answering for about a minute, in every long run (open, owner: Phase 17 to re-check on
the real server).** It happened at different times, about once an hour. The driver reported
`ReplicaSetNoPrimary`, and once the container restarted. The cause was not found: the container's logs did
not cover those times. A probe during a messages run saw no stall, so it is not tied to that load. The VM
was under heavy load (load average up to 100, swap nearly full). In the final soak this gave 7,788 failed
requests in that minute: webhooks answered 503, which Meta retries, and sends answered 500. Every accepted
message was stored and nothing was charged twice. Because of these errors `perf:soak` itself prints FAIL.
No soak ran a full hour with zero errors.

**Voice maximum is not known above 20 calls.** `CALL_LIMITS.concurrentPerProcess` refuses more, and the
limit was not removed for a benchmark. At 20 calls: 42.6 % of one core, event loop lag p99 16 ms, 4.7 % late
ticks and 0 stalled frames, so 20 is comfortable.

**Sign-up under load: not reproduced.** The Phase 14 and 15 symptom did not appear in 648 sign-ups during
the soak. The single 500 fell in the MongoDB stall.

## Fixed because of these checks

- **Inbound messages and statuses scanned the account's messages.** A partial index on `$type` needs the
  `$type` in the query. Processing fell from 200 to 35 messages / s within 4 min; it now holds about 250 / s.
- **Sends answered 500 at 50 / s.** Transactions on one wallet kept conflicting until the driver gave up at
  120 s. Wallet changes now queue in each process.
- **The global rate limit could refuse Meta's webhooks in a burst.** Signed webhook paths are now exempt.
- **`whatsapp` worker concurrency** went from 10 to 30.

## Phase 17 (2 Nov 2026, same Mac)

**API messages, 50 / s on one account, API and worker as two processes** (`PERF_SPLIT=1`, as production runs them): before the wallet lock p95 7.7 s and 31 s in two runs; with the Redis wallet lock (`5cd4eb4`) **p95 951 ms**, p50 152 ms, 3,000 / 3,000, no 500, money exact. **Still above the 500 ms target**, so this stays open for the staging server (T17.9). One process with the workers inside it is much slower (p95 16 s): run them apart in production.

**Where the time goes:** a wallet hold alone takes 3.3 ms (p50), so the wallet is not the limit. Under load MongoDB in Docker Desktop used up to 2 CPUs, and every operation waited, even a plain unique insert of the idempotency key (up to 4.7 s). The laptop's database is the limit; the real server decides.

## Phase 18 — SIP line (T18.19)

`npm run perf:sip -- --calls 30 --seconds 60` on the Mac lab (Asterisk 22.11 in Docker Desktop, SIPp as the trunk echoing every packet, the bot streaming audio for the whole call — the worst case for RTP), 3 Nov 2026:

| Metric                   | Result                                                            |
| ------------------------ | ----------------------------------------------------------------- |
| Calls answered / dropped | 30 / 0                                                            |
| RTP per call (60 s)      | 3,050 packets out, 3,050 in                                       |
| Loss / jitter            | 0 % (max 0 %) / 1.2 ms average                                    |
| Our process CPU          | 10.5 % of one core (G.711 encode / decode, pacing, jitter buffer) |
| Event loop lag p99       | 12 ms                                                             |
| Asterisk                 | 0.3 % CPU, 88 MB (no transcoding: G.711 both sides)               |
| Leaked ports / legs      | 0 / 0                                                             |

- `SIP_PCMU_PASSTHROUGH` is not needed: G.711 in TypeScript costs about 0.35 % of a core per call.
- **Found:** with too few RTP ports Asterisk 22.11 cannot allocate one for an ExternalMedia channel and then **crashes (segfault)**. Asterisk uses even ports only and each call needs two (trunk leg and ExternalMedia), plus two more during a transfer. Keep the RTP range at least **4 × `SIP_MAX_CHANNELS`** ports (production 20000–20999 = 1,000 ports, enough for 250 channels). Compose restarts the container.
- Staging / production-sized numbers: open (no staging server, Phase 17).

## Phase 19 continuation sender benchmark — 5 Nov 2026

`npm run build && npm run perf:wa-campaign`, fake Meta, isolated cav_perf/Redis DB 9;
two 500-recipient campaigns per sender, two independent senders running together.
Latest run `/tmp/cav-p19r-perf-final3.log` passed after a paused/quiesced hard restart.

| Sender classification             | Recipients | Peak attempts in rolling 1000ms | First-to-last attempt | Captured charges | Duplicate client/provider IDs |
| --------------------------------- | ---------: | ------------------------------: | --------------------: | ---------------: | ----------------------------: |
| Business App/coexistence (cap 18) |       1000 |                              17 |              68.664 s |             1000 |                             0 |
| Confirmed Cloud API (cap 75)      |       1000 |                              48 |              50.215 s |             1000 |                             0 |

Overall wall-clock 71.705 s including setup/start/restart observation. Both senders have
1000 messages, recipient rows and counted sends; counters and captured charges agree.
This measures fake-provider behavior on this laptop, not guaranteed Meta throughput.
The cap is an upper bound; database/queue work reduces observed throughput. Redis
controlled-clock tests independently cover 1000 attempts/classification, shared workers,
retries, downgrade, lower ceilings and fail-closed behavior. Tier/wallet boundaries have
separate campaign integration tests. The hard kill follows pause and callback quiescence;
an arbitrary provider acknowledgement-loss window is not represented by that benchmark.

Earlier `/tmp/cav-p19r-perf7.log` passed using the fake provider's accepted-record timestamp.
A post-fix run found 19 records in a rolling second on the 18 sender. Investigation found
DB guards after slot acquisition and log timestamps after asynchronous fake storage.
Guards now execute before pacing, including after a short wait; provider invocation follows
slot acquisition immediately. Fake logs retain acceptance `at` and add method-entry
`attemptedAt`. The benchmark requires that entry timestamp and keeps the same 1000ms
window, caps, uniqueness and charge assertions. Missing timestamps fail the benchmark.
One worktree attempt also failed before startup because its build was absent; building
resolved that setup issue. None of the failed attempts is claimed as passing evidence.
