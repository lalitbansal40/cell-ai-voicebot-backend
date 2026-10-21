import { Types } from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setRealtime } from '../../src/core/realtime';
import { CampaignModel, emptyCampaignStats } from '../../src/db/models/campaign.model';
import { publishProgress, resetProgressThrottle } from '../../src/modules/campaigns/progress';
import { useTestDb } from '../helpers/db';

useTestDb();

afterEach(() => {
  resetProgressThrottle();
  setRealtime(undefined);
  vi.useRealTimers();
});

describe('campaign.progress throttle', () => {
  it('at most one per second per campaign; the last change is always sent', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const pushToTopic = vi.fn(() => Promise.resolve());
    setRealtime({ pushToTopic } as never);
    const c = await CampaignModel.create({
      accountId: new Types.ObjectId(),
      name: 'Progress',
      flowId: new Types.ObjectId(),
      schedule: { timezone: 'Asia/Kolkata' },
      window: { start: '09:00', end: '19:00', days: [1] },
      retry: { maxAttempts: 1, intervalMinutes: 15 },
      pacing: { concurrency: 1, dialsPerMinute: 1 },
      stats: { ...emptyCampaignStats(), total: 7 },
    });
    const id = c._id.toString();
    publishProgress(id);
    await vi.waitFor(() => expect(pushToTopic).toHaveBeenCalledTimes(1));
    expect(pushToTopic).toHaveBeenCalledWith(`campaign:${id}`, 'campaign.progress', {
      campaignId: id,
      stats: expect.objectContaining({ total: 7 }),
    });
    publishProgress(id);
    publishProgress(id); // coalesced into one trailing send
    expect(pushToTopic).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(pushToTopic).toHaveBeenCalledTimes(2));
    // an unknown campaign sends nothing; no realtime → no error
    publishProgress(new Types.ObjectId().toString());
    setRealtime(undefined);
    await vi.advanceTimersByTimeAsync(1_000);
    publishProgress(id);
    expect(pushToTopic).toHaveBeenCalledTimes(2);
  });
});

describe('campaign.progress failures', () => {
  it('a database error (e.g. Mongo already closed at shutdown) is caught, never an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    const findById = vi.spyOn(CampaignModel, 'findById').mockImplementation(
      () =>
        ({
          select: () => ({ lean: () => Promise.reject(new Error('client is not connected')) }),
        }) as never,
    );
    try {
      const id = new Types.ObjectId().toString();
      publishProgress(id); // sent now
      publishProgress(id); // trailing send ≤ 1 s later
      await new Promise((r) => setTimeout(r, 1_200));
      expect(findById).toHaveBeenCalledTimes(2);
      expect(unhandled).toEqual([]);
    } finally {
      findById.mockRestore();
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
