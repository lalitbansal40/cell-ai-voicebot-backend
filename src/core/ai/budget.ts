import type { Types } from 'mongoose';

import { isDuplicateKeyError } from '../../db/errors';
import { AgentUsageModel } from '../../db/models/agent-usage.model';
import type { AiAgentDoc } from '../../db/models/ai-agent.model';
import { ymdInZone } from '../../shared/time';
import { getOrCreateWallet } from '../billing/wallets';

export type BudgetResult =
  { ok: true } | { ok: false; reason: 'wallet_empty' | 'cap_daily' | 'cap_monthly' };

/** Day / month keys in the account timezone (caps reset at local midnight). */
export const usageKeys = (now: Date, timezone: string) => {
  const day = ymdInZone(now, timezone);
  return { day, month: day.slice(0, 7) };
};

/**
 * May this agent spend now? AI usage is prepaid: balance − holds must be
 * positive (the credit limit is for calls only, Phase 4 rule), and the
 * agent's own daily / monthly caps (0 = none) must not be reached.
 */
export const assertAgentBudget = async ({
  accountId,
  agent,
  now,
  timezone,
}: {
  accountId: Types.ObjectId;
  agent: Pick<AiAgentDoc, '_id' | 'limits'>;
  now: Date;
  timezone: string;
}): Promise<BudgetResult> => {
  const wallet = await getOrCreateWallet(accountId);
  if (wallet.balanceMicros - wallet.holdMicros <= 0) return { ok: false, reason: 'wallet_empty' };
  const { dailySpendCapMicros: daily, monthlySpendCapMicros: monthly } = agent.limits;
  if (!daily && !monthly) return { ok: true };
  const { day, month } = usageKeys(now, timezone);
  if (daily) {
    const today = await AgentUsageModel.findOne({ agentId: agent._id, day })
      .select({ spentMicros: 1 })
      .lean<{ spentMicros: number }>();
    if ((today?.spentMicros ?? 0) >= daily) return { ok: false, reason: 'cap_daily' };
  }
  if (monthly) {
    const [sum] = await AgentUsageModel.aggregate<{ spent: number }>([
      { $match: { accountId, agentId: agent._id, month } },
      { $group: { _id: null, spent: { $sum: '$spentMicros' } } },
    ]);
    if ((sum?.spent ?? 0) >= monthly) return { ok: false, reason: 'cap_monthly' };
  }
  return { ok: true };
};

/** Adds a turn's spend to the agent's counters (atomic upsert, no read-modify-write). */
export const recordAgentSpend = async ({
  accountId,
  agentId,
  now,
  timezone,
  micros,
  inputTokens,
  outputTokens,
}: {
  accountId: Types.ObjectId;
  agentId: Types.ObjectId;
  now: Date;
  timezone: string;
  micros: number;
  inputTokens: number;
  outputTokens: number;
}): Promise<void> => {
  const { day, month } = usageKeys(now, timezone);
  const inc = { spentMicros: micros, turns: 1, inputTokens, outputTokens };
  try {
    await AgentUsageModel.updateOne(
      { accountId, agentId, day },
      { $setOnInsert: { accountId, agentId, day, month }, $inc: inc },
      { upsert: true },
    );
  } catch (err) {
    // two first spends of the day raced on the upsert — the row exists now
    if (!isDuplicateKeyError(err)) throw err;
    await AgentUsageModel.updateOne({ accountId, agentId, day }, { $inc: inc });
  }
};
