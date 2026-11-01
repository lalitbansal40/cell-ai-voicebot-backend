import type { Types } from 'mongoose';

import { getEnv } from '../../config/env';
import type { StorageProvider } from '../../core/storage';
import { AccountExportModel } from '../../db/models/account-export.model';
import { AgentPlaygroundSessionModel } from '../../db/models/agent-playground-session.model';
import { AgentToolCallModel } from '../../db/models/agent-tool-call.model';
import { CallEventModel } from '../../db/models/call-event.model';
import { CallInsightModel } from '../../db/models/call-insight.model';
import { CallModel } from '../../db/models/call.model';
import { CampaignContactModel } from '../../db/models/campaign-contact.model';
import { ContactModel } from '../../db/models/contact.model';
import { ConversationSummaryModel } from '../../db/models/conversation-summary.model';
import { ConversationModel } from '../../db/models/conversation.model';
import { DndEntryModel } from '../../db/models/dnd-entry.model';
import { ExportJobModel } from '../../db/models/export-job.model';
import { FlowRunModel } from '../../db/models/flow-run.model';
import { IdempotencyKeyModel } from '../../db/models/idempotency-key.model';
import { ImportJobModel } from '../../db/models/import-job.model';
import { InboxUploadModel } from '../../db/models/inbox-upload.model';
import { LedgerEntryModel } from '../../db/models/ledger-entry.model';
import { MessageModel } from '../../db/models/message.model';
import { MetaWebhookEventModel } from '../../db/models/meta-webhook-event.model';
import { NotificationModel } from '../../db/models/notification.model';
import { PostCallMessageModel } from '../../db/models/post-call-message.model';
import { TranscriptTurnModel } from '../../db/models/transcript-turn.model';
import { WebhookDeliveryModel } from '../../db/models/webhook-delivery.model';
import { WebhookEventModel } from '../../db/models/webhook-event.model';
import { WhatsAppCallPermissionModel } from '../../db/models/whatsapp-call-permission.model';
import { WhatsAppChannelModel } from '../../db/models/whatsapp-channel.model';
import { open, secretKeys } from '../../shared/crypto/secret-box';

/** What every store needs to find one person's rows. All queries carry `accountId`. */
export interface EraseContext {
  accountId: Types.ObjectId;
  contactId: Types.ObjectId;
  phoneE164: string;
  waId: string | null;
  name: string | null;
  callIds: Types.ObjectId[];
  conversationIds: Types.ObjectId[];
  storage: StorageProvider;
}

export type EraseAction = 'delete' | 'scrub' | 'keep' | 'none';

export interface EraseEntry {
  /** The collection name, as in `docs/security/DATA_MAP.md`. */
  store: string;
  action: EraseAction;
  /** Rows or files changed. Absent for `keep` and `none`. */
  run?: (ctx: EraseContext) => Promise<number>;
  /** Why nothing happens. */
  reason?: string;
}

export const ERASED_PHONE = 'erased';
const BATCH = 500;

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The ways a person can appear inside free text. */
const personPattern = (ctx: EraseContext): RegExp => {
  const parts = [
    ctx.contactId.toString(),
    ctx.phoneE164,
    ctx.phoneE164.replace(/^\+/, ''),
    ...(ctx.waId ? [ctx.waId] : []),
    ...(ctx.name && ctx.name.trim().length >= 3 ? [ctx.name.trim()] : []),
  ];
  return new RegExp([...new Set(parts)].map(escapeRegex).join('|'), 'i');
};

const removeFile = async (storage: StorageProvider, key: string | null | undefined) => {
  if (!key) return 0;
  try {
    await storage.delete(key);
    return 1;
  } catch {
    return 0; // already gone: erasing again stays safe
  }
};

const readText = async (storage: StorageProvider, key: string): Promise<Buffer | null> => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of await storage.get(key)) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
};

/**
 * Does this file hold the person? A compressed file can't be searched, so it counts as a yes.
 * A file holding many people is removed whole.
 */
