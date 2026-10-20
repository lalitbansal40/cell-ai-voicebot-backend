import { CAMPAIGN_LIMITS } from '../../config/limits';
import { tryGetRealtime } from '../../core/realtime';
import { CampaignModel, type CampaignStats } from '../../db/models/campaign.model';

const lastSent = new Map<string, number>();
const trailing = new Map<string, NodeJS.Timeout>();

const send = async (campaignId: string): Promise<void> => {
  lastSent.set(campaignId, Date.now());
  const doc = await CampaignModel.findById(campaignId)
    .select({ stats: 1 })
    .lean<{ stats: CampaignStats }>();
  if (!doc) return;
  await tryGetRealtime()
    ?.pushToTopic(`campaign:${campaignId}`, 'campaign.progress', { campaignId, stats: doc.stats })
    .catch(() => undefined);
};

/**
 * `campaign.progress` to the campaign topic (websocket.md §5): at most one per
 * second per campaign, and the last change is always sent (trailing send).
 */
export const publishProgress = (campaignId: string): void => {
  if (trailing.has(campaignId)) return;
  const wait = (lastSent.get(campaignId) ?? 0) + CAMPAIGN_LIMITS.progressThrottleMs - Date.now();
  if (wait <= 0) {
    void send(campaignId);
    return;
  }
  trailing.set(
    campaignId,
    setTimeout(() => {
      trailing.delete(campaignId);
      void send(campaignId);
    }, wait),
  );
};

/** Tests / shutdown: forget the throttle state. */
export const resetProgressThrottle = (): void => {
  for (const t of trailing.values()) clearTimeout(t);
  trailing.clear();
  lastSent.clear();
};
