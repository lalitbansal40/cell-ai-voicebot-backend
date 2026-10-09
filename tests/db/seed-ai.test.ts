import { Types } from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';

import { mockPaymentFor, SEED_KB_NAME, seedAi } from '../../scripts/seed-ai';
import { DEMO_CONTACT_COUNT } from '../../scripts/seed-contacts';
import { createFakeProvider } from '../../src/core/ai';
import { credit } from '../../src/core/billing/engine';
import { AiAgentModel } from '../../src/db/models/ai-agent.model';
import { KnowledgeBaseModel } from '../../src/db/models/knowledge-base.model';
import { KnowledgeSourceModel } from '../../src/db/models/knowledge-source.model';
import { MockPaymentRecordModel } from '../../src/db/models/mock-payment-record.model';
import { DEFAULT_RATE_CARD, RateCardModel } from '../../src/db/models/rate-card.model';
import { recordingAiJobs } from '../helpers/ai';
import { useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';

useTestDb();
const storage = useTempStorage();

beforeAll(async () => {
  await RateCardModel.create({ accountId: null, ...DEFAULT_RATE_CARD, effectiveFrom: new Date(0) });
});

describe('seedAi', () => {
  it('seeds agents, the sample knowledge base and mock payments once', async () => {
    const accountId = new Types.ObjectId();
    await credit({
      accountId,
      type: 'adjustment',
      amountMicros: 1_000_000_000,
      ref: { type: 'manual', id: 'x' },
      idempotencyKey: `fund-${accountId.toString()}`,
    });
    const deps = {
      env: {
        APP_URL: 'http://localhost:5100',
        MOCK_APIS_ENABLED: true,
        OPENAI_TEXT_MODEL: 'gpt-4.1-mini',
      },
      ownerId: new Types.ObjectId(),
      storage,
      provider: createFakeProvider(),
      jobs: recordingAiJobs().jobs,
    };
    expect(await seedAi(accountId, deps)).toEqual({
      agents: 2,
      sources: 3,
      ready: 3,
      mockPayments: DEMO_CONTACT_COUNT,
    });
    const kb = await KnowledgeBaseModel.findOne({ accountId, name: SEED_KB_NAME }).lean();
    expect(kb).toMatchObject({ sourcesCount: 3 });
    expect(kb?.chunksCount).toBeGreaterThan(5);
    const recovery = await AiAgentModel.findOne({
      accountId,
      name: 'Recovery Bot (Hinglish)',
    }).lean();
    expect(recovery).toMatchObject({ isActive: true, templateKey: 'loan_recovery_hinglish' });
    expect(recovery?.knowledge.knowledgeBaseIds.map(String)).toEqual([kb?._id.toString()]);
    expect(recovery?.functions[0]?.url).toBe(
      'http://localhost:5100/api/v1/mock/payment-status?phone={{contact.phone}}',
    );
    expect(
      (await AiAgentModel.findOne({ accountId, name: 'Payment Reminder' }).lean())?.isActive,
    ).toBe(false);
    const statuses = (await MockPaymentRecordModel.find({ loanId: /^DEMO-/ }).lean()).map(
      (r) => r.status,
    );
    expect(statuses.filter((s) => s === 'partial').length).toBe(Math.floor(DEMO_CONTACT_COUNT / 5));
    expect(statuses.filter((s) => s === 'paid').length).toBeGreaterThan(5);

    // second run: nothing new
    expect(await seedAi(accountId, deps)).toEqual({
      agents: 0,
      sources: 0,
      ready: 3,
      mockPayments: 0,
    });
    expect(await KnowledgeSourceModel.countDocuments({ accountId })).toBe(3);
  });

  it('decides the mock answer per demo contact', () => {
    expect(mockPaymentFor(2)).toMatchObject({ status: 'paid', paidOn: '2026-10-03' });
    expect(mockPaymentFor(3)).toMatchObject({ status: 'unpaid', paidOn: null });
    expect(mockPaymentFor(5).status).toBe('partial');
  });
});