const fileHoldsPerson = async (ctx: EraseContext, key: string): Promise<boolean> => {
  const data = await readText(ctx.storage, key);
  if (!data) return false;
  if (data.subarray(0, 2).toString('latin1') === 'PK') return true;
  return personPattern(ctx).test(data.toString('utf8'));
};

const deleted = (res: { deletedCount?: number }) => res.deletedCount ?? 0;

const eraseMessages = async (ctx: EraseContext): Promise<number> => {
  const filter = {
    accountId: ctx.accountId,
    $or: [{ conversationId: { $in: ctx.conversationIds } }, { contactId: ctx.contactId }],
  };
  let after: Types.ObjectId | null = null;
  const keys: string[] = [];
  for (;;) {
    const page: { _id: Types.ObjectId; media?: { storageKey?: string | null } | null }[] =
      await MessageModel.collection
        .find(after ? { ...filter, _id: { $gt: after } } : filter)
        .project<{ _id: Types.ObjectId; media?: { storageKey?: string | null } | null }>({
          'media.storageKey': 1,
        })
        .sort({ _id: 1 })
        .limit(BATCH)
        .toArray();
    for (const row of page) {
      const key = row.media?.storageKey;
      if (key) {
        keys.push(key);
        await removeFile(ctx.storage, key);
      }
    }
    const last = page.at(-1);
    if (!last) break;
    after = last._id;
  }
  if (keys.length) {
    const uploads = await InboxUploadModel.collection
      .find({ accountId: ctx.accountId, storageKey: { $in: keys } })
      .project<{ _id: Types.ObjectId }>({ _id: 1 })
      .toArray();
    await InboxUploadModel.collection.deleteMany({
      accountId: ctx.accountId,
      _id: { $in: uploads.map((u) => u._id) },
    });
  }
  return deleted(await MessageModel.collection.deleteMany(filter));
};

const scrubCalls = async (ctx: EraseContext): Promise<number> => {
  if (!ctx.callIds.length) return 0;
  const filter = { accountId: ctx.accountId, _id: { $in: ctx.callIds } };
  const rows = await CallModel.collection
    .find(filter)
    .project<{ recording?: { fileKey?: string; deletedAt?: Date | null } | null }>({ recording: 1 })
    .toArray();
  for (const row of rows) {
    if (row.recording && !row.recording.deletedAt) {
      await removeFile(ctx.storage, row.recording.fileKey);
    }
  }
  const res = await CallModel.collection.updateMany(filter, {
    $set: {
      to: ERASED_PHONE,
      contactId: null,
      variables: {},
      manualVariables: null,
      testPhone: null,
      outcome: {},
      recording: null,
      insights: null,
      error: null,
    },
  });
  // only the customer's side: a business number on `from` is no personal data
  await CallModel.collection.updateMany(
    { ...filter, from: { $in: [ctx.phoneE164, ctx.waId].filter(Boolean) } },
    { $set: { from: ERASED_PHONE } },
  );
  return res.modifiedCount;
};

const eraseMetaEvents = async (ctx: EraseContext): Promise<number> => {
  const channels = await WhatsAppChannelModel.collection
    .find({ accountId: ctx.accountId })
    .project<{ phoneNumberId?: string }>({ phoneNumberId: 1 })
    .toArray();
  const numbers = channels.flatMap((c) => (c.phoneNumberId ? [c.phoneNumberId] : []));
  const filter = {
    $or: [
      { accountId: ctx.accountId },
      // received before its account was known, for one of this account's numbers
      { accountId: null, phoneNumberId: { $in: numbers } },
    ],
  };
  const keys = secretKeys(getEnv());
  const digits = ctx.phoneE164.replace(/^\+/, '');
  const needles = [digits, ...(ctx.waId ? [ctx.waId] : [])];
  let after: Types.ObjectId | null = null;
  let count = 0;
  for (;;) {
    const page: { _id: Types.ObjectId; payloadSealed?: string }[] =
      await MetaWebhookEventModel.collection
        .find(after ? { ...filter, _id: { $gt: after } } : filter)
        .project<{ _id: Types.ObjectId; payloadSealed?: string }>({ payloadSealed: 1 })
        .sort({ _id: 1 })
        .limit(BATCH)
        .toArray();
    const hits: Types.ObjectId[] = [];
    for (const row of page) {
      let text = '';
      try {
        text = open(keys, row.payloadSealed ?? '');
      } catch {
        continue; // can't be read by anyone without the key; TTL removes it
      }
      if (needles.some((n) => text.includes(n))) hits.push(row._id);
    }
    if (hits.length) {
      count += deleted(await MetaWebhookEventModel.collection.deleteMany({ _id: { $in: hits } }));
    }
    const last = page.at(-1);
    if (!last) break;
    after = last._id;
  }
  return count;
};

