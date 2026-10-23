import { Types } from 'mongoose';

import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import { getLogger } from '../../shared/logger';

import type { TemplateContext } from './context';
import type { TemplateSyncJobData } from './jobs';
import { syncTemplates, type SyncResult } from './template.service';

/** Redis lock: one template sync per WABA per minute (Meta rate + our own load). */
export const syncLockKey = (wabaId: string) => `tpl-sync-${wabaId}`;

/**
 * `template.sync` job: skipped while another sync of the same WABA ran in the last
 * minute or the number can't manage templates any more; otherwise a full sync.
 */
export const processTemplateSync = async (
  tx: TemplateContext,
  data: TemplateSyncJobData,
): Promise<SyncResult | { skipped: 'rate' | 'channel' }> => {
  if (!Types.ObjectId.isValid(data.channelId)) return { skipped: 'channel' };
  const channel = await WhatsAppChannelModel.findById(data.channelId)
    .select({ wabaId: 1, status: 1 })
    .lean<Pick<WhatsAppChannelDoc, '_id' | 'wabaId' | 'status'>>();
  if (!channel || !['connected', 'restricted', 'action_needed'].includes(channel.status)) {
    return { skipped: 'channel' };
  }
  const got = await tx.wa.redis.set(syncLockKey(channel.wabaId), data.reason, 'EX', 60, 'NX');
  if (got !== 'OK') return { skipped: 'rate' };
  return syncTemplates(tx, channel._id, data.reason);
};

/**
 * Daily scheduler (`templates-daily-sync`, 04:10 IST): one `template.sync` per WABA,
 * through its first connected number.
 */
export const queueDailyTemplateSyncs = async (tx: TemplateContext): Promise<{ queued: number }> => {
  const channels = await WhatsAppChannelModel.find({ status: { $in: ['connected', 'restricted'] } })
    .select({ accountId: 1, wabaId: 1 })
    .sort({ createdAt: 1 })
    .lean<Pick<WhatsAppChannelDoc, '_id' | 'accountId' | 'wabaId'>[]>();
  const seen = new Set<string>();
  let queued = 0;
  for (const c of channels) {
    const k = `${c.accountId.toString()}|${c.wabaId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    try {
      await tx.jobs.enqueueSync(c._id.toString(), 'daily');
      queued += 1;
    } catch (err) {
      getLogger().warn(
        { channelId: c._id.toString(), errName: (err as Error).name },
        'templates: daily sync not queued',
      );
    }
  }
  return { queued };
};
