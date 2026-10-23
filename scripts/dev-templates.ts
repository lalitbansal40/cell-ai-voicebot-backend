/**
 * DEV ONLY — WhatsApp templates + message charges end to end on the dev database / Redis
 * with the fake Meta provider (`npm run dev:templates [-- --account <slug>]`): connects a
 * fake number, creates and approves a template, sends it to a customer whose window is
 * closed, one service reply and one template to the undeliverable `…00009` number, lets
 * the fake's status webhooks run through the real receiver + worker (billing hook), and
 * prints counts and the wallet before / after (numbers only). Refuses production and the
 * real Meta provider. Never prints texts, phones, names or tokens.
 *
 * Sends go through the inbox `sendMessage` pipeline (rules → price → hold → message →
 * `message.send` job) like the API.
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Types } from 'mongoose';

import { createApp } from '../src/app';
import { loadEnv } from '../src/config/env';
import { secretBoxKey } from '../src/core/ai/secret-box';
import { credit } from '../src/core/billing/engine';
import { buildFakeCode, createMetaClient, type FakeMetaClient } from '../src/core/meta';
import { QUEUES } from '../src/core/queues/names';
import { closeAllQueues, createQueue } from '../src/core/queues/queue-factory';
import { closeAllRedis, getAppRedis } from '../src/core/queues/redis';
import { startWhatsAppWorker } from '../src/core/queues/workers/whatsapp.worker';
import { createStorage } from '../src/core/storage';
import { AccountModel } from '../src/db/models/account.model';
import { LedgerEntryModel } from '../src/db/models/ledger-entry.model';
import { MessageModel } from '../src/db/models/message.model';
import { UserModel } from '../src/db/models/user.model';
import { WalletModel } from '../src/db/models/wallet.model';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../src/db/models/whatsapp-channel.model';
import { connectMongo, disconnectMongo } from '../src/db/mongo';
import { findOrCreateWhatsAppContact } from '../src/modules/inbox/contacts';
import type { InboxContext } from '../src/modules/inbox/context';
import { upsertConversation } from '../src/modules/inbox/conversation-store';
import { queueInboxJobs } from '../src/modules/inbox/jobs';
import { sendMessage } from '../src/modules/inbox/outbound.service';
import { queueTemplateJobs } from '../src/modules/templates/jobs';
import { createTemplate } from '../src/modules/templates/template.service';
import type { WhatsAppContext } from '../src/modules/whatsapp/context';
import { connectFakeStatusWebhooks } from '../src/modules/whatsapp/fake-statuses';
import { queueWhatsAppJobs } from '../src/modules/whatsapp/jobs';
import { createWhatsAppService } from '../src/modules/whatsapp/whatsapp.service';
import { createWhatsAppBillingHook } from '../src/modules/whatsapp-billing/billing-hook';
import { createLogger } from '../src/shared/logger';

const env = loadEnv();
if (env.NODE_ENV === 'production') {
  console.error('dev:templates refuses to run in production');
  process.exit(1);
}
if (env.META_PROVIDER !== 'fake' || !env.WHATSAPP_ENABLED) {
  console.error('dev:templates needs WHATSAPP_ENABLED=true and META_PROVIDER=fake');
  process.exit(1);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

const main = async () => {
  const logger = createLogger({ ...env, LOG_LEVEL: 'warn' });
  const step = (msg: string) => console.error(`dev:templates — ${msg}`);
  await connectMongo(env, logger);
  const redis = getAppRedis(env.REDIS_URL, logger);
  const storage = createStorage(env, logger);

  const slug = arg('account');
  const account = await AccountModel.findOne({
    isPlatform: { $ne: true },
    status: 'active',
    ...(slug ? { slug } : {}),
  })
    .sort({ createdAt: 1 })
    .lean<{ _id: Types.ObjectId }>();
  if (!account) {
    throw new Error(
      slug ? `No active account "${slug}"` : 'No customer account — run npm run db:seed',
    );
  }
  const owner = await UserModel.findOne({ accountId: account._id, status: 'active' }).lean();
  if (!owner) throw new Error('No active user in that account');
  const actor = { type: 'user' as const, id: owner._id };

  const meta = createMetaClient(env, { redis, logger }) as FakeMetaClient;
  const ctx: WhatsAppContext = { env, meta, redis, key: secretBoxKey(env) };
  const connected = await createWhatsAppService(ctx).connect({
    accountId: account._id,
    actor,
    mode: 'cloud_api',
    code: buildFakeCode({
      businessName: 'Dev Templates Co',
      phone: '+91 90010 10040',
      displayName: 'Dev Templates Co',
      mode: 'cloud_api',
      outcome: 'finish',
    }),
  });
  const channel = await WhatsAppChannelModel.findById(connected.channel.id)
    .select('+tokenSealed')
    .lean<WhatsAppChannelDoc>();
  if (!channel?.phoneNumberId) throw new Error('channel missing');
  step(`channel ${channel._id.toString()}: ${connected.outcome}`);

  const queue = createQueue(QUEUES.whatsapp, { redisUrl: env.REDIS_URL, logger });
  const jobs = queueWhatsAppJobs(queue);
  const stopStatuses = connectFakeStatusWebhooks({ ctx, jobs });
  const app = createApp({ env, logger, whatsapp: { ctx, jobs } });
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  step(`receiver on port ${String((server.address() as AddressInfo).port)}`);
  const { worker } = await startWhatsAppWorker({ redisUrl: env.REDIS_URL, logger, ctx, storage });

  // dev money so the holds succeed (once per run, idempotent key)
  const runId = Date.now().toString(36);
  await credit({
    accountId: account._id,
    type: 'adjustment',
    amountMicros: 10_000_000,
    ref: { type: 'manual', id: `dev-templates-${runId}` },
    idempotencyKey: `dev-templates-${runId}`,
    note: 'dev:templates test money',
  });
  const walletOf = async () => {
    const w = await WalletModel.findOne({ accountId: account._id }).lean();
    return { balanceMicros: w?.balanceMicros ?? 0, holdMicros: w?.holdMicros ?? 0 };
  };
  const before = await walletOf();
  const started = new Date();

  const tx = { wa: ctx, jobs: queueTemplateJobs(queue), storage };
  const template = await createTemplate(tx, account._id, actor, {
    channelId: channel._id.toString(),
    name: `dev_order_${runId}_instant`,
    language: 'en',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'Hi {{1}}, your order is on its way.',
        example: { body_text: [['Asha']] },
      },
    ],
  });
  step(`template ${template.id}: ${template.status}`);

  const ix: InboxContext = {
    wa: ctx,
    storage,
    jobs: queueInboxJobs(queue),
    billing: createWhatsAppBillingHook(),
  };
  const sendActor = { accountId: account._id, userId: owner._id };
  /** A conversation for `waId`; `open` = the customer wrote just now (service window). */
  const conversationFor = async (waId: string, open: boolean) => {
    const contact = await findOrCreateWhatsAppContact({ accountId: account._id, waId });
    const conv = await upsertConversation({
      key: { accountId: account._id, channelId: channel._id, waId },
      contactId: contact._id,
      source: 'outbound',
      ...(open ? { inbound: { at: new Date(), countUnread: false } } : {}),
    });
    return conv._id.toString();
  };
  const sendTemplate = async (waId: string) =>
    sendMessage(ix, sendActor, await conversationFor(waId, false), {
      clientId: randomUUID(),
      type: 'template',
      templateId: template.id,
      variables: { '1': 'Dev Customer' },
    });
  await sendTemplate('919001020041'); // window closed: only a template can go
  await sendMessage(ix, sendActor, await conversationFor('919001020042', true), {
    clientId: randomUUID(),
    type: 'text',
    text: 'Dev reply',
  });
  await sendTemplate('919001000009'); // fake: sent, then failed (undeliverable)

  // fake statuses → receiver → worker → billing hook
  const delays = env.FAKE_META_STATUS_DELAYS_MS ?? [0, 0, 0];
  await sleep(Math.max(...delays) + 1500);
  for (let i = 0; i < 100; i += 1) {
    const counts = await queue.getJobCounts('waiting', 'active');
    if (Object.values(counts).every((x) => x === 0)) break;
    await sleep(100);
  }

  const billing = await MessageModel.aggregate<{ _id: string; n: number }>([
    { $match: { channelId: channel._id, billing: { $ne: null }, createdAt: { $gte: started } } },
    { $group: { _id: '$billing.status', n: { $sum: 1 } } },
  ]);
  const ledger = await LedgerEntryModel.aggregate<{ _id: { status: string }; n: number }>([
    { $match: { accountId: account._id, type: 'whatsapp_charge', createdAt: { $gte: started } } },
    { $group: { _id: { status: '$status' }, n: { $sum: 1 } } },
  ]);
  console.log(
    JSON.stringify(
      {
        accountId: account._id.toString(),
        templateId: template.id,
        templateStatus: template.status,
        messagesByBillingStatus: Object.fromEntries(billing.map((b) => [b._id, b.n])),
        whatsappLedgerByStatus: Object.fromEntries(ledger.map((l) => [l._id.status, l.n])),
        walletBefore: before,
        walletAfter: await walletOf(),
      },
      null,
      2,
    ),
  );

  stopStatuses();
  await worker.close();
  await new Promise((r) => server.close(r));
  await closeAllQueues({ logger });
  await closeAllRedis();
  await disconnectMongo();
};

main().catch(async (err: unknown) => {
  console.error('dev:templates failed:', (err as Error).message);
  await closeAllRedis().catch(() => undefined);
  await disconnectMongo().catch(() => undefined);
  process.exit(1);
});
