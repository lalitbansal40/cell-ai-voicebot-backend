/**
 * DEV ONLY — the WhatsApp inbox end to end on the dev database / Redis with the fake
 * Meta provider (`npm run dev:inbox [-- --account <slug>]`): connects a fake number,
 * signs and POSTs ten customer messages of different types to the HTTP handler of a
 * locally started app (text, image, voice note, document, location, contact card,
 * button reply, reaction, STOP, START), sends six replies through the inbox service
 * (text, image, browser voice note, buttons, list, reaction), runs the `whatsapp`
 * worker until the queue is idle, waits for the fake's auto statuses, runs the
 * retention job once and prints counts. Refuses production and the real Meta
 * provider. Prints ids and counts only — never texts, phones, names or tokens.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

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
import { createStorage } from '../src/core/storage';
import { AccountModel } from '../src/db/models/account.model';
import { ConversationModel } from '../src/db/models/conversation.model';
import { MessageModel, type MessageDoc } from '../src/db/models/message.model';
import { UserModel } from '../src/db/models/user.model';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../src/db/models/whatsapp-channel.model';
import { connectMongo, disconnectMongo } from '../src/db/mongo';
import type { InboxContext } from '../src/modules/inbox/context';
import { queueInboxJobs } from '../src/modules/inbox/jobs';
import { sendMessage } from '../src/modules/inbox/outbound.service';
import { runInboxRetention } from '../src/modules/inbox/retention.job';
import { createUpload } from '../src/modules/inbox/upload.service';
import type { WhatsAppContext } from '../src/modules/whatsapp/context';
import { connectFakeStatusWebhooks } from '../src/modules/whatsapp/fake-statuses';
import { queueWhatsAppJobs } from '../src/modules/whatsapp/jobs';
import { createWhatsAppService } from '../src/modules/whatsapp/whatsapp.service';
import { createLogger } from '../src/shared/logger';
import { buildWebm } from '../tests/helpers/webm';

const env = loadEnv();
if (env.NODE_ENV === 'production') {
  console.error('dev:inbox refuses to run in production');
  process.exit(1);
}
if (env.META_PROVIDER !== 'fake' || !env.WHATSAPP_ENABLED) {
  console.error('dev:inbox needs WHATSAPP_ENABLED=true and META_PROVIDER=fake');
  process.exit(1);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const MEDIA = join(__dirname, '../tests/fixtures/meta/media');
const media = (name: string) => readFileSync(join(MEDIA, name));
const CUSTOMER = '919001020030';
let seq = 0;
const wamid = () => `wamid.DEVINBOX${Date.now().toString(36)}${String((seq += 1))}`;

const payload = (channel: WhatsAppChannelDoc, message: Record<string, unknown>) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: channel.wabaId,
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: {
              display_phone_number: (channel.displayPhoneNumber ?? '').replace(/\D/g, ''),
              phone_number_id: channel.phoneNumberId,
            },
            contacts: [{ profile: { name: 'Dev Customer' }, wa_id: CUSTOMER }],
            messages: [
              {
                from: CUSTOMER,
                id: wamid(),
                timestamp: String(Math.floor(Date.now() / 1000)),
                ...message,
              },
            ],
          },
        },
      ],
    },
  ],
});

const main = async () => {
  const logger = createLogger({ ...env, LOG_LEVEL: 'warn' });
  const step = (msg: string) => console.error(`dev:inbox — ${msg}`);
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
  if (!account)
    throw new Error(
      slug ? `No active account "${slug}"` : 'No customer account — run npm run db:seed',
    );
  const owner = await UserModel.findOne({ accountId: account._id, status: 'active' }).lean();
  if (!owner) throw new Error('No active user in that account');

  const meta = createMetaClient(env, { redis, logger }) as FakeMetaClient;
  const ctx: WhatsAppContext = { env, meta, redis, key: secretBoxKey(env) };
  const svc = createWhatsAppService(ctx);
  const signup = {
    businessName: 'Dev Inbox Co',
    phone: '+91 90010 10030',
    mode: 'cloud_api' as const,
  };
  const connected = await svc.connect({
    accountId: account._id,
    actor: { type: 'user', id: owner._id },
    mode: signup.mode,
    code: buildFakeCode({ ...signup, displayName: signup.businessName, outcome: 'finish' }),
  });
  const channel = await WhatsAppChannelModel.findById(
    connected.channel.id,
  ).lean<WhatsAppChannelDoc>();
  if (!channel) throw new Error('channel missing');
  step(`channel ${channel._id.toString()}: ${connected.outcome}`);

  const queue = createQueue(QUEUES.whatsapp, { redisUrl: env.REDIS_URL, logger });
  const jobs = queueWhatsAppJobs(queue);
  const stopStatuses = connectFakeStatusWebhooks({ ctx, jobs });
  const app = createApp({ env, logger, whatsapp: { ctx, jobs } });
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1/webhooks/meta`;
  const { worker } = await startWhatsAppWorker({ redisUrl: env.REDIS_URL, logger, ctx, storage });
  const ix: InboxContext = { wa: ctx, storage, jobs: queueInboxJobs(queue) };

  // idle = nothing waiting / running and no delayed job except the daily health scheduler
  const idle = async () => {
    for (let i = 0; i < 300; i += 1) {
      const counts = await queue.getJobCounts('waiting', 'active');
      const delayed = (await queue.getDelayed()).filter((j) => j.name !== 'whatsapp-health');
      if (Object.values(counts).every((n) => n === 0) && !delayed.length) return;
      await sleep(100);
    }
  };
  const post = async (kind: string, message: Record<string, unknown>) => {
    const body = JSON.stringify(payload(channel, message));
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signWebhook(body, metaAppSecret(env)),
      },
      body,
    });
    step(`customer ${kind} → HTTP ${String(res.status)}`);
  };

  const image = await meta.putMedia(media('sample.jpg'), 'image/jpeg');
  const voice = await meta.putMedia(media('sample.ogg'), 'audio/ogg');
  const pdf = await meta.putMedia(media('sample.pdf'), 'application/pdf', 'dev.pdf');
  await post('text', { type: 'text', text: { body: 'Dev hello' } });
  await post('image', {
    type: 'image',
    image: { id: image, mime_type: 'image/jpeg', caption: 'Dev photo' },
  });
  await post('voice', {
    type: 'audio',
    audio: { id: voice, mime_type: 'audio/ogg; codecs=opus', voice: true },
  });
  await post('document', {
    type: 'document',
    document: { id: pdf, mime_type: 'application/pdf', filename: 'dev.pdf' },
  });
  await post('location', {
    type: 'location',
    location: { latitude: 26.9, longitude: 75.8, name: 'Dev office' },
  });
  await post('contacts', {
    type: 'contacts',
    contacts: [{ name: { formatted_name: 'Dev Friend' }, phones: [{ phone: '+91 90010 20031' }] }],
  });
  await post('button reply', {
    type: 'interactive',
    interactive: { type: 'button_reply', button_reply: { id: 'yes', title: 'Yes' } },
  });
  await idle();
  const first = await MessageModel.findOne({ channelId: channel._id, direction: 'in' })
    .sort({ at: 1 })
    .lean<MessageDoc>();
  await post('reaction', {
    type: 'reaction',
    reaction: { message_id: first?.waMessageId ?? '', emoji: '👍' },
  });
  await post('STOP', { type: 'text', text: { body: 'STOP' } });
  await sleep(1100); // a later second: keywords apply in message-time order
  await post('START', { type: 'text', text: { body: 'START' } });
  await idle();

  const conversation = await ConversationModel.findOne({
    channelId: channel._id,
    waId: CUSTOMER,
  }).lean();
  if (!conversation) throw new Error('conversation missing');
  const actor = { accountId: account._id, userId: owner._id };
  const send = (input: Record<string, unknown>) =>
    sendMessage(ix, actor, conversation._id.toString(), {
      clientId: randomUUID(),
      ...input,
    } as never);
  const img = await createUpload(ix, {
    ...actor,
    kind: 'image',
    bytes: media('sample.jpg'),
    declaredMime: 'image/jpeg',
  });
  const rec = await createUpload(ix, { ...actor, kind: 'voice', bytes: buildWebm() });
  await send({ type: 'text', text: 'Dev reply' });
  await send({ type: 'image', mediaToken: img._id.toString(), caption: 'Dev image reply' });
  await send({ type: 'voice', mediaToken: rec._id.toString() });
  await send({
    type: 'buttons',
    body: 'Pay today?',
    buttons: [
      { id: 'y', title: 'Yes' },
      { id: 'n', title: 'No' },
    ],
  });
  await send({
    type: 'list',
    body: 'Pick a plan',
    button: 'Plans',
    sections: [{ rows: [{ id: 'p1', title: 'Plan 1' }] }],
  });
  await send({ type: 'reaction', messageId: first?._id.toString() ?? '', emoji: '🙏' });
  await idle();
  const delays = env.FAKE_META_STATUS_DELAYS_MS ?? [0, 0, 0];
  await sleep(Math.max(...delays) + 500);
  await idle();
  const retention = await runInboxRetention(storage, env.INBOX_RETENTION_DAYS);

  const group = (field: string) =>
    MessageModel.aggregate<{ _id: string; n: number }>([
      { $match: { channelId: channel._id } },
      { $group: { _id: `$${field}`, n: { $sum: 1 } } },
    ]);
  const conv = await ConversationModel.findById(conversation._id).lean();
  const sent = await meta.sentMessages(channel.phoneNumberId ?? '');
  console.log(
    JSON.stringify(
      {
        accountId: account._id.toString(),
        conversationId: conversation._id.toString(),
        messagesByType: Object.fromEntries((await group('type')).map((g) => [g._id, g.n])),
        messagesByStatus: Object.fromEntries((await group('status')).map((g) => [g._id, g.n])),
        mediaReady: await MessageModel.countDocuments({
          channelId: channel._id,
          'media.status': 'ready',
        }),
        unread: conv?.unreadCount ?? 0,
        fakeMetaSends: sent.length,
        voiceNotesValid: sent.filter((s) => s.voiceValid).length,
        retention,
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
  console.error('dev:inbox failed:', (err as Error).message);
  await closeAllRedis().catch(() => undefined);
  await disconnectMongo().catch(() => undefined);
  process.exit(1);
});
