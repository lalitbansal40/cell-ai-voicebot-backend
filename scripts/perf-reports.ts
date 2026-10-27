/**
 * DEV ONLY — Phase 14 performance check (PHASE_14_PLAN T14.9 §3).
 *   npm run perf:reports                     (100,000 calls + 500,000 messages, 400 days)
 *   npm run perf:reports -- 20000 100000     (smaller run)
 * Works in a throw-away database `cav_perf` on the MONGODB_URI server (dropped at the
 * end): generates one account's history, times the backfill (rollups from scratch) and a
 * second recount, every report tab over 7 / 30 / 365 days (p50 / p95 of 20 runs, target
 * p95 < 1,500 ms) and checks the report queries use indexes (no COLLSCAN).
 * Needs `npm run infra:up`. Refuses NODE_ENV=production.
 */
import { performance } from 'node:perf_hooks';

import mongoose, { Types } from 'mongoose';

import { getEnv } from '../src/config/env';
import { AccountModel } from '../src/db/models/account.model';
import { AnalyticsMarkModel } from '../src/db/models/analytics-mark.model';
import { CallModel, emptyCallCost, emptyCallMetrics } from '../src/db/models/call.model';
import { LedgerEntryModel } from '../src/db/models/ledger-entry.model';
import { MessageModel } from '../src/db/models/message.model';
import { StatsDailyModel } from '../src/db/models/stats-daily.model';
import { connectMongo, disconnectMongo } from '../src/db/mongo';
import { rebuildAccount } from '../src/modules/analytics/rebuild';
import { REPORT_TABS, ReportQuery } from '../src/modules/reports/reports.schema';
import { buildReport, reportContext } from '../src/modules/reports/reports.service';
import { createLogger } from '../src/shared/logger';
import { addDays, ymdInZone } from '../src/shared/time';

const DAYS = 400;
const BATCH = 5_000;
const RUNS = 20;
const TARGET_P95_MS = 1_500;
const TZ = 'Asia/Kolkata';

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
};

const timed = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
  const start = performance.now();
  const out = await fn();
  return [out, performance.now() - start];
};

/** The same server, another database: `…/<db>?…` → `…/cav_perf?…`. */
export const perfUri = (uri: string): string => {
  const url = new URL(uri);
  url.pathname = '/cav_perf';
  return url.toString();
};

const ids = (n: number) => Array.from({ length: n }, () => new Types.ObjectId());

const insertInBatches = async (
  collection: mongoose.mongo.Collection,
  total: number,
  make: (i: number) => Record<string, unknown>,
) => {
  for (let start = 0; start < total; start += BATCH) {
    const docs = [];
    for (let i = start; i < Math.min(total, start + BATCH); i += 1) docs.push(make(i));
    await collection.insertMany(docs, { ordered: false });
  }
};

