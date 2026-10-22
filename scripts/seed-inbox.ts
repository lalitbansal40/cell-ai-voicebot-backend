/**
 * DEV ONLY — demo WhatsApp chats for "Demo Finance" on its seeded number, through the
 * real pipeline (simulated, signed webhooks → receiver → processor with the inbox
 * hooks; replies through the inbox service and the send job): a text chat with an
 * agent reply that reaches "read", a media chat (photo, voice note, document), a
 * closed chat, an echo from the WhatsApp Business app and a customer who sent STOP.
 * Idempotent: skipped when the number already has conversations.
 */
import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';
import type { Types } from 'mongoose';

import type { Env } from '../src/config/env';
import { secretBoxKey } from '../src/core/ai/secret-box';
import { createMetaClient, metaAppSecret, signWebhook } from '../src/core/meta';
import type { StorageProvider } from '../src/core/storage';
import { ConversationModel } from '../src/db/models/conversation.model';
import { MessageModel } from '../src/db/models/message.model';
import {
  WA_ACTIVE_STATUSES,
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../src/db/models/whatsapp-channel.model';
import { runInboxBackfill } from '../src/modules/inbox/backfill.job';
import type { InboxContext } from '../src/modules/inbox/context';
import { createInboxHooks } from '../src/modules/inbox/hooks';
import { INBOX_JOBS, recordingInboxJobs } from '../src/modules/inbox/jobs';
import { downloadInboundMedia } from '../src/modules/inbox/media.service';
import { sendMessage } from '../src/modules/inbox/outbound.service';
import { processSend } from '../src/modules/inbox/send.job';
import { runInboxSimulator, type InboxSimulatorKind } from '../src/modules/inbox/simulator';
import type { WhatsAppContext } from '../src/modules/whatsapp/context';
import { buildSimulatorPayload } from '../src/modules/whatsapp/simulator';
import { processWebhookEvent } from '../src/modules/whatsapp/webhook-processor';
import { receiveWebhook } from '../src/modules/whatsapp/webhooks.service';
import { createWhatsAppService } from '../src/modules/whatsapp/whatsapp.service';
import type { Logger } from '../src/shared/logger';

import { SEED_WHATSAPP_NUMBER } from './seed-whatsapp';

export const SEED_INBOX_CUSTOMERS = {
  text: '+91 90000 77001',
  media: '+91 90000 77002',
  closed: '+91 90000 77003',
  stop: '+91 90000 77004',
} as const;

export interface InboxSeedDeps {
  env: Env;
  ownerId: Types.ObjectId;
  redis: Redis;
  logger: Logger;
  storage: StorageProvider;
}

export const seedInbox = async (
  accountId: Types.ObjectId,
  { env, ownerId, redis, logger, storage }: InboxSeedDeps,
): Promise<{ conversations: number; messages: number; skipped: string | null }> => {
  if (!env.WHATSAPP_ENABLED || env.META_PROVIDER !== 'fake') {
    return {
      conversations: 0,
      messages: 0,
      skipped: 'WhatsApp is off or uses the real Meta provider',
    };
  }
  const channel = await WhatsAppChannelModel.findOne({
    accountId,
    displayPhoneNumber: SEED_WHATSAPP_NUMBER,
    status: { $in: WA_ACTIVE_STATUSES },
  }).lean<WhatsAppChannelDoc>();
  if (!channel) return { conversations: 0, messages: 0, skipped: 'No demo WhatsApp number' };
  if (
    await ConversationModel.exists({
      channelId: channel._id,
      waId: SEED_INBOX_CUSTOMERS.text.replace(/\D/g, ''),
    })
  ) {
    return { conversations: 0, messages: 0, skipped: null };
  }

  const ctx: WhatsAppContext = {
    env: { ...env, FAKE_META_STATUS_DELAYS_MS: null },
    meta: createMetaClient({ ...env, FAKE_META_STATUS_DELAYS_MS: null }, { redis, logger }),
    redis,
    key: secretBoxKey(env),
  };
  const jobs = recordingInboxJobs();
  const ix: InboxContext = { wa: ctx, storage, jobs };
  const h = { ctx, service: createWhatsAppService(ctx), inbox: createInboxHooks(ix) };
  const queued: string[] = [];
  const waJobs = { enqueueEvent: (id: string) => (queued.push(id), Promise.resolve()) };

  /** Processes stored events, then the inbox jobs they queued (downloads, sends), until idle. */
  const drain = async () => {
    for (let round = 0; round < 10 && (queued.length || jobs.sent.length); round += 1) {
      for (const id of queued.splice(0)) await processWebhookEvent(h, id, { finalAttempt: true });
      for (const job of jobs.sent.splice(0)) {
        if (job.name === INBOX_JOBS.mediaDownload)
          await downloadInboundMedia(ix, job.id, { finalAttempt: true });
        if (job.name === INBOX_JOBS.messageSend)
          await processSend(ix, job.id, { finalAttempt: true, waits: 20 });
      }
    }
  };
  const customer = async (kind: InboxSimulatorKind, from: string, text?: string) => {
    await runInboxSimulator({ ctx, jobs: waJobs, storage }, channel._id, kind, { from, text });
    await drain();
  };
  const conversationOf = (from: string) =>
    ConversationModel.findOne({ channelId: channel._id, waId: from.replace(/\D/g, '') }).lean();
  const statusWebhook = async (wamid: string, to: string, status: string) => {
    const payload = {
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
                statuses: [
                  {
                    id: wamid,
                    status,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    recipient_id: to,
                    pricing: { billable: false, pricing_model: 'PMP', category: 'service' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const raw = Buffer.from(JSON.stringify(payload));
    await receiveWebhook(ctx, waJobs, raw, signWebhook(raw, metaAppSecret(env)));
    await drain();
  };

  // events the WhatsApp seed stored before the inbox existed
  await runInboxBackfill(ix);

  // 1. text chat + an agent reply that reaches "read"
  await customer('inbound_text', SEED_INBOX_CUSTOMERS.text, 'Namaste, meri EMI ki date kya hai?');
  const textConv = await conversationOf(SEED_INBOX_CUSTOMERS.text);
  if (textConv) {
    const { message } = await sendMessage(
      ix,
      { accountId, userId: ownerId },
      textConv._id.toString(),
      {
        clientId: randomUUID(),
        type: 'text',
        text: 'Aapki EMI 5 tareekh ko due hai. Payment link chahiye?',
      },
    );
    await drain();
    const sent = await MessageModel.findById(message._id).lean();
    for (const status of ['sent', 'delivered', 'read']) {
      if (sent?.waMessageId) await statusWebhook(sent.waMessageId, textConv.waId, status);
    }
    await customer('inbound_reply', SEED_INBOX_CUSTOMERS.text, 'Haan, bhej dijiye');
  }
  // 2. media chat
  await customer('inbound_image', SEED_INBOX_CUSTOMERS.media, 'Payment ka screenshot');
  await customer('inbound_voice', SEED_INBOX_CUSTOMERS.media);
  await customer('inbound_document', SEED_INBOX_CUSTOMERS.media);
  // 3. a closed chat
  await customer('inbound_text', SEED_INBOX_CUSTOMERS.closed, 'Thank you, ho gaya');
  await ConversationModel.updateOne(
    { channelId: channel._id, waId: SEED_INBOX_CUSTOMERS.closed.replace(/\D/g, '') },
    { $set: { status: 'closed', closedAt: new Date(), closedBy: ownerId, unreadCount: 0 } },
  );
  // 4. an echo from the business phone + a customer who opted out
  const echo = buildSimulatorPayload('echo_text', channel);
  const raw = Buffer.from(JSON.stringify(echo));
  await receiveWebhook(ctx, waJobs, raw, signWebhook(raw, metaAppSecret(env)));
  await drain();
  await customer('inbound_stop', SEED_INBOX_CUSTOMERS.stop);

  return {
    conversations: await ConversationModel.countDocuments({ channelId: channel._id }),
    messages: await MessageModel.countDocuments({ channelId: channel._id }),
    skipped: null,
  };
};
