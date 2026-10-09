import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { assertAgentBudget, recordAgentSpend, usageKeys } from '../../src/core/ai/budget';
import { credit } from '../../src/core/billing/engine';
import { AgentUsageModel } from '../../src/db/models/agent-usage.model';
import { WalletModel } from '../../src/db/models/wallet.model';
import { useTestDb } from '../helpers/db';

useTestDb();
const R = 1_000_000;
const TZ = 'Asia/Kolkata';

const funded = async (micros = 100 * R) => {
  const accountId = new Types.ObjectId();
  await credit({
    accountId,
    type: 'adjustment',
    amountMicros: micros,
    ref: { type: 'manual', id: 'x' },
    idempotencyKey: `k-${accountId.toString()}`,
  });
  return accountId;
};
const agent = (daily = 0, monthly = 0) => ({
  _id: new Types.ObjectId(),
  limits: {
    dailySpendCapMicros: daily,
    monthlySpendCapMicros: monthly,
    onCap: 'fallback' as const,
  },
});

describe('agent budget', () => {
  it('uses account-timezone days and months', () => {
    expect(usageKeys(new Date('2026-10-31T18:29:59Z'), TZ)).toEqual({
      day: '2026-10-31',
      month: '2026-10',
    });
    expect(usageKeys(new Date('2026-10-31T18:30:00Z'), TZ)).toEqual({
      day: '2026-11-01',
      month: '2026-11',
    });
  });

  it('needs a positive prepaid balance (credit limit and holds do not count)', async () => {
    const empty = new Types.ObjectId();
    const now = new Date();
    expect(
      await assertAgentBudget({ accountId: empty, agent: agent(), now, timezone: TZ }),
    ).toEqual({ ok: false, reason: 'wallet_empty' });
    await WalletModel.updateOne({ accountId: empty }, { $set: { creditLimitMicros: 500 * R } });
    expect(
      await assertAgentBudget({ accountId: empty, agent: agent(), now, timezone: TZ }),
    ).toEqual({ ok: false, reason: 'wallet_empty' });
    const accountId = await funded();
    expect(await assertAgentBudget({ accountId, agent: agent(), now, timezone: TZ })).toEqual({
      ok: true,
    });
  });

  it('stops at the daily cap, resets at local midnight and checks the month', async () => {
    const accountId = await funded();
    const a = agent(R, 3 * R);
    const day1 = new Date('2026-10-09T10:00:00Z');
    await recordAgentSpend({
      accountId,
      agentId: a._id,
      now: day1,
      timezone: TZ,
      micros: R,
      inputTokens: 10,
      outputTokens: 5,
    });
    expect(await assertAgentBudget({ accountId, agent: a, now: day1, timezone: TZ })).toEqual({
      ok: false,
      reason: 'cap_daily',
    });
    const day2 = new Date('2026-10-09T18:30:00Z'); // 00:00 IST 10 Oct
    expect(await assertAgentBudget({ accountId, agent: a, now: day2, timezone: TZ })).toEqual({
      ok: true,
    });
    await recordAgentSpend({
      accountId,
      agentId: a._id,
      now: day2,
      timezone: TZ,
      micros: 500_000,
      inputTokens: 1,
      outputTokens: 1,
    });
    await recordAgentSpend({
      accountId,
      agentId: a._id,
      now: new Date('2026-10-11T10:00:00Z'),
      timezone: TZ,
      micros: 2 * R,
      inputTokens: 1,
      outputTokens: 1,
    });
    expect(
      await assertAgentBudget({
        accountId,
        agent: a,
        now: new Date('2026-10-12T10:00:00Z'),
        timezone: TZ,
      }),
    ).toEqual({ ok: false, reason: 'cap_monthly' });
    expect(
      await assertAgentBudget({
        accountId,
        agent: a,
        now: new Date('2026-11-01T10:00:00Z'),
        timezone: TZ,
      }),
    ).toEqual({ ok: true });
    const row = await AgentUsageModel.findOne({ agentId: a._id, day: '2026-10-10' }).lean();
    expect(row).toMatchObject({
      month: '2026-10',
      spentMicros: 500_000,
      turns: 1,
      inputTokens: 1,
      outputTokens: 1,
    });
  });

  it('counts parallel spends atomically', async () => {
    const accountId = await funded();
    const a = agent();
    const now = new Date('2026-10-09T10:00:00Z');
    await Promise.all(
      Array.from({ length: 10 }, () =>
        recordAgentSpend({
          accountId,
          agentId: a._id,
          now,
          timezone: TZ,
          micros: 100,
          inputTokens: 2,
          outputTokens: 1,
        }),
      ),
    );
    const row = await AgentUsageModel.findOne({ agentId: a._id }).lean();
    expect(row).toMatchObject({ spentMicros: 1000, turns: 10, inputTokens: 20, outputTokens: 10 });
    vi.useRealTimers();
  });
});
