import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SEED_WHATSAPP_NUMBER, seedWhatsApp } from '../../scripts/seed-whatsapp';
import { MetaWebhookEventModel } from '../../src/db/models/meta-webhook-event.model';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import { createLogger } from '../../src/shared/logger';
import { createTestAccount } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { requireRedis } from '../helpers/redis';
import { testEnv } from '../helpers/test-app';

useTestDb();
useCapturedEmail();
const env = testEnv();
const logger = createLogger(env);
let redis: Redis;
beforeAll(async () => {
  redis = (await requireRedis()).client;
  await WhatsAppChannelModel.createIndexes();
});
afterAll(() => redis.disconnect());

describe('seedWhatsApp', () => {
  it('connects the demo number through connect() with three events — once', async () => {
    // a previous run elsewhere must not hold the demo number
    await WhatsAppChannelModel.deleteMany({ displayPhoneNumber: SEED_WHATSAPP_NUMBER });
    const t = await createTestAccount({ name: 'Demo Finance' });
    const owner = await t.addUser('owner');
    const deps = { env, ownerId: owner.user._id, redis, logger };
    expect(await seedWhatsApp(t.account._id, deps)).toEqual({
      channels: 1,
      events: 3,
      skipped: null,
    });
    const channel = await WhatsAppChannelModel.findOne({ accountId: t.account._id }).lean();
    expect(channel).toMatchObject({
      status: 'connected',
      mode: 'cloud_api',
      label: 'Demo Finance',
      displayPhoneNumber: SEED_WHATSAPP_NUMBER,
      qualityRating: 'GREEN',
      // the fake's numbers report Meta's 2,000 tier (enough for calling, Phase 12)
      messagingLimitTier: 'TIER_2K',
      nameStatus: 'APPROVED',
    });
    const events = await MetaWebhookEventModel.find({ channelId: channel?._id }).lean();
    expect(events.map((e) => `${e.field}:${e.status}`).sort()).toEqual([
      'messages:deferred',
      'phone_number_name_update:processed',
      'phone_number_quality_update:processed',
    ]);
    expect(await seedWhatsApp(t.account._id, deps)).toEqual({
      channels: 0,
      events: 0,
      skipped: null,
    });
    expect(await WhatsAppChannelModel.countDocuments({ accountId: t.account._id })).toBe(1);
  });

  it('skips when WhatsApp is off or the real provider is configured', async () => {
    const t = await createTestAccount();
    const owner = await t.addUser('owner');
    const off = { ...env, WHATSAPP_ENABLED: false };
    expect(
      (await seedWhatsApp(t.account._id, { env: off, ownerId: owner.user._id, redis, logger }))
        .skipped,
    ).toMatch(/off/);
  });
});
