/**
 * DEV ONLY — WhatsApp end to end on the dev database / Redis with the fake Meta
 * provider (`npm run dev:whatsapp`): connects two fake numbers to the first
 * customer account through the channel service (one Cloud API, one WhatsApp
 * Business app number), signs and POSTs five webhook events to the HTTP handler
 * of a locally started app (quality downgrade, name approved, echo, history
 * chunk, inbound text), runs the `whatsapp` worker until the queue is idle and
 * prints counts. Refuses production and the real Meta provider. Prints ids and
 * numbers only — never tokens, phones, names or texts.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Types } from 'mongoose';

import { createApp } from '../src/app';
import { loadEnv } from '../src/config/env';
import { secretBoxKey } from '../src/core/ai/secret-box';
import {
  buildFakeCode,
  createMetaClient,
  metaAppSecret,
  signWebhook,
  type FakeMetaClient,
} from '../src/core/meta';
import { QUEUES } from '../src/core/queues/names';
import { closeAllQueues, createQueue } from '../src/core/queues/queue-factory';
import { closeAllRedis, getAppRedis } from '../src/core/queues/redis';
import { startWhatsAppWorker } from '../src/core/queues/workers/whatsapp.worker';
import { AccountModel } from '../src/db/models/account.model';
import { MetaWebhookEventModel } from '../src/db/models/meta-webhook-event.model';
import { UserModel } from '../src/db/models/user.model';
import { WhatsAppChannelModel } from '../src/db/models/whatsapp-channel.model';
import { connectMongo, disconnectMongo } from '../src/db/mongo';
import type { WhatsAppContext } from '../src/modules/whatsapp/context';
import { queueWhatsAppJobs } from '../src/modules/whatsapp/jobs';
import { buildSimulatorPayload, type SimulatorKind } from '../src/modules/whatsapp/simulator';
import { createWhatsAppService } from '../src/modules/whatsapp/whatsapp.service';
import { createLogger } from '../src/shared/logger';

const env = loadEnv();
if (env.NODE_ENV === 'production') {
  console.error('dev:whatsapp refuses to run in production');
  process.exit(1);
}
if (env.META_PROVIDER !== 'fake' || !env.WHATSAPP_ENABLED) {
  console.error('dev:whatsapp needs WHATSAPP_ENABLED=true and META_PROVIDER=fake');
  process.exit(1);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const NUMBERS = [
  { businessName: 'Dev WhatsApp Co', phone: '+91 90010 10010', mode: 'cloud_api' as const },
  { businessName: 'Dev WhatsApp Shop', phone: '+91 90010 10020', mode: 'coexistence' as const },
];
const EVENTS: { kind: SimulatorKind; number: 0 | 1 }[] = [
  { kind: 'quality_downgrade', number: 0 },
  { kind: 'name_approved', number: 0 },
  { kind: 'inbound_text', number: 0 },
  { kind: 'echo_text', number: 1 },
  { kind: 'history_chunk', number: 1 },
];

const main = async () => {
  const logger = createLogger({ ...env, LOG_LEVEL: 'warn' });
  const step = (msg: string) => console.error(`dev:whatsapp — ${msg}`);
  await connectMongo(env, logger);
  const redis = getAppRedis(env.REDIS_URL, logger);

  const account = await AccountModel.findOne({ isPlatform: { $ne: true }, status: 'active' })
    .sort({ createdAt: 1 })
    .lean<{ _id: Types.ObjectId }>();
  if (!account) throw new Error('No customer account — run npm run db:seed');
  const owner = await UserModel.findOne({ accountId: account._id, status: 'active' }).lean();
  if (!owner) throw new Error('No active user in that account');

  const meta = createMetaClient(env, { redis, logger }) as FakeMetaClient;
  const ctx: WhatsAppContext = { env, meta, redis, key: secretBoxKey(env) };
  const svc = createWhatsAppService(ctx);
  const channelIds: string[] = [];
  for (const n of NUMBERS) {
    const r = await svc.connect({
      accountId: account._id,
      actor: { type: 'user', id: owner._id },
      mode: n.mode,
      code: buildFakeCode({ ...n, displayName: n.businessName, outcome: 'finish' }),
    });
    channelIds.push(r.channel.id);
    step(`channel ${r.channel.id} ${n.mode}: ${r.outcome}${r.reconnected ? ' (reconnected)' : ''}`);
  }

  const queue = createQueue(QUEUES.whatsapp, { redisUrl: env.REDIS_URL, logger });
  const app = createApp({ env, logger, whatsapp: { ctx, jobs: queueWhatsAppJobs(queue) } });
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1/webhooks/meta`;
  const { worker } = startWhatsAppWorker({ redisUrl: env.REDIS_URL, logger, ctx });

  for (const e of EVENTS) {
    const channel = await WhatsAppChannelModel.findById(channelIds[e.number]).lean();
    if (!channel) continue;
    const body = JSON.stringify(buildSimulatorPayload(e.kind, channel));
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signWebhook(body, metaAppSecret(env)),
      },
      body,
    });
    step(`posted ${e.kind} → HTTP ${String(res.status)}`);
  }

  // until the queue is idle (max 30 s)
  for (let i = 0; i < 300; i += 1) {
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed');
    if (Object.values(counts).every((n) => n === 0)) break;
    await sleep(100);
  }

  const channels = await WhatsAppChannelModel.aggregate<{ _id: string; n: number }>([
    { $match: { accountId: account._id } },
    { $group: { _id: '$status', n: { $sum: 1 } } },
  ]);
  const events = await MetaWebhookEventModel.aggregate<{
    _id: { status: string; field: string };
    n: number;
  }>([
    {
      $match: {
        channelId: {
          $in: await WhatsAppChannelModel.find({ _id: { $in: channelIds } }).distinct('_id'),
        },
      },
    },
    { $group: { _id: { status: '$status', field: '$field' }, n: { $sum: 1 } } },
  ]);
  console.log(
    JSON.stringify(
      {
        accountId: account._id.toString(),
        channelsByStatus: Object.fromEntries(channels.map((c) => [c._id, c.n])),
        eventsByStatusAndField: Object.fromEntries(
          events.map((e) => [`${e._id.status}:${e._id.field}`, e.n]),
        ),
      },
      null,
      2,
    ),
  );

  await worker.close();
  await new Promise((r) => server.close(r));
  await closeAllQueues({ logger });
  await closeAllRedis();
  await disconnectMongo();
};

main().catch(async (err: unknown) => {
  console.error('dev:whatsapp failed:', (err as Error).message);
  await closeAllRedis().catch(() => undefined);
  await disconnectMongo().catch(() => undefined);
  process.exit(1);
});
