import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SEED_WA_CALL_MARKS, seedCallsWa } from '../../scripts/seed-calls-wa';
import { demoPhone } from '../../scripts/seed-contacts';
import { SEED_WHATSAPP_NUMBER, seedWhatsApp } from '../../scripts/seed-whatsapp';
import { CallModel } from '../../src/db/models/call.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { WhatsAppCallPermissionModel } from '../../src/db/models/whatsapp-call-permission.model';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import { createLogger } from '../../src/shared/logger';
import { createTestAccount } from '../helpers/auth';
import { expectWalletConsistent } from '../helpers/billing';
import { ensureRateCard, fund } from '../helpers/calls';
import { useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { requireRedis, uniquePrefix } from '../helpers/redis';
import { testEnv } from '../helpers/test-app';

useTestDb();
useCapturedEmail();
const env = testEnv();
const logger = createLogger(env);
const storage = useTempStorage();
let redis: Redis;
beforeAll(async () => {
  redis = (await requireRedis()).client;
  await WhatsAppChannelModel.createIndexes();
  await ensureRateCard();
});
afterAll(() => redis.disconnect());

describe('seedCallsWa', () => {
  it('enables calling, two permissions and three past calls (two charged in pulses) — once', async () => {
    await WhatsAppChannelModel.deleteMany({ displayPhoneNumber: SEED_WHATSAPP_NUMBER });
    const t = await createTestAccount({ name: 'Demo Finance' });
    const owner = await t.addUser('owner');
    await fund(t.account._id);
    for (const i of [4, 5, 6])
      await ContactModel.create({
        accountId: t.account._id,
        phoneE164: demoPhone(i),
        name: `Demo ${String(i)}`,
        source: { type: 'manual' },
      });
    const deps = {
      env,
      ownerId: owner.user._id,
      redis,
      logger,
      storage,
      metaPrefix: `${uniquePrefix('seed-wa')}:`,
    };
    await seedWhatsApp(t.account._id, deps);
    // a number saved before migration 0013 has no calling sub-document
    await WhatsAppChannelModel.updateOne({ accountId: t.account._id }, { $unset: { calling: '' } });
    expect(await seedCallsWa(t.account._id, deps)).toEqual({
      permissions: 2,
      calls: 3,
      skipped: null,
    });
    const channel = await WhatsAppChannelModel.findOne({ accountId: t.account._id }).lean();
    expect(channel?.calling).toMatchObject({
      status: 'enabled',
      callbackPermission: true,
      callHours: { enabled: false },
      inbound: { route: 'team', ringTimeoutSec: 30 },
    });
    expect(
      (await WhatsAppCallPermissionModel.find({ accountId: t.account._id }).lean())
        .map((p) => p.status)
        .sort(),
    ).toEqual(['permanent', 'temporary']);
    const calls = await CallModel.find({ accountId: t.account._id }).lean();
    const of = (mark: string) => calls.find((c) => c.providerCallId === mark);
    // 47 s → 8 pulses, 30 s → 5 pulses (₹0.3885 / min × 1.15, paise rounded up)
    expect(of(SEED_WA_CALL_MARKS.agent)?.billing.whatsapp).toMatchObject({
      pulses: 8,
      status: 'settled',
    });
    expect(of(SEED_WA_CALL_MARKS.ai)?.billing.whatsapp?.pulses).toBe(5);
    expect(of(SEED_WA_CALL_MARKS.missed)).toMatchObject({
      direction: 'inbound',
      status: 'no_answer',
      recording: null,
    });
    expect(of(SEED_WA_CALL_MARKS.agent)?.recording?.fileKey).toBeTruthy();
    const charges = await LedgerEntryModel.find({
      accountId: t.account._id,
      type: 'whatsapp_call_charge',
      status: 'captured',
    }).lean();
    expect(charges).toHaveLength(2);
    expect(charges.map((c) => c.amountMicros).sort((a, b) => a - b)).toEqual([230_000, 360_000]);
    await expectWalletConsistent(t.account._id);

    expect(await seedCallsWa(t.account._id, deps)).toEqual({
      permissions: 0,
      calls: 0,
      skipped: null,
    });
    expect(await CallModel.countDocuments({ accountId: t.account._id })).toBe(3);
  });

  it('skips without the fake Meta or the demo number', async () => {
    const t = await createTestAccount();
    const deps = { env, ownerId: t.account._id, redis, logger, storage };
    expect(
      await seedCallsWa(t.account._id, { ...deps, env: { ...env, WHATSAPP_ENABLED: false } }),
    ).toMatchObject({ calls: 0, skipped: expect.any(String) });
    expect(await seedCallsWa(t.account._id, deps)).toEqual({
      permissions: 0,
      calls: 0,
      skipped: 'No demo WhatsApp number',
    });
  });
});
