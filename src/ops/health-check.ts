/**
 * App-side checks for healthwatch (Phase 17): `node dist/ops/health-check.js [--failed-before <n>]`.
 * Prints `failed-total <n>` and then one alert key per line; no secrets, no customer data.
 */
import type { Redis } from 'ioredis';
import type { Types } from 'mongoose';

import { getEnv } from '../config/env';
import { closeAllRedis, getAppRedis } from '../core/queues/redis';
import { UserModel } from '../db/models/user.model';
import { connectMongo, disconnectMongo } from '../db/mongo';
import { createSystemStatus } from '../modules/admin/system.service';
import { notify } from '../modules/notifications/notifications.service';
import { getLogger } from '../shared/logger';

import { runOp, say, type OpMain } from './cli';
import { failedTotal, healthIssues } from './health-rules';

export const parseFailedBefore = (args: string[]): number | null => {
  const at = args.indexOf('--failed-before');
  if (at === -1) return null;
  const n = Number(args[at + 1]);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

const SIP_TEXT: Record<string, string> = {
  'sip-ari-down': 'The app cannot reach Asterisk: phone calls are not being placed.',
  'sip-trunk-offline': 'The SIP trunk is offline: phone calls fail at the carrier.',
  'sip-audio-loss': 'Phone calls lost more than 5% of their audio over the last day.',
  // Phase 18B: WhatsApp call audio
  'wa-media-no-public-ip':
    'WhatsApp call audio is on but WA_MEDIA_PUBLIC_IP is not set: customers will hear nothing.',
  'wa-call-setup-failing': '3 or more WhatsApp calls failed to connect in the last 15 minutes.',
};

/** Phase 18: a SIP problem also rings the superadmins' bell, once an hour per problem. */
export const bellSuperadmins = async (issues: string[], redis: Redis): Promise<number> => {
  let sent = 0;
  for (const issue of issues) {
    const hour = Math.floor(Date.now() / 3_600_000);
    if ((await redis.set(`health:bell:${issue}:${String(hour)}`, '1', 'EX', 7200, 'NX')) !== 'OK')
      continue;
    const admins = await UserModel.find({ platformRole: 'superadmin', status: 'active' })
      .select({ _id: 1, accountId: 1 })
      .lean<{ _id: Types.ObjectId; accountId: Types.ObjectId }[]>();
    const platform = admins[0]?.accountId;
    if (!platform) continue;
    await notify({
      accountId: platform,
      userIds: admins.map((a) => a._id),
      type: 'sip.trunk_down',
      title: issue.startsWith('wa-') ? 'WhatsApp calling problem' : 'Phone line problem',
      body: SIP_TEXT[issue] ?? issue,
      link: '/admin/system',
    });
    sent += 1;
  }
  return sent;
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
    const issues = healthIssues({
      mongoPrimary: status.mongo.primary,
      queues: status.queues,
      failedBefore: parseFailedBefore(args),
      lastBackupAt: status.lastBackup?.ok ? status.lastBackup.at : null,
      now: new Date(),
      sip: status.sip,
      whatsappCalls: status.whatsappCalls,
      env: status.env,
    });
    for (const issue of issues) say(issue);
    await bellSuperadmins(
      issues.filter((i) => i.startsWith('sip-') || i.startsWith('wa-')),
      getAppRedis(env.REDIS_URL, logger),
    );
  } finally {
    await system.close();
    await closeAllRedis();
    await disconnectMongo();
  }
};

if (require.main === module) runOp(main);
