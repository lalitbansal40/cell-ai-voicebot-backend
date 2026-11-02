import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { MessageModel } from '../../src/db/models/message.model';
import { stringEq } from '../../src/db/partial-match';
import { useTestDb } from '../helpers/db';

useTestDb();

const stagesOf = (plan: unknown): string[] => {
  const node = plan as { stage?: string; inputStage?: unknown };
  return [node.stage ?? '', ...(node.inputStage ? stagesOf(node.inputStage) : [])];
};

describe('stringEq', () => {
  it('lets a wamid lookup use its partial index, unlike a plain equality', async () => {
    await MessageModel.createIndexes();
    const accountId = new Types.ObjectId();
    const channelId = new Types.ObjectId();
    const conversationId = new Types.ObjectId();
    const at = new Date();
    await MessageModel.collection.insertMany(
      Array.from({ length: 50 }, (_, i) => ({
        accountId,
        channelId,
        conversationId,
        waMessageId: `wamid.${String(i)}`,
        direction: 'in',
        at,
      })),
    );
    const explain = (waMessageId: string | ReturnType<typeof stringEq>) =>
      MessageModel.find({ accountId, channelId, waMessageId }).explain(
        'executionStats',
      ) as unknown as Promise<{
        queryPlanner: { winningPlan: unknown };
        executionStats: { totalDocsExamined: number; nReturned: number };
      }>;
    const fixed = await explain(stringEq('wamid.7'));
    expect(fixed.executionStats.nReturned).toBe(1);
    expect(fixed.executionStats.totalDocsExamined).toBe(1);
    expect(stagesOf(fixed.queryPlanner.winningPlan)).toContain('IXSCAN');
    const plain = await explain('wamid.7');
    expect(plain.executionStats.totalDocsExamined).toBeGreaterThan(1);
  });
});
