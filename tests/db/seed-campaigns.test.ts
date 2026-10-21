import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { seedAi } from '../../scripts/seed-ai';
import {
  SEED_CAMPAIGN_NAMES,
  SEED_CAMPAIGN_SEGMENT,
  seedCampaigns,
} from '../../scripts/seed-campaigns';
import { seedContacts } from '../../scripts/seed-contacts';
import { seedFlows } from '../../scripts/seed-flows';
import { createFakeProvider } from '../../src/core/ai';
import { AccountModel } from '../../src/db/models/account.model';
import { CallModel } from '../../src/db/models/call.model';
import { CampaignContactModel } from '../../src/db/models/campaign-contact.model';
import { CampaignModel } from '../../src/db/models/campaign.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { SegmentModel } from '../../src/db/models/segment.model';
import { createLogger } from '../../src/shared/logger';
import { recordingAiJobs } from '../helpers/ai';
import { createTestAccount } from '../helpers/auth';
import { ensureRateCard, fund } from '../helpers/calls';
import { ALL_DAY } from '../helpers/campaigns';
import { useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { requireRedis } from '../helpers/redis';
import { testEnv } from '../helpers/test-app';

useTestDb();
useCapturedEmail();
const storage = useTempStorage();
// the seed serves the mock payment API on APP_URL's port while it runs
const env = testEnv({
  APP_URL: 'http://localhost:5198',
  MOCK_APIS_ENABLED: 'true',
  AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS: 'true',
});

let redis: Redis;
beforeAll(async () => {
  redis = (await requireRedis()).client;
  await ensureRateCard();
});
afterAll(() => redis.disconnect());

describe('seedCampaigns', () => {
  it('a dry-run campaign run by the dispatcher, a draft, a paused recurring parent and the segment — once', async () => {
    const t = await createTestAccount({ name: 'Demo Finance' });
    const owner = await t.addUser('owner');
    const accountId = t.account._id;
    await fund(accountId, 2_000_000_000);
    await AccountModel.updateOne({ _id: accountId }, { 'settings.callingWindow': ALL_DAY });
    await seedContacts(accountId, owner.user._id);
    await seedAi(accountId, {
      env,
      ownerId: owner.user._id,
      storage,
      provider: createFakeProvider(),
      jobs: recordingAiJobs().jobs,
    });
    await seedFlows(accountId, { env, ownerId: owner.user._id, storage });
    const ledgerBefore = await LedgerEntryModel.countDocuments({ accountId });
    const deps = {
      env,
      ownerId: owner.user._id,
      storage,
      redis,
      logger: createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
    };
    const first = await seedCampaigns(accountId, deps);
    expect(first.campaigns).toBe(3);
    expect(first.calls).toBeGreaterThanOrEqual(30);

    const done = await CampaignModel.findOne({ accountId, name: SEED_CAMPAIGN_NAMES.done }).lean();
    expect(done?.stats.total).toBe(30);
    // everything final except customer callbacks (at their real time)
    const open = await CampaignContactModel.find({
      campaignId: done?._id,
      status: { $nin: ['completed', 'failed', 'skipped'] },
    }).lean();
    expect(open.every((r) => r.status === 'callback_wait')).toBe(true);
    expect(done?.stats.waiting).toBe(open.length);
    expect(done?.status).toBe(open.length ? 'running' : 'completed');
    expect(await CallModel.countDocuments({ campaignId: done?._id, provider: 'dryrun' })).toBe(
      first.calls,
    );
    // never charged
    expect(await LedgerEntryModel.countDocuments({ accountId })).toBe(ledgerBefore);

    expect(
      await CampaignModel.findOne({ accountId, name: SEED_CAMPAIGN_NAMES.draft }).lean(),
    ).toMatchObject({ status: 'draft' });
    expect(
      await CampaignModel.findOne({ accountId, name: SEED_CAMPAIGN_NAMES.recurring }).lean(),
    ).toMatchObject({
      status: 'paused',
      pauseReason: 'manual',
      schedule: { recurrence: { freq: 'daily', time: '10:00' } },
    });
    expect(
      await SegmentModel.findOne({ accountId, name: SEED_CAMPAIGN_SEGMENT }).lean(),
    ).toMatchObject({
      filter: { conditions: [{ key: 'lastDisposition', op: 'eq', value: 'promise_to_pay' }] },
    });

    // idempotent
    const again = await seedCampaigns(accountId, deps);
    expect(again.campaigns).toBe(0);
    expect(await CampaignModel.countDocuments({ accountId })).toBe(3);
    expect(await SegmentModel.countDocuments({ accountId, name: SEED_CAMPAIGN_SEGMENT })).toBe(1);
  });
});