const main = async (): Promise<void> => {
  const env = getEnv();
  if (env.NODE_ENV === 'production') throw new Error('perf:reports is disabled in production');
  const callCount = Number(process.argv[2] ?? 100_000);
  const messageCount = Number(process.argv[3] ?? 500_000);
  const logger = createLogger({ NODE_ENV: 'development', LOG_LEVEL: 'warn' });
  await connectMongo({ ...env, MONGODB_URI: perfUri(env.MONGODB_URI) }, logger);
  try {
    await mongoose.connection.dropDatabase();
    await Promise.all(
      [
        AccountModel,
        CallModel,
        MessageModel,
        LedgerEntryModel,
        StatsDailyModel,
        AnalyticsMarkModel,
      ].map((m) => m.syncIndexes()),
    );
    const account = await AccountModel.create({ name: 'Perf Finance', slug: 'perf-finance' });
    const accountId = account._id;
    const now = new Date();
    const today = ymdInZone(now, TZ);
    const span = DAYS * 86_400_000;
    const flows = ids(10);
    const agents = ids(5);
    const campaigns = ids(20);
    const users = ids(8);
    const channels = ids(3);
    const templates = ids(15);
    const conversations = ids(2_000);
    const contacts = ids(5_000);
    const when = (i: number, n: number) =>
      new Date(now.getTime() - span + Math.floor((i / n) * span));

    console.info(`Generating ${callCount} calls, ${messageCount} messages over ${DAYS} days…`);
    const [, genMs] = await timed(async () => {
      await insertInBatches(CallModel.collection, callCount, (i) => {
        const at = when(i, callCount);
        const answered = i % 10 < 6;
        const whatsapp = i % 7 === 0;
        return {
          accountId,
          direction: 'outbound',
          provider: whatsapp ? 'whatsapp' : i % 3 === 0 ? 'dryrun' : 'webcall',
          from: 'perf',
          to: 'perf',
          mode: whatsapp ? 'human' : 'ai',
          isTest: i % 50 === 0,
          contactId: contacts[i % contacts.length],
          campaignId: i % 3 === 0 ? campaigns[i % campaigns.length] : null,
          source:
            i % 4 === 0
              ? { kind: 'agent', agentId: agents[i % agents.length] }
              : { kind: 'flow', flowId: flows[i % flows.length] },
          status: answered ? 'completed' : 'no_answer',
          durationSec: answered ? 30 + (i % 200) : 0,
          timestamps: {
            queuedAt: at,
            ringingAt: at,
            answeredAt: answered ? at : null,
            endedAt: at,
          },
          metrics: emptyCallMetrics(),
          cost: emptyCallCost(),
          disposition: answered ? ['promise_to_pay', 'callback', 'paid', 'dispute'][i % 4] : null,
          dispositionSource: answered ? 'ai' : null,
          insights: answered
            ? {
                status: 'done',
                version: 1,
                sentiment: 'neutral',
                hasPromise: i % 4 === 0,
                promiseAmountMicros: null,
                hasSummary: true,
                at,
              }
            : null,
          agentUserId: null,
          whatsapp: whatsapp
            ? { channelId: channels[i % channels.length], answeredBy: users[i % users.length] }
            : null,
          createdAt: at,
          updatedAt: at,
        };
      });
      await insertInBatches(MessageModel.collection, messageCount, (i) => {
        const at = when(i, messageCount);
        const inbound = i % 4 === 0;
        const template = !inbound && i % 5 === 0;
        return {
          accountId,
          conversationId: conversations[i % conversations.length],
          channelId: channels[i % channels.length],
          contactId: contacts[i % contacts.length],
          direction: inbound ? 'in' : 'out',
          origin: inbound ? 'customer' : 'agent',
          type: template ? 'template' : 'text',
          status: inbound ? 'received' : ['sent', 'delivered', 'read', 'read', 'failed'][i % 5],
          statusHistory: [],
          sentBy: inbound ? null : users[i % users.length],
          template: template
            ? {
                templateId: templates[i % templates.length],
                name: 't',
                language: 'en',
                category: 'utility',
              }
            : null,
          reactions: [],
          at,
          createdAt: at,
          updatedAt: at,
        };
      });
      const ledgerCount = DAYS * 3;
      await insertInBatches(LedgerEntryModel.collection, ledgerCount, (i) => {
        const at = when(i, ledgerCount);
        return {
          accountId,
          type: ['call_charge', 'ai_charge', 'whatsapp_charge'][i % 3],
          direction: 'debit',
          status: 'captured',
          amountMicros: 1_000_000 + (i % 100) * 10_000,
          currency: 'INR',
          ref: { type: 'manual', id: `perf-${String(i)}` },
          idempotencyKey: `perf-${String(i)}`,
          createdAt: at,
          updatedAt: at,
        };
      });
    });

    const from = addDays(today, -DAYS);
    const [backfill, backfillMs] = await timed(() =>
      rebuildAccount({ accountId, from, to: today }),
    );
    const [recount, recountMs] = await timed(() => rebuildAccount({ accountId, from, to: today }));

    const ranges = { '7 days': 6, '30 days': 29, '365 days': 364 } as const;
    const rows: { tab: string; range: string; p50: number; p95: number }[] = [];
    for (const tab of REPORT_TABS) {
      for (const [range, back] of Object.entries(ranges)) {
        const query = ReportQuery.parse({
          from: addDays(today, -back),
          to: today,
          compare: 'true',
        });
        const ms: number[] = [];
        for (let r = 0; r < RUNS; r += 1) {
          const [, t] = await timed(async () =>
            buildReport(tab, await reportContext(accountId, query)),
          );
          ms.push(t);
        }
        rows.push({ tab, range, p50: percentile(ms, 50), p95: percentile(ms, 95) });
      }
    }

    // the report queries must use an index
    const plans = await Promise.all(
      (['all', 'campaign', 'template', 'user'] as const).map((kind) =>
        StatsDailyModel.find({
          accountId,
          kind,
          day: { $gte: addDays(today, -364), $lte: today },
          channel: { $in: ['voice', 'whatsapp', 'money'] },
          test: false,
        })
          .explain('queryPlanner')
          .then((plan) => ({ kind, collscan: JSON.stringify(plan).includes('COLLSCAN') })),
      ),
    );

    const slowest = Math.max(...rows.map((r) => r.p95));
    console.info(
      `\nData: ${callCount} calls, ${messageCount} messages, ${DAYS * 3} ledger rows (generated in ${(genMs / 1000).toFixed(1)} s)`,
    );
    console.info(
      `Backfill (rollups from scratch): ${(backfillMs / 1000).toFixed(1)} s, ${String(backfill.rows)} rows, ${String(backfill.differences)} differences`,
    );
    console.info(
      `Recount (analytics:rebuild): ${(recountMs / 1000).toFixed(1)} s, ${String(recount.differences)} differences`,
    );
    console.info('\nReport            range      p50 ms   p95 ms');
    for (const r of rows)
      console.info(
        `${r.tab.padEnd(17)} ${r.range.padEnd(9)} ${r.p50.toFixed(0).padStart(7)} ${r.p95.toFixed(0).padStart(8)}`,
      );
    console.info(
      `\nSlowest p95: ${slowest.toFixed(0)} ms (target < ${String(TARGET_P95_MS)} ms) → ${slowest < TARGET_P95_MS ? 'OK' : 'TOO SLOW'}`,
    );
    console.info(
      `Explain: ${plans.map((p) => `${p.kind} ${p.collscan ? 'COLLSCAN' : 'index'}`).join(', ')}`,
    );
    if (slowest >= TARGET_P95_MS || plans.some((p) => p.collscan) || recount.differences)
      process.exitCode = 1;
  } finally {
    await mongoose.connection.dropDatabase().catch(() => undefined);
    await disconnectMongo();
  }
};

if (require.main === module)
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
