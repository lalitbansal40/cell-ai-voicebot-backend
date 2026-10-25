/**
 * DEV ONLY — WhatsApp templates + charges for "Demo Finance" on its seeded number
 * (fake Meta): an EMI reminder (utility, approved, variables from the contact's fields),
 * an offer (marketing, approved), the call permission template (pending) and one
 * rejected template with its reason; the EMI reminder sent to the closed demo chat and
 * charged (delivered, billable). The Phase 10 demo reply was released by its free
 * statuses. Global 15 % markup, no account override. Idempotent.
 */
import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';
import type { Types } from 'mongoose';

import type { Env } from '../src/config/env';
import { secretBoxKey } from '../src/core/ai/secret-box';
import { createMetaClient, type FakeMetaClient } from '../src/core/meta';
import type { StorageProvider } from '../src/core/storage';
import { ConversationModel } from '../src/db/models/conversation.model';
import { MessageModel } from '../src/db/models/message.model';
import {
  WA_ACTIVE_STATUSES,
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../src/db/models/whatsapp-channel.model';
import {
  WhatsAppTemplateModel,
  type TemplateStatus,
} from '../src/db/models/whatsapp-template.model';
import type { InboxContext } from '../src/modules/inbox/context';
import { recordingInboxJobs } from '../src/modules/inbox/jobs';
import { sendMessage } from '../src/modules/inbox/outbound.service';
import { processSend } from '../src/modules/inbox/send.job';
import { unavailableTemplateJobs } from '../src/modules/templates/jobs';
import {
  createCallPermissionTemplate,
  createTemplate,
  setVariableSources,
  syncTemplates,
} from '../src/modules/templates/template.service';
import type { WhatsAppContext } from '../src/modules/whatsapp/context';
import { onMessageStatus } from '../src/modules/whatsapp-billing/billing-hook';
import { AppError } from '../src/shared/errors/app-error';
import type { Logger } from '../src/shared/logger';

import { SEED_INBOX_CUSTOMERS } from './seed-inbox';
import { SEED_WHATSAPP_NUMBER } from './seed-whatsapp';

export const SEED_TEMPLATE_NAMES = {
  emi: 'emi_reminder',
  offer: 'festive_offer',
  rejected: 'loan_offer_old',
} as const;

export interface TemplateSeedDeps {
  /** Tests: the fake Meta's Redis key prefix (default: the dev server's keys). */
  metaPrefix?: string;
  env: Env;
  ownerId: Types.ObjectId;
  redis: Redis;
  logger: Logger;
  storage: StorageProvider;
}

export const seedTemplates = async (
  accountId: Types.ObjectId,
  { env, ownerId, redis, logger, storage, metaPrefix }: TemplateSeedDeps,
): Promise<{ templates: number; charged: number; skipped: string | null }> => {
  if (!env.WHATSAPP_ENABLED || env.META_PROVIDER !== 'fake') {
    return { templates: 0, charged: 0, skipped: 'WhatsApp is off or uses the real Meta provider' };
  }
  const channel = await WhatsAppChannelModel.findOne({
    accountId,
    displayPhoneNumber: SEED_WHATSAPP_NUMBER,
    status: { $in: WA_ACTIVE_STATUSES },
  }).lean<WhatsAppChannelDoc>();
  if (!channel) return { templates: 0, charged: 0, skipped: 'No demo WhatsApp number' };
  if (await WhatsAppTemplateModel.exists({ accountId, name: SEED_TEMPLATE_NAMES.emi })) {
    return { templates: 0, charged: 0, skipped: null };
  }
  const quiet = { ...env, FAKE_META_STATUS_DELAYS_MS: null, FAKE_META_TEMPLATE_REVIEW_MS: null };
  const meta = createMetaClient(quiet, {
    redis,
    logger,
    ...(metaPrefix ? { prefix: metaPrefix } : {}),
  }) as FakeMetaClient;
  const ctx: WhatsAppContext = { env: quiet, meta, redis, key: secretBoxKey(env) };
  const tx = { wa: ctx, jobs: unavailableTemplateJobs, storage };
  const actor = { type: 'user' as const, id: ownerId };
  const channelId = channel._id.toString();

  /**
   * Create + submit, or adopt the template the fake already has (a dev re-seed after the
   * database was reset keeps the fake's Redis state).
   */
  const createOrAdopt = async (input: Parameters<typeof createTemplate>[3]) => {
    try {
      return (await createTemplate(tx, accountId, actor, input)).id;
    } catch (err) {
      if (!(err instanceof AppError) || err.code !== 'TEMPLATE_NAME_TAKEN') throw err;
      await syncTemplates(tx, channel._id, 'manual');
      const row = await WhatsAppTemplateModel.findOne({
        accountId,
        wabaId: channel.wabaId,
        name: input.name,
        language: input.language,
      }).lean();
      if (!row) throw err;
      return row._id.toString();
    }
  };

  /** Meta's review outcome, set on the fake and our row (no review timers in a seed). */
  const decide = async (id: string, status: TemplateStatus, reason?: string) => {
    const row = await WhatsAppTemplateModel.findById(id).lean();
    if (!row?.metaTemplateId) return;
    await meta.patchTemplate(channel.wabaId, row.metaTemplateId, {
      status,
      rejected_reason: reason ?? null,
    });
    await WhatsAppTemplateModel.updateOne(
      { _id: row._id },
      {
        $set: {
          status,
          statusReason: reason ? { reason, title: null, description: null } : null,
          lastEventAt: new Date(),
        },
        $push: {
          statusHistory: { status, reason: reason ?? null, at: new Date(), source: 'webhook' },
        },
      },
    );
  };

  const emiId = await createOrAdopt({
    channelId,
    name: SEED_TEMPLATE_NAMES.emi,
    language: 'en',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'Namaste, your EMI of {{1}} is due on {{2}}. Please pay on time to avoid charges.',
        example: { body_text: [['₹12,500.00', '05 Nov 2026']] },
      },
      { type: 'FOOTER', text: 'Demo Finance' },
    ],
  });
  await decide(emiId, 'APPROVED');
  await setVariableSources(accountId, actor, emiId, [
    { key: '1', kind: 'field', value: 'emi_amount' },
    { key: '2', kind: 'field', value: 'due_date' },
  ]);
  const offerId = await createOrAdopt({
    channelId,
    name: SEED_TEMPLATE_NAMES.offer,
    language: 'en',
    category: 'MARKETING',
    components: [
      {
        type: 'BODY',
        text: 'Festive offer: top-up loans at a special rate for you, {{1}}. Reply YES to know more.',
        example: { body_text: [['Asha']] },
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'YES' },
          { type: 'QUICK_REPLY', text: 'Not now' },
        ],
      },
    ],
  });
  await decide(offerId, 'APPROVED');
  await setVariableSources(accountId, actor, offerId, [{ key: '1', kind: 'contact.name' }]);
  try {
    await createCallPermissionTemplate(tx, accountId, actor, { channelId });
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== 'TEMPLATE_NAME_TAKEN') throw err;
    await syncTemplates(tx, channel._id, 'manual');
  }
  const rejectedId = await createOrAdopt({
    channelId,
    name: SEED_TEMPLATE_NAMES.rejected,
    language: 'en',
    category: 'MARKETING',
    components: [
      {
        type: 'BODY',
        text: 'Get a loan in 5 minutes, {{1}}! No documents needed.',
        example: { body_text: [['Asha']] },
      },
    ],
  });
  await decide(rejectedId, 'REJECTED', 'PROMOTIONAL');

  // the EMI reminder to the closed demo chat (window closed: only a template can go)
  let charged = 0;
  const conv = await ConversationModel.findOne({
    channelId: channel._id,
    waId: SEED_INBOX_CUSTOMERS.closed.replace(/\D/g, ''),
  }).lean();
  if (conv) {
    const jobs = recordingInboxJobs();
    const ix: InboxContext = { wa: ctx, storage, jobs };
    const { message } = await sendMessage(ix, { accountId, userId: ownerId }, conv._id.toString(), {
      clientId: randomUUID(),
      type: 'template',
      templateId: emiId,
      variables: { '1': '₹12,500.00', '2': '05 Nov 2026' },
    });
    for (const job of jobs.sent.splice(0)) {
      await processSend(ix, job.id, { finalAttempt: true, waits: 20 });
    }
    await MessageModel.updateOne({ _id: message._id }, { $set: { status: 'delivered' } });
    const outcome = await onMessageStatus({
      accountId,
      messageId: message._id,
      status: 'delivered',
      pricing: {
        billable: true,
        model: 'PMP',
        category: 'utility',
        type: 'regular',
        subtype: null,
        conversationId: null,
        conversationOrigin: null,
      },
    });
    if (outcome === 'captured') charged = 1;
  }
  return {
    templates: await WhatsAppTemplateModel.countDocuments({
      accountId,
      status: { $ne: 'DELETED' },
    }),
    charged,
    skipped: null,
  };
};
