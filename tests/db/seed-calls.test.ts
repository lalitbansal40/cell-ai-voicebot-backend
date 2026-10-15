import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { seedAi } from '../../scripts/seed-ai';
import { SEED_CALL_MARKS, seedCalls } from '../../scripts/seed-calls';
import { seedContacts } from '../../scripts/seed-contacts';
import { seedFlows } from '../../scripts/seed-flows';
import { createFakeProvider } from '../../src/core/ai';
import { CallEventModel } from '../../src/db/models/call-event.model';
import { CallModel } from '../../src/db/models/call.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { TranscriptTurnModel } from '../../src/db/models/transcript-turn.model';
import { createLogger } from '../../src/shared/logger';
import { recordingAiJobs } from '../helpers/ai';
import { createTestAccount } from '../helpers/auth';
import { ensureRateCard, fund } from '../helpers/calls';
import { useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { requireRedis } from '../helpers/redis';
import { testEnv } from '../helpers/test-app';

useTestDb();
const storage = useTempStorage();
// the seed serves the mock payment API on APP_URL's port while it runs
const env = testEnv({
  APP_URL: 'http://localhost:5197',
  MOCK_APIS_ENABLED: 'true',
  AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS: 'true',
});

let redis: Redis;
beforeAll(async () => {
  redis = (await requireRedis()).client;
  await ensureRateCard();
});
afterAll(() => redis.disconnect());

describe('seedCalls', () => {
  it('runs the Loan recovery (paid) and the agent promise calls through the runtime, once', async () => {
    const t = await createTestAccount({ name: 'Demo Finance' });
    const owner = await t.addUser('owner');
    const accountId = t.account._id;
    await fund(accountId, 1_000_000_000);
    await seedContacts(accountId, owner.user._id);
    await seedAi(accountId, {
      env,
      ownerId: owner.user._id,
      storage,
      provider: createFakeProvider(),
      jobs: recordingAiJobs().jobs,
    });
    await seedFlows(accountId, { env, ownerId: owner.user._id, storage });
    const deps = {
      env,
      ownerId: owner.user._id,
      storage,
      redis,
      provider: createFakeProvider(),
      logger: createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
    };
    expect(await seedCalls(accountId, deps)).toEqual({ calls: 2 });

    const loan = await CallModel.findOne({
      accountId,
      providerCallId: SEED_CALL_MARKS.loan,
    }).lean();
    expect(loan).toMatchObject({
      status: 'completed',
      endReason: 'hangup_node',
      disposition: 'paid',
    });
    expect(loan?.recording?.sizeBytes).toBeGreaterThan(44);
    expect(loan?.flowRunId).toBeTruthy();
    const agent = await CallModel.findOne({
      accountId,
      providerCallId: SEED_CALL_MARKS.agent,
    }).lean();
    expect(agent).toMatchObject({ status: 'completed', disposition: 'promise_to_pay' });
    expect(agent?.metrics.aiSeconds).toBeGreaterThan(0);
    for (const call of [loan, agent]) {
      expect(await TranscriptTurnModel.countDocuments({ callId: call?._id })).toBeGreaterThan(2);
      expect(await CallEventModel.countDocuments({ callId: call?._id })).toBeGreaterThan(3);
      expect(
        await LedgerEntryModel.exists({
          'ref.type': 'call',
          'ref.id': call?._id.toString(),
          type: 'call_charge',
        }),
      ).toBeTruthy();
    }

    expect(await seedCalls(accountId, deps)).toEqual({ calls: 0 });
    expect(await CallModel.countDocuments({ accountId })).toBe(2);
  });
});
