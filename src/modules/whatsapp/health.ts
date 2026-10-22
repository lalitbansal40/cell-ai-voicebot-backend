import { WHATSAPP_LIMITS } from '../../config/limits';
import { isMetaApiError } from '../../core/meta';
import {
  WA_ACTIVE_STATUSES,
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import { getLogger } from '../../shared/logger';

import { SYSTEM_ACTOR } from './channel-status';
import type { WhatsAppService } from './whatsapp.service';

/** Daily at 22:00 UTC (job scheduler id `whatsapp-health`). */
export const WHATSAPP_HEALTH_CRON = '0 22 * * *';

export interface HealthResult {
  checked: number;
  failed: number;
  byStatus: Record<string, number>;
}

/**
 * The daily health pass (§1g): every non-disconnected channel gets one `sync`
 * (token check, Meta details, status). Channels of one account run one after the
 * other; up to `healthConcurrency` accounts at once. A channel's error never stops
 * the pass. Transitions notify through `transition` (once per change).
 */
export const runHealthPass = async (
  service: Pick<WhatsAppService, 'syncChannel'>,
  concurrency: number = WHATSAPP_LIMITS.healthConcurrency,
): Promise<HealthResult> => {
  const channels = await WhatsAppChannelModel.find({ status: { $in: WA_ACTIVE_STATUSES } })
    .select('+tokenSealed')
    .sort({ accountId: 1, _id: 1 })
    .lean<WhatsAppChannelDoc[]>();
  const byAccount = new Map<string, WhatsAppChannelDoc[]>();
  for (const c of channels) {
    const key = c.accountId.toString();
    byAccount.set(key, [...(byAccount.get(key) ?? []), c]);
  }
  const result: HealthResult = { checked: 0, failed: 0, byStatus: {} };
  const queue = [...byAccount.values()];
  const worker = async () => {
    for (let group = queue.shift(); group; group = queue.shift()) {
      for (const channel of group) {
        result.checked += 1;
        try {
          const after = await service.syncChannel(channel, SYSTEM_ACTOR);
          result.byStatus[after.status] = (result.byStatus[after.status] ?? 0) + 1;
        } catch (err) {
          result.failed += 1;
          getLogger().warn(
            {
              channelId: channel._id.toString(),
              code: isMetaApiError(err) ? err.code : null,
              err: isMetaApiError(err) ? undefined : (err as Error).name,
            },
            'whatsapp: health check failed',
          );
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  getLogger().info({ ...result }, 'whatsapp: health pass done');
  return result;
};