const webhookEventFilter = (ctx: EraseContext) => ({
  accountId: ctx.accountId,
  $or: [
    { 'data.contactId': ctx.contactId.toString() },
    { 'data.phone': ctx.phoneE164 },
    { 'data.callId': { $in: ctx.callIds.map(String) } },
    { 'data.conversationId': { $in: ctx.conversationIds.map(String) } },
  ],
});

const eraseWebhooks = async (ctx: EraseContext): Promise<number> => {
  const filter = webhookEventFilter(ctx);
  const events = await WebhookEventModel.collection
    .find(filter)
    .project<{ eventId?: string; _id: Types.ObjectId }>({ eventId: 1 })
    .toArray();
  const ids = events.flatMap((e) => [e._id.toString(), ...(e.eventId ? [e.eventId] : [])]);
  if (ids.length) {
    await WebhookDeliveryModel.collection.deleteMany({
      accountId: ctx.accountId,
      eventId: { $in: ids },
    });
  }
  return deleted(await WebhookEventModel.collection.deleteMany(filter));
};

/** Stored answers that mention the person; they last 24 hours anyway. */
const eraseIdempotency = async (ctx: EraseContext): Promise<number> => {
  const pattern = personPattern(ctx);
  const rows = await IdempotencyKeyModel.collection
    .find({ accountId: ctx.accountId })
    .project<{ _id: Types.ObjectId; responseBody?: unknown }>({ responseBody: 1 })
    .toArray();
  const hits = rows.filter((r) => pattern.test(JSON.stringify(r.responseBody ?? null)));
  if (!hits.length) return 0;
  return deleted(
    await IdempotencyKeyModel.collection.deleteMany({
      accountId: ctx.accountId,
      _id: { $in: hits.map((h) => h._id) },
    }),
  );
};

const eraseNotifications = async (ctx: EraseContext): Promise<number> => {
  const pattern = personPattern(ctx);
  return deleted(
    await NotificationModel.collection.deleteMany({
      accountId: ctx.accountId,
      $or: [{ title: pattern }, { body: pattern }, { link: pattern }],
    }),
  );
};

const scrubImports = async (ctx: EraseContext): Promise<number> => {
  const rows = await ImportJobModel.collection
    .find({
      accountId: ctx.accountId,
      $or: [{ fileKey: { $ne: null } }, { errorReportKey: { $ne: null } }],
    })
    .project<{ _id: Types.ObjectId; fileKey?: string | null; errorReportKey?: string | null }>({
      fileKey: 1,
      errorReportKey: 1,
    })
    .toArray();
  let count = 0;
  for (const row of rows) {
    const set: Record<string, unknown> = {};
    for (const field of ['fileKey', 'errorReportKey'] as const) {
      const key = row[field];
      if (key && (await fileHoldsPerson(ctx, key))) {
        await removeFile(ctx.storage, key);
        set[field] = null;
      }
    }
    if (Object.keys(set).length) {
      await ImportJobModel.collection.updateOne(
        { _id: row._id, accountId: ctx.accountId },
        { $set: { ...set, filesPurgedAt: new Date() } },
      );
      count += 1;
    }
  }
  return count;
};

