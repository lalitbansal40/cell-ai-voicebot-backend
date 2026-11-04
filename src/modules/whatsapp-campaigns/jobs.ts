import type { WaCampaignJobs } from './campaigns.service';

/** `whatsapp` queue jobs (Phase 19); job ids never contain `:`. */
export const WA_CAMPAIGN_JOBS = {
  dispatch: 'whatsapp-campaign.dispatch',
  sweep: 'whatsapp-campaign.sweep',
} as const;
export const WA_CAMPAIGN_SWEEP_CRON = '*/5 * * * *';
export const WA_CAMPAIGN_SWEEP_JOB_ID = 'whatsapp-campaign-sweep';
export const waCampaignJobId = (campaignId: string): string => `wa-campaign-${campaignId}`;

export interface WaCampaignDispatchData {
  campaignId: string;
}

export const queueWaCampaignJobs = (queue: {
  add(name: string, data: unknown, opts: Record<string, unknown>): Promise<unknown>;
}): WaCampaignJobs => ({
  async enqueueDispatch(campaignId) {
    await queue.add(WA_CAMPAIGN_JOBS.dispatch, { campaignId } satisfies WaCampaignDispatchData, {
      // a new job id per call: a resume after the last job finished must run again
      jobId: `${waCampaignJobId(campaignId)}-${String(Date.now())}`,
      priority: 10,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: true,
      removeOnFail: { age: 7 * 86_400 },
    });
  },
});
