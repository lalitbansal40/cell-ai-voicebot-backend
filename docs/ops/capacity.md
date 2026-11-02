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
