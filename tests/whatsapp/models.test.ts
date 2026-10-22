import { Types } from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';

import { MetaDeletionRequestModel } from '../../src/db/models/meta-deletion-request.model';
import { MetaWebhookEventModel } from '../../src/db/models/meta-webhook-event.model';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import { useTestDb } from '../helpers/db';

useTestDb();

beforeAll(async () => {
  await WhatsAppChannelModel.createIndexes();
  await MetaWebhookEventModel.createIndexes();
  await MetaDeletionRequestModel.createIndexes();
});

const channel = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  accountId: new Types.ObjectId(),
  label: 'Support',
  provider: 'fake',
  mode: 'cloud_api',
  wabaId: 'fake_waba_1',
  phoneNumberId: `fake_phone_${new Types.ObjectId().toString()}`,
  metaPayer: 'platform',
  status: 'connected',
  ...over,
});

describe('WhatsAppChannel model', () => {
  it('defaults, secrets hidden from queries and JSON', async () => {
    const doc = await WhatsAppChannelModel.create({
      ...channel(),
      tokenSealed: 'sealed-token',
      registration: { status: 'registered', pinSealed: 'sealed-pin' },
    });
    expect(doc.toJSON()).not.toHaveProperty('tokenSealed');
    const read = await WhatsAppChannelModel.findById(doc._id).lean();
    expect(read).not.toHaveProperty('tokenSealed');
    expect(read?.registration).not.toHaveProperty('pinSealed');
    expect(read).toMatchObject({
      qualityRating: 'UNKNOWN',
      messagingLimitTier: null,
      isOnBizApp: false,
      creditLine: { status: 'not_needed' },
      paymentMethodOk: null,
      coexistence: { contactsSync: 'not_requested', historySync: 'not_requested' },
      webhook: { lastEventAt: null },
      history: [],
    });
    const secrets = await WhatsAppChannelModel.findById(doc._id)
      .select('+tokenSealed +registration.pinSealed')
      .lean();
    expect(secrets?.tokenSealed).toBe('sealed-token');
    expect(secrets?.registration.pinSealed).toBe('sealed-pin');
  });

  it('validates enums, label length and required fields', async () => {
    await expect(WhatsAppChannelModel.create(channel({ status: 'weird' }))).rejects.toThrow();
    await expect(WhatsAppChannelModel.create(channel({ mode: 'other' }))).rejects.toThrow();
    await expect(WhatsAppChannelModel.create(channel({ label: 'x'.repeat(61) }))).rejects.toThrow();
    await expect(WhatsAppChannelModel.create(channel({ metaPayer: undefined }))).rejects.toThrow();
    await expect(WhatsAppChannelModel.create(channel({ accountId: undefined }))).rejects.toThrow();
  });

  it('one active channel per phone number; disconnected ones and missing numbers do not count', async () => {
    const phoneNumberId = 'fake_phone_unique_1';
    await WhatsAppChannelModel.create(channel({ phoneNumberId, status: 'disconnected' }));
    await WhatsAppChannelModel.create(channel({ phoneNumberId, status: 'connected' }));
    await expect(
      WhatsAppChannelModel.create(channel({ phoneNumberId, status: 'action_needed' })),
    ).rejects.toMatchObject({ code: 11000 });
    // a WABA without a number yet (FINISH_ONLY_WABA)
    await WhatsAppChannelModel.create(channel({ phoneNumberId: null, status: 'action_needed' }));
    await WhatsAppChannelModel.create(channel({ phoneNumberId: null, status: 'action_needed' }));
  });
});

describe('MetaWebhookEvent / MetaDeletionRequest models', () => {
  it('unique key, sealed payload hidden, TTL indexes', async () => {
    const base = {
      key: 'k'.repeat(64),
      object: 'whatsapp_business_account',
      field: 'messages',
      payloadSealed: 'sealed',
      receivedAt: new Date(),
      expiresAt: new Date(Date.now() + 1000),
    };
    const event = await MetaWebhookEventModel.create(base);
    expect(event.toJSON()).not.toHaveProperty('payloadSealed');
    expect(await MetaWebhookEventModel.findById(event._id).lean()).toMatchObject({
      status: 'received',
      attempts: 0,
      accountId: null,
    });
    await expect(MetaWebhookEventModel.create(base)).rejects.toMatchObject({ code: 11000 });
    const ttl = (await MetaWebhookEventModel.collection.indexes()).find(
      (i) => i.key.expiresAt === 1,
    );
    expect(ttl?.expireAfterSeconds).toBe(0);

    const req = {
      confirmationCode: 'abcDEF123456ghij',
      metaUserId: '123',
      receivedAt: new Date(),
      expiresAt: new Date(Date.now() + 1000),
    };
    await MetaDeletionRequestModel.create(req);
    await expect(MetaDeletionRequestModel.create(req)).rejects.toMatchObject({ code: 11000 });
  });
});
