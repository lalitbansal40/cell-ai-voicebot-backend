/**
 * DEV ONLY — Phase 4 wallet concurrency check (PHASE_4_PLAN T4.10).
 *   npm run bench:wallet               (default 1,000 calls, 20 parallel workers)
 *   npm run bench:wallet -- 2000 40
 * Creates a throw-away account `bench-<ts>`, credits ₹10,000 and runs N ×
 * (hold → settle) through the real engine across W parallel workers, then
 * checks wallet == Σ ledger and that the balance never went below zero.
 * Deletes everything it made at the end (bench-only `allowLedgerDelete`).
 * Needs `npm run infra:up`. Refuses NODE_ENV=production.
 */
import { Types } from 'mongoose';

import { getEnv } from '../src/config/env';
import { credit, holdForCall, settleCall } from '../src/core/billing/engine';
import { createWallet } from '../src/core/billing/wallets';
import { AccountModel } from '../src/db/models/account.model';
import { LedgerEntryModel, type LedgerEntryDoc } from '../src/db/models/ledger-entry.model';
import { NotificationModel } from '../src/db/models/notification.model';
import { WalletModel } from '../src/db/models/wallet.model';
import { connectMongo, disconnectMongo } from '../src/db/mongo';
import { createLogger } from '../src/shared/logger';
import { formatInr } from '../src/shared/money';

const RUPEE = 1_000_000;
const BENCH_PREFIX = 'bench-';

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
};

/** Removes the throw-away account and every row it made (bench accounts only). */
const cleanup = async (accountId: Types.ObjectId): Promise<void> => {
  const account = await AccountModel.findById(accountId).lean();
  if (!account?.slug.startsWith(BENCH_PREFIX))
    throw new Error('refusing to delete a non-bench account');
  await LedgerEntryModel.deleteMany({ accountId }).setOptions({ allowLedgerDelete: true });
  await WalletModel.deleteOne({ accountId });
  await NotificationModel.deleteMany({ accountId });
  await AccountModel.deleteOne({ _id: accountId });
};

const main = async (): Promise<void> => {
  const env = getEnv();
  if (env.NODE_ENV === 'production') throw new Error('bench:wallet is disabled in production');
  const calls = Number(process.argv[2] ?? 1000);
  const workers = Number(process.argv[3] ?? 20);
  if (!Number.isSafeInteger(calls) || calls < 1 || !Number.isSafeInteger(workers) || workers < 1) {
    throw new Error('Usage: npm run bench:wallet -- [calls] [workers]');
  }
  const logger = createLogger({ ...env, LOG_LEVEL: 'warn' });
  await connectMongo(env, logger);
  const account = await AccountModel.create({
    name: 'Wallet bench',
    slug: `${BENCH_PREFIX}${Date.now()}`,
  });
  const accountId = account._id;
  try {
    await createWallet(accountId);
    await credit({
      accountId,
      type: 'adjustment',
      amountMicros: 10_000 * RUPEE,
      ref: { type: 'manual', id: 'bench' },
      idempotencyKey: 'bench:opening',
      note: 'Bench opening credit',
    });

    console.info(
      `Wallet benchmark — ${calls.toLocaleString('en-IN')} × (hold → settle), ${workers} parallel workers`,
    );
    const latencies: number[] = [];
    let next = 0;
    let failed = 0;
    const worker = async () => {
      while (next < calls) {
        const i = next;
        next += 1;
        const t0 = performance.now();
        try {
          const id = new Types.ObjectId().toString();
          const hold = await holdForCall({
            accountId,
            ref: { type: 'simulator', id },
            idempotencyKey: `bench:hold:${i}`,
          });
          const holdId = hold.entries[0]?._id;
          if (!holdId) throw new Error('no hold row');
          await settleCall({
            accountId,
            holdId,
            usage: { answered: true, durationSec: 20 + (i % 100), aiSeconds: i % 3 === 0 ? 30 : 0 },
          });
          latencies.push(performance.now() - t0);
        } catch (err) {
          failed += 1;
          logger.error({ err, i }, 'bench: call failed');
        }
      }
    };
    const started = performance.now();
    await Promise.all(Array.from({ length: workers }, worker));
    const seconds = (performance.now() - started) / 1000;

    const wallet = await WalletModel.findOne({ accountId }).lean();
    const rows = await LedgerEntryModel.find({ accountId }).lean<LedgerEntryDoc[]>();
    const captured = rows.filter((r) => r.status === 'captured');
    const ledgerBalance = captured.reduce(
      (s, r) => s + (r.direction === 'credit' ? r.amountMicros : -r.amountMicros),
      0,
    );
    const ledgerHold = rows
      .filter((r) => r.status === 'held')
      .reduce((s, r) => s + r.amountMicros, 0);
    const minBalance = Math.min(...captured.map((r) => r.balanceAfterMicros ?? 0));
    const ok =
      wallet?.balanceMicros === ledgerBalance &&
      wallet.holdMicros === ledgerHold &&
      minBalance >= 0 &&
      failed === 0;

    console.info(`  wall time                          ${seconds.toFixed(2)} s`);
    console.info(
      `  throughput                         ${(calls / seconds).toFixed(0)} calls/s (${((2 * calls) / seconds).toFixed(0)} engine ops/s)`,
    );
    console.info(
      `  per call (hold + settle)           p50 ${percentile(latencies, 50).toFixed(0)} ms · p95 ${percentile(latencies, 95).toFixed(0)} ms · p99 ${percentile(latencies, 99).toFixed(0)} ms`,
    );
    console.info(`  failed calls                       ${failed}`);
    console.info(
      `  wallet balance / Σ ledger          ${formatInr(wallet?.balanceMicros ?? 0)} / ${formatInr(ledgerBalance)}`,
    );
    console.info(
      `  wallet hold / Σ held rows          ${formatInr(wallet?.holdMicros ?? 0)} / ${formatInr(ledgerHold)}`,
    );
    console.info(`  lowest balance after a row        ${formatInr(minBalance)}`);
    console.info(`  ledger rows                        ${rows.length.toLocaleString('en-IN')}`);
    console.info(ok ? 'RESULT: OK' : 'RESULT: MISMATCH');
    if (!ok) process.exitCode = 1;
  } finally {
    await cleanup(accountId);
    await disconnectMongo();
  }
};

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
