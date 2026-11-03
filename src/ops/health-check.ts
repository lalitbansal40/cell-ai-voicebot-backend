/**
 * App-side checks for healthwatch (Phase 17): `node dist/ops/health-check.js [--failed-before <n>]`.
 * Prints `failed-total <n>` and then one alert key per line; no secrets, no customer data.
 */
import { getEnv } from '../config/env';
import { closeAllRedis, getAppRedis } from '../core/queues/redis';
import { connectMongo, disconnectMongo } from '../db/mongo';
import { createSystemStatus } from '../modules/admin/system.service';
import { getLogger } from '../shared/logger';

import { runOp, say, type OpMain } from './cli';
import { failedTotal, healthIssues } from './health-rules';

export const parseFailedBefore = (args: string[]): number | null => {
  const at = args.indexOf('--failed-before');
  if (at === -1) return null;
  const n = Number(args[at + 1]);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

export const main: OpMain = async (args) => {
  const env = getEnv();
  const logger = getLogger();
  await connectMongo(env, logger);
  const system = createSystemStatus({
    env,
    build: { commit: env.GIT_SHA ?? 'unknown', builtAt: env.BUILT_AT ?? 'unknown' },
    redis: getAppRedis(env.REDIS_URL, logger),
  });
  try {
    const status = await system.read();
    say(`failed-total ${String(failedTotal(status.queues))}`);
    for (const issue of healthIssues({
      mongoPrimary: status.mongo.primary,
      queues: status.queues,
      failedBefore: parseFailedBefore(args),
      lastBackupAt: status.lastBackup?.ok ? status.lastBackup.at : null,
      now: new Date(),
    })) {
      say(issue);
    }
  } finally {
    await system.close();
    await closeAllRedis();
    await disconnectMongo();
  }
};

if (require.main === module) runOp(main);
