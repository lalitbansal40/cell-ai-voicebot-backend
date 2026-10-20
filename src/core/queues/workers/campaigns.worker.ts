import type { Queue, Worker } from 'bullmq';

import {
  CAMPAIGN_SCHEDULES,
  processCampaignJob,
  type CampaignJobContext,
} from '../../../modules/campaigns/jobs';
import { QUEUES } from '../names';
import { createQueue, createWorker, type QueueFactoryDeps } from '../queue-factory';

/** Starts the `campaigns` worker and the minute sweep (Phase 8). */
export const startCampaignsWorker = async (
  deps: QueueFactoryDeps & Omit<CampaignJobContext, 'logger'>,
): Promise<{ queue: Queue; worker: Worker }> => {
  const queue = createQueue(QUEUES.campaigns, deps);
  const worker = createWorker(
    QUEUES.campaigns,
    processCampaignJob({ dispatcher: deps.dispatcher, logger: deps.logger }),
    { ...deps, concurrency: 4 },
  );
  for (const s of CAMPAIGN_SCHEDULES) {
    await queue.upsertJobScheduler(s.name, { pattern: s.pattern, tz: 'UTC' }, { name: s.name });
  }
  return { queue, worker };
};
