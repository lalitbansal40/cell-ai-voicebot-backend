# 0043 — Report analytics: daily rollups written by an `updatedAt` sweep with per-entity marks, recounted from raw rows

- **Status:** accepted
- **Date:** 2026-10-27

## Context

Phase 14 adds the Reports page, Dashboard tiles, exports and e-mailed reports over calls (voice + WhatsApp), WhatsApp messages and spend. Reports must be fast for large accounts (100k calls, 500k messages, ranges up to a year), must match the raw data exactly, and must survive raw-data retention (calls are purged after 180 days, chats after 90). Raw rows keep changing after they are first written: Meta's call duration and message statuses arrive late, people set dispositions later, holds become charges. Ledger rows are insert-only.

## Options considered

1. **Aggregate raw rows on every request** — always exact, but slow on big accounts and impossible once raw rows are purged.
2. **Hooks in every write path that `$inc` rollups** — fresh, but every service (session end, WhatsApp settle, status webhooks, billing engine, manual edits, future phases) must remember to call them, and a retried hook double counts.
3. **Daily rollups written from per-entity contributions found by an `updatedAt` sweep** — one place to count; each entity's last counted rows are stored, so a change applies only the difference; a nightly recount from raw rows catches anything missed.

## Decision

Option 3.

- **Definitions** (`modules/analytics/definitions.ts`, glossary [METRICS.md](../analytics/METRICS.md)) are pure functions: call / message / ledger row → rows `{ day (account timezone), channel voice | whatsapp | money, test, kind all | campaign | flow | agent | user | template | number, refId, counters }`. Counters are integers; ratios are computed on read. Neighbour facts (a reply to a template, a first response) come from `context.ts`.
- **Rollups** `statsDaily` — unique per account × day × channel × test × kind × refId; no personal data; kept 25 months.
- **Marks** `analyticsMarks` (`<entity>-<id>` → the rows it added) — a separate collection because ledger rows are immutable and to keep `updatedAt` of calls / messages untouched. The writer computes `next − counted`, `$inc`s the rollups and stores `next` in one transaction per batch. Purges delete the marks with the raw rows; the rollups stay.
- **Sweep** `analytics-sweep` (maintenance queue, every minute, concurrency 1): calls, messages and ledger rows with `updatedAt` past the Redis watermark (minus a 120 s overlap for late commits), batches of 500, indexes `analytics_sweep { updatedAt, _id }`. Idempotent. No write path needs a hook.
- **Recount** `rebuildAccount` (same definitions): recomputes a day range (reading raw rows 2 days around it for replies), compares, replaces those days and resets the marks of every recounted row. Used by migration `0015-analytics` (backfill), the nightly `analytics-reconcile` (last 3 days; fixes + `analytics.reconcile_mismatch` bell to superadmins) and `npm run analytics:rebuild`. Days before the raw-data floor are never rebuilt.
- **One writer at a time:** a Redis lock (`analytics-lock`, 10 min TTL) shared by the sweep, the reconcile and the CLI.

## Consequences

- Reports read a few hundred rollup rows instead of scanning raw data, and keep history after purges.
- Freshness is ≤ ~1 minute (sweep) + 60 s (report cache) — fine for reports; live screens keep using their own realtime events.
- One filter per query is served by a rollup slice; combinations (campaign × team member) are answered by the raw drill-down lists.
- Counting rules live in one file; changing one needs a recount of the affected range (`analytics:rebuild`), which the runbook lists.
- An extra `analyticsMarks` document per counted call / message / spend row.
