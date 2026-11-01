/**
 * DEV ONLY — account export memory check (Phase 16).
 *   npm run bench:account-export            (default 100,000 contacts)
 * Works only in `cav_perf`, refuses NODE_ENV=production, drops its account at the end and
 * prints the peak RSS growth. A flat result means the zip is streamed, not buffered.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import mongoose, { Types } from 'mongoose';

import { getEnv } from '../src/config/env';
import { LocalStorage, signingKey } from '../src/core/storage';
import { AccountExportModel } from '../src/db/models/account-export.model';
import { connectMongo, disconnectMongo } from '../src/db/mongo';
import { runAccountExport } from '../src/modules/privacy/account-export.job';
import { getLogger } from '../src/shared/logger';

import { perfUri } from './perf-reports';

const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);

const main = async () => {
  const env = getEnv();
  if (env.NODE_ENV === 'production') throw new Error('Refusing to run in production');
  const total = Number(process.argv[2] ?? 100_000);
  await connectMongo({ ...env, MONGODB_URI: perfUri(env.MONGODB_URI) }, getLogger());
  const accountId = new Types.ObjectId();
  const dir = mkdtempSync(path.join(tmpdir(), 'cav-export-bench-'));
  const db = mongoose.connection.db as NonNullable<typeof mongoose.connection.db>;
  if (db.databaseName !== 'cav_perf') throw new Error('Refusing: not the cav_perf database');
  const contacts = db.collection('contacts');
  try {
    for (let i = 0; i < total; i += 5000) {
      await contacts.insertMany(
        Array.from({ length: Math.min(5000, total - i) }, (_v, n) => ({
          accountId,
          phoneE164: `+9198${String(i + n).padStart(8, '0')}`,
          name: `Bench ${String(i + n)}`,
          tags: ['bench'],
          variables: { branch: 'Pune', amount: i + n },
          deletedAt: null,
        })),
      );
    }
    const job = await AccountExportModel.create({ accountId, requestedBy: new Types.ObjectId() });
    const storage = new LocalStorage(dir, env.APP_URL, signingKey(env));
    global.gc?.();
    const before = process.memoryUsage().rss;
    let peak = before;
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 100);
    const started = Date.now();
    await runAccountExport(
      { accountId: accountId.toString(), accountExportId: job._id.toString() },
      { storage },
    ).catch((err: unknown) => {
      // the e-mail needs a running server; the archive is already saved by then
      if (!(err instanceof Error) || !err.message.includes('Email service')) throw err;
    });
    clearInterval(timer);
    const row = await AccountExportModel.findById(job._id).lean();
    process.stdout.write(
      `Export of ${String(total)} contacts: ${String(Math.round((Date.now() - started) / 1000))} s, ` +
        `${String(mb(row?.sizeBytes ?? 0))} MB file, RSS ${String(mb(before))} → peak ${String(mb(peak))} MB ` +
        `(+${String(mb(peak - before))} MB), status ${String(row?.status)}\n`,
    );
  } finally {
    await contacts.deleteMany({ accountId });
    await AccountExportModel.deleteMany({ accountId });
    rmSync(dir, { recursive: true, force: true });
    await disconnectMongo();
  }
};

void main();