const scrubFiles = async (
  ctx: EraseContext,
  model: typeof ExportJobModel | typeof AccountExportModel,
): Promise<number> => {
  const collection = model.collection;
  const rows = await collection
    .find({ accountId: ctx.accountId, fileKey: { $ne: null } })
    .project<{ _id: Types.ObjectId; fileKey: string }>({ fileKey: 1 })
    .toArray();
  let count = 0;
  for (const row of rows) {
    if (await fileHoldsPerson(ctx, row.fileKey)) {
      await removeFile(ctx.storage, row.fileKey);
      await collection.updateOne(
        { _id: row._id, accountId: ctx.accountId },
        { $set: { fileKey: null, status: 'expired' } },
      );
      count += 1;
    }
  }
  return count;
};

const byCalls = (ctx: EraseContext) => ({ accountId: ctx.accountId, callId: { $in: ctx.callIds } });

/**
 * One entry per row of DATA_MAP.md (a test fails when one is missing). Erase and the account
 * purge share this list. The contact goes last, so a stopped run can start again.
 */
export const ERASE_MAP: EraseEntry[] = [
  { store: 'messages', action: 'delete', run: eraseMessages },
  {
    store: 'conversationSummaries',
    action: 'delete',
    run: async (ctx) =>
      deleted(
        await ConversationSummaryModel.collection.deleteMany({
          accountId: ctx.accountId,
          conversationId: { $in: ctx.conversationIds },
        }),
      ),
  },
  {
    store: 'conversations',
    action: 'delete',
    run: async (ctx) =>
      deleted(
        await ConversationModel.collection.deleteMany({
          accountId: ctx.accountId,
          _id: { $in: ctx.conversationIds },
        }),
      ),
  },
  { store: 'inboxUploads', action: 'delete', reason: 'Removed with their message' },
  {
    store: 'transcriptTurns',
    action: 'delete',
    run: async (ctx) => deleted(await TranscriptTurnModel.collection.deleteMany(byCalls(ctx))),
  },
  {
    store: 'callInsights',
    action: 'delete',
    run: async (ctx) => deleted(await CallInsightModel.collection.deleteMany(byCalls(ctx))),
  },
  {
    store: 'callEvents',
    action: 'scrub',
    run: async (ctx) =>
      (await CallEventModel.collection.updateMany(byCalls(ctx), { $set: { data: {} } }))
        .modifiedCount,
  },
  {
    store: 'flowRuns',
    action: 'delete',
    run: async (ctx) =>
      deleted(
        await FlowRunModel.collection.deleteMany({
          accountId: ctx.accountId,
          $or: [{ contactId: ctx.contactId }, { callId: { $in: ctx.callIds } }],
        }),
      ),
  },
  {
    store: 'agentToolCalls',
    action: 'delete',
    run: async (ctx) => {
      const sessions = await AgentPlaygroundSessionModel.collection
        .find({ accountId: ctx.accountId, contactId: ctx.contactId })
        .project<{ _id: Types.ObjectId }>({ _id: 1 })
        .toArray();
      return deleted(
        await AgentToolCallModel.collection.deleteMany({
          accountId: ctx.accountId,
          sessionId: { $in: [...sessions.map((s) => s._id), ...ctx.callIds] },
        }),
      );
    },
  },
  {
    store: 'agentPlaygroundSessions',
    action: 'delete',
    run: async (ctx) =>
      deleted(
        await AgentPlaygroundSessionModel.collection.deleteMany({
          accountId: ctx.accountId,
          contactId: ctx.contactId,
        }),
      ),
  },
  {
    store: 'postCallMessages',
    action: 'delete',
    run: async (ctx) =>
      deleted(
        await PostCallMessageModel.collection.deleteMany({
          accountId: ctx.accountId,
          $or: [{ contactId: ctx.contactId }, { callId: { $in: ctx.callIds } }],
        }),
      ),
  },
  { store: 'webhookEvents', action: 'delete', run: eraseWebhooks },
  { store: 'webhookDeliveries', action: 'delete', reason: 'Removed with their events' },
  {
    store: 'whatsappCallPermissions',
    action: 'delete',
    run: async (ctx) =>
      deleted(
        await WhatsAppCallPermissionModel.collection.deleteMany({
          accountId: ctx.accountId,
          contactId: ctx.contactId,
        }),
      ),
  },
  {
    store: 'dndEntries',
    action: 'delete',
    run: async (ctx) =>
      deleted(
        await DndEntryModel.collection.deleteMany({
          accountId: ctx.accountId,
          phoneE164: ctx.phoneE164,
        }),
      ),
  },
  { store: 'metaWebhookEvents', action: 'delete', run: eraseMetaEvents },
  { store: 'idempotencyKeys', action: 'delete', run: eraseIdempotency },
  { store: 'notifications', action: 'delete', run: eraseNotifications },
  { store: 'calls', action: 'scrub', run: scrubCalls },
  {
    store: 'campaignContacts',
    action: 'scrub',
    run: async (ctx) => {
      const filter = { accountId: ctx.accountId, contactId: ctx.contactId };
      await CampaignContactModel.collection.updateMany(
        { ...filter, status: { $in: ['pending', 'retry_wait', 'callback_wait'] } },
        { $set: { status: 'canceled', nextAttemptAt: null } },
      );
      return (
        await CampaignContactModel.collection.updateMany(filter, {
          $set: {
            phoneE164: ERASED_PHONE,
            name: null,
            variables: {},
            promiseToPay: null,
            callback: null,
          },
        })
      ).modifiedCount;
    },
  },
  {
    store: 'ledgerEntries',
    action: 'scrub',
    run: async (ctx) =>
      (
        await LedgerEntryModel.collection.updateMany(
          { accountId: ctx.accountId, note: personPattern(ctx) },
          { $set: { note: null } },
        )
      ).modifiedCount,
  },
  { store: 'importJobs', action: 'scrub', run: scrubImports },
  { store: 'exportJobs', action: 'scrub', run: (ctx) => scrubFiles(ctx, ExportJobModel) },
  { store: 'accountExports', action: 'delete', run: (ctx) => scrubFiles(ctx, AccountExportModel) },
  {
    store: 'contacts',
    action: 'delete',
    run: async (ctx) =>
      deleted(
        await ContactModel.collection.deleteMany({
          accountId: ctx.accountId,
          $or: [{ _id: ctx.contactId }, { phoneE164: ctx.phoneE164 }],
        }),
      ),
  },
  ...(
    [
      ['auditLogs', 'keep', 'No personal data by rule; the leak scan proves it'],
      ['suppressions', 'keep', 'One-way hash that stops the number coming back'],
      ['statsDaily', 'keep', 'Numbers only; reports stay correct'],
      ['invoices', 'keep', "The business's record, not contact data"],
      ['ttsCache', 'keep', "Cached audio can't be linked to a person; it ages out"],
      ['mockPaymentRecords', 'keep', 'Development only, never mounted in production'],
    ] as const
  ).map(([store, action, reason]) => ({ store, action, reason })),
  ...[
    'accounts',
    'users',
    'roles',
    'refreshTokens',
    'authCodes',
    'apiKeys',
    'apiRequestLogs',
    'contactLists',
    'customFieldDefinitions',
    'segments',
    'sheetImports',
    'flowNodeStats',
    'agentUsage',
    'aiAgents',
    'knowledgeBases',
    'knowledgeSources',
    'knowledgeChunks',
    'flows',
    'flowVersions',
    'flowAudio',
    'campaigns',
    'outcomeRules',
    'whatsappChannels',
    'whatsappTemplates',
    'metaDeletionRequests',
    'webhookEndpoints',
    'wallets',
    'invoiceCounters',
    'paymentEvents',
    'topupOrders',
    'rateCards',
    'whatsappRateCards',
    'whatsappBillingDaily',
    'platformSettings',
    'analyticsMarks',
    'reportSubscriptions',
    'eraseJobs',
  ].map((store) => ({ store, action: 'none' as const, reason: 'Holds no contact data' })),
];
