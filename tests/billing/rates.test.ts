import { Types } from 'mongoose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createRateCardVersion,
  effectiveRateCard,
  invalidateRateCardCache,
  rateCardById,
  rateCardHistory,
  setAccountToDefault,
} from '../../src/core/billing/rates';
import { DEFAULT_RATE_CARD, RateCardModel } from '../../src/db/models/rate-card.model';
import { ValidationError } from '../../src/shared/errors/app-error';
import { useTestDb } from '../helpers/db';

useTestDb();

const admin = new Types.ObjectId();

beforeAll(async () => {
  await RateCardModel.create({ accountId: null, ...DEFAULT_RATE_CARD, effectiveFrom: new Date(0) });
});
afterEach(() => {
  vi.useRealTimers();
  invalidateRateCardCache();
});

describe('effective rate card', () => {
  it('uses the platform default when the account has no override', async () => {
    const card = await effectiveRateCard(new Types.ObjectId());
    expect(card).toMatchObject({ ...DEFAULT_RATE_CARD, source: 'default' });
    expect(card.id).toMatch(/^[a-f0-9]{24}$/);
  });

  it('uses the latest account version, then the default again after "back to default"', async () => {
    const accountId = new Types.ObjectId();
    await createRateCardVersion({
      accountId,
      values: { ...DEFAULT_RATE_CARD, callPerMinuteMicros: 800_000 },
      createdBy: admin,
      note: 'first',
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });
    await createRateCardVersion({
      accountId,
      values: { ...DEFAULT_RATE_CARD, callPerMinuteMicros: 700_000, pulseSeconds: 30 },
      createdBy: admin,
    });
    expect(await effectiveRateCard(accountId)).toMatchObject({
      source: 'account',
      callPerMinuteMicros: 700_000,
      pulseSeconds: 30,
    });
    expect(
      await effectiveRateCard(accountId, { at: new Date('2026-02-01T00:00:00Z') }),
    ).toMatchObject({ callPerMinuteMicros: 800_000 });
    await setAccountToDefault({ accountId, createdBy: admin, note: 'reset' });
    expect(await effectiveRateCard(accountId)).toMatchObject({ source: 'default' });
    const history = await rateCardHistory(accountId);
    expect(history.map((h) => h.inheritsDefault)).toEqual([true, false, false]);
    expect(history[0]?.note).toBe('reset');
  });

  it('ignores future versions until they take effect', async () => {
    const accountId = new Types.ObjectId();
    await createRateCardVersion({
      accountId,
      values: { ...DEFAULT_RATE_CARD, aiPerMinuteMicros: 1 },
      createdBy: admin,
      effectiveFrom: new Date(Date.now() + 3_600_000),
    });
    expect((await effectiveRateCard(accountId)).source).toBe('default');
  });

  it('caches 60 s per account and is invalidated by a new version', async () => {
    const accountId = new Types.ObjectId();
    const first = await effectiveRateCard(accountId);
    const spy = vi.spyOn(RateCardModel, 'findOne');
    expect(await effectiveRateCard(accountId)).toBe(first);
    expect(spy).not.toHaveBeenCalled();
    await createRateCardVersion({
      accountId,
      values: { ...DEFAULT_RATE_CARD, ttsPer1kCharsMicros: 1_000_000 },
      createdBy: admin,
    });
    expect((await effectiveRateCard(accountId)).ttsPer1kCharsMicros).toBe(1_000_000);
    spy.mockRestore();
  });

  it('expires the cache after 60 s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const accountId = new Types.ObjectId();
    await effectiveRateCard(accountId);
    await RateCardModel.create({
      accountId,
      ...DEFAULT_RATE_CARD,
      commissionBps: 100,
      effectiveFrom: new Date(),
    });
    expect((await effectiveRateCard(accountId)).commissionBps).toBe(0); // still cached
    vi.setSystemTime(Date.now() + 61_000);
    expect((await effectiveRateCard(accountId)).commissionBps).toBe(100);
  });

  it('a new platform default reaches every account', async () => {
    const accountId = new Types.ObjectId();
    await effectiveRateCard(accountId);
    await createRateCardVersion({
      accountId: null,
      values: { ...DEFAULT_RATE_CARD, callPerMinuteMicros: 1_200_000 },
      createdBy: admin,
    });
    expect((await effectiveRateCard(accountId)).callPerMinuteMicros).toBe(1_200_000);
    expect((await rateCardHistory(null))[0]?.callPerMinuteMicros).toBe(1_200_000);
  });

  it('looks up a card by id (hold snapshot)', async () => {
    const card = await effectiveRateCard(new Types.ObjectId());
    expect(await rateCardById(card.id)).toMatchObject({ pulseSeconds: card.pulseSeconds });
    await expect(rateCardById(new Types.ObjectId())).rejects.toThrow(/not found/);
  });

  it('validates values', async () => {
    const bad = async (values: unknown) =>
      createRateCardVersion({ accountId: new Types.ObjectId(), values, createdBy: admin });
    await expect(bad({ ...DEFAULT_RATE_CARD, pulseSeconds: 20 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(bad({ ...DEFAULT_RATE_CARD, commissionBps: 10_001 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(bad({ ...DEFAULT_RATE_CARD, callPerMinuteMicros: 1.5 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      bad({ ...DEFAULT_RATE_CARD, callPerMinuteMicros: 1_000_000_001 }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(bad({ ...DEFAULT_RATE_CARD, extra: 1 })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('AI prices (Phase 5)', () => {
  const {
    aiTextPer1kTokensMicros: _t,
    embeddingPer1kTokensMicros: _e,
    ...callOnly
  } = DEFAULT_RATE_CARD;

  it('carries AI prices over from the card in force when a request leaves them out', async () => {
    const accountId = new Types.ObjectId();
    await createRateCardVersion({
      accountId,
      values: {
        ...DEFAULT_RATE_CARD,
        aiTextPer1kTokensMicros: 500_000,
        embeddingPer1kTokensMicros: 20_000,
      },
      createdBy: admin,
    });
    const next = await createRateCardVersion({
      accountId,
      values: { ...callOnly, callPerMinuteMicros: 2_000_000 },
      createdBy: admin,
    });
    expect(next).toMatchObject({
      callPerMinuteMicros: 2_000_000,
      aiTextPer1kTokensMicros: 500_000,
      embeddingPer1kTokensMicros: 20_000,
    });
    // the default card version without AI prices keeps the previous default's
    const def = await createRateCardVersion({
      accountId: null,
      values: callOnly,
      createdBy: admin,
    });
    expect(def.aiTextPer1kTokensMicros).toBe(DEFAULT_RATE_CARD.aiTextPer1kTokensMicros);
    // only one of the two → the other carries over
    const half = await createRateCardVersion({
      accountId,
      values: { ...callOnly, aiTextPer1kTokensMicros: 1 },
      createdBy: admin,
    });
    expect(half).toMatchObject({ aiTextPer1kTokensMicros: 1, embeddingPer1kTokensMicros: 20_000 });
    const effective = await effectiveRateCard(accountId, { at: new Date() });
    expect(effective.aiTextPer1kTokensMicros).toBe(1);
  });

  it('reads old rows without AI prices as the defaults', async () => {
    const accountId = new Types.ObjectId();
    await RateCardModel.collection.insertOne({
      accountId,
      ...callOnly,
      inheritsDefault: false,
      effectiveFrom: new Date(0),
    });
    const card = await effectiveRateCard(accountId, { at: new Date() });
    expect(card.aiTextPer1kTokensMicros).toBe(DEFAULT_RATE_CARD.aiTextPer1kTokensMicros);
  });
});

describe('without a platform default', () => {
  it('fails loudly', async () => {
    await RateCardModel.collection.deleteMany({ accountId: null });
    invalidateRateCardCache();
    await expect(effectiveRateCard(new Types.ObjectId())).rejects.toThrow(/db:migrate/);
    await expect(
      setAccountToDefault({ accountId: new Types.ObjectId(), createdBy: admin }),
    ).rejects.toThrow(/db:migrate/);
  });
});
