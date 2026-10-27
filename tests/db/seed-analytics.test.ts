import { Types } from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';

import { SEED_ANALYTICS_MARK, seedAnalytics } from '../../scripts/seed-analytics';
import { reconcileWallets } from '../../src/core/billing/reconcile';
import { CallInsightModel } from '../../src/db/models/call-insight.model';
import { CallModel } from '../../src/db/models/call.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { ConversationModel } from '../../src/db/models/conversation.model';
import { FlowModel } from '../../src/db/models/flow.model';
import { MessageModel } from '../../src/db/models/message.model';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import { countFromRaw, storedTotals } from '../helpers/analytics';
import { createTestAccount, type TestAccount } from '../helpers/auth';
import { useTestDb } from '../helpers/db';

useTestDb();

const NOW = new Date('2026-10-27T12:00:00Z');

/** An account with what the demo seeds leave behind: contacts, a flow, a number, a chat. */
const world = async (): Promise<TestAccount> => {
  const t = await createTestAccount({ name: 'Demo Finance' });
  await t.addUser('owner');
  await t.addUser('agent');
  const contacts = await ContactModel.insertMany(
    Array.from({ length: 5 }, (_, i) => ({
      accountId: t.account._id,
      phoneE164: `+9190000${String(40000 + i)}`,
      source: { type: 'manual' },
    })),
  );
  await FlowModel.collection.insertOne({
    _id: new Types.ObjectId(),
    accountId: t.account._id,
    name: 'Loan recovery',
    deletedAt: null,
  });
  const channel = new Types.ObjectId();
  await WhatsAppChannelModel.collection.insertOne({
    _id: channel,
    accountId: t.account._id,
    label: 'Demo number',
  });
  await ConversationModel.collection.insertOne({
    _id: new Types.ObjectId(),
    accountId: t.account._id,
    channelId: channel,
    contactId: contacts[0]?._id,
  });
  return t;
};

let t: TestAccount;
beforeAll(async () => {
  t = await world();
});

describe('seedAnalytics', () => {
  it('writes days of calls, insights, messages and charges, and rollups that match the raw rows', async () => {
    const result = await seedAnalytics(t.account._id, { days: 12, now: NOW });
    expect(result.skipped).toBeUndefined();
    expect(result.calls).toBeGreaterThan(40);
    expect(result.messages).toBeGreaterThan(50);
    expect(result.charges).toBeGreaterThan(5);
    expect(result.rollupRows).toBeGreaterThan(0);

    const calls = await CallModel.find({ accountId: t.account._id }).lean();
    expect(new Set(calls.map((c) => c.provider))).toEqual(new Set(['webcall', 'whatsapp']));
    expect(calls.every((c) => c.createdAt <= NOW)).toBe(true);
    const answered = calls.filter((c) => c.status === 'completed');
    expect(await CallInsightModel.countDocuments({ accountId: t.account._id })).toBe(
      answered.length,
    );
    const insight = await CallInsightModel.findOne({ accountId: t.account._id }).lean();
    expect(insight?.output?.summary).toMatch(/^Demo: /);
    expect(answered.every((c) => c.insights?.status === 'done' && c.disposition)).toBe(true);
    expect(
      await MessageModel.countDocuments({ accountId: t.account._id, text: { $ne: null } }),
    ).toBe(0);

    // the rollups equal a count from the raw rows; the wallet still equals its ledger
    const raw = await countFromRaw(t.account._id, 'Asia/Kolkata');
    expect(await storedTotals(t.account._id, raw)).toEqual(raw);
    const { mismatches } = await reconcileWallets();
    expect(mismatches.filter((m) => m.accountId === t.account._id.toString())).toEqual([]);
  });

  it('is idempotent and deterministic', async () => {
    const before = await CallModel.countDocuments({ accountId: t.account._id });
    expect(await seedAnalytics(t.account._id, { days: 12, now: NOW })).toMatchObject({
      skipped: 'already seeded',
      calls: 0,
    });
    expect(await CallModel.countDocuments({ accountId: t.account._id })).toBe(before);
    expect(
      await CallModel.countDocuments({
        accountId: t.account._id,
        'variables.seed': SEED_ANALYTICS_MARK,
      }),
    ).toBe(before);

    const twin = await world();
    const again = await seedAnalytics(twin.account._id, { days: 12, now: NOW });
    expect(again.calls).toBe(before);
  });

  it('marks everything as test traffic for the staging review account', async () => {
    const review = await world();
    await seedAnalytics(review.account._id, { days: 3, now: NOW, isTest: true });
    expect(await CallModel.countDocuments({ accountId: review.account._id, isTest: false })).toBe(
      0,
    );
  });

  it('skips an account without contacts or without anything to call with', async () => {
    const bare = await createTestAccount();
    expect((await seedAnalytics(bare.account._id, { now: NOW })).skipped).toBe('no contacts');
    await ContactModel.create({
      accountId: bare.account._id,
      phoneE164: '+919000049999',
      source: { type: 'manual' },
    });
    expect((await seedAnalytics(bare.account._id, { now: NOW })).skipped).toMatch(/no flows/);
  });
});
