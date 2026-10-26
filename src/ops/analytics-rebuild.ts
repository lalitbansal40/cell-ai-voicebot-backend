/**
 * `npm run analytics:rebuild -- [--account <id>] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--dry-run]`
 * (image: `node dist/ops/analytics-rebuild.js`): recounts report rollups from raw rows.
 * Default: every account, the last `REPORT_LIMITS.reconcileDays` days. Prints counts only.
 */
import { Types } from 'mongoose';

import '../db/models/all';
import { getEnv } from '../config/env';
import { REPORT_LIMITS } from '../config/limits';
import { closeAllRedis, getAppRedis } from '../core/queues/redis';
import { AccountModel } from '../db/models/account.model';
import { connectMongo, disconnectMongo } from '../db/mongo';
import { rawFloor, rebuildAccount } from '../modules/analytics/rebuild';
import { withAnalyticsLock } from '../modules/analytics/sweep';
import { getLogger } from '../shared/logger';
import { addDays, ymdInZone } from '../shared/time';

import { runOp, say, type OpMain } from './cli';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface RebuildArgs {
  accountId: Types.ObjectId | null;
  from: string | null;
  to: string | null;
  dryRun: boolean;
}

export const parseRebuildArgs = (args: string[]): RebuildArgs => {
  const out: RebuildArgs = { accountId: null, from: null, to: null, dryRun: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const value = args[i + 1];
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--account' && value && Types.ObjectId.isValid(value)) {
      out.accountId = new Types.ObjectId(value);
      i += 1;
    } else if ((arg === '--from' || arg === '--to') && value && DAY.test(value)) {
      out[arg === '--from' ? 'from' : 'to'] = value;
      i += 1;
    } else
      throw new Error(
        'Usage: analytics:rebuild [--account <id>] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--dry-run]',
      );
  }
  if (out.from && out.to && out.from > out.to) throw new Error('--from must not be after --to');
  return out;
};

export const main: OpMain = async (args) => {
  const options = parseRebuildArgs(args);
  const env = getEnv();
  const logger = getLogger();
  await connectMongo(env, logger);
  try {
    const done = await withAnalyticsLock(
      { redis: getAppRedis(env.REDIS_URL, logger) },
      async () => {
        const accounts = await AccountModel.find(
          options.accountId ? { _id: options.accountId } : {},
        )
          .select({ timezone: 1 })
          .lean<{ _id: Types.ObjectId; timezone?: string }[]>();
        let rows = 0;
        let differences = 0;
        const now = new Date();
        for (const a of accounts) {
          const tz = a.timezone ?? 'Asia/Kolkata';
          const to = options.to ?? ymdInZone(now, tz);
          const r = await rebuildAccount({
            accountId: a._id,
            from: options.from ?? addDays(to, -(REPORT_LIMITS.reconcileDays - 1)),
            to,
            dryRun: options.dryRun,
            floor: rawFloor(now, tz, {
              callsDays: env.CALL_RETENTION_DAYS,
              inboxDays: env.INBOX_RETENTION_DAYS,
            }),
          });
          rows += r.rows;
          differences += r.differences;
        }
        say(
          `Analytics ${options.dryRun ? 'check' : 'rebuild'}: ${String(accounts.length)} account(s), ${String(rows)} rollup rows, ${String(differences)} difference(s)${options.dryRun || !differences ? '' : ' fixed'}`,
        );
      },
    );
    if (done === null)
      throw new Error('Another analytics writer is running; try again in a minute');
  } finally {
    await closeAllRedis();
    await disconnectMongo();
  }
};

if (require.main === module) runOp(main);
