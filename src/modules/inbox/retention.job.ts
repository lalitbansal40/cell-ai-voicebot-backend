import { Types } from 'mongoose';

import { INBOX_LIMITS } from '../../config/limits';
import type { StorageProvider } from '../../core/storage';
import { AnalyticsMarkModel, analyticsMarkId } from '../../db/models/analytics-mark.model';
import { ConversationModel } from '../../db/models/conversation.model';
import { InboxUploadModel } from '../../db/models/inbox-upload.model';
import { MessageModel, type MessageDoc } from '../../db/models/message.model';
import { getLogger } from '../../shared/logger';
import { recordAudit } from '../audit/audit.service';

import { buildPreview } from './preview';

export interface RetentionResult {
  messages: number;
  media: number;
  uploads: number;
  conversations: number;
}

const removeFile = async (
  storage: StorageProvider,
  key: string | null | undefined,
): Promise<boolean> => {
  if (!key) return false;
  try {
    await storage.delete(key);
    return true;
  } catch {
    return false; // already gone — fine
  }
};

/** Newest remaining message → list row (or none: row cleared, unread 0). */
const recompute = async (conversationId: Types.ObjectId) => {
  const newest = await MessageModel.findOne({
    conversationId,
    type: { $nin: ['reaction', 'note'] },
  })
    .sort({ at: -1, _id: -1 })
    .lean<MessageDoc>();
  await ConversationModel.updateOne(
    { _id: conversationId },
    newest
      ? {
          $set: {
            lastMessage: {
              id: newest._id,
              direction: newest.direction,
              type: newest.type,
              preview: buildPreview(newest),
              at: newest.at,
              status: newest.status,
            },
          },
        }
      : { $set: { lastMessage: null, unreadCount: 0 } },
  );
};

/**
 * `inbox-retention` (daily, owner decision: 90 days — `INBOX_RETENTION_DAYS`, 0 =
 * keep): deletes messages older than the cutoff with their stored files in batches,
 * recomputes the touched conversations' list rows (the conversation, contact and
 * assignment stay), deletes unused uploads past their expiry, audits counts per
 * account. Resumable: a crash leaves only older-than-cutoff rows, deleted next run.
 */
export const runInboxRetention = async (
  storage: StorageProvider,
  retentionDays: number,
  now = new Date(),
): Promise<RetentionResult> => {
  const result: RetentionResult = { messages: 0, media: 0, uploads: 0, conversations: 0 };
  const perAccount = new Map<
    string,
    { accountId: Types.ObjectId; messages: number; media: number; uploads: number }
  >();
  const tally = (accountId: Types.ObjectId) => {
    const key = accountId.toString();
    let t = perAccount.get(key);
    if (!t) {
      t = { accountId, messages: 0, media: 0, uploads: 0 };
      perAccount.set(key, t);
    }
    return t;
  };
  if (retentionDays > 0) {
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
    const touched = new Set<string>();
    for (;;) {
      const batch = await MessageModel.find({ at: { $lt: cutoff } })
        .select({
          accountId: 1,
          conversationId: 1,
          'media.storageKey': 1,
          'interactive.header.storageKey': 1,
        })
        .limit(INBOX_LIMITS.retentionBatchSize)
        .lean<
          Pick<MessageDoc, '_id' | 'accountId' | 'conversationId' | 'media' | 'interactive'>[]
        >();
      if (!batch.length) break;
      for (const m of batch) {
        const t = tally(m.accountId);
        if (await removeFile(storage, m.media?.storageKey)) {
          t.media += 1;
          result.media += 1;
        }
        await removeFile(storage, m.interactive?.header?.storageKey);
        touched.add(m.conversationId.toString());
      }
      const res = await MessageModel.deleteMany({ _id: { $in: batch.map((m) => m._id) } });
      // counts stay in the report rollups; only the bookkeeping goes
      await AnalyticsMarkModel.deleteMany({
        _id: { $in: batch.map((m) => analyticsMarkId('message', m._id)) },
      });
      result.messages += res.deletedCount;
      for (const m of batch) tally(m.accountId).messages += 1;
    }
    for (const id of touched) {
      await recompute(new Types.ObjectId(id));
    }
    result.conversations = touched.size;
  }
  for (;;) {
    const uploads = await InboxUploadModel.find({ expiresAt: { $lt: now } })
      .select({ accountId: 1, storageKey: 1 })
      .limit(INBOX_LIMITS.retentionBatchSize)
      .lean<{ _id: Types.ObjectId; accountId: Types.ObjectId; storageKey: string }[]>();
    if (!uploads.length) break;
    for (const u of uploads) await removeFile(storage, u.storageKey);
    await InboxUploadModel.deleteMany({ _id: { $in: uploads.map((u) => u._id) } });
    result.uploads += uploads.length;
    for (const u of uploads) tally(u.accountId).uploads += 1;
  }
  for (const t of perAccount.values()) {
    await recordAudit({
      accountId: t.accountId,
      actor: { type: 'system', id: null },
      action: 'inbox.messages_purged',
      target: { type: 'account', id: t.accountId.toString() },
      meta: { messages: t.messages, media: t.media, uploads: t.uploads },
    });
  }
  getLogger().info({ ...result }, 'inbox: retention done');
  return result;
};
